import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { systemClock, uuidGenerator } from './application/ports/clock.port';
import { WagerTransactionApplier } from './application/services/wager-transaction-applier';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { env } from './infra/config/env';
import { TypeOrmUnitOfWork } from './infra/database/typeorm-unit-of-work';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: env.db.url,
      extra: { max: env.db.poolMax },
      migrationsRun: false,
      synchronize: false,
    }),
  ],
  providers: [
    { provide: TypeOrmUnitOfWork, useFactory: (ds: DataSource) => new TypeOrmUnitOfWork(ds), inject: [DataSource] },
    { provide: WagerTransactionApplier, useFactory: () => new WagerTransactionApplier(uuidGenerator, env.pendingReference) },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: TypeOrmUnitOfWork, applier: WagerTransactionApplier) =>
        new ProcessWagerTransaction(uow, applier, systemClock, uuidGenerator),
      inject: [TypeOrmUnitOfWork, WagerTransactionApplier],
    },
  ],
  exports: [TypeOrmUnitOfWork, WagerTransactionApplier, ProcessWagerTransaction],
})
export class CoreModule {}