// Input<T> conversion: plain values, thenables, interop Observables (Symbol.observable / '@@observable'), any other
// object with subscribe() — RxJS 9 and the platform Observable called with {signal} — in that order; throwing getters,
// then and subscribe become errors of the conversion; async iterables (`async function*`, Node streams) iterated like
// for await; laziness and cancellation; the firstValue helper.
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import fc from 'fast-check';
import { Observable as Rx7Observable, of, Subject, throwError } from 'rxjs';
import { ColdObservable } from 'rxjs9';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { firstValue, subscribeInput, toObservable, type InputObserver } from '../../src/observable/input.js';
import { Observable, type Subscriber, type UnhandledReporter } from '../../src/observable/observable.js';
import { symbolObservable } from '../../src/observable/symbol-observable.js';
import type { Input, Observer, Subscription } from '../../src/types.js';
import { replayParameters } from '../setup-fast-check.js';

const require = createRequire(import.meta.url);

type Event = ['next', unknown] | ['error', unknown] | ['complete'];

/** Subscribe and record every notification. */
function record<T>(input: Input<T>, reporter?: UnhandledReporter) {
  const events: Event[] = [];
  const subscription = toObservable(input, reporter).subscribe({
    next: (v) => events.push(['next', v]),
    error: (e: unknown) => events.push(['error', e]),
    complete: () => events.push(['complete']),
  });
  return { events, subscription };
}

function recorder(): { reporter: UnhandledReporter; reports: unknown[][] } {
  const reports: unknown[][] = [];
  return { reports, reporter: (error, kind) => reports.push([error, kind]) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A minimal foreign interop Observable that records what it was given. */
function interopSource<T>(script: (observer: Observer<T>) => void, key: PropertyKey = symbolObservable) {
  const state = { subscribes: 0, unsubscribes: 0, observer: undefined as Observer<T> | undefined };
  const inner = {
    subscribe(observer: Observer<T>) {
      state.subscribes++;
      state.observer = observer;
      script(observer);
      return {
        unsubscribe() {
          state.unsubscribes++;
        },
      };
    },
  };
  return { source: { [key]: () => inner } as unknown as Input<T>, state };
}

let consoleError: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('plain values', () => {
  test.each([
    ['a number', 42],
    ['zero', 0],
    ['an empty string', ''],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 10n],
    ['a symbol', Symbol.for('s')],
    ['a plain object', { args: [1], kwargs: {} }],
    ['an array', [1, 2]],
    ['a function', () => 1],
    ['an object with a non-function then', { then: 1 }],
    ['an object with a non-function subscribe', { subscribe: true }],
    ['an object with a non-function interop key', { [symbolObservable]: 'x', '@@observable': 1 }],
    ['a null-prototype object', Object.create(null) as object],
  ])('%s: one value then complete, synchronously, by identity', (_, value) => {
    const { events, subscription } = record(value);
    expect(events).toEqual([['next', value], ['complete']]);
    expect(Object.is(events[0]?.[1], value)).toBe(true);
    expect(subscription.closed).toBe(true);
  });

  test('property: any value without then/subscribe/interop/Symbol.asyncIterator members is of(value)', () => {
    const plain = fc.anything().filter((v) => {
      if ((typeof v !== 'object' || v === null) && typeof v !== 'function') return true;
      const o = v as Record<PropertyKey, unknown>;
      const members = [o[symbolObservable], o['@@observable'], o['then'], o['subscribe'], o[Symbol.asyncIterator]];
      return !members.some((m) => typeof m === 'function');
    });
    fc.assert(
      fc.property(plain, (value) => {
        const { events } = record(value);
        expect(events).toHaveLength(2);
        expect(Object.is(events[0]?.[1], value)).toBe(true);
        expect(events[1]).toEqual(['complete']);
      }),
      replayParameters(),
    );
  });
});

describe('thenables', () => {
  test('a resolved Promise: one value then complete, asynchronously', async () => {
    const { events } = record(Promise.resolve('token'));
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual([['next', 'token'], ['complete']]);
  });

  test('a rejected Promise errors (and counts as handled)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const boom = new Error('rejected');
    const { events } = record(Promise.reject(boom));
    await tick();
    await tick();
    process.off('unhandledRejection', unhandled);
    expect(events).toEqual([['error', boom]]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('a synchronous custom thenable is still adopted asynchronously, once', async () => {
    const thenable = {
      then(resolve: (v: string) => void, reject: (e: unknown) => void) {
        resolve('first');
        resolve('second');
        reject(new Error('ignored'));
      },
    };
    const { events } = record(thenable as unknown as Input<string>);
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual([['next', 'first'], ['complete']]);
  });

  test('a thenable resolving to a thenable yields the inner value', async () => {
    const inner = {
      then: (resolve: (v: number) => void) => {
        resolve(7);
      },
    };
    const outer = {
      then: (resolve: (v: unknown) => void) => {
        resolve(inner);
      },
    };
    const { events } = record(outer as Input<number>);
    await tick();
    expect(events).toEqual([['next', 7], ['complete']]);
  });

  test('then() that throws, or a then getter that throws on adoption, errors the conversion', async () => {
    const boom = new Error('then threw');
    const throwingThen = {
      then() {
        throw boom;
      },
    };
    let reads = 0;
    const flakyGetter = {
      get then() {
        if (++reads > 1) throw boom;
        return () => undefined;
      },
    };
    const a = record(throwingThen as unknown as Input<number>);
    const b = record(flakyGetter as unknown as Input<number>);
    await tick();
    expect(a.events).toEqual([['error', boom]]);
    expect(b.events).toEqual([['error', boom]]);
  });

  test('a native Promise whose constructor getter throws errors synchronously', () => {
    const boom = new Error('constructor getter');
    const promise = Promise.resolve(1);
    void Object.defineProperty(promise, 'constructor', {
      get() {
        throw boom;
      },
    });
    expect(record(promise).events).toEqual([['error', boom]]);
  });

  test('unsubscribing before the Promise settles drops its value (a Promise cannot be cancelled)', async () => {
    let resolve!: (v: string) => void;
    const { events, subscription } = record(new Promise<string>((r) => (resolve = r)));
    subscription.unsubscribe();
    resolve('late');
    await tick();
    expect(events).toEqual([]);
  });
});

describe('interop Observables', () => {
  test('Symbol.observable: the observer is forwarded; unsubscribe calls the returned unsubscribe once', () => {
    const { source, state } = interopSource<number>((o) => {
      o.next(1);
    });
    const { events, subscription } = record(source);
    expect(events).toEqual([['next', 1]]);
    expect(state.subscribes).toBe(1);
    state.observer?.next(2);
    subscription.unsubscribe();
    subscription.unsubscribe();
    state.observer?.next(3);
    state.observer?.complete();
    expect(events).toEqual([
      ['next', 1],
      ['next', 2],
    ]);
    expect(state.unsubscribes).toBe(1);
  });

  test("'@@observable' (an Rx library loaded before Symbol.observable existed)", () => {
    const { source, state } = interopSource<string>((o) => {
      o.next('a');
      o.complete();
    }, '@@observable');
    expect(record(source).events).toEqual([['next', 'a'], ['complete']]);
    expect(state.unsubscribes).toBe(1); // a synchronous completion releases it when subscribe returns
  });

  test('errors and completion are forwarded; the forwarded observer works detached', () => {
    const boom = new Error('source error');
    const { source } = interopSource<number>((o) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the point: our observer's methods are closures
      const { next, error } = o;
      next(1);
      error(boom);
    });
    expect(record(source).events).toEqual([
      ['next', 1],
      ['error', boom],
    ]);
  });

  test('the interop key wins over then and subscribe', () => {
    const { source, state } = interopSource<number>((o) => {
      o.next(9);
    });
    const then = vi.fn();
    const subscribe = vi.fn();
    Object.assign(source as object, { then, subscribe });
    expect(record(source).events).toEqual([['next', 9]]);
    expect(state.subscribes).toBe(1);
    expect(then).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  test('RxJS 7 Observables: of, throwError, Subject (unsubscribe releases it)', () => {
    expect(record(of(1, 2)).events).toEqual([['next', 1], ['next', 2], ['complete']]);
    const boom = new Error('rx');
    expect(record(throwError(() => boom)).events).toEqual([['error', boom]]);
    const subject = new Subject<number>();
    const { events, subscription } = record(subject);
    subject.next(1);
    expect(subject.observed).toBe(true);
    subscription.unsubscribe();
    expect(subject.observed).toBe(false);
    subject.next(2);
    expect(events).toEqual([['next', 1]]);
  });

  test('RxJS 7 Observables take the interop path: subscribe(observer) without {signal}', () => {
    const rx = new Rx7Observable<number>((s) => {
      s.next(1);
    });
    const spy = vi.spyOn(rx, 'subscribe');
    record(rx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  test('our own Observable converts to itself', () => {
    let teardowns = 0;
    const ours = new Observable<number>((s) => {
      s.next(5);
      return () => {
        teardowns++;
      };
    });
    const { events, subscription } = record(ours);
    subscription.unsubscribe();
    expect(events).toEqual([['next', 5]]);
    expect(teardowns).toBe(1);
  });

  test.each([
    ['returns undefined', () => undefined],
    ['returns a primitive', () => 42],
    ['returns an object without subscribe', () => ({})],
    ['returns null', () => null],
  ])('an interop method that %s is a TypeError of the conversion', (_, method) => {
    const { events } = record({ [symbolObservable]: method } as unknown as Input<number>);
    expect(events).toEqual([
      ['error', new TypeError('thruway.js: the Symbol.observable method did not return an object with subscribe()')],
    ]);
    expect(events[0]?.[1]).toBeInstanceOf(TypeError);
  });

  test('a function-typed interop result with subscribe works', () => {
    const inner = Object.assign(() => undefined, {
      subscribe: (o: Observer<number>) => {
        o.next(3);
        o.complete();
      },
    });
    expect(record({ [symbolObservable]: () => inner } as unknown as Input<number>).events).toEqual([
      ['next', 3],
      ['complete'],
    ]);
  });

  test('throwing getter, throwing interop method and throwing subscribe become errors of the conversion', () => {
    const boom = new Error('hostile');
    const getter = Object.defineProperty({}, symbolObservable, {
      get() {
        throw boom;
      },
    });
    const method = {
      [symbolObservable]() {
        throw boom;
      },
    };
    const subscribe = {
      [symbolObservable]: () => ({
        subscribe() {
          throw boom;
        },
      }),
    };
    for (const input of [getter, method, subscribe]) {
      expect(record(input as Input<number>).events).toEqual([['error', boom]]);
    }
  });

  test("RxJS 5 rethrows its subscribe function's throw after delivering it: one error, nothing reported", () => {
    interface Rx5Static {
      readonly Observable: { create(subscribe: () => void): Input<number> };
    }
    for (const id of ['rxjs5/Rx.js', 'rxjs543/Rx.js']) {
      const { Observable: Rx5 } = require(id) as Rx5Static;
      const boom = new Error(`thrown inside ${id}`);
      const { reporter, reports } = recorder();
      const source = Rx5.create(() => {
        throw boom;
      });
      expect(record(source, reporter).events).toEqual([['error', boom]]);
      expect(first(source, reporter).calls).toEqual([['error', boom]]);
      expect(results(source, reporter).out).toEqual([['error', boom]]);
      expect(reports).toEqual([]);
    }
  });

  test('a foreign subscribe that delivers an error and then throws another value: that value is reported', () => {
    const delivered = new Error('delivered');
    const other = new Error('thrown afterwards');
    const { reporter, reports } = recorder();
    const interop = {
      [symbolObservable]: () => ({
        subscribe(o: Observer<number>) {
          o.error(delivered);
          throw other;
        },
      }),
    };
    expect(record(interop as Input<number>, reporter).events).toEqual([['error', delivered]]);
    expect(reports).toEqual([[other, 'unhandled']]);
    const withSignal = {
      subscribe(o: Observer<number>) {
        o.error(delivered);
        throw delivered; // the same value: handled already
      },
    };
    expect(record(withSignal as unknown as Input<number>, reporter).events).toEqual([['error', delivered]]);
    expect(reports).toEqual([[other, 'unhandled']]);
    // only the error that reached the subscriber counts: a second error, or one after completion, was never delivered
    const late = new Error('never delivered');
    const twice = {
      subscribe(o: Observer<number>) {
        o.error(delivered);
        o.error(late);
        throw late;
      },
    };
    const afterComplete = {
      subscribe(o: Observer<number>) {
        o.complete();
        o.error(late);
        throw late;
      },
    };
    expect(record(twice as unknown as Input<number>, reporter).events).toEqual([['error', delivered]]);
    expect(record(afterComplete as unknown as Input<number>, reporter).events).toEqual([['complete']]);
    expect(reports).toEqual([
      [other, 'unhandled'],
      [late, 'unhandled'],
      [late, 'unhandled'],
    ]);
  });

  test('an unsubscribe that throws is reported, not thrown; one that is missing is fine', () => {
    const boom = new Error('unsubscribe failed');
    const { reporter, reports } = recorder();
    const throwing = {
      [symbolObservable]: () => ({
        subscribe: () => ({
          unsubscribe() {
            throw boom;
          },
        }),
      }),
    };
    const { subscription } = record(throwing as Input<number>, reporter);
    expect(() => {
      subscription.unsubscribe();
    }).not.toThrow();
    expect(reports).toEqual([[boom, 'unhandled']]);
    for (const ret of [{ closed: false }, 7, undefined, null, () => undefined, { unsubscribe: 'no' }]) {
      const odd = { [symbolObservable]: () => ({ subscribe: () => ret }) };
      record(odd as unknown as Input<number>, reporter).subscription.unsubscribe();
    }
    expect(reports).toEqual([[boom, 'unhandled']]);
  });

  test('a revoked Proxy and a Proxy with a throwing get trap error the conversion', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    const revoked = record(proxy as Input<number>).events;
    expect(revoked[0]?.[0]).toBe('error');
    expect(revoked[0]?.[1]).toBeInstanceOf(TypeError);
    expect(record(hostile as Input<number>).events).toEqual([['error', new Error('trap')]]);
  });
});

describe('objects with a subscribe function (RxJS 9, the platform Observable)', () => {
  test('subscribe(observer, {signal}); unsubscribe aborts the signal and calls ret.unsubscribe()', () => {
    let given: { observer: Observer<number>; options: { signal: AbortSignal } } | undefined;
    const ret = { unsubscribe: vi.fn() };
    const source = {
      subscribe(observer: Observer<number>, options: { signal: AbortSignal }) {
        given = { observer, options };
        observer.next(1);
        return ret;
      },
    };
    const { events, subscription } = record(source as unknown as Input<number>);
    expect(events).toEqual([['next', 1]]);
    expect(given?.options.signal.aborted).toBe(false);
    expect(given?.options.signal).toBeInstanceOf(AbortSignal);
    subscription.unsubscribe();
    expect(given?.options.signal.aborted).toBe(true);
    expect((given?.options.signal.reason as Error).name).toBe('AbortError');
    expect(ret.unsubscribe).toHaveBeenCalledTimes(1);
    given?.observer.next(2);
    expect(events).toEqual([['next', 1]]);
  });

  test('a platform Observable (RxJS 9 polyfill): values, completion, and cancellation through the signal', () => {
    const teardowns = vi.fn();
    let producer: { next(value: number): void } | undefined;
    const platform = new globalThis.Observable<number>((subscriber) => {
      producer = subscriber;
      subscriber.addTeardown(teardowns);
      subscriber.next(1);
    });
    const { events, subscription } = record(platform as unknown as Input<number>);
    expect(events).toEqual([['next', 1]]);
    producer?.next(2);
    subscription.unsubscribe();
    expect(teardowns).toHaveBeenCalledTimes(1);
    producer?.next(3);
    expect(events).toEqual([
      ['next', 1],
      ['next', 2],
    ]);
  });

  test('RxJS 9 ColdObservable: each subscription runs the producer; errors are forwarded', () => {
    let runs = 0;
    const boom = new Error('rx9');
    const cold = new ColdObservable<string>((subscriber) => {
      runs++;
      subscriber.next('tok');
      if (runs === 2) subscriber.error(boom);
      else subscriber.complete();
    });
    expect(record(cold).events).toEqual([['next', 'tok'], ['complete']]);
    expect(record(cold).events).toEqual([
      ['next', 'tok'],
      ['error', boom],
    ]);
  });

  test('a subscribe getter or call that throws errors the conversion; ret without unsubscribe is fine', () => {
    const boom = new Error('subscribe');
    const getter = Object.defineProperty({}, 'subscribe', {
      get() {
        throw boom;
      },
    });
    const call = {
      subscribe() {
        throw boom;
      },
    };
    expect(record(getter as Input<number>).events).toEqual([['error', boom]]);
    expect(record(call as Input<number>).events).toEqual([['error', boom]]);
    const { reporter, reports } = recorder();
    for (const ret of [undefined, null, 1, { closed: true }]) {
      record({ subscribe: () => ret }, reporter).subscription.unsubscribe();
    }
    expect(reports).toEqual([]);
  });

  test('functions are inspected like objects (thenable, interop, subscribe)', async () => {
    const thenable = Object.assign(() => 'not called', {
      then: (resolve: (v: string) => void) => {
        resolve('from a thenable function');
      },
    });
    const interop = Object.assign(() => 'not called', { [symbolObservable]: () => of('from an interop function') });
    const subscribable = Object.assign(() => 'not called', {
      subscribe: (o: Observer<string>) => {
        o.next('from a subscribe function');
        o.complete();
      },
    });
    const a = record(thenable as unknown as Input<string>);
    expect(record(interop as unknown as Input<string>).events).toEqual([
      ['next', 'from an interop function'],
      ['complete'],
    ]);
    expect(record(subscribable as unknown as Input<string>).events).toEqual([
      ['next', 'from a subscribe function'],
      ['complete'],
    ]);
    await tick();
    expect(a.events).toEqual([['next', 'from a thenable function'], ['complete']]);
  });

  test('thenables win over subscribe', async () => {
    const subscribe = vi.fn();
    const source = {
      then: (r: (v: number) => void) => {
        r(1);
      },
      subscribe,
    };
    const { events } = record(source as Input<number>);
    await tick();
    expect(events).toEqual([['next', 1], ['complete']]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  test('an unsubscribe that throws after the abort is reported to the reporter', () => {
    const { reporter, reports } = recorder();
    const boom = new Error('ret.unsubscribe');
    let signal: AbortSignal | undefined;
    const source = {
      subscribe(_o: unknown, options: { signal: AbortSignal }) {
        signal = options.signal;
        return {
          unsubscribe() {
            throw boom;
          },
        };
      },
    };
    record(source as Input<number>, reporter).subscription.unsubscribe();
    expect(signal?.aborted).toBe(true);
    expect(reports).toEqual([[boom, 'unhandled']]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Async iterables: checked after interop, thenable and subscribe-object; iterated like
// `for await`: one emission per value, completion at done, an error for a throw or rejection; unsubscribe → return()
// ---------------------------------------------------------------------------------------------------------------------

/** What a scripted iterator does at one `next()` call. */
type Step =
  | { readonly kind: 'value'; readonly value: number; readonly via: 'object' | 'promise' | 'thenable' | 'twice' }
  | { readonly kind: 'done' }
  | { readonly kind: 'reject' | 'throw'; readonly error: number }
  | { readonly kind: 'non-object' }
  | { readonly kind: 'pending' };

/**
 * An async iterable whose iterator follows `script` (then reports done) and records how it is driven: next() and
 * return() calls, their `this`, a next() while another is still pending, a next() after the iterator ended.
 */
function scriptedIterable(script: readonly Step[]) {
  const state = { iterators: 0, nexts: 0, returns: 0, pending: 0, overlapped: false, nextAfterEnd: false };
  let ended = false;
  let wrongThis = false;
  const settle = <R>(result: R): Promise<R> => {
    state.pending++;
    return Promise.resolve().then(() => {
      state.pending--;
      return result;
    });
  };
  const iterator = {
    next(this: unknown): unknown {
      if (this !== iterator) wrongThis = true;
      if (ended) state.nextAfterEnd = true;
      if (state.pending > 0) state.overlapped = true;
      const step: Step = script[state.nexts++] ?? { kind: 'done' };
      if (step.kind !== 'value' && step.kind !== 'pending') ended = true;
      switch (step.kind) {
        case 'value': {
          const result = { value: step.value, done: false };
          if (step.via === 'object') return result;
          if (step.via === 'promise') return settle(result);
          if (step.via === 'thenable') {
            return {
              then(resolve: (r: unknown) => void) {
                resolve(result);
              },
            };
          }
          // a native Promise (handed back unchanged by Promise.resolve) whose own then calls back twice
          return Object.defineProperty(Promise.resolve(result), 'then', {
            value: (resolve: (r: unknown) => void) => {
              resolve(result);
              resolve({ value: 'a second callback', done: false });
            },
          });
        }
        case 'done':
          return settle({ value: 'dropped', done: true });
        case 'reject':
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- any value; numbers are easy to compare
          return Promise.reject(step.error);
        case 'throw':
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- any value; numbers are easy to compare
          throw step.error;
        case 'non-object':
          return settle(42);
        case 'pending':
          state.pending++;
          return new Promise(() => undefined);
      }
    },
    return(this: unknown): unknown {
      if (this !== iterator) wrongThis = true;
      ended = true;
      state.returns++;
      return Promise.resolve({ done: true });
    },
  };
  const iterable = {
    [Symbol.asyncIterator](this: unknown) {
      if (this !== iterable) wrongThis = true;
      state.iterators++;
      return iterator;
    },
  };
  return { iterable: iterable as AsyncIterable<number>, state, wrongThis: () => wrongThis };
}

/** Every pending microtask has run (setImmediate: unlike setTimeout it is not clamped to 1 ms, so properties stay
 *  fast); Node has also processed the unhandled rejections of those microtasks by then. */
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The time budget of an async property: it scales with FC_NUM_RUNS, never below vitest's default 5 s. */
const PROPERTY_TIMEOUT = Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 2);

/** Run `body` and fail if a promise rejection went unhandled meanwhile (Node reports them after the microtasks). */
async function noUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    await body();
    await settled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
  expect(unhandled).not.toHaveBeenCalled();
}

describe('async iterables', () => {
  test('an async generator: each value is one emission, asynchronously, then complete; finally runs once', async () => {
    const log: string[] = [];
    async function* numbers(): AsyncGenerator<number> {
      try {
        yield 1;
        yield await Promise.resolve(2);
        yield 3;
      } finally {
        log.push('finally');
      }
    }
    const { events, subscription } = record(numbers());
    expect(events).toEqual([]); // nothing synchronously, like a Promise
    await tick();
    expect(events).toEqual([['next', 1], ['next', 2], ['next', 3], ['complete']]);
    expect(subscription.closed).toBe(true);
    expect(log).toEqual(['finally']);
  });

  test('an async generator that throws: the values before, then that error (by identity)', async () => {
    const boom = new Error('feed failed');
    async function* failing(): AsyncGenerator<number> {
      yield 1;
      await Promise.resolve();
      throw boom;
    }
    const { events } = record(failing());
    await tick();
    expect(events).toEqual([
      ['next', 1],
      ['error', boom],
    ]);
    expect(events[1]?.[1]).toBe(boom);
  });

  test('an empty async generator only completes; the value of done is dropped (for await drops it too)', async () => {
    // eslint-disable-next-line require-yield -- the point: a generator that yields nothing
    async function* empty(): AsyncGenerator<number, string> {
      await Promise.resolve();
      return 'the return value';
    }
    const { events } = record(empty());
    await tick();
    expect(events).toEqual([['complete']]);
  });

  test('unsubscribe while the generator is suspended: return() runs its finally once; nothing follows', async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous yields: suspended at a yield when stopped
    async function* endless(): AsyncGenerator<number> {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        log.push('finally');
      }
    }
    const events: Event[] = [];
    const subscription = toObservable(endless()).subscribe({
      next: (v) => {
        events.push(['next', v]);
        if (v === 2) subscription.unsubscribe();
      },
      error: (e: unknown) => events.push(['error', e]),
      complete: () => events.push(['complete']),
    });
    await tick();
    subscription.unsubscribe();
    await tick();
    expect(events).toEqual([
      ['next', 0],
      ['next', 1],
      ['next', 2],
    ]);
    expect(log).toEqual(['finally']);
  });

  test('unsubscribe while next() is pending: return() is called once, the late result is ignored', async () => {
    await noUnhandledRejection(async () => {
      for (const late of ['value', 'reject'] as const) {
        let settle!: (result: unknown) => void;
        let fail!: (error: unknown) => void;
        const returns = vi.fn(() => Promise.resolve({ done: true }));
        const iterator = {
          next: () =>
            new Promise((resolve, reject) => {
              settle = resolve;
              fail = reject;
            }),
          return: returns,
        };
        const { events, subscription } = record({
          [Symbol.asyncIterator]: () => iterator,
        } as unknown as AsyncIterable<number>);
        subscription.unsubscribe();
        subscription.unsubscribe();
        expect(returns).toHaveBeenCalledTimes(1);
        expect(returns.mock.calls[0]).toEqual([]); // like `break` in for await: no argument
        if (late === 'value') settle({ value: 1, done: false });
        else fail(new Error('late rejection'));
        await tick();
        expect(events).toEqual([]);
        expect(returns).toHaveBeenCalledTimes(1);
      }
    });
  });

  test('a result that arrives after return() is not read (its done and value getters are never called)', async () => {
    let settle!: (result: unknown) => void;
    const reads: string[] = [];
    const late = {
      get done() {
        reads.push('done');
        return false;
      },
      get value() {
        reads.push('value');
        return 1;
      },
    };
    const iterator = {
      next: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      return: () => Promise.resolve({ done: true }),
    };
    const { events, subscription } = record({
      [Symbol.asyncIterator]: () => iterator,
    } as unknown as AsyncIterable<number>);
    subscription.unsubscribe();
    settle(late);
    await tick();
    expect(reads).toEqual([]);
    expect(events).toEqual([]);
  });

  test('the value of a done result is never read (for await reads only done)', async () => {
    const reads: string[] = [];
    const doneResult = {
      done: true,
      get value() {
        reads.push('value');
        throw new Error('never read');
      },
    };
    const iterator = { next: () => Promise.resolve(doneResult) };
    const { events } = record({ [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>);
    await tick();
    expect(events).toEqual([['complete']]);
    expect(reads).toEqual([]);
  });

  test('next is read once, when the iteration starts (the iterator record of for await)', async () => {
    let reads = 0;
    const results = [1, 2, 3];
    const original = function (this: unknown) {
      const value = results.shift();
      return Promise.resolve(value === undefined ? { done: true } : { value, done: false });
    };
    const iterator = {
      get next() {
        reads++;
        return reads === 1 ? original : () => Promise.reject(new Error('a later next getter value'));
      },
    };
    const viaForAwait: unknown[] = [];
    for await (const value of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<number>) {
      viaForAwait.push(value);
    }
    results.push(1, 2, 3);
    reads = 0;
    const { events } = record({ [Symbol.asyncIterator]: () => iterator } as AsyncIterable<number>);
    expect(reads).toBe(1);
    await tick();
    expect(events).toEqual([['next', 1], ['next', 2], ['next', 3], ['complete']]);
    expect(viaForAwait).toEqual([1, 2, 3]);
    expect(reads).toBe(1);
  });

  test('an iterator that never settles, then unsubscribed: return() once, no emission, no further next()', async () => {
    const { iterable, state } = scriptedIterable([{ kind: 'pending' }]);
    const { events, subscription } = record(iterable);
    await tick();
    expect(state.nexts).toBe(1);
    expect(events).toEqual([]);
    subscription.unsubscribe();
    await tick();
    expect(state.returns).toBe(1);
    expect(state.nexts).toBe(1);
    expect(events).toEqual([]);
  });

  test('return() is never called after the iterator finished or failed (for await semantics)', async () => {
    for (const end of [{ kind: 'done' }, { kind: 'reject', error: 1 }, { kind: 'throw', error: 2 }] as const) {
      const { iterable, state } = scriptedIterable([{ kind: 'value', value: 0, via: 'promise' }, end]);
      const { subscription } = record(iterable);
      await tick();
      subscription.unsubscribe();
      expect(state.returns).toBe(0);
    }
  });

  test('a missing or non-function return() is fine; next/return/Symbol.asyncIterator get the right `this`', async () => {
    for (const ret of [undefined, 'not a function']) {
      const iterator = { next: () => new Promise(() => undefined), return: ret };
      const { subscription } = record({ [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>);
      expect(() => {
        subscription.unsubscribe();
      }).not.toThrow();
    }
    const scripted = scriptedIterable([{ kind: 'value', value: 1, via: 'object' }, { kind: 'pending' }]);
    const { subscription } = record(scripted.iterable);
    await tick();
    subscription.unsubscribe();
    expect(scripted.state.returns).toBe(1);
    expect(scripted.wrongThis()).toBe(false);
  });

  test('return() that throws, rejects or has a throwing getter: reported once to the reporter, never thrown', async () => {
    const boom = new Error('return failed');
    const rejected = new Error('return rejected');
    const hostileReturns: (readonly [string, object, unknown])[] = [
      [
        'throws',
        {
          return() {
            throw boom;
          },
        },
        boom,
      ],
      ['rejects', { return: () => Promise.reject(rejected) }, rejected],
      [
        'a throwing getter',
        Object.defineProperty({}, 'return', {
          get() {
            throw boom;
          },
        }),
        boom,
      ],
    ];
    await noUnhandledRejection(async () => {
      for (const [name, partial, expected] of hostileReturns) {
        const { reporter, reports } = recorder();
        const iterator = Object.assign(partial, { next: () => new Promise(() => undefined) });
        const { subscription } = record(
          { [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>,
          reporter,
        );
        expect(() => {
          subscription.unsubscribe();
        }, name).not.toThrow();
        await tick();
        expect(reports, name).toEqual([[expected, 'unhandled']]);
      }
    });
  });

  test('without a reporter, a failing return() goes to the default logger (console.error)', async () => {
    const iterator = { next: () => new Promise(() => undefined), return: () => Promise.reject(new Error('r')) };
    record({ [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>).subscription.unsubscribe();
    await tick();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  describe('hostile iterables: an error of the conversion, never a throw out of subscribe', () => {
    const boom = new Error('hostile iterator');
    const never = (): Promise<never> => new Promise(() => undefined);
    const cases: (readonly [string, () => unknown, 'sync' | 'async', unknown])[] = [
      [
        'a Symbol.asyncIterator getter that throws',
        () =>
          Object.defineProperty({}, Symbol.asyncIterator, {
            get() {
              throw boom;
            },
          }),
        'sync',
        boom,
      ],
      [
        'a Symbol.asyncIterator method that throws',
        () => ({
          [Symbol.asyncIterator]() {
            throw boom;
          },
        }),
        'sync',
        boom,
      ],
      [
        'next() that throws at once',
        () => ({
          [Symbol.asyncIterator]: () => ({
            next() {
              throw boom;
            },
          }),
        }),
        'sync',
        boom,
      ],
      [
        'a next getter that throws',
        () => ({
          [Symbol.asyncIterator]: () =>
            Object.defineProperty({}, 'next', {
              get() {
                throw boom;
              },
            }),
        }),
        'sync',
        boom,
      ],
      [
        'next() rejecting',
        () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }) }),
        'async',
        boom,
      ],
      [
        'next() giving a thenable whose then throws',
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => ({
              then() {
                throw boom;
              },
            }),
          }),
        }),
        'async',
        boom,
      ],
      [
        'next() giving a native Promise whose constructor getter throws',
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Object.defineProperty(never(), 'constructor', {
                get() {
                  throw boom;
                },
              }),
          }),
        }),
        'async',
        boom,
      ],
      [
        'a result whose done getter throws',
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve(
                Object.defineProperty({}, 'done', {
                  get() {
                    throw boom;
                  },
                }),
              ),
          }),
        }),
        'async',
        boom,
      ],
      [
        'a result whose value getter throws',
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve(
                Object.defineProperty({ done: false }, 'value', {
                  get() {
                    throw boom;
                  },
                }),
              ),
          }),
        }),
        'async',
        boom,
      ],
    ];

    test.each(cases)('%s', async (_name, input, when, expected) => {
      await noUnhandledRejection(async () => {
        const { events, subscription } = record(input() as Input<number>);
        if (when === 'sync') expect(events).toEqual([['error', expected]]);
        await tick();
        expect(events).toEqual([['error', expected]]);
        expect(events[0]?.[1]).toBe(expected);
        expect(subscription.closed).toBe(true);
      });
    });

    /** A native Promise of `result` with an own `then` (Promise.resolve would hand it back unchanged). */
    const withOwnThen = (result: unknown, then: (this: Promise<unknown>, ...args: unknown[]) => unknown) =>
      Object.defineProperty(Promise.resolve(result), 'then', { value: then });

    test('a later next() giving a Promise whose own then throws: that error, never a hang or an unhandled rejection', async () => {
      await noUnhandledRejection(async () => {
        let calls = 0;
        const iterator = {
          next: () =>
            ++calls === 1
              ? Promise.resolve({ value: 1, done: false })
              : withOwnThen({ value: 2, done: false }, () => {
                  throw boom;
                }),
          return: vi.fn(),
        };
        const { events, subscription } = record({
          [Symbol.asyncIterator]: () => iterator,
        } as unknown as AsyncIterable<number>);
        await tick();
        expect(events).toEqual([
          ['next', 1],
          ['error', boom],
        ]);
        expect(subscription.closed).toBe(true);
        expect(iterator.return).not.toHaveBeenCalled(); // the iterator failed: for await does not return() it either
      });
    });

    test('a Promise whose own then calls back twice: one emission, never two next() in flight', async () => {
      let calls = 0;
      let pending = 0;
      let overlapped = false;
      const iterator = {
        next: () => {
          if (pending > 0) overlapped = true;
          pending++;
          const result = { value: ++calls, done: calls > 2 };
          return withOwnThen(result, (resolve) => {
            pending--;
            (resolve as (r: unknown) => void)(result);
            (resolve as (r: unknown) => void)({ value: 'second callback', done: false });
          });
        },
      };
      const { events } = record({ [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>);
      await tick();
      expect(events).toEqual([['next', 1], ['next', 2], ['complete']]);
      expect(overlapped).toBe(false);
    });

    test('return() giving a Promise whose own then throws or rejects twice: reported once, never thrown', async () => {
      const rejected = new Error('return rejected');
      const thens = [
        () => {
          throw boom;
        },
        (_ok: unknown, fail: unknown) => {
          (fail as (e: unknown) => void)(rejected);
          (fail as (e: unknown) => void)(rejected);
        },
      ];
      await noUnhandledRejection(async () => {
        for (const then of thens) {
          const { reporter, reports } = recorder();
          const iterator = { next: () => never(), return: () => withOwnThen({ done: true }, then) };
          const { subscription } = record(
            { [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<number>,
            reporter,
          );
          expect(() => {
            subscription.unsubscribe();
          }).not.toThrow();
          await tick();
          expect(reports).toHaveLength(1);
          expect(reports[0]?.[1]).toBe('unhandled');
        }
      });
    });

    test.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 7],
      ['a string', 'iterator'],
    ])('Symbol.asyncIterator returning %s: TypeError', (_name, value) => {
      const { events } = record({ [Symbol.asyncIterator]: () => value } as unknown as Input<number>);
      expect(events).toEqual([
        ['error', new TypeError('thruway.js: the Symbol.asyncIterator method did not return an object')],
      ]);
      expect(events[0]?.[1]).toBeInstanceOf(TypeError);
    });

    test.each([
      ['no next', {}],
      ['a non-function next', { next: 1 }],
    ])('an iterator with %s: TypeError, at once', (_name, iterator) => {
      const { events } = record({ [Symbol.asyncIterator]: () => iterator } as unknown as Input<number>);
      expect(events).toEqual([['error', new TypeError('thruway.js: an async iterator has no next() method')]]);
    });

    test.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 1],
      ['a string', 'done'],
      ['true', true],
    ])('next() resolving to %s (not an object): TypeError; return() is not called', async (_name, result) => {
      const returns = vi.fn();
      let calls = 0; // then done: a missed non-object check fails the assertions instead of looping forever
      const iterator = { next: () => Promise.resolve(calls++ === 0 ? result : { done: true }), return: returns };
      const { events, subscription } = record({
        [Symbol.asyncIterator]: () => iterator,
      } as unknown as AsyncIterable<number>);
      await tick();
      expect(events).toEqual([['error', new TypeError("thruway.js: an async iterator's next() gave a non-object")]]);
      subscription.unsubscribe();
      expect(returns).not.toHaveBeenCalled();
    });

    test('a function is an object: a result that is a function with value/done is read like an object', async () => {
      let calls = 0;
      const iterator = {
        next: () => Promise.resolve(Object.assign(() => undefined, { value: 5, done: calls++ > 0 })),
      };
      const { events } = record({ [Symbol.asyncIterator]: () => iterator });
      await tick();
      expect(events).toEqual([['next', 5], ['complete']]);
    });

    test('done is read as truthy/falsy, like for await: 1 and "yes" end, 0 and "" do not', async () => {
      const results = [
        { value: 'a', done: 0 },
        { value: 'b', done: '' },
        { value: 'c', done: null },
        { value: 'd' },
        { value: 'dropped', done: 'yes' },
      ];
      const iterator = { next: () => Promise.resolve(results.shift()) };
      const { events } = record({ [Symbol.asyncIterator]: () => iterator } as unknown as AsyncIterable<string>);
      await tick();
      expect(events).toEqual([['next', 'a'], ['next', 'b'], ['next', 'c'], ['next', 'd'], ['complete']]);
      const once = { next: () => Promise.resolve({ value: 'dropped', done: 1 }) };
      const ended = record({ [Symbol.asyncIterator]: () => once } as unknown as AsyncIterable<string>);
      await tick();
      expect(ended.events).toEqual([['complete']]);
    });
  });

  describe('classification order: interop key, then thenable, then subscribe(), then Symbol.asyncIterator', () => {
    // finite, so that a wrong classification fails the assertions instead of iterating forever
    const iteratorSpy = () =>
      vi.fn(() => {
        let calls = 0;
        return { next: () => Promise.resolve({ value: 'from the iterator', done: calls++ > 0 }) };
      });

    test('our Observable (an async iterable itself) is taken by its interop key, not iterated', () => {
      const ours = new Observable<string>((s) => {
        s.next('interop');
        s.complete();
        return undefined;
      });
      const spy = iteratorSpy();
      Object.defineProperty(ours, Symbol.asyncIterator, { value: spy });
      expect(record(ours).events).toEqual([['next', 'interop'], ['complete']]);
      expect(spy).not.toHaveBeenCalled();
    });

    test('an RxJS 7 Observable given a Symbol.asyncIterator still takes the interop path', () => {
      const rx = of('interop');
      const spy = iteratorSpy();
      Object.defineProperty(rx, Symbol.asyncIterator, { value: spy });
      expect(record(rx).events).toEqual([['next', 'interop'], ['complete']]);
      expect(spy).not.toHaveBeenCalled();
    });

    test('RxJS 9 and the platform Observable keep the subscribe(observer, {signal}) path, async iterable or not', () => {
      // RxJS 9.0.0-beta.1's Observables have no Symbol.asyncIterator of their own (only Observable.from accepts async
      // iterables); one that gains it must still be subscribed, never iterated.
      const cold = new ColdObservable<string>((subscriber) => {
        subscriber.next('subscribe');
        subscriber.complete();
      });
      const platform = new globalThis.Observable<string>((subscriber) => {
        subscriber.next('subscribe');
        subscriber.complete();
      });
      for (const source of [cold, platform]) {
        expect(Symbol.asyncIterator in source).toBe(false);
        const spy = iteratorSpy();
        const subscribe = vi.spyOn(source, 'subscribe');
        Object.defineProperty(source, Symbol.asyncIterator, { value: spy });
        expect(record(source as unknown as Input<string>).events).toEqual([['next', 'subscribe'], ['complete']]);
        expect(spy).not.toHaveBeenCalled();
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0]?.[1]).toHaveProperty('signal');
      }
    });

    test('a thenable that is also async iterable is a thenable', async () => {
      const spy = iteratorSpy();
      const source = {
        then: (resolve: (v: string) => void) => {
          resolve('thenable');
        },
        [Symbol.asyncIterator]: spy,
      };
      const { events } = record(source as unknown as Input<string>);
      await tick();
      expect(events).toEqual([['next', 'thenable'], ['complete']]);
      expect(spy).not.toHaveBeenCalled();
    });

    test('synchronous iterables (arrays, Sets, generator objects, strings) stay plain values', () => {
      function* gen(): Generator<number> {
        yield 1;
      }
      const generator = gen();
      for (const value of [[1, 2], new Set([1]), generator, 'abc', new Map([[1, 2]])]) {
        const { events } = record(value as Input<unknown>);
        expect(events.map(([kind]) => kind)).toEqual(['next', 'complete']); // toEqual would iterate the generator
        expect(events[0]?.[1]).toBe(value);
      }
    });

    test('a function with Symbol.asyncIterator is iterated (functions are inspected like objects)', async () => {
      const fn = Object.assign(() => 'not called', {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield 'from a function';
        },
      });
      const { events } = record(fn as unknown as Input<string>);
      await tick();
      expect(events).toEqual([['next', 'from a function'], ['complete']]);
    });
  });

  test('a Node Readable stream (an async iterable) emits its chunks; unsubscribe destroys it', async () => {
    // Node streams schedule some of their work with nextTick/setImmediate: wait for the outcome, bounded
    const until = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !condition(); i++) await tick();
    };
    const stream = Readable.from(['a', 'b', 'c']);
    const { events } = record(stream as unknown as Input<string>);
    await until(() => events.length === 4);
    expect(events).toEqual([['next', 'a'], ['next', 'b'], ['next', 'c'], ['complete']]);
    const endless = new Readable({
      objectMode: true,
      read() {
        this.push('x');
      },
    });
    const seen: unknown[] = [];
    const subscription = toObservable(endless as unknown as Input<string>).subscribe((v) => {
      seen.push(v);
      if (seen.length === 3) subscription.unsubscribe();
    });
    await until(() => endless.destroyed);
    expect(seen).toEqual(['x', 'x', 'x']);
    expect(endless.destroyed).toBe(true);
  });

  test('cold: Symbol.asyncIterator is called at each subscribe, never before; an iterable restarts', async () => {
    const calls = vi.fn();
    const iterable = {
      async *[Symbol.asyncIterator]() {
        calls();
        await Promise.resolve();
        yield 1;
        yield 2;
      },
    };
    const observable = toObservable(iterable);
    expect(calls).not.toHaveBeenCalled();
    const a: unknown[] = [];
    const b: unknown[] = [];
    observable.subscribe((v) => a.push(v));
    observable.subscribe((v) => b.push(v));
    await tick();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test('a generator object is single-use: a second subscription gets nothing more and completes', async () => {
    async function* once(): AsyncGenerator<number> {
      yield 1;
      await Promise.resolve();
      yield 2;
    }
    const observable = toObservable(once());
    const first = record(observable);
    await tick();
    const second = record(observable);
    await tick();
    expect(first.events).toEqual([['next', 1], ['next', 2], ['complete']]);
    expect(second.events).toEqual([['complete']]);
  });

  test('firstValue: the first value, then return() (finally runs, nothing after it); empty; error; cancel', async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- suspended at its first yield when released
    async function* tokens(): AsyncGenerator<string> {
      try {
        yield 'token-1';
        log.push('after the first value');
        yield 'token-2';
      } finally {
        log.push('finally');
      }
    }
    const taken = first(tokens());
    expect(taken.calls).toEqual([]);
    await tick();
    expect(taken.calls).toEqual([['next', 'token-1']]);
    expect(log).toEqual(['finally']);
    // eslint-disable-next-line require-yield -- an answer that completes without a value
    async function* empty(): AsyncGenerator<string> {
      await Promise.resolve();
    }
    const boom = new Error('token service');
    // eslint-disable-next-line require-yield -- an answer that fails before a value
    async function* failing(): AsyncGenerator<string> {
      await Promise.resolve();
      throw boom;
    }
    const e = first(empty());
    const f = first(failing());
    await tick();
    expect(e.calls).toEqual([['complete']]);
    expect(f.calls).toEqual([['error', boom]]);
    const { iterable, state } = scriptedIterable([{ kind: 'pending' }]);
    const cancelled = first(iterable);
    cancelled.cancel();
    cancelled.cancel();
    await tick();
    expect(cancelled.calls).toEqual([]);
    expect(state.returns).toBe(1);
  });

  test('subscribeInput: an async iterable is a stream (next* then complete), never a single value', async () => {
    async function* progress(): AsyncGenerator<number> {
      yield 1;
      yield await Promise.resolve(2);
    }
    const a = results(progress());
    // eslint-disable-next-line require-yield -- a stream without values
    async function* none(): AsyncGenerator<number> {
      await Promise.resolve();
    }
    const b = results(none());
    await tick();
    expect(a.out).toEqual([['next', 1], ['next', 2], ['complete']]);
    expect(b.out).toEqual([['complete']]);
  });

  test(
    'property: any script, any unsubscribe point — for-await semantics, return() at most once, nothing unhandled',
    async () => {
      const step: fc.Arbitrary<Step> = fc.oneof(
        {
          weight: 6,
          arbitrary: fc.record({
            kind: fc.constant('value' as const),
            value: fc.integer(),
            via: fc.constantFrom('object' as const, 'promise' as const, 'thenable' as const, 'twice' as const),
          }),
        },
        fc.constant({ kind: 'done' as const }),
        fc.record({ kind: fc.constantFrom('reject' as const, 'throw' as const), error: fc.integer() }),
        fc.constant({ kind: 'non-object' as const }),
        fc.constant({ kind: 'pending' as const }),
      );
      await fc.assert(
        fc.asyncProperty(
          fc.array(step, { maxLength: 12 }),
          fc.option(fc.nat({ max: 12 })),
          async (script, stopAfter) => {
            await noUnhandledRejection(async () => {
              const { iterable, state, wrongThis } = scriptedIterable(script);
              const events: Event[] = [];
              let count = 0;
              const subscription: Subscription = toObservable(iterable).subscribe({
                next: (v) => {
                  events.push(['next', v]);
                  if (++count === stopAfter) subscription.unsubscribe();
                },
                error: (e: unknown) => events.push(['error', e]),
                complete: () => events.push(['complete']),
              });
              if (stopAfter === 0) subscription.unsubscribe();
              await settled();
              subscription.unsubscribe(); // idempotent; releases an iterator that never settles
              await settled();

              // The oracle: what `for await` with a `break` after `stopAfter` values would observe.
              const expected: Event[] = [];
              let returned = false;
              if (stopAfter === 0) {
                const head = script[0];
                if (head?.kind === 'throw')
                  expected.push(['error', head.error]); // synchronous, inside subscribe
                else returned = true;
              } else {
                for (let i = 0; ; i++) {
                  const s: Step = script[i] ?? { kind: 'done' };
                  if (s.kind === 'value') {
                    expected.push(['next', s.value]);
                    if (expected.length === stopAfter) {
                      returned = true;
                      break;
                    }
                    continue;
                  }
                  if (s.kind === 'done') expected.push(['complete']);
                  else if (s.kind === 'reject' || s.kind === 'throw') expected.push(['error', s.error]);
                  else if (s.kind === 'non-object') expected.push(['error', expect.any(TypeError)]);
                  else returned = true; // pending: the final unsubscribe returns it
                  break;
                }
              }
              expect(events).toEqual(expected);
              expect(state.returns).toBe(returned ? 1 : 0);
              expect(state.iterators).toBe(1);
              expect(state.overlapped).toBe(false);
              expect(state.nextAfterEnd).toBe(false);
              expect(wrongThis()).toBe(false);
            });
          },
        ),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'property: an async generator of any values gives exactly what for await gives',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.anything(), { maxLength: 8 }), fc.boolean(), async (values, fails) => {
          const boom = new Error('end');
          // eslint-disable-next-line @typescript-eslint/require-await -- the generator only yields (yield awaits anyway)
          async function* gen(): AsyncGenerator {
            for (const value of values) yield value;
            if (fails) throw boom;
          }
          const viaForAwait: Event[] = [];
          try {
            for await (const value of gen()) viaForAwait.push(['next', value]);
            viaForAwait.push(['complete']);
          } catch (error) {
            viaForAwait.push(['error', error]);
          }
          const { events } = record(gen());
          await settled();
          expect(events).toEqual(viaForAwait);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );
});

describe('laziness and cold re-classification', () => {
  test('nothing is read before subscribe; every subscribe reads again', () => {
    const reads: PropertyKey[] = [];
    const proxy = new Proxy(
      { value: 1 },
      {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const observable = toObservable(proxy);
    expect(reads).toEqual([]);
    observable.subscribe(() => undefined);
    const once = reads.length;
    expect(once).toBeGreaterThan(0);
    observable.subscribe(() => undefined);
    expect(reads.length).toBe(once * 2);
  });

  test('a getter that changes between subscriptions changes the classification', async () => {
    let calls = 0;
    const shifty = {
      get then() {
        calls++;
        return calls === 1
          ? undefined
          : (r: (v: string) => void) => {
              r('promise');
            };
      },
    };
    const observable = toObservable(shifty as Input<string>);
    const seen: unknown[] = [];
    observable.subscribe((v) => seen.push(v));
    observable.subscribe((v) => seen.push(v));
    expect(seen).toEqual([shifty]);
    await tick();
    expect(seen).toEqual([shifty, 'promise']);
  });

  test('the conversion never throws out of subscribe, whatever the input (property)', () => {
    const { reporter } = recorder();
    fc.assert(
      fc.property(fc.anything({ withMap: true, withSet: true, withTypedArray: true }), (value) => {
        expect(() => {
          record(value, reporter).subscription.unsubscribe();
        }).not.toThrow();
      }),
      replayParameters(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// firstValue
// ---------------------------------------------------------------------------------------------------------------------

function first<T>(input: Input<T>, reporter?: UnhandledReporter) {
  const calls: Event[] = [];
  const cancel = firstValue<T>(
    input,
    (v) => calls.push(['next', v]),
    (e) => calls.push(['error', e]),
    () => calls.push(['complete']),
    reporter,
  );
  return { calls, cancel };
}

/** A source of ours that logs its lifecycle into `log`. */
function logged(log: string[], script: (s: Subscriber<string>) => void) {
  return new Observable<string>((s) => {
    log.push('subscribe');
    script(s);
    return () => log.push('teardown');
  });
}

describe('firstValue', () => {
  test('a plain value and a synchronous source: one callback, after the source was released', () => {
    expect(first('url').calls).toEqual([['next', 'url']]);
    const log: string[] = [];
    firstValue(
      logged(log, (s) => {
        s.next('a');
        s.next('b');
      }),
      (v) => log.push(`value ${v}`),
      () => log.push('error'),
      () => log.push('empty'),
    );
    expect(log).toEqual(['subscribe', 'teardown', 'value a']);
  });

  test('an asynchronous source: the first value only, source unsubscribed before the callback', () => {
    const log: string[] = [];
    let s!: Subscriber<string>;
    firstValue(
      logged(log, (subscriber) => (s = subscriber)),
      (v) => log.push(`value ${v} closed=${String(s.closed)}`),
      () => log.push('error'),
      () => log.push('empty'),
    );
    s.next('a');
    s.next('b');
    s.complete();
    expect(log).toEqual(['subscribe', 'teardown', 'value a closed=true']);
  });

  test('error and empty completion, synchronous and asynchronous', async () => {
    const boom = new Error('resolver failed');
    expect(first(throwError(() => boom)).calls).toEqual([['error', boom]]);
    expect(first(of()).calls).toEqual([['complete']]);
    const rejected = first(Promise.reject(boom));
    const resolved = first(Promise.resolve('ws://x'));
    expect(rejected.calls).toEqual([]);
    await tick();
    expect(rejected.calls).toEqual([['error', boom]]);
    expect(resolved.calls).toEqual([['next', 'ws://x']]);
    const empty = new Subject<string>();
    const e = first(empty);
    empty.complete();
    expect(e.calls).toEqual([['complete']]);
  });

  test('a conversion that throws (hostile getter) is onError, never a throw', () => {
    const boom = new Error('getter');
    const hostile = Object.defineProperty({}, 'then', {
      get() {
        throw boom;
      },
    });
    expect(first(hostile as Input<string>).calls).toEqual([['error', boom]]);
  });

  test('cancel(): no callback afterwards, the source is unsubscribed once, idempotent', async () => {
    const subject = new Subject<string>();
    const { calls, cancel } = first(subject);
    expect(subject.observed).toBe(true);
    cancel();
    expect(subject.observed).toBe(false);
    cancel();
    subject.next('late');
    expect(calls).toEqual([]);
    const promise = first(Promise.resolve('late'));
    promise.cancel();
    await tick();
    expect(promise.calls).toEqual([]);
  });

  test('cancel() after settling or from inside the callback does nothing', () => {
    const log: string[] = [];
    let s!: Subscriber<string>;
    const control: { cancel?: () => void } = {};
    const cancel = firstValue(
      logged(log, (subscriber) => (s = subscriber)),
      (v) => {
        log.push(`value ${v}`);
        control.cancel?.();
      },
      () => undefined,
      () => undefined,
    );
    control.cancel = cancel;
    s.next('a');
    cancel();
    expect(log).toEqual(['subscribe', 'teardown', 'value a']);
  });

  test('a callback that throws is reported, never rethrown (synchronous and asynchronous sources)', () => {
    const { reporter, reports } = recorder();
    const boom = new Error('submit failed');
    const thrower = () => {
      throw boom;
    };
    expect(() => firstValue('v', thrower, thrower, thrower, reporter)).not.toThrow();
    expect(() => firstValue(of(), thrower, thrower, thrower, reporter)).not.toThrow();
    expect(() =>
      firstValue(
        throwError(() => 'e'),
        thrower,
        thrower,
        thrower,
        reporter,
      ),
    ).not.toThrow();
    const subject = new Subject<string>();
    firstValue(subject, thrower, thrower, thrower, reporter);
    expect(() => {
      subject.next('async');
    }).not.toThrow();
    expect(reports).toEqual([
      [boom, 'next'],
      [boom, 'complete'],
      [boom, 'error'],
      [boom, 'next'],
    ]);
    firstValue('v', thrower, thrower, thrower);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('property: exactly one callback (or none after cancel) for any script of an async source', () => {
    const step = fc.constantFrom('next', 'error', 'complete', 'cancel');
    fc.assert(
      fc.property(fc.array(step, { maxLength: 8 }), fc.boolean(), (steps, syncFirst) => {
        let s: Subscriber<number> | undefined;
        let teardowns = 0;
        const source = new Observable<number>((subscriber) => {
          s = subscriber;
          if (syncFirst) subscriber.next(0);
          return () => {
            teardowns++;
          };
        });
        const { calls, cancel } = first(source);
        const producer = s;
        if (producer === undefined) throw new Error('not subscribed');
        let cancelled = false;
        for (const [i, k] of steps.entries()) {
          if (k === 'cancel') {
            if (calls.length === 0) cancelled = true;
            cancel();
          } else if (k === 'next') producer.next(i + 1);
          else if (k === 'error') producer.error(i);
          else producer.complete();
        }
        const settledBy = syncFirst ? 'next' : steps.find((k) => k !== 'cancel');
        const expectedCalls = cancelled && !syncFirst ? 0 : settledBy === undefined ? 0 : 1;
        expect(calls).toHaveLength(expectedCalls);
        if (expectedCalls === 1) expect(calls[0]?.[0]).toBe(settledBy);
        const released = expectedCalls === 1 || cancelled;
        expect(teardowns).toBe(released ? 1 : 0);
      }),
      replayParameters(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// subscribeInput: a single value (thenable, plain) kept apart from an Observable's values (callee results)
// ---------------------------------------------------------------------------------------------------------------------

type Out = ['next', unknown] | ['value', unknown] | ['error', unknown] | ['complete'];

function results<T>(input: Input<T>, reporter?: UnhandledReporter) {
  const out: Out[] = [];
  const observer: InputObserver<T> = {
    next: (v) => out.push(['next', v]),
    value: (v) => out.push(['value', v]),
    error: (e) => out.push(['error', e]),
    complete: () => out.push(['complete']),
  };
  return { out, subscription: subscribeInput(input, observer, reporter) };
}

describe('subscribeInput', () => {
  test('a plain value is the single value, synchronously; no next, no complete', () => {
    const { out, subscription } = results({ args: [1] });
    expect(out).toEqual([['value', { args: [1] }]]);
    expect(subscription.closed).toBe(true);
    expect(results(undefined).out).toEqual([['value', undefined]]);
  });

  test('a thenable resolves to the single value; a rejection is the error', async () => {
    const boom = new Error('handler rejected');
    const resolved = results(Promise.resolve('final'));
    const rejected = results(Promise.reject(boom));
    expect(resolved.out).toEqual([]);
    await tick();
    expect(resolved.out).toEqual([['value', 'final']]);
    expect(rejected.out).toEqual([['error', boom]]);
  });

  test('an Observable input: next for each value, then complete; an empty one only completes', () => {
    expect(results(of(1, 2)).out).toEqual([['next', 1], ['next', 2], ['complete']]);
    expect(results(of()).out).toEqual([['complete']]);
    const boom = new Error('stream failed');
    expect(results(throwError(() => boom)).out).toEqual([['error', boom]]);
    const platform = new globalThis.Observable<number>((subscriber) => {
      subscriber.next(7);
      subscriber.complete();
    });
    expect(results(platform as unknown as Input<number>).out).toEqual([['next', 7], ['complete']]);
    const ours = new Observable<number>((s) => {
      s.next(3);
      s.complete();
      return undefined;
    });
    expect(results(ours).out).toEqual([['next', 3], ['complete']]);
  });

  test('a single value of an Observable is still next + complete (only thenables and plain values are single)', () => {
    expect(results(of('one')).out).toEqual([['next', 'one'], ['complete']]);
  });

  test('a conversion that throws is the error; nothing escapes', () => {
    const boom = new Error('hostile');
    const hostile = Object.defineProperty({}, symbolObservable, {
      get() {
        throw boom;
      },
    });
    expect(results(hostile as Input<number>).out).toEqual([['error', boom]]);
  });

  test('unsubscribe releases the source and nothing follows', async () => {
    const subject = new Subject<number>();
    const a = results(subject);
    subject.next(1);
    a.subscription.unsubscribe();
    expect(subject.observed).toBe(false);
    subject.next(2);
    subject.complete();
    expect(a.out).toEqual([['next', 1]]);
    const b = results(Promise.resolve('late'));
    b.subscription.unsubscribe();
    await tick();
    expect(b.out).toEqual([]);
  });

  test("the observer's throws are reported, never rethrown", () => {
    const { reporter, reports } = recorder();
    const boom = new Error('submit failed');
    const thrower = () => {
      throw boom;
    };
    const observer = { next: thrower, value: thrower, error: thrower, complete: thrower };
    expect(() => subscribeInput('v', observer, reporter)).not.toThrow();
    expect(() => subscribeInput(of(1), observer, reporter)).not.toThrow();
    expect(() =>
      subscribeInput(
        throwError(() => 'e'),
        observer,
        reporter,
      ),
    ).not.toThrow();
    expect(reports).toEqual([
      [boom, 'next'],
      [boom, 'next'],
      [boom, 'complete'],
      [boom, 'error'],
    ]);
    subscribeInput('v', observer);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('property: next* (value | complete | error)? and value never follows next', () => {
    const input = fc.oneof(
      fc.anything().map((v) => ({ kind: 'plain', input: v })),
      fc.array(fc.integer(), { maxLength: 4 }).map((vs) => ({ kind: 'observable', input: of(...vs) })),
      fc.integer().map((v) => ({ kind: 'failing', input: throwError(() => v) })),
    );
    fc.assert(
      fc.property(input, ({ kind, input: value }) => {
        const { out } = results(value);
        const shape = out.map((o) => o[0]).join(' ');
        expect(shape).toMatch(/^(next ?)*(value|complete|error)?$/);
        if (shape.includes('value')) expect(shape).toBe('value');
        if (kind === 'observable') expect(shape.endsWith('complete')).toBe(true);
        if (kind === 'failing') expect(shape).toBe('error');
      }),
      replayParameters(),
    );
  });
});
