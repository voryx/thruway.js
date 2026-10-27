// The Trace model (types in trace-types.ts) and its recorder. One recorder per client: the harness feeds it the
// client's frames (router side, at the client's socket boundary), its log entries (the recorder is the client's
// logger), the notifications of every observer subscribed through `observe()`, the app's open/close/reconnect calls and
// the clock's arm/cancel/fire log; the client's core feeds it steps and deliveries through a `CoreTraceSink` (passed in
// via the internal option `trace`, see harness.ts).
//
// Step attribution: a frame the client writes ('in') belongs to the step running at that moment; a frame the client
// receives ('out') to the step that processes it — the next `ws.message` step whose data is that frame's text (inputs
// are FIFO, so the first unmatched received frame with equal text is the one). A notification and a CloseInfo belong
// to the step that queued the delivery running at that moment; one delivered outside any delivery (a lifecycle
// replay inside `subscribe`) has no step.
import type { CoreInput } from '../../src/core/contracts.js';
import type { FrameRecord } from '../../src/testing/index.js';
import type { ClockEvent } from '../../src/testing/virtual-clock.js';
import type { CloseInfo, LogEntry, Observer, Unsubscribable } from '../../src/types.js';
import type {
  ApiEvent,
  CloseInfoEvent,
  DeliveryEvent,
  FrameEvent,
  InputEvent,
  LogEvent,
  NotificationEvent,
  ObserverEvent,
  ObserverId,
  StepId,
  TimerEvent,
  Trace,
  TraceEvent,
  TraceSeq,
  TraceStream,
} from './trace-types.js';

/** What the core reports so the trace can attribute frames and notifications to steps. */
export interface CoreTraceSink {
  /** Step `stepId` (1, 2, 3, … per client) starts processing `input`. */
  stepStart(stepId: StepId, input: CoreInput): void;
  stepEnd(stepId: StepId): void;
  /** Step `stepId` queued delivery `deliveryId`. */
  deliveryQueued(deliveryId: number, stepId: StepId): void;
  deliveryStart(deliveryId: number): void;
  deliveryEnd(deliveryId: number): void;
}

/** The global order shared by the recorders of one run. */
export class TraceSequence {
  private n = 0;
  next(): TraceSeq {
    return ++this.n;
  }
}

export interface TraceRecorderOptions {
  readonly now: () => number;
  readonly source?: Trace['source'];
  readonly seed?: number;
  readonly sequence?: TraceSequence;
}

/** Anything with a `subscribe(observer)` (our Observable, a lifecycle stream, an Rx Observable). */
export interface SubscribableLike<T> {
  subscribe(observer: Partial<Observer<T>>): Unsubscribable;
}

/** One app observer subscribed through the recorder, with what it received. */
export interface Recorded<T> {
  readonly id: ObserverId;
  readonly values: readonly T[];
  /** The error it received (when `errored`). */
  readonly error: unknown;
  readonly errored: boolean;
  readonly completed: boolean;
  /** Terminated, or unsubscribed. */
  readonly closed: boolean;
  unsubscribe(): void;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The text of a frame record when the raw data is not known (the router writes `JSON.stringify(frame)`). */
function frameText(frame: FrameRecord['frame']): string {
  return typeof frame === 'string' ? frame : JSON.stringify(frame);
}

export class TraceRecorder {
  readonly sink: CoreTraceSink;
  /** Use as `ClientOptions.logger`. */
  readonly log: (entry: LogEntry) => void;
  private readonly events: TraceEvent[] = [];
  private readonly sequence: TraceSequence;
  private currentStep: StepId | undefined;
  private currentDelivery: number | undefined;
  private readonly deliverySteps = new Map<number, StepId>();
  /** Received frames whose processing step has not started yet. */
  private readonly unprocessed: { readonly text: string; readonly event: Mutable<FrameEvent> }[] = [];
  private observers = 0;

  constructor(private readonly options: TraceRecorderOptions) {
    this.sequence = options.sequence ?? new TraceSequence();
    this.log = (entry) => {
      this.push<LogEvent>({ kind: 'log', entry });
    };
    this.sink = {
      stepStart: (stepId, input) => {
        this.currentStep = stepId;
        if (input.kind === 'ws.message') {
          const index = this.unprocessed.findIndex((u) => u.text === input.data);
          if (index >= 0) {
            const [match] = this.unprocessed.splice(index, 1);
            (match as { event: Mutable<FrameEvent> }).event.stepId = stepId;
          }
        }
        this.push<InputEvent>({
          kind: 'input',
          stepId,
          input: input.kind,
          conn: 'conn' in input ? input.conn : undefined,
        });
      },
      stepEnd: (stepId) => {
        if (this.currentStep === stepId) this.currentStep = undefined;
      },
      deliveryQueued: (deliveryId, stepId) => {
        this.deliverySteps.set(deliveryId, stepId);
        this.push<DeliveryEvent>({ kind: 'delivery', deliveryId, stepId, phase: 'queued' });
      },
      deliveryStart: (deliveryId) => {
        this.currentDelivery = deliveryId;
        this.push<DeliveryEvent>({
          kind: 'delivery',
          deliveryId,
          stepId: this.deliverySteps.get(deliveryId) ?? 0,
          phase: 'ran',
        });
      },
      deliveryEnd: (deliveryId) => {
        if (this.currentDelivery === deliveryId) this.currentDelivery = undefined;
        this.deliverySteps.delete(deliveryId);
      },
    };
  }

  private push<E extends TraceEvent>(event: Omit<E, 'seq' | 'at'> & Partial<Pick<E, 'at'>>): E {
    const full = { seq: this.sequence.next(), at: this.options.now(), ...event } as unknown as E;
    this.events.push(full);
    return full;
  }

  /** The step whose delivery is running now (notifications), if any. */
  private deliveryStep(): StepId | undefined {
    return this.currentDelivery === undefined ? undefined : this.deliverySteps.get(this.currentDelivery);
  }

  /** A frame on one of this client's connections (`in` = written by the client). `data` is the frame as it travelled:
   *  a received frame is matched to its `ws.message` step by that text (a decoded frame re-serialized may differ from
   *  it: whitespace, `1.0`, escapes — the fuzzers' raw frames). */
  frame(record: FrameRecord, data?: string | Uint8Array): void {
    const event = this.push<FrameEvent>({
      kind: 'frame',
      connection: record.connection,
      direction: record.direction,
      frame: record.frame,
      at: record.at,
      stepId: record.direction === 'in' ? this.currentStep : undefined,
    }) as Mutable<FrameEvent>;
    if (record.direction === 'out') {
      this.unprocessed.push({ text: typeof data === 'string' ? data : frameText(record.frame), event });
    }
  }

  timer(event: ClockEvent): void {
    this.push<TimerEvent>({ kind: 'timer', ...event });
  }

  api(call: ApiEvent['call'], resolved = false): void {
    this.push<ApiEvent>({ kind: 'api', call, resolved });
  }

  /** Subscribe `forward` (optional app observer) to `source` through a recording observer. */
  observe<T>(
    stream: TraceStream,
    uri: string | undefined,
    source: SubscribableLike<T>,
    forward?: Partial<Observer<T>>,
  ): Recorded<T> {
    const id = ++this.observers;
    const values: T[] = [];
    const state = { error: undefined as unknown, errored: false, completed: false, unsubscribed: false };
    const notify = (notification: NotificationEvent['notification'], value: unknown): void => {
      const stepId = this.deliveryStep();
      this.push<NotificationEvent>({ kind: 'notification', observer: id, stream, uri, notification, value, stepId });
      if (stream === 'onClose' && notification === 'next') {
        this.push<CloseInfoEvent>({ kind: 'close-info', info: value as CloseInfo, stepId });
      }
    };
    this.push<ObserverEvent>({ kind: 'observer', observer: id, stream, uri, action: 'subscribe' });
    const subscription = source.subscribe({
      next: (value: T) => {
        values.push(value);
        notify('next', value);
        forward?.next?.(value);
      },
      error: (error: unknown) => {
        state.error = error;
        state.errored = true;
        notify('error', error);
        forward?.error?.(error);
      },
      complete: () => {
        state.completed = true;
        notify('complete', undefined);
        forward?.complete?.();
      },
    });
    return {
      id,
      values,
      get error() {
        return state.error;
      },
      get errored() {
        return state.errored;
      },
      get completed() {
        return state.completed;
      },
      get closed() {
        return state.errored || state.completed || state.unsubscribed;
      },
      unsubscribe: () => {
        if (state.unsubscribed) return;
        state.unsubscribed = true;
        this.push<ObserverEvent>({ kind: 'observer', observer: id, stream, uri, action: 'unsubscribe' });
        subscription.unsubscribe();
      },
    };
  }

  /** A snapshot: the ordered log and its filtered views (frozen). */
  trace(): Trace {
    const events = Object.freeze(this.events.map((event) => Object.freeze({ ...event })));
    const only = <K extends TraceEvent['kind']>(kind: K): readonly Extract<TraceEvent, { kind: K }>[] =>
      Object.freeze(events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind));
    return Object.freeze({
      source: this.options.source ?? 'sim',
      seed: this.options.seed,
      events,
      frames: only('frame'),
      inputs: only('input'),
      deliveries: only('delivery'),
      notifications: only('notification'),
      observers: only('observer'),
      closeInfos: only('close-info'),
      api: only('api'),
      timers: only('timer'),
      logs: only('log'),
    });
  }
}

// --- queries ----------------------------------------------------------------------------------------------------

/** Every connection number that carried a frame, in order of first appearance. */
export function connectionsOf(trace: Trace): readonly number[] {
  return [...new Set(trace.frames.map((f) => f.connection))];
}

/** The frames of one connection, optionally of one direction. */
export function framesOn(trace: Trace, connection: number, direction?: 'in' | 'out'): readonly FrameEvent[] {
  return trace.frames.filter(
    (f) => f.connection === connection && (direction === undefined || f.direction === direction),
  );
}

/** Message types (element 0) of the frames of one connection, or of all of them; raw text frames are `NaN`. */
export function frameTypes(trace: Trace, connection?: number, direction?: 'in' | 'out'): readonly number[] {
  return trace.frames
    .filter(
      (f) =>
        (connection === undefined || f.connection === connection) &&
        (direction === undefined || f.direction === direction),
    )
    .map((f) => (typeof f.frame === 'string' || typeof f.frame[0] !== 'number' ? NaN : f.frame[0]));
}

export function notificationsOf(trace: Trace, observer: ObserverId): readonly NotificationEvent[] {
  return trace.notifications.filter((n) => n.observer === observer);
}

export function timersOf(trace: Trace, scope: string): readonly TimerEvent[] {
  return trace.timers.filter((t) => t.scope === scope);
}

export function logsOf(trace: Trace, event: string): readonly LogEvent[] {
  return trace.logs.filter((l) => l.entry.event === event);
}
