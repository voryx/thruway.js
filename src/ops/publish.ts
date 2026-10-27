/**
 * PublishParticipant: PUBLISH and PUBLISHED.
 *
 * Publications waiting for a session stay in the core's FIFO; the participant holds only acknowledged
 * publications whose PUBLISH is on the wire and not yet answered.
 *
 * - `write`: `[16, id, options, topic, args?, kwargs?]` through `ctx.request(build, expectsReply = acknowledge)` (an id
 *   is allocated even when unacknowledged: Nexus strict counts it). A serializer or size error fails only this op
 *   (nothing written, `'done'`); a refused write leaves it queued (`'not-sent'`). Unacknowledged and written ⇒
 *   `next(undefined)`, `complete` (handed to the socket; if the socket then drops, the publication may be lost).
 * - PUBLISHED ⇒ `next(undefined)`, `complete`; ERROR(16) ⇒ `WampError` with the topic context; a payload-invalid
 *   ERROR(16) ⇒ `ProtocolError`. No client-side timer: the app bounds an unanswered acknowledgement with Rx timeout().
 * - Unsubscribe ⇒ forgotten (WAMP has no publish cancel); a late PUBLISHED/ERROR is dropped as unknown.
 * - Session end ⇒ `end.inflightError(…)`; close()/give-up ⇒ `stopError(…)`, with its topic and request id.
 *
 * A publication leaves `byId` (the only strong map; the op index is weak and consulted through it) before its terminal
 * notification is queued; app code runs only in deliveries.
 *
 * @module
 */
import type {
  Effects,
  EndInfo,
  OneShotParticipant,
  ParticipantDeps,
  PublishOp,
  SessionCtx,
  StopError,
} from '../core/contracts.js';
import { ProtocolError, WampError, withContext } from '../errors.js';
import { MessageType } from '../protocol/codes.js';
import { publishFrame, type InboundError, type InboundMessage } from '../protocol/messages.js';
import { outboundPayload } from '../protocol/payload.js';
import { withWriteContext } from './call.js';

interface InFlightPublish {
  readonly op: PublishOp;
  readonly requestId: number;
  /** The connection the PUBLISH was written on: only its answers settle the op. */
  readonly connId: number;
}

export class PublishParticipant implements OneShotParticipant<PublishOp> {
  readonly name = 'publish' as const;
  /** The acknowledged publications in flight: the only strong reference this participant keeps to a record. */
  private readonly byId = new Map<number, InFlightPublish>();
  /** Lookup for `stop`; an entry counts only while `byId` still maps its id to it. */
  private readonly byOp = new WeakMap<PublishOp, InFlightPublish>();

  /** Publications arm no timers and submit nothing, so `deps` is not used; the core constructs every participant
   *  alike. */
  constructor(private readonly deps?: ParticipantDeps) {}

  write(op: PublishOp, ctx: SessionCtx): 'done' | 'not-sent' {
    if (op.subscriber.closed) return 'done'; // unsubscribed by app code inside a step: publish nothing
    const { topic, options, args, kwargs, ack } = op.snap;
    let requestId: number | undefined;
    try {
      requestId = ctx.request((id) => publishFrame(id, options, topic, outboundPayload(args, kwargs)), ack);
    } catch (error) {
      const failure = withWriteContext(error, { topic, sessionId: ctx.session.id });
      ctx.deliver(() => {
        op.subscriber.error(failure);
      });
      return 'done';
    }
    if (requestId === undefined) return 'not-sent';
    if (ack) {
      const publication: InFlightPublish = { op, requestId, connId: ctx.connId };
      this.byId.set(requestId, publication);
      this.byOp.set(op, publication);
    } else {
      done(op, ctx);
    }
    return 'done';
  }

  stop(op: PublishOp): void {
    const publication = this.byOp.get(op);
    // answered or failed: nothing to forget (its id may already belong to a newer publication)
    if (publication === undefined || this.byId.get(publication.requestId) !== publication) return;
    this.forget(publication);
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    if (msg.type === MessageType.ERROR) return msg.requestType === MessageType.PUBLISH && this.error(msg, ctx);
    if (msg.type !== MessageType.PUBLISHED) return false;
    const publication = this.inFlight(msg.requestId, ctx);
    if (publication === undefined) return false;
    this.forget(publication);
    done(publication.op, ctx);
    return true;
  }

  timer(): void {
    // Publications arm no timers: an acknowledgement is bounded by the app's Rx timeout().
  }

  sessionEnded(end: EndInfo, fx: Effects): void {
    this.failAll(fx, (p) => end.inflightError({ requestId: p.requestId, topic: p.op.snap.topic }));
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    this.failAll(fx, (p) => stopError({ requestId: p.requestId, topic: p.op.snap.topic }));
  }

  /** A live view that can be iterated any number of times (see CallParticipant.pendingIds). */
  pendingIds(): Iterable<number> {
    return { [Symbol.iterator]: () => this.byId.keys() };
  }

  private error(msg: InboundError, ctx: SessionCtx): boolean {
    const publication = this.inFlight(msg.requestId, ctx);
    if (publication === undefined) return false;
    this.forget(publication);
    const context = { topic: publication.op.snap.topic, requestId: msg.requestId, sessionId: ctx.session.id };
    const error =
      msg.invalid === undefined
        ? withContext(new WampError(msg.error, msg.args, msg.kwargs, msg.details), context)
        : new ProtocolError({ message: msg.invalid.reason, frame: msg.invalid.frame, ...context });
    ctx.deliver(() => {
      publication.op.subscriber.error(error);
    });
    return true;
  }

  private inFlight(requestId: number, ctx: SessionCtx): InFlightPublish | undefined {
    const publication = this.byId.get(requestId);
    return publication?.connId === ctx.connId ? publication : undefined;
  }

  private forget(publication: InFlightPublish): void {
    this.byId.delete(publication.requestId);
  }

  /** Clear the per-session map, then error each publication that was in flight (in write order). */
  private failAll(fx: Effects, errorOf: (publication: InFlightPublish) => unknown): void {
    const publications = [...this.byId.values()];
    this.byId.clear();
    for (const publication of publications) {
      const error = errorOf(publication);
      fx.deliver(() => {
        publication.op.subscriber.error(error);
      });
    }
  }
}

/** The publication was handed to the socket (unacknowledged) or acknowledged: emit `undefined` once and complete. */
function done(op: PublishOp, fx: Effects): void {
  fx.deliver(() => {
    op.subscriber.next(undefined);
  });
  fx.deliver(() => {
    op.subscriber.complete();
  });
}
