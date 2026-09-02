import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);

  // Cloud Run / Vercel rewrite están detrás de proxies: ip y protocolo reales.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API escuchando en http://localhost:${env.PORT}`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  console.error('Fallo al arrancar el API', err);
  process.exit(1);
});
