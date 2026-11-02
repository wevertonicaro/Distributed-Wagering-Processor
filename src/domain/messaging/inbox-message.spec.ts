import { describe, expect, test } from 'bun:test';
import { InboxMessage, InvalidInboxMessageError } from './inbox-message';

const base = { messageId: 'msg-1', consumerName: 'c1', payloadHash: 'h', now: new Date() };

describe('InboxMessage', () => {
  test('nasce não processada', () => {
    const m = InboxMessage.receive(base);
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
  });

  test('markProcessed marca uma única vez', () => {
    const m = InboxMessage.receive(base);
    const at = new Date();
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toBe(at);
    expect(() => m.markProcessed(new Date())).toThrow(InvalidInboxMessageError);
  });

  test('campos obrigatórios', () => {
    expect(() => InboxMessage.receive({ ...base, messageId: ' ' })).toThrow(InvalidInboxMessageError);
    expect(() => InboxMessage.receive({ ...base, consumerName: '' })).toThrow(InvalidInboxMessageError);
  });

  test('matchesPayload', () => {
    const m = InboxMessage.receive(base);
    expect(m.matchesPayload('h')).toBe(true);
    expect(m.matchesPayload('x')).toBe(false);
  });
});