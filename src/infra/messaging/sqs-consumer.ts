import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { log } from '../observability/logger';
import { classify, Disposition, errorCode } from './error-classifier';

export type MessageHandler = (body: string) => Promise<void>;

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  concurrency: number;
  retryBaseSeconds?: number;
  retryMaxSeconds?: number;
}

export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  return Math.min(maxSeconds, baseSeconds * 2 ** (Math.max(1, receiveCount) - 1));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SqsConsumer {
  private running = false;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: MessageHandler,
    private readonly options: SqsConsumerOptions,
  ) {}

  start(): void {
    this.running = true;
    this.loops = Array.from({ length: this.options.concurrency }, () => this.loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await Promise.all(this.loops);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (!this.running) return;
        log('error', 'sqs receive failed', { error: error instanceof Error ? error.message : String(error) });
        await sleep(1000);
        continue;
      }

      for (let i = 0; i < messages.length; i++) {
        if (!this.running) {
          await this.release(messages.slice(i));
          break;
        }
        await this.handle(messages[i]);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let outcome: 'OK' | Disposition;
    let reason = 'OK';
    try {
      await this.handler(message.Body ?? '');
      outcome = 'OK';
    } catch (error) {
      outcome = classify(error);
      reason = errorCode(error);
      log(outcome === 'RETRY' ? 'error' : 'warn', 'message not processed', {
        sqsMessageId: message.MessageId,
        receiveCount,
        disposition: outcome,
        code: reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.settle(message, outcome, receiveCount, reason);
    } catch (error) {
      log('error', 'failed to settle message', {
        sqsMessageId: message.MessageId,
        disposition: outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async settle(message: Message, outcome: 'OK' | Disposition, receiveCount: number, reason: string) {
    switch (outcome) {
      case 'OK':
      case 'ACK':
        return this.remove(message);
      case 'DEAD_LETTER':
        await this.sendToDlq(message, reason);
        return this.remove(message);
      case 'RETRY':
        return this.setVisibility(
          message,
          retryDelaySeconds(receiveCount, this.options.retryBaseSeconds ?? 2, this.options.retryMaxSeconds ?? 60),
        );
    }
  }

  private async remove(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { failureCode: { DataType: 'String', StringValue: reason } },
      }),
    );
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.allSettled(messages.map((m) => this.setVisibility(m, 0)));
  }
}