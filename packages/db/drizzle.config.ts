import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // ALL tables: the chassis half, read from the installed @antasphere/chassis-db
  // (this package depends on it, so pnpm links it here; its schema.ts re-exports
  // the Better Auth tables from its auth-schema.ts) + the deck half
  // (./src/schema.ts). The migration history is one history.
  schema: ['./node_modules/@antasphere/chassis-db/src/schema.ts', './src/schema.ts'],
  out: './drizzle',
  dbCredentials: {
    // Only needed for drizzle-kit push/studio against a live DB; migrations
    // are generated offline from the schema and applied by the app at boot.
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/slideless'
  },
  verbose: true,
  strict: true
});
