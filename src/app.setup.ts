import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { ApiExceptionFilter } from './common/exception.filter';
import { readConfig } from './common/config';
import { tenantContextMiddleware } from './database/tenant-context';
export function configureApp(app: INestApplication): void {
  const cfg = readConfig();
  app.use(tenantContextMiddleware);
  app.getHttpAdapter().getInstance().set('trust proxy', cfg.TRUST_PROXY);
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.enableCors({
    origin: cfg.CORS_ORIGINS.split(',').filter(Boolean),
    credentials: false,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  if (cfg.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Suretek HireAI + HRMS')
        .setDescription(
          'Starter API. All roles are tenant scoped. Call plans never dial. HR records human decisions and consent evidence.',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }
}
