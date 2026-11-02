import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../events/integration-event';
import { OutboxMessage } from './outbox-message';

class TestEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static make() {
    return new TestEvent({
      eventId: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      correlationId: 'c1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      data: { n: 1 },
    });
  }
}

describe('OutboxMessage', () => {
  test('enqueue grava o envelope e nasce pendente e vencida', () => {
    const event = TestEvent.make();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.payload.eventType).toBe('TestEvent');
    expect(msg.payload.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(new Date())).toBe(true);
    expect(msg.attempts).toBe(0);
  });

  test('scheduleRetry usa backoff exponencial com teto', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    const now = new Date('2026-01-01T00:00:00.000Z');
    const policy = { baseMs: 1000, maxMs: 3000 };
    msg.scheduleRetry(now, policy);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(1000);
    msg.scheduleRetry(now, policy);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
    msg.scheduleRetry(now, policy);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(3000);
    expect(msg.isDue(now)).toBe(false);
  });

  test('markPublished tira da fila de pendentes', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    msg.markPublished(new Date());
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date())).toBe(false);
  });
});