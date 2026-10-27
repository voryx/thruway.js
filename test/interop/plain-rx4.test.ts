// Plain positional subscribe: code that bridges RxJS 5 streams into Rx 4 with an `rx5ToRx4` helper only calls
// `subscribe(next, error, complete)` and `unsubscribe()`; rxjs-hooks users call `output$.subscribe(fn)`. Rx 4 itself is
// not installed: `Rx4.create` below is the slice of Rx 4's `Observable.create` the bridge uses (an observer with
// onNext/onError/onCompleted, a dispose function as teardown).
import { describe, expect, test } from 'vitest';
import { isWampError } from '../../src/errors.js';
import { rxClient } from '../../src/rxjs/index.js';
import { calls, never, T, useInteropEnv } from './env.js';
import { loadRx5 } from './rx5-suite.js';

const env = useInteropEnv();

interface Rx4Observer<V> {
  onNext(value: V): void;
  onError(error: unknown): void;
  onCompleted(): void;
}
interface Rx4Observable<V> {
  subscribe(onNext?: (value: V) => void, onError?: (e: unknown) => void, onCompleted?: () => void): { dispose(): void };
}
const Rx4 = {
  create<V>(subscribe: (observer: Rx4Observer<V>) => () => void): Rx4Observable<V> {
    return {
      subscribe(onNext, onError, onCompleted) {
        let done = false;
        const teardown = subscribe({
          onNext: (v) => {
            if (!done) onNext?.(v);
          },
          onError: (e) => {
            if (!done) {
              done = true;
              onError?.(e);
            }
          },
          onCompleted: () => {
            if (!done) {
              done = true;
              onCompleted?.();
            }
          },
        });
        return { dispose: teardown };
      },
    };
  },
};

/** A typical RxJS 5 → Rx 4 bridge. */
interface PositionalSource<V> {
  subscribe(next: (v: V) => void, error: (e: unknown) => void, complete: () => void): { unsubscribe(): void };
}
function rx5ToRx4<V>(source: PositionalSource<V>): Rx4Observable<V> {
  return Rx4.create<V>((observer) => {
    const sub = source.subscribe(
      (v) => {
        observer.onNext(v);
      },
      (e) => {
        observer.onError(e);
      },
      () => {
        observer.onCompleted();
      },
    );
    return () => {
      sub.unsubscribe();
    };
  });
}

describe('rx5ToRx4 over raw client streams (positional subscribe)', () => {
  test('a progressive call: onNext per result, then onCompleted', async () => {
    env.current.router.procedure('com.example.ticker', () => ['done']);
    const client = env.current.client();
    const seen: unknown[] = [];
    let completed = false;
    rx5ToRx4(client.progressiveCall('com.example.ticker')).subscribe(
      (r) => seen.push(r.args),
      () => undefined,
      () => (completed = true),
    );
    await env.current.advance(10);
    expect(seen).toEqual([[['done']]]);
    expect(completed).toBe(true);
  });

  test('dispose() ⇒ unsubscribe ⇒ CANCEL; onError gets the typed WampError', async () => {
    env.current.router.procedure('com.example.slow', never);
    env.current.router.deny((request) => request.uri === 'com.example.denied');
    const client = env.current.client();
    const disposable = rx5ToRx4(client.call('com.example.slow')).subscribe();
    const errors: unknown[] = [];
    rx5ToRx4(client.call('com.example.denied')).subscribe(undefined, (e) => errors.push(e));
    await env.current.advance(10);
    disposable.dispose();
    await env.current.advance(10);
    const [call] = calls(env.current, 'com.example.slow');
    expect(env.current.written(T.CANCEL)).toEqual([[T.CANCEL, call?.[1], { mode: 'killnowait' }]]);
    expect(errors).toHaveLength(1);
    expect(isWampError(errors[0]) && errors[0].errorUri).toBe('wamp.error.not_authorized');
  });

  test('rxjs-hooks style: subscribe(fn) on a topic and on status; unsubscribe ⇒ UNSUBSCRIBE', async () => {
    const client = env.current.client();
    const events: unknown[] = [];
    const states: unknown[] = [];
    const topic = client.topic('com.example.notifications').subscribe((e) => events.push(e.args[0]));
    const status = client.status.subscribe((s) => states.push(s.state));
    await env.current.advance(10);
    env.current.router.publish('com.example.notifications', ['n1']);
    await env.current.advance(10);
    topic.unsubscribe();
    status.unsubscribe();
    await env.current.advance(10);
    expect(events).toEqual(['n1']);
    expect(states).toEqual(['connecting', 'open']);
    expect(topic.closed).toBe(true);
    expect(env.current.written(T.UNSUBSCRIBE)).toHaveLength(1);
  });

  test('positional subscribe(null, error): the error callback alone', async () => {
    const client = env.current.client();
    await client.close();
    const errors: unknown[] = [];
    client.call('com.example.after_close').subscribe(null, (e: unknown) => errors.push(e));
    expect(errors).toMatchObject([{ name: 'ConnectionClosedError', procedure: 'com.example.after_close' }]);
  });
});

describe('rx5ToRx4 over RxJS 5 adapter streams (rxClient)', () => {
  test('progressiveCall through rxClient(client, Observable.from) into Rx 4: values, completion, CANCEL on dispose', async () => {
    const { Observable } = loadRx5('rxjs5');
    let feed: { next(v: unknown): void } | undefined;
    env.current.router.procedure(
      'com.example.progress',
      () =>
        new Observable((observer) => {
          feed = observer;
        }),
    );
    const wamp = rxClient(env.current.client(), Observable.from);
    const seen: unknown[] = [];
    const disposable = rx5ToRx4(
      wamp.progressiveCall('com.example.progress', [7]) as unknown as PositionalSource<{
        args: unknown[];
      }>,
    ).subscribe((r) => seen.push(r.args[0]));
    await env.current.advance(10);
    feed?.next('ack 1');
    feed?.next('ack 2');
    await env.current.advance(10);
    expect(seen).toEqual(['ack 1', 'ack 2']);
    disposable.dispose();
    await env.current.advance(10);
    expect(env.current.written(T.CANCEL)).toHaveLength(1);
    expect(calls(env.current, 'com.example.progress')[0]?.[4]).toEqual([7]);
  });
});
