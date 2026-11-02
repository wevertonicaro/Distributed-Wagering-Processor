import { Money } from '../money';
import { InvalidLedgerEntryError } from './wallet.errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(p: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!p.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (p.balanceBefore.isNegative() || p.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger balances cannot be negative');
    }
    const entry = new WalletLedgerEntry(
      p.id, p.walletId, p.transactionId, p.direction,
      p.money, p.balanceBefore, p.balanceAfter, p.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${p.balanceBefore} ${p.direction} ${p.money} != ${p.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id, s.walletId, s.transactionId, s.direction,
      s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}