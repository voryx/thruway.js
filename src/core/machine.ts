/**
 * `Core`: the states, the transitions with their catch-all, inbound routing, the end procedure, the close procedure,
 * lingering connections and `hardReset`.
 *
 * Everything the client does is a step: one input, processed to completion by `step()` (EventLoop). A step never
 * runs app code (observers, handlers, `onChallenge`, the url resolver); it queues deliveries. Every way an attempt or
 * session ends goes through `end()`, which closes the gate, notifies the app, fails what was in flight and schedules
 * exactly one reconnect. A throw out of a step — a client bug — is contained by `hardReset`.
 *
 * The state is a `Phase`: the states that have a connection carry it, ESTABLISHED also its SessionCtx. An input is
 * handled only in the states that accept it, and timer inputs only while their generation is armed; anything else
 * reaches the catch-all (dropped, `debug` log), so no (state, input) pair can throw.
 *
 * @module
 */
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  ConnectionClosedError,
  ConnectionLostError,
  ProtocolError,
  TimeoutError,
  withContext,
  type ThruwayError,
} from '../errors.js';
import {
  defaultLogger,
  describeError,
  eager,
  frameEntry,
  redactUrl,
  safeLog,
  safeLogLazy,
  unhandledEntry,
  type LogTarget,
} from '../logger.js';
import { firstValue } from '../observable/input.js';
import {
  logReporter,
  Observable,
  type Subscriber,
  type TeardownLogic,
  type UnhandledReporter,
} from '../observable/observable.js';
import { EventSubject, LatestSubject } from '../observable/subjects.js';
import { CallParticipant } from '../ops/call.js';
import { ChallengeRunner } from '../ops/challenge.js';
import { Liveness } from '../ops/liveness.js';
import { PublishParticipant } from '../ops/publish.js';
import { GHOST_MEMORY, RegisterParticipant } from '../ops/register.js';
import { TopicParticipant } from '../ops/topic.js';
import { helloAuth, type HelloAuth, type NormalizedOptions } from '../options.js';
import { CloseCode, MessageType, Uri } from '../protocol/codes.js';
import { decode, frameText } from '../protocol/decode.js';
import { helloDetails } from '../protocol/hello.js';
import {
  abortFrame,
  authenticateFrame,
  goodbyeFrame,
  helloFrame,
  type Dict,
  type InboundChallenge,
  type InboundMessage,
  type InboundWelcome,
  type OutboundFrame,
} from '../protocol/messages.js';
import { isPlainObject } from '../protocol/payload.js';
import { openWebSocket } from '../transport/websocket.js';
import type {
  CloseInfo,
  LogEntry,
  Observable as PublicObservable,
  Serializer,
  Session,
  Status,
  WebSocketConstructorLike,
  WebSocketLike,
} from '../types.js';
import { adaptiveDeadline, Backoff } from './backoff.js';
import { clampDelay, clockAccess, platformTimers, systemClock, TimerScope, type ClockAccess } from './clock.js';
import { closeReason, Connection, frameBytes, Lingering } from './connection.js';
import type {
  AnyOp,
  ConnId,
  CoreInput,
  Effects,
  EndInfo,
  HandlerEvent,
  InterestOp,
  LivenessHost,
  OneShotOp,
  OpFactories,
  ParticipantDeps,
  ParticipantName,
  RecordContext,
  Seq,
  SessionCtx,
  StopError,
  TimerHandle,
} from './contracts.js';
import { RandomIds, SequentialIds, type IdAllocator } from './ids.js';
import { EventLoop, type LoopHost } from './loop.js';
import { opFactories, Registry } from './registry.js';

/** The machine states (`CHALLENGED` carries its round on the connection). */
export type MachineState =
  'CLOSED' | 'WAITING' | 'RESOLVING' | 'CONNECTING' | 'HELLO_SENT' | 'CHALLENGED' | 'ESTABLISHED';

/** What the internal debug probe reports (`client[Symbol.for('thruway.js.debug')]()`, INV-R10). */
export interface CoreDebugInfo {
  readonly state: MachineState;
  readonly stopped: boolean;
  readonly currentConnection: number | undefined;
  readonly lingering: number;
  readonly inputs: number;
  readonly deliveries: number;
  readonly registry: number;
  readonly queued: number;
  /** Map sizes per participant (keys, requests, invocations, late entries, …). */
  readonly participants: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Timers armed in the core's own scope and the current connection's (lingering ones not counted). */
  readonly timers: number;
}

/** More CHALLENGE rounds than this on one connection ⇒ ABORT (INV-AUTH). */
export const MAX_ROUNDS = 8;

/** `conn` of the core's own timers (`timer.retry`): not a connection. */
const CORE_CONN = 0;
/** The generation `lastResort`'s platform timer submits. */
const LAST_RESORT_GEN = -1;

const EMPTY: Dict = Object.freeze({});

/** The machine state; the states with a connection carry it, ESTABLISHED also its ctx. */
type Phase =
  | { readonly state: 'CLOSED' }
  | { readonly state: 'WAITING' }
  | { readonly state: 'RESOLVING' | 'CONNECTING' | 'HELLO_SENT' | 'CHALLENGED'; readonly conn: Connection }
  | { readonly state: 'ESTABLISHED'; readonly conn: Connection; readonly ctx: SessionCtx };
type ConnPhase = Extract<Phase, { readonly conn: Connection }>;

/** Inputs bound to a connection (`conn` is a connection id): the staleness rule applies. */
type ConnInput = Exclude<
  CoreInput,
  { kind: 'open' | 'reconnect' | 'close' | 'op.start' | 'op.stop' | 'challenge.ok' | 'challenge.fail' }
>;
type TimerInput = Extract<CoreInput, { gen: number }>;

/** How an attempt or session ended. `closeCode` is the code the socket was closed with, when known. */
interface EndCause {
  readonly initiator: CloseInfo['initiator'];
  readonly reason?: string | undefined;
  readonly details?: Dict | undefined;
  readonly closeCode?: number | undefined;
  readonly wasClean: boolean;
  readonly error?: ThruwayError | undefined;
}

type Loose<T> = { [K in keyof T]?: T[K] | undefined };
/** `new Ctor(init)` with undefined fields allowed (the error constructors skip them; exactOptionalPropertyTypes). */
function make<C extends new (init: never) => object>(
  Ctor: C,
  init: Loose<NonNullable<ConstructorParameters<C>[0]>>,
): InstanceType<C> {
  return new Ctor(init as never) as InstanceType<C>;
}

/** The four participants and liveness: replaced as a whole by `hardReset`. */
interface Participants {
  readonly call: CallParticipant;
  readonly publish: PublishParticipant;
  readonly topic: TopicParticipant;
  readonly register: RegisterParticipant;
  readonly liveness: Liveness;
}

/** The `client[Symbol.for('thruway.js.faults')]` hook: throws injected into named internals. */
export interface FaultsHook {
  /** `target`: `call.write`, `topic.start`, … (any participant or liveness method), `challenge.run`,
   *  `challenge.cancel`, `serializer.serialize`, `serializer.deserialize`, `logger`, `clock.random`, `ws.send`,
   *  `ws.close`. `once` (default) removes the fault after it threw. */
  inject(target: string, mode?: 'once' | 'always', error?: unknown): void;
  clear(target?: string): void;
}

/** The fault plan behind {@link FaultsHook}: one size check per hook point until a fault is injected; participants and
 *  sockets are wrapped only once the hook was used. */
class FaultPlan implements FaultsHook {
  private readonly planned = new Map<string, { readonly mode: 'once' | 'always'; readonly error: unknown }>();
  enabled = false;

  constructor(private readonly onEnable: () => void) {}

  inject(target: string, mode: 'once' | 'always' = 'once', error?: unknown): void {
    this.planned.set(target, { mode, error: error ?? new Error(`injected fault: ${target}`) });
    if (this.enabled) return;
    this.enabled = true;
    this.onEnable();
  }

  clear(target?: string): void {
    if (target === undefined) this.planned.clear();
    else this.planned.delete(target);
  }

  check(target: string): void {
    if (this.planned.size === 0) return;
    const fault = this.planned.get(target);
    if (fault === undefined) return;
    if (fault.mode === 'once') this.planned.delete(target);
    throw fault.error;
  }

  /** Shadow every method of `object` (class methods up its prototype chain) with one that checks `name.method`. */
  patch(name: string, object: object): void {
    const check = (target: string): void => {
      this.check(target);
    };
    for (let proto: unknown = Object.getPrototypeOf(object); proto !== Object.prototype;) {
      for (const method of Object.getOwnPropertyNames(proto)) {
        const original = (proto as Record<string, unknown>)[method];
        if (method === 'constructor' || typeof original !== 'function' || Object.hasOwnProperty.call(object, method)) {
          continue;
        }
        Object.defineProperty(object, method, {
          configurable: true,
          writable: true,
          value: function (this: unknown, ...args: unknown[]): unknown {
            check(`${name}.${method}`);
            return (original as (...a: unknown[]) => unknown).apply(this, args);
          },
        });
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  /** A WebSocket constructor whose sockets check `ws.send` / `ws.close` first. */
  sockets(Ctor: WebSocketConstructorLike): WebSocketConstructorLike {
    const check = (target: string): void => {
      this.check(target);
    };
    const Faulty = function (url: string, protocols?: string | string[]): WebSocketLike {
      return new Proxy(new Ctor(url, protocols), {
        get(target, prop) {
          if (prop === 'send' || prop === 'close') {
            return (...args: unknown[]): unknown => {
              check(`ws.${prop}`);
              return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      });
    } as unknown as WebSocketConstructorLike;
    Object.defineProperty(Faulty, 'OPEN', { value: Ctor.OPEN });
    return Faulty;
  }
}

/** Deferred work of the current step: liveness verdicts (`host.later`) and `ctx.violation`, in order. */
type Later =
  | { readonly kind: 'later'; readonly conn: ConnId; readonly fn: () => void }
  | { readonly kind: 'violation'; readonly conn: ConnId; readonly message: string; readonly frame: unknown };

export class Core implements LoopHost {
  private readonly o: NormalizedOptions;
  private readonly loop: EventLoop;
  private readonly logTarget: LogTarget;
  private readonly reporter: UnhandledReporter;
  private readonly clock: ClockAccess;
  private readonly coreTimers: TimerScope;
  private readonly backoff: Backoff;
  private readonly registry = new Registry();
  private readonly randomIds: RandomIds;
  /** The register participant's ghost-key memory: client-level, it survives hardReset and close(). */
  private readonly ghostKeys = new Set<string>();
  private readonly runner: ChallengeRunner;
  private readonly statusSubject: LatestSubject<Status>;
  private readonly openSubject: LatestSubject<Session>;
  private readonly closeSubject: EventSubject<CloseInfo>;
  private readonly faults: FaultPlan;
  private readonly serializer: Serializer;
  private readonly fx: Effects;
  private readonly livenessHost: LivenessHost;
  private parts: Participants;
  private phase: Phase = { state: 'CLOSED' };
  /** Set while stopped (after close() or give-up): the ConnectionClosedError new work gets. */
  private stopCause: ConnectionClosedError | undefined = undefined;
  private connSeq = 0;
  private seqValue = 0;
  private lastAttemptStart = Number.NEGATIVE_INFINITY;
  /** `clock.now()` when the armed retry timer is due, and its delay (meaningful only while it is armed). */
  private retryDue = 0;
  private retryDelay = 0;
  /** `willRetry` of the last end the app was told about (status shows it while WAITING). */
  private announcedRetry = false;
  private kConnect = 0;
  private kHandshake = 0;
  private readonly lingering = new Map<ConnId, Lingering>();
  private laterQueue: Later[] = [];
  private lastResortHandle: unknown = undefined;
  private lastResortArmed = false;
  /** The session `end()` is ending while liveness and the participants run: a hardReset there still knows it (its
   *  registrations may be ghosts; its id goes into the errors). */
  private ending: Session | undefined = undefined;
  /** A client bug noticed inside `ctx.request` or `ctx.send`, thrown at the end of the step (see `internalError`). */
  private failure: { readonly error: unknown } | undefined = undefined;
  private readonly deliverFn = (fn: () => void): void => {
    this.loop.deliver(fn);
  };

  constructor(options: NormalizedOptions) {
    this.o = options;
    const faults = new FaultPlan(() => {
      this.patchParticipants(this.parts);
    });
    this.faults = faults;
    const logger = options.logger ?? defaultLogger;
    this.logTarget = {
      logger: (entry) => {
        faults.check('logger');
        logger(entry);
      },
      custom: options.logger !== undefined,
      fallbackUsed: false,
    };
    this.reporter = logReporter((entry) => {
      safeLog(this.logTarget, entry);
    });
    this.loop = new EventLoop(this, options.trace);
    this.clock = clockAccess(options.clock, (error, what) => {
      this.fallback(`clock.${what} threw or returned an unusable value; the platform default was used`, error);
    });
    this.coreTimers = new TimerScope(this.clock);
    const random = options.random ?? systemClock.random;
    this.backoff = new Backoff({
      initialRetryDelay: options.retry.initialRetryDelay,
      retryDelayGrowth: options.retry.retryDelayGrowth,
      maxRetryDelay: options.retry.maxRetryDelay,
      retryDelay: options.retry.retryDelay,
      random: () => {
        faults.check('clock.random');
        return random();
      },
      onFallback: (error, what) => {
        const option = what === 'random' ? 'clock.random' : 'retryOptions.retryDelay';
        this.fallback(`${option} threw or returned an unusable value; the default was used`, error);
      },
    });
    this.randomIds = new RandomIds(options.random === undefined ? undefined : this.seedOf(options.random));
    const serializer = options.serializer;
    this.serializer = {
      protocol: serializer.protocol,
      binary: serializer.binary,
      serialize: (message) => {
        faults.check('serializer.serialize');
        return serializer.serialize(message);
      },
      deserialize: (data) => {
        faults.check('serializer.deserialize');
        return serializer.deserialize(data);
      },
    };
    const now = (): number => this.clock.now();
    this.fx = Object.freeze({
      deliver: this.deliverFn,
      log: (build: () => LogEntry) => {
        this.log(build);
      },
      get now() {
        return now();
      },
    });
    this.livenessHost = this.makeLivenessHost();
    this.runner = new ChallengeRunner(
      {
        onChallenge: options.onChallenge,
        submit: (input) => {
          this.submit(input);
        },
      },
      this.reporter,
    );
    this.statusSubject = new LatestSubject<Status>(
      { hasValue: true, value: Object.freeze({ state: 'closed', closed: undefined }) },
      this.reporter,
    );
    this.openSubject = new LatestSubject<Session>({ hasValue: false }, this.reporter);
    this.closeSubject = new EventSubject<CloseInfo>(this.reporter);
    this.parts = this.freshParticipants();
  }

  // ------------------------------------------------------------------------------------------------ public surface

  /** The only way anything reaches the machine (API calls, transport events, timers, app results). */
  submit(input: CoreInput): void {
    this.loop.submit(input);
  }

  /** The next app-subscription sequence number (start order). */
  nextSeq(): Seq {
    return ++this.seqValue;
  }

  get factories(): OpFactories {
    return opFactories;
  }

  /** The established session, or undefined; never one that has ended. */
  get session(): Session | undefined {
    return this.phase.state === 'ESTABLISHED' ? this.phase.ctx.session : undefined;
  }

  get state(): MachineState {
    return this.phase.state;
  }

  /** `options.autoOpen`: the facade submits `open` right after construction. */
  get autoOpen(): boolean {
    return this.o.autoOpen;
  }

  get status(): PublicObservable<Status> {
    return this.statusSubject.observable;
  }

  get onOpen(): PublicObservable<Session> {
    return this.openSubject.observable;
  }

  get onClose(): PublicObservable<CloseInfo> {
    return this.closeSubject.observable;
  }

  /** A cold Observable reporting through this client's logger (observer throws, unhandled errors). */
  observable<T>(subscribe: (subscriber: Subscriber<T>) => TeardownLogic): Observable<T> {
    return new Observable<T>(subscribe, this.reporter);
  }

  get faultsHook(): FaultsHook {
    return this.faults;
  }

  debug(): CoreDebugInfo {
    const p = this.parts;
    const count = (ids: Iterable<number>): number => [...ids].length;
    const sizes = this.loop.sizes();
    const conn = this.conn();
    return Object.freeze({
      state: this.phase.state,
      stopped: this.stopCause !== undefined,
      currentConnection: conn?.id,
      lingering: this.lingering.size,
      inputs: sizes.inputs,
      deliveries: sizes.deliveries,
      registry: this.registry.size,
      queued: this.registry.queuedCount,
      participants: Object.freeze({
        call: Object.freeze({ inFlight: count(p.call.pendingIds()) }),
        publish: Object.freeze({ inFlight: count(p.publish.pendingIds()) }),
        topic: Object.freeze({ ...p.topic.sizes() }),
        register: Object.freeze({ ...p.register.sizes() }),
        liveness: Object.freeze({ probes: count(p.liveness.pendingIds()) }),
      }),
      timers: this.coreTimers.size + (conn?.timers.size ?? 0),
    });
  }

  // ------------------------------------------------------------------------------------------------ LoopHost

  step(input: CoreInput): void {
    this.dispatch(input);
    this.runLater();
    const failure = this.failure;
    this.failure = undefined;
    if (failure !== undefined) throw failure.error; // → panic → hardReset
  }

  /** A client bug inside `ctx.request`, where a participant would take a throw for its own serializer's failure: the
   *  step finishes, then it is contained like any other throw out of a step. */
  private internalError(error: unknown): void {
    if (this.failure !== undefined) return; // the first one is reported
    this.failure = { error };
  }

  panic(error: unknown): void {
    this.hardReset(error);
  }

  lastResort(error: unknown): void {
    safeLog(this.logTarget, {
      level: 'error',
      event: 'internal',
      message: `the client could not contain an internal error: ${describeError(error)}`,
      data: { error },
    });
    if (this.stopCause !== undefined) return;
    this.phase = { state: 'WAITING' };
    this.clearLastResort();
    this.lastResortArmed = true;
    this.lastResortHandle = platformTimers.setTimeout(() => {
      this.submit({ kind: 'timer.retry', conn: CORE_CONN, gen: LAST_RESORT_GEN });
    }, this.o.retry.maxRetryDelay);
  }

  reportUnhandled(error: unknown): void {
    safeLog(this.logTarget, unhandledEntry(error, 'a delivery'));
  }

  // ------------------------------------------------------------------------------------------------ dispatch

  private dispatch(input: CoreInput): void {
    switch (input.kind) {
      case 'open':
        this.onOpenInput();
        return;
      case 'reconnect':
        this.onReconnect();
        return;
      case 'close':
        this.close(input.resolve);
        return;
      case 'op.start':
        this.opStart(input.op);
        return;
      case 'op.stop':
        this.opStop(input.op);
        return;
      case 'challenge.ok':
      case 'challenge.fail':
        this.challengeResult(input);
        return;
      case 'url.ok':
      case 'url.fail':
      case 'ws.open':
      case 'ws.message':
      case 'ws.closed':
      case 'handler.next':
      case 'handler.complete':
      case 'handler.error':
      case 'timer.op':
        this.connInput(input);
        return;
      case 'timer.retry':
      case 'timer.connect':
      case 'timer.handshake':
      case 'timer.challenge':
      case 'timer.stable':
      case 'timer.idle':
      case 'timer.ping':
      case 'timer.goodbye':
        if (input.conn === CORE_CONN) this.retryTimer(input);
        else this.connInput(input);
    }
  }

  /** The staleness rule: an input for another connection goes to its lingering record or is dropped. */
  private connInput(input: ConnInput): void {
    const p = this.phase;
    if (!('conn' in p) || p.conn.id !== input.conn) {
      const record = this.lingering.get(input.conn);
      if (record === undefined) this.stale(input);
      else this.lingeringInput(record, input);
      return;
    }
    if (input.kind === 'url.ok' || input.kind === 'url.fail') this.urlResult(p, input);
    else if (input.kind === 'ws.open') this.wsOpen(p, input);
    else if (input.kind === 'ws.message') this.wsMessage(p, input);
    else if (input.kind === 'ws.closed') this.wsClosed(p, input);
    else if ('invocation' in input) this.handlerEvent(p, input);
    else this.connTimer(p, input);
  }

  private handlerEvent(p: ConnPhase, input: HandlerEvent): void {
    if (p.state === 'ESTABLISHED') this.parts.register.handlerEvent(input, p.ctx);
    else this.stale(input);
  }

  /** The catch-all: drop + debug log; never throws. */
  private stale(
    input: ConnInput | Extract<CoreInput, { kind: 'challenge.ok' | 'challenge.fail' }>,
    why = 'stale',
  ): void {
    const state = this.phase.state;
    this.log(() => ({
      level: 'debug',
      event: 'frame.dropped',
      message: `dropped ${input.kind} (${why}) in ${state}`,
      data: { input: input.kind, state, conn: input.conn },
    }));
  }

  // ------------------------------------------------------------------------------------------------ API inputs

  private onOpenInput(): void {
    const p = this.phase;
    switch (p.state) {
      case 'CLOSED':
        this.startFromClosed();
        return;
      case 'WAITING':
        this.startSoon(); // the counter is kept
        return;
      case 'ESTABLISHED':
        this.parts.liveness.check(p.ctx); // a wake-up: probe now if nothing arrived for 2 s
        return;
      case 'RESOLVING':
      case 'CONNECTING':
      case 'HELLO_SENT':
      case 'CHALLENGED':
        return; // connecting: no-op
    }
  }

  /** `open()`/`reconnect()` from CLOSED: subject to the attempt floor like every app-driven attempt (INV-R2), so
   *  `close(); open()` cycles and an `onClose` observer that re-opens a client that gave up cannot spin. The
   *  first attempt of a client is never delayed (no attempt has started yet). */
  private startFromClosed(): void {
    this.stopCause = undefined;
    this.backoff.reset();
    this.startSoon();
  }

  private onReconnect(): void {
    const p = this.phase;
    if (p.state === 'CLOSED') {
      this.startFromClosed();
    } else if (p.state === 'WAITING') {
      this.backoff.reset();
      this.startSoon();
    } else if (p.state === 'ESTABLISHED') {
      this.linger(p.conn, this.bestEffort(p.conn, goodbyeFrame(Uri.CLOSE_REALM)));
      this.backoff.reset();
      this.end(
        p.conn,
        { initiator: 'app', reason: Uri.CLOSE_REALM, closeCode: CloseCode.NORMAL, wasClean: true },
        true,
      );
    } else {
      // RESOLVING … CHALLENGED: abandon the attempt, start a fresh one (new credentials, a new server override)
      const conn = p.conn;
      this.deliverCancel(conn, new CanceledError({ message: 'reconnect() abandoned this attempt' }));
      const closeCode = conn.hasSocket ? CloseCode.NORMAL : undefined;
      conn.release(CloseCode.NORMAL);
      this.backoff.reset();
      this.end(conn, { initiator: 'app', closeCode, wasClean: true }, true);
    }
  }

  /** The close procedure. */
  private close(resolve: () => void): void {
    const p = this.phase;
    if (p.state === 'CLOSED') {
      this.resolveWhenDone(resolve);
      if (this.stopCause === undefined) {
        // never opened: what it queued fails, the client is stopped; no lifecycle event
        this.stopCause = new ConnectionClosedError({ gaveUp: false });
        this.clientClosed(this.stopCause);
      }
      return;
    }
    // An open() that waits for the attempt floor after close() or a give-up has announced nothing yet: closing it again
    // is as quiet as a close() in CLOSED (status stays the closed it shows; INV-R7, INV-R9)
    const announce = p.state !== 'WAITING' || this.announcedRetry;
    // before any I/O
    const stopCause = new ConnectionClosedError({ gaveUp: false });
    this.stopCause = stopCause;
    this.phase = { state: 'CLOSED' };
    this.coreTimers.cancel('retry');
    this.clearLastResort();
    let session: Session | undefined;
    let closeCode: number | undefined;
    if (p.state === 'WAITING') {
      this.deliverCancel(undefined, stopCause); // nothing should be pending; harmless if nothing is
    } else {
      const conn = p.conn;
      conn.ended = true;
      closeCode = conn.hasSocket ? CloseCode.NORMAL : undefined;
      if (p.state === 'ESTABLISHED') {
        session = p.ctx.session;
        this.linger(conn, this.bestEffort(conn, goodbyeFrame(Uri.CLOSE_REALM)));
      } else {
        this.deliverCancel(conn, stopCause);
        conn.release(CloseCode.NORMAL);
      }
    }
    this.resolveWhenDone(resolve); // the connections that exist now (a participant bug below cannot lose it)
    this.openSubject.clear();
    this.backoff.reset();
    const info: CloseInfo = Object.freeze({
      initiator: 'app',
      reason: session === undefined ? undefined : Uri.CLOSE_REALM,
      details: EMPTY,
      closeCode,
      wasClean: true,
      sessionId: session?.id,
      error: undefined,
      willRetry: false,
      delay: undefined,
      attempt: 0,
    });
    if (announce) this.notifyEnd(info, session !== undefined);
    // Liveness and the participants run last: the socket is lingering (or released) and the app has been told, so a
    // bug in one of them (hardReset) can neither leak the socket nor hide the close (INV-R7).
    if (session !== undefined) this.parts.liveness.sessionEnded(false);
    this.clientClosed(stopCause, session?.id);
  }

  /** Resolve a close() promise once the connections lingering now are done. */
  private resolveWhenDone(resolve: () => void): void {
    const records = [...this.lingering.values()];
    if (records.length === 0) resolve();
    else
      void Promise.all(records.map((l) => l.done)).then(() => {
        resolve();
      });
  }

  private opStart(op: AnyOp): void {
    if (op.subscriber.closed) return; // unsubscribed before its start was processed
    const p = this.phase;
    if (p.state === 'CLOSED' && this.stopCause !== undefined) {
      this.failStopped(op, this.stopCause);
      return;
    }
    this.registry.add(op);
    const ctx = p.state === 'ESTABLISHED' ? p.ctx : undefined;
    if (op.kind === 'topic' || op.kind === 'register') {
      this.startInterest(op, ctx);
      return;
    }
    if (ctx !== undefined && this.registry.queuedCount === 0 && this.write(op, ctx) === 'done') return;
    this.registry.enqueue(op); // waits for a session, or behind the ops already waiting (start order)
  }

  private opStop(op: AnyOp): void {
    const queued = (op.kind === 'call' || op.kind === 'publish') && this.registry.dequeue(op);
    this.registry.remove(op);
    if (queued) return; // never written: nothing to undo
    const p = this.phase;
    const ctx = p.state === 'ESTABLISHED' ? p.ctx : undefined;
    switch (op.kind) {
      case 'call':
        this.parts.call.stop(op, ctx);
        return;
      case 'publish':
        this.parts.publish.stop(op);
        return;
      case 'topic':
        this.parts.topic.stop(op, ctx, this.fx);
        return;
      case 'register':
        this.parts.register.stop(op, ctx, this.fx);
    }
  }

  private startInterest(op: InterestOp, ctx: SessionCtx | undefined): void {
    if (op.kind === 'topic') this.parts.topic.start(op, ctx, this.fx);
    else this.parts.register.start(op, ctx, this.fx);
  }

  private write(op: OneShotOp, ctx: SessionCtx): 'done' | 'not-sent' {
    return op.kind === 'call' ? this.parts.call.write(op, ctx) : this.parts.publish.write(op, ctx);
  }

  /** Error `op` with the stop's error (with its procedure/topic): work started while stopped, or still waiting at
   *  close()/give-up/hardReset. */
  private failStopped(op: AnyOp, stopCause: ConnectionClosedError): void {
    const error = stopErrorOf(stopCause, uriOf(op));
    this.loop.deliver(() => {
      op.subscriber.error(error);
    });
  }

  // ------------------------------------------------------------------------------------------------ attempts

  /** Start an attempt now. */
  private startAttempt(): void {
    this.coreTimers.cancel('retry');
    this.clearLastResort();
    this.lastAttemptStart = this.clock.now();
    const conn = new Connection(++this.connSeq, new TimerScope(this.clock), this.serializer, (frame, data) => {
      this.log(() => frameEntry('out', frame, frameBytes(data)));
    });
    conn.deadline = adaptiveDeadline(this.o.timeouts.connect, this.kConnect);
    this.arm(conn, 'connect', conn.deadline, true);
    const attempt = this.backoff.attempts + 1;
    this.emitStatus({ state: 'connecting', attempt });
    const url = this.o.url;
    this.log(() => ({
      level: 'info',
      event: 'attempt.start',
      message: `attempt ${String(attempt)} (connection ${String(conn.id)})`,
      data: { attempt, conn: conn.id, ...(typeof url === 'string' ? { url: redactUrl(url) } : {}) },
    }));
    if (typeof url === 'string') {
      this.createSocket(conn, url);
    } else {
      this.phase = { state: 'RESOLVING', conn };
      this.deliverResolver(conn, url);
    }
  }

  /** `open()`/`reconnect()`/a late challenge answer while waiting: never within the attempt floor of the previous
   *  attempt's start. */
  private startSoon(): void {
    const remaining = this.floorRemaining();
    if (remaining === 0) {
      this.startAttempt();
      return;
    }
    this.phase = { state: 'WAITING' };
    // it cuts a wait, it never lengthens one: a retry that is due before the floor ends stays as it is (a clock that
    // went back since the retry was armed: it is due within its delay from now at the latest)
    const now = this.clock.now();
    if (this.coreTimers.isArmed('retry') && Math.min(this.retryDue, now + this.retryDelay) <= now + remaining) return;
    this.armRetry(remaining);
  }

  private floorRemaining(): number {
    const floor = this.o.internal.attemptFloor;
    const elapsed = this.clock.now() - this.lastAttemptStart;
    return elapsed >= floor ? 0 : clampDelay(floor - elapsed, floor); // a clock that went back waits one floor
  }

  private armRetry(delay: number): void {
    this.retryDue = this.clock.now() + delay;
    this.retryDelay = delay;
    this.coreTimers.arm('retry', delay, (gen) => {
      this.submit({ kind: 'timer.retry', conn: CORE_CONN, gen });
    });
  }

  /** `timer.retry` (the core's own scope; `conn` is CORE_CONN), and `lastResort`'s platform timer. */
  private retryTimer(input: TimerInput): void {
    let armed: boolean;
    if (input.gen === LAST_RESORT_GEN) {
      armed = this.lastResortArmed;
      this.lastResortArmed = false;
    } else {
      armed = this.coreTimers.claim('retry', input.gen);
    }
    if (armed && this.phase.state === 'WAITING') this.startAttempt();
    else this.stale(input);
  }

  private clearLastResort(): void {
    if (!this.lastResortArmed) return;
    this.lastResortArmed = false;
    platformTimers.clearTimeout(this.lastResortHandle);
  }

  /** RESOLVING: the app's `url()` runs in a delivery; its first value (any Input) comes back as `url.*`. */
  private deliverResolver(conn: Connection, url: Exclude<NormalizedOptions['url'], string>): void {
    this.loop.deliver(() => {
      if (conn.ended) return; // the attempt ended before the resolver could run: never ask the app for it
      const fail = (error: unknown): void => {
        this.submit({ kind: 'url.fail', conn: conn.id, error });
      };
      try {
        conn.cancelResolver = firstValue<unknown>(
          url(),
          (value) => {
            this.submit({ kind: 'url.ok', conn: conn.id, url: value });
          },
          fail,
          () => {
            fail(new TypeError('the url resolver completed without a value'));
          },
          this.reporter,
        );
      } catch (error) {
        fail(error); // url() threw; firstValue itself never throws
      }
    });
  }

  private urlResult(p: ConnPhase, input: Extract<CoreInput, { kind: 'url.ok' | 'url.fail' }>): void {
    if (p.state !== 'RESOLVING') {
      this.stale(input);
      return;
    }
    if (input.kind === 'url.ok' && typeof input.url === 'string' && input.url !== '') {
      this.createSocket(p.conn, input.url);
      return;
    }
    const cause = input.kind === 'url.fail' ? input.error : new TypeError('url must be a non-empty string');
    this.end(p.conn, {
      initiator: 'connection',
      wasClean: false,
      error: new ConnectionLostError({ message: 'url resolution failed', cause }),
    });
  }

  private createSocket(conn: Connection, url: string): void {
    conn.url = url;
    this.phase = { state: 'CONNECTING', conn };
    const id = conn.id;
    try {
      const Ctor = this.faults.enabled ? this.faults.sockets(this.o.WebSocket) : this.o.WebSocket;
      conn.transport = openWebSocket(Ctor, url, [this.serializer.protocol], {
        open: (protocol) => {
          this.submit({ kind: 'ws.open', conn: id, protocol });
        },
        message: (data) => {
          this.submit({ kind: 'ws.message', conn: id, data });
        },
        closed: (code, reason, wasClean, error) => {
          this.submit({
            kind: 'ws.closed',
            conn: id,
            code,
            reason,
            wasClean,
            ...(error === undefined ? {} : { error }),
          });
        },
      });
    } catch (error) {
      this.end(conn, {
        initiator: 'connection',
        wasClean: false,
        error: new ConnectionLostError({ message: 'the WebSocket could not be created', cause: error }),
      });
    }
  }

  private wsOpen(p: ConnPhase, input: Extract<CoreInput, { kind: 'ws.open' }>): void {
    if (p.state !== 'CONNECTING') {
      this.stale(input, 'second open');
      return;
    }
    const conn = p.conn;
    if (input.protocol !== this.serializer.protocol && input.protocol !== '') {
      conn.release(CloseCode.PROTOCOL_VIOLATION);
      this.end(conn, {
        initiator: 'connection',
        closeCode: CloseCode.PROTOCOL_VIOLATION,
        wasClean: false,
        error: new ProtocolError({ message: `the router selected the subprotocol "${input.protocol}", not offered` }),
      });
      return;
    }
    conn.timers.cancel('connect');
    this.kConnect = 0;
    conn.gate = 'hello';
    this.phase = { state: 'HELLO_SENT', conn };
    const auth = this.helloAuth(conn);
    if (auth === undefined) return;
    if (this.writeHandshake(conn, helloFrame(this.o.realm, helloDetails(auth)))) this.armHandshake(conn);
  }

  /** This attempt's auth keys, kept on the connection: the function options are called now. Undefined when one threw
   *  or returned an invalid value: the attempt ended (AuthenticationError, retried with backoff). */
  private helloAuth(conn: Connection): HelloAuth | undefined {
    try {
      conn.auth = helloAuth(this.o);
      return conn.auth;
    } catch (cause) {
      conn.release(CloseCode.NORMAL);
      this.end(conn, {
        initiator: 'connection',
        closeCode: CloseCode.NORMAL,
        wasClean: true,
        error: new AuthenticationError({ message: 'the authmethods, authid or authextra option failed', cause }),
      });
      return undefined;
    }
  }

  private armHandshake(conn: Connection): void {
    conn.deadline = adaptiveDeadline(this.o.timeouts.handshake, this.kHandshake);
    this.arm(conn, 'handshake', conn.deadline, true);
  }

  /** HELLO / AUTHENTICATE. False when a throw ended the attempt (a custom serializer that cannot write it); a refused
   *  write is true (the adapter has queued the loss). */
  private writeHandshake(conn: Connection, frame: OutboundFrame): boolean {
    try {
      conn.write(frame);
      return true;
    } catch (error) {
      conn.release(CloseCode.NORMAL);
      this.end(conn, {
        initiator: 'connection',
        closeCode: CloseCode.NORMAL,
        wasClean: true,
        error: new ProtocolError({ message: 'a handshake frame could not be serialized', cause: error }),
      });
      return false;
    }
  }

  /** ABORT / GOODBYE: nothing depends on them; a throw (a custom serializer) or a refusal is ignored. True if written. */
  private bestEffort(conn: Connection, frame: OutboundFrame): boolean {
    try {
      return conn.write(frame);
    } catch (error) {
      this.log(() => ({
        level: 'warn',
        event: 'request.error',
        message: `${frame[0] === MessageType.GOODBYE ? 'GOODBYE' : 'ABORT'} could not be serialized; skipped`,
        data: { error },
      }));
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------------ inbound

  private wsMessage(p: ConnPhase, input: Extract<CoreInput, { kind: 'ws.message' }>): void {
    if (p.state === 'RESOLVING' || p.state === 'CONNECTING') {
      this.stale(input, 'before open');
      return;
    }
    const msg = this.decodeFrame(p.conn, input.data);
    if (msg === undefined) return;
    if (p.state === 'ESTABLISHED') this.established(p, msg);
    else this.handshake(p.conn, msg);
  }

  /** deserialize → decode; a header-fatal frame ends the connection (protocol violation); dropped frames are
   *  logged. Undefined unless there is a message to handle. */
  private decodeFrame(conn: Connection, data: unknown): InboundMessage | undefined {
    let value: unknown;
    try {
      value = this.serializer.deserialize(data as Parameters<Serializer['deserialize']>[0]);
    } catch (error) {
      this.violation(conn, `the frame could not be deserialized: ${describeError(error)}`, frameText(data));
      return undefined;
    }
    this.log(() => frameEntry('in', value, rawBytes(data)));
    const result = decode(value);
    if (result.kind === 'fatal') {
      this.violation(conn, result.reason, result.frame);
      return undefined;
    }
    if (result.kind === 'dropped') {
      this.log(() => ({
        level: result.level,
        event: 'frame.dropped',
        message: result.reason,
        data: { frame: result.frame },
      }));
      return undefined;
    }
    for (const warning of result.warnings) {
      this.log(() => ({ level: 'warn', event: 'protocol.violation', message: `tolerated: ${warning}` }));
    }
    return result.message;
  }

  /** A header-fatal frame (or `ctx.violation`): ABORT protocol_violation, close 4000, reconnect. */
  private violation(conn: Connection, message: string, frame: string): void {
    this.bestEffort(conn, abortFrame(Uri.PROTOCOL_VIOLATION, message));
    conn.release(CloseCode.PROTOCOL_VIOLATION);
    this.log(() => ({ level: 'warn', event: 'protocol.violation', message, data: { frame } }));
    this.end(conn, {
      initiator: 'connection',
      reason: Uri.PROTOCOL_VIOLATION,
      closeCode: CloseCode.PROTOCOL_VIOLATION,
      wasClean: false,
      error: new ProtocolError({ message, frame }),
    });
  }

  /** HELLO_SENT / CHALLENGED. */
  private handshake(conn: Connection, msg: InboundMessage): void {
    switch (msg.type) {
      case MessageType.WELCOME:
        this.welcome(conn, msg);
        return;
      case MessageType.CHALLENGE:
        this.challenge(conn, msg);
        return;
      case MessageType.ABORT:
      case MessageType.GOODBYE:
        // GOODBYE before WELCOME is handled like ABORT, without a reply; Crossbar keeps the socket open
        conn.release(CloseCode.NORMAL);
        this.end(conn, {
          initiator: 'router',
          reason: msg.reason,
          details: msg.details,
          closeCode: CloseCode.NORMAL,
          wasClean: true,
          error: new AbortError({ reason: msg.reason, details: msg.details }),
        });
        return;
      case MessageType.ERROR:
      case MessageType.PUBLISHED:
      case MessageType.SUBSCRIBED:
      case MessageType.UNSUBSCRIBED:
      case MessageType.EVENT:
      case MessageType.RESULT:
      case MessageType.REGISTERED:
      case MessageType.UNREGISTERED:
      case MessageType.INVOCATION:
      case MessageType.INTERRUPT:
        this.log(() => ({
          level: 'debug',
          event: 'frame.dropped',
          message: `dropped message type ${String(msg.type)} before WELCOME`,
        }));
    }
  }

  /** The anonymous-WELCOME rule: a client whose `authmethods` leave out `anonymous` and that got no CHALLENGE
   *  rejects a WELCOME that is (or looks) anonymous. */
  private anonymous(conn: Connection, details: Dict): boolean {
    const methods = conn.auth.authmethods;
    if (methods.length === 0 || methods.includes('anonymous') || conn.challenged) return false;
    return (
      details['authmethod'] === 'anonymous' ||
      (details['authmethod'] === undefined && details['authid'] === undefined) ||
      details['authmethods'] !== undefined // a HELLO-only key: Thruway PHP's echo WELCOME
    );
  }

  private welcome(conn: Connection, msg: InboundWelcome): void {
    if (this.anonymous(conn, msg.details)) {
      conn.rejectedSessionId = msg.sessionId;
      this.bestEffort(conn, goodbyeFrame(Uri.CLOSE_REALM));
      conn.release(CloseCode.NORMAL);
      this.end(conn, {
        initiator: 'connection',
        reason: Uri.CLOSE_REALM,
        closeCode: CloseCode.NORMAL,
        wasClean: true,
        error: new AuthenticationError({ message: 'router welcomed the session anonymously' }),
      });
      return;
    }
    if (this.phase.state === 'CHALLENGED') {
      this.deliverCancel(undefined, new CanceledError({ message: 'the router welcomed the session' }));
    }
    conn.timers.cancel('handshake');
    conn.timers.cancel('challenge');
    conn.settling = undefined;
    this.kHandshake = 0;
    conn.gate = 'open';
    const session: Session = Object.freeze({ id: msg.sessionId, realm: this.o.realm, details: msg.details });
    conn.session = session;
    const ids = this.o.requestIds === 'sequential' ? new SequentialIds() : this.randomIds;
    const ctx = this.makeCtx(conn, session, ids);
    this.phase = { state: 'ESTABLISHED', conn, ctx };
    this.arm(conn, 'stable', this.o.internal.stable, false);
    const roles = msg.details['roles'];
    // The probe capability, strike and budget belong to the router this connection reached
    this.parts.liveness.endpoint(conn.url);
    this.parts.liveness.start(ctx, isPlainObject(roles) ? roles : EMPTY);
    this.emitStatus({ state: 'open', session });
    this.openSubject.emit(session, this.deliverFn);
    this.log(() => ({
      level: 'info',
      event: 'session.open',
      message: `session ${String(session.id)} established`,
      data: { sessionId: session.id, conn: conn.id },
    }));
    this.parts.register.welcome(ctx);
    this.parts.topic.welcome(ctx);
    for (const op of this.registry.queued()) {
      if (this.write(op, ctx) === 'not-sent') break; // the gate closed (a refused write): the rest stay queued, in order
      this.registry.dequeue(op);
    }
  }

  private challenge(conn: Connection, msg: InboundChallenge): void {
    const method = msg.authMethod;
    const methods = conn.auth.authmethods;
    if (this.o.onChallenge === undefined) {
      this.cannotAuthenticate(conn, 'no onChallenge handler', method, undefined);
      return;
    }
    if (!methods.includes(method)) {
      this.cannotAuthenticate(conn, `CHALLENGE for authmethod "${method}", which was not offered`, method, undefined);
      return;
    }
    if (conn.round >= MAX_ROUNDS) {
      this.cannotAuthenticate(conn, `more than ${String(MAX_ROUNDS)} CHALLENGE rounds`, method, undefined);
      return;
    }
    const answered = this.phase.state === 'HELLO_SENT'; // else CHALLENGED: a newer CHALLENGE for the pending round
    conn.round++;
    conn.challenged = true;
    conn.timers.cancel('handshake'); // the router answered; the app may take as long as it needs
    if (answered) {
      const last = conn.lastAnsweredMethod;
      if (last !== undefined && last !== method) {
        this.log(() => ({
          level: 'warn',
          event: 'challenge.mismatch',
          message: `CHALLENGE for ${method} after an AUTHENTICATE for ${last}: offer one authmethod per realm on Thruway PHP`,
          data: { authMethod: method, answered: last, round: conn.round },
        }));
      }
      this.phase = { state: 'CHALLENGED', conn };
      if (conn.round === 1 && methods.length > 1) {
        // settle window: Thruway PHP sends one CHALLENGE per matching method, back to back
        conn.settling = msg;
        this.arm(conn, 'challenge', this.o.internal.settle, false);
      } else {
        this.runRound(conn, msg);
      }
    } else if (conn.settling !== undefined) {
      conn.settling = msg; // a newer CHALLENGE replaces the held one; the window stays bounded by the first
    } else {
      // latest wins: Thruway PHP verifies AUTHENTICATE against the last CHALLENGE it sent
      this.deliverCancel(undefined, new CanceledError({ message: 'A newer CHALLENGE superseded this one' }));
      this.runRound(conn, msg);
    }
  }

  private runRound(conn: Connection, msg: InboundChallenge): void {
    conn.roundMethod = msg.authMethod;
    const round = conn.round;
    const challenge = { authMethod: msg.authMethod, extra: msg.extra };
    this.loop.deliver(() => {
      if (conn.ended || conn.round !== round) return; // ended or superseded meanwhile: never ask the app
      try {
        this.runner.run(conn.id, round, challenge);
      } catch (error) {
        // the runner catches the app's errors itself; should it throw, the attempt must not wait forever
        this.submit({ kind: 'challenge.fail', conn: conn.id, round, error });
      }
    });
  }

  private cannotAuthenticate(conn: Connection, message: string, authMethod: string | undefined, cause: unknown): void {
    this.bestEffort(conn, abortFrame(Uri.CANNOT_AUTHENTICATE, message));
    conn.release(CloseCode.NORMAL);
    this.end(conn, {
      initiator: 'connection',
      reason: Uri.CANNOT_AUTHENTICATE,
      closeCode: CloseCode.NORMAL,
      wasClean: true,
      error: make(AuthenticationError, { message, authMethod, cause }),
    });
  }

  private challengeResult(input: Extract<CoreInput, { kind: 'challenge.ok' | 'challenge.fail' }>): void {
    const p = this.phase;
    if (p.state !== 'CHALLENGED' || p.conn.id !== input.conn) {
      // a late answer for an ended connection while waiting starts the next attempt early
      if (input.kind === 'challenge.ok' && p.state === 'WAITING') {
        this.stale(input, 'late answer, the next attempt starts early');
        this.startSoon();
      } else {
        this.stale(input);
      }
      return;
    }
    const conn = p.conn;
    if (input.round !== conn.round || conn.settling !== undefined) {
      this.stale(input, 'another round');
    } else if (input.kind === 'challenge.fail') {
      this.cannotAuthenticate(conn, 'the challenge handler failed', conn.roundMethod, input.error);
    } else if (this.writeHandshake(conn, authenticateFrame(input.signature))) {
      conn.lastAnsweredMethod = conn.roundMethod;
      this.phase = { state: 'HELLO_SENT', conn };
      this.armHandshake(conn);
    }
  }

  /** ESTABLISHED: liveness first, then the session-level messages, then routing. */
  private established(p: Extract<Phase, { state: 'ESTABLISHED' }>, msg: InboundMessage): void {
    const { conn, ctx } = p;
    if (this.parts.liveness.inbound(msg, ctx)) return; // the probe's answer
    switch (msg.type) {
      case MessageType.GOODBYE:
        // reply for every reason (a MUST of the WAMP spec, Session Closing); released at once, so an echo reaches a
        // closed gate
        this.bestEffort(conn, goodbyeFrame(Uri.GOODBYE_AND_OUT));
        conn.release(CloseCode.NORMAL);
        this.end(conn, {
          initiator: 'router',
          reason: msg.reason,
          details: msg.details,
          closeCode: CloseCode.NORMAL,
          wasClean: true,
        });
        return;
      case MessageType.ABORT:
        conn.release(CloseCode.NORMAL);
        this.end(conn, {
          initiator: 'router',
          reason: msg.reason,
          details: msg.details,
          closeCode: CloseCode.NORMAL,
          wasClean: true,
          error: new AbortError({ reason: msg.reason, details: msg.details }),
        });
        return;
      case MessageType.WELCOME:
      case MessageType.CHALLENGE:
        this.log(() => ({
          level: 'warn',
          event: 'frame.dropped',
          message: `dropped message type ${String(msg.type)} in an established session`,
        }));
        return;
      case MessageType.ERROR:
      case MessageType.PUBLISHED:
      case MessageType.SUBSCRIBED:
      case MessageType.UNSUBSCRIBED:
      case MessageType.EVENT:
      case MessageType.RESULT:
      case MessageType.REGISTERED:
      case MessageType.UNREGISTERED:
      case MessageType.INVOCATION:
      case MessageType.INTERRUPT:
        if (!this.route(msg, ctx)) {
          this.log(() => ({
            level: 'debug',
            event: 'frame.dropped',
            message: `dropped message type ${String(msg.type)}: no record for it`,
          }));
        }
    }
  }

  /** Routing; false ⇒ nobody consumed it. */
  private route(msg: InboundMessage, ctx: SessionCtx): boolean {
    const p = this.parts;
    if (msg.type === MessageType.ERROR) {
      switch (msg.requestType) {
        case MessageType.CALL:
        case MessageType.CANCEL:
          return p.call.inbound(msg, ctx);
        case MessageType.PUBLISH:
          return p.publish.inbound(msg, ctx);
        case MessageType.SUBSCRIBE:
        case MessageType.UNSUBSCRIBE:
          return p.topic.inbound(msg, ctx);
        case MessageType.REGISTER:
        case MessageType.UNREGISTER:
          return p.register.inbound(msg, ctx);
        default:
          return false; // Thruway's [8,8,…] after killnowait, and every other request type
      }
    }
    if (msg.type === MessageType.RESULT) return p.call.inbound(msg, ctx);
    if (msg.type === MessageType.PUBLISHED) return p.publish.inbound(msg, ctx);
    if (
      msg.type === MessageType.SUBSCRIBED ||
      msg.type === MessageType.UNSUBSCRIBED ||
      msg.type === MessageType.EVENT
    ) {
      return p.topic.inbound(msg, ctx);
    }
    return p.register.inbound(msg, ctx); // REGISTERED, UNREGISTERED, INVOCATION, INTERRUPT
  }

  private wsClosed(p: ConnPhase, input: Extract<CoreInput, { kind: 'ws.closed' }>): void {
    if (p.state === 'RESOLVING') {
      this.stale(input); // no socket yet
      return;
    }
    const reason = input.reason === '' ? '' : `: ${input.reason}`;
    this.end(p.conn, {
      initiator: 'connection',
      closeCode: input.code,
      wasClean: input.wasClean,
      error: make(ConnectionLostError, {
        message: `socket closed (${String(input.code)})${reason}`,
        closeCode: input.code,
        cause: input.error,
      }),
    });
  }

  /** Timers of the current connection: handled in the states they belong to and only while their generation is armed;
   *  otherwise the catch-all. */
  private connTimer(p: ConnPhase, input: TimerInput): void {
    const conn = p.conn;
    const fired = (key: string): boolean => conn.timers.claim(key, input.gen);
    const state = p.state;
    if (input.kind === 'timer.op') {
      if (p.state === 'ESTABLISHED' && fired(`op:${input.owner}:${String(input.key)}`)) {
        this.parts[input.owner].timer(input.key, p.ctx);
        return;
      }
    } else if (input.kind === 'timer.connect') {
      if ((state === 'RESOLVING' || state === 'CONNECTING') && fired('connect')) {
        conn.release(CloseCode.CLIENT_TIMEOUT); // end() delivers the resolver's cancel
        this.kConnect++;
        this.end(conn, {
          initiator: 'connection',
          closeCode: state === 'CONNECTING' ? CloseCode.CLIENT_TIMEOUT : undefined,
          wasClean: false,
          error: new TimeoutError({ timer: 'connect', timeout: conn.deadline }),
        });
        return;
      }
    } else if (input.kind === 'timer.handshake') {
      if (state === 'HELLO_SENT' && fired('handshake')) {
        this.kHandshake++;
        this.timeout(conn, new TimeoutError({ timer: 'handshake', timeout: conn.deadline }));
        return;
      }
    } else if (input.kind === 'timer.challenge') {
      const held = conn.settling;
      if (state === 'CHALLENGED' && held !== undefined && fired('challenge')) {
        conn.settling = undefined;
        this.runRound(conn, held);
        return;
      }
    } else if (p.state === 'ESTABLISHED') {
      if (input.kind === 'timer.stable' && fired('stable')) {
        this.backoff.markStable();
        return;
      }
      if (input.kind === 'timer.idle' && fired('idle')) {
        this.parts.liveness.onIdle(p.ctx);
        return;
      }
      if (input.kind === 'timer.ping' && fired('ping')) {
        const liveness = this.parts.liveness;
        if (liveness.onPing(p.ctx) === 'dead') {
          // idle + the ping budget in force, which doubled after earlier liveness ends
          const timeout = this.o.timeouts.idle + liveness.budget(p.ctx);
          this.timeout(conn, new TimeoutError({ timer: 'liveness', timeout }));
        }
        return;
      }
    }
    this.stale(input, 'not armed');
  }

  /** A deadline expired: close 4001, end (handshake, liveness). */
  private timeout(conn: Connection, error: TimeoutError): void {
    conn.release(CloseCode.CLIENT_TIMEOUT);
    this.end(conn, { initiator: 'connection', closeCode: CloseCode.CLIENT_TIMEOUT, wasClean: false, error });
  }

  // ------------------------------------------------------------------------------------------------ lingering

  /** Move an established connection to the lingering set after the client's own GOODBYE. `sent`: the GOODBYE
   *  was written (otherwise nothing will answer it: the record finishes at once). */
  private linger(conn: Connection, sent: boolean): void {
    const record = new Lingering(conn, this.o.internal.goodbye, (gen) => {
      this.submit({ kind: 'timer.goodbye', conn: conn.id, gen });
    });
    this.lingering.set(conn.id, record);
    if (!sent) this.finishLingering(record, false);
  }

  private finishLingering(record: Lingering, terminate: boolean): void {
    this.lingering.delete(record.id);
    record.finish(terminate);
  }

  /** Inputs routed to a lingering connection: GOODBYE (any reason) / ABORT / its socket's close / its timer
   *  finish it; everything else is dropped (nothing is ever answered there). */
  private lingeringInput(record: Lingering, input: ConnInput): void {
    if (
      input.kind === 'ws.closed' ||
      (input.kind === 'ws.message' && this.endsLingering(input.data)) ||
      (input.kind === 'timer.goodbye' && record.connection.timers.claim('goodbye', input.gen))
    ) {
      this.finishLingering(record, input.kind === 'timer.goodbye');
      return;
    }
    this.stale(input, 'lingering connection');
  }

  /** A GOODBYE or ABORT (undecodable frames are ignored: never answered). */
  private endsLingering(data: unknown): boolean {
    let value: unknown;
    try {
      value = this.serializer.deserialize(data as Parameters<Serializer['deserialize']>[0]);
    } catch {
      return false;
    }
    const result = decode(value);
    return (
      result.kind === 'message' &&
      (result.message.type === MessageType.GOODBYE || result.message.type === MessageType.ABORT)
    );
  }

  // ------------------------------------------------------------------------------------------------ end procedure

  /** The end procedure: gate → notify → fail → schedule. Exactly once per connection. */
  private end(conn: Connection, cause: EndCause, forceRetry = false): void {
    // Exactly one end per connection, so one reconnect per loss: every caller handles an input of the current
    // connection, whose phase this end leaves at once; later inputs of it are stale.
    // 1. gate
    conn.ended = true;
    conn.release(CloseCode.NORMAL); // a no-op when released already or lingering
    const session = conn.session;
    // the session is over for every reader from here on, the app's retryDelay included; nothing below can
    // throw before the notification: liveness and the participants run after it
    this.phase = { state: 'WAITING' };
    this.openSubject.clear();
    // 2. count the failure
    const n = forceRetry ? 0 : this.backoff.fail();
    const sessionId = session?.id ?? conn.rejectedSessionId;
    if (cause.error !== undefined) setContext(cause.error, { attempt: n, sessionId: session?.id });
    // 3. the delay, or null to give up
    let delay: number | null;
    if (forceRetry) delay = this.floorRemaining();
    else if (n > this.o.retry.maxRetries) delay = null;
    else delay = this.backoff.delay(n, (d) => closeInfo(cause, sessionId, n, true, d));
    const willRetry = delay !== null;
    // 4. notify
    const info = closeInfo(cause, sessionId, n, willRetry, delay ?? undefined);
    this.notifyEnd(info, session !== undefined);
    // The outcome is settled before liveness and the participants run, so a bug in one of them finds this end
    // complete — announced, with its retry armed or the client stopped — and hardReset neither announces it again,
    // counts a second failure nor gives up without telling the app.
    const stopCause = delay === null ? this.stop(info.error) : undefined;
    if (delay !== null) {
      this.logRetry(delay, n);
      // Armed now also for reconnect() (its startSoon() below, after the failures are queued, keeps it or starts at
      // once): a bug in liveness or a participant then finds the announced retry armed and keeps it
      this.armRetry(delay);
    }
    // step 1's liveness cleanup (it runs no app code: its place after the notification is invisible)
    this.ending = session;
    this.parts.liveness.sessionEnded(cause.error instanceof TimeoutError && cause.error.timer === 'liveness');
    // 5. fail
    const lost = (context: { requestId?: number; procedure?: string; topic?: string }): ConnectionLostError =>
      make(ConnectionLostError, {
        reason: info.reason,
        closeCode: info.closeCode,
        cause: info.error,
        sessionId: session?.id,
        ...context,
      });
    const inflightError = willRetry
      ? lost
      : (context: { requestId?: number; procedure?: string; topic?: string }): ThruwayError =>
          make(ConnectionClosedError, { gaveUp: true, cause: lost(context), sessionId: session?.id, ...context });
    if (session !== undefined) {
      const endInfo: EndInfo = { info, inflightError };
      const p = this.parts;
      p.call.sessionEnded(endInfo, this.fx);
      p.publish.sessionEnded(endInfo, this.fx);
      p.topic.sessionEnded(endInfo, this.fx);
      p.register.sessionEnded(endInfo, this.fx);
    } else {
      this.deliverCancel(conn, inflightError({}));
    }
    this.ending = undefined;
    // 6. schedule (armed above), or give up: every remaining op and interest errors the stop's error
    if (stopCause !== undefined) this.clientClosed(stopCause);
    else if (forceRetry) this.startSoon();
  }

  private logRetry(delay: number, attempt: number): void {
    this.log(() => ({
      level: 'info',
      event: 'retry.scheduled',
      message: `next attempt in ${String(delay)} ms`,
      data: { delay, attempt },
    }));
  }

  /** The notify step of the end and close procedures: status, onClose, log. */
  private notifyEnd(info: CloseInfo, hadSession: boolean): void {
    this.announcedRetry = info.willRetry;
    this.emitStatus({ state: 'closed', closed: info });
    this.closeSubject.emit(info, this.deliverFn);
    const what = hadSession ? 'session' : 'attempt';
    this.log(() => ({
      level: 'info',
      event: `${what}.end`,
      message: `${what} ended (${info.initiator}${info.reason === undefined ? '' : `, ${info.reason}`})`,
      data: { info },
    }));
  }

  /** Give-up (the last step of `end()`): CLOSED and stopped; new work fails with `ConnectionClosedError{gaveUp: true, cause}`.
   *  The caller fails what is left. */
  private stop(cause: ThruwayError | undefined): ConnectionClosedError {
    const stopCause = make(ConnectionClosedError, { gaveUp: true, cause });
    this.phase = { state: 'CLOSED' };
    this.stopCause = stopCause;
    this.backoff.reset();
    return stopCause;
  }

  /** close() and give-up: every participant fails what it holds, each record with the stop's error in its own context;
   *  queued one-shots fail the same way. `sessionId`: the session close() ended, which the errors of
   *  the records in flight in it name. */
  private clientClosed(stopCause: ConnectionClosedError, sessionId?: number): void {
    const p = this.parts;
    const stopError: StopError = (context) => stopErrorOf(stopCause, context, sessionId);
    p.call.clientClosed(stopError, this.fx);
    p.publish.clientClosed(stopError, this.fx);
    p.topic.clientClosed(stopError, this.fx);
    p.register.clientClosed(stopError, this.fx);
    const queued = new Set<AnyOp>(this.registry.clearQueue());
    for (const op of queued) this.failStopped(op, stopCause);
    // A subscription no participant holds (a hardReset could not restart it) ends here too: close() and give-up end
    // every live one. One a participant failed above is closed by the time this error is delivered.
    for (const op of this.registry.live()) if (!queued.has(op)) this.failStopped(op, stopCause);
  }

  /** Deliver the challenge runner's cancel and the url resolver's cancel (each in its own try/catch; both
   *  idempotent: a no-op when nothing is pending). */
  private deliverCancel(conn: Connection | undefined, reason: ThruwayError): void {
    this.loop.deliver(() => {
      try {
        this.runner.cancel(reason);
      } catch (error) {
        this.reportUnhandled(error); // the runner catches the app's errors itself: only a bug of its own lands here
      }
      conn?.cancelResolver?.(); // firstValue's cancel: an unsubscribe, which reports a throwing teardown itself
    });
  }

  // ------------------------------------------------------------------------------------------------ hardReset

  /** Contain a client bug. No participant logic runs; every action is its own try/catch. */
  private hardReset(error: unknown): void {
    const attempt = (action: () => void): void => {
      try {
        action();
      } catch (e) {
        safeLog(this.logTarget, unhandledEntry(e, 'hardReset'));
      }
    };
    // log first
    safeLog(this.logTarget, {
      level: 'error',
      event: 'internal',
      message: `internal error, the client was reset: ${describeError(error)}`,
      data: { error },
    });
    const p = this.phase;
    const internal = (): ProtocolError => new ProtocolError({ message: 'internal error', cause: error });
    const conn = 'conn' in p ? p.conn : undefined;
    const session = conn?.session ?? this.ending; // a fault inside end(): the session that was ending
    this.ending = undefined;
    // A client that waits for a retry an end has announced keeps it: nothing was in progress, so nothing failed — no
    // second failure is counted and the announced delay holds (INV-R1, INV-R2), and it cannot give up unannounced
    const scheduled = p.state === 'WAITING' && (this.coreTimers.isArmed('retry') || this.lastResortArmed);
    // drop the current connection and the lingering ones
    this.phase = { state: p.state === 'CLOSED' ? 'CLOSED' : 'WAITING' };
    this.laterQueue = [];
    this.failure = undefined;
    attempt(() => {
      this.openSubject.clear();
    });
    for (const c of conn === undefined ? [] : [conn]) {
      c.ended = true;
      attempt(() => {
        c.release(CloseCode.INTERNAL_ERROR);
      });
      attempt(() => {
        c.transport.terminate();
      });
    }
    for (const record of [...this.lingering.values()]) {
      attempt(() => {
        record.connection.transport.close(CloseCode.INTERNAL_ERROR, closeReason(CloseCode.INTERNAL_ERROR));
      });
      attempt(() => {
        record.connection.transport.terminate();
      });
      attempt(() => {
        record.finish(false);
      });
    }
    this.lingering.clear();
    if (!scheduled) {
      attempt(() => {
        this.coreTimers.clearAll();
      });
      attempt(() => {
        this.clearLastResort();
      });
    }
    // fresh participants
    attempt(() => {
      this.parts = this.freshParticipants();
    });
    // notify and schedule (or give up) before anything fails: the app hears the end first. A stopped client stays stopped and a
    // never-opened one stays closed: nothing is resurrected or opened.
    if (p.state !== 'CLOSED' && !scheduled) {
      attempt(() => {
        const failure = internal();
        const n = this.backoff.fail();
        setContext(failure, { attempt: n, sessionId: session?.id });
        const closeCode = conn?.hasSocket === true ? CloseCode.INTERNAL_ERROR : undefined;
        const info = (willRetry: boolean, delay: number | undefined): CloseInfo =>
          resetInfo(failure, session?.id, closeCode, n, willRetry, delay);
        const delay = n <= this.o.retry.maxRetries ? this.backoff.delay(n, (d) => info(true, d)) : null;
        // an interrupted attempt or session ends here; a WAITING client was told about its end already, unless it
        // gives up now
        if (conn !== undefined || delay === null) {
          this.notifyEnd(info(delay !== null, delay ?? undefined), session !== undefined);
        }
        if (delay === null) {
          this.stop(failure);
        } else {
          this.logRetry(delay, n);
          this.armRetry(delay);
        }
      });
    }
    const stopCause = this.stopCause;
    attempt(() => {
      this.deliverCancel(conn, stopCause ?? new ConnectionLostError({ cause: internal() }));
    });
    // then fail the one-shots (or every op, when stopped) and restart the interests
    const ops = this.registry.live();
    this.registry.clearQueue();
    for (const op of ops) {
      attempt(() => {
        // the crashed session may hold this registration on the router: its re-REGISTER rides out a ghost
        if (op.kind === 'register' && session !== undefined) this.rememberGhost(op.snap.key);
        if (stopCause !== undefined || op.kind === 'call' || op.kind === 'publish') {
          this.registry.remove(op);
          if (stopCause === undefined) this.failLost(op, internal(), session?.id);
          else this.failStopped(op, stopCause);
        } else {
          this.startInterest(op, undefined);
        }
      });
    }
  }

  /** Add a registration key to the client-level ghost memory (most recent last, at most GHOST_MEMORY keys). */
  private rememberGhost(key: string): void {
    const keys = this.ghostKeys;
    keys.delete(key);
    keys.add(key);
    for (const oldest of keys) {
      if (keys.size <= GHOST_MEMORY) break;
      keys.delete(oldest);
    }
  }

  private failLost(op: AnyOp, cause: ProtocolError, sessionId: number | undefined): void {
    const error = make(ConnectionLostError, { cause, sessionId, ...uriOf(op) });
    this.loop.deliver(() => {
      op.subscriber.error(error);
    });
  }

  // ------------------------------------------------------------------------------------------------ session ctx

  private conn(): Connection | undefined {
    const p = this.phase;
    return 'conn' in p ? p.conn : undefined;
  }

  /** `conn` carries the established session (its gate may still have closed in this step: a refused write; then
   *  `Connection.write` writes nothing). */
  private isLive(conn: Connection): boolean {
    const p = this.phase;
    return p.state === 'ESTABLISHED' && p.conn === conn;
  }

  /** The session's ctx: the core's effects (deliver, log, a live `now`, inherited from `fx`) plus the session's own
   *  writes, timers and verdicts, each a no-op once the session has ended. */
  private makeCtx(conn: Connection, session: Session, ids: IdAllocator): SessionCtx {
    const own: Omit<SessionCtx, keyof Effects> = {
      connId: conn.id,
      session,
      send: (frame: OutboundFrame): boolean => {
        if (!this.isLive(conn)) return false;
        const written = conn.write(frame);
        if (written) {
          try {
            this.parts.liveness.sent(ctx); // a write that expects no reply holds the idle deadline
          } catch (error) {
            this.internalError(error); // the frame is on the wire; hardReset after this step
          }
        }
        return written;
      },
      request: (build: (requestId: number) => OutboundFrame, expectsReply = true): number | undefined => {
        if (!this.isLive(conn)) return undefined;
        let id: number;
        try {
          id = ids.next((candidate) => this.inFlight(candidate));
        } catch (error) {
          this.internalError(error); // a client bug: nothing was written; hardReset after this step
          return undefined;
        }
        let written: boolean;
        try {
          written = conn.write(build(id));
        } catch (error) {
          ids.release(id);
          throw error;
        }
        if (!written) {
          ids.release(id);
          return undefined;
        }
        try {
          this.parts.liveness.wrote(expectsReply, ctx); // synchronously, inside the write
        } catch (error) {
          this.internalError(error); // the frame is on the wire; hardReset after this step
        }
        return id;
      },
      timer: (ms: number, owner: ParticipantName, key: number, deadline?: boolean): TimerHandle =>
        this.ctxTimer(conn, ms, owner, key, deadline === true),
      verifyAlive: (since: number, onTimeout: () => void): void => {
        this.parts.liveness.verifyAlive(since, onTimeout, ctx);
      },
      violation: (message: string, frame: unknown): void => {
        this.laterQueue.push({ kind: 'violation', conn: conn.id, message, frame });
      },
    };
    const ctx = Object.freeze(Object.assign(Object.create(this.fx) as Effects, own));
    return ctx;
  }

  /** Is `id` in flight in the current session, in any participant or as the liveness probe? Each
   *  `pendingIds()` is read at every allocation. */
  private inFlight(id: number): boolean {
    const p = this.parts;
    for (const ids of [
      p.call.pendingIds(),
      p.publish.pendingIds(),
      p.topic.pendingIds(),
      p.register.pendingIds(),
      p.liveness.pendingIds(),
    ]) {
      for (const pending of ids) if (pending === id) return true;
    }
    return false;
  }

  private ctxTimer(conn: Connection, ms: number, owner: ParticipantName, key: number, deadline: boolean): TimerHandle {
    if (!this.isLive(conn)) return { cancel: () => undefined }; // the session ended: nothing is armed
    const timerKey = `op:${owner}:${String(key)}`;
    const gen = conn.timers.arm(
      timerKey,
      ms,
      (g) => {
        this.submit({ kind: 'timer.op', conn: conn.id, gen: g, owner, key });
      },
      deadline,
    );
    return {
      cancel: () => {
        conn.timers.cancel(timerKey, gen); // a stale handle never cancels a newer timer of that key
      },
    };
  }

  /** Arm a connection timer whose input is `timer.<key>`. */
  private arm(
    conn: Connection,
    key: 'connect' | 'handshake' | 'challenge' | 'stable' | 'idle' | 'ping',
    ms: number,
    deadline: boolean,
  ): void {
    conn.timers.arm(
      key,
      ms,
      (gen) => {
        this.submit({ kind: `timer.${key}`, conn: conn.id, gen });
      },
      deadline,
    );
  }

  private makeLivenessHost(): LivenessHost {
    /** The connection of `ctx` while its session is live; liveness ignores the calls for any other one. */
    const live = (ctx: SessionCtx): Connection | undefined => {
      const conn = this.conn();
      return conn?.id === ctx.connId && this.isLive(conn) ? conn : undefined;
    };
    return {
      idle: this.o.timeouts.idle,
      pingBudget: this.o.internal.ping,
      armIdle: (ctx, ms) => {
        const conn = live(ctx);
        if (conn !== undefined) this.arm(conn, 'idle', ms, false);
      },
      armPing: (ctx, ms) => {
        const conn = live(ctx);
        if (conn !== undefined) this.arm(conn, 'ping', ms, true);
      },
      cancelPing: (ctx) => {
        live(ctx)?.timers.cancel('ping');
      },
      bufferedAmount: (ctx) => live(ctx)?.transport.bufferedAmount() ?? 0,
      later: (ctx, fn) => {
        this.laterQueue.push({ kind: 'later', conn: ctx.connId, fn });
      },
    };
  }

  /** Deferred work of this step (verdicts, `ctx.violation`), each dropped once its session has ended. */
  private runLater(): void {
    while (this.laterQueue.length > 0) {
      const batch = this.laterQueue;
      this.laterQueue = [];
      for (const item of batch) {
        const p = this.phase;
        if (p.state !== 'ESTABLISHED' || p.conn.id !== item.conn) continue;
        if (item.kind === 'later') item.fn();
        else this.violation(p.conn, item.message, frameText(item.frame));
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ plumbing

  private freshParticipants(): Participants {
    const deps: ParticipantDeps = {
      requestTimeout: this.o.timeouts.request,
      submit: (input) => {
        this.submit(input);
      },
    };
    const parts: Participants = {
      call: new CallParticipant(deps),
      publish: new PublishParticipant(deps),
      topic: new TopicParticipant(deps),
      register: new RegisterParticipant(deps, this.ghostKeys),
      liveness: new Liveness(this.livenessHost),
    };
    if (this.faults.enabled) this.patchParticipants(parts);
    return parts;
  }

  private patchParticipants(parts: Participants): void {
    for (const [name, part] of Object.entries(parts)) this.faults.patch(name, part as object);
    this.faults.patch('challenge', this.runner);
  }

  private emitStatus(status: Status): void {
    this.statusSubject.emit(Object.freeze(status), this.deliverFn);
  }

  /** Lazy: built only for a custom logger (or an `eager` entry). */
  private log(build: () => LogEntry): void {
    safeLogLazy(this.logTarget, build);
  }

  /** A pure hook failed and its default was used: reaches the default logger too. */
  private fallback(message: string, error: unknown): void {
    this.log(eager({ level: 'warn', event: 'option.fallback', message, data: { error } }));
  }

  /** The request-id stream's seed: one draw of the app's `clock.random`, the system's when it throws. */
  private seedOf(random: () => number): () => number {
    return () => {
      try {
        return random();
      } catch (error) {
        this.fallback('clock.random threw while seeding the request-id stream; the system random was used', error);
        return systemClock.random();
      }
    };
  }
}

/** The procedure or topic of an op (error context). */
function uriOf(op: AnyOp): { readonly procedure: string } | { readonly topic: string } {
  return op.kind === 'call' || op.kind === 'register' ? { procedure: op.snap.procedure } : { topic: op.snap.topic };
}

/** The error of one record failed by a stop (close() or give-up): the stop's ConnectionClosedError in the record's
 *  context; one that has a request id was in flight in session `sessionId` and names it too. */
function stopErrorOf(
  stopCause: ConnectionClosedError,
  context: RecordContext,
  sessionId?: number,
): ConnectionClosedError {
  return make(ConnectionClosedError, {
    message: stopCause.message,
    gaveUp: stopCause.gaveUp,
    cause: stopCause.cause,
    sessionId: context.requestId === undefined ? undefined : sessionId,
    ...context,
  });
}

/** Set context fields on an error the client built for an end. */
function setContext(error: ThruwayError, context: { attempt: number; sessionId?: number | undefined }): void {
  withContext(error, context as { attempt: number; sessionId?: number });
}

function closeInfo(
  cause: EndCause,
  sessionId: number | undefined,
  attempt: number,
  willRetry: boolean,
  delay: number | undefined,
): CloseInfo {
  return Object.freeze({
    initiator: cause.initiator,
    reason: cause.reason,
    details: cause.details ?? EMPTY,
    closeCode: cause.closeCode,
    wasClean: cause.wasClean,
    sessionId,
    error: cause.error,
    willRetry,
    delay: willRetry ? delay : undefined,
    attempt,
  });
}

/** The CloseInfo of a contained internal error (the end `hardReset` announces). */
function resetInfo(
  error: ProtocolError,
  sessionId: number | undefined,
  closeCode: number | undefined,
  n: number,
  willRetry: boolean,
  delay: number | undefined,
): CloseInfo {
  return closeInfo({ initiator: 'connection', closeCode, wasClean: false, error }, sessionId, n, willRetry, delay);
}

/** Byte length of a received WebSocket message (frame entries). */
function rawBytes(data: unknown): number {
  if (typeof data === 'string') return frameBytes(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}
