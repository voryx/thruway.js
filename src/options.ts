/**
 * Client option defaults, validation and normalisation: `TypeError` with the option path on invalid values; keys set to
 * `undefined` mean "default"; frozen copies, never mutating the caller's objects.
 *
 * Each app property is read once. `authmethods`, `authid` and `authextra` may instead be functions: `helloAuth()` calls
 * them for every attempt's HELLO. Unknown keys are ignored (the HELLO only ever carries those three).
 *
 * @module
 */
import { systemClock } from './core/clock.js';
import type { TraceSink } from './core/loop.js';
import { isPlainObject } from './protocol/payload.js';
import { isValidUri } from './protocol/uri.js';
import { jsonSerializer } from './transport/json.js';
import type {
  ChallengeMessage,
  Clock,
  Input,
  LogEntry,
  RetryOptions,
  Serializer,
  WebSocketConstructorLike,
} from './types.js';

/** Public option defaults. */
export const DEFAULTS = {
  autoOpen: true,
  requestIds: 'random',
  retryOptions: {
    initialRetryDelay: 1500,
    retryDelayGrowth: 1.5,
    maxRetryDelay: 60000,
    maxRetries: Number.POSITIVE_INFINITY,
  },
  timeouts: {
    connect: 10000,
    handshake: 15000,
    request: 60000,
    idle: 30000,
  },
} as const;

/** Internal constants that only the internal option may override (fast test profiles). */
export interface InternalTimings {
  /** Liveness ping budget base. */
  readonly ping: number;
  /** Stable-session window that resets the retry counter. */
  readonly stable: number;
  /** Lingering GOODBYE wait. */
  readonly goodbye: number;
  /** Challenge settle window. */
  readonly settle: number;
  /** Minimum time between the starts of app-driven attempts (`startSoon`). */
  readonly attemptFloor: number;
}
export const INTERNAL_DEFAULTS: InternalTimings = {
  ping: 20000,
  stable: 60000,
  goodbye: 2000,
  settle: 50,
  attemptFloor: 1000,
};

/** The symbol-keyed option overriding `InternalTimings` (`{[INTERNAL_OPTIONS]: {ping: 5}}`) and carrying the test
 *  harness's trace sink (`{trace}`, test/helpers/harness.ts); tests only. */
export const INTERNAL_OPTIONS: symbol = Symbol.for('thruway.js.internal');

/** The largest duration (setTimeout's limit). */
const MAX_DURATION = 2 ** 31 - 1;

/** Every option resolved: defaults applied, validated, frozen. */
export interface NormalizedOptions {
  readonly url: string | (() => Input<string>);
  readonly realm: string;
  /** A validated value, or the app's function (called by `helloAuth()`). */
  readonly authmethods: readonly string[] | (() => unknown);
  readonly authid: string | undefined | (() => unknown);
  readonly authextra: Readonly<Record<string, unknown>> | undefined | (() => unknown);
  readonly onChallenge: ((challenge: ChallengeMessage) => Input<string>) | undefined;
  readonly autoOpen: boolean;
  readonly retry: {
    readonly initialRetryDelay: number;
    readonly retryDelayGrowth: number;
    readonly maxRetryDelay: number;
    readonly maxRetries: number;
    readonly retryDelay: RetryOptions['retryDelay'];
  };
  readonly timeouts: {
    readonly connect: number;
    readonly handshake: number;
    readonly request: number;
    readonly idle: number;
  };
  readonly requestIds: 'random' | 'sequential';
  readonly WebSocket: WebSocketConstructorLike;
  readonly serializer: Serializer;
  readonly clock: Clock;
  /** The injected `clock.random` (seeds the request-id stream), or undefined for the system default. */
  readonly random: (() => number) | undefined;
  readonly logger: ((entry: LogEntry) => void) | undefined;
  readonly internal: InternalTimings;
  /** The test harness's step/delivery sink (internal option `trace`), or undefined. */
  readonly trace: TraceSink | undefined;
}

type Bag = Readonly<Record<PropertyKey, unknown>>;

/** `value` as an options object: undefined/null ⇒ `{}`; anything but a plain object ⇒ TypeError naming `path`. */
function bag(value: unknown, path: string): Bag {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Bag;
}

/** A function or undefined (the caller casts it to the option's type). */
function fn(value: unknown, path: string): unknown {
  if (value !== undefined && typeof value !== 'function') throw new TypeError(`${path} must be a function`);
  return value;
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

/** A duration: an integer in [min, 2^31−1]. */
function duration(value: unknown, path: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > MAX_DURATION) {
    const range = min === 0 ? 'a non-negative integer' : `an integer ≥ ${String(min)}`;
    throw new TypeError(`${path} must be ${range} (ms) and at most 2^31−1`);
  }
  return value;
}

function retryOptions(value: unknown): NormalizedOptions['retry'] {
  const r = bag(value, 'retryOptions');
  const d = DEFAULTS.retryOptions;
  const growth = r['retryDelayGrowth'];
  if (growth !== undefined && (typeof growth !== 'number' || !Number.isFinite(growth) || growth < 1)) {
    throw new TypeError('retryOptions.retryDelayGrowth must be a finite number ≥ 1');
  }
  const maxRetries = r['maxRetries'];
  if (
    maxRetries !== undefined &&
    (typeof maxRetries !== 'number' ||
      !(maxRetries === Number.POSITIVE_INFINITY || (Number.isInteger(maxRetries) && maxRetries >= 0)))
  ) {
    throw new TypeError(
      'retryOptions.maxRetries must be a non-negative integer or Infinity (use Infinity for unlimited retries)',
    );
  }
  return Object.freeze({
    initialRetryDelay: duration(r['initialRetryDelay'], 'retryOptions.initialRetryDelay', d.initialRetryDelay, 0),
    retryDelayGrowth: growth ?? d.retryDelayGrowth,
    maxRetryDelay: duration(r['maxRetryDelay'], 'retryOptions.maxRetryDelay', d.maxRetryDelay, 100),
    maxRetries: maxRetries ?? d.maxRetries,
    retryDelay: fn(r['retryDelay'], 'retryOptions.retryDelay') as RetryOptions['retryDelay'],
  });
}

function timeouts(value: unknown): NormalizedOptions['timeouts'] {
  const t = bag(value, 'timeouts');
  const d = DEFAULTS.timeouts;
  return Object.freeze({
    connect: duration(t['connect'], 'timeouts.connect', d.connect, 1),
    handshake: duration(t['handshake'], 'timeouts.handshake', d.handshake, 1),
    request: duration(t['request'], 'timeouts.request', d.request, 1),
    idle: duration(t['idle'], 'timeouts.idle', d.idle, 0),
  });
}

/** A function option as it is (called later), anything else through `check`. */
function orValue<T>(value: unknown, check: (value: unknown) => T): T | (() => unknown) {
  return typeof value === 'function' ? (value as () => unknown) : check(value);
}

/** One attempt's HELLO auth keys, validated and frozen. */
export interface HelloAuth {
  readonly authmethods: readonly string[];
  readonly authid: string | undefined;
  readonly authextra: Readonly<Record<string, unknown>> | undefined;
}

/** `what` names the option in the error: the option itself, or `authmethods()` for a function's result. */
function authmethods(value: unknown, what: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array of non-empty strings${orFunction(what)}`);
  const copy: string[] = [];
  for (const method of value as readonly unknown[]) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError(`${what} must be an array of non-empty strings${orFunction(what)}`);
    }
    copy.push(method);
  }
  return Object.freeze(copy);
}

function authid(value: unknown, what: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new TypeError(`${what} must be a string${orFunction(what)}`);
}

function authextra(value: unknown, what: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new TypeError(`${what} must be a plain object${orFunction(what)}`);
  return Object.freeze({ ...value });
}

/** The tail of an option's error message: a function's result may also be `undefined`; the option may be a function. */
function orFunction(what: string): string {
  return what.endsWith('()') ? ' or undefined' : ' (or a function returning one)';
}

/**
 * The HELLO auth keys for one attempt: each function option is called now (authmethods, then authid, then authextra)
 * and its result validated like the value form; `undefined` means not set. Throws what a function threw, or a
 * `TypeError` for an invalid result.
 */
export function helloAuth(o: Pick<NormalizedOptions, 'authmethods' | 'authid' | 'authextra'>): HelloAuth {
  return Object.freeze({
    authmethods: typeof o.authmethods === 'function' ? authmethods(o.authmethods(), 'authmethods()') : o.authmethods,
    authid: typeof o.authid === 'function' ? authid(o.authid(), 'authid()') : o.authid,
    authextra: typeof o.authextra === 'function' ? authextra(o.authextra(), 'authextra()') : o.authextra,
  });
}

function webSocket(value: unknown): WebSocketConstructorLike {
  if (value !== undefined) {
    if (typeof value !== 'function') throw new TypeError('WebSocket must be a WebSocket constructor');
    return value as WebSocketConstructorLike;
  }
  const global = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof global !== 'function') {
    throw new TypeError('no WebSocket implementation: pass options.WebSocket (globalThis.WebSocket is not available)');
  }
  return global as WebSocketConstructorLike;
}

function serializer(value: unknown): Serializer {
  if (value === undefined) return jsonSerializer();
  const s = bag(value, 'serializer');
  if (typeof s['protocol'] !== 'string' || s['protocol'] === '') {
    throw new TypeError('serializer.protocol must be a non-empty string');
  }
  requireFn(s['serialize'], 'serializer.serialize');
  requireFn(s['deserialize'], 'serializer.deserialize');
  return value as Serializer;
}

function clock(value: unknown): { readonly clock: Clock; readonly random: (() => number) | undefined } {
  if (value === undefined) return { clock: systemClock, random: undefined };
  const c = bag(value, 'clock');
  for (const key of ['now', 'setTimeout', 'clearTimeout'] as const) requireFn(c[key], `clock.${key}`);
  const random = fn(c['random'], 'clock.random') as (() => number) | undefined;
  const owner = value as Clock;
  return { clock: owner, random: random === undefined ? undefined : () => random.call(owner) };
}

function requireFn(value: unknown, path: string): void {
  if (typeof value !== 'function') throw new TypeError(`${path} must be a function`);
}

function internal(value: unknown): { readonly timings: InternalTimings; readonly trace: TraceSink | undefined } {
  const i = bag(value, 'internal options');
  const d = INTERNAL_DEFAULTS;
  const trace = i['trace'];
  return {
    timings: Object.freeze({
      ping: duration(i['ping'], 'internal ping', d.ping, 1),
      stable: duration(i['stable'], 'internal stable', d.stable, 1),
      goodbye: duration(i['goodbye'], 'internal goodbye', d.goodbye, 1),
      settle: duration(i['settle'], 'internal settle', d.settle, 1),
      attemptFloor: duration(i['attemptFloor'], 'internal attemptFloor', d.attemptFloor, 0),
    }),
    trace: typeof trace === 'object' && trace !== null ? (trace as TraceSink) : undefined,
  };
}

/** Validate and normalise the constructor arguments; throws `TypeError` naming the option path. */
export function normalizeOptions(url: unknown, realm: unknown, options: unknown): NormalizedOptions {
  if (typeof url !== 'function' && (typeof url !== 'string' || url === '')) {
    throw new TypeError('url must be a non-empty string or a function returning one');
  }
  if (typeof realm !== 'string' || !isValidUri(realm)) {
    // the router would reject it on every attempt: an ABORT/backoff loop, or a handshake-timeout loop
    throw new TypeError('realm must be a URI: non-empty, no whitespace, no "#", no empty component');
  }
  const o = bag(options, 'options');
  const requestIds = o['requestIds'] ?? DEFAULTS.requestIds;
  if (requestIds !== 'random' && requestIds !== 'sequential') {
    throw new TypeError("requestIds must be 'random' or 'sequential'");
  }
  const { clock: theClock, random } = clock(o['clock']);
  const { timings, trace } = internal(o[INTERNAL_OPTIONS]);
  return Object.freeze({
    url: url as NormalizedOptions['url'],
    realm,
    authmethods: orValue(o['authmethods'], (v) => authmethods(v, 'authmethods')),
    authid: orValue(o['authid'], (v) => authid(v, 'authid')),
    authextra: orValue(o['authextra'], (v) => authextra(v, 'authextra')),
    onChallenge: fn(o['onChallenge'], 'onChallenge') as NormalizedOptions['onChallenge'],
    autoOpen: bool(o['autoOpen'], 'autoOpen', DEFAULTS.autoOpen),
    retry: retryOptions(o['retryOptions']),
    timeouts: timeouts(o['timeouts']),
    requestIds,
    WebSocket: webSocket(o['WebSocket']),
    serializer: serializer(o['serializer']),
    clock: theClock,
    random,
    logger: fn(o['logger'], 'logger') as NormalizedOptions['logger'],
    internal: timings,
    trace,
  });
}
