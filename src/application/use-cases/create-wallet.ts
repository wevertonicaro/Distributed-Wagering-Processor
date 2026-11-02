import { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionProcessed } from '../../domain/events/wagering-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, MoneyProps } from '../../domain/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletAlreadyExistsError } from '../errors';
import { Clock, IdGenerator } from '../ports/clock.port';
import { UnitOfWork } from '../ports/unit-of-work.port';
import { assertUuid } from '../validation';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    assertUuid('playerId', cmd.playerId);
    const initial = Money.from(cmd.initialBalance);
    const now = this.clock.now();

    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: cmd.playerId,
      initialBalance: initial,
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      now,
    });

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError(`wallet already exists for player ${cmd.playerId} in ${initial.currency}`);
      }

      if (openingEntry) {
        const opening = WagerTransaction.createOpening({
          id: openingEntry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initial,
          now,
        });
        opening.markProcessed(undefined, wallet.balance, now);
        await ctx.transactions.insertIfAbsent(opening);
        await ctx.ledger.insert(openingEntry);

        const eventCtx = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId: opening.id,
          causationId: opening.id,
          occurredAt: now,
        });
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventCtx())));
        await ctx.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventCtx())));
      }

      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    });
  }
}