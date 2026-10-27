// The RxJS 5 interop suite, run by rxjs5.test.ts (5.5.12) and rxjs543.test.ts (5.4.3) against their own copy of RxJS 5.
// It loads RxJS 5 the way RxJS 5 apps commonly do: `rxjs/Observable` plus one `rxjs/add/...` file per operator, which
// patches that copy's prototype. RxJS 5 is loaded with require() and typed by the small interfaces below: the in-repo
// `rxjs` types are RxJS 7's (the RxJS 5 type cells are in the consumer matrix, scripts/consumer-matrix.sh).
//
// Covered: Observable.from(client stream) with patched operators, toPromise, retryWhen + repeatWhen (long-lived feeds),
// timeout ⇒ CANCEL, SafeSubscriber rethrows isolated (an observer that throws, an error nobody handles), RxJS 5
// Observables as inputs (handler result, challenge answer, URL resolver), and rxClient(client, Observable.from).
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { isThruwayError, isWampError } from '../../src/errors.js';
import { rxClient } from '../../src/rxjs/index.js';
import type { DialectName } from '../../src/testing/sim.js';
import type { Observer } from '../../src/types.js';
import { calls, never, T, useInteropEnv } from './env.js';

export interface Rx5Subscription {
  unsubscribe(): void;
  readonly closed: boolean;
}
export interface Rx5Observable<V> {
  subscribe(
    observerOrNext?: Partial<Observer<V>> | ((value: V) => void) | null,
    error?: (e: unknown) => void,
    complete?: () => void,
  ): Rx5Subscription;
  map<R>(project: (value: V) => R): Rx5Observable<R>;
  take(count: number): Rx5Observable<V>;
  delay(ms: number): Rx5Observable<V>;
  timeout(ms: number): Rx5Observable<V>;
  share(): Rx5Observable<V>;
  retryWhen(notifier: (errors: Rx5Observable<unknown>) => Rx5Observable<unknown>): Rx5Observable<V>;
  repeatWhen(notifier: (completions: Rx5Observable<unknown>) => Rx5Observable<unknown>): Rx5Observable<V>;
  toArray(): Rx5Observable<V[]>;
  toPromise(): Promise<V>;
}
export interface Rx5ObservableStatic {
  new (subscribe: (observer: { next(v: unknown): void; complete(): void }) => unknown): Rx5Observable<unknown>;
  /** Function-typed properties: apps pass `Observable.from` itself, unbound. */
  readonly from: <V>(input: unknown) => Rx5Observable<V>;
  readonly of: <V>(...values: V[]) => Rx5Observable<V>;
  prototype: object;
}

const OPERATORS = ['map', 'take', 'delay', 'timeout', 'share', 'retryWhen', 'repeatWhen', 'toArray', 'toPromise'];

/** Load RxJS 5 from `pkg` like an RxJS 5 app: the Observable class, `Observable.from`/`of` and one file per operator. RxJS 5
 *  captures `Date.now` when it loads (`Scheduler.now`), so its async scheduler is pointed at the current `Date.now`,
 *  the one vitest's fake timers replace (RxJS 6 and 7 read it at each call). */
export function loadRx5(pkg: string): { readonly Observable: Rx5ObservableStatic; readonly version: string } {
  const require = createRequire(import.meta.url);
  const { async } = require(`${pkg}/scheduler/async`) as { async: { now: () => number } };
  async.now = () => Date.now();
  const { Observable } = require(`${pkg}/Observable`) as { Observable: Rx5ObservableStatic };
  require(`${pkg}/add/observable/from`);
  require(`${pkg}/add/observable/of`);
  for (const operator of OPERATORS) require(`${pkg}/add/operator/${operator}`);
  const { version } = require(`${pkg}/package.json`) as { version: string };
  return { Observable, version };
}

/** The suite for the RxJS 5 copy `pkg`; `dialect`: the reference router's (Thruway PHP, the first-class router). */
export function rx5Suite(pkg: string, expectedVersion: string, dialect?: DialectName): void {
  const { Observable, version } = loadRx5(pkg);
  const env = useInteropEnv({
    ...(dialect === undefined ? {} : { dialect }),
    providers: [
      { method: 'anonymous' },
      {
        method: 'jwt',
        verify: (signature) => (signature === 'token-1' ? { authid: 'peter', authrole: 'user' } : false),
      },
    ],
  });

  test(`the copy under test is RxJS ${expectedVersion}, on the ${dialect ?? 'spec'} dialect`, () => {
    expect(version).toBe(expectedVersion);
    expect(env.current.router.dialect).toBe(dialect ?? 'spec');
  });

  describe(`Observable.from(client stream), RxJS ${expectedVersion}`, () => {
    test('patched operators and toPromise on a call (Observable.from(client.call(...)).map(...).toPromise())', async () => {
      env.current.router.procedure('com.example.get_user_info', () => ({ name: 'peter' }));
      const client = env.current.client();
      const source = Observable.from<{ args: unknown[] }>(client.call('com.example.get_user_info'));
      expect(source).toBeInstanceOf(Observable);
      const name = source.map((r) => (r.args[0] as { name: string }).name).toPromise();
      await env.current.advance(10);
      await expect(name).resolves.toBe('peter');
    });

    test('a progressive feed with retryWhen(delay 3000): re-issued after the connection was lost', async () => {
      let feed: { next(v: string): void } | undefined;
      env.current.router.procedure(
        'com.example.ticker',
        () =>
          new Observable((observer) => {
            feed = observer;
          }),
      );
      const client = env.current.client({ timeouts: { idle: 0 } });
      const seen: unknown[] = [];
      const errors: unknown[] = [];
      const subscription = Observable.from<{ args: unknown[] }>(client.progressiveCall('com.example.ticker'))
        .retryWhen((e) => e.delay(3000))
        .repeatWhen((c) => c.delay(3000))
        .subscribe(
          (r) => seen.push(r.args[0]),
          (e) => errors.push(e),
        );
      await env.current.advance(10);
      feed?.next('t1');
      await env.current.advance(10);
      env.current.router.drop();
      await env.current.advance(10000);
      feed?.next('t2');
      await env.current.advance(10);
      expect(seen).toEqual(['t1', 't2']);
      expect(errors).toEqual([]);
      expect(calls(env.current, 'com.example.ticker')).toHaveLength(2);
      subscription.unsubscribe();
      await env.current.advance(10);
      expect(env.current.written(T.CANCEL)).toHaveLength(1);
    });

    test('.timeout(5000) unsubscribes ⇒ CANCEL killnowait', async () => {
      env.current.router.procedure('com.example.slow', never);
      const client = env.current.client();
      const result = Observable.from(client.call('com.example.slow'))
        .timeout(5000)
        .toPromise()
        .catch((e: unknown) => e);
      await env.current.advance(5000);
      expect(await result).toMatchObject({ name: 'TimeoutError' });
      const [call] = calls(env.current, 'com.example.slow');
      expect(env.current.written(T.CANCEL)).toEqual([[T.CANCEL, call?.[1], { mode: 'killnowait' }]]);
      await env.current.advance(10);
      // the router's answer to the CANCEL: ERROR(CALL) by the spec, ERROR(CANCEL) from Thruway PHP (T2); dropped
      const answers = env.current.router.frames.filter(
        (f) => f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === T.ERROR && f.frame[2] === call?.[1],
      );
      expect(answers.map((f) => (f.frame as unknown[])[1])).toEqual([dialect === 'thruway-php' ? T.CANCEL : T.CALL]);
    });

    test('take(1) on a topic: EVENT received, then UNSUBSCRIBE', async () => {
      const client = env.current.client();
      const first = Observable.from<{ args: unknown[] }>(client.topic('com.example.notifications')).take(1).toPromise();
      await env.current.advance(10);
      env.current.router.publish('com.example.notifications', ['hello']);
      await env.current.advance(10);
      await expect(first).resolves.toMatchObject({ args: ['hello'] });
      expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
    });
  });

  describe(`SafeSubscriber rethrows are isolated, RxJS ${expectedVersion}`, () => {
    test('an observer that throws: reported to the logger; other subscribers and the session carry on', async () => {
      const client = env.current.client();
      const bug = new Error('app observer bug');
      const others: unknown[] = [];
      Observable.from(client.topic('com.example.t')).subscribe(() => {
        throw bug;
      });
      Observable.from<{ args: unknown[] }>(client.topic('com.example.t')).subscribe((e) => others.push(e.args[0]));
      await env.current.advance(10);
      env.current.router.publish('com.example.t', [1]);
      env.current.router.publish('com.example.t', [2]);
      await env.current.advance(10);
      expect(others).toEqual([1, 2]);
      expect(env.current.unhandled().map((entry) => entry.data?.['error'])).toEqual([bug]);
      expect(client.session).toBeDefined();
      expect(env.current.written(T.UNSUBSCRIBE)).toEqual([]); // RxJS 5 dropped its subscriber; the other remains
    });

    test('an error nobody handles (v2 unwound it into the socket handler): reported, the client is unharmed', async () => {
      env.current.router.procedure('com.example.fails', () => {
        throw new Error('backend error');
      });
      env.current.router.procedure('com.example.ok', () => 'ok');
      const client = env.current.client();
      Observable.from(client.call('com.example.fails')).subscribe(() => undefined); // no error callback
      await env.current.advance(10);
      const [entry] = env.current.unhandled();
      expect(isWampError(entry?.data?.['error'])).toBe(true);
      await expect(Observable.from(client.call('com.example.ok')).toPromise()).resolves.toMatchObject({ args: ['ok'] });
      expect(env.current.written(T.HELLO)).toHaveLength(1); // never reconnected
    });
  });

  describe(`RxJS ${expectedVersion} Observables as inputs and rxClient(client, Observable.from)`, () => {
    test('handler result (progressive and final), challenge answer (Observable.of) and URL resolver', async () => {
      const { router } = env.current;
      const callee = env.current.client({ authmethods: ['jwt'], onChallenge: () => Observable.of('token-1') }, () =>
        Observable.of(router.url),
      );
      callee.register('com.example.letters', () => Observable.of('x', 'y', 'z')).subscribe();
      await env.current.advance(10);
      expect(callee.session?.details.authid).toBe('peter');
      expect(env.current.written(T.AUTHENTICATE)).toEqual([[T.AUTHENTICATE, 'token-1', {}]]);
      const wamp = rxClient(env.current.client(), Observable.from);
      const progressive = (wamp.progressiveCall('com.example.letters') as unknown as Rx5Observable<{ args: unknown[] }>)
        .map((r) => r.args[0])
        .toArray()
        .toPromise();
      const last = (wamp.call('com.example.letters') as unknown as Rx5Observable<{ args: unknown[] }>).toPromise();
      await env.current.advance(10);
      await expect(progressive).resolves.toEqual(['x', 'y', 'z']);
      await expect(last).resolves.toMatchObject({ args: ['z'] }); // not progressive: the last value
    });

    test('rxClient streams are RxJS 5 Observables with the patched operators; lifecycle wrappers are stable', async () => {
      env.current.router.procedure('com.example.n', () => 7);
      const client = env.current.client({ autoOpen: false });
      const wamp = rxClient(client, Observable.from);
      expect(wamp.status).toBe(wamp.status);
      const status = wamp.status as unknown as Rx5Observable<{ state: string }>;
      expect(status).toBeInstanceOf(Observable);
      const states: string[] = [];
      const s = status.map((x) => x.state).subscribe((state) => states.push(state));
      const opened = (wamp.onOpen as unknown as Rx5Observable<{ id: number }>).take(1).toPromise();
      client.open();
      await env.current.advance(10);
      await expect(opened).resolves.toMatchObject({ id: client.session?.id });
      const n = (wamp.call('com.example.n') as unknown as Rx5Observable<{ args: unknown[] }>).map((r) => r.args[0]);
      await expect(n.toPromise()).resolves.toBe(7);
      s.unsubscribe();
      expect(states).toEqual(['closed', 'connecting', 'open']);
    });

    test('errors arrive typed through RxJS 5 (the app matches e.errorUri)', async () => {
      env.current.router.deny((request) => request.uri === 'com.example.admin');
      const wamp = rxClient(env.current.client(), Observable.from);
      const error = await (wamp.call('com.example.admin') as unknown as Rx5Observable<unknown>)
        .toPromise()
        .catch((e: unknown) => e);
      expect(isThruwayError(error)).toBe(true);
      expect(error).toMatchObject({ errorUri: 'wamp.error.not_authorized', procedure: 'com.example.admin' });
    });
  });
}
