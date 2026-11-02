import { DomainError } from '../domain-error';

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(id: string, from: string, to: string) {
    super(`transaction ${id}: invalid transition ${from} -> ${to}`);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}