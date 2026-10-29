import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ActivityController } from './activity.controller.js';
import { ActivityInterceptor } from './activity.interceptor.js';
import { ActivityService } from './activity.service.js';

/** Actividad de los usuarios (ingresos, páginas y acciones) para el administrador del sistema */
@Global()
@Module({
  controllers: [ActivityController],
  providers: [ActivityService, { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor }],
  exports: [ActivityService],
})
export class ActivityModule {}
