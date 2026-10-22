import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BASE_DB, type Database } from '../database/database.module.js';
import { memberships, userRoleEnum, users } from '../database/schema/index.js';
import { validate } from '../products/catalog.validation.js';
import { hashPassword } from './crypto.js';
import { CurrentUser, Roles, type SessionUser } from './decorators.js';

const roleSchema = z.enum(userRoleEnum.enumValues, { error: 'Rol inválido' });

/**
 * Equipo de la empresa actual (memberships).
 *   GET    /api/team
 *   POST   /api/team            { email, name, role }  invita: si no tiene cuenta se crea con clave temporal
 *   PATCH  /api/team/:id        { role?, isActive? }
 *   DELETE /api/team/:id
 */
@Roles('ADMIN')
@Controller('team')
export class UsersController {
  constructor(@Inject(BASE_DB) private readonly db: Database) {}

  @Get()
  list(@CurrentUser() me: SessionUser) {
    return this.db
      .select({
        id: memberships.id,
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        isActive: memberships.isActive,
        lastLoginAt: users.lastLoginAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, me.tenantId!))
      .orderBy(asc(memberships.createdAt));
  }

  @Post()
  async invite(@CurrentUser() me: SessionUser, @Body() body: unknown) {
    const input = validate(
      z.object({
        email: z.string().trim().toLowerCase().email('Correo inválido'),
        name: z.string().trim().min(2, 'Falta el nombre').max(120),
        role: roleSchema,
      }),
      body,
    );
    if (input.role === 'DUENO' && me.role !== 'DUENO') throw new BadRequestException('Solo un dueño puede agregar otro dueño');
    let [user] = await this.db.select().from(users).where(eq(users.email, input.email));
    let tempPassword: string | null = null;
    if (!user) {
      tempPassword = randomBytes(6).toString('base64url');
      [user] = await this.db
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash: await hashPassword(tempPassword), mustChangePassword: true })
        .returning();
    }
    await this.db
      .insert(memberships)
      .values({ userId: user.id, tenantId: me.tenantId!, role: input.role })
      .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role: input.role, isActive: true } });
    // La clave temporal se muestra UNA vez: hay que entregársela a la persona
    return { ok: true, email: user.email, tempPassword };
  }

  @Patch(':id')
  async update(@CurrentUser() me: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(z.object({ role: roleSchema.optional(), isActive: z.boolean().optional() }), body);
    const m = await this.member(me, id);
    if ((data.role === 'DUENO' || m.role === 'DUENO') && me.role !== 'DUENO') throw new BadRequestException('Solo un dueño puede cambiar a un dueño');
    if (m.role === 'DUENO' && (data.isActive === false || (data.role && data.role !== 'DUENO'))) await this.ensureAnotherOwner(me, id);
    await this.db.update(memberships).set(data).where(eq(memberships.id, id));
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() me: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    const m = await this.member(me, id);
    if (m.role === 'DUENO') {
      if (me.role !== 'DUENO') throw new BadRequestException('Solo un dueño puede quitar a un dueño');
      await this.ensureAnotherOwner(me, id);
    }
    await this.db.delete(memberships).where(eq(memberships.id, id));
    return { deleted: true };
  }

  private async member(me: SessionUser, id: string) {
    const [m] = await this.db.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.tenantId, me.tenantId!)));
    if (!m) throw new NotFoundException('Esa persona no está en la empresa');
    return m;
  }

  private async ensureAnotherOwner(me: SessionUser, exceptId: string) {
    const others = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, me.tenantId!), eq(memberships.role, 'DUENO'), eq(memberships.isActive, true), ne(memberships.id, exceptId)));
    if (!others.length) throw new BadRequestException('La empresa debe tener al menos un dueño activo');
  }
}
