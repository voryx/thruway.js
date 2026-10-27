// The Registry: every live subscription, the one-shot FIFO kept in start (`seq`) order, removal by teardown (also from
// the FIFO), snapshots, and the frozen op records of the factories.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { AnyOp, CallOp, OneShotOp, OpSubscriber, PublishOp } from '../../src/core/contracts.js';
import { opFactories, Registry } from '../../src/core/registry.js';
import { snapshotCall, snapshotPublish, snapshotRegister, snapshotTopic } from '../../src/validate.js';
import { replayParameters } from '../setup-fast-check.js';

function subscriber<T>(): OpSubscriber<T> {
  return { next: () => undefined, error: () => undefined, complete: () => undefined, closed: false };
}
const call = (seq: number): CallOp => opFactories.newCallOp(seq, snapshotCall('a.b', [], {}, {}), subscriber());
const publish = (seq: number): PublishOp =>
  opFactories.newPublishOp(seq, snapshotPublish('a.t', [], {}, {}), subscriber());
const topic = (seq: number): AnyOp => opFactories.newTopicOp(seq, snapshotTopic('a.t', {}), subscriber());

describe('the op factories', () => {
  test('frozen immutable records {kind, seq, snap, subscriber}', () => {
    const sub = subscriber<never>();
    const records = [
      opFactories.newCallOp(1, snapshotCall('a.b', [], {}, {}), sub),
      opFactories.newPublishOp(2, snapshotPublish('a.t', [], {}, {}), sub),
      opFactories.newTopicOp(3, snapshotTopic('a.t', {}), sub),
      opFactories.newRegisterOp(
        4,
        snapshotRegister('a.r', () => 1, {}),
        sub,
      ),
    ];
    expect(records.map((r) => [r.kind, r.seq])).toEqual([
      ['call', 1],
      ['publish', 2],
      ['topic', 3],
      ['register', 4],
    ]);
    for (const r of records) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(r.subscriber).toBe(sub);
    }
  });
});

describe('Registry', () => {
  test('live subscriptions in seq order; remove() also takes a one-shot out of the FIFO', () => {
    const r = new Registry();
    const [a, b, t] = [call(3), publish(1), topic(2)];
    r.add(a);
    r.add(b);
    r.add(t);
    expect(r.size).toBe(3);
    expect(r.live()).toEqual([b, t, a]);
    expect(r.has(t)).toBe(true);
    r.enqueue(a);
    r.remove(a);
    expect(r.queued()).toEqual([]);
    expect(r.has(a)).toBe(false);
    r.remove(t);
    expect(r.live()).toEqual([b]);
  });

  test('the FIFO keeps seq order whatever order ops are enqueued in; dequeue reports whether it held the op', () => {
    const r = new Registry();
    const ops = [call(5), publish(1), call(3), publish(4), call(2)];
    for (const op of ops) r.enqueue(op);
    expect(r.queued().map((o) => o.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.queuedCount).toBe(5);
    expect(r.dequeue(ops[2]!)).toBe(true);
    expect(r.dequeue(ops[2]!)).toBe(false);
    expect(r.queued().map((o) => o.seq)).toEqual([1, 2, 4, 5]);
  });

  test('queued() and live() are snapshots; clearQueue() empties the FIFO and returns what it held', () => {
    const r = new Registry();
    const op = call(1);
    r.add(op);
    r.enqueue(op);
    const snapshot = r.queued();
    const live = r.live();
    r.dequeue(op);
    r.remove(op);
    expect(snapshot).toEqual([op]);
    expect(live).toEqual([op]);
    r.enqueue(op);
    expect(r.clearQueue()).toEqual([op]);
    expect(r.queuedCount).toBe(0);
  });

  test('the FIFO always equals the enqueued-and-not-removed ops sorted by seq (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 40 })), { maxLength: 80 }), (script) => {
        const r = new Registry();
        const model = new Map<number, OneShotOp>();
        for (const [enqueue, seq] of script) {
          const existing = model.get(seq);
          if (enqueue && existing === undefined) {
            const op = seq % 2 === 0 ? call(seq) : publish(seq);
            model.set(seq, op);
            r.enqueue(op);
          } else if (!enqueue && existing !== undefined) {
            model.delete(seq);
            r.remove(existing);
          }
          expect(r.queued()).toEqual([...model.entries()].sort((x, y) => x[0] - y[0]).map(([, op]) => op));
        }
      }),
      replayParameters(),
    );
  });
});
