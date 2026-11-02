import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { env } from '../config/env';

// glob exige "/" mesmo no Windows
const migrationsGlob = join(__dirname, 'migrations', '*.{ts,js}').replace(/\\/g, '/');

export const dataSource = new DataSource({
  type: 'postgres',
  url: env.db.url,
  extra: { max: env.db.poolMax },
  migrations: [migrationsGlob],
  migrationsTableName: 'migrations',
});