import { MigrationInterface, QueryRunner } from 'typeorm';

export class LedgerImmutabilityTrigger1793464128631 implements MigrationInterface {
  name = 'LedgerImmutabilityTrigger1793464128631';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable (% blocked)', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries`);
    await q.query(`DROP FUNCTION IF EXISTS forbid_ledger_mutation()`);
  }
}