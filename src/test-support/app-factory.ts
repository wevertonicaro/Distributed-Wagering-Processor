import { DataSource } from 'typeorm';
import { systemClock, uuidGenerator } from '../application/ports/clock.port';
import { WagerTransactionApplier } from '../application/services/wager-transaction-applier';
import { CreateWallet } from '../application/use-cases/create-wallet';
import { ProcessWagerTransaction } from '../application/use-cases/process-wager-transaction';
import { ResolvePendingReferences } from '../application/use-cases/resolve-pending-references';
import { TypeOrmUnitOfWork } from '../infra/database/typeorm-unit-of-work';

export const PENDING_MAX_ATTEMPTS = 8;

export function buildApp(ds: DataSource) {
  const uow = new TypeOrmUnitOfWork(ds);
  const applier = new WagerTransactionApplier(uuidGenerator, {
    maxAttempts: PENDING_MAX_ATTEMPTS,
    backoffBaseMs: 2000,
    backoffMaxMs: 300_000,
  });
  return {
    uow,
    applier,
    createWallet: new CreateWallet(uow, systemClock, uuidGenerator),
    process: new ProcessWagerTransaction(uow, applier, systemClock, uuidGenerator),
    resolvePending: new ResolvePendingReferences(uow, applier, systemClock),
  };
}