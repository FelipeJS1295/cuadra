import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { SII_PROVIDERS } from '../sii/providers/types.js';
import { SiiProviderService } from '../sii/sii-provider.service.js';
import { HomeService } from './home.service.js';
import { SettingsService } from './settings.service.js';

const optional = (max: number) => z.string().trim().max(max).nullish();

/**
 *   GET   /api/home?month=AAAA-MM       inicio en lenguaje simple + tareas
 *   GET   /api/company                  datos de la empresa
 *   PATCH /api/company                  (ADMIN)
 *   GET   /api/company/sii              conexión con el SII (claves enmascaradas)
 *   PUT   /api/company/sii              (ADMIN)
 *   POST  /api/company/sii/test         prueba la conexión con el proveedor elegido (API Gateway, SimpleAPI o Nubox)
 *   GET   /api/company/onboarding       pasos del asistente de inicio
 *   POST  /api/company/onboarding/:step { value: 'SALTADO' | null }
 */
@Controller()
export class CompanyController {
  constructor(
    private readonly settings: SettingsService,
    private readonly home: HomeService,
    private readonly sii: SiiProviderService,
  ) {}

  @Get('home')
  summary(@Query('month') month?: string) {
    return this.home.summary(month);
  }

  @Get('company')
  company() {
    return this.settings.company();
  }

  @Roles('ADMIN')
  @Patch('company')
  async saveCompany(@Body() body: unknown) {
    const input = validate(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        legalName: optional(200),
        taxId: optional(12),
        businessMode: z.enum(['REVENDEDOR', 'FABRICANTE']).optional(),
      }),
      body,
    );
    await this.settings.saveCompany(input);
    return this.settings.company();
  }

  @Get('company/sii')
  siiConfig() {
    return this.settings.siiPublic();
  }

  @Roles('ADMIN')
  @Put('company/sii')
  async saveSii(@Body() body: unknown) {
    const input = validate(
      z.object({
        provider: z.enum(SII_PROVIDERS).nullish(),
        usuarioRut: optional(12),
        sucursal: optional(20),
        apigatewayUrl: optional(200),
        token: optional(500),
        clave: optional(100),
        simpleapiKey: optional(200),
        nuboxUrl: optional(200),
        nuboxToken: optional(1000),
        nuboxApiKey: optional(500),
        nuboxUser: optional(100),
        nuboxSerie: optional(20),
        nuboxPassword: optional(200),
      }),
      body,
    );
    await this.settings.saveSii(input);
    return this.settings.siiPublic();
  }

  @Post('company/sii/test')
  @HttpCode(200)
  testSii() {
    return this.sii.test();
  }

  @Get('company/onboarding')
  onboarding() {
    return this.home.onboarding();
  }

  @Post('company/onboarding/:step')
  @HttpCode(200)
  async mark(@Param('step') step: string, @Body() body: unknown, @CurrentUser() _user: SessionUser) {
    const { value } = validate(z.object({ value: z.enum(['SALTADO', 'HECHO']).nullable() }), body);
    await this.settings.markOnboarding(step, value);
    return this.home.onboarding();
  }
}
