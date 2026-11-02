import type { Subprocess } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { systemClock } from '../../src/application/ports/clock.port';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import { env } from '../../src/infra/config/env';
import { SqsEventPublisher } from '../../src/infra/messaging/sqs-event-publisher';
import { buildApp } from '../../src/test-support/app-factory';
import { expectLedgerInvariant } from '../../src/test-support/invariants';
import {
  createEventsQueue,
  createTestQueues,
  drainQueue,
  publish,
  queueDepth,
  readDlq,
  TestQueues,
  wagerMessage,
  waitFor,
} from '../../src/test-support/sqs-test-utils';
import { setupTestDatabase, teardownTestDatabase } from '../../src/test-support/test-db';

setDefaultTimeout(180_000);

const ROOT = resolve(__dirname, '..', '..');
const CONSUMER = 'mp-consumer';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let ds: DataSource;
let app: ReturnType<typeof buildApp>;
let q: TestQueues;
let events: Awaited<ReturnType<typeof createEventsQueue>>;
let children: Subprocess[] = [];

beforeAll(async () => {
  ds = await setupTestDatabase();
  app = buildApp(ds);
});
afterAll(teardownTestDatabase);

beforeEach(async () => {
  q = await createTestQueues(5);
  events = await createEventsQueue();
});

afterEach(async () => {
  children.forEach((c) => c.kill('SIGKILL'));
  await Promise.all(children.map((c) => c.exited));
  children = [];
  await q.cleanup();
  await events.cleanup();
});

function childEnv(port = 0) {
  return {
    ...process.env,
    DATABASE_URL: env.db.url,
    SQS_WAGER_QUEUE_URL: q.queueUrl,
    SQS_WAGER_DLQ_URL: q.dlqUrl,
    SQS_EVENTS_QUEUE_URL: events.url,
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_MAX_RECEIVE_COUNT: '5',
    CONSUMER_NAME: CONSUMER,
    CONSUMER_CONCURRENCY: '2',
    WORKER_PORT: String(port),
    DB_POOL_MAX: '5',
    OUTBOX_POLL_INTERVAL_MS: '200',
    LOG_LEVEL: 'warn',
    SHUTDOWN_TIMEOUT_MS: '5000',
  };
}

function spawn(script: string, port = 0): Subprocess {
  const proc = Bun.spawn([process.execPath, 'run', script], {
    cwd: ROOT,
    env: childEnv(port),
    stdout: 'inherit',
    stderr: 'inherit',
  });

  children.push(proc);
  return proc;
}

async function startWorker(): Promise<Subprocess> {
  const port = 41_000 + Math.floor(Math.random() * 8_000);
  const proc = spawn('src/worker.ts', port);
  await waitFor(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
      } catch {
        return false;
      }
    },
    30_000,
    300,
  );
  return proc;
}

type Actor = { walletId: string; playerId: string };

async function newWallet(balance = '100.00'): Promise<Actor> {
  const playerId = randomUUID();
  const w = await app.createWallet.execute({ playerId, initialBalance: brl(balance) });
  return { walletId: w.id, playerId };
}

function betData(a: Actor, money = '10.00') {
  const ext = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: a.playerId,
    walletId: a.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl(money),
  };
}


const publishFree = (body: unknown) => publish(q, body, { groupId: randomUUID() });

const count = async (sql: string, params: unknown[] = []) =>
  ((await ds.query(sql, params)) as { n: number }[])[0].n;
const betCount = (walletId: string, status?: string) =>
  count(
    `SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' AND ($2::text IS NULL OR status = $2)`,
    [walletId, status ?? null],
  );
const debits = (walletId: string) =>
  count(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId]);
const balance = async (walletId: string) =>
  ((await ds.query(`SELECT balance::text AS balance FROM wallets WHERE id = $1`, [walletId])) as { balance: string }[])[0]
    .balance;
const pendingOutbox = () => count(`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);

describe('várias instâncias', () => {
  test('3 processos na mesma fila: hot wallet, wallets distintas e entregas duplicadas, sem débito duplicado', async () => {
    const hot = await newWallet('100.00');
    const others = await Promise.all(Array.from({ length: 5 }, () => newWallet('100.00')));
    await Promise.all([startWorker(), startWorker(), startWorker()]);

    const messageIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const data = betData(hot, '10.00');
      const first = wagerMessage(data);
      messageIds.push(first.messageId);
      await publishFree(first);
      await publishFree(first);
      const retry = wagerMessage(data); 
      messageIds.push(retry.messageId);
      await publishFree(retry);
    }
    for (const o of others) await publishFree(wagerMessage(betData(o, '30.00')));

    await waitFor(
      async () => (await betCount(hot.walletId)) === 30 && (await queueDepth(q)) === 0,
      120_000,
      500,
    );

    expect(await betCount(hot.walletId, 'PROCESSED')).toBe(10);
    expect(await betCount(hot.walletId, 'REJECTED')).toBe(20);
    expect(await balance(hot.walletId)).toBe('0.00');
    expect(await debits(hot.walletId)).toBe(10);
    await expectLedgerInvariant(ds, hot.walletId);

    for (const o of others) {
      expect(await balance(o.walletId)).toBe('70.00');
      expect(await debits(o.walletId)).toBe(1);
      await expectLedgerInvariant(ds, o.walletId);
    }

    expect(
      await count(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE consumer_name = $1 AND message_id = ANY($2)`, [
        CONSUMER,
        messageIds,
      ]),
    ).toBe(60);
    expect(await readDlq(q, 0, 1500)).toHaveLength(0);

    await waitFor(async () => (await pendingOutbox()) === 0, 60_000, 500);
  });

  test('worker morto (SIGKILL) no meio do lote e reiniciado: consistência final', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => newWallet('200.00')));
    const workers = await Promise.all([startWorker(), startWorker(), startWorker()]);

    for (const w of wallets) {
      for (let i = 0; i < 20; i++) await publishFree(wagerMessage(betData(w, '5.00')));
    }

    await waitFor(
      async () =>
        (await count(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND wallet_id = ANY($1)`, [
          wallets.map((w) => w.walletId),
        ])) >= 10,
      60_000,
      200,
    );
    workers[0].kill('SIGKILL'); 
    await startWorker(); 

    await waitFor(
      async () =>
        (await queueDepth(q)) === 0 &&
        (await count(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND wallet_id = ANY($1)`, [
          wallets.map((w) => w.walletId),
        ])) === 60,
      120_000,
      500,
    );

    for (const w of wallets) {
      expect(await betCount(w.walletId, 'PROCESSED')).toBe(20);
      expect(await betCount(w.walletId, 'REJECTED')).toBe(0);
      expect(await debits(w.walletId)).toBe(20);
      expect(await balance(w.walletId)).toBe('100.00');
      await expectLedgerInvariant(ds, w.walletId);
    }
    const [{ total, distinct }] = (await ds.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT external_transaction_id)::int AS distinct
         FROM wager_transactions WHERE kind = 'BET' AND wallet_id = ANY($1)`,
      [wallets.map((w) => w.walletId)],
    )) as { total: number; distinct: number }[];
    expect(total).toBe(distinct);
    expect(await readDlq(q, 0, 1500)).toHaveLength(0);
  });
});

describe('falhas entre commit e ack / publicação', () => {
  test('worker morre DEPOIS do commit e ANTES do ack: a redelivery não duplica o débito', async () => {
    const a = await newWallet('100.00');
    const port = 41_000 + Math.floor(Math.random() * 8_000);
    const crashing = spawn('test/support/crash-after-commit-worker.ts', port);
    const messageId = randomUUID();
    await publishFree(wagerMessage(betData(a, '25.00'), messageId));

    expect(await crashing.exited).toBe(137);

    expect(await balance(a.walletId)).toBe('75.00');
    expect(await debits(a.walletId)).toBe(1);
    expect(
      await count(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`, [
        CONSUMER,
        messageId,
      ]),
    ).toBe(1);
    expect(await queueDepth(q)).toBe(1);

    await startWorker();
    await waitFor(async () => (await queueDepth(q)) === 0, 60_000, 500);

    expect(await balance(a.walletId)).toBe('75.00');
    expect(await debits(a.walletId)).toBe(1);
    await expectLedgerInvariant(ds, a.walletId);
    expect(await readDlq(q, 0, 1500)).toHaveLength(0);
  });

  test('commit no Postgres, processo morre ao publicar: outra instância publica e a duplicata é segura', async () => {
    const a = await newWallet('100.00');
    for (let i = 0; i < 2; i++) await app.process.execute(betData(a, '10.00'));
    const total = await pendingOutbox();
    expect(total).toBeGreaterThan(0);

    const port = 41_000 + Math.floor(Math.random() * 8_000);
    const crashing = spawn('test/support/crash-after-publish.ts', port);
    expect(await crashing.exited).toBe(137);
    expect(await pendingOutbox()).toBe(total);

    const real = new SqsEventPublisher(events.sqs, events.url);
    const backoff = { baseMs: 1000, maxMs: 60_000 };
    const takeover = [1, 2].map(() => new PublishOutbox(app.uow, real, systemClock, { batchSize: 5, backoff }));
    await waitFor(
      async () => {
        await Promise.all(takeover.map((p) => p.execute()));
        return (await pendingOutbox()) === 0;
      },
      30_000,
      300,
    );

    const bodies = (await drainQueue(events.sqs, events.url, { expected: total, timeoutMs: 15_000 })).map((b) => JSON.parse(b));
    const ids = new Set(bodies.map((b) => b.eventId));
    expect(ids.size).toBe(total);
    const byId = new Map<string, string[]>();
    for (const b of bodies) byId.set(b.eventId, [...(byId.get(b.eventId) ?? []), JSON.stringify(b)]);
    for (const copies of byId.values()) expect(new Set(copies).size).toBe(1);
  });
});