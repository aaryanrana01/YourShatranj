import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` turns changes in src/db/schema.ts into a new SQL file in ./drizzle.
// The server applies pending files at startup (src/db/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
