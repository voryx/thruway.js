# Changelog

## 3.0.0 (unreleased; release candidates are published under the `next` dist-tag)

A rewrite. See [MIGRATION.md](MIGRATION.md) for what changes in your code, with before and after examples, and the
[README](README.md) for the API.

### Added

- `reconnect()`: replace the connection now and keep every stream; the new handshake calls `onChallenge` again.
- `status` (connecting with an attempt number, open with the session, closed with a `CloseInfo`), the `session`
  getter, and structured `CloseInfo` on `onClose` for every end, ABORTs included.
- Eight typed error classes with stable `code`s (`WampError`, `ConnectionLostError`, `ConnectionClosedError`,
  `TimeoutError`, `AbortError`, `ProtocolError`, `CanceledError`, `AuthenticationError`) and brand checks that work
  across package copies (`isThruwayError`, `isWampError`).
- `onChallenge` as an option: a function per CHALLENGE that returns a string, a Promise or any Observable, with an
  `AbortSignal` for abandoned handshakes.
- The URL may be a function, called at the start of every attempt.
- `retryOptions.retryDelay` (a custom backoff that can give up with `null`), `timeouts` (connect, handshake, request,
  idle), `requestIds`, `WebSocket`, `serializer`, `clock`, `logger`.
- Liveness: a WAMP-level probe finds dead sockets that browsers and React Native cannot ping.
- `register` with a callee handler that returns a value, a `Yield`, a Promise, an Observable or an async iterable
  (progressive results), honours INTERRUPT and surfaces revocations.
- `thruway.js/rxjs` (`rxClient`), `thruway.js/auth` (`ticket`, `wampcra`, `cryptosign`), `thruway.js/testing`
  (`createTestRouter`, `createVirtualClock`).
- ESM and CommonJS builds, browser bundles, types that need neither the DOM library nor `@types/node`; tested on
  Node 22–26, chromium, webkit, Hermes, Jest 29, TypeScript 5.0–7, RxJS 5.4–9.

### Changed

- No RxJS dependency: the client's own small Observable interoperates with RxJS 5, 6, 7 and 9.
- The connection is explicit (`autoOpen`, `open()`, `reconnect()`, `close()`), no longer reference-counted.
- Topics and registrations survive reconnects and router GOODBYEs; in-flight calls fail with `ConnectionLostError`;
  waiting calls are sent once at the next WELCOME; `close()` fails everything with `ConnectionClosedError`.
- `progressiveCall` keeps its name and arguments but never re-sends a CALL by itself.
- `publish(topic, args, kwargs, options)` is cold.
- Backoff with full jitter; `maxRetries` defaults to `Infinity`; the counter resets after a stable session.
- `WampError` extends `Error`, keeps the router's `kwargs` and `details`, no longer appends `{uri}` to `args`.
- Invalid options and arguments throw or error locally instead of reaching the router.
- The complete list is in [MIGRATION.md, part 2](MIGRATION.md#2-behaviour-changes).

### Removed

- `onError`, `retryWhen`, `defaultRetryWhen`, `progressiveRegister`, `SessionData.messages`, `welcomeMsg`, `argskw`,
  `Observable<ThruwayConfig>` constructors, Subject transports, `WebSocketTransport`, `WebWorkerTransport`, the message
  classes and every deep `thruway.js/src/*` import.
- The `ws` and `rxjs` dependencies.

## 2.x

See the 2.x branch and its tags.
