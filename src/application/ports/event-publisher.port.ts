import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}