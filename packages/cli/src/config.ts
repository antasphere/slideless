import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Multi-profile CLI config at `$XDG_CONFIG_HOME/slideless/config.json`
 * (default `~/.config/slideless/config.json`). The file stores API keys, so
 * the directory is created 0700 and the file kept 0600 on every write.
 *
 * All I/O is synchronous and env-injected (no process.env reads) so tests can
 * point the whole config world at a temp dir via XDG_CONFIG_HOME.
 */

export interface CliProfile {
  /** `slk_...` API key for this instance. */
  apiKey?: string;
  /** Instance origin, e.g. https://slides.example.com */
  baseUrl?: string;
}

export interface CliConfig {
  activeProfile?: string;
  profiles: Record<string, CliProfile>;
}

export type CliEnv = Record<string, string | undefined>;

/** Where the config lives for this environment; null when no home is known. */
export function configPath(env: CliEnv): string | null {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : null);
  if (!base) return null;
  return join(base, 'slideless', 'config.json');
}

const EMPTY: CliConfig = { profiles: {} };

/** Load the config; a missing/unreadable/corrupt file is an empty config. */
export function loadConfig(env: CliEnv): CliConfig {
  const path = configPath(env);
  if (!path || !existsSync(path)) return { ...EMPTY, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CliConfig>;
    const profiles =
      parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
    return {
      ...(typeof parsed.activeProfile === 'string' ? { activeProfile: parsed.activeProfile } : {}),
      profiles
    };
  } catch {
    return { ...EMPTY, profiles: {} };
  }
}

/** Persist the config (0700 dir / 0600 file). Throws when no home is known. */
export function saveConfig(env: CliEnv, config: CliConfig): string {
  const path = configPath(env);
  if (!path) {
    throw new Error(
      'Cannot locate a config directory — set HOME or XDG_CONFIG_HOME, or pass --api-key/--api-url explicitly.'
    );
  }
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies on creation — re-assert on every write.
  chmodSync(dir, 0o700);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Delete the config file (config clear). No-op when absent. */
export function clearConfig(env: CliEnv): void {
  const path = configPath(env);
  if (path && existsSync(path)) rmSync(path);
}

/** `slk_abcd1234_…` → `slk_abcd1234_…c3f9` — safe for terminals and logs. */
export function redactKey(key: string): string {
  if (key.length <= 16) return '****';
  return `${key.slice(0, 13)}…${key.slice(-4)}`;
}
