// Vitest config of the nested run in test/package/bundle-semantics.test.ts (never part of the root config's projects):
// the unit tests of the error classes, the Observable and Yield run unchanged, but their imports of those src modules
// resolve to the rspack/swc build of the same modules in $THRUWAY_SEMANTICS_DIR (the browser bundles must have the tsc
// builds' class-field and runtime semantics).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = process.env['THRUWAY_SEMANTICS_DIR'];
if (dir === undefined)
  throw new Error('THRUWAY_SEMANTICS_DIR is not set (run through test/package/bundle-semantics.test.ts)');

/** The src modules the unit files import (the specifiers as written in test/unit/*.test.ts) → bundle files. */
export const BUNDLED: Readonly<Record<string, string>> = {
  'src/errors.js': 'errors.mjs',
  'src/yield.js': 'yield.mjs',
  'src/observable/observable.js': 'observable.mjs',
  'src/observable/symbol-observable.js': 'symbol-observable.mjs',
};

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: Object.entries(BUNDLED).map(([module, file]) => ({
      find: new RegExp(`^(?:\\.\\./)+${module.replaceAll('.', '\\.')}$`),
      replacement: `${dir}/${file}`,
    })),
  },
  test: {
    environment: 'node',
    include: ['test/unit/errors.test.ts', 'test/unit/observable.test.ts', 'test/unit/yield.test.ts'],
    setupFiles: ['test/setup-fast-check.ts'],
    typecheck: { enabled: false },
  },
});
