import { EntityManager } from 'typeorm';
import { ConcurrentModificationError } from '../../../application/errors';
import { WagerTransactionRepository } from '../../../application/ports/repositories.port';
import { Money } from '../../../domain/money';
import { FailureCode } from '../../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction';
import { rowsOf } from './sql';

interface Row {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
}

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance, reference_attempts,
  next_reference_attempt_at, created_at, processed_at`;

const toTransaction = (r: Row): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromStored(r.amount, r.currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    createdAt: r.created_at,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined,
    observedBalance: r.observed_balance === null ? undefined : Money.fromStored(r.observed_balance, r.currency),
    referenceAttempts: r.reference_attempts,
    nextReferenceAttemptAt: r.next_reference_attempt_at ?? undefined,
    processedAt: r.processed_at ?? undefined,
  });

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const rows = rowsOf(
      await this.em.query(
        `INSERT INTO wager_transactions (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash,
          tx.walletId, tx.playerId, tx.roundId, tx.gameId, tx.kind,
          tx.money.toString(), tx.money.currency,
          tx.referenceExternalTransactionId ?? null,
          tx.referenceTransactionId ?? null,
          tx.status,
          tx.failureCode ?? null,
          tx.observedBalance?.toString() ?? null,
          tx.referenceAttempts,
          tx.nextReferenceAttemptAt ?? null,
          tx.createdAt,
          tx.processedAt ?? null,
        ],
      ),
    );
    return rows.length === 1;
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string) {
    return this.findOne(`provider_id = $1 AND idempotency_key = $2`, [providerId, idempotencyKey]);
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.findOne(`provider_id = $1 AND external_transaction_id = $2`, [providerId, externalTransactionId]);
  }

  findReversalOf(referenceTransactionId: string) {
    return this.findOne(
      `reference_transaction_id = $1 AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
      [referenceTransactionId],
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    const rows = rowsOf(
      await this.em.query(
        `UPDATE wager_transactions
            SET status = $2, failure_code = $3, observed_balance = $4, reference_transaction_id = $5,
                reference_attempts = $6, next_reference_attempt_at = $7, processed_at = $8
          WHERE id = $1
          RETURNING id`,
        [
          tx.id,
          tx.status,
          tx.failureCode ?? null,
          tx.observedBalance?.toString() ?? null,
          tx.referenceTransactionId ?? null,
          tx.referenceAttempts,
          tx.nextReferenceAttemptAt ?? null,
          tx.processedAt ?? null,
        ],
      ),
    );
    if (rows.length !== 1) throw new ConcurrentModificationError(`transaction ${tx.id} not found for update`);
  }

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | null> {
    const rows = rowsOf<Row>(
      await this.em.query(`SELECT ${COLUMNS} FROM wager_transactions WHERE ${where} LIMIT 1`, params),
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async lockNextDuePendingReference(now: Date): Promise<WagerTransaction | null> {
    const rows = rowsOf<Row>(
      await this.em.query(
        `SELECT ${COLUMNS} FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= $1
          ORDER BY next_reference_attempt_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [now],
      ),
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }
}