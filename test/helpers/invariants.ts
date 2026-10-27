// The INV-* checkers: executable invariants over one client's `Trace` (trace-types.ts), each with a tolerance (0 in the
// sim; e.g. 50 ms + 5 % in real-router runs). Every checker is a pure function `(trace, options) → violations`;
// `checkInvariants` runs a selection, `assertInvariants` throws a readable report. The model suite (test/model) runs
// every checker after every command, the sims and fuzzers after each scenario, and the integration and chaos runs over
// the client-side traces of real-router runs.
//
// What a checker can know comes from the trace alone: frames per socket (the fake socket number) with the step that
// wrote ('in') or processed ('out') them, every core input with its step, every notification with the step whose
// delivery carried it, every observer's (un)subscription, the app's open/close/reconnect calls, the clock's timer log
// and the log entries. The rest is passed in `CheckOptions`: the client's timings, how app ops are tagged on the wire
// (`ops`, `tagOf`: an op's CALL/PUBLISH carries its tag as `args[0]`), how challenge answers name their CHALLENGE
// (`signature`), which errors are deliberate (`exempt`), the clock jumps the run injected (`skews`, `suspends`) and,
// for end-of-run checks (`final`), when the run was healed. A trace without step attribution (frames recorded at a
// proxy) is checked in wire order.
//
// Each socket's connection id (the client's `ConnId`) is the input `conn` of the step that wrote its HELLO; attempt k
// is connection k (the core numbers connections in attempt order) and is read from the first `status` observer, which
// must have been subscribed before the client's first attempt (the harness subscribes at construction; use
// `autoOpen: false` or the default router so that the first attempt is still `connecting` then).
import { isThruwayError, type ThruwayError } from '../../src/errors.js';
import { INTERNAL_DEFAULTS, DEFAULTS } from '../../src/options.js';
import { MessageType as T, Uri } from '../../src/protocol/codes.js';
import { decode } from '../../src/protocol/decode.js';
import type { DecodeResult, InboundMessage } from '../../src/protocol/messages.js';
import { snapshotRegister, snapshotTopic } from '../../src/validate.js';
import type { CloseInfo, Session, Status } from '../../src/types.js';
import type {
  FrameEvent,
  NotificationEvent,
  ObserverId,
  StepId,
  TimerEvent,
  Tolerance,
  Trace,
  TraceSeq,
  TraceStream,
} from './trace-types.js';

// ---------------------------------------------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------------------------------------------

export const INVARIANT_IDS = [
  'INV-CL01',
  'INV-CL02',
  'INV-R1',
  'INV-R2',
  'INV-R3',
  'INV-R4',
  'INV-R5',
  'INV-R6',
  'INV-R7',
  'INV-R8',
  'INV-R9',
  'INV-R10',
  'INV-ORDER',
  'INV-INVOKE',
  'INV-CANCEL',
  'INV-AUTH',
  'INV-ESTABLISH',
  'INV-EVENT',
  'INV-LIVE',
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly message: string;
  /** The trace event the violation was found at, when there is one. */
  readonly seq?: TraceSeq | undefined;
}

/** The client's timings (ms); missing ones are the defaults of src/options.ts. */
export interface Timings {
  readonly connect: number;
  readonly handshake: number;
  readonly request: number;
  readonly idle: number;
  /** Internal liveness ping budget base. */
  readonly ping: number;
  readonly stable: number;
  readonly goodbye: number;
  readonly settle: number;
  readonly attemptFloor: number;
  readonly maxRetryDelay: number;
}

/** What the model knows about one app op/interest observer. */
export interface OpInfo {
  readonly kind: 'call' | 'publish' | 'topic' | 'register';
  /** The op's tag (`args[0]` of its CALL/PUBLISH, see `tagOf`). */
  readonly tag?: string | undefined;
  /** An acknowledged PUBLISH. */
  readonly ack?: boolean | undefined;
  /** Topic/registration key as `snapshotTopic`/`snapshotRegister` compute it [uri without options]. */
  readonly key?: string | undefined;
}

export interface CheckOptions {
  readonly tolerance?: Tolerance | undefined;
  /** End-of-run checks too (INV-R1's bound after healing, INV-R5 "settled by close()", INV-R9 open after close). */
  readonly final?: boolean | undefined;
  readonly timings?: Partial<Timings> | undefined;
  readonly requestIds?: 'random' | 'sequential' | undefined;
  readonly authmethods?: readonly string[] | undefined;
  readonly maxRetries?: number | undefined;
  /** The run's retry strategy: built in, a custom `retryDelay`, or a custom one that may return `null`. */
  readonly retryDelay?: 'default' | 'custom' | 'custom-null' | undefined;
  /** Observer id → what it is (links ops to their frames: INV-R5, INV-R6; keys: INV-R4, INV-EVENT, INV-ESTABLISH). */
  readonly ops?: ReadonlyMap<ObserverId, OpInfo> | undefined;
  /** The tag of a CALL/PUBLISH frame [its args[0] when that is a string]. */
  readonly tagOf?: ((frame: readonly unknown[]) => string | undefined) | undefined;
  /** What an AUTHENTICATE signature says it answers: the CHALLENGE's method and, when the run's CHALLENGEs carry
   *  one, its token (`challengeToken`). */
  readonly signature?: ((signature: string) => { method?: string; token?: unknown } | undefined) | undefined;
  /** The token of a CHALLENGE (from its extra), compared with the signature's. */
  readonly challengeToken?: ((extra: Readonly<Record<string, unknown>>) => unknown) | undefined;
  /** Errors delivered on purpose (bad arguments, injected serializer errors): not judged by INV-R6. */
  readonly exempt?: ((error: unknown) => boolean) | undefined;
  /** `clock.skew(ms)` calls of the run (`seq`: the last trace event before it). */
  readonly skews?: readonly { readonly seq: TraceSeq; readonly ms: number }[] | undefined;
  /** `clock.suspend(ms)` calls of the run (`seq`: the last trace event before it). */
  readonly suspends?: readonly { readonly seq: TraceSeq; readonly ms: number }[] | undefined;
  /** When the run was healed (the last trace position and virtual time before healing) and the INV-R1 bound to reach
   *  `open` from then. */
  readonly healed?: { readonly seq: number; readonly at: number; readonly bound: number } | undefined;
  /** Procedures whose handler throws on purpose (INV-R8). */
  readonly throwingHandlers?: ReadonlySet<string> | undefined;
  /** Internal faults were injected (`internal` entries and their ends are expected, INV-R3). */
  readonly faults?: boolean | undefined;
  /** The run scripted `bufferedAmount` (liveness may then wait for a draining backlog): INV-LIVE is relaxed. */
  readonly buffered?: boolean | undefined;
  /** The client's clock scope in the trace's timer log ['client']. */
  readonly scope?: string | undefined;
  /** A hardReset could not restart an interest (an `unhandled` entry in context `hardReset`: a fault that persists):
   *  that interest is lost for good, so INV-R4's WELCOME clause and INV-ESTABLISH no longer judge the run. */
  readonly lostInterests?: boolean | undefined;
  /** `clock.now()` when the check runs [the last event's time]: what "the end of the trace" means for the rules that
   *  judge how long something has been waiting (INV-R1, INV-ESTABLISH). */
  readonly now?: number | undefined;
}

/** The end of the trace as a position: after every event and every injected jump so far, at `options.now`. */
function traceEnd(index: Index, options: CheckOptions): { readonly seq: number; readonly at: number } {
  return { seq: Number.MAX_SAFE_INTEGER, at: options.now ?? index.lastAt };
}

export type Checker = (trace: Trace, options?: CheckOptions) => readonly InvariantViolation[];

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const RETRY_FLOOR = 100;
/** A deadline that fires late is re-armed once for at most this long (core/clock.ts GRACE_REARM). */
const GRACE_REARM = 3000;
/** Ghost re-REGISTER window (ops/register.ts GHOST_RETRY.window). */
const GHOST_WINDOW = 300000;
const PING_BUDGET_CAP = 120000;
const PROBE_PROCEDURE = 'thruway.js.ping';

function timingsOf(options: CheckOptions): Timings {
  const t = options.timings ?? {};
  return {
    connect: t.connect ?? DEFAULTS.timeouts.connect,
    handshake: t.handshake ?? DEFAULTS.timeouts.handshake,
    request: t.request ?? DEFAULTS.timeouts.request,
    idle: t.idle ?? DEFAULTS.timeouts.idle,
    ping: t.ping ?? INTERNAL_DEFAULTS.ping,
    stable: t.stable ?? INTERNAL_DEFAULTS.stable,
    goodbye: t.goodbye ?? INTERNAL_DEFAULTS.goodbye,
    settle: t.settle ?? INTERNAL_DEFAULTS.settle,
    attemptFloor: t.attemptFloor ?? INTERNAL_DEFAULTS.attemptFloor,
    maxRetryDelay: t.maxRetryDelay ?? DEFAULTS.retryOptions.maxRetryDelay,
  };
}

/** `absoluteMs + relative × duration`. */
function slack(options: CheckOptions, duration = 0): number {
  const t = options.tolerance;
  return t === undefined ? 0 : t.absoluteMs + t.relative * Math.abs(duration);
}

// ---------------------------------------------------------------------------------------------------------------
// The trace index (built once per check)
// ---------------------------------------------------------------------------------------------------------------

type Frame = readonly unknown[];

interface Step {
  readonly id: StepId;
  readonly seq: TraceSeq;
  readonly at: number;
  readonly input: string;
  readonly conn: number | undefined;
}

/** A frame placed in the client's processing order: an 'in' frame where it was written, an 'out' frame at the input
 *  of the step that processed it (unprocessed 'out' frames are left out). */
interface Placed {
  readonly event: FrameEvent;
  readonly frame: Frame;
  /** Order key: the frame's own seq ('in'), its processing step's input seq ('out'). */
  readonly pos: number;
  readonly at: number;
  readonly step: StepId | undefined;
  /** The decoded message ('out' frames that decode to one). */
  readonly msg: InboundMessage | undefined;
}

interface SocketRec {
  readonly number: number;
  conn: number | undefined;
  /** In processing order. */
  readonly placed: Placed[];
}

interface End {
  readonly info: CloseInfo;
  /** The notification (status `closed`) of the primary status observer. */
  readonly seq: TraceSeq;
  readonly at: number;
  readonly step: StepId | undefined;
  /** Where the end happened in the core's order: the input seq of its step (deliveries lag steps). */
  readonly pos: number;
}

interface Attempt {
  readonly conn: number;
  readonly startSeq: TraceSeq;
  readonly startAt: number;
  readonly startStep: StepId | undefined;
  /** The input seq of the step that started it (its status notification may be delivered later). */
  readonly startPos: number;
  socket: SocketRec | undefined;
  /** The accepted WELCOME (status `open`). */
  open:
    | { readonly seq: TraceSeq; readonly at: number; readonly step: StepId | undefined; readonly session: Session }
    | undefined;
  end: End | undefined;
}

interface ObserverRec {
  readonly id: ObserverId;
  readonly stream: TraceStream;
  readonly uri: string | undefined;
  readonly subscribeSeq: TraceSeq;
  readonly subscribeAt: number;
  unsubscribeSeq: TraceSeq | undefined;
  readonly notes: NotificationEvent[];
  terminal: NotificationEvent | undefined;
}

interface Index {
  readonly trace: Trace;
  readonly attributed: boolean;
  readonly steps: ReadonlyMap<StepId, Step>;
  /** Input events in order. */
  readonly stepList: readonly Step[];
  readonly sockets: ReadonlyMap<number, SocketRec>;
  readonly attempts: readonly Attempt[];
  /** Ends without a connection (close() while waiting). */
  readonly freeEnds: readonly End[];
  /** Every end in order (attempt ends and free ends). */
  readonly ends: readonly (End & { readonly attempt: Attempt | undefined })[];
  readonly observers: ReadonlyMap<ObserverId, ObserverRec>;
  readonly primaryStatus: ObserverRec | undefined;
  readonly api: Trace['api'];
  readonly lastSeq: TraceSeq;
  readonly lastAt: number;
}

const decodeCache = new WeakMap<object, DecodeResult>();

/** `decode` of a recorded frame, on a copy (decode freezes dicts in place), cached per frame object. */
function decoded(frame: Frame): DecodeResult {
  let result = decodeCache.get(frame);
  if (result === undefined) {
    let copy: unknown;
    try {
      copy = structuredClone(frame);
    } catch {
      copy = frame;
    }
    result = decode(copy);
    decodeCache.set(frame, result);
  }
  return result;
}

function messageOf(frame: Frame): InboundMessage | undefined {
  const result = decoded(frame);
  return result.kind === 'message' ? result.message : undefined;
}

const indexCache = new WeakMap<Trace, Index>();

export function indexTrace(trace: Trace): Index {
  const cached = indexCache.get(trace);
  if (cached !== undefined) return cached;
  const steps = new Map<StepId, Step>();
  const stepList: Step[] = [];
  for (const input of trace.inputs) {
    const step = { id: input.stepId, seq: input.seq, at: input.at, input: input.input, conn: input.conn };
    steps.set(input.stepId, step);
    stepList.push(step);
  }
  const attributed = stepList.length > 0;
  const sockets = new Map<number, SocketRec>();
  for (const f of trace.frames) {
    let socket = sockets.get(f.connection);
    if (socket === undefined) {
      socket = { number: f.connection, conn: undefined, placed: [] };
      sockets.set(f.connection, socket);
    }
    if (typeof f.frame === 'string') {
      if (f.direction === 'in') socket.placed.push(place(f, [], f.seq, undefined));
      continue;
    }
    const frame = f.frame;
    if (f.direction === 'in') {
      socket.placed.push(place(f, frame, f.seq, undefined));
      if (frame[0] === T.HELLO && socket.conn === undefined && f.stepId !== undefined) {
        socket.conn = steps.get(f.stepId)?.conn;
      }
    } else if (!attributed) {
      socket.placed.push(place(f, frame, f.seq, messageOf(frame)));
    } else if (f.stepId !== undefined) {
      const step = steps.get(f.stepId);
      if (step !== undefined) socket.placed.push(place(f, frame, step.seq, messageOf(frame)));
    }
  }
  for (const socket of sockets.values()) socket.placed.sort((a, b) => a.pos - b.pos || a.event.seq - b.event.seq);

  const observers = new Map<ObserverId, ObserverRec>();
  for (const event of trace.events) {
    if (event.kind === 'observer') {
      if (event.action === 'subscribe') {
        observers.set(event.observer, {
          id: event.observer,
          stream: event.stream,
          uri: event.uri,
          subscribeSeq: event.seq,
          subscribeAt: event.at,
          unsubscribeSeq: undefined,
          notes: [],
          terminal: undefined,
        });
      } else {
        const o = observers.get(event.observer);
        if (o !== undefined && o.unsubscribeSeq === undefined) o.unsubscribeSeq = event.seq;
      }
    } else if (event.kind === 'notification') {
      const o = observers.get(event.observer);
      if (o === undefined) continue;
      o.notes.push(event);
      if (event.notification !== 'next' && o.terminal === undefined) o.terminal = event;
    }
  }
  const primaryStatus = [...observers.values()].find((o) => o.stream === 'status');

  const attempts: Attempt[] = [];
  const freeEnds: End[] = [];
  const ends: (End & { attempt: Attempt | undefined })[] = [];
  let current: Attempt | undefined;
  const posOf = (note: NotificationEvent): number =>
    note.stepId === undefined ? note.seq : (steps.get(note.stepId)?.seq ?? note.seq);
  for (const note of primaryStatus?.notes ?? []) {
    if (note.notification !== 'next') continue;
    const status = note.value as Status;
    if (status.state === 'connecting') {
      current = {
        conn: attempts.length + 1,
        startSeq: note.seq,
        startAt: note.at,
        startStep: note.stepId,
        startPos: posOf(note),
        socket: undefined,
        open: undefined,
        end: undefined,
      };
      attempts.push(current);
    } else if (status.state === 'open') {
      if (current === undefined) {
        // opened before the observer subscribed (sync delivery inside the constructor): attempt 1 is this one
        current = {
          conn: attempts.length + 1,
          startSeq: note.seq,
          startAt: note.at,
          startStep: undefined,
          startPos: note.seq,
          socket: undefined,
          open: undefined,
          end: undefined,
        };
        attempts.push(current);
      }
      current.open ??= { seq: note.seq, at: note.at, step: note.stepId, session: status.session };
    } else if (status.closed !== undefined) {
      const end: End = { info: status.closed, seq: note.seq, at: note.at, step: note.stepId, pos: posOf(note) };
      if (current !== undefined && current.end === undefined) {
        current.end = end;
        ends.push({ ...end, attempt: current });
        current = undefined;
      } else {
        freeEnds.push(end);
        ends.push({ ...end, attempt: undefined });
      }
    }
  }
  for (const socket of sockets.values()) {
    const attempt = socket.conn === undefined ? undefined : attempts[socket.conn - 1];
    if (attempt !== undefined) attempt.socket = socket;
  }
  const last = trace.events[trace.events.length - 1];
  const index: Index = {
    trace,
    attributed,
    steps,
    stepList,
    sockets,
    attempts,
    freeEnds,
    ends,
    observers,
    primaryStatus,
    api: trace.api,
    lastSeq: last?.seq ?? 0,
    lastAt: last?.at ?? 0,
  };
  indexCache.set(trace, index);
  return index;
}

function place(event: FrameEvent, frame: Frame, pos: number, msg: InboundMessage | undefined): Placed {
  const at = event.at;
  const step = event.stepId;
  return { event, frame, pos, at, step, msg };
}

/** Was a placed 'out' frame processed while its connection was still the client's (before the step that ended it)?
 *  A lingering connection drops what it receives. */
function beforeEnd(attempt: Attempt | undefined, p: Placed): boolean {
  const end = attempt?.end?.step;
  return end === undefined || p.step === undefined || p.step < end;
}

/** The step that processed a placed 'out' frame, or wrote an 'in' one. */
function stepOf(index: Index, placed: Placed): Step | undefined {
  return placed.step === undefined ? undefined : index.steps.get(placed.step);
}

/** Is the observer live (subscribed, not unsubscribed, not terminated) just before `seq`? */
function liveAt(o: ObserverRec, seq: number): boolean {
  if (o.subscribeSeq >= seq) return false;
  if (o.unsubscribeSeq !== undefined && o.unsubscribeSeq < seq) return false;
  return !(o.terminal !== undefined && o.terminal.seq < seq);
}

/** Is the observer live for the core when `step` starts: subscribed before it, not unsubscribed, and not settled by an
 *  earlier step (its terminal notification may still be waiting in the delivery queue, e.g. behind a delivery whose
 *  re-entrant API call runs further steps first)? */
function liveAtStep(o: ObserverRec, step: Step): boolean {
  if (!liveAt(o, step.seq)) return false;
  const term = o.terminal;
  return !(term?.stepId !== undefined && term.stepId < step.id);
}

function isOp(o: ObserverRec): boolean {
  return o.stream === 'call' || o.stream === 'publish';
}

function isInterest(o: ObserverRec): boolean {
  return o.stream === 'topic' || o.stream === 'register';
}

function isLifecycle(o: ObserverRec): boolean {
  return o.stream === 'status' || o.stream === 'onOpen' || o.stream === 'onClose';
}

/** Virtual time with the injected skews removed (`skew` moves `now()`, not the timers). */
function eff(options: CheckOptions, seq: number, at: number): number {
  let t = at;
  for (const s of options.skews ?? []) if (s.seq < seq) t -= s.ms;
  return t;
}

/** A clock jump (skew or suspend) happened between the two trace positions. */
function jumped(options: CheckOptions, fromSeq: number, toSeq: number): boolean {
  for (const s of options.skews ?? []) if (s.seq >= fromSeq && s.seq < toSeq) return true;
  for (const s of options.suspends ?? []) if (s.seq >= fromSeq && s.seq < toSeq) return true;
  return false;
}

/** Timer time from one trace position to another, without injected skews and suspended time (a suspend stops the
 *  process: deadlines then fire late). */
function active(
  options: CheckOptions,
  from: { readonly seq: number; readonly at: number },
  to: { readonly seq: number; readonly at: number },
): number {
  let t = eff(options, to.seq, to.at) - eff(options, from.seq, from.at);
  for (const s of options.suspends ?? []) if (s.seq >= from.seq && s.seq < to.seq) t -= s.ms;
  return t;
}

function suspendedBetween(options: CheckOptions, fromSeq: number, toSeq: number): boolean {
  for (const s of options.suspends ?? []) if (s.seq >= fromSeq && s.seq < toSeq) return true;
  return false;
}

/** The key of a topic/register observer. */
function keyOf(options: CheckOptions, o: ObserverRec): string {
  const known = options.ops?.get(o.id)?.key;
  if (known !== undefined) return known;
  return o.stream === 'register' ? registerKey(o.uri ?? '', {}) : topicKey(o.uri ?? '', {});
}

/** The client's key of a SUBSCRIBE's topic + options (validate.ts). */
export function topicKey(topic: unknown, options: unknown): string {
  try {
    return snapshotTopic(topic, options).key;
  } catch {
    return `${String(topic)} ?`;
  }
}

export function registerKey(procedure: unknown, options: unknown): string {
  try {
    return snapshotRegister(procedure, () => undefined, options).key;
  } catch {
    return `${String(procedure)} ?`;
  }
}

function defaultTagOf(frame: Frame): string | undefined {
  const args = frame[0] === T.CALL || frame[0] === T.PUBLISH ? frame[4] : undefined;
  const first: unknown = Array.isArray(args) ? args[0] : undefined;
  return typeof first === 'string' ? first : undefined;
}

function isProbe(frame: Frame): boolean {
  return frame[0] === T.CALL && frame[3] === PROBE_PROCEDURE;
}

function show(frame: Frame | string): string {
  const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function violation(invariant: InvariantId, message: string, seq?: number): InvariantViolation {
  return seq === undefined ? { invariant, message } : { invariant, message, seq };
}

function typeOf(frame: Frame): number {
  return typeof frame[0] === 'number' ? frame[0] : NaN;
}

function dict(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------------------------------------------
// INV-CL01 / INV-AUTH: what the client writes around the handshake and the session end
// ---------------------------------------------------------------------------------------------------------------

/** Steps in which the client ABORTed `protocol_violation` on this socket: what it received there was unreadable to it
 *  (header-fatal, or its serializer failed), so it changed nothing but the end. */
function fatalSteps(socket: SocketRec): ReadonlySet<StepId> {
  const steps = new Set<StepId>();
  for (const p of socket.placed) {
    if (
      p.event.direction === 'in' &&
      p.frame[0] === T.ABORT &&
      p.frame[2] === Uri.PROTOCOL_VIOLATION &&
      p.step !== undefined
    ) {
      steps.add(p.step);
    }
  }
  return steps;
}

export const checkCL01: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  for (const socket of index.sockets.values()) {
    const fatal = fatalSteps(socket);
    let welcomed = false;
    let welcomeStep: StepId | undefined;
    let wroteInWelcomeStep = false;
    let wroteEnd: string | undefined;
    let receivedEnd: string | undefined;
    let routerGoodbye = false;
    let replies = 0;
    for (const p of socket.placed) {
      if (p.event.direction === 'out') {
        if (wroteEnd !== undefined || receivedEnd !== undefined) continue;
        if (p.step !== undefined && fatal.has(p.step)) continue;
        const type = typeOf(p.frame);
        if (type === T.WELCOME && !welcomed && p.msg !== undefined) {
          welcomed = true;
          welcomeStep = p.step;
          wroteInWelcomeStep = false;
        } else if (type === T.ABORT && p.msg !== undefined) {
          receivedEnd = 'a received ABORT';
        } else if (type === T.GOODBYE && p.msg !== undefined) {
          if (welcomed) routerGoodbye = true;
          else receivedEnd = 'a GOODBYE received before WELCOME';
        }
        continue;
      }
      const type = typeOf(p.frame);
      const where = `socket ${String(socket.number)}: ${show(p.frame)}`;
      if (wroteEnd !== undefined) {
        out.push(violation('INV-CL01', `a frame after the client's own ${wroteEnd} on ${where}`, p.event.seq));
        continue;
      }
      if (receivedEnd !== undefined) {
        out.push(violation('INV-CL01', `a frame after ${receivedEnd} on ${where}`, p.event.seq));
        continue;
      }
      if (routerGoodbye) {
        replies++;
        if (type !== T.GOODBYE || replies > 1) {
          out.push(
            violation(
              'INV-CL01',
              `more than the single GOODBYE reply after the router's GOODBYE on ${where}`,
              p.event.seq,
            ),
          );
        }
        wroteEnd = 'GOODBYE reply';
        continue;
      }
      if (!welcomed) {
        if (type !== T.HELLO && type !== T.AUTHENTICATE && type !== T.ABORT) {
          out.push(violation('INV-CL01', `a session frame before WELCOME on ${where}`, p.event.seq));
        }
      } else if (type === T.GOODBYE && p.step !== undefined && p.step === welcomeStep) {
        // the rejection of an unrequested anonymous WELCOME: written in the WELCOME's own step, before anything else
        if (wroteInWelcomeStep) {
          out.push(
            violation('INV-CL01', `the GOODBYE rejecting a WELCOME follows session frames on ${where}`, p.event.seq),
          );
        }
      } else if (type === T.HELLO || type === T.AUTHENTICATE) {
        out.push(violation('INV-CL01', `a handshake frame after WELCOME on ${where}`, p.event.seq));
      }
      if (p.step !== undefined && p.step === welcomeStep) wroteInWelcomeStep = true;
      if (type === T.GOODBYE) wroteEnd = 'GOODBYE';
      else if (type === T.ABORT) wroteEnd = 'ABORT';
    }
  }
  return out;
};

export const checkAuth: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const methods = options.authmethods;
  for (const socket of index.sockets.values()) {
    let hellos = 0;
    let first = true;
    let welcomed = false;
    let pending: { method: string; token: unknown } | undefined;
    let authenticates = 0;
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction === 'out') {
        if (p.msg?.type === T.CHALLENGE && !welcomed) {
          pending = { method: p.msg.authMethod, token: options.challengeToken?.(p.msg.extra) };
        } else if (p.msg?.type === T.WELCOME) {
          welcomed = true;
        }
        continue;
      }
      const where = `socket ${String(socket.number)}: ${show(p.frame)}`;
      if (first && type !== T.HELLO)
        out.push(violation('INV-AUTH', `the first frame is not HELLO on ${where}`, p.event.seq));
      first = false;
      if (type === T.HELLO && ++hellos > 1) out.push(violation('INV-AUTH', `a second HELLO on ${where}`, p.event.seq));
      if (type !== T.AUTHENTICATE) continue;
      authenticates++;
      if (authenticates > 8) out.push(violation('INV-AUTH', `more than 8 rounds on ${where}`, p.event.seq));
      if (welcomed) {
        out.push(violation('INV-AUTH', `AUTHENTICATE after WELCOME on ${where}`, p.event.seq));
        continue;
      }
      if (pending === undefined) {
        out.push(violation('INV-AUTH', `AUTHENTICATE without an unanswered CHALLENGE on ${where}`, p.event.seq));
        continue;
      }
      const said = typeof p.frame[1] === 'string' ? options.signature?.(p.frame[1]) : undefined;
      if (said?.method !== undefined) {
        if (methods !== undefined && !methods.includes(said.method)) {
          out.push(
            violation('INV-AUTH', `AUTHENTICATE for "${said.method}", which was not offered, on ${where}`, p.event.seq),
          );
        }
        if (said.method !== pending.method || (said.token !== undefined && said.token !== pending.token)) {
          out.push(
            violation(
              'INV-AUTH',
              `AUTHENTICATE answers ${said.method}/${String(said.token)}, not the latest CHALLENGE ${pending.method}/${String(pending.token)}, on ${where}`,
              p.event.seq,
            ),
          );
        }
      }
      pending = undefined; // answered: a second AUTHENTICATE needs a new CHALLENGE
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// INV-CL02 / INV-CANCEL / INV-INVOKE: ids per connection
// ---------------------------------------------------------------------------------------------------------------

const REQUEST_WRITES: ReadonlySet<number> = new Set([
  T.CALL,
  T.PUBLISH,
  T.SUBSCRIBE,
  T.UNSUBSCRIBE,
  T.REGISTER,
  T.UNREGISTER,
]);

interface Outstanding {
  readonly type: number;
  readonly at: number;
  readonly seq: number;
}

export const checkCL02: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const request = timingsOf(options).request;
  for (const socket of index.sockets.values()) {
    const calls = new Set<unknown>();
    const outstanding = new Map<unknown, Outstanding>();
    const subscriptions = new Set<unknown>();
    const registrations = new Set<unknown>();
    const invocations = new Set<unknown>();
    let lastSequential = 0;
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction === 'out') {
        const msg = p.msg;
        if (msg === undefined) continue;
        // an EVENT's or an INVOCATION's id is one the router gave this session as well: the client withdraws a
        // registration it is invoked for but holds no record of (its REGISTERED was lost or given up on)
        if (msg.type === T.SUBSCRIBED || msg.type === T.EVENT) subscriptions.add(msg.subscriptionId);
        else if (msg.type === T.REGISTERED) registrations.add(msg.registrationId);
        else if (msg.type === T.INVOCATION) {
          invocations.add(msg.requestId);
          registrations.add(msg.registrationId);
        }
        if ('requestId' in msg && msg.requestId !== 0) {
          const o = outstanding.get(msg.requestId);
          const final =
            msg.type === T.ERROR ||
            msg.type === T.PUBLISHED ||
            msg.type === T.SUBSCRIBED ||
            msg.type === T.REGISTERED ||
            msg.type === T.UNSUBSCRIBED ||
            msg.type === T.UNREGISTERED ||
            (msg.type === T.RESULT && (msg.details['progress'] !== true || msg.invalid !== undefined));
          if (o !== undefined && final) outstanding.delete(msg.requestId);
        }
        continue;
      }
      const id = p.frame[1];
      const where = `socket ${String(socket.number)}: ${show(p.frame)}`;
      if (REQUEST_WRITES.has(type)) {
        const o = outstanding.get(id);
        if (o !== undefined && (o.type === T.CALL || active(options, o, { seq: p.event.seq, at: p.at }) < request)) {
          out.push(violation('INV-CL02', `request id ${String(id)} is still in flight on ${where}`, p.event.seq));
        }
        if (options.requestIds === 'sequential') {
          if (id !== lastSequential + 1) {
            out.push(
              violation(
                'INV-CL02',
                `sequential id ${String(id)} after ${String(lastSequential)} on ${where}`,
                p.event.seq,
              ),
            );
          }
          if (typeof id === 'number') lastSequential = id;
        }
        if (type === T.CALL) calls.add(id);
        // a CALL is in flight until its final answer or its CANCEL; the probe and acknowledged PUBLISHes may be
        // forgotten without a frame, SUBSCRIBE/REGISTER/UN* at their request timeout
        if (type === T.CALL && !isProbe(p.frame)) outstanding.set(id, { type, at: p.at, seq: p.event.seq });
        else if (type !== T.CALL && type !== T.PUBLISH) outstanding.set(id, { type, at: p.at, seq: p.event.seq });
        if (type === T.UNSUBSCRIBE && !subscriptions.has(p.frame[2])) {
          out.push(violation('INV-CL02', `UNSUBSCRIBE of a subscription id never received on ${where}`, p.event.seq));
        }
        if (type === T.UNREGISTER && !registrations.has(p.frame[2])) {
          out.push(violation('INV-CL02', `UNREGISTER of a registration id never received on ${where}`, p.event.seq));
        }
      } else if (type === T.CANCEL) {
        if (!calls.has(id)) out.push(violation('INV-CL02', `CANCEL of a CALL never written on ${where}`, p.event.seq));
        outstanding.delete(id);
      } else if (type === T.YIELD || (type === T.ERROR && p.frame[1] === T.INVOCATION)) {
        const invocation = type === T.YIELD ? id : p.frame[2];
        if (!invocations.has(invocation)) {
          out.push(violation('INV-CL02', `an answer to an INVOCATION never received on ${where}`, p.event.seq));
        }
      }
    }
  }
  return out;
};

export const checkCancel: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  for (const socket of index.sockets.values()) {
    /** CALL id → state of the latest CALL written with it. */
    const calls = new Map<unknown, { cancels: number; final: boolean }>();
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction === 'out') {
        const msg = p.msg;
        if (msg === undefined) continue;
        const final =
          (msg.type === T.RESULT && (msg.details['progress'] !== true || msg.invalid !== undefined)) ||
          (msg.type === T.ERROR && (msg.requestType === T.CALL || msg.requestType === T.CANCEL));
        if (final && 'requestId' in msg) {
          const call = calls.get(msg.requestId);
          if (call !== undefined) call.final = true;
        }
        continue;
      }
      if (type === T.CALL) calls.set(p.frame[1], { cancels: 0, final: false });
      if (type !== T.CANCEL) continue;
      const where = `socket ${String(socket.number)}: ${show(p.frame)}`;
      if (dict(p.frame[2])['mode'] !== 'killnowait') {
        out.push(violation('INV-CANCEL', `a CANCEL without mode killnowait on ${where}`, p.event.seq));
      }
      const call = calls.get(p.frame[1]);
      if (call === undefined) continue; // INV-CL02
      if (++call.cancels > 1) out.push(violation('INV-CANCEL', `a second CANCEL of one CALL on ${where}`, p.event.seq));
      if (call.final) {
        out.push(
          violation(
            'INV-CANCEL',
            `a CANCEL after the client processed the call's final answer on ${where}`,
            p.event.seq,
          ),
        );
      }
    }
  }
  return out;
};

export const checkInvoke: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  for (const socket of index.sockets.values()) {
    const invocations = new Map<unknown, { progress: boolean; final: boolean; killed: boolean }>();
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction === 'out') {
        const msg = p.msg;
        if (msg?.type === T.INVOCATION) {
          const running = invocations.get(msg.requestId);
          if (running === undefined || running.final || running.killed) {
            invocations.set(msg.requestId, {
              progress: msg.details['receive_progress'] === true,
              final: false,
              killed: false,
            });
          }
        } else if (msg?.type === T.INTERRUPT && msg.options['mode'] === 'killnowait') {
          const running = invocations.get(msg.requestId);
          if (running !== undefined && !running.final) running.killed = true;
        }
        continue;
      }
      const isYield = type === T.YIELD;
      if (!isYield && !(type === T.ERROR && p.frame[1] === T.INVOCATION)) continue;
      const id = isYield ? p.frame[1] : p.frame[2];
      const inv = invocations.get(id);
      if (inv === undefined) continue; // INV-CL02
      const where = `socket ${String(socket.number)}: ${show(p.frame)}`;
      const progress = isYield && dict(p.frame[2])['progress'] === true;
      if (inv.killed)
        out.push(violation('INV-INVOKE', `an answer after INTERRUPT killnowait on ${where}`, p.event.seq));
      if (inv.final) out.push(violation('INV-INVOKE', `an answer after the final one on ${where}`, p.event.seq));
      if (progress && !inv.progress) {
        out.push(violation('INV-INVOKE', `a progress YIELD the INVOCATION did not ask for on ${where}`, p.event.seq));
      }
      if (!progress) inv.final = true;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// INV-ORDER: gate → notify → fail → schedule
// ---------------------------------------------------------------------------------------------------------------

export const checkOrder: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const byStep = new Map<StepId, NotificationEvent[]>();
  for (const n of trace.notifications) {
    if (n.stepId === undefined) continue;
    const list = byStep.get(n.stepId) ?? [];
    list.push(n);
    byStep.set(n.stepId, list);
  }
  const judged = new Set<StepId>();
  for (const end of index.ends) {
    if (end.step === undefined) continue;
    const socket = end.attempt?.socket;
    if (socket !== undefined) {
      for (const p of socket.placed) {
        if (p.event.direction === 'in' && p.step !== undefined && p.step > end.step) {
          out.push(
            violation(
              'INV-ORDER',
              `a frame on socket ${String(socket.number)} after the step that ended it: ${show(p.frame)}`,
              p.event.seq,
            ),
          );
        }
      }
    }
    const notes = byStep.get(end.step) ?? [];
    // the first end of the step is told first: no op/interest failure of the step comes before its first
    // onClose/status (a step can hold two ends: reconnect()'s, then a new attempt that fails at once)
    const firstEnd = !judged.has(end.step);
    judged.add(end.step);
    let firstLifecycle = Infinity;
    for (const n of notes) {
      const o = index.observers.get(n.observer);
      if (o === undefined) continue;
      const v = n.value as (Status & { closed?: unknown }) | CloseInfo | undefined;
      const mine =
        o.stream === 'onClose'
          ? v === end.info
          : o.stream === 'status' &&
            (v as Status | undefined)?.state === 'closed' &&
            (v as { closed?: unknown }).closed === end.info;
      if (mine) firstLifecycle = Math.min(firstLifecycle, n.seq);
    }
    for (const n of notes) {
      const o = index.observers.get(n.observer);
      if (firstEnd && o !== undefined && !isLifecycle(o) && n.notification === 'error' && n.seq < firstLifecycle) {
        out.push(
          violation(
            'INV-ORDER',
            `a ${o.stream} failure delivered before the end's onClose/status (step ${String(end.step)})`,
            n.seq,
          ),
        );
      }
    }
    // the retry timer armed in the end's step fires after both
    const step = index.steps.get(end.step);
    if (step === undefined) continue;
    const next = index.stepList.find((s) => s.seq > step.seq)?.seq ?? Infinity;
    const lastNote = notes.length === 0 ? -Infinity : Math.max(...notes.map((n) => n.seq));
    const armed = new Set<string>();
    for (const t of trace.timers) {
      if (t.action === 'arm' && t.seq > step.seq && t.seq < next) armed.add(`${t.scope}#${String(t.timerId)}`);
      if (t.action === 'fire' && armed.has(`${t.scope}#${String(t.timerId)}`) && t.seq < lastNote) {
        out.push(violation('INV-ORDER', `a timer armed in the end's step fired before its deliveries ran`, t.seq));
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// INV-R1 / INV-R2: never give up; backoff
// ---------------------------------------------------------------------------------------------------------------

/** The primary status observer's values with their events. */
function statusSeq(index: Index): { readonly status: Status; readonly note: NotificationEvent }[] {
  return (index.primaryStatus?.notes ?? [])
    .filter((n) => n.notification === 'next')
    .map((note) => ({ status: note.value as Status, note }));
}

/** Where a notification happened in the core's order: the input seq of the step that queued it. */
function notePos(index: Index, note: NotificationEvent): number {
  return note.stepId === undefined ? note.seq : (index.steps.get(note.stepId)?.seq ?? note.seq);
}

function apiBetween(index: Index, fromSeq: number, toSeq: number, calls: readonly string[]): boolean {
  return index.api.some((a) => !a.resolved && calls.includes(a.call) && a.seq > fromSeq && a.seq < toSeq);
}

function inputBetween(index: Index, fromSeq: number, toSeq: number, input: string): boolean {
  return index.stepList.some((s) => s.input === input && s.seq > fromSeq && s.seq < toSeq);
}

export const checkR1: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const seq = statusSeq(index);
  for (let i = 0; i < seq.length; i++) {
    const { status, note } = seq[i]!;
    if (status.state !== 'closed') continue;
    const next = seq[i + 1];
    if (status.closed?.willRetry === true) {
      if (
        next !== undefined &&
        next.status.state !== 'connecting' &&
        !(next.status.state === 'closed' && next.status.closed?.initiator === 'app')
      ) {
        out.push(
          violation(
            'INV-R1',
            `an end with willRetry is followed by ${next.status.state}, not one connecting`,
            next.note.seq,
          ),
        );
      }
    } else if (
      next?.status.state === 'connecting' &&
      // from the step that queued the end (an open() inside its delivery's re-entrant callback came after it)
      !apiBetween(index, notePos(index, note), next.note.seq, ['open', 'reconnect'])
    ) {
      out.push(
        violation('INV-R1', 'the client started connecting after giving up without open()/reconnect()', next.note.seq),
      );
    }
  }
  // an announced retry comes: the trace may not end long after a willRetry end without the next connecting
  const lastEnd = seq[seq.length - 1];
  const delay = lastEnd?.status.state === 'closed' ? lastEnd.status.closed?.delay : undefined;
  if (
    lastEnd !== undefined &&
    delay !== undefined &&
    lastEnd.status.state === 'closed' &&
    lastEnd.status.closed?.willRetry === true
  ) {
    const waited = active(options, lastEnd.note, traceEnd(index, options));
    // after a backward clock jump the client cannot place the armed retry: an open()/reconnect() may wait one attempt
    // floor of timer time from the call (as in INV-R2)
    const from = notePos(index, lastEnd.note);
    let allowed = delay;
    for (const a of index.api) {
      if (a.resolved || (a.call !== 'open' && a.call !== 'reconnect') || a.seq <= from) continue;
      if ((options.skews ?? []).some((j) => j.ms < 0 && j.seq >= from && j.seq < a.seq))
        allowed = Math.max(allowed, active(options, lastEnd.note, a) + timingsOf(options).attemptFloor);
    }
    if (
      waited > allowed + slack(options, allowed) + 1 &&
      !suspendedBetween(options, lastEnd.note.seq, Number.MAX_SAFE_INTEGER)
    ) {
      out.push(
        violation(
          'INV-R1',
          `no attempt ${String(waited)} ms after an end that announced a retry in ${String(delay)} ms`,
          lastEnd.note.seq,
        ),
      );
    }
  }
  const healed = options.healed;
  if (options.final === true && healed !== undefined) {
    const last = seq[seq.length - 1]?.status;
    const stopped = last?.state === 'closed' && last.closed?.willRetry !== true;
    if (!stopped) {
      const limit = healed.bound + slack(options, healed.bound);
      const opened = seq.some(
        ({ status, note }) =>
          status.state === 'open' && note.seq > healed.seq && active(options, healed, note) <= limit,
      );
      const openAtHeal = (() => {
        let state: string | undefined;
        for (const { status, note } of seq) if (note.seq <= healed.seq) state = status.state;
        return state === 'open';
      })();
      if (!opened && !openAtHeal) {
        const opens = seq
          .filter(({ status }) => status.state === 'open')
          .map(({ note }) => `${String(note.seq)}@${String(note.at)}`);
        out.push(
          violation(
            'INV-R1',
            `not open within ${String(healed.bound)} ms of healing at ${String(healed.seq)}@${String(healed.at)} (last status ${String(last?.state)}; opens ${opens.join(' ')})`,
            healed.seq,
          ),
        );
      }
    }
  }
  return out;
};

export const checkR2: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const t = timingsOf(options);
  const custom = options.retryDelay === 'custom' || options.retryDelay === 'custom-null';
  // delays
  for (const end of index.ends) {
    const { info } = end;
    if (!info.willRetry) continue;
    const d = info.delay;
    if (d === undefined) {
      out.push(violation('INV-R2', 'a willRetry end without a delay', end.seq));
      continue;
    }
    const [min, max] =
      info.initiator === 'app'
        ? [0, t.attemptFloor]
        : custom
          ? [RETRY_FLOOR, MAX_TIMER_DELAY]
          : [RETRY_FLOOR, t.maxRetryDelay];
    if (!(d >= min && d <= max))
      out.push(violation('INV-R2', `delay ${String(d)} outside [${String(min)}, ${String(max)}]`, end.seq));
  }
  // attempt starts: backoff-driven at end + delay, or app-driven and never within the floor of the previous start
  const attempts = index.attempts;
  for (let k = 1; k < attempts.length; k++) {
    const prev = attempts[k - 1]!;
    const cur = attempts[k]!;
    // in the core's order (positions of the steps), since deliveries can lag behind later steps
    const start = eff(options, cur.startPos, cur.startAt);
    const prevStart = eff(options, prev.startPos, prev.startAt);
    // the end that precedes the start (in one step, e.g. reconnect(), the end comes first)
    const end = [...index.ends]
      .reverse()
      .find((e) => e.pos < cur.startPos || (e.pos === cur.startPos && e.seq < cur.startSeq));
    const tol = slack(options, start - prevStart);
    const appDriven =
      end === undefined ||
      apiBetween(index, end.pos, cur.startPos, ['open', 'reconnect']) ||
      inputBetween(index, end.pos, cur.startPos, 'challenge.ok');
    const due =
      end?.info.willRetry === true && end.info.delay !== undefined
        ? eff(options, end.pos, end.at) + end.info.delay
        : undefined;
    const suspended = end !== undefined && suspendedBetween(options, end.pos, cur.startPos);
    const onDue = due !== undefined && (Math.abs(start - due) <= tol || (suspended && start >= due - tol));
    if (appDriven) {
      // the floor is measured with now(): a forward jump the timers did not see counts as elapsed time (the client
      // cannot tell it from a suspend); after a backward jump the client waits a full floor of timer time
      const rawGap = cur.startAt - prev.startAt;
      if (!onDue && start < prevStart + t.attemptFloor - tol && rawGap < t.attemptFloor - tol) {
        out.push(
          violation(
            'INV-R2',
            `an app-driven attempt started ${String(start - prevStart)} ms after the previous one`,
            cur.startSeq,
          ),
        );
      }
      // after a backward jump the client cannot tell how much of the armed retry has elapsed: it may wait one floor
      const from = end?.pos ?? 0;
      const back = (options.skews ?? []).some((j) => j.ms < 0 && j.seq >= from && j.seq < cur.startPos);
      if (due !== undefined && start > due + tol && !suspended && !back) {
        out.push(
          violation(
            'INV-R2',
            `open()/reconnect() postponed a retry due at ${String(due)} to ${String(start)}`,
            cur.startSeq,
          ),
        );
      }
    } else if (!end.info.willRetry) {
      out.push(
        violation('INV-R2', 'an attempt started after a give-up or close() without open()/reconnect()', cur.startSeq),
      );
    } else if (!onDue) {
      out.push(
        violation(
          'INV-R2',
          `the attempt started at ${String(start)}, not delay ${String(end.info.delay)} after its end (${String(due)})`,
          cur.startSeq,
        ),
      );
    }
  }
  // attempt counts: +1 per consecutive failure; reset by reconnect(), open() from CLOSED, close(), give-up, a stable
  // session; never by a socket open
  let counter = 0;
  let stopped = true; // a never-opened client is CLOSED
  // ordered by step position, then by notification (an attempt that fails in the step that started it)
  const events: { seq: number; tie: number; kind: string; end?: (typeof index.ends)[number]; status?: Status }[] = [];
  for (const a of index.api) if (!a.resolved) events.push({ seq: a.seq, tie: a.seq, kind: a.call });
  for (const e of index.ends) events.push({ seq: e.pos, tie: e.seq, kind: 'end', end: e });
  for (const a of index.attempts) {
    const note = index.primaryStatus?.notes.find((n) => n.seq === a.startSeq);
    if (note !== undefined)
      events.push({ seq: a.startPos, tie: a.startSeq, kind: 'connecting', status: note.value as Status });
  }
  for (const s of index.stepList) {
    if (s.input !== 'timer.stable') continue;
    const attempt = s.conn === undefined ? undefined : index.attempts[s.conn - 1];
    const live =
      attempt?.open !== undefined && attempt.open.seq < s.seq && (attempt.end === undefined || attempt.end.seq > s.seq);
    if (live) events.push({ seq: s.seq, tie: s.seq, kind: 'stable' });
  }
  events.sort((a, b) => a.seq - b.seq || a.tie - b.tie);
  for (const e of events) {
    if (e.kind === 'reconnect' || e.kind === 'close' || e.kind === 'stable' || (e.kind === 'open' && stopped))
      counter = 0;
    if (e.kind === 'open' || e.kind === 'reconnect') stopped = false;
    if (e.kind === 'connecting' && e.status?.state === 'connecting' && e.status.attempt !== counter + 1) {
      out.push(
        violation(
          'INV-R2',
          `status connecting shows attempt ${String(e.status.attempt)}, expected ${String(counter + 1)}`,
          e.seq,
        ),
      );
    }
    if (e.kind !== 'end' || e.end === undefined) continue;
    const info = e.end.info;
    if (info.initiator === 'app') {
      if (info.attempt !== 0) out.push(violation('INV-R2', `an app end with attempt ${String(info.attempt)}`, e.seq));
      counter = 0;
    } else {
      counter++;
      if (info.attempt !== counter) {
        out.push(
          violation(
            'INV-R2',
            `end attempt ${String(info.attempt)}, expected ${String(counter)} consecutive failures`,
            e.seq,
          ),
        );
        counter = info.attempt;
      }
    }
    if (!info.willRetry) {
      if (info.initiator !== 'app' && options.maxRetries !== undefined) {
        const giveUp = options.maxRetries + 1;
        const ok = options.retryDelay === 'custom-null' ? info.attempt <= giveUp : info.attempt === giveUp;
        if (!ok)
          out.push(
            violation(
              'INV-R2',
              `gave up after ${String(info.attempt)} attempts with maxRetries ${String(options.maxRetries)}`,
              e.seq,
            ),
          );
      }
      counter = 0;
      stopped = true;
    }
  }
  for (const timer of trace.timers) {
    if (
      timer.action === 'arm' &&
      timer.delay !== undefined &&
      timer.delay > MAX_TIMER_DELAY &&
      timer.scope === (options.scope ?? 'client')
    ) {
      out.push(violation('INV-R2', `a client timer armed for ${String(timer.delay)} ms`, timer.seq));
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// INV-R4 / INV-ESTABLISH / INV-EVENT: interests
// ---------------------------------------------------------------------------------------------------------------

interface InterestRequest {
  readonly kind: 'subscribe' | 'register' | 'unsubscribe' | 'unregister';
  readonly id: unknown;
  readonly key: string;
  /** The topic/procedure of a SUBSCRIBE/REGISTER. */
  readonly uri: unknown;
  readonly at: number;
  readonly pos: number;
  readonly seq: number;
  /** The subscription/registration id it was answered with (SUBSCRIBE/REGISTER) or undoes (UN*). */
  routerId: unknown;
  answered: boolean;
  answeredPos: number;
  /** Answered with an ERROR (an UN* the router refused undid nothing). */
  refused: boolean;
  /** The SUBSCRIBED met an UNSUBSCRIBE of its id in flight (the key subscribes again). */
  resubscribe: boolean;
  /** The UNREGISTER of its id that the REGISTERED met in flight (the router drops the registration: the record
   *  registers again once that UNREGISTER is answered). */
  raced: InterestRequest | undefined;
}

/** Per socket: the interest requests written there, in order, with their answers. */
function interestRequests(socket: SocketRec): InterestRequest[] {
  const requests: InterestRequest[] = [];
  const byId = new Map<unknown, InterestRequest>();
  const unsubscribing = new Map<unknown, InterestRequest>();
  const unregistering = new Map<unknown, InterestRequest>();
  for (const p of socket.placed) {
    const type = typeOf(p.frame);
    if (p.event.direction === 'in') {
      const kind =
        type === T.SUBSCRIBE
          ? 'subscribe'
          : type === T.REGISTER
            ? 'register'
            : type === T.UNSUBSCRIBE
              ? 'unsubscribe'
              : type === T.UNREGISTER
                ? 'unregister'
                : undefined;
      if (kind === undefined) continue;
      const key =
        kind === 'subscribe'
          ? topicKey(p.frame[3], p.frame[2])
          : kind === 'register'
            ? registerKey(p.frame[3], p.frame[2])
            : '';
      const request: InterestRequest = {
        kind,
        id: p.frame[1],
        key,
        uri: kind === 'subscribe' || kind === 'register' ? p.frame[3] : undefined,
        at: p.at,
        pos: p.pos,
        seq: p.event.seq,
        routerId: kind === 'unsubscribe' || kind === 'unregister' ? p.frame[2] : undefined,
        answered: false,
        answeredPos: Infinity,
        refused: false,
        resubscribe: false,
        raced: undefined,
      };
      requests.push(request);
      byId.set(p.frame[1], request);
      if (kind === 'unsubscribe') unsubscribing.set(p.frame[2], request);
      if (kind === 'unregister') unregistering.set(p.frame[2], request);
      continue;
    }
    const msg = p.msg;
    if (msg === undefined || !('requestId' in msg)) continue;
    const request = byId.get(msg.requestId);
    if (request === undefined || request.answered) continue;
    if (msg.type === T.SUBSCRIBED && request.kind === 'subscribe') {
      request.routerId = msg.subscriptionId;
      const pendingUnsub = unsubscribing.get(msg.subscriptionId);
      request.resubscribe = pendingUnsub !== undefined && !pendingUnsub.answered;
    } else if (msg.type === T.REGISTERED && request.kind === 'register') {
      request.routerId = msg.registrationId;
      const pendingUnreg = unregistering.get(msg.registrationId);
      request.raced = pendingUnreg !== undefined && !pendingUnreg.answered ? pendingUnreg : undefined;
    } else if (!(
      (msg.type === T.ERROR &&
        ((request.kind === 'subscribe' && msg.requestType === T.SUBSCRIBE) ||
          (request.kind === 'register' && msg.requestType === T.REGISTER) ||
          (request.kind === 'unsubscribe' && msg.requestType === T.UNSUBSCRIBE) ||
          (request.kind === 'unregister' && msg.requestType === T.UNREGISTER))) ||
      (msg.type === T.UNSUBSCRIBED && request.kind === 'unsubscribe' && !msg.revocation) ||
      (msg.type === T.UNREGISTERED && request.kind === 'unregister' && !msg.revocation)
    )) {
      continue;
    }
    request.answered = true;
    request.answeredPos = p.pos;
    request.refused = msg.type === T.ERROR;
  }
  return requests;
}

/** The ping budget that can be in force after `endsByLiveness` liveness ends (doubled each time, capped). */
function budgetBound(t: Timings, endsByLiveness: number): number {
  let budget = t.ping;
  for (let i = 0; i < endsByLiveness; i++) budget = Math.min(2 * budget, Math.max(PING_BUDGET_CAP, t.ping));
  return budget;
}

function livenessEndsBefore(index: Index, seq: number): number {
  return index.ends.filter(
    (e) => e.seq < seq && (e.info.error as { timer?: unknown } | undefined)?.timer === 'liveness',
  ).length;
}

/** How long a SUBSCRIBE/REGISTER can stay unanswered before its interest errors or the session ends. */
function effectiveRequestTimeout(index: Index, options: CheckOptions, seq: number): number {
  const t = timingsOf(options);
  const verdict = t.idle > 0 ? 2 * budgetBound(t, livenessEndsBefore(index, seq)) : 0;
  return t.request + verdict + GRACE_REARM + slack(options, t.request);
}

export const checkR4: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const t = timingsOf(options);
  const interests = [...index.observers.values()].filter(isInterest);
  // (d) an interest's stream ends only with a router ERROR, a revocation, a request timeout, ConnectionClosedError or
  // the error of a write that can never be sent
  for (const o of interests) {
    const term = o.terminal;
    if (term === undefined) continue;
    if (term.notification === 'complete') {
      out.push(violation('INV-R4', `${o.stream} ${String(o.uri)} completed`, term.seq));
      continue;
    }
    const e = term.value;
    if (options.exempt?.(e) === true) continue;
    if (e instanceof TypeError && term.seq === o.subscribeSeq + 1) continue; // a bad argument, at subscribe
    const code = isThruwayError(e) ? e.code : undefined;
    // a custom serializer's own error when the SUBSCRIBE/REGISTER is written (at op.start or a WELCOME) is passed on
    // unchanged (the key can never be sent, its locals fail; ops/topic.ts `writeFailure`)
    const step = term.stepId === undefined ? undefined : index.steps.get(term.stepId);
    const serializerError = !isThruwayError(e) && (step?.input === 'op.start' || step?.input === 'ws.message');
    const ok =
      serializerError ||
      code === 'wamp_error' ||
      code === 'connection_closed' ||
      (code === 'timeout' && (e as { timer?: unknown }).timer === 'request') ||
      (code === 'protocol' && !isInternal(e));
    if (!ok) out.push(violation('INV-R4', `${o.stream} ${String(o.uri)} ended with ${describe(e)}`, term.seq));
    else if (code === 'wamp_error' && !routerAnswered(index, options, o, term, e)) {
      out.push(
        violation(
          'INV-R4',
          `${o.stream} ${String(o.uri)} ended with ${describe(e)}, but no router ERROR or revocation of its key arrived in that step`,
          term.seq,
        ),
      );
    }
  }
  // ghost window: a re-REGISTER's procedure_already_exists surfaces only after it
  const ghostSince = new Map<string, number>();
  const remembered = new Set<string>();
  for (const attempt of index.attempts) {
    const socket = attempt.socket;
    if (socket === undefined) continue;
    const requests = interestRequests(socket);
    // the client gave up on a request when an interest of its key errored with the request timeout in between (a
    // suspend fires the request timer at once on resume although no active time passed)
    const timedOut = (o: InterestRequest, r: InterestRequest): boolean =>
      interests.some((x) => {
        const term = x.terminal;
        if (term?.notification !== 'error' || keyOf(options, x) !== o.key) return false;
        const e = term.value;
        const code = isThruwayError(e) ? e.code : undefined;
        const pos = notePos(index, term);
        return code === 'timeout' && (e as { timer?: unknown }).timer === 'request' && pos > o.pos && pos < r.pos;
      });
    // (a) never two outstanding SUBSCRIBEs for one key; REGISTERs: no more than the key's live records
    for (const r of requests) {
      if (r.kind !== 'subscribe' && r.kind !== 'register') continue;
      const others = requests.filter(
        (o) =>
          o !== r &&
          o.kind === r.kind &&
          o.key === r.key &&
          o.pos < r.pos &&
          o.answeredPos > r.pos &&
          active(options, o, r) < t.request &&
          !timedOut(o, r),
      );
      if (r.kind === 'subscribe' && others.length > 0) {
        out.push(
          violation('INV-R4', `a second outstanding SUBSCRIBE for ${r.key} on socket ${String(socket.number)}`, r.seq),
        );
      }
      if (r.kind === 'register') {
        const writer = socket.placed.find((p) => p.event.seq === r.seq)?.step;
        const step = writer === undefined ? undefined : index.steps.get(writer);
        const live = interests.filter(
          (o) =>
            o.stream === 'register' &&
            keyOf(options, o) === r.key &&
            (step === undefined ? liveAt(o, r.seq) : liveAtStep(o, step)),
        ).length;
        if (others.length + 1 > Math.max(live, 1)) {
          out.push(
            violation(
              'INV-R4',
              `${String(others.length + 1)} outstanding REGISTERs for ${r.key} with ${String(live)} live record(s)`,
              r.seq,
            ),
          );
        }
      }
    }
    // (b) at the WELCOME, every key with locals and every live register record gets exactly one SUBSCRIBE/REGISTER
    const open = attempt.open;
    if (open?.step !== undefined && options.lostInterests !== true) {
      const welcome = index.steps.get(open.step);
      const endedThere = attempt.end?.step === open.step;
      if (welcome !== undefined && !endedThere) {
        const inStep = requests.filter((r) => socket.placed.some((p) => p.event.seq === r.seq && p.step === open.step));
        // a record that errors in the WELCOME step itself with a write error (its SUBSCRIBE/REGISTER could not be
        // serialized or is over the size limit: "this key can never be sent") is not expected on the wire
        const writeFailed = (o: ObserverRec): boolean => {
          const term = o.terminal;
          if (term?.notification !== 'error' || term.stepId !== open.step) return false;
          const code = (term.value as { code?: unknown } | null | undefined)?.code;
          return code !== 'connection_lost' && code !== 'connection_closed';
        };
        const liveTopics = new Set(
          interests
            .filter((o) => o.stream === 'topic' && liveAtStep(o, welcome) && !writeFailed(o))
            .map((o) => keyOf(options, o)),
        );
        const subs = inStep.filter((r) => r.kind === 'subscribe');
        for (const key of liveTopics) {
          const n = subs.filter((r) => r.key === key).length;
          if (n !== 1)
            out.push(
              violation(
                'INV-R4',
                `${String(n)} SUBSCRIBEs for ${key} at the WELCOME of socket ${String(socket.number)}`,
                welcome.seq,
              ),
            );
        }
        for (const r of subs) {
          if (!liveTopics.has(r.key))
            out.push(violation('INV-R4', `a SUBSCRIBE for ${r.key} (no locals) at the WELCOME`, r.seq));
        }
        const liveRegs = interests.filter((o) => o.stream === 'register' && liveAtStep(o, welcome) && !writeFailed(o));
        const regKeys = new Map<string, number>();
        for (const o of liveRegs) regKeys.set(keyOf(options, o), (regKeys.get(keyOf(options, o)) ?? 0) + 1);
        const regs = inStep.filter((r) => r.kind === 'register');
        for (const [key, n] of regKeys) {
          const m = regs.filter((r) => r.key === key).length;
          if (m !== n)
            out.push(
              violation(
                'INV-R4',
                `${String(m)} REGISTERs for ${key} with ${String(n)} live record(s) at the WELCOME`,
                welcome.seq,
              ),
            );
        }
        for (const r of regs) {
          if (!regKeys.has(r.key))
            out.push(violation('INV-R4', `a REGISTER for ${r.key} (no subscriber) at the WELCOME`, r.seq));
        }
      }
    }
    // (c) at most one UNSUBSCRIBE/UNREGISTER per granted id; an id first seen in an EVENT or an INVOCATION (its
    // SUBSCRIBED/REGISTERED lost or given up on) counts as granted once
    const grants = new Map<string, number>();
    for (const p of socket.placed) {
      const msg = p.msg;
      if (p.event.direction === 'out') {
        if (msg?.type === T.SUBSCRIBED)
          grants.set(`s${String(msg.subscriptionId)}`, (grants.get(`s${String(msg.subscriptionId)}`) ?? 0) + 1);
        if (msg?.type === T.REGISTERED)
          grants.set(`r${String(msg.registrationId)}`, (grants.get(`r${String(msg.registrationId)}`) ?? 0) + 1);
        const seen =
          msg?.type === T.EVENT
            ? `s${String(msg.subscriptionId)}`
            : msg?.type === T.INVOCATION
              ? `r${String(msg.registrationId)}`
              : undefined;
        if (seen !== undefined && !grants.has(seen)) grants.set(seen, 1);
        continue;
      }
      const type = typeOf(p.frame);
      if (type !== T.UNSUBSCRIBE && type !== T.UNREGISTER) continue;
      const k = `${type === T.UNSUBSCRIBE ? 's' : 'r'}${String(p.frame[2])}`;
      const left = (grants.get(k) ?? 0) - 1;
      grants.set(k, left);
      if (left < 0)
        out.push(
          violation(
            'INV-R4',
            `a second UNSUBSCRIBE/UNREGISTER of one id on socket ${String(socket.number)}: ${show(p.frame)}`,
            p.event.seq,
          ),
        );
    }
    // ghost bookkeeping for (d)
    for (const r of requests) {
      if (r.kind !== 'register') continue;
      const answer = socket.placed.find((p) => p.pos === r.answeredPos && p.msg !== undefined);
      if (answer?.msg?.type === T.ERROR && answer.msg.error === Uri.PROCEDURE_ALREADY_EXISTS && remembered.has(r.key)) {
        if (!ghostSince.has(r.key)) ghostSince.set(r.key, eff(options, answer.event.seq, answer.at));
      }
      if (answer?.msg?.type === T.REGISTERED) {
        remembered.delete(r.key);
        ghostSince.delete(r.key);
      }
    }
    // what this session leaves behind as a possible ghost (ops/register.ts `end`)
    for (const r of requests) {
      if (r.kind === 'register' && (!r.answered || r.routerId !== undefined)) {
        const unregistered = requests.some((u) => u.kind === 'unregister' && u.routerId === r.routerId && u.answered);
        if (!unregistered) remembered.add(r.key);
      }
    }
    for (const o of interests) {
      const term = o.terminal;
      if (
        o.stream !== 'register' ||
        term?.notification !== 'error' ||
        (term.value as { uri?: unknown }).uri !== Uri.PROCEDURE_ALREADY_EXISTS
      )
        continue;
      const since = ghostSince.get(keyOf(options, o));
      if (since === undefined) continue;
      const at = eff(options, term.seq, term.at);
      if (
        at - since < GHOST_WINDOW - slack(options, GHOST_WINDOW) &&
        at >= since &&
        term.seq > (attempt.open?.seq ?? Infinity) &&
        (attempt.end?.seq ?? Infinity) > term.seq
      ) {
        out.push(
          violation(
            'INV-R4',
            `procedure_already_exists surfaced ${String(at - since)} ms into the ghost window of ${keyOf(options, o)}`,
            term.seq,
          ),
        );
      }
    }
  }
  return out;
};

/**
 * An interest's error stays "on that stream only" (INV-R4): an interest's WampError is a router's answer to that
 * interest — in the step that delivered it, an ERROR to a SUBSCRIBE/REGISTER of its key with the error's URI, or the
 * revocation of a subscription or registration id the router gave its key — or the client's own refusal of a write that
 * can never be sent (an invalid URI, a frame over the size limit). Traces without steps (recorded at a proxy) are not
 * judged.
 */
function routerAnswered(
  index: Index,
  options: CheckOptions,
  o: ObserverRec,
  term: NotificationEvent,
  e: unknown,
): boolean {
  const uri = (e as { uri?: unknown }).uri;
  if (uri === Uri.INVALID_URI || uri === Uri.PAYLOAD_SIZE_EXCEEDED) return true;
  if (!index.attributed || term.stepId === undefined) return true;
  const topic = o.stream === 'topic';
  const known = options.ops?.get(o.id)?.key;
  const mine = (r: InterestRequest): boolean =>
    r.kind === (topic ? 'subscribe' : 'register') && (known !== undefined ? r.key === known : r.uri === o.uri);
  for (const socket of index.sockets.values()) {
    const placed = socket.placed.filter((p) => p.step === term.stepId && p.event.direction === 'out');
    if (placed.length === 0) continue;
    const requests = interestRequests(socket).filter(mine);
    for (const { msg } of placed) {
      if (msg === undefined) continue;
      if (msg.type === T.ERROR && msg.requestType === (topic ? T.SUBSCRIBE : T.REGISTER)) {
        if (msg.error === uri && requests.some((r) => r.id === msg.requestId)) return true;
      } else if (msg.type === (topic ? T.UNSUBSCRIBED : T.UNREGISTERED) && msg.revocation) {
        const routerId = 'subscriptionId' in msg ? msg.subscriptionId : msg.registrationId;
        if (requests.some((r) => r.routerId === routerId)) return true;
      }
    }
  }
  return false;
}

function isInternal(e: unknown): boolean {
  return isThruwayError(e) && e.code === 'protocol' && e.message === 'internal error';
}

function describe(e: unknown): string {
  if (isThruwayError(e)) return `${e.name}(${e.message})`;
  if (e instanceof Error) return `${e.name}(${e.message})`;
  return String(e);
}

/** INV-ESTABLISH, judged at the end of the trace (the model calls it after every command). */
export const checkEstablish: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  if (options.lostInterests === true) return out;
  const attempt = index.attempts[index.attempts.length - 1];
  if (attempt?.open === undefined || attempt.end !== undefined || attempt.socket === undefined) return out;
  const socket = attempt.socket;
  const end = traceEnd(index, options);
  const limit = effectiveRequestTimeout(index, options, index.lastSeq);
  const requests = interestRequests(socket);
  const interests = [...index.observers.values()].filter((o) => isInterest(o) && liveAt(o, index.lastSeq + 1));
  // a subscription that adopts an outstanding request (a late one, or one whose subscriber left) re-arms its request
  // timer: the wait counts from the later of the write and the newest live subscription of that key
  const newest = new Map<string, { seq: number; at: number }>();
  for (const o of interests) {
    const k = keyOf(options, o);
    const known = newest.get(k);
    if (known === undefined || o.subscribeSeq > known.seq) newest.set(k, { seq: o.subscribeSeq, at: o.subscribeAt });
  }
  const age = (r: InterestRequest): number => {
    const since = newest.get(r.key);
    return active(options, since !== undefined && since.seq > r.seq ? since : r, end);
  };
  const young = (r: InterestRequest): boolean => age(r) <= limit;
  for (const key of new Set(interests.filter((o) => o.stream === 'topic').map((o) => keyOf(options, o)))) {
    const subs = requests.filter((r) => r.kind === 'subscribe' && r.key === key);
    const last = subs[subs.length - 1];
    if (last === undefined) {
      out.push(violation('INV-ESTABLISH', `topic ${key} has locals but no SUBSCRIBE in the established session`));
      continue;
    }
    if (!last.answered) {
      if (!young(last))
        out.push(
          violation(
            'INV-ESTABLISH',
            `topic ${key}: its SUBSCRIBE is unanswered after ${String(age(last))} ms`,
            last.seq,
          ),
        );
      continue;
    }
    if (last.routerId === undefined) continue; // answered with an ERROR: its locals errored (INV-R4)
    const unsub = requests.find(
      (r) => r.kind === 'unsubscribe' && r.routerId === last.routerId && r.pos > last.answeredPos,
    );
    if (unsub !== undefined)
      out.push(violation('INV-ESTABLISH', `topic ${key} has locals but its subscription was UNSUBSCRIBEd`, unsub.seq));
    if (last.resubscribe) {
      const pending = requests.find(
        (r) => r.kind === 'unsubscribe' && r.routerId === last.routerId && r.pos < last.answeredPos,
      );
      if (pending !== undefined && pending.answered && pending.answeredPos < Infinity) {
        out.push(
          violation('INV-ESTABLISH', `topic ${key} did not SUBSCRIBE again after the UNSUBSCRIBE it raced`, last.seq),
        );
      } else if (pending !== undefined && !young(pending)) {
        out.push(
          violation(
            'INV-ESTABLISH',
            `topic ${key} waits for an UNSUBSCRIBE answer for ${String(age(pending))} ms`,
            pending.seq,
          ),
        );
      }
    }
  }
  const regKeys = new Map<string, number>();
  for (const o of interests)
    if (o.stream === 'register') regKeys.set(keyOf(options, o), (regKeys.get(keyOf(options, o)) ?? 0) + 1);
  for (const [key, live] of regKeys) {
    const regs = requests.filter((r) => r.kind === 'register' && r.key === key);
    // only an UNREGISTER written after the REGISTER can remove what the router granted it (one written before, of a
    // stray id the router then hands out, was processed first), and only one the router did not refuse
    const active = regs.filter(
      (r) =>
        r.answered &&
        r.routerId !== undefined &&
        !requests.some((u) => u.kind === 'unregister' && u.routerId === r.routerId && u.pos > r.pos && !u.refused),
    ).length;
    // a REGISTERED that met an UNREGISTER of its id in flight waits for that answer, then registers again
    const pending = regs.filter(
      (r) => (!r.answered && young(r)) || (r.raced !== undefined && !r.raced.answered && young(r.raced)),
    ).length;
    const stale = regs.filter((r) => !r.answered && !young(r));
    const ghostly = regs.some((r) => {
      const answer = socket.placed.find((p) => p.pos === r.answeredPos);
      return (
        answer?.msg?.type === T.ERROR &&
        answer.msg.error === Uri.PROCEDURE_ALREADY_EXISTS &&
        age(r) <= GHOST_WINDOW + 30000 + limit
      );
    });
    if (active + pending < live && !ghostly) {
      out.push(
        violation(
          'INV-ESTABLISH',
          `register ${key}: ${String(live)} live record(s), ${String(active)} active, ${String(pending)} pending${stale.length > 0 ? `, ${String(stale.length)} unanswered too long` : ''}`,
        ),
      );
    }
  }
  return out;
};

export const checkEvent: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const topics = [...index.observers.values()].filter((o) => o.stream === 'topic');
  const nextByStep = new Map<StepId, NotificationEvent[]>();
  for (const o of topics) {
    for (const n of o.notes) {
      if (n.notification !== 'next' || n.stepId === undefined) continue;
      const list = nextByStep.get(n.stepId) ?? [];
      list.push(n);
      nextByStep.set(n.stepId, list);
    }
  }
  for (const attempt of index.attempts) {
    const socket = attempt.socket;
    if (socket === undefined) continue;
    const requests = interestRequests(socket).filter((r) => r.kind === 'subscribe' || r.kind === 'unsubscribe');
    for (const p of socket.placed) {
      const msg = p.msg;
      if (p.event.direction !== 'out' || msg?.type !== T.EVENT || p.step === undefined || !beforeEnd(attempt, p))
        continue;
      const step = index.steps.get(p.step);
      if (step === undefined) continue;
      // keys mapped to the subscription id at receive time: their latest SUBSCRIBE was answered with it (not while
      // its UNSUBSCRIBE was in flight), and no UNSUBSCRIBE of it was written since
      const mapped = new Set<string>();
      const latest = new Map<string, InterestRequest>();
      for (const r of requests) if (r.kind === 'subscribe' && r.pos < p.pos) latest.set(r.key, r);
      for (const [key, r] of latest) {
        if (!r.answered || r.answeredPos > p.pos || r.routerId !== msg.subscriptionId || r.resubscribe) continue;
        const undone = requests.some(
          (u) =>
            u.kind === 'unsubscribe' && u.routerId === msg.subscriptionId && u.pos > r.answeredPos && u.pos < p.pos,
        );
        if (!undone) mapped.add(key);
      }
      const expected = topics.filter((o) => mapped.has(keyOf(options, o)) && liveAtStep(o, step));
      const got = nextByStep.get(p.step) ?? [];
      const valid = msg.invalid === undefined;
      for (const o of expected) {
        const mine = got.filter((n) => n.observer === o.id);
        const goneBefore = (o.unsubscribeSeq ?? Infinity) < (mine[0]?.seq ?? Infinity) && mine.length === 0;
        const terminatedBefore = o.terminal !== undefined && o.terminal.seq < step.seq;
        if (!valid) {
          if (mine.length > 0)
            out.push(
              violation('INV-EVENT', `an invalid EVENT was delivered to observer ${String(o.id)}`, mine[0]?.seq),
            );
          continue;
        }
        if (mine.length > 1)
          out.push(
            violation(
              'INV-EVENT',
              `an EVENT delivered ${String(mine.length)} times to observer ${String(o.id)}`,
              p.event.seq,
            ),
          );
        if (
          mine.length === 0 &&
          !goneBefore &&
          !terminatedBefore &&
          (o.unsubscribeSeq === undefined || o.unsubscribeSeq > index.lastSeq)
        ) {
          // it may have unsubscribed during an earlier delivery of the same step
          const unsubscribedInStep = o.unsubscribeSeq !== undefined;
          if (!unsubscribedInStep)
            out.push(
              violation(
                'INV-EVENT',
                `an EVENT (subscription ${String(msg.subscriptionId)}) not delivered to observer ${String(o.id)} (${keyOf(options, o)})`,
                p.event.seq,
              ),
            );
        }
        for (const n of mine) {
          const value = n.value as { args?: unknown; kwargs?: unknown };
          if (
            JSON.stringify(value.args) !== JSON.stringify(msg.args) ||
            JSON.stringify(value.kwargs) !== JSON.stringify(msg.kwargs)
          ) {
            out.push(violation('INV-EVENT', `observer ${String(o.id)} got another payload than the EVENT's`, n.seq));
          }
        }
      }
      for (const n of got) {
        if (!expected.some((o) => o.id === n.observer)) {
          out.push(
            violation(
              'INV-EVENT',
              `an EVENT (subscription ${String(msg.subscriptionId)}) delivered to observer ${String(n.observer)}, not a local of a key mapped to it`,
              n.seq,
            ),
          );
        }
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// INV-R5 / INV-R6: one-shot ops and typed errors
// ---------------------------------------------------------------------------------------------------------------

/** The op.start step of an op observer: the first input after its subscription, when that is an op.start. */
function startStep(index: Index, o: ObserverRec): Step | undefined {
  const step = index.stepList.find((s) => s.seq > o.subscribeSeq);
  return step?.input === 'op.start' && !(o.terminal !== undefined && o.terminal.seq < step.seq) ? step : undefined;
}

/** Was the client stopped (closed by the app or given up, not reopened) just before `seq`? */
function stoppedAt(index: Index, seq: number): boolean {
  let stopped = false;
  const events: { seq: number; kind: 'stop' | 'go' }[] = [];
  for (const a of index.api) {
    if (a.resolved || a.seq >= seq) continue;
    events.push({ seq: a.seq, kind: a.call === 'close' ? 'stop' : 'go' });
  }
  // an end stops the client where its step ran (an open() re-entered from its delivery comes after it)
  for (const e of index.ends) if (e.pos < seq && !e.info.willRetry) events.push({ seq: e.pos, kind: 'stop' });
  events.sort((a, b) => a.seq - b.seq);
  for (const e of events) stopped = e.kind === 'stop';
  return stopped;
}

export const checkR5: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const tagOf = options.tagOf ?? defaultTagOf;
  const ops = [...index.observers.values()].filter(isOp);
  // where each tagged op's request went
  const writes = new Map<string, { socket: SocketRec; placed: Placed; attempt: Attempt | undefined }[]>();
  for (const attempt of index.attempts) {
    const socket = attempt.socket;
    if (socket === undefined) continue;
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction !== 'in' || (type !== T.CALL && type !== T.PUBLISH)) continue;
      const tag = tagOf(p.frame);
      if (tag === undefined) continue;
      const list = writes.get(tag) ?? [];
      list.push({ socket, placed: p, attempt });
      writes.set(tag, list);
    }
  }
  for (const o of ops) {
    const notes = o.notes;
    const terminals = notes.filter((n) => n.notification !== 'next');
    if (terminals.length > 1)
      out.push(violation('INV-R5', `op ${String(o.id)} settled ${String(terminals.length)} times`, terminals[1]?.seq));
    const term = o.terminal;
    if (term !== undefined && notes.some((n) => n.seq > term.seq))
      out.push(violation('INV-R5', `op ${String(o.id)} notified after it settled`, term.seq));
    const info = options.ops?.get(o.id);
    const start = startStep(index, o);
    // an op started while stopped errors in its own step
    if (start !== undefined && stoppedAt(index, start.seq)) {
      if (
        term?.notification !== 'error' ||
        term.stepId !== start.id ||
        !(isThruwayError(term.value) && term.value.code === 'connection_closed')
      ) {
        out.push(
          violation(
            'INV-R5',
            `op ${String(o.id)} started while stopped did not error ConnectionClosedError in its own step`,
            start.seq,
          ),
        );
      }
    }
    const tag = info?.tag;
    if (tag === undefined) continue;
    const mine = writes.get(tag) ?? [];
    if (mine.length > 1)
      out.push(
        violation(
          'INV-R5',
          `op ${String(o.id)} (${tag}) was written ${String(mine.length)} times`,
          mine[1]?.placed.event.seq,
        ),
      );
    const write = mine[0];
    if (write === undefined) {
      // waiting: written in the first WELCOME after its start unless it settled or left before
      if (start === undefined) continue;
      for (const attempt of index.attempts) {
        const open = attempt.open;
        if (open?.step === undefined) continue;
        const welcome = index.steps.get(open.step);
        if (welcome === undefined || welcome.seq < start.seq || !liveAtStep(o, welcome)) continue;
        if (attempt.end?.step === open.step) continue; // the write was refused: still waiting
        if (o.terminal?.stepId === open.step) break; // its write failed there (serializer, size): it errored instead
        out.push(
          violation(
            'INV-R5',
            `op ${String(o.id)} (${tag}) waited but was not written at the WELCOME of socket ${String(attempt.socket?.number)}`,
            welcome.seq,
          ),
        );
        break;
      }
      continue;
    }
    // in flight at an end: errors in the end's step, Lost iff the client retries
    if (info?.kind === 'publish' && info.ack !== true) continue;
    const { socket, placed, attempt } = write;
    const end = attempt?.end;
    if (end?.step === undefined) continue;
    const id = placed.frame[1];
    const answered = socket.placed.some(
      (p) =>
        p.event.direction === 'out' &&
        p.pos > placed.pos &&
        beforeEnd(attempt, p) &&
        p.msg !== undefined &&
        'requestId' in p.msg &&
        p.msg.requestId === id &&
        (p.msg.type === T.ERROR ||
          p.msg.type === T.PUBLISHED ||
          (p.msg.type === T.RESULT && (p.msg.details['progress'] !== true || p.msg.invalid !== undefined))),
    );
    const endStep = index.steps.get(end.step);
    // unsubscribed before the end, or before the end's error was delivered (the kit drops it then)
    const left =
      (o.unsubscribeSeq ?? Infinity) < (endStep?.seq ?? Infinity) ||
      (term === undefined && o.unsubscribeSeq !== undefined);
    const settledBefore =
      term !== undefined && endStep !== undefined && term.seq < endStep.seq && term.stepId !== end.step;
    if (answered || left || settledBefore) continue;
    const e = term?.value;
    const closing = end.info.initiator === 'app' && !end.info.willRetry;
    const expected = end.info.willRetry
      ? isThruwayError(e) && e.code === 'connection_lost'
      : closing
        ? isThruwayError(e) && e.code === 'connection_closed' && !e.gaveUp
        : // a contained fault in the give-up's own end procedure fails it with the stop's error (hardReset)
          isThruwayError(e) &&
          e.code === 'connection_closed' &&
          e.gaveUp &&
          (isLostCause(e) || options.faults === true);
    if (term?.notification !== 'error' || term.stepId !== end.step || !expected) {
      out.push(
        violation(
          'INV-R5',
          `op ${String(o.id)} (${tag}) in flight at the end of socket ${String(socket.number)} got ${term === undefined ? 'nothing' : `${term.notification} ${describe(term.value)} in step ${String(term.stepId)}`}, not the end's ${end.info.willRetry ? 'ConnectionLostError' : 'ConnectionClosedError'} in step ${String(end.step)}`,
          term?.seq ?? end.seq,
        ),
      );
    }
  }
  // close() and a give-up settle every op still live in their step (waiting, in flight, and one a participant lost), so
  // after close() resolves nothing that was there at its call is unsettled
  const stops: Step[] = index.stepList.filter((st) => st.input === 'close');
  for (const end of index.ends) {
    const st = end.step === undefined ? undefined : index.steps.get(end.step);
    if (!end.info.willRetry && end.info.initiator !== 'app' && st !== undefined) stops.push(st);
  }
  for (const st of stops) {
    // an end with a retry earlier in the same step (reconnect(), whose next attempt failed at once and gave up) lost
    // what was in flight then: ConnectionLostError from that end is the answer for those ops
    const lossFirst = index.ends.some((e) => e.step === st.id && e.info.willRetry);
    const stopEnd = index.ends.find((e) => e.step === st.id && !e.info.willRetry);
    for (const o of ops) {
      if (!liveAtStep(o, st)) continue;
      const term = o.terminal;
      if (term === undefined && o.unsubscribeSeq !== undefined) continue; // unsubscribed before the delivery ran
      // settled earlier in the give-up's own step, before its end was announced (deliveries run in queue order): an
      // unacknowledged PUBLISH completes when it is written, then a contained fault after the write gives up
      if (term !== undefined && stopEnd !== undefined && term.stepId === st.id && term.seq < stopEnd.seq) continue;
      const code = isThruwayError(term?.value) ? term.value.code : undefined;
      const closed = code === 'connection_closed' || (lossFirst && code === 'connection_lost');
      if (term?.notification !== 'error' || term.stepId !== st.id || !closed) {
        const got =
          term === undefined
            ? 'nothing'
            : `${term.notification} ${describe(term.value)} in step ${String(term.stepId)}`;
        const what = st.input === 'close' ? 'close()' : 'give-up';
        out.push(
          violation(
            'INV-R5',
            `op ${String(o.id)} (${String(o.uri)}) live at the ${what} of step ${String(st.id)} got ${got}`,
            st.seq,
          ),
        );
      }
    }
  }
  return out;
};

function isLostCause(e: unknown): boolean {
  const cause: unknown = (e as { cause?: unknown }).cause;
  return isThruwayError(cause) && cause.code === 'connection_lost';
}

const CODE_OF_NAME: Readonly<Record<string, string>> = {
  WampError: 'wamp_error',
  ConnectionLostError: 'connection_lost',
  ConnectionClosedError: 'connection_closed',
  TimeoutError: 'timeout',
  AbortError: 'abort',
  ProtocolError: 'protocol',
  CanceledError: 'canceled',
  AuthenticationError: 'authentication',
};

export const checkR6: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  for (const o of index.observers.values()) {
    for (const n of o.notes) {
      if (n.notification !== 'error') continue;
      const e = n.value;
      if (options.exempt?.(e) === true) continue;
      if (e instanceof TypeError && n.seq === o.subscribeSeq + 1) continue; // a deliberate invalid input
      if (e instanceof RangeError) continue; // the async iterator's buffer cap
      if (!isThruwayError(e) || CODE_OF_NAME[e.name] !== e.code) {
        out.push(
          violation('INV-R6', `${o.stream} observer ${String(o.id)} got ${describe(e)}, not a typed error`, n.seq),
        );
        continue;
      }
      if (isOp(o) && e.code === 'connection_lost' && !isInternalLoss(e)) {
        const lost = e;
        const where = lost.procedure ?? lost.topic;
        if (lost.sessionId === undefined || lost.requestId === undefined || where === undefined) {
          out.push(
            violation(
              'INV-R6',
              `a ConnectionLostError of op ${String(o.id)} without sessionId/requestId/procedure|topic`,
              n.seq,
            ),
          );
        }
      }
    }
  }
  for (const end of index.ends) {
    const e = end.info.error;
    if (end.info.initiator === 'app' && e !== undefined)
      out.push(violation('INV-R6', 'an app end with an error', end.seq));
    if (end.info.initiator === 'connection' && e === undefined)
      out.push(violation('INV-R6', 'a connection end without an error', end.seq));
    if (e === undefined) continue;
    if (!isThruwayError(e) || CODE_OF_NAME[e.name] !== e.code)
      out.push(violation('INV-R6', `CloseInfo.error ${describe(e)} is not a typed error`, end.seq));
    if (typeof (e as { attempt?: unknown }).attempt !== 'number')
      out.push(violation('INV-R6', `CloseInfo.error ${describe(e)} has no attempt`, end.seq));
  }
  return out;
};

/** hardReset's ConnectionLostError: no request id (participant state is untrusted; the one INV-R6 exception). */
function isInternalLoss(e: ThruwayError): boolean {
  return isInternal((e as { cause?: unknown }).cause);
}

// ---------------------------------------------------------------------------------------------------------------
// INV-R7 / INV-R9 / INV-R10: lifecycle streams, close(), late events
// ---------------------------------------------------------------------------------------------------------------

function stateOf(s: Status): string {
  if (s.state !== 'closed') return s.state;
  if (s.closed === undefined) return 'closed()';
  return s.closed.willRetry ? 'closed{willRetry}' : `closed{${s.closed.initiator}}`;
}

/** Was a session established just before `seq` (by step order)? */
function openAt(index: Index, seq: number): boolean {
  for (const attempt of index.attempts) {
    const open = attempt.open;
    if (open === undefined) continue;
    const openStep = open.step === undefined ? open.seq : (index.steps.get(open.step)?.seq ?? open.seq);
    const endStep =
      attempt.end?.step === undefined
        ? (attempt.end?.seq ?? Infinity)
        : (index.steps.get(attempt.end.step)?.seq ?? Infinity);
    if (openStep < seq && seq <= endStep) return true;
  }
  return false;
}

export const checkR7: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  for (const o of index.observers.values()) {
    if (!isLifecycle(o)) continue;
    for (const n of o.notes) {
      if (n.notification !== 'next')
        out.push(violation('INV-R7', `${o.stream} observer ${String(o.id)} got ${n.notification}`, n.seq));
    }
    const first = o.notes[0];
    if (o.stream === 'status') {
      if (first?.seq !== o.subscribeSeq + 1)
        out.push(
          violation(
            'INV-R7',
            `status observer ${String(o.id)} got no value synchronously on subscribe`,
            o.subscribeSeq,
          ),
        );
      const values = o.notes.filter((n) => n.notification === 'next');
      for (let i = 1; i < values.length; i++) {
        const a = values[i - 1]!.value as Status;
        const b = values[i]!.value as Status;
        const ok =
          (a.state === 'connecting' && (b.state === 'open' || b.state === 'closed')) ||
          (a.state === 'open' && b.state === 'closed') ||
          (a.state === 'closed' &&
            a.closed?.willRetry === true &&
            (b.state === 'connecting' || (b.state === 'closed' && b.closed?.initiator === 'app'))) ||
          (a.state === 'closed' && a.closed?.willRetry !== true && b.state === 'connecting');
        if (!ok)
          out.push(
            violation('INV-R7', `status observer ${String(o.id)} moved ${stateOf(a)} → ${stateOf(b)}`, values[i]!.seq),
          );
      }
    } else if (o.stream === 'onOpen') {
      const synchronous = first?.seq === o.subscribeSeq + 1;
      const open = openAt(index, o.subscribeSeq);
      if (synchronous !== open) {
        out.push(
          violation(
            'INV-R7',
            `onOpen observer ${String(o.id)} ${synchronous ? 'replayed a session while not open' : 'did not replay the open session'}`,
            o.subscribeSeq,
          ),
        );
      }
    }
  }
  // each end ⇒ exactly one onClose per observer subscribed then
  const onCloses = [...index.observers.values()].filter((o) => o.stream === 'onClose');
  for (const end of index.ends) {
    const step = end.step === undefined ? undefined : index.steps.get(end.step);
    const at = step?.seq ?? end.seq;
    for (const o of onCloses) {
      const got = o.notes.filter((n) => n.value === end.info).length;
      const subscribed = o.subscribeSeq < at;
      const left = o.unsubscribeSeq !== undefined && o.unsubscribeSeq < at;
      if (subscribed && !left && got !== 1 && !(got === 0 && o.unsubscribeSeq !== undefined)) {
        out.push(violation('INV-R7', `onClose observer ${String(o.id)} got an end ${String(got)} times`, end.seq));
      }
      if (!subscribed && got > 0)
        out.push(violation('INV-R7', `onClose observer ${String(o.id)} got an end from before it subscribed`, end.seq));
    }
  }
  return out;
};

export const checkR9: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const scope = options.scope ?? 'client';
  const api = index.api.filter((a) => !a.resolved);
  // close() called k times ⇒ one onClose
  for (let i = 0; i < api.length; i++) {
    const call = api[i]!;
    if (call.call !== 'close') continue;
    const next = api.slice(i + 1).find((a) => a.call !== 'close')?.seq ?? Infinity;
    if (api[i - 1]?.call === 'close') continue; // judged at the first close() of the burst
    // in the core's order: an open() re-entered from the end's own delivery is after the end
    const appEnds = index.ends.filter(
      (e) => e.pos > call.seq && e.pos < next && e.info.initiator === 'app' && !e.info.willRetry,
    );
    if (appEnds.length > 1)
      out.push(violation('INV-R9', `close() produced ${String(appEnds.length)} onClose`, call.seq));
    const activeAttempt = index.attempts.some(
      (a) => a.startPos < call.seq && (a.end === undefined || a.end.pos > call.seq),
    );
    if (activeAttempt && appEnds.length !== 1)
      out.push(violation('INV-R9', `close() of an active client produced ${String(appEnds.length)} onClose`, call.seq));
  }
  // each close() promise: the connections that existed at its call are done, timers cleared, no frame after
  for (const resolved of index.api.filter((a) => a.call === 'close' && a.resolved)) {
    const calls = api.filter((a) => a.call === 'close' && a.seq < resolved.seq);
    const call = calls[calls.length - 1];
    if (call === undefined) continue;
    const reopen = api.find((a) => a.call !== 'close' && a.seq > call.seq)?.seq ?? Infinity;
    const pending = new Map<string, TimerEvent>();
    for (const timer of trace.timers) {
      if (timer.seq > resolved.seq || timer.scope !== scope) continue;
      const k = `${timer.scope}#${String(timer.timerId)}`;
      if (timer.action === 'arm') pending.set(k, timer);
      else pending.delete(k);
    }
    for (const timer of pending.values()) {
      if (timer.seq < reopen) {
        out.push(
          violation(
            'INV-R9',
            `a client timer (armed at seq ${String(timer.seq)}) is still pending when close() resolved`,
            resolved.seq,
          ),
        );
      }
    }
    for (const attempt of index.attempts) {
      if (attempt.startSeq > call.seq || attempt.socket === undefined) continue;
      for (const p of attempt.socket.placed) {
        if (p.event.direction === 'in' && p.event.seq > resolved.seq) {
          out.push(
            violation(
              'INV-R9',
              `a frame on socket ${String(attempt.socket.number)} after close() resolved: ${show(p.frame)}`,
              p.event.seq,
            ),
          );
        }
      }
    }
  }
  // open() after close() reaches open on a new connection whose first frame is HELLO
  if (options.final === true) {
    const lastClose = [...api].reverse().find((a) => a.call === 'close');
    const reopen = lastClose === undefined ? undefined : api.find((a) => a.seq > lastClose.seq && a.call !== 'close');
    if (reopen !== undefined && !(options.healed === undefined)) {
      const opened = index.attempts.find((a) => a.startSeq > reopen.seq && a.open !== undefined);
      const last = statusSeq(index).at(-1)?.status;
      const gaveUp = last?.state === 'closed' && last.closed?.willRetry === false;
      if (opened === undefined && !gaveUp)
        out.push(violation('INV-R9', 'open() after close() never reached open', reopen.seq));
      const first = opened?.socket?.placed.find((p) => p.event.direction === 'in');
      if (first !== undefined && typeOf(first.frame) !== T.HELLO)
        out.push(violation('INV-R9', 'the first frame after reopening is not HELLO', first.event.seq));
    }
  }
  return out;
};

export const checkR10: Checker = (trace) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const queuedBy = new Map<StepId, number>();
  for (const d of trace.deliveries) if (d.phase === 'queued') queuedBy.set(d.stepId, (queuedBy.get(d.stepId) ?? 0) + 1);
  const framesBy = new Map<StepId, number>();
  for (const f of trace.frames)
    if (f.direction === 'in' && f.stepId !== undefined) framesBy.set(f.stepId, (framesBy.get(f.stepId) ?? 0) + 1);
  for (const step of index.stepList) {
    const transport =
      step.input.startsWith('ws.') ||
      step.input.startsWith('timer.') ||
      step.input.startsWith('url.') ||
      step.input.startsWith('handler.');
    if (!transport || step.conn === undefined || step.conn === 0) continue;
    const attempt = index.attempts[step.conn - 1];
    const ended = attempt?.end?.step !== undefined && attempt.end.step < step.id;
    if (!ended) continue;
    const frames = framesBy.get(step.id) ?? 0;
    const deliveries = queuedBy.get(step.id) ?? 0;
    if (frames > 0 || deliveries > 0) {
      out.push(
        violation(
          'INV-R10',
          `${step.input} of ended connection ${String(step.conn)} wrote ${String(frames)} frame(s) and queued ${String(deliveries)} delivery(ies)`,
          step.seq,
        ),
      );
    }
  }
  return out;
};

/** INV-R10's quiescence part, over the client's debug probe (`client[Symbol.for('thruway.js.debug')]()`). */
export function checkDebugProbe(
  debug: {
    readonly state: string;
    readonly inputs: number;
    readonly deliveries: number;
    readonly registry: number;
    readonly queued: number;
    readonly currentConnection: number | undefined;
    readonly participants: Readonly<Record<string, Readonly<Record<string, number>>>>;
  },
  expected: { readonly liveSubscriptions?: number | undefined },
): readonly InvariantViolation[] {
  const out: InvariantViolation[] = [];
  if (debug.inputs !== 0 || debug.deliveries !== 0) {
    out.push(
      violation(
        'INV-R10',
        `queues not empty at quiescence: ${String(debug.inputs)} input(s), ${String(debug.deliveries)} delivery(ies)`,
      ),
    );
  }
  for (const [name, sizes] of Object.entries(debug.participants)) {
    const late = sizes['late'];
    if (late !== undefined && late > 1024) out.push(violation('INV-R10', `${name}: ${String(late)} late requests`));
    if (debug.state !== 'ESTABLISHED') {
      for (const key of ['inFlight', 'requests', 'invocations', 'routerIds', 'deferred', 'ghostTimers', 'probes']) {
        const n = sizes[key];
        if (n !== undefined && n > 0) out.push(violation('INV-R10', `${name}.${key} = ${String(n)} without a session`));
      }
    }
  }
  if (expected.liveSubscriptions !== undefined && debug.registry !== expected.liveSubscriptions) {
    out.push(
      violation(
        'INV-R10',
        `the registry holds ${String(debug.registry)} entries for ${String(expected.liveSubscriptions)} live subscriptions`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// INV-LIVE: half-open detection
// ---------------------------------------------------------------------------------------------------------------

export const checkLive: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const t = timingsOf(options);
  if (t.idle <= 0) return out;
  let unsupported = false;
  let budget = t.ping;
  const logs = trace.logs;
  for (const attempt of index.attempts) {
    const socket = attempt.socket;
    const open = attempt.open;
    if (socket === undefined || open === undefined) continue;
    const startSeq = open.step === undefined ? open.seq : (index.steps.get(open.step)?.seq ?? open.seq);
    const endSeq =
      attempt.end?.step === undefined
        ? (attempt.end?.seq ?? Infinity)
        : (index.steps.get(attempt.end.step)?.seq ?? Infinity);
    // up to the end itself: the probe failure that ends a session can turn liveness off in that same step
    const sessionLogs = logs.filter((l) => l.seq > startSeq && l.seq < (attempt.end?.seq ?? Infinity));
    const offAt =
      sessionLogs.find(
        (l) =>
          l.entry.event === 'liveness.unsupported' ||
          (l.entry.event === 'option.fallback' && l.entry.message.includes('no dealer role')),
      )?.seq ?? Infinity;
    const roles = dict(open.session.details.roles);
    const names = Object.keys(roles);
    const noDealer = names.length > 0 && !names.includes('dealer');
    const enabled = !unsupported && !noDealer && options.buffered !== true;
    if (offAt !== Infinity && sessionLogs.some((l) => l.seq === offAt && l.entry.event === 'liveness.unsupported'))
      unsupported = true;
    if (!enabled) {
      if (
        attempt.end !== undefined &&
        (attempt.end.info.error as { timer?: unknown } | undefined)?.timer === 'liveness'
      )
        budget = Math.min(2 * budget, Math.max(PING_BUDGET_CAP, t.ping));
      continue;
    }
    const until = Math.min(endSeq, offAt);
    const offLog = offAt === Infinity ? undefined : logs.find((l) => l.seq === offAt);
    const endAt =
      offLog !== undefined
        ? eff(options, offLog.seq, offLog.at)
        : attempt.end === undefined
          ? eff(options, Number.MAX_SAFE_INTEGER, options.now ?? index.lastAt)
          : eff(options, attempt.end.seq, attempt.end.at);
    const inbound: { seq: number; at: number; msg: InboundMessage }[] = [];
    /** Each probe with the budget its ping timer got (the client's budget when it was written). */
    const probes: {
      seq: number;
      at: number;
      id: unknown;
      answeredAt: number | undefined;
      answeredSeq: number;
      budget: number;
    }[] = [];
    const sessionBudget = budget;
    const welcomeAt = eff(options, startSeq, open.at);
    for (const p of socket.placed) {
      const pseq = p.pos;
      if (pseq < startSeq || pseq >= until) continue;
      if (p.event.direction === 'out' && p.msg !== undefined) {
        inbound.push({ seq: p.event.seq, at: eff(options, pseq, stepOf(index, p)?.at ?? p.at), msg: p.msg });
        const probe = probes.find(
          (x) =>
            x.answeredAt === undefined &&
            'requestId' in p.msg! &&
            p.msg.requestId === x.id &&
            (p.msg.type === T.RESULT ||
              (p.msg.type === T.ERROR && (p.msg.requestType === T.CALL || p.msg.requestType === T.CANCEL))),
        );
        if (probe !== undefined) {
          probe.answeredAt = eff(options, pseq, p.at);
          probe.answeredSeq = p.event.seq;
          if (probe.answeredAt - probe.at <= t.ping) budget = t.ping;
        }
      } else if (p.event.direction === 'in' && isProbe(p.frame)) {
        probes.push({
          seq: p.event.seq,
          at: eff(options, p.event.seq, p.at),
          id: p.frame[1],
          answeredAt: undefined,
          answeredSeq: Infinity,
          budget,
        });
      }
    }
    const eps = slack(options, t.idle) + 1;
    const replies = inbound.filter((i) => isReply(i.msg));
    // silence: after each inbound frame (and the WELCOME), a probe within idle + ε, unless a probe was pending then;
    // an unanswered probe lets the session survive at most its budget past it (plus a deadline's grace after a clock
    // jump), or a re-probe's budget past that when the router proved alive meanwhile
    const marks = [{ seq: startSeq, at: welcomeAt }, ...inbound.map((i) => ({ seq: i.seq, at: i.at }))];
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]!;
      const nextAt = marks[i + 1]?.at ?? endAt;
      const nextSeq = marks[i + 1]?.seq ?? Math.min(until, index.lastSeq + 1);
      if (nextAt - mark.at <= t.idle + eps) continue;
      if (suspendedBetween(options, mark.seq, nextSeq)) continue;
      const pendingProbe = probes.find(
        (x) => x.seq < mark.seq && (x.answeredAt === undefined || x.answeredAt > mark.at),
      );
      // the probe that answers for this silence: one pending at the mark, or the first written within idle of it
      const probed = probes.find((x) => x.at > mark.at - eps && x.at <= mark.at + t.idle + eps && x.seq > mark.seq - 1);
      const first = pendingProbe ?? probed;
      if (first !== undefined) {
        const grace = jumped(options, first.seq, nextSeq) ? GRACE_REARM : 0;
        // a reply to a request written after the probe proves the router works, so the unanswered probe is 'alive' at
        // its deadline and the client probes again: the newest such re-probe is the one judged (proven by its deadline:
        // the probe is dropped as 'alive', and the next one follows the ordinary idle cadence — at the deadline when
        // the idle deadline already passed, else idle after the last inbound frame)
        let probe = first;
        for (;;) {
          const from = probe;
          const deadline = from.at + from.budget + grace + eps;
          const again = probes.find((x) => {
            if (x.seq <= from.seq || x.at > nextAt) return false;
            const lastIn = Math.max(welcomeAt, ...inbound.filter((i) => i.seq < x.seq).map((i) => i.at));
            return (
              x.at <= Math.max(deadline, lastIn + t.idle + grace + eps) &&
              provenAfter(socket, replies, from.seq, x.seq, deadline)
            );
          });
          if (again === undefined) break;
          probe = again;
        }
        if (nextAt - probe.at > probe.budget + grace + eps + t.idle) {
          out.push(
            violation(
              'INV-LIVE',
              `socket ${String(socket.number)}: a pending probe kept a silent session ${String(nextAt - probe.at)} ms past it`,
              mark.seq,
            ),
          );
        }
        continue;
      }
      out.push(
        violation(
          'INV-LIVE',
          `socket ${String(socket.number)}: no probe within ${String(t.idle)} ms of the last inbound frame (silent ${String(nextAt - mark.at)} ms)`,
          mark.seq,
        ),
      );
    }
    // a one-way half-open link: every write is proven — a request by any reply, a write that expects no reply by the
    // answer of a probe written after it — within idle + 2 budgets (a probe pending at the write may be answered or
    // fail first), or the session ends; a request that still waits for its own answer needs a proof again within that
    // bound after each one
    const span = t.idle + 2 * Math.max(sessionBudget, budget, ...probes.map((x) => x.budget)) + eps;
    for (const p of socket.placed) {
      if (p.event.direction !== 'in' || p.pos < startSeq || p.pos >= until || !watched(p.frame)) continue;
      const request = expectsReply(p.frame);
      const id = p.frame[1];
      const write = { seq: p.event.seq, at: eff(options, p.event.seq, p.at) };
      const doneSeq = request ? ownAnswer(socket, p) : Infinity;
      let from = write;
      for (;;) {
        const proof = request
          ? replies.find((r) => r.seq > from.seq)
          : (() => {
              const answer = probes.find(
                (x) => x.seq > write.seq && x.answeredSeq > from.seq && x.answeredSeq < Infinity,
              );
              return answer === undefined ? undefined : { seq: answer.answeredSeq, at: answer.answeredAt ?? Infinity };
            })();
        const proofAt = proof?.at ?? endAt;
        const toSeq = proof?.seq ?? Number.MAX_SAFE_INTEGER;
        const grace = jumped(options, from.seq, toSeq) ? GRACE_REARM : 0;
        if (proofAt - from.at > span + grace && !suspendedBetween(options, from.seq, toSeq)) {
          out.push(
            violation(
              'INV-LIVE',
              `socket ${String(socket.number)}: ${show(p.frame)} stayed unproven ${String(proofAt - from.at)} ms (bound ${String(span)}) while the session went on`,
              from.seq,
            ),
          );
          break;
        }
        if (proof === undefined || !request || proof.seq >= doneSeq) break;
        // a forgotten request (cancelled call, SUBSCRIBE/REGISTER past its timeout) stops waiting
        if (proof.at - write.at > t.request || cancelledBefore(socket, id, proof.seq)) break;
        from = proof;
      }
    }
    if (
      attempt.end !== undefined &&
      (attempt.end.info.error as { timer?: unknown } | undefined)?.timer === 'liveness'
    ) {
      budget = Math.min(2 * budget, Math.max(PING_BUDGET_CAP, t.ping));
    }
  }
  return out;
};

/** A reply (between trace positions `afterSeq` and `beforeSeq`, by time `byAt`: the probe's deadline) to a request
 *  written after `afterSeq`: what proves an unanswered probe written at `afterSeq` 'alive' (ops/liveness.ts,
 *  `replies > ahead`). */
function provenAfter(
  socket: SocketRec,
  replies: readonly { readonly seq: number; readonly at: number; readonly msg: InboundMessage }[],
  afterSeq: number,
  beforeSeq: number,
  byAt: number,
): boolean {
  const written = new Set<unknown>();
  for (const p of socket.placed)
    if (p.event.direction === 'in' && p.event.seq > afterSeq && p.event.seq < beforeSeq && expectsReply(p.frame))
      written.add(p.frame[1]);
  return replies.some(
    (r) =>
      r.seq > afterSeq && r.seq < beforeSeq && r.at <= byAt && 'requestId' in r.msg && written.has(r.msg.requestId),
  );
}

/** Writes INV-LIVE watches: requests (not the probe) and the writes that expect no reply. */
function watched(frame: Frame): boolean {
  const type = typeOf(frame);
  if (type === T.CALL) return !isProbe(frame);
  return (
    type === T.PUBLISH ||
    type === T.SUBSCRIBE ||
    type === T.UNSUBSCRIBE ||
    type === T.REGISTER ||
    type === T.UNREGISTER ||
    type === T.YIELD ||
    type === T.CANCEL ||
    (type === T.ERROR && frame[1] === T.INVOCATION)
  );
}

function expectsReply(frame: Frame): boolean {
  const type = typeOf(frame);
  if (type === T.PUBLISH) return dict(frame[2])['acknowledge'] === true;
  return (
    type === T.CALL || type === T.SUBSCRIBE || type === T.UNSUBSCRIBE || type === T.REGISTER || type === T.UNREGISTER
  );
}

/** The trace position of a request's own final answer on its socket (Infinity: none). */
function ownAnswer(socket: SocketRec, request: Placed): number {
  const id = request.frame[1];
  for (const p of socket.placed) {
    if (p.event.direction !== 'out' || p.pos <= request.pos || p.msg === undefined || !('requestId' in p.msg)) continue;
    if (p.msg.requestId !== id) continue;
    if (p.msg.type === T.RESULT && p.msg.details['progress'] === true && p.msg.invalid === undefined) continue;
    if (p.msg.type === T.UNSUBSCRIBED && p.msg.revocation) continue;
    if (p.msg.type === T.UNREGISTERED && p.msg.revocation) continue;
    return p.event.seq;
  }
  return Infinity;
}

function cancelledBefore(socket: SocketRec, id: unknown, seq: number): boolean {
  return socket.placed.some(
    (p) => p.event.direction === 'in' && p.frame[0] === T.CANCEL && p.frame[1] === id && p.event.seq < seq,
  );
}

const REPLY_TYPES: ReadonlySet<number> = new Set([T.RESULT, T.PUBLISHED, T.SUBSCRIBED, T.REGISTERED, T.ERROR]);

/** Reply-class frames (ops/liveness.ts `replyKind` 'reply' or 'final'): they prove the router processes writes. */
function isReply(msg: InboundMessage): boolean {
  if (msg.type === T.UNSUBSCRIBED || msg.type === T.UNREGISTERED) return !msg.revocation;
  return REPLY_TYPES.has(msg.type);
}

// ---------------------------------------------------------------------------------------------------------------
// INV-R3 / INV-R8: single-trace parts and the differential comparisons
// ---------------------------------------------------------------------------------------------------------------

/** INV-R3's single-trace part: no end has an app-stream cause (a contained internal error without an injected fault). */
export const checkR3: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  if (options.faults === true) return out;
  for (const end of index.ends) {
    if (isInternal(end.info.error))
      out.push(
        violation('INV-R3', 'an end caused by a contained internal error (an app stream reached the core)', end.seq),
      );
  }
  for (const log of trace.logs) {
    if (log.entry.event === 'internal')
      out.push(violation('INV-R3', `internal error logged: ${log.entry.message}`, log.seq));
  }
  return out;
};

/** INV-R8's single-trace part: a throwing handler answers ERROR runtime_error and its registration stays. */
export const checkR8: Checker = (trace, options = {}) => {
  const index = indexTrace(trace);
  const out: InvariantViolation[] = [];
  const throwing = options.throwingHandlers;
  if (throwing === undefined || throwing.size === 0) return out;
  for (const socket of index.sockets.values()) {
    const procedures = new Map<unknown, string>(); // registration id → procedure
    const invocations = new Map<unknown, string>(); // invocation id → procedure
    const requests = new Map<unknown, string>(); // REGISTER request id → procedure
    for (const p of socket.placed) {
      const type = typeOf(p.frame);
      if (p.event.direction === 'in') {
        if (type === T.REGISTER && typeof p.frame[3] === 'string') requests.set(p.frame[1], p.frame[3]);
        if (type === T.YIELD) {
          const procedure = invocations.get(p.frame[1]);
          if (procedure !== undefined && throwing.has(procedure)) {
            out.push(violation('INV-R8', `a throwing handler of ${procedure} answered YIELD`, p.event.seq));
          }
        }
        if (type === T.ERROR && p.frame[1] === T.INVOCATION) {
          const procedure = invocations.get(p.frame[2]);
          // the handler threw (runtime_error), or never ran: interrupted (canceled), unregistered meanwhile
          // (no_such_registration), an invalid INVOCATION (invalid_argument)
          const allowed: readonly unknown[] = [
            Uri.RUNTIME_ERROR,
            Uri.CANCELED,
            Uri.NO_SUCH_REGISTRATION,
            Uri.INVALID_ARGUMENT,
          ];
          if (procedure !== undefined && throwing.has(procedure) && !allowed.includes(p.frame[4])) {
            out.push(
              violation(
                'INV-R8',
                `a throwing handler of ${procedure} answered ${String(p.frame[4])}, not runtime_error`,
                p.event.seq,
              ),
            );
          }
        }
        continue;
      }
      const msg = p.msg;
      if (msg?.type === T.REGISTERED) {
        const procedure = requests.get(msg.requestId);
        if (procedure !== undefined) procedures.set(msg.registrationId, procedure);
      } else if (msg?.type === T.INVOCATION) {
        const procedure = procedures.get(msg.registrationId);
        if (procedure !== undefined) invocations.set(msg.requestId, procedure);
      }
    }
  }
  // the registration stays: no handler result (the throw) ends it
  for (const o of index.observers.values()) {
    const term = o.terminal;
    const by = term?.stepId === undefined ? undefined : index.steps.get(term.stepId)?.input;
    // (a stop — close() or a give-up — ends every registration: a handler event can be the step that gave up, when an
    // injected fault in it resets the client once too often; INV-R4 judges that end)
    const stopped = isThruwayError(term?.value) && term.value.code === 'connection_closed';
    if (
      o.stream === 'register' &&
      throwing.has(o.uri ?? '') &&
      term !== undefined &&
      by?.startsWith('handler.') === true &&
      !stopped
    ) {
      out.push(
        violation(
          'INV-R8',
          `the registration of throwing handler ${String(o.uri)} ended with ${describe(term.value)}`,
          term.seq,
        ),
      );
    }
  }
  return out;
};

/** The per-end sequence INV-R3 compares: (state, attempt, delay) of every end. */
export function endSequence(trace: Trace): readonly string[] {
  return indexTrace(trace).ends.map(
    (e) =>
      `${e.info.initiator}/${String(e.info.reason)}/${String(e.info.willRetry)}/${String(e.info.attempt)}/${String(e.info.delay)}/${e.info.error?.name ?? '-'}`,
  );
}

/** INV-R3 (differential): the ends with app-stream noise equal the ends without it. */
export function compareR3(withNoise: Trace, without: Trace): readonly InvariantViolation[] {
  const a = endSequence(withNoise);
  const b = endSequence(without);
  const out: InvariantViolation[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      out.push(
        violation('INV-R3', `end ${String(i + 1)} differs with app-stream noise: ${String(a[i])} vs ${String(b[i])}`),
      );
      break;
    }
  }
  return out;
}

/** The notifications one observer (by creation order among observers of its stream and uri) received. */
function observerSequences(trace: Trace, skip: ReadonlySet<string>): Map<string, string[]> {
  const index = indexTrace(trace);
  const counts = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const o of index.observers.values()) {
    const base = `${o.stream}:${String(o.uri)}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const name = `${base}#${String(n)}`;
    if (skip.has(name)) continue;
    out.set(
      name,
      o.notes.map((x) => `${x.notification}:${summarize(x.value)}`),
    );
  }
  return out;
}

function summarize(value: unknown): string {
  if (isThruwayError(value)) return value.name;
  if (value instanceof Error) return value.name;
  try {
    const v = value as { state?: unknown; args?: unknown; id?: unknown; registrationId?: unknown; initiator?: unknown };
    if (typeof v.state === 'string') return v.state;
    if (typeof v.initiator === 'string') return `close:${v.initiator}`;
    if (v.args !== undefined) return JSON.stringify(v.args);
    if (v.registrationId !== undefined) return 'registered';
    if (v.id !== undefined) return 'session';
    return typeof value;
  } catch {
    return '?';
  }
}

/** INV-R8 (differential): throwing observers (named `stream:uri#n`) change no other observer's sequence. */
export function compareR8(
  withThrows: Trace,
  without: Trace,
  throwing: ReadonlySet<string>,
): readonly InvariantViolation[] {
  const a = observerSequences(withThrows, throwing);
  const b = observerSequences(without, throwing);
  const out: InvariantViolation[] = [];
  for (const [name, seq] of b) {
    const other = a.get(name);
    if (other?.join('|') !== seq.join('|')) {
      out.push(
        violation(
          'INV-R8',
          `observer ${name} saw ${JSON.stringify(other)} with throwing observers, ${JSON.stringify(seq)} without`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

export const CHECKERS: Readonly<Record<InvariantId, Checker>> = Object.freeze({
  'INV-CL01': checkCL01,
  'INV-CL02': checkCL02,
  'INV-R1': checkR1,
  'INV-R2': checkR2,
  'INV-R3': checkR3,
  'INV-R4': checkR4,
  'INV-R5': checkR5,
  'INV-R6': checkR6,
  'INV-R7': checkR7,
  'INV-R8': checkR8,
  'INV-R9': checkR9,
  'INV-R10': checkR10,
  'INV-ORDER': checkOrder,
  'INV-INVOKE': checkInvoke,
  'INV-CANCEL': checkCancel,
  'INV-AUTH': checkAuth,
  'INV-ESTABLISH': checkEstablish,
  'INV-EVENT': checkEvent,
  'INV-LIVE': checkLive,
});

export function checkInvariants(
  trace: Trace,
  options: CheckOptions = {},
  ids: readonly InvariantId[] = INVARIANT_IDS,
): readonly InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const id of ids) out.push(...CHECKERS[id](trace, options));
  return out;
}

export function formatViolations(violations: readonly InvariantViolation[], trace?: Trace): string {
  const lines = violations
    .slice(0, 20)
    .map((v) => `${v.invariant}: ${v.message}${v.seq === undefined ? '' : ` (seq ${String(v.seq)})`}`);
  if (violations.length > 20) lines.push(`… and ${String(violations.length - 20)} more`);
  if (trace !== undefined && violations[0]?.seq !== undefined) {
    const at = violations[0].seq;
    lines.push('trace around the first violation:', ...excerpt(trace, at));
  }
  return lines.join('\n');
}

/** The trace events around `seq`, one line each. */
export function excerpt(trace: Trace, seq: number, before = 25, after = 30): string[] {
  const found = trace.events.findIndex((e) => e.seq >= seq);
  const i = found < 0 ? trace.events.length - 1 : found; // after the last event: the trace's tail
  const from = Math.max(0, i - before);
  return trace.events
    .slice(from, i + after + 1)
    .map((e) => `  ${String(e.seq).padStart(5)} @${String(e.at)} ${eventLine(e)}`);
}

function eventLine(e: Trace['events'][number]): string {
  switch (e.kind) {
    case 'frame':
      return `${e.direction === 'in' ? '→' : '←'} #${String(e.connection)} ${show(e.frame)} step ${String(e.stepId)}`;
    case 'input':
      return `step ${String(e.stepId)} ${e.input}${e.conn === undefined ? '' : ` conn ${String(e.conn)}`}`;
    case 'delivery':
      return `delivery ${String(e.deliveryId)} ${e.phase} (step ${String(e.stepId)})`;
    case 'notification':
      return `obs ${String(e.observer)} ${e.stream} ${e.uri ?? ''} ${e.notification} ${summarize(e.value)} (step ${String(e.stepId)})`;
    case 'observer':
      return `obs ${String(e.observer)} ${e.stream} ${e.uri ?? ''} ${e.action}`;
    case 'close-info':
      return `close-info ${e.info.initiator} ${String(e.info.reason)} retry=${String(e.info.willRetry)} attempt=${String(e.info.attempt)}`;
    case 'api':
      return `api ${e.call}${e.resolved ? ' resolved' : ''}`;
    case 'timer':
      return `timer ${e.scope} ${e.action} #${String(e.timerId)} ${e.delay === undefined ? '' : `delay ${String(e.delay)}`}`;
    case 'log':
      return `log ${e.entry.level} ${e.entry.event}: ${e.entry.message}`;
  }
}

/** Throw with a readable report when any checker finds a violation. */
export function assertInvariants(
  trace: Trace,
  options: CheckOptions = {},
  ids: readonly InvariantId[] = INVARIANT_IDS,
): void {
  const found = checkInvariants(trace, options, ids);
  if (found.length > 0)
    throw new Error(`invariant violated (seed ${String(trace.seed)}):\n${formatViolations(found, trace)}`);
}
