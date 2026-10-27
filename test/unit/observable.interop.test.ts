// Our Observable consumed by Rx libraries: RxJS 7 from() with operators, firstValueFrom/lastValueFrom, retry; the
// '@@observable' key; RxJS 5's Observable.from with its rethrowing SafeSubscriber isolated; the async iterator through
// for await and the platform Observable (RxJS 9), including return() on early exit and on abort. (The full per-version
// interop suites with a Client are in test/interop.)
import { createRequire } from 'node:module';
import { firstValueFrom, from, lastValueFrom, map, retry, take, toArray } from 'rxjs';
import 'rxjs9';
import { describe, expect, test, vi } from 'vitest';
import { Observable, type Subscriber, type UnhandledReporter } from '../../src/observable/observable.js';
import type { Observer } from '../../src/types.js';

const require = createRequire(import.meta.url);

function recorder(): { reporter: UnhandledReporter; reports: unknown[][] } {
  const reports: unknown[][] = [];
  return { reports, reporter: (error, kind) => reports.push([error, kind]) };
}

/** Ours, driven by hand, counting subscriptions and teardowns. */
function source<T>(reporter?: UnhandledReporter) {
  const state = { subscribes: 0, teardowns: 0, subscribers: [] as Subscriber<T>[] };
  const observable = new Observable<T>((s) => {
    state.subscribes++;
    state.subscribers.push(s);
    return () => {
      state.teardowns++;
    };
  }, reporter);
  const last = (): Subscriber<T> => {
    const s = state.subscribers[state.subscribers.length - 1];
    if (s === undefined) throw new Error('not subscribed');
    return s;
  };
  return { observable, state, last };
}

const sync = (...values: number[]) =>
  new Observable<number>((s) => {
    for (const v of values) s.next(v);
    s.complete();
    return undefined;
  });

describe('RxJS 7', () => {
  test('from(ours) with operators; unsubscribing the Rx subscription runs our teardown once', () => {
    const { observable, state, last } = source<number>();
    const seen: number[] = [];
    const subscription = from(observable)
      .pipe(map((v) => v * 10))
      .subscribe((v) => seen.push(v));
    last().next(1);
    last().next(2);
    subscription.unsubscribe();
    last().next(3);
    expect(seen).toEqual([10, 20]);
    expect(state.teardowns).toBe(1);
  });

  test('take(1) releases ours right after the first value', () => {
    const { observable, state, last } = source<number>();
    const seen: number[] = [];
    from(observable)
      .pipe(take(1))
      .subscribe((v) => seen.push(v));
    last().next(1);
    expect(state.teardowns).toBe(1);
    expect(last().closed).toBe(true);
    expect(seen).toEqual([1]);
  });

  test('errors and completion propagate; firstValueFrom, lastValueFrom, toArray', async () => {
    await expect(firstValueFrom(from(sync(4, 5)))).resolves.toBe(4);
    await expect(lastValueFrom(from(sync(4, 5)))).resolves.toBe(5);
    await expect(firstValueFrom(from(sync(1, 2, 3)).pipe(toArray()))).resolves.toEqual([1, 2, 3]);
    const boom = new Error('call failed');
    const failing = new Observable<number>((s) => {
      s.error(boom);
      return undefined;
    });
    await expect(firstValueFrom(from(failing))).rejects.toBe(boom);
  });

  test('retry re-subscribes ours: cold, a fresh producer per attempt', async () => {
    let attempts = 0;
    const flaky = new Observable<string>((s) => {
      attempts++;
      if (attempts < 3) s.error(new Error(`attempt ${String(attempts)}`));
      else {
        s.next('ok');
        s.complete();
      }
      return undefined;
    });
    await expect(firstValueFrom(from(flaky).pipe(retry(5)))).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  test('firstValueFrom/lastValueFrom given ours directly (JavaScript, no from()): released like an RxJS Observable', async () => {
    // RxJS's firstValueFrom calls source.subscribe(rxSubscriber) and drops the returned Subscription.
    const { observable, state, last } = source<number>();
    const first = firstValueFrom(observable as never);
    last().next(1);
    await expect(first).resolves.toBe(1);
    expect(state.teardowns).toBe(1);
    expect(last().closed).toBe(true);
    let teardowns = 0;
    const replaying = new Observable<string>((s) => {
      s.next('open'); // a LatestSubject replay: the value arrives inside subscribe
      return () => {
        teardowns++;
      };
    });
    await expect(firstValueFrom(replaying as never)).resolves.toBe('open');
    expect(teardowns).toBe(1);
    await expect(lastValueFrom(sync(1, 2, 3) as never)).resolves.toBe(3);
  });

  test("'@@observable': RxJS 7 loaded before our module (this file's import order) resolves the string key", () => {
    // RxJS 7 picks `Symbol.observable || '@@observable'` once at load. This file imports it before thruway.js, so it
    // runs on the string key; symbol-observable.test.ts covers both orders with fresh module loads.
    const viaString = vi.spyOn(Observable.prototype, '@@observable');
    const { observable, state, last } = source<number>();
    const seen: number[] = [];
    const subscription = from(observable).subscribe((v) => seen.push(v));
    last().next(1);
    subscription.unsubscribe();
    expect(seen).toEqual([1]);
    expect(viaString).toHaveBeenCalledTimes(1);
    expect(state.teardowns).toBe(1);
  });
});

describe('RxJS 5', () => {
  interface Rx5Subscription {
    unsubscribe(): void;
  }
  interface Rx5Observable<T> {
    subscribe(next?: (v: T) => void, error?: (e: unknown) => void): Rx5Subscription;
    map<R>(fn: (v: T) => R): Rx5Observable<R>;
    toPromise(): Promise<T>;
  }
  const { Observable: Rx5 } = require('rxjs5/Rx.js') as {
    Observable: { from<T>(x: unknown): Rx5Observable<T> };
  };

  test('Observable.from(ours) with a patched operator and toPromise', async () => {
    const seen: number[] = [];
    Rx5.from<number>(sync(1, 2))
      .map((v) => v + 1)
      .subscribe((v) => seen.push(v));
    expect(seen).toEqual([2, 3]);
    await expect(Rx5.from<number>(sync(7, 8)).toPromise()).resolves.toBe(8);
  });

  test('an RxJS 5 Subscriber given directly is linked: its unsubscribe releases ours', () => {
    const { Subscriber: Rx5Subscriber } = require('rxjs5/Rx.js') as {
      Subscriber: new (next: (v: number) => void) => Rx5Subscription & Partial<Observer<number>>;
    };
    const { observable, state, last } = source<number>();
    const seen: number[] = [];
    const rxSubscriber = new Rx5Subscriber((v) => seen.push(v));
    observable.subscribe(rxSubscriber);
    last().next(1);
    rxSubscriber.unsubscribe();
    last().next(2);
    expect(seen).toEqual([1]);
    expect(state.teardowns).toBe(1);
    expect(last().closed).toBe(true);
  });

  test("RxJS 5's SafeSubscriber rethrows an observer error: we report it, and it never reaches the producer", () => {
    const { reporter, reports } = recorder();
    const { observable, state, last } = source<number>(reporter);
    const boom = new Error('app observer');
    Rx5.from<number>(observable).subscribe(() => {
      throw boom;
    });
    expect(() => {
      last().next(1);
    }).not.toThrow();
    expect(reports).toEqual([[boom, 'next']]);
    expect(state.teardowns).toBe(1); // RxJS 5 unsubscribes itself before rethrowing
    expect(last().closed).toBe(true);
  });
});

describe('async iterator', () => {
  test('for await with break calls return(): the subscription is released', async () => {
    const { observable, state, last } = source<number>();
    const seen: number[] = [];
    const loop = (async () => {
      for await (const v of observable) {
        seen.push(v);
        if (v === 2) break;
      }
    })();
    last().next(1);
    last().next(2);
    await loop;
    expect(seen).toEqual([1, 2]);
    expect(state.teardowns).toBe(1);
  });

  test('a throw in the for await body calls return() too', async () => {
    const { observable, state, last } = source<number>();
    const loop = (async () => {
      for await (const v of observable) throw new Error(`body ${String(v)}`);
    })();
    last().next(1);
    await expect(loop).rejects.toThrow('body 1');
    expect(state.teardowns).toBe(1);
  });

  test('the platform Observable (RxJS 9 polyfill): Observable.from(ours) pulls every value', async () => {
    const platform = globalThis.Observable.from(sync(1, 2, 3));
    await expect(platform.toArray()).resolves.toEqual([1, 2, 3]);
  });

  test('platform first(): return() releases ours after the first value', async () => {
    const { observable, state, last } = source<string>();
    const first = globalThis.Observable.from(observable).first();
    await Promise.resolve();
    last().next('a');
    last().next('b');
    await expect(first).resolves.toBe('a');
    await vi.waitFor(() => {
      expect(state.teardowns).toBe(1);
    });
  });

  test('aborting the platform subscription calls return(), which unsubscribes ours', async () => {
    const { observable, state, last } = source<number>();
    const controller = new AbortController();
    const seen: number[] = [];
    globalThis.Observable.from(observable).subscribe({ next: (v) => seen.push(v) }, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(state.subscribes).toBe(1);
    });
    last().next(1);
    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    controller.abort();
    await vi.waitFor(() => {
      expect(state.teardowns).toBe(1);
    });
  });

  test('a source error ends the platform subscription with that error', async () => {
    const boom = new Error('lost');
    const failing = new Observable<number>((s) => {
      s.next(1);
      s.error(boom);
      return undefined;
    });
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      globalThis.Observable.from(failing).subscribe({
        next: (v) => seen.push(v),
        error: (e: unknown) => {
          seen.push(e);
          resolve();
        },
      });
    });
    expect(seen).toEqual([1, boom]);
  });
});
