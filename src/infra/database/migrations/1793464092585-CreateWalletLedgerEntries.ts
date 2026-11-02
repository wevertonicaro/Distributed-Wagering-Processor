import { MigrationInterface, QueryRunner, Table, TableCheck, TableForeignKey, TableUnique } from "typeorm";

const tableName = 'wallet_ledger_entries';
export class CreateWalletLedgerEntries1793464092585 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (!tableExist) {
            await queryRunner.createTable(
                new Table({
                    name: tableName,
                    columns: [
                        { name: 'id', type: 'uuid', isPrimary: true },
                        {
                            name: 'seq',
                            type: 'bigint',
                            isGenerated: true,
                            generationStrategy: 'identity',
                            generatedIdentity: 'ALWAYS',
                        },
                        { name: 'wallet_id', type: 'uuid', isNullable: false },
                        { name: 'transaction_id', type: 'uuid', isNullable: false },
                        { name: 'direction', type: 'text', isNullable: false },
                        { name: 'amount', type: 'numeric', precision: 19, scale: 2, isNullable: false },
                        { name: 'balance_before', type: 'numeric', precision: 19, scale: 2, isNullable: false },
                        { name: 'balance_after', type: 'numeric', precision: 19, scale: 2, isNullable: false },
                        { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'now()' },
                    ],
                    uniques: [
                        new TableUnique({
                            name: 'uq_ledger_wallet_transaction',
                            columnNames: ['wallet_id', 'transaction_id'],
                        }),
                        new TableUnique({ name: 'uq_ledger_wallet_seq', columnNames: ['wallet_id', 'seq'] }),
                    ],
                    checks: [
                        new TableCheck({
                            name: 'chk_ledger_direction',
                            expression: `direction IN ('DEBIT','CREDIT')`,
                        }),
                        new TableCheck({ name: 'chk_ledger_amount_positive', expression: 'amount > 0' }),
                        new TableCheck({
                            name: 'chk_ledger_balances_non_negative',
                            expression: 'balance_before >= 0 AND balance_after >= 0',
                        }),
                        new TableCheck({
                            name: 'chk_ledger_arithmetic',
                            expression: `(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)`,
                        }),
                    ],
                    foreignKeys: [
                        new TableForeignKey({
                            name: 'fk_ledger_wallet',
                            columnNames: ['wallet_id'],
                            referencedTableName: 'wallets',
                            referencedColumnNames: ['id'],
                        }),
                        new TableForeignKey({
                            name: 'fk_ledger_transaction',
                            columnNames: ['transaction_id'],
                            referencedTableName: 'wager_transactions',
                            referencedColumnNames: ['id'],
                        }),
                    ],
                })
            )
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (tableExist) {
            await queryRunner.dropTable(tableName, true);
        }
    }

}
