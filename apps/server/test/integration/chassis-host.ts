import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY } from '@slideless/contract';
import type { ChassisTestHost } from '@antasphere/chassis-server/testing';
import { boot, type BootOverrides, type BootResult } from '../../src/boot.js';

/**
 * The Slideless host of the chassis suite
 * (`@antasphere/chassis-server/test/integration`, run a second time by this app's
 * integration config): the real Slideless composition, the deck scope names,
 * and the deck list as the probe route — the values those files spelled
 * before they moved. `@chassis-test/host` resolves here under
 * `vitest.integration.config.ts`.
 */
// The repository root, four levels up from this file.
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

export type HostBootResult = BootResult;
export type HostBootOverrides = BootOverrides;

export const host: ChassisTestHost<HostBootResult, HostBootOverrides> = {
  boot,
  // The folder this tool's boot applies: the one migration chain, chassis tables and the tool's.
  migrationsDir: join(root, 'packages/db/drizzle'),
  // The tool's own DR library: the chassis suite's dump check sources it.
  drLib: join(root, 'scripts/lib/dr-lib.sh'),
  identity: IDENTITY,
  hubClientId: 'tool-slideless-cloud',
  scopes: { read: 'presentations:read', write: 'presentations:write', dataExport: 'data:export' },
  probeRoute: '/api/v1/presentations'
};
