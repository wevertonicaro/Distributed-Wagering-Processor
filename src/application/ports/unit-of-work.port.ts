import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories.port';

export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}