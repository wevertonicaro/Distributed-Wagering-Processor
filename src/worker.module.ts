import { BeforeApplicationShutdown, Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { CoreModule } from './core.module';
import { env } from './infra/config/env';
import { SqsConsumer } from './infra/messaging/sqs-consumer';
import { createSqsClient } from './infra/messaging/sqs.client';
import { toCommand } from './infra/messaging/wager-message';
import { log } from './infra/observability/logger';

@Injectable()
export class WagerConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer?: SqsConsumer;

  constructor(@Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction) {}

  onApplicationBootstrap(): void {
    this.consumer = new SqsConsumer(
      createSqsClient(),
      async (body) => {
        const command = toCommand(body, env.sqs.consumerName);
        const result = await this.processWager.execute(command);
        log('info', 'message processed', {
          messageId: command.inbox?.messageId,
          correlationId: command.correlationId,
          transactionId: result.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        });
      },
      {
        queueUrl: env.sqs.wagerQueueUrl,
        dlqUrl: env.sqs.wagerDlqUrl,
        waitTimeSeconds: env.sqs.waitTimeSeconds,
        visibilityTimeoutSeconds: env.sqs.visibilityTimeoutSeconds,
        concurrency: env.sqs.concurrency,
      },
    );
    this.consumer.start();
    log('info', 'wager consumer started', { queueUrl: env.sqs.wagerQueueUrl });
  }

  async beforeApplicationShutdown(): Promise<void> {
    log('info', 'wager consumer stopping');
    const deadline = new Promise((resolve) => setTimeout(resolve, env.shutdownTimeoutMs).unref());
    await Promise.race([this.consumer?.stop(), deadline]);
  }
}

@Module({ imports: [CoreModule], providers: [WagerConsumerService] })
export class WorkerModule {}