import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, NoTenant, Roles, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { ActivityService } from './activity.service.js';
import { describePage } from './describe.js';

/**
 *   POST /api/activity/page { path }   la web avisa qué página abrió el usuario
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @NoTenant()
  @Roles('DUENO', 'ADMIN', 'OPERADOR', 'LECTURA')
  @Post('page')
  @HttpCode(204)
  page(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    const { path } = validate(z.object({ path: z.string().trim().min(1).max(300).startsWith('/') }), body);
    this.activity.record({ kind: 'PAGINA', description: describePage(path), userId: user.id, companyId: user.tenantId, path, req });
  }
}
