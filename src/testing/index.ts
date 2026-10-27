/**
 * Public entry "thruway.js/testing": the narrow kit app tests need — an in-memory reference router and a virtual clock.
 * Everything else (dialects, faults, delivery control, skew/suspend, scopes) is the internal kit (`sim.ts`), never
 * reachable from `exports`.
 *
 * ```ts
 * const clock = createVirtualClock();
 * const router = createTestRouter({ clock });
 * router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
 * const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
 * await clock.advance(10);
 * ```
 *
 * @module
 */
import type { Clock, Input, WebSocketConstructorLike } from '../types.js';
import { createRouter } from './router.js';
import { createSimClock, linkSimClock } from './virtual-clock.js';

export interface VirtualClock extends Required<Clock> {
  /** Advance virtual time by `ms`, running due timers in (time, insertion) order, including ones they arm; microtasks
   *  are drained before and after each timer, so app Promises (challenge answers, handler results) settle in between,
   *  like vi.advanceTimersByTimeAsync. */
  advance(ms: number): Promise<void>;
  /** Advance until no timer is pending (limit [10 min virtual]). */
  runUntilIdle(limitMs?: number): Promise<void>;
  readonly pendingTimers: number;
}

/** A virtual clock for `ClientOptions.clock` and `TestRouterOptions.clock`. `start` is the initial `now()` [0];
 *  `seed` seeds `random()` (xorshift128+) [1], so a run is reproducible. Timer delays follow Node: NaN and negative
 *  delays are 0, delays above 2^31−1 fire after 1 ms. Its methods work detached (`const { now } = clock`). */
export function createVirtualClock(options?: { readonly start?: number; readonly seed?: number }): VirtualClock {
  const sim = createSimClock({
    ...(options?.start === undefined ? {} : { start: options.start }),
    ...(options?.seed === undefined ? {} : { seed: options.seed }),
  });
  const clock: VirtualClock = {
    now: () => sim.now(),
    setTimeout: (fn: () => void, ms: number) => sim.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => {
      sim.clearTimeout(handle);
    },
    random: () => sim.random(),
    advance: (ms: number) => sim.advance(ms),
    runUntilIdle: (limitMs?: number) => sim.runUntilIdle(limitMs),
    get pendingTimers() {
      return sim.pendingTimers;
    },
  };
  linkSimClock(clock, sim);
  return Object.freeze(clock);
}

export interface TestRouterOptions {
  /** With a clock, frames are delivered through it (advance the clock); without one, on the microtask queue. */
  readonly clock?: VirtualClock | undefined;
  /** Decide each HELLO. Default: WELCOME everyone (anonymous). */
  readonly authenticate?: ((hello: { realm: string; details: Record<string, unknown> }) => AuthDecision) | undefined;
}
export type AuthDecision =
  | { readonly welcome: Record<string, unknown> }
  | {
      readonly challenge: { method: string; extra?: Record<string, unknown> };
      readonly verify: (signature: string) => AuthDecision;
    }
  | { readonly abort: string; readonly details?: Record<string, unknown> };

export interface FrameRecord {
  readonly connection: number; // fake socket number, 1-based
  readonly direction: 'in' | 'out'; // 'in' = client → router
  readonly frame: readonly unknown[] | string; // decoded, or raw text if undecodable
  readonly at: number;
}
export interface TestRouter {
  readonly url: string; // 'memory://router/<n>'
  readonly WebSocket: WebSocketConstructorLike; // pass as ClientOptions.WebSocket
  readonly frames: readonly FrameRecord[];
  /** Script a procedure; the result/throw rules are listed below the declarations. */
  procedure(
    uri: string,
    fn: (args: unknown[], kwargs: Record<string, unknown>, details: Record<string, unknown>) => Input<unknown>,
  ): void;
  publish(topic: string, args?: unknown[], kwargs?: Record<string, unknown>): void;
  drop(code?: number): void; // abrupt close of every open connection [1006]
  goodbye(reason?: string, details?: Record<string, unknown>): void;
  abort(reason?: string, details?: Record<string, unknown>): void;
  close(): void; // closes every socket, rejects new ones
}

/**
 * An in-memory WAMP router (realms, broker, dealer) whose `WebSocket` connects to it. `procedure(uri, fn)` scripts a
 * procedure: `fn(args, kwargs, details)` runs once per CALL (`details` is the CALL's Options dict) and its result is
 * converted like a callee result — a value or a Promise of one becomes the RESULT (`undefined` ⇒ no args, a `Yield` ⇒
 * its args/kwargs, anything else ⇒ args `[value]`); an Observable's values are progress RESULTs when the CALL asked
 * `receive_progress` (otherwise only the last value is sent) and its completion sends the final RESULT; a thrown,
 * rejected or errored `WampError` (either package copy) becomes `ERROR` with its uri/args/kwargs/details, anything
 * else `ERROR wamp.error.runtime_error [message]`; a CALL to a URI without a handler (the client's liveness probe
 * `thruway.js.ping` included) gets `wamp.error.no_such_procedure`; a result that never settles keeps the call in
 * flight; a CANCEL unsubscribes the handler's result and is answered `wamp.error.canceled`. A second `procedure()`
 * for a URI replaces its handler. Clients can also REGISTER procedures and SUBSCRIBE/PUBLISH among themselves.
 *
 * An `authenticate` hook that throws ABORTs that handshake with `wamp.error.authorization_failed`; the error is
 * rethrown as an unhandled rejection, so the test runner reports it.
 */
export function createTestRouter(options?: TestRouterOptions): TestRouter {
  const router = createRouter({
    clock: options?.clock,
    authenticate: options?.authenticate,
    onError: (error) => {
      void Promise.reject(
        error instanceof Error ? error : Object.assign(new Error('a non-Error was thrown'), { cause: error }),
      );
    },
  });
  return Object.freeze({
    url: router.url,
    WebSocket: router.WebSocket,
    get frames() {
      return router.frames;
    },
    procedure: (uri: string, fn: Parameters<TestRouter['procedure']>[1]) => {
      router.procedure(uri, fn);
    },
    publish: (topic: string, args?: unknown[], kwargs?: Record<string, unknown>) => {
      router.publish(topic, args, kwargs);
    },
    drop: (code?: number) => {
      router.drop(code);
    },
    goodbye: (reason?: string, details?: Record<string, unknown>) => {
      router.goodbye(reason, details);
    },
    abort: (reason?: string, details?: Record<string, unknown>) => {
      router.abort(reason, details);
    },
    close: () => {
      router.close();
    },
  });
}
