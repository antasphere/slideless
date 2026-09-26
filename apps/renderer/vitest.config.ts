import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A cold Chromium launch alone can take seconds on a loaded machine.
    testTimeout: 60_000
  }
});
