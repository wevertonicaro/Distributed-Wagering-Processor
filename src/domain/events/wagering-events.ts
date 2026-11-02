import { MoneyProps } from '../money';
import { FailureCode } from '../wagering/failure-code';
import { WagerTransaction } from '../wagering/wager-transaction';
import { EventContext, IntegrationEvent, propsFrom } from './integration-event';

interface TransactionData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
}

const base = (tx: WagerTransaction): TransactionData => ({
  transactionId: tx.id,
  walletId: tx.walletId,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  roundId: tx.roundId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

export interface WagerTransactionProcessedData extends TransactionData {
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.observedBalance) throw new Error('processed transaction must carry observedBalance');
    return new WagerTransactionProcessed(
      propsFrom(tx.walletId, ctx, { ...base(tx), balance: tx.observedBalance.toJSON() }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error('rejected transaction must carry failureCode');
    return new WagerTransactionRejected(propsFrom(tx.walletId, ctx, { ...base(tx), failureCode: tx.failureCode }));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      propsFrom(tx.walletId, ctx, {
        ...base(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
      }),
    );
  }
}