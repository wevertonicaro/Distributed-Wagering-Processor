import { NestFactory } from '@nestjs/core';
import { env } from './infra/config/env';
import { log } from './infra/observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.create(WorkerModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  await app.listen(env.workerPort, '0.0.0.0');
}

bootstrap().catch((error) => {
  log('error', 'worker failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});