import { Counter, Registry } from 'prom-client';

export const registry = new Registry();

export const reconciliationDivergences = new Counter({
  name: 'reconciliation_divergences_total',
  help: 'Wallets whose stored balance differs from the balance rebuilt from the ledger',
  registers: [registry],
});