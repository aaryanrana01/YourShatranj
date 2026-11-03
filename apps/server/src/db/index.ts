import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Small pool: free Postgres tiers allow few connections, and a chess server
    // only touches Postgres at login and when a game ends.
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
export { schema };
