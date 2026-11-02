import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError, Money } from '../money';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidLedgerEntryError, InvalidWalletOperationError } from './wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const move = (amount: Money) => ({
  entryId: randomUUID(),
  transactionId: randomUUID(),
  amount,
  at: new Date(),
});

function open(balance = '100.00') {
  return Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: brl(balance),
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
    now: new Date(),
  });
}

describe('Wallet.open', () => {
  test('saldo inicial > 0 gera lançamento CREDIT de abertura e version 1', () => {
    const { wallet, openingEntry } = open('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz saldo, gera lançamento e incrementa version', () => {
    const { wallet } = open('100.00');
    const entry = wallet.debit(move(brl('25.00')));
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta saldo', () => {
    const { wallet } = open('100.00');
    const entry = wallet.credit(move(brl('10.50')));
    expect(wallet.balance.toString()).toBe('110.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('pode debitar exatamente o saldo inteiro', () => {
    const { wallet } = open('100.00');
    wallet.debit(move(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente lança erro e não altera estado', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit(move(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('moeda diferente lança erro de domínio e não altera estado', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero é rejeitado', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.credit(move(brl('0.00')))).toThrow(InvalidWalletOperationError);
  });

  test('cenário da seção 8 no domínio: 100 - 80 ok, segundo 80 rejeitado, saldo 20', () => {
    const { wallet } = open('100.00');
    wallet.debit(move(brl('80.00')));
    expect(() => wallet.debit(move(brl('80.00')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('invariante: saldo == reconstruído pelos lançamentos', () => {
    const { wallet, openingEntry } = open('100.00');
    const entries = [openingEntry!];
    entries.push(wallet.debit(move(brl('30.00'))));
    entries.push(wallet.credit(move(brl('5.25'))));
    entries.push(wallet.debit(move(brl('10.00'))));
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = () => ({
    id: randomUUID(),
    walletId: randomUUID(),
    transactionId: randomUUID(),
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('90.00'),
    createdAt: new Date(),
  });

  test('create valida a aritmética', () => {
    expect(() => WalletLedgerEntry.create({ ...base(), balanceAfter: brl('50.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base(), direction: LedgerDirection.Credit }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor não positivo', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base(), money: brl('0.00'), balanceAfter: brl('100.00') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é imutável (objeto congelado)', () => {
    const entry = WalletLedgerEntry.create(base());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });

  test('rehydrate não revalida (isBalanced expõe inconsistência)', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...base(), balanceAfter: brl('1.00') });
    expect(entry.isBalanced()).toBe(false);
  });
});