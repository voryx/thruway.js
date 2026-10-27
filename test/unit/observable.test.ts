// Observable + Subscriber: the grammar next* (error|complete)? as a property over random producer/consumer scripts,
// teardown exactly once, synchronous emission inside subscribe, positional and object observers through the one
// subscribe signature, throwing observers reported to the reporter and never rethrown, and the async iterator with its
// 1024-value buffer cap.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi, type MockInstance } from 'vitest';
import {
  defaultReporter,
  ITERATOR_BUFFER_LIMIT,
  logReporter,
  Observable,
  report,
  Subscriber,
  type TeardownLogic,
  type UnhandledReporter,
} from '../../src/observable/observable.js';
import { symbolObservable } from '../../src/observable/symbol-observable.js';
import type { BaseOp, OpSubscriber } from '../../src/core/contracts.js';
import type { LogEntry, Observer, Observable as PublicObservable, Subscription } from '../../src/types.js';
import { replayParameters } from '../setup-fast-check.js';

type Kind = Parameters<UnhandledReporter>[1];

function recorder(): { reporter: UnhandledReporter; reports: [unknown, Kind][] } {
  const reports: [unknown, Kind][] = [];
  return { reports, reporter: (error, kind) => reports.push([error, kind]) };
}

/** A source whose subscriber the test drives by hand. */
function manual<T>(reporter?: UnhandledReporter) {
  const state = { subscribes: 0, teardowns: 0, subscriber: undefined as Subscriber<T> | undefined };
  const observable = new Observable<T>((subscriber) => {
    state.subscribes++;
    state.subscriber = subscriber;
    return () => {
      state.teardowns++;
    };
  }, reporter);
  return {
    observable,
    state,
    get s(): Subscriber<T> {
      if (state.subscriber === undefined) throw new Error('not subscribed');
      return state.subscriber;
    },
  };
}

let consoleError: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
// Grammar property: a reference model of the semantics, compared event by event.
// ---------------------------------------------------------------------------------------------------------------------

type Cmd =
  | { readonly k: 'next'; readonly v: number }
  | { readonly k: 'error' }
  | { readonly k: 'complete' }
  | { readonly k: 'unsubscribe' }
  | { readonly k: 'throw' };
type ObserverShape = 'object' | 'positional' | 'nextOnly' | 'errorOnly' | 'none' | 'emptyObject';

const producerCmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 99 }).map((v): Cmd => ({ k: 'next', v })) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ k: 'error' }) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ k: 'complete' }) },
);
const syncCmd = fc.oneof(producerCmd, fc.constant<Cmd>({ k: 'throw' }));
const asyncCmd = fc.oneof(producerCmd, fc.constant<Cmd>({ k: 'unsubscribe' }));

const scenario = fc.record({
  sync: fc.array(syncCmd, { maxLength: 6 }),
  later: fc.array(asyncCmd, { maxLength: 8 }),
  teardown: fc.constantFrom('function', 'object', 'none'),
  shape: fc.constantFrom<ObserverShape>('object', 'positional', 'nextOnly', 'errorOnly', 'none', 'emptyObject'),
  nextThrowsOnOdd: fc.boolean(),
  terminalThrows: fc.boolean(),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer S> ? S : never;

function run(sc: Scenario) {
  const log: string[] = [];
  const { reporter, reports } = recorder();
  const errors = { producer: new Error('producer error'), thrown: new Error('subscribe threw') };
  const fail = (what: string) => new Error(`${what} callback threw`);
  const next = (v: number) => {
    log.push(`next:${String(v)}`);
    if (sc.nextThrowsOnOdd && v % 2 === 1) throw fail(`next ${String(v)}`);
  };
  const error = (e: unknown) => {
    log.push(`error:${e === errors.producer ? 'producer' : 'thrown'}`);
    if (sc.terminalThrows) throw fail('error');
  };
  const complete = () => {
    log.push('complete');
    if (sc.terminalThrows) throw fail('complete');
  };
  let subscriber: Subscriber<number> | undefined;
  const teardown: TeardownLogic =
    sc.teardown === 'function'
      ? () => log.push('teardown')
      : sc.teardown === 'object'
        ? { unsubscribe: () => log.push('teardown') }
        : undefined;
  const observable = new Observable<number>((s) => {
    subscriber = s;
    for (const cmd of sc.sync) {
      if (cmd.k === 'throw') throw errors.thrown;
      if (cmd.k === 'next') s.next(cmd.v);
      else if (cmd.k === 'error') s.error(errors.producer);
      else if (cmd.k === 'complete') s.complete();
    }
    return teardown;
  }, reporter);
  let subscription: Subscription;
  switch (sc.shape) {
    case 'object':
      subscription = observable.subscribe({ next, error, complete });
      break;
    case 'positional':
      subscription = observable.subscribe(next, error, complete);
      break;
    case 'nextOnly':
      subscription = observable.subscribe(next);
      break;
    case 'errorOnly':
      subscription = observable.subscribe(null, error);
      break;
    case 'none':
      subscription = observable.subscribe();
      break;
    case 'emptyObject':
      subscription = observable.subscribe({});
      break;
  }
  log.push('subscribed');
  for (const cmd of sc.later) {
    if (cmd.k === 'unsubscribe') subscription.unsubscribe();
    else if (cmd.k === 'next') subscriber?.next(cmd.v);
    else if (cmd.k === 'error') subscriber?.error(errors.producer);
    else if (cmd.k === 'complete') subscriber?.complete();
  }
  return {
    log,
    reports: reports.map(([e, kind]) => [e instanceof Error ? e.message : e, kind]),
    closed: subscription.closed,
  };
}

/** The Observable semantics, written independently of the implementation. */
function model(sc: Scenario) {
  const log: string[] = [];
  const reports: [unknown, Kind][] = [];
  const hasNext = sc.shape === 'object' || sc.shape === 'positional' || sc.shape === 'nextOnly';
  const hasError = sc.shape === 'object' || sc.shape === 'positional' || sc.shape === 'errorOnly';
  const hasComplete = sc.shape === 'object' || sc.shape === 'positional';
  const state = { open: true, teardownSet: false };
  const deliverNext = (v: number) => {
    if (!hasNext) return;
    log.push(`next:${String(v)}`);
    if (sc.nextThrowsOnOdd && v % 2 === 1) reports.push([`next ${String(v)} callback threw`, 'next']);
  };
  const deliverError = (which: 'producer' | 'thrown') => {
    if (!hasError) {
      reports.push([which === 'producer' ? 'producer error' : 'subscribe threw', 'unhandled']);
      return;
    }
    log.push(`error:${which}`);
    if (sc.terminalThrows) reports.push(['error callback threw', 'error']);
  };
  const deliverComplete = () => {
    if (!hasComplete) return;
    log.push('complete');
    if (sc.terminalThrows) reports.push(['complete callback threw', 'complete']);
  };
  /** close(): the teardown (if one was returned already) runs before the terminal callback. */
  const close = () => {
    state.open = false;
    if (state.teardownSet) {
      state.teardownSet = false;
      log.push('teardown');
    }
  };
  let threw = false;
  for (const cmd of sc.sync) {
    if (cmd.k === 'throw') {
      threw = true;
      if (state.open) {
        close();
        deliverError('thrown');
      } else {
        reports.push(['subscribe threw', 'unhandled']);
      }
      break;
    }
    if (!state.open) continue;
    if (cmd.k === 'next') deliverNext(cmd.v);
    else if (cmd.k === 'error') {
      close();
      deliverError('producer');
    } else if (cmd.k === 'complete') {
      close();
      deliverComplete();
    }
  }
  if (!threw && sc.teardown !== 'none') {
    if (state.open) state.teardownSet = true;
    else log.push('teardown'); // returned after the subscriber closed: runs at once
  }
  log.push('subscribed');
  for (const cmd of sc.later) {
    if (!state.open) continue;
    if (cmd.k === 'next') deliverNext(cmd.v);
    else if (cmd.k === 'unsubscribe') close();
    else if (cmd.k === 'error') {
      close();
      deliverError('producer');
    } else {
      close();
      deliverComplete();
    }
  }
  return { log, reports, closed: !state.open };
}

describe('grammar next* (error|complete)? (property)', () => {
  test('every script behaves like the reference model', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        const actual = run(sc);
        expect(actual).toEqual(model(sc));
        const notifications = actual.log.filter((e) => e !== 'teardown' && e !== 'subscribed');
        expect(notifications.join(' ')).toMatch(/^(next:\d+ ?)*((error:\w+|complete))?$/);
        expect(actual.log.filter((e) => e === 'teardown').length).toBeLessThanOrEqual(1);
      }),
      replayParameters(),
    );
  });

  test('never throws out of subscribe, next, error, complete or unsubscribe (any thrown value)', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.constantFrom('next', 'error', 'complete', 'teardown', 'subscribe'),
        (thrown, where) => {
          const { reporter, reports } = recorder();
          const raise = () => {
            throw thrown;
          };
          let sub: Subscriber<number> | undefined;
          const observable = new Observable<number>((s) => {
            sub = s;
            if (where === 'subscribe') raise();
            return where === 'teardown' ? raise : undefined;
          }, reporter);
          const subscription = observable.subscribe({
            next: where === 'next' ? raise : undefined,
            error: where === 'error' || where === 'subscribe' ? raise : undefined,
            complete: where === 'complete' ? raise : undefined,
          } as unknown as Partial<Observer<number>>);
          sub?.next(1);
          if (where === 'error') sub?.error('e');
          else sub?.complete();
          subscription.unsubscribe();
          expect(reports.length).toBeGreaterThan(0);
          expect(Object.is(reports[0]?.[0], thrown)).toBe(true);
        },
      ),
      replayParameters(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('teardown runs exactly once', () => {
  test('unsubscribe is idempotent; later notifications are dropped', () => {
    const m = manual<number>();
    const seen: unknown[] = [];
    const subscription = m.observable.subscribe({
      next: (v) => seen.push(v),
      error: (e) => seen.push(['error', e]),
      complete: () => seen.push('complete'),
    });
    m.s.next(1);
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    subscription.unsubscribe();
    m.s.next(2);
    m.s.error('x');
    m.s.complete();
    expect(seen).toEqual([1]);
    expect(m.state.teardowns).toBe(1);
    expect(subscription.closed).toBe(true);
    expect(m.s.closed).toBe(true);
  });

  test('error, then complete, then unsubscribe: one teardown, one notification', () => {
    const m = manual<number>();
    const seen: unknown[] = [];
    const subscription = m.observable.subscribe({ error: (e) => seen.push(e), complete: () => seen.push('c') });
    m.s.error('boom');
    m.s.complete();
    m.s.error('again');
    subscription.unsubscribe();
    expect(seen).toEqual(['boom']);
    expect(m.state.teardowns).toBe(1);
  });

  test('the teardown runs before the terminal callback, which sees closed === true', () => {
    const order: string[] = [];
    let s!: Subscriber<number>;
    const subscription = new Observable<number>((subscriber) => {
      s = subscriber;
      return () => order.push('teardown');
    }).subscribe({
      complete: () => {
        order.push(`complete closed=${String(subscription.closed)} producer closed=${String(s.closed)}`);
      },
    });
    s.complete();
    expect(order).toEqual(['teardown', 'complete closed=true producer closed=true']);
  });

  test('a re-entrant unsubscribe or error from inside the teardown does not run it twice', () => {
    let count = 0;
    let s!: Subscriber<number>;
    const holder: { subscription?: Subscription } = {};
    const errors: unknown[] = [];
    const subscription = new Observable<number>((subscriber) => {
      s = subscriber;
      return () => {
        count++;
        holder.subscription?.unsubscribe();
        s.error('from teardown');
      };
    }).subscribe({ error: (e) => errors.push(e) });
    holder.subscription = subscription;
    subscription.unsubscribe();
    expect(count).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a teardown returned after a synchronous terminal runs at once, after the notification', () => {
    const order: string[] = [];
    const subscription = new Observable<number>((s) => {
      s.next(1);
      s.complete();
      return () => order.push('teardown');
    }).subscribe({ next: (v) => order.push(`next ${String(v)}`), complete: () => order.push('complete') });
    expect(order).toEqual(['next 1', 'complete', 'teardown']);
    expect(subscription.closed).toBe(true);
    subscription.unsubscribe();
    expect(order).toHaveLength(3);
  });

  test('an Unsubscribable teardown is called as a method; other return values are ignored', () => {
    const calls: unknown[] = [];
    const resource = {
      name: 'resource',
      unsubscribe(this: { name: string }) {
        calls.push(this.name);
      },
    };
    new Observable<number>(() => resource).subscribe().unsubscribe();
    expect(calls).toEqual(['resource']);
    for (const junk of [42, 'str', null, { unsubscribe: 'not a function' }, Symbol('s')]) {
      const { reporter, reports } = recorder();
      const subscription = new Observable<number>(() => junk as unknown as TeardownLogic, reporter).subscribe();
      subscription.unsubscribe();
      expect(subscription.closed).toBe(true);
      expect(reports).toEqual([]);
    }
  });

  test('a throwing teardown (or unsubscribe getter) is reported as unhandled, never thrown', () => {
    const boom = new Error('teardown failed');
    const { reporter, reports } = recorder();
    const throwing = new Observable<number>(
      () => () => {
        throw boom;
      },
      reporter,
    ).subscribe();
    expect(() => {
      throwing.unsubscribe();
    }).not.toThrow();
    expect(throwing.closed).toBe(true);
    const getter = {
      get unsubscribe(): () => void {
        throw boom;
      },
    };
    let s!: Subscriber<number>;
    const seen: unknown[] = [];
    new Observable<number>((subscriber) => {
      s = subscriber;
      return getter;
    }, reporter).subscribe({ complete: () => seen.push('complete') });
    s.complete();
    expect(seen).toEqual(['complete']);
    expect(reports).toEqual([
      [boom, 'unhandled'],
      [boom, 'unhandled'],
    ]);
  });
});

describe('synchronous emission during subscribe', () => {
  test('values and the completion arrive before subscribe returns', () => {
    const seen: unknown[] = [];
    const subscription = new Observable<number>((s) => {
      s.next(1);
      s.next(2);
      s.complete();
      s.next(3);
      return undefined;
    }).subscribe({ next: (v) => seen.push(v), complete: () => seen.push('done') });
    seen.push('returned');
    expect(seen).toEqual([1, 2, 'done', 'returned']);
    expect(subscription.closed).toBe(true);
  });

  test('a subscribe function that throws delivers the error synchronously; after a terminal it is reported', () => {
    const { reporter, reports } = recorder();
    const seen: unknown[] = [];
    const bad = new TypeError('invalid argument');
    const subscription = new Observable<number>(() => {
      throw bad;
    }, reporter).subscribe({ error: (e) => seen.push(e) });
    expect(seen).toEqual([bad]);
    expect(subscription.closed).toBe(true);
    new Observable<number>((s) => {
      s.complete();
      throw bad;
    }, reporter).subscribe({ error: (e) => seen.push(e) });
    expect(seen).toEqual([bad]);
    expect(reports).toEqual([[bad, 'unhandled']]);
  });

  test('cold: every subscribe runs the subscribe function again with a fresh Subscriber', () => {
    const subscribers: Subscriber<number>[] = [];
    const observable = new Observable<number>((s) => {
      subscribers.push(s);
      s.next(subscribers.length);
      return undefined;
    });
    const seen: number[] = [];
    observable.subscribe((v) => seen.push(v));
    observable.subscribe((v) => seen.push(v)).unsubscribe();
    observable.subscribe((v) => seen.push(v));
    expect(seen).toEqual([1, 2, 3]);
    expect(new Set(subscribers).size).toBe(3);
    expect(subscribers.map((s) => s.closed)).toEqual([false, true, false]);
  });

  test('re-subscribing from inside the error callback (retry) starts after the old teardown ran', () => {
    const order: string[] = [];
    const subscribers: Subscriber<number>[] = [];
    const observable = new Observable<number>((s) => {
      const n = subscribers.push(s);
      order.push(`start ${String(n)}`);
      return () => order.push(`teardown ${String(n)}`);
    });
    const subscribeOnce = () => {
      observable.subscribe({ error: subscribeOnce, complete: () => order.push('complete') });
    };
    subscribeOnce();
    subscribers[0]?.error(new Error('fail 1'));
    subscribers[1]?.error(new Error('fail 2'));
    subscribers[2]?.complete();
    expect(order).toEqual(['start 1', 'teardown 1', 'start 2', 'teardown 2', 'start 3', 'teardown 3', 'complete']);
  });

  test('synchronous errors during subscribe: each teardown runs when its subscribe returns', () => {
    const order: string[] = [];
    let attempt = 0;
    const observable = new Observable<number>((s) => {
      const n = ++attempt;
      order.push(`start ${String(n)}`);
      if (n < 3) s.error(new Error(`fail ${String(n)}`));
      else s.complete();
      return () => order.push(`teardown ${String(n)}`);
    });
    const subscribeOnce = () => {
      observable.subscribe({ error: subscribeOnce, complete: () => order.push('complete') });
    };
    subscribeOnce();
    expect(order).toEqual(['start 1', 'start 2', 'start 3', 'complete', 'teardown 3', 'teardown 2', 'teardown 1']);
  });
});

describe('one subscribe signature: positional and object observers', () => {
  test('positional callbacks, null and undefined holes', () => {
    const m = manual<number>();
    const seen: unknown[] = [];
    m.observable.subscribe(
      (v) => seen.push(['a', v]),
      (e: unknown) => seen.push(['a error', e]),
      () => seen.push('a complete'),
    );
    const a = m.s;
    m.observable.subscribe(null, (e: unknown) => seen.push(['b error', e]));
    const b = m.s;
    m.observable.subscribe(undefined, undefined, () => seen.push('c complete'));
    const c = m.s;
    m.observable.subscribe(null, null, null);
    const d = m.s;
    a.next(1);
    a.complete();
    b.next(2);
    b.error('e');
    c.next(3);
    c.complete();
    d.next(4);
    d.complete();
    expect(seen).toEqual([['a', 1], 'a complete', ['b error', 'e'], 'c complete']);
  });

  test('an observer object wins over positional arguments; methods are called with the observer as this', () => {
    class Collector {
      readonly values: number[] = [];
      done = false;
      next(v: number) {
        this.values.push(v);
      }
      complete() {
        this.done = true;
      }
    }
    const collector = new Collector();
    const m = manual<number>();
    const positional = vi.fn();
    (m.observable.subscribe as (...a: unknown[]) => Subscription)(collector, positional, positional);
    m.s.next(7);
    m.s.complete();
    expect(collector.values).toEqual([7]);
    expect(collector.done).toBe(true);
    expect(positional).not.toHaveBeenCalled();
  });

  test('next and error get one argument, complete none', () => {
    const m = manual<number>();
    const arity: string[] = [];
    m.observable.subscribe({
      next(...args: unknown[]) {
        arity.push(`next ${String(args.length)}`);
      },
      complete(...args: unknown[]) {
        arity.push(`complete ${String(args.length)}`);
      },
    });
    m.s.next(undefined as unknown as number);
    m.s.complete();
    m.observable.subscribe({
      error(...args: unknown[]) {
        arity.push(`error ${String(args.length)}`);
      },
    });
    m.s.error(undefined);
    expect(arity).toEqual(['next 1', 'complete 0', 'error 1']);
  });

  test('observer methods are read when they are called (like RxJS 7)', () => {
    const m = manual<number>();
    const observer: { next?: (v: number) => void } = {};
    m.observable.subscribe(observer);
    m.s.next(1);
    const seen: number[] = [];
    observer.next = (v) => seen.push(v);
    m.s.next(2);
    expect(seen).toEqual([2]);
  });

  test('a function passed as observer is the next callback, even if it has next/error properties', () => {
    const m = manual<number>();
    const seen: unknown[] = [];
    const fn = Object.assign((v: number) => seen.push(['fn', v]), { next: () => seen.push('prop') });
    m.observable.subscribe(fn);
    m.s.next(1);
    expect(seen).toEqual([['fn', 1]]);
  });

  test('a primitive passed from JavaScript is an observer without callbacks', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    (m.observable.subscribe as (o: unknown) => Subscription)(42);
    m.s.next(1);
    m.s.error('lost');
    expect(reports).toEqual([['lost', 'unhandled']]);
  });

  test('the returned Subscription has only closed and unsubscribe, and works detached', () => {
    const m = manual<number>();
    const subscription = m.observable.subscribe();
    expect(Object.keys(subscription).sort()).toEqual(['closed', 'unsubscribe']);
    expect(subscription).not.toBeInstanceOf(Subscriber);
    expect('next' in subscription).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point: it works detached
    const { unsubscribe } = subscription;
    unsubscribe();
    expect(subscription.closed).toBe(true);
    expect(m.state.teardowns).toBe(1);
  });
});

describe('an RxJS Subscriber given as the observer is linked to our subscription', () => {
  const noop = () => undefined;

  test('duck-typed like RxJS 7 isSubscriber (add, remove, unsubscribe, closed): add() receives the subscription', () => {
    const m = manual<number>();
    const added: unknown[] = [];
    const add = (teardown: unknown) => added.push(teardown);
    const rxLike = { closed: false, next: noop, add, remove: noop, unsubscribe: noop };
    const subscription = m.observable.subscribe(rxLike);
    expect(added).toEqual([subscription]);
    const inherited = Object.create({ closed: false, add, remove: noop, unsubscribe: noop }) as object;
    const second = m.observable.subscribe(inherited);
    expect(added).toEqual([subscription, second]);
  });

  test('look-alikes missing a member, and positional callbacks, are not linked', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    const add = vi.fn();
    for (const partial of [
      { add, remove: noop, unsubscribe: noop },
      { closed: false, add, unsubscribe: noop },
      { closed: false, add, remove: noop },
      { closed: false, add: 'add', remove: noop, unsubscribe: noop },
    ]) {
      m.observable.subscribe(partial as unknown as Partial<Observer<number>>);
    }
    const callable = Object.assign((v: number) => v, { closed: false, add, remove: noop, unsubscribe: noop });
    m.observable.subscribe(callable);
    expect(add).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  test('a throwing add (or getter) is reported; the subscription stands', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    const boom = new Error('add threw');
    const seen: number[] = [];
    const throwingAdd = {
      closed: false,
      next: (v: number) => seen.push(v),
      add() {
        throw boom;
      },
      remove: noop,
      unsubscribe: noop,
    };
    m.observable.subscribe({
      get add(): never {
        throw boom;
      },
    } as unknown as Partial<Observer<number>>);
    const subscription = m.observable.subscribe(throwingAdd);
    expect(reports).toEqual([
      [boom, 'unhandled'],
      [boom, 'unhandled'],
    ]);
    expect(subscription.closed).toBe(false);
    m.s.next(1);
    expect(seen).toEqual([1]);
  });
});

describe('throwing observers are reported and never rethrown', () => {
  test('next throws: reported as next, the subscription continues', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    const seen: number[] = [];
    const subscription = m.observable.subscribe({
      next: (v) => {
        seen.push(v);
        if (v === 1) throw new Error('bad next');
      },
    });
    expect(() => {
      m.s.next(1);
    }).not.toThrow();
    m.s.next(2);
    expect(seen).toEqual([1, 2]);
    expect(subscription.closed).toBe(false);
    expect(reports).toEqual([[new Error('bad next'), 'next']]);
  });

  test('error and complete callbacks that throw are reported with their kind', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    m.observable.subscribe({
      error: () => {
        throw new Error('bad error');
      },
    });
    m.s.error('e');
    m.observable.subscribe({
      complete: () => {
        throw new Error('bad complete');
      },
    });
    m.s.complete();
    expect(reports).toEqual([
      [new Error('bad error'), 'error'],
      [new Error('bad complete'), 'complete'],
    ]);
  });

  test('an error with no error callback is reported as unhandled', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    m.observable.subscribe({ next: () => undefined, error: undefined } as unknown as Partial<Observer<number>>);
    m.s.error('nobody listens');
    m.observable.subscribe((v) => v);
    m.s.error('positional without error');
    expect(reports).toEqual([
      ['nobody listens', 'unhandled'],
      ['positional without error', 'unhandled'],
    ]);
  });

  test('a throwing getter on the observer is reported like a throwing callback', () => {
    const { reporter, reports } = recorder();
    const m = manual<number>(reporter);
    const boom = new Error('getter');
    m.observable.subscribe({
      get next(): (v: number) => void {
        throw boom;
      },
      get error(): (e: unknown) => void {
        throw boom;
      },
    });
    m.s.next(1);
    m.s.error('e');
    expect(reports).toEqual([
      [boom, 'next'],
      [boom, 'error'],
    ]);
  });

  test('a reporter that throws is swallowed', () => {
    const m = manual<number>(() => {
      throw new Error('reporter broke');
    });
    m.observable.subscribe({
      next: () => {
        throw new Error('observer broke');
      },
    });
    expect(() => {
      m.s.next(1);
      m.s.error('unhandled');
    }).not.toThrow();
    expect(() => {
      report(
        () => {
          throw new Error('x');
        },
        'e',
        'unhandled',
      );
    }).not.toThrow();
  });

  test('default reporter: one console.error per report, synchronously, never via a timer', () => {
    vi.useFakeTimers();
    const m = manual<number>();
    const boom = new Error('boom');
    m.observable.subscribe({
      next: () => {
        throw boom;
      },
    });
    m.s.next(1);
    m.s.error('lost');
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError.mock.calls).toEqual([
      ['thruway.js: unhandled error in an observer next callback: Error: boom', boom],
      ['thruway.js: unhandled error in an Observable: lost', 'lost'],
    ]);
  });

  test('logReporter builds unhandled entries for a log function; defaultReporter uses the default logger', () => {
    const entries: LogEntry[] = [];
    const reporter = logReporter((entry) => entries.push(entry));
    reporter(new Error('x'), 'complete');
    reporter('y', 'unhandled');
    expect(entries.map((e) => [e.level, e.event, e.message])).toEqual([
      ['error', 'unhandled', 'unhandled error in an observer complete callback: Error: x'],
      ['error', 'unhandled', 'unhandled error in an Observable: y'],
    ]);
    expect(entries[0]?.data?.['error']).toEqual(new Error('x'));
    defaultReporter('z', 'error');
    expect(consoleError).toHaveBeenCalledWith('thruway.js: unhandled error in an observer error callback: z', 'z');
  });
});

describe('contracts', () => {
  test('a Subscriber is the OpSubscriber of core/contracts.ts; the class is the public Observable type', () => {
    expectTypeOf<Subscriber<number>>().toExtend<OpSubscriber<number>>();
    expectTypeOf<Subscriber<number>>().toExtend<BaseOp['subscriber']>();
    expectTypeOf<Observable<number>>().toExtend<PublicObservable<number>>();
    expectTypeOf<ReturnType<Observable<number>['subscribe']>>().toEqualTypeOf<Subscription>();
  });
});

describe('interop members', () => {
  test('Symbol.observable and @@observable return the Observable itself', () => {
    const observable = new Observable<number>(() => undefined);
    expect(typeof Symbol.observable).toBe('symbol');
    expect(symbolObservable).toBe(Symbol.observable);
    expect(observable[Symbol.observable]()).toBe(observable);
    expect(observable['@@observable']()).toBe(observable);
    expect(typeof observable[Symbol.asyncIterator]).toBe('function');
  });

  test('no pipe or lift (compose with your Rx library)', () => {
    const observable = new Observable<number>(() => undefined) as unknown as Record<string, unknown>;
    expect(observable['pipe']).toBeUndefined();
    expect(observable['lift']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Async iterator
// ---------------------------------------------------------------------------------------------------------------------

async function collect<T>(iterator: AsyncIterator<T, undefined>): Promise<unknown[]> {
  const out: unknown[] = [];
  for (;;) {
    try {
      const r = await iterator.next();
      if (r.done === true) return out;
      out.push(r.value);
    } catch (e) {
      out.push(['throw', e]);
    }
  }
}

describe('async iterator', () => {
  test('for await over a synchronous source', async () => {
    const source = new Observable<number>((s) => {
      s.next(1);
      s.next(2);
      s.next(3);
      s.complete();
      return undefined;
    });
    const seen: number[] = [];
    for await (const v of source) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
  });

  test('subscribes on the first next(), not when the iterator is created', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    expect(m.state.subscribes).toBe(0);
    const first = iterator.next();
    expect(m.state.subscribes).toBe(1);
    m.s.next(5);
    await expect(first).resolves.toEqual({ value: 5, done: false });
    void iterator.next();
    expect(m.state.subscribes).toBe(1);
  });

  test('concurrent next() calls settle in order; completion settles the rest with done', async () => {
    const m = manual<string>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const p = [iterator.next(), iterator.next(), iterator.next(), iterator.next()];
    m.s.next('a');
    m.s.next('b');
    m.s.complete();
    expect(await Promise.all(p)).toEqual([
      { value: 'a', done: false },
      { value: 'b', done: false },
      { value: undefined, done: true },
      { value: undefined, done: true },
    ]);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test('values that arrive while nobody waits are buffered in order', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const first = iterator.next();
    m.s.next(1);
    m.s.next(2);
    m.s.next(3);
    m.s.complete();
    await expect(first).resolves.toEqual({ value: 1, done: false });
    expect(await collect(iterator)).toEqual([2, 3]);
  });

  test('a source error is thrown after the buffered values, once, then done', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    void iterator.next();
    const boom = new Error('source failed');
    m.s.next(1);
    m.s.next(2);
    m.s.error(boom);
    expect(await collect(iterator)).toEqual([2, ['throw', boom]]);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test('a source error with waiters rejects the first and ends the others', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const a = iterator.next();
    const b = iterator.next();
    m.s.error('e');
    await expect(a).rejects.toBe('e');
    await expect(b).resolves.toEqual({ value: undefined, done: true });
  });

  test('return() unsubscribes once, drops the buffer and settles pending next() with done', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const first = iterator.next();
    m.s.next(1);
    m.s.next(2);
    const pending = iterator.next();
    const pending2 = iterator.next();
    await expect(first).resolves.toEqual({ value: 1, done: false });
    await expect(pending).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    await expect(pending2).resolves.toEqual({ value: undefined, done: true });
    expect(m.state.teardowns).toBe(1);
    m.s.next(3);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    await iterator.return?.();
    expect(m.state.teardowns).toBe(1);
  });

  test('return() drops the buffered values and a pending source error: next() is done afterwards', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const first = iterator.next();
    m.s.next(1);
    m.s.next(2);
    m.s.next(3);
    await expect(first).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(m.state.teardowns).toBe(1);

    const failing = manual<number>();
    const failingIterator = failing.observable[Symbol.asyncIterator]();
    void failingIterator.next();
    failing.s.next(1);
    failing.s.next(2);
    failing.s.error(new Error('lost'));
    await failingIterator.return?.();
    await expect(failingIterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test('return() before the first next() never subscribes', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    await iterator.return?.();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(m.state.subscribes).toBe(0);
  });

  test('break in for await calls return() and unsubscribes', async () => {
    const m = manual<number>();
    const seen: number[] = [];
    const loop = (async () => {
      for await (const v of m.observable) {
        seen.push(v);
        if (v === 2) break;
      }
    })();
    await Promise.resolve();
    m.s.next(1);
    m.s.next(2);
    m.s.next(3);
    await loop;
    expect(seen).toEqual([1, 2]);
    expect(m.state.teardowns).toBe(1);
    expect(m.s.closed).toBe(true);
  });

  test(`buffer cap: ${String(ITERATOR_BUFFER_LIMIT)} values are kept; one more unsubscribes and ends with RangeError`, async () => {
    expect(ITERATOR_BUFFER_LIMIT).toBe(1024);
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    const first = iterator.next();
    m.s.next(-1);
    await first;
    for (let i = 0; i < ITERATOR_BUFFER_LIMIT; i++) m.s.next(i);
    expect(m.state.teardowns).toBe(0);
    m.s.next(ITERATOR_BUFFER_LIMIT); // the overflow
    expect(m.state.teardowns).toBe(1);
    expect(m.s.closed).toBe(true);
    const out = await collect(iterator);
    expect(out.slice(0, ITERATOR_BUFFER_LIMIT)).toEqual(Array.from({ length: ITERATOR_BUFFER_LIMIT }, (_, i) => i));
    expect(out).toHaveLength(ITERATOR_BUFFER_LIMIT + 1);
    const [tag, error] = out[ITERATOR_BUFFER_LIMIT] as [string, unknown];
    expect(tag).toBe('throw');
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe('thruway.js: async iterator buffer overflow (more than 1024 values waiting)');
  });

  test('exactly the cap followed by completion is not an overflow; pulling in between frees room', async () => {
    const m = manual<number>();
    const iterator = m.observable[Symbol.asyncIterator]();
    void iterator.next().then(() => undefined);
    m.s.next(0); // taken by the waiter
    for (let i = 1; i <= ITERATOR_BUFFER_LIMIT; i++) m.s.next(i);
    await iterator.next(); // frees one slot
    m.s.next(ITERATOR_BUFFER_LIMIT + 1);
    m.s.complete();
    const out = await collect(iterator);
    expect(out).toHaveLength(ITERATOR_BUFFER_LIMIT);
    expect(out.every((v) => typeof v === 'number')).toBe(true);
    expect(m.state.teardowns).toBe(1);
  });

  test('an overflow during a synchronous subscribe releases the subscription when subscribe returns', async () => {
    let teardowns = 0;
    let emitted = 0;
    const source = new Observable<number>((s) => {
      for (let i = 0; i < 1500; i++) {
        emitted++;
        s.next(i);
      }
      return () => {
        teardowns++;
      };
    });
    const iterator = source[Symbol.asyncIterator]();
    const out = await collect(iterator);
    expect(emitted).toBe(1500);
    expect(teardowns).toBe(1);
    expect(out).toHaveLength(ITERATOR_BUFFER_LIMIT + 1);
    expect(out[0]).toBe(0);
    expect((out[ITERATOR_BUFFER_LIMIT] as [string, unknown])[1]).toBeInstanceOf(RangeError);
  });

  test('after an overflow during subscribe, a later completion or error does not replace the RangeError', async () => {
    for (const end of ['complete', 'error'] as const) {
      const source = new Observable<number>((s) => {
        for (let i = 0; i <= ITERATOR_BUFFER_LIMIT; i++) s.next(i);
        if (end === 'complete') s.complete();
        else s.error(new Error('source error'));
        return undefined;
      });
      const out = await collect(source[Symbol.asyncIterator]());
      expect(out).toHaveLength(ITERATOR_BUFFER_LIMIT + 1);
      expect((out[ITERATOR_BUFFER_LIMIT] as [string, unknown])[1]).toBeInstanceOf(RangeError);
    }
  });

  test('each iterator has its own subscription and buffer', async () => {
    const source = new Observable<number>((s) => {
      s.next(1);
      s.complete();
      return undefined;
    });
    const a = source[Symbol.asyncIterator]();
    const b = source[Symbol.asyncIterator]();
    expect(a).not.toBe(b);
    expect(await collect(a)).toEqual([1]);
    expect(await collect(b)).toEqual([1]);
  });
});
