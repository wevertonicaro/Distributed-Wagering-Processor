import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { WalletNotFoundError } from '../errors';
import { Clock } from '../ports/clock.port';
import { UnitOfWork } from '../ports/unit-of-work.port';
import { WagerTransactionApplier } from '../services/wager-transaction-applier';

export interface ResolvedReference {
  transactionId: string;
  status: WagerTransactionStatus;
}

export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
  ) {}

  async execute(limit: number): Promise<ResolvedReference[]> {
    const done: ResolvedReference[] = [];
    for (let i = 0; i < limit; i++) {
      const item = await this.resolveNext();
      if (!item) break;
      done.push(item);
    }
    return done;
  }

  private resolveNext(): Promise<ResolvedReference | null> {
    return this.uow.run(async (ctx) => {
      const now = this.clock.now();
      const tx = await ctx.transactions.lockNextDuePendingReference(now);
      if (!tx) return null;

      const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
      if (!wallet) throw new WalletNotFoundError(tx.walletId);

      await this.applier.apply(ctx, wallet, tx, now, tx.id);
      return { transactionId: tx.id, status: tx.status };
    });
  }
}