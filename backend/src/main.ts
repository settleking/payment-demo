import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from './app.module';
import { AppConfig } from './config';

async function bootstrap() {
  // rawBody keeps the exact webhook bytes for signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get(AppConfig);
  const logger = new Logger('TempoDanceStudio');

  app.setGlobalPrefix('api');
  app.set('trust proxy', 'loopback, uniquelocal');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  // The built React site; every non-API route falls back to its index.html.
  if (existsSync(join(config.frontendDist, 'index.html'))) {
    app.useStaticAssets(config.frontendDist, { index: false, maxAge: '1h' });
    const index = join(config.frontendDist, 'index.html');
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (request.method === 'GET' && !request.path.startsWith('/api')) {
        response.setHeader('Cache-Control', 'no-cache');
        return response.sendFile(index);
      }
      return next();
    });
  } else {
    logger.warn(`No frontend build at ${config.frontendDist}; serving the API only`);
  }

  await app.listen(config.port, '0.0.0.0');
  logger.log(`${config.studioName} on :${config.port}, public URL ${config.publicUrl}`);
  if (!config.paymentsConfigured) {
    logger.warn('SETTLEKING_CLIENT_ID / SETTLEKING_CLIENT_SECRET are not set: bookings cannot be paid');
  }
  if (config.paymentsConfigured && !config.widgetsConfigured) {
    logger.log('SETTLEKING_WIDGET_ID / SETTLEKING_PUBLISHABLE_KEY are not set: the page offers hosted checkout only');
  }
  if (!config.adminToken) {
    logger.log('ADMIN_TOKEN is not set: the studio admin panel is turned off');
  }
  if (!config.settleking.webhookSecret) {
    logger.warn('SETTLEKING_WEBHOOK_SECRET is not set: webhooks are rejected; payments are confirmed by lookup');
  }
}

void bootstrap();
