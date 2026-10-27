// The shipped browser bundles in real browsers: dist/browser/thruway.min.js as a classic <script> (global `thruway`
// with every root export and `thruway.auth`, Symbol.observable defined at load) and dist/browser/thruway.mjs as a
// module, each doing a handshake, a registration and a call with the browser's own WebSocket against the reference
// server. Needs a build (`npm run build`; the browser CI stage builds first).
import { afterEach, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type * as Root from '../../src/index.js';

type Bundle = typeof Root & { readonly auth: Record<string, unknown> };

const ROOT_EXPORTS = [
  'AbortError',
  'AuthenticationError',
  'CanceledError',
  'Client',
  'ConnectionClosedError',
  'ConnectionLostError',
  'ProtocolError',
  'TimeoutError',
  'WampError',
  'Yield',
  'auth',
  'isThruwayError',
  'isWampError',
  'jsonSerializer',
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function roundTrip(lib: Bundle): Promise<unknown[]> {
  const proxy = await commands.proxy('reference');
  cleanups.push(() => commands.closeProxy(proxy.id));
  const client = new lib.Client(proxy.url, 'realm1');
  cleanups.push(() => client.close());
  const echo = `com.bundle.e${Math.random().toString(36).slice(2, 10)}`; // unique: both browsers share the server
  await new Promise<void>((resolve, reject) => {
    client
      .register(echo, (inv) => new lib.Yield(inv.args))
      .subscribe({
        next: () => {
          resolve();
        },
        error: reject,
      });
  });
  const add = await new Promise<Root.ResultMessage>((resolve, reject) => {
    client.call('com.example.add', [2, 3]).subscribe({ next: resolve, error: reject });
  });
  const echoed = await new Promise<Root.ResultMessage>((resolve, reject) => {
    client.call(echo, ['hi']).subscribe({ next: resolve, error: reject });
  });
  return [add.args, echoed.args];
}

describe('dist/browser bundles', () => {
  test('thruway.min.js as a classic script: global thruway (and thruway.auth), Symbol.observable, a session', async () => {
    const before = typeof Symbol.observable;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../../dist/browser/thruway.min.js', import.meta.url).href;
      script.onload = () => {
        resolve();
      };
      script.onerror = () => {
        reject(new Error('thruway.min.js did not load (run npm run build)'));
      };
      document.head.append(script);
    });
    const lib = (globalThis as unknown as { thruway: Bundle }).thruway;
    expect(Object.keys(lib).sort()).toEqual(ROOT_EXPORTS);
    expect(Object.keys(lib.auth).sort()).toEqual(['cryptosign', 'ticket', 'wampcra']);
    // nothing in this page defines it before the bundle (the import above is type-only): the bundle's ponyfill does
    expect([before, typeof Symbol.observable]).toEqual(['undefined', 'symbol']);
    expect(Symbol.observable).toBe(Symbol.for('https://github.com/benlesh/symbol-observable'));
    expect(new lib.CanceledError().constructor.name).toBe('CanceledError');
    expect(await roundTrip(lib)).toEqual([[5], ['hi']]);
  });

  test('thruway.mjs as a module: the same surface and a session', async () => {
    const url = new URL('../../dist/browser/thruway.mjs', import.meta.url).href;
    const lib = (await import(/* @vite-ignore */ url)) as Bundle;
    expect(Object.keys(lib).sort()).toEqual(ROOT_EXPORTS);
    expect(lib.isWampError(new lib.WampError('a.b'))).toBe(true);
    expect(await roundTrip(lib)).toEqual([[5], ['hi']]);
  });
});
