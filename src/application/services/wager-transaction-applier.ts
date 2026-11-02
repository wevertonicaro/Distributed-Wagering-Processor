import { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wagering-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { InsufficientFundsError } from '../../domain/wallet/wallet.errors';
import { IdGenerator } from '../ports/clock.port';
import { TransactionContext } from '../ports/unit-of-work.port';

export interface PendingReferencePolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export function pendingReferenceBackoffMs(attempt: number, p: PendingReferencePolicy): number {
  return Math.min(p.backoffMaxMs, p.backoffBaseMs * 2 ** (attempt - 1));
}

type Outcome =
  | { type: 'REJECTED' }
  | { type: 'PENDING' }
  | { type: 'PROCESSED'; entry?: WalletLedgerEntry };


export class WagerTransactionApplier {
  constructor(
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy,
  ) {}

  async apply(
    ctx: TransactionContext,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
    correlationId: string,
  ): Promise<void> {
    const eventCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    const outcome = await this.decide(ctx, wallet, tx, now);

    const events: IntegrationEvent<object>[] = [];
    switch (outcome.type) {
      case 'REJECTED':
        events.push(WagerTransactionRejected.from(tx, eventCtx()));
        break;
      case 'PENDING':
        if (tx.referenceAttempts === 1) events.push(WagerTransactionPendingReference.from(tx, eventCtx()));
        break;
      case 'PROCESSED':
        events.push(WagerTransactionProcessed.from(tx, eventCtx()));
        if (outcome.entry) events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventCtx()));
        break;
    }

    await ctx.transactions.update(tx);
    for (const event of events) await ctx.outbox.add(OutboxMessage.enqueue(event));
  }

  private async decide(ctx: TransactionContext, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<Outcome> {
    if (tx.playerId !== wallet.playerId) return this.reject(tx, FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return this.reject(tx, FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.requiresReference()) {
      const found = await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      if (found && found.id === tx.id) return this.reject(tx, FailureCode.InvalidReferenceKind);

      if (!found || !found.isTerminal()) {
        if (tx.referenceAttempts >= this.policy.maxAttempts) {
          return this.reject(tx, found ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
        }
        const delay = pendingReferenceBackoffMs(tx.referenceAttempts + 1, this.policy);
        tx.markPendingReference(new Date(now.getTime() + delay));
        return { type: 'PENDING' };
      }

      const violation = tx.validateReference(found);
      if (violation) return this.reject(tx, violation);
      if (await ctx.transactions.findReversalOf(found.id)) return this.reject(tx, FailureCode.AlreadyReversed);
      reference = found;
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(undefined, wallet.balance, now);
      return { type: 'PROCESSED' };
    }

    const movement = { entryId: this.ids.next(), transactionId: tx.id, amount: tx.money, at: now };
    const previousVersion = wallet.version;
    let entry: WalletLedgerEntry;
    try {
      entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
        return this.reject(tx, code);
      }
      throw error;
    }

    await ctx.wallets.updateBalance(wallet, previousVersion);
    await ctx.ledger.insert(entry);
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { type: 'PROCESSED', entry };
  }

  private reject(tx: WagerTransaction, code: FailureCode): Outcome {
    tx.reject(code);
    return { type: 'REJECTED' };
  }
}