import { Money } from '../money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { computePayloadHash } from './payload-hash';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wager-transaction.errors';

export const INTERNAL_PROVIDER_ID = 'INTERNAL';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const S = WagerTransactionStatus;
const K = WagerTransactionKind;

const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [S.Pending]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.PendingReference]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  now: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _observedBalance?: Money;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt?: Date;
  private _processedAt?: Date;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._observedBalance = s.observedBalance;
    this._referenceAttempts = s.referenceAttempts;
    this._nextReferenceAttemptAt = s.nextReferenceAttemptAt;
    this._processedAt = s.processedAt;
  }

  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === K.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    if (p.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`provider id "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    return WagerTransaction.build(p);
  }

  static createOpening(p: { id: string; walletId: string; playerId: string; money: Money; now: Date }): WagerTransaction {
    const key = `opening:${p.walletId}`;
    return WagerTransaction.build({
      id: p.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: computePayloadHash({
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: key,
        playerId: p.playerId,
        walletId: p.walletId,
        roundId: 'opening',
        gameId: 'opening',
        kind: K.Opening,
        money: p.money,
      }),
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: K.Opening,
      money: p.money,
      now: p.now,
    });
  }

  private static build(p: CreateWagerTransactionProps): WagerTransaction {
    const required = {
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    if (p.money.isNegative()) {
      throw new InvalidWagerTransactionError('amount cannot be negative');
    }
    if (p.kind !== K.Loss && !p.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${p.kind} amount must be positive`);
    }
    const ref = p.referenceExternalTransactionId;
    if (ALLOWED_REFERENCE_KINDS[p.kind] && (!ref || ref.trim() === '')) {
      throw new InvalidWagerTransactionError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (ref && (p.kind === K.Bet || p.kind === K.Opening)) {
      throw new InvalidWagerTransactionError(`${p.kind} cannot carry a reference`);
    }

    return new WagerTransaction({
      id: p.id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      money: p.money,
      referenceExternalTransactionId: ref,
      createdAt: p.now,
      status: S.Pending,
      referenceAttempts: 0,
    });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get observedBalance(): Money | undefined { return this._observedBalance; }
  get referenceAttempts(): number { return this._referenceAttempts; }
  get nextReferenceAttemptAt(): Date | undefined { return this._nextReferenceAttemptAt; }
  get processedAt(): Date | undefined { return this._processedAt; }

  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    if (!this.requiresReference()) {
      throw new InvalidWagerTransactionError(`${this.kind} does not wait for a reference`);
    }
    this.transitionTo(S.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode): void {
    this.transitionTo(S.Rejected);
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.transitionTo(S.Failed);
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  private transitionTo(target: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(target)) {
      throw new InvalidTransactionStateError(this.id, this._status, target);
    }
    this._status = target;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== K.Loss;
  }

  requiresReference(): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind] !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case K.Bet:
        return LedgerDirection.Debit;
      case K.Win:
      case K.Refund:
      case K.Opening:
        return LedgerDirection.Credit;
      case K.Loss:
        throw new InvalidWagerTransactionError('LOSS does not affect the balance');
      case K.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError('ROLLBACK needs its reference');
        return WagerTransaction.directionOf(reference.kind) === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private static directionOf(kind: WagerTransactionKind): LedgerDirection {
    if (kind === K.Bet) return LedgerDirection.Debit;
    if (kind === K.Win || kind === K.Refund) return LedgerDirection.Credit;
    throw new InvalidWagerTransactionError(`${kind} has no reversible direction`);
  }

 
  validateReference(reference: WagerTransaction): FailureCode | undefined {
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind];
    if (!allowed) {
      throw new InvalidWagerTransactionError(`${this.kind} does not use a reference`);
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!allowed.includes(reference.kind)) return FailureCode.InvalidReferenceKind;
    if (reference.status !== S.Processed) return FailureCode.ReferenceNotProcessed;
    if (!reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }
}