import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { configureBodyParsers } from './common/body-parsers';

async function bootstrap() {
  requireProductionSecrets();

  // Body parsers are registered below so usage-ingest routes can take larger batches than the rest of the API.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(helmet());
  configureBodyParsers(app);
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  // AuditLoggingInterceptor is registered as a global APP_INTERCEPTOR in AuditModule
  // (not here) so Nest's DI container can inject its repository.
  app.setGlobalPrefix('api');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Vector Database Assessment & Optimization Platform')
    .setDescription('Discovery -> Design -> Implementation -> Operations API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}/api  (docs at /api/docs)`);
}

/**
 * Fails fast on boot rather than starting with an insecure or missing secret
 * in production - a misconfigured JWT_SECRET is a security incident waiting
 * to happen, not something that should surface later as a confusing 500.
 */
function requireProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a value of at least 32 characters in production.');
  }
}

bootstrap();
