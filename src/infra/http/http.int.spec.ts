import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { ConcurrentModificationError } from '../../application/errors';
import { setupTestDatabase, teardownTestDatabase } from '../../test-support/test-db';
import { translate } from './domain-exception.filter';

let app: INestApplication;
let ds: DataSource;
let base: string;

beforeAll(async () => {
  ds = await setupTestDatabase();
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
  await teardownTestDatabase();
});

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(balance = '100.00') {
  const playerId = randomUUID();
  const res = await call('POST', '/wallets', { body: { playerId, initialBalance: brl(balance) } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

type Actor = { walletId: string; playerId: string };

const betBody = (a: Actor, over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: a.playerId,
  walletId: a.walletId,
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: brl('25.00'),
  ...over,
});

const submit = (body: any, key: string = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', { body, headers: { 'idempotency-key': key } });

describe('POST /wallets', () => {
  test('201 com saldo e version 1', async () => {
    const res = await call('POST', '/wallets', { body: { playerId: randomUUID(), initialBalance: brl('1000.00') } });
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual(brl('1000.00'));
    expect(res.body.version).toBe(1);
  });

  test('wallet duplicada (player + moeda) é 409', async () => {
    const playerId = randomUUID();
    await call('POST', '/wallets', { body: { playerId, initialBalance: brl('10.00') } });
    const dup = await call('POST', '/wallets', { body: { playerId, initialBalance: brl('10.00') } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('payload inválido é 400', async () => {
    const negative = await call('POST', '/wallets', { body: { playerId: randomUUID(), initialBalance: brl('-1.00') } });
    expect(negative.status).toBe(400);
    expect(negative.body.code).toBe('INVALID_MONEY');

    const badPlayer = await call('POST', '/wallets', { body: { playerId: 'x', initialBalance: brl('1.00') } });
    expect(badPlayer.status).toBe(400);
    expect(badPlayer.body.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /wallets/:id', () => {
  test('200, 404 e 400', async () => {
    const a = await createWallet('50.00');
    const ok = await call('GET', `/wallets/${a.walletId}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: a.walletId, playerId: a.playerId, balance: brl('50.00'), version: 1 });

    const missing = await call('GET', `/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('WALLET_NOT_FOUND');

    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('200 PROCESSED e replay idêntico com idempotentReplay=true', async () => {
    const a = await createWallet();
    const body = betBody(a);
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false });

    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
  });

  test('sem Idempotency-Key: 400', async () => {
    const a = await createWallet();
    const res = await call('POST', '/wagering/transactions', { body: betBody(a) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  test('mesma key com payload diferente: 409 (não é replay)', async () => {
    const a = await createWallet();
    const body = betBody(a);
    await submit(body);
    const conflict = await submit({ ...body, money: brl('26.00') });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('rejeição de negócio: 422 com failureCode; replay mantém 422', async () => {
    const a = await createWallet('10.00');
    const body = betBody(a);
    const rejected = await submit(body);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });

    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  });

  test('referência ausente: 202 PENDING_REFERENCE', async () => {
    const a = await createWallet();
    const res = await submit(betBody(a, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('wallet inexistente: 404', async () => {
    const res = await submit(betBody({ walletId: randomUUID(), playerId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('OPENING não pode ser submetido pela API: 400', async () => {
    const a = await createWallet();
    const res = await submit(betBody(a, { kind: 'OPENING' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WAGER_TRANSACTION');
  });

  test('JSON malformado: 400', async () => {
    const res = await call('POST', '/wagering/transactions', { body: '{bad', headers: { 'idempotency-key': 'k' } });
    expect(res.status).toBe(400);
  });
});

describe('consultas de transação', () => {
  test('por id e por provider + externalTransactionId; 404 quando não existe', async () => {
    const a = await createWallet();
    const body = betBody(a);
    const sent = await submit(body);

    const byId = await call('GET', `/wagering/transactions/${sent.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ status: 'PROCESSED', kind: 'BET', money: brl('25.00'), balance: brl('75.00') });

    const byExternal = await call(
      'GET',
      `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.transactionId).toBe(sent.body.transactionId);

    const missing = await call('GET', `/wagering/transactions/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('GET /wallets/:id/ledger', () => {
  test('cursor opaco percorre todas as entradas sem repetir', async () => {
    const a = await createWallet('100.00');
    for (let i = 0; i < 5; i++) await submit(betBody(a, { money: brl('10.00') }));

    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: any = await call('GET', `/wallets/${a.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(6); // abertura + 5 débitos
    expect(new Set(seen.map((e) => e.id)).size).toBe(6);
    expect(seen[0]).toMatchObject({ direction: 'CREDIT', balanceAfter: brl('100.00') });
    expect(seen[5]).toMatchObject({ direction: 'DEBIT', balanceAfter: brl('50.00') });
  });

  test('parâmetros inválidos: 400; wallet inexistente: 404', async () => {
    const a = await createWallet();
    expect((await call('GET', `/wallets/${a.walletId}/ledger?cursor=zzz`)).status).toBe(400);
    expect((await call('GET', `/wallets/${a.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${a.walletId}/ledger?limit=201`)).status).toBe(400);
    expect((await call('GET', `/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  const divergences = async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    const m = text.match(/^reconciliation_divergences_total (\d+)/m);
    return m ? Number(m[1]) : 0;
  };

  test('consistente: difference 0.00', async () => {
    const a = await createWallet('100.00');
    await submit(betBody(a));
    const res = await call('POST', `/wallets/${a.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: a.walletId,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e contada em métrica, e NÃO é corrigida', async () => {
    const a = await createWallet('100.00');
    await ds.query(`UPDATE wallets SET balance = balance + 1 WHERE id = $1`, [a.walletId]);
    const before = await divergences();

    const res = await call('POST', `/wallets/${a.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: brl('101.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('1.00'),
      consistent: false,
    });
    expect(await divergences()).toBe(before + 1);

    const stillWrong = await call('GET', `/wallets/${a.walletId}`);
    expect(stillWrong.body.balance).toEqual(brl('101.00'));
  });

  test('wallet inexistente: 404', async () => {
    expect((await call('POST', `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
  });
});

describe('health', () => {
  test('live e ready abertos', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });
});

describe('mapeamento de erros (filtro único)', () => {
  test('falha transitória de infraestrutura vira 503 com Retry-After', () => {
    expect(translate(new ConcurrentModificationError('x'))).toMatchObject({ status: 503, retryAfterSeconds: 1 });
    expect(translate(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).status).toBe(503);
    expect(translate({ driverError: { code: '57P01' } }).status).toBe(503);
    expect(translate(new Error('Connection terminated unexpectedly')).status).toBe(503);
  });

  test('erro inesperado vira 500 sem vazar a mensagem interna', () => {
    expect(translate(new Error('segredo interno'))).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'unexpected error' },
    });
  });
});