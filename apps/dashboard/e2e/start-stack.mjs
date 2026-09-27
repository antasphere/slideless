/**
 * Playwright webServer command: builds the image, brings the compose stack up
 * on an isolated project with a FRESH database, then stays alive until
 * Playwright tears it down (global-teardown.mjs runs `compose down -v`).
 */
import { spawnSync } from 'node:child_process';
import { composeArgs, stackEnv, APP_PORT } from './stack-env.mjs';

const env = stackEnv();

function compose(args, opts = {}) {
  const result = spawnSync('docker', [...composeArgs, ...args], {
    env,
    stdio: 'inherit',
    ...opts
  });
  if (result.status !== 0) {
    console.error(`docker ${['compose', ...args].join(' ')} failed with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// A stale project from an aborted run would reuse its old database — the spec
// assumes first-boot, so always start from zero.
compose(['down', '-v', '--remove-orphans']);
// The renderer is built too (the images profile): its boot self-check takes
// a few seconds, and `up --wait` waits on its healthcheck as well.
compose(['build', 'app', 'renderer']);
compose(['up', '-d', '--wait']);

console.log(`pw-smoke stack up on :${APP_PORT}; waiting for teardown…`);

// Keep the webServer process alive; Playwright kills it when the run ends.
setInterval(() => {}, 60_000);
