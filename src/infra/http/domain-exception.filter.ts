import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { DomainError } from '../../domain/domain-error';
import { log } from '../observability/logger';

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

export interface Translated {
  status: number;
  body: { code: string; message: string };
  retryAfterSeconds?: number;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_MONEY: 400,
  INVALID_WAGER_TRANSACTION: 400,
  CURRENCY_MISMATCH: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  CONCURRENT_MODIFICATION: 503,
};

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  '57P01', '57P02', '57P03', 
  '53300', 
  '40001', '40P01', 
]);

export function isTransientInfrastructureError(error: unknown): boolean {
  const e = error as { code?: unknown; driverError?: { code?: unknown }; message?: unknown } | null;
  const codes = [e?.code, e?.driverError?.code].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => TRANSIENT_CODES.has(c) || c.startsWith('08'))) return true;
  return typeof e?.message === 'string' && /connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(e.message);
}

export function translate(error: unknown): Translated {
  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code];
    if (status) {
      return {
        status,
        body: { code: error.code, message: error.message },
        ...(status === 503 ? { retryAfterSeconds: 1 } : {}),
      };
    }
  }
  if (isTransientInfrastructureError(error)) {
    return {
      status: 503,
      body: { code: 'SERVICE_UNAVAILABLE', message: 'temporary failure; retry with the same idempotency key' },
      retryAfterSeconds: 1,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, body: { code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: error.message } };
  }
  const clientStatus = (error as { status?: unknown } | null)?.status;
  if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
    return { status: clientStatus, body: { code: 'INVALID_REQUEST', message: 'malformed request' } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'unexpected error' } };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<HttpResponse>();
    const req = http.getRequest<{ method?: string; url?: string }>();
    const t = translate(exception);

    if (t.status >= 500) {
      log('error', 'request failed', {
        method: req.method,
        path: req.url,
        code: t.body.code,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }
    if (t.retryAfterSeconds) res.setHeader('Retry-After', String(t.retryAfterSeconds));
    res.status(t.status).json(t.body);
  }
}