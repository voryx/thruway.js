// Vitest project `node`: real sockets, child processes, exit/no-ws, and the packed-tarball
// smoke/hazard/bundle-semantics tests and the release/audit gate tests. Its globalSetup builds dist and packs it first
// (test/package/global-setup.ts), so every run tests a fresh build.
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'node',
    environment: 'node',
    include: ['test/node/**/*.test.ts', 'test/package/**/*.test.ts'],
    globalSetup: ['test/package/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
