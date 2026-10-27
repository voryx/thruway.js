/**
 * `Input<T>` → Observable conversion: interop key (`Symbol.observable`, `'@@observable'`) → subscribe; thenable → one
 * value; any other object with a `subscribe` function (RxJS 9, the platform Observable) →
 * `subscribe(observer, {signal})`, cancelled by `abort()` + `ret?.unsubscribe?.()`; an async iterable
 * (`Symbol.asyncIterator`: an `async function*`, a Node stream) → one value per `next()`, cancelled by `return()`; else
 * `of(value)`. Getter/`then`/`subscribe`/iterator throws become errors of the conversion, never throws out of it.
 *
 * The input is classified at every subscribe (cold: a getter is read again by a re-subscription), never before. A
 * thenable is adopted with `Promise.resolve` (so a thenable resolving to a thenable yields the inner value, and a
 * thenable that calls back twice counts once); its value always arrives asynchronously, and so does every value of an
 * async iterable.
 *
 * @module
 */
import type { Input, Subscription } from '../types.js';
import { createAbort } from './abort.js';
import {
  defaultReporter,
  Observable,
  report,
  type Subscriber,
  type TeardownLogic,
  type UnhandledReporter,
} from './observable.js';
import { symbolObservable } from './symbol-observable.js';

type Props = Readonly<Record<PropertyKey, unknown>>;

/** The observer handed to a foreign Observable: plain closures, so detached calls work too. */
interface ForwardObserver<T> {
  next(value: T): void;
  error(error: unknown): void;
  complete(): void;
}

/**
 * Call a foreign `subscribe` (`call`) with an observer forwarding to `subscriber`; returns what it returned.
 * RxJS 5 delivers an error thrown by its subscribe function to the observer and then rethrows it from `subscribe()`:
 * that throw is the error already delivered, so it is dropped instead of being reported as unhandled. Any other throw
 * propagates (an error of the conversion, or an `unhandled` report once the subscriber has closed).
 */
function subscribeForeign<T>(subscriber: Subscriber<T>, call: (observer: ForwardObserver<T>) => unknown): unknown {
  let delivered: { readonly error: unknown } | undefined;
  const observer: ForwardObserver<T> = {
    next: (value: T) => {
      subscriber.next(value);
    },
    error: (error: unknown) => {
      if (!subscriber.closed) delivered = { error }; // the error that reaches the subscriber (the first one)
      subscriber.error(error);
    },
    complete: () => {
      subscriber.complete();
    },
  };
  try {
    return call(observer);
  } catch (thrown) {
    if (delivered !== undefined && Object.is(thrown, delivered.error)) return undefined;
    throw thrown;
  }
}

/** `ret.unsubscribe()` when `ret` has one (read when called). */
function unsubscribeResult(ret: unknown): void {
  const unsubscribe = (ret as Props | null | undefined)?.['unsubscribe'];
  if (typeof unsubscribe === 'function') (unsubscribe as (this: unknown) => void).call(ret);
}

function interopMethod(source: Props): ((this: unknown) => unknown) | undefined {
  const primary = source[symbolObservable];
  if (typeof primary === 'function') return primary as (this: unknown) => unknown;
  const fallback = source['@@observable'];
  return typeof fallback === 'function' ? (fallback as (this: unknown) => unknown) : undefined;
}

function subscribeInterop<T>(observable: unknown, subscriber: Subscriber<T>): TeardownLogic {
  const subscribe = (observable as Props | null | undefined)?.['subscribe'];
  if (typeof subscribe !== 'function') {
    throw new TypeError('thruway.js: the Symbol.observable method did not return an object with subscribe()');
  }
  const ret = subscribeForeign(subscriber, (observer) =>
    (subscribe as (this: unknown, observer: unknown) => unknown).call(observable, observer),
  );
  return () => {
    unsubscribeResult(ret);
  };
}

function subscribeWithSignal<T>(
  source: Props,
  subscribe: (this: unknown, observer: unknown, options: unknown) => unknown,
  subscriber: Subscriber<T>,
  reporter: UnhandledReporter | undefined,
): TeardownLogic {
  const abort = createAbort(reporter);
  const ret = subscribeForeign(subscriber, (observer) => subscribe.call(source, observer, { signal: abort.signal }));
  return () => {
    abort.abort(undefined); // never throws
    unsubscribeResult(ret); // a throw is reported by the teardown runner
  };
}

function isObjectLike(value: unknown): value is Props {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** `value` adopted by a fresh Promise. Never `Promise.resolve(value).then(…)`: for a Promise that is returned as is,
 *  and an own `then` on it would run in our stack, where it can throw (in a reaction: an unhandled rejection and a
 *  stream that never ends) or call back twice. A fresh Promise settles once, and its `then` is the platform's. */
function adopt(value: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    resolve(value);
  });
}

/**
 * An async iterable, iterated the way `for await` does: `next` is read once, at the start; one emission per `next()`
 * result, completion at `done` (its value is dropped), an error when `Symbol.asyncIterator` or `next()` throws,
 * `next()` rejects, or a result is not an object. Unsubscribing before the end calls `return()` once (as `break` does), never after the iterator finished or
 * failed; its rejection goes to `reporter` and a synchronous throw to the teardown runner (which reports it too). The
 * iterator's promises all get a rejection handler, and the handlers never throw: nothing becomes an unhandled
 * rejection.
 */
function subscribeAsyncIterable<T>(
  source: Props,
  iterate: (this: unknown) => unknown,
  subscriber: Subscriber<T>,
  reporter: UnhandledReporter,
): TeardownLogic {
  const iterator = iterate.call(source);
  if (!isObjectLike(iterator)) {
    throw new TypeError('thruway.js: the Symbol.asyncIterator method did not return an object');
  }
  const next = iterator['next']; // read once, like the iterator record of for await
  if (typeof next !== 'function') throw new TypeError('thruway.js: an async iterator has no next() method');
  /** Done, failed or returned: the iterator is not touched again. */
  let finished = false;
  const fail = (error: unknown): void => {
    finished = true;
    subscriber.error(error);
  };
  const step = (result: unknown): void => {
    if (finished) return; // returned (unsubscribed) while this next() was pending: the result is not read
    let done: boolean;
    let value: unknown;
    try {
      if (!isObjectLike(result)) throw new TypeError("thruway.js: an async iterator's next() gave a non-object");
      done = Boolean(result['done']);
      value = done ? undefined : result['value'];
    } catch (error) {
      fail(error);
      return;
    }
    if (done) {
      finished = true;
      subscriber.complete();
      return;
    }
    subscriber.next(value as T);
    if (!subscriber.closed) pull(); // the observer may have unsubscribed (its teardown called return())
  };
  const pull = (): void => {
    let result: unknown;
    try {
      result = (next as (this: unknown) => unknown).call(iterator);
    } catch (error) {
      fail(error);
      return;
    }
    adopt(result).then(step, fail); // after return() the subscriber is closed: a late rejection changes nothing
  };
  pull();
  return () => {
    if (finished) return;
    finished = true;
    const close = iterator['return'];
    if (typeof close !== 'function') return;
    adopt((close as (this: unknown) => unknown).call(iterator)).then(undefined, (error: unknown) => {
      report(reporter, error, 'unhandled');
    });
  };
}

/** How a single value (a thenable's resolution, a plain value) reaches the subscriber. */
type Single<T> = (subscriber: Subscriber<T>, value: T) => void;

function nextThenComplete<T>(subscriber: Subscriber<T>, value: T): void {
  subscriber.next(value);
  subscriber.complete();
}

/** The runtime rule: interop key → thenable → any object with a subscribe function → async iterable → plain
 *  value. */
function connect<T>(
  input: unknown,
  subscriber: Subscriber<T>,
  single: Single<T>,
  reporter: UnhandledReporter | undefined,
): TeardownLogic {
  if (isObjectLike(input)) {
    const source = input;
    const interop = interopMethod(source);
    if (interop !== undefined) return subscribeInterop(interop.call(source), subscriber);
    if (typeof source['then'] === 'function') {
      Promise.resolve(source as unknown as PromiseLike<T>).then(
        (value) => {
          single(subscriber, value);
        },
        (error: unknown) => {
          subscriber.error(error);
        },
      );
      return undefined;
    }
    const subscribe = source['subscribe'];
    if (typeof subscribe === 'function') {
      return subscribeWithSignal(source, subscribe as (o: unknown, opts: unknown) => unknown, subscriber, reporter);
    }
    const iterate = source[Symbol.asyncIterator];
    if (typeof iterate === 'function') {
      return subscribeAsyncIterable(
        source,
        iterate as (this: unknown) => unknown,
        subscriber,
        reporter ?? defaultReporter,
      );
    }
  }
  single(subscriber, input as T);
  return undefined;
}

/**
 * Convert any app-supplied value to our Observable (lazy: nothing is read until subscribe). A thenable or a plain
 * value becomes one `next` followed by `complete`.
 * @param reporter where the conversion's own unhandled errors go (a throwing `unsubscribe` of the app's Observable,
 *                 an abort listener); the client passes its own.
 */
export function toObservable<T>(input: Input<T>, reporter?: UnhandledReporter): Observable<T> {
  return new Observable<T>((subscriber) => connect(input, subscriber, nextThenComplete, reporter), reporter);
}

/** What {@link subscribeInput} reports: `next` (any number) then `complete` for an Observable or async iterable input,
 *  `value` for the single result of a thenable or a plain value (terminal: nothing follows it), `error` for any
 *  failure, a conversion throw included. */
export interface InputObserver<T> {
  next(value: T): void;
  value(value: T): void;
  error(error: unknown): void;
  complete(): void;
}

/**
 * Subscribe to `input` like `toObservable(input).subscribe(…)`, but keep a single value apart from an Observable's
 * values: a callee needs the difference (an Observable's values are progressive results and its completion the
 * empty final YIELD; a Promise's or plain value is the final YIELD itself). An async iterable (`async function*`) is a
 * stream like an Observable. Never throws; the observer's own throws go to `reporter`.
 */
export function subscribeInput<T>(
  input: Input<T>,
  observer: InputObserver<T>,
  reporter: UnhandledReporter = defaultReporter,
): Subscription {
  let single = false;
  const markSingle: Single<T> = (subscriber, value) => {
    single = true;
    nextThenComplete(subscriber, value);
  };
  return new Observable<T>((subscriber) => connect(input, subscriber, markSingle, reporter), reporter).subscribe({
    next: (value) => {
      if (single) observer.value(value);
      else observer.next(value);
    },
    error: (error: unknown) => {
      observer.error(error);
    },
    complete: () => {
      if (!single) observer.complete();
    },
  });
}

/**
 * Take the first value of `input` (converted like `toObservable`; one of our Observables passes through): exactly one
 * of `onValue`, `onError`, `onEmpty` is called (or none after cancel). Returns `cancel()`, which unsubscribes the
 * source (idempotent). Used by the URL resolver and the challenge runner.
 *
 * The source is unsubscribed before the callback runs (a token-refresh Observable stops at its first value), also
 * for a source that answers synchronously inside subscribe: that callback runs right after subscribe returned. A
 * callback that throws is reported, never rethrown.
 */
export function firstValue<T>(
  input: Input<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  onEmpty: () => void,
  reporter: UnhandledReporter = defaultReporter,
): () => void {
  type Kind = 'next' | 'error' | 'complete';
  let settled = false;
  let subscribing = true;
  let deferred: { readonly kind: Kind; readonly callback: () => void } | undefined;
  const settle = (kind: Kind, callback: () => void): void => {
    if (settled) return;
    settled = true;
    if (subscribing) {
      deferred = { kind, callback };
    } else {
      source.unsubscribe();
      callback(); // inside the subscriber's callback: a throw is reported as `kind` there
    }
  };
  const source = toObservable(input, reporter).subscribe({
    next: (value) => {
      settle('next', () => {
        onValue(value);
      });
    },
    error: (error: unknown) => {
      settle('error', () => {
        onError(error);
      });
    },
    complete: () => {
      settle('complete', onEmpty);
    },
  });
  subscribing = false;
  if (deferred !== undefined) {
    source.unsubscribe();
    try {
      deferred.callback();
    } catch (error) {
      report(reporter, error, deferred.kind);
    }
  }
  // After unsubscribe the source cannot call back, so cancel needs no flag of its own.
  return () => {
    source.unsubscribe();
  };
}
