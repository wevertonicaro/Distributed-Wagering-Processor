import { createHash } from 'node:crypto';
import { Money } from '../money';

export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computePayloadHash(i: PayloadHashInput): string {
  const canonical = canonicalJson({
    providerId: i.providerId,
    externalTransactionId: i.externalTransactionId,
    playerId: i.playerId,
    walletId: i.walletId,
    roundId: i.roundId,
    gameId: i.gameId,
    kind: i.kind,
    money: i.money.toJSON(),
    referenceExternalTransactionId: i.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}