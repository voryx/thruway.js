// MIGRATION.md's doctests: the 3.0 code of each "after" block — the RxJS 5 helpers, then the before-and-after sections
// — run against the testing kit's reference router under vitest's fake timers. RxJS 5 code runs on RxJS 5.5.12
// (`rxjs5`), loaded the way such apps load it: the Observable class plus one `add/` file per operator. `rxClient` is
// shadowed in those tests by `rxClient5`, the same function typed the way an RxJS 5 project sees it (doctest.ts). The
// app's own functions (show, loggers, token readers) are stubs defined before each region. recipes.test.ts checks that
// each region is the code of its MIGRATION.md block.
/* eslint-disable @typescript-eslint/no-unsafe-return -- RxJS 5's types */
/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-type-parameters -- doc code writes callbacks and hooks the way apps write them */
/* eslint-disable @typescript-eslint/no-deprecated -- the docs pass RxJS's `from` as apps do (only its scheduler overload is deprecated) */
import { Observable } from 'rxjs5/Observable.js';
import 'rxjs5/add/observable/defer.js';
import 'rxjs5/add/observable/from.js';
import 'rxjs5/add/observable/interval.js';
import 'rxjs5/add/observable/of.js';
import 'rxjs5/add/observable/throw.js';
import 'rxjs5/add/observable/timer.js';
import 'rxjs5/add/operator/catch.js';
import 'rxjs5/add/operator/concatMap.js';
import 'rxjs5/add/operator/do.js';
import 'rxjs5/add/operator/filter.js';
import 'rxjs5/add/operator/map.js';
import 'rxjs5/add/operator/mergeMap.js';
import 'rxjs5/add/operator/retryWhen.js';
import 'rxjs5/add/operator/shareReplay.js';
import 'rxjs5/add/operator/take.js';
import 'rxjs5/add/operator/timeout.js';
import 'rxjs5/add/operator/toPromise.js';
import {
  concatMap,
  filter,
  firstValueFrom,
  from,
  interval,
  lastValueFrom,
  map,
  take,
  type Observable as Rx7Observable,
} from 'rxjs';
import { beforeAll, describe, expect, test } from 'vitest';
import { ticket } from '../../src/auth/index.js';
import {
  Client,
  WampError,
  Yield,
  isThruwayError,
  isWampError,
  type ClientOptions,
  type CloseInfo,
  type ConnectionLostError,
  type EventMessage,
  type InvocationMessage,
  type ResultMessage,
  type Status,
} from '../../src/index.js';
import { rxClient } from '../../src/rxjs/index.js';
import { createTestRouter, createVirtualClock, type AuthDecision } from '../../src/testing/index.js';
import { T, fakeTimersForRx5, never, rxClient5, useDocEnv, type DocEnv } from './doctest.js';

beforeAll(() => {
  fakeTimersForRx5();
});

const url = 'wss://router.example.com/ws';

/**
 * The router of these tests: the first offered method is CHALLENGEd; `wampcra` (any signature) and `ticket` with the
 * ticket 'secret1' are welcomed as joe; another ticket is ABORTed `refusal` with `details.message`; a HELLO without
 * methods is welcomed anonymously.
 */
function authenticateWith(refusal: string) {
  return (hello: { realm: string; details: Record<string, unknown> }): AuthDecision => {
    const methods = hello.details['authmethods'];
    if (!Array.isArray(methods) || methods.length === 0) return { welcome: { authrole: 'anonymous' } };
    const method = String(methods[0]);
    return {
      challenge: { method, extra: method === 'wampcra' ? { challenge: '{"nonce":"doc"}' } : {} },
      verify: (signature) =>
        method === 'wampcra' || signature === 'secret1'
          ? { welcome: { authid: 'joe', authrole: 'user', authmethod: method } }
          : { abort: refusal, details: { message: 'invalid ticket' } },
    };
  };
}
const authenticate = authenticateWith('wamp.error.authentication_failed');

/** A client tracked by the doc environment, and its RxJS 5 adapter (the `client` and `wamp` of MIGRATION part 3). */
function rx5(env: { readonly current: DocEnv }, options: ClientOptions = {}) {
  const client = env.current.track(new Client(url, 'realm1', options));
  return { client, wamp: rxClient5(client, Observable.from) };
}

/** Every value of a stream, once it completed. */
function collect<V>(source: {
  subscribe(observer: { next(v: V): void; error(e: unknown): void; complete(): void }): unknown;
}): Promise<V[]> {
  return new Promise<V[]>((resolve, reject) => {
    const values: V[] = [];
    source.subscribe({
      next: (v) => values.push(v),
      error: reject,
      complete: () => {
        resolve(values);
      },
    });
  });
}

const lastOf = <V>(o: Observable<V>): Promise<V> => o.toPromise();
const argsOf = (results: readonly ResultMessage[]): unknown[] => results.map((r) => r.args);

// --- the RxJS 5 helpers (module level, as in an app's wampHelpers.ts) ---------------------------------------------

// doctest: rx5-helpers
const isLost = (e: unknown): e is ConnectionLostError => isThruwayError(e) && e.code === 'connection_lost';
const CANCELED = new Set(['wamp.error.canceled', 'wamp.error.cancelled']);
const TRANSIENT = new Set(['wamp.error.no_such_procedure', ...CANCELED, 'wamp.error.no_eligible_callee']);
const FRAME_REJECTED = new Set([1002, 1003, 1007, 1009, 1011]);

/** Worth asking a read again: the connection was lost, or the backend is restarting (recipe 1). */
const transient = (e: unknown): boolean =>
  (isLost(e) && !FRAME_REJECTED.has(e.closeCode ?? 0)) || (isWampError(e) && TRANSIENT.has(e.uri));
/** A write whose outcome is unknown (recipe 3). */
const outcomeUnknown = (e: unknown): boolean =>
  isLost(e) ||
  (isThruwayError(e) && e.code === 'connection_closed' && isLost(e.cause)) ||
  (isWampError(e) && CANCELED.has(e.uri));
/** RxJS's own timeout error (not the client's TimeoutError). */
const isRxTimeout = (e: unknown): boolean => e instanceof Error && e.name === 'TimeoutError' && !isThruwayError(e);

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
const liveRead = retryWith(transient, 500);

/** Recipe 5: a topic that outlives a revocation or an unanswered SUBSCRIBE. */
const durableTopic = retryWith(
  (e) => isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked'))),
  1000,
);

class OutcomeUnknown extends Error {
  constructor(readonly reason: unknown) {
    super('the outcome of this write is unknown');
  }
}

/** Recipe 3: one CALL, held until its RESULT or ERROR (never cancelled); its answer, or OutcomeUnknown after a lost
 *  connection or `ms`. Hot: the CALL is sent when write() is called. */
const write = <T>(call$: Observable<T>, ms = 15000): Observable<T> => {
  const held$ = call$.shareReplay(1);
  held$.subscribe({ error: () => undefined });
  return held$
    .take(1)
    .timeout(ms)
    .catch((e: unknown) => Observable.throw(outcomeUnknown(e) || isRxTimeout(e) ? new OutcomeUnknown(e) : e));
};
// doctest-end

describe('the RxJS 5 helpers', () => {
  const env = useDocEnv({ authenticate });

  test('liveRead re-issues after no_such_procedure and a lost connection; write holds its CALL and reports the unknown', async () => {
    const { router } = env.current;
    const { wamp } = rx5(env, { timeouts: { idle: 0 } });
    const seen: unknown[] = [];
    const read = liveRead(wamp.call('com.example.board', ['current'])).subscribe((r) => seen.push(r.args[0]));
    await env.current.advance(10); // no_such_procedure: asked again after 1 s
    router.procedure('com.example.board', () => 'board');
    await env.current.advance(1000);
    expect(seen).toEqual(['board']);
    read.unsubscribe();
    router.procedure('com.example.order.place', never);
    const outcome = lastOf(write(wamp.call('com.example.order.place', [{ item: 'A' }]), 5000)).catch((e: unknown) => e);
    await env.current.advance(5000);
    const e = await outcome;
    expect(e).toBeInstanceOf(OutcomeUnknown);
    expect(isRxTimeout((e as OutcomeUnknown).reason)).toBe(true);
    expect(env.current.written(T.CANCEL)).toEqual([]); // the write is never cancelled
    const topic = durableTopic(wamp.topic('com.example.status')).subscribe();
    await env.current.advance(10);
    router.revokeSubscription('com.example.status', 'revoked');
    await env.current.advance(2100);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(2); // subscribed again after the revocation
    topic.unsubscribe();
    router.drop();
    await env.current.advance(5000);
  });
});

// --- 3.1 construction and options ----------------------------------------------------------------------------------

describe('MIGRATION 3.1 (construction and options)', () => {
  const env = useDocEnv({ authenticate });

  test('the URL function runs per attempt; the ticket answers each CHALLENGE; the retry options apply', async () => {
    const { router } = env.current;
    const rxClient = rxClient5;
    let loads = 0;
    const loadConfig = (): Promise<{ wampUrl: string }> => {
      loads++;
      return Promise.resolve({ wampUrl: url });
    };
    const readTicket = (): string => 'secret1';
    // doctest: migrate-construct
    const client = new Client(async () => (await loadConfig()).wampUrl, 'realm1', {
      authmethods: ['ticket'],
      authid: 'joe',
      onChallenge: () => readTicket(), // each CHALLENGE, on every handshake: a string, a Promise or an Observable
      retryOptions: { maxRetryDelay: 15000, maxRetries: 20 },
    });
    const wamp = rxClient(client, Observable.from);
    // doctest-end
    env.current.track(client);
    await env.current.advance(50);
    expect(client.session?.details.authid).toBe('joe');
    expect(env.current.written(T.HELLO)[0]?.[2]).toMatchObject({ authmethods: ['ticket'], authid: 'joe' });
    expect(env.current.written(T.AUTHENTICATE)[0]?.[1]).toBe('secret1');
    router.drop();
    await env.current.advance(20000);
    expect(loads).toBe(2); // the URL function ran again for the reconnect
    expect(client.session).toBeDefined();
    expect(env.current.written(T.AUTHENTICATE)).toHaveLength(2);
    const sessions: unknown[] = [];
    wamp.onOpen.map((s) => s.details.authid).subscribe((id) => sessions.push(id));
    expect(sessions).toEqual(['joe']);
  });

  test('the ticket() helper offers the method and answers its CHALLENGE', async () => {
    const readTicket = (): string => 'secret1';
    // doctest: migrate-auth-helper
    const client = new Client(url, 'realm1', {
      ...ticket('joe', () => readTicket()),
      retryOptions: { maxRetryDelay: 15000 },
    });
    // doctest-end
    env.current.track(client);
    await env.current.advance(50);
    expect(env.current.written(T.HELLO)[0]?.[2]).toMatchObject({ authmethods: ['ticket'], authid: 'joe' });
    expect(client.session?.details.authmethod).toBe('ticket');
  });
});

// --- 3.2 calls -------------------------------------------------------------------------------------------------------

describe('MIGRATION 3.2 (calls)', () => {
  const env = useDocEnv({ authenticate });

  test('call maps args[0]; progressiveCall delivers every result with kwargs and details.progress', async () => {
    const { router } = env.current;
    const { wamp } = rx5(env);
    const shown: unknown[] = [];
    const show = (value: unknown): void => {
      shown.push(value);
    };
    const rendered: unknown[] = [];
    const render = (args: readonly unknown[], kwargs: Readonly<Record<string, unknown>>, more: boolean): void => {
      rendered.push([args, kwargs, more]);
    };
    router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    router.procedure('com.example.report', () =>
      Observable.of(new Yield(['row 1']), new Yield(['row 2'], { rows: 2 })),
    );
    // doctest: migrate-call
    wamp
      .call('com.example.add', [2, 3])
      .map((r: ResultMessage) => r.args[0] as number)
      .subscribe((sum) => show(sum));

    wamp
      .progressiveCall('com.example.report', ['2026-Q3'], { format: 'rows' })
      .subscribe((r: ResultMessage) => render(r.args, r.kwargs, r.details.progress === true)); // true: more follow
    // doctest-end
    await env.current.advance(50);
    expect(shown).toEqual([5]);
    // the empty final RESULT after progressive ones completes the stream without a value
    expect(rendered).toEqual([
      [['row 1'], {}, true],
      [['row 2'], { rows: 2 }, true],
    ]);
    const report = env.current.written(T.CALL).find((f) => f[3] === 'com.example.report');
    expect(report?.[2]).toEqual({ receive_progress: true });
    expect(report?.slice(4)).toEqual([['2026-Q3'], { format: 'rows' }]);
  });
});

// --- 3.3 register ---------------------------------------------------------------------------------------------------

describe('MIGRATION 3.3 (register)', () => {
  const env = useDocEnv({ authenticate });

  test('one InvocationMessage argument; kwargs; progressive results only for callers that asked; a WampError answer', async () => {
    const { wamp } = rx5(env);
    const reported: unknown[] = [];
    const report = (e: unknown): void => {
      reported.push(e);
    };
    // doctest: migrate-register
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
    // doctest-end
    await env.current.advance(50);
    expect(env.current.written(T.REGISTER).map((f) => f[3])).toEqual([
      'com.example.add',
      'com.example.greet',
      'com.example.countdown',
      'com.example.divide',
    ]);
    const caller = env.current.track(new Client(url, 'realm1'));
    const sum = collect(caller.call('com.example.add', [2, 3]));
    const greeting = collect(caller.call('com.example.greet', [], { name: 'Ann' }));
    const countdown = collect(caller.progressiveCall('com.example.countdown', [2]));
    const last = collect(caller.call('com.example.countdown', [2]));
    const divided = collect(caller.call('com.example.divide', [1, 0])).catch((e: unknown) => e);
    await env.current.advance(3000);
    expect(argsOf(await sum)).toEqual([[5]]);
    expect(argsOf(await greeting)).toEqual([['Hello, Ann']]);
    expect(argsOf(await countdown).slice(0, 3)).toEqual([[2], [1], [0]]);
    expect(argsOf(await last)).toEqual([[0]]);
    expect(await divided).toMatchObject({ uri: 'com.example.error.division_by_zero', args: ['b must not be 0'] });
    expect(reported).toEqual([]);
  });
});

// --- 3.4 topics and publish -------------------------------------------------------------------------------------------

describe('MIGRATION 3.4 (topics and publish)', () => {
  const env = useDocEnv({ authenticate });

  test('a topic survives a drop; publish takes args and is cold; a stream publishes one value per acknowledgement', async () => {
    const { router } = env.current;
    const { wamp } = rx5(env);
    const shown: unknown[] = [];
    const show = (value: unknown): void => {
      shown.push(value);
    };
    // doctest: migrate-topic-publish
    const prices = wamp.topic('com.example.ticker').map((e: EventMessage) => e.args[0] as number);
    prices.subscribe((price) => show(price));

    wamp.publish('com.example.status', ['online']).subscribe(); // cold: subscribe to send it

    // a stream: one PUBLISH per value, each after the router acknowledged the previous one (recipe 13)
    const ticking = Observable.interval(1000)
      .concatMap((n) => wamp.publish('com.example.ticker', [n], {}, { acknowledge: true }))
      .subscribe();
    // doctest-end
    await env.current.advance(50);
    expect(env.current.written(T.PUBLISH)[0]).toEqual([16, expect.any(Number), {}, 'com.example.status', ['online']]);
    router.publish('com.example.ticker', [101.5]);
    await env.current.advance(10);
    router.drop(); // 2.x completed the topic here
    await env.current.advance(5000);
    router.publish('com.example.ticker', [102]);
    await env.current.advance(10);
    expect(shown.filter((p) => typeof p === 'number' && p > 100)).toEqual([101.5, 102]);
    const ticks = env.current.written(T.PUBLISH).filter((f) => f[3] === 'com.example.ticker');
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.every((f) => (f[2] as Record<string, unknown>)['acknowledge'] === true)).toBe(true);
    ticking.unsubscribe();
  });
});

// --- 3.5 lifecycle ---------------------------------------------------------------------------------------------------

describe('MIGRATION 3.5 (lifecycle)', () => {
  const env = useDocEnv({ authenticate });

  test('onOpen with the session, onClose for every end, isOpen from session, a connected flag from status', async () => {
    const { router } = env.current;
    const client = env.current.track(new Client(url, 'realm1'));
    const logs: string[] = [];
    const log = (message: string): void => {
      logs.push(message);
    };
    const flags: boolean[] = [];
    const setConnected = (connected: boolean): void => {
      if (flags.at(-1) !== connected) flags.push(connected);
    };
    // doctest: migrate-lifecycle
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
    // doctest-end
    expect(isOpen()).toBe(false);
    await env.current.advance(50);
    expect(isOpen()).toBe(true);
    expect(logs).toEqual([`session ${String(client.session?.id)} as anonymous`]);
    router.drop();
    await env.current.advance(10);
    expect(isOpen()).toBe(false);
    expect(logs.at(-1)).toMatch(/^closed by connection: .+, reconnecting$/);
    await env.current.advance(5000);
    expect(isOpen()).toBe(true);
    router.goodbye('wamp.close.system_shutdown');
    await env.current.advance(10);
    expect(logs.at(-1)).toBe('closed by router: wamp.close.system_shutdown, reconnecting');
    await env.current.advance(5000);
    expect(flags).toEqual([false, true, false, true, false, true]);
  });
});

// --- 3.6 errors -------------------------------------------------------------------------------------------------------

describe('MIGRATION 3.6 (error handling)', () => {
  const env = useDocEnv({ authenticate });

  test('a WAMP ERROR by URI and args, a lost connection, a closed client: typed, no strings parsed', async () => {
    const { router } = env.current;
    const { client, wamp } = rx5(env, { timeouts: { idle: 0 } });
    const shown: unknown[] = [];
    const show = (value: unknown): void => {
      shown.push(value);
    };
    const errors: string[] = [];
    const showError = (message: string): void => {
      errors.push(message);
    };
    const ask = (): void => {
      // doctest: migrate-errors
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
      // doctest-end
    };
    let answer: () => unknown = () => {
      throw new WampError('com.example.error.not_found', [42]);
    };
    router.procedure('com.example.report', () => answer());
    ask();
    await env.current.advance(50);
    answer = () => {
      throw new WampError('com.example.error.busy', ['Report 42 is being built.']);
    };
    ask();
    await env.current.advance(10);
    answer = () => 'report 42';
    ask();
    await env.current.advance(10);
    answer = never;
    ask();
    await env.current.advance(10);
    router.drop();
    await env.current.advance(10);
    ask(); // waits for the next session
    await env.current.advance(10);
    void client.close();
    await env.current.advance(3000);
    expect(shown).toEqual(['report 42']);
    expect(errors).toEqual([
      'No such report.',
      'Report 42 is being built.',
      'The connection was lost. Try again.',
      'Disconnected.',
    ]);
  });
});

// --- 3.7 writes -------------------------------------------------------------------------------------------------------

describe('MIGRATION 3.7 (writes that must not be retried)', () => {
  const env = useDocEnv({ authenticate });

  test('placed, refused, or outcome unknown after a drop; one CALL with its key, never cancelled', async () => {
    const { router } = env.current;
    const { wamp } = rx5(env, { timeouts: { idle: 0 } });
    interface Order {
      readonly item: string;
    }
    // doctest: migrate-write
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
    // doctest-end
    router.procedure('com.example.order.place', () => 'A-1');
    const placed = lastOf(placeOrder({ item: 'book' }, 'k1'));
    await env.current.advance(50);
    expect(await placed).toBe('Order A-1 placed.');
    router.procedure('com.example.order.place', () => {
      throw new WampError('com.example.error.out_of_stock', ['Out of stock.']);
    });
    const refused = lastOf(placeOrder({ item: 'lamp' }, 'k2'));
    await env.current.advance(10);
    expect(await refused).toBe('The order was refused: Out of stock.');
    router.procedure('com.example.order.place', never);
    const unknown = lastOf(placeOrder({ item: 'desk' }, 'k3'));
    await env.current.advance(10);
    router.drop();
    await env.current.advance(10);
    expect(await unknown).toBe('We could not confirm the order. Check your orders before placing it again.');
    const calls = env.current.written(T.CALL).filter((f) => f[3] === 'com.example.order.place');
    expect(calls.map((f) => f[5])).toEqual([{ request_key: 'k1' }, { request_key: 'k2' }, { request_key: 'k3' }]);
    expect(env.current.written(T.CANCEL)).toEqual([]);
    await env.current.advance(5000);
    expect(env.current.written(T.CALL).filter((f) => f[3] === 'com.example.order.place')).toHaveLength(3); // not re-sent
  });
});

// --- 3.8 login failure ------------------------------------------------------------------------------------------------

function loginFailureApp(readTicket: () => string, showLoginError: (message: string) => void): Client {
  // doctest: migrate-login-failure
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
  // doctest-end
  return client;
}

for (const refusal of [
  'wamp.error.authentication_failed',
  'wamp.error.not_authorized',
  'thruway.error.authentication_failure',
]) {
  describe(`MIGRATION 3.8 (stop reconnecting on a login failure: ${refusal})`, () => {
    const env = useDocEnv({ authenticate: authenticateWith(refusal) });

    test('a refused login stops the client and is shown; open() after a new login; a router restart keeps going', async () => {
      const { router } = env.current;
      let ticketValue = 'wrong';
      const errors: string[] = [];
      const client = env.current.track(
        loginFailureApp(
          () => ticketValue,
          (message) => errors.push(message),
        ),
      );
      const closes: CloseInfo[] = [];
      client.onClose.subscribe((c) => closes.push(c));
      await env.current.advance(10000);
      expect(errors).toEqual(['invalid ticket']);
      expect(closes).toEqual([expect.objectContaining({ reason: refusal, willRetry: false })]);
      expect(env.current.written(T.HELLO)).toHaveLength(1);
      expect(client.session).toBeUndefined();
      ticketValue = 'secret1';
      client.open();
      await env.current.advance(1100);
      expect(client.session?.details.authid).toBe('joe');
      router.goodbye('wamp.close.system_shutdown');
      await env.current.advance(5000);
      expect(client.session).toBeDefined();
      expect(errors).toHaveLength(1);
    });
  });
}

// --- 3.9 RxJS 5 and RxJS 7 ------------------------------------------------------------------------------------------

describe('MIGRATION 3.9 (RxJS 5 and RxJS 6/7)', () => {
  const env = useDocEnv({ authenticate });

  test('RxJS 5: the adapter with patched operators', async () => {
    const rxClient = rxClient5;
    // doctest: migrate-rxjs5
    const client = new Client(url, 'realm1');
    const wamp = rxClient(client, Observable.from);
    const highPrices$ = wamp
      .topic('com.example.ticker')
      .map((e) => e.args[0] as number)
      .filter((price) => price > 100);
    // doctest-end
    env.current.track(client);
    const seen: number[] = [];
    highPrices$.subscribe({ next: (p) => seen.push(p), error: () => undefined }); // close() ends it
    await env.current.advance(50);
    env.current.router.publish('com.example.ticker', [99]);
    env.current.router.publish('com.example.ticker', [101]);
    await env.current.advance(10);
    expect(seen).toEqual([101]);
  });

  test('RxJS 7: the adapter with pipe', async () => {
    // doctest: migrate-rxjs7
    const client = new Client(url, 'realm1');
    const wamp = rxClient(client, from);
    const highPrices$ = wamp.topic('com.example.ticker').pipe(
      map((e) => e.args[0] as number),
      filter((price) => price > 100),
    );
    // doctest-end
    env.current.track(client);
    const seen: number[] = [];
    highPrices$.subscribe({ next: (p) => seen.push(p), error: () => undefined }); // close() ends it
    await env.current.advance(50);
    env.current.router.publish('com.example.ticker', [99]);
    env.current.router.publish('com.example.ticker', [101]);
    await env.current.advance(10);
    expect(seen).toEqual([101]);
  });
});

// --- 3.10 an Angular service --------------------------------------------------------------------------------------

describe('MIGRATION 3.10 (an Angular service)', () => {
  const env = useDocEnv({ authenticate });

  test('a service that wraps the client: connected$, call, topic, close on destroy', async () => {
    const { router } = env.current;
    type Observable<T> = Rx7Observable<T>; // RxJS 7's, as in an Angular project
    // doctest: migrate-angular
    class WampService {
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
    // doctest-end
    const service = new WampService();
    env.current.track(service.client);
    const connected: boolean[] = [];
    service.connected$.subscribe((c) => connected.push(c));
    router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    const sum = firstValueFrom(service.call<number>('com.example.add', [2, 3]));
    await env.current.advance(50);
    expect(await sum).toBe(5);
    const counter: number[] = [];
    service.topic<number>('com.example.counter').subscribe({ next: (n) => counter.push(n), error: () => undefined });
    await env.current.advance(10);
    router.publish('com.example.counter', [1]);
    await env.current.advance(10);
    expect(counter).toEqual([1]);
    service.ngOnDestroy();
    await env.current.advance(3000);
    expect(service.client.session).toBeUndefined();
    expect(connected).toContain(true);
    expect(connected.at(-1)).toBe(false);
  });
});

// --- 3.11 a React hook ------------------------------------------------------------------------------------------------

/** Just enough of React to run hooks: state, effects with dependencies, re-render on a state change, unmount. */
interface Effect {
  readonly deps: readonly unknown[] | undefined;
  readonly cleanup: (() => void) | undefined;
}
interface HookInstance {
  readonly values: unknown[];
  readonly effects: (Effect | undefined)[];
  readonly rerender: () => void;
}
let rendering: { readonly instance: HookInstance; s: number; e: number; readonly pending: (() => void)[] } | undefined;

function currentRender(): NonNullable<typeof rendering> {
  if (rendering === undefined) throw new Error('a hook outside a render');
  return rendering;
}

function useState<S>(initial: S): [S, (next: S) => void];
function useState<S = undefined>(): [S | undefined, (next: S | undefined) => void];
function useState<S>(initial?: S): [S | undefined, (next: S | undefined) => void] {
  const r = currentRender();
  const index = r.s++;
  const { values, rerender } = r.instance;
  if (index === values.length) values.push(initial);
  return [
    values[index] as S | undefined,
    (next) => {
      if (Object.is(values[index], next)) return;
      values[index] = next;
      rerender();
    },
  ];
}

function useEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]): void {
  const r = currentRender();
  const index = r.e++;
  const { instance } = r;
  const previous = instance.effects[index]?.deps;
  const same =
    previous !== undefined && deps?.length === previous.length && deps.every((d, k) => Object.is(d, previous[k]));
  if (same) return;
  r.pending.push(() => {
    instance.effects[index]?.cleanup?.();
    instance.effects[index] = { deps, cleanup: effect() };
  });
}

function renderHook<P, R>(component: (props: P) => R, initialProps: NoInfer<P>) {
  let props = initialProps;
  let result: R | undefined;
  let busy = false;
  let dirty = false; // a state change during a render or its effects: render again
  let mounted = true;
  const takeDirty = (): boolean => {
    const was = dirty;
    dirty = false;
    return was;
  };
  const instance: HookInstance = {
    values: [],
    effects: [],
    rerender: () => {
      render();
    },
  };
  function render(): void {
    if (!mounted) return;
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        const r = { instance, s: 0, e: 0, pending: [] as (() => void)[] };
        rendering = r;
        try {
          result = component(props);
        } finally {
          rendering = undefined;
        }
        for (const run of r.pending) run();
      } while (takeDirty());
    } finally {
      busy = false;
    }
  }
  render();
  return {
    get current(): R {
      return result as R;
    },
    rerender(next: P): void {
      props = next;
      render();
    },
    unmount(): void {
      mounted = false;
      for (const effect of instance.effects) effect?.cleanup?.();
    },
  };
}

describe('MIGRATION 3.11 (a React hook)', () => {
  const env = useDocEnv({ authenticate });

  test('useTopicValue subscribes on mount, follows its topic, unsubscribes on unmount; the connection stays', async () => {
    const { router } = env.current;
    // doctest: migrate-react-hook
    // one client for the app, created once at module level
    const client = new Client('wss://router.example.com/ws', 'realm1');

    /** The last value published on `topic`: SUBSCRIBE on mount, UNSUBSCRIBE on unmount. */
    function useTopicValue<T>(topic: string): T | undefined {
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
    function useConnected(): boolean {
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
    // doctest-end
    env.current.track(client);
    const view = renderHook(
      (topic: string) => ({ value: useTopicValue<number>(topic), connected: useConnected() }),
      'com.example.ticker',
    );
    expect(view.current).toEqual({ value: undefined, connected: false });
    await env.current.advance(50);
    expect(view.current.connected).toBe(true);
    router.publish('com.example.ticker', [42]);
    await env.current.advance(10);
    expect(view.current.value).toBe(42);
    router.drop();
    await env.current.advance(10);
    expect(view.current.connected).toBe(false);
    await env.current.advance(5000);
    expect(view.current.connected).toBe(true);
    router.publish('com.example.ticker', [43]);
    await env.current.advance(10);
    expect(view.current.value).toBe(43); // the topic came back with the session
    view.rerender('com.example.other');
    await env.current.advance(10);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
    expect(env.current.written(T.SUBSCRIBE).at(-1)?.[3]).toBe('com.example.other');
    view.unmount();
    await env.current.advance(10);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(2);
    expect(client.session).toBeDefined(); // unmounting does not close the connection
  });
});

// --- 3.12 React Native ------------------------------------------------------------------------------------------------

describe('MIGRATION 3.12 (React Native)', () => {
  const env = useDocEnv({ authenticate });

  test('an own wampcra signer; coming to the foreground cuts the backoff; a stopped client stays stopped', async () => {
    const { router } = env.current;
    const listeners: ((state: string) => void)[] = [];
    const AppState = {
      addEventListener: (type: 'change', listener: (state: string) => void): void => {
        listeners.push(listener);
      },
    };
    const secret = 'secret1';
    const signChallenge = (key: string, challenge: string): string => `${key} signed ${challenge}`;
    // doctest: migrate-react-native
    const client = new Client('wss://router.example.com/ws', 'realm1', {
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
    // doctest-end
    env.current.track(client);
    await env.current.advance(50);
    expect(client.session?.details.authmethod).toBe('wampcra');
    expect(env.current.written(T.AUTHENTICATE)[0]?.[1]).toBe('secret1 signed {"nonce":"doc"}');
    router.setAvailable('refuse');
    router.drop();
    await env.current.advance(20000);
    router.setAvailable('ok');
    const hellos = env.current.written(T.HELLO).length;
    for (const listener of listeners) listener('active');
    await env.current.advance(1100);
    expect(env.current.written(T.HELLO).length).toBe(hellos + 1);
    expect(client.session).toBeDefined();
    const closing = client.close();
    await env.current.advance(3000);
    await closing;
    const stopped = env.current.written(T.HELLO).length;
    for (const listener of listeners) listener('active');
    await env.current.advance(5000);
    expect(env.current.written(T.HELLO).length).toBe(stopped);
  });
});

// --- 3.13 Node -------------------------------------------------------------------------------------------------------

describe('MIGRATION 3.13 (Node)', () => {
  const env = useDocEnv({ authenticate });

  test('ws as the WebSocket option, a callee and an acknowledged publisher, close() at the end', async () => {
    const WebSocket = env.current.router.WebSocket; // the doc passes `ws`; here, the reference router's socket class
    const observer = env.current.track(new Client(url, 'realm1'));
    const counts: unknown[] = [];
    observer.topic('com.example.counter').subscribe((e) => counts.push(e.args[0]));
    const run = async (): Promise<void> => {
      // doctest: migrate-node
      const client = new Client('ws://127.0.0.1:8080/ws', 'realm1', { WebSocket });
      const wamp = rxClient(client, from);

      const registration = wamp
        .register('com.example.add', (inv) => Number(inv.args[0]) + Number(inv.args[1]))
        .subscribe();
      await lastValueFrom(
        interval(1000).pipe(
          take(5),
          concatMap((n) => wamp.publish('com.example.counter', [n], {}, { acknowledge: true })),
        ),
      );
      registration.unsubscribe();
      await client.close(); // the process can exit
      // doctest-end
    };
    const done = run();
    await env.current.advance(50);
    const sum = collect(observer.call('com.example.add', [2, 3]));
    await env.current.advance(6000);
    await done;
    expect(argsOf(await sum)).toEqual([[5]]);
    expect(counts).toEqual([0, 1, 2, 3, 4]);
    expect(env.current.written(T.UNREGISTER)).toHaveLength(1);
    expect(env.current.written(T.GOODBYE)).toHaveLength(1);
  });
});

// --- 3.14 tests with the testing kit -------------------------------------------------------------------------------

describe('MIGRATION 3.14 (tests with the testing kit)', () => {
  test('a call, a drop and the reconnect on the virtual clock', async () => {
    // doctest: migrate-testing-kit
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
    expect(
      router.frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 1),
    ).toHaveLength(2);

    const closing = client.close();
    await clock.runUntilIdle();
    await closing;
    // doctest-end
    expect(clock.pendingTimers).toBe(0);
  });
});
