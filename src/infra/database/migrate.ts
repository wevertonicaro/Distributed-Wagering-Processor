import { dataSource } from './data-source';

async function main() {
  const cmd = process.argv[2];
  await dataSource.initialize();
  try {
    if (cmd === 'up') {
      const applied = await dataSource.runMigrations();
      console.log(`applied: ${applied.map((m) => m.name).join(', ') || 'none'}`);
    } else if (cmd === 'down') {
      await dataSource.undoLastMigration();
      console.log('reverted last migration');
    } else {
      throw new Error('usage: migrate.ts up|down');
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});