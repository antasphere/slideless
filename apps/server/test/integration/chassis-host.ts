import { IDENTITY } from '@slideless/contract';
import type { ChassisTestHost } from '@antasphere/chassis-server/testing';
import { boot, type BootOverrides, type BootResult } from '../../src/boot.js';

/**
 * The Slideless host of the chassis suite
 * (`packages/chassis-server/test/integration`, run a second time by this app's
 * integration config): the real Slideless composition, the deck scope names,
 * and the deck list as the probe route — the values those files spelled
 * before they moved. `@chassis-test/host` resolves here under
 * `vitest.integration.config.ts`.
 */
export type HostBootResult = BootResult;
export type HostBootOverrides = BootOverrides;

export const host: ChassisTestHost<HostBootResult, HostBootOverrides> = {
  boot,
  identity: IDENTITY,
  hubClientId: 'tool-slideless-cloud',
  scopes: { read: 'presentations:read', write: 'presentations:write', dataExport: 'data:export' },
  probeRoute: '/api/v1/presentations'
};
