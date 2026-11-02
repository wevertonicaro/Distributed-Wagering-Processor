import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ProcessWagerTransactionCommand } from '../../../application/use-cases/process-wager-transaction';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../domain/wagering/wager-transaction';
import { buildApp, PENDING_MAX_ATTEMPTS } from '../../../test-support/app-factory';
import { expectLedgerInvariant } from '../../../test-support/invariants';
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
  const w = await app.createWallet.execute({ playerId, initialBalance: brl(balance) });
  return { walletId: w.id, playerId };
}

function cmd(a: Actor, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
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

const makeDue = (transactionId: string) =>
  ds.query(`UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second' WHERE id = $1`, [
    transactionId,
  ]);

const balance = async (walletId: string) =>
  ((await ds.query(`SELECT balance::text AS balance FROM wallets WHERE id = $1`, [walletId])) as { balance: string }[])[0]
    .balance;

async function eventCounts(walletId: string) {
  const rows = (await ds.query(
    `SELECT event_type, COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 GROUP BY event_type`,
    [walletId],
  )) as { event_type: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
}

async function row(id: string) {
  return ((await ds.query(
    `SELECT status, failure_code, reference_attempts, observed_balance::text AS observed,
            reference_transaction_id IS NOT NULL AS has_reference,
            next_reference_attempt_at > now() + interval '3 seconds' AS far_future
       FROM wager_transactions WHERE id = $1`,
    [id],
  )) as any[])[0];
}

describe.each([
  ['REFUND', K.Refund],
  ['ROLLBACK', K.Rollback],
])('%s entregue antes da BET referenciada', (_, kind) => {
  test('fica PENDING_REFERENCE e o worker aplica quando a referência aparece', async () => {
    const a = await newWallet('100.00');
    const betExt = randomUUID();

    const reversal = await app.process.execute(cmd(a, { kind, referenceExternalTransactionId: betExt }));
    expect(reversal.status).toBe(S.PendingReference);

    await app.process.execute(cmd(a, { externalTransactionId: betExt })); // BET: 100 -> 75
    expect(await balance(a.walletId)).toBe('75.00');

    expect(await app.resolvePending.execute(10)).toEqual([]); // ainda não venceu

    await makeDue(reversal.transactionId);
    const resolved = await app.resolvePending.execute(10);
    expect(resolved).toEqual([{ transactionId: reversal.transactionId, status: S.Processed }]);

    expect(await balance(a.walletId)).toBe('100.00');
    expect(await row(reversal.transactionId)).toMatchObject({ status: S.Processed, observed: '100.00', has_reference: true });
    expect(await eventCounts(a.walletId)).toEqual({
      WagerTransactionProcessed: 3, // abertura, BET e reversão
      WalletBalanceChanged: 3,
      WagerTransactionPendingReference: 1,
    });
    await expectLedgerInvariant(ds, a.walletId);
  });
});

describe('PENDING_REFERENCE', () => {
  test('referência ainda ausente: reagenda com backoff e conta a tentativa, sem repetir o evento', async () => {
    const a = await newWallet();
    const pending = await app.process.execute(
      cmd(a, { kind: K.Refund, referenceExternalTransactionId: randomUUID() }),
    );
    expect((await row(pending.transactionId)).reference_attempts).toBe(1);

    await makeDue(pending.transactionId);
    expect(await app.resolvePending.execute(10)).toEqual([
      { transactionId: pending.transactionId, status: S.PendingReference },
    ]);

    expect(await row(pending.transactionId)).toMatchObject({
      status: S.PendingReference,
      reference_attempts: 2,
      far_future: true, // 2º backoff = 4s
    });
    expect((await eventCounts(a.walletId)).WagerTransactionPendingReference).toBe(1);
    expect(await balance(a.walletId)).toBe('100.00');
  });

  test('esgotado o limite: REJECTED com REFERENCE_NOT_FOUND e evento publicado na outbox', async () => {
    const a = await newWallet();
    const pending = await app.process.execute(
      cmd(a, { kind: K.Refund, referenceExternalTransactionId: randomUUID() }),
    );
    await ds.query(
      `UPDATE wager_transactions SET reference_attempts = $2, next_reference_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [pending.transactionId, PENDING_MAX_ATTEMPTS],
    );

    expect(await app.resolvePending.execute(10)).toEqual([{ transactionId: pending.transactionId, status: S.Rejected }]);
    expect(await row(pending.transactionId)).toMatchObject({ status: S.Rejected, failure_code: 'REFERENCE_NOT_FOUND' });
    expect((await eventCounts(a.walletId)).WagerTransactionRejected).toBe(1);
    expect(await balance(a.walletId)).toBe('100.00');
    await expectLedgerInvariant(ds, a.walletId);
  });

  test('dois workers concorrentes: a reversão é aplicada uma única vez (SKIP LOCKED)', async () => {
    const a = await newWallet('100.00');
    const betExt = randomUUID();
    const refund = await app.process.execute(cmd(a, { kind: K.Refund, referenceExternalTransactionId: betExt }));
    await app.process.execute(cmd(a, { externalTransactionId: betExt }));
    await makeDue(refund.transactionId);

    const [first, second] = await Promise.all([app.resolvePending.execute(10), app.resolvePending.execute(10)]);
    expect(first.length + second.length).toBe(1);
    expect(await balance(a.walletId)).toBe('100.00');
    const [{ credits }] = await ds.query(
      `SELECT COUNT(*)::int AS credits FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`,
      [a.walletId],
    );
    expect(credits).toBe(2); 
    await expectLedgerInvariant(ds, a.walletId);
  });
});