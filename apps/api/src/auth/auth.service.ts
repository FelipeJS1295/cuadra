import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { BASE_DB, type Database } from '../database/database.module.js';
import { memberships, retailers, tenants, users, type User } from '../database/schema/index.js';
import { tenantStore, withTenant } from '../database/tenant-context.js';
import { authSecret, sessionDays } from './auth.config.js';
import { hashPassword, passwordFingerprint, signSession, verifyPassword } from './crypto.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
const TRIAL_DAYS = 14;

/** Retailers con los que parte cada empresa nueva (se pueden desactivar) */
export const DEFAULT_RETAILERS = [
  { code: 'FALABELLA', name: 'Falabella', commissionPct: '0' },
  { code: 'CENCOSUD', name: 'Paris', commissionPct: '0' },
  { code: 'WALMART', name: 'Walmart', commissionPct: '0' },
  { code: 'HITES', name: 'Hites', commissionPct: '0' },
];

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  companyName: string;
  taxId?: string | null;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly failed = new Map<string, { count: number; until: number }>();

  constructor(@Inject(BASE_DB) private readonly db: Database) {}

  /** Al partir: si no hay ningún superadmin, lo crea con SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD */
  async onModuleInit() {
    const [{ total }] = await this.db.select({ total: count() }).from(users).where(eq(users.isSuperadmin, true));
    if (total > 0) return;
    const email = (process.env.SUPERADMIN_EMAIL ?? 'admin@cuadra.local').trim().toLowerCase();
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      await this.db.update(users).set({ isSuperadmin: true }).where(eq(users.id, existing.id));
      this.logger.log(`Superadmin: ${email}`);
      return;
    }
    let password = process.env.SUPERADMIN_PASSWORD;
    if (!password) {
      password = randomBytes(6).toString('base64url');
      this.logger.warn(`SUPERADMIN_PASSWORD no está en el .env: contraseña generada para "${email}": ${password}`);
    }
    await this.db.insert(users).values({ email, name: 'Administrador', passwordHash: await hashPassword(password), isSuperadmin: true });
    this.logger.log(`Superadmin inicial creado: ${email}`);
  }

  async login(emailRaw: string, password: string) {
    const email = emailRaw.trim().toLowerCase();
    const lock = this.failed.get(email);
    if (lock && lock.until > Date.now()) {
      throw new UnauthorizedException(`Demasiados intentos. Prueba de nuevo en ${Math.ceil((lock.until - Date.now()) / 60000)} min`);
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok || !user.isActive) {
      const current = this.failed.get(email) ?? { count: 0, until: 0 };
      current.count++;
      if (current.count >= MAX_FAILED) {
        current.until = Date.now() + LOCK_MINUTES * 60000;
        current.count = 0;
      }
      this.failed.set(email, current);
      throw new UnauthorizedException(user && ok && !user.isActive ? 'Tu usuario está desactivado' : 'Correo o contraseña incorrectos');
    }
    this.failed.delete(email);
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return { token: this.tokenFor(user), firstTenantId: (await this.tenantsOf(user.id))[0]?.id ?? null, userId: user.id };
  }

  /** Id del usuario con ese correo (para anotar intentos fallidos) */
  async userIdOf(email: string) {
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase()));
    return u?.id ?? null;
  }

  tokenFor(user: User) {
    return signSession({ sub: user.id, pf: passwordFingerprint(user.passwordHash), exp: Math.floor(Date.now() / 1000) + sessionDays() * 86400 }, authSecret());
  }

  /** Registro: crea la persona, su empresa (con prueba gratis) y la deja como DUEÑO */
  async signup(input: SignupInput) {
    const email = input.email.trim().toLowerCase();
    const [exists] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (exists) throw new ConflictException('Ya existe una cuenta con ese correo. Inicia sesión');
    const [user] = await this.db
      .insert(users)
      .values({ email, name: input.name.trim(), passwordHash: await hashPassword(input.password) })
      .returning();
    const tenant = await this.createTenant(user.id, input.companyName, input.taxId ?? null);
    return { token: this.tokenFor(user), tenantId: tenant.id };
  }

  /** Nueva empresa para un usuario (queda como DUEÑO) con los retailers de siempre */
  async createTenant(userId: string, name: string, taxId: string | null) {
    const trial = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString().slice(0, 10);
    const [tenant] = await this.db.insert(tenants).values({ name: name.trim(), taxId, trialEndsAt: trial }).returning();
    await this.db.insert(memberships).values({ userId, tenantId: tenant.id, role: 'DUENO' });
    await withTenant(this.db, tenant.id, async () => {
      // Dentro de la empresa: tenant_id lo pone la base sola
      await tenantStore.getStore()!.tx.insert(retailers).values(DEFAULT_RETAILERS).onConflictDoNothing();
    });
    this.logger.log(`Empresa creada: ${tenant.name} (${tenant.id})`);
    return tenant;
  }

  async tenantsOf(userId: string) {
    return this.db
      .select({ id: tenants.id, name: tenants.name, role: memberships.role, plan: tenants.plan, status: tenants.status })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)))
      .orderBy(asc(memberships.createdAt));
  }

  /** Verifica que el usuario pueda entrar a la empresa (o que sea superadmin) */
  async canUseTenant(userId: string, isSuperadmin: boolean, tenantId: string) {
    if (isSuperadmin) return true;
    return (await this.tenantsOf(userId)).some((t) => t.id === tenantId);
  }

  async changePassword(userId: string, current: string, next: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || !(await verifyPassword(current, user.passwordHash))) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    const [updated] = await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
      .where(eq(users.id, userId))
      .returning();
    return this.tokenFor(updated);
  }

  assertNotLast(isOwner: boolean) {
    if (isOwner) throw new ForbiddenException('La empresa debe tener al menos un dueño');
  }
}
