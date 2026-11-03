import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/db (dev, via tsx) and dist/db (production build).
const migrationsFolder = path.resolve(here, '../../drizzle');

/**
 * Applies pending SQL migrations. A Postgres advisory lock makes sure that if
 * two server instances start at once, only one runs migrations.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

// Allows `pnpm db:migrate` to run migrations on their own.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { default: pgModule } = await import('pg');
  const pool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations(pool);
  await pool.end();
  console.log('Migrations applied');
}
