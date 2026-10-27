/**
 * Lifecycle subjects: observers are snapshotted when a value is emitted; an observer added later gets only the replay
 * of the then-current value (synchronously, inside its own subscribe); one removed before its delivery gets nothing.
 * They never error or complete. Emission happens inside a step, so `emit` takes the delivery queue (`deliver`) instead
 * of calling observers.
 *
 * Every observer therefore sees each lifecycle event exactly once, in order: an observer is in the snapshot of
 * every emit after its subscribe began (it is registered before its replay runs, so an emit caused by its own replay
 * callback reaches it too), and the replay covers exactly the value current when it subscribed.
 *
 * @module
 */
import { Observable, type Subscriber, type UnhandledReporter } from './observable.js';

/** The observer set shared by both subjects. */
class Fanout<T> {
  readonly observable: Observable<T>;
  private readonly subscribers = new Set<Subscriber<T>>();

  constructor(replay: (subscriber: Subscriber<T>) => void, reporter: UnhandledReporter | undefined) {
    this.observable = new Observable<T>((subscriber) => {
      this.subscribers.add(subscriber);
      replay(subscriber);
      return () => {
        this.subscribers.delete(subscriber);
      };
    }, reporter);
  }

  emit(value: T, deliver: (fn: () => void) => void): void {
    if (this.subscribers.size === 0) return;
    const snapshot = Array.from(this.subscribers);
    deliver(() => {
      // An observer that unsubscribed since the emit is closed: next() is a no-op for it. next() never throws.
      for (const subscriber of snapshot) subscriber.next(value);
    });
  }
}

/** Replays the current value to every new subscriber (`status`, `onOpen`). */
export class LatestSubject<T> {
  private current: { readonly value: T } | undefined;
  private readonly fanout: Fanout<T>;

  /** @param initial the current value; `hasValue: false` (onOpen while not open) replays nothing. */
  constructor(
    initial: { readonly hasValue: true; readonly value: T } | { readonly hasValue: false },
    reporter?: UnhandledReporter,
  ) {
    this.current = initial.hasValue ? { value: initial.value } : undefined;
    this.fanout = new Fanout<T>((subscriber) => {
      const current = this.current;
      if (current !== undefined) subscriber.next(current.value);
    }, reporter);
  }

  /** The same Observable instance on every access. */
  get observable(): Observable<T> {
    return this.fanout.observable;
  }

  /** Set the current value and queue its delivery to a snapshot of the current observers. */
  emit(value: T, deliver: (fn: () => void) => void): void {
    this.current = { value };
    this.fanout.emit(value, deliver);
  }

  /** Forget the current value without emitting (onOpen after a session ended: nothing is replayed). */
  clear(): void {
    this.current = undefined;
  }
}

/** No replay (`onClose`). */
export class EventSubject<T> {
  private readonly fanout: Fanout<T>;

  constructor(reporter?: UnhandledReporter) {
    this.fanout = new Fanout<T>(() => undefined, reporter);
  }

  get observable(): Observable<T> {
    return this.fanout.observable;
  }

  emit(value: T, deliver: (fn: () => void) => void): void {
    this.fanout.emit(value, deliver);
  }
}
