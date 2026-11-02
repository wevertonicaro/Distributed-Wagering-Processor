import { EntityManager } from 'typeorm';
import { InboxRepository } from '../../../application/ports/repositories.port';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { rowsOf } from './sql';

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(m: InboxMessage): Promise<boolean> {
    const rows = rowsOf(
      await this.em.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING message_id`,
        [m.consumerName, m.messageId, m.payloadHash, m.receivedAt, m.processedAt ?? null],
      ),
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const [r] = rowsOf<{
      consumer_name: string;
      message_id: string;
      payload_hash: string;
      received_at: Date;
      processed_at: Date | null;
    }>(
      await this.em.query(
        `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
           FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
        [consumerName, messageId],
      ),
    );
    return r
      ? InboxMessage.rehydrate({
          messageId: r.message_id,
          consumerName: r.consumer_name,
          payloadHash: r.payload_hash,
          receivedAt: r.received_at,
          processedAt: r.processed_at ?? undefined,
        })
      : null;
  }
}