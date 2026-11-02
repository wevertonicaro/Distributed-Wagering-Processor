import { EntityManager } from 'typeorm';
import { ConcurrentModificationError } from '../../../application/errors';
import { WalletRepository } from '../../../application/ports/repositories.port';
import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { rowsOf } from './sql';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toWallet = (r: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromStored(r.balance, r.currency),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(w: Wallet): Promise<boolean> {
    const rows = rowsOf(
      await this.em.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [w.id, w.playerId, w.currency, w.balance.toString(), w.version, w.createdAt, w.updatedAt],
      ),
    );
    return rows.length === 1;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const rows = rowsOf<WalletRow>(
      await this.em.query(
        `SELECT id, player_id, currency, balance, version, created_at, updated_at
           FROM wallets WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async updateBalance(w: Wallet, expectedVersion: number): Promise<void> {
    const rows = rowsOf(
      await this.em.query(
        `UPDATE wallets SET balance = $2, version = $3, updated_at = $4
          WHERE id = $1 AND version = $5
          RETURNING id`,
        [w.id, w.balance.toString(), w.version, w.updatedAt, expectedVersion],
      ),
    );
    if (rows.length !== 1) {
      throw new ConcurrentModificationError(`wallet ${w.id} changed concurrently (expected version ${expectedVersion})`);
    }
  }
}