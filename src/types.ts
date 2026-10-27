/**
 * The public types of thruway.js.
 *
 * No runtime code lives here. The public classes and functions are implemented in their own modules: `Client`
 * (client.ts), `Yield` (yield.ts), the error classes, `ThruwayError`, `isThruwayError` and `isWampError` (errors.ts)
 * and `jsonSerializer` (transport/json.ts). `test/types/api.test-d.ts` pins every one of them.
 *
 * @module
 */
import type { ThruwayError } from './errors.js';

// ---------------------------------------------------------------------------------------------------------------
// Observable kit (types only; no Observable constructor is exported)
// ---------------------------------------------------------------------------------------------------------------

declare global {
  interface SymbolConstructor {
    /** TC39 Observable interop symbol; defined at load by thruway.js like the `symbol-observable` ponyfill. */
    readonly observable: symbol;
  }
}

export interface Observer<T> {
  next(value: T): void;
  error(error: any): void;
  complete(): void;
}
export interface Unsubscribable {
  unsubscribe(): void;
}
export interface Subscription extends Unsubscribable {
  readonly closed: boolean;
}
export interface Subscribable<T> {
  subscribe(observer: Partial<Observer<T>>): Unsubscribable;
}

/** Any Observable that speaks the interop protocol at the type level (zen-observable, …). Declared like RxJS 7's. */
export type InteropObservable<T> =
  { [Symbol.observable]: () => Subscribable<T> } | { '@@observable': () => Subscribable<T> };

/** Structural: any Rx Observable *type* (RxJS 5/7/9, the platform Observable). Their class typings do not declare the
 *  interop key, so this member is what makes them assignable. */
export interface SubscribableInput<T> {
  subscribe(observer: Observer<T>): unknown;
}

/** What the client accepts wherever the app supplies a value: a plain value, a Promise/thenable, an Observable or an
 *  async iterable such as an `async function*` (first value is used for single-valued inputs; every value for handler
 *  streams). Runtime rule: interop key → thenable → any object with a `subscribe` function →
 *  `Symbol.asyncIterator` → plain value. */
export type Input<T> = T | PromiseLike<T> | InteropObservable<T> | SubscribableInput<T> | AsyncIterable<T>;

/** The Observable every client method returns. Cold. No pipe(): compose with your Rx library. */
export interface Observable<T> {
  /** One signature (not overloads), so RxJS 5's `Observable.from(ours)` and RxJS 7's `from(ours)` type-check. */
  subscribe(
    observerOrNext?: Partial<Observer<T>> | ((value: T) => void) | null,
    error?: ((error: any) => void) | null,
    complete?: (() => void) | null,
  ): Subscription;
  [Symbol.observable](): Observable<T>;
  '@@observable'(): Observable<T>;
  /** For RxJS 9 / platform Observable / for-await. Buffers up to 1024 values per iterator (overflow: the iteration
   *  throws RangeError and unsubscribes); return() unsubscribes. Hot streams belong to Rx buffering operators. */
  [Symbol.asyncIterator](): AsyncIterator<T, undefined>;
}

// ---------------------------------------------------------------------------------------------------------------
// Options (defaults in brackets)
// ---------------------------------------------------------------------------------------------------------------

export interface ClientOptions {
  // --- HELLO.Details, spec names (only these keys are ever sent; nothing else leaks) ---
  readonly authmethods?: readonly string[] | undefined; // [none → anonymous]
  readonly authid?: string | undefined;
  readonly authextra?: Readonly<Record<string, unknown>> | undefined;
  /** Called for every CHALLENGE whose method is in `authmethods`, on every handshake (a newer CHALLENGE replaces a
   *  pending one; its signal is aborted). May take arbitrarily long (login dialogs): the handshake timer does not run
   *  while it is pending — bound non-interactive handlers yourself (README recipe 18).
   *  Throw/reject/error/complete-empty → ABORT wamp.error.cannot_authenticate and reconnect with backoff. When several
   *  methods are offered, a round-1 CHALLENGE is held for a short settle window so back-to-back CHALLENGEs (Thruway PHP
   *  sends one per matching method) are answered once, for the latest; offering exactly one method is still best. */
  readonly onChallenge?: ((challenge: ChallengeMessage) => Input<string>) | undefined;

  // --- lifecycle ---
  readonly autoOpen?: boolean | undefined; // [true]  false → stays closed until open()
  readonly retryOptions?: RetryOptions | undefined;
  readonly timeouts?: Timeouts | undefined;

  // --- plumbing ---
  /** 'random' = 53-bit random ids, unique among the session's in-flight requests (Thruway PHP indexes CALLs realm-wide
   *  by request id).
   *  'sequential' = spec-style per-session counter from 1 (Nexus strict_request_ids). */
  readonly requestIds?: 'random' | 'sequential' | undefined; // ['random']
  readonly WebSocket?: WebSocketConstructorLike | undefined; // [globalThis.WebSocket]
  readonly serializer?: Serializer | undefined; // [jsonSerializer()]
  readonly clock?: Clock | undefined; // [system clock]
  /** Receives log entries. Default prints only `level: 'error'` entries (unhandled app errors) with console.error.
   *  Frame entries (byte length + redacted preview) are built only when a logger is given. A logger that throws loses
   *  that entry and nothing else (one console.error fallback per client; never re-logged, never rethrown). */
  readonly logger?: ((entry: LogEntry) => void) | undefined;
}

export interface RetryOptions {
  // v2 names kept (v2 code passes maxRetryDelay)
  readonly initialRetryDelay?: number | undefined; // [1500] ms
  readonly retryDelayGrowth?: number | undefined; // [1.5]  ≥ 1
  readonly maxRetryDelay?: number | undefined; // [60000] ms, ≥ 100
  /** Consecutive failed attempts before giving up (stopped + ConnectionClosedError{gaveUp:true}).
   *  Infinity = never give up. 0 = fail fast. A non-negative integer or Infinity: -1 (the Autobahn
   *  "unlimited" idiom), other negatives, fractions and NaN throw TypeError at construction. */
  readonly maxRetries?: number | undefined; // [Infinity]
  /** Custom strategy: delay in ms before reconnect attempt `attempt` (1-based); `defaultDelay` is what the built-in
   *  formula chose. Return `null` to give up now (one onClose with willRetry false; README recipe 9). The result is
   *  clamped to [100, 2^31−1]; a throw or non-finite result falls back to `defaultDelay` (and is logged). */
  readonly retryDelay?: ((attempt: number, closed: CloseInfo, defaultDelay: number) => number | null) | undefined;
}

export interface Timeouts {
  // ms; positive integers ≤ 2^31−1 (idle may be 0)
  readonly connect?: number | undefined; // [10000]  attempt start (incl. url resolution) → socket open; doubles after consecutive connect timeouts (cap 60 s)
  readonly handshake?: number | undefined; // [15000]  HELLO/AUTHENTICATE → router's next CHALLENGE/WELCOME/ABORT; adaptive like connect
  readonly request?: number | undefined; // [60000]  SUBSCRIBE/UNSUBSCRIBE/REGISTER/UNREGISTER answer (verified against liveness first)
  readonly idle?: number | undefined; // [30000]  no reply for this long → liveness probe; 0 disables liveness (half-open sockets are then detected only by the OS)
}

export interface Clock {
  /** Monotonic milliseconds (default: performance.now(), else Date.now()). Used for every duration. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Uniform [0,1). Used for jitter; also seeds the request-id stream once at construction when injected.
   *  [crypto.getRandomValues, else Math.random] */
  random?(): number;
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  /** Stable event names: 'frame.in' 'frame.out' 'frame.dropped' 'attempt.start' 'attempt.end' 'session.open'
   *  'session.end' 'retry.scheduled' 'protocol.violation' 'unhandled' 'internal' 'option.fallback'
   *  'liveness.unsupported' 'cancel.refused' 'register.ghost' 'challenge.mismatch' 'request.timeout'
   *  'request.error'. */
  readonly event: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** WAMP options are passed through (copied, never mutated); keys whose value is `undefined` are dropped. The index
 *  signature admits router-specific keys such as Thruway's `replace_orphaned_session` (singular; 'yes' or true),
 *  `thruway_multiregister`, `_thruway_eligible_authids`, or Crossbar's `force_reregister`. Spec-named keys are
 *  validated with their spec types (below). */
export type MatchPolicy = 'exact' | 'prefix' | 'wildcard' | `_${string}`;
export type InvokePolicy = 'single' | 'roundrobin' | 'random' | 'first' | 'last' | `_${string}`;
export interface CallOptions {
  readonly receive_progress?: boolean | undefined; // read by the client: progressive results
  readonly disclose_me?: boolean | undefined;
  readonly [key: string]: unknown; // e.g. router-side `timeout` (validated; prefer Rx timeout())
}
export interface RegisterOptions {
  readonly match?: MatchPolicy | undefined;
  readonly invoke?: InvokePolicy | undefined;
  readonly disclose_caller?: boolean | undefined;
  readonly [key: string]: unknown;
}
export interface TopicOptions {
  readonly match?: MatchPolicy | undefined;
  readonly [key: string]: unknown; // e.g. `get_retained` (validated boolean)
}
export interface PublishOptions {
  readonly acknowledge?: boolean | undefined; // read by the client
  readonly exclude_me?: boolean | undefined;
  readonly exclude?: readonly number[] | undefined;
  readonly exclude_authid?: readonly string[] | undefined;
  readonly exclude_authrole?: readonly string[] | undefined;
  readonly eligible?: readonly number[] | undefined;
  readonly eligible_authid?: readonly string[] | undefined;
  readonly eligible_authrole?: readonly string[] | undefined;
  readonly disclose_me?: boolean | undefined;
  readonly [key: string]: unknown; // e.g. `retain` (validated boolean)
}

// ---------------------------------------------------------------------------------------------------------------
// Data delivered to the app (all delivered objects are frozen (shallow) and never mutated by the client)
// ---------------------------------------------------------------------------------------------------------------

export interface ResultMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A; // always an array ([] when absent or null)
  readonly kwargs: Readonly<K>; // always an object ({} when absent or null)
  readonly details: Readonly<{ progress?: boolean } & Record<string, unknown>>;
}
export interface EventMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  /** EVENT.Details as received: `topic` (pattern subscriptions), `publisher*`, `retained`, … A retained event is
   *  delivered again after every re-establishment of the subscription. */
  readonly details: Readonly<Record<string, unknown>>;
}
export interface InvocationMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<
    { receive_progress?: boolean; caller?: number; procedure?: string } & Record<string, unknown>
  >;
  /** details.procedure (pattern registrations) or the registered URI. */
  readonly procedure: string;
  /** Aborted on INTERRUPT (reason CanceledError), when the app unsubscribes the registration (CanceledError), when
   *  the session ends (ConnectionLostError) or on close()/give-up (ConnectionClosedError). */
  readonly signal: AbortSignalLike;
}
/** Return a value (→ YIELD args [value]; undefined → no args), a Yield (explicit args/kwargs), a Promise of either,
 *  or an Observable of either (each value → progress YIELD when the caller asked for progress).
 *  Throw/reject/error a WampError to send its uri/args/kwargs; anything else → wamp.error.runtime_error. */
export type InvocationHandler = (invocation: InvocationMessage) => Input<unknown>;

export interface RegisteredMessage {
  readonly registrationId: number;
  readonly procedure: string;
  readonly sessionId: number;
}
export interface ChallengeMessage {
  readonly authMethod: string; // v2 name
  readonly extra: Readonly<Record<string, unknown>>; // v2 name
  /** Aborted when this handshake is abandoned. `signal.reason` says why:
   *  ConnectionLostError — the socket died; the client retries, so keep a login dialog open (README recipe 17);
   *  ConnectionClosedError — close() or give-up; CanceledError — a newer CHALLENGE replaced this one, or reconnect(). */
  readonly signal: AbortSignalLike;
}
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Session, status, close information
// ---------------------------------------------------------------------------------------------------------------

export interface Session {
  readonly id: number;
  readonly realm: string;
  /** WELCOME.Details as received (frozen). Thruway PHP adds the non-standard `authroles` array; anonymous Thruway
   *  sessions carry only `roles`; fox-wamp never sends `authrole`. Do not assume any auth key exists. */
  readonly details: Readonly<WelcomeDetails>;
}
export interface WelcomeDetails {
  readonly authid?: string;
  readonly authrole?: string;
  readonly authroles?: readonly string[];
  readonly authmethod?: string;
  readonly authprovider?: string;
  readonly authextra?: Readonly<Record<string, unknown>>;
  readonly roles?: Readonly<Record<string, { readonly features?: Readonly<Record<string, boolean>> }>>;
  readonly [key: string]: unknown;
}

export type Status =
  /** `attempt`: 1-based number of this attempt among consecutive attempts since the last reset; equals the
   *  `CloseInfo.attempt` of this attempt's end if it fails before a session is established. */
  | { readonly state: 'connecting'; readonly attempt: number }
  | { readonly state: 'open'; readonly session: Session }
  | { readonly state: 'closed'; readonly closed: CloseInfo | undefined }; // undefined = never opened (autoOpen:false)

export interface CloseInfo {
  /** 'app': close() or reconnect(). 'router': an ABORT or GOODBYE was received. 'connection': everything else —
   *  the socket closed or failed, a timeout, a protocol violation, a challenge failure, an anonymous WELCOME — with
   *  `error` saying which. */
  readonly initiator: 'app' | 'router' | 'connection';
  /** A WAMP URI only: the ABORT/GOODBYE reason received, or the one the client sent ('wamp.close.close_realm',
   *  'wamp.error.protocol_violation', 'wamp.error.cannot_authenticate'); undefined for socket-level ends. The router's
   *  human text is `details.message`; socket close text is in `error.message`. */
  readonly reason: string | undefined;
  readonly details: Readonly<Record<string, unknown>>; // ABORT/GOODBYE details, {} otherwise
  readonly closeCode: number | undefined; // WebSocket close code when known
  readonly wasClean: boolean;
  /** Set when a session (WELCOME) existed on this connection. */
  readonly sessionId: number | undefined;
  /** Typed cause; undefined for close(), reconnect() and a router GOODBYE. */
  readonly error: ThruwayError | undefined;
  readonly willRetry: boolean;
  readonly delay: number | undefined; // ms until the next attempt when willRetry
  /** Consecutive failed attempts including this one (what retryDelay receives); 0 for close() and reconnect(). */
  readonly attempt: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Errors, serializer, transport types (the error classes themselves are in errors.ts)
// ---------------------------------------------------------------------------------------------------------------

export type ErrorCode =
  | 'wamp_error'
  | 'connection_lost'
  | 'connection_closed'
  | 'timeout'
  | 'abort'
  | 'protocol'
  | 'canceled'
  | 'authentication';

export interface Serializer {
  readonly protocol: string; // WebSocket subprotocol, e.g. 'wamp.2.json'
  readonly binary: boolean; // binary frames?
  serialize(message: readonly unknown[]): string | Uint8Array;
  /** Must throw on undecodable input (the client then aborts with protocol_violation). */
  deserialize(data: string | ArrayBuffer | Uint8Array): unknown;
}

/** The slice of the WHATWG WebSocket the client uses (structural: globalThis.WebSocket, `ws`, React Native and the
 *  testing kit's socket all satisfy it; proven by test/types/websocket-like*.test-d.ts). */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  /** Read when present: an outbound backlog delays the liveness verdict instead of failing it. */
  readonly bufferedAmount?: number;
  binaryType: string;
  /** Binary frames are `Uint8Array`s over a plain `ArrayBuffer` — what the DOM typings of `WebSocket.send` accept
   *  since TypeScript 5.7 (a `Uint8Array` may sit on a SharedArrayBuffer); on TypeScript 5.0–5.6 this is just
   *  `Uint8Array`. */
  send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void;
  close(code?: number, reason?: string): void;
  /** Called when present (the `ws` package) if a closing handshake is not answered in time, so Node can exit. */
  terminate?(): void;
  addEventListener(type: 'open' | 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string; readonly wasClean?: boolean }) => void,
  ): void;
  /** One overload per event, mirroring addEventListener (so that the `ws` package's generic signature fits too). */
  removeEventListener(type: 'open' | 'error', listener: (ev: unknown) => void): void;
  removeEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  removeEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string; readonly wasClean?: boolean }) => void,
  ): void;
}
export interface WebSocketConstructorLike {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly OPEN: number;
}
