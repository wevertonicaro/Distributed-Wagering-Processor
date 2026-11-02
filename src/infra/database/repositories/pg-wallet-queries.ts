import { DataSource } from 'typeorm';
import { LedgerSummary, LedgerSummaryReader } from '../../../application/use-cases/reconcile-wallet';
import { Money, MoneyProps } from '../../../domain/money';
import { rowsOf } from './sql';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: Date;
  processedAt?: Date;
}

export interface LedgerRow {
  seq: string;
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

interface TransactionRow {
  id: string; provider_id: string; external_transaction_id: string; wallet_id: string; player_id: string;
  round_id: string; game_id: string; kind: string; amount: string; currency: string; status: string;
  failure_code: string | null; reference_external_transaction_id: string | null;
  reference_transaction_id: string | null; observed_balance: string | null;
  created_at: Date; processed_at: Date | null;
}

const TX_COLUMNS = `id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
  amount, currency, status, failure_code, reference_external_transaction_id, reference_transaction_id,
  observed_balance, created_at, processed_at`;

const toView = (r: TransactionRow): TransactionView => ({
  transactionId: r.id,
  providerId: r.provider_id,
  externalTransactionId: r.external_transaction_id,
  walletId: r.wallet_id,
  playerId: r.player_id,
  roundId: r.round_id,
  gameId: r.game_id,
  kind: r.kind,
  money: { amount: r.amount, currency: r.currency },
  status: r.status,
  failureCode: r.failure_code ?? undefined,
  referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
  referenceTransactionId: r.reference_transaction_id ?? undefined,
  balance: r.observed_balance === null ? undefined : { amount: r.observed_balance, currency: r.currency },
  createdAt: r.created_at,
  processedAt: r.processed_at ?? undefined,
});

export class PgWalletQueries implements LedgerSummaryReader {
  constructor(private readonly ds: DataSource) {}

  async findWallet(id: string): Promise<WalletView | null> {
    const [r] = rowsOf<{ id: string; player_id: string; currency: string; balance: string; version: number }>(
      await this.ds.query(`SELECT id, player_id, currency, balance, version FROM wallets WHERE id = $1`, [id]),
    );
    return r
      ? { id: r.id, playerId: r.player_id, balance: { amount: r.balance, currency: r.currency }, version: r.version }
      : null;
  }

  async findTransactionById(id: string): Promise<TransactionView | null> {
    const [r] = rowsOf<TransactionRow>(
      await this.ds.query(`SELECT ${TX_COLUMNS} FROM wager_transactions WHERE id = $1`, [id]),
    );
    return r ? toView(r) : null;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | null> {
    const [r] = rowsOf<TransactionRow>(
      await this.ds.query(
        `SELECT ${TX_COLUMNS} FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
        [providerId, externalTransactionId],
      ),
    );
    return r ? toView(r) : null;
  }

  async ledgerPage(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerRow[]> {
    const rows = rowsOf<{
      seq: string; id: string; transaction_id: string; direction: string; amount: string;
      balance_before: string; balance_after: string; created_at: Date; currency: string;
    }>(
      await this.ds.query(
        `SELECT l.seq::text AS seq, l.id, l.transaction_id, l.direction, l.amount, l.balance_before,
                l.balance_after, l.created_at, w.currency
           FROM wallet_ledger_entries l JOIN wallets w ON w.id = l.wallet_id
          WHERE l.wallet_id = $1 AND ($2::bigint IS NULL OR l.seq > $2::bigint)
          ORDER BY l.seq
          LIMIT $3`,
        [walletId, afterSeq, limit],
      ),
    );
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      money: { amount: r.amount, currency: r.currency },
      balanceBefore: { amount: r.balance_before, currency: r.currency },
      balanceAfter: { amount: r.balance_after, currency: r.currency },
      createdAt: r.created_at,
    }));
  }

  async summarize(walletId: string): Promise<LedgerSummary | null> {
    const [r] = rowsOf<{ currency: string; stored: string; calculated: string; entries: string }>(
      await this.ds.query(
        `SELECT w.currency, w.balance AS stored,
                COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS calculated,
                COUNT(l.id) AS entries
           FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
          WHERE w.id = $1
          GROUP BY w.id, w.currency, w.balance`,
        [walletId],
      ),
    );
    if (!r) return null;
    return {
      stored: Money.fromStored(r.stored, r.currency),
      calculated: Money.fromStored(r.calculated, r.currency),
      entries: Number(r.entries),
    };
  }
}