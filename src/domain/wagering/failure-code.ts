export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InfraPermanent = 'INFRA_PERMANENT',
}

export type ProviderAction = 'FIX_PAYLOAD' | 'GIVE_UP' | 'CONTACT_SUPPORT';

export const FAILURE_CODE_ACTION: Record<FailureCode, ProviderAction> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'CONTACT_SUPPORT',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.AmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.WalletPlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InfraPermanent]: 'CONTACT_SUPPORT',
};