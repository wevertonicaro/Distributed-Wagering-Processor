import { MigrationInterface, QueryRunner, Table, TableCheck, TableForeignKey, TableIndex, TableUnique } from "typeorm";

const tableName = 'wager_transactions';
export class CreateWagerTransactions1793464081696 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (!tableExist) {
            await queryRunner.createTable(
                new Table({
                    name: tableName,
                    columns: [
                        { name: 'id', type: 'uuid', isPrimary: true },
                        { name: 'provider_id', type: 'text', isNullable: false },
                        { name: 'external_transaction_id', type: 'text', isNullable: false },
                        { name: 'idempotency_key', type: 'text', isNullable: false },
                        { name: 'payload_hash', type: 'text', isNullable: false },
                        { name: 'wallet_id', type: 'uuid', isNullable: false },
                        { name: 'player_id', type: 'uuid', isNullable: false },
                        { name: 'round_id', type: 'text', isNullable: false },
                        { name: 'game_id', type: 'text', isNullable: false },
                        { name: 'kind', type: 'text', isNullable: false },
                        { name: 'amount', type: 'numeric', precision: 19, scale: 2, isNullable: false },
                        { name: 'currency', type: 'char', length: '3', isNullable: false },
                        { name: 'reference_external_transaction_id', type: 'text', isNullable: true },
                        { name: 'reference_transaction_id', type: 'uuid', isNullable: true },
                        { name: 'status', type: 'text', isNullable: false, default: `'PENDING'` },
                        { name: 'failure_code', type: 'text', isNullable: true },
                        { name: 'observed_balance', type: 'numeric', precision: 19, scale: 2, isNullable: true },
                        { name: 'reference_attempts', type: 'integer', isNullable: false, default: 0 },
                        { name: 'next_reference_attempt_at', type: 'timestamptz', isNullable: true },
                        { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'now()' },
                        { name: 'processed_at', type: 'timestamptz', isNullable: true },
                    ],
                    uniques: [
                        new TableUnique({
                            name: 'uq_wager_tx_provider_idempotency',
                            columnNames: ['provider_id', 'idempotency_key'],
                        }),
                        new TableUnique({
                            name: 'uq_wager_tx_provider_external',
                            columnNames: ['provider_id', 'external_transaction_id'],
                        }),
                    ],
                    checks: [
                        new TableCheck({
                            name: 'chk_wager_tx_kind',
                            expression: `kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')`,
                        }),
                        new TableCheck({
                            name: 'chk_wager_tx_status',
                            expression: `status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')`,
                        }),
                        new TableCheck({ name: 'chk_wager_tx_amount_non_negative', expression: 'amount >= 0' }),
                        new TableCheck({
                            name: 'chk_wager_tx_reference_required',
                            expression: `kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL`,
                        }),
                        new TableCheck({
                            name: 'chk_wager_tx_failure_code_required',
                            expression: `status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL`,
                        }),
                        new TableCheck({
                            name: 'chk_wager_tx_processed_fields',
                            expression: `status <> 'PROCESSED' OR (processed_at IS NOT NULL AND observed_balance IS NOT NULL)`,
                        }),
                        new TableCheck({
                            name: 'chk_wager_tx_opening_internal',
                            expression: `(kind = 'OPENING') = (provider_id = 'INTERNAL')`,
                        }),
                    ],
                    foreignKeys: [
                        new TableForeignKey({
                            name: 'fk_wager_tx_wallet',
                            columnNames: ['wallet_id'],
                            referencedTableName: 'wallets',
                            referencedColumnNames: ['id'],
                        }),
                        new TableForeignKey({
                            name: 'fk_wager_tx_reference',
                            columnNames: ['reference_transaction_id'],
                            referencedTableName: tableName,
                            referencedColumnNames: ['id'],
                        }),
                    ],
                    indices: [
                        new TableIndex({
                            name: 'uq_wager_tx_single_reversal',
                            columnNames: ['reference_transaction_id'],
                            isUnique: true,
                            where: `status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
                        }),
                        new TableIndex({
                            name: 'idx_wager_tx_pending_reference',
                            columnNames: ['next_reference_attempt_at'],
                            where: `status = 'PENDING_REFERENCE'`,
                        }),
                        new TableIndex({ name: 'idx_wager_tx_wallet', columnNames: ['wallet_id', 'created_at'] }),
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
