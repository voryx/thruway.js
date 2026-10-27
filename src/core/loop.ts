/**
 * `EventLoop`: the input queue, the delivery queue and the re-entrancy rules L1–L6. A throw out of a step goes to
 * `panic` (then `lastResort`); a throw out of a delivery to `reportUnhandled`; nothing escapes `submit`.
 *
 * - L1: a step never runs app code: observers, `onChallenge`, handlers, the URL resolver and app Observables run only
 *   in deliveries. The "pure hooks" a step must call (the clock, `retryDelay`, the jitter source) are contained.
 * - L2: an input submitted while a step runs is queued and processed right after it.
 * - L3: every queued input is processed before the next delivery; deliveries run FIFO, one at a time, never nested.
 * - L4: an input submitted while no step runs (app code, a WebSocket listener, a timer) is processed — with every
 *   delivery it causes, unless a delivery is already running further up the stack — before `submit` returns.
 * - L5: a delivery that throws is reported and the next one runs.
 * - L6: lifecycle observers are snapshotted when a value is emitted (observable/subjects.ts).
 *
 * @module
 */
import type { CoreInput } from './contracts.js';

/** What the loop drives (the `Core`). */
export interface LoopHost {
  step(input: CoreInput): void;
  /** Contain a throw out of `step` (`hardReset`). */
  panic(error: unknown): void;
  /** A throw out of `panic` (impossible by construction): log and schedule a plain retry unless stopped. */
  lastResort(error: unknown): void;
  /** A delivery threw: log `{level: 'error', event: 'unhandled'}` through safeLog. */
  reportUnhandled(error: unknown): void;
}

/** What the test harness learns about steps and deliveries (test/helpers/trace.ts `CoreTraceSink`). The sink is
 *  test code: its throws are swallowed. */
export interface TraceSink {
  stepStart(stepId: number, input: CoreInput): void;
  stepEnd(stepId: number): void;
  deliveryQueued(deliveryId: number, stepId: number): void;
  deliveryStart(deliveryId: number): void;
  deliveryEnd(deliveryId: number): void;
}

/** A FIFO with O(1) shift (an Array's `shift` is O(n), and a burst of deliveries can be long). */
class Queue<T> {
  private items: T[] = [];
  private head = 0;

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head] as T;
    this.items[this.head] = undefined as unknown as T; // release the reference
    this.head++;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  get size(): number {
    return this.items.length - this.head;
  }
}

interface Delivery {
  readonly id: number;
  readonly fn: () => void;
}

export class EventLoop {
  private readonly inputs = new Queue<CoreInput>();
  private readonly deliveries = new Queue<Delivery>();
  private stepping = false;
  private delivering = false;
  private stepId = 0;
  private deliveryId = 0;

  constructor(
    private readonly host: LoopHost,
    private readonly trace?: TraceSink,
  ) {}

  /** Queue `input`; if no step is on the stack, process every queued input and delivery before returning (L2–L4). */
  submit(input: CoreInput): void {
    this.inputs.push(input);
    this.run();
  }

  /** Queue app code to run after the current step (only called from inside steps). */
  deliver(fn: () => void): void {
    const id = ++this.deliveryId;
    this.deliveries.push({ id, fn });
    this.notify((t) => {
      t.deliveryQueued(id, this.stepId);
    });
  }

  /** True while a step runs (participant callbacks such as `LivenessHost.later` rely on it). */
  get inStep(): boolean {
    return this.stepping;
  }

  /** Queue sizes for the internal debug probe. */
  sizes(): { readonly inputs: number; readonly deliveries: number } {
    return { inputs: this.inputs.size, deliveries: this.deliveries.size };
  }

  private run(): void {
    if (this.stepping) return; // L2: processed right after the current step
    for (;;) {
      const input = this.inputs.shift();
      if (input !== undefined) {
        this.runStep(input);
        continue;
      }
      if (this.delivering) return; // the run() that started the delivery keeps going (L3: never nested)
      const delivery = this.deliveries.shift();
      if (delivery === undefined) return;
      this.runDelivery(delivery);
    }
  }

  private runStep(input: CoreInput): void {
    const id = ++this.stepId;
    this.stepping = true;
    this.notify((t) => {
      t.stepStart(id, input);
    });
    try {
      this.host.step(input);
    } catch (error) {
      try {
        this.host.panic(error);
      } catch (error2) {
        try {
          this.host.lastResort(error2);
        } catch {
          // lastResort only logs through safeLog and arms a platform timer; nothing is left to try
        }
      }
    } finally {
      this.stepping = false;
      this.notify((t) => {
        t.stepEnd(id);
      });
    }
  }

  private runDelivery(delivery: Delivery): void {
    this.delivering = true;
    this.notify((t) => {
      t.deliveryStart(delivery.id);
    });
    try {
      delivery.fn();
    } catch (error) {
      try {
        this.host.reportUnhandled(error);
      } catch {
        // unreachable: safeLog swallows a throwing logger, and the entry is built defensively
      }
    } finally {
      this.delivering = false;
      this.notify((t) => {
        t.deliveryEnd(delivery.id);
      });
    }
  }

  private notify(call: (sink: TraceSink) => void): void {
    const trace = this.trace;
    if (trace === undefined) return;
    try {
      call(trace);
    } catch {
      // the trace sink is test code
    }
  }
}
