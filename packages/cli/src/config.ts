import {
  clearConfig as coreClearConfig,
  configPath as coreConfigPath,
  loadConfig as coreLoadConfig,
  migrateLegacyConfig,
  saveConfig as coreSaveConfig,
  type CliConfig,
  type CliEnv
} from '@antasphere/cli-core';

/**
 * The Slideless CLI's profiles live in the `slideless` namespace of the
 * shared Antasphere config home owned by @antasphere/cli-core:
 * `$XDG_CONFIG_HOME/antasphere/tools/slideless.json` (default
 * `~/.config/antasphere/tools/slideless.json`), 0700 dirs / 0600 file, fully
 * env-injected. The store's behavior (multi-profile, activeProfile, tolerant
 * parsing) is byte-for-byte the old local one — cli-core was extracted from
 * it.
 *
 * Migration: the pre-cli-core config lived at
 * `$XDG_CONFIG_HOME/slideless/config.json`. On any config read, if that file
 * still exists, holds at least one profile, and the shared home has no
 * slideless profiles yet, it is imported once, NON-destructively (the legacy
 * file stays in place for older CLI builds; it just stops being read).
 */

export { redactKey } from '@antasphere/cli-core';
export type { CliConfig, CliEnv, CliProfile } from '@antasphere/cli-core';

const TOOL = 'slideless';
const LEGACY = { tool: TOOL, legacyDir: 'slideless' };

/** Where the config lives for this environment; null when no home is known. */
export function configPath(env: CliEnv): string | null {
  return coreConfigPath(env, TOOL);
}

/** Load the config (after the one-shot legacy import); corrupt/missing = empty. */
export function loadConfig(env: CliEnv): CliConfig {
  try {
    migrateLegacyConfig(env, LEGACY);
  } catch {
    // A failed import must never break a read — worst case the user signs
    // in again; the legacy file is untouched either way.
  }
  return coreLoadConfig(env, TOOL);
}

/** Persist the config (0700 dirs / 0600 file). Throws when no home is known. */
export function saveConfig(env: CliEnv, config: CliConfig): string {
  return coreSaveConfig(env, TOOL, config);
}

/** Delete the config file (config clear). No-op when absent. */
export function clearConfig(env: CliEnv): void {
  coreClearConfig(env, TOOL);
}
