import { NestFactory } from '@nestjs/core';
import { log } from './infra/observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
}

bootstrap().catch((error) => {
  log('error', 'worker failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});