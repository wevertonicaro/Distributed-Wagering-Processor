import { MigrationInterface, QueryRunner, Table } from "typeorm";

const tableName = 'inbox_messages';
export class CreateInboxMessages1793464104424 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (!tableExist) {
            await queryRunner.createTable(new Table({
                name: tableName,
                columns: [
                    { name: 'consumer_name', type: 'text', isPrimary: true },
                    { name: 'message_id', type: 'text', isPrimary: true },
                    { name: 'payload_hash', type: 'text', isNullable: false },
                    { name: 'received_at', type: 'timestamptz', isNullable: false, default: 'now()' },
                    { name: 'processed_at', type: 'timestamptz', isNullable: true },
                ]
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
