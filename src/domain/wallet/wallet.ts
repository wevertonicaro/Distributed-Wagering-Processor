import { Money } from '../money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidWalletOperationError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    now: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const initial = props.initialBalance;
    if (initial.isNegative()) {
      throw new InvalidWalletOperationError('initial balance cannot be negative');
    }
    const wallet = new Wallet(props.id, props.playerId, initial.currency, initial, 1, props.now, props.now);
    if (initial.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initial,
      balanceBefore: Money.zero(initial.currency),
      balanceAfter: initial,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  canDebit(amount: Money): boolean {
    this.assertMovable(amount);
    return !this._balance.isLessThan(amount);
  }

  debit(m: WalletMovement): WalletLedgerEntry {
    this.assertMovable(m.amount);
    if (this._balance.isLessThan(m.amount)) {
      throw new InsufficientFundsError(`balance ${this._balance} is lower than ${m.amount}`);
    }
    return this.apply(LedgerDirection.Debit, m, this._balance.subtract(m.amount));
  }

  credit(m: WalletMovement): WalletLedgerEntry {
    this.assertMovable(m.amount);
    return this.apply(LedgerDirection.Credit, m, this._balance.add(m.amount));
  }

  private apply(direction: LedgerDirection, m: WalletMovement, after: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.id,
      transactionId: m.transactionId,
      direction,
      money: m.amount,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: m.at,
    });
    this._balance = after;
    this._version += 1; 
    this._updatedAt = m.at;
    return entry;
  }

  private assertMovable(amount: Money): void {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      this._balance.add(money);
    }
  }
}