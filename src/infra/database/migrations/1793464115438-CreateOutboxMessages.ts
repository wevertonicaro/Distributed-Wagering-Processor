import { MigrationInterface, QueryRunner, Table, TableCheck, TableIndex } from "typeorm";

const tableName = 'outbox_messages';
export class CreateOutboxMessages1793464115438 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
            const tableExist = await queryRunner.hasTable(tableName);
            if (!tableExist) {
                await queryRunner.createTable(new Table({
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
                        { name: 'aggregate_id', type: 'uuid', isNullable: false },
                        { name: 'event_type', type: 'text', isNullable: false },
                        { name: 'payload', type: 'jsonb', isNullable: false },
                        { name: 'occurred_at', type: 'timestamptz', isNullable: false },
                        { name: 'attempts', type: 'integer', isNullable: false, default: 0 },
                        { name: 'next_attempt_at', type: 'timestamptz', isNullable: true },
                        { name: 'published_at', type: 'timestamptz', isNullable: true },
                        { name: 'last_error', type: 'text', isNullable: true },
                    ],
                    checks: [
                        new TableCheck({ name: 'chk_outbox_attempts_non_negative', expression: 'attempts >= 0' }),
                    ],
                    indices: [
                        new TableIndex({
                            name: 'idx_outbox_pending',
                            columnNames: ['seq'],
                            where: 'published_at IS NULL',
                        }),
                    ],
                }));
            }
        }
    
        public async down(queryRunner: QueryRunner): Promise<void> {
            const tableExist = await queryRunner.hasTable(tableName);
            if (tableExist) {
                await queryRunner.dropTable(tableName, true);
            }
        }

}
