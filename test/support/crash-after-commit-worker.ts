import { env } from '../../src/infra/config/env';
import { dataSource } from '../../src/infra/database/data-source';
import { SqsConsumer } from '../../src/infra/messaging/sqs-consumer';
import { createSqsClient } from '../../src/infra/messaging/sqs.client';
import { toCommand } from '../../src/infra/messaging/wager-message';
import { buildApp } from '../../src/test-support/app-factory';

async function main() {
  await dataSource.initialize();
  const app = buildApp(dataSource);
  const consumer = new SqsConsumer(
    createSqsClient(),
    async (body) => {
      await app.process.execute(toCommand(body, env.sqs.consumerName)); 
      process.exit(137);
    },
    {
      queueUrl: env.sqs.wagerQueueUrl,
      dlqUrl: env.sqs.wagerDlqUrl,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: env.sqs.visibilityTimeoutSeconds,
      concurrency: 1,
    },
  );
  consumer.start();
}

main().catch((error) => {
  console.error('CRASH-AFTER-COMMIT-WORKER FAILED:', error);
  process.exit(1);
});