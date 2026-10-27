// Vitest project `mutation`: what Stryker runs — the unit, sim, model and fuzz tests without typecheck, browsers, real
// sockets or routers, with a fixed fast-check seed and 50 runs. Left out: the self-test of the model
// (broken-participant.test.ts patches a participant and asserts the model notices; it judges the model, not src/, and
// costs seconds per mutant).
import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mutation',
    environment: 'node',
    include: [
      'test/unit/**/*.test.ts',
      'test/sim/**/*.test.ts',
      'test/model/**/*.test.ts',
      'test/fuzz/**/*.test.ts',
      'test/helpers/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, 'test/model/broken-participant.test.ts'],
    setupFiles: ['test/setup-fast-check.ts'],
    env: { FC_SEED: '424242', FC_NUM_RUNS: '50' },
    // Stryker's instrumented code is several times slower (the 16 MiB frame-size tests, the transcript recordings)
    testTimeout: 60000,
    hookTimeout: 120000,
    typecheck: { enabled: false },
  },
});
