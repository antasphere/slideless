/** Removes the pw-smoke compose project AND its volumes (fresh DB next run). */
import { spawnSync } from 'node:child_process';
import { composeArgs, stackEnv } from './stack-env.mjs';

export default function globalTeardown() {
  spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
    env: stackEnv(),
    stdio: 'inherit'
  });
}
