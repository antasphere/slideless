import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger.js';

/**
 * Resolve the auth secret: prefer AUTH_SECRET from the environment; otherwise
 * persist a generated one under DATA_DIR (n8n-style zero-config first run).
 * The file is written 0600 and reused on every subsequent boot, so sessions
 * survive restarts even when the operator never set a secret.
 */
export async function resolveAuthSecret(
  envSecret: string | undefined,
  dataDir: string,
  log: Logger
): Promise<string> {
  if (envSecret) return envSecret;

  const secretPath = join(dataDir, 'secret');
  try {
    const existing = (await readFile(secretPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
    log.warn({ secretPath }, 'existing secret file is too short — regenerating');
  } catch {
    // no secret file yet
  }

  const secret = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  // Write + rename (same dir → atomic) so a crash mid-write never leaves a
  // truncated secret that a later boot would accept and lock everyone out.
  const tmpPath = join(dataDir, `.secret.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, secret + '\n', { mode: 0o600 });
    await rename(tmpPath, secretPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  log.warn(
    { secretPath },
    'AUTH_SECRET was not set — generated one into the data volume. ' +
      'Set AUTH_SECRET explicitly for multi-replica deployments; all replicas must share it.'
  );
  return secret;
}
