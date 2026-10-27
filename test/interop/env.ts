// The interop suites' environment: real Clients against the reference router, both driven by vitest's fake timers, so
// the client's timers, its clock (`performance.now`) and every Rx library's schedulers (setTimeout / setInterval) share
// one virtual time. The router delivers frames on the microtask queue, which `vi.advanceTimersByTimeAsync` drains
// between timers.
//
//   const env = useInteropEnv();                     // beforeEach: fake timers + a router; afterEach: the checks
//   const client = env.current.client();             // a Client on that router (autoOpen)
//   await env.current.advance(10);
//
// afterEach closes every client, lets the GOODBYEs settle, then requires: no timer left (client or Rx), no router
// violation of the client's side of the protocol, no test-code error recorded by the router, and no contained internal
// client error (`internal` log entry).
import { from, type Observable as RxObservable, type ObservableInput } from 'rxjs';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { createSimRouter, type SimRouter, type SimRouterOptions } from '../../src/testing/sim.js';
import type { ClientOptions, Input, LogEntry } from '../../src/types.js';

export interface InteropEnv {
  readonly router: SimRouter;
  /** Every log entry of every client made here (each client logs here unless its options replace the logger). */
  readonly logs: LogEntry[];
  /** A Client on the router (realm1); `url` replaces the router URL (a resolver, say). */
  client(options?: ClientOptions, url?: string | (() => Input<string>)): Client;
  advance(ms: number): Promise<void>;
  /** Decoded frames the clients wrote, oldest first; only those of message type `type` when given. */
  written(type?: number): unknown[][];
  /** The `unhandled` log entries (throwing observers, errors nobody handled). */
  unhandled(): LogEntry[];
}

export function useInteropEnv(routerOptions: Omit<SimRouterOptions, 'clock'> = {}): { readonly current: InteropEnv } {
  let current: InteropEnv | undefined;
  let clients: Client[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    const router = createSimRouter({ strict: false, ...routerOptions });
    const logs: LogEntry[] = [];
    clients = [];
    current = {
      router,
      logs,
      client(options = {}, url = router.url) {
        const client = new Client(url, 'realm1', {
          WebSocket: router.WebSocket,
          logger: (entry) => logs.push(entry),
          ...options,
        });
        clients.push(client);
        return client;
      },
      advance: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
      written: (type) =>
        router.frames
          .filter((f) => f.direction === 'in' && Array.isArray(f.frame) && (type === undefined || f.frame[0] === type))
          .map((f) => f.frame as unknown[]),
      unhandled: () => logs.filter((entry) => entry.event === 'unhandled'),
    };
  });
  afterEach(async () => {
    const env = current;
    current = undefined;
    if (env === undefined) return;
    try {
      const closing = Promise.all(clients.map((client) => client.close()));
      await vi.advanceTimersByTimeAsync(10000); // GOODBYE replies, lingering sockets
      await closing;
      expect(vi.getTimerCount(), 'timers left after close()').toBe(0);
      expect(env.router.violations, 'router violations').toEqual([]);
      expect(env.router.errors, 'test-code errors').toEqual([]);
      expect(env.logs.filter((entry) => entry.event === 'internal')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  return {
    get current(): InteropEnv {
      if (current === undefined) throw new Error('useInteropEnv: only inside a test');
      return current;
    },
  };
}

/** WAMP message types the tests look for. */
export const T = {
  HELLO: 1,
  AUTHENTICATE: 5,
  ERROR: 8,
  PUBLISH: 16,
  SUBSCRIBE: 32,
  UNSUBSCRIBE: 34,
  CALL: 48,
  CANCEL: 49,
  REGISTER: 64,
  UNREGISTER: 66,
  YIELD: 70,
} as const;

/** The CALLs of `procedure` the clients wrote. */
export function calls(env: InteropEnv, procedure: string): unknown[][] {
  return env.written(T.CALL).filter((f) => f[3] === procedure);
}

/** A Promise that never settles (a call that is never answered). */
export const never = (): Promise<never> => new Promise<never>(() => undefined);

/** RxJS 7's `from`, as apps hand it to `rxClient(client, from)`: the same function. typescript-eslint reports a bare
 *  `from` reference as from's deprecated scheduler overload, so the tests pass this alias. */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- only the scheduler overload is deprecated
export const rxjsFrom: <V>(input: ObservableInput<V>) => RxObservable<V> = from;
