import { DomainError } from './domain-error';

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
      throw new InvalidMoneyError(`invalid amount: ${String(amount)}`);
    }
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: ${String(currency)}`);
    }
    const [int, frac = ''] = amount.split('.');
    return new Money(BigInt(int + frac.padEnd(2, '0')), currency);
  }

  static fromStored(amount: string, currency: string): Money {
    const neg = amount.startsWith('-');
    const abs = Money.from({ amount: neg ? amount.slice(1) : amount, currency });
    return neg ? abs.negate() : abs;
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents + o.cents, this.currency);
  }
  subtract(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents - o.cents, this.currency);
  }
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero() { return this.cents === 0n; }
  isPositive() { return this.cents > 0n; }
  isNegative() { return this.cents < 0n; }
  isLessThan(o: Money) {
    this.assertSameCurrency(o);
    return this.cents < o.cents;
  }
  equals(o: Money) {
    return this.currency === o.currency && this.cents === o.cents;
  }

  toString(): string {
    const neg = this.cents < 0n;
    const abs = (neg ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${neg ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(o: Money) {
    if (this.currency !== o.currency) {
      throw new CurrencyMismatchError(`${this.currency} vs ${o.currency}`);
    }
  }
}

