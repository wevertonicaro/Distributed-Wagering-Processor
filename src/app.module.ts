import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { systemClock, uuidGenerator } from './application/ports/clock.port';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ReconcileWallet } from './application/use-cases/reconcile-wallet';
import { CoreModule } from './core.module';
import { PgWalletQueries } from './infra/database/repositories/pg-wallet-queries';
import { TypeOrmUnitOfWork } from './infra/database/typeorm-unit-of-work';
import { DomainExceptionFilter } from './infra/http/domain-exception.filter';
import { HealthController, MetricsController } from './infra/http/ops.controller';
import { WageringController } from './infra/http/wagering.controller';
import { WalletsController } from './infra/http/wallets.controller';
import { createSqsClient } from './infra/messaging/sqs.client';

@Module({
  imports: [CoreModule],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: SQSClient, useFactory: createSqsClient },
    { provide: PgWalletQueries, useFactory: (ds: DataSource) => new PgWalletQueries(ds), inject: [DataSource] },
    {
      provide: CreateWallet,
      useFactory: (uow: TypeOrmUnitOfWork) => new CreateWallet(uow, systemClock, uuidGenerator),
      inject: [TypeOrmUnitOfWork],
    },
    { provide: ReconcileWallet, useFactory: (q: PgWalletQueries) => new ReconcileWallet(q), inject: [PgWalletQueries] },
  ],
})
export class AppModule {}