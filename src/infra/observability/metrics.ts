import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { ProcessingMetrics } from '../../application/ports/metrics.port';

export const registry = new Registry();

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export const transactionsTotal = new Counter({
  name: 'wager_transactions_total',
  help: 'Wager transactions processed, by final status (idempotent replays excluded)',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const duplicatesTotal = new Counter({
  name: 'wager_duplicates_total',
  help: 'Idempotent replays detected',
  registers: [registry],
});

export const processingSeconds = new Histogram({
  name: 'wager_processing_seconds',
  help: 'Latency of ProcessWagerTransaction',
  buckets: BUCKETS,
  registers: [registry],
});

export const walletLockWaitSeconds = new Histogram({
  name: 'wallet_lock_wait_seconds',
  help: 'Time spent waiting for the wallet row lock (lock contention)',
  buckets: BUCKETS,
  registers: [registry],
});

export const concurrentModificationsTotal = new Counter({
  name: 'wallet_concurrent_modifications_total',
  help: 'Optimistic version guard failures (should stay at zero while the row lock is held)',
  registers: [registry],
});

export const messageRetriesTotal = new Counter({
  name: 'sqs_message_retries_total',
  help: 'SQS messages released for retry after a transient error',
  registers: [registry],
});

export const dlqMessagesTotal = new Counter({
  name: 'sqs_dlq_messages_total',
  help: 'Messages sent (or about to be redriven) to the DLQ',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const outboxPublishedTotal = new Counter({
  name: 'outbox_published_total',
  help: 'Outbox events published',
  registers: [registry],
});

export const outboxPublishFailuresTotal = new Counter({
  name: 'outbox_publish_failures_total',
  help: 'Outbox publish attempts that failed and were rescheduled with backoff',
  registers: [registry],
});

export const pendingReferenceTotal = new Counter({
  name: 'pending_reference_attempts_total',
  help: 'PENDING_REFERENCE reprocessing attempts, by resulting status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const reconciliationDivergences = new Counter({
  name: 'reconciliation_divergences_total',
  help: 'Wallets whose stored balance differs from the balance rebuilt from the ledger',
  registers: [registry],
});

let lagRegistered = false;
export function registerOutboxLag(read: () => Promise<number>): void {
  if (lagRegistered) return;
  lagRegistered = true;
  new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [registry],
    async collect() {
      this.set(await read());
    },
  });
}

export const prometheusProcessingMetrics: ProcessingMetrics = {
  transaction(status, replay, seconds) {
    if (replay) duplicatesTotal.inc();
    else transactionsTotal.inc({ status });
    processingSeconds.observe(seconds);
  },
  lockWait(seconds) {
    walletLockWaitSeconds.observe(seconds);
  },
};