import { ProcessWagerTransactionCommand } from '../../application/use-cases/process-wager-transaction';
import { asObject, optionalString } from '../../application/validation';
import { DomainError } from '../../domain/domain-error';
import { MoneyProps } from '../../domain/money';

export class MalformedMessageError extends DomainError {
  readonly code = 'MALFORMED_MESSAGE';
}

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export function toCommand(body: string, consumerName: string): ProcessWagerTransactionCommand {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('message body is not valid JSON');
  }

  const message = asObject(json);
  const messageId = optionalString(message.messageId, 'messageId');
  if (!messageId?.trim()) throw new MalformedMessageError('messageId is required');
  if (message.type !== WAGER_MESSAGE_TYPE) {
    throw new MalformedMessageError(`unsupported message type: ${String(message.type)}`);
  }

  const d = asObject(message.data);
  return {
    providerId: optionalString(d.providerId, 'providerId') as string,
    externalTransactionId: optionalString(d.externalTransactionId, 'externalTransactionId') as string,
    idempotencyKey: optionalString(d.idempotencyKey, 'idempotencyKey') as string,
    playerId: optionalString(d.playerId, 'playerId') as string,
    walletId: optionalString(d.walletId, 'walletId') as string,
    roundId: optionalString(d.roundId, 'roundId') as string,
    gameId: optionalString(d.gameId, 'gameId') as string,
    kind: optionalString(d.kind, 'kind') as string,
    money: d.money as MoneyProps,
    referenceExternalTransactionId: optionalString(d.referenceExternalTransactionId, 'referenceExternalTransactionId'),
    correlationId: messageId,
    inbox: { consumerName, messageId },
  };
}