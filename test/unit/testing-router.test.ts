// The testing kit's router. Part 1: every rule of the `procedure()` contract, through the public kit
// (`createTestRouter`, `createVirtualClock`) and a raw WAMP peer on its WebSocket. Part 2: the reference router's
// protocol behaviour (handshake and auth hook, GOODBYE/ABORT both ways, broker, dealer between two sessions, CANCEL
// modes, leaving mid-call, revocation, id policies, delivery modes, availability, strict mode, the violation oracle,
// views and hooks). The routers/ smoke scenarios are ported in testing-smoke.test.ts.
import { BehaviorSubject, NEVER, Observable as RxObservable, of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WampError } from '../../src/errors.js';
import { Yield } from '../../src/yield.js';
import { createTestRouter, createVirtualClock, type TestRouter, type VirtualClock } from '../../src/testing/index.js';
import { createRouter, type SimRouter, type SimRouterOptions } from '../../src/testing/router.js';
import { createSimClock, createSimRouter, drainMicrotasks } from '../../src/testing/sim.js';
import { callFrame, MSG, PEER_ROLES, WampPeer, type Frame } from '../helpers/wamp-peer.js';

const ERROR_BRAND = Symbol.for('thruway.js.error');

async function kit(): Promise<{ clock: VirtualClock; router: TestRouter; peer: WampPeer }> {
  const clock = createVirtualClock();
  const router = createTestRouter({ clock });
  const peer = new WampPeer(router.WebSocket, router.url, () => clock.advance(0));
  await peer.join();
  return { clock, router, peer };
}

/** CALL `procedure` and return the reply (a RESULT or ERROR, after settling). */
async function callOnce(
  peer: WampPeer,
  procedure: string,
  args?: unknown[],
  kwargs?: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<Frame> {
  return peer.call(procedure, args, kwargs, options);
}

/** A WampError from "another copy of the package": a different class carrying the same Symbol.for brand. */
function foreignWampError(
  uri: string,
  args: unknown[],
  kwargs: Record<string, unknown>,
  details: Record<string, unknown>,
): Error {
  const error = new Error(uri);
  Object.defineProperty(error, ERROR_BRAND, { value: 'wamp_error' });
  return Object.assign(error, { code: 'wamp_error', uri, errorUri: uri, args, kwargs, details });
}

describe('procedure(): the handler', () => {
  test('is called once per CALL with args, kwargs and the CALL options as details ([] / {} when absent)', async () => {
    const { router, peer } = await kit();
    const calls: unknown[][] = [];
    router.procedure('com.example.echo', (args, kwargs, details) => {
      calls.push([args, kwargs, details]);
      return 'ok';
    });
    await callOnce(peer, 'com.example.echo', [1, 'two'], { k: true }, { disclose_me: true, custom: 1 });
    await callOnce(peer, 'com.example.echo');
    expect(calls).toEqual([
      [[1, 'two'], { k: true }, { disclose_me: true, custom: 1 }],
      [[], {}, {}],
    ]);
  });

  test('gets copies: mutating them changes neither the recorded frames nor the next call', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.mutate', (args, kwargs, details) => {
      args.push('x');
      kwargs['x'] = 1;
      details['x'] = 1;
      return null;
    });
    await callOnce(peer, 'com.example.mutate', [1], { a: 1 });
    expect(
      router.frames.find((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === MSG.CALL)?.frame,
    ).toEqual(callFrame(1, 'com.example.mutate', [1], { a: 1 }));
  });

  test('a second procedure() for the same URI replaces the handler', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.p', () => 1);
    router.procedure('com.example.p', () => 2);
    expect((await callOnce(peer, 'com.example.p'))[3]).toEqual([2]);
  });

  test('fn must be a function', () => {
    const router = createTestRouter();
    expect(() => {
      router.procedure('com.example.p', 42 as unknown as () => unknown);
    }).toThrow(new TypeError('procedure(uri, fn): fn must be a function'));
  });
});

describe('procedure(): values and Promises ⇒ RESULT with the yieldPayload rule', () => {
  const cases: readonly [string, unknown, Frame][] = [
    ['a plain value ⇒ args [v]', 42, [MSG.RESULT, 1, {}, [42]]],
    ['an object ⇒ args [v]', { a: 1 }, [MSG.RESULT, 1, {}, [{ a: 1 }]]],
    ['null ⇒ args [null]', null, [MSG.RESULT, 1, {}, [null]]],
    ['undefined ⇒ no args', undefined, [MSG.RESULT, 1, {}]],
    ['a Yield ⇒ its args', new Yield([1, 2]), [MSG.RESULT, 1, {}, [1, 2]]],
    ['a Yield ⇒ its args and kwargs', new Yield([1], { k: 'v' }), [MSG.RESULT, 1, {}, [1], { k: 'v' }]],
    [
      'a Yield with kwargs only ⇒ [] then kwargs',
      new Yield(undefined, { k: 'v' }),
      [MSG.RESULT, 1, {}, [], { k: 'v' }],
    ],
    ['an empty Yield ⇒ no payload', new Yield(), [MSG.RESULT, 1, {}]],
  ];
  test.each(cases)('%s', async (_name, result, expected) => {
    const { router, peer } = await kit();
    router.procedure('com.example.p', () => result);
    expect(await callOnce(peer, 'com.example.p')).toEqual(expected);
  });

  test.each(cases)('a Promise of it: %s', async (_name, result, expected) => {
    const { router, peer } = await kit();
    router.procedure('com.example.p', async () => {
      await Promise.resolve();
      return result;
    });
    expect(await callOnce(peer, 'com.example.p')).toEqual(expected);
  });

  test('a Promise that settles on a timer answers when the virtual clock reaches it', async () => {
    const { clock, router, peer } = await kit();
    router.procedure(
      'com.example.slow',
      () =>
        new Promise((resolve) => {
          clock.setTimeout(() => {
            resolve('late');
          }, 5000);
        }),
    );
    const id = peer.id();
    peer.send(callFrame(id, 'com.example.slow'));
    await clock.advance(4999);
    expect(peer.take((f) => f[0] === MSG.RESULT)).toBeUndefined();
    await clock.advance(1);
    expect(peer.take((f) => f[0] === MSG.RESULT)).toEqual([MSG.RESULT, id, {}, ['late']]);
  });

  test('a Yield whose args is not an array or whose kwargs is not a dict ⇒ runtime_error "invalid result payload"', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.badargs', () => new Yield({ 0: 'x' } as unknown as unknown[]));
    router.procedure('com.example.badkwargs', () => new Yield([], [] as unknown as Record<string, unknown>));
    for (const p of ['com.example.badargs', 'com.example.badkwargs']) {
      expect((await callOnce(peer, p)).slice(4)).toEqual(['wamp.error.runtime_error', ['invalid result payload']]);
    }
  });

  test('a result that cannot be serialized ⇒ runtime_error "result could not be serialized"', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.bigint', () => 10n);
    expect((await callOnce(peer, 'com.example.bigint')).slice(3)).toEqual([
      {},
      'wamp.error.runtime_error',
      ['result could not be serialized'],
    ]);
  });
});

describe('procedure(): Observables', () => {
  test('receive_progress ⇒ each value is a progress RESULT, completion sends the empty final RESULT', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.feed', () => of(1, new Yield(['two'], { n: 2 }), undefined));
    const id = peer.id();
    peer.send(callFrame(id, 'com.example.feed', undefined, undefined, { receive_progress: true }));
    await peer.reply(MSG.CALL, id, MSG.RESULT).catch(() => undefined);
    expect(peer.received.filter((f) => f[0] === MSG.RESULT)).toEqual([
      [MSG.RESULT, id, { progress: true }, [1]],
      [MSG.RESULT, id, { progress: true }, ['two'], { n: 2 }],
      [MSG.RESULT, id, { progress: true }],
      [MSG.RESULT, id, {}],
    ]);
  });

  test('without receive_progress only the last value is sent, as the final RESULT (none: no args)', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.last', () => of(1, 2, new Yield([3], { k: 3 })));
    router.procedure('com.example.empty', () => of());
    expect(await callOnce(peer, 'com.example.last')).toEqual([MSG.RESULT, 1, {}, [3], { k: 3 }]);
    expect(await callOnce(peer, 'com.example.empty')).toEqual([MSG.RESULT, 2, {}]);
  });

  test('values that arrive over time are forwarded as they come; any interop Observable works', async () => {
    const { clock, router, peer } = await kit();
    const subject = new Subject<number>();
    router.procedure('com.example.live', () => subject);
    const interop = {
      [Symbol.observable]: () => ({
        subscribe: (o: { next(v: number): void; complete(): void }) => {
          o.next(7);
          o.complete();
          return { unsubscribe: () => undefined };
        },
      }),
    };
    router.procedure('com.example.interop', () => interop);
    const id = peer.id();
    peer.send(callFrame(id, 'com.example.live', undefined, undefined, { receive_progress: true }));
    await clock.runUntilIdle();
    subject.next(1);
    await clock.runUntilIdle();
    expect(peer.take((f) => f[0] === MSG.RESULT)).toEqual([MSG.RESULT, id, { progress: true }, [1]]);
    subject.next(2);
    subject.complete();
    await clock.runUntilIdle();
    expect(peer.pending).toEqual([
      [MSG.RESULT, id, { progress: true }, [2]],
      [MSG.RESULT, id, {}],
    ]);
    peer.take(() => true);
    peer.take(() => true);
    expect(await callOnce(peer, 'com.example.interop')).toEqual([MSG.RESULT, 2, {}, [7]]);
  });

  test('an invalid progress value ⇒ runtime_error and the Observable is unsubscribed', async () => {
    const { router, peer } = await kit();
    const teardown = vi.fn();
    router.procedure(
      'com.example.p',
      () =>
        new RxObservable((s) => {
          s.next(new Yield('nope' as unknown as unknown[]));
          return teardown;
        }),
    );
    const reply = await peer.call('com.example.p', undefined, undefined, { receive_progress: true });
    expect(reply.slice(4)).toEqual(['wamp.error.runtime_error', ['invalid result payload']]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test('emissions queued behind an invalid one are ignored once the call is settled', async () => {
    const { router, peer } = await kit();
    const bad = new Yield('nope' as unknown as unknown[]);
    router.procedure(
      'com.example.then-next',
      () =>
        new RxObservable((s) => {
          s.next(bad);
          s.next(2);
        }),
    );
    router.procedure(
      'com.example.then-complete',
      () =>
        new RxObservable((s) => {
          s.next(bad);
          s.complete();
        }),
    );
    router.procedure(
      'com.example.then-error',
      () =>
        new RxObservable((s) => {
          s.next(bad);
          s.error(new Error('after'));
        }),
    );
    for (const uri of ['com.example.then-next', 'com.example.then-complete', 'com.example.then-error']) {
      const reply = await peer.call(uri, undefined, undefined, { receive_progress: true });
      expect(reply.slice(4)).toEqual(['wamp.error.runtime_error', ['invalid result payload']]);
    }
    expect(peer.pending).toEqual([]);
  });

  test('a progress value that cannot be serialized ⇒ runtime_error and the Observable is unsubscribed', async () => {
    const { router, peer } = await kit();
    const teardown = vi.fn();
    router.procedure(
      'com.example.p',
      () =>
        new RxObservable((s) => {
          s.next(1n);
          return teardown;
        }),
    );
    const reply = await peer.call('com.example.p', undefined, undefined, { receive_progress: true });
    expect(reply.slice(4)).toEqual(['wamp.error.runtime_error', ['result could not be serialized']]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe('procedure(): errors', () => {
  const ours = new WampError('com.example.error.denied', ['nope', 1], { why: 'because' }, { extra: true });
  const theirs = foreignWampError('com.example.error.foreign', ['x'], { y: 2 }, { d: 1 });
  const expectedOurs = [{ extra: true }, 'com.example.error.denied', ['nope', 1], { why: 'because' }];
  const expectedTheirs = [{ d: 1 }, 'com.example.error.foreign', ['x'], { y: 2 }];
  const ways: readonly [string, (e: Error) => unknown][] = [
    [
      'thrown',
      (e) => {
        throw e;
      },
    ],
    ['rejected', (e) => Promise.reject(e)],
    ['errored by an Observable', (e) => throwError(() => e)],
    [
      'errored after a value',
      (e) =>
        new RxObservable((s) => {
          s.next(1);
          s.error(e);
        }),
    ],
  ];
  for (const [how, raise] of ways) {
    test(`a WampError ${how} ⇒ ERROR with its uri/args/kwargs/details`, async () => {
      const { router, peer } = await kit();
      router.procedure('com.example.p', () => raise(ours));
      expect((await callOnce(peer, 'com.example.p')).slice(0, 3)).toEqual([MSG.ERROR, MSG.CALL, 1]);
      expect((await callOnce(peer, 'com.example.p')).slice(3)).toEqual(expectedOurs);
    });

    test(`a WampError of another package copy ${how} ⇒ the same (brand check)`, async () => {
      const { router, peer } = await kit();
      router.procedure('com.example.p', () => raise(theirs));
      expect((await callOnce(peer, 'com.example.p')).slice(3)).toEqual(expectedTheirs);
    });

    test(`any other error ${how} ⇒ runtime_error [message]`, async () => {
      const { router, peer } = await kit();
      router.procedure('com.example.p', () => raise(new TypeError('bad input')));
      expect((await callOnce(peer, 'com.example.p')).slice(3)).toEqual([{}, 'wamp.error.runtime_error', ['bad input']]);
    });
  }

  test.each([
    ['a string', 'plain text', 'plain text'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an object without message', { code: 5 }, '[object Object]'],
    ['an object with a numeric message', { message: 404 }, '404'],
    [
      'a value whose message getter throws',
      Object.defineProperty({}, 'message', {
        get: () => {
          throw new Error('getter');
        },
      }),
      'unknown error',
    ],
  ])('a thrown %s ⇒ runtime_error [String(e?.message ?? e)]', async (_name, thrown, text) => {
    const { router, peer } = await kit();
    router.procedure('com.example.p', () => {
      throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error -- the point: handlers may throw anything
    });
    expect((await callOnce(peer, 'com.example.p')).slice(4)).toEqual(['wamp.error.runtime_error', [text]]);
  });

  test('a WampError without kwargs/args/details sends only what it has; an invalid URI or payload is replaced', async () => {
    const { router, peer } = await kit();
    router.procedure('com.example.bare', () => Promise.reject(new WampError('com.example.error.bare')));
    router.procedure('com.example.baduri', () => Promise.reject(new WampError('not a valid uri')));
    router.procedure('com.example.badpayload', () =>
      Promise.reject(new WampError('com.example.e', 'x' as unknown as unknown[])),
    );
    router.procedure('com.example.baddetails', () =>
      Promise.reject(Object.assign(foreignWampError('com.example.e', [], {}, {}), { details: 'x' })),
    );
    expect((await callOnce(peer, 'com.example.bare')).slice(3)).toEqual([{}, 'com.example.error.bare']);
    expect((await callOnce(peer, 'com.example.baduri')).slice(3)).toEqual([
      {},
      'wamp.error.runtime_error',
      ['not a valid uri'],
    ]);
    expect((await callOnce(peer, 'com.example.badpayload')).slice(3)).toEqual([
      {},
      'wamp.error.runtime_error',
      ['invalid result payload'],
    ]);
    expect((await callOnce(peer, 'com.example.baddetails')).slice(3)).toEqual([{}, 'com.example.e']);
  });
});

describe('procedure(): unscripted URIs', () => {
  test.each(['com.example.nobody', 'thruway.js.ping'])('%s ⇒ ERROR wamp.error.no_such_procedure', async (uri) => {
    const { peer } = await kit();
    expect(await callOnce(peer, uri)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.no_such_procedure']);
  });

  test('in strict mode (the sim router) an unscripted CALL is recorded — the liveness probe is not', async () => {
    const clock = createSimClock();
    const router = createSimRouter({ clock });
    const peer = new WampPeer(router.WebSocket, router.url, () => clock.advance(0));
    await peer.join();
    await callOnce(peer, 'thruway.js.ping');
    await callOnce(peer, 'com.example.nobody');
    expect(router.unscripted.map((f) => f.frame)).toEqual([callFrame(2, 'com.example.nobody')]);
  });
});

describe('procedure(): a result that never settles keeps the call in flight', () => {
  /** A handler that never settles, recording its teardown. */
  function never(router: TestRouter, kind: 'promise' | 'observable'): { teardowns: number } {
    const state = { teardowns: 0 };
    router.procedure('com.example.never', () =>
      kind === 'promise'
        ? new Promise(() => undefined)
        : new RxObservable(() => () => {
            state.teardowns++;
          }),
    );
    return state;
  }

  test.each(['promise', 'observable'] as const)('%s: nothing arrives, however long the clock runs', async (kind) => {
    const { clock, router, peer } = await kit();
    never(router, kind);
    peer.send(callFrame(peer.id(), 'com.example.never'));
    await clock.advance(10 * 60 * 1000);
    expect(peer.pending).toEqual([]);
  });

  test.each(['promise', 'observable'] as const)(
    '%s + timeout (the app’s Rx timeout() ⇒ CANCEL): ERROR canceled, handler unsubscribed',
    async (kind) => {
      const { clock, router, peer } = await kit();
      const state = never(router, kind);
      const id = peer.id();
      peer.send(callFrame(id, 'com.example.never'));
      await clock.advance(5000);
      peer.send([MSG.CANCEL, id, { mode: 'killnowait' }]);
      expect(await peer.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
      expect(state.teardowns).toBe(kind === 'observable' ? 1 : 0);
    },
  );

  test.each(['promise', 'observable'] as const)(
    '%s + router.drop(): the socket closes 1006, the handler is unsubscribed',
    async (kind) => {
      const { clock, router, peer } = await kit();
      const state = never(router, kind);
      peer.send(callFrame(peer.id(), 'com.example.never'));
      await clock.runUntilIdle();
      router.drop();
      await clock.runUntilIdle();
      expect(peer.closed).toEqual({ code: 1006, reason: '', wasClean: false });
      expect(state.teardowns).toBe(kind === 'observable' ? 1 : 0);
    },
  );

  test.each(['promise', 'observable'] as const)(
    '%s + the client closes (GOODBYE): GOODBYE reply, no RESULT, handler unsubscribed',
    async (kind) => {
      const { clock, router, peer } = await kit();
      const state = never(router, kind);
      peer.send(callFrame(peer.id(), 'com.example.never'));
      await clock.runUntilIdle();
      expect(await peer.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
      await clock.runUntilIdle();
      expect(peer.closed).toEqual({ code: 1000, reason: '', wasClean: true });
      expect(peer.received.map((f) => f[0])).toEqual([MSG.WELCOME, MSG.GOODBYE]);
      expect(state.teardowns).toBe(kind === 'observable' ? 1 : 0);
    },
  );
});

describe('procedure(): CANCEL', () => {
  test.each([['killnowait'], ['kill'], ['skip'], [undefined]])(
    'mode %s: the handler’s Observable is unsubscribed, ERROR canceled answers',
    async (mode) => {
      const { router, peer } = await kit();
      const teardown = vi.fn();
      router.procedure('com.example.p', () => new RxObservable(() => teardown));
      const id = peer.id();
      peer.send(callFrame(id, 'com.example.p'));
      peer.send([MSG.CANCEL, id, mode === undefined ? {} : { mode }]);
      expect(await peer.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
      expect(teardown).toHaveBeenCalledTimes(1);
    },
  );

  test('a later settlement of the cancelled handler is ignored (Promise and Observable)', async () => {
    const { clock, router, peer } = await kit();
    const subject = new BehaviorSubject<number>(0);
    let resolve: (v: unknown) => void = () => undefined;
    router.procedure('com.example.promise', () => new Promise((r) => (resolve = r)));
    router.procedure('com.example.subject', () => subject);
    const a = peer.id();
    const b = peer.id();
    peer.send(callFrame(a, 'com.example.promise'));
    peer.send(callFrame(b, 'com.example.subject', undefined, undefined, { receive_progress: true }));
    await clock.runUntilIdle();
    peer.take((f) => f[0] === MSG.RESULT); // the BehaviorSubject's current value, as a progress result
    peer.send([MSG.CANCEL, a, { mode: 'killnowait' }]);
    peer.send([MSG.CANCEL, b, { mode: 'killnowait' }]);
    await clock.runUntilIdle();
    resolve('too late');
    subject.next(1);
    subject.complete();
    await clock.runUntilIdle();
    expect(peer.pending).toEqual([
      [MSG.ERROR, MSG.CALL, a, {}, 'wamp.error.canceled'],
      [MSG.ERROR, MSG.CALL, b, {}, 'wamp.error.canceled'],
    ]);
  });

  test('a CANCEL for a call that already finished (or never existed) is ignored', async () => {
    const { clock, router, peer } = await kit();
    router.procedure('com.example.p', () => 1);
    await callOnce(peer, 'com.example.p');
    peer.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    peer.send([MSG.CANCEL, 999, { mode: 'killnowait' }]);
    await clock.runUntilIdle();
    expect(peer.pending).toEqual([]);
  });

  test('an unknown cancel mode ⇒ ERROR(49) invalid_argument, the call keeps running', async () => {
    const { clock, router, peer } = await kit();
    let resolve: (v: unknown) => void = () => undefined;
    router.procedure('com.example.p', () => new Promise((r) => (resolve = r)));
    const id = peer.id();
    peer.send(callFrame(id, 'com.example.p'));
    peer.send([MSG.CANCEL, id, { mode: 'abort' }]);
    expect(await peer.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CANCEL, id, {}, 'wamp.error.invalid_argument']);
    resolve('done');
    await clock.runUntilIdle();
    expect(peer.take(() => true)).toEqual([MSG.RESULT, id, {}, ['done']]);
  });
});

describe('the public facade createTestRouter', () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const fn of restore.splice(0)) fn();
  });

  test('exactly the TestRouter members, frozen; url memory://router/<n>', () => {
    const a = createTestRouter();
    const b = createTestRouter();
    expect(Object.keys(a).sort()).toEqual([
      'WebSocket',
      'abort',
      'close',
      'drop',
      'frames',
      'goodbye',
      'procedure',
      'publish',
      'url',
    ]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.url).toMatch(/^memory:\/\/router\/\d+$/);
    expect(a.url).not.toBe(b.url);
    expect(a.WebSocket.OPEN).toBe(1);
  });

  test('without a clock frames travel on microtasks; frames records both directions with `at`', async () => {
    const router = createTestRouter();
    const peer = new WampPeer(router.WebSocket, router.url, () => drainMicrotasks());
    await peer.join();
    router.publish('com.example.t'); // nobody subscribed: nothing to deliver
    expect(router.frames.map((f) => [f.connection, f.direction, (f.frame as Frame)[0]])).toEqual([
      [1, 'in', MSG.HELLO],
      [1, 'out', MSG.WELCOME],
    ]);
    expect(router.frames.every((f) => typeof f.at === 'number' && f.at >= 0)).toBe(true);
  });

  test('drop, goodbye, abort, close and publish reach the router', async () => {
    const clock = createVirtualClock();
    const router = createTestRouter({ clock });
    const settle = (): Promise<void> => clock.runUntilIdle();
    const sub = new WampPeer(router.WebSocket, router.url, settle);
    await sub.join();
    const subscription = await sub.subscribe('com.example.t');
    router.publish('com.example.t', [1], { a: 1 });
    expect(await sub.nextOf(MSG.EVENT)).toEqual([MSG.EVENT, subscription, expect.any(Number), {}, [1], { a: 1 }]);
    router.goodbye('wamp.close.killed', { message: 'admin' });
    expect(await sub.nextOf(MSG.GOODBYE)).toEqual([MSG.GOODBYE, { message: 'admin' }, 'wamp.close.killed']);
    const b = new WampPeer(router.WebSocket, router.url, settle);
    await b.join();
    router.abort('com.example.abort', { message: 'bye' });
    expect(await b.nextOf(MSG.ABORT)).toEqual([MSG.ABORT, { message: 'bye' }, 'com.example.abort']);
    const c = new WampPeer(router.WebSocket, router.url, settle);
    await c.join();
    router.drop(4000);
    await settle();
    expect(c.closed).toEqual({ code: 4000, reason: '', wasClean: true });
    router.close();
    const d = new WampPeer(router.WebSocket, router.url, settle);
    await settle();
    expect(d.events).toEqual(['error', 'close:1006']);
  });

  test('an authenticate hook that throws ABORTs the handshake and surfaces as an unhandled rejection', async () => {
    const reasons: unknown[] = [];
    const previous = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const listener = (reason: unknown): void => {
      reasons.push(reason);
    };
    process.on('unhandledRejection', listener);
    restore.push(() => {
      process.off('unhandledRejection', listener);
      for (const l of previous) process.on('unhandledRejection', l);
    });
    const clock = createVirtualClock();
    for (const thrown of [new Error('hook bug'), 'not an Error']) {
      const router = createTestRouter({
        clock,
        authenticate: () => {
          throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error -- also a non-Error on purpose
        },
      });
      const peer = new WampPeer(router.WebSocket, router.url, () => clock.advance(0));
      expect(await peer.join()).toEqual([
        MSG.ABORT,
        { message: 'the authenticate hook threw' },
        'wamp.error.authorization_failed',
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reasons.map(String)).toEqual(['Error: hook bug', 'Error: a non-Error was thrown']);
    expect((reasons[1] as { cause: unknown }).cause).toBe('not an Error');
  });
});

// =====================================================================================================================
// Part 2: the reference router
// =====================================================================================================================

interface Setup {
  readonly clock: ReturnType<typeof createSimClock>;
  readonly router: SimRouter;
  peer(url?: string): WampPeer;
  join(details?: Record<string, unknown>): Promise<WampPeer>;
}

function setup(options: Omit<SimRouterOptions, 'clock'> = {}): Setup {
  const clock = createSimClock();
  const router = createRouter({ clock, ...options });
  const settle = async (): Promise<void> => {
    for (;;) {
      await clock.runUntilIdle();
      if (router.flush() === 0) return;
    }
  };
  const peer = (url = router.url): WampPeer => new WampPeer(router.WebSocket, url, settle);
  return {
    clock,
    router,
    peer,
    join: async (details = {}) => {
      const p = peer();
      const welcome = await p.join('realm1', details);
      if (welcome[0] !== MSG.WELCOME) throw new Error(`join failed: ${JSON.stringify(welcome)}`);
      return p;
    },
  };
}

describe('handshake', () => {
  test('default: anonymous WELCOME with auth details and the router roles; realms are auto-created', async () => {
    const s = setup();
    const peer = s.peer();
    const welcome = await peer.join('any.realm.name');
    expect(welcome).toEqual([
      MSG.WELCOME,
      expect.any(Number),
      {
        authid: `anonymous-${String(welcome[1])}`,
        authrole: 'anonymous',
        authmethod: 'anonymous',
        authprovider: 'static',
        roles: {
          broker: {
            features: expect.objectContaining({
              pattern_based_subscription: true,
              subscription_revocation: true,
            }) as unknown,
          },
          dealer: {
            features: expect.objectContaining({
              progressive_call_results: true,
              call_canceling: true,
              shared_registration: true,
            }) as unknown,
          },
        },
      },
    ]);
    expect(s.router.sessions).toEqual([
      expect.objectContaining({ id: welcome[1], realm: 'any.realm.name', connection: 1, alive: true }),
    ]);
    expect(s.router.connections[0]!.phase).toBe('established');
    expect(s.router.sessions[0]!.hello).toEqual(expect.objectContaining({ agent: 'wamp-peer', roles: PEER_ROLES }));
    const roles = (welcome[2] as { roles: unknown }).roles;
    expect(roles).toEqual({
      broker: {
        features: {
          publisher_identification: true,
          publisher_exclusion: true,
          subscriber_blackwhite_listing: true,
          pattern_based_subscription: true,
          subscription_revocation: true,
        },
      },
      dealer: {
        features: {
          progressive_call_results: true,
          call_canceling: true,
          caller_identification: true,
          pattern_based_registration: true,
          shared_registration: true,
          registration_revocation: true,
        },
      },
    });
    const sent = s.router.sessions[0]!.welcome['roles'] as { broker: { features: object } };
    expect([Object.isFrozen(sent), Object.isFrozen(sent.broker), Object.isFrozen(sent.broker.features)]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test('authenticate: welcome details replace the anonymous ones (roles kept unless given)', async () => {
    const hellos: unknown[] = [];
    const s = setup({
      authenticate: (hello) => {
        hellos.push(hello);
        return { welcome: { authid: 'joe', authrole: 'user', custom: 1 } };
      },
    });
    const peer = s.peer();
    const welcome = await peer.join('realm1', { authmethods: ['ticket'], authid: 'joe' });
    expect(welcome[2]).toEqual({ roles: expect.any(Object) as unknown, authid: 'joe', authrole: 'user', custom: 1 });
    expect(hellos).toEqual([
      { realm: 'realm1', details: expect.objectContaining({ authmethods: ['ticket'], authid: 'joe' }) as unknown },
    ]);
  });

  test('a challenge round, then multi-round (verify answers another CHALLENGE), then WELCOME', async () => {
    const signatures: string[] = [];
    const s = setup({
      authenticate: () => ({
        challenge: { method: 'ticket' },
        verify: (sig) => {
          signatures.push(sig);
          return {
            challenge: { method: 'otp', extra: { digits: 6 } },
            verify: (otp) => {
              signatures.push(otp);
              return otp === '123456'
                ? { welcome: { authid: 'joe', authmethod: 'ticket' } }
                : { abort: 'wamp.error.not_authorized' };
            },
          };
        },
      }),
    });
    const peer = s.peer();
    const challenges: string[] = [];
    const welcome = await peer.join('realm1', { authmethods: ['ticket'] }, (method, extra) => {
      challenges.push(`${method} ${JSON.stringify(extra)}`);
      return method === 'ticket' ? 'secret' : '123456';
    });
    expect(welcome[0]).toBe(MSG.WELCOME);
    expect(challenges).toEqual(['ticket {}', 'otp {"digits":6}']);
    expect(signatures).toEqual(['secret', '123456']);
  });

  test('an abort decision ⇒ ABORT with its reason/details, the router closes the socket; no session', async () => {
    const s = setup({ authenticate: () => ({ abort: 'wamp.error.no_such_realm', details: { message: 'gone' } }) });
    const peer = s.peer();
    expect(await peer.join()).toEqual([MSG.ABORT, { message: 'gone' }, 'wamp.error.no_such_realm']);
    await s.clock.runUntilIdle();
    expect(peer.closed).toEqual({ code: 1000, reason: '', wasClean: true });
    expect(s.router.sessions).toEqual([]);
    expect(s.router.connections[0]!.phase).toBe('closed');
  });

  test('an abort decision without details sends {}', async () => {
    const s = setup({ authenticate: () => ({ abort: 'wamp.error.not_authorized' }) });
    expect(await s.peer().join()).toEqual([MSG.ABORT, {}, 'wamp.error.not_authorized']);
  });

  test.each([
    [
      'throws',
      () => {
        throw new Error('hook bug');
      },
      'the authenticate hook threw',
      'hook bug',
    ],
    [
      'returns nonsense',
      () => ({ nothing: true }),
      'invalid authenticate decision',
      'authenticate returned no welcome',
    ],
    [
      'returns a challenge without verify',
      () => ({ challenge: { method: 'ticket' } }),
      'invalid authenticate decision',
      'authenticate returned no welcome',
    ],
    [
      'returns a challenge whose method is not a string',
      () => ({ challenge: { method: 7 }, verify: () => ({ welcome: {} }) }),
      'invalid authenticate decision',
      'authenticate',
    ],
    [
      'returns a challenge with a bad extra',
      () => ({ challenge: { method: 'x', extra: 5 }, verify: () => ({ welcome: {} }) }),
      'invalid authenticate decision',
      'authenticate',
    ],
    [
      'returns an abort with bad details',
      () => ({ abort: 'x', details: 'y' }),
      'invalid authenticate decision',
      'authenticate',
    ],
  ])('a hook that %s ⇒ ABORT authorization_failed and an entry in errors', async (_name, hook, message, errorText) => {
    const onError = vi.fn();
    const s = setup({ authenticate: hook as never, onError });
    expect(await s.peer().join()).toEqual([MSG.ABORT, { message }, 'wamp.error.authorization_failed']);
    expect(String(s.router.errors[0])).toContain(errorText);
    expect(onError).toHaveBeenCalledWith(s.router.errors[0]);
  });

  test('a verify that throws ABORTs the second step the same way', async () => {
    const s = setup({
      authenticate: () => ({
        challenge: { method: 'ticket' },
        verify: () => {
          throw new Error('verify bug');
        },
      }),
    });
    expect(await s.peer().join('realm1', {}, () => 'x')).toEqual([
      MSG.ABORT,
      { message: 'the authenticate hook threw' },
      'wamp.error.authorization_failed',
    ]);
    expect(s.router.errors.map(String)).toEqual(['Error: verify bug']);
  });

  test('ABORT from the client while challenged ends the attempt; the router closes the socket', async () => {
    const s = setup({ authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) });
    const peer = s.peer();
    await s.clock.runUntilIdle();
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await peer.nextOf(MSG.CHALLENGE);
    peer.send([MSG.ABORT, { message: 'no' }, 'wamp.error.cannot_authenticate']);
    await s.clock.runUntilIdle();
    expect(peer.closed?.code).toBe(1000);
    expect(s.router.violations).toEqual([]);
  });

  test('a malformed HELLO is a violation and is ABORTed with protocol_violation', async () => {
    const s = setup();
    const peer = s.peer();
    await s.clock.runUntilIdle();
    peer.send([MSG.HELLO, 42, {}]);
    expect(await peer.nextOf(MSG.ABORT)).toEqual([
      MSG.ABORT,
      { message: 'malformed HELLO' },
      'wamp.error.protocol_violation',
    ]);
    expect(s.router.violations.map((v) => v.rule)).toEqual(['malformed HELLO']);
  });

  test.each([[{}], [{ roles: {} }], [{ roles: 'caller' }]])(
    'a HELLO with details %j (no roles) is a violation; the session is still welcomed',
    async (details) => {
      const s = setup();
      const peer = s.peer();
      await s.clock.runUntilIdle();
      peer.send([MSG.HELLO, 'realm1', details]);
      expect((await peer.nextOf(MSG.WELCOME))[0]).toBe(MSG.WELCOME);
      peer.send([]);
      await s.clock.runUntilIdle();
      expect(s.router.violations.map((v) => v.rule)).toEqual([
        'HELLO without roles',
        'the message type is not an integer',
      ]);
    },
  );
});

describe('GOODBYE and ABORT', () => {
  test('client GOODBYE ⇒ reply goodbye_and_out, the router closes the socket, the session is gone', async () => {
    const s = setup();
    const peer = await s.join();
    expect(await peer.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
    await s.clock.runUntilIdle();
    expect(peer.closed).toEqual({ code: 1000, reason: '', wasClean: true });
    expect([s.router.sessions, s.router.connections[0]!.phase, s.router.connections[0]!.state]).toEqual([
      [],
      'closed',
      'closed',
    ]);
  });

  test('router goodbye(): established sessions only; the reply makes the router close; routing stops at once', async () => {
    const s = setup({
      authenticate: (h) =>
        h.realm === 'auth' ? { challenge: { method: 'x' }, verify: () => ({ welcome: {} }) } : { welcome: {} },
    });
    const a = await s.join();
    const pending = s.peer();
    await s.clock.runUntilIdle();
    pending.send([MSG.HELLO, 'auth', { roles: PEER_ROLES }]);
    await pending.nextOf(MSG.CHALLENGE);
    s.router.goodbye();
    expect(await a.nextOf(MSG.GOODBYE)).toEqual([MSG.GOODBYE, {}, 'wamp.close.system_shutdown']);
    expect(s.router.sessions).toEqual([]);
    expect(s.router.connections[0]!.phase).toBe('goodbye');
    a.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
    await s.clock.runUntilIdle();
    expect(a.closed?.code).toBe(1000);
    expect(pending.pending).toEqual([]);
    expect(s.router.violations).toEqual([]);
  });

  test('after the router GOODBYE anything but the reply is a violation; closing without a reply is fine', async () => {
    const s = setup();
    const a = await s.join();
    const b = await s.join();
    s.router.goodbye('wamp.close.killed');
    await s.clock.runUntilIdle();
    a.send(callFrame(9, 'com.example.p'));
    b.ws.close(1000);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      "CALL after the router's GOODBYE (only the GOODBYE reply may follow)",
    ]);
    expect(s.router.connections[1]!.phase).toBe('closed');
  });

  test('ABORT from the router to every open connection (handshaking ones too), then the socket is closed', async () => {
    const s = setup();
    const a = await s.join();
    const b = s.peer();
    await s.clock.runUntilIdle(); // open, no HELLO yet
    s.router.abort('wamp.error.system_shutdown', { message: 'maintenance' });
    await s.clock.runUntilIdle();
    for (const p of [a, b]) {
      expect(p.received.at(-1)).toEqual([MSG.ABORT, { message: 'maintenance' }, 'wamp.error.system_shutdown']);
      expect(p.closed?.code).toBe(1000);
    }
    s.router.abort(); // nothing open: nothing happens
    expect(s.router.errors).toEqual([]);
  });

  test('ABORT from the client in a session ends it: the router closes the socket', async () => {
    const s = setup();
    const a = await s.join();
    a.send([MSG.ABORT, { message: 'bug' }, 'wamp.error.protocol_violation']);
    await s.clock.runUntilIdle();
    expect([s.router.sessions, a.closed?.code, s.router.connections[0]!.phase]).toEqual([[], 1000, 'closed']);
  });

  test('anything after the client’s ABORT is a violation, even if the router never sees it', async () => {
    const s = setup();
    const a = await s.join();
    a.send([MSG.ABORT, { message: 'bug' }, 'wamp.error.protocol_violation']);
    a.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual(["GOODBYE after the client's ABORT"]);
  });

  test('after its GOODBYE reply the client may send nothing more', async () => {
    const s = setup();
    const a = await s.join();
    a.onFrame = (f) => {
      if (f[0] === MSG.GOODBYE) {
        a.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
        a.send(callFrame(5, 'com.example.p'));
      }
      return false;
    };
    s.router.goodbye();
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual(["CALL after the client's GOODBYE"]);
  });

  test('while the router waits for the GOODBYE reply other frames do not end the wait', async () => {
    const s = setup();
    const a = await s.join();
    s.router.goodbye();
    await s.clock.runUntilIdle();
    a.send(callFrame(5, 'com.example.p')); // a violation, but not the reply
    await s.clock.runUntilIdle();
    expect([a.closed, s.router.connections[0]!.phase]).toEqual([undefined, 'goodbye']);
    a.send([MSG.ABORT, {}, 'wamp.error.protocol_violation']); // an ABORT ends it as well
    await s.clock.runUntilIdle();
    expect(a.closed?.code).toBe(1000);
  });

  test('router abort() leaves connections that were never answered alone', async () => {
    const s = setup();
    s.router.setAvailable('hang');
    const hanging = s.peer();
    s.router.abort();
    await s.clock.runUntilIdle();
    expect([hanging.events, hanging.ws.readyState]).toEqual([[], 0]);
  });
});

describe('broker', () => {
  test('SUBSCRIBE → SUBSCRIBED; a repeated SUBSCRIBE of the same topic+match in a session gets the same id', async () => {
    const s = setup();
    const p = await s.join();
    const a = await p.subscribe('com.example.t');
    const b = await p.subscribe('com.example.t', { match: 'exact' });
    const c = await p.subscribe('com.example', { match: 'prefix' });
    const d = await p.subscribe('com.example.u');
    const e = await p.subscribe('com.example.t', { match: 'prefix' });
    expect(a).toBe(b);
    expect(new Set([a, c, d, e]).size).toBe(4); // another match or another topic: another subscription
    expect(s.router.sessions[0]!.subscriptions).toEqual([
      { id: a, topic: 'com.example.t', match: 'exact' },
      { id: c, topic: 'com.example', match: 'prefix' },
      { id: d, topic: 'com.example.u', match: 'exact' },
      { id: e, topic: 'com.example.t', match: 'prefix' },
    ]);
  });

  test('pattern matching: prefix by characters, wildcard by whole components (same count)', async () => {
    const s = setup();
    const sub = await s.join();
    const prefix = await sub.subscribe('com.exam', { match: 'prefix' });
    const wildcard = await sub.subscribe('com..b', { match: 'wildcard' });
    for (const topic of ['com.example', 'com.x.b', 'com.x.b.extra', 'com.b', 'org.x.b']) s.router.publish(topic);
    await s.clock.runUntilIdle();
    expect(sub.pending.map((f) => [f[1], (f[3] as { topic: string }).topic])).toEqual([
      [prefix, 'com.example'],
      [wildcard, 'com.x.b'],
    ]);
  });

  test('PUBLISH: EVENT to every matching subscription, the publisher excluded by default, PUBLISHED with the same id', async () => {
    const s = setup();
    const pub = await s.join();
    const sub = await s.join();
    const exact = await sub.subscribe('com.example.t');
    const prefix = await sub.subscribe('com.ex', { match: 'prefix' });
    const wildcard = await sub.subscribe('com..t', { match: 'wildcard' });
    await sub.subscribe('com.example.other');
    await pub.subscribe('com.example.t');
    const id = pub.id();
    pub.send([MSG.PUBLISH, id, { acknowledge: true }, 'com.example.t', ['hello'], { n: 1 }]);
    const published = await pub.nextOf(MSG.PUBLISHED, id);
    const publication = published[2];
    await s.clock.runUntilIdle();
    expect(sub.pending).toEqual([
      [MSG.EVENT, exact, publication, {}, ['hello'], { n: 1 }],
      [MSG.EVENT, prefix, publication, { topic: 'com.example.t' }, ['hello'], { n: 1 }],
      [MSG.EVENT, wildcard, publication, { topic: 'com.example.t' }, ['hello'], { n: 1 }],
    ]);
    expect(pub.pending).toEqual([]);
  });

  test('exclude_me: false, disclose_me, payload shapes forwarded as sent, no PUBLISHED without acknowledge', async () => {
    const s = setup();
    const p = await s.join();
    const sub = await p.subscribe('com.example.t');
    p.send([MSG.PUBLISH, p.id(), { exclude_me: false, disclose_me: true }, 'com.example.t']);
    p.send([MSG.PUBLISH, p.id(), { exclude_me: false }, 'com.example.t', [1]]);
    p.send([MSG.PUBLISH, p.id(), { exclude_me: false }, 'com.example.t', [], { k: 1 }]);
    await s.clock.runUntilIdle();
    const session = s.router.sessions[0]!.id;
    expect(p.pending.map((f) => [f[1], f[3], ...f.slice(4)])).toEqual([
      [sub, { publisher: session }],
      [sub, {}, [1]],
      [sub, {}, [], { k: 1 }],
    ]);
  });

  test('eligible / exclude by session id, authid and authrole', async () => {
    const s = setup({
      authenticate: (h) => ({
        welcome: {
          authid: String(h.details['authid']),
          authrole: String(h.details['authid']).startsWith('admin') ? 'admin' : 'user',
        },
      }),
    });
    const pub = await s.join({ authid: 'pub' });
    const subs = [
      await s.join({ authid: 'alice' }),
      await s.join({ authid: 'bob' }),
      await s.join({ authid: 'admin1' }),
    ];
    for (const sub of subs) await sub.subscribe('com.example.t');
    const ids = s.router.sessions.map((x) => x.id);
    const publish = async (options: Record<string, unknown>): Promise<string[]> => {
      pub.send([MSG.PUBLISH, pub.id(), options, 'com.example.t']);
      await s.clock.runUntilIdle();
      return subs
        .map((sub, i) => (sub.take((f) => f[0] === MSG.EVENT) === undefined ? '' : ['alice', 'bob', 'admin1'][i]!))
        .filter(Boolean);
    };
    expect(await publish({})).toEqual(['alice', 'bob', 'admin1']);
    expect(await publish({ eligible: [ids[1]] })).toEqual(['alice']);
    expect(await publish({ exclude: [ids[1], ids[2]] })).toEqual(['admin1']);
    expect(await publish({ eligible_authid: ['bob', 'admin1'] })).toEqual(['bob', 'admin1']);
    expect(await publish({ exclude_authid: ['bob'] })).toEqual(['alice', 'admin1']);
    expect(await publish({ eligible_authrole: ['admin'] })).toEqual(['admin1']);
    expect(await publish({ exclude_authrole: ['admin'] })).toEqual(['alice', 'bob']);
  });

  test('UNSUBSCRIBE → UNSUBSCRIBED; again ⇒ no_such_subscription; an id never given is also a violation', async () => {
    const s = setup();
    const p = await s.join();
    const other = await s.join();
    const foreign = await other.subscribe('com.example.x');
    const id = await p.subscribe('com.example.t');
    const u1 = p.id();
    p.send([MSG.UNSUBSCRIBE, u1, id]);
    expect(await p.reply(MSG.UNSUBSCRIBE, u1, MSG.UNSUBSCRIBED)).toEqual([MSG.UNSUBSCRIBED, u1]);
    const u2 = p.id();
    p.send([MSG.UNSUBSCRIBE, u2, id]);
    expect(await p.reply(MSG.UNSUBSCRIBE, u2, MSG.UNSUBSCRIBED)).toEqual([
      MSG.ERROR,
      MSG.UNSUBSCRIBE,
      u2,
      {},
      'wamp.error.no_such_subscription',
    ]);
    expect(s.router.violations).toEqual([]);
    const u3 = p.id();
    p.send([MSG.UNSUBSCRIBE, u3, foreign]);
    await p.reply(MSG.UNSUBSCRIBE, u3, MSG.UNSUBSCRIBED);
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'UNSUBSCRIBE of a subscription id this session was never given',
    ]);
    s.router.publish('com.example.t');
    await s.clock.runUntilIdle();
    expect(p.pending).toEqual([]);
  });

  test('router publish(): to every realm, payload normalised; it also declares the topic', async () => {
    const s = setup();
    const a = await s.join();
    const b = s.peer();
    await b.join('realm2');
    const sa = await a.subscribe('com.example.t');
    const sb = await b.subscribe('com.example.t');
    s.router.publish('com.example.t', [], {});
    s.router.publish('com.example.t', ['x']);
    await s.clock.runUntilIdle();
    expect(a.pending.map((f) => [f[1], ...f.slice(3)])).toEqual([
      [sa, {}],
      [sa, {}, ['x']],
    ]);
    expect(b.pending.map((f) => [f[1], ...f.slice(3)])).toEqual([
      [sb, {}],
      [sb, {}, ['x']],
    ]);
  });
});

describe('dealer: calls between two sessions', () => {
  test('REGISTER, CALL → INVOCATION → YIELD → RESULT; ERROR(68) → ERROR(48)', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    const reg = await callee.register('com.example.add');
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      const [a, b] = f[4] as number[];
      if (a === 0)
        callee.send([MSG.ERROR, MSG.INVOCATION, f[1], { d: 1 }, 'com.example.error.zero', ['zero'], { k: 0 }]);
      else callee.send([MSG.YIELD, f[1], {}, [a! + b!], { echo: (f[5] as Record<string, unknown>)['greet'] }]);
      return true;
    };
    expect(await caller.call('com.example.add', [2, 3], { greet: 'hi' })).toEqual([
      MSG.RESULT,
      1,
      {},
      [5],
      { echo: 'hi' },
    ]);
    expect(await caller.call('com.example.add', [0, 1])).toEqual([
      MSG.ERROR,
      MSG.CALL,
      2,
      { d: 1 },
      'com.example.error.zero',
      ['zero'],
      { k: 0 },
    ]);
    const invocations = callee.received.filter((f) => f[0] === MSG.INVOCATION);
    expect(invocations.map((f) => [f[2], f[3], ...f.slice(4)])).toEqual([
      [reg, {}, [2, 3], { greet: 'hi' }],
      [reg, {}, [0, 1]],
    ]);
    expect(s.router.violations).toEqual([]);
  });

  test('a second REGISTER of a procedure (or of a scripted one) ⇒ procedure_already_exists', async () => {
    const s = setup();
    s.router.procedure('com.example.scripted', () => 1);
    const a = await s.join();
    const b = await s.join();
    await a.register('com.example.p');
    for (const [peer, uri] of [
      [b, 'com.example.p'],
      [a, 'com.example.p'],
      [b, 'com.example.scripted'],
    ] as const) {
      const id = peer.id();
      peer.send([MSG.REGISTER, id, {}, uri]);
      expect(await peer.reply(MSG.REGISTER, id, MSG.REGISTERED)).toEqual([
        MSG.ERROR,
        MSG.REGISTER,
        id,
        {},
        'wamp.error.procedure_already_exists',
      ]);
    }
  });

  test('the same URI may be registered once exact and once as a prefix; a scripted URI only refuses an exact REGISTER', async () => {
    const s = setup();
    s.router.procedure('com.example.scripted', () => 1);
    const a = await s.join();
    const exact = await a.register('com.example.p');
    const prefix = await a.register('com.example.p', { match: 'prefix' });
    const scriptedPrefix = await a.register('com.example.scripted', { match: 'prefix' });
    expect(new Set([exact, prefix, scriptedPrefix]).size).toBe(3);
  });

  test('progressive results: receive_progress reaches a callee that announced the feature; progress YIELDs become progress RESULTs', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.feed');
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      callee.send([MSG.YIELD, f[1], { progress: true }, ['partial']]);
      callee.send([MSG.YIELD, f[1], {}, ['final']]);
      return true;
    };
    const id = caller.id();
    caller.send(callFrame(id, 'com.example.feed', undefined, undefined, { receive_progress: true }));
    await s.clock.runUntilIdle();
    expect(caller.pending).toEqual([
      [MSG.RESULT, id, { progress: true }, ['partial']],
      [MSG.RESULT, id, {}, ['final']],
    ]);
    expect(callee.received.find((f) => f[0] === MSG.INVOCATION)?.[3]).toEqual({ receive_progress: true });
  });

  test('a progress YIELD the INVOCATION did not ask for is a violation and is dropped (also for a callee without the feature)', async () => {
    const s = setup();
    const callee = s.peer();
    await callee.join('realm1', { roles: { callee: { features: {} } } });
    const caller = await s.join();
    await callee.register('com.example.p');
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      callee.send([MSG.YIELD, f[1], { progress: true }, ['nope']]);
      callee.send([MSG.YIELD, f[1], {}, ['final']]);
      return true;
    };
    expect(await caller.call('com.example.p', undefined, undefined, { receive_progress: true })).toEqual([
      MSG.RESULT,
      1,
      {},
      ['final'],
    ]);
    expect(callee.received.find((f) => f[0] === MSG.INVOCATION)?.[3]).toEqual({});
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'progress YIELD although the INVOCATION did not ask for progress',
    ]);
  });

  test('pattern registrations: details.procedure; precedence exact > longest prefix > most literal wildcard', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    const exact = await callee.register('com.example.a.b');
    const shortPrefix = await callee.register('com', { match: 'prefix' });
    const longPrefix = await callee.register('com.example', { match: 'prefix' });
    const loose = await callee.register('..b', { match: 'wildcard' });
    const tight = await callee.register('net..b', { match: 'wildcard' });
    const seen: unknown[][] = [];
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      seen.push([f[2], f[3]]);
      callee.send([MSG.YIELD, f[1], {}]);
      return true;
    };
    for (const uri of ['com.example.a.b', 'com.example.zzz', 'com.other', 'com.x.b', 'net.x.b', 'org.q.b'])
      await caller.call(uri);
    expect(seen).toEqual([
      [exact, {}],
      [longPrefix, { procedure: 'com.example.zzz' }],
      [shortPrefix, { procedure: 'com.other' }],
      [shortPrefix, { procedure: 'com.x.b' }], // a prefix beats a wildcard
      [tight, { procedure: 'net.x.b' }],
      [loose, { procedure: 'org.q.b' }],
    ]);
    expect((await caller.call('org.q.c'))[4]).toBe('wamp.error.no_such_procedure');
    expect((await caller.call('a.b'))[4]).toBe('wamp.error.no_such_procedure'); // wildcards match whole component counts
  });

  test('any prefix beats any wildcard, however many literals the wildcard has', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    const wildcard = await callee.register('com..b', { match: 'wildcard' }); // 2 literals
    const prefix = await callee.register('com', { match: 'prefix' }); // 3 characters, 1 component
    const seen: unknown[] = [];
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      seen.push(f[2]);
      callee.send([MSG.YIELD, f[1], {}]);
      return true;
    };
    await caller.call('com.x.b');
    expect(seen).toEqual([prefix]);
    expect(wildcard).not.toBe(prefix);
  });

  test('a second final answer for one INVOCATION is ignored (the caller got its RESULT) and is a violation', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.p');
    let inv = 0;
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      inv = f[1] as number;
      callee.send([MSG.YIELD, inv, {}, ['first']]);
      callee.send([MSG.YIELD, inv, {}, ['second']]);
      callee.send([MSG.ERROR, MSG.INVOCATION, inv, {}, 'com.example.e']);
      return true;
    };
    expect(await caller.call('com.example.p')).toEqual([MSG.RESULT, 1, {}, ['first']]);
    await s.clock.runUntilIdle();
    expect(caller.pending).toEqual([]);
    expect(s.router.violations.map((v) => [v.rule, v.frame.frame])).toEqual([
      [`YIELD for INVOCATION ${String(inv)} after its final answer`, [MSG.YIELD, inv, {}, ['second']]],
      [
        `ERROR for INVOCATION ${String(inv)} after its final answer`,
        [MSG.ERROR, MSG.INVOCATION, inv, {}, 'com.example.e'],
      ],
    ]);
  });

  test('wildcards: more literal components win over a longer pattern; equal scores go to the first registered', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    const long = await callee.register('aaaaaaaaaa..', { match: 'wildcard' }); // 1 literal, 12 characters
    const literal = await callee.register('.b.c', { match: 'wildcard' }); // 2 literals, 4 characters
    const first = await callee.register('x..z', { match: 'wildcard' });
    await callee.register('.y.z', { match: 'wildcard' }); // as many literals as `first`
    const seen: unknown[] = [];
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      seen.push(f[2]);
      callee.send([MSG.YIELD, f[1], {}]);
      return true;
    };
    await caller.call('aaaaaaaaaa.b.c');
    await caller.call('x.y.z');
    expect(seen).toEqual([literal, first]);
    expect(long).not.toBe(literal);
  });

  test('shared registrations: roundrobin, first, last, random; a policy mismatch or the same session twice is refused', async () => {
    const s = setup();
    const callees = [await s.join(), await s.join(), await s.join()];
    const caller = await s.join();
    const who: number[] = [];
    callees.forEach((c, i) => {
      c.onFrame = (f) => {
        if (f[0] !== MSG.INVOCATION) return false;
        who.push(i);
        c.send([MSG.YIELD, f[1], {}]);
        return true;
      };
    });
    for (const policy of ['roundrobin', 'first', 'last', 'random']) {
      const ids = [];
      for (const c of callees) ids.push(await c.register(`com.example.${policy}`, { invoke: policy }));
      expect(new Set(ids).size).toBe(1); // one registration, one id for every callee
      who.length = 0;
      for (let i = 0; i < 6; i++) await caller.call(`com.example.${policy}`);
      if (policy === 'roundrobin') expect(who).toEqual([0, 1, 2, 0, 1, 2]);
      if (policy === 'first') expect(who).toEqual([0, 0, 0, 0, 0, 0]);
      if (policy === 'last') expect(who).toEqual([2, 2, 2, 2, 2, 2]);
      if (policy === 'random') expect(new Set(who).size).toBeGreaterThan(1); // seeded: reproducible
    }
    for (const [peer, options] of [
      [caller, { invoke: 'first' }], // another policy
      [callees[0]!, { invoke: 'roundrobin' }], // the same session twice
      [caller, {}], // single
    ] as const) {
      const id = peer.id();
      peer.send([MSG.REGISTER, id, options, 'com.example.roundrobin']);
      expect((await peer.reply(MSG.REGISTER, id, MSG.REGISTERED))[4]).toBe('wamp.error.procedure_already_exists');
    }
  });

  test('disclose_caller (REGISTER) and disclose_me (CALL) put the caller session in the INVOCATION details', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.a', { disclose_caller: true });
    await callee.register('com.example.b');
    const details: unknown[] = [];
    callee.onFrame = (f) => {
      if (f[0] !== MSG.INVOCATION) return false;
      details.push(f[3]);
      callee.send([MSG.YIELD, f[1], {}]);
      return true;
    };
    await caller.call('com.example.a');
    await caller.call('com.example.b', undefined, undefined, { disclose_me: true });
    await caller.call('com.example.b');
    const callerId = s.router.sessions[1]!.id;
    expect(details).toEqual([{ caller: callerId }, { caller: callerId }, {}]);
  });

  test('UNREGISTER → UNREGISTERED (shared: the others keep it); again ⇒ no_such_registration; a foreign id is a violation', async () => {
    const s = setup();
    const a = await s.join();
    const b = await s.join();
    const reg = await a.register('com.example.p', { invoke: 'roundrobin' });
    await b.register('com.example.p', { invoke: 'roundrobin' });
    const solo = await b.register('com.example.solo');
    const first = a.id();
    a.send([MSG.UNREGISTER, first, reg]);
    expect(await a.reply(MSG.UNREGISTER, first, MSG.UNREGISTERED)).toEqual([MSG.UNREGISTERED, first]);
    const again = a.id();
    a.send([MSG.UNREGISTER, again, reg]);
    expect(await a.reply(MSG.UNREGISTER, again, MSG.UNREGISTERED)).toEqual([
      MSG.ERROR,
      MSG.UNREGISTER,
      again,
      {},
      'wamp.error.no_such_registration',
    ]);
    expect(s.router.violations).toEqual([]);
    expect(s.router.sessions[1]!.registrations.map((r) => r.procedure)).toEqual(['com.example.p', 'com.example.solo']);
    b.autoCallee(reg, () => 'still served by b');
    expect((await a.call('com.example.p'))[3]).toEqual(['still served by b']);
    const id = a.id();
    a.send([MSG.UNREGISTER, id, solo]);
    await a.reply(MSG.UNREGISTER, id, MSG.UNREGISTERED);
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'UNREGISTER of a registration id this session was never given',
    ]);
  });
});

describe('dealer: CANCEL of an invocation', () => {
  async function inflight(calleeFeatures: Record<string, boolean> = { call_canceling: true }) {
    const s = setup();
    const callee = s.peer();
    await callee.join('realm1', { roles: { callee: { features: calleeFeatures } } });
    const caller = await s.join();
    await callee.register('com.example.slow');
    const id = caller.id();
    caller.send(callFrame(id, 'com.example.slow'));
    const invocation = await callee.nextOf(MSG.INVOCATION);
    return { s, callee, caller, id, inv: invocation[1] as number };
  }

  test('killnowait: INTERRUPT killnowait, the caller is answered at once, the callee’s later answer is dropped', async () => {
    const { s, callee, caller, id, inv } = await inflight();
    caller.send([MSG.CANCEL, id, { mode: 'killnowait' }]);
    expect(await callee.nextOf(MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, inv, { mode: 'killnowait' }]);
    expect(await caller.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
    callee.send([MSG.YIELD, inv, {}, ['late']]);
    await s.clock.runUntilIdle();
    expect(caller.pending).toEqual([]);
    // a client writes nothing after an INTERRUPT killnowait it received (INV-INVOKE)
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      `YIELD for INVOCATION ${String(inv)} after its INTERRUPT killnowait`,
    ]);
  });

  test('kill: INTERRUPT kill, the caller waits for the callee’s answer; a second CANCEL is ignored', async () => {
    const { s, callee, caller, id, inv } = await inflight();
    caller.send([MSG.CANCEL, id, { mode: 'kill' }]);
    caller.send([MSG.CANCEL, id, { mode: 'kill' }]);
    expect(await callee.nextOf(MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, inv, { mode: 'kill' }]);
    await s.clock.runUntilIdle();
    expect(callee.pending).toEqual([]);
    expect(caller.pending).toEqual([]);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv, {}, 'wamp.error.canceled']);
    expect(await caller.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
    // the second CANCEL and a mode other than killnowait are the caller's bugs; answering an INTERRUPT kill is what
    // the callee should do
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'CANCEL with mode "kill"',
      `a second CANCEL of CALL ${String(id)}`,
      'CANCEL with mode "kill"',
    ]);
  });

  test('skip: the caller is answered at once, no INTERRUPT, the callee’s progress and final answers are discarded', async () => {
    const { s, callee, caller, id, inv } = await inflight();
    caller.send([MSG.CANCEL, id, { mode: 'skip' }]);
    expect(await caller.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
    callee.send([MSG.YIELD, inv, {}, ['late']]);
    await s.clock.runUntilIdle();
    expect([callee.pending, caller.pending]).toEqual([[], []]);
  });

  test('no mode means killnowait; a callee without call_canceling gets skip semantics (no INTERRUPT)', async () => {
    const a = await inflight();
    a.caller.send([MSG.CANCEL, a.id, {}]);
    expect(await a.callee.nextOf(MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, a.inv, { mode: 'killnowait' }]);
    const b = await inflight({});
    b.caller.send([MSG.CANCEL, b.id, { mode: 'killnowait' }]);
    expect(await b.caller.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, b.id, {}, 'wamp.error.canceled']);
    expect(b.callee.pending).toEqual([]);
  });

  test('a callee that leaves after a skip does not answer the caller twice', async () => {
    const { s, callee, caller, id } = await inflight();
    caller.send([MSG.CANCEL, id, { mode: 'skip' }]);
    await caller.nextOf(MSG.ERROR);
    callee.ws.controls.drop();
    await s.clock.runUntilIdle();
    expect(caller.pending).toEqual([]);
  });

  test('a progress YIELD after a skip is discarded too', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.p');
    const id = caller.id();
    caller.send(callFrame(id, 'com.example.p', undefined, undefined, { receive_progress: true }));
    const inv = (await callee.nextOf(MSG.INVOCATION))[1];
    caller.send([MSG.CANCEL, id, { mode: 'skip' }]);
    await caller.nextOf(MSG.ERROR);
    callee.send([MSG.YIELD, inv, { progress: true }, [1]]);
    callee.send([MSG.YIELD, inv, {}, [2]]);
    await s.clock.runUntilIdle();
    expect(caller.pending).toEqual([]);
  });
});

describe('leaving mid-call', () => {
  test('the callee leaves ⇒ the caller gets ERROR canceled', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.p');
    const id = caller.id();
    caller.send(callFrame(id, 'com.example.p'));
    await callee.nextOf(MSG.INVOCATION);
    callee.ws.close(1000);
    expect(await caller.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, id, {}, 'wamp.error.canceled']);
    expect(await caller.call('com.example.p')).toEqual([MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.no_such_procedure']);
  });

  test('the caller leaves ⇒ the callee gets INTERRUPT killnowait (if it cancels), and nothing for a callee without the feature', async () => {
    const s = setup();
    const a = await s.join();
    const b = s.peer();
    await b.join('realm1', { roles: { callee: { features: {} } } });
    const caller = await s.join();
    await a.register('com.example.a');
    await b.register('com.example.b');
    caller.send(callFrame(caller.id(), 'com.example.a'));
    caller.send(callFrame(caller.id(), 'com.example.b'));
    const invA = (await a.nextOf(MSG.INVOCATION))[1];
    await b.nextOf(MSG.INVOCATION);
    caller.ws.controls.drop();
    expect(await a.nextOf(MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, invA, { mode: 'killnowait' }]);
    await s.clock.runUntilIdle();
    expect(b.pending).toEqual([]);
  });

  test('the caller leaves ⇒ a scripted handler is unsubscribed; a session calling itself is cleaned once', async () => {
    const s = setup();
    const teardown = vi.fn();
    s.router.procedure('com.example.never', () => new RxObservable(() => teardown));
    const p = await s.join();
    await p.register('com.example.self');
    p.send(callFrame(p.id(), 'com.example.never'));
    p.send(callFrame(p.id(), 'com.example.self'));
    await p.nextOf(MSG.INVOCATION);
    p.ws.controls.drop();
    await s.clock.runUntilIdle();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(s.router.errors).toEqual([]);
  });
});

describe('nothing after the end of a session on its own connection', () => {
  test('a router GOODBYE is its last frame there: no INTERRUPT for a call to its own registration follows', async () => {
    const s = setup();
    const other = await s.join();
    const p = await s.join();
    await p.register('com.example.self');
    await other.register('com.example.other');
    p.send(callFrame(p.id(), 'com.example.self'));
    const toOther = p.id();
    p.send(callFrame(toOther, 'com.example.other'));
    await p.nextOf(MSG.INVOCATION);
    await other.nextOf(MSG.INVOCATION);
    s.router.goodbye();
    await s.clock.runUntilIdle();
    // `other` ended first (it is the older session), so p, still in its session, heard that its callee left
    expect(p.pending).toEqual([
      [MSG.ERROR, MSG.CALL, toOther, {}, 'wamp.error.canceled'],
      [MSG.GOODBYE, {}, 'wamp.close.system_shutdown'],
    ]);
    expect(other.pending).toEqual([[MSG.GOODBYE, {}, 'wamp.close.system_shutdown']]);
    expect(s.router.violations).toEqual([]);
  });

  test('a connection that is dropped or closed by the router gets no frame after its end', async () => {
    for (const end of ['drop', 'close'] as const) {
      const s = setup();
      const p = await s.join();
      await p.register('com.example.self');
      p.send(callFrame(p.id(), 'com.example.self'));
      await p.nextOf(MSG.INVOCATION);
      const before = p.events.length;
      if (end === 'drop') p.ws.controls.drop();
      else p.ws.controls.close(1000, 'bye');
      await s.clock.runUntilIdle();
      expect(p.events.slice(before)).toEqual(end === 'drop' ? ['error', 'close:1006'] : ['close:1000']);
    }
  });
});

describe('revocation', () => {
  test('revokeSubscription: [35, 0, {subscription, reason}] to subscribers that announced the feature; the subscription is gone', async () => {
    const s = setup();
    const a = await s.join();
    const b = s.peer();
    await b.join('realm1', { roles: { subscriber: { features: {} } } });
    const sa = await a.subscribe('com.example.t');
    await b.subscribe('com.example.t');
    await a.subscribe('com.example.other');
    s.router.revokeSubscription('com.example.t', 'admin');
    s.router.revokeSubscription('com.example.other');
    await s.clock.runUntilIdle();
    expect(a.pending.map((f) => [f[0], f[1], f[2]])).toEqual([
      [MSG.UNSUBSCRIBED, 0, { subscription: sa, reason: 'admin' }],
      [MSG.UNSUBSCRIBED, 0, expect.objectContaining({ subscription: expect.any(Number) as unknown }) as unknown],
    ]);
    expect(a.pending[1]![2]).not.toHaveProperty('reason');
    expect(b.pending).toEqual([]);
    a.take(() => true);
    a.take(() => true);
    s.router.publish('com.example.t');
    await s.clock.runUntilIdle();
    expect([a.pending, b.pending]).toEqual([[], []]);
  });

  test('revokeRegistration: [67, 0, {registration, reason}] to every callee; calls then find no procedure', async () => {
    const s = setup();
    const a = await s.join();
    const b = s.peer();
    await b.join('realm1', { roles: { callee: { features: {} } } });
    const caller = await s.join();
    const reg = await a.register('com.example.p', { invoke: 'roundrobin' });
    await b.register('com.example.p', { invoke: 'roundrobin' });
    s.router.revokeRegistration('com.example.p', 'moved');
    await s.clock.runUntilIdle();
    expect(a.pending).toEqual([[MSG.UNREGISTERED, 0, { registration: reg, reason: 'moved' }]]);
    expect(b.pending).toEqual([]);
    expect((await caller.call('com.example.p'))[4]).toBe('wamp.error.no_such_procedure');
    a.take(() => true);
    const other = await a.register('com.example.other');
    await a.register('com.example.third');
    a.autoCallee(other, () => 'other');
    s.router.revokeRegistration('com.example.third');
    await s.clock.runUntilIdle();
    expect((await caller.call('com.example.other'))[3]).toEqual(['other']); // only the named procedure is revoked
  });
});

describe('router id policies', () => {
  test("'unique' (default): one counter for every kind of id, never reused", async () => {
    const s = setup();
    const p = await s.join();
    const ids = [
      s.router.sessions[0]!.id,
      await p.subscribe('com.example.a'),
      await p.register('com.example.b'),
      await p.subscribe('com.example.c'),
    ];
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  test("'per-session': subscription, registration and invocation ids start at 1 in every session", async () => {
    const s = setup({ routerIds: 'per-session' });
    const a = await s.join();
    const b = await s.join();
    expect([
      await a.subscribe('com.example.t'),
      await a.subscribe('com.example.u'),
      await b.subscribe('com.example.t'),
    ]).toEqual([1, 2, 1]);
    expect([
      await a.register('com.example.p', { invoke: 'roundrobin' }),
      await b.register('com.example.p', { invoke: 'roundrobin' }),
    ]).toEqual([1, 1]);
    a.autoCallee(1, () => 'a');
    b.autoCallee(1, () => 'b');
    expect((await b.call('com.example.p'))[3]).toEqual(['a']);
    expect((await a.call('com.example.p'))[3]).toEqual(['b']);
    const invocations = [...a.received, ...b.received].filter((f) => f[0] === MSG.INVOCATION).map((f) => f[1]);
    expect(invocations).toEqual([1, 1]);
    s.router.publish('com.example.t');
    await s.clock.runUntilIdle();
    expect(a.pending.map((f) => f[1])).toEqual([1]);
  });

  test("'random': 53-bit ids from the router's own seeded stream, distinct, reproducible", async () => {
    const run = async (): Promise<number[]> => {
      const s = setup({ routerIds: 'random' });
      const p = await s.join();
      return [s.router.sessions[0]!.id, await p.subscribe('com.example.a'), await p.register('com.example.b')];
    };
    const first = await run();
    expect(first).toEqual(await run());
    expect(new Set(first).size).toBe(3);
    for (const id of first) expect(Number.isInteger(id) && id >= 1 && id <= 2 ** 53).toBe(true);
  });

  test("'random' redraws an id that is already in use", async () => {
    const clock = createSimClock();
    const draws = [0.5, 0.5, 0.25];
    const random = (): number => draws.shift() ?? 0.75;
    // a plain VirtualClock (not linked to a SimClock): the router draws from its `random`
    const router = createRouter({ clock: { ...clock.scope('r'), random }, routerIds: 'random' });
    const peer = new WampPeer(router.WebSocket, router.url, () => clock.advance(0));
    await peer.join();
    const sub = await peer.subscribe('com.example.t');
    expect([router.sessions[0]!.id, sub]).toEqual([Math.floor(0.5 * 2 ** 53) + 1, Math.floor(0.25 * 2 ** 53) + 1]);
  });
});

describe('delivery modes and latency', () => {
  test('clock: frames take the per-direction latency (in = client → router, out = router → client)', async () => {
    const s = setup({ latency: { in: 30, out: 70 } });
    const peer = s.peer();
    await s.clock.advance(69);
    expect(peer.opened).toBe(false);
    await s.clock.advance(1);
    expect(peer.opened).toBe(true);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await s.clock.advance(99);
    expect(peer.pending).toEqual([]);
    await s.clock.advance(1);
    expect(peer.pending[0]![0]).toBe(MSG.WELCOME);
    expect(s.router.frames.map((f) => [f.direction, f.at])).toEqual([
      ['in', 70],
      ['out', 170],
    ]);
  });

  test("the socket's own events (close() while CONNECTING) take the router → client latency", async () => {
    const s = setup({ latency: { in: 30, out: 70 } });
    s.router.setAvailable('hang');
    const peer = s.peer();
    peer.ws.close(4001);
    await s.clock.advance(69);
    expect(peer.events).toEqual([]);
    await s.clock.advance(1);
    expect(peer.events).toEqual(['error', 'close:1006']);
  });

  test('sync: everything happens inside the calls (the frame is answered inside send())', () => {
    const router = createRouter({ delivery: 'sync' });
    const peer = new WampPeer(router.WebSocket, router.url, () => undefined);
    expect(peer.ws.readyState).toBe(1);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    expect(peer.pending[0]![0]).toBe(MSG.WELCOME);
  });

  test('manual: nothing moves until flush(n); pending counts the queue; flush runs FIFO and returns the count', () => {
    const router = createRouter({ delivery: 'manual' });
    const peer = new WampPeer(router.WebSocket, router.url, () => undefined);
    expect([peer.opened, router.pending]).toEqual([false, 1]);
    expect(router.flush()).toBe(1);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    peer.send([MSG.SUBSCRIBE, 1, {}, 'com.example.t']);
    expect(router.flush(1)).toBe(1); // HELLO reaches the router; WELCOME is queued
    expect([router.pending, peer.pending.length]).toEqual([2, 0]);
    expect(router.flush(10)).toBe(3);
    expect(peer.pending.map((f) => f[0])).toEqual([MSG.WELCOME, MSG.SUBSCRIBED]);
    expect(router.flush()).toBe(0);
  });

  test('microtask (no clock): frames arrive once microtasks ran; a manual flush() does nothing', async () => {
    const router = createRouter();
    const peer = new WampPeer(router.WebSocket, router.url, () => drainMicrotasks());
    await peer.join();
    expect(router.flush()).toBe(0);
    expect(router.sessions).toHaveLength(1);
  });

  test('clock delivery through a clock that is not a SimClock uses its setTimeout', async () => {
    const real = createSimClock();
    const calls: number[] = [];
    const plain = {
      now: () => real.now(),
      setTimeout: (fn: () => void, ms: number) => {
        calls.push(ms);
        return real.setTimeout(fn, ms);
      },
      clearTimeout: (h: unknown) => {
        real.clearTimeout(h);
      },
      random: () => 0.5,
      advance: (ms: number) => real.advance(ms),
      runUntilIdle: (l?: number) => real.runUntilIdle(l),
      get pendingTimers() {
        return real.pendingTimers;
      },
    };
    const router = createRouter({ clock: plain, latency: { out: 5 } });
    const peer = new WampPeer(router.WebSocket, router.url, () => plain.runUntilIdle());
    await peer.join();
    expect(calls).toEqual([5, 0, 5]);
  });

  test('createRouter is not strict by default (createSimRouter is)', async () => {
    const router = createRouter({ delivery: 'sync' });
    const peer = new WampPeer(router.WebSocket, router.url, () => undefined);
    await peer.join();
    await peer.subscribe('com.example.undeclared');
    await peer.call('com.example.nobody');
    expect(router.unscripted).toEqual([]);
  });

  test("'random' ids without a clock come from Math.random; with a SimClock from its 'router' stream", async () => {
    const plain = createRouter({ delivery: 'sync', routerIds: 'random' });
    const peer = new WampPeer(plain.WebSocket, plain.url, () => undefined);
    await peer.join();
    const id = await peer.subscribe('com.example.t');
    expect(Number.isInteger(id) && id >= 1 && id <= 2 ** 53).toBe(true);
    const clock = createSimClock({ seed: 5 });
    const seeded = createRouter({ clock: clock.scope('router'), routerIds: 'random' });
    const p2 = new WampPeer(seeded.WebSocket, seeded.url, () => clock.runUntilIdle());
    const welcome = await p2.join();
    const stream = createSimClock({ seed: 5 }).fork('router');
    expect(welcome[1]).toBe(Math.floor(stream() * 2 ** 53) + 1);
  });

  test('a shared registration picks randomly through the router stream even without a clock', async () => {
    const router = createRouter({ delivery: 'sync' });
    const settle = (): undefined => undefined;
    const callees = [
      new WampPeer(router.WebSocket, router.url, settle),
      new WampPeer(router.WebSocket, router.url, settle),
    ];
    const caller = new WampPeer(router.WebSocket, router.url, settle);
    for (const c of [...callees, caller]) await c.join();
    const who: number[] = [];
    for (const [i, c] of callees.entries()) {
      c.autoCallee(await c.register('com.example.p', { invoke: 'random' }), () => who.push(i));
    }
    for (let i = 0; i < 40; i++) await caller.call('com.example.p');
    expect(new Set(who)).toEqual(new Set([0, 1]));
  });

  test('option errors: unknown delivery mode, clock delivery without a clock, unknown dialect', () => {
    expect(() => createRouter({ delivery: 'teleport' as 'sync' })).toThrow(
      new TypeError("unknown delivery mode 'teleport'"),
    );
    expect(() => createRouter({ delivery: 'clock' })).toThrow("delivery 'clock' needs a clock");
    expect(() => createRouter({ dialect: 'nonsense' as 'spec' })).toThrow(
      new TypeError("testing router: unknown dialect 'nonsense'"),
    );
    expect(() => createRouter({ dialect: 'spec' })).not.toThrow();
    expect(() => createRouter({ authManager: 'maybe' as 'ok' })).toThrow(new TypeError("unknown authManager 'maybe'"));
  });
});

describe('availability and connection failures', () => {
  test.each([
    ['refuse', ['error', 'close:1006'], 3],
    ['error-only', ['error'], 0],
    ['hang', [], 0],
  ] as const)("'%s'", async (mode, events, readyState) => {
    const s = setup();
    s.router.setAvailable(mode);
    const peer = s.peer();
    await s.clock.runUntilIdle();
    expect(peer.events).toEqual(events);
    expect(peer.ws.readyState).toBe(readyState);
    expect(s.router.connections).toHaveLength(1);
  });

  test("'throw': the constructor throws and no connection is recorded; 'ok' restores", async () => {
    const s = setup();
    s.router.setAvailable('throw');
    expect(() => s.peer()).toThrow('connections are refused');
    expect(s.router.connections).toHaveLength(0);
    s.router.setAvailable('ok');
    await s.join();
    expect(() => {
      s.router.setAvailable('maybe' as 'ok');
    }).toThrow(new TypeError("unknown availability 'maybe'"));
  });

  test('a client that does not offer wamp.2.json fails the upgrade', async () => {
    const s = setup();
    const peer = new WampPeer(s.router.WebSocket, s.router.url, () => s.clock.runUntilIdle(), ['wamp.2.msgpack']);
    await s.clock.runUntilIdle();
    expect(peer.events).toEqual(['error', 'close:1006']);
    expect((peer.errors[0] as { message: string }).message).toBe('Server sent no subprotocol');
  });

  test('drop() includes connections that were never answered; close() closes 1001 and refuses new ones', async () => {
    const s = setup();
    const a = await s.join();
    s.router.setAvailable('hang');
    const b = s.peer();
    s.router.drop();
    await s.clock.runUntilIdle();
    expect([a.events.at(-1), b.events]).toEqual(['close:1006', ['error', 'close:1006']]);
    s.router.setAvailable('ok');
    const c = await s.join();
    s.router.close();
    const d = s.peer();
    await s.clock.runUntilIdle();
    expect([c.closed, d.events]).toEqual([{ code: 1001, reason: '', wasClean: true }, ['error', 'close:1006']]);
  });
});

describe('strict mode', () => {
  test('SUBSCRIBE/PUBLISH to an undeclared topic and an unscripted CALL are recorded; declared topics are not', async () => {
    const clock = createSimClock();
    const router = createSimRouter({ clock });
    router.declareTopic('com.example.declared');
    router.publish('com.example.published'); // publishing declares
    const peer = new WampPeer(router.WebSocket, router.url, () => clock.advance(0));
    await peer.join();
    await peer.subscribe('com.example.declared');
    await peer.subscribe('com.example.published');
    await peer.subscribe('com.example.undeclared');
    peer.send([MSG.PUBLISH, peer.id(), {}, 'com.example.undeclared.too']);
    await peer.call('com.example.nobody');
    expect(router.unscripted.map((f) => (f.frame as Frame)[0])).toEqual([MSG.SUBSCRIBE, MSG.PUBLISH, MSG.CALL]);
    expect(createSimRouter({ strict: false }).unscripted).toEqual([]);
  });
});

describe('ignore(): frames the router leaves unanswered', () => {
  test('a HELLO, a SUBSCRIBE, the liveness probe and a GOODBYE matching a predicate get no answer; others do', async () => {
    const s = setup({ strict: true });
    s.router.declareTopic('com.example.a');
    s.router.declareTopic('com.example.b');
    const seen: [number, number][] = [];
    const stop = s.router.ignore((f, c) => {
      seen.push([f[0] as number, c.number]);
      return (
        (f[0] === MSG.HELLO && f[1] === 'silent') ||
        (f[0] === MSG.SUBSCRIBE && f[3] === 'com.example.b') ||
        (f[0] === MSG.CALL && f[3] === 'thruway.js.ping') ||
        f[0] === MSG.GOODBYE
      );
    });
    const silent = s.peer();
    await s.clock.runUntilIdle();
    silent.send([MSG.HELLO, 'silent', { roles: PEER_ROLES }]);
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.example.a']);
    p.send([MSG.SUBSCRIBE, 2, {}, 'com.example.b']);
    p.send(callFrame(3, 'thruway.js.ping'));
    p.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await s.clock.advance(60000);
    expect(silent.received).toEqual([]);
    expect(s.router.connections.map((c) => [c.number, c.phase, c.state])).toEqual([
      [1, 'hello', 'open'],
      [2, 'established', 'open'],
    ]);
    expect(p.pending.map((f) => f.slice(0, 2))).toEqual([[MSG.SUBSCRIBED, 1]]);
    expect(seen.slice(0, 2)).toEqual([
      [MSG.HELLO, 1],
      [MSG.HELLO, 2],
    ]);
    // recorded like any frame; the oracle still judges them (nothing to flag here)
    expect(s.router.frames.filter((r) => r.direction === 'in').length).toBe(6);
    expect([s.router.violations, s.router.unscripted, s.router.errors]).toEqual([[], [], []]);
    stop();
    stop(); // idempotent
    p.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']); // a second GOODBYE: a violation, but now answered
    await s.clock.runUntilIdle();
    expect(p.closed?.code).toBe(1000);
    expect(s.router.violations.map((v) => v.rule)).toEqual(["GOODBYE after the client's GOODBYE"]);
  });

  test('a predicate that throws is recorded in errors and ignores nothing; it must be a function', async () => {
    const s = setup();
    const failure = new Error('predicate bug');
    s.router.ignore(() => {
      throw failure;
    });
    s.router.ignore((f) => f[0] === MSG.SUBSCRIBE); // the next predicate still runs
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.example.t']);
    await s.clock.runUntilIdle();
    expect(p.pending).toEqual([]);
    expect(s.router.errors).toEqual([failure, failure]); // the HELLO and the SUBSCRIBE
    expect(() => s.router.ignore(undefined as never)).toThrow(
      new TypeError('ignore(predicate): predicate must be a function'),
    );
  });

  test('the same predicate twice is two entries, removed one at a time', async () => {
    const s = setup();
    const predicate = (f: readonly unknown[]): boolean => f[0] === MSG.SUBSCRIBE;
    const first = s.router.ignore(predicate);
    s.router.ignore(predicate);
    first();
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.example.t']);
    await s.clock.runUntilIdle();
    expect(p.pending).toEqual([]);
  });
});

describe('the violation oracle', () => {
  async function session(): Promise<{ s: Setup; peer: WampPeer }> {
    const s = setup();
    return { s, peer: await s.join() };
  }

  test('frames before HELLO and before WELCOME, raw text, non-array JSON and non-integer types', async () => {
    const s = setup({ authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) });
    const peer = s.peer();
    await s.clock.runUntilIdle();
    peer.send([MSG.SUBSCRIBE, 1, {}, 'com.example.t']);
    peer.ws.send('not json');
    peer.ws.send('{"a":1}');
    peer.send(['1', 'realm1', {}]);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await peer.nextOf(MSG.CHALLENGE);
    peer.send([MSG.CALL, 2, {}, 'com.example.p']);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    peer.send([MSG.AUTHENTICATE, 42, {}]);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'SUBSCRIBE before HELLO',
      'the frame is not a JSON array',
      'the frame is not a JSON array',
      'the message type is not an integer',
      'CALL before WELCOME',
      'a second HELLO',
      'malformed AUTHENTICATE',
    ]);
    expect(s.router.violations[1]!.frame).toEqual(expect.objectContaining({ direction: 'in', frame: 'not json' }));
  });

  test('in a session: second HELLO, AUTHENTICATE, router-only and unknown types', async () => {
    const { s, peer } = await session();
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    peer.send([MSG.AUTHENTICATE, 'x', {}]);
    peer.send([MSG.WELCOME, 1, {}]);
    peer.send([999, 1]);
    peer.send([999, MSG.INVOCATION, {}]); // shaped like a YIELD, but not one: one violation only
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'a second HELLO',
      'AUTHENTICATE after WELCOME',
      'WELCOME is not a message a client sends in a session',
      'type 999 is not a message a client sends in a session',
      'type 999 is not a message a client sends in a session',
    ]);
  });

  test('ordering is judged by what the client had received: a frame crossing the router GOODBYE is no violation', async () => {
    const { s, peer } = await session();
    s.router.goodbye();
    peer.send(callFrame(peer.id(), 'com.example.p')); // the GOODBYE is still on the wire
    await s.clock.runUntilIdle();
    peer.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
    await s.clock.runUntilIdle();
    expect(s.router.violations).toEqual([]);
  });

  test('nothing after the client’s own GOODBYE — also not a reply to a router GOODBYE that crossed it', async () => {
    const { s, peer } = await session();
    const other = await s.join();
    peer.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    peer.send(callFrame(peer.id(), 'com.example.p')); // never reaches the router: it closes first
    // A buggy client that answers the router's GOODBYE although it had sent its own:
    other.onFrame = (f) => {
      if (f[0] === MSG.GOODBYE) other.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
      return false;
    };
    other.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    s.router.goodbye(); // crosses `other`'s GOODBYE on the wire
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => [v.frame.connection, v.rule])).toEqual([
      [1, "CALL after the client's GOODBYE"],
      [2, "GOODBYE after the client's GOODBYE"],
    ]);
  });

  test("nothing after the router's ABORT, and no reply to a GOODBYE received before WELCOME", async () => {
    const s = setup({
      authenticate: (h) =>
        h.realm === 'auth' ? { challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) } : { welcome: {} },
    });
    const a = await s.join();
    a.onFrame = (f) => {
      if (f[0] === MSG.ABORT) a.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']); // too late: the ABORT ended it
      return false;
    };
    s.router.abort('wamp.error.system_shutdown');
    await s.clock.runUntilIdle();
    const b = s.peer();
    await s.clock.runUntilIdle();
    b.send([MSG.HELLO, 'auth', { roles: PEER_ROLES }]);
    await b.nextOf(MSG.CHALLENGE);
    s.router.goodbye(); // only established sessions get one: b is challenged
    b.onFrame = (f) => {
      if (f[0] === MSG.GOODBYE) b.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']); // GOODBYE before WELCOME: no reply
      return false;
    };
    s.router.sendRaw(JSON.stringify([MSG.GOODBYE, {}, 'wamp.close.system_shutdown']));
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => [v.frame.connection, v.rule])).toEqual([
      [1, "GOODBYE after the router's ABORT"],
      [2, "GOODBYE after the router's ABORT"],
    ]);
  });

  test('AUTHENTICATE without a CHALLENGE (early, or a second one for one CHALLENGE); GOODBYE before WELCOME', async () => {
    const s = setup({ authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) });
    const twice = s.peer();
    const early = s.peer();
    const leaving = s.peer();
    await s.clock.runUntilIdle();
    for (const p of [twice, early, leaving]) p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    early.send([MSG.AUTHENTICATE, 'early', {}]);
    await s.clock.runUntilIdle();
    twice.send([MSG.AUTHENTICATE, 'one', {}]);
    twice.send([MSG.AUTHENTICATE, 'two', {}]);
    leaving.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => [v.frame.connection, v.rule])).toEqual([
      [2, 'AUTHENTICATE without a CHALLENGE'],
      [1, 'AUTHENTICATE without a CHALLENGE'],
      [3, 'GOODBYE before WELCOME'],
    ]);
  });

  test('malformed requests: bad request ids (0, negative, fractional, > 2^53, strings), dicts and URIs', async () => {
    const { s, peer } = await session();
    const frames: Frame[] = [
      [MSG.SUBSCRIBE, 0, {}, 'com.example.t'],
      [MSG.SUBSCRIBE, 1, [], 'com.example.t'],
      [MSG.UNSUBSCRIBE, -1, 5],
      [MSG.UNSUBSCRIBE, 1, 'x'],
      [MSG.PUBLISH, 1.5, {}, 'com.example.t'],
      [MSG.PUBLISH, 1, {}, 'com.example.t', { not: 'args' }],
      [MSG.PUBLISH, 1, {}, 'com.example.t', [], 'not kwargs'],
      [MSG.REGISTER, 2 ** 53 + 2, {}, 'com.example.p'],
      [MSG.REGISTER, 1, {}, 7],
      [MSG.UNREGISTER, '1', 1],
      [MSG.CALL, 1, {}, 'com.example.p', 'x'],
      [MSG.CALL, 1, {}],
      [MSG.CANCEL, 1, 'kill'],
      [MSG.YIELD, 1, 'options'],
      [MSG.ERROR, MSG.INVOCATION, 1, {}, 5],
      [MSG.ERROR, MSG.CALL, 1, {}, 'com.example.e'],
      [MSG.SUBSCRIBE, 1, {}, 5],
      [MSG.PUBLISH, 1, [], 'com.example.t'],
      [MSG.PUBLISH, 1, {}, 5],
      [MSG.CALL, 1, [], 'com.example.p'],
      [MSG.CALL, 1, {}, 5],
      [MSG.REGISTER, 1, 'options', 'com.example.p'],
      [MSG.YIELD, 0, {}],
      [MSG.YIELD, 1, {}, 'not args'],
      [MSG.ERROR, MSG.INVOCATION, 'x', {}, 'com.example.e'],
      [MSG.ERROR, MSG.INVOCATION, 1, 'details', 'com.example.e'],
      [MSG.ERROR, MSG.INVOCATION, 1, {}, 'com.example.e', 'not args'],
    ];
    for (const f of frames) peer.send(f);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'malformed SUBSCRIBE',
      'malformed SUBSCRIBE',
      'malformed UNSUBSCRIBE',
      'malformed UNSUBSCRIBE',
      'malformed PUBLISH',
      'malformed PUBLISH',
      'malformed PUBLISH',
      'malformed REGISTER',
      'malformed REGISTER',
      'malformed UNREGISTER',
      'malformed CALL',
      'malformed CALL',
      'malformed CANCEL',
      'malformed YIELD',
      'malformed ERROR',
      'ERROR for request type 48 (a client only answers INVOCATIONs)',
      'malformed SUBSCRIBE',
      'malformed PUBLISH',
      'malformed PUBLISH',
      'malformed CALL',
      'malformed CALL',
      'malformed REGISTER',
      'malformed YIELD',
      'malformed YIELD',
      'malformed ERROR',
      'malformed ERROR',
      'malformed ERROR',
    ]);
    expect(peer.pending).toEqual([]);
  });

  test('the request id 2^53 and null payload elements are valid', async () => {
    const { s, peer } = await session();
    s.router.procedure('com.example.p', (args, kwargs) => [args, kwargs]);
    peer.send([MSG.SUBSCRIBE, 2 ** 53, {}, 'com.example.t']);
    peer.send([MSG.CALL, 7, {}, 'com.example.p', null, null]);
    peer.send([MSG.PUBLISH, 8, { acknowledge: true }, 'com.example.t', null, { k: 1 }]);
    await s.clock.runUntilIdle();
    expect(peer.pending.map((f) => [f[0], f[1]])).toEqual([
      [MSG.SUBSCRIBED, 2 ** 53],
      [MSG.RESULT, 7],
      [MSG.PUBLISHED, 8],
    ]);
    expect(peer.received.find((f) => f[0] === MSG.RESULT)?.[3]).toEqual([[[], {}]]);
    expect(s.router.violations).toEqual([]);
  });

  test('raw text in a session is one violation (it is never routed)', async () => {
    const { s, peer } = await session();
    peer.ws.send('nonsense');
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual(['the frame is not a JSON array']);
  });

  test('invalid URIs: ERROR invalid_uri for SUBSCRIBE/REGISTER/CALL/acknowledged PUBLISH, nothing for a plain PUBLISH', async () => {
    const { s, peer } = await session();
    const frames: Frame[] = [
      [MSG.SUBSCRIBE, 1, {}, 'bad uri'],
      [MSG.SUBSCRIBE, 2, { match: 'prefix' }, 'ok.prefix.'],
      [MSG.REGISTER, 3, {}, 'a..b'],
      [MSG.CALL, 4, {}, 'a.#.b'],
      [MSG.PUBLISH, 5, { acknowledge: true }, ''],
      [MSG.PUBLISH, 6, {}, 'x y'],
    ];
    for (const f of frames) peer.send(f);
    await s.clock.runUntilIdle();
    expect(peer.pending).toEqual([
      [MSG.ERROR, MSG.SUBSCRIBE, 1, {}, 'wamp.error.invalid_uri'],
      [MSG.SUBSCRIBED, 2, expect.any(Number)],
      [MSG.ERROR, MSG.REGISTER, 3, {}, 'wamp.error.invalid_uri'],
      [MSG.ERROR, MSG.CALL, 4, {}, 'wamp.error.invalid_uri'],
      [MSG.ERROR, MSG.PUBLISH, 5, {}, 'wamp.error.invalid_uri'],
    ]);
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'SUBSCRIBE with an invalid URI "bad uri"',
      'REGISTER with an invalid URI "a..b"',
      'CALL with an invalid URI "a.#.b"',
      'PUBLISH with an invalid URI ""',
      'PUBLISH with an invalid URI "x y"',
    ]);
  });

  test('a CALL id still in flight reused; YIELD/ERROR for an INVOCATION never received', async () => {
    const s = setup();
    s.router.procedure('com.example.never', () => new Promise(() => undefined));
    const callee = await s.join();
    const peer = await s.join();
    peer.send(callFrame(7, 'com.example.never'));
    peer.send(callFrame(7, 'com.example.never'));
    peer.send([MSG.YIELD, 12345, {}]);
    peer.send([MSG.ERROR, MSG.INVOCATION, 12345, {}, 'com.example.e']);
    await callee.register('com.example.p');
    await s.clock.runUntilIdle();
    // every rule is judged when the frame is written, against what the client had sent and received
    expect(s.router.violations.map((v) => [v.code, v.rule])).toEqual([
      ['request-id-in-flight', 'CALL with a request id that is still in flight'],
      ['answer-unknown-invocation', 'YIELD for an INVOCATION this session never received'],
      ['answer-unknown-invocation', 'ERROR for an INVOCATION this session never received'],
    ]);
  });

  test('CANCEL only for a CALL written on this connection, once per CALL (a new CALL with the id resets it)', async () => {
    const s = setup();
    s.router.procedure('com.example.never', () => new Promise(() => undefined));
    s.router.procedure('com.example.now', () => 'now');
    const old = await s.join();
    old.send(callFrame(40, 'com.example.never'));
    const peer = await s.join();
    peer.send([MSG.CANCEL, 40, { mode: 'killnowait' }]); // a CALL of another connection
    peer.send(callFrame(41, 'com.example.now'));
    await peer.reply(MSG.CALL, 41, MSG.RESULT);
    peer.send([MSG.CANCEL, 41, { mode: 'killnowait' }]); // after the RESULT: a benign race, ignored
    peer.send([MSG.CANCEL, 41, { mode: 'killnowait' }]);
    peer.send(callFrame(41, 'com.example.never')); // the id is free again
    peer.send([MSG.CANCEL, 41, { mode: 'killnowait' }]);
    peer.send([MSG.CANCEL, 'x', {}]); // malformed: flagged as such only
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      'CANCEL of CALL 40, never written on this connection',
      'a second CANCEL of CALL 41',
      'malformed CANCEL',
    ]);
    expect(peer.pending).toEqual([[MSG.ERROR, MSG.CALL, 41, {}, 'wamp.error.canceled']]);
  });

  test('YIELD/ERROR: only for INVOCATIONs received on this connection, nothing after the final answer or a killnowait', async () => {
    const s = setup();
    const callee = s.peer();
    await callee.join('realm1', {
      roles: { callee: { features: { progressive_call_results: true, call_canceling: true } } },
    });
    const caller = await s.join();
    await callee.register('com.example.p');
    const progressive = { receive_progress: true };
    caller.send(callFrame(1, 'com.example.p', undefined, undefined, progressive));
    caller.send(callFrame(2, 'com.example.p'));
    const [a, b] = [(await callee.nextOf(MSG.INVOCATION))[1], (await callee.nextOf(MSG.INVOCATION))[1]];
    callee.send([MSG.YIELD, a, { progress: true }, [1]]); // progress, then the final answer: fine
    callee.send([MSG.YIELD, a, {}, [2]]);
    callee.send([MSG.YIELD, a, { progress: true }, [3]]); // after the final one
    caller.send([MSG.CANCEL, 2, { mode: 'killnowait' }]);
    await callee.nextOf(MSG.INTERRUPT);
    callee.send([MSG.ERROR, MSG.INVOCATION, b, {}, 'wamp.error.canceled']); // after receiving the killnowait
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual([
      `YIELD for INVOCATION ${String(a)} after its final answer`,
      `ERROR for INVOCATION ${String(b)} after its INTERRUPT killnowait`,
    ]);
    expect(caller.pending.map((f) => f.slice(0, 4))).toEqual([
      [MSG.RESULT, 1, { progress: true }, [1]],
      [MSG.RESULT, 1, {}, [2]],
      [MSG.ERROR, MSG.CALL, 2, {}],
    ]);
  });

  test('an answer that crossed the INTERRUPT on the wire, or the INVOCATION of a lost connection, is judged by what the client had', async () => {
    const s = setup();
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.p');
    caller.send(callFrame(1, 'com.example.p'));
    const inv = (await callee.nextOf(MSG.INVOCATION))[1];
    caller.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    callee.send([MSG.YIELD, inv, {}, ['crossing']]); // written before the INTERRUPT reached it
    await s.clock.runUntilIdle();
    expect(callee.take((f) => f[0] === MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, inv, { mode: 'killnowait' }]);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled']);
    expect(s.router.violations).toEqual([]);
    // a second connection answering the first connection's INVOCATION (a stale id leaking across sessions)
    caller.send(callFrame(2, 'com.example.p'));
    const stale = (await callee.nextOf(MSG.INVOCATION))[1];
    const next = await s.join();
    next.send([MSG.YIELD, stale, {}]);
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual(['YIELD for an INVOCATION this session never received']);
    expect(caller.pending).toEqual([]);
  });

  test('binary frames are decoded as UTF-8 JSON; invalid UTF-8 is a violation', async () => {
    const { s, peer } = await session();
    peer.ws.send(new TextEncoder().encode(JSON.stringify([MSG.SUBSCRIBE, 1, {}, 'com.example.t'])));
    peer.ws.send(new Uint8Array([0xff, 0xfe]));
    await s.clock.runUntilIdle();
    expect(peer.pending.map((f) => f[0])).toEqual([MSG.SUBSCRIBED]);
    expect(s.router.violations.map((v) => [v.rule, v.frame.frame])).toEqual([
      ['the frame is not a JSON array', '[binary frame of 2 bytes, not UTF-8]'],
    ]);
  });
});

describe('views, hooks and errors', () => {
  test('connections and sessions are live views: state, phase, session, subscriptions, registrations, calls, invocations', async () => {
    const s = setup();
    s.router.procedure('com.example.never', () => new Promise(() => undefined));
    const callee = await s.join();
    const caller = await s.join();
    await callee.register('com.example.p');
    await callee.subscribe('com.example.t');
    caller.send(callFrame(caller.id(), 'com.example.never'));
    caller.send(callFrame(caller.id(), 'com.example.p'));
    await callee.nextOf(MSG.INVOCATION);
    const [c1, c2] = s.router.connections;
    expect([c1!.number, c1!.state, c1!.phase, c1!.url, c1!.protocols, c1!.owner]).toEqual([
      1,
      'open',
      'established',
      s.router.url,
      ['wamp.2.json'],
      undefined,
    ]);
    expect(c1!.socket.controls).toBe(c1!.controls);
    expect(c1!.session).toEqual(
      expect.objectContaining({
        registrations: [{ id: expect.any(Number) as unknown, procedure: 'com.example.p', match: 'exact' }],
        invocations: 1,
        calls: 0,
      }),
    );
    expect(c2!.session).toEqual(expect.objectContaining({ calls: 2, invocations: 0, subscriptions: [] }));
    expect(s.router.connections[0]).toBe(c1); // the same live view every time
    callee.ws.close(1000);
    caller.ws.close(1000);
    await s.clock.runUntilIdle();
    expect([c2!.state, c2!.phase]).toEqual(['closed', 'closed']);
    expect(c2!.session).toEqual(expect.objectContaining({ alive: false, calls: 0, invocations: 0 }));
    expect(c1!.session).toEqual(expect.objectContaining({ alive: false, subscriptions: [], invocations: 0 }));
    expect(s.router.sessions).toEqual([]);
    const fresh = s.peer();
    expect(s.router.connections[2]!.session).toBeUndefined();
    fresh.ws.close();
  });

  test('webSocketFor(owner) tags the connections it makes', async () => {
    const s = setup();
    const WS = s.router.webSocketFor('client-7');
    const peer = new WampPeer(WS, s.router.url, () => s.clock.runUntilIdle());
    await peer.join();
    expect(s.router.connections.map((c) => c.owner)).toEqual(['client-7']);
  });

  test('observeFrames sees every record with its connection; a throwing listener lands in errors; unsubscribe works', async () => {
    const s = setup();
    const seen: string[] = [];
    const stop = s.router.observeFrames((record, connection) => {
      seen.push(`${String(connection.number)} ${record.direction} ${String((record.frame as Frame)[0])}`);
    });
    s.router.observeFrames(() => {
      throw new Error('observer bug');
    });
    const peer = await s.join();
    stop();
    await peer.subscribe('com.example.t');
    expect(seen).toEqual(['1 in 1', '1 out 2']);
    expect(s.router.errors.map(String)).toEqual([
      'Error: observer bug',
      'Error: observer bug',
      'Error: observer bug',
      'Error: observer bug',
    ]);
  });

  test('a client listener that throws is recorded in errors (and given to onError)', async () => {
    const onError = vi.fn();
    const s = setup({ onError });
    const peer = await s.join();
    peer.ws.addEventListener('message', () => {
      throw new Error('client bug');
    });
    await peer.subscribe('com.example.t');
    expect(s.router.errors.map(String)).toEqual(['Error: client bug']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('a handler Observable whose teardown throws is reported to errors', async () => {
    const s = setup();
    s.router.procedure(
      'com.example.p',
      () =>
        new RxObservable(() => () => {
          throw new Error('teardown bug');
        }),
    );
    const peer = await s.join();
    const id = peer.id();
    peer.send(callFrame(id, 'com.example.p'));
    peer.send([MSG.CANCEL, id, { mode: 'killnowait' }]);
    await peer.nextOf(MSG.ERROR);
    expect(s.router.errors.map(String)).toEqual([expect.stringContaining('Error: teardown bug')]);
  });

  test('sendRaw writes text to every open connection; frames records it as text when it is not a JSON array', async () => {
    const s = setup();
    const peer = await s.join();
    s.router.sendRaw('garbage{');
    s.router.sendRaw('[36,1,1,{}]');
    await s.clock.runUntilIdle();
    expect(peer.raw).toEqual(['garbage{']);
    expect(peer.pending).toEqual([[36, 1, 1, {}]]);
    expect(s.router.frames.slice(-2).map((f) => f.frame)).toEqual(['garbage{', [36, 1, 1, {}]]);
  });

  test('with sync delivery a closing window collapses: the close event follows at once', () => {
    const router = createRouter({ delivery: 'sync' });
    const peer = new WampPeer(router.WebSocket, router.url, () => undefined);
    router.connections[0]!.controls.closingWindow(500);
    expect(peer.events).toEqual(['close:1000']);
  });

  test('a router task that throws (a clock whose setTimeout fails) is recorded in errors; the router keeps going', async () => {
    const real = createSimClock();
    let fail = false;
    const clock = {
      ...real.scope('broken'),
      setTimeout: (fn: () => void, ms: number) => {
        if (fail) throw new Error('clock broke');
        return real.setTimeout(fn, ms);
      },
    };
    const router = createRouter({ clock });
    const peer = new WampPeer(router.WebSocket, router.url, () => real.runUntilIdle());
    await peer.join();
    fail = true;
    router.publish('com.example.t');
    router.goodbye(); // sending the GOODBYE needs the clock: the task throws
    fail = false;
    expect(router.errors.map(String)).toEqual(['Error: clock broke']);
    router.drop();
    await real.runUntilIdle();
    expect(peer.closed?.code).toBe(1006);
  });

  test('an ABORT that reaches a client after its own GOODBYE changes nothing (it may not reply)', async () => {
    const s = setup();
    const peer = await s.join();
    peer.onFrame = (f) => {
      if (f[0] === MSG.ABORT) peer.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
      return false;
    };
    peer.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    s.router.abort(); // crosses the client's GOODBYE
    await s.clock.runUntilIdle();
    expect(s.router.violations.map((v) => v.rule)).toEqual(["GOODBYE after the client's GOODBYE"]);
  });

  test('without a clock FrameRecord.at is milliseconds since the router was created', () => {
    const router = createRouter({ delivery: 'sync' });
    const peer = new WampPeer(router.WebSocket, router.url, () => undefined);
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    for (const f of router.frames) expect(f.at >= 0 && f.at < 60000).toBe(true);
  });

  test('NEVER keeps a call in flight with no teardown error', async () => {
    const s = setup();
    s.router.procedure('com.example.never', () => NEVER);
    const peer = await s.join();
    peer.send(callFrame(peer.id(), 'com.example.never'));
    await s.clock.advance(60000);
    expect(peer.pending).toEqual([]);
    expect(s.router.sessions[0]!.calls).toBe(1);
  });
});
