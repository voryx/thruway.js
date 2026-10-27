// Vitest project `integration`: real routers under podman (`npm run test:integration`; ROUTERS unset: Thruway PHP only,
// ROUTERS=all or a comma list for others, REQUIRE_ROUTERS=1 makes an unavailable router a failure). The global setup
// starts the selected routers through scripts/routers.mjs and stops them at the end; files run one at a time
// (router-wide faults never hit another file's clients), no retries (a flake is a bug).
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/harness/global-setup.ts'],
    setupFiles: ['test/integration/harness/setup.ts'],
    fileParallelism: false,
    retry: 0,
    testTimeout: 120000,
    hookTimeout: 300000,
  },
});
