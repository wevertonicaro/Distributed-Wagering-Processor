import { DomainError } from '../domain-error';

export class InvalidInboxMessageError extends DomainError {
  readonly code = 'INVALID_INBOX_MESSAGE';
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  now: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(p: ReceiveInboxProps): InboxMessage {
    for (const [field, value] of Object.entries({
      messageId: p.messageId,
      consumerName: p.consumerName,
      payloadHash: p.payloadHash,
    })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidInboxMessageError(`${field} is required`);
      }
    }
    return new InboxMessage(p.messageId, p.consumerName, p.payloadHash, p.now);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidInboxMessageError('message already processed');
    this._processedAt = at;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}