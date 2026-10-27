/**
 * Node's global (undici) WebSocket satisfies `WebSocketConstructorLike` under @types/node without the DOM library
 * (this project has `lib: ["es2023"]`, `types: ["node"]`). Compiled by scripts/typecheck.mjs with TypeScript 7 and 6.
 */
import { describe, expectTypeOf, test } from 'vitest';
import type { ClientOptions, WebSocketConstructorLike, WebSocketLike } from '../../../src/index.js';

describe('undici WebSocket (Node ≥ 22 global)', () => {
  test('satisfies the structural transport types', () => {
    expectTypeOf(globalThis.WebSocket).toExtend<WebSocketConstructorLike>();
    expectTypeOf<InstanceType<typeof globalThis.WebSocket>>().toExtend<WebSocketLike>();
    expectTypeOf({ WebSocket: globalThis.WebSocket }).toExtend<ClientOptions>();
  });
  test('no DOM library in this project', () => {
    // @ts-expect-error -- `document` exists only with lib dom; this project must not have it
    expectTypeOf(document).toBeObject();
  });
});
