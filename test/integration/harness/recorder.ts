// The client side of every integration test: `itClient()` builds a real `Client` against a real router with the fast
// profile, a recording WebSocket and a Trace recorder (test/helpers/trace.ts, real time), and registers it, so the
// `afterEach` of harness/setup.ts closes it, checks its trace and hands the trace to every registered checker (the
// INV-* invariants, see `registerTraceChecker`).
//
//   const c = itClient(r);                               // r: a Router from harness/routers.ts
//   const result = await firstValue(c.client.call('com.x.add', [1, 2]));
//   await c.opened();
import { Client } from '../../../src/index.js';
import type { CoreDebugInfo } from '../../../src/core/machine.js';
import type {
  ClientOptions,
  CloseInfo,
  Input,
  LogEntry,
  Observer,
  Session,
  Status,
  WebSocketConstructorLike,
  WebSocketLike,
} from '../../../src/types.js';
import { type OpInfo, registerKey, topicKey } from '../../helpers/invariants.js';
import { type Recorded, type SubscribableLike, TraceRecorder, TraceSequence } from '../../helpers/trace.js';
import type { Trace, TraceStream } from '../../helpers/trace-types.js';
import { type ClientProfile, StreamingChecks } from './checks.js';
import type { Router } from './routers.js';

const INTERNAL = Symbol.for('thruway.js.internal');
const DEBUG = Symbol.for('thruway.js.debug');

/** The timings the INV-* checkers read (test/helpers/invariants.ts `Timings`). */
const TIMING_KEYS: ReadonlySet<string> = new Set([
  'connect',
  'handshake',
  'request',
  'idle',
  'ping',
  'stable',
  'goodbye',
  'settle',
  'attemptFloor',
  'maxRetryDelay',
]);

/** The internal timings of the fast profile: ping 1 s, lingering GOODBYE wait 1 s, attempt floor 100 ms. */
export const FAST_INTERNAL = { ping: 1000, goodbye: 1000, attemptFloor: 100 } as const;
/** The public options of the fast profile: request 2 s, idle 1 s, retry 100 ms … 1 s. */
export const FAST_OPTIONS = {
  retryOptions: { initialRetryDelay: 100, maxRetryDelay: 1000 },
  timeouts: { connect: 5000, handshake: 5000, request: 2000, idle: 1000 },
} as const satisfies ClientOptions;

export interface ItClientSetup {
  /** [the router's default endpoint] */
  readonly url?: string | (() => Input<string>);
  /** [the router's default realm] */
  readonly realm?: string;
  /** Merged over the fast profile (retryOptions and timeouts key by key). */
  readonly options?: ClientOptions;
  /** Internal timings merged over FAST_INTERNAL (`stable`, `settle`, …). */
  readonly internal?: Readonly<Record<string, number>>;
  /** The WebSocket implementation under the recorder [globalThis.WebSocket]. */
  readonly WebSocket?: WebSocketConstructorLike;
  /** Shown in problems [client-<n>]. */
  readonly name?: string;
  /** 'full' [default]: a Trace with every frame, step and delivery (checked after the test). 'online': frames go
   *  through the bounded StreamingChecks as they happen and only the lifecycle streams are kept (soak runs). */
  readonly record?: 'full' | 'online';
}

export interface SocketRecord {
  readonly connection: number;
  readonly url: string;
  opened: boolean;
  closed: { readonly code: number; readonly reason: string } | undefined;
  /** The client called close() (or terminate()) on it. */
  released: boolean;
}

export interface ItClient {
  readonly client: Client;
  readonly name: string;
  readonly router: Router | undefined;
  readonly recorder: TraceRecorder;
  readonly sockets: readonly SocketRecord[];
  readonly status: Recorded<Status>;
  readonly onOpen: Recorded<Session>;
  readonly onClose: Recorded<CloseInfo>;
  readonly logs: readonly LogEntry[];
  readonly requestIds: 'random' | 'sequential';
  /** Timings and retry settings in force (for the INV-* checkers, harness/setup.ts). */
  readonly profile: ClientProfile;
  /** Observer id → its kind and key (with options) for the topics and registrations observed through `observe`
   *  straight from `client.topic`/`client.register` (the INV-* checkers key interests by them, harness/setup.ts). */
  readonly ops: ReadonlyMap<number, OpInfo>;
  /** The online checks of a client recorded with `record: 'online'` (undefined for full traces). */
  readonly online: StreamingChecks | undefined;
  /** Set by tests that leave a peer frozen on purpose (the afterEach then does not wait for the sockets to close). */
  allowOpenSockets: boolean;
  trace(): Trace;
  observe<T>(
    stream: TraceStream,
    uri: string | undefined,
    source: SubscribableLike<T>,
    forward?: Partial<Observer<T>>,
  ): Recorded<T>;
  open(): void;
  reconnect(): void;
  /** `client.close()`, recorded; resolves when the client's close() resolves. */
  close(): Promise<void>;
  debug(): CoreDebugInfo;
  /** Resolves with the session once status is open (now or later), or rejects after `ms`. */
  opened(ms?: number): Promise<Session>;
  /** Log entries with this event name. */
  logged(event: string): readonly LogEntry[];
  /** The number of sockets currently open (opened and not closed). */
  openSockets(): number;
  /** Open sockets the client never closed (a leak by the client). */
  unreleasedSockets(): number;
  /** The number of ends (onClose values) so far — also with online recording, which keeps only the last few. */
  ends(): number;
}

/** Every client created in the current test (harness/setup.ts closes and checks them). */
export const liveClients = new Set<ItClient>();
const sequence = new TraceSequence();
let counter = 0;

/** A WebSocket class that records every frame of its connections (in = client → router) and their lifecycle. */
function recordingWebSocket(
  base: WebSocketConstructorLike,
  onFrame: (connection: number, direction: 'in' | 'out', data: unknown) => void,
  sockets: SocketRecord[],
): WebSocketConstructorLike {
  let connections = 0;
  class RecordingWebSocket {
    static readonly OPEN = base.OPEN;
    private readonly inner: WebSocketLike;
    constructor(url: string, protocols?: string | string[]) {
      this.inner = new base(url, protocols);
      const record: SocketRecord = {
        connection: ++connections,
        url,
        opened: false,
        closed: undefined,
        released: false,
      };
      this.record = record;
      sockets.push(record);
      // registered before the client's own listeners: a frame is recorded before the client processes it
      this.inner.addEventListener('message', (event) => {
        onFrame(record.connection, 'out', event.data);
      });
      this.inner.addEventListener('open', () => {
        record.opened = true;
      });
      this.inner.addEventListener('close', (event) => {
        record.closed = { code: event.code, reason: event.reason };
      });
      this.inner.addEventListener('error', () => {
        record.closed ??= { code: 1006, reason: 'error' };
      });
      this.connection = record.connection;
    }
    readonly connection: number;
    private readonly record: SocketRecord;
    get readyState(): number {
      return this.inner.readyState;
    }
    get protocol(): string {
      return this.inner.protocol;
    }
    get bufferedAmount(): number {
      return this.inner.bufferedAmount ?? 0;
    }
    get binaryType(): string {
      return this.inner.binaryType;
    }
    set binaryType(value: string) {
      this.inner.binaryType = value;
    }
    get terminate(): (() => void) | undefined {
      const inner = this.inner;
      const record = this.record;
      return inner.terminate === undefined
        ? undefined
        : () => {
            record.released = true;
            inner.terminate?.();
          };
    }
    send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void {
      if (this.inner.readyState === base.OPEN) onFrame(this.connection, 'in', data);
      this.inner.send(data);
    }
    close(code?: number, reason?: string): void {
      this.record.released = true;
      this.inner.close(code, reason);
    }
    addEventListener(type: 'open' | 'error' | 'message' | 'close', listener: (ev: never) => void): void {
      (this.inner.addEventListener as (t: string, l: unknown) => void)(type, listener);
    }
    removeEventListener(type: 'open' | 'error' | 'message' | 'close', listener: (ev: never) => void): void {
      (this.inner.removeEventListener as (t: string, l: unknown) => void)(type, listener);
    }
  }
  return RecordingWebSocket as unknown as WebSocketConstructorLike;
}

function text(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return undefined;
}

function decode(data: string): readonly unknown[] | string {
  try {
    const value: unknown = JSON.parse(data);
    return Array.isArray(value) ? (value as readonly unknown[]) : data;
  } catch {
    return data;
  }
}

/** A real Client against `r` (or any URL with `setup.url`), recorded and registered for the afterEach checks. */
export function itClient(r: Router | undefined, setup: ItClientSetup = {}): ItClient {
  const name = setup.name ?? `client-${String(++counter)}`;
  const started = performance.now();
  const recorder = new TraceRecorder({ source: 'real-router', now: () => performance.now() - started, sequence });
  const sockets: SocketRecord[] = [];
  const logs: LogEntry[] = [];
  const base = setup.WebSocket ?? globalThis.WebSocket;
  const user = setup.options ?? {};
  const online = setup.record === 'online' ? new StreamingChecks(name, user.requestIds ?? 'random') : undefined;
  const WebSocket = recordingWebSocket(
    base,
    (connection, direction, data) => {
      const raw = text(data);
      if (raw === undefined) return;
      const frame = decode(raw);
      if (online !== undefined) online.frame({ connection, direction, frame });
      else recorder.frame({ connection, direction, frame, at: performance.now() - started }, raw);
    },
    sockets,
  );
  const userLogger = user.logger;
  const options: ClientOptions = {
    ...user,
    retryOptions: { ...FAST_OPTIONS.retryOptions, ...user.retryOptions },
    timeouts: { ...FAST_OPTIONS.timeouts, ...user.timeouts },
    WebSocket,
    logger: (entry) => {
      if (online === undefined) {
        logs.push(entry);
        recorder.log(entry);
      } else {
        online.log(entry);
        // without `data`: it holds CloseInfos and errors, whose captured stack frames keep released connections
        // (and their sockets) alive — a long run would measure the harness, not the client
        if (entry.level !== 'debug') logs.push({ level: entry.level, event: entry.event, message: entry.message });
        if (logs.length > 200) logs.splice(0, 100);
      }
      userLogger?.(entry);
    },
    [INTERNAL]: { ...FAST_INTERNAL, ...setup.internal, ...(online === undefined ? { trace: recorder.sink } : {}) },
  } as ClientOptions;
  const internal: Readonly<Record<string, number>> = { ...FAST_INTERNAL, ...setup.internal };
  const profile: ClientProfile = {
    timings: Object.fromEntries(
      Object.entries({ ...options.timeouts, maxRetryDelay: options.retryOptions?.maxRetryDelay, ...internal }).filter(
        ([k, v]) => TIMING_KEYS.has(k) && typeof v === 'number',
      ),
    ),
    maxRetries: options.retryOptions?.maxRetries,
    retryDelay: options.retryOptions?.retryDelay === undefined ? 'default' : 'custom-null',
    authmethods: options.authmethods,
  };
  const url = setup.url ?? r?.url;
  if (url === undefined) throw new Error('itClient: no router and no url');
  const realm = setup.realm ?? r?.realm ?? 'realm1';
  const client = new Client(url, realm, options);
  // The key of every topic/registration Observable the client hands out (no change to the Observable itself), so
  // `observe` can tell the checkers the key with its options (a `match`, `replace_orphaned_session`, …)
  const keys = new WeakMap<object, OpInfo>();
  const ops = new Map<number, OpInfo>();
  const topicOf = client.topic.bind(client);
  const registerOf = client.register.bind(client);
  Object.assign(client, {
    topic: (...args: Parameters<Client['topic']>) => {
      const source = topicOf(...args);
      keys.set(source, { kind: 'topic', key: topicKey(args[0], args[1] ?? {}) });
      return source;
    },
    register: (...args: Parameters<Client['register']>) => {
      const source = registerOf(...args);
      keys.set(source, { kind: 'register', key: registerKey(args[0], args[2] ?? {}) });
      return source;
    },
  });
  // online: the lifecycle values are kept in small windows, for the retention reason of the logs (a kept CloseInfo
  // keeps ≈ 26 KB reachable: windows of 50 grew a soak's heap until they were full); `ends()` counts all
  const status = online === undefined ? recorder.observe('status', undefined, client.status) : bounded(client.status);
  const onOpen = online === undefined ? recorder.observe('onOpen', undefined, client.onOpen) : bounded(client.onOpen);
  const onClose =
    online === undefined ? recorder.observe('onClose', undefined, client.onClose) : bounded(client.onClose);
  const it: ItClient = {
    client,
    name,
    router: r,
    recorder,
    sockets,
    status,
    onOpen,
    onClose,
    logs,
    requestIds: user.requestIds ?? 'random',
    profile,
    ops,
    online,
    allowOpenSockets: false,
    trace: () => recorder.trace(),
    observe: (stream, uri, source, forward) => {
      const recorded = recorder.observe(stream, uri, source, forward);
      const info = keys.get(source);
      if (info !== undefined) ops.set(recorded.id, info);
      return recorded;
    },
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
    debug: () => (client as unknown as Record<symbol, () => CoreDebugInfo>)[DEBUG]!.call(client),
    opened: (ms = 15000) =>
      new Promise<Session>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error(`${name}: not open within ${String(ms)} ms (status ${JSON.stringify(statusText(it))})`));
        }, ms);
        const sub = client.onOpen.subscribe((session) => {
          clearTimeout(timer);
          queueMicrotask(() => {
            sub.unsubscribe();
          });
          resolve(session);
        });
      }),
    logged: (event) => logs.filter((l) => l.event === event),
    openSockets: () => sockets.filter((s) => s.opened && s.closed === undefined).length,
    unreleasedSockets: () => sockets.filter((s) => s.opened && s.closed === undefined && !s.released).length,
    ends: () => (onClose as Partial<{ count: number }>).count ?? onClose.values.length,
  };
  liveClients.add(it);
  return it;
}

/** Read `.stack` along the error chain of a kept CloseInfo (or of a closed status): until then V8 keeps the structured
 *  stack frames, and with them ≈ 26 KB of the released connection per CloseInfo (≈ 2.7 KB once formatted). */
function formatStacks(value: unknown): void {
  const v = value as { error?: unknown; closed?: { error?: unknown } } | null | undefined;
  let error: unknown = v?.error ?? v?.closed?.error;
  for (let depth = 0; depth < 5 && typeof error === 'object' && error !== null; depth++) {
    const { stack, cause } = error as { stack?: unknown; cause?: unknown };
    if (stack === undefined) break; // reading it is the point: it formats the frames
    error = cause;
  }
}

/** The values a recorded observer keeps with online recording; `count` counts them all. */
const ONLINE_WINDOW = 5;

/** A recorded observer that keeps only the last ONLINE_WINDOW values (online recording); `count` counts them all. */
function bounded<T>(source: SubscribableLike<T>): Recorded<T> & { readonly count: number } {
  const values: T[] = [];
  const state = { count: 0, error: undefined as unknown, errored: false, completed: false, unsubscribed: false };
  const subscription = source.subscribe({
    next: (value: T) => {
      state.count++;
      formatStacks(value);
      values.push(value);
      if (values.length > ONLINE_WINDOW) values.splice(0, values.length - ONLINE_WINDOW);
    },
    error: (error: unknown) => {
      state.error = error;
      state.errored = true;
    },
    complete: () => {
      state.completed = true;
    },
  });
  return {
    id: 0,
    values,
    get count() {
      return state.count;
    },
    get error() {
      return state.error;
    },
    get errored() {
      return state.errored;
    },
    get completed() {
      return state.completed;
    },
    get closed() {
      return state.errored || state.completed || state.unsubscribed;
    },
    unsubscribe: () => {
      state.unsubscribed = true;
      subscription.unsubscribe();
    },
  };
}

function statusText(c: ItClient): unknown {
  const last = c.status.values[c.status.values.length - 1];
  return last?.state === 'closed'
    ? { state: 'closed', error: last.closed?.error?.message, reason: last.closed?.reason }
    : last?.state;
}

/** Poll `check` every `step` ms until it returns true; rejects with `what` after `ms`. */
export async function eventually(check: () => boolean, ms: number, what: string, step = 20): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

/** The first value of an Observable, or reject with its error; rejects with a timeout error after `ms`. */
export function firstValue<T>(source: SubscribableLike<T>, ms = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      sub.unsubscribe();
      reject(new Error(`no value within ${String(ms)} ms`));
    }, ms);
    const sub = source.subscribe({
      next: (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => {
          sub.unsubscribe();
        });
        resolve(value);
      },
      error: (error: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('completed without a value'));
      },
    });
  });
}

/** Every value until completion (or reject on error / after `ms`). */
export function allValues<T>(source: SubscribableLike<T>, ms = 10000): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`not complete within ${String(ms)} ms (${String(values.length)} values)`));
    }, ms);
    const sub = source.subscribe({
      next: (value) => values.push(value),
      error: (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        clearTimeout(timer);
        resolve(values);
      },
    });
  });
}

/** The error an Observable ends with (rejects if it emits a value first, or completes). */
export function errorOf(source: SubscribableLike<unknown>, ms = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`no error within ${String(ms)} ms`));
    }, ms);
    const sub = source.subscribe({
      error: (error: unknown) => {
        clearTimeout(timer);
        resolve(error);
      },
      complete: () => {
        clearTimeout(timer);
        reject(new Error('completed instead of erroring'));
      },
    });
  });
}

/** A unique URI component per test run and call (`[a-z0-9_]`, valid on every router). */
export function unique(prefix = 't'): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** `com.thruwayjs.<area>.<unique>`: unique URIs per test (and per chaos schedule). */
export function uri(area: string): string {
  return `com.thruwayjs.${area}.${unique()}`;
}

/** Wait until a recorded observer has more than `count` values (default: its first); returns the value. */
export async function valueOf<T>(recorded: Recorded<T>, count = 0, ms = 10000): Promise<T> {
  await eventually(
    () => recorded.values.length > count || recorded.errored || recorded.completed,
    ms,
    `value #${String(count + 1)} of observer ${String(recorded.id)}`,
  );
  if (recorded.values.length <= count) {
    throw new Error(
      `observer ${String(recorded.id)} ended without value #${String(count + 1)}: ${String(recorded.error)}`,
    );
  }
  return recorded.values[count] as T;
}

/** Wait until a recorded observer errored; returns the error. */
export async function errorFrom(recorded: Recorded<unknown>, ms = 10000): Promise<unknown> {
  await eventually(() => recorded.errored || recorded.completed, ms, `error of observer ${String(recorded.id)}`);
  if (!recorded.errored) throw new Error(`observer ${String(recorded.id)} completed instead of erroring`);
  return recorded.error;
}
