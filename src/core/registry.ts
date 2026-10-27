/**
 * `Registry`: every live app subscription (added when its `op.start` is processed, removed when its
 * `op.stop` is) and the one-shot FIFO of ops waiting for a session, ordered by `seq` (calls and publishes interleaved
 * as the app started them). Its size is exactly what the app keeps subscribed. Also the op factories:
 * op records are immutable `{kind, seq, snap, subscriber}` objects (core/contracts.ts).
 *
 * Only the core mutates it, inside steps.
 *
 * @module
 */
import type { AnyOp, OneShotOp, OpFactories } from './contracts.js';

export class Registry {
  private readonly ops = new Set<AnyOp>();
  private fifo: OneShotOp[] = [];

  /** A live subscription (op.start). */
  add(op: AnyOp): void {
    this.ops.add(op);
  }

  /** Its teardown ran (also removes it from the FIFO). */
  remove(op: AnyOp): void {
    this.ops.delete(op);
    if (op.kind === 'call' || op.kind === 'publish') this.dequeue(op);
  }

  has(op: AnyOp): boolean {
    return this.ops.has(op);
  }

  /** Append a one-shot to the waiting FIFO (kept in `seq` order). */
  enqueue(op: OneShotOp): void {
    const later = this.fifo.findIndex((queued) => queued.seq > op.seq);
    if (later < 0) this.fifo.push(op);
    else this.fifo.splice(later, 0, op);
  }

  /** Remove a waiting one-shot; false if it was not queued (then it is in flight or settled). */
  dequeue(op: OneShotOp): boolean {
    const i = this.fifo.indexOf(op);
    if (i < 0) return false;
    this.fifo.splice(i, 1);
    return true;
  }

  /** The waiting one-shots in `seq` order (a snapshot). */
  queued(): readonly OneShotOp[] {
    return this.fifo.slice();
  }

  /** Empty the FIFO (hardReset, close, give-up: its ops are failed by the caller); returns what it held. */
  clearQueue(): readonly OneShotOp[] {
    const queued = this.fifo;
    this.fifo = [];
    return queued;
  }

  get queuedCount(): number {
    return this.fifo.length;
  }

  /** Every live subscription in `seq` order (a snapshot; hardReset, close). */
  live(): readonly AnyOp[] {
    return [...this.ops].sort((a, b) => a.seq - b.seq);
  }

  get size(): number {
    return this.ops.size;
  }
}

/** The factories client.ts uses to build op records from validated snapshots. Records are frozen. */
export const opFactories: OpFactories = {
  newCallOp(seq, snap, subscriber) {
    return Object.freeze({ kind: 'call', seq, snap, subscriber });
  },
  newPublishOp(seq, snap, subscriber) {
    return Object.freeze({ kind: 'publish', seq, snap, subscriber });
  },
  newTopicOp(seq, snap, subscriber) {
    return Object.freeze({ kind: 'topic', seq, snap, subscriber });
  },
  newRegisterOp(seq, snap, subscriber) {
    return Object.freeze({ kind: 'register', seq, snap, subscriber });
  },
};
