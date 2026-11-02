import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConcurrentModificationError } from '../../application/errors';
import { buildApp } from '../../test-support/app-factory';
import {
  createTestQueues,
  publish,
  queueDepth,
  readDlq,
  sleep,
  TestQueues,
  wagerMessage,
  waitFor,
} from '../../test-support/sqs-test-utils';
import { setupTestDatabase, teardownTestDatabase } from '../../test-support/test-db';
import { MessageHandler, SqsConsumer, SqsConsumerOptions } from './sqs-consumer';
import { toCommand } from './wager-message';

setDefaultTimeout(60_000);

const CONSUMER = 'test-consumer';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let ds: DataSource;
let app: ReturnType<typeof buildApp>;
let q: TestQueues;
let consumers: SqsConsumer[] = [];
let extraQueues: TestQueues[] = [];

beforeAll(async () => {
  ds = await setupTestDatabase();
  app = buildApp(ds);
});
afterAll(teardownTestDatabase);

beforeEach(async () => {
  q = await createTestQueues();
});

afterEach(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  consumers = [];
  await q.cleanup();
  await Promise.all(extraQueues.map((x) => x.cleanup()));
  extraQueues = [];
});

const realHandler: MessageHandler = async (body) => {
  await app.process.execute(toCommand(body, CONSUMER));
};

function startConsumer(handler: MessageHandler = realHandler, over: Partial<SqsConsumerOptions> = {}, queues = q) {
  const consumer = new SqsConsumer(queues.sqs, handler, {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 10,
    concurrency: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 2,
    ...over,
  });
  consumer.start();
  consumers.push(consumer);
  return consumer;
}

type Actor = { walletId: string; playerId: string };

async function newWallet(balance = '100.00'): Promise<Actor> {
  const playerId = randomUUID();
  const wallet = await app.createWallet.execute({ playerId, initialBalance: brl(balance) });
  return { walletId: wallet.id, playerId };
}

function betData(a: Actor, over: Record<string, unknown> = {}) {
  const ext = (over.externalTransactionId as string) ?? randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: a.playerId,
    walletId: a.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...over,
  };
}

const send = (a: Actor, data: Record<string, unknown>, messageId: string = randomUUID(), queues = q) =>
  publish(queues, wagerMessage(data, messageId), { groupId: a.walletId });

const balance = async (walletId: string) =>
  ((await ds.query(`SELECT balance::text AS balance FROM wallets WHERE id = $1`, [walletId])) as { balance: string }[])[0]
    .balance;

const debits = async (walletId: string) =>
  ((await ds.query(
    `SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [walletId],
  )) as { n: number }[])[0].n;

const inboxRows = async (messageId: string) =>
  ((await ds.query(`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`, [
    CONSUMER,
    messageId,
  ])) as { n: number }[])[0].n;

const betTransactions = async (walletId: string) =>
  (await ds.query(
    `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'`,
    [walletId],
  )) as { status: string; failure_code: string | null }[];

const emptyQueue = () => waitFor(async () => (await queueDepth(q)) === 0);

describe('processamento', () => {
  test('BET: debita, grava ledger e inbox, e a mensagem sai da fila (ack pós-commit)', async () => {
    const a = await newWallet();
    const messageId = randomUUID();
    startConsumer();
    await send(a, betData(a), messageId);

    await waitFor(async () => (await balance(a.walletId)) === '75.00');
    await emptyQueue();
    expect(await debits(a.walletId)).toBe(1);
    expect(await inboxRows(messageId)).toBe(1);
  });

  test('redelivery: o mesmo messageId entregue 2 vezes não duplica efeitos', async () => {
    const a = await newWallet();
    const messageId = randomUUID();
    const body = wagerMessage(betData(a), messageId);
    await publish(q, body, { groupId: a.walletId });
    await publish(q, body, { groupId: a.walletId });
    startConsumer();

    await waitFor(async () => (await balance(a.walletId)) === '75.00');
    await emptyQueue();
    expect(await debits(a.walletId)).toBe(1);
    expect(await inboxRows(messageId)).toBe(1);
  });

  test('usa o mesmo caso de uso do HTTP: transação já aplicada vira replay, sem novo débito', async () => {
    const a = await newWallet();
    const data = betData(a);
    const first = await app.process.execute(data);
    expect(first.idempotentReplay).toBe(false);

    const messageId = randomUUID();
    startConsumer();
    await send(a, data, messageId);

    await waitFor(async () => (await inboxRows(messageId)) === 1);
    await emptyQueue();
    expect(await debits(a.walletId)).toBe(1);
    expect(await balance(a.walletId)).toBe('75.00');
  });

  test('rejeição de negócio é terminal: transação REJECTED persistida, ack e DLQ vazia', async () => {
    const a = await newWallet('10.00');
    startConsumer();
    await send(a, betData(a));

    await waitFor(async () => (await betTransactions(a.walletId)).length === 1);
    await emptyQueue();
    expect(await betTransactions(a.walletId)).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }]);
    expect(await balance(a.walletId)).toBe('10.00');
    expect(await readDlq(q, 0, 1500)).toHaveLength(0);
  });

  test('wallet inexistente: ack sem persistir nada', async () => {
    const ghost = { walletId: randomUUID(), playerId: randomUUID() };
    const data = betData(ghost);
    startConsumer();
    await send(ghost, data);

    await emptyQueue();
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE idempotency_key = $1`, [
      data.idempotencyKey,
    ]);
    expect(n).toBe(0);
    expect(await readDlq(q, 0, 1500)).toHaveLength(0);
  });
});

describe('erros permanentes: DLQ imediata', () => {
  test('JSON inválido, OPENING e valor inválido vão para a DLQ e não deixam efeito', async () => {
    const a = await newWallet();
    startConsumer();
    await publish(q, '{not json', { groupId: a.walletId });
    await send(a, betData(a, { kind: 'OPENING' }));
    await send(a, betData(a, { money: brl('-5.00') }));

    const dead = await readDlq(q, 3);
    expect(dead.map((d) => d.failureCode).sort()).toEqual([
      'INVALID_MONEY',
      'INVALID_WAGER_TRANSACTION',
      'MALFORMED_MESSAGE',
    ]);
    await emptyQueue();
    expect(await betTransactions(a.walletId)).toEqual([]);
    expect(await balance(a.walletId)).toBe('100.00');
  });

  test('mesmo messageId com payload diferente vai para a DLQ e não altera o saldo', async () => {
    const a = await newWallet();
    const messageId = randomUUID();
    startConsumer();
    await send(a, betData(a), messageId);
    await waitFor(async () => (await balance(a.walletId)) === '75.00');

    await send(a, betData(a, { money: brl('26.00') }), messageId);
    const dead = await readDlq(q, 1);
    expect(dead[0].failureCode).toBe('INBOX_PAYLOAD_MISMATCH');
    expect(await balance(a.walletId)).toBe('75.00');
    expect(await debits(a.walletId)).toBe(1);
  });
});

describe('erros transitórios', () => {
  test('retry com backoff: processa na segunda tentativa, sem duplicar efeitos', async () => {
    const a = await newWallet();
    let calls = 0;
    startConsumer(async (body) => {
      calls++;
      if (calls === 1) throw new ConcurrentModificationError('falha transitória simulada');
      await realHandler(body);
    });
    await send(a, betData(a));

    await waitFor(async () => (await balance(a.walletId)) === '75.00');
    await emptyQueue();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await debits(a.walletId)).toBe(1);
  });

  test('limite de tentativas: estourado o maxReceiveCount a mensagem vai para a DLQ', async () => {
    const limited = await createTestQueues(2);
    extraQueues.push(limited);
    const a = await newWallet();
    let calls = 0;
    startConsumer(
      async () => {
        calls++;
        throw new Error('banco indisponível (simulado)');
      },
      {},
      limited,
    );
    await send(a, betData(a), randomUUID(), limited);

    const dead = await readDlq(limited, 1, 40_000);
    expect(dead).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await betTransactions(a.walletId)).toEqual([]);
  });
});

describe('shutdown (SIGTERM)', () => {
  test('conclui a mensagem em andamento e devolve as não iniciadas; nada é perdido nem duplicado', async () => {
    const a = await newWallet('100.00');
    for (let i = 0; i < 3; i++) await send(a, betData(a, { money: brl('10.00') }));

    let started = 0;
    const slow: MessageHandler = async (body) => {
      started++;
      await sleep(800);
      await realHandler(body);
    };
    const first = startConsumer(slow, { concurrency: 1 });
    await waitFor(() => started >= 1);
    await first.stop(); 

    expect(started).toBe(1);
    expect(await debits(a.walletId)).toBe(1);

    startConsumer();
    await waitFor(async () => (await balance(a.walletId)) === '70.00');
    await emptyQueue();
    expect(await debits(a.walletId)).toBe(3);
  });
});