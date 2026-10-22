import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Todas las rutas quedan bajo /api (ej: /api/health)
  app.setGlobalPrefix('api');

  // credentials: true para que el navegador envíe la cookie de sesión
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3200',
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 4200);
  // Solo en 127.0.0.1: desde internet se entra únicamente por Nginx
  await app.listen(port, process.env.API_HOST ?? '127.0.0.1');
  Logger.log(`API escuchando en http://localhost:${port}/api`, 'Bootstrap');
}

await bootstrap();
