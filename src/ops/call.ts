/**
 * CallParticipant: CALL, RESULT/ERROR, CANCEL and progressive results.
 *
 * A call is held here only while it is in flight: from the write that put its CALL on the wire until the first of its
 * final RESULT/ERROR, the app's unsubscribe, the end of its session or close()/give-up. Calls waiting for a session
 * stay in the core's FIFO; records are immutable and their per-op state lives in this participant.
 *
 * - `write`: `[48, id, options, procedure, args?, kwargs?]` through `ctx.request`. A serializer or size error fails
 *   only this op (nothing written, `'done'`); a refused write leaves it queued (`'not-sent'`).
 * - RESULT: a progress RESULT is emitted only when the op asked for progress and it carries a payload (Crossbar
 *   forwards unrequested progress, Thruway PHP sends empty keepalives); the final RESULT is emitted unless the op is
 *   progressive, its payload is empty and something was emitted already, then the op completes.
 * - ERROR(48|49) ⇒ `WampError` with uri, args, kwargs, details and the call's context; a payload-invalid RESULT/ERROR
 *   ⇒ `ProtocolError` (the session continues).
 * - Unsubscribe ⇒ `[49, id, {mode: 'killnowait'}]` once, only into the call's own session; the call is settled locally
 *   and later frames for its id are dropped. A refused CANCEL (`wamp.error.not_supported`, Thruway PHP for callees
 *   without `call_canceling`) is logged `cancel.refused` once per procedure per session.
 * - Session end ⇒ `end.inflightError(…)` (ConnectionLostError, or ConnectionClosedError{gaveUp, cause} on give-up);
 *   close()/give-up ⇒ `stopError(…)`, each with its own procedure and request id. Calls never time out inside the
 *   client and are never re-sent (the callee may already have run them).
 *
 * A call leaves `byId` (the only strong map; the op index is weak and consulted through it) before its terminal
 * notification is queued; app code runs only in deliveries.
 *
 * @module
 */
import type {
  CallOp,
  Effects,
  EndInfo,
  OneShotParticipant,
  ParticipantDeps,
  SessionCtx,
  StopError,
} from '../core/contracts.js';
import { isWampError, ProtocolError, WampError, withContext, type ThruwayError } from '../errors.js';
import { describeError, eager } from '../logger.js';
import { MessageType, Uri } from '../protocol/codes.js';
import {
  callFrame,
  cancelFrame,
  type InboundError,
  type InboundMessage,
  type InboundResult,
  type PayloadInvalid,
} from '../protocol/messages.js';
import { outboundPayload } from '../protocol/payload.js';
import type { ResultMessage } from '../types.js';

/** Answers to cancelled calls are recognised (log text, `cancel.refused`) for the most recent 64 cancellations. */
export const CANCELLED_LIMIT = 64;
/** At most this many procedures are remembered as "CANCEL refused" per session (a long session that cancels calls
 *  to ever new procedure URIs must not grow without bound); the oldest is forgotten first and may be logged again. */
export const REFUSED_LIMIT = 1024;

interface InFlightCall {
  readonly op: CallOp;
  readonly requestId: number;
  /** The connection the CALL was written on: nothing for this call is ever written into another one. */
  readonly connId: number;
  /** A progress result was emitted. */
  emitted: boolean;
}

export class CallParticipant implements OneShotParticipant<CallOp> {
  readonly name = 'call' as const;
  /** The calls in flight in the current session: the only strong reference this participant keeps to a record. */
  private readonly byId = new Map<number, InFlightCall>();
  /** Lookup for `stop`; an entry counts only while `byId` still maps its id to it. */
  private readonly byOp = new WeakMap<CallOp, InFlightCall>();
  /** Request id → procedure of the calls cancelled in this session (diagnostics only; FIFO-evicted, no timer). */
  private readonly cancelled = new Map<number, string>();
  /** Procedures whose CANCEL the router refused in this session. */
  private readonly refused = new Set<string>();

  /** Calls arm no timers and submit nothing, so `deps` is not used; the core constructs every participant alike. */
  constructor(private readonly deps?: ParticipantDeps) {}

  write(op: CallOp, ctx: SessionCtx): 'done' | 'not-sent' {
    if (op.subscriber.closed) return 'done'; // nobody wants the answer (unsubscribed by app code inside a step)
    const { procedure, options, args, kwargs } = op.snap;
    let requestId: number | undefined;
    try {
      requestId = ctx.request((id) => callFrame(id, options, procedure, outboundPayload(args, kwargs)));
    } catch (error) {
      const failure = withWriteContext(error, { procedure, sessionId: ctx.session.id });
      ctx.deliver(() => {
        op.subscriber.error(failure);
      });
      return 'done';
    }
    if (requestId === undefined) return 'not-sent';
    const call: InFlightCall = { op, requestId, connId: ctx.connId, emitted: false };
    this.byId.set(requestId, call);
    this.byOp.set(op, call);
    return 'done';
  }

  stop(op: CallOp, ctx: SessionCtx | undefined): void {
    const call = this.byOp.get(op);
    // queued, answered or already failed: nothing to cancel (its id may already belong to a newer call)
    if (call === undefined || this.byId.get(call.requestId) !== call) return;
    this.forget(call);
    if (ctx?.connId !== call.connId) return; // no session, or another one: never written into it
    const { requestId } = call;
    const { procedure } = op.snap;
    this.cancelled.set(requestId, procedure);
    trim(this.cancelled, CANCELLED_LIMIT);
    try {
      ctx.send(cancelFrame(requestId)); // false: the connection is ending, the router drops the call with it
    } catch (error) {
      // Only a broken custom serializer can fail on this frame; the call stays settled locally.
      ctx.log(
        eager({
          level: 'error',
          event: 'internal',
          message: `CANCEL for a call to ${procedure} could not be written: ${describeError(error)}`,
          data: { error, requestId, procedure },
        }),
      );
    }
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    // ERROR(49): Thruway PHP and Bondy answer for the CALL with the CANCEL's request type.
    if (msg.type === MessageType.ERROR)
      return (msg.requestType === MessageType.CALL || msg.requestType === MessageType.CANCEL) && this.error(msg, ctx);
    return msg.type === MessageType.RESULT && this.result(msg, ctx);
  }

  timer(): void {
    // Calls arm no timers: a call timeout is the app's Rx timeout(), whose unsubscribe sends CANCEL.
  }

  sessionEnded(end: EndInfo, fx: Effects): void {
    this.failAll(fx, (call) => end.inflightError({ requestId: call.requestId, procedure: call.op.snap.procedure }));
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    this.failAll(fx, (call) => stopError({ requestId: call.requestId, procedure: call.op.snap.procedure }));
  }

  /** A live view that can be iterated any number of times (a bare `Map` iterator could be consumed only once, so an
   *  allocator that scanned it again on a redraw would see no ids in flight and could reuse one). */
  pendingIds(): Iterable<number> {
    return { [Symbol.iterator]: () => this.byId.keys() };
  }

  private result(msg: InboundResult, ctx: SessionCtx): boolean {
    const call = this.inFlight(msg.requestId, ctx);
    if (call === undefined) return this.late(msg.requestId, false, ctx);
    if (msg.invalid !== undefined) return this.invalid(call, msg.invalid, ctx);
    const { op } = call;
    const empty = msg.args.length === 0 && Object.keys(msg.kwargs).length === 0;
    // Frozen, payload not copied; the decoder already froze `details`.
    const result = Object.freeze({ args: msg.args, kwargs: msg.kwargs, details: msg.details }) as ResultMessage;
    if (msg.details['progress'] === true) {
      if (!op.snap.progressive || empty) {
        const what = op.snap.progressive ? 'an empty progress RESULT' : 'an unrequested progress RESULT';
        ctx.log(() => dropped(msg.requestId, op.snap.procedure, what));
      } else {
        call.emitted = true;
        ctx.deliver(() => {
          op.subscriber.next(result);
        });
      }
      return true;
    }
    this.forget(call);
    // an empty terminator after progress values is not surfaced (only a progressive call can have emitted)
    if (!(empty && call.emitted)) {
      ctx.deliver(() => {
        op.subscriber.next(result);
      });
    }
    ctx.deliver(() => {
      op.subscriber.complete();
    });
    return true;
  }

  private error(msg: InboundError, ctx: SessionCtx): boolean {
    const call = this.inFlight(msg.requestId, ctx);
    if (call === undefined) return this.late(msg.requestId, msg.error === Uri.NOT_SUPPORTED, ctx);
    if (msg.invalid !== undefined) return this.invalid(call, msg.invalid, ctx);
    const error = withContext(new WampError(msg.error, msg.args, msg.kwargs, msg.details), context(call, ctx));
    return this.fail(call, error, ctx);
  }

  private invalid(call: InFlightCall, invalid: PayloadInvalid, ctx: SessionCtx): boolean {
    return this.fail(
      call,
      new ProtocolError({ message: invalid.reason, frame: invalid.frame, ...context(call, ctx) }),
      ctx,
    );
  }

  private fail(call: InFlightCall, error: ThruwayError, ctx: SessionCtx): boolean {
    this.forget(call);
    ctx.deliver(() => {
      call.op.subscriber.error(error);
    });
    return true;
  }

  /** RESULT/ERROR for no call in flight: consumed (and logged here) only when it answers a call cancelled in this
   *  session — `refusal` when it is ERROR wamp.error.not_supported; otherwise `false`, and the core logs the drop. */
  private late(requestId: number, refusal: boolean, ctx: SessionCtx): boolean {
    const procedure = this.cancelled.get(requestId);
    if (procedure === undefined) return false;
    if (refusal && !this.refused.has(procedure)) {
      this.refused.add(procedure);
      trim(this.refused, REFUSED_LIMIT);
      ctx.log(() => ({
        level: 'warn',
        event: 'cancel.refused',
        message: `The router refused to cancel a call to ${procedure} (${Uri.NOT_SUPPORTED}); the callee keeps working`,
        data: { requestId, procedure },
      }));
    } else {
      ctx.log(() => dropped(requestId, procedure, 'an answer to a canceled call'));
    }
    return true;
  }

  private inFlight(requestId: number, ctx: SessionCtx): InFlightCall | undefined {
    const call = this.byId.get(requestId);
    return call?.connId === ctx.connId ? call : undefined;
  }

  private forget(call: InFlightCall): void {
    this.byId.delete(call.requestId);
  }

  /** Clear every per-session structure, then error each call that was in flight (in write order). */
  private failAll(fx: Effects, errorOf: (call: InFlightCall) => unknown): void {
    const calls = [...this.byId.values()];
    this.byId.clear();
    this.cancelled.clear();
    this.refused.clear();
    for (const call of calls) {
      const error = errorOf(call);
      fx.deliver(() => {
        call.op.subscriber.error(error);
      });
    }
  }
}

function context(call: InFlightCall, ctx: SessionCtx) {
  return { procedure: call.op.snap.procedure, requestId: call.requestId, sessionId: ctx.session.id };
}

/**
 * The error a failed write delivers to its op: a WampError (the size error, or a custom serializer's) gets the op's
 * context; anything else is passed on unchanged. A WampError that refuses the context (frozen, or a Proxy whose `set`
 * throws) is passed on unchanged too, so a custom serializer can never make `write` throw (that would be a hardReset
 * that fails every other op). Also used by the publication participant.
 */
export function withWriteContext(
  error: unknown,
  context: { readonly procedure?: string; readonly topic?: string; readonly sessionId: number },
): unknown {
  if (!isWampError(error)) return error;
  try {
    return withContext(error, context);
  } catch {
    return error;
  }
}

/** Forget the oldest entries (insertion order) until at most `limit` remain. */
function trim<K>(
  entries: { readonly size: number; keys(): Iterable<K>; delete(key: K): boolean },
  limit: number,
): void {
  for (const oldest of entries.keys()) {
    if (entries.size <= limit) break;
    entries.delete(oldest);
  }
}

function dropped(requestId: number, procedure: string, what: string) {
  return {
    level: 'debug' as const,
    event: 'frame.dropped',
    message: `dropped ${what} to ${procedure}`,
    data: { requestId, procedure },
  };
}
