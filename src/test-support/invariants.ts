import { expect } from 'bun:test';
import { DataSource } from 'typeorm';

export async function expectLedgerInvariant(ds: DataSource, walletId: string): Promise<void> {
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