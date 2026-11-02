import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createSqsClient } from '../infra/messaging/sqs.client';

export interface TestQueues {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  cleanup(): Promise<void>;
}

export async function createTestQueues(maxReceiveCount = 5): Promise<TestQueues> {
  const sqs = createSqsClient();
  const suffix = randomUUID().slice(0, 8);

  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: `test-dlq-${suffix}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const arn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn;
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `test-wager-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );

  return {
    sqs,
    queueUrl: main.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    cleanup: async () => {
      await Promise.allSettled([
        sqs.send(new DeleteQueueCommand({ QueueUrl: main.QueueUrl })),
        sqs.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl })),
      ]);
    },
  };
}

export const wagerMessage = (data: Record<string, unknown>, messageId: string = randomUUID()) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data,
});

export async function publish(
  q: TestQueues,
  body: unknown,
  opts: { groupId: string; dedupId?: string },
): Promise<void> {
  await q.sqs.send(
    new SendMessageCommand({
      QueueUrl: q.queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: opts.groupId,
      MessageDeduplicationId: opts.dedupId ?? randomUUID(),
    }),
  );
}

export async function queueDepth(q: TestQueues): Promise<number> {
  const out = await q.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: q.queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  return Object.values(out.Attributes ?? {}).reduce((sum, v) => sum + Number(v), 0);
}

export async function readDlq(q: TestQueues, expected: number, timeoutMs = 15_000) {
  const found: { body: string; failureCode?: string }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await q.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: q.dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['failureCode'],
      }),
    );
    for (const m of out.Messages ?? []) {
      found.push({ body: m.Body ?? '', failureCode: m.MessageAttributes?.failureCode?.StringValue });
      await q.sqs.send(new DeleteMessageCommand({ QueueUrl: q.dlqUrl, ReceiptHandle: m.ReceiptHandle }));
    }
    if (expected > 0 && found.length >= expected) break;
  }
  return found;
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));