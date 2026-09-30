#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { run } from './index.js';

void run(process.argv.slice(2), {
  env: process.env,
  out: process.stdout,
  err: process.stderr,
  // The interactive prompt (`login`: the email, the code). The question
  // goes to stderr so `--json` on stdout stays clean.
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
}).then((code) => process.exit(code));
