import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports/event-publisher.port';
import { OutboxMessage } from '../../domain/messaging/outbox-message';

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(m: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(m.payload),
        MessageGroupId: m.aggregateId, 
        MessageDeduplicationId: m.id, 
        MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
      }),
    );
  }
}