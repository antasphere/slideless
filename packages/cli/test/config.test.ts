import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clearConfig, configPath, loadConfig, redactKey, saveConfig } from '../src/config.js';
import { tempConfigEnv } from './harness.js';

describe('CLI config store', () => {
  it('round-trips profiles through $XDG_CONFIG_HOME/antasphere/tools/slideless.json', async () => {
    const env = await tempConfigEnv();
    expect(loadConfig(env)).toEqual({ profiles: {} });
    saveConfig(env, {
      activeProfile: 'dev',
      profiles: { dev: { apiKey: 'slk_a_b', baseUrl: 'http://localhost:3100' } }
    });
    const loaded = loadConfig(env);
    expect(loaded.activeProfile).toBe('dev');
    expect(loaded.profiles.dev).toEqual({ apiKey: 'slk_a_b', baseUrl: 'http://localhost:3100' });
  });

  it('creates the dir 0700 and the file 0600', async () => {
    const env = await tempConfigEnv();
    const path = saveConfig(env, { profiles: { p: { apiKey: 'slk_x_y' } } });
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    const dir = path.slice(0, path.lastIndexOf('/'));
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME is unset', () => {
    // The slideless namespace of the SHARED antasphere config home
    // (@antasphere/cli-core) — moved here from ~/.config/slideless/.
    expect(configPath({ HOME: '/home/u' })).toBe('/home/u/.config/antasphere/tools/slideless.json');
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/antasphere/tools/slideless.json');
    expect(configPath({})).toBeNull();
  });

  it('treats a corrupt config file as empty instead of crashing', async () => {
    const env = await tempConfigEnv();
    const path = saveConfig(env, { profiles: {} });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, 'not json');
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('clear removes the file', async () => {
    const env = await tempConfigEnv();
    saveConfig(env, { profiles: { p: {} } });
    clearConfig(env);
    expect(loadConfig(env)).toEqual({ profiles: {} });
  });

  it('redacts keys to prefix…suffix', () => {
    expect(redactKey('slk_abcdefgh_0123456789abcdefghijklmnop')).toBe('slk_abcdefgh_…mnop');
    expect(redactKey('short')).toBe('****');
  });
});
