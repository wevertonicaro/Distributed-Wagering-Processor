import { MigrationInterface, QueryRunner, Table, TableCheck, TableUnique } from "typeorm";

const tableName = 'wallets';

export class CreateWallets1793464063737 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (!tableExist) {
            await queryRunner.createTable(
                new Table({
                    name: tableName,
                    columns: [
                    { 
                        name: 'id', 
                        type: 'uuid', 
                        isPrimary: true 
                    },
                    { 
                        name: 'player_id', 
                        type: 'uuid', 
                        isNullable: false 
                    },
                    { 
                        name: 'currency', 
                        type: 'char', 
                        length: '3', 
                        isNullable: false 
                    },
                    { 
                        name: 'balance', 
                        type: 'numeric', 
                        precision: 19, 
                        scale: 2, 
                        isNullable: false 
                    },
                    { 
                        name: 'version', 
                        type: 'integer', 
                        isNullable: false, 
                        default: 1 
                    },
                    { 
                        name: 'created_at', 
                        type: 'timestamptz', 
                        isNullable: false, 
                        default: 'now()' 
                    },
                    { 
                        name: 'updated_at', 
                        type: 'timestamptz', 
                        isNullable: false, 
                        default: 'now()' 
                    },
                    ],
                    uniques: [
                        new TableUnique({
                            name: 'uq_wallets_player_currency',
                            columnNames: ['player_id', 'currency'],
                        }),
                    ],
                    checks: [
                        new TableCheck({ 
                            name: 'chk_wallets_balance_non_negative', 
                            expression: 'balance >= 0' 
                        }),
                        new TableCheck({ 
                            name: 'chk_wallets_version_positive', 
                            expression: 'version >= 1' 
                        }),
                    ],
                }),
            );    
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tableExist = await queryRunner.hasTable(tableName);
        if (tableExist) {
            await queryRunner.dropTable(tableName);
        }
    }

}
