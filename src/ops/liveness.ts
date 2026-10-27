/**
 * Liveness. WHATWG WebSockets can neither send nor observe pings, so half-open connections are
 * detected at the WAMP level with the probe `[48, id, {}, "thruway.js.ping"]`, a CALL to a procedure that does not
 * exist: every router answers it (`no_such_procedure`, or `not_authorized` from a default-deny router), and any answer
 * proves that the router still processes what this client writes.
 *
 * - A probe is written when nothing arrived for `idle` ms, and when a write has waited `idle` ms for proof that the
 *   router received it while other frames keep arriving (a one-way half-open link: client→router dead, router→client
 *   alive). Any reply restarts the wait of a request; a write that expects no reply (YIELD, an INVOCATION
 *   ERROR, CANCEL, an unacknowledged PUBLISH) is proven only by the answer of a probe written after it.
 * - Only the probe's own answer clears `timer.ping`. When it fires: an outbound backlog that is still draining re-arms
 *   it (the probe has not left yet). A router that provably processed a request written after the probe has
 *   received the probe and dropped it: while its probe capability is unknown, that turns probing off (calibration);
 *   once it has answered a probe, the session is kept, once in a row. Otherwise the connection is
 *   dead.
 * - The probe capability, the calibration strike and the ping budget belong to the endpoint they were learned on (the
 *   URL without query and fragment; `endpoint`). The budget adapts: doubled after a session ended by liveness
 *   (cap 120 s), back to the base once a probe is answered within the base.
 * - Liveness can never loop on one endpoint: a session ended by liveness sends an endpoint that answered
 *   probes back to calibration, and the second session in a row on an endpoint that ends by liveness with no probe
 *   answered in it turns probing off there, whatever the client's traffic: a router that drops every probe costs at
 *   most two liveness reconnects per endpoint.
 * - A request timer asks for a verdict before it errors an interest (`verifyAlive`); `open()` while established
 *   probes after 2 s of silence (`check`).
 *
 * The idle timer always runs towards the current deadline: frames that move the deadline re-arm it (at most once per
 * second), and so does the first write while a probe is pending (the probe's answer vouches only for what was written
 * before it). A firing idle timer means "probe now", and no clock reading decides whether to probe — a clock that
 * jumps can neither postpone nor disable the probe; it can only make one earlier.
 *
 * The core calls it; it is not a participant. `timer.idle` and `timer.ping` are core timers, armed through the
 * `LivenessHost` and cleared with the connection, so liveness only ignores callbacks for a connection it no longer
 * tracks.
 *
 * @module
 */
import type { ConnId, Liveness as LivenessContract, LivenessHost, SessionCtx } from '../core/contracts.js';
import { MessageType } from '../protocol/codes.js';
import { probeFrame, type InboundMessage } from '../protocol/messages.js';

/** Ping budget cap. */
export const PING_BUDGET_CAP = 120000;
/** `check()` probes only when nothing arrived for this long. */
export const CHECK_SILENCE = 2000;
/** The first idle timer of a session while the router's probe capability is unknown (calibration). */
export const CALIBRATION_DELAY = 1000;
/** `timer.ping` re-check interval while the outbound backlog drains. */
export const DRAIN_RECHECK = 5000;
/** Frames re-arm the idle timer at most this often (at most a tenth of `idle`): a probe comes at most this early. */
export const REARM_SLACK = 1000;
/** Endpoints remembered; the one used least recently is forgotten first. */
export const ENDPOINT_MEMORY = 16;
/** Sessions in a row on one endpoint that end by liveness with no probe answered: then probing is off there. */
export const DEAD_SESSIONS_LIMIT = 2;

/** Request types the client writes through `ctx.request`: an ERROR for one of them settles that request. */
const REQUEST_TYPES: ReadonlySet<number> = new Set<number>([
  MessageType.PUBLISH,
  MessageType.SUBSCRIBE,
  MessageType.UNSUBSCRIBE,
  MessageType.CALL,
  MessageType.REGISTER,
  MessageType.UNREGISTER,
]);

/** What liveness learns about one router: kept across sessions, per endpoint (`endpointKey`). */
interface Endpoint {
  /** Does this router answer the probe? */
  capability: 'unknown' | 'yes' | 'no';
  /** A calibration probe went unanswered while other frames, but no proof, arrived; a second such probe decides. */
  suspect: boolean;
  budget: number;
  /** The latest sessions on this endpoint, in a row, that ended by liveness with no probe answered in them. */
  deadSessions: number;
}

interface Probe {
  readonly id: number;
  /** 1 for the session's first probe, then 2, … */
  readonly seq: number;
  readonly writtenAt: number;
  /** Requests still waiting for their final reply when the probe was written. */
  readonly ahead: number;
  /** Writes that expect no reply were still unproven when the probe was written. */
  readonly unprovenAhead: boolean;
  /** Frames other than the answer received since the probe was written. */
  frames: number;
  /** Final replies received since then. */
  replies: number;
  /** The router provably processed a request written after the probe, so it received the probe and did not answer
   *  it: a final reply arrived after such a request, and more of them than requests were waiting at the probe's write.
   *  Replies that arrive before any request written after the probe can prove nothing. */
  proven: boolean;
  /** `bufferedAmount` when the probe was written, then at each draining re-check. */
  buffered: number;
  /** A re-check saw the backlog in front of the probe draining. */
  draining: boolean;
  /** Something was written after the probe. The answer vouches only for what was written before the probe, so those
   *  writes keep their own deadline: the idle timer, re-armed for `idle` at the first of them. */
  followed: boolean;
  /** A request expecting a reply was written after the probe. */
  asked: boolean;
  /** A write that expects no reply was written after the probe: it stays unproven after the answer. */
  sentAfter: boolean;
  /** That deadline passed while the probe was pending: its answer probes again at once. */
  overdue: boolean;
}

interface Verdict {
  /** The request's write time, or Infinity when the clock cannot place it. */
  readonly since: number;
  /** Probes written in this session when the verdict was queued: any later probe was written after its request. */
  readonly after: number;
  readonly onTimeout: () => void;
}

interface SessionState {
  readonly conn: ConnId;
  /** The router of this session: what it learns goes there, also when the core reports another URL meanwhile. */
  readonly ep: Endpoint;
  enabled: boolean;
  /** ctx.now when the idle timer was armed (only to coalesce re-arms). */
  idleArmedAt: number;
  /** Requests written that expect a reply and whose final reply has not arrived (while this is positive, frames
   *  other than replies do not move the idle deadline). An estimate that errs high (an unanswered request or a
   *  cancelled call stays counted): that costs at most one probe per idle. */
  outstanding: number;
  /** Writes that expect no reply have not been proven by the answer of a probe written after them: no frame moves
   *  the idle deadline, which stays `idle` after the oldest of them. */
  unproven: boolean;
  /** The last probe went unanswered and was forgiven on proof of activity: the next one must be answered. */
  saved: boolean;
  /** The id of the last forgiven probe until its late answer arrives: that answer is consumed, never taken for the
   *  final reply of a request, and the id stays in flight for the allocator. */
  forgiven: number | undefined;
  /** ctx.now of the last inbound frame (`check`). */
  lastInbound: number;
  probe: Probe | undefined;
  probes: number;
  /** Write time of the last answered probe: the router processed everything written up to then. */
  aliveSince: number;
  /** A probe was answered in this session (a forgiven probe's late answer is none). */
  answered: boolean;
  verdicts: Verdict[];
}

export class Liveness implements LivenessContract {
  private readonly host: LivenessHost;
  /** The router the next session talks to (before the core first reports a URL: an endpoint of its own). */
  private ep: Endpoint;
  /** What was learned per endpoint, the least recently used first (at most `ENDPOINT_MEMORY`). */
  private readonly endpoints = new Map<string, Endpoint>();
  private session: SessionState | undefined;
  /** Set while the probe itself is written, so that its own `wrote()` is not counted as a request. */
  private writingProbe = false;

  constructor(host: LivenessHost) {
    this.host = host;
    this.ep = newEndpoint(host.pingBudget);
  }

  /**
   * The URL the next connection resolved to (not part of the `Liveness` contract; the core calls it before `start`
   * at each WELCOME). The probe capability, the calibration strike and the ping budget belong to the endpoint
   * they were learned on: an endpoint seen for the first time (also the first one reported after something was learned)
   * starts from scratch, as a fresh instance would; the same one changes nothing; one seen before gets back what was
   * learned there, so a resolver that alternates between routers (or puts a fresh ticket in the query string) still
   * converges instead of looping on liveness reconnects. A session that is still running keeps its own router.
   */
  endpoint(url: string): void {
    const key = endpointKey(url);
    const ep = this.endpoints.get(key) ?? newEndpoint(this.host.pingBudget);
    this.endpoints.delete(key); // inserted again as the most recent one (the current endpoint always is)
    this.endpoints.set(key, ep);
    for (const oldest of this.endpoints.keys()) {
      if (this.endpoints.size <= ENDPOINT_MEMORY) break;
      this.endpoints.delete(oldest);
    }
    this.ep = ep;
  }

  start(ctx: SessionCtx, welcomeRoles: Readonly<Record<string, unknown>>): void {
    const ep = this.ep;
    const on = this.host.idle > 0 && ep.capability !== 'no';
    const noDealer = on && lacksDealer(welcomeRoles);
    const s: SessionState = {
      conn: ctx.connId,
      ep,
      enabled: on && !noDealer,
      idleArmedAt: ctx.now,
      outstanding: 0,
      unproven: false,
      saved: false,
      forgiven: undefined,
      lastInbound: ctx.now,
      probe: undefined,
      probes: 0,
      aliveSince: -Infinity,
      answered: false,
      verdicts: [],
    };
    this.session = s;
    if (s.enabled) {
      const calibrate = ep.capability === 'unknown';
      this.armIdle(s, ctx, calibrate ? Math.min(CALIBRATION_DELAY, this.host.idle) : this.host.idle);
    } else if (noDealer) {
      ctx.log(() => ({
        level: 'warn',
        event: 'option.fallback',
        message: 'the router announced no dealer role: the liveness probe (a CALL) is off for this session',
      }));
    }
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    const s = this.current(ctx);
    if (s === undefined) return false;
    s.lastInbound = ctx.now;
    const probe = s.probe;
    if (probe !== undefined && answers(msg, probe.id)) {
      this.answered(s, probe, ctx);
      return true;
    }
    // The late answer of a forgiven probe proves no more than its save did. Taken for a final reply, it would let a
    // request written into a dead uplink stop holding the deadline while EVENTs keep it moving (a hidden half-open link)
    const late = s.forgiven !== undefined && answers(msg, s.forgiven);
    if (late) s.forgiven = undefined;
    const kind = late ? 'none' : replyKind(msg);
    if (probe !== undefined) {
      probe.frames++;
      if (kind === 'final') {
        probe.replies++;
        if (probe.asked && probe.replies > probe.ahead) probe.proven = true;
      }
    }
    if (kind === 'final' && s.outstanding > 0) s.outstanding--;
    // The deadline moves to `idle` after this frame, unless requests still wait for a reply since before it: a reply
    // restarts their wait, any other frame leaves it
    if (kind !== 'none' || s.outstanding === 0) this.touch(s, ctx);
    return late;
  }

  wrote(expectsReply: boolean, ctx: SessionCtx): void {
    const s = this.current(ctx);
    if (s === undefined || this.writingProbe) return;
    if (!expectsReply) {
      this.unanswered(s, ctx); // an unacknowledged PUBLISH
      return;
    }
    s.outstanding++;
    // The deadline stays where it is (`idle` after the last frame, which came before this request), unless a probe is
    // pending: its answer does not vouch for this request
    const probe = s.probe;
    if (probe !== undefined) {
      this.follow(s, probe, ctx);
      probe.asked = true;
    }
  }

  /**
   * A write that expects no reply succeeded (not part of the `Liveness` contract; the core calls it after every
   * successful `ctx.send`: YIELD, an INVOCATION ERROR, CANCEL). Only the answer of a probe written after it proves
   * that the router received it.
   */
  sent(ctx: SessionCtx): void {
    const s = this.current(ctx);
    if (s !== undefined) this.unanswered(s, ctx);
  }

  onIdle(ctx: SessionCtx): void {
    const s = this.current(ctx);
    if (!s?.enabled) return;
    // Nothing moved the deadline for `idle` ms (or the calibration delay passed): probe. With a probe pending, this is
    // the deadline of a write after it (`followed`): its answer probes again
    if (s.probe === undefined) this.probe(s, ctx);
    else if (s.probe.followed) s.probe.overdue = true;
  }

  onPing(ctx: SessionCtx): 'alive' | 'dead' {
    const s = this.current(ctx);
    if (s?.probe === undefined) return 'alive'; // nothing of this session to decide
    const probe = s.probe;
    const ep = s.ep;
    const buffered = this.host.bufferedAmount(ctx);
    if (buffered > 0 && buffered < probe.buffered) {
      // (a) the outbound backlog in front of the probe is draining: the probe has not left yet
      probe.buffered = buffered;
      probe.draining = true;
      this.host.armPing(ctx, Math.min(ep.budget, DRAIN_RECHECK));
      return 'alive';
    }
    if (buffered === 0 && probe.draining) {
      // the backlog finished draining since the last re-check, so the probe has only just left: one full budget
      probe.draining = false;
      probe.buffered = 0;
      this.host.armPing(ctx, ep.budget);
      return 'alive';
    }
    if (ep.capability === 'unknown' && probe.frames > 0) {
      // (b) the router talks but has not answered the probe: it drops unknown CALLs — when it provably processed a
      // request written after the probe, or for the second time; otherwise it may be stalled or half-open (dead)
      if (probe.proven || ep.suspect) {
        ep.capability = 'no';
        this.disable(s, ctx, 'the router does not answer the liveness probe (CALL thruway.js.ping): liveness is off');
        return 'alive';
      }
      ep.suspect = true;
    } else if (probe.proven && !s.saved) {
      // the router answers probes, received this one and processed later requests: it dropped one probe, the link
      // works. Forgiven once in a row, so strays cannot keep a half-open link alive. The deadline is the
      // idle timer armed at the first write after the probe, unless writes that need a probe's answer were waiting
      s.saved = true;
      s.probe = undefined;
      s.forgiven = probe.id;
      if (s.verdicts.length > 0 || probe.unprovenAhead || probe.overdue) this.probe(s, ctx);
      return 'alive';
    }
    return this.dead(s, ctx); // (c) the core releases with 4001 and ends the session with TimeoutError{liveness}
  }

  check(ctx: SessionCtx): void {
    const s = this.current(ctx);
    if (s !== undefined && s.enabled && s.probe === undefined && ctx.now - s.lastInbound >= CHECK_SILENCE) {
      this.probe(s, ctx);
    }
  }

  verifyAlive(since: number, onTimeout: () => void, ctx: SessionCtx): void {
    const s = this.current(ctx);
    if (s === undefined) return; // that session has ended: its record is dormant or Lost, never a request timeout
    // `since` and `aliveSince` are ctx.now readings. A `since` that is not a finite number cannot be placed, and an
    // `aliveSince` ahead of now (the clock went back) proves nothing: then only a probe written from now on decides
    const placed = Number.isFinite(since);
    if (!s.enabled || (placed && s.aliveSince >= since && s.aliveSince <= ctx.now)) {
      this.host.later(ctx, onTimeout);
      return;
    }
    s.verdicts.push({ since: placed ? since : Infinity, after: s.probes, onTimeout });
    if (s.probe === undefined) this.probe(s, ctx);
  }

  sessionEnded(byLiveness: boolean): void {
    // The core has released the connection, which cleared its timers; queued verdicts are discarded with the session.
    // Only the end of a tracked session counts: an end without one (a failed handshake) or a second call for the same
    // end must not double the budget again. A session that ended otherwise breaks a run of liveness ends
    const s = this.session;
    if (s === undefined) return;
    this.session = undefined;
    if (byLiveness) s.ep.budget = Math.min(2 * s.ep.budget, Math.max(PING_BUDGET_CAP, this.host.pingBudget));
    else s.ep.deadSessions = 0;
  }

  /** The ping budget in force in `ctx`'s session (not part of the `Liveness` contract): its endpoint's, doubled after
   *  earlier liveness ends. The core reports it in TimeoutError{timer: 'liveness'}. */
  budget(ctx: SessionCtx): number {
    return this.current(ctx)?.ep.budget ?? this.host.pingBudget;
  }

  /** The id of the pending probe, then that of a forgiven one still unanswered, if any (not part of the `Liveness`
   *  contract): the core's request-id allocator must treat them as in flight, like the participants' `pendingIds()`. */
  pendingIds(): Iterable<number> {
    const s = this.session;
    const ids: number[] = [];
    if (s?.probe !== undefined) ids.push(s.probe.id);
    if (s?.forgiven !== undefined) ids.push(s.forgiven);
    return ids;
  }

  private current(ctx: SessionCtx): SessionState | undefined {
    const s = this.session;
    return s?.conn === ctx.connId ? s : undefined;
  }

  private armIdle(s: SessionState, ctx: SessionCtx, ms: number): void {
    s.idleArmedAt = ctx.now;
    this.host.armIdle(ctx, ms);
  }

  /** The idle deadline moved to `idle` from now. Re-arm, unless the calibration timer runs (until the router has
   *  answered a probe, frames do not move it), a probe is pending, a verdict waits for one (its probe could not be
   *  written: the idle timer retries it) or writes wait for one, or the timer was armed less than the slack
   *  ago (ctx.now only coalesces: a clock that lies can only make a probe earlier). */
  private touch(s: SessionState, ctx: SessionCtx): void {
    if (!s.enabled || s.ep.capability === 'unknown' || s.probe !== undefined || s.verdicts.length > 0 || s.unproven) {
      return;
    }
    const elapsed = ctx.now - s.idleArmedAt;
    if (elapsed >= 0 && elapsed < Math.min(REARM_SLACK, this.host.idle / 10)) return;
    this.armIdle(s, ctx, this.host.idle);
  }

  /** A write that expects no reply: unproven until a probe written after it is answered. */
  private unanswered(s: SessionState, ctx: SessionCtx): void {
    s.unproven = true;
    const probe = s.probe;
    if (probe !== undefined) {
      this.follow(s, probe, ctx);
      probe.sentAfter = true;
    }
  }

  /** A write while the probe is pending: the first one re-arms the idle timer for `idle`, its own deadline. */
  private follow(s: SessionState, probe: Probe, ctx: SessionCtx): void {
    if (probe.followed) return;
    probe.followed = true;
    this.armIdle(s, ctx, this.host.idle);
  }

  private probe(s: SessionState, ctx: SessionCtx): void {
    let id: number | undefined;
    this.writingProbe = true;
    try {
      id = ctx.request(probeFrame);
    } catch (error) {
      this.disable(s, ctx, 'the liveness probe could not be written: liveness is off for this session', error);
      return;
    } finally {
      this.writingProbe = false;
    }
    if (id === undefined) {
      // not sent: the connection is ending. Should it not end, the idle timer writes the probe again.
      this.armIdle(s, ctx, this.host.idle);
      return;
    }
    s.probe = {
      id,
      seq: ++s.probes,
      writtenAt: ctx.now,
      ahead: s.outstanding,
      unprovenAhead: s.unproven,
      frames: 0,
      replies: 0,
      proven: false,
      buffered: this.host.bufferedAmount(ctx),
      draining: false,
      followed: false,
      asked: false,
      sentAfter: false,
      overdue: false,
    };
    this.host.armPing(ctx, s.ep.budget);
  }

  private answered(s: SessionState, probe: Probe, ctx: SessionCtx): void {
    s.probe = undefined;
    s.saved = false;
    s.answered = true;
    s.ep.capability = 'yes'; // until a session on this router ends by liveness: then it calibrates again
    s.ep.suspect = false;
    this.host.cancelPing(ctx);
    s.aliveSince = probe.writtenAt;
    if (ctx.now - probe.writtenAt <= this.host.pingBudget) s.ep.budget = this.host.pingBudget;
    // Writes that expect no reply are proven up to the probe; those written after it wait for the next one
    s.unproven = probe.sentAfter;
    // A verdict is decided by a probe written after it was queued, or (clock permitting) after its request
    const clockOk = probe.writtenAt <= ctx.now;
    this.runVerdicts(s, ctx, (v) => v.after < probe.seq || (clockOk && v.since <= probe.writtenAt));
    // The answer restarts the wait of what was written before the probe. Writes after it (`followed`) that still wait
    // keep the idle timer armed at the first of them, or probe again if that deadline has passed
    const waiting = probe.sentAfter || (probe.asked && s.outstanding > 0);
    if (s.verdicts.length > 0 || (waiting && probe.overdue)) this.probe(s, ctx);
    else if (!waiting) this.armIdle(s, ctx, this.host.idle);
  }

  /**
   * (c) The probe failed: the session ends. On its endpoint: a router that has answered probes is
   * calibrated again by the next session (`'unknown'`), and the second session in a row that ends this way with no
   * probe answered in it turns probing off there (`'no'`), so a router that drops every probe costs at most two
   * liveness reconnects per endpoint, whatever the traffic. A real half-open link on an endpoint that answers is still
   * detected (this end), and the next healthy session re-calibrates it.
   */
  private dead(s: SessionState, ctx: SessionCtx): 'dead' {
    const ep = s.ep;
    if (ep.capability === 'yes') ep.capability = 'unknown';
    ep.deadSessions = s.answered ? 0 : ep.deadSessions + 1;
    if (ep.deadSessions >= DEAD_SESSIONS_LIMIT) {
      ep.capability = 'no';
      ctx.log(() => ({
        level: 'warn',
        event: 'liveness.unsupported',
        message: `the router answered no liveness probe in ${String(ep.deadSessions)} sessions in a row: liveness is off`,
      }));
    }
    return 'dead';
  }

  /** Liveness cannot work in this session (probe unanswered or unwritable): verdicts run, nothing is probed again. */
  private disable(s: SessionState, ctx: SessionCtx, message: string, error?: unknown): void {
    s.enabled = false;
    s.probe = undefined;
    ctx.log(() =>
      error === undefined
        ? { level: 'warn', event: 'liveness.unsupported', message }
        : { level: 'warn', event: 'liveness.unsupported', message, data: { error } },
    );
    this.runVerdicts(s, ctx, () => true);
  }

  /** Queue `onTimeout` of the verdicts selected by `due` (FIFO, in a later step); keep the others. */
  private runVerdicts(s: SessionState, ctx: SessionCtx, due: (verdict: Verdict) => boolean): void {
    const keep: Verdict[] = [];
    for (const verdict of s.verdicts) {
      if (due(verdict)) this.host.later(ctx, verdict.onTimeout);
      else keep.push(verdict);
    }
    s.verdicts = keep;
  }
}

function newEndpoint(budget: number): Endpoint {
  return { capability: 'unknown', suspect: false, budget, deadSessions: 0 };
}

/** An endpoint is the URL without its query and fragment: a fresh ticket in the query string is the same router. */
function endpointKey(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** RESULT or ERROR(CALL | CANCEL) for the probe's id: the probe's answer (liveness routes before `call`). */
function answers(msg: InboundMessage, id: number): boolean {
  return (
    (msg.type === MessageType.RESULT ||
      (msg.type === MessageType.ERROR &&
        (msg.requestType === MessageType.CALL || msg.requestType === MessageType.CANCEL))) &&
    msg.requestId === id
  );
}

/**
 * Reply-class frames prove that the router processes what this client writes; `final` ones also settle one request. A
 * progress RESULT and an ERROR answering a CANCEL (type 49, as Thruway PHP and Bondy send) or a request the client
 * never makes (type 8) settle nothing. Revocations, EVENT, INVOCATION and INTERRUPT are router-initiated: they prove
 * only the inbound direction.
 */
function replyKind(msg: InboundMessage): 'none' | 'reply' | 'final' {
  switch (msg.type) {
    case MessageType.RESULT:
      return msg.details['progress'] === true ? 'reply' : 'final';
    case MessageType.ERROR:
      return REQUEST_TYPES.has(msg.requestType) ? 'final' : 'reply';
    case MessageType.PUBLISHED:
    case MessageType.SUBSCRIBED:
    case MessageType.REGISTERED:
      return 'final';
    case MessageType.UNSUBSCRIBED:
    case MessageType.UNREGISTERED:
      return msg.revocation ? 'none' : 'final';
    case MessageType.WELCOME:
    case MessageType.ABORT:
    case MessageType.CHALLENGE:
    case MessageType.GOODBYE:
    case MessageType.EVENT:
    case MessageType.INVOCATION:
    case MessageType.INTERRUPT:
      return 'none';
  }
}

/**
 * WELCOME `roles` that list roles but no `dealer`: a CALL probe would go to a router that routes no calls. A
 * WELCOME without roles (the core passes `{}`) is treated as having one, as is a dict that cannot be read.
 */
function lacksDealer(roles: Readonly<Record<string, unknown>>): boolean {
  try {
    const names = Object.keys(roles);
    return names.length > 0 && !names.includes('dealer');
  } catch {
    return false;
  }
}
