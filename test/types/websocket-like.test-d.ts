/**
 * The structural transport types: the DOM `WebSocket` (browsers; this project has lib dom) and the `ws` package's class
 * satisfy `WebSocketConstructorLike`, their instances `WebSocketLike`, so either can be passed as
 * `ClientOptions.WebSocket` without a cast. Node's undici WebSocket under @types/node without DOM is proven by
 * node-only/websocket-like-node.test-d.ts.
 */
import { describe, expectTypeOf, test } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import type { ClientOptions, WebSocketConstructorLike, WebSocketLike } from '../../src/index.js';
import type { TestRouter } from '../../src/testing/index.js';

describe('WebSocketConstructorLike', () => {
  test('the DOM WebSocket', () => {
    expectTypeOf(globalThis.WebSocket).toExtend<WebSocketConstructorLike>();
    expectTypeOf<InstanceType<typeof globalThis.WebSocket>>().toExtend<WebSocketLike>();
    expectTypeOf({ WebSocket: globalThis.WebSocket }).toExtend<ClientOptions>();
  });
  test('the ws package', () => {
    expectTypeOf(WsWebSocket).toExtend<WebSocketConstructorLike>();
    expectTypeOf<InstanceType<typeof WsWebSocket>>().toExtend<WebSocketLike>();
    expectTypeOf({ WebSocket: WsWebSocket }).toExtend<ClientOptions>();
  });
  test('the testing kit socket', () => {
    expectTypeOf<TestRouter['WebSocket']>().toExtend<WebSocketConstructorLike>();
  });
  test('something else is not a WebSocket', () => {
    expectTypeOf<new (url: string) => { send(data: string): void }>().not.toExtend<WebSocketConstructorLike>();
  });
});
