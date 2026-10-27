// RxJS 7.8.2 (the in-repo `rxjs`) on real Client streams: from() and pipe operators, unsubscribe ⇒ CANCEL / UNSUBSCRIBE
// / UNREGISTER, lastValueFrom, RxJS Observables as handler results, and recipes 1 (live read feed) and 5 (durable
// shared topic) of the README exactly as the docs write them, through the adapter.
import {
  type Observable as RxObservable,
  filter,
  firstValueFrom,
  from,
  interval,
  lastValueFrom,
  map,
  Observable,
  of,
  retry,
  share,
  Subject,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
  timeout,
  timer,
  toArray,
} from 'rxjs';
import { describe, expect, test } from 'vitest';
import {
  type ConnectionLostError,
  isThruwayError,
  isWampError,
  TimeoutError as ThruwayTimeoutError,
} from '../../src/errors.js';
import { rxClient } from '../../src/rxjs/index.js';
import { calls, never, rxjsFrom, T, useInteropEnv } from './env.js';

const env = useInteropEnv();

// The shared helpers of the README recipes.
const isLost = (e: unknown): e is ConnectionLostError => isThruwayError(e) && e.code === 'connection_lost';
const CANCELED = new Set(['wamp.error.canceled', 'wamp.error.cancelled']);

// Recipe 1.
const TRANSIENT = new Set(['wamp.error.no_such_procedure', ...CANCELED, 'wamp.error.no_eligible_callee']);
const FRAME_REJECTED = new Set([1002, 1003, 1007, 1009, 1011]);
const transient = (e: unknown) =>
  (isLost(e) && !FRAME_REJECTED.has(e.closeCode ?? 0)) || (isWampError(e) && TRANSIENT.has(e.uri));
const liveRead = <V>(src: RxObservable<V>) =>
  src.pipe(
    retry({
      delay: (e: unknown, n: number) => (transient(e) ? timer(Math.min(30_000, 500 * 2 ** n)) : throwError(() => e)),
      resetOnSuccess: true,
    }),
  );

// Recipe 5.
const durable = (e: unknown) =>
  isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked')));

describe('from(client stream) with operators', () => {
  test('a call: map + lastValueFrom; one CALL', async () => {
    env.current.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
    const client = env.current.client();
    const sum = lastValueFrom(from(client.call('com.example.add', [2, 3])).pipe(map((r) => r.args[0] as number)));
    await env.current.advance(10);
    await expect(sum).resolves.toBe(5);
    expect(calls(env.current, 'com.example.add')).toHaveLength(1);
  });

  test('a progressive call: every progress result and the final one, in order (toArray)', async () => {
    env.current.router.procedure('com.example.feed', () => of('a', 'b', 'c'));
    const client = env.current.client();
    const all = lastValueFrom(from(client.progressiveCall('com.example.feed')).pipe(toArray()));
    await env.current.advance(10);
    // the router sends every value as progress and an empty final RESULT, which the client does not emit
    expect((await all).map((r) => r.args[0] as string)).toEqual(['a', 'b', 'c']);
  });

  test('timeout() unsubscribes ⇒ CANCEL killnowait, once; the error is RxJS’s TimeoutError', async () => {
    env.current.router.procedure('com.example.slow', never);
    const client = env.current.client();
    const result = firstValueFrom(from(client.call('com.example.slow')).pipe(timeout(1000)));
    const settled = result.catch((e: unknown) => e);
    await env.current.advance(1500);
    expect(await settled).toMatchObject({ name: 'TimeoutError' });
    expect(isThruwayError(await settled)).toBe(false);
    const [call] = calls(env.current, 'com.example.slow');
    expect(env.current.written(T.CANCEL)).toEqual([[T.CANCEL, call?.[1], { mode: 'killnowait' }]]);
  });

  test('switchMap: a new value cancels the running call and issues a new CALL with a new request id', async () => {
    env.current.router.procedure('com.example.search', (args) => (args[0] === 'ab' ? 'found ab' : never()));
    const client = env.current.client();
    await env.current.advance(10);
    const queries = new Subject<string>();
    const seen: unknown[] = [];
    const subscription = queries
      .pipe(switchMap((q) => from(client.call('com.example.search', [q]))))
      .subscribe((r) => seen.push(r.args[0]));
    queries.next('a');
    await env.current.advance(5);
    queries.next('ab');
    await env.current.advance(5);
    expect(seen).toEqual(['found ab']);
    const [first, second] = calls(env.current, 'com.example.search');
    expect(first?.[1]).not.toBe(second?.[1]);
    expect(env.current.written(T.CANCEL)).toEqual([[T.CANCEL, first?.[1], { mode: 'killnowait' }]]);
    subscription.unsubscribe();
  });

  test('a topic: filter + take(2); completing the chain writes UNSUBSCRIBE', async () => {
    const client = env.current.client();
    const got = lastValueFrom(
      from(client.topic('com.example.t')).pipe(
        map((e) => e.args[0] as number),
        filter((v) => v % 2 === 0),
        take(2),
        toArray(),
      ),
    );
    await env.current.advance(10);
    for (const v of [1, 2, 3, 4, 5]) env.current.router.publish('com.example.t', [v]);
    await env.current.advance(10);
    await expect(got).resolves.toEqual([2, 4]);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(1);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('takeUntil ends a registration: UNREGISTER; its handler answered with an RxJS Observable', async () => {
    const callee = env.current.client();
    const stop = new Subject<void>();
    const registered: unknown[] = [];
    from(callee.register('com.example.double', ({ args }) => of((args[0] as number) * 2)))
      .pipe(takeUntil(stop))
      .subscribe((r) => registered.push(r.procedure));
    const caller = env.current.client();
    await env.current.advance(10);
    await expect(lastValueFrom(from(caller.call('com.example.double', [21])))).resolves.toMatchObject({ args: [42] });
    stop.next();
    await env.current.advance(10);
    expect(registered).toEqual(['com.example.double']);
    expect(env.current.written(T.UNREGISTER)).toHaveLength(1);
  });

  test('a progressive callee result from RxJS: progress YIELDs, then the empty final YIELD', async () => {
    const callee = env.current.client();
    callee.register('com.example.count', () => interval(100).pipe(take(3))).subscribe();
    const caller = env.current.client();
    await env.current.advance(10);
    const all = lastValueFrom(from(caller.progressiveCall('com.example.count')).pipe(toArray()));
    await env.current.advance(500);
    expect((await all).map((r) => r.args[0] as number)).toEqual([0, 1, 2]);
    const yields = env.current.written(T.YIELD);
    expect(yields.map((y) => y[2])).toEqual([{ progress: true }, { progress: true }, { progress: true }, {}]);
  });
});

describe('recipe 1: live read feed (retry on transient errors, through rxClient)', () => {
  test('re-issued while the backend is missing and after a lost connection; values keep flowing', async () => {
    const { router } = env.current;
    const wamp = rxClient(env.current.client({ timeouts: { idle: 0 } }), rxjsFrom);
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = liveRead(wamp.progressiveCall('com.example.ticker')).subscribe({
      next: (r) => seen.push(r.args[0]),
      error: (e: unknown) => errors.push(e),
    });
    await env.current.advance(10); // no_such_procedure: retried after 1 s
    expect(calls(env.current, 'com.example.ticker')).toHaveLength(1);
    let feed: Subject<string> | undefined;
    router.procedure('com.example.ticker', () => (feed = new Subject<string>()));
    await env.current.advance(1000);
    expect(calls(env.current, 'com.example.ticker')).toHaveLength(2);
    feed?.next('t1');
    await env.current.advance(10);
    router.drop(); // the CALL in flight errors ConnectionLostError: retried, and it waits for the next WELCOME
    await env.current.advance(10000);
    expect(calls(env.current, 'com.example.ticker')).toHaveLength(3);
    feed?.next('t2');
    await env.current.advance(10);
    expect(seen).toEqual(['t1', 't2']);
    expect(errors).toEqual([]);
    subscription.unsubscribe();
    await env.current.advance(10);
    expect(env.current.written(T.CANCEL)).toHaveLength(1); // the running feed call
  });

  test('never retried: not_authorized surfaces on the stream at once', async () => {
    env.current.router.deny((request) => request.uri === 'com.example.secret');
    const wamp = rxClient(env.current.client(), rxjsFrom);
    const result = lastValueFrom(liveRead(wamp.progressiveCall('com.example.secret'))).catch((e: unknown) => e);
    await env.current.advance(60000);
    expect(await result).toMatchObject({ name: 'WampError', uri: 'wamp.error.not_authorized' });
    expect(calls(env.current, 'com.example.secret')).toHaveLength(1);
  });

  test('never retried: ConnectionClosedError after close()', async () => {
    env.current.router.procedure('com.example.feed', never);
    const client = env.current.client();
    const wamp = rxClient(client, rxjsFrom);
    const result = lastValueFrom(liveRead(wamp.call('com.example.feed'))).catch((e: unknown) => e);
    await env.current.advance(10);
    await client.close();
    expect(await result).toMatchObject({ name: 'ConnectionClosedError', gaveUp: false });
    expect(calls(env.current, 'com.example.feed')).toHaveLength(1);
  });
});

describe('recipe 5: a durable shared topic', () => {
  test('share(): one SUBSCRIBE for two subscribers; a revocation re-subscribes after 1 s, nobody sees an error', async () => {
    const { router } = env.current;
    const wamp = rxClient(env.current.client(), rxjsFrom);
    const status$ = wamp.topic('com.example.status').pipe(
      retry({
        delay: (e: unknown, n: number) => (durable(e) ? timer(Math.min(30_000, 1000 * 2 ** n)) : throwError(() => e)),
        resetOnSuccess: true,
      }),
      share(),
    );
    const a: unknown[] = [];
    const b: unknown[] = [];
    const errors: unknown[] = [];
    const sa = status$.subscribe({ next: (e) => a.push(e.args[0]), error: (e: unknown) => errors.push(e) });
    const sb = status$.subscribe({ next: (e) => b.push(e.args[0]), error: (e: unknown) => errors.push(e) });
    await env.current.advance(10);
    router.publish('com.example.status', ['up']);
    await env.current.advance(10);
    router.revokeSubscription('com.example.status', 'wamp.error.subscription_revoked');
    await env.current.advance(10);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(1);
    await env.current.advance(1980); // retry's first delay is 1000 × 2 ** 1 after the revocation (at 20)
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(1);
    await env.current.advance(10);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(2);
    router.publish('com.example.status', ['again']);
    await env.current.advance(10);
    expect(a).toEqual(['up', 'again']);
    expect(b).toEqual(['up', 'again']);
    expect(errors).toEqual([]);
    sa.unsubscribe();
    sb.unsubscribe();
    await env.current.advance(10);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('a lost connection never errors a topic: it is re-established by the client itself', async () => {
    const { router } = env.current;
    const wamp = rxClient(env.current.client({ timeouts: { idle: 0 } }), rxjsFrom);
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = wamp.topic('com.example.status').subscribe({
      next: (e) => seen.push(e.args[0]),
      error: (e: unknown) => errors.push(e),
    });
    await env.current.advance(10);
    router.drop();
    await env.current.advance(10000);
    router.publish('com.example.status', ['back']);
    await env.current.advance(10);
    expect(seen).toEqual(['back']);
    expect(errors).toEqual([]);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(2);
    subscription.unsubscribe();
  });

  test('durable: a request timeout is retried (the late SUBSCRIBE is adopted, not re-sent); a router ERROR is not', async () => {
    const { router } = env.current;
    router.ignore((frame) => frame[0] === T.SUBSCRIBE && frame[3] === 'com.example.slow'); // never answered
    const wamp = rxClient(env.current.client({ timeouts: { request: 2000 } }), rxjsFrom);
    const timeouts: unknown[] = [];
    const errors: unknown[] = [];
    const retried = wamp
      .topic('com.example.slow')
      .pipe(
        tap({ error: (e: unknown) => timeouts.push(e) }),
        retry({ delay: (e: unknown) => (durable(e) ? timer(1000) : throwError(() => e)) }),
      )
      .subscribe({ error: (e: unknown) => errors.push(e) });
    await env.current.advance(5500); // 2000: timeout, 3000: re-subscribed (adopts the late SUBSCRIBE), 5000: timeout
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toMatchObject({ name: 'TimeoutError', timer: 'request', topic: 'com.example.slow' });
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(1);
    expect(errors).toEqual([]);
    retried.unsubscribe();
    router.deny((request) => request.uri === 'com.example.denied');
    const denied = lastValueFrom(
      wamp
        .topic('com.example.denied')
        .pipe(retry({ delay: (e: unknown) => (durable(e) ? timer(1000) : throwError(() => e)) })),
    ).catch((e: unknown) => e);
    await env.current.advance(5000);
    expect(await denied).toMatchObject({ name: 'WampError', uri: 'wamp.error.not_authorized' });
    expect(env.current.written(T.SUBSCRIBE).filter((f) => f[3] === 'com.example.denied')).toHaveLength(1);
  });
});

describe('our errors through RxJS', () => {
  test('a typed error keeps its brand and context through catchError-free chains', async () => {
    env.current.router.procedure('com.example.fail', () => {
      throw new Error('boom');
    });
    const client = env.current.client();
    const error = await lastValueFrom(from(client.call('com.example.fail')).pipe(map((r) => r.args.length))).catch(
      (e: unknown) => e,
    );
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({ uri: 'wamp.error.runtime_error', procedure: 'com.example.fail' });
  });

  test('recipe 19: timeout({with}) raising our TimeoutError{timer: "call"}', async () => {
    env.current.router.procedure('com.example.report', never);
    const client = env.current.client();
    const procedure = 'com.example.report';
    const result = firstValueFrom(
      from(client.call(procedure)).pipe(
        timeout({
          first: 5000,
          with: () => throwError(() => new ThruwayTimeoutError({ timer: 'call', timeout: 5000, procedure })),
        }),
      ),
    ).catch((e: unknown) => e);
    await env.current.advance(5000);
    expect(await result).toMatchObject({ code: 'timeout', timer: 'call', procedure });
    expect(env.current.written(T.CANCEL)).toHaveLength(1);
  });

  test('a throwing operator in the app chain never reaches the client: other streams keep working', async () => {
    env.current.router.procedure('com.example.n', () => 1);
    const client = env.current.client();
    const broken = lastValueFrom(
      from(client.topic('com.example.t')).pipe(
        map(() => {
          throw new Error('app bug');
        }),
      ),
    ).catch((e: unknown) => e);
    await env.current.advance(10);
    env.current.router.publish('com.example.t', [1]);
    await env.current.advance(10);
    expect(await broken).toMatchObject({ message: 'app bug' });
    await expect(lastValueFrom(from(client.call('com.example.n')))).resolves.toMatchObject({ args: [1] });
    expect(client.session).toBeDefined();
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('an RxJS Observable that never emits is a valid handler result until the call is cancelled', async () => {
    let unsubscribed = 0;
    const callee = env.current.client();
    callee
      .register(
        'com.example.hang',
        () =>
          new Observable<never>(() => () => {
            unsubscribed++;
          }),
      )
      .subscribe();
    const caller = env.current.client();
    await env.current.advance(10);
    const result = firstValueFrom(from(caller.call('com.example.hang')).pipe(timeout(1000))).catch((e: unknown) => e);
    await env.current.advance(1500);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(unsubscribed).toBe(1); // CANCEL → INTERRUPT → the handler's Observable is unsubscribed
  });
});
