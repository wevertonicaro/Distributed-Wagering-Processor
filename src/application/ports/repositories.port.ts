import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<boolean>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null>;
  lockNextDuePendingReference(now: Date): Promise<WagerTransaction | null>;
  update(tx: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage, lastError?: string): Promise<void>;
}

export interface InboxRepository {
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}