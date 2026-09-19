import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this app's packaging puts things, resolved from the location of THIS
 * file — which must stay directly under `apps/server/src/`: in the image the
 * app is bundled into `/app/dist/index.js` (so `here` is `/app/dist`), in dev
 * and tests it runs unbundled from `apps/server/src/`. Both layouts resolve
 * the candidates below exactly as they always did.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** Locate the committed migrations folder in dev (workspace) and in the image. */
export function findMigrationsFolder(): string {
  const candidates = [
    join(here, '../drizzle'), // image layout: /app/drizzle next to /app/dist
    join(here, '../../../packages/db/drizzle') // workspace layout from apps/server/dist or src
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`migrations folder not found; looked in: ${candidates.join(', ')}`);
}

/** Directory holding the built dashboard SPA. */
export const publicDir = join(here, '../public');
