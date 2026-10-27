# thruway.js

A [WAMP v2](https://wamp-proto.org/) client for browsers, Node.js and React Native.

- Every operation is a cold Observable: subscribe to send, unsubscribe to cancel.
- One deterministic state machine owns the connection. It reconnects with backoff, re-establishes topics and
  registrations, detects dead sockets, and never gives up unless you tell it to.
- Zero runtime dependencies. Its small Observable interoperates with RxJS 5, 6, 7 and 9 and with any interop
  Observable. Use your own Rx library for operators.
- Typed errors with stable codes, and structured close information instead of error strings.
- ES2020 output, ESM and CommonJS, TypeScript types that need neither the DOM library nor `@types/node`.

Version 3 is a rewrite. Coming from 2.x? Read [MIGRATION.md](MIGRATION.md).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Errors](#errors)
- [Reconnection](#reconnection)
- [Authentication](#authentication)
- [RxJS](#rxjs)
- [Testing kit](#testing-kit)
- [Recipes](#recipes)
- [Routers](#routers)
- [Limits and caveats](#limits-and-caveats)

## Install

```sh
npm install thruway.js@next   # the 3.0 beta; plain `npm install thruway.js` still installs 2.x
```

Requirements: Node.js ≥ 22 (it has a global `WebSocket`), any current browser, or React Native (Hermes). RxJS is an
optional peer (`>=5.4.3 <10`); you need it only for operators.

Entry points:

| Import               | What                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `thruway.js`         | `Client`, the error classes and guards, `Yield`, `jsonSerializer`, all public types |
| `thruway.js/rxjs`    | `rxClient`: the client with every stream wrapped in your RxJS                       |
| `thruway.js/auth`    | `ticket`, `wampcra`, `cryptosign` helpers                                           |
| `thruway.js/testing` | an in-memory router and a virtual clock for your tests                              |

A browser bundle is in `dist/browser/` (`thruway.js` UMD with the global `thruway`, `thruway.min.js`, `thruway.mjs`).
It holds the root entry and `auth` (as `thruway.auth`), about 35 kB gzipped.

## Quick start

### Browser (with a bundler)

<!-- doctest: quick-start-browser -->

```ts
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { from, map } from 'rxjs';

const client = new Client('wss://router.example.com/ws', 'realm1');
const wamp = rxClient(client, from);

wamp
  .call('com.example.add', [2, 3])
  .pipe(map((result) => result.args[0] as number))
  .subscribe((sum) => {
    console.log('2 + 3 =', sum);
  });

wamp.topic('com.example.ticks').subscribe({
  next: (event) => {
    console.log('tick', event.args[0]);
  },
  error: (e: unknown) => {
    console.error('ticks ended', e); // close() ends every stream with ConnectionClosedError
  },
});
```

The client connects at construction (`autoOpen: true`). Work started before the first WELCOME waits for it.

### Node.js

Node's global `WebSocket` works. Pass the `ws` package for CLIs and services that must exit after `close()` even
when the router stops answering (see [Limits and caveats](#limits-and-caveats)):

<!-- doctest: quick-start-node -->

```ts
import WebSocket from 'ws';
import { Client } from 'thruway.js';

const client = new Client('ws://127.0.0.1:8080/ws', 'realm1', { WebSocket });
// …
await client.close();
```

### React Native

React Native's global `WebSocket` works as is; use the browser example. Hermes has no WebCrypto, so the `wampcra` and
seed-form `cryptosign` helpers are not available there: answer the CHALLENGE in your own `onChallenge`. If you use
RxJS 7, read [recipe 15](#15-unhandled-errors-under-rxjs-7-in-react-native).

## How it works

- **Cold Observables.** `call`, `progressiveCall`, `register`, `topic` and `publish` return cold Observables. Each
  subscription sends its own CALL, REGISTER, SUBSCRIBE or PUBLISH. Unsubscribing sends CANCEL, UNREGISTER or
  UNSUBSCRIBE. There are no handles, ids or promises (except `close()`). The Observables have no `pipe`: compose them
  with your Rx library, through `rxClient` or your library's `from`.
- **One-shot operations** (`call`, `progressiveCall`, `publish`) wait for a session if there is none, are written once
  after the next WELCOME, and fail if the session ends while they are in flight.
- **Interests** (`topic`, `register`) live as long as you stay subscribed. They are re-established after every
  reconnect and never end because the connection was lost.
- **The connection is explicit.** The client connects when created (or on `open()`), reconnects on its own, and stops
  only on `close()` or when its retry policy gives up. Subscriber counts never open or close it.
- **App code cannot break the client.** A bad argument errors only that subscription. An observer that throws is
  reported to the logger. A callee handler that throws answers the caller with an ERROR.

## API reference

### `new Client(url, realm, options?)`

```ts
new Client(url: string | (() => Input<string>), realm: string, options?: ClientOptions)
```

- `url`: the WebSocket URL, or a function called at the start of every attempt (it may return a Promise or an
  Observable; the first value is used). A function that throws or rejects fails that attempt, which is retried.
- `realm`: a URI under the WAMP loose rule (non-empty, no whitespace, no `#`, no empty component).
- Throws `TypeError` synchronously for invalid options, or when there is no WebSocket implementation.

### `ClientOptions`

Every key is optional. A key set to `undefined` means the default.

| Option         | Type                                                             | Default                                     | Notes                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authmethods`  | `readonly string[]`, or a function returning one                 | none (anonymous)                            | Sent in HELLO. Non-empty strings. A function is called for every HELLO ([recipe 11](#11-re-authenticate)).                                                        |
| `authid`       | `string`, or a function returning one                            | —                                           | Sent in HELLO. A function is called for every HELLO.                                                                                                              |
| `authextra`    | `Readonly<Record<string, unknown>>`, or a function returning one | —                                           | Sent in HELLO. A plain object. A function is called for every HELLO.                                                                                              |
| `onChallenge`  | `(challenge: ChallengeMessage) => Input<string>`                 | —                                           | Answers each CHALLENGE. See [Authentication](#authentication).                                                                                                    |
| `autoOpen`     | `boolean`                                                        | `true`                                      | `false`: stays closed until `open()`.                                                                                                                             |
| `retryOptions` | `RetryOptions`                                                   | see below                                   | Reconnect backoff.                                                                                                                                                |
| `timeouts`     | `Timeouts`                                                       | see below                                   | Client timers.                                                                                                                                                    |
| `requestIds`   | `'random' \| 'sequential'`                                       | `'random'`                                  | `random`: 53-bit ids unique among the session's in-flight requests. `sequential`: a counter from 1 per session (Nexus `strict_request_ids`; not for Thruway PHP). |
| `WebSocket`    | `WebSocketConstructorLike`                                       | `globalThis.WebSocket`                      | Any WHATWG-style WebSocket class: `ws`, React Native's, a custom transport.                                                                                       |
| `serializer`   | `Serializer`                                                     | `jsonSerializer()`                          |                                                                                                                                                                   |
| `clock`        | `Clock`                                                          | the system clock                            | Inject a virtual clock in tests.                                                                                                                                  |
| `logger`       | `(entry: LogEntry) => void`                                      | prints `error` entries with `console.error` | See [`LogEntry`](#logentry).                                                                                                                                      |

HELLO carries only `agent`, `roles`, `authmethods`, `authid` and `authextra`. Other keys of `options` are ignored.

`authmethods`, `authid` and `authextra` may each be a function instead of a value. It is called, synchronously, every
time a HELLO is written (never at construction), and returning `undefined` leaves the key out. A throw or an invalid
result ends that attempt before the HELLO (`AuthenticationError` in `CloseInfo`, the throw as its `cause`) and the
client retries with backoff.

#### `RetryOptions`

| Key                 | Type                                                                           | Default    | Notes                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialRetryDelay` | `number` (ms)                                                                  | `1500`     | Integer ≥ 0.                                                                                                                                                                                                                                 |
| `retryDelayGrowth`  | `number`                                                                       | `1.5`      | ≥ 1.                                                                                                                                                                                                                                         |
| `maxRetryDelay`     | `number` (ms)                                                                  | `60000`    | Integer ≥ 100.                                                                                                                                                                                                                               |
| `maxRetries`        | `number`                                                                       | `Infinity` | Consecutive failed attempts before giving up. `0` fails fast. A non-negative integer or `Infinity`; `-1`, other negatives, fractions and `NaN` throw `TypeError`.                                                                            |
| `retryDelay`        | `(attempt: number, closed: CloseInfo, defaultDelay: number) => number \| null` | —          | Your own policy. `attempt` is 1-based; `defaultDelay` is what the built-in formula chose. Return `null` to give up now. The result is clamped to [100, 2^31−1]; a throw or a non-finite result falls back to `defaultDelay` (and is logged). |

The built-in delay is `min(maxRetryDelay, initialRetryDelay × retryDelayGrowth^(attempt−1))` with full jitter (a
random value between 0 and that), at least 100 ms. See [Reconnection](#reconnection).

#### `Timeouts`

All in milliseconds, integers ≤ 2^31−1.

| Key         | Default | Meaning                                                                                                                                                         |
| ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`   | `10000` | From the start of an attempt (URL resolution included) to the socket being open. Doubles after consecutive connect timeouts, up to 60 s. Must be > 0.           |
| `handshake` | `15000` | From HELLO or AUTHENTICATE to the router's next CHALLENGE, WELCOME or ABORT. Does not run while `onChallenge` is pending. Adaptive like `connect`. Must be > 0. |
| `request`   | `60000` | For a SUBSCRIBE, UNSUBSCRIBE, REGISTER or UNREGISTER answer. Checked against liveness first: a dead socket ends the session instead. Must be > 0.               |
| `idle`      | `30000` | No reply for this long ⇒ a liveness probe. `0` disables liveness (half-open sockets are then found only by the operating system).                               |

There is no call or publish timeout option: use your Rx library's `timeout()` ([recipe 2](#2-timeouts)).

#### `Clock`

```ts
interface Clock {
  now(): number; // monotonic ms [performance.now(), else Date.now()]
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random?(): number; // [0, 1) for jitter; also seeds the request-id stream [crypto.getRandomValues, else Math.random]
}
```

#### `LogEntry`

```ts
interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
```

Stable `event` names: `frame.in`, `frame.out`, `frame.dropped`, `attempt.start`, `attempt.end`, `session.open`,
`session.end`, `retry.scheduled`, `protocol.violation`, `unhandled`, `internal`, `option.fallback`,
`liveness.unsupported`, `cancel.refused`, `register.ghost`, `challenge.mismatch`, `request.timeout`, `request.error`.

The default logger prints only `error` entries (`unhandled`: an observer that threw, an error nobody handled). Frame
entries (byte length and a redacted preview) are built only when you pass a logger. A logger that throws loses that
entry and nothing else.

### `Client` members

```ts
call<A, K>(procedure: string, args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>, options?: CallOptions): Observable<ResultMessage<A, K>>
progressiveCall<A, K>(procedure: string, args?, kwargs?, options?: CallOptions): Observable<ResultMessage<A, K>>
register(procedure: string, handler: InvocationHandler, options?: RegisterOptions): Observable<RegisteredMessage>
topic<A, K>(topic: string, options?: TopicOptions): Observable<EventMessage<A, K>>
publish(topic: string, args?, kwargs?, options?: PublishOptions): Observable<void>
open(): void
reconnect(): void
close(): Promise<void>
readonly status: Observable<Status>
readonly onOpen: Observable<Session>
readonly onClose: Observable<CloseInfo>
readonly session: Session | undefined
```

`A` defaults to `any[]` and `K` to `Record<string, any>`: they only type the result.

| Member            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call`            | One CALL per subscription. Emits one `ResultMessage` and completes. With `receive_progress: true` it emits every progressive result and the final one. Unsubscribing before the final result sends `CANCEL {mode: 'killnowait'}`. Waits for a session if there is none; fails at once with `ConnectionClosedError` if the client is stopped.                                                      |
| `progressiveCall` | `call` with `receive_progress: true` forced (the options are copied, never mutated). It never re-sends the CALL on its own: a live feed adds [recipe 1](#1-live-read-feed).                                                                                                                                                                                                                       |
| `register`        | REGISTER while subscribed, in every session. Emits a `RegisteredMessage` each time the registration becomes active. Unsubscribing sends UNREGISTER; running invocations are answered `wamp.error.canceled`. A re-REGISTER that meets the client's own ghost session (`procedure_already_exists` after a drop the router has not noticed) is retried for up to 5 minutes before the stream errors. |
| `topic`           | SUBSCRIBE while subscribed, in every session. Emits every EVENT. Never errors or completes because the connection was lost. Two subscriptions with the same topic and equivalent options share one router subscription; the last one to leave sends UNSUBSCRIBE.                                                                                                                                  |
| `publish`         | One PUBLISH per subscription. Emits `undefined` and completes when the frame was handed to the socket, or, with `acknowledge: true`, when PUBLISHED arrived. Waits for a session if there is none.                                                                                                                                                                                                |
| `open()`          | Stopped or never opened: start connecting (retry counter reset). Waiting to retry: start the next attempt now (never within 1 s of the previous attempt's start). Open: if nothing has arrived for 2 s, probe the connection now. Connecting: nothing.                                                                                                                                            |
| `reconnect()`     | Replace the connection now and keep every stream. Open: GOODBYE, then a new attempt at once. In-flight calls and acknowledged publishes fail with `ConnectionLostError`; topics and registrations are re-established; waiting operations stay. The new handshake calls `onChallenge` again. Connecting or waiting: start a fresh attempt. Stopped: same as `open()`.                              |
| `close()`         | Idempotent. Sends GOODBYE (`wamp.close.close_realm`), stops reconnecting, fails every pending operation and interest with `ConnectionClosedError`. Work started afterwards fails at once until `open()` or `reconnect()`. Resolves when the connections that existed at the call are closed and their timers cleared (at most about 2 s). Never rejects.                                          |
| `status`          | The current `Status`, replayed to every subscriber, then every change. Never errors or completes.                                                                                                                                                                                                                                                                                                 |
| `onOpen`          | The current session (replayed if open), then every new session. Never errors or completes.                                                                                                                                                                                                                                                                                                        |
| `onClose`         | Every end of an attempt or session, including `close()` and `reconnect()`. Not replayed. Never errors or completes.                                                                                                                                                                                                                                                                               |
| `session`         | The established session, or `undefined`. Never a session that has ended.                                                                                                                                                                                                                                                                                                                          |

`status`, `onOpen` and `onClose` return the same Observable instance on every access.

Arguments are validated inside `subscribe`: an invalid argument errors that subscription synchronously (a
`TypeError`, or `WampError('wamp.error.invalid_uri')` for a bad URI) and nothing is sent. `args` must be an array,
`kwargs` and `options` plain objects. Frames larger than 16 MiB are never written: that operation errors with
`WampError('wamp.error.payload_size_exceeded')`.

### WAMP options

Options are passed to the router under their spec names, copied, with `undefined` values dropped. The index
signature lets router-specific keys through (Thruway PHP's `replace_orphaned_session`, `_thruway_eligible_authids`,
Crossbar's `force_reregister`).

```ts
type MatchPolicy = 'exact' | 'prefix' | 'wildcard' | `_${string}`;
type InvokePolicy = 'single' | 'roundrobin' | 'random' | 'first' | 'last' | `_${string}`;

interface CallOptions {
  receive_progress?: boolean;
  disclose_me?: boolean;
  [key: string]: unknown;
}
interface RegisterOptions {
  match?: MatchPolicy;
  invoke?: InvokePolicy;
  disclose_caller?: boolean;
  [key: string]: unknown;
}
interface TopicOptions {
  match?: MatchPolicy;
  [key: string]: unknown;
}
interface PublishOptions {
  acknowledge?: boolean;
  exclude_me?: boolean;
  disclose_me?: boolean;
  exclude?: readonly number[];
  exclude_authid?: readonly string[];
  exclude_authrole?: readonly string[];
  eligible?: readonly number[];
  eligible_authid?: readonly string[];
  eligible_authrole?: readonly string[];
  [key: string]: unknown;
}
```

Spec keys are checked with their spec types, because Crossbar closes the connection for a mistyped one:
`receive_progress`, `acknowledge`, `disclose_me`, `disclose_caller`, `exclude_me`, `retain`, `get_retained`,
`force_reregister` are booleans; `timeout` is a non-negative safe integer; `exclude`/`eligible` are arrays of ids;
`exclude_authid`, `exclude_authrole`, `eligible_authid`, `eligible_authrole` are arrays of strings; `match` and
`invoke` take the spec values or `_` followed by at least three of `[a-z0-9_]`. Router keys that Crossbar checks are
typed too: `concurrency` (a positive integer), `caller` (an id), `caller_authid`, `caller_authrole`,
`transaction_hash` (strings), `forward_for` (an array of `{session, authid, authrole}`). Rejected with a `TypeError`:
`progress` in CALL options, any `ppt_*` key, and `forward_timeout` in REGISTER options (features this client does not
implement). The router-side CALL `timeout` is passed through, but routers disagree on it; prefer Rx `timeout()`.

### Data delivered to you

All delivered objects are shallow-frozen. Received payloads are not copied.

```ts
interface ResultMessage<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>> {
  readonly args: A; // always an array ([] when absent)
  readonly kwargs: Readonly<K>; // always an object ({} when absent)
  readonly details: Readonly<{ progress?: boolean } & Record<string, unknown>>;
}
interface EventMessage<A, K> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<Record<string, unknown>>; // topic (pattern subscriptions), publisher, retained, …
}
interface InvocationMessage<A, K> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<
    { receive_progress?: boolean; caller?: number; procedure?: string } & Record<string, unknown>
  >;
  readonly procedure: string; // details.procedure (pattern registrations) or the registered URI
  readonly signal: AbortSignalLike; // aborted on INTERRUPT, unsubscribe, session end, close()
}
type InvocationHandler = (invocation: InvocationMessage) => Input<unknown>;
interface RegisteredMessage {
  readonly registrationId: number;
  readonly procedure: string;
  readonly sessionId: number;
}
interface ChallengeMessage {
  readonly authMethod: string;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignalLike; // aborted when this handshake is abandoned; signal.reason says why
}
interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
declare class Yield {
  constructor(args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>);
  readonly args: readonly unknown[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}
```

A callee handler returns:

- a value: YIELD `args: [value]`; `undefined`: YIELD without arguments;
- a `Yield`: its `args` and `kwargs`;
- a Promise of either;
- an Observable or an async iterable (`async function*`): each value is a progressive YIELD when the caller asked for
  progress; otherwise only the last value is sent. Completion sends the final YIELD.

A handler that throws, rejects or errors a `WampError` answers with its `uri`, `args` and `kwargs`; anything else
answers `wamp.error.runtime_error` with the error message. Keys of a `WampError`'s `details` that Crossbar checks
(`callee`, `callee_authid`, `callee_authrole`, `forward_for`) are dropped with a `warn` when mistyped.

`InvocationMessage.signal` is aborted with `CanceledError` on INTERRUPT or when you unsubscribe the registration,
with `ConnectionLostError` when the session ends, and with `ConnectionClosedError` on `close()` or give-up.

### Session, status, close information

```ts
interface Session {
  readonly id: number;
  readonly realm: string;
  readonly details: Readonly<WelcomeDetails>; // WELCOME.Details as received
}
interface WelcomeDetails {
  readonly authid?: string;
  readonly authrole?: string;
  readonly authroles?: readonly string[]; // Thruway PHP
  readonly authmethod?: string;
  readonly authprovider?: string;
  readonly authextra?: Readonly<Record<string, unknown>>;
  readonly roles?: Readonly<Record<string, { readonly features?: Readonly<Record<string, boolean>> }>>;
  readonly [key: string]: unknown;
}
type Status =
  | { readonly state: 'connecting'; readonly attempt: number } // 1-based, consecutive attempts since the last reset
  | { readonly state: 'open'; readonly session: Session }
  | { readonly state: 'closed'; readonly closed: CloseInfo | undefined }; // undefined: never opened
interface CloseInfo {
  readonly initiator: 'app' | 'router' | 'connection';
  readonly reason: string | undefined; // the ABORT/GOODBYE reason URI received or sent; undefined for socket ends
  readonly details: Readonly<Record<string, unknown>>; // ABORT/GOODBYE details ({} otherwise); router text in details.message
  readonly closeCode: number | undefined; // WebSocket close code when known
  readonly wasClean: boolean;
  readonly sessionId: number | undefined; // set when a session existed on this connection
  readonly error: ThruwayError | undefined; // undefined for close(), reconnect() and a router GOODBYE
  readonly willRetry: boolean;
  readonly delay: number | undefined; // ms until the next attempt when willRetry
  readonly attempt: number; // consecutive failed attempts including this one; 0 for close() and reconnect()
}
```

`initiator` is `'app'` for `close()` and `reconnect()`, `'router'` for a received ABORT or GOODBYE, and
`'connection'` for everything else (the socket closed or failed, a timeout, a protocol violation, a challenge
failure, an anonymous WELCOME), with `error` saying which. Do not assume any auth key exists in `details`: anonymous
Thruway PHP sessions carry only `roles`.

### Observable types

The client exports types only; there is no Observable constructor.

```ts
interface Observable<T> {
  subscribe(
    observerOrNext?: Partial<Observer<T>> | ((value: T) => void) | null,
    error?: ((error: any) => void) | null,
    complete?: (() => void) | null,
  ): Subscription;
  [Symbol.observable](): Observable<T>;
  '@@observable'(): Observable<T>;
  [Symbol.asyncIterator](): AsyncIterator<T, undefined>;
}
interface Observer<T> {
  next(value: T): void;
  error(error: any): void;
  complete(): void;
}
interface Unsubscribable {
  unsubscribe(): void;
}
interface Subscription extends Unsubscribable {
  readonly closed: boolean;
}
interface Subscribable<T> {
  subscribe(observer: Partial<Observer<T>>): Unsubscribable;
}
type InteropObservable<T> = { [Symbol.observable]: () => Subscribable<T> } | { '@@observable': () => Subscribable<T> };
interface SubscribableInput<T> {
  subscribe(observer: Observer<T>): unknown;
}
type Input<T> = T | PromiseLike<T> | InteropObservable<T> | SubscribableInput<T> | AsyncIterable<T>;
```

`Observable` follows the Rx grammar: `next* (error | complete)?`, teardown exactly once, idempotent `unsubscribe()`,
synchronous emission inside `subscribe` allowed. One difference from RxJS: an observer that throws, or an error with
no error callback, is reported to the logger (`unhandled`) and never rethrown. The async iterator buffers up to 1024
values; beyond that the iteration throws `RangeError` and unsubscribes.

`Input<T>` is what the client accepts wherever you supply a value (the URL function, `onChallenge`, a callee result):
a plain value, a Promise, any Rx Observable (RxJS 5, 7, 9, the platform Observable), or an async iterable. Inputs are
recognised in this order: interop key, thenable, an object with a `subscribe` function, `Symbol.asyncIterator`, plain
value. Single-valued inputs use the first value.

At load, thruway.js defines `Symbol.observable` if it is missing, like the `symbol-observable` ponyfill.

### Serializer and transport

```ts
interface Serializer {
  readonly protocol: string; // WebSocket subprotocol, e.g. 'wamp.2.json'
  readonly binary: boolean; // binary frames?
  serialize(message: readonly unknown[]): string | Uint8Array;
  deserialize(data: string | ArrayBuffer | Uint8Array): unknown; // must throw on undecodable input
}
function jsonSerializer(options?: { readonly binary?: boolean }): Serializer;
interface WebSocketConstructorLike {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly OPEN: number;
}
interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  readonly bufferedAmount?: number;
  binaryType: string;
  send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void;
  close(code?: number, reason?: string): void;
  terminate?(): void; // the ws package: called when a closing handshake is not answered in time
  addEventListener(type: 'open' | 'error' | 'message' | 'close', listener: (ev: any) => void): void; // per-event overloads
  removeEventListener(type: 'open' | 'error' | 'message' | 'close', listener: (ev: any) => void): void;
}
```

`jsonSerializer()` speaks `wamp.2.json` in text frames. `jsonSerializer({ binary: true })` adds the WAMP convention for
binary values: a `Uint8Array` or `ArrayBuffer` in args or kwargs travels as `"\u0000" + base64`, and such strings
arrive as `Uint8Array`. Bare `NaN`, `Infinity` and `-Infinity` tokens (Python peers through Crossbar) are accepted.

`WebSocketConstructorLike` is the transport contract: `globalThis.WebSocket`, `ws`, React Native's WebSocket and the
testing kit's socket satisfy it, and so can your own (a worker bridge, a recording transport).

## Errors

Every error the client creates is one of eight classes. Each has a stable `name` and `code` and carries a brand, so
the guards work across duplicate copies of the package (ESM and CommonJS, two bundles). Use the guards rather than
`instanceof`.

| Class                   | `code`              | When                                                                                                                                                                                                                                                 | Key fields                                                                                                                    |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `WampError`             | `wamp_error`        | An ERROR from the router or a callee; a revocation (`thruway.error.subscription_revoked` / `registration_revoked`); a bad URI (`wamp.error.invalid_uri`); a frame over 16 MiB (`wamp.error.payload_size_exceeded`).                                  | `uri`, `errorUri` (same), `args`, `kwargs`, `details`, `procedure`/`topic`, `requestId`, `sessionId`; `message === uri`       |
| `ConnectionLostError`   | `connection_lost`   | A call or acknowledged publish was in flight when its session ended and the client will reconnect. Also `CloseInfo.error` for a socket that closed or failed.                                                                                        | `reason` (WAMP URI only), `closeCode`, `cause`, `sessionId`, `requestId`, `procedure`/`topic`; socket close text in `message` |
| `ConnectionClosedError` | `connection_closed` | `close()` (`gaveUp: false`) or a give-up (`gaveUp: true`), for every operation and interest still alive, and for work started while stopped.                                                                                                         | `gaveUp`, `cause`: the in-flight operation's `ConnectionLostError` (outcome unknown), or the last attempt's error             |
| `TimeoutError`          | `timeout`           | `timer`: `'connect'`, `'handshake'`, `'liveness'` (in `CloseInfo.error`), `'request'` (a SUBSCRIBE or REGISTER the router never answered). `'call'` is never raised by the client ([recipe 19](#19-typed-call-timeouts)).                            | `timer`, `timeout`, `attempt`, `sessionId`, `requestId`, `procedure`/`topic`                                                  |
| `AbortError`            | `abort`             | The router sent ABORT, or GOODBYE before WELCOME.                                                                                                                                                                                                    | `reason`, `details` (`message` is `details.message ?? reason`), `attempt`, `sessionId`                                        |
| `ProtocolError`         | `protocol`          | The client aborted because of a malformed frame, a malformed answer to one operation, or a contained internal error.                                                                                                                                 | `frame` (≤ 256 characters), `attempt`, `sessionId`, `requestId`, `procedure`/`topic`                                          |
| `CanceledError`         | `canceled`          | The reason of a `ChallengeMessage.signal` (a newer CHALLENGE, `reconnect()`) or an `InvocationMessage.signal` (INTERRUPT, unsubscribe).                                                                                                              | `requestId`, `procedure`                                                                                                      |
| `AuthenticationError`   | `authentication`    | A CHALLENGE for a method you did not offer, no `onChallenge`, more than 8 rounds, an `onChallenge` that threw, rejected, errored, completed empty or answered a non-string, or an anonymous WELCOME although you offered only non-anonymous methods. | `authMethod`, `cause`, `attempt`                                                                                              |

```ts
type ErrorCode =
  | 'wamp_error'
  | 'connection_lost'
  | 'connection_closed'
  | 'timeout'
  | 'abort'
  | 'protocol'
  | 'canceled'
  | 'authentication';
type ThruwayError =
  | WampError
  | ConnectionLostError
  | ConnectionClosedError
  | TimeoutError
  | AbortError
  | ProtocolError
  | CanceledError
  | AuthenticationError;
function isThruwayError(value: unknown): value is ThruwayError; // brand check
function isWampError(value: unknown): value is WampError; // brand check and code === 'wamp_error'
```

The constructors are public, so tests and apps can build errors (`new WampError(uri, args?, kwargs?, details?)`,
`new TimeoutError({ timer, timeout, procedure? })`, …). Messages are English sentences; do not parse them.
`isThruwayError` also matches `WampError`: for "is this a connection problem?" use
`isThruwayError(e) && !isWampError(e)`.

<!-- doctest: errors -->

```ts
wamp.call('com.example.report', [42]).subscribe({
  next: (result) => {
    show(result.args[0]);
  },
  error: (e: unknown) => {
    if (isWampError(e))
      showError(String(e.args[0] ?? e.uri)); // the server's sentence
    else if (isThruwayError(e) && e.code === 'connection_lost') showError('Connection lost. Try again.');
    else if (isThruwayError(e) && e.code === 'connection_closed') showError('Disconnected.');
    else throw e;
  },
});
```

Retry guidance (applied by the recipes, never by the client): `no_such_procedure`, `canceled`/`cancelled` and
`no_eligible_callee` are transient for reads while backends restart; for a write, `canceled` and a lost connection
mean the outcome is unknown; `not_authorized`, `invalid_argument` and `payload_size_exceeded` are final.

## Reconnection

Every way an attempt or session can end goes through one procedure: the socket closed or failed, a connect,
handshake or liveness timeout, an ABORT, a router GOODBYE, a protocol violation, a failed challenge, a failed URL
function, `reconnect()`. It reports one `onClose`, then schedules exactly one new attempt, unless `close()` was called,
`maxRetries` is exhausted, or `retryDelay` returned `null`. A clean close from the router is a disconnect, not the
end. An ABORT of any reason reconnects with backoff; stop it yourself ([recipe 9](#9-stop-reconnecting-on-a-login-failure)).

- **Backoff.** Full jitter on `min(maxRetryDelay, initialRetryDelay × retryDelayGrowth^(n−1))`, at least 100 ms.
  The counter grows with consecutive failures and resets only after a session has stayed established for 60 s (never
  on a socket open), so a router that ends every session at once backs off instead of looping. `open()` from a stopped
  client and `reconnect()` reset it. Attempts started by you (`open()`, `reconnect()`) never start within 1 s of the
  previous attempt's start.
- **What happens to your streams at a session end:**

  | Stream                                | While the client reconnects                 | On `close()` or give-up                                                                   |
  | ------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
  | call / acknowledged publish in flight | errors `ConnectionLostError`                | errors `ConnectionClosedError` (`cause`: the `ConnectionLostError` when it was in flight) |
  | call / publish waiting for a session  | keeps waiting                               | errors `ConnectionClosedError`                                                            |
  | topic / registration                  | dormant, re-established at the next WELCOME | errors `ConnectionClosedError`                                                            |
  | new work                              | waits                                       | fails at once with `ConnectionClosedError` until `open()`                                 |

  `onClose` and `status` are delivered before the streams fail. Work started before the very first `open()` of an
  `autoOpen: false` client waits.

- **Liveness.** Browsers cannot send WebSocket pings, so the client checks the WAMP session itself. After `idle`
  (30 s) without any frame from the router, or when a request has waited that long for any reply, it writes
  `CALL thruway.js.ping`. Any answer counts, `no_such_procedure` and `not_authorized` included. No answer within the
  ping budget (20 s, doubled after each liveness reconnect up to 120 s) ends the session with
  `TimeoutError{timer: 'liveness'}`, and the client reconnects. 1 s after the first WELCOME on an endpoint the client
  probes once to learn whether the router answers. See the [limits](#limits-and-caveats).
- **Ghost registrations.** After a drop the router has not noticed, its old session may still hold your procedures.
  The client retries such a re-REGISTER for up to 5 minutes; router options can evict the ghost at once
  ([recipe 16](#16-long-lived-callee)).
- **close() and open().** `close()` sends GOODBYE, waits up to 2 s for the reply, closes the socket (and calls
  `terminate()` when the transport has it), and clears every timer. `open()` right after `close()` works in any timing.

## Authentication

Offer methods in `authmethods` and answer each CHALLENGE in `onChallenge`:

```ts
const client = new Client(url, 'realm1', {
  authmethods: ['ticket'],
  onChallenge: (challenge) => readToken(challenge.extra), // a string, a Promise or an Observable of one
});
```

- `onChallenge` runs for every CHALLENGE whose method you offered, on every handshake. It may take as long as it
  needs (a login dialog): the handshake timer does not run while it is pending. Bound non-interactive handlers
  yourself ([recipe 18](#18-bound-non-interactive-challenge-handlers)).
- A throw, rejection, error or empty completion ends the attempt (ABORT `wamp.error.cannot_authenticate`,
  `AuthenticationError` in `CloseInfo`) and the client retries with backoff.
- `challenge.signal` is aborted when the handshake is abandoned. `signal.reason` is a `ConnectionLostError` (the
  socket died; the client retries, so keep a login dialog open), a `ConnectionClosedError` (`close()` or give-up), or
  a `CanceledError` (a newer CHALLENGE or `reconnect()`). Where `AbortController` exists, it is the platform
  `AbortSignal`; its type is the structural `AbortSignalLike`, so cast it for `fetch`.
- With more than one method offered, a first CHALLENGE is held for 50 ms so that back-to-back CHALLENGEs (Thruway PHP
  sends one per matching method) are answered once, for the latest. Offering exactly one method is still best.
- A WELCOME without a CHALLENGE that is anonymous (no `authid` and no `authmethod`, `authmethod: 'anonymous'`, or an
  echo of your HELLO) when you offered only non-anonymous methods is rejected as an authentication failure (Thruway PHP
  does that when no provider covers the realm). Add `'anonymous'` to `authmethods` to accept it.
- `reconnect()` runs a new handshake, so `onChallenge` reads fresh credentials, and `authmethods`, `authid` and
  `authextra` given as functions are read again: a new identity takes effect without ending any stream
  ([recipe 11](#11-re-authenticate)).

### `thruway.js/auth`

```ts
type AuthOptions = Required<Pick<ClientOptions, 'authmethods' | 'onChallenge'>> &
  Pick<ClientOptions, 'authid' | 'authextra'>;
function ticket(authid: string, ticket: string | (() => Input<string>)): AuthOptions;
function wampcra(authid: string, secret: string | (() => Input<string>)): AuthOptions;
function cryptosign(
  key:
    | { authid?: string; publicKey: string; privateKey: string } // hex; privateKey is the 32-byte seed
    | { authid?: string; publicKey: string; sign(message: Uint8Array): Input<Uint8Array> },
): AuthOptions;
```

<!-- doctest: auth-helpers -->

```ts
import { Client } from 'thruway.js';
import { wampcra } from 'thruway.js/auth';

const client = new Client(url, 'realm1', { ...wampcra('peter', 'secret1'), retryOptions: { maxRetryDelay: 15000 } });
```

- Each helper offers exactly one method and answers only CHALLENGEs for it. The function forms re-read the secret on
  every handshake.
- `ticket` answers the ticket as is.
- `wampcra` signs the exact challenge string (HMAC-SHA256, base64). With `extra.salt` it derives the key with
  PBKDF2-HMAC-SHA256 (salt as UTF-8 text, `iterations` default 1000, `keylen` default 32; 0 also means the default).
- `cryptosign` sends `authextra.pubkey` and answers `hex(signature ‖ challenge)`. It needs Ed25519 in WebCrypto
  (Node 22+, current browsers) for the seed form; the `sign` form lets you plug in a native signer. Channel binding is
  not supported. A public key that does not belong to the seed fails each handshake with a `TypeError` cause (WebCrypto
  checks keys asynchronously, so it cannot throw at creation).
- `wampcra` and the seed form of `cryptosign` need `globalThis.crypto.subtle`. Without it (Hermes) the handshake fails
  with `AuthenticationError`.

## RxJS

`thruway.js/rxjs` wraps every stream with your own `from`, so you get your Rx library's Observables with their
operators. It never imports `rxjs` at runtime.

```ts
interface RxClient {
  readonly client: Client; // open(), reconnect(), close(), session
  call<A, K>(procedure, args?, kwargs?, options?: CallOptions): RxObservable<ResultMessage<A, K>>;
  progressiveCall<A, K>(procedure, args?, kwargs?, options?: CallOptions): RxObservable<ResultMessage<A, K>>;
  register(procedure, handler: InvocationHandler, options?: RegisterOptions): RxObservable<RegisteredMessage>;
  topic<A, K>(topic, options?: TopicOptions): RxObservable<EventMessage<A, K>>;
  publish(topic, args?, kwargs?, options?: PublishOptions): RxObservable<void>;
  readonly status: RxObservable<Status>;
  readonly onOpen: RxObservable<Session>;
  readonly onClose: RxObservable<CloseInfo>;
}
function rxClient(client: Client, from: (input: any) => unknown): RxClient;
```

- RxJS 6 and 7: `rxClient(client, from)` with `import { from } from 'rxjs'`.
- RxJS 5.4/5.5: `rxClient(client, Observable.from)`. If you import only `rxjs/Observable`, also
  `import 'rxjs/add/observable/from'`. The adapter's types refer to `import('rxjs').Observable`, which is RxJS 5's
  in an RxJS 5 project, so your patched operators type-check.
- RxJS 9 and the platform Observable: `rxClient(client, (x) => Observable.from(x))` works at runtime through the async
  iterator; the adapter's types are RxJS 7's.
- `rxClient` throws `TypeError` if `from` is not a function. It returns a plain object, so you can replace methods
  (a demo mode, a test stub). The lifecycle streams are wrapped once.
- Without the adapter: `from(client.call(…))` in RxJS 7, `Observable.from(client.call(…))` in RxJS 5. Rx 4 can
  consume the raw streams with positional `subscribe(next, error, complete)`.
- thruway.js and RxJS can load in any order. thruway.js, RxJS 5 and the `symbol-observable` ponyfill define
  `Symbol.observable` when it is missing, so whichever loads first defines it and the others reuse it. RxJS 6 and 7
  never define it; loaded first, they use the `'@@observable'` key, which the client's Observables also carry.

## Testing kit

`thruway.js/testing` gives your tests an in-memory router and a virtual clock. No network, no real timers.

<!-- doctest: testing-kit -->

```ts
import { Client } from 'thruway.js';
import { createTestRouter, createVirtualClock } from 'thruway.js/testing';

const clock = createVirtualClock();
const router = createTestRouter({ clock });
router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });

const results: unknown[] = [];
client.call('com.example.add', [2, 3]).subscribe((result) => results.push(result.args[0]));
await clock.advance(10); // results: [5]
router.drop(); // the socket dies; the client reconnects with backoff
await clock.advance(5000);
const closing = client.close();
await clock.runUntilIdle(); // the GOODBYE travels through the virtual clock too
await closing;
```

```ts
function createVirtualClock(options?: { start?: number; seed?: number }): VirtualClock;
interface VirtualClock extends Required<Clock> {
  advance(ms: number): Promise<void>; // runs due timers in order; drains microtasks before and after each
  runUntilIdle(limitMs?: number): Promise<void>; // [10 minutes of virtual time]
  readonly pendingTimers: number;
}
function createTestRouter(options?: TestRouterOptions): TestRouter;
interface TestRouterOptions {
  clock?: VirtualClock; // with a clock, frames travel through it; without one, on the microtask queue
  authenticate?: (hello: { realm: string; details: Record<string, unknown> }) => AuthDecision; // [WELCOME everyone]
}
type AuthDecision =
  | { welcome: Record<string, unknown> }
  | { challenge: { method: string; extra?: Record<string, unknown> }; verify: (signature: string) => AuthDecision }
  | { abort: string; details?: Record<string, unknown> };
interface TestRouter {
  readonly url: string; // 'memory://router/<n>'
  readonly WebSocket: WebSocketConstructorLike; // pass as ClientOptions.WebSocket
  readonly frames: readonly FrameRecord[];
  procedure(
    uri: string,
    fn: (args: unknown[], kwargs: Record<string, unknown>, details: Record<string, unknown>) => Input<unknown>,
  ): void;
  publish(topic: string, args?: unknown[], kwargs?: Record<string, unknown>): void;
  drop(code?: number): void; // abrupt close of every connection [1006]
  goodbye(reason?: string, details?: Record<string, unknown>): void;
  abort(reason?: string, details?: Record<string, unknown>): void;
  close(): void; // closes every socket and refuses new ones
}
interface FrameRecord {
  readonly connection: number; // 1-based
  readonly direction: 'in' | 'out'; // 'in': client to router
  readonly frame: readonly unknown[] | string; // decoded, or the raw text
  readonly at: number;
}
```

`procedure(uri, fn)` runs `fn` once per CALL with the CALL's args, kwargs and options. Its result is converted like a
callee result: a value or Promise becomes the RESULT; an Observable's values become progressive results when the CALL
asked for them; a `WampError` becomes that ERROR, anything else `wamp.error.runtime_error`. A CALL to a URI without a
handler gets `wamp.error.no_such_procedure` (the liveness probe too). A result that never settles keeps the call in
flight, so you can test `timeout()`, `router.drop()` and `close()`. A CANCEL is answered `wamp.error.canceled`.
Clients can also register procedures and publish to each other through the router.

The kit works with Jest 29 (`require`) and with Jest's and Vitest's fake timers: without a `clock`, the client uses the
global timers and `performance.now()`, and the router delivers frames on the microtask queue.

## Recipes

The client does only what Rx cannot: run the session, reconnect, re-establish interests, cancel, check liveness.
Retries, timeouts, sharing, buffering and promise conversion are your Rx library's job. Each recipe below is a test in
`test/docs/recipes.test.ts`: it type-checks with TypeScript 7 and runs against the testing kit (recipes 1, 5 and 16
also against its Thruway PHP dialect). They use RxJS 7 through the adapter; RxJS 5 apps write the same with
dot-chained operators on `rxClient(client, Observable.from)` streams (see [MIGRATION.md](MIGRATION.md)).

<!-- doctest: recipes-imports -->

```ts
import {
  Client,
  TimeoutError,
  isThruwayError,
  isWampError,
  type CloseInfo,
  type ConnectionLostError,
  type InvocationMessage,
  type Status,
} from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import {
  EMPTY,
  TimeoutError as RxTimeoutError,
  catchError,
  concatMap,
  defer,
  distinctUntilChanged,
  filter,
  finalize,
  first,
  firstValueFrom,
  from,
  lastValueFrom,
  map,
  merge,
  mergeMap,
  retry,
  share,
  shareReplay,
  switchMap,
  throwError,
  timeout,
  timer,
  withLatestFrom,
  type Observable as RxObservable,
  type Subscription,
} from 'rxjs';
```

<!-- doctest: recipes-setup -->

```ts
const client = new Client('wss://router.example.com/ws', 'realm1', {
  authmethods: ['ticket'],
  onChallenge: () => token,
});
const wamp = rxClient(client, from);
```

Shared helpers:

<!-- doctest: recipes-helpers -->

```ts
const isLost = (e: unknown): e is ConnectionLostError => isThruwayError(e) && e.code === 'connection_lost';
/** The WAMP spec also spells the Dealer's cancel URI `cancelled` (Basic Profile, callee leaving): accept both. */
const CANCELED = new Set(['wamp.error.canceled', 'wamp.error.cancelled']);
/** A write that was (or may have been) on the wire when its session ended, or whose callee left mid-call (Thruway
 *  PHP and Crossbar then answer `canceled`): the outcome is unknown. Your own unsubscribe never produces an error. */
const outcomeUnknown = (e: unknown): boolean =>
  isLost(e) ||
  (isThruwayError(e) && e.code === 'connection_closed' && isLost(e.cause)) ||
  (isWampError(e) && CANCELED.has(e.uri));
```

### 1. Live read feed

Re-issue a read after a lost connection and while backends restart (2.x `progressiveCall` did a part of this on its
own).

<!-- doctest: recipe-1 -->

```ts
const TRANSIENT = new Set(['wamp.error.no_such_procedure', ...CANCELED, 'wamp.error.no_eligible_callee']);
const FRAME_REJECTED = new Set([1002, 1003, 1007, 1009, 1011]); // the router closed the socket over a frame
const transient = (e: unknown): boolean =>
  (isLost(e) && !FRAME_REJECTED.has(e.closeCode ?? 0)) || (isWampError(e) && TRANSIENT.has(e.uri));
const liveRead = <T>(src: RxObservable<T>): RxObservable<T> =>
  src.pipe(
    retry({
      delay: (e: unknown, n: number) => (transient(e) ? timer(Math.min(30_000, 500 * 2 ** n)) : throwError(() => e)),
      resetOnSuccess: true,
    }),
  );
const feed$ = liveRead(wamp.progressiveCall('com.example.ticker'));
```

A re-subscription waits for the next WELCOME by itself. Never retried: `not_authorized`, `invalid_argument`,
`ConnectionClosedError` (the client was stopped), and a loss whose close code says the router rejected a frame (an
oversized frame would otherwise kill every reconnect). For a feed the server may complete, add
`repeat({ delay: 3000 })`.

### 2. Timeouts

<!-- doctest: recipe-2 -->

```ts
const report$ = wamp.call('com.example.report', [42]).pipe(timeout(5000)); // expiry unsubscribes: CANCEL
const sent$ = wamp.publish('com.example.status', ['up'], {}, { acknowledge: true }).pipe(timeout(5000));
```

The timer starts at subscribe, so it also bounds the wait for a session. Acknowledged publishes have no client timer
either. The error is your Rx library's `TimeoutError`; [recipe 19](#19-typed-call-timeouts) maps it to the client's.

### 3. Writes: no retry, no cancel, outcome unknown

Reads use recipe 1. A write must not be retried when its outcome is unknown, and must not be cancelled by a timeout:

<!-- doctest: recipe-3 -->

```ts
class OutcomeUnknown extends Error {
  constructor(readonly reason: unknown) {
    super('the outcome of this write is unknown');
  }
}
const call$ = wamp.call('com.example.save_note', [note]).pipe(shareReplay({ bufferSize: 1, refCount: false }));
call$.subscribe({ error: () => undefined }); // holds the CALL until RESULT or ERROR: no CANCEL, ever
const outcome$ = call$.pipe(
  first(),
  timeout({ first: 15000 }),
  catchError((e: unknown) =>
    throwError(() => (outcomeUnknown(e) || e instanceof RxTimeoutError ? new OutcomeUnknown(e) : e)),
  ),
);
```

A write that never left the client (offline, or a socket that refused it) keeps waiting and is sent once. `close()`
before it was written fails it with a plain `ConnectionClosedError` (definitely not sent).

**Idempotency keys.** An outcome-unknown write can be resubmitted safely only if the backend recognises the repeat.
Give non-idempotent writes a key created once per user action and reused for every resubmission of that action:

<!-- doctest: recipe-3-key -->

```ts
const saveNote = (note: Note, key: string = crypto.randomUUID()) =>
  wamp.call('com.example.save_note', [note], { request_key: key }); // the backend ignores a key it has applied
```

Writes started while offline are each written once at the next WELCOME, in start order: a user who presses "Submit"
twice while offline submits twice. Disable the control while a write is pending (`exhaustMap` from the click stream),
or reuse the key.

### 4. Fail fast while offline

<!-- doctest: recipe-4 -->

```ts
class Offline extends Error {}
const userInfo$ = defer(() => {
  if (client.session === undefined) return throwError(() => new Offline());
  return wamp.call('com.example.user_info');
});
```

Inside `defer` the `session` getter reflects the state the CALL will be written in. Work started after `close()` or a
give-up already fails with `ConnectionClosedError`.

### 5. Shared and durable topics

Topics never error because of a lost connection. They error on a router rejection, a revocation, or a SUBSCRIBE the
router never answers. A topic that must outlive those:

<!-- doctest: recipe-5 -->

```ts
const durable = (e: unknown): boolean =>
  isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked')));
const status$ = wamp.topic('com.example.status').pipe(
  retry({
    delay: (e: unknown, n: number) => (durable(e) ? timer(Math.min(30_000, 1000 * 2 ** n)) : throwError(() => e)),
    resetOnSuccess: true,
  }),
  share(),
);
```

Add `wamp.error.not_authorized` if your authorizer restarts. A re-subscription after a request timeout reuses the
SUBSCRIBE that is still unanswered instead of sending a new one. `shareReplay({ bufferSize: 1, refCount: true })`
gives a last-value cache. Two `topic('t')` subscriptions already share one router subscription, so router-side effects
such as `get_retained` happen once per topic and options per session: a later local subscriber does not get the
retained event (use `shareReplay`), and a retained event is delivered again after each re-subscription.

### 6. Wait for a session; once per session

<!-- doctest: recipe-6 -->

```ts
const session = await firstValueFrom(wamp.onOpen);
const perSession$ = wamp.onOpen.pipe(
  switchMap(() =>
    wamp.call('com.example.user_info').pipe(catchError((e: unknown) => (isLost(e) ? EMPTY : throwError(() => e)))),
  ),
);
```

Without the `catchError`, a drop while the call is in flight would end the "once per session" pipeline for good.

### 7. Connected flag and outage banner

From `status` alone, so a deliberate stop hides the banner:

<!-- doctest: recipe-7 -->

```ts
const connected$ = wamp.status.pipe(
  map((s) => s.state === 'open'),
  distinctUntilChanged(),
);
const outage = (s: Status): boolean =>
  s.state === 'connecting' ? s.attempt > 1 : s.state === 'closed' && s.closed?.willRetry === true;
wamp.status.pipe(map(outage), distinctUntilChanged()).subscribe((down) => {
  if (down) showOutage();
  else hideOutage();
});
```

### 8. Promises

<!-- doctest: recipe-8 -->

```ts
const user = await lastValueFrom(wamp.call('com.example.user_info'));
await lastValueFrom(wamp.publish('com.example.status', ['up']));
const raw = await lastValueFrom(from(client.call('com.example.user_info'))); // without the adapter
```

RxJS 5: `wamp.call(p, a).toPromise()`.

### 9. Stop reconnecting on a login failure

<!-- doctest: recipe-9 -->

```ts
const client = new Client(url, 'realm1', {
  authmethods: ['ticket'],
  onChallenge: () => readToken(),
  retryOptions: {
    retryDelay: (attempt, closed, defaultDelay) =>
      closed.initiator === 'router' && closed.reason === 'wamp.error.authentication_failed' ? null : defaultDelay,
  },
});
```

The end is reported once, with `willRetry: false`. Every stream ends with `ConnectionClosedError{gaveUp: true}`.
`open()` starts again after a new login. (`client.close()` from an `onClose` observer also stops it, but you first
see `willRetry: true` and then a second `onClose`.)

### 10. Wake-ups

Foreground, network change, a fresh token:

<!-- doctest: recipe-10 -->

```ts
merge(appActive$, networkChange$)
  .pipe(withLatestFrom(wamp.status))
  .subscribe(([, s]) => {
    if (!(s.state === 'closed' && s.closed?.willRetry === false)) client.open();
  });
```

`open()` cuts a backoff wait, and while open it probes the connection, so a socket that died in the background is
replaced within the ping budget. The guard keeps a stopped client stopped.

### 11. Re-authenticate

<!-- doctest: recipe-11 -->

```ts
token = newToken; // the next onChallenge reads it
client.reconnect();
```

Topics and registrations are re-established, waiting work stays, in-flight reads fail with `connection_lost`
(recipe 1 re-issues them). Do not use `close(); open()` for this: `close()` ends every stream.

To switch identity, for example from an anonymous session to a logged-in user, give the auth options as functions.
They are read for every HELLO:

<!-- doctest: recipe-11-identity -->

```ts
let login: { authid: string; ticket: string } | undefined = undefined; // anonymous until the user logs in
const client = new Client(url, 'realm1', {
  authmethods: () => (login === undefined ? undefined : ['ticket']),
  authid: () => login?.authid,
  onChallenge: () => login?.ticket ?? '', // only challenged once ticket is offered
});
```

After the login:

<!-- doctest: recipe-11-login -->

```ts
login = { authid: 'joe', ticket: token };
client.reconnect(); // the next HELLO offers ticket as joe; every stream carries over
```

### 12. Retry selected error URIs

<!-- doctest: recipe-12 -->

```ts
const list$ = wamp.call('com.example.list', ['current']).pipe(
  retry({
    count: 8,
    delay: (e: unknown) =>
      isWampError(e) && e.uri === 'wamp.error.no_such_procedure' ? timer(1000) : throwError(() => e),
  }),
);
```

### 13. Publish a stream

The acknowledgement is the flow control (an unacknowledged publish completes as soon as the socket takes it, so
`concatMap` would not wait); `exhaustMap` drops values while one is pending. The client never buffers on its own; you
pick the offline policy.

<!-- doctest: recipe-13 -->

```ts
const acked$ = source$.pipe(concatMap((v) => wamp.publish('com.example.status', [v], {}, { acknowledge: true })));

// drop while offline
const online$ = source$.pipe(
  filter(() => client.session !== undefined),
  concatMap((v) => wamp.publish('com.example.status', [v])),
);

// bounded offline queue, dropping the newest value when full
const MAX = 100; // values allowed to wait for a session (or an acknowledgement)
let outstanding = 0;
const publishBounded$ = source$.pipe(
  filter(() => outstanding < MAX),
  mergeMap((v) =>
    defer(() => {
      outstanding++;
      return wamp.publish('com.example.status', [v]);
    }).pipe(
      finalize(() => {
        outstanding--;
      }),
      catchError(() => EMPTY), // one failed publish never ends the source
    ),
  ),
);
```

Every subscribed publish without a session waits in the client's queue and is written once, in start order, at the
next WELCOME, so the number of live waiting subscriptions is the queue length. To drop the oldest value instead,
unsubscribe the oldest waiting publish (an unsubscribed waiting publish is never sent):

<!-- doctest: recipe-13-oldest -->

```ts
const waiting: Subscription[] = [];
source$.subscribe((v) => {
  const sub = wamp.publish('com.example.status', [v]).subscribe({ error: () => undefined });
  if (!sub.closed) waiting.push(sub);
  while (waiting.length > MAX || waiting[0]?.closed === true) waiting.shift()?.unsubscribe();
});
```

Add `timeout(ms)` inside the `mergeMap` to bound how long a value may wait.

### 14. Lazy connection

For a client used now and then: `open()` when the first subscriber arrives, `close()` when the last one leaves.

<!-- doctest: recipe-14 -->

```ts
const lazy = (client: Client) => {
  let refs = 0;
  return <T>(src: RxObservable<T>): RxObservable<T> =>
    defer(() => {
      if (refs++ === 0) client.open(); // the first subscriber: open BEFORE subscribing
      return src;
    }).pipe(
      finalize(() => {
        if (--refs === 0) void client.close();
      }),
    );
};
const dashboard = new Client(DASHBOARD_URL, 'realm1', { autoOpen: false });
const dash = rxClient(dashboard, from);
const live = lazy(dashboard);
const tiles$ = live(dash.call('com.example.dashboard', ['tiles'], {}, { receive_progress: true }));
```

`open()` must run before `src` is subscribed: after `close()` the client is stopped, and work started while stopped
fails at once. `finalize` runs after `src` was unsubscribed, so the CANCEL is written before `close()`'s GOODBYE. A
last unsubscribe followed by a new subscribe in the same tick works: the old connection closes on its own and the
new attempt starts at once, or 1 s after the previous attempt's start if that was more recent.

### 15. Unhandled errors under RxJS 7 in React Native

RxJS 7 rethrows an unhandled error from a timer, which is fatal in React Native. Report it instead, and give every
pipeline a `catchError`:

<!-- doctest: recipe-15 -->

```ts
config.onUnhandledError = (e: unknown) => {
  console.error(e);
};
```

(`import { config } from 'rxjs'`.) The client's own Observables never throw: they report to the logger.

### 16. Long-lived callee

<!-- doctest: recipe-16 -->

```ts
const registration$ = wamp
  .register('com.example.build_report', (inv: InvocationMessage) => buildReport(inv.args[0]), {
    replace_orphaned_session: 'yes',
  })
  .pipe(
    retry({
      delay: (e: unknown) =>
        isWampError(e) && e.uri === 'wamp.error.procedure_already_exists' ? timer(5000) : throwError(() => e),
    }),
  );
```

`replace_orphaned_session: 'yes'` (singular) is Thruway PHP's option: the router pings the old session for 5 s and
evicts it if it is dead. Use `{ force_reregister: true }` on Crossbar. The client itself re-registers after every
reconnect and, when its own previous session still holds the procedure, retries for up to 5 minutes before the stream
errors; these options make the router evict the stale session at once. The `retry` covers a genuine conflict or a
longer outage. With Thruway's option the REGISTERED answer can take about 5 s; keep `timeouts.request` well above that.

### 17. Login dialogs that outlive a socket

Memoise the credentials so a new handshake reuses the dialog that is already open, and forget them, with any stored
token, when the router rejects them (ABORT) or ends the login (a router GOODBYE). Router restarts and outages keep
them:

<!-- doctest: recipe-17 -->

```ts
const KEEP = new Set([
  'wamp.close.system_shutdown', // router restart (Bondy SIGTERM, …)
  'com.example.login.unavailable', // app-specific outage reasons
]);
const loginEnded = (c: CloseInfo): boolean =>
  c.initiator === 'router' && !KEEP.has(c.reason ?? '') && (c.error === undefined || c.error.code === 'abort');
const login = () => defer(() => showLoginDialog()).pipe(shareReplay({ bufferSize: 1, refCount: false }));
let creds$ = login();
const client = new Client(url, 'realm1', { authmethods: ['ticket'], onChallenge: () => creds$ });
client.onClose.subscribe((c) => {
  if (loginEnded(c)) {
    forgetStoredToken();
    creds$ = login();
  }
});
```

`c.error === undefined` with `initiator: 'router'` is a GOODBYE; `c.error.code === 'abort'` is a rejection. `onClose`
is delivered before the retry timer (≥ 100 ms) can start the next attempt, so the next CHALLENGE opens a new dialog.
An app that must not reconnect at all after such an end stops instead: `retryDelay: (n, c, d) => (loginEnded(c) ?
null : d)`. When the socket dies under the dialog, `challenge.signal.reason` is a `ConnectionLostError`: keep the
dialog open.

### 18. Bound non-interactive challenge handlers

The handshake timer does not run while `onChallenge` is pending, so a handler that can hang must bound itself:

<!-- doctest: recipe-18 -->

```ts
const client = new Client(url, 'realm1', {
  authmethods: ['ticket'],
  onChallenge: async (challenge) => {
    const signal = AbortSignal.any([challenge.signal as AbortSignal, AbortSignal.timeout(15000)]);
    const res = await fetch('/api/token', { credentials: 'include', signal });
    const { token } = (await res.json()) as { token: string };
    return token;
  },
});
```

For an Observable answer, use Rx `timeout(15000)`.

### 19. Typed call timeouts

Recipe 2's `timeout()` raises your Rx library's `TimeoutError`, which has no brand, `code` or `procedure`. To make
every timeout classify like the client's (`isThruwayError(e) && e.code === 'timeout'`), map it at the call site.
Expiry still unsubscribes, so CANCEL is still sent:

<!-- doctest: recipe-19 -->

```ts
const callTimeout =
  (ms: number, procedure: string) =>
  <T>(src: RxObservable<T>): RxObservable<T> =>
    src.pipe(
      timeout({
        first: ms,
        with: () =>
          throwError(() => new TimeoutError({ timer: 'call', timeout: ms, procedure, sessionId: client.session?.id })),
      }),
    );
const report$ = wamp.call('com.example.report', [42]).pipe(callTimeout(5000, 'com.example.report'));
```

RxJS 5: `.timeoutWith(ms, Observable.throw(new TimeoutError({ timer: 'call', timeout: ms, procedure })))`. App code
never sees request ids, so the error has none. `sessionId` is the session at expiry (left out when there is none).

## Routers

### Thruway PHP (0.6.1)

First-class: the full integration and chaos suite runs against it.

- Offer exactly one auth method. With two, Thruway sends one CHALLENGE per method and verifies against the last; the
  client's 50 ms settle window copes, but one method is simpler (the auth helpers offer one).
- Keep `requestIds: 'random'` (the default): Thruway indexes calls by request id across the realm, so two sessions
  with the same in-flight id interfere.
- CANCEL is refused for callees that do not announce `call_canceling`: the call keeps running on the callee. See the
  [cancel caveat](#limits-and-caveats). thruway/client 0.5.8 announces it and cancels a handler that returns a
  cancellable promise; older PHP callees may not.
- A callee that leaves mid-call answers the caller `wamp.error.canceled` (recipe 1 retries it for reads).
- A `match: 'wildcard'` SUBSCRIBE is never answered: the topic errors with `TimeoutError{request}` after 60 s.
- Ghost registrations: `replace_orphaned_session: 'yes'` (recipe 16).
- `thruway.inspect.shutdown_session` drops the socket without a GOODBYE: apps see a connection loss, not a router
  GOODBYE.
- WELCOME carries the non-standard `authroles` array. A realm with no auth provider WELCOMEs anonymously; the client
  rejects that WELCOME when you offered only non-anonymous methods.

### Other routers

Tested in the integration matrix: Crossbar 26.10.1, Bondy 1.0.0-rc.65, Nexus 3.3.1 and main (`requestIds:
'sequential'` for `strict_request_ids` realms), xconn nxt, fox-wamp 0.7.28; wamp-server 0.0.9 as a hostile router.
Router-specific options pass through the options' index signature. Notes: Crossbar closes the connection for a
mistyped option (the client checks spec keys first) and for an implementation-specific `match` or `invoke` (`_…`,
meant for another router), and ghost registrations need `force_reregister: true`; Bondy does not interrupt a callee
on CANCEL with a mode, does not pass `receive_progress` to callees, delivers your own events and reorders some events
of one publisher; Nexus limits a callee to about 120 queued invocations; nxt and fox-wamp leave a caller waiting when
its callee leaves (bound calls with `timeout()`); fox-wamp unwraps a single array argument (`[[x]]` arrives as `[x]`).
With Node's default WebSocket, nxt keeps a socket open per ABORTed attempt; services pass `ws`.

## Limits and caveats

- **Cancel is best effort.** Unsubscribing settles the call locally at once and sends `CANCEL {mode: 'killnowait'}`.
  A router may refuse it: Thruway PHP refuses CANCEL for callees that do not announce `call_canceling` (thruway/client
  0.5.8 announces it; older PHP callees may not), and then the callee's work runs to the end. The refusal is logged
  once per procedure (`warn cancel.refused`). Do not rely on unsubscribe to stop work on such callees.
- **Liveness limits.**
  - With liveness on, each inbound message must arrive within `idle` + the ping budget; send very large results as
    progressive chunks.
  - A router that silently drops the probe while answering other traffic is detected: after two sessions on one
    endpoint that end by liveness with no probe answered, the client logs `warn liveness.unsupported` and stops
    half-open detection on that endpoint for the client's life (16 endpoints are remembered, keyed by URL without
    query). Two half-open links in a row before the router answered a probe have the same effect, as does a link
    whose answers take longer than twice the budget.
  - `timeouts.idle: 0` turns liveness off; then only the operating system detects a dead socket (minutes or never).
  - The probe is a `CALL thruway.js.ping`, visible in router logs, at most one per `idle` while the client is busy.
- **Node.js and a frozen router.** Node's global WebSocket (undici) has no `terminate()` and no closing-handshake
  timeout. If the router completes the upgrade and then never answers (a paused container, a proxy that stops
  forwarding), `close()` still resolves within about 2 s and the client releases everything it owns, but one TCP
  socket stays open for as long as the peer holds the connection, so the process cannot exit. CLIs and services that
  must exit pass `WebSocket: ws` from the `ws` package: the client calls its `terminate()` after the 2 s GOODBYE wait.
  Browsers and React Native are not affected.
- **Node 22.0–22.3** print undici's "WebSocket is experimental" warning once per process; 22.4 and later are silent.
  `cryptosign` prints Node's Ed25519 experimental warning once on 22.0–22.12.
- **Rx `TimeoutError`.** Call and publish timeouts are your Rx library's `timeout()`, so a timed-out call errors with
  RxJS's own `TimeoutError`: same `name`, but no brand, `code`, `requestId` or `procedure`; `isThruwayError` is false
  for it. Use [recipe 19](#19-typed-call-timeouts) to get the client's `TimeoutError{timer: 'call'}`.
- **Throwing `abort` listeners.** `ChallengeMessage.signal` and `InvocationMessage.signal` are platform
  `AbortSignal`s where available. A listener of yours that throws is handled the platform's way: in Node it becomes an
  `uncaughtException`. The same goes for a handler or `onChallenge` result from RxJS 9 or the platform Observable whose
  teardown throws. Catch inside your listeners.
- **Late answers.** A REGISTERED or SUBSCRIBED that arrives after `timeouts.request` is withdrawn (UNREGISTER or
  UNSUBSCRIBE) unless a new subscription took it over. A REGISTERED that never arrives leaves the registration at the
  router until its first INVOCATION, which the client answers `no_such_registration` and then withdraws. A SUBSCRIBED
  that never arrives leaves the router subscription in place for the rest of that session (its EVENTs are dropped).
- **Memory.** A kept `CloseInfo` keeps its `error` (with its stack and cause) reachable, about 26 KB per end. Copy
  what you need instead of storing every `onClose` value.
- **Sizes.** Frames over 16 MiB are never written (`payload_size_exceeded`). Routers with lower limits close the socket
  (1009), which recipe 1 does not retry.
- **Not implemented:** msgpack/CBOR, RawSocket, batched WebSocket, progressive call invocations, payload passthru,
  WAMP-SCRAM, session resumption, the meta API, publication ids on events.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## License

MIT
