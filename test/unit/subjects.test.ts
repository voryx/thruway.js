// Lifecycle subjects: snapshot-at-emit delivery through the delivery queue, LatestSubject replay of the then-current
// value inside subscribe, EventSubject without replay, never error/complete, observers removed on unsubscribe, and a
// model-based property: every observer sees each event exactly once, in order.
import fc from 'fast-check';
import { firstValueFrom, from, take } from 'rxjs';
import { describe, expect, test } from 'vitest';
import type { UnhandledReporter } from '../../src/observable/observable.js';
import { EventSubject, LatestSubject } from '../../src/observable/subjects.js';
import type { Subscription } from '../../src/types.js';
import { replayParameters } from '../setup-fast-check.js';

/** The core's delivery queue, driven by hand (FIFO, one at a time). */
function queue() {
  const pending: (() => void)[] = [];
  return {
    pending,
    deliver: (fn: () => void) => {
      pending.push(fn);
    },
    flushOne: () => {
      pending.shift()?.();
    },
    flush: () => {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

function watcher(observable: { subscribe(o: object): Subscription }) {
  const seen: unknown[] = [];
  const subscription = observable.subscribe({
    next: (v: unknown) => seen.push(v),
    error: (e: unknown) => seen.push(['error', e]),
    complete: () => seen.push('complete'),
  });
  return { seen, subscription };
}

describe('LatestSubject', () => {
  test('replays the initial value synchronously inside subscribe', () => {
    const subject = new LatestSubject<string>({ hasValue: true, value: 'connecting' });
    const order: string[] = [];
    subject.observable.subscribe((v) => order.push(v));
    order.push('returned');
    expect(order).toEqual(['connecting', 'returned']);
  });

  test('hasValue false replays nothing until the first emit', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: false });
    const early = watcher(subject.observable);
    expect(early.seen).toEqual([]);
    subject.emit(1, q.deliver);
    expect(early.seen).toEqual([]); // queued, not delivered inside the step
    q.flush();
    expect(early.seen).toEqual([1]);
    expect(watcher(subject.observable).seen).toEqual([1]);
  });

  test('a late subscriber gets only the latest value', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: true, value: 0 });
    subject.emit(1, q.deliver);
    subject.emit(2, q.deliver);
    q.flush();
    expect(watcher(subject.observable).seen).toEqual([2]);
  });

  test('snapshot at emit: one added before the delivery gets only the replay; each value once', () => {
    const q = queue();
    const subject = new LatestSubject<string>({ hasValue: true, value: 'a' });
    const first = watcher(subject.observable);
    subject.emit('b', q.deliver);
    const second = watcher(subject.observable); // after the emit, before its delivery
    expect(second.seen).toEqual(['b']);
    subject.emit('c', q.deliver);
    q.flush();
    expect(first.seen).toEqual(['a', 'b', 'c']);
    expect(second.seen).toEqual(['b', 'c']);
  });

  test('an observer removed before its delivery gets nothing; one removed during the delivery too', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: false });
    const seen: string[] = [];
    const holder: { b?: Subscription } = {};
    subject.observable.subscribe((v) => {
      seen.push(`a${String(v)}`);
      holder.b?.unsubscribe();
    });
    holder.b = subject.observable.subscribe((v) => seen.push(`b${String(v)}`));
    const c = subject.observable.subscribe((v) => seen.push(`c${String(v)}`));
    subject.emit(1, q.deliver);
    c.unsubscribe();
    q.flush();
    expect(seen).toEqual(['a1']);
  });

  test('emit queues one delivery, and none without observers', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: false });
    subject.emit(1, q.deliver);
    expect(q.pending).toHaveLength(0);
    const a = watcher(subject.observable);
    watcher(subject.observable);
    subject.emit(2, q.deliver);
    expect(q.pending).toHaveLength(1);
    a.subscription.unsubscribe();
    q.flush();
    expect(a.seen).toEqual([1]);
  });

  test('clear() forgets the value without emitting; queued deliveries still arrive', () => {
    const q = queue();
    const subject = new LatestSubject<string>({ hasValue: true, value: 'open' });
    const a = watcher(subject.observable);
    subject.emit('open again', q.deliver);
    subject.clear();
    expect(q.pending).toHaveLength(1);
    expect(watcher(subject.observable).seen).toEqual([]);
    q.flush();
    expect(a.seen).toEqual(['open', 'open again']);
    subject.emit('next session', q.deliver);
    q.flush();
    expect(watcher(subject.observable).seen).toEqual(['next session']);
  });

  test('an emit caused by an observer’s own replay callback reaches it (registered before the replay)', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: true, value: 1 });
    const seen: number[] = [];
    subject.observable.subscribe((v) => {
      seen.push(v);
      if (v === 1) {
        subject.emit(2, q.deliver);
        q.flush(); // the app's call ran a step and its deliveries before returning
      }
    });
    expect(seen).toEqual([1, 2]);
  });

  test('an Rx consumer that stops at the replay (take(1)) is removed when subscribe returns', async () => {
    const q = queue();
    const subject = new LatestSubject<string>({ hasValue: true, value: 'open' });
    await expect(firstValueFrom(from(subject.observable))).resolves.toBe('open');
    await expect(firstValueFrom(from(subject.observable).pipe(take(1)))).resolves.toBe('open');
    subject.emit('later', q.deliver);
    expect(q.pending).toHaveLength(0);
  });

  test('unsubscribing from a callback removes the observer', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: true, value: 1 });
    const seen: number[] = [];
    const holder: { subscription?: Subscription } = {};
    holder.subscription = subject.observable.subscribe((v) => {
      seen.push(v);
      if (v === 2) holder.subscription?.unsubscribe();
    });
    subject.emit(2, q.deliver);
    q.flush();
    subject.emit(3, q.deliver);
    expect(q.pending).toHaveLength(0);
    expect(seen).toEqual([1, 2]);
    expect(holder.subscription.closed).toBe(true);
  });

  test('the same Observable instance on every access; observers are released on unsubscribe', () => {
    const q = queue();
    const subject = new LatestSubject<number>({ hasValue: false });
    expect(subject.observable).toBe(subject.observable);
    const subscriptions = Array.from({ length: 5 }, () => subject.observable.subscribe(() => undefined));
    for (const s of subscriptions) s.unsubscribe();
    subject.emit(1, q.deliver);
    expect(q.pending).toHaveLength(0);
  });

  test('a throwing observer is reported and the others still get the value', () => {
    const q = queue();
    const reports: unknown[] = [];
    const reporter: UnhandledReporter = (e, kind) => reports.push([e, kind]);
    const subject = new LatestSubject<number>({ hasValue: false }, reporter);
    subject.observable.subscribe(() => {
      throw new Error('bad observer');
    });
    const ok = watcher(subject.observable);
    subject.emit(1, q.deliver);
    expect(() => {
      q.flush();
    }).not.toThrow();
    expect(ok.seen).toEqual([1]);
    expect(reports).toEqual([[new Error('bad observer'), 'next']]);
  });
});

describe('EventSubject', () => {
  test('no replay; snapshot at emit; same instance', () => {
    const q = queue();
    const subject = new EventSubject<string>();
    expect(subject.observable).toBe(subject.observable);
    const a = watcher(subject.observable);
    subject.emit('closed 1', q.deliver);
    const b = watcher(subject.observable);
    q.flush();
    subject.emit('closed 2', q.deliver);
    q.flush();
    expect(a.seen).toEqual(['closed 1', 'closed 2']);
    expect(b.seen).toEqual(['closed 2']);
    expect(watcher(subject.observable).seen).toEqual([]);
  });

  test('uses the reporter for throwing observers', () => {
    const q = queue();
    const reports: unknown[] = [];
    const subject = new EventSubject<number>((e, kind) => reports.push(kind));
    subject.observable.subscribe(() => {
      throw new Error('x');
    });
    subject.emit(1, q.deliver);
    q.flush();
    expect(reports).toEqual(['next']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// As a property: random subscribe / unsubscribe / emit / clear / deliver interleavings against a reference model.
// ---------------------------------------------------------------------------------------------------------------------

type Op =
  | { readonly k: 'subscribe' }
  | { readonly k: 'unsubscribe'; readonly i: number }
  | { readonly k: 'emit' }
  | { readonly k: 'clear' }
  | { readonly k: 'deliverOne' }
  | { readonly k: 'deliverAll' };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ k: 'subscribe' }),
  fc.nat({ max: 7 }).map((i): Op => ({ k: 'unsubscribe', i })),
  fc.constant<Op>({ k: 'emit' }),
  fc.constant<Op>({ k: 'clear' }),
  fc.constant<Op>({ k: 'deliverOne' }),
  fc.constant<Op>({ k: 'deliverAll' }),
);

describe('snapshot-at-emit property: exactly once, in order', () => {
  for (const latest of [true, false]) {
    test(`${latest ? 'LatestSubject' : 'EventSubject'} matches the model`, () => {
      fc.assert(
        fc.property(fc.boolean(), fc.array(op, { maxLength: 40 }), (initial, ops) => {
          const q = queue();
          const subject = latest
            ? new LatestSubject<number>(initial ? { hasValue: true, value: 0 } : { hasValue: false })
            : new EventSubject<number>();
          const actual: number[][] = [];
          const subscriptions: Subscription[] = [];
          // model
          let current: number | undefined = latest && initial ? 0 : undefined;
          const expected: number[][] = [];
          const live = new Set<number>();
          const modelQueue: { value: number; snapshot: number[] }[] = [];
          let nextValue = 1;
          const modelDeliverOne = () => {
            const d = modelQueue.shift();
            if (d === undefined) return;
            for (const i of d.snapshot) if (live.has(i)) expected[i]?.push(d.value);
          };
          for (const o of ops) {
            switch (o.k) {
              case 'subscribe': {
                const i = subscriptions.length;
                actual.push([]);
                expected.push(current === undefined ? [] : [current]);
                live.add(i);
                subscriptions.push(subject.observable.subscribe((v) => actual[i]?.push(v)));
                break;
              }
              case 'unsubscribe':
                subscriptions[o.i]?.unsubscribe();
                live.delete(o.i);
                break;
              case 'emit': {
                const value = nextValue++;
                subject.emit(value, q.deliver);
                if (latest) current = value;
                if (live.size > 0) modelQueue.push({ value, snapshot: [...live] });
                break;
              }
              case 'clear':
                if (subject instanceof LatestSubject) subject.clear();
                current = undefined;
                break;
              case 'deliverOne':
                q.flushOne();
                modelDeliverOne();
                break;
              case 'deliverAll':
                q.flush();
                while (modelQueue.length > 0) modelDeliverOne();
                break;
            }
          }
          q.flush();
          while (modelQueue.length > 0) modelDeliverOne();
          expect(actual).toEqual(expected);
          // strictly increasing per observer (each event once, in order)
          for (const seen of actual)
            for (let j = 1; j < seen.length; j++) expect(seen[j]).toBeGreaterThan(seen[j - 1]!);
        }),
        replayParameters(),
      );
    });
  }
});
