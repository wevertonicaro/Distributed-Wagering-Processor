import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dataSource as ds } from './data-source';

const MIGRATIONS_COUNT = 6;

async function insert(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await ds.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
  return row.id as string;
}

async function newWallet(balance = '100.00', playerId = randomUUID(), currency = 'BRL') {
  return insert('wallets', { id: randomUUID(), player_id: playerId, currency, balance });
}

async function newTx(walletId: string, over: Record<string, unknown> = {}) {
  const ext = randomUUID();
  return insert('wager_transactions', {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: ext,
    idempotency_key: `provider-a:${ext}`,
    payload_hash: 'h',
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    ...over,
  });
}

const processed = () => ({
  status: 'PROCESSED',
  processed_at: new Date(),
  observed_balance: '90.00',
});

async function newLedger(walletId: string, txId: string, over: Record<string, unknown> = {}) {
  return insert('wallet_ledger_entries', {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: txId,
    direction: 'DEBIT',
    amount: '10.00',
    balance_before: '100.00',
    balance_after: '90.00',
    ...over,
  });
}

beforeAll(async () => {
  await ds.initialize();
  const [{ db }] = await ds.query('SELECT current_database() AS db');
  if (!String(db).endsWith('_test')) {
    throw new Error(`Recusando rodar em "${db}": o banco de testes deve terminar com _test`);
  }
  await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ds.runMigrations();
});

afterAll(async () => {
  await ds.destroy();
});

describe('wallets', () => {
  test('saldo negativo é rejeitado', async () => {
    const id = await newWallet('10.00');
    await expect(ds.query(`UPDATE wallets SET balance = -0.01 WHERE id = $1`, [id])).rejects.toThrow(
      /chk_wallets_balance_non_negative/,
    );
  });

  test('version precisa ser >= 1', async () => {
    const id = await newWallet();
    await expect(ds.query(`UPDATE wallets SET version = 0 WHERE id = $1`, [id])).rejects.toThrow(
      /chk_wallets_version_positive/,
    );
  });

  test('uma wallet por (player, currency); outra moeda é permitida', async () => {
    const player = randomUUID();
    await newWallet('0.00', player, 'BRL');
    await expect(newWallet('0.00', player, 'BRL')).rejects.toThrow(/uq_wallets_player_currency/);
    await newWallet('0.00', player, 'USD');
  });
});

describe('wager_transactions', () => {
  test('mesma idempotency key no mesmo provider é rejeitada', async () => {
    const w = await newWallet();
    const key = randomUUID();
    await newTx(w, { idempotency_key: key });
    await expect(newTx(w, { idempotency_key: key })).rejects.toThrow(/uq_wager_tx_provider_idempotency/);
  });

  test('mesmo externalTransactionId no mesmo provider é rejeitado', async () => {
    const w = await newWallet();
    const ext = randomUUID();
    await newTx(w, { external_transaction_id: ext });
    await expect(newTx(w, { external_transaction_id: ext })).rejects.toThrow(/uq_wager_tx_provider_external/);
  });

  test('wallet inexistente é rejeitada pela FK', async () => {
    await expect(newTx(randomUUID())).rejects.toThrow(/fk_wager_tx_wallet/);
  });

  test('kind e status fora do enum são rejeitados', async () => {
    const w = await newWallet();
    await expect(newTx(w, { kind: 'DEPOSIT' })).rejects.toThrow(/chk_wager_tx_kind/);
    await expect(newTx(w, { status: 'DONE' })).rejects.toThrow(/chk_wager_tx_status/);
  });

  test('REFUND/ROLLBACK exigem referência', async () => {
    const w = await newWallet();
    await expect(newTx(w, { kind: 'REFUND' })).rejects.toThrow(/chk_wager_tx_reference_required/);
    await expect(newTx(w, { kind: 'ROLLBACK' })).rejects.toThrow(/chk_wager_tx_reference_required/);
  });

  test('REJECTED/FAILED exigem failure_code', async () => {
    const w = await newWallet();
    await expect(newTx(w, { status: 'REJECTED' })).rejects.toThrow(/chk_wager_tx_failure_code_required/);
    await expect(newTx(w, { status: 'FAILED' })).rejects.toThrow(/chk_wager_tx_failure_code_required/);
  });

  test('PROCESSED exige processed_at e observed_balance', async () => {
    const w = await newWallet();
    await expect(newTx(w, { status: 'PROCESSED' })).rejects.toThrow(/chk_wager_tx_processed_fields/);
  });

  test('OPENING só existe para o provider INTERNAL', async () => {
    const w = await newWallet();
    await expect(newTx(w, { kind: 'OPENING', provider_id: 'provider-a' })).rejects.toThrow(
      /chk_wager_tx_opening_internal/,
    );
    await expect(newTx(w, { kind: 'BET', provider_id: 'INTERNAL' })).rejects.toThrow(
      /chk_wager_tx_opening_internal/,
    );
    await newTx(w, { kind: 'OPENING', provider_id: 'INTERNAL', ...processed() });
  });

  test('uma referência não pode ser revertida duas vezes', async () => {
    const w = await newWallet();
    const bet = await newTx(w, processed());
    await newTx(w, {
      ...processed(),
      kind: 'REFUND',
      reference_transaction_id: bet,
      reference_external_transaction_id: 'bet-ext',
    });
    await expect(
      newTx(w, {
        ...processed(),
        kind: 'ROLLBACK',
        reference_transaction_id: bet,
        reference_external_transaction_id: 'bet-ext',
      }),
    ).rejects.toThrow(/uq_wager_tx_single_reversal/);
  });

  test('reversão REJECTED não consome a referência', async () => {
    const w = await newWallet();
    const bet = await newTx(w, processed());
    await newTx(w, {
      kind: 'REFUND',
      status: 'REJECTED',
      failure_code: 'AMOUNT_MISMATCH',
      reference_transaction_id: bet,
      reference_external_transaction_id: 'bet-ext',
    });
    await newTx(w, {
      ...processed(),
      kind: 'REFUND',
      reference_transaction_id: bet,
      reference_external_transaction_id: 'bet-ext',
    });
  });
});

describe('wallet_ledger_entries', () => {
  test('aritmética inconsistente é rejeitada', async () => {
    const w = await newWallet();
    const tx = await newTx(w, processed());
    await expect(newLedger(w, tx, { balance_after: '50.00' })).rejects.toThrow(/chk_ledger_arithmetic/);
    await expect(
      newLedger(w, tx, { direction: 'CREDIT', balance_before: '100.00', balance_after: '90.00' }),
    ).rejects.toThrow(/chk_ledger_arithmetic/);
  });

  test('valor zero ou negativo é rejeitado', async () => {
    const w = await newWallet();
    const tx = await newTx(w, processed());
    await expect(newLedger(w, tx, { amount: '0.00', balance_after: '100.00' })).rejects.toThrow(
      /chk_ledger_amount_positive/,
    );
  });

  test('no máximo um lançamento por (wallet, transação)', async () => {
    const w = await newWallet();
    const tx = await newTx(w, processed());
    await newLedger(w, tx);
    await expect(newLedger(w, tx)).rejects.toThrow(/uq_ledger_wallet_transaction/);
  });

  test('seq é gerado pelo banco e crescente', async () => {
    const w = await newWallet();
    const tx1 = await newTx(w, processed());
    const tx2 = await newTx(w, processed());
    await newLedger(w, tx1);
    await newLedger(w, tx2, { balance_before: '90.00', balance_after: '80.00' });
    const rows = await ds.query(`SELECT seq FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY seq`, [w]);
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
    await expect(
      ds.query(`INSERT INTO wallet_ledger_entries (seq, id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) VALUES (999, $1, $2, $3, 'DEBIT', 1, 10, 9)`, [randomUUID(), w, tx1]),
    ).rejects.toThrow(/non-DEFAULT value/);
  });

  test('UPDATE e DELETE são bloqueados (imutável)', async () => {
    const w = await newWallet();
    const tx = await newTx(w, processed());
    const id = await newLedger(w, tx);
    await expect(ds.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /immutable/,
    );
    await expect(ds.query(`DELETE FROM wallet_ledger_entries WHERE id = $1`, [id])).rejects.toThrow(
      /immutable/,
    );
  });
});

describe('inbox_messages', () => {
  test('(consumer, messageId) duplicado é rejeitado; outro consumer é permitido', async () => {
    const msg = randomUUID();
    const sql = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ($1,$2,'h')`;
    await ds.query(sql, ['c1', msg]);
    await expect(ds.query(sql, ['c1', msg])).rejects.toThrow(/duplicate key/);
    await ds.query(sql, ['c2', msg]);
  });
});

describe('outbox_messages', () => {
  test('attempts não pode ser negativo', async () => {
    await expect(
      insert('outbox_messages', {
        id: randomUUID(),
        aggregate_id: randomUUID(),
        event_type: 'WalletBalanceChanged',
        payload: JSON.stringify({}),
        occurred_at: new Date(),
        attempts: -1,
      }),
    ).rejects.toThrow(/chk_outbox_attempts_non_negative/);
  });
});

describe('migrations', () => {
  test('são reversíveis e reaplicáveis', async () => {
    for (let i = 0; i < MIGRATIONS_COUNT; i++) await ds.undoLastMigration();
    const [{ t }] = await ds.query(`SELECT to_regclass('public.wallets') AS t`);
    expect(t).toBeNull();

    await ds.runMigrations();
    const [{ t: again }] = await ds.query(`SELECT to_regclass('public.wallets') AS t`);
    expect(again).not.toBeNull();
  });
});