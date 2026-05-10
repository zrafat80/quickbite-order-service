import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { DatabaseErrorFilter } from './lib/filters/database-error.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
        },
      },
    }),
  );

  const corsOrigins = configService.get<string[]>('cors.origins') ?? [
    'http://localhost:3000',
  ];
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Region',
      'X-CorrelationId',
      'Idempotency-Key',
      'x-api-key',
    ],
    credentials: true,
  });

  app.setGlobalPrefix('api');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('QuickBite Order Service API')
    .setDescription('Orders, payments, deliveries, restaurant finance')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs/swagger', app, document);

  app.use(cookieParser());

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // DatabaseErrorFilter must be registered AFTER HttpExceptionFilter (which is
  // bound globally via APP_FILTER in AppModule). Filters registered later run
  // first; we want SQLSTATE mapping to win for raw PG errors and pass HTTP
  // exceptions through unchanged.
  app.useGlobalFilters(new DatabaseErrorFilter());

  app.enableShutdownHooks();

  const port = configService.get<number>('port') ?? 4000;
  await app.listen(port);
  logger.log(`order-service listening on :${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('bootstrap failed:', err);
  process.exit(1);
});
