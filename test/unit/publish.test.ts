// Publication participant, driven through fake-ctx: PUBLISH with and without acknowledge (an id is allocated either
// way, expectsReply only with acknowledge), completion on write vs on PUBLISHED, ERROR(16) ⇒ WampError{topic},
// payload-invalid ERROR(16) ⇒ ProtocolError, not sent ⇒ stays queued, serializer/size errors fail only that op,
// unsubscribe forgets (no frame), session end ⇒ Lost or Closed{gaveUp, cause}, close(), one connection per record,
// options never mutated, no timers; and a model-based property over random interleavings (no double settle, no frame
// after settle, no leak, every op settles).
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import type { OpSubscriber, PublishOp, PublishSnapshot } from '../../src/core/contracts.js';
import { ConnectionClosedError, isThruwayError, isWampError, WampError } from '../../src/errors.js';
import { PublishParticipant } from '../../src/ops/publish.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { MAX_FRAME_BYTES, type OutboundFrame } from '../../src/protocol/messages.js';
import { outboundPayload } from '../../src/protocol/payload.js';
import { snapshotPublish } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  FakeEffects,
  fakeEndInfo,
  fakeStopError,
  fakePublishOp,
  FakeSessionCtx,
  FakeSubscriber,
  inbound,
  nextSeq,
} from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

const ACK = { acknowledge: true } as const;

function publishOf<S extends OpSubscriber<void>>(snap: PublishSnapshot, subscriber: S): PublishOp & { subscriber: S } {
  return Object.freeze({ kind: 'publish' as const, seq: nextSeq(), snap, subscriber });
}

describe('write', () => {
  test('unacknowledged: an id is allocated (Nexus strict counts it), expectsReply false; next(undefined), complete after the step', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ ids: [31] });
    const op = fakePublishOp({ topic: 'com.example.status', args: [1] });
    expect(publish.write(op, ctx)).toBe('done');
    expect(ctx.written).toMatchObject([
      { via: 'request', requestId: 31, expectsReply: false, frame: [16, 31, {}, 'com.example.status', [1]] },
    ]);
    expect([...publish.pendingIds()]).toEqual([]); // nothing to wait for
    expect(op.subscriber.notifications).toEqual([]);
    expect(ctx.runDeliveries()).toBe(2);
    expect(op.subscriber.notifications).toEqual([{ kind: 'next', value: undefined }, { kind: 'complete' }]);
    expect(publish.inbound(inbound.published(31, 900), ctx)).toBe(false); // nothing was waiting for it
  });

  test('acknowledged: expectsReply true, held until PUBLISHED, then next(undefined), complete', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ ids: [8] });
    const op = fakePublishOp({ topic: 't', kwargs: { a: 1 }, options: ACK });
    expect(publish.write(op, ctx)).toBe('done');
    expect(ctx.written).toMatchObject([{ requestId: 8, expectsReply: true, frame: [16, 8, ACK, 't', [], { a: 1 }] }]);
    expect([...publish.pendingIds()]).toEqual([8]);
    expect(ctx.runDeliveries()).toBe(0);
    expect(publish.inbound(inbound.published(8, 4242), ctx)).toBe(true);
    expect([...publish.pendingIds()]).toEqual([]);
    expect(op.subscriber.notifications).toEqual([]);
    ctx.runDeliveries();
    expect(op.subscriber.notifications).toEqual([{ kind: 'next', value: undefined }, { kind: 'complete' }]);
    expect(publish.inbound(inbound.published(8, 4242), ctx)).toBe(false); // duplicate/late: dropped by the core
  });

  test('next and complete are separate deliveries: a throwing next still lets the publication complete', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    class Throwing extends FakeSubscriber<void> {
      override next(): void {
        super.next();
        throw new Error('observer bug');
      }
    }
    const op = publishOf(snapshotPublish('t', [], {}, {}), new Throwing());
    publish.write(op, ctx);
    expect(ctx.runDeliveries({ rethrow: false })).toBe(2);
    expect(op.subscriber.completed).toBe(true);
  });

  test.each([
    ['no payload', undefined, undefined, [16, 1, {}, 't']],
    ['empty args and kwargs', [], {}, [16, 1, {}, 't']],
    ['args', [1, null], undefined, [16, 1, {}, 't', [1, null]]],
    ['kwargs', undefined, { k: 1 }, [16, 1, {}, 't', [], { k: 1 }]],
    ['both', [1], { k: 1 }, [16, 1, {}, 't', [1], { k: 1 }]],
  ] as const)('payload: %s', (_name, args, kwargs, frame) => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    publish.write(fakePublishOp({ topic: 't', args, kwargs }), ctx);
    expect(ctx.frames()).toEqual([frame]);
  });

  test("not sent ('not-sent'): nothing held, nothing delivered — even unacknowledged it does not complete; written once later", () => {
    for (const options of [{}, ACK]) {
      const publish = new PublishParticipant();
      const ending = createFakeCtx({ connId: 1 });
      ending.refuseWrites = true;
      const op = fakePublishOp({ topic: 't', options });
      expect(publish.write(op, ending)).toBe('not-sent');
      expect(ending.refused).toMatchObject([{ releasedId: 1, reason: 'refused' }]);
      expect(ending.pendingDeliveries).toEqual([]);
      expect([...publish.pendingIds()]).toEqual([]);
      ending.endSession();
      publish.sessionEnded(fakeEndInfo(), createFakeEffects());
      const next = createFakeCtx({ connId: 2, session: { id: 2 } });
      expect(publish.write(op, next)).toBe('done');
      expect(next.frames()).toEqual([[16, 1, options, 't']]);
      if (options === ACK) publish.inbound(inbound.published(1, 1), next);
      next.runDeliveries();
      expect(op.subscriber.completed).toBe(true);
    }
  });

  test('a serializer error fails only this op after the step; nothing written, the id released', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const bad = fakePublishOp({ topic: 't', args: [10n], options: ACK });
    expect(publish.write(bad, ctx)).toBe('done');
    expect(bad.subscriber.notifications).toEqual([]);
    ctx.runDeliveries();
    expect(bad.subscriber.errors).toEqual([expect.any(TypeError)]);
    expect(ctx.written).toEqual([]);
    expect([...publish.pendingIds()]).toEqual([]);
    const thrown = new RangeError('custom serializer');
    ctx.failNextWrite(thrown);
    const custom = fakePublishOp({ topic: 't' });
    publish.write(custom, ctx);
    ctx.runDeliveries();
    expect(custom.subscriber.errors[0]).toBe(thrown);
    publish.write(fakePublishOp({ topic: 't' }), ctx);
    expect(ctx.written.map((w) => w.requestId)).toEqual([1]);
  });

  test('a frame over 16 MiB errors the op with payload_size_exceeded and its topic context', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ session: { id: 9 }, maxFrameBytes: 64 });
    const op = fakePublishOp({ topic: 'com.example.big', args: ['x'.repeat(64)] });
    publish.write(op, ctx);
    ctx.runDeliveries();
    const [error] = op.subscriber.errors;
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({ uri: Uri.PAYLOAD_SIZE_EXCEEDED, topic: 'com.example.big', sessionId: 9 });
    expect(ctx.written).toEqual([]);
  });

  test('the real 16 MiB limit applies to a publication too', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't', kwargs: { blob: 'y'.repeat(MAX_FRAME_BYTES) } });
    publish.write(op, ctx);
    ctx.runDeliveries();
    expect(op.subscriber.errors).toMatchObject([{ uri: Uri.PAYLOAD_SIZE_EXCEEDED }]);
  });

  test('a frozen WampError from a custom serializer fails only this op: write never throws', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const frozen = Object.freeze(new WampError(Uri.PAYLOAD_SIZE_EXCEEDED, [9, 8]));
    const op = fakePublishOp({ topic: 't', options: ACK });
    ctx.failNextWrite(frozen);
    expect(publish.write(op, ctx)).toBe('done');
    ctx.runDeliveries();
    expect(op.subscriber.errors[0]).toBe(frozen);
    expect(frozen).not.toHaveProperty('topic');
    expect([...publish.pendingIds()]).toEqual([]);
  });

  test('pendingIds() is a live view that can be iterated again and again', () => {
    const publish = new PublishParticipant();
    const ids = publish.pendingIds();
    const ctx = createFakeCtx({ ids: [3, 3, 4], inFlight: () => ids });
    publish.write(fakePublishOp({ topic: 'a', options: ACK }), ctx);
    expect([...ids]).toEqual([3]);
    expect([...ids]).toEqual([3]);
    publish.write(fakePublishOp({ topic: 'b', options: ACK }), ctx); // 3 is redrawn
    expect([...ids]).toEqual([3, 4]);
    publish.inbound(inbound.published(3, 1), ctx);
    expect([...ids]).toEqual([4]);
  });

  test('an op whose subscriber already closed is not published', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't' });
    op.subscriber.unsubscribe();
    expect(publish.write(op, ctx)).toBe('done');
    expect(ctx.written).toEqual([]);
    expect(ctx.pendingDeliveries).toEqual([]);
  });
});

describe('answers', () => {
  test('ERROR(16) ⇒ WampError with uri, args, kwargs, details, topic, requestId, sessionId', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ ids: [4], session: { id: 6 } });
    const op = fakePublishOp({ topic: 'com.example.secret', options: ACK });
    publish.write(op, ctx);
    const args = ['denied'];
    expect(publish.inbound(inbound.error(16, 4, Uri.NOT_AUTHORIZED, args, { why: 'role' }, { router: 'x' }), ctx)).toBe(
      true,
    );
    expect([...publish.pendingIds()]).toEqual([]);
    ctx.runDeliveries();
    const [error] = op.subscriber.errors;
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({
      uri: Uri.NOT_AUTHORIZED,
      message: Uri.NOT_AUTHORIZED,
      kwargs: { why: 'role' },
      details: { router: 'x' },
      topic: 'com.example.secret',
      requestId: 4,
      sessionId: 6,
    });
    expect((error as { args: unknown }).args).toBe(args);
    expect(publish.inbound(inbound.error(16, 4, Uri.NOT_AUTHORIZED), ctx)).toBe(false);
  });

  test('a payload-invalid ERROR(16) ⇒ ProtocolError{frame, context}; the session continues', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't', options: ACK });
    publish.write(op, ctx);
    publish.inbound(
      inbound.invalid(inbound.error(16, 1, 'x'), 'ERROR args is not an array', '[8,16,1,{},"x",{}]'),
      ctx,
    );
    ctx.runDeliveries();
    const [error] = op.subscriber.errors;
    expect(isThruwayError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'protocol',
      message: 'ERROR args is not an array',
      frame: '[8,16,1,{},"x",{}]',
      topic: 't',
      requestId: 1,
    });
    expect(ctx.violations).toEqual([]);
  });

  test('answers for unknown ids, ERRORs of other request types and foreign messages are not consumed', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    publish.write(fakePublishOp({ topic: 't', options: ACK }), ctx);
    expect(publish.inbound(inbound.published(2, 1), ctx)).toBe(false);
    expect(publish.inbound(inbound.error(16, 2, 'x'), ctx)).toBe(false);
    for (const type of [8, 32, 48, 49, 64, 68]) expect(publish.inbound(inbound.error(type, 1, 'x'), ctx)).toBe(false);
    for (const msg of [inbound.result(1), inbound.subscribed(1, 1), inbound.event(1, 1)])
      expect(publish.inbound(msg, ctx)).toBe(false);
    expect([...publish.pendingIds()]).toEqual([1]);
  });

  test("an answer handed in with another connection's ctx settles nothing", () => {
    const publish = new PublishParticipant();
    const mine = createFakeCtx({ connId: 1 });
    const other = createFakeCtx({ connId: 2 });
    publish.write(fakePublishOp({ topic: 't', options: ACK }), mine);
    expect(publish.inbound(inbound.published(1, 1), other)).toBe(false);
    expect(publish.inbound(inbound.error(16, 1, 'x'), other)).toBe(false);
    expect([...publish.pendingIds()]).toEqual([1]);
    expect(publish.inbound(inbound.published(1, 1), mine)).toBe(true);
  });

  test('no client timer: an unanswered acknowledged publish waits (bounded by the app’s Rx timeout)', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't', options: ACK });
    publish.write(op, ctx);
    publish.timer();
    expect(ctx.timers).toEqual([]);
    expect(ctx.advance(10 * 60 * 1000)).toBe(0);
    expect([...publish.pendingIds()]).toEqual([1]);
    expect(op.subscriber.notifications).toEqual([]);
  });
});

describe('unsubscribe', () => {
  test("a settled publication's late stop (the facade's teardown) never touches a newer one that reuses its id", () => {
    const publish = new PublishParticipant();
    const first = createFakeCtx({ connId: 1, ids: [5, 5], inFlight: () => publish.pendingIds() });
    const acked = fakePublishOp({ topic: 'a', options: ACK });
    publish.write(acked, first);
    publish.inbound(inbound.published(5, 1), first);
    const reused = fakePublishOp({ topic: 'b', options: ACK });
    publish.write(reused, first); // same session, id 5 again
    publish.stop(acked);
    expect([...publish.pendingIds()]).toEqual([5]);
    expect(publish.inbound(inbound.published(5, 2), first)).toBe(true);
    first.runDeliveries();
    expect(reused.subscriber.completed).toBe(true);
  });

  test('after a session end, stopping an old publication never touches the next session’s one with the same id', () => {
    const publish = new PublishParticipant();
    const first = createFakeCtx({ connId: 1 });
    const old = fakePublishOp({ topic: 'a', options: ACK });
    publish.write(old, first);
    first.endSession();
    publish.sessionEnded(fakeEndInfo(), first);
    const second = createFakeCtx({ connId: 2, session: { id: 2 } });
    const next = fakePublishOp({ topic: 'b', options: ACK });
    publish.write(next, second); // sequential ids restart at 1
    publish.stop(old);
    expect([...publish.pendingIds()]).toEqual([1]);
    expect(publish.inbound(inbound.published(1, 1), second)).toBe(true);
    second.runDeliveries();
    expect(next.subscriber.completed).toBe(true);
  });

  test('an acknowledged publication in flight is forgotten: no frame (WAMP has no publish cancel), late answers dropped', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't', options: ACK });
    publish.write(op, ctx);
    const calls = [
      vi.spyOn(op.subscriber, 'next'),
      vi.spyOn(op.subscriber, 'error'),
      vi.spyOn(op.subscriber, 'complete'),
    ];
    op.subscriber.unsubscribe();
    publish.stop(op);
    expect(ctx.frames()).toHaveLength(1);
    expect([...publish.pendingIds()]).toEqual([]);
    expect(publish.inbound(inbound.published(1, 1), ctx)).toBe(false);
    expect(publish.inbound(inbound.error(16, 1, 'x'), ctx)).toBe(false);
    expect(ctx.pendingDeliveries).toEqual([]);
    for (const method of calls) expect(method).not.toHaveBeenCalled();
  });

  test('stop of a completed, failed or never-written publication changes nothing', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const sent = fakePublishOp({ topic: 't' });
    publish.write(sent, ctx);
    const acked = fakePublishOp({ topic: 't', options: ACK });
    publish.write(acked, ctx);
    publish.inbound(inbound.published(2, 1), ctx);
    const queued = fakePublishOp({ topic: 't', options: ACK });
    for (const op of [sent, acked, queued]) publish.stop(op);
    ctx.runDeliveries();
    expect(sent.subscriber.completed).toBe(true);
    expect(acked.subscriber.completed).toBe(true);
    expect(ctx.frames()).toHaveLength(2);
  });
});

describe('session end, close() and give-up', () => {
  test('acknowledged publications in flight error ConnectionLostError{requestId, topic} after the core notified', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ ids: [5, 6] });
    const unacked = fakePublishOp({ topic: 'fire' });
    const acked = fakePublishOp({ topic: 'com.example.ack', options: ACK });
    publish.write(unacked, ctx);
    publish.write(acked, ctx);
    ctx.runDeliveries(); // the unacknowledged one completed on write
    ctx.endSession();
    const fx = createFakeEffects();
    const order: string[] = [];
    fx.deliver(() => order.push('onClose'));
    const end = fakeEndInfo();
    publish.sessionEnded(end, fx);
    expect(end.calls).toEqual([{ requestId: 6, topic: 'com.example.ack' }]);
    expect([...publish.pendingIds()]).toEqual([]);
    fx.deliver(() => order.push('after'));
    fx.runDeliveries();
    expect(order).toEqual(['onClose', 'after']);
    expect(acked.subscriber.errors).toMatchObject([
      { code: 'connection_lost', requestId: 6, topic: 'com.example.ack' },
    ]);
    expect(unacked.subscriber.notifications).toEqual([{ kind: 'next', value: undefined }, { kind: 'complete' }]);
  });

  test('give-up: ConnectionClosedError{gaveUp: true, cause: ConnectionLostError}', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const op = fakePublishOp({ topic: 't', options: ACK });
    publish.write(op, ctx);
    const fx = createFakeEffects();
    publish.sessionEnded(fakeEndInfo({ willRetry: false }), fx);
    publish.clientClosed(fakeStopError({ gaveUp: true }), fx);
    fx.runDeliveries();
    expect(op.subscriber.errors).toHaveLength(1);
    expect(op.subscriber.errors[0]).toMatchObject({
      code: 'connection_closed',
      gaveUp: true,
      cause: { code: 'connection_lost' },
    });
  });

  test('close(): every acknowledged publication in flight errors its own stop error (topic, request id), in write order', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx({ ids: [7, 8] });
    const a = fakePublishOp({ topic: 'a', options: ACK });
    const b = fakePublishOp({ topic: 'b', options: ACK });
    publish.write(a, ctx);
    publish.write(b, ctx);
    const stopError = fakeStopError();
    const fx = createFakeEffects();
    const errors: string[] = [];
    const errorOfA = vi.spyOn(a.subscriber, 'error').mockImplementation(() => errors.push('a'));
    vi.spyOn(b.subscriber, 'error').mockImplementation(() => errors.push('b'));
    publish.clientClosed(stopError, fx);
    expect([...publish.pendingIds()]).toEqual([]);
    expect(stopError.calls).toEqual([
      { requestId: 7, topic: 'a' },
      { requestId: 8, topic: 'b' },
    ]);
    fx.runDeliveries();
    expect(errors).toEqual(['a', 'b']);
    expect(errorOfA.mock.calls).toMatchObject([[{ code: 'connection_closed', topic: 'a', requestId: 7 }]]);
    expect(publish.inbound(inbound.published(1, 1), ctx)).toBe(false);
  });
});

describe('options are never mutated', () => {
  test('the PUBLISH carries the frozen snapshot; the app object stays untouched (spec-typed arrays copied)', () => {
    const publish = new PublishParticipant();
    const ctx = createFakeCtx();
    const exclude = [1, 2];
    const appOptions = { acknowledge: true, exclude, retain: false, x_router: 'yes', gone: undefined };
    const snap = snapshotPublish('t', ['v'], undefined, appOptions);
    publish.write(publishOf(snap, new FakeSubscriber<void>()), ctx);
    const [frame] = ctx.frames(MessageType.PUBLISH);
    expect(frame![2]).toBe(snap.options);
    expect(Object.isFrozen(frame![2])).toBe(true);
    expect(frame![2]).toEqual({ acknowledge: true, exclude: [1, 2], retain: false, x_router: 'yes' });
    exclude.push(3); // mutating the app's array after subscribe cannot change what was validated and sent
    expect(frame![2]).toEqual({ acknowledge: true, exclude: [1, 2], retain: false, x_router: 'yes' });
    expect(appOptions).toEqual({
      acknowledge: true,
      exclude: [1, 2, 3],
      retain: false,
      x_router: 'yes',
      gone: undefined,
    });
  });
});

// =====================================================================================================================
// Model-based property
// =====================================================================================================================

type Command =
  | { kind: 'start'; ack: boolean; bigint: boolean }
  | { kind: 'refuse'; on: boolean }
  | { kind: 'drain' }
  | { kind: 'published'; live: boolean; target: number }
  | { kind: 'error'; live: boolean; target: number; invalid: boolean }
  | { kind: 'unsubscribe'; target: number }
  | { kind: 'end'; willRetry: boolean }
  | { kind: 'close' }
  | { kind: 'deliver' };

/** Answers mostly go to a publication in flight, otherwise to any (late, duplicate or never-acknowledged ones). */
const liveArb = fc.constantFrom(true, true, false);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('start' as const), ack: fc.boolean(), bigint: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('refuse' as const), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('drain' as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('published' as const), live: liveArb, target: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('error' as const),
      live: liveArb,
      target: fc.nat(),
      invalid: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('unsubscribe' as const), target: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('end' as const), willRetry: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('close' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('deliver' as const) }) },
);

type Expected = { kind: 'next' } | { kind: 'error'; code: unknown } | { kind: 'complete' };

/** Request ids from a pool of six (then unique ones), so finished ids are drawn again at once and the redraw loop
 *  runs. */
const DEGENERATE_IDS: readonly number[] = Array.from({ length: 5000 }, (_, i) => (i < 4000 ? (i % 6) + 1 : i));
type IdMode = 'sequential' | 'random' | 'degenerate';

function runModel(ids: IdMode, commands: readonly Command[]): void {
  const queue: { tag: number; fn: () => void }[] = [];
  let tags = 0;
  let running = 0;
  class Ctx extends FakeSessionCtx {
    override deliver(fn: () => void): void {
      queue.push({ tag: ++tags, fn });
    }
  }
  class Fx extends FakeEffects {
    override deliver(fn: () => void): void {
      queue.push({ tag: ++tags, fn });
    }
  }
  const participant = new PublishParticipant();

  class Recorder implements OpSubscriber<void> {
    readonly raw: { kind: string; tag: number }[] = [];
    readonly effective: Expected[] = [];
    stopTag = Infinity;
    unsubscribed = false;
    private isClosed = false;
    constructor(private readonly teardown: () => void) {}
    get closed(): boolean {
      return this.isClosed;
    }
    next(): void {
      this.raw.push({ kind: 'next', tag: running });
      if (!this.isClosed) this.effective.push({ kind: 'next' });
    }
    error(error: unknown): void {
      this.raw.push({ kind: 'error', tag: running });
      if (this.isClosed) return;
      this.isClosed = true;
      this.effective.push({ kind: 'error', code: (error as { code?: unknown }).code ?? 'TypeError' });
      this.teardown();
    }
    complete(): void {
      this.raw.push({ kind: 'complete', tag: running });
      if (this.isClosed) return;
      this.isClosed = true;
      this.effective.push({ kind: 'complete' });
      this.teardown();
    }
    unsubscribe(): void {
      this.isClosed = true;
      this.unsubscribed = true;
      this.stopTag = tags;
    }
  }
  interface M {
    readonly op: PublishOp & { readonly subscriber: Recorder };
    readonly bigint: boolean;
    status: 'queued' | 'inflight' | 'done';
    id?: number;
    closed: boolean;
    readonly expected: Expected[];
  }

  let connId = 1;
  const newCtx = (): Ctx =>
    new Ctx({ connId, ids: ids === 'degenerate' ? DEGENERATE_IDS : ids, inFlight: () => participant.pendingIds() });
  let ctx = newCtx();
  let expectedFrames: OutboundFrame[] = [];
  const ended: { ctx: Ctx; writes: number }[] = [];
  const models: M[] = [];
  const fifo: M[] = [];
  const inflight = new Map<number, M>();
  const pending: { m: M; n: Expected }[] = [];
  let counter = 0;
  const enqueue = (m: M, ...ns: Expected[]): void => {
    for (const n of ns) pending.push({ m, n });
  };

  const write = (m: M): 'done' | 'not-sent' => {
    const outcome = participant.write(m.op, ctx);
    if (m.bigint) {
      expect(outcome).toBe('done');
      m.status = 'done';
      enqueue(m, { kind: 'error', code: 'TypeError' });
      return outcome;
    }
    if (ctx.refuseWrites) {
      expect(outcome).toBe('not-sent');
      return outcome;
    }
    expect(outcome).toBe('done');
    const written = ctx.written[ctx.written.length - 1]!;
    const { snap } = m.op;
    expect(written.expectsReply).toBe(snap.ack);
    expectedFrames.push([16, written.requestId!, snap.options, snap.topic, ...outboundPayload(snap.args, snap.kwargs)]);
    if (snap.ack) {
      expect(inflight.has(written.requestId!)).toBe(false);
      Object.assign(m, { status: 'inflight', id: written.requestId });
      inflight.set(written.requestId!, m);
    } else {
      m.status = 'done';
      enqueue(m, { kind: 'next' }, { kind: 'complete' });
    }
    return outcome;
  };
  const flush = (): void => {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      running = d.tag;
      d.fn();
      running = 0;
    }
    for (const { m, n } of pending.splice(0)) {
      if (m.closed) continue;
      m.expected.push(n);
      if (n.kind !== 'next') m.closed = true;
    }
  };
  const stopAll = (error: ConnectionClosedError, fx: Fx): void => {
    participant.clientClosed(() => error, fx);
    for (const m of inflight.values()) {
      m.status = 'done';
      enqueue(m, { kind: 'error', code: error.code });
    }
    for (const m of fifo.splice(0)) {
      m.status = 'done';
      fx.deliver(() => {
        m.op.subscriber.error(error);
      });
      enqueue(m, { kind: 'error', code: error.code });
    }
  };
  const newSession = (): void => {
    ended.push({ ctx, writes: ctx.written.length + ctx.refused.length + ctx.failed.length });
    inflight.clear();
    connId++;
    ctx = newCtx();
    expectedFrames = [];
  };
  const target = (index: number, live = false): M | undefined => {
    const pool = live && inflight.size > 0 ? [...inflight.values()] : models;
    return pool[index % Math.max(1, pool.length)];
  };
  const check = (): void => {
    expect(new Set(participant.pendingIds())).toEqual(new Set(inflight.keys()));
    expect(ctx.written.map((w) => w.frame)).toEqual(expectedFrames);
    for (const old of ended)
      expect(old.ctx.written.length + old.ctx.refused.length + old.ctx.failed.length).toBe(old.writes);
    for (const m of models) {
      const { raw, stopTag } = m.op.subscriber;
      const terminal = raw.findIndex((r) => r.kind !== 'next');
      expect(raw.filter((r) => r.kind !== 'next')).toHaveLength(terminal < 0 ? 0 : 1);
      if (terminal >= 0) expect(raw.slice(terminal + 1)).toEqual([]);
      expect(raw.filter((r) => r.tag > stopTag)).toEqual([]);
    }
  };

  for (const command of commands) {
    switch (command.kind) {
      case 'start': {
        const snap = snapshotPublish('t', [command.bigint ? 10n : ++counter], undefined, command.ack ? ACK : {});
        const m: M = {
          op: undefined as never,
          bigint: command.bigint,
          status: 'queued',
          closed: false,
          expected: [],
        };
        // the facade's teardown submits op.stop at every end: it must never touch another publication
        Object.assign(m, {
          op: publishOf(
            snap,
            new Recorder(() => {
              participant.stop(m.op);
            }),
          ),
        });
        models.push(m);
        if (fifo.length > 0 || write(m) === 'not-sent') fifo.push(m);
        break;
      }
      case 'refuse':
        ctx.refuseWrites = command.on;
        break;
      case 'drain':
        while (fifo.length > 0 && write(fifo[0]!) === 'done') fifo.shift();
        break;
      case 'published': {
        const id = target(command.target, command.live)?.id ?? 2 ** 53;
        const owner = inflight.get(id);
        expect(participant.inbound(inbound.published(id, ++counter), ctx)).toBe(owner !== undefined);
        if (owner === undefined) break;
        inflight.delete(id);
        owner.status = 'done';
        enqueue(owner, { kind: 'next' }, { kind: 'complete' });
        break;
      }
      case 'error': {
        const id = target(command.target, command.live)?.id ?? 2 ** 53;
        const owner = inflight.get(id);
        const msg = inbound.error(16, id, Uri.NOT_AUTHORIZED);
        expect(participant.inbound(command.invalid ? inbound.invalid(msg) : msg, ctx)).toBe(owner !== undefined);
        if (owner === undefined) break;
        inflight.delete(id);
        owner.status = 'done';
        enqueue(owner, { kind: 'error', code: command.invalid ? 'protocol' : 'wamp_error' });
        break;
      }
      case 'unsubscribe': {
        const m = target(command.target);
        if (m === undefined || m.op.subscriber.closed) break;
        m.op.subscriber.unsubscribe();
        m.closed = true;
        if (m.status === 'queued') {
          fifo.splice(fifo.indexOf(m), 1);
        } else {
          participant.stop(m.op); // settled ones included: their id may belong to a newer publication by now
          if (m.status === 'inflight') inflight.delete(m.id!);
        }
        m.status = 'done';
        break;
      }
      case 'end': {
        ctx.endSession();
        const fx = new Fx();
        const end = fakeEndInfo({ willRetry: command.willRetry });
        const order = [...inflight.values()];
        participant.sessionEnded(end, fx);
        expect(end.calls).toEqual(order.map((m) => ({ requestId: m.id, topic: 't' })));
        for (const m of order) {
          m.status = 'done';
          enqueue(m, { kind: 'error', code: command.willRetry ? 'connection_lost' : 'connection_closed' });
        }
        inflight.clear();
        if (!command.willRetry) stopAll(new ConnectionClosedError({ gaveUp: true }), fx);
        newSession();
        break;
      }
      case 'close':
        ctx.endSession();
        stopAll(new ConnectionClosedError({}), new Fx());
        newSession();
        break;
      case 'deliver':
        flush();
        for (const m of models) expect(m.op.subscriber.effective).toEqual(m.expected);
        break;
    }
    check();
  }

  ctx.endSession();
  stopAll(new ConnectionClosedError({}), new Fx());
  newSession();
  flush();
  check();
  for (const m of models) {
    expect(m.op.subscriber.effective).toEqual(m.expected);
    const terminals = m.op.subscriber.effective.filter((n) => n.kind !== 'next').length;
    expect(terminals).toBe(m.op.subscriber.unsubscribed && terminals === 0 ? 0 : 1); // never hangs
  }
  expect([...participant.pendingIds()]).toEqual([]);
}

/** The model runs take a few ms each, so a deeper `FC_NUM_RUNS=20000` run needs far more than vitest's default 5 s
 *  (per-file timeouts scale with FC_NUM_RUNS; fast-check's own time limit still applies). */
const PROPERTY_TIMEOUT = Math.max(5000, (fc.readConfigureGlobal().numRuns ?? 100) * 20);

describe('property: random interleavings of writes, answers, unsubscribes, deliveries, session ends and close()', () => {
  test(
    'no double settle, no frame after settle or into an ended session, no leak, every op settles',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom<IdMode>('sequential', 'random', 'degenerate'),
          fc.array(commandArb, { maxLength: 60, size: 'max' }),
          runModel,
        ),
        { ...replayParameters() },
      );
    },
    PROPERTY_TIMEOUT,
  );

  test('a fixed interleaving: ack and fire-and-forget, refusal, drain, unsubscribe in flight, give-up', () => {
    runModel('sequential', [
      { kind: 'start', ack: true, bigint: false },
      { kind: 'start', ack: false, bigint: false },
      { kind: 'refuse', on: true },
      { kind: 'start', ack: true, bigint: false },
      { kind: 'start', ack: false, bigint: true },
      { kind: 'published', live: true, target: 0 },
      { kind: 'unsubscribe', target: 1 },
      { kind: 'deliver' },
      { kind: 'end', willRetry: true },
      { kind: 'drain' },
      { kind: 'unsubscribe', target: 2 },
      { kind: 'error', live: false, target: 2, invalid: false },
      { kind: 'end', willRetry: false },
      { kind: 'deliver' },
    ]);
  });
});
