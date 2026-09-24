import { makeCreateTestApp, type TestApp as ChassisTestApp } from '@antasphere/chassis-server/testing';
import { boot, type BootOverrides, type BootResult } from '../../src/boot.js';

/**
 * The Slideless binding of the shared harness (`@antasphere/chassis-server/testing`,
 * ONE copy for the chassis suite and for these tests): the same helpers, with
 * `createTestApp` bound to the real Slideless `boot()`.
 */
export {
  RecordingEmailDriver,
  SETUP_TOKEN,
  PG_IMAGE,
  startPostgres,
  expectBootRefusal,
  createDatabase,
  truncateAll,
  readJson,
  extractCookie
} from '@antasphere/chassis-server/testing';

export type TestApp = ChassisTestApp<BootResult>;

const createChassisTestApp = makeCreateTestApp<BootResult, BootOverrides>(boot);

/**
 * Boot the real app (real migrations, real Better Auth) against a database.
 * The deck-image capture (PRDCT-2725) is OFF unless a suite turns it on: a
 * machine with a Chromium at the default path would otherwise launch it on
 * every push of every suite. A suite that tests the capture passes its own
 * renderer (`overrides.tool.thumbnailRenderer`), which wins over the switch.
 */
export const createTestApp: typeof createChassisTestApp = (connectionString, extraEnv = {}, overrides) =>
  createChassisTestApp(connectionString, { SLIDELESS_THUMBNAILS: 'off', ...extraEnv }, overrides);
