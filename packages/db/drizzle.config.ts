import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // ALL tables: the chassis half (which re-exports the Better Auth tables from
  // its auth-schema.ts) + the deck half. The migration history is one history.
  schema: ['../chassis-db/src/schema.ts', './src/schema.ts'],
  out: './drizzle',
  dbCredentials: {
    // Only needed for drizzle-kit push/studio against a live DB; migrations
    // are generated offline from the schema and applied by the app at boot.
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/slideless'
  },
  verbose: true,
  strict: true
});
