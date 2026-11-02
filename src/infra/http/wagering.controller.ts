import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { InvalidRequestError, TransactionNotFoundError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { asObject, assertUuid, optionalString } from '../../application/validation';
import { MoneyProps } from '../../domain/money';
import { WagerTransactionStatus as S } from '../../domain/wagering/wager-transaction';
import { PgWalletQueries } from '../database/repositories/pg-wallet-queries';
import type { HttpResponse } from './domain-exception.filter';
import { NoOpAuthGuard } from './no-op-auth.guard';

const HTTP_STATUS: Record<S, number> = {
  [S.Processed]: 200,
  [S.PendingReference]: 202,
  [S.Pending]: 202,
  [S.Rejected]: 422,
  [S.Failed]: 422,
};

@Controller()
@UseGuards(NoOpAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(PgWalletQueries) private readonly queries: PgWalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    if (!idempotencyKey?.trim()) throw new InvalidRequestError('Idempotency-Key header is required');
    const b = asObject(raw);

    const result = await this.processWager.execute({
      providerId: optionalString(b.providerId, 'providerId') as string,
      externalTransactionId: optionalString(b.externalTransactionId, 'externalTransactionId') as string,
      idempotencyKey: idempotencyKey.trim(),
      playerId: optionalString(b.playerId, 'playerId') as string,
      walletId: optionalString(b.walletId, 'walletId') as string,
      roundId: optionalString(b.roundId, 'roundId') as string,
      gameId: optionalString(b.gameId, 'gameId') as string,
      kind: optionalString(b.kind, 'kind') as string,
      money: b.money as MoneyProps,
      referenceExternalTransactionId: optionalString(b.referenceExternalTransactionId, 'referenceExternalTransactionId'),
      correlationId: correlationId?.trim() || undefined,
    });

    res.status(HTTP_STATUS[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    assertUuid('transactionId', transactionId);
    const tx = await this.queries.findTransactionById(transactionId);
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return tx;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.queries.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return tx;
  }
}