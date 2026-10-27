// Vitest project `interop`: RxJS 5.4.3 / 5.5.12 / 6.6.7 / 7.8.2 / 9.0.0-beta.1, plain positional subscribe, and the
// load-order child processes, which run the built package (the globalSetup builds dist when it is missing or older than
// src). Node ≥ 22.13 (RxJS 9 beta).
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'interop',
    environment: 'node',
    include: ['test/interop/**/*.test.ts'],
    globalSetup: ['test/interop/global-setup.ts'],
    testTimeout: 30000,
  },
});
