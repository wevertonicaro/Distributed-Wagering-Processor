function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var: ${name}`);
  return v;
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Invalid env var ${name}: expected integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`Invalid env var ${name}: use true|false`);
  return raw === 'true';
}

const q = (name: string, queue: string) =>
  str(name, `http://localhost:4566/000000000000/${queue}`);

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000, 1),
  logLevel: str('LOG_LEVEL', 'info'),
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 15000, 1),

  db: {
    url: str('DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
    poolMax: int('DB_POOL_MAX', 20, 1),
  },

  aws: {
    region: str('AWS_REGION', 'us-east-1'),
    endpoint: process.env.AWS_ENDPOINT_URL || undefined, // undefined => AWS real
  },

  sqs: {
    wagerQueueUrl: q('SQS_WAGER_QUEUE_URL', 'wager-transactions.fifo'),
    wagerDlqUrl: q('SQS_WAGER_DLQ_URL', 'wager-transactions-dlq.fifo'),
    eventsQueueUrl: q('SQS_EVENTS_QUEUE_URL', 'wager-events.fifo'),
    waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 10),
    visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30, 1),
    maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5, 1),
    consumerName: str('CONSUMER_NAME', 'wager-transactions-consumer'),
    concurrency: int('CONSUMER_CONCURRENCY', 5, 1),
  },

  outbox: {
    batchSize: int('OUTBOX_BATCH_SIZE', 50, 1),
    pollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 500, 50),
    backoffBaseMs: int('OUTBOX_BACKOFF_BASE_MS', 1000, 1),
    backoffMaxMs: int('OUTBOX_BACKOFF_MAX_MS', 60000, 1),
  },

  pendingReference: {
    maxAttempts: int('PENDING_REF_MAX_ATTEMPTS', 8, 1),
    backoffBaseMs: int('PENDING_REF_BACKOFF_BASE_MS', 2000, 1),
    backoffMaxMs: int('PENDING_REF_BACKOFF_MAX_MS', 300000, 1),
    pollIntervalMs: int('PENDING_REF_POLL_INTERVAL_MS', 1000, 50),
  },

  auth: {
    enabled: bool('AUTH_ENABLED', false),
  },
} as const;

export type Env = typeof env;