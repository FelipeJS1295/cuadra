import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/** Configuración de la empresa: disponible en todos los módulos */
@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
