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

/** Boot the real app (real migrations, real Better Auth) against a database. */
export const createTestApp = makeCreateTestApp<BootResult, BootOverrides>(boot);
