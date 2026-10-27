/**
 * `Observable` + `Subscriber`: grammar `next* (error|complete)?`, teardown exactly once, idempotent unsubscribe,
 * synchronous emission allowed, one `subscribe` signature, interop keys, bounded async iterator, unhandled errors
 * routed to the owning client's reporter.
 *
 * Isolation: an observer callback that throws (or whose getter throws), an
 * error with no error callback, a teardown that throws and a subscribe function that throws after its subscriber
 * closed are all handed to the reporter; nothing is ever rethrown into the producer, the consumer or a timer.
 *
 * @module
 */
import { defaultLogger, unhandledEntry } from '../logger.js';
import type { LogEntry, Observable as PublicObservable, Observer, Subscription, Unsubscribable } from '../types.js';
import { symbolObservable } from './symbol-observable.js';

/** Per-iterator buffer limit of `[Symbol.asyncIterator]()` (overflow: RangeError + unsubscribe). */
export const ITERATOR_BUFFER_LIMIT = 1024;

/** What a subscribe function may return: a teardown function, a subscription-like object, or nothing. */
export type TeardownLogic = (() => void) | Unsubscribable | undefined;

/**
 * Receives what no observer can take: an observer callback that threw (`kind` 'next' | 'error' | 'complete') or an
 * error delivered to a subscription without an error callback (`kind` 'unhandled'; also a throwing teardown). The
 * client wires this to its `safeLog` (`{level: 'error', event: 'unhandled'}`); it must never throw (a throw is
 * swallowed here anyway).
 */
export type UnhandledReporter = (error: unknown, kind: 'next' | 'error' | 'complete' | 'unhandled') => void;

/** A reporter that turns each report into an `unhandled` entry for `log` (the client passes its `safeLog`). */
export function logReporter(log: (entry: LogEntry) => void): UnhandledReporter {
  return (error, kind) => {
    log(unhandledEntry(error, kind === 'unhandled' ? 'an Observable' : `an observer ${kind} callback`));
  };
}

/** Used when an Observable is created without a reporter: prints like the client's default logger (console.error). */
export const defaultReporter: UnhandledReporter = logReporter(defaultLogger);

/** Call the reporter; a reporter that throws is ignored (never rethrown). */
export function report(reporter: UnhandledReporter, error: unknown, kind: Parameters<UnhandledReporter>[1]): void {
  try {
    reporter(error, kind);
  } catch {
    // the reporter contract says it never throws; if it does, there is nowhere left to send it
  }
}

/** The observer as given: methods are read when called (like RxJS 7), so a missing or throwing one is handled then. */
interface ObserverLike {
  readonly next?: unknown;
  readonly error?: unknown;
  readonly complete?: unknown;
}

function runTeardown(teardown: unknown, reporter: UnhandledReporter): void {
  try {
    if (typeof teardown === 'function') {
      (teardown as () => void)();
    } else if (typeof teardown === 'object' && teardown !== null) {
      const unsubscribe = (teardown as { readonly unsubscribe?: unknown }).unsubscribe;
      if (typeof unsubscribe === 'function') (unsubscribe as (this: unknown) => void).call(teardown);
    }
  } catch (error) {
    report(reporter, error, 'unhandled');
  }
}

/**
 * An RxJS 5–7 `Subscriber` given as the observer — `firstValueFrom(ours)` or `lastValueFrom(ours)` without `from()`
 * drop the returned Subscription — gets ours added to it, as RxJS's own Observable does, so its unsubscribe (after
 * the first value, say) releases ours. Duck-typed like RxJS 7's `isSubscriber`: `add`, `remove` and `unsubscribe`
 * functions and a `closed` member. A throw there is reported; the subscription stands.
 */
function linkRxSubscriber(observer: ObserverLike, subscription: Subscription, reporter: UnhandledReporter): void {
  try {
    const rx = observer as { readonly add?: unknown; readonly remove?: unknown; readonly unsubscribe?: unknown };
    const add = rx.add;
    if (typeof add === 'function' && typeof rx.remove === 'function' && typeof rx.unsubscribe === 'function') {
      if ('closed' in rx) (add as (this: unknown, teardown: Subscription) => void).call(observer, subscription);
    }
  } catch (error) {
    report(reporter, error, 'unhandled');
  }
}

/**
 * The producer side handed to a subscribe function. After `error`/`complete` or unsubscribe, every call is a no-op
 * and `closed` is true. Structurally it is the `OpSubscriber<T>` of core/contracts.ts.
 *
 * A terminal notification first closes the subscriber and runs the teardown, then calls the observer (like the
 * platform Observable): inside an `error`/`complete` callback `closed` is already true, and an operator that
 * re-subscribes there (retry, repeat) starts after the old subscription was released.
 */
export class Subscriber<T> {
  private observer: ObserverLike | undefined;
  private teardown: unknown = undefined;
  private readonly reporter: UnhandledReporter;

  /** Internal: created by `Observable.subscribe`. */
  constructor(observer: ObserverLike, reporter: UnhandledReporter) {
    this.observer = observer;
    this.reporter = reporter;
  }

  get closed(): boolean {
    return this.observer === undefined;
  }

  next(value: T): void {
    const observer = this.observer;
    if (observer !== undefined) this.call(observer, 'next', value);
  }

  error(error: unknown): void {
    const observer = this.close();
    if (observer !== undefined && !this.call(observer, 'error', error)) report(this.reporter, error, 'unhandled');
  }

  complete(): void {
    const observer = this.close();
    if (observer !== undefined) this.call(observer, 'complete', undefined);
  }

  /** Internal: the consumer's unsubscribe (the app sees only `Subscription`). Idempotent. */
  unsubscribe(): void {
    this.close();
  }

  /** Internal: the subscribe function's return value; run at once when the subscriber closed during subscribe. */
  setTeardown(teardown: unknown): void {
    if (this.observer === undefined) runTeardown(teardown, this.reporter);
    else this.teardown = teardown;
  }

  /** Close and run the teardown (once: it is cleared); returns the observer it had, undefined if closed already. */
  private close(): ObserverLike | undefined {
    const observer = this.observer;
    this.observer = undefined;
    const teardown = this.teardown;
    this.teardown = undefined;
    runTeardown(teardown, this.reporter);
    return observer;
  }

  /** Call `observer[kind]` as a method; false when it is not a function. A throw (also from a getter) is reported. */
  private call(observer: ObserverLike, kind: 'next' | 'error' | 'complete', arg: unknown): boolean {
    try {
      const callback = observer[kind];
      if (typeof callback !== 'function') return false;
      if (kind === 'complete') (callback as (this: unknown) => void).call(observer);
      else (callback as (this: unknown, arg: unknown) => void).call(observer, arg);
    } catch (error) {
      report(this.reporter, error, kind);
    }
    return true;
  }
}

/**
 * The client's cold Observable. The constructor is internal (the public surface exports only the *type*
 * `Observable`).
 */
export class Observable<T> implements PublicObservable<T> {
  private readonly subscribeFn: (subscriber: Subscriber<T>) => TeardownLogic;
  private readonly reporter: UnhandledReporter;

  /**
   * Internal (only the `Observable` *type* is public; this module is not reachable from the package entries).
   * @param subscribeFn called once per subscription with a fresh Subscriber; its return value is the teardown.
   *                    A throw is delivered as the subscription's error (reported if it had closed already).
   * @param reporter where observer exceptions and unhandled errors go (the owning client's logger).
   */
  constructor(
    subscribeFn: (subscriber: Subscriber<T>) => TeardownLogic,
    reporter: UnhandledReporter = defaultReporter,
  ) {
    this.subscribeFn = subscribeFn;
    this.reporter = reporter;
  }

  subscribe(
    observerOrNext?: Partial<Observer<T>> | ((value: T) => void) | null,
    error?: ((error: any) => void) | null,
    complete?: (() => void) | null,
  ): Subscription {
    const observer: ObserverLike =
      typeof observerOrNext === 'object' && observerOrNext !== null
        ? observerOrNext
        : { next: observerOrNext, error, complete };
    const subscriber = new Subscriber<T>(observer, this.reporter);
    const subscribeFn = this.subscribeFn;
    try {
      subscriber.setTeardown(subscribeFn(subscriber));
    } catch (thrown) {
      if (subscriber.closed) report(this.reporter, thrown, 'unhandled');
      else subscriber.error(thrown);
    }
    // A separate object, so the app cannot call next/error on the producer side; works detached (`const {unsubscribe}`).
    const subscription: Subscription = {
      get closed() {
        return subscriber.closed;
      },
      unsubscribe() {
        subscriber.unsubscribe();
      },
    };
    linkRxSubscriber(observer, subscription, this.reporter); // positional callbacks never look like one
    return subscription;
  }

  [symbolObservable](): this {
    return this;
  }

  // A computed key (same member): StrykerJS cannot place mutants in a string-literal method name.
  ['@@observable'](): this {
    return this;
  }

  /** Subscribes on the first `next()`; buffers up to {@link ITERATOR_BUFFER_LIMIT} values. */
  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return new ObservableIterator(this);
  }
}

interface Waiter<T> {
  resolve(result: IteratorResult<T, undefined>): void;
  reject(error: unknown): void;
}

function done<T>(): IteratorResult<T, undefined> {
  return { value: undefined, done: true };
}

/**
 * The async iterator of one Observable (RxJS 9 / platform `Observable.from(ours)`, `for await`). Values that arrive
 * while nobody waits are buffered; a source error is thrown after the values buffered before it (like RxJS 9's
 * iterators). More than {@link ITERATOR_BUFFER_LIMIT} buffered values end the iteration the same way: the source is
 * unsubscribed at once, the buffered values are still yielded, then `next()` rejects with a `RangeError`.
 * `return()` unsubscribes, drops the buffer and settles every pending `next()` with `done`.
 */
class ObservableIterator<T> implements AsyncIterator<T, undefined> {
  private readonly source: Observable<T>;
  private subscription: Subscription | undefined = undefined;
  private started = false;
  /** No more values are accepted: the source ended, the buffer overflowed, or return() was called. */
  private ended = false;
  /** Thrown by the next `next()` once the buffer is drained. */
  private failure: { readonly error: unknown } | undefined = undefined;
  private readonly values: T[] = [];
  private readonly waiters: Waiter<T>[] = [];

  constructor(source: Observable<T>) {
    this.source = source;
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (!this.started) this.start();
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }

  return(): Promise<IteratorResult<T, undefined>> {
    this.started = true;
    this.ended = true;
    this.values.length = 0;
    this.failure = undefined;
    this.unsubscribe();
    this.drain();
    return Promise.resolve(done<T>());
  }

  private start(): void {
    this.started = true;
    const subscription = this.source.subscribe({
      next: (value) => {
        this.push(value);
      },
      error: (error: unknown) => {
        this.end({ error });
      },
      complete: () => {
        this.end(undefined);
      },
    });
    // Ended during subscribe (synchronous completion or overflow): release it now, there was no handle before.
    if (this.ended) subscription.unsubscribe();
    else this.subscription = subscription;
  }

  /** A value from the source. After an overflow during a synchronous subscribe more may come: they land in the
   *  `else` branch again, whose unsubscribe and end are then no-ops. */
  private push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
    } else if (this.values.length < ITERATOR_BUFFER_LIMIT) {
      this.values.push(value);
    } else {
      this.unsubscribe();
      this.end({
        error: new RangeError(
          `thruway.js: async iterator buffer overflow (more than ${String(ITERATOR_BUFFER_LIMIT)} values waiting)`,
        ),
      });
    }
  }

  private end(failure: { readonly error: unknown } | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = failure;
    this.subscription = undefined;
    this.drain();
  }

  private unsubscribe(): void {
    const subscription = this.subscription;
    this.subscription = undefined;
    subscription?.unsubscribe();
  }

  /** Settle waiters in order: buffered values first, then the failure (once), then `done`. */
  private drain(): void {
    for (;;) {
      const waiter = this.waiters[0];
      if (waiter === undefined) return;
      if (this.values.length > 0) {
        this.waiters.shift();
        waiter.resolve({ value: this.values.shift() as T, done: false });
      } else if (!this.ended) {
        return;
      } else {
        this.waiters.shift();
        const failure = this.failure;
        this.failure = undefined;
        if (failure === undefined) waiter.resolve(done<T>());
        else waiter.reject(failure.error);
      }
    }
  }
}
