import type { PlatformClient } from '@slideless/sdk';
import type { CliTestHost } from '@antasphere/chassis-cli/testing';
import { cli as slidelessCli } from '../src/cli.js';
import { run as slidelessRun } from '../src/index.js';

/**
 * The Slideless host of the chassis suite (`packages/chassis-cli/test/suite`,
 * run a second time by this package's vitest config): the real kit
 * (`src/cli.ts`) and the real runner, which binds the Slideless command groups
 * and `VERSION` (`src/index.ts`). The identity it carries gives those files
 * the literals they spelled before they moved. `@chassis-cli-test/host`
 * resolves here.
 */
const host: CliTestHost<PlatformClient> = { cli: slidelessCli, run: slidelessRun };

export const { cli, run } = host;
