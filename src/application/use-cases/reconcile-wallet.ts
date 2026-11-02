import { Money, MoneyProps } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import { assertUuid } from '../validation';

export interface LedgerSummary {
  stored: Money;
  calculated: Money;
  entries: number;
}

export interface LedgerSummaryReader {
  summarize(walletId: string): Promise<LedgerSummary | null>;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(private readonly reader: LedgerSummaryReader) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    assertUuid('walletId', walletId);
    const s = await this.reader.summarize(walletId);
    if (!s) throw new WalletNotFoundError(walletId);
    const difference = s.stored.subtract(s.calculated);
    return {
      walletId,
      storedBalance: s.stored.toJSON(),
      calculatedBalance: s.calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: s.entries,
    };
  }
}