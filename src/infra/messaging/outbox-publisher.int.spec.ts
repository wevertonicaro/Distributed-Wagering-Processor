import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { systemClock } from '../../application/ports/clock.port';
import { EventPublisher } from '../../application/ports/event-publisher.port';
import { PublishOutbox } from '../../application/use-cases/publish-outbox';
import { buildApp } from '../../test-support/app-factory';
import { createEventsQueue, drainQueue } from '../../test-support/sqs-test-utils';
import { setupTestDatabase, teardownTestDatabase } from '../../test-support/test-db';
import { SqsEventPublisher } from './sqs-event-publisher';

let ds: DataSource;
let app: ReturnType<typeof buildApp>;
let events: Awaited<ReturnType<typeof createEventsQueue>>;

beforeAll(async () => {
  ds = await setupTestDatabase();
  app = buildApp(ds);
});
afterAll(teardownTestDatabase);
beforeEach(async () => {
  events = await createEventsQueue();
});
afterEach(() => events.cleanup());

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const BACKOFF = { baseMs: 1000, maxMs: 60_000 };

async function walletWithBets(bets: number) {
  const playerId = randomUUID();
  const w = await app.createWallet.execute({ playerId, initialBalance: brl('1000.00') });
  for (let i = 0; i < bets; i++) {
    const ext = randomUUID();
    await app.process.execute({
      providerId: 'provider-a',
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('10.00'),
    });
  }
  return w.id;
}

const pending = async () =>
  ((await ds.query(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)) as { n: number }[])[0].n;

const realPublisher = () => new SqsEventPublisher(events.sqs, events.url);
const publisherWith = (p: EventPublisher, batchSize = 50) => new PublishOutbox(app.uow, p, systemClock, { batchSize, backoff: BACKOFF });

describe('PublishOutbox', () => {
  test('publica os pendentes no SQS, marca published_at e o envelope é estável', async () => {
    await walletWithBets(2);
    const total = await pending();
    expect(total).toBe(2 + 2 * 2); 

    const result = await publisherWith(realPublisher()).execute();
    expect(result).toEqual({ published: total, failed: 0 });
    expect(await pending()).toBe(0);

    const bodies = (await drainQueue(events.sqs, events.url, { expected: total })).map((b) => JSON.parse(b));
    expect(new Set(bodies.map((b) => b.eventId)).size).toBe(total);
    const balanceChanged = bodies.find((b) => b.eventType === 'WalletBalanceChanged');
    expect(balanceChanged).toMatchObject({ version: 1 });
    expect(Object.keys(balanceChanged).sort()).toEqual(
      ['aggregateId', 'causationId', 'correlationId', 'data', 'eventId', 'eventType', 'occurredAt', 'version'].sort(),
    );
    expect(typeof balanceChanged.data.money.amount).toBe('string'); 
  });

  test('falha ao publicar: reagenda com backoff e outra instância assume depois', async () => {
    await walletWithBets(1);
    const total = await pending();

    const failing: EventPublisher = {
      publish: async () => {
        throw new Error('SQS indisponível (simulado)');
      },
    };
    expect(await publisherWith(failing).execute()).toEqual({ published: 0, failed: total });

    const [row] = (await ds.query(
      `SELECT MIN(attempts) AS attempts, bool_and(next_attempt_at > now()) AS scheduled,
              bool_and(last_error LIKE '%simulado%') AS has_error
         FROM outbox_messages WHERE published_at IS NULL`,
    )) as any[];
    expect(Number(row.attempts)).toBe(1);
    expect(row.scheduled).toBe(true);
    expect(row.has_error).toBe(true);

    expect(await publisherWith(realPublisher()).execute()).toEqual({ published: 0, failed: 0 }); 

    await ds.query(`UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second' WHERE published_at IS NULL`);
    expect(await publisherWith(realPublisher()).execute()).toEqual({ published: total, failed: 0 });
    expect(await pending()).toBe(0);
  });

  test('dois publishers sobre a mesma outbox: cada evento é publicado exatamente uma vez', async () => {
    await Promise.all(Array.from({ length: 5 }, () => walletWithBets(4)));
    const total = await pending();

    const calls = new Map<string, number>();
    const real = realPublisher();
    const counting: EventPublisher = {
      publish: async (m) => {
        calls.set(m.id, (calls.get(m.id) ?? 0) + 1);
        await real.publish(m);
      },
    };

    const drain = async (p: PublishOutbox) => {
      for (;;) {
        const r = await p.execute();
        if (r.published + r.failed === 0) return;
      }
    };
    await Promise.all([drain(publisherWith(counting, 5)), drain(publisherWith(counting, 5))]);

    expect(calls.size).toBe(total);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(await pending()).toBe(0);
    const bodies = await drainQueue(events.sqs, events.url, { expected: total });
    expect(new Set(bodies.map((b) => JSON.parse(b).eventId)).size).toBe(total);
  });
});