import { describe, expect, test } from 'bun:test';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidRequestError,
  WalletNotFoundError,
} from '../../application/errors';
import { InvalidMoneyError } from '../../domain/money';
import { InvalidWagerTransactionError } from '../../domain/wagering/wager-transaction.errors';
import { classify } from './error-classifier';
import { retryDelaySeconds } from './sqs-consumer';
import { MalformedMessageError, toCommand } from './wager-message';

const valid = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

describe('toCommand', () => {
  test('mapeia a mensagem do enunciado no comando do caso de uso, com inbox e correlationId', () => {
    const cmd = toCommand(JSON.stringify(valid()), 'consumer-a');
    expect(cmd).toMatchObject({
      providerId: 'provider-a',
      idempotencyKey: 'provider-a:transaction-123',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: 'msg-123',
      inbox: { consumerName: 'consumer-a', messageId: 'msg-123' },
    });
  });

  test('JSON inválido, messageId ausente e tipo desconhecido são malformados', () => {
    expect(() => toCommand('{bad', 'c')).toThrow(MalformedMessageError);
    expect(() => toCommand(JSON.stringify({ ...valid(), messageId: undefined }), 'c')).toThrow(MalformedMessageError);
    expect(() => toCommand(JSON.stringify({ ...valid(), type: 'Other' }), 'c')).toThrow(MalformedMessageError);
  });

  test('campo com tipo errado vira erro de requisição inválida', () => {
    const msg = valid();
    (msg.data as Record<string, unknown>).walletId = 42;
    expect(() => toCommand(JSON.stringify(msg), 'c')).toThrow(InvalidRequestError);
  });
});

describe('classify', () => {
  test('permanentes vão para a DLQ', () => {
    for (const e of [
      new MalformedMessageError('x'),
      new InvalidRequestError('x'),
      new InvalidWagerTransactionError('x'),
      new InboxPayloadMismatchError('x'),
    ]) {
      expect(classify(e)).toBe('DEAD_LETTER');
    }
    expect(classify(Object.assign(new InvalidMoneyError('x')))).toBe('DEAD_LETTER');
  });

  test('negócio terminal é ack', () => {
    expect(classify(new WalletNotFoundError('x'))).toBe('ACK');
    expect(classify(new IdempotencyConflictError('x'))).toBe('ACK');
  });

  test('transitório e desconhecido fazem retry', () => {
    expect(classify(new ConcurrentModificationError('x'))).toBe('RETRY');
    expect(classify(new Error('connection terminated'))).toBe('RETRY');
  });
});

describe('retryDelaySeconds', () => {
  test('exponencial com teto', () => {
    expect(retryDelaySeconds(1, 2, 60)).toBe(2);
    expect(retryDelaySeconds(2, 2, 60)).toBe(4);
    expect(retryDelaySeconds(3, 2, 60)).toBe(8);
    expect(retryDelaySeconds(10, 2, 60)).toBe(60);
  });
});