import { DomainError } from '../../domain/domain-error';

export type Disposition = 'ACK' | 'RETRY' | 'DEAD_LETTER';

const ACK_CODES = new Set(['WALLET_NOT_FOUND', 'IDEMPOTENCY_CONFLICT']);

const DEAD_LETTER_CODES = new Set([
  'MALFORMED_MESSAGE',
  'INVALID_REQUEST',
  'INVALID_MONEY',
  'INVALID_WAGER_TRANSACTION',
  'CURRENCY_MISMATCH',
  'INBOX_PAYLOAD_MISMATCH',
]);

export function classify(error: unknown): Disposition {
  if (error instanceof DomainError) {
    if (ACK_CODES.has(error.code)) return 'ACK';
    if (DEAD_LETTER_CODES.has(error.code)) return 'DEAD_LETTER';
  }
  return 'RETRY';
}

export const errorCode = (error: unknown): string => (error instanceof DomainError ? error.code : 'UNEXPECTED_ERROR');