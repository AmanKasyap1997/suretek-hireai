import { SafeJsonLogger, jsonLog } from './platform/http/logging';
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { readConfig } from './platform/config';
async function bootstrap() {
  const cfg = readConfig();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new SafeJsonLogger(),
  });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, cfg.HOST);
}
bootstrap().catch(() => {
  jsonLog('startup_failed', { level: 'error' });
  process.exitCode = 1;
});
