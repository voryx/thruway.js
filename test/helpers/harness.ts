// The deterministic-simulation harness: one virtual clock, the reference router in strict mode, a fake socket class per
// client and a Trace recorder per client. The client class is a parameter, so the same harness runs the real `Client`
// (test/sim/contract.test.ts) and the scripted stand-in of harness.test.ts.
//
//   const h = useHarness({ seed });                       // beforeEach: a fresh harness; afterEach: h.finish()
//   const c = h.current.makeClient(Client, { options: { authmethods: … } });
//   const call = c.observe('call', 'com.example.add', c.client.call('com.example.add', [1, 2]));
//   await h.current.clock.advance(10);
//
// Any router option goes through `router`, a dialect included: `useHarness({ router: { dialect: 'thruway-php',
// providers: [...] } })`; `h.current.router.quirks` holds the flags in effect, `heal()` is the model's healing.
//
// Wiring per client: `WebSocket` = the router's class tagged with the client's index (so its connections are known),
// `clock` = its own scope ('client', then 'client-2', …: shared time, separate timer counts), `logger` = the recorder
// (chained to the test's own logger), and the recorder's `CoreTraceSink` under `trace` in the internal option
// (`Symbol.for('thruway.js.internal')`), so the core can report steps and deliveries. `finish()` is the afterEach:
// `close()` every client, run the clock until idle, await every `close()` promise, then require zero armed timers in
// every client scope (router timers do not count), no router violations, no unscripted traffic (strict mode), no errors
// recorded by the router, no listener left on any client socket (the adapter's permanent `error` guard excepted), and
// no `internal` log entry (a contained client bug).
import { afterEach, beforeEach } from 'vitest';
import {
  createSimClock,
  createSimRouter,
  type SimClock,
  type SimClockScope,
  type SimConnection,
  type SimRouter,
  type SimRouterOptions,
} from '../../src/testing/sim.js';
import type {
  ClientOptions,
  CloseInfo,
  Input,
  LogEntry,
  Observer,
  Session,
  Status,
  WebSocketConstructorLike,
} from '../../src/types.js';
import { type Recorded, type SubscribableLike, TraceRecorder, TraceSequence } from './trace.js';
import type { Trace, TraceStream } from './trace-types.js';

/** The internal option key (src/options.ts `INTERNAL_OPTIONS`; the client accepts `trace` there). */
export const INTERNAL_OPTIONS_KEY: symbol = Symbol.for('thruway.js.internal');
const FAULTS_HOOK: symbol = Symbol.for('thruway.js.faults');
const DEBUG_HOOK: symbol = Symbol.for('thruway.js.debug');

/** What the harness needs of a client (the real `Client` has it all). */
export interface HarnessClient {
  readonly status: SubscribableLike<Status>;
  readonly onOpen: SubscribableLike<Session>;
  readonly onClose: SubscribableLike<CloseInfo>;
  open(): void;
  close(): Promise<void>;
  reconnect(): void;
}

export type ClientConstructor<C extends HarnessClient> = new (
  url: string | (() => Input<string>),
  realm: string,
  options?: ClientOptions,
) => C;

export interface HarnessOptions {
  /** The run's seed (clock PRNG streams; printed with every problem) [1]. */
  readonly seed?: number;
  /** Initial virtual time [0]. */
  readonly start?: number;
  readonly tieOrder?: 'frames-first' | 'timers-first';
  /** Router options (its clock is the harness clock's 'router' scope). Strict by default. */
  readonly router?: Omit<SimRouterOptions, 'clock'>;
  /** Which `finish()` checks run [all true]. */
  readonly checks?: {
    readonly unscripted?: boolean;
    readonly violations?: boolean;
    readonly routerErrors?: boolean;
    readonly internalLogs?: boolean;
  };
}

export interface ClientSetup {
  readonly realm?: string; // ['realm1']
  readonly url?: string | (() => Input<string>); // [router.url]
  /** Merged over the harness wiring; `WebSocket` and `clock` may be replaced, `logger` is chained. */
  readonly options?: ClientOptions;
  /** Clock scope name ['client', then 'client-2', …]. */
  readonly scope?: string;
  /** Record `status`, `onOpen` and `onClose` from construction on [true]. */
  readonly lifecycle?: boolean;
}

export interface SimClient<C extends HarnessClient> {
  readonly client: C;
  /** 1-based, in creation order; also the owner tag of its connections. */
  readonly index: number;
  readonly scope: SimClockScope;
  readonly recorder: TraceRecorder;
  readonly WebSocket: WebSocketConstructorLike;
  /** This client's connections, oldest first. */
  readonly connections: readonly SimConnection[];
  /** The last of them (throws when there is none). */
  readonly connection: SimConnection;
  /** Lifecycle recordings (undefined with `lifecycle: false`). */
  readonly status: Recorded<Status> | undefined;
  readonly onOpen: Recorded<Session> | undefined;
  readonly onClose: Recorded<CloseInfo> | undefined;
  /** A snapshot of this client's trace. */
  trace(): Trace;
  open(): void;
  reconnect(): void;
  /** `client.close()`, recorded (and its resolution). */
  close(): Promise<void>;
  /** Subscribe through a recording observer (`forward` gets every notification too). */
  observe<T>(
    stream: TraceStream,
    uri: string | undefined,
    source: SubscribableLike<T>,
    forward?: Partial<Observer<T>>,
  ): Recorded<T>;
  /** `close()`, run the clock until idle, await the close promise. */
  settle(): Promise<void>;
  /** `client[Symbol.for('thruway.js.faults')]`, if the client has one. */
  readonly faults: unknown;
  /** `client[Symbol.for('thruway.js.debug')]()`, if the client has one. */
  debug(): unknown;
}

export interface Harness {
  readonly seed: number;
  readonly clock: SimClock;
  readonly router: SimRouter;
  readonly clients: readonly SimClient<HarnessClient>[];
  makeClient<C extends HarnessClient>(Ctor: ClientConstructor<C>, setup?: ClientSetup): SimClient<C>;
  /** `close()` every client, run the clock until idle and await every close promise; throws if one never resolves. */
  closeAndSettle(): Promise<void>;
  /** The harness checks (see the file comment); empty when the run is clean. */
  problems(): readonly string[];
  /** `closeAndSettle()`, then throw an Error listing `problems()` (with the seed) if there are any. */
  finish(): Promise<void>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const seed = options.seed ?? 1;
  const clock = createSimClock({
    seed,
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.tieOrder === undefined ? {} : { tieOrder: options.tieOrder }),
  });
  const router = createSimRouter({ ...options.router, clock: clock.scope('router') });
  const sequence = new TraceSequence();
  const clients: SimClient<HarnessClient>[] = [];
  const recorders = new Map<unknown, TraceRecorder>();
  router.observeFrames((record, connection, data) => {
    recorders.get(connection.owner)?.frame(record, data);
  });
  clock.observe((event) => {
    for (const recorder of recorders.values()) recorder.timer(event);
  });
  const checks = { unscripted: true, violations: true, routerErrors: true, internalLogs: true, ...options.checks };

  function makeClient<C extends HarnessClient>(Ctor: ClientConstructor<C>, setup: ClientSetup = {}): SimClient<C> {
    const index = clients.length + 1;
    const scope = clock.scope(setup.scope ?? (index === 1 ? 'client' : `client-${String(index)}`));
    const recorder = new TraceRecorder({ source: 'sim', seed, now: () => clock.now(), sequence });
    recorders.set(index, recorder);
    const WebSocket = router.webSocketFor(index);
    const userLogger = setup.options?.logger;
    const userInternal = (setup.options as Record<symbol, unknown> | undefined)?.[INTERNAL_OPTIONS_KEY];
    const clientOptions = {
      WebSocket,
      clock: scope,
      ...setup.options,
      logger: (entry: LogEntry) => {
        recorder.log(entry);
        userLogger?.(entry);
      },
      [INTERNAL_OPTIONS_KEY]: { ...(userInternal as object | undefined), trace: recorder.sink },
    } as ClientOptions;
    const client = new Ctor(setup.url ?? router.url, setup.realm ?? 'realm1', clientOptions);
    const lifecycle = setup.lifecycle !== false;
    const own = (): readonly SimConnection[] => router.connections.filter((c) => c.owner === index);
    const sim: SimClient<C> = {
      client,
      index,
      scope,
      recorder,
      WebSocket,
      get connections() {
        return own();
      },
      get connection() {
        const all = own();
        const last = all[all.length - 1];
        if (last === undefined) throw new Error(`client ${String(index)} has no connection yet`);
        return last;
      },
      status: lifecycle ? recorder.observe('status', undefined, client.status) : undefined,
      onOpen: lifecycle ? recorder.observe('onOpen', undefined, client.onOpen) : undefined,
      onClose: lifecycle ? recorder.observe('onClose', undefined, client.onClose) : undefined,
      trace: () => recorder.trace(),
      open: () => {
        recorder.api('open');
        client.open();
      },
      reconnect: () => {
        recorder.api('reconnect');
        client.reconnect();
      },
      close: () => {
        recorder.api('close');
        return client.close().then(() => {
          recorder.api('close', true);
        });
      },
      observe: (stream, uri, source, forward) => recorder.observe(stream, uri, source, forward),
      settle: async () => {
        await settleAll([sim]);
      },
      get faults() {
        return (client as unknown as Record<symbol, unknown>)[FAULTS_HOOK];
      },
      debug: () => {
        const hook = (client as unknown as Record<symbol, unknown>)[DEBUG_HOOK];
        return typeof hook === 'function' ? (hook as (this: unknown) => unknown).call(client) : undefined;
      },
    };
    clients.push(sim);
    return sim;
  }

  async function settleAll(targets: readonly SimClient<HarnessClient>[]): Promise<void> {
    const pending = targets.map((c) => {
      const state = { done: false };
      const promise = c.close().then(() => {
        state.done = true;
      });
      return { c, state, promise };
    });
    await clock.runUntilIdle();
    const stuck = pending.filter((p) => !p.state.done).map((p) => p.c.index);
    if (stuck.length > 0) {
      throw new Error(
        `seed ${String(seed)}: close() of client ${stuck.join(', ')} did not resolve once the clock was idle`,
      );
    }
    await Promise.all(pending.map((p) => p.promise));
  }

  function problems(): readonly string[] {
    const out: string[] = [];
    for (const c of clients) {
      if (c.scope.pendingTimers > 0) {
        out.push(
          `client ${String(c.index)}: ${String(c.scope.pendingTimers)} timer(s) still armed in scope '${c.scope.name}'`,
        );
      }
      for (const connection of c.connections) {
        const count = connection.controls.listenerCount;
        if (count > 0) {
          out.push(
            `client ${String(c.index)}: socket ${String(connection.number)} still has ${String(count)} listener(s) ${JSON.stringify(connection.controls.listeners)}`,
          );
        }
      }
      if (checks.internalLogs) {
        for (const log of c.trace().logs) {
          if (log.entry.event === 'internal')
            out.push(`client ${String(c.index)}: internal error logged: ${log.entry.message}`);
        }
      }
    }
    if (checks.violations) {
      for (const v of router.violations)
        out.push(`router violation on socket ${String(v.frame.connection)}: ${v.rule} ${describe(v.frame.frame)}`);
    }
    if (checks.unscripted) {
      for (const f of router.unscripted)
        out.push(`unscripted traffic on socket ${String(f.connection)}: ${describe(f.frame)}`);
    }
    if (checks.routerErrors) {
      for (const e of router.errors) out.push(`router error: ${String(e instanceof Error ? e.stack : e)}`);
    }
    for (const e of clock.errors) out.push(`clock observer error: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  return {
    seed,
    clock,
    router,
    clients,
    makeClient,
    closeAndSettle: () => settleAll(clients),
    problems,
    finish: async () => {
      await settleAll(clients);
      const found = problems();
      if (found.length > 0) throw new Error(`seed ${String(seed)}: the run is not clean:\n  ${found.join('\n  ')}`);
    },
  };
}

/**
 * The same settling for one client outside a harness: `const p = client.close(); await clock.runUntilIdle(); await p` —
 * but a close() that has not resolved once the clock is idle throws instead of hanging the test.
 */
export async function closeAndSettle(
  client: Pick<HarnessClient, 'close'>,
  clock: Pick<SimClock, 'runUntilIdle'>,
): Promise<void> {
  const state = { done: false };
  const promise = client.close().then(() => {
    state.done = true;
  });
  await clock.runUntilIdle();
  if (!state.done) throw new Error('closeAndSettle: close() did not resolve once the clock was idle');
  await promise;
}

function describe(frame: readonly unknown[] | string): string {
  const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** A fresh harness per test (`beforeEach`) and `finish()` after it (`afterEach`). */
export function useHarness(options?: HarnessOptions): { readonly current: Harness } {
  let current: Harness | undefined;
  beforeEach(() => {
    current = createHarness(options);
  });
  afterEach(async () => {
    const harness = current;
    current = undefined;
    await harness?.finish(); // undefined only if beforeEach failed (bad options)
  });
  return {
    get current() {
      if (current === undefined) throw new Error('useHarness: only available inside a test');
      return current;
    },
  };
}
