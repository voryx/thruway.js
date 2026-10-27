/**
 * Internal contracts between the core and its participants, so that the core, the participants, the challenge
 * runner and liveness can each be built and tested against this file alone.
 *
 * The first part declares the contracts. The second part holds the types they reference (op records, snapshots,
 * `OpSubscriber`) and the constructor dependencies of the participants, the challenge runner and liveness; each is
 * documented where it is declared. `test/types/contracts.test-d.ts` shows that
 * every action of the core's state machine type-checks against this file alone.
 * Internal: not reachable from any package entry point.
 *
 * @module
 */
import type { CloseInfo, Session, LogEntry, ChallengeMessage, InvocationMessage } from '../types.js';
import type { ThruwayError } from '../errors.js';
import type { InboundMessage, OutboundFrame } from '../protocol/messages.js';
// Types the contracts use (OpFactories, snapshots).
import type { EventMessage, Input, RegisteredMessage, ResultMessage } from '../types.js';

export type ConnId = number; // monotonic per Client, starts at 1
export type Seq = number; // monotonic per Client: one per app subscription, start order

/** What a participant may do while handling an input. Never invokes app code synchronously. */
export interface Effects {
  /** Queue app code to run after the current step (FIFO). */
  deliver(fn: () => void): void;
  /** Lazy: the entry is built only when a custom logger is set. */
  log(entry: () => LogEntry): void;
  readonly now: number; // monotonic ms (clock.now())
}

/** Effects bound to the current established session. Invalid (gate closed) after that session ends. */
export interface SessionCtx extends Effects {
  readonly connId: ConnId;
  readonly session: Session;
  /** Write a frame that carries no new request id (CANCEL, YIELD, ERROR). Returns false when nothing was sent: the gate
   *  is closed, or the transport refused the write (the adapter then reports the connection lost; the core ends it
   *  after this step). Throws the serializer's error, or WampError('wamp.error.payload_size_exceeded') for frames over
   *  16 MiB: the caller fails its own record; nothing was written. */
  send(frame: OutboundFrame): boolean;
  /** Allocate a request id now, build, serialize and write. Returns the id, or undefined when nothing was sent (the id
   *  is released; a sequential counter is rolled back). Throws like send(). `expectsReply` is false only for an
   *  unacknowledged PUBLISH (liveness does not wait for an answer to it). */
  request(build: (requestId: number) => OutboundFrame, expectsReply?: boolean): number | undefined;
  /** Arm a timer owned by this session; it submits `{kind:'timer.op', conn, gen, owner, key}` and is cleared at session
   *  end. `deadline: true` gives it the late-fire grace of a deadline (request timers). */
  timer(ms: number, owner: ParticipantName, key: number, deadline?: boolean): TimerHandle;
  /** Request-timeout verdict: runs `onTimeout` (in a later step) when the connection has been proven alive since
   *  `since` or liveness is off; otherwise probes and runs it after the probe is answered. Never runs it if the probe
   *  fails (the session then ends and the record goes dormant / fails as Lost). */
  verifyAlive(since: number, onTimeout: () => void): void;
  /** Ask the core to abort the session with wamp.error.protocol_violation after the current step (ignored unless this
   *  connection is still current and ESTABLISHED then). */
  violation(message: string, frame: unknown): void;
}

export interface TimerHandle {
  cancel(): void;
}
export type ParticipantName = 'call' | 'publish' | 'topic' | 'register';

/** Every op/interest record created by the facade. The registry holds these for hardReset. */
export interface BaseOp {
  readonly seq: Seq;
  readonly subscriber: { error(e: unknown): void; readonly closed: boolean };
}

/** The context an error names for one record: its request id while in flight, its procedure or topic. */
export interface RecordContext {
  readonly requestId?: number;
  readonly procedure?: string;
  readonly topic?: string;
}

/** The error of one record failed by close() or give-up: the stop's ConnectionClosedError
 *  {gaveUp, cause} with that record's context (and the session id when the context has a request id). */
export type StopError = (ctx: RecordContext) => ThruwayError;

/** What participants receive at a session end. */
export interface EndInfo {
  readonly info: CloseInfo;
  /** Error for records that were in flight: ConnectionLostError when info.willRetry, else
   *  ConnectionClosedError{gaveUp: true, cause: ConnectionLostError}. */
  inflightError(ctx: { requestId?: number; procedure?: string; topic?: string }): ThruwayError;
}

/** call and publish. The core owns the FIFO of ops waiting for a session (Registry). */
export interface OneShotParticipant<Op extends BaseOp> {
  readonly name: 'call' | 'publish';
  /** Write op now. 'done' ⇒ the op left the queue: written, or failed by its own serializer/size error (the
   *  participant has errored it). 'not-sent' ⇒ the core keeps it queued at its position (the connection is ending).
   *  A throw out of write() is a client bug (hardReset). */
  write(op: Op, ctx: SessionCtx): 'done' | 'not-sent';
  /** The app unsubscribed an op the participant holds (in flight). */
  stop(op: Op, ctx: SessionCtx | undefined, fx: Effects): void;
  inbound(msg: InboundMessage, ctx: SessionCtx): boolean; // true = consumed (false ⇒ logged as dropped)
  timer(key: number, ctx: SessionCtx): void;
  sessionEnded(end: EndInfo, fx: Effects): void; // in-flight ops error end.inflightError(...)
  clientClosed(stopError: StopError, fx: Effects): void; // in-flight ops error stopError(...)
  pendingIds(): Iterable<number>; // ids in flight in the current session
}

/** topic and register. */
export interface InterestParticipant<Op extends BaseOp> {
  readonly name: 'topic' | 'register';
  /** ctx undefined ⇒ no session: the interest stays dormant. */
  start(op: Op, ctx: SessionCtx | undefined, fx: Effects): void;
  stop(op: Op, ctx: SessionCtx | undefined, fx: Effects): void;
  /** A session was established (after onOpen/status are queued): (re)establish interests, FIFO by seq. */
  welcome(ctx: SessionCtx): void;
  inbound(msg: InboundMessage, ctx: SessionCtx): boolean;
  timer(key: number, ctx: SessionCtx): void;
  /** Gate already closed, app already notified: interests dormant, invocations aborted, per-session maps cleared. */
  sessionEnded(end: EndInfo, fx: Effects): void;
  /** close() or give-up: every interest errors `stopError(...)` with its own context. */
  clientClosed(stopError: StopError, fx: Effects): void;
  pendingIds(): Iterable<number>;
}

export interface RegisterParticipant extends InterestParticipant<RegisterOp> {
  /** A handler result arrived (a delivery submitted it). Matched by the Invocation object, never by id. */
  handlerEvent(ev: HandlerEvent, ctx: SessionCtx): void;
}
export type InvocationRef = object; // opaque identity of one running invocation
export type HandlerEvent =
  | {
      readonly kind: 'handler.next';
      readonly conn: ConnId;
      readonly invocation: InvocationRef;
      readonly value: unknown;
    }
  | {
      readonly kind: 'handler.complete';
      readonly conn: ConnId;
      readonly invocation: InvocationRef;
      readonly value?: unknown;
      readonly hasValue: boolean;
    }
  | {
      readonly kind: 'handler.error';
      readonly conn: ConnId;
      readonly invocation: InvocationRef;
      readonly error: unknown;
    };

export interface Liveness {
  // the core calls it, it is not a participant
  start(ctx: SessionCtx, welcomeRoles: Readonly<Record<string, unknown>>): void;
  /** Every decodable inbound frame, before routing. Returns true if it was the probe's answer (consumed). */
  inbound(msg: InboundMessage, ctx: SessionCtx): boolean;
  wrote(expectsReply: boolean, ctx: SessionCtx): void; // from ctx.request
  onIdle(ctx: SessionCtx): void; // timer.idle
  onPing(ctx: SessionCtx): 'alive' | 'dead'; // timer.ping
  check(ctx: SessionCtx): void; // open() while ESTABLISHED
  verifyAlive(since: number, onTimeout: () => void, ctx: SessionCtx): void;
  sessionEnded(byLiveness: boolean): void; // adapts the ping budget, clears per-session state
}

export interface ChallengeRunner {
  /** A delivery: calls onChallenge, converts its Input, submits challenge.ok/challenge.fail for (conn, round). */
  run(conn: ConnId, round: number, challenge: { authMethod: string; extra: Readonly<Record<string, unknown>> }): void;
  /** A delivery: unsubscribes the pending answer first, then aborts its signal with `reason` (each in try/catch). */
  cancel(reason: ThruwayError): void;
}

export interface OpFactories {
  // used by client.ts; each takes a validated snapshot
  newCallOp(seq: Seq, snap: CallSnapshot, subscriber: OpSubscriber<ResultMessage>): CallOp;
  newPublishOp(seq: Seq, snap: PublishSnapshot, subscriber: OpSubscriber<void>): PublishOp;
  newTopicOp(seq: Seq, snap: TopicSnapshot, subscriber: OpSubscriber<EventMessage>): TopicOp;
  newRegisterOp(seq: Seq, snap: RegisterSnapshot, subscriber: OpSubscriber<RegisteredMessage>): RegisterOp;
}

/** Every input of the core. */
export type CoreInput =
  | { kind: 'open' }
  | { kind: 'reconnect' }
  | { kind: 'close'; resolve: () => void }
  | { kind: 'op.start'; op: AnyOp }
  | { kind: 'op.stop'; op: AnyOp }
  | { kind: 'url.ok'; conn: ConnId; url: unknown }
  | { kind: 'url.fail'; conn: ConnId; error: unknown }
  | { kind: 'challenge.ok'; conn: ConnId; round: number; signature: string }
  | { kind: 'challenge.fail'; conn: ConnId; round: number; error: unknown }
  | HandlerEvent
  | { kind: 'ws.open'; conn: ConnId; protocol: string }
  | { kind: 'ws.message'; conn: ConnId; data: unknown }
  | { kind: 'ws.closed'; conn: ConnId; code: number; reason: string; wasClean: boolean; error?: unknown }
  | {
      kind:
        | 'timer.retry'
        | 'timer.connect'
        | 'timer.handshake'
        | 'timer.challenge'
        | 'timer.stable'
        | 'timer.idle'
        | 'timer.ping'
        | 'timer.goodbye';
      conn: ConnId;
      gen: number;
    }
  | { kind: 'timer.op'; conn: ConnId; gen: number; owner: ParticipantName; key: number };

// =====================================================================================================================
// The types the contracts above reference (validated snapshots, op records), plus the constructor dependencies the
// core hands to participants, the challenge runner and liveness.
// =====================================================================================================================

/**
 * The app-facing end of one subscription, as the core and participants see it (structurally the `Subscriber` of
 * observable/observable.ts). `next`/`error`/`complete` run app code (observer callbacks), so participants call them
 * only inside `fx.deliver(() => …)`, never synchronously inside a step. After a terminal call, or after the
 * app unsubscribed, every call is a no-op and `closed` is true. Records are removed from every participant map
 * *before* their terminal notification is queued.
 */
export interface OpSubscriber<T> {
  next(value: T): void;
  error(e: unknown): void;
  complete(): void;
  readonly closed: boolean;
}

/** A WAMP options dict as snapshotted by the facade: a shallow copy with `undefined` values dropped. */
export type OptionsSnapshot = Readonly<Record<string, unknown>>;

/**
 * Validated arguments of one `call()` subscription (`validate.ts` `snapshotCall`, run inside `subscribe`).
 * Participants never read app objects: `args`/`kwargs` are shallow copies (`undefined` when absent) and the
 * procedure URI is valid.
 */
export interface CallSnapshot {
  readonly procedure: string;
  readonly args: readonly unknown[] | undefined;
  readonly kwargs: Readonly<Record<string, unknown>> | undefined;
  readonly options: OptionsSnapshot;
  /** `options.receive_progress === true`: progressive results. */
  readonly progressive: boolean;
}

/** Validated arguments of one `publish()` subscription (`snapshotPublish`). */
export interface PublishSnapshot {
  readonly topic: string;
  readonly args: readonly unknown[] | undefined;
  readonly kwargs: Readonly<Record<string, unknown>> | undefined;
  readonly options: OptionsSnapshot;
  /** `options.acknowledge === true`: complete on PUBLISHED instead of on write. */
  readonly ack: boolean;
}

/** Validated arguments of one `topic()` subscription (`snapshotTopic`). */
export interface TopicSnapshot {
  readonly topic: string;
  readonly options: OptionsSnapshot;
  /** One router subscription per key: `topic + canonicalJson(normalised options)`; normalisation drops `undefined`,
   *  `match: 'exact'` and spec booleans that are `false`, so `{}` and `{match:'exact'}` are one key. */
  readonly key: string;
  /** `topic + match`: what a broker that reuses subscription ids keys on (deferred UNSUBSCRIBE). */
  readonly group: string;
}

/** Validated arguments of one `register()` subscription (`snapshotRegister`). */
export interface RegisterSnapshot {
  readonly procedure: string;
  readonly options: OptionsSnapshot;
  /** `procedure + canonicalJson(normalised options)`; normalisation also drops `invoke: 'single'`. */
  readonly key: string;
  /** The app's handler (app code: called only inside a delivery). */
  readonly handler: (invocation: InvocationMessage) => Input<unknown>;
}

/**
 * One subscription of `call()`. Op records are immutable and created by `OpFactories` from a snapshot; the
 * owning participant keeps the mutable per-op state (queued/inflight/done, connection, request id, emitted)
 * in its own structures keyed by the record's identity, so the core and the Registry never see participant state and
 * `hardReset` can hand the same record to a fresh participant.
 */
export interface CallOp extends BaseOp {
  readonly kind: 'call';
  readonly snap: CallSnapshot;
  readonly subscriber: OpSubscriber<ResultMessage>;
}

/** One subscription of `publish()`. Emits `undefined` once, then completes. */
export interface PublishOp extends BaseOp {
  readonly kind: 'publish';
  readonly snap: PublishSnapshot;
  readonly subscriber: OpSubscriber<void>;
}

/** One local subscriber of `topic()`; the router-side key state belongs to the topic participant. */
export interface TopicOp extends BaseOp {
  readonly kind: 'topic';
  readonly snap: TopicSnapshot;
  readonly subscriber: OpSubscriber<EventMessage>;
}

/**
 * One subscription of `register()`. Adoption (StrictMode) happens inside the register participant: a
 * new RegisterOp takes over the pending registration record of the same key; the op itself never changes.
 */
export interface RegisterOp extends BaseOp {
  readonly kind: 'register';
  readonly snap: RegisterSnapshot;
  readonly subscriber: OpSubscriber<RegisteredMessage>;
}

/** Every op/interest record; `kind` names the participant that owns it (`participants[op.kind]`). */
export type AnyOp = CallOp | PublishOp | TopicOp | RegisterOp;
/** The one-shot ops: they wait in the Registry FIFO while there is no session. */
export type OneShotOp = CallOp | PublishOp;
/** The long-lived interests: dormant while there is no session, re-established at every WELCOME. */
export type InterestOp = TopicOp | RegisterOp;

/** Constructor dependencies of the four participants (`new CallParticipant(deps)`, …). */
export interface ParticipantDeps {
  /** `timeouts.request` (ms): answer deadline of SUBSCRIBE/UNSUBSCRIBE/REGISTER/UNREGISTER (`op` timers); also the
   *  expiry of `late` entries. Unused by call and publish. */
  readonly requestTimeout: number;
  /** Submit an input to the core from app context (the register participant's handler deliveries submit
   *  `handler.*`). Never called synchronously inside a step. */
  submit(input: CoreInput): void;
}

/** Constructor dependencies of the challenge runner. */
export interface ChallengeRunnerDeps {
  /** `ClientOptions.onChallenge` (the core ABORTs without calling `run` when it is undefined). */
  readonly onChallenge: ((challenge: ChallengeMessage) => Input<string>) | undefined;
  /** Submits `challenge.ok` / `challenge.fail` (from deliveries and from the answer's callbacks). */
  submit(input: CoreInput): void;
}

/**
 * Constructor dependencies of liveness. `timer.idle` and `timer.ping` are core timers (generations,
 * deadline grace, cleared with the connection's TimerScope); liveness arms them through this host and the core calls
 * `onIdle`/`onPing` when they fire.
 */
export interface LivenessHost {
  /** `timeouts.idle` (ms); 0 disables liveness. */
  readonly idle: number;
  /** Base ping budget (20 000 ms; lowered by the internal fast-profile option). */
  readonly pingBudget: number;
  /** (Re-)arm the session's `timer.idle` for `ms` (a new generation; a previously armed one is dropped). */
  armIdle(ctx: SessionCtx, ms: number): void;
  /** (Re-)arm the session's `timer.ping` for `ms`, with the late-fire grace of a deadline. */
  armPing(ctx: SessionCtx, ms: number): void;
  /** Disarm `timer.ping` (the probe was answered). */
  cancelPing(ctx: SessionCtx): void;
  /** The transport's outbound backlog: `ws.bufferedAmount` when it is a number, else 0. */
  bufferedAmount(ctx: SessionCtx): number;
  /** Run `fn` after the current step's actions (verdicts run in a later step); dropped if `ctx`'s session has
   *  ended by then. */
  later(ctx: SessionCtx, fn: () => void): void;
}
