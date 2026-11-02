import { EntityManager } from 'typeorm';
import { LedgerRepository } from '../../../application/ports/repositories.port';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await this.em.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.id, e.walletId, e.transactionId, e.direction,
        e.money.toString(), e.balanceBefore.toString(), e.balanceAfter.toString(), e.createdAt,
      ],
    );
  }
}