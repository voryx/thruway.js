/**
 * RegisterParticipant: REGISTER/UNREGISTER/INVOCATION/INTERRUPT/YIELD, adoption of a pending REGISTER (StrictMode),
 * ghost re-REGISTER window, handler results matched by Invocation identity.
 *
 * A registration record is `dormant` (no session, or its REGISTER was not sent), `waiting` (its re-REGISTER met this
 * client's own ghost session; REGISTER again when the ghost timer fires), `registering` (REGISTER outstanding),
 * `reregister` (the router answered with an id that an UNREGISTER written after its REGISTER is removing: REGISTER
 * again once that is answered; keep the id if the router refused it) or
 * `active`. A record whose subscriber is gone while its REGISTER is outstanding (the app unsubscribed: stopped; the
 * request timed out: late) is adopted by the next subscription of the same key, so a remount never registers twice
 * and never meets its own `procedure_already_exists`. Everything bound to one session (request ids, registration ids,
 * running invocations, ghost timers) lives in a `Session` object dropped at the session's end.
 *
 * Invocations: the handler runs in a delivery (app context); its result — a plain value, a `Yield`, a Promise, any
 * Observable — is converted with `subscribeInput` and comes back as `handler.*` inputs carrying the Invocation object
 * itself, so a result can only ever answer the INVOCATION it was started for. Every invocation gets at most one
 * final answer (YIELD or ERROR); a result that cannot be sent becomes an ERROR, and the registration stays.
 *
 * @module
 */
import {
  CanceledError,
  ConnectionLostError,
  isWampError,
  ProtocolError,
  TimeoutError,
  WampError,
  withContext,
} from '../errors.js';
import { eager, unhandledEntry } from '../logger.js';
import { createAbort, type AbortHandle } from '../observable/abort.js';
import { subscribeInput } from '../observable/input.js';
import { logReporter, type UnhandledReporter } from '../observable/observable.js';
import { MessageType, Uri } from '../protocol/codes.js';
import { isId } from '../protocol/decode.js';
import {
  invocationErrorFrame,
  registerFrame,
  unregisterFrame,
  yieldFrame,
  type Dict,
  type InboundError,
  type InboundInterrupt,
  type InboundInvocation,
  type InboundMessage,
  type InboundRegistered,
  type InboundRegistrationRevoked,
  type InvocationErrorFrame,
  type OutboundFrame,
  type OutboundPayload,
} from '../protocol/messages.js';
import { isPlainObject, outboundPayload } from '../protocol/payload.js';
import { isValidUri } from '../protocol/uri.js';
import type {
  Effects,
  EndInfo,
  HandlerEvent,
  OptionsSnapshot,
  ParticipantDeps,
  RegisterOp,
  RegisterParticipant as RegisterParticipantContract,
  RegisterSnapshot,
  SessionCtx,
  StopError,
  TimerHandle,
} from '../core/contracts.js';
import type { InvocationMessage, RegisteredMessage, Subscription } from '../types.js';
import { isYield } from '../yield.js';
import { LATE_LIMIT, writeFailure } from './topic.js';

/** Ghost re-REGISTER schedule: 1 s doubling to 30 s, for up to 300 s since the first such error. */
export const GHOST_RETRY = { initial: 1000, cap: 30000, window: 300000 } as const;

/** How many registration keys are remembered as possibly still held by an earlier session of this client. */
export const GHOST_MEMORY = 1024;

/** What `sizes()` reports (the client's debug probe, INV-R10). */
export type RegisterSizes = Readonly<
  Record<'records' | 'ops' | 'requests' | 'late' | 'invocations' | 'ghostTimers' | 'ghostKeys', number>
>;

interface RegisterRequest {
  readonly kind: 'register';
  readonly id: number;
  readonly record: Registration;
  readonly writtenAt: number;
  /** Write order in the session: the router processes REGISTERs and UNREGISTERs in this order. */
  readonly order: number;
  timer: TimerHandle;
}

interface UnregisterRequest {
  readonly kind: 'unregister';
  readonly id: number;
  readonly registrationId: number;
  readonly key: string;
  readonly writtenAt: number;
  readonly order: number;
  readonly timer: TimerHandle;
}

type Request = RegisterRequest | UnregisterRequest;

type RecordState =
  | { readonly kind: 'dormant' }
  | { readonly kind: 'waiting'; readonly timerKey: number; readonly timer: TimerHandle }
  | { readonly kind: 'registering'; readonly request: RegisterRequest }
  | { readonly kind: 'reregister'; readonly after: number }
  | { readonly kind: 'active'; readonly registrationId: number };

interface Registration {
  /** The subscription it serves; undefined while its REGISTER is outstanding and the subscriber is gone (adoptable). */
  op: RegisterOp | undefined;
  readonly key: string;
  readonly procedure: string;
  readonly options: OptionsSnapshot;
  state: RecordState;
  /** When this record's re-REGISTER first met `procedure_already_exists` (start of its ghost window). */
  ghostSince: number | undefined;
  ghostAttempts: number;
}

interface Invocation {
  readonly id: number;
  readonly conn: number;
  readonly procedure: string;
  readonly record: Registration;
  readonly progressive: boolean;
  readonly abort: AbortHandle;
  /** The handler result's subscription, once the handler ran. */
  subscription: Subscription | undefined;
  /** The latest value of a non-progressive Observable result (sent when it completes). */
  last: unknown;
  /** Answered, interrupted or aborted: later handler results are dropped. */
  done: boolean;
}

const DORMANT: RecordState = { kind: 'dormant' };

/** Per-session maps; dropped as a whole when the session ends. */
class Session {
  readonly requests = new Map<number, Request>();
  /** Router registration id → the records it serves (more than one only if a router hands out one id twice). */
  readonly byRegistration = new Map<number, Registration[]>();
  readonly invocations = new Map<number, Invocation>();
  /** Ghost timer key (negative: never a request id) → the waiting record. */
  readonly ghostTimers = new Map<number, Registration>();
  /** Late REGISTERs → when they are forgotten; oldest first. */
  readonly late = new Map<RegisterRequest, number>();
  /** Keys of REGISTERs/UNREGISTERs given up on (forgotten unanswered): the router may still hold them for this
   *  session, so they join the ghost memory at its end like the outstanding ones. Oldest first, at most GHOST_MEMORY. */
  readonly forgotten = new Set<string>();
  /** Registration ids this session wrote an UNREGISTER for, oldest first, at most GHOST_MEMORY: a REGISTERED or an
   *  INVOCATION of one of them that no record maps is a frame racing that UNREGISTER, never a reason for another. */
  readonly retired = new Set<number>();
  /** Registration ids the router removed for an UNREGISTER of this session (answered, or timed out), with that
   *  UNREGISTER's write order; oldest first, at most GHOST_MEMORY. */
  readonly removed = new Map<number, number>();
  /** REGISTERs and UNREGISTERs written in this session (their `order`). */
  writes = 0;
  nextGhostKey = -1;
  constructor(readonly connId: number) {}
}

export class RegisterParticipant implements RegisterParticipantContract {
  readonly name = 'register' as const;
  private readonly requestTimeout: number;
  private readonly deps: ParticipantDeps;
  private readonly records = new Set<Registration>();
  private readonly opRecord = new Map<RegisterOp, Registration>();
  /** Keys REGISTERed in a session that ended before they were unregistered: the router may still hold them for that
   *  ghost session, so their `procedure_already_exists` is retried. Oldest first, at most GHOST_MEMORY. */
  private readonly ghostKeys: Set<string>;
  private s: Session | undefined;

  /** @param ghostKeys the client-level ghost-key memory: the core hands the same set to every RegisterParticipant it
   *                   builds, so it survives `hardReset` (and `close()`). */
  constructor(deps: ParticipantDeps, ghostKeys: Set<string> = new Set<string>()) {
    this.requestTimeout = deps.requestTimeout;
    this.deps = deps;
    this.ghostKeys = ghostKeys;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the contract's signature (start delivers through ctx)
  start(op: RegisterOp, ctx: SessionCtx | undefined, _fx: Effects): void {
    if (this.opRecord.has(op)) return;
    if (ctx === undefined) {
      this.add(op); // no session: dormant until the next WELCOME
      return;
    }
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    const request = adoptable(op.snap.key, s);
    if (request === undefined) {
      this.register(this.add(op), s, ctx);
      return;
    }
    // adoption: the outstanding REGISTER now serves this subscription; nothing is written
    request.record.op = op;
    this.opRecord.set(op, request.record);
    if (s.late.delete(request)) request.timer = ctx.timer(this.requestTimeout, 'register', request.id, true);
  }

  stop(op: RegisterOp, ctx: SessionCtx | undefined, fx: Effects): void {
    const record = this.opRecord.get(op);
    if (record === undefined) return; // settled already
    this.opRecord.delete(op);
    record.op = undefined;
    const state = record.state;
    if (state.kind === 'registering') return; // stopped: UNREGISTER on arrival unless a new subscription adopts it
    this.records.delete(record);
    if (state.kind === 'waiting') {
      state.timer.cancel();
      this.s?.ghostTimers.delete(state.timerKey);
    } else if (state.kind === 'active' && ctx !== undefined) {
      const s = this.session(ctx);
      for (const invocation of [...s.invocations.values()]) {
        if (invocation.record !== record) continue;
        // the callers settle: the running invocations of this registration are answered `canceled`
        this.abortInvocation(invocation, canceled(invocation), s, fx);
        this.sendQuietly(invocationErrorFrame(invocation.id, {}, Uri.CANCELED), ctx);
      }
      if (this.unmap(record, state.registrationId, s)) {
        this.writeUnregister(state.registrationId, record.key, s, ctx);
      }
    }
  }

  welcome(ctx: SessionCtx): void {
    this.begin(ctx);
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    if (msg.type === MessageType.REGISTERED) return this.registered(msg, s, ctx);
    if (msg.type === MessageType.UNREGISTERED) {
      return msg.revocation ? this.revoked(msg, s, ctx) : this.unregistered(msg.requestId, undefined, s, ctx);
    }
    if (msg.type === MessageType.INVOCATION) return this.invocation(msg, s, ctx);
    if (msg.type === MessageType.INTERRUPT) return this.interrupt(msg, s, ctx);
    if (msg.type !== MessageType.ERROR) return false; // routed elsewhere
    if (msg.requestType === MessageType.REGISTER) return this.registerError(msg, s, ctx);
    if (msg.requestType === MessageType.UNREGISTER) return this.unregistered(msg.requestId, msg, s, ctx);
    return false;
  }

  timer(key: number, ctx: SessionCtx): void {
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    const waiting = s.ghostTimers.get(key);
    if (waiting !== undefined) {
      s.ghostTimers.delete(key);
      this.register(waiting, s, ctx); // the ghost re-REGISTER
      return;
    }
    const request = s.requests.get(key);
    if (request === undefined) return; // answered meanwhile
    ctx.verifyAlive(request.writtenAt, () => {
      if (this.s !== s || s.requests.get(request.id) !== request) return; // answered, or the session ended
      if (request.kind === 'register') {
        this.registerTimedOut(request, s, ctx);
        return;
      }
      this.unregisterDone(request, false, s, ctx);
      remember(s.forgotten, request.key);
      ctx.log(() => ({
        level: 'warn',
        event: 'request.timeout',
        message: `UNREGISTER ${String(request.id)} was not answered; forgotten`,
        data: { requestId: request.id, registrationId: request.registrationId },
      }));
    });
  }

  handlerEvent(ev: HandlerEvent, ctx: SessionCtx): void {
    const s = this.session(ctx);
    const invocation = ev.invocation as Invocation;
    if (s.invocations.get(invocation.id) !== invocation) return; // finished, interrupted, or another session's
    switch (ev.kind) {
      case 'handler.next':
        if (invocation.progressive) this.yieldResult(invocation, true, ev.value, s, ctx);
        else invocation.last = ev.value;
        return;
      case 'handler.complete':
        // a Promise or plain value is the result itself; an Observable's completion sends its last value (or, for a
        // progressive call, the empty final YIELD after the progress YIELDs)
        this.yieldResult(invocation, false, ev.hasValue ? ev.value : invocation.last, s, ctx);
        return;
      case 'handler.error':
        this.answer(invocation, errorAnswer(invocation, ev.error, ctx), s, ctx);
        return;
    }
  }

  sessionEnded(end: EndInfo, fx: Effects): void {
    this.end((invocation) => end.inflightError({ requestId: invocation.id, procedure: invocation.procedure }), fx);
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    // invocations aborted with their own error; nothing is written after GOODBYE
    this.end((invocation) => stopError({ requestId: invocation.id, procedure: invocation.procedure }), fx);
    const records = [...this.records];
    for (const record of records) this.fail(record, stopError({ procedure: record.procedure }), fx);
  }

  /** A live view that can be iterated any number of times (see TopicParticipant.pendingIds). */
  pendingIds(): Iterable<number> {
    return { [Symbol.iterator]: () => (this.s === undefined ? [].values() : this.s.requests.keys()) };
  }

  /** Map sizes, for the client's debug probe and the no-leak checks (INV-R10). Internal. */
  sizes(): RegisterSizes {
    const s = this.s ?? new Session(0);
    return {
      records: this.records.size,
      ops: this.opRecord.size,
      requests: s.requests.size,
      late: s.late.size,
      invocations: s.invocations.size,
      ghostTimers: s.ghostTimers.size,
      ghostKeys: this.ghostKeys.size,
    };
  }

  // ------------------------------------------------------------------------------------------------- session

  /** The session `ctx` belongs to; a session this participant was not told about is welcomed first. */
  private session(ctx: SessionCtx): Session {
    const s = this.s;
    return s?.connId === ctx.connId ? s : this.begin(ctx);
  }

  /** WELCOME: REGISTER every dormant record that has a subscriber, FIFO by seq. Idempotent per session. */
  private begin(ctx: SessionCtx): Session {
    if (this.s !== undefined && this.s.connId !== ctx.connId) {
      this.end(() => new ConnectionLostError({ message: 'The session ended' }), ctx); // its end was never reported
    }
    const s = this.s ?? new Session(ctx.connId);
    this.s = s;
    const dormant: [Registration, RegisterOp][] = [];
    for (const record of this.records) {
      if (record.state.kind === 'dormant' && record.op !== undefined) dormant.push([record, record.op]);
    }
    dormant.sort((a, b) => a[1].seq - b[1].seq);
    for (const [record] of dormant) this.register(record, s, ctx);
    return s;
  }

  /**
   * Session end (or close): running invocations are aborted with `reasonFor(invocation)` (no frames, results
   * discarded); what this session registered is remembered as a possible ghost; records with a subscriber turn
   * dormant (nothing is emitted), the others (stopped, late) are deleted and never REGISTERed again.
   */
  private end(reasonFor: (invocation: Invocation) => unknown, fx: Effects): void {
    const s = this.s;
    this.s = undefined;
    if (s !== undefined) {
      for (const invocation of s.invocations.values()) this.abortInvocation(invocation, reasonFor(invocation), s, fx);
      for (const key of s.forgotten) this.rememberGhost(key);
      for (const request of s.requests.values()) {
        this.rememberGhost(request.kind === 'register' ? request.record.key : request.key);
      }
      for (const records of s.byRegistration.values()) for (const record of records) this.rememberGhost(record.key);
      for (const record of this.records) if (record.state.kind === 'reregister') this.rememberGhost(record.key);
    }
    for (const record of [...this.records]) {
      if (record.op === undefined) this.records.delete(record);
      else record.state = DORMANT;
    }
  }

  private rememberGhost(key: string): void {
    if (key !== '') remember(this.ghostKeys, key); // '': a withdrawn registration no record wants back
  }

  // ------------------------------------------------------------------------------------------------- writes

  private register(record: Registration, s: Session, ctx: SessionCtx): void {
    let id: number | undefined;
    try {
      id = ctx.request((requestId) => registerFrame(requestId, record.options, record.procedure));
    } catch (error) {
      // serializer or size error: this registration can never be sent; it fails, the connection is untouched
      this.fail(record, writeFailure(error, { procedure: record.procedure }), ctx);
      return;
    }
    if (id === undefined) {
      record.state = DORMANT; // not sent: the connection is ending; REGISTER again at the next WELCOME
      return;
    }
    const timer = ctx.timer(this.requestTimeout, 'register', id, true);
    const request: RegisterRequest = { kind: 'register', id, record, writtenAt: ctx.now, order: ++s.writes, timer };
    s.requests.set(id, request);
    record.state = { kind: 'registering', request };
  }

  /** UNREGISTER `registrationId`, an id received in this session (never a stale one), at most once while one
   *  is in flight (a router that hands out one id twice; a second UNREGISTER would be for an unknown id, and it
   *  crashes wamp-server). */
  private writeUnregister(registrationId: number, key: string, s: Session, ctx: SessionCtx): void {
    if (unregistering(registrationId, s)) return;
    let id: number | undefined;
    try {
      id = ctx.request((requestId) => unregisterFrame(requestId, registrationId));
    } catch (error) {
      ctx.log(() => ({
        level: 'warn',
        event: 'request.error',
        message: `UNREGISTER of registration ${String(registrationId)} could not be written`,
        data: { registrationId, error },
      }));
      return;
    }
    if (id === undefined) return; // the session is ending
    remember(s.retired, registrationId);
    const timer = ctx.timer(this.requestTimeout, 'register', id, true);
    s.requests.set(id, { kind: 'unregister', id, registrationId, key, writtenAt: ctx.now, order: ++s.writes, timer });
  }

  /**
   * A registration of this session that no record holds: the answer to a REGISTER given up on, or one whose
   * REGISTERED was lost and that the router now invokes. The router used the id in this session, so UNREGISTER it
   * once; otherwise it blocks the procedure for everyone and the app's retry meets `procedure_already_exists`.
   * False when a record holds the id or it was already withdrawn (a duplicate, or a frame racing that UNREGISTER), and
   * for id 0, which no router issues for a registration (it is accepted for revocations): an UNREGISTER needs an id ≥ 1.
   */
  private withdraw(registrationId: number, s: Session, ctx: SessionCtx): boolean {
    if (registrationId === 0 || s.byRegistration.has(registrationId) || s.retired.has(registrationId)) return false;
    ctx.log(() => ({
      level: 'debug',
      event: 'frame.dropped',
      message: `registration ${String(registrationId)} belongs to no subscription; UNREGISTER it`,
      data: { registrationId },
    }));
    this.writeUnregister(registrationId, '', s, ctx);
    return true;
  }

  /** A frame that answers an INVOCATION and cannot fail for app data (fixed URIs, no payload of the app's). */
  private sendQuietly(frame: OutboundFrame, ctx: SessionCtx): void {
    try {
      ctx.send(frame);
    } catch (error) {
      ctx.log(() => ({
        level: 'warn',
        event: 'request.error',
        message: 'an answer to an INVOCATION could not be written',
        data: { error },
      }));
    }
  }

  // ------------------------------------------------------------------------------------------------- inbound

  private registered(msg: InboundRegistered, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(msg.requestId);
    if (request === undefined) return this.withdraw(msg.registrationId, s, ctx); // a REGISTER given up on, or a duplicate
    if (request.kind !== 'register') return false;
    this.settle(request, s);
    const record = request.record;
    const registrationId = msg.registrationId;
    const op = record.op;
    if (op === undefined) {
      // stopped or late, and nobody adopted it
      this.records.delete(record);
      if (!s.byRegistration.has(registrationId)) this.writeUnregister(registrationId, record.key, s, ctx);
      return true;
    }
    // An UNREGISTER of this id written after this REGISTER removes what the router granted here (one written before
    // it acted first: the router processes them in order, whatever the order of its answers)
    const unregister = unregisterOf(registrationId, s);
    if (unregister !== undefined && unregister.order > request.order) {
      record.state = { kind: 'reregister', after: registrationId }; // the router is about to drop that registration
      return true;
    }
    const removedBy = s.removed.get(registrationId);
    if (removedBy !== undefined && removedBy > request.order) {
      // that UNREGISTER was answered before this REGISTERED (Thruway PHP invokes a replacing registration before it
      // confirms it): the router already dropped this registration
      this.register(record, s, ctx);
      return true;
    }
    this.activate(record, op, registrationId, s, ctx);
    return true;
  }

  /** The record holds `registrationId`: map it and announce it to the subscriber. */
  private activate(record: Registration, op: RegisterOp, registrationId: number, s: Session, ctx: SessionCtx): void {
    record.state = { kind: 'active', registrationId };
    s.retired.delete(registrationId);
    s.removed.delete(registrationId);
    record.ghostSince = undefined;
    record.ghostAttempts = 0;
    this.ghostKeys.delete(record.key);
    const records = s.byRegistration.get(registrationId);
    if (records === undefined) s.byRegistration.set(registrationId, [record]);
    else records.push(record);
    const registered: RegisteredMessage = Object.freeze({
      registrationId,
      procedure: record.procedure,
      sessionId: ctx.session.id,
    });
    ctx.deliver(() => {
      op.subscriber.next(registered);
    });
  }

  private registerError(msg: InboundError, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(msg.requestId);
    if (request?.kind !== 'register') return false;
    this.settle(request, s);
    const record = request.record;
    const invalid = msg.invalid;
    if (invalid === undefined && msg.error === Uri.PROCEDURE_ALREADY_EXISTS && this.ghostRetry(record, s, ctx)) {
      return true;
    }
    const context = { procedure: record.procedure, requestId: msg.requestId, sessionId: ctx.session.id };
    const error =
      invalid === undefined
        ? withContext(new WampError(msg.error, msg.args, msg.kwargs, msg.details), context)
        : new ProtocolError({
            message: `invalid ERROR for REGISTER: ${invalid.reason}`,
            frame: invalid.frame,
            ...context,
          });
    this.fail(record, error, ctx);
    return true;
  }

  /**
   * `procedure_already_exists` for a re-establishment (a key this client registered in an earlier session, or a record
   * already riding out its ghost): the router still holds the registration for this client's own ghost session (a drop
   * it has not noticed yet), so REGISTER again after 1, 2, 4, 8, 16, 30, 30, … s, for up to 300 s. False for a
   * first REGISTER (a genuine conflict) and once the window is over.
   */
  private ghostRetry(record: Registration, s: Session, ctx: SessionCtx): boolean {
    if (record.op === undefined) return false; // nobody wants it any more
    if (record.ghostSince === undefined && !this.ghostKeys.has(record.key)) return false;
    const since = record.ghostSince ?? ctx.now;
    if (ctx.now - since >= GHOST_RETRY.window) {
      this.ghostKeys.delete(record.key); // treat it as a genuine conflict from now on
      return false;
    }
    record.ghostSince = since;
    record.ghostAttempts++;
    const delay = Math.min(GHOST_RETRY.initial * 2 ** (record.ghostAttempts - 1), GHOST_RETRY.cap);
    const timerKey = s.nextGhostKey--;
    record.state = { kind: 'waiting', timerKey, timer: ctx.timer(delay, 'register', timerKey) };
    s.ghostTimers.set(timerKey, record);
    ctx.log(() => ({
      level: 'debug',
      event: 'register.ghost',
      message: `${record.procedure} is held by an earlier session of this client; REGISTER again in ${String(delay)} ms`,
      data: { procedure: record.procedure, attempt: record.ghostAttempts, delay, since },
    }));
    return true;
  }

  /** UNREGISTERED, or ERROR(66) (`refusal`; a payload-invalid one too): the request is over either way. */
  private unregistered(requestId: number, refusal: InboundError | undefined, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(requestId);
    if (request?.kind !== 'unregister') return false;
    this.unregisterDone(request, refusal !== undefined, s, ctx);
    if (refusal !== undefined) {
      ctx.log(() => ({
        level: 'debug',
        event: 'request.error',
        message: `UNREGISTER ${String(requestId)} answered with ${refusal.error}`,
        data: { requestId, registrationId: request.registrationId, error: refusal.error },
      }));
    }
    return true;
  }

  /** The UNREGISTER of a registration id is over: records whose REGISTERED met that id REGISTER again, or keep the id
   *  when the router `refused` that UNREGISTER (it still holds the registration; a REGISTER would meet it). */
  private unregisterDone(request: UnregisterRequest, refused: boolean, s: Session, ctx: SessionCtx): void {
    s.requests.delete(request.id);
    request.timer.cancel();
    if (!refused) rememberAt(s.removed, request.registrationId, request.order);
    for (const record of [...this.records]) {
      if (record.state.kind !== 'reregister' || record.state.after !== request.registrationId) continue;
      if (refused && record.op !== undefined) this.activate(record, record.op, request.registrationId, s, ctx);
      else this.register(record, s, ctx);
    }
  }

  private revoked(msg: InboundRegistrationRevoked, s: Session, ctx: SessionCtx): boolean {
    const records = s.byRegistration.get(msg.registrationId);
    if (records === undefined) return false;
    s.byRegistration.delete(msg.registrationId);
    const args = msg.reason === undefined ? [] : [msg.reason];
    for (const record of records) {
      const error = new WampError(Uri.REGISTRATION_REVOKED, args, {}, msg.details);
      this.fail(record, withContext(error, { procedure: record.procedure, sessionId: ctx.session.id }), ctx);
    }
    return true; // running invocations continue and may still answer
  }

  private invocation(msg: InboundInvocation, s: Session, ctx: SessionCtx): boolean {
    const id = msg.requestId;
    if (s.invocations.has(id)) return false; // a duplicate of a running invocation
    const record = s.byRegistration.get(msg.registrationId)?.[0];
    const op = record?.op;
    if (record === undefined || op === undefined) {
      this.sendQuietly(invocationErrorFrame(id, {}, Uri.NO_SUCH_REGISTRATION), ctx);
      if (record === undefined) this.withdraw(msg.registrationId, s, ctx); // its REGISTERED never arrived
      return true;
    }
    if (msg.invalid !== undefined) {
      this.sendQuietly(invocationErrorFrame(id, {}, Uri.INVALID_ARGUMENT), ctx);
      return true;
    }
    const details = msg.details;
    const procedure = typeof details['procedure'] === 'string' ? details['procedure'] : record.procedure;
    const reporter = logReporter((entry) => {
      ctx.log(eager(entry));
    });
    const abort = createAbort(reporter);
    const invocation: Invocation = {
      id,
      conn: ctx.connId,
      procedure,
      record,
      progressive: details['receive_progress'] === true,
      abort,
      subscription: undefined,
      last: undefined,
      done: false,
    };
    s.invocations.set(id, invocation);
    const message: InvocationMessage = Object.freeze({
      args: msg.args as unknown[],
      kwargs: msg.kwargs,
      details,
      procedure,
      signal: abort.signal,
    });
    const handler = op.snap.handler;
    ctx.deliver(() => {
      this.run(invocation, handler, message, reporter);
    });
    return true;
  }

  private interrupt(msg: InboundInterrupt, s: Session, ctx: SessionCtx): boolean {
    const invocation = s.invocations.get(msg.requestId);
    if (invocation === undefined) return false; // unknown or already answered
    this.abortInvocation(invocation, canceled(invocation), s, ctx);
    // `kill`, or no mode at all (Thruway PHP sends `{}`): answer `canceled`; `killnowait`: the router answered
    if (msg.options['mode'] !== 'killnowait') {
      this.sendQuietly(invocationErrorFrame(invocation.id, {}, Uri.CANCELED), ctx);
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------- invocations

  /** A delivery (app context): call the handler and subscribe to its result. Never throws. */
  private run(
    invocation: Invocation,
    handler: RegisterSnapshot['handler'],
    message: InvocationMessage,
    reporter: UnhandledReporter,
  ): void {
    if (invocation.done) return; // interrupted, unregistered or ended before the handler ran
    const conn = invocation.conn;
    const submit = (input: HandlerEvent): void => {
      this.deps.submit(input);
    };
    let result: unknown;
    try {
      result = handler(message);
    } catch (error) {
      submit({ kind: 'handler.error', conn, invocation, error });
      return;
    }
    const subscription = subscribeInput(
      result,
      {
        next: (value) => {
          submit({ kind: 'handler.next', conn, invocation, value });
        },
        value: (value) => {
          submit({ kind: 'handler.complete', conn, invocation, value, hasValue: true });
        },
        complete: () => {
          submit({ kind: 'handler.complete', conn, invocation, hasValue: false });
        },
        error: (error) => {
          submit({ kind: 'handler.error', conn, invocation, error });
        },
      },
      reporter,
    );
    if (isDone(invocation))
      subscription.unsubscribe(); // answered or aborted while subscribing
    else invocation.subscription = subscription;
  }

  /** Write a result: a progress YIELD (`progress`) or the final YIELD. A result that cannot be sent becomes the final
   *  ERROR instead; a final YIELD that was not sent is dropped with the session. */
  private yieldResult(invocation: Invocation, progress: boolean, value: unknown, s: Session, ctx: SessionCtx): void {
    const payload = yieldPayload(value);
    if (payload === undefined) {
      const problem = new TypeError('a Yield result needs an args array and a plain kwargs object');
      ctx.log(eager(unhandledEntry(problem, `the handler of ${invocation.procedure}`)));
      this.answer(invocation, runtimeError(invocation, 'invalid result payload'), s, ctx);
      return;
    }
    try {
      ctx.send(yieldFrame(invocation.id, progress, payload));
    } catch (error) {
      const tooLarge = isWampError(error) && error.uri === Uri.PAYLOAD_SIZE_EXCEEDED;
      const answer = tooLarge
        ? invocationErrorFrame(invocation.id, {}, Uri.PAYLOAD_SIZE_EXCEEDED, outboundPayload(error.args, undefined))
        : runtimeError(invocation, 'result could not be serialized');
      this.answer(invocation, answer, s, ctx);
      return;
    }
    if (!progress) this.finish(invocation, s, ctx);
  }

  /** The final ERROR answer; if it cannot be serialized (the app's args, kwargs or details), it is sent bare. */
  private answer(invocation: Invocation, frame: InvocationErrorFrame, s: Session, ctx: SessionCtx): void {
    try {
      ctx.send(frame);
    } catch {
      const uri = frame[4];
      this.sendQuietly(invocationErrorFrame(invocation.id, {}, uri), ctx);
    }
    this.finish(invocation, s, ctx);
  }

  /** The final answer was written (or dropped with the session): forget the invocation; a still running handler
   *  Observable (its progress YIELD failed) is unsubscribed. */
  private finish(invocation: Invocation, s: Session, fx: Effects): void {
    invocation.done = true;
    s.invocations.delete(invocation.id);
    const subscription = invocation.subscription;
    if (subscription !== undefined && !subscription.closed) {
      fx.deliver(() => {
        subscription.unsubscribe();
      });
    }
  }

  /** INTERRUPT, unsubscribe of the registration, session end, close: the handler Observable is unsubscribed first,
   *  then the signal is aborted with `reason` (a delivery: both run app code). Its later results are dropped. */
  private abortInvocation(invocation: Invocation, reason: unknown, s: Session, fx: Effects): void {
    invocation.done = true;
    s.invocations.delete(invocation.id);
    fx.deliver(() => {
      const subscription = invocation.subscription;
      invocation.subscription = undefined;
      subscription?.unsubscribe(); // our Subscription: never throws (a throwing app teardown is reported)
      invocation.abort.abort(reason); // never throws (listener errors are isolated or the platform's)
    });
  }

  // ------------------------------------------------------------------------------------------------- timers

  /** The router answered a probe but not this REGISTER: the subscriber errors; the record stays late. */
  private registerTimedOut(request: RegisterRequest, s: Session, ctx: SessionCtx): void {
    const record = request.record;
    const op = record.op;
    if (op !== undefined) {
      record.op = undefined;
      this.opRecord.delete(op);
      const init = { timer: 'request', timeout: this.requestTimeout, procedure: record.procedure } as const;
      const error = new TimeoutError({ ...init, requestId: request.id, sessionId: ctx.session.id });
      ctx.deliver(() => {
        op.subscriber.error(error);
      });
    }
    s.late.set(request, ctx.now + this.requestTimeout);
    for (const oldest of s.late.keys()) {
      if (s.late.size <= LATE_LIMIT) break;
      this.expire(oldest, s, ctx);
    }
  }

  // ------------------------------------------------------------------------------------------------- helpers

  private add(op: RegisterOp): Registration {
    const { key, procedure, options } = op.snap;
    const record: Registration = {
      op,
      key,
      procedure,
      options,
      state: DORMANT,
      ghostSince: undefined,
      ghostAttempts: 0,
    };
    this.records.add(record);
    this.opRecord.set(op, record);
    return record;
  }

  /** A REGISTER was answered or forgotten: no longer pending, its timer cancelled. */
  private settle(request: RegisterRequest, s: Session): void {
    s.requests.delete(request.id);
    s.late.delete(request);
    request.timer.cancel();
  }

  /** Remove `record` from the records of `registrationId`; true when no record uses that id any more. */
  private unmap(record: Registration, registrationId: number, s: Session): boolean {
    const records = s.byRegistration.get(registrationId);
    if (records === undefined) return false; // not this session's id
    records.splice(records.indexOf(record), 1);
    if (records.length > 0) return false;
    s.byRegistration.delete(registrationId);
    return true;
  }

  /** The record is gone; its subscriber (if any) errors `error`, after the record left every map. */
  private fail(record: Registration, error: unknown, fx: Effects): void {
    this.records.delete(record);
    const op = record.op;
    record.op = undefined;
    if (op === undefined) return;
    this.opRecord.delete(op);
    fx.deliver(() => {
      op.subscriber.error(error);
    });
  }

  /** Forget a late REGISTER (expired or evicted): a later answer is dropped as unknown. */
  private expire(request: RegisterRequest, s: Session, ctx: SessionCtx): void {
    this.settle(request, s);
    remember(s.forgotten, request.record.key);
    this.records.delete(request.record);
    ctx.log(() => ({
      level: 'debug',
      event: 'request.timeout',
      message: `late REGISTER ${String(request.id)} forgotten`,
      data: { requestId: request.id, procedure: request.record.procedure },
    }));
  }

  /** Lazy expiry of late REGISTERs, on every entry with a session (no tombstone timer). */
  private purgeLate(s: Session, ctx: SessionCtx): void {
    for (const [request, until] of s.late) {
      if (until > ctx.now) return;
      this.expire(request, s, ctx);
    }
  }
}

/** Add `key` to `keys` as the most recent one, keeping at most GHOST_MEMORY (oldest first). */
/** `remember` for a map: `key` (with `value`) becomes the newest entry. */
function rememberAt<K, V>(entries: Map<K, V>, key: K, value: V): void {
  entries.delete(key);
  entries.set(key, value);
  for (const oldest of entries.keys()) {
    if (entries.size <= GHOST_MEMORY) break;
    entries.delete(oldest);
  }
}

function remember<K>(keys: Set<K>, key: K): void {
  keys.delete(key);
  keys.add(key);
  for (const oldest of keys) {
    if (keys.size <= GHOST_MEMORY) break;
    keys.delete(oldest);
  }
}

/** An outstanding REGISTER of `key` whose subscriber is gone (stopped or late): the next subscription adopts it. */
function adoptable(key: string, s: Session): RegisterRequest | undefined {
  for (const request of s.requests.values()) {
    if (request.kind === 'register' && request.record.op === undefined && request.record.key === key) return request;
  }
  return undefined;
}

/** The UNREGISTER of `registrationId` in flight, if any. */
function unregisterOf(registrationId: number, s: Session): UnregisterRequest | undefined {
  for (const request of s.requests.values()) {
    if (request.kind === 'unregister' && request.registrationId === registrationId) return request;
  }
  return undefined;
}

/** Is an UNREGISTER of `registrationId` in flight? */
function unregistering(registrationId: number, s: Session): boolean {
  return unregisterOf(registrationId, s) !== undefined;
}

/** Read through a call: app code (the handler, the result's subscribe) may have finished it meanwhile. */
function isDone(invocation: Invocation): boolean {
  return invocation.done;
}

function canceled(invocation: Invocation): CanceledError {
  return new CanceledError({ procedure: invocation.procedure, requestId: invocation.id });
}

function runtimeError(invocation: Invocation, text: string): InvocationErrorFrame {
  return invocationErrorFrame(invocation.id, {}, Uri.RUNTIME_ERROR, [[text]]);
}

/** `yieldPayload`: a `Yield` ⇒ its args/kwargs (undefined when they are not an array / a plain object);
 *  `undefined` ⇒ no payload; anything else ⇒ args `[value]`. */
function yieldPayload(value: unknown): OutboundPayload | undefined {
  if (value === undefined) return [];
  if (!isYield(value)) return [[value]];
  try {
    const { args, kwargs } = value;
    return Array.isArray(args) && isPlainObject(kwargs) ? outboundPayload(args, kwargs) : undefined;
  } catch {
    return undefined; // a hostile Yield (throwing getters, revoked Proxy)
  }
}

/** The ERROR answering a handler that threw, rejected or errored with `error`. */
function errorAnswer(invocation: Invocation, error: unknown, fx: Effects): InvocationErrorFrame {
  if (!isWampError(error)) return runtimeError(invocation, errorText(error));
  try {
    const { uri, args, kwargs, details } = error;
    if (Array.isArray(args) && isPlainObject(kwargs)) {
      // an invalid error URI would make Crossbar kill the callee's connection
      if (!isValidUri(uri)) return invocationErrorFrame(invocation.id, {}, Uri.RUNTIME_ERROR, [[uri]]);
      const dict: Dict = isPlainObject(details) ? checkedDetails(details, invocation, fx) : {};
      return invocationErrorFrame(invocation.id, dict, uri, outboundPayload(args, kwargs));
    }
  } catch {
    // a hostile WampError subclass: treated like an invalid payload
  }
  const problem = new TypeError('a WampError result needs an args array and a plain kwargs object');
  fx.log(eager(unhandledEntry(problem, `the handler of ${invocation.procedure}`)));
  return runtimeError(invocation, 'invalid result payload');
}

/** ERROR Details keys Crossbar checks (autobahn 26.10 `Error.parse` and its constructor): a mistyped one closes the
 *  callee's connection (1002, or 1011 for a bad `forward_for` principal). The types are validate.ts's for the CALL
 *  keys (`caller` → `callee`, an id; principals with `authid` a string). */
const CHECKED_DETAILS: ReadonlyMap<string, readonly [check: (value: unknown) => boolean, expected: string]> = new Map([
  ['callee', [isId, 'an id']],
  ['callee_authid', [isString, 'a string']],
  ['callee_authrole', [isString, 'a string']],
  ['forward_for', [isPrincipals, 'an array of {session: id, authid: string, authrole: string}']],
] as const);

/** The handler's WampError details as sent: a copy (each property read once) without the Crossbar-checked keys of the
 *  wrong type, each dropped with a `warn`: one handler's mistake must not close the callee's connection
 *  and with it every other registration and stream. */
function checkedDetails(details: Dict, invocation: Invocation, fx: Effects): Dict {
  const kept: [string, unknown][] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue; // absent, as JSON (and validate.ts) treat it
    const rule = CHECKED_DETAILS.get(key);
    if (rule === undefined || rule[0](value)) {
      kept.push([key, value]);
      continue;
    }
    fx.log(() => ({
      level: 'warn',
      event: 'option.fallback',
      message: `the ERROR for ${invocation.procedure} is sent without details.${key}: it must be ${rule[1]}`,
      data: { procedure: invocation.procedure, requestId: invocation.id, key },
    }));
  }
  return Object.fromEntries(kept);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Every item a principal, holes included: `for…of` visits a hole as undefined (`every()` skips it), and JSON writes it
 *  as null, which Crossbar refuses. */
function isPrincipals(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const items: readonly unknown[] = value;
  for (const item of items) if (!isPrincipal(item)) return false;
  return true;
}

function isPrincipal(item: unknown): boolean {
  return isPlainObject(item) && isId(item['session']) && isString(item['authid']) && isString(item['authrole']);
}

/** `String(e?.message ?? e)`: the message only, never a stack; never throws. */
function errorText(error: unknown): string {
  try {
    const message: unknown =
      typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
    return String(message ?? error);
  } catch {
    return 'unknown error';
  }
}
