// RxJS 6.6.7 (alias `rxjs6`), which the peer range `>=5.4.3 <10` admits: from() and pipe operators, unsubscribe ⇒
// CANCEL, `retry` re-issues the call (a second CALL with a new request id), toPromise, and RxJS 6 Observables as inputs
// (rxClient with RxJS 6's `from` is in test/unit/rx-adapter.test.ts).
import { from, Observable as Rx6Observable, of, Subject } from 'rxjs6';
import { map, retry, switchMap, take, timeout, toArray } from 'rxjs6/operators';
import { describe, expect, test } from 'vitest';
import { isThruwayError } from '../../src/errors.js';
import { calls, never, T, useInteropEnv } from './env.js';

const env = useInteropEnv({
  providers: [
    { method: 'anonymous' },
    {
      method: 'ticket',
      verify: (signature) => (signature === 'secret' ? { authid: 'peter', authrole: 'user' } : false),
    },
  ],
});

describe('RxJS 6', () => {
  test('from(call) is an RxJS 6 Observable: pipe(map) + toPromise', async () => {
    env.current.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
    const client = env.current.client();
    const source = from(client.call('com.example.add', [20, 22]));
    expect(source).toBeInstanceOf(Rx6Observable);
    const sum = source.pipe(map((r) => r.args[0] as number)).toPromise();
    await env.current.advance(10);
    await expect(sum).resolves.toBe(42);
  });

  test('unsubscribe before the result ⇒ CANCEL killnowait (timeout and an explicit unsubscribe)', async () => {
    env.current.router.procedure('com.example.slow', never);
    const client = env.current.client();
    const timedOut = from(client.call('com.example.slow'))
      .pipe(timeout(1000))
      .toPromise()
      .catch((e: unknown) => e);
    await env.current.advance(1500);
    expect(await timedOut).toMatchObject({ name: 'TimeoutError' });
    const subscription = from(client.call('com.example.slow')).subscribe();
    await env.current.advance(10);
    subscription.unsubscribe();
    await env.current.advance(10);
    const ids = calls(env.current, 'com.example.slow').map((f) => f[1]);
    expect(env.current.written(T.CANCEL)).toEqual(ids.map((id) => [T.CANCEL, id, { mode: 'killnowait' }]));
  });

  test('retry re-issues a call that lost its connection: a second CALL with a new request id', async () => {
    let n = 0;
    env.current.router.procedure('com.example.feed', () => (++n === 1 ? never() : 'second time'));
    env.current.router.procedure('com.example.pending', never);
    const client = env.current.client();
    const errors: unknown[] = [];
    const result = from(client.call('com.example.feed'))
      .pipe(
        map((r) => r.args[0] as string),
        retry(3),
      )
      .toPromise();
    from(client.call('com.example.pending'))
      .toPromise()
      .catch((e: unknown) => errors.push(e)); // not retried: sees the loss itself
    await env.current.advance(10);
    env.current.router.drop();
    await env.current.advance(10000);
    await expect(result).resolves.toBe('second time');
    const [first, second] = calls(env.current, 'com.example.feed');
    expect(second).toBeDefined();
    expect(first?.[1]).not.toBe(second?.[1]);
    expect(errors).toHaveLength(1);
    expect(isThruwayError(errors[0]) && errors[0].code).toBe('connection_lost');
  });

  test('switchMap over a topic: one CALL per EVENT; take(2) ⇒ UNSUBSCRIBE', async () => {
    env.current.router.procedure('com.example.lookup', (args) => `price of ${String(args[0])}`);
    const client = env.current.client();
    const prices = from(client.topic('com.example.ticks'))
      .pipe(
        switchMap((e) => from(client.call('com.example.lookup', e.args))),
        map((r) => r.args[0] as string),
        take(2),
        toArray(),
      )
      .toPromise();
    await env.current.advance(10);
    env.current.router.publish('com.example.ticks', ['apples']);
    await env.current.advance(10);
    env.current.router.publish('com.example.ticks', ['milk']);
    await env.current.advance(10);
    await expect(prices).resolves.toEqual(['price of apples', 'price of milk']);
    expect(calls(env.current, 'com.example.lookup')).toHaveLength(2);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('RxJS 6 Observables as inputs: a handler result (progressive) and a challenge answer', async () => {
    const callee = env.current.client();
    callee.register('com.example.letters', () => of('x', 'y')).subscribe();
    await env.current.advance(10);
    const caller = env.current.client();
    const letters = from(caller.progressiveCall('com.example.letters')).pipe(toArray()).toPromise();
    await env.current.advance(10);
    expect((await letters).map((r) => r.args[0] as string)).toEqual(['x', 'y']);
    const answers = new Subject<string>();
    const authed = env.current.client({ authmethods: ['ticket'], onChallenge: () => answers.pipe(take(1)) });
    await env.current.advance(10);
    answers.next('secret');
    await env.current.advance(10);
    expect(env.current.written(T.AUTHENTICATE)).toEqual([[T.AUTHENTICATE, 'secret', {}]]);
    expect(authed.session).toBeDefined();
  });
});
