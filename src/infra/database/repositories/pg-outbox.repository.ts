import { EntityManager } from 'typeorm';
import { OutboxRepository } from '../../../application/ports/repositories.port';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(m: OutboxMessage): Promise<void> {
    await this.em.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [
        m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt,
        m.attempts, m.nextAttemptAt ?? null, m.publishedAt ?? null,
      ],
    );
  }
}