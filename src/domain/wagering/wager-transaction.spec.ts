import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FAILURE_CODE_ACTION, FailureCode } from './failure-code';
import { canonicalJson, computePayloadHash } from './payload-hash';
import {
  CreateWagerTransactionProps,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  WagerTransaction,
} from './wager-transaction';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wager-transaction.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ids = { walletId: randomUUID(), playerId: randomUUID() };

function make(over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const ext = randomUUID();
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: 'hash',
    ...ids,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: K.Bet,
    money: brl('25.00'),
    now: new Date(),
    ...over,
  });
}

const processed = (over: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = make(over);
  tx.markProcessed(undefined, brl('75.00'), new Date());
  return tx;
};

const reversal = (kind: K, over: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind, referenceExternalTransactionId: 'ref-1', ...over });

describe('create', () => {
  test('nasce PENDING', () => {
    const tx = make();
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING e provider INTERNAL não podem ser submetidos', () => {
    expect(() => make({ kind: K.Opening })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ providerId: 'INTERNAL' })).toThrow(InvalidWagerTransactionError);
  });

  test('REFUND/ROLLBACK exigem referência', () => {
    expect(() => make({ kind: K.Refund })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ kind: K.Rollback })).toThrow(InvalidWagerTransactionError);
  });

  test('BET não carrega referência; WIN pode', () => {
    expect(() => make({ kind: K.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(make({ kind: K.Win, referenceExternalTransactionId: 'bet-1' }).kind).toBe(K.Win);
  });

  test('só LOSS aceita valor zero; negativo nunca', () => {
    expect(make({ kind: K.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    expect(() => make({ kind: K.Bet, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ money: brl('1.00').negate() })).toThrow(InvalidWagerTransactionError);
  });

  test('campos obrigatórios vazios são rejeitados', () => {
    expect(() => make({ roundId: '  ' })).toThrow(InvalidWagerTransactionError);
  });

  test('createOpening é interno, CREDIT e determinístico por wallet', () => {
    const a = WagerTransaction.createOpening({ id: randomUUID(), walletId: 'w1', playerId: 'p1', money: brl('10.00'), now: new Date() });
    const b = WagerTransaction.createOpening({ id: randomUUID(), walletId: 'w1', playerId: 'p1', money: brl('10.00'), now: new Date() });
    expect(a.kind).toBe(K.Opening);
    expect(a.providerId).toBe('INTERNAL');
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('máquina de estados', () => {
  test('PENDING -> PROCESSED guarda saldo observado', () => {
    const tx = make();
    const at = new Date();
    tx.markProcessed(undefined, brl('75.00'), at);
    expect(tx.status).toBe(S.Processed);
    expect(tx.observedBalance?.toString()).toBe('75.00');
    expect(tx.processedAt).toBe(at);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED guarda failureCode', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING -> FAILED', () => {
    const tx = make();
    tx.fail(FailureCode.InfraPermanent);
    expect(tx.status).toBe(S.Failed);
  });

  test('PENDING_REFERENCE conta tentativas e pode repetir até resolver', () => {
    const tx = reversal(K.Refund);
    const next = new Date(Date.now() + 2000);
    tx.markPendingReference(next);
    tx.markPendingReference(next);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt).toBe(next);
    tx.markProcessed('ref-id', brl('100.00'), new Date());
    expect(tx.status).toBe(S.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('só reversões podem ficar PENDING_REFERENCE', () => {
    expect(() => make().markPendingReference(new Date())).toThrow(InvalidWagerTransactionError);
  });

  test('estados terminais não transicionam', () => {
    const p = processed();
    expect(() => p.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => p.fail(FailureCode.InfraPermanent)).toThrow(InvalidTransactionStateError);
    expect(() => p.markProcessed(undefined, brl('1.00'), new Date())).toThrow(InvalidTransactionStateError);

    const r = make();
    r.reject(FailureCode.InsufficientFunds);
    expect(() => r.markProcessed(undefined, brl('1.00'), new Date())).toThrow(InvalidTransactionStateError);

    const f = reversal(K.Refund);
    f.fail(FailureCode.InfraPermanent);
    expect(() => f.markPendingReference(new Date())).toThrow(InvalidTransactionStateError);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance / requiresReference', () => {
    expect(make({ kind: K.Loss }).affectsBalance()).toBe(false);
    expect(make({ kind: K.Win }).affectsBalance()).toBe(true);
    expect(reversal(K.Refund).requiresReference()).toBe(true);
    expect(reversal(K.Rollback).requiresReference()).toBe(true);
    expect(make().requiresReference()).toBe(false);
  });

  test('ledgerDirectionFor', () => {
    expect(make({ kind: K.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(reversal(K.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => make({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rb = reversal(K.Rollback);
    expect(rb.ledgerDirectionFor(processed({ kind: K.Bet }))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(processed({ kind: K.Win }))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(reversal(K.Refund))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rb.ledgerDirectionFor(make({ kind: K.Loss }))).toThrow(InvalidWagerTransactionError);
  });

  test('matchesPayload', () => {
    const tx = make({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('validateReference', () => {
  test('referência válida', () => {
    const bet = processed({ kind: K.Bet });
    expect(reversal(K.Refund).validateReference(bet)).toBeUndefined();
    expect(reversal(K.Rollback).validateReference(processed({ kind: K.Win }))).toBeUndefined();
  });

  test('REFUND só referencia BET', () => {
    expect(reversal(K.Refund).validateReference(processed({ kind: K.Win }))).toBe(FailureCode.InvalidReferenceKind);
  });

  test('ROLLBACK não referencia LOSS nem ROLLBACK', () => {
    expect(reversal(K.Rollback).validateReference(processed({ kind: K.Loss }))).toBe(FailureCode.InvalidReferenceKind);
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: randomUUID() }],
    ['wallet', { walletId: randomUUID() }],
    ['rodada', { roundId: 'round-2' }],
    ['moeda', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
  ] as const)('divergência de %s -> REFERENCE_MISMATCH', (_, over) => {
    expect(reversal(K.Refund).validateReference(processed(over))).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência não processada -> REFERENCE_NOT_PROCESSED', () => {
    const rejected = make({ kind: K.Bet });
    rejected.reject(FailureCode.InsufficientFunds);
    expect(reversal(K.Refund).validateReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('valor diferente -> AMOUNT_MISMATCH', () => {
    expect(reversal(K.Refund, { money: brl('10.00') }).validateReference(processed())).toBe(FailureCode.AmountMismatch);
  });

  test('transação sem referência não valida', () => {
    expect(() => make().validateReference(processed())).toThrow(InvalidWagerTransactionError);
  });
});

describe('payload hash', () => {
  const input = {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'p1',
    walletId: 'w1',
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    money: brl('25.00'),
  };

  test('é determinístico e independe da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(computePayloadHash(input)).toBe(computePayloadHash({ ...input }));
  });

  test('normaliza o valor (25 == 25.00)', () => {
    expect(computePayloadHash({ ...input, money: Money.from({ amount: '25', currency: 'BRL' }) })).toBe(
      computePayloadHash(input),
    );
  });

  test('qualquer campo de negócio diferente muda o hash', () => {
    const base = computePayloadHash(input);
    expect(computePayloadHash({ ...input, money: brl('25.01') })).not.toBe(base);
    expect(computePayloadHash({ ...input, kind: 'WIN' })).not.toBe(base);
    expect(computePayloadHash({ ...input, roundId: 'r2' })).not.toBe(base);
    expect(computePayloadHash({ ...input, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });
});

describe('failure codes', () => {
  test('todo código tem ação definida para o provedor', () => {
    for (const code of Object.values(FailureCode)) {
      expect(FAILURE_CODE_ACTION[code]).toBeDefined();
    }
  });
});