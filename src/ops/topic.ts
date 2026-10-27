/**
 * TopicParticipant: one router subscription per key, shared by every local subscriber of that key;
 * events routed by router subscription id (several keys may share one id on brokers that reuse ids, Crossbar; Thruway
 * and fox-wamp give every SUBSCRIBE a new id); UNSUBSCRIBE deferred while a SUBSCRIBE of the same topic + match is
 * pending, and a SUBSCRIBED that returns an id whose UNSUBSCRIBE is in flight subscribes again; request
 * timers verified against liveness, late keys; revocation.
 *
 * A key is `dormant` (no session, or its SUBSCRIBE was not sent), `subscribing` (its SUBSCRIBE is outstanding; late
 * once the request timer expired and its locals errored), `resubscribe` (the router answered with an id whose
 * UNSUBSCRIBE is in flight: SUBSCRIBE again once that is answered) or `active`. A key stays findable while its
 * SUBSCRIBE is outstanding, even without locals, so a re-subscription joins it (StrictMode, `retry`). Everything bound
 * to one session lives in a `Session` object dropped at the session's end, so a callback that outlives its session (a
 * liveness verdict) finds itself stale and does nothing.
 *
 * @module
 */
import { isThruwayError, ProtocolError, TimeoutError, WampError, withContext } from '../errors.js';
import { MessageType, Uri } from '../protocol/codes.js';
import {
  subscribeFrame,
  unsubscribeFrame,
  type InboundError,
  type InboundEvent,
  type InboundMessage,
  type InboundSubscribed,
  type InboundSubscriptionRevoked,
} from '../protocol/messages.js';
import type {
  Effects,
  EndInfo,
  InterestParticipant,
  OptionsSnapshot,
  ParticipantDeps,
  SessionCtx,
  StopError,
  TimerHandle,
  TopicOp,
} from '../core/contracts.js';
import type { EventMessage } from '../types.js';

/** At most this many late requests per session and participant; the oldest is forgotten first. */
export const LATE_LIMIT = 1024;

/** What `sizes()` reports (the client's debug probe, INV-R10). */
export type TopicSizes = Readonly<Record<'keys' | 'locals' | 'requests' | 'late' | 'routerIds' | 'deferred', number>>;

interface SubscribeRequest {
  readonly kind: 'subscribe';
  readonly id: number;
  readonly key: Key;
  readonly writtenAt: number;
  timer: TimerHandle;
}

interface UnsubscribeRequest {
  readonly kind: 'unsubscribe';
  readonly id: number;
  readonly subscriptionId: number;
  readonly writtenAt: number;
  readonly timer: TimerHandle;
}

type Request = SubscribeRequest | UnsubscribeRequest;

type KeyState =
  | { readonly kind: 'dormant' }
  | { readonly kind: 'subscribing'; readonly request: SubscribeRequest }
  | { readonly kind: 'resubscribe'; readonly after: number }
  | { readonly kind: 'active'; readonly subscriptionId: number };

interface Key {
  readonly id: string;
  readonly group: string;
  readonly topic: string;
  readonly options: OptionsSnapshot;
  readonly locals: Set<TopicOp>;
  state: KeyState;
}

const DORMANT: KeyState = { kind: 'dormant' };

/** The group of a subscription no key holds (its topic is unknown): its UNSUBSCRIBE waits until no SUBSCRIBE of any
 *  group is pending, since Crossbar may answer a pending one with the same id. */
const ANY_GROUP = '';

/** Per-session maps; dropped as a whole when the session ends. */
class Session {
  readonly requests = new Map<number, Request>();
  /** Router subscription id → the keys it serves (Crossbar may give two keys of one topic the same id). */
  readonly byRouterId = new Map<number, Set<Key>>();
  /** Router subscription ids whose UNSUBSCRIBE is in flight (no key maps them). */
  readonly unsubscribing = new Set<number>();
  /** Router subscription id → its group: UNSUBSCRIBE it once no SUBSCRIBE of that group is pending. */
  readonly deferred = new Map<number, string>();
  /** Late SUBSCRIBEs → when they are forgotten; oldest first (they all live `requestTimeout` ms). */
  readonly late = new Map<SubscribeRequest, number>();
  constructor(readonly connId: number) {}
}

export class TopicParticipant implements InterestParticipant<TopicOp> {
  readonly name = 'topic' as const;
  private readonly requestTimeout: number;
  private readonly keys = new Map<string, Key>();
  private readonly localKey = new Map<TopicOp, Key>();
  private s: Session | undefined;

  constructor(deps: ParticipantDeps) {
    this.requestTimeout = deps.requestTimeout;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the contract's signature (topics deliver through ctx)
  start(op: TopicOp, ctx: SessionCtx | undefined, _fx: Effects): void {
    if (this.localKey.has(op)) return;
    if (ctx === undefined) {
      this.add(op); // no session: dormant until the next WELCOME
      return;
    }
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    const key = this.add(op);
    const state = key.state;
    if (state.kind === 'dormant') {
      this.subscribe(key, s, ctx);
    } else if (state.kind === 'subscribing' && s.late.delete(state.request)) {
      // a late key is adopted: its SUBSCRIBE is still outstanding; it gets a fresh request timer
      state.request.timer = ctx.timer(this.requestTimeout, 'topic', state.request.id, true);
    }
    // otherwise the local joins the pending SUBSCRIBE, the next re-SUBSCRIBE, or the active subscription
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the contract's signature (topics deliver through ctx)
  stop(op: TopicOp, ctx: SessionCtx | undefined, _fx: Effects): void {
    const key = this.localKey.get(op);
    if (key === undefined) return; // settled already (errored, revoked, closed)
    this.localKey.delete(op);
    key.locals.delete(op);
    if (key.locals.size > 0) return;
    const state = key.state;
    if (state.kind === 'subscribing' || state.kind === 'resubscribe') return; // kept until the router answers
    this.keys.delete(key.id);
    if (state.kind === 'active' && ctx !== undefined) {
      const s = this.session(ctx);
      this.purgeLate(s, ctx); // an expired late SUBSCRIBE must not hold this UNSUBSCRIBE back
      if (this.unmap(key, state.subscriptionId, s)) this.unsubscribeSoon(state.subscriptionId, key.group, s, ctx);
    }
  }

  welcome(ctx: SessionCtx): void {
    this.begin(ctx);
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    if (msg.type === MessageType.SUBSCRIBED) return this.subscribed(msg, s, ctx);
    if (msg.type === MessageType.UNSUBSCRIBED) {
      return msg.revocation ? this.revoked(msg, s, ctx) : this.unsubscribed(msg.requestId, undefined, s, ctx);
    }
    if (msg.type === MessageType.EVENT) return this.event(msg, s, ctx);
    if (msg.type !== MessageType.ERROR) return false; // routed elsewhere
    if (msg.requestType === MessageType.SUBSCRIBE) return this.subscribeError(msg, s, ctx);
    if (msg.requestType === MessageType.UNSUBSCRIBE) return this.unsubscribed(msg.requestId, msg, s, ctx);
    return false;
  }

  timer(key: number, ctx: SessionCtx): void {
    const s = this.session(ctx);
    this.purgeLate(s, ctx);
    const request = s.requests.get(key);
    if (request === undefined) return; // answered meanwhile
    ctx.verifyAlive(request.writtenAt, () => {
      if (this.s !== s || s.requests.get(request.id) !== request) return; // answered, or the session ended
      if (request.kind === 'unsubscribe') this.unsubscribeTimedOut(request, s, ctx);
      else this.subscribeTimedOut(request, s, ctx);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the contract's signature (nothing to emit)
  sessionEnded(_end: EndInfo, _fx: Effects): void {
    this.end();
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    this.s = undefined;
    const locals = [...this.localKey.keys()];
    this.localKey.clear();
    this.keys.clear();
    for (const local of locals) {
      const error = stopError({ topic: local.snap.topic });
      fx.deliver(() => {
        local.subscriber.error(error);
      });
    }
  }

  /** A live view of this session's request ids that can be iterated any number of times (an allocator may scan it
   *  again on each redraw; a bare Map iterator would be exhausted after the first scan). */
  pendingIds(): Iterable<number> {
    return { [Symbol.iterator]: () => (this.s === undefined ? [].values() : this.s.requests.keys()) };
  }

  /** Map sizes, for the client's debug probe and the no-leak checks (INV-R10). Internal. */
  sizes(): TopicSizes {
    const s = this.s ?? new Session(0);
    return {
      keys: this.keys.size,
      locals: this.localKey.size,
      requests: s.requests.size,
      late: s.late.size,
      routerIds: s.byRouterId.size,
      deferred: s.deferred.size,
    };
  }

  // ------------------------------------------------------------------------------------------------- session

  /** The session `ctx` belongs to; a session this participant was not told about is welcomed first. */
  private session(ctx: SessionCtx): Session {
    const s = this.s;
    return s?.connId === ctx.connId ? s : this.begin(ctx);
  }

  /** WELCOME: SUBSCRIBE every dormant key with locals, FIFO by first local. Idempotent per session. */
  private begin(ctx: SessionCtx): Session {
    if (this.s !== undefined && this.s.connId !== ctx.connId) this.end(); // its end was never reported
    const s = this.s ?? new Session(ctx.connId);
    this.s = s;
    const dormant = [...this.keys.values()].filter((key) => key.state.kind === 'dormant');
    dormant.sort((a, b) => firstSeq(a) - firstSeq(b));
    for (const key of dormant) this.subscribe(key, s, ctx);
    return s;
  }

  /** Session end: keys with locals turn dormant without emitting anything; keys without locals are deleted. */
  private end(): void {
    this.s = undefined;
    for (const key of [...this.keys.values()]) {
      if (key.locals.size === 0) this.keys.delete(key.id);
      else key.state = DORMANT;
    }
  }

  // ------------------------------------------------------------------------------------------------- writes

  private subscribe(key: Key, s: Session, ctx: SessionCtx): void {
    let id: number | undefined;
    try {
      id = ctx.request((requestId) => subscribeFrame(requestId, key.options, key.topic));
    } catch (error) {
      // serializer or size error: this key can never be sent; its locals fail, the connection is untouched
      this.keys.delete(key.id);
      this.fail(key, writeFailure(error, { topic: key.topic }), ctx);
      return;
    }
    if (id === undefined) {
      key.state = DORMANT; // not sent: the connection is ending; SUBSCRIBE again at the next WELCOME
      return;
    }
    const timer = ctx.timer(this.requestTimeout, 'topic', id, true);
    const request: SubscribeRequest = { kind: 'subscribe', id, key, writtenAt: ctx.now, timer };
    s.requests.set(id, request);
    key.state = { kind: 'subscribing', request };
  }

  /** The last key of a router subscription left: UNSUBSCRIBE it, unless a SUBSCRIBE of the same group is pending (the
   *  router may be about to answer that one with this very id). */
  private unsubscribeSoon(subscriptionId: number, group: string, s: Session, ctx: SessionCtx): void {
    if (this.pendingIn(group, s)) s.deferred.set(subscriptionId, group);
    else this.writeUnsubscribe(subscriptionId, s, ctx);
  }

  /** UNSUBSCRIBE `subscriptionId`, an id received in this session (never a stale one). */
  private writeUnsubscribe(subscriptionId: number, s: Session, ctx: SessionCtx): void {
    s.deferred.delete(subscriptionId);
    let id: number | undefined;
    try {
      id = ctx.request((requestId) => unsubscribeFrame(requestId, subscriptionId));
    } catch (error) {
      ctx.log(() => ({
        level: 'warn',
        event: 'request.error',
        message: `UNSUBSCRIBE of subscription ${String(subscriptionId)} could not be written`,
        data: { subscriptionId, error },
      }));
      return;
    }
    if (id === undefined) return; // the session is ending
    const timer = ctx.timer(this.requestTimeout, 'topic', id, true);
    s.requests.set(id, { kind: 'unsubscribe', id, subscriptionId, writtenAt: ctx.now, timer });
    s.unsubscribing.add(subscriptionId);
  }

  /** Write every deferred UNSUBSCRIBE whose group has no pending SUBSCRIBE any more. */
  private flushDeferred(s: Session, ctx: SessionCtx): void {
    for (const [subscriptionId, group] of [...s.deferred]) {
      if (!this.pendingIn(group, s)) this.writeUnsubscribe(subscriptionId, s, ctx);
    }
  }

  /** Is a SUBSCRIBE of `group` outstanding (late ones included: the router may still answer them)? */
  private pendingIn(group: string, s: Session): boolean {
    for (const request of s.requests.values()) {
      if (request.kind === 'subscribe' && (group === ANY_GROUP || request.key.group === group)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------- inbound

  private subscribed(msg: InboundSubscribed, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(msg.requestId);
    if (request === undefined) {
      // the answer to a SUBSCRIBE given up on: the router just subscribed this session, so withdraw it once (not
      // id 0, which no router issues for a subscription: an UNSUBSCRIBE needs an id ≥ 1)
      const id = msg.subscriptionId;
      if (id === 0 || s.byRouterId.has(id) || s.unsubscribing.has(id) || s.deferred.has(id)) return false; // a duplicate
      ctx.log(() => ({
        level: 'debug',
        event: 'frame.dropped',
        message: `subscription ${String(id)} belongs to no topic; UNSUBSCRIBE it`,
        data: { subscriptionId: id },
      }));
      this.unsubscribeSoon(id, ANY_GROUP, s, ctx);
      return true;
    }
    if (request.kind !== 'subscribe') return false;
    this.settle(request, s);
    const key = request.key;
    const subscriptionId = msg.subscriptionId;
    if (key.locals.size === 0) {
      // every local left while the SUBSCRIBE was pending, or it was late and nobody adopted it
      this.keys.delete(key.id);
      if (!s.unsubscribing.has(subscriptionId) && !s.byRouterId.has(subscriptionId)) {
        this.unsubscribeSoon(subscriptionId, key.group, s, ctx);
      }
    } else if (s.unsubscribing.has(subscriptionId)) {
      key.state = { kind: 'resubscribe', after: subscriptionId }; // the router is about to drop that subscription
    } else {
      key.state = { kind: 'active', subscriptionId };
      const keys = s.byRouterId.get(subscriptionId);
      if (keys === undefined) s.byRouterId.set(subscriptionId, new Set([key]));
      else keys.add(key);
      s.deferred.delete(subscriptionId); // another key uses it now
    }
    this.flushDeferred(s, ctx);
    return true;
  }

  private subscribeError(msg: InboundError, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(msg.requestId);
    if (request?.kind !== 'subscribe') return false;
    this.settle(request, s);
    const key = request.key;
    this.keys.delete(key.id);
    const context = { topic: key.topic, requestId: msg.requestId, sessionId: ctx.session.id };
    const invalid = msg.invalid;
    const error =
      invalid === undefined
        ? withContext(new WampError(msg.error, msg.args, msg.kwargs, msg.details), context)
        : new ProtocolError({
            message: `invalid ERROR for SUBSCRIBE: ${invalid.reason}`,
            frame: invalid.frame,
            ...context,
          });
    this.fail(key, error, ctx);
    this.flushDeferred(s, ctx);
    return true;
  }

  /** UNSUBSCRIBED, or ERROR(34) (`refusal`; a payload-invalid one too): the request is over either way. */
  private unsubscribed(requestId: number, refusal: InboundError | undefined, s: Session, ctx: SessionCtx): boolean {
    const request = s.requests.get(requestId);
    if (request?.kind !== 'unsubscribe') return false;
    this.unsubscribeDone(request, s, ctx);
    if (refusal !== undefined) {
      ctx.log(() => ({
        level: 'debug',
        event: 'request.error',
        message: `UNSUBSCRIBE ${String(requestId)} answered with ${refusal.error}`,
        data: { requestId, subscriptionId: request.subscriptionId, error: refusal.error },
      }));
    }
    return true;
  }

  /** The UNSUBSCRIBE of a subscription id is over: keys whose SUBSCRIBED met that id subscribe again. */
  private unsubscribeDone(request: UnsubscribeRequest, s: Session, ctx: SessionCtx): void {
    s.requests.delete(request.id);
    request.timer.cancel();
    s.unsubscribing.delete(request.subscriptionId);
    for (const key of [...this.keys.values()]) {
      if (key.state.kind !== 'resubscribe' || key.state.after !== request.subscriptionId) continue;
      if (key.locals.size === 0) this.keys.delete(key.id);
      else this.subscribe(key, s, ctx);
    }
  }

  private event(msg: InboundEvent, s: Session, ctx: SessionCtx): boolean {
    const keys = s.byRouterId.get(msg.subscriptionId);
    if (keys === undefined) return false; // unknown id (an EVENT racing an UNSUBSCRIBE)
    const invalid = msg.invalid;
    if (invalid !== undefined) {
      ctx.log(() => ({
        level: 'warn',
        event: 'frame.dropped',
        message: `EVENT dropped: invalid payload (${invalid.reason})`,
        data: { subscriptionId: msg.subscriptionId, frame: invalid.frame },
      }));
      return true;
    }
    const event: EventMessage = Object.freeze({
      args: msg.args as unknown[],
      kwargs: msg.kwargs,
      details: msg.details,
    });
    for (const key of keys) {
      for (const local of key.locals) {
        // one delivery per local: an observer that throws cannot keep the event from the others
        ctx.deliver(() => {
          local.subscriber.next(event);
        });
      }
    }
    return true;
  }

  private revoked(msg: InboundSubscriptionRevoked, s: Session, ctx: SessionCtx): boolean {
    const subscriptionId = msg.subscriptionId;
    const wasDeferred = s.deferred.delete(subscriptionId); // never UNSUBSCRIBE an id the router dropped
    const keys = s.byRouterId.get(subscriptionId);
    if (keys === undefined) return wasDeferred;
    s.byRouterId.delete(subscriptionId);
    const args = msg.reason === undefined ? [] : [msg.reason];
    for (const key of keys) {
      this.keys.delete(key.id);
      const context = { topic: key.topic, sessionId: ctx.session.id };
      this.fail(key, withContext(new WampError(Uri.SUBSCRIPTION_REVOKED, args, {}, msg.details), context), ctx);
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------- timers

  /** The router answered a probe but not this SUBSCRIBE: its locals error; the key stays late. */
  private subscribeTimedOut(request: SubscribeRequest, s: Session, ctx: SessionCtx): void {
    const key = request.key;
    const init = { timer: 'request', timeout: this.requestTimeout, topic: key.topic, requestId: request.id } as const;
    this.fail(key, new TimeoutError({ ...init, sessionId: ctx.session.id }), ctx);
    s.late.set(request, ctx.now + this.requestTimeout);
    for (const oldest of s.late.keys()) {
      if (s.late.size <= LATE_LIMIT) break;
      this.expire(oldest, s, ctx);
    }
  }

  private unsubscribeTimedOut(request: UnsubscribeRequest, s: Session, ctx: SessionCtx): void {
    this.unsubscribeDone(request, s, ctx);
    ctx.log(() => ({
      level: 'warn',
      event: 'request.timeout',
      message: `UNSUBSCRIBE ${String(request.id)} was not answered; forgotten`,
      data: { requestId: request.id, subscriptionId: request.subscriptionId },
    }));
  }

  // ------------------------------------------------------------------------------------------------- helpers

  private add(op: TopicOp): Key {
    let key = this.keys.get(op.snap.key);
    if (key === undefined) {
      const { key: id, group, topic, options } = op.snap;
      key = { id, group, topic, options, locals: new Set(), state: DORMANT };
      this.keys.set(id, key);
    }
    key.locals.add(op);
    this.localKey.set(op, key);
    return key;
  }

  /** A SUBSCRIBE was answered or forgotten: no longer pending, its timer cancelled. */
  private settle(request: SubscribeRequest, s: Session): void {
    s.requests.delete(request.id);
    s.late.delete(request);
    request.timer.cancel();
  }

  /** Remove `key` from the keys of `subscriptionId`; true when no key uses that id any more. */
  private unmap(key: Key, subscriptionId: number, s: Session): boolean {
    const keys = s.byRouterId.get(subscriptionId);
    if (keys === undefined) return false; // not this session's id
    keys.delete(key);
    if (keys.size > 0) return false;
    s.byRouterId.delete(subscriptionId);
    return true;
  }

  /** Every local of `key` errors `error`, after it has been removed from every map. */
  private fail(key: Key, error: unknown, fx: Effects): void {
    const locals = [...key.locals];
    key.locals.clear();
    for (const local of locals) {
      this.localKey.delete(local);
      fx.deliver(() => {
        local.subscriber.error(error);
      });
    }
  }

  /** Forget a late SUBSCRIBE (expired or evicted): a later answer is dropped as unknown. */
  private expire(request: SubscribeRequest, s: Session, ctx: SessionCtx): void {
    this.settle(request, s);
    this.keys.delete(request.key.id);
    ctx.log(() => ({
      level: 'debug',
      event: 'request.timeout',
      message: `late SUBSCRIBE ${String(request.id)} forgotten`,
      data: { requestId: request.id, topic: request.key.topic },
    }));
    this.flushDeferred(s, ctx); // its group may have no pending SUBSCRIBE any more
  }

  /** Lazy expiry of late SUBSCRIBEs, on every entry with a session (no tombstone timer). */
  private purgeLate(s: Session, ctx: SessionCtx): void {
    for (const [request, until] of s.late) {
      if (until > ctx.now) return;
      this.expire(request, s, ctx);
    }
  }
}

/**
 * The error a failed SUBSCRIBE/REGISTER write delivers: one of our errors (the size error, a custom serializer's
 * ThruwayError) gets `context`; anything else is passed on unchanged. An error that refuses the context (frozen, or a
 * Proxy whose `set` throws) is passed on unchanged too, so a custom serializer can never make a participant throw (that
 * would be a hardReset failing every other stream; the same rule as call.ts `withWriteContext`). Also used by the
 * register participant.
 */
export function writeFailure(
  error: unknown,
  context: { readonly topic?: string; readonly procedure?: string },
): unknown {
  if (!isThruwayError(error)) return error;
  try {
    return withContext(error, context);
  } catch {
    return error;
  }
}

function firstSeq(key: Key): number {
  let seq = Infinity;
  for (const local of key.locals) seq = Math.min(seq, local.seq);
  return seq;
}
