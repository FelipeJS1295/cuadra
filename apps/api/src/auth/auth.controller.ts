import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { validate } from '../products/catalog.validation.js';
import { siiRut } from '../sii/rut.js';
import { cookieSecure, SESSION_COOKIE, sessionDays, TENANT_COOKIE } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { CurrentUser, NoTenant, Public, type SessionUser } from './decorators.js';

export const passwordSchema = z
  .string({ error: 'Falta la contraseña' })
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(100, 'La contraseña es demasiado larga');

const emailSchema = z.string({ error: 'Falta el correo' }).trim().toLowerCase().email('Correo inválido').max(160);

const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: 'Falta la contraseña' }).min(1, 'Falta la contraseña'),
});

const rutSchema = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const rut = siiRut(v);
    if (!rut) ctx.addIssue({ code: 'custom', message: 'RUT inválido' });
    return rut;
  });

const signupSchema = z.object({
  name: z.string({ error: 'Falta tu nombre' }).trim().min(2, 'Falta tu nombre').max(120),
  email: emailSchema,
  password: passwordSchema,
  companyName: z.string({ error: 'Falta el nombre de la empresa' }).trim().min(2, 'Falta el nombre de la empresa').max(120),
  taxId: rutSchema,
});

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure(), path: '/', maxAge: sessionDays() * 86400 * 1000 });

function setSession(res: Response, token: string, tenantId?: string | null) {
  res.cookie(SESSION_COOKIE, token, cookieOpts());
  if (tenantId) res.cookie(TENANT_COOKIE, tenantId, cookieOpts());
}

/**
 *   POST /api/auth/signup            crea cuenta + empresa (prueba gratis)
 *   POST /api/auth/login             { email, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me                usuario, empresa actual y sus empresas
 *   POST /api/auth/switch            { tenantId }  cambiar de empresa
 *   POST /api/auth/tenants           { companyName, taxId }  crear otra empresa
 *   POST /api/auth/change-password   { currentPassword, newPassword }
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  @HttpCode(200)
  async signup(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = validate(signupSchema, body);
    const { token, tenantId } = await this.auth.signup(input);
    setSession(res, token, tenantId);
    return { ok: true };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = validate(loginSchema, body);
    const { token, firstTenantId } = await this.auth.login(email, password);
    setSession(res, token, firstTenantId);
    return { ok: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(TENANT_COOKIE, { path: '/' });
    return { ok: true };
  }

  @NoTenant()
  @Get('me')
  async me(@CurrentUser() user: SessionUser) {
    return { ...user, tenants: await this.auth.tenantsOf(user.id) };
  }

  @NoTenant()
  @Post('switch')
  @HttpCode(200)
  async switch(@CurrentUser() user: SessionUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { tenantId } = validate(z.object({ tenantId: z.uuid('Empresa inválida') }), body);
    if (!(await this.auth.canUseTenant(user.id, user.isSuperadmin, tenantId))) throw new ForbiddenException('No perteneces a esa empresa');
    res.cookie(TENANT_COOKIE, tenantId, cookieOpts());
    return { ok: true };
  }

  @NoTenant()
  @Post('tenants')
  @HttpCode(200)
  async createTenant(@CurrentUser() user: SessionUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { companyName, taxId } = validate(signupSchema.pick({ companyName: true, taxId: true }), body);
    const tenant = await this.auth.createTenant(user.id, companyName, taxId);
    res.cookie(TENANT_COOKIE, tenant.id, cookieOpts());
    return { id: tenant.id };
  }

  @NoTenant()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: SessionUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { currentPassword, newPassword } = validate(
      z.object({ currentPassword: z.string().min(1, 'Falta la contraseña actual'), newPassword: passwordSchema }),
      body,
    );
    const token = await this.auth.changePassword(user.id, currentPassword, newPassword);
    res.cookie(SESSION_COOKIE, token, cookieOpts());
    return { ok: true };
  }
}
