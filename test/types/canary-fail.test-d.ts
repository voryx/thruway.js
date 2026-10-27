/**
 * The canary: this type test MUST fail to compile. scripts/typecheck.mjs compiles it with TypeScript 7 and 6 and
 * through vitest's typecheck (test/types/tsconfig.canary.json) and fails the run when it compiles cleanly — proof that
 * type tests are really type-checked and not silently skipped. Each line marked CANARY must produce exactly one error;
 * nothing else in this file may.
 */
import { expectTypeOf, test } from 'vitest';
import type { Status } from '../../src/index.js';

test('canary', () => {
  expectTypeOf<Status['state']>().toEqualTypeOf<'open'>(); // CANARY
});
