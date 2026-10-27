'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS consumer: require() is what is tested */
/* global require, queueMicrotask */
// Jest 29 consumer of the packed package: React Native apps run Jest 29 in CJS mode (`@react-native/jest-preset`:
// customExportConditions ['require', 'react-native']) without transforming thruway.js. Through `require` — Jest's own
// resolver and module registry — a client of the testing kit does a handshake, a call, a registration, a topic, a
// router drop and the reconnect, and close(): first on the kit's virtual clock, then with jestApi.useFakeTimers() and
// the default clock (modern and legacy fake timers). RxJS 5.5.12's Observable.from consumes our Observables, also
// through thruway.js/rxjs (rxClient).
// (`jest` itself is a parameter of Jest's module wrapper, so the import is renamed)
const { afterEach, describe, expect, jest: jestApi, test } = require('@jest/globals');
const { Client, isThruwayError, isWampError, Yield } = require('thruway.js');
const { createTestRouter, createVirtualClock } = require('thruway.js/testing');
const { rxClient } = require('thruway.js/rxjs');
const { Observable } = require('rxjs');

/**
 * @template T
 * @param {import('thruway.js').Observable<T>} observable
 * @returns {Promise<T>}
 */
function first(observable) {
  return new Promise((resolve, reject) => {
    const sub = observable.subscribe({
      next: (value) => {
        resolve(value);
        queueMicrotask(() => {
          sub.unsubscribe();
        });
      },
      error: reject,
    });
  });
}

/**
 * The scenario, driven by `advance(ms)` (virtual or fake time).
 * @param {(ms: number) => Promise<void>} advance
 * @param {import('thruway.js/testing').VirtualClock | undefined} clock
 */
async function scenario(advance, clock) {
  const router = createTestRouter(clock === undefined ? {} : { clock });
  router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
  const client = new Client(router.url, 'realm1', {
    WebSocket: router.WebSocket,
    ...(clock === undefined ? {} : { clock }),
    retryOptions: { initialRetryDelay: 500, maxRetryDelay: 1000 },
  });
  try {
    /** @type {string[]} */
    const states = [];
    /** @type {string[]} */
    const closes = [];
    let registered = 0;
    /** @type {unknown[]} */
    const events = [];
    client.status.subscribe((s) => states.push(s.state));
    client.onClose.subscribe((c) => closes.push(`${String(c.error?.name)} ${String(c.willRetry)}`));
    /** @type {string[]} */
    const ended = [];
    client
      .register('com.jest.echo', (inv) => new Yield(inv.args, { by: 'jest' }))
      .subscribe({
        next: () => (registered += 1),
        error: (/** @type {Error} */ e) => ended.push(e.name),
      });
    client.topic('com.jest.topic').subscribe({
      next: (e) => events.push(e.args[0]),
      error: (/** @type {Error} */ e) => ended.push(e.name),
    });

    const added = first(client.call('com.example.add', [2, 3]));
    await advance(50);
    expect((await added).args).toEqual([5]);
    const echoed = first(client.call('com.jest.echo', ['hi']));
    const published = first(client.publish('com.jest.topic', ['event'], {}, { acknowledge: true, exclude_me: false }));
    await advance(50);
    expect([(await echoed).args, (await echoed).kwargs]).toEqual([['hi'], { by: 'jest' }]);
    await published;
    expect(events).toEqual(['event']);

    const missing = client.call('com.jest.missing');
    /** @type {unknown} */
    let error;
    missing.subscribe({
      error: (e) => {
        error = e;
      },
    });
    await advance(50);
    expect(isWampError(error) ? error.uri : error).toBe('wamp.error.no_such_procedure');

    router.drop();
    await advance(5000);
    expect(closes).toEqual(['ConnectionLostError true']);
    expect(states.filter((s) => s === 'open').length).toBe(2);
    expect(registered).toBe(2); // re-registered in the new session
    const again = first(client.call('com.example.add', [20, 22]));
    await advance(50);
    expect((await again).args).toEqual([42]);

    const closed = client.close();
    await advance(3000);
    await closed;
    expect(states[states.length - 1]).toBe('closed');
    expect(ended).toEqual(['ConnectionClosedError', 'ConnectionClosedError']); // close() ends the interests
    expect(isThruwayError(new Error('plain'))).toBe(false);
  } finally {
    // a failed expectation must not leave a reconnecting client behind (it would keep Jest from exiting)
    void client.close();
  }
}

afterEach(() => {
  jestApi.useRealTimers();
});

describe('thruway.js under Jest 29 (CJS, require conditions)', () => {
  test('the testing kit with its virtual clock: handshake, call, register, topic, drop and reconnect, close', async () => {
    const clock = createVirtualClock({ seed: 3 });
    await scenario((ms) => clock.advance(ms), clock);
    expect(clock.pendingTimers).toBe(0);
  });

  test('jest.useFakeTimers() (modern) and the default clock', async () => {
    jestApi.useFakeTimers();
    await scenario((ms) => jestApi.advanceTimersByTimeAsync(ms), undefined);
    expect(jestApi.getTimerCount()).toBe(0);
  });

  test('legacy fake timers and the default clock', async () => {
    jestApi.useFakeTimers({ legacyFakeTimers: true });
    await scenario(async (ms) => {
      for (let t = 0; t < ms; t += 10) {
        jestApi.advanceTimersByTime(10);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
    }, undefined);
    expect(jestApi.getTimerCount()).toBe(0);
  });

  test('RxJS 5.5 Observable.from consumes our Observables (Symbol.observable interop)', async () => {
    const clock = createVirtualClock({ seed: 4 });
    const router = createTestRouter({ clock });
    router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
    /** @type {unknown[]} */
    const values = [];
    Observable.from(client.call('com.example.add', [1, 1])).subscribe((r) => values.push(r.args));
    await clock.advance(50);
    expect(values).toEqual([[2]]);
    const closed = client.close();
    await clock.advance(3000);
    await closed;
  });
});

// Skipped while the thruway.js/rxjs entry is a stub that throws "not implemented". RxJS 5's static Observable.from is
// passed as is, unbound, as apps do.
const rxReady = (() => {
  try {
    rxClient(new Client('ws://127.0.0.1:9/', 'realm1', { autoOpen: false }), Observable.from);
    return true;
  } catch (e) {
    return !(e instanceof Error && e.message.startsWith('not implemented'));
  }
})();
(rxReady ? test : test.skip)(
  'rxClient(client, Observable.from) returns RxJS 5 Observables with patched operators',
  async () => {
    const clock = createVirtualClock({ seed: 5 });
    const router = createTestRouter({ clock });
    router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
    const wamp = rxClient(client, Observable.from);
    /** @type {unknown[]} */
    const values = [];
    wamp
      .call('com.example.add', [3, 4])
      .map((r) => Number(r.args[0]))
      .subscribe((n) => values.push(n));
    await clock.advance(50);
    expect(values).toEqual([7]);
    const closed = client.close();
    await clock.advance(3000);
    await closed;
  },
);
