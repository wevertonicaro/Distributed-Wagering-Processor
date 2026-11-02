import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../application/errors';
import { ProcessWagerTransactionCommand } from '../../../application/use-cases/process-wager-transaction';
import { FailureCode } from '../../../domain/wagering/failure-code';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../domain/wagering/wager-transaction';
import { buildApp } from '../../../test-support/app-factory';
import { setupTestDatabase, teardownTestDatabase } from '../../../test-support/test-db';

let ds: DataSource;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  ds = await setupTestDatabase();
  app = buildApp(ds);
});
afterAll(teardownTestDatabase);

const brl = (amount: string) => ({ amount, currency: 'BRL' });

type Actor = { walletId: string; playerId: string };

async function newWallet(balance = '100.00'): Promise<Actor> {
  const playerId = randomUUID();
  const wallet = await app.createWallet.execute({ playerId, initialBalance: brl(balance) });
  return { walletId: wallet.id, playerId };
}

function command(a: Actor, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  const ext = over.externalTransactionId ?? randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: a.playerId,
    walletId: a.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: K.Bet,
    money: brl('25.00'),
    ...over,
  };
}

async function ledger(walletId: string) {
  return (await ds.query(
    `SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY seq`,
    [walletId],
  )) as { direction: string; amount: string }[];
}

async function eventTypes(walletId: string) {
  const rows = (await ds.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`, [
    walletId,
  ])) as { event_type: string }[];
  return rows.map((r) => r.event_type);
}

async function walletState(walletId: string) {
  const [row] = (await ds.query(`SELECT balance::text AS balance, version FROM wallets WHERE id = $1`, [walletId])) as {
    balance: string;
    version: number;
  }[];
  return row;
}

async function expectLedgerInvariant(walletId: string) {
  const [sum] = (await ds.query(
    `SELECT w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.id, w.balance`,
    [walletId],
  )) as { consistent: boolean }[];
  expect(sum.consistent).toBe(true);

  const [chain] = (await ds.query(
    `WITH ordered AS (
       SELECT balance_before, LAG(balance_after, 1, 0.00::numeric) OVER (ORDER BY seq) AS prev_after
         FROM wallet_ledger_entries WHERE wallet_id = $1)
     SELECT COUNT(*) FILTER (WHERE balance_before <> prev_after)::int AS broken FROM ordered`,
    [walletId],
  )) as { broken: number }[];
  expect(chain.broken).toBe(0);
}

describe('CreateWallet', () => {
  test('saldo inicial gera OPENING + CREDIT no ledger + eventos, na mesma transação', async () => {
    const a = await newWallet('1000.00');
    expect(await ledger(a.walletId)).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);
    expect(await walletState(a.walletId)).toEqual({ balance: '1000.00', version: 1 });
    expect(await eventTypes(a.walletId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [opening] = await ds.query(
      `SELECT kind, provider_id, status FROM wager_transactions WHERE wallet_id = $1`,
      [a.walletId],
    );
    expect(opening).toEqual({ kind: 'OPENING', provider_id: 'INTERNAL', status: 'PROCESSED' });
    await expectLedgerInvariant(a.walletId);
  });

  test('saldo inicial zero não gera ledger nem eventos', async () => {
    const a = await newWallet('0.00');
    expect(await ledger(a.walletId)).toEqual([]);
    expect(await eventTypes(a.walletId)).toEqual([]);
  });

  test('wallet duplicada (player + moeda) falha como conflito e não deixa lixo', async () => {
    const playerId = randomUUID();
    await app.createWallet.execute({ playerId, initialBalance: brl('10.00') });
    await expect(app.createWallet.execute({ playerId, initialBalance: brl('99.00') })).rejects.toThrow(
      WalletAlreadyExistsError,
    );
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM wallets WHERE player_id = $1`, [playerId]);
    expect(count).toBe(1);
  });
});

describe('ProcessWagerTransaction: regras', () => {
  test('BET debita, gera 1 lançamento DEBIT e eventos', async () => {
    const a = await newWallet();
    const result = await app.process.execute(command(a));
    expect(result.status).toBe(S.Processed);
    expect(result.balance).toEqual(brl('75.00'));
    expect(result.idempotentReplay).toBe(false);
    expect(await walletState(a.walletId)).toEqual({ balance: '75.00', version: 2 });
    expect((await ledger(a.walletId)).slice(1)).toEqual([{ direction: 'DEBIT', amount: '25.00' }]);
    expect((await eventTypes(a.walletId)).slice(2)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await expectLedgerInvariant(a.walletId);
  });

  test('replay devolve o resultado original, com o saldo observado na época', async () => {
    const a = await newWallet();
    const bet = command(a);
    const first = await app.process.execute(bet);
    await app.process.execute(command(a, { kind: K.Win, money: brl('10.00') })); 

    const replay = await app.process.execute(bet);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(brl('75.00'));
    expect((await ledger(a.walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('mesma key com payload diferente é conflito, não replay', async () => {
    const a = await newWallet();
    const bet = command(a);
    await app.process.execute(bet);
    await expect(app.process.execute({ ...bet, money: brl('26.00') })).rejects.toThrow(IdempotencyConflictError);
    expect((await walletState(a.walletId)).balance).toBe('75.00');
  });

  test('mesmo externalTransactionId com outra key é conflito', async () => {
    const a = await newWallet();
    const bet = command(a);
    await app.process.execute(bet);
    await expect(app.process.execute({ ...bet, idempotencyKey: 'outra-key' })).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  test('WIN credita; LOSS não move saldo nem gera lançamento', async () => {
    const a = await newWallet();
    await app.process.execute(command(a, { kind: K.Win, money: brl('40.00') }));
    const loss = await app.process.execute(command(a, { kind: K.Loss, money: brl('0.00') }));
    expect(loss.status).toBe(S.Processed);
    expect((await walletState(a.walletId)).balance).toBe('140.00');
    expect(await ledger(a.walletId)).toHaveLength(2); 
    expect((await eventTypes(a.walletId)).slice(-1)).toEqual(['WagerTransactionProcessed']); 
    await expectLedgerInvariant(a.walletId);
  });

  test('saldo insuficiente: REJECTED auditável, sem ledger e com evento', async () => {
    const a = await newWallet('10.00');
    const result = await app.process.execute(command(a, { money: brl('25.00') }));
    expect(result.status).toBe(S.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toBeUndefined();
    expect(await walletState(a.walletId)).toEqual({ balance: '10.00', version: 1 });
    expect(await ledger(a.walletId)).toHaveLength(1);
    expect((await eventTypes(a.walletId)).slice(2)).toEqual(['WagerTransactionRejected']);

    const [row] = await ds.query(`SELECT status, failure_code FROM wager_transactions WHERE id = $1`, [
      result.transactionId,
    ]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('REFUND credita a BET; segunda reversão da mesma BET é rejeitada', async () => {
    const a = await newWallet();
    const betExt = randomUUID();
    await app.process.execute(command(a, { externalTransactionId: betExt }));

    const refund = await app.process.execute(
      command(a, { kind: K.Refund, referenceExternalTransactionId: betExt }),
    );
    expect(refund.status).toBe(S.Processed);
    expect(refund.balance).toEqual(brl('100.00'));

    const rollback = await app.process.execute(
      command(a, { kind: K.Rollback, referenceExternalTransactionId: betExt }),
    );
    expect(rollback.status).toBe(S.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await walletState(a.walletId)).balance).toBe('100.00');
    await expectLedgerInvariant(a.walletId);
  });

  test('ROLLBACK de WIN debita; se deixaria saldo negativo: REVERSAL_WOULD_OVERDRAW', async () => {
    const a = await newWallet('100.00');
    const winExt = randomUUID();
    await app.process.execute(command(a, { kind: K.Win, money: brl('50.00'), externalTransactionId: winExt })); // 150
    await app.process.execute(command(a, { money: brl('140.00') })); // 10

    const rollback = await app.process.execute(
      command(a, { kind: K.Rollback, money: brl('50.00'), referenceExternalTransactionId: winExt }),
    );
    expect(rollback.status).toBe(S.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect((await walletState(a.walletId)).balance).toBe('10.00');
    await expectLedgerInvariant(a.walletId);
  });

  test('ROLLBACK de WIN com saldo suficiente debita', async () => {
    const a = await newWallet('100.00');
    const winExt = randomUUID();
    await app.process.execute(command(a, { kind: K.Win, money: brl('30.00'), externalTransactionId: winExt }));
    const rollback = await app.process.execute(
      command(a, { kind: K.Rollback, money: brl('30.00'), referenceExternalTransactionId: winExt }),
    );
    expect(rollback.status).toBe(S.Processed);
    expect(rollback.balance).toEqual(brl('100.00'));
    await expectLedgerInvariant(a.walletId);
  });

  test('referências inválidas: valor diferente e rodada diferente', async () => {
    const a = await newWallet();
    const betExt = randomUUID();
    await app.process.execute(command(a, { externalTransactionId: betExt }));

    const wrongAmount = await app.process.execute(
      command(a, { kind: K.Refund, money: brl('10.00'), referenceExternalTransactionId: betExt }),
    );
    expect(wrongAmount.failureCode).toBe(FailureCode.AmountMismatch);

    const wrongRound = await app.process.execute(
      command(a, { kind: K.Refund, roundId: 'round-2', referenceExternalTransactionId: betExt }),
    );
    expect(wrongRound.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await walletState(a.walletId)).balance).toBe('75.00');
  });

  test('reversão antes da referência fica PENDING_REFERENCE, sem mexer no saldo', async () => {
    const a = await newWallet();
    const result = await app.process.execute(
      command(a, { kind: K.Refund, referenceExternalTransactionId: randomUUID() }),
    );
    expect(result.status).toBe(S.PendingReference);
    expect((await walletState(a.walletId)).balance).toBe('100.00');
    expect((await eventTypes(a.walletId)).slice(2)).toEqual(['WagerTransactionPendingReference']);
    const [row] = await ds.query(
      `SELECT reference_attempts, next_reference_attempt_at IS NOT NULL AS scheduled FROM wager_transactions WHERE id = $1`,
      [result.transactionId],
    );
    expect(row).toEqual({ reference_attempts: 1, scheduled: true });
  });

  test('wallet de outro player: REJECTED WALLET_PLAYER_MISMATCH', async () => {
    const a = await newWallet();
    const result = await app.process.execute(command(a, { playerId: randomUUID() }));
    expect(result.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test('wallet inexistente: 404 sem persistir nada', async () => {
    const ghost = { walletId: randomUUID(), playerId: randomUUID() };
    const cmd = command(ghost);
    await expect(app.process.execute(cmd)).rejects.toThrow(WalletNotFoundError);
    const [{ count }] = await ds.query(
      `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE idempotency_key = $1`,
      [cmd.idempotencyKey],
    );
    expect(count).toBe(0);
  });
});

describe('ProcessWagerTransaction: concorrência (paralelismo real)', () => {
  test('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const a = await newWallet('100.00');
    const results = await Promise.all([
      app.process.execute(command(a, { money: brl('80.00') })),
      app.process.execute(command(a, { money: brl('80.00') })),
    ]);

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === S.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await walletState(a.walletId)).balance).toBe('20.00');
    expect((await ledger(a.walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await expectLedgerInvariant(a.walletId);
  });

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const a = await newWallet('100.00');
    const bet = command(a);
    const results = await Promise.all(Array.from({ length: 50 }, () => app.process.execute(bet)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance?.amount === '75.00')).toBe(true);
    expect((await ledger(a.walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await walletState(a.walletId)).balance).toBe('75.00');
    await expectLedgerInvariant(a.walletId);
  });

  test('hot wallet: 30 apostas de 10 sobre saldo 100 => exatamente 10 aceitas', async () => {
    const a = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => app.process.execute(command(a, { money: brl('10.00') }))),
    );

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === S.Rejected)).toHaveLength(20);
    expect((await walletState(a.walletId)).balance).toBe('0.00');
    expect(await ledger(a.walletId)).toHaveLength(11); 
    await expectLedgerInvariant(a.walletId);
  });

  test('wallets distintas processam em paralelo, cada uma consistente', async () => {
    const actors = await Promise.all(Array.from({ length: 20 }, () => newWallet('100.00')));
    const results = await Promise.all(actors.map((a) => app.process.execute(command(a, { money: brl('30.00') }))));

    expect(results.every((r) => r.status === S.Processed)).toBe(true);
    for (const a of actors) {
      expect((await walletState(a.walletId)).balance).toBe('70.00');
      await expectLedgerInvariant(a.walletId);
    }
  });
});