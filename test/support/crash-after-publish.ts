import { systemClock } from '../../src/application/ports/clock.port';
import { EventPublisher } from '../../src/application/ports/event-publisher.port';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import { env } from '../../src/infra/config/env';
import { dataSource } from '../../src/infra/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infra/database/typeorm-unit-of-work';
import { SqsEventPublisher } from '../../src/infra/messaging/sqs-event-publisher';
import { createSqsClient } from '../../src/infra/messaging/sqs.client';

async function main() {
  await dataSource.initialize();
  const real = new SqsEventPublisher(createSqsClient(), env.sqs.eventsQueueUrl);
  const crashing: EventPublisher = {
    publish: async (m) => {
      await real.publish(m); 
      process.exit(137);
    },
  };
  await new PublishOutbox(new TypeOrmUnitOfWork(dataSource), crashing, systemClock, {
    batchSize: 5,
    backoff: { baseMs: 1000, maxMs: 60_000 },
  }).execute();
}

main().catch((error) => {
  console.error('CRASH-AFTER-PUBLISH FAILED:', error);
  process.exit(1);
});