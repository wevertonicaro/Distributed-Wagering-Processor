import { DataSource } from 'typeorm';
import { dataSource } from '../infra/database/data-source';

export async function setupTestDatabase(): Promise<DataSource> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  const [{ db }] = await dataSource.query('SELECT current_database() AS db');
  if (!String(db).endsWith('_test')) {
    throw new Error(`Recusando rodar em "${db}": o banco de testes deve terminar com _test`);
  }
  await dataSource.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await dataSource.runMigrations();
  return dataSource;
}

export async function teardownTestDatabase(): Promise<void> {
  if (dataSource.isInitialized) await dataSource.destroy();
}