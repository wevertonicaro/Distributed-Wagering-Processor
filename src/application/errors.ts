import { DomainError } from '../domain/domain-error';

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}
export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}
export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}
export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
}
export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST';
}
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}
export class InboxPayloadMismatchError extends DomainError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';
}