import { DataSource } from 'typeorm';
import { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import { PgInboxRepository } from './repositories/pg-inbox.repository';
import { PgLedgerRepository } from './repositories/pg-ledger.repository';
import { PgOutboxRepository } from './repositories/pg-outbox.repository';
import { PgWagerTransactionRepository } from './repositories/pg-wager-transaction.repository';
import { PgWalletRepository } from './repositories/pg-wallet.repository';

export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', (em) =>
      work({
        wallets: new PgWalletRepository(em),
        transactions: new PgWagerTransactionRepository(em),
        ledger: new PgLedgerRepository(em),
        outbox: new PgOutboxRepository(em),
        inbox: new PgInboxRepository(em),
      }),
    );
  }
}