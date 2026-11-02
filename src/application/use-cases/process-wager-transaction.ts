import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, MoneyProps } from '../../domain/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import { computePayloadHash } from '../../domain/wagering/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { InvalidWagerTransactionError } from '../../domain/wagering/wager-transaction.errors';
import { IdempotencyConflictError, InboxPayloadMismatchError, WalletNotFoundError } from '../errors';
import { Clock, IdGenerator } from '../ports/clock.port';
import { noopMetrics, ProcessingMetrics } from '../ports/metrics.port';
import { TransactionContext, UnitOfWork } from '../ports/unit-of-work.port';
import { WagerTransactionApplier } from '../services/wager-transaction-applier';
import { assertUuid } from '../validation';

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

const secondsSince = (started: number) => (performance.now() - started) / 1000;

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: ProcessingMetrics = noopMetrics,
  ) {}

  async execute(cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const started = performance.now();

    assertUuid('walletId', cmd.walletId);
    assertUuid('playerId', cmd.playerId);
    if (!Object.values(WagerTransactionKind).includes(cmd.kind as WagerTransactionKind)) {
      throw new InvalidWagerTransactionError(`unknown kind: ${String(cmd.kind)}`);
    }
    const money = Money.from(cmd.money);
    const payloadHash = computePayloadHash({ ...cmd, money });
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      now: this.clock.now(),
    });
    const correlationId = cmd.correlationId ?? tx.id;

    const result = await this.uow.run(async (ctx) => {
      if (cmd.inbox) await this.receiveInbox(ctx, cmd.inbox, payloadHash);

      const existing = await ctx.transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey);
      if (existing) return this.replay(existing, payloadHash);

      const lockStarted = performance.now();
      const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
      this.metrics.lockWait(secondsSince(lockStarted));
      if (!wallet) throw new WalletNotFoundError(tx.walletId);

      if (!(await ctx.transactions.insertIfAbsent(tx))) {
        const winner = await ctx.transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey);
        if (winner) return this.replay(winner, payloadHash);
        throw new IdempotencyConflictError('externalTransactionId already used with a different idempotency key');
      }

      await this.applier.apply(ctx, wallet, tx, this.clock.now(), correlationId);
      return this.toResult(tx, false);
    });

    this.metrics.transaction(result.status, result.idempotentReplay, secondsSince(started));
    return result;
  }

  private async receiveInbox(
    ctx: TransactionContext,
    inbox: { consumerName: string; messageId: string },
    payloadHash: string,
  ): Promise<void> {
    const now = this.clock.now();
    const message = InboxMessage.receive({ ...inbox, payloadHash, now });
    message.markProcessed(now); 
    if (await ctx.inbox.insertIfAbsent(message)) return;

    const previous = await ctx.inbox.find(inbox.consumerName, inbox.messageId);
    if (previous && !previous.matchesPayload(payloadHash)) {
      throw new InboxPayloadMismatchError(`message ${inbox.messageId} was already received with a different payload`);
    }
  }

  private replay(found: WagerTransaction, payloadHash: string): ProcessWagerTransactionResult {
    if (!found.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError('idempotency key reused with a different payload');
    }
    return this.toResult(found, true);
  }

  private toResult(tx: WagerTransaction, replay: boolean): ProcessWagerTransactionResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.observedBalance?.toJSON(),
      idempotentReplay: replay,
    };
  }
}