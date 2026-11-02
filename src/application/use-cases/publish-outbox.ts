import { BackoffPolicy } from '../../domain/messaging/outbox-message';
import { Clock } from '../ports/clock.port';
import { EventPublisher } from '../ports/event-publisher.port';
import { UnitOfWork } from '../ports/unit-of-work.port';

export interface PublishOutboxOptions {
  batchSize: number;
  backoff: BackoffPolicy;
}

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

const truncate = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {}

  execute(): Promise<PublishOutboxResult> {
    return this.uow.run(async (ctx) => {
      const batch = await ctx.outbox.lockDue(this.clock.now(), this.options.batchSize);
      let published = 0;
      let failed = 0;

      for (const message of batch) {
        try {
          await this.publisher.publish(message);
        } catch (error) {
          message.scheduleRetry(this.clock.now(), this.options.backoff);
          await ctx.outbox.save(message, truncate(error));
          failed++;
          continue;
        }
        message.markPublished(this.clock.now());
        await ctx.outbox.save(message);
        published++;
      }
      return { published, failed };
    });
  }
}