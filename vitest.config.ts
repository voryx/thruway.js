// Vitest 5 root config: it only lists the projects, one file per project under test/projects/. Vitest accepts project
// *files* only when they are named `vitest.*.config.*`, so the project modules are imported and listed inline (inline
// projects inherit this root config).
//
// Coverage is a root-only option in Vitest, so its block lives here (the thresholds: global lines/statements/functions
// 95 %, branches 90 %; the core, ops, protocol, observable and validation code lines 98 %, branches 95 %). They apply
// to every `--coverage` run: CI's is the whole unit project (`npm run test:unit -- --coverage`); a run of a few files
// with `--coverage` fails them.
import { defineConfig } from 'vitest/config';
import browser from './test/projects/browser.js';
import integration from './test/projects/integration.js';
import interop from './test/projects/interop.js';
import mutation from './test/projects/mutation.js';
import node from './test/projects/node.js';
import unit from './test/projects/unit.js';

export default defineConfig({
  test: {
    projects: [unit, node, interop, browser, integration, mutation],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
        'src/core/**': { lines: 98, branches: 95 },
        'src/ops/**': { lines: 98, branches: 95 },
        'src/protocol/**': { lines: 98, branches: 95 },
        'src/observable/**': { lines: 98, branches: 95 },
        'src/validate.ts': { lines: 98, branches: 95 },
      },
    },
  },
});
