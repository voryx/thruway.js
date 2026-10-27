// RxJS 9.0.0-beta.1 (alias `rxjs9`) and the platform Observable it installs. RxJS 9 accepts no `Symbol.observable`
// interop; `Observable.from(ours)` goes through our async iterator, and its abort calls the iterator's `return()`,
// which unsubscribes (⇒ CANCEL / UNSUBSCRIBE). The input direction: RxJS 9 Observables (the platform `Observable` and
// RxJS 9's `ColdObservable`) as challenge answer, as handler result (progressive and final) and as URL resolver result.
import { ColdObservable } from 'rxjs9';
import { map } from 'rxjs9/map';
import { repeat } from 'rxjs9/repeat';
import { retry } from 'rxjs9/retry';
import { take } from 'rxjs9/take';
import { describe, expect, test } from 'vitest';
import { calls, T, useInteropEnv } from './env.js';

const env = useInteropEnv({
  providers: [
    { method: 'anonymous' },
    {
      method: 'ticket',
      verify: (signature) => (signature === 'rx9-ticket' ? { authid: 'nine', authrole: 'user' } : false),
    },
  ],
});

/** A ColdObservable that emits `values` one per `ms` (fake) milliseconds, then completes. */
function emitEvery<V>(ms: number, ...values: V[]): ColdObservable<V> {
  return new ColdObservable<V>((subscriber) => {
    let i = 0;
    const id = setInterval(() => {
      const value = values[i++];
      if (value !== undefined) subscriber.next(value);
      if (i >= values.length) {
        clearInterval(id);
        subscriber.complete();
      }
    }, ms);
    subscriber.addTeardown(() => {
      clearInterval(id);
    });
  });
}

describe('from(ours) through the async iterator', () => {
  test('a topic: events arrive; aborting the platform subscription calls return() ⇒ UNSUBSCRIBE', async () => {
    const client = env.current.client();
    const controller = new AbortController();
    const seen: unknown[] = [];
    Observable.from(client.topic('com.example.t')).subscribe(
      { next: (e) => seen.push(e.args[0]) },
      { signal: controller.signal },
    );
    await env.current.advance(10);
    env.current.router.publish('com.example.t', [1]);
    env.current.router.publish('com.example.t', [2]);
    await env.current.advance(10);
    expect(seen).toEqual([1, 2]);
    controller.abort();
    await env.current.advance(10);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('RxJS 9 operators ([take], [map]) and toArray(): the iterator is released ⇒ UNSUBSCRIBE', async () => {
    const client = env.current.client();
    const values = Observable.from(client.topic('com.example.t'))
      [take](2)
      [map]((e) => e.args[0] as string)
      .toArray();
    await env.current.advance(10);
    for (const v of ['a', 'b', 'c']) env.current.router.publish('com.example.t', [v]);
    await env.current.advance(10);
    await expect(values).resolves.toEqual(['a', 'b']);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('first() of a progressive call: return() after the first result ⇒ CANCEL killnowait', async () => {
    env.current.router.procedure('com.example.feed', () => emitEvery(100, 'p1', 'p2', 'p3'));
    const client = env.current.client();
    const first = Observable.from(client.progressiveCall('com.example.feed')).first();
    await env.current.advance(150);
    await expect(first).resolves.toMatchObject({ args: ['p1'] });
    await env.current.advance(10);
    const [call] = calls(env.current, 'com.example.feed');
    expect(env.current.written(T.CANCEL)).toEqual([[T.CANCEL, call?.[1], { mode: 'killnowait' }]]);
  });

  test('a call that completes: map + first(), and no CANCEL', async () => {
    env.current.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
    const client = env.current.client();
    const sum = Observable.from(client.call('com.example.add', [4, 5]))
      .map((r) => r.args[0] as number)
      .first();
    await env.current.advance(10);
    await expect(sum).resolves.toBe(9);
    expect(env.current.written(T.CANCEL)).toEqual([]);
  });

  test('a call error reaches the platform observer typed', async () => {
    env.current.router.deny((request) => request.uri === 'com.example.secret');
    const client = env.current.client();
    const error = await Observable.from(client.call('com.example.secret'))
      .first()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'WampError', uri: 'wamp.error.not_authorized' });
  });
});

describe('re-subscription through RxJS 9 operators (every stream is cold and can be re-subscribed)', () => {
  test('[retry]: an errored call is issued again, a new CALL with a new request id each time', async () => {
    let n = 0;
    env.current.router.procedure('com.example.flaky', () => {
      if (++n < 3) throw new Error('not yet');
      return 'third time';
    });
    const client = env.current.client();
    const result = Observable.from(client.call('com.example.flaky'))[retry]({ count: 5 }).first();
    await env.current.advance(10);
    await expect(result).resolves.toMatchObject({ args: ['third time'] });
    const ids = calls(env.current, 'com.example.flaky').map((f) => f[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  test('[repeat]: a completed call is issued again; a topic re-subscribed after take(1) writes SUBSCRIBE again', async () => {
    let n = 0;
    env.current.router.procedure('com.example.n', () => ++n);
    const client = env.current.client();
    const values = Observable.from(client.call('com.example.n'))
      [repeat]({ count: 3 })
      [map]((r) => r.args[0] as number)
      .toArray();
    await env.current.advance(10);
    await expect(values).resolves.toEqual([1, 2, 3]);
    expect(calls(env.current, 'com.example.n')).toHaveLength(3);
    const events = Observable.from(client.topic('com.example.t'))
      [take](1)
      [repeat]({ count: 2 })
      [map]((e) => e.args[0] as string)
      .toArray();
    await env.current.advance(10);
    env.current.router.publish('com.example.t', ['a']);
    await env.current.advance(10);
    env.current.router.publish('com.example.t', ['b']);
    await env.current.advance(10);
    await expect(events).resolves.toEqual(['a', 'b']);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(2);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(2);
  });
});

describe('RxJS 9 Observables as inputs', () => {
  test('challenge answer (ColdObservable, async) and URL resolver (platform Observable)', async () => {
    const { router } = env.current;
    const client = env.current.client(
      { authmethods: ['ticket'], onChallenge: () => emitEvery(50, 'rx9-ticket', 'ignored') },
      () => Observable.from(Promise.resolve(router.url)),
    );
    await env.current.advance(100);
    expect(env.current.written(T.AUTHENTICATE)).toEqual([[T.AUTHENTICATE, 'rx9-ticket', {}]]);
    expect(client.session?.details.authid).toBe('nine');
  });

  test('handler result: progress YIELDs and the empty final one; a non-progressive caller gets the last value', async () => {
    const callee = env.current.client();
    callee.register('com.example.count', () => emitEvery(10, 1, 2, 3)).subscribe();
    const caller = env.current.client();
    await env.current.advance(10);
    const progressive = Observable.from(caller.progressiveCall('com.example.count'))
      .map((r) => r.args[0] as number)
      .toArray();
    const final = Observable.from(caller.call('com.example.count')).first();
    await env.current.advance(100);
    await expect(progressive).resolves.toEqual([1, 2, 3]);
    await expect(final).resolves.toMatchObject({ args: [3] });
    const yields = env.current.written(T.YIELD).map((y) => y[2]);
    expect(yields.filter((options) => (options as { progress?: boolean }).progress === true)).toHaveLength(3);
    expect(yields.filter((options) => Object.keys(options as object).length === 0)).toHaveLength(2);
  });

  test('a handler’s platform Observable is aborted when the caller cancels (CANCEL ⇒ INTERRUPT)', async () => {
    let aborted = 0;
    const callee = env.current.client();
    callee
      .register(
        'com.example.hang',
        () =>
          new Observable<never>((subscriber) => {
            subscriber.addTeardown(() => {
              aborted++;
            });
          }),
      )
      .subscribe();
    const caller = env.current.client();
    await env.current.advance(10);
    const controller = new AbortController();
    Observable.from(caller.call('com.example.hang')).subscribe({}, { signal: controller.signal });
    await env.current.advance(10);
    controller.abort();
    await env.current.advance(10);
    expect(env.current.written(T.CANCEL)).toHaveLength(1);
    expect(aborted).toBe(1);
  });
});
