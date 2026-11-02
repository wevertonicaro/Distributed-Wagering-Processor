import { EntityManager } from 'typeorm';
import { OutboxRepository } from '../../../application/ports/repositories.port';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { rowsOf } from './sql';

interface Row {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

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

  async lockDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = rowsOf<Row>(
      await this.em.query(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
           FROM outbox_messages
          WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY seq
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      ),
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: r.payload,
        occurredAt: r.occurred_at,
        attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at ?? undefined,
        publishedAt: r.published_at ?? undefined,
      }),
    );
  }

  async save(m: OutboxMessage, lastError?: string): Promise<void> {
    await this.em.query(
      `UPDATE outbox_messages
          SET attempts = $2, next_attempt_at = $3, published_at = $4, last_error = $5
        WHERE id = $1`,
      [m.id, m.attempts, m.nextAttemptAt ?? null, m.publishedAt ?? null, lastError ?? null],
    );
  }
}