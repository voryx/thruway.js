/**
 * Trace types of the test harness, shared by the harness and trace recorder, the invariant checkers, the real-router
 * recorder and the browser runs so that they agree.
 *
 * A `Trace` is one run's ordered event log: every frame per connection with direction, time and global sequence
 * number; every core input with its `StepId`; every delivery with the step that queued it; every notification
 * delivered to every app observer (op, interest, lifecycle); every `CloseInfo`; the app's `open()`/`close()`/
 * `reconnect()` calls; the clock's arm/cancel/fire log per scope; and log entries. Checkers take a tolerance (0 in the
 * sim; e.g. 50 ms + 5 % in real-router runs).
 */
import type { CoreInput } from '../../src/core/contracts.js';
import type { FrameRecord } from '../../src/testing/index.js';
import type { CloseInfo, LogEntry } from '../../src/types.js';

/** The testing kit's frame record, also the JSONL line format of test/fixtures/transcripts. */
export type { FrameRecord };

/** One step of the core state machine, i.e. one processed input; monotonic per client, starting at 1. */
export type StepId = number;

/** Position in a trace's single global order (shared by every event kind), starting at 1. */
export type TraceSeq = number;

/** A trace-local identity of one app observer (one subscription of an op, interest or lifecycle stream). */
export type ObserverId = number;

/** Which stream an observer subscribed to. */
export type TraceStream = 'call' | 'publish' | 'topic' | 'register' | 'status' | 'onOpen' | 'onClose';

interface TraceEventBase {
  readonly seq: TraceSeq;
  /** Virtual ms in the sim; `performance.now()`-based ms in real-time runs. */
  readonly at: number;
}

/** A frame on one connection (`direction` 'in' = client → router, as in `FrameRecord`). */
export interface FrameEvent extends TraceEventBase, FrameRecord {
  readonly kind: 'frame';
  /** The client step that wrote the frame ('in') or processed it ('out'); undefined when not observable (frames
   *  recorded at a proxy, router-side frames that never reached the client). */
  readonly stepId: StepId | undefined;
}

/** One core input, as processed (one step). */
export interface InputEvent extends TraceEventBase {
  readonly kind: 'input';
  readonly stepId: StepId;
  readonly input: CoreInput['kind'];
  /** The input's connection id, when it carries one. */
  readonly conn: number | undefined;
}

/** One delivery (app code queued by a step), when it was queued and when it ran. */
export interface DeliveryEvent extends TraceEventBase {
  readonly kind: 'delivery';
  readonly deliveryId: number;
  /** The step that queued it. */
  readonly stepId: StepId;
  readonly phase: 'queued' | 'ran';
}

/** A notification delivered to an app observer. */
export interface NotificationEvent extends TraceEventBase {
  readonly kind: 'notification';
  readonly observer: ObserverId;
  readonly stream: TraceStream;
  /** Procedure or topic of an op/interest observer; undefined for lifecycle streams. */
  readonly uri: string | undefined;
  readonly notification: 'next' | 'error' | 'complete';
  /** The value (next) or the error (error). */
  readonly value: unknown;
  /** The step whose delivery carried it. */
  readonly stepId: StepId | undefined;
}

/** An app observer subscribed or unsubscribed. */
export interface ObserverEvent extends TraceEventBase {
  readonly kind: 'observer';
  readonly observer: ObserverId;
  readonly stream: TraceStream;
  readonly uri: string | undefined;
  readonly action: 'subscribe' | 'unsubscribe';
}

/** Every end of an attempt or session (one per `onClose`). */
export interface CloseInfoEvent extends TraceEventBase {
  readonly kind: 'close-info';
  readonly info: CloseInfo;
  readonly stepId: StepId | undefined;
}

/** An app call of the lifecycle API. */
export interface ApiEvent extends TraceEventBase {
  readonly kind: 'api';
  readonly call: 'open' | 'close' | 'reconnect';
  /** For `close`: when its Promise resolved (a second event with `resolved: true`). */
  readonly resolved: boolean;
}

/** The clock's arm/cancel/fire log, per scope (`client`, `router`, …). */
export interface TimerEvent extends TraceEventBase {
  readonly kind: 'timer';
  readonly scope: string;
  readonly action: 'arm' | 'cancel' | 'fire';
  readonly timerId: number;
  /** Requested delay (arm). */
  readonly delay: number | undefined;
  /** Due time (arm, fire). */
  readonly due: number | undefined;
}

/** A log entry the client produced (the trace is the client's logger). */
export interface LogEvent extends TraceEventBase {
  readonly kind: 'log';
  readonly entry: LogEntry;
}

export type TraceEvent =
  | FrameEvent
  | InputEvent
  | DeliveryEvent
  | NotificationEvent
  | ObserverEvent
  | CloseInfoEvent
  | ApiEvent
  | TimerEvent
  | LogEvent;

/** One run's trace. `events` is the single ordered log (by `seq`); the other arrays are filtered views of it. */
export interface Trace {
  readonly source: 'sim' | 'real-router' | 'browser';
  /** The run's seed (sim/model runs) for replay. */
  readonly seed: number | undefined;
  readonly events: readonly TraceEvent[];
  readonly frames: readonly FrameEvent[];
  readonly inputs: readonly InputEvent[];
  readonly deliveries: readonly DeliveryEvent[];
  readonly notifications: readonly NotificationEvent[];
  readonly observers: readonly ObserverEvent[];
  readonly closeInfos: readonly CloseInfoEvent[];
  readonly api: readonly ApiEvent[];
  readonly timers: readonly TimerEvent[];
  readonly logs: readonly LogEvent[];
}

/** Checker tolerance: `absoluteMs + relative × duration`. Zero in the sim. */
export interface Tolerance {
  readonly absoluteMs: number;
  readonly relative: number;
}
