import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money', () => {
  test('normaliza escala para 2 casas', () => {
    expect(m('25').toString()).toBe('25.00');
    expect(m('25.5').toString()).toBe('25.50');
  });

  test('aritmética exata (0.10 + 0.20 === 0.30)', () => {
    expect(m('0.10').add(m('0.20')).equals(m('0.30'))).toBe(true);
  });

  test('subtract pode ficar negativo (quem barra é a Wallet)', () => {
    expect(m('10.00').subtract(m('15.00')).toString()).toBe('-5.00');
  });

  test.each(['', 'NaN', 'Infinity', '1e3', '1.234', '-1.00', ' 1.00', '1,00', '.50'])(
    'rejeita entrada inválida %p',
    (bad) => expect(() => m(bad)).toThrow(InvalidMoneyError),
  );

  test('rejeita moeda inválida', () => {
    expect(() => m('1.00', 'brl')).toThrow(InvalidMoneyError);
  });

  test('moedas diferentes lançam erro de domínio', () => {
    expect(() => m('1.00', 'BRL').add(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => m('1.00', 'BRL').isLessThan(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  test('imutabilidade', () => {
    const a = m('5.00');
    a.add(m('1.00'));
    expect(a.toString()).toBe('5.00');
  });

  test('fromStored aceita negativo; toJSON é string', () => {
    expect(Money.fromStored('-5.00', 'BRL').isNegative()).toBe(true);
    expect(m('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});