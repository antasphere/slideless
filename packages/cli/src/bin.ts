#!/usr/bin/env node
import { run } from './index.js';

void run(process.argv.slice(2), {
  env: process.env,
  out: process.stdout,
  err: process.stderr
}).then((code) => process.exit(code));
