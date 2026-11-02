import { SQSClient } from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { systemClock } from './application/ports/clock.port';
import { WagerTransactionApplier } from './application/services/wager-transaction-applier';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { PublishOutbox } from './application/use-cases/publish-outbox';
import { ResolvePendingReferences } from './application/use-cases/resolve-pending-references';
import { CoreModule } from './core.module';
import { env } from './infra/config/env';
import { rowsOf } from './infra/database/repositories/sql';
import { TypeOrmUnitOfWork } from './infra/database/typeorm-unit-of-work';
import { HealthController, MetricsController } from './infra/http/ops.controller';
import { PollingWorker } from './infra/jobs/polling-worker';
import { SqsConsumer } from './infra/messaging/sqs-consumer';
import { SqsEventPublisher } from './infra/messaging/sqs-event-publisher';
import { createSqsClient } from './infra/messaging/sqs.client';
import { toCommand } from './infra/messaging/wager-message';
import { log } from './infra/observability/logger';
import {
  outboxPublishedTotal,
  outboxPublishFailuresTotal,
  pendingReferenceTotal,
  registerOutboxLag,
} from './infra/observability/metrics';

const PENDING_BATCH = 20;

@Injectable()
export class WorkerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer?: SqsConsumer;
  private jobs: PollingWorker[] = [];

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(PublishOutbox) private readonly publishOutbox: PublishOutbox,
    @Inject(ResolvePendingReferences) private readonly resolvePending: ResolvePendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    registerOutboxLag(async () => {
      const [row] = rowsOf<{ lag: number }>(
        await this.ds.query(
          `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float AS lag
             FROM outbox_messages WHERE published_at IS NULL`,
        ),
      );
      return Number(row?.lag ?? 0);
    });

    this.consumer = new SqsConsumer(
      this.sqs,
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
        maxReceiveCount: env.sqs.maxReceiveCount,
      },
    );
    this.consumer.start();

    this.jobs = [
      new PollingWorker(
        'outbox-publisher',
        async () => {
          const r = await this.publishOutbox.execute();
          outboxPublishedTotal.inc(r.published);
          outboxPublishFailuresTotal.inc(r.failed);
          return r.published + r.failed;
        },
        env.outbox.pollIntervalMs,
      ),
      new PollingWorker(
        'pending-reference',
        async () => {
          const items = await this.resolvePending.execute(PENDING_BATCH);
          for (const item of items) pendingReferenceTotal.inc({ status: item.status });
          return items.length;
        },
        env.pendingReference.pollIntervalMs,
      ),
    ];
    this.jobs.forEach((job) => job.start());
    log('info', 'worker started', { queueUrl: env.sqs.wagerQueueUrl });
  }

  async beforeApplicationShutdown(): Promise<void> {
    log('info', 'worker stopping');
    const deadline = new Promise((resolve) => setTimeout(resolve, env.shutdownTimeoutMs).unref());
    await Promise.race([Promise.all([this.consumer?.stop(), ...this.jobs.map((j) => j.stop())]), deadline]);
  }
}

@Module({
  imports: [CoreModule],
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: SQSClient, useFactory: createSqsClient },
    {
      provide: PublishOutbox,
      useFactory: (uow: TypeOrmUnitOfWork, sqs: SQSClient) =>
        new PublishOutbox(uow, new SqsEventPublisher(sqs, env.sqs.eventsQueueUrl), systemClock, {
          batchSize: env.outbox.batchSize,
          backoff: { baseMs: env.outbox.backoffBaseMs, maxMs: env.outbox.backoffMaxMs },
        }),
      inject: [TypeOrmUnitOfWork, SQSClient],
    },
    {
      provide: ResolvePendingReferences,
      useFactory: (uow: TypeOrmUnitOfWork, applier: WagerTransactionApplier) =>
        new ResolvePendingReferences(uow, applier, systemClock),
      inject: [TypeOrmUnitOfWork, WagerTransactionApplier],
    },
    WorkerService,
  ],
})
export class WorkerModule {}