# Migrating from thruway.js 2.x to 3.0

3.0 is a rewrite. The API keeps the 2.x names where nothing is gained by renaming (`Client`, `call`,
`progressiveCall`, `register`, `topic`, `publish`, `open`, `close`, `onOpen`, `onClose`, `onChallenge`, `autoOpen`,
`retryOptions`, `ResultMessage`, `EventMessage`, `ChallengeMessage`, `errorUri`), so most call sites do not change. The
work is in the module that creates the client, its error helpers, and a few places where 2.x behaved differently.

This guide has four parts:

1. [Mechanical changes](#1-mechanical-changes): the renames and replacements, in one table.
2. [Behaviour changes](#2-behaviour-changes): what 2.x did that 3.0 does not.
3. [Before and after](#3-before-and-after): the common 2.x patterns and their 3.0 form.
4. [Checklist](#4-checklist).

"Before" code is 2.x usage (thruway.js 2.0.8 with RxJS 5.5, its peer dependency). "After" code marked as a doctest is
a test of this repository (`test/docs/migration.test.ts`): it type-checks under TypeScript 7 and 6 and runs against
the testing kit, RxJS 5 code on RxJS 5.5.12 (the operators used here exist in 5.4.3 too). Names such as `show`,
`readTicket` or `loadConfig` stand for your own code.

The README's [recipes](README.md#recipes) are referred to by number.

## 1. Mechanical changes

| 2.x                                                                                                                | 3.0                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import {Client} from 'thruway.js'` and RxJS 5 operators on its streams                                            | `import {Client} from 'thruway.js'; import {rxClient} from 'thruway.js/rxjs'; const wamp = rxClient(client, Observable.from)`. The module that creates the client keeps returning RxJS Observables, so call sites do not change. RxJS 5 code that imports only `rxjs/Observable` also `import 'rxjs/add/observable/from'`. |
| the operators 2.x patched onto RxJS 5's `Observable.prototype` (its `Client` imported about 30 `rxjs/add/…` files) | import every operator you use: 3.0 patches nothing                                                                                                                                                                                                                                                                         |
| `new Client(url, realm, {authmethods, retryWhen})`                                                                 | `new Client(url, realm, {authmethods, onChallenge, retryOptions?})`; a custom `retryWhen` becomes `retryOptions.retryDelay` ([3.8](#38-stop-reconnecting-on-a-login-failure)) and wake-ups (recipe 10)                                                                                                                     |
| `new Client(Observable<ThruwayConfig>)`                                                                            | `new Client(url \| () => Promise<url>, realm, {...})`; `config.autoOpen` is the `autoOpen` option ([3.1](#31-construction-and-options))                                                                                                                                                                                    |
| `new Client(subject)` (a Subject transport, in tests)                                                              | the testing kit ([3.14](#314-tests-with-the-testing-kit)), or your own class as the `WebSocket` option                                                                                                                                                                                                                     |
| `autoOpen: false` + `open()`                                                                                       | unchanged                                                                                                                                                                                                                                                                                                                  |
| `wamp.onChallenge(c$ => c$.switchMap(...))`, a stream of challenges                                                | the option `onChallenge: (c) => string \| Promise \| Observable`, called once per CHALLENGE. RxJS 5 Observables are accepted. It sees only the methods you offered, so a `filter(m => m.authMethod === X)` can go.                                                                                                         |
| `onChallenge(() => Observable.never())` to stop reconnecting                                                       | `retryOptions.retryDelay` returning `null` ([3.8](#38-stop-reconnecting-on-a-login-failure), recipe 9)                                                                                                                                                                                                                     |
| `progressiveCall(u, a, k, o)`                                                                                      | the same name and arguments; `o` is no longer mutated; it no longer re-sends after `wamp.error.canceled`. A live read feed adds recipe 1.                                                                                                                                                                                  |
| `register(u, (a, b) => …)`, `{extended: true}` with `(args, argskw, details)`                                      | one `InvocationMessage` argument: `inv.args`, `inv.kwargs`, `inv.details`, `inv.signal` ([3.3](#33-register))                                                                                                                                                                                                              |
| `progressiveRegister(u, fn)`                                                                                       | `register(u, handler)` returning an Observable: progressive YIELDs go to callers that asked for progress ([3.3](#33-register))                                                                                                                                                                                             |
| `onOpen.map(({welcomeMsg}) => welcomeMsg.details)`, `welcomeMsg.sessionId`                                         | `onOpen.map((s) => s.details)`, `s.id`                                                                                                                                                                                                                                                                                     |
| `onOpen.flatMap(({messages}) => messages)`                                                                         | delete (`SessionData.messages` is gone)                                                                                                                                                                                                                                                                                    |
| `onClose` (a GoodbyeMessage or `undefined`), `onError` (strings)                                                   | `onClose`: a `CloseInfo`, always an object, ABORTs included; router text in `details.message`; `initiator` is `'app'`, `'router'` or `'connection'`. There is no `onError` ([3.5](#35-lifecycle-onopen-onclose-and-is-it-open)).                                                                                           |
| `e.errorUri`, `e.args[0]`, `e.message === uri`                                                                     | unchanged on `WampError`                                                                                                                                                                                                                                                                                                   |
| `e instanceof WampErrorException`                                                                                  | `isWampError(e)` ([3.6](#36-error-handling))                                                                                                                                                                                                                                                                               |
| "is this a transport failure?" checks                                                                              | `isThruwayError(e) && !isWampError(e)` (`isThruwayError` alone also matches `WampError`)                                                                                                                                                                                                                                   |
| `err.args[n].uri` (the `{uri}` 2.x appended)                                                                       | `err.procedure`                                                                                                                                                                                                                                                                                                            |
| `result.argskw`                                                                                                    | `result.kwargs` (on results, events and invocations)                                                                                                                                                                                                                                                                       |
| `publish(uri, value)` (hot)                                                                                        | `publish(uri, [value]).subscribe()` (cold: nothing is sent without a subscriber)                                                                                                                                                                                                                                           |
| `publish(uri, observable)`                                                                                         | your Rx library's `concatMap` over `publish` ([3.4](#34-topics-and-publish), recipe 13)                                                                                                                                                                                                                                    |
| deep imports `thruway.js/src/Messages/*`, `thruway.js/src/Common/WampErrorException`                               | `import type {ResultMessage, ChallengeMessage, Session, EventMessage, InvocationMessage} from 'thruway.js'`; `WampError`. `WelcomeMessage` becomes `Session` (`s.details` is `WelcomeDetails`).                                                                                                                            |
| keep-open hacks: a dummy `wamp.topic(…).subscribe()`, a long-lived `onOpen` subscription                           | delete: the connection no longer depends on subscribers (`autoOpen` defaults to `true`)                                                                                                                                                                                                                                    |
| `wamp.defaultRetryWhen(...)`, `retryWhen`, `consecutiveFailures` resets in `onOpen`                                | `retryOptions` (and `retryDelay`), `close()`, `open()`, `reconnect()`; the counter resets by itself after a stable session                                                                                                                                                                                                 |
| `close(); open()` to re-authenticate                                                                               | `reconnect()` (streams survive)                                                                                                                                                                                                                                                                                            |
| `config.next({..., options: {authid}})` on a config Observable, to change identity                                 | `authmethods`, `authid`, `authextra` as functions, then `reconnect()` (streams survive; [README recipe 11](README.md#11-re-authenticate))                                                                                                                                                                                  |
| the `ws` dependency in Node                                                                                        | delete, unless you keep it as the `WebSocket` option ([3.13](#313-node))                                                                                                                                                                                                                                                   |
| Promise helpers on raw streams                                                                                     | through the adapter (`wamp.call(…).toPromise()` in RxJS 5, `lastValueFrom(wamp.call(…))` in RxJS 7) or `from(client.call(…))`                                                                                                                                                                                              |

The v2 error strings map to typed errors: `'Connection Closed'` is `ConnectionLostError` (in flight, the client
reconnects) or `ConnectionClosedError` (`close()` or give-up); `'Transport Timeout'` is `TimeoutError{timer:
'connect'}` in `CloseInfo.error`; `'Connection ended because …'` is `AbortError` in `CloseInfo` (structured `reason`
and `details`); `WampErrorException` is `WampError`; `WampChallengeException` is `AuthenticationError`.

### Helpers for RxJS 5 code

These are the recipes an RxJS 5 app needs most, written with patched operators. Put them in one module (say
`wampHelpers.ts`) next to the module that creates the client:

<!-- doctest: rx5-helpers rxjs5 -->

```ts
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/shareReplay';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/timeout';
import { isThruwayError, isWampError, type ConnectionLostError } from 'thruway.js';

export const isLost = (e: unknown): e is ConnectionLostError => isThruwayError(e) && e.code === 'connection_lost';
const CANCELED = new Set(['wamp.error.canceled', 'wamp.error.cancelled']);
const TRANSIENT = new Set(['wamp.error.no_such_procedure', ...CANCELED, 'wamp.error.no_eligible_callee']);
const FRAME_REJECTED = new Set([1002, 1003, 1007, 1009, 1011]);

/** Worth asking a read again: the connection was lost, or the backend is restarting (recipe 1). */
export const transient = (e: unknown): boolean =>
  (isLost(e) && !FRAME_REJECTED.has(e.closeCode ?? 0)) || (isWampError(e) && TRANSIENT.has(e.uri));
/** A write whose outcome is unknown (recipe 3). */
export const outcomeUnknown = (e: unknown): boolean =>
  isLost(e) ||
  (isThruwayError(e) && e.code === 'connection_closed' && isLost(e.cause)) ||
  (isWampError(e) && CANCELED.has(e.uri));
/** RxJS's own timeout error (not the client's TimeoutError). */
export const isRxTimeout = (e: unknown): boolean =>
  e instanceof Error && e.name === 'TimeoutError' && !isThruwayError(e);

/** Retry `src` with capped exponential backoff while `retryable(e)`; each value resets the backoff. */
const retryWith =
  (retryable: (e: unknown) => boolean, base: number) =>
  <T>(src: Observable<T>): Observable<T> =>
    Observable.defer(() => {
      let failures = 0;
      return src
        .do(() => {
          failures = 0;
        })
        .retryWhen((errors) =>
          errors.mergeMap((e: unknown) =>
            retryable(e) ? Observable.timer(Math.min(30000, base * 2 ** ++failures)) : Observable.throw(e),
          ),
        );
    });

/** Recipe 1: a read that is asked again after a lost connection and while backends restart. */
export const liveRead = retryWith(transient, 500);

/** Recipe 5: a topic that outlives a revocation or an unanswered SUBSCRIBE. */
export const durableTopic = retryWith(
  (e) => isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked'))),
  1000,
);

export class OutcomeUnknown extends Error {
  constructor(readonly reason: unknown) {
    super('the outcome of this write is unknown');
  }
}

/** Recipe 3: one CALL, held until its RESULT or ERROR (never cancelled); its answer, or OutcomeUnknown after a lost
 *  connection or `ms`. Hot: the CALL is sent when write() is called. */
export const write = <T>(call$: Observable<T>, ms = 15000): Observable<T> => {
  const held$ = call$.shareReplay(1);
  held$.subscribe({ error: () => undefined });
  return held$
    .take(1)
    .timeout(ms)
    .catch((e: unknown) => Observable.throw(outcomeUnknown(e) || isRxTimeout(e) ? new OutcomeUnknown(e) : e));
};
```

RxJS 5 has no `retry({resetOnSuccess})`, hence the counter. RxJS 5.5's `shareReplay(1)` keeps the source subscribed
after its subscribers leave, which is what `write` needs: unsubscribing from the result never sends CANCEL.

## 2. Behaviour changes

1. No RxJS dependency or peer requirement. Streams are interop Observables without operators: use `rxClient`.
2. The connection is explicit (`autoOpen`, `open()`, `reconnect()`, `close()`), not reference-counted: no lazy
   connect, no disconnect when the last subscriber leaves.
3. `close()` sends GOODBYE, closes the socket, ends every operation and interest with `ConnectionClosedError`, and
   returns a Promise. `open()` after `close()` works in any timing. Work started after `close()` fails at once until
   `open()`.
4. Topics and registrations survive a router GOODBYE and `reconnect()` (in 2.x they completed or errored).
5. ABORT and every other end arrive structured on `onClose` and `status`. `onError` and the
   `'Connection ended because …'` strings are gone.
6. Calls in flight at any session end error with `ConnectionLostError` while the client reconnects, and with
   `ConnectionClosedError{gaveUp, cause}` when it stops (2.0.8 behaviour, now typed). Calls waiting for a session fail
   on `close()` or give-up instead of hanging.
7. No hidden retries: 2.x's `progressiveCall` re-sent the CALL after `wamp.error.canceled`; 3.0's never re-sends.
8. `publish` is cold and takes `(topic, args, kwargs, options)`. Values are not wrapped. `publish(uri, null)` no
   longer throws. A non-array `args` is rejected locally (it closed the connection on Crossbar).
9. `WampError` extends `Error`, keeps the router's `kwargs` and `details`, never appends `{uri}` to `args`, and its
   `name` is `'WampError'` (was `'WAMP Error'`).
10. Retry: full jitter on `initialRetryDelay × retryDelayGrowth^(n−1)` (2.x added `retryDelayGrowth^n` milliseconds to
    `initialRetryDelay`, so its delay stayed near 1.5 s for the first dozen attempts); `maxRetries` defaults to
    `Infinity` and counts consecutive failures; the counter resets after a session stayed up for 60 s, never on socket
    open; `retryWhen` is gone; `retryDelay` may give up with `null`. Invalid options throw `TypeError` at
    construction: `maxRetries` −1, negative, fractional or `NaN` (2.x used 10000 for `NaN`), and a realm that is not a
    valid URI.
11. New timers: connect 10 s and handshake 15 s (both grow after consecutive timeouts; 2.x had one 5 s `timeout`), the
    liveness probe (after 30 s idle, with a 20 s ping budget; earlier when a request waits for any reply),
    SUBSCRIBE/REGISTER answers 60 s, the GOODBYE wait 2 s.
12. CANCEL always carries `mode: 'killnowait'`.
13. HELLO carries only `agent`, `roles`, `authmethods`, `authid` and `authextra`; the announced features match the
    implementation. Other option keys, which 2.x copied into HELLO, are ignored.
14. A callee handler gets one `InvocationMessage` argument; an `undefined` result is a YIELD without arguments;
    progressive YIELDs go only to callers that asked for progress (2.x's `progressiveRegister` sent them to every
    caller); failures that are not a `WampError` answer `wamp.error.runtime_error` with the message (2.x answered
    `thruway.error.invocation_exception`); INTERRUPT is honoured; revocation is surfaced.
15. A malformed frame whose request cannot be identified aborts the session (`protocol_violation`) and the client
    reconnects; a malformed payload fails only its own operation; stray, late and unknown frames are dropped.
16. Two `topic()` subscriptions to the same topic and equivalent options share one router subscription;
    unsubscribing one no longer kills the other.
17. Invalid URIs and wrongly typed spec options are rejected locally (`wamp.error.invalid_uri`, `TypeError`) instead of
    being sent.
18. No console output except unhandled app errors through the default logger.
19. An observer without an error callback no longer throws into the client: the error is logged.
20. Deep `src/*` imports, the message classes, `WebSocketTransport`, `WebWorkerTransport`, Subject transports and
    `Observable<ThruwayConfig>` are removed.
21. Work started while the client has never been opened waits for `open()` (2.x started a lazy connection).
22. A WELCOME that is anonymous although you offered only non-anonymous methods, without a CHALLENGE, is an
    authentication failure, not a session.
23. On Thruway PHP, `replace_orphaned_sessions` (plural, forced by 2.x's `progressiveRegister`) was ignored by the
    router. 3.0 forces nothing; recipe 16 uses the real option, `replace_orphaned_session`.
24. `forward_timeout` in REGISTER options is rejected locally (`TypeError`): 2.x passed it on without implementing the
    callee side it requires.

## 3. Before and after

In the after code, `client` is a 3.0 `Client` and `wamp` is `rxClient(client, Observable.from)`: the client's streams
as RxJS 5 Observables with your patched operators, so the operator chains of the before code stay as they are and you
can move to 3.0 without moving to a new RxJS at the same time. [3.9](#39-rxjs-5-and-rxjs-67) shows the same with
RxJS 7's `pipe`. Code that needs no operator uses the client's own streams.

### 3.1 Construction and options

Before:

```ts
import { Client } from 'thruway.js';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';

const config = Observable.fromPromise(loadConfig()).map((cfg) => ({
  url: cfg.wampUrl,
  realm: 'realm1',
  options: { authmethods: ['ticket'], authid: 'joe' },
}));
// with a config Observable, 2.x read retryOptions from the third argument, not from config.options
export const wamp = new Client(config, undefined, { retryOptions: { maxRetryDelay: 15000, maxRetries: 20 } });

wamp.onChallenge((challenge) => challenge.filter((c) => c.authMethod === 'ticket').map(() => readTicket()));
```

After:

<!-- doctest: migrate-construct rxjs5 -->

```ts
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/from';

export const client = new Client(async () => (await loadConfig()).wampUrl, 'realm1', {
  authmethods: ['ticket'],
  authid: 'joe',
  onChallenge: () => readTicket(), // each CHALLENGE, on every handshake: a string, a Promise or an Observable
  retryOptions: { maxRetryDelay: 15000, maxRetries: 20 },
});
export const wamp = rxClient(client, Observable.from);
```

- The URL function runs at the start of every attempt, so a changed configuration applies to the next connection
  (2.x read the configuration Observable once). A throw or rejection fails that attempt, which is retried.
- All options are in one object. `onChallenge` is called only for methods you offered (a CHALLENGE for another one
  fails the handshake with `AuthenticationError`), so the `filter` goes.
- `maxRetries` counts consecutive failed attempts (default `Infinity`); the backoff now multiplies (part 2, item 10),
  so check your `maxRetryDelay`.
- 2.x's single `timeout` option (5 s) becomes `timeouts: { connect, handshake }` (10 s and 15 s by default).
- `thruway.js/auth` has helpers for `ticket`, `wampcra` and `cryptosign` that offer the method and answer its
  CHALLENGE:

<!-- doctest: migrate-auth-helper -->

```ts
import { Client } from 'thruway.js';
import { ticket } from 'thruway.js/auth';

const client = new Client(url, 'realm1', {
  ...ticket('joe', () => readTicket()),
  retryOptions: { maxRetryDelay: 15000 },
});
```

### 3.2 Calls

Before:

```ts
import { ResultMessage } from 'thruway.js/src/Messages/ResultMessage';

wamp
  .call('com.example.add', [2, 3])
  .map((r: ResultMessage) => r.args[0])
  .subscribe((sum) => show(sum));

wamp
  .progressiveCall('com.example.report', ['2026-Q3'], { format: 'rows' })
  .subscribe((r: ResultMessage) => render(r.args, r.argskw));
```

After:

<!-- doctest: migrate-call rxjs5 -->

```ts
import type { ResultMessage } from 'thruway.js';

wamp
  .call('com.example.add', [2, 3])
  .map((r: ResultMessage) => r.args[0] as number)
  .subscribe((sum) => show(sum));

wamp
  .progressiveCall('com.example.report', ['2026-Q3'], { format: 'rows' })
  .subscribe((r: ResultMessage) => render(r.args, r.kwargs, r.details.progress === true)); // true: more follow
```

- `argskw` is `kwargs`. `args` is always an array and `kwargs` always an object, empty when the router sent none.
  Progressive results keep `details.progress` (2.x deleted it); an empty final result after them completes the
  stream without a value.
- `progressiveCall` copies its options (2.x set `receive_progress` on your object) and never re-sends the CALL: 2.x
  re-sent it 5 s after `wamp.error.canceled`. A live feed that must survive a lost connection or a restarting
  backend uses recipe 1 (`liveRead` in the [RxJS 5 helpers](#helpers-for-rxjs-5-code)).
- Unsubscribing before the final result still sends CANCEL. A call in flight when the session ends errors with
  `ConnectionLostError`; a call made while the client is reconnecting waits and is sent once.
- There is no call timeout option: use your Rx library's `timeout()` (recipe 2).

### 3.3 Register

Before:

```ts
import { WampErrorException } from 'thruway.js/src/Common/WampErrorException';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/take';

wamp.register('com.example.add', (a: number, b: number) => a + b).subscribe();

wamp
  .register('com.example.greet', (args: any[], argskw: any) => `Hello, ${argskw.name}`, { extended: true })
  .subscribe();

// every value is a progressive YIELD, whatever the caller asked for
wamp
  .progressiveRegister('com.example.countdown', (start: number) =>
    Observable.timer(0, 1000)
      .map((i) => start - i)
      .take(start + 1),
  )
  .subscribe();

wamp
  .register('com.example.divide', (a: number, b: number) => {
    if (b === 0) throw new WampErrorException('com.example.error.division_by_zero', ['b must not be 0']);
    return a / b;
  })
  .subscribe();
```

After:

<!-- doctest: migrate-register rxjs5 -->

```ts
import { WampError, type InvocationMessage } from 'thruway.js';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/take';

wamp.register('com.example.add', (inv: InvocationMessage) => Number(inv.args[0]) + Number(inv.args[1])).subscribe();

wamp.register('com.example.greet', (inv: InvocationMessage) => `Hello, ${String(inv.kwargs['name'])}`).subscribe();

// each value is a progressive YIELD when the caller asked for progress; otherwise only the last value is sent
wamp
  .register('com.example.countdown', (inv: InvocationMessage) => {
    const start = Number(inv.args[0]);
    return Observable.timer(0, 1000)
      .map((i) => start - i)
      .take(start + 1);
  })
  .subscribe();

wamp
  .register('com.example.divide', (inv: InvocationMessage) => {
    const [a, b] = inv.args as [number, number];
    if (b === 0) throw new WampError('com.example.error.division_by_zero', ['b must not be 0']);
    return a / b;
  })
  .subscribe({ error: (e: unknown) => report(e) }); // a refused REGISTER or a revocation
```

- The handler gets one `InvocationMessage` (`args`, `kwargs`, `details`, `procedure`, `signal`); the `extended`
  option is gone. It may return a value, a `Yield` (to answer with `args` and `kwargs`, which 2.x could not), a
  Promise, an Observable or an async iterable.
- `progressiveRegister` is gone, and with it 2.x's forced `replace_orphaned_sessions` option, which Thruway PHP ignored
  (recipe 16 has the option that works). A callee that must take its procedure over from a dead session of its own
  after a restart passes Thruway PHP's `replace_orphaned_session: 'yes'` or Crossbar's `force_reregister: true`.
- A thrown `WampError` answers with its `uri`, `args` and `kwargs`. Any other failure answers
  `wamp.error.runtime_error` with the error's message.
- A caller's cancel (INTERRUPT) unsubscribes a returned Observable and aborts `inv.signal`: pass it to `fetch` and
  other cancellable work.
- The stream emits a `RegisteredMessage` each time the registration becomes active: it is registered again after every
  reconnect, and unsubscribing sends UNREGISTER.

### 3.4 Topics and publish

Before:

```ts
import { EventMessage } from 'thruway.js/src/Messages/EventMessage';
import 'rxjs/add/observable/interval';
import 'rxjs/add/operator/map';

const prices = wamp.topic('com.example.ticker').map((e: EventMessage) => e.args[0]);
prices.subscribe((price) => show(price));

wamp.publish('com.example.status', 'online'); // sent as args ['online']
const ticking = wamp.publish('com.example.ticker', Observable.interval(1000)); // a Subscription
```

After:

<!-- doctest: migrate-topic-publish rxjs5 -->

```ts
import type { EventMessage } from 'thruway.js';
import 'rxjs/add/observable/interval';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/map';

const prices = wamp.topic('com.example.ticker').map((e: EventMessage) => e.args[0] as number);
prices.subscribe((price) => show(price));

wamp.publish('com.example.status', ['online']).subscribe(); // cold: subscribe to send it

// a stream: one PUBLISH per value, each after the router acknowledged the previous one (recipe 13)
const ticking = Observable.interval(1000)
  .concatMap((n) => wamp.publish('com.example.ticker', [n], {}, { acknowledge: true }))
  .subscribe();
```

- A topic never completes or errors because the connection was lost: it is subscribed again after every reconnect
  (2.x completed it at `onClose`). It errors on a refusal or a revocation (recipe 5).
- `publish` takes the `args` array and optional `kwargs` and options; the value is no longer wrapped for you. It sends
  when subscribed, waits for a session if there is none, and completes when the frame was written (or, with
  `acknowledge: true`, when the router answered).
- An Observable is no longer an argument of `publish`: pick the flow control and the offline policy with your Rx
  library (recipe 13).

### 3.5 Lifecycle: onOpen, onClose and "is it open?"

Before:

```ts
import { WelcomeMessage } from 'thruway.js/src/Messages/WelcomeMessage';

let isOpen = false;
wamp.onOpen.subscribe(({ welcomeMsg }: { welcomeMsg: WelcomeMessage }) => {
  isOpen = true;
  setConnected(true);
  log(`session ${welcomeMsg.sessionId} as ${welcomeMsg.details.authid}`);
});
wamp.onClose.subscribe(() => {
  isOpen = false; // a GoodbyeMessage, an AbortMessage, or undefined after close()
  setConnected(false);
});
wamp.onError.subscribe((e: Error) => {
  isOpen = false; // 'Transport Timeout', 'Connection ended because …', a socket error
  setConnected(false);
  log(`connection error: ${e.message}`);
});
```

After:

<!-- doctest: migrate-lifecycle -->

```ts
client.onOpen.subscribe((session) => {
  log(`session ${String(session.id)} as ${session.details.authid ?? 'anonymous'}`);
});
client.onClose.subscribe((c) => {
  // every end, ABORTs included: who ended it, why, and whether the client reconnects
  log(
    `closed by ${c.initiator}: ${c.reason ?? c.error?.message ?? 'socket closed'}${c.willRetry ? ', reconnecting' : ''}`,
  );
});

const isOpen = (): boolean => client.session !== undefined;
client.status.subscribe((s) => {
  setConnected(s.state === 'open'); // the current status at once, then every change
});
```

- `onOpen` emits a `Session` (`id`, `realm`, `details`), replayed to late subscribers as before.
- `onClose` emits a `CloseInfo` for every end of an attempt or session: `initiator` (`'app'`, `'router'`,
  `'connection'`), `reason` and `details` of an ABORT or GOODBYE, `error` (a typed error: a timeout, a socket failure,
  an `AbortError`), `willRetry`, `delay` and `attempt`. It is not replayed. There is no `onError`.
- `status` is the state machine's view (`connecting` with the attempt number, `open` with the session, `closed`) and
  the source for a connected flag or an outage banner (recipe 7). `session` reads the open session now.

### 3.6 Error handling

Before:

```ts
import { WampErrorException } from 'thruway.js/src/Common/WampErrorException';

wamp.call('com.example.report', [42]).subscribe(
  (r) => show(r.args[0]),
  (e: any) => {
    if (e instanceof WampErrorException) {
      // args ends with the {uri: procedure} 2.x appended
      showError(e.errorUri === 'com.example.error.not_found' ? 'No such report.' : String(e.args[0]));
    } else if (e.message === 'Connection Closed') {
      showError('Disconnected.');
    } else {
      showError(e.message); // 'Transport Timeout', 'Connection ended because …'
    }
  },
);
```

After:

<!-- doctest: migrate-errors -->

```ts
import { isThruwayError, isWampError } from 'thruway.js';

wamp.call('com.example.report', [42]).subscribe(
  (r) => show(r.args[0]),
  (e: unknown) => {
    if (isWampError(e)) {
      // an ERROR from the router or the callee: its URI, args and kwargs as sent, and the procedure called
      showError(e.uri === 'com.example.error.not_found' ? 'No such report.' : String(e.args[0] ?? e.uri));
    } else if (isThruwayError(e) && e.code === 'connection_lost') {
      showError('The connection was lost. Try again.'); // the client is reconnecting
    } else if (isThruwayError(e) && e.code === 'connection_closed') {
      showError('Disconnected.'); // close(), or the retry policy gave up
    } else {
      showError(String(e));
    }
  },
);
```

- `isWampError(e)` replaces `instanceof WampErrorException` and works across duplicate copies of the package. `uri`
  and `errorUri` are the same; `message` is still the URI, so `e.message === uri` checks keep working.
- `args` are the server's, without the `{uri}` 2.x appended: the procedure is `e.procedure`. `kwargs` and `details`
  are kept.
- Connection problems are typed errors with a stable `code`: `connection_lost`, `connection_closed`, `timeout`,
  `abort`, `protocol`, `canceled`, `authentication` (README, [Errors](README.md#errors)). Do not parse messages.
- An error your code did not handle is reported to the logger instead of being thrown into the client.

### 3.7 Writes that must not be retried

Before:

```ts
import 'rxjs/add/operator/retry';
import 'rxjs/add/operator/timeout';

// re-sent after a timeout or a lost connection: the order may be placed twice
wamp
  .call('com.example.order.place', [order])
  .timeout(5000)
  .retry(3)
  .subscribe(
    (r) => show(`Order ${r.args[0]} placed.`),
    (e) => showError(e.message),
  );
```

2.x's `progressiveCall` also re-sent its CALL after `wamp.error.canceled`, so writes made through it could run twice.

After (with the [RxJS 5 helpers](#helpers-for-rxjs-5-code)):

<!-- doctest: migrate-write rxjs5 -->

```ts
import { isWampError } from 'thruway.js';
import { OutcomeUnknown, write } from './wampHelpers';

/** One CALL, never cancelled and never re-sent; `key` is made once per user action and reused if it is resubmitted. */
const placeOrder = (order: Order, key: string) =>
  write(wamp.call('com.example.order.place', [order], { request_key: key }))
    .map((r) => `Order ${String(r.args[0])} placed.`)
    .catch((e: unknown) =>
      Observable.of(
        e instanceof OutcomeUnknown
          ? 'We could not confirm the order. Check your orders before placing it again.'
          : `The order was refused: ${String(isWampError(e) ? (e.args[0] ?? e.uri) : e)}`,
      ),
    );
```

- After a lost connection or the timeout, the order may or may not have been placed: say so instead of retrying.
  A write started while offline waits and is sent once at the next WELCOME.
- A timeout that unsubscribes would send CANCEL, which does not undo a write that already ran: `write` holds the CALL
  until its answer.
- An idempotency key lets the backend recognise a resubmission of the same action (recipe 3).

### 3.8 Stop reconnecting on a login failure

Before:

```ts
const wamp = new Client(url, 'realm1', {
  authmethods: ['ticket'],
  authid: 'joe',
  // an ABORT reached retryWhen as the text 'Connection ended because {…}reason'
  retryWhen: (attempts: Observable<Error>) =>
    attempts.mergeMap((e) => (/authentication_fail/.test(e.message) ? Observable.throw(e) : Observable.timer(5000))),
});
wamp.onChallenge((challenge) => challenge.map(() => readTicket()));
wamp.onError.subscribe((e: Error) => showLoginError(e.message));
```

Another 2.x workaround, `wamp.onChallenge(() => Observable.never())`, left the handshake unanswered and the socket
open.

After:

<!-- doctest: migrate-login-failure -->

```ts
import { Client, type CloseInfo } from 'thruway.js';

/** A refused login: the ABORT reason of the spec, of Crossbar and of Thruway PHP. */
const LOGIN_REFUSED = new Set([
  'wamp.error.authentication_failed',
  'wamp.error.not_authorized',
  'thruway.error.authentication_failure',
]);
const loginRefused = (c: CloseInfo): boolean => c.initiator === 'router' && LOGIN_REFUSED.has(c.reason ?? '');

const client = new Client(url, 'realm1', {
  authmethods: ['ticket'],
  authid: 'joe',
  onChallenge: () => readTicket(),
  retryOptions: { retryDelay: (attempt, closed, delay) => (loginRefused(closed) ? null : delay) },
});
client.onClose.subscribe((c) => {
  const message = c.details['message']; // the router's text, when it sent one
  if (loginRefused(c)) showLoginError(typeof message === 'string' ? message : 'Login refused.');
});
// after the user signed in again: client.open()
```

- `retryDelay` returning `null` stops the client: one `onClose` with `willRetry: false`, and every stream ends with
  `ConnectionClosedError{gaveUp: true}`. `open()` starts again, and the next CHALLENGE reads the new ticket.
- An ABORT of any other reason (a router restart, an outage of your authenticator) keeps reconnecting with backoff.
- To log in again with new credentials without stopping, call `reconnect()` (recipe 11): topics and registrations
  survive. Login dialogs that must outlive a dropped socket are recipe 17.

### 3.9 RxJS 5 and RxJS 6/7

2.x required RxJS 5 and patched the operators it used onto `Observable.prototype`, so code could call `.map` without
importing it. Before:

```ts
import { Client } from 'thruway.js';
import 'rxjs/add/operator/filter'; // map came patched by thruway.js 2.x

const wamp = new Client(url, 'realm1');
export const highPrices$ = wamp
  .topic('com.example.ticker')
  .map((e) => e.args[0] as number)
  .filter((price) => price > 100);
```

After, staying on RxJS 5 (5.4 or 5.5):

<!-- doctest: migrate-rxjs5 rxjs5 -->

```ts
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/from';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';

const client = new Client(url, 'realm1');
export const wamp = rxClient(client, Observable.from);
export const highPrices$ = wamp
  .topic('com.example.ticker')
  .map((e) => e.args[0] as number)
  .filter((price) => price > 100);
```

After, on RxJS 7 (RxJS 6 is the same, with the operators from `rxjs/operators`):

<!-- doctest: migrate-rxjs7 -->

```ts
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { filter, from, map } from 'rxjs';

const client = new Client(url, 'realm1');
export const wamp = rxClient(client, from);
export const highPrices$ = wamp.topic('com.example.ticker').pipe(
  map((e) => e.args[0] as number),
  filter((price) => price > 100),
);
```

- The adapter's types are `import('rxjs').Observable`, which is RxJS 5's in an RxJS 5 project, so patched operators
  type-check. 3.0 patches nothing: import every operator you call.
- Without the adapter: `from(client.topic(…))` in RxJS 7, `Observable.from(client.topic(…))` in RxJS 5. RxJS 9 and
  the platform Observable: `rxClient(client, (x) => Observable.from(x))`. Rx 4 can consume the raw streams with
  positional `subscribe(next, error, complete)`.
- You can move the app from RxJS 5 to 7 later, one module at a time: both adapters can wrap the same `client`.

### 3.10 An Angular service

Before (the 2.x README's pattern: the service is the client):

```ts
import { Injectable } from '@angular/core';
import { Client } from 'thruway.js';

@Injectable()
export class WampService extends Client {
  constructor() {
    super('wss://router.example.com/ws', 'realm1');
  }
}

// in a component
counter: Observable<number> = this.wamp.topic('com.example.counter').map((e: EventMessage) => e.args[0]);
```

After (RxJS 7, as current Angular uses; decorate the class with `@Injectable({ providedIn: 'root' })`):

<!-- doctest: migrate-angular -->

```ts
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { from, map, type Observable } from 'rxjs';

export class WampService {
  readonly client = new Client('wss://router.example.com/ws', 'realm1');
  private readonly wamp = rxClient(this.client, from);

  readonly connected$: Observable<boolean> = this.wamp.status.pipe(map((s) => s.state === 'open'));

  call<T>(procedure: string, args: unknown[] = []): Observable<T> {
    return this.wamp.call(procedure, args).pipe(map((r) => r.args[0] as T));
  }

  topic<T>(topic: string): Observable<T> {
    return this.wamp.topic(topic).pipe(map((e) => e.args[0] as T));
  }

  ngOnDestroy(): void {
    void this.client.close();
  }
}

// in a component: counter$ = this.wamp.topic<number>('com.example.counter');
```

- Wrap the client instead of extending it: the service exposes RxJS Observables for `async` pipes and operators, and
  the client stays one instance for the app.
- The connection opens when the service is created and stays open while components come and go.

### 3.11 A React hook

Before:

```ts
import { useEffect, useState } from 'react';
import { EventMessage } from 'thruway.js/src/Messages/EventMessage';

export function useTicker(): number | undefined {
  const [price, setPrice] = useState<number>();
  useEffect(() => {
    const subscription = wamp
      .topic('com.example.ticker')
      .map((e: EventMessage) => e.args[0])
      .subscribe(setPrice);
    return () => subscription.unsubscribe(); // the last unsubscribe also closed 2.x's socket
  }, []);
  return price;
}
```

After (no RxJS needed; `useEffect` and `useState` are React's):

<!-- doctest: migrate-react-hook -->

```ts
import { Client } from 'thruway.js';

// one client for the app, created once at module level
export const client = new Client('wss://router.example.com/ws', 'realm1');

/** The last value published on `topic`: SUBSCRIBE on mount, UNSUBSCRIBE on unmount. */
export function useTopicValue<T>(topic: string): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const subscription = client.topic(topic).subscribe({
      next: (event) => {
        setValue(event.args[0] as T);
      },
      error: (e: unknown) => {
        console.error(`${topic} ended`, e); // a refusal or a revocation, never a lost connection
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [topic]);
  return value;
}

/** Whether a session is open. */
export function useConnected(): boolean {
  const [connected, setConnected] = useState(client.session !== undefined);
  useEffect(() => {
    const subscription = client.status.subscribe((s) => {
      setConnected(s.state === 'open');
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);
  return connected;
}
```

- The client's streams have `subscribe`, which is all an effect needs. Components that subscribe to the same topic
  share one router subscription.
- Unmounting the last component no longer closes the connection, so StrictMode's double effects and route changes do
  not reconnect. Call `client.close()` yourself if the app must disconnect.
- `status` replays the current state to every subscriber, so `useConnected` is right on its first effect.

### 3.12 React Native

Before:

```ts
import { Client } from 'thruway.js';
import 'rxjs/add/operator/map';

export const wamp = new Client('wss://router.example.com/ws', 'realm1', { authmethods: ['wampcra'], authid: 'joe' });
wamp.onChallenge((challenge) =>
  challenge.map((c) => signChallenge(secret, (c.extra as { challenge: string }).challenge)),
);
// after a stay in the background, the app waited for 2.x's next retry
```

After:

<!-- doctest: migrate-react-native -->

```ts
import { Client, type Status } from 'thruway.js';

export const client = new Client('wss://router.example.com/ws', 'realm1', {
  authmethods: ['wampcra'],
  authid: 'joe',
  // Hermes has no WebCrypto, so thruway.js/auth's wampcra() cannot sign there: keep your own signer
  onChallenge: (c) => signChallenge(secret, String(c.extra['challenge'])),
});

// back in the foreground: cut a backoff wait, or probe a socket that may have died in the background (recipe 10)
let status: Status | undefined;
client.status.subscribe((s) => {
  status = s;
});
AppState.addEventListener('change', (state) => {
  if (state === 'active' && !(status?.state === 'closed' && status.closed?.willRetry === false)) client.open();
});
```

- React Native's global `WebSocket` works as is. `AppState` is React Native's.
- `open()` starts the next attempt now when the client is waiting to retry, and checks an open connection with a
  liveness probe. The guard keeps a stopped client (after `close()` or a give-up) stopped.
- With RxJS 7, set `config.onUnhandledError` (recipe 15): RxJS 7 rethrows unhandled errors from a timer, which React
  Native reports as fatal.

### 3.13 Node

Before (the 2.x README's example; `ws` was a peer dependency that the transport required):

```js
const Thruway = require('thruway.js');
const Rx = require('rxjs');

const wamp = new Thruway.Client('ws://127.0.0.1:8080/ws', 'realm1');
wamp.publish('com.example.counter', Rx.Observable.interval(1000));
```

After:

<!-- doctest: migrate-node -->

```ts
import WebSocket from 'ws';
import { Client } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';
import { concatMap, from, interval, lastValueFrom, take } from 'rxjs';

const client = new Client('ws://127.0.0.1:8080/ws', 'realm1', { WebSocket });
const wamp = rxClient(client, from);

const registration = wamp.register('com.example.add', (inv) => Number(inv.args[0]) + Number(inv.args[1])).subscribe();
await lastValueFrom(
  interval(1000).pipe(
    take(5),
    concatMap((n) => wamp.publish('com.example.counter', [n], {}, { acknowledge: true })),
  ),
);
registration.unsubscribe();
await client.close(); // the process can exit
```

- Node 22 and later have a global `WebSocket`, so `ws` is optional. Pass it for services and CLIs that must exit
  after `close()` even when the router stops answering ([Limits and caveats](README.md#limits-and-caveats)).
- 3.0 ships ESM and CommonJS: `const { Client } = require('thruway.js')` works too.

### 3.14 Tests with the testing kit

Before (a Subject transport fed with message classes from deep imports):

```ts
import { Subject } from 'rxjs/Subject';
import { Client } from 'thruway.js';
import { WelcomeMessage } from 'thruway.js/src/Messages/WelcomeMessage';
import { ResultMessage } from 'thruway.js/src/Messages/ResultMessage';

const sent: any[] = [];
const incoming = new Subject<any>();
const transport = Subject.create({ next: (m: any) => sent.push(m), error: () => {}, complete: () => {} }, incoming);
const wamp = new Client(transport, 'realm1');

const results: number[] = [];
wamp.call('com.example.add', [2, 3]).subscribe((r) => results.push(r.args[0]));
incoming.next(new WelcomeMessage(12345, {}));
incoming.next(new ResultMessage(sent[sent.length - 1].requestId, {}, [5]));
```

After:

<!-- doctest: migrate-testing-kit -->

```ts
import { Client } from 'thruway.js';
import { createTestRouter, createVirtualClock } from 'thruway.js/testing';

const clock = createVirtualClock();
const router = createTestRouter({ clock });
router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });

const results: unknown[] = [];
client.call('com.example.add', [2, 3]).subscribe((r) => results.push(r.args[0]));
await clock.advance(10);
expect(results).toEqual([5]);

// a drop and the reconnect, which a Subject transport could not show
router.drop();
await clock.advance(5000);
expect(client.session).toBeDefined();
expect(router.frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 1)).toHaveLength(2);

const closing = client.close();
await clock.runUntilIdle();
await closing;
```

- The router speaks real WAMP to the client: HELLO, CHALLENGE (with `authenticate`), WELCOME, calls, topics,
  registrations, ABORT, GOODBYE and drops. `frames` records every frame for assertions.
- The virtual clock runs the client's timers, so backoff, timeouts and liveness are tested without waiting. With Jest
  or Vitest fake timers, leave `clock` out.
- To stub the client in component tests, replace methods on the `rxClient` adapter: it is a plain object.

## 4. Checklist

1. Change the dependency to `"thruway.js": "^3.0.0"` and refresh the lockfile: a `^2` range never picks up 3.x
   (release candidates are under the `next` dist-tag: pin them exactly). Keep your RxJS (5.4 to 9). Remove `ws`
   unless you pass it as the `WebSocket` option.
2. Rewrite the module that creates the client ([3.1](#31-construction-and-options)), with its `onChallenge` and
   retry policy ([3.8](#38-stop-reconnecting-on-a-login-failure)), and wrap it with `rxClient`
   ([3.9](#39-rxjs-5-and-rxjs-67)).
3. In the same change, rewrite the error helpers that read strings or the appended `{uri}`
   ([3.6](#36-error-handling)). A text parser left behind silently turns login failures into "disconnected".
4. Delete keep-open subscriptions, retry counters reset in `onOpen`, and `onError` handlers
   ([3.5](#35-lifecycle-onopen-onclose-and-is-it-open)).
5. Point deep imports (`thruway.js/src/…`) at the root: `import type {…} from 'thruway.js'`.
6. Sort calls into reads, which may be asked again (recipe 1), and writes, which must not be
   ([3.7](#37-writes-that-must-not-be-retried)); writes made through `progressiveCall` are now sent exactly once.
7. Give every long-lived pipeline that maps values to calls an error handler: a call that fails (a lost connection is
   now an error) ends a `mergeMap` chain without one.
8. Update comments and documents that describe 2.x behaviour, such as "a call caught by a dropped connection never
   answers" or "topics complete when the connection closes".
9. Move tests from Subject transports to `thruway.js/testing` ([3.14](#314-tests-with-the-testing-kit)).
10. Check your router: it must answer `CALL thruway.js.ping` (any answer counts, `no_such_procedure` and
    `not_authorized` included), or turn liveness off with `timeouts: { idle: 0 }`; and it must not WELCOME a client
    anonymously, without a CHALLENGE, when the client offered only non-anonymous methods (add `'anonymous'` to
    `authmethods` if that is expected). The README's [Routers](README.md#routers) section has notes per router.
