import { DataSource } from 'typeorm';
import { systemClock, uuidGenerator } from '../application/ports/clock.port';
import { WagerTransactionApplier } from '../application/services/wager-transaction-applier';
import { CreateWallet } from '../application/use-cases/create-wallet';
import { ProcessWagerTransaction } from '../application/use-cases/process-wager-transaction';
import { TypeOrmUnitOfWork } from '../infra/database/typeorm-unit-of-work';

export function buildApp(ds: DataSource) {
  const uow = new TypeOrmUnitOfWork(ds);
  const applier = new WagerTransactionApplier(uuidGenerator, {
    maxAttempts: 8,
    backoffBaseMs: 2000,
    backoffMaxMs: 300_000,
  });
  return {
    uow,
    applier,
    createWallet: new CreateWallet(uow, systemClock, uuidGenerator),
    process: new ProcessWagerTransaction(uow, applier, systemClock, uuidGenerator),
  };
}