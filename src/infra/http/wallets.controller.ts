import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InvalidRequestError, WalletNotFoundError } from '../../application/errors';
import { CreateWallet } from '../../application/use-cases/create-wallet';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet';
import { asObject, assertUuid, optionalString } from '../../application/validation';
import { MoneyProps } from '../../domain/money';
import { PgWalletQueries } from '../database/repositories/pg-wallet-queries';
import { log } from '../observability/logger';
import { reconciliationDivergences } from '../observability/metrics';
import { NoOpAuthGuard } from './no-op-auth.guard';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const encodeCursor = (seq: string) => Buffer.from(JSON.stringify({ seq })).toString('base64url');

function decodeCursor(cursor: string): string {
  let seq: unknown;
  try {
    seq = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).seq;
  } catch {
    throw new InvalidRequestError('invalid cursor');
  }
  if (typeof seq !== 'string' || !/^\d+$/.test(seq)) {
    throw new InvalidRequestError('invalid cursor');
  }
  return seq;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

@Controller('wallets')
@UseGuards(NoOpAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(PgWalletQueries) private readonly queries: PgWalletQueries,
  ) {}

  @Post()
  create(@Body() raw: unknown) {
    const b = asObject(raw);
    return this.createWallet.execute({
      playerId: optionalString(b.playerId, 'playerId') as string,
      initialBalance: b.initialBalance as MoneyProps,
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    assertUuid('walletId', walletId);
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    assertUuid('walletId', walletId);
    const limit = parseLimit(limitRaw);
    const after = cursor ? decodeCursor(cursor) : null;
    if (!(await this.queries.findWallet(walletId))) throw new WalletNotFoundError(walletId);

    const rows = await this.queries.ledgerPage(walletId, after, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ seq: _seq, ...item }) => item),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string) {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      reconciliationDivergences.inc();
      log('error', 'wallet reconciliation divergence', {
        walletId,
        difference: result.difference.amount,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}