// Vitest project `unit`: unit + sim + model + fuzz tests (node, virtual clock) and the type tests, compiled by
// TypeScript 7 through test/tsconfig.json.
//
// THRUWAY_TYPECHECK_CANARY=1 switches the project to the canary run of scripts/typecheck.mjs: type tests only, the
// canary file only, compiled through test/types/tsconfig.canary.json. That run must fail.
import { defineProject } from 'vitest/config';

const canary = process.env['THRUWAY_TYPECHECK_CANARY'] === '1';

export default defineProject({
  test: {
    name: 'unit',
    environment: 'node',
    include: [
      'test/unit/**/*.test.ts',
      'test/sim/**/*.test.ts',
      'test/model/**/*.test.ts',
      'test/fuzz/**/*.test.ts',
      'test/helpers/**/*.test.ts',
    ],
    setupFiles: ['test/setup-fast-check.ts'],
    typecheck: {
      enabled: true,
      only: canary,
      // TS 7 by explicit path: node_modules/.bin/tsc may be TS 6's (both packages ship a `tsc` bin).
      checker: 'node_modules/typescript7/bin/tsc',
      tsconfig: canary ? 'test/types/tsconfig.canary.json' : 'test/tsconfig.json',
      include: canary ? ['test/types/canary-fail.test-d.ts'] : ['test/types/**/*.test-d.ts'],
      // node-only has its own project (no DOM) and the canary must fail: both run in scripts/typecheck.mjs.
      exclude: canary ? [] : ['test/types/node-only/**', 'test/types/canary-fail.test-d.ts'],
    },
  },
});
