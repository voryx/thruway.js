// Worked example for participant unit tests: two deliberately small participants, written against the contracts alone
// (`OneShotParticipant<CallOp>`, `InterestParticipant<TopicOp>`), driven through test/helpers/fake-ctx.ts the way a
// participant unit test does — write outcomes, request ids, deliveries after the step, CANCEL, request timers and
// liveness verdicts, session ends and re-establishment on the next session. The participants here are not the real
// ones (src/ops/*); they only prove that the fake can drive a participant through every contract method.
import { describe, expect, test } from 'vitest';
import type {
  CallOp,
  Effects,
  EndInfo,
  InterestParticipant,
  OneShotParticipant,
  SessionCtx,
  StopError,
  TimerHandle,
  TopicOp,
} from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import {
  callFrame,
  cancelFrame,
  subscribeFrame,
  unsubscribeFrame,
  type InboundMessage,
  type OutboundPayload,
} from '../../src/protocol/messages.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeCallOp,
  fakeEndInfo,
  fakeStopError,
  fakeTopicOp,
  inbound,
  wampError,
} from './fake-ctx.js';

function payload(args: readonly unknown[] | undefined, kwargs: Readonly<Record<string, unknown>> | undefined) {
  const out: OutboundPayload =
    kwargs !== undefined && Object.keys(kwargs).length > 0
      ? [args ?? [], kwargs]
      : args !== undefined && args.length > 0
        ? [args]
        : [];
  return out;
}

/** A minimal call participant: CALL, RESULT/ERROR, CANCEL on stop, Lost/Closed at session end. */
class MiniCall implements OneShotParticipant<CallOp> {
  readonly name = 'call' as const;
  private readonly byId = new Map<number, CallOp>();
  private readonly ids = new Map<CallOp, number>();

  write(op: CallOp, ctx: SessionCtx): 'done' | 'not-sent' {
    let id: number | undefined;
    try {
      id = ctx.request((requestId) =>
        callFrame(requestId, op.snap.options, op.snap.procedure, payload(op.snap.args, op.snap.kwargs)),
      );
    } catch (error) {
      ctx.deliver(() => {
        op.subscriber.error(error);
      });
      return 'done';
    }
    if (id === undefined) return 'not-sent';
    this.byId.set(id, op);
    this.ids.set(op, id);
    return 'done';
  }

  stop(op: CallOp, ctx: SessionCtx | undefined): void {
    const id = this.ids.get(op);
    if (id === undefined) return;
    this.forget(id, op);
    ctx?.send(cancelFrame(id));
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    if (msg.type === MessageType.RESULT) {
      const op = this.byId.get(msg.requestId);
      if (op === undefined) return false;
      this.forget(msg.requestId, op);
      const result = Object.freeze({ args: msg.args as unknown[], kwargs: msg.kwargs, details: msg.details });
      ctx.deliver(() => {
        op.subscriber.next(result);
        op.subscriber.complete();
      });
      return true;
    }
    if (msg.type === MessageType.ERROR && (msg.requestType === 48 || msg.requestType === 49)) {
      const op = this.byId.get(msg.requestId);
      if (op === undefined) return false;
      this.forget(msg.requestId, op);
      const error = wampError(msg.error, msg.args, msg.kwargs, msg.details);
      ctx.deliver(() => {
        op.subscriber.error(error);
      });
      return true;
    }
    return false;
  }

  timer(): void {
    // calls arm no timers (call timeouts are the app's Rx timeout())
  }

  sessionEnded(end: EndInfo, fx: Effects): void {
    for (const [id, op] of [...this.byId]) {
      this.forget(id, op);
      const error = end.inflightError({ requestId: id, procedure: op.snap.procedure });
      fx.deliver(() => {
        op.subscriber.error(error);
      });
    }
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    for (const [id, op] of [...this.byId]) {
      this.forget(id, op);
      const error = stopError({ requestId: id, procedure: op.snap.procedure });
      fx.deliver(() => {
        op.subscriber.error(error);
      });
    }
  }

  pendingIds(): Iterable<number> {
    return this.byId.keys();
  }

  private forget(id: number, op: CallOp): void {
    this.byId.delete(id);
    this.ids.delete(op);
  }
}

/** A minimal topic participant: dormant without a session, SUBSCRIBE on start/welcome, request timer + verdict. */
class MiniTopic implements InterestParticipant<TopicOp> {
  readonly name = 'topic' as const;
  private readonly dormant = new Set<TopicOp>();
  private readonly pending = new Map<number, { readonly op: TopicOp; readonly since: number; timer: TimerHandle }>();
  private readonly active = new Map<number, TopicOp>();

  constructor(private readonly requestTimeout: number) {}

  start(op: TopicOp, ctx: SessionCtx | undefined): void {
    if (ctx === undefined) this.dormant.add(op);
    else this.subscribe(op, ctx);
  }

  stop(op: TopicOp, ctx: SessionCtx | undefined): void {
    this.dormant.delete(op);
    for (const [subscriptionId, other] of this.active) {
      if (other !== op) continue;
      this.active.delete(subscriptionId);
      ctx?.request((requestId) => unsubscribeFrame(requestId, subscriptionId));
    }
  }

  welcome(ctx: SessionCtx): void {
    const ops = [...this.dormant].sort((a, b) => a.seq - b.seq);
    this.dormant.clear();
    for (const op of ops) this.subscribe(op, ctx);
  }

  inbound(msg: InboundMessage, ctx: SessionCtx): boolean {
    if (msg.type === MessageType.SUBSCRIBED) {
      const entry = this.pending.get(msg.requestId);
      if (entry === undefined) return false;
      this.pending.delete(msg.requestId);
      entry.timer.cancel();
      this.active.set(msg.subscriptionId, entry.op);
      return true;
    }
    if (msg.type === MessageType.EVENT) {
      const op = this.active.get(msg.subscriptionId);
      if (op === undefined) return false;
      const event = Object.freeze({ args: msg.args as unknown[], kwargs: msg.kwargs, details: msg.details });
      ctx.deliver(() => {
        op.subscriber.next(event);
      });
      return true;
    }
    return false;
  }

  timer(key: number, ctx: SessionCtx): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    ctx.verifyAlive(entry.since, () => {
      if (this.pending.get(key) !== entry) return;
      this.pending.delete(key);
      const error = wampError(Uri.TIMEOUT, [this.requestTimeout]);
      ctx.deliver(() => {
        entry.op.subscriber.error(error);
      });
    });
  }

  sessionEnded(): void {
    for (const { op } of this.pending.values()) if (!op.subscriber.closed) this.dormant.add(op);
    for (const op of this.active.values()) if (!op.subscriber.closed) this.dormant.add(op);
    this.pending.clear();
    this.active.clear();
  }

  clientClosed(stopError: StopError, fx: Effects): void {
    const all = new Set([...this.dormant, ...[...this.pending.values()].map((e) => e.op), ...this.active.values()]);
    this.dormant.clear();
    this.pending.clear();
    this.active.clear();
    for (const op of all) {
      const error = stopError({ topic: op.snap.topic });
      fx.deliver(() => {
        op.subscriber.error(error);
      });
    }
  }

  pendingIds(): Iterable<number> {
    return this.pending.keys();
  }

  private subscribe(op: TopicOp, ctx: SessionCtx): void {
    const id = ctx.request((requestId) => subscribeFrame(requestId, op.snap.options, op.snap.topic));
    if (id === undefined) {
      this.dormant.add(op);
      return;
    }
    this.pending.set(id, { op, since: ctx.now, timer: ctx.timer(this.requestTimeout, 'topic', id, true) });
  }
}

describe('a one-shot participant driven through fake-ctx', () => {
  test('CALL is written with an allocated id; the RESULT is delivered after the step', () => {
    const ctx = createFakeCtx();
    const call: OneShotParticipant<CallOp> = new MiniCall();
    const op = fakeCallOp({ procedure: 'com.example.add', args: [1, 2] });
    expect(call.write(op, ctx)).toBe('done');
    expect(ctx.frames(MessageType.CALL)).toEqual([[48, 1, {}, 'com.example.add', [1, 2]]]);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(call.inbound(inbound.result(1, [3]), ctx)).toBe(true);
    expect(op.subscriber.notifications).toEqual([]); // nothing runs inside the step
    expect(ctx.runDeliveries()).toBe(1);
    expect(op.subscriber.values).toEqual([{ args: [3], kwargs: {}, details: {} }]);
    expect(op.subscriber.completed).toBe(true);
    expect(call.inbound(inbound.result(1, [3]), ctx)).toBe(false); // late duplicate: dropped by the core
  });

  test("a refused write is 'not-sent' and releases the id; a serializer error fails only that op", () => {
    const ctx = createFakeCtx();
    const call: OneShotParticipant<CallOp> = new MiniCall();
    ctx.refuseWrites = true;
    const queued = fakeCallOp({ procedure: 'p' });
    expect(call.write(queued, ctx)).toBe('not-sent');
    expect([...call.pendingIds()]).toEqual([]);
    ctx.refuseWrites = false;
    const bad = fakeCallOp({ procedure: 'p', args: [10n] });
    expect(call.write(bad, ctx)).toBe('done');
    ctx.runDeliveries();
    expect(bad.subscriber.errors).toEqual([expect.any(TypeError)]);
    expect(call.write(queued, ctx)).toBe('done');
    expect(ctx.written.map((w) => w.requestId)).toEqual([1]); // ids 1 and 1 released, then 1 again
  });

  test('unsubscribe sends CANCEL killnowait for the in-flight id; the late answer is unknown', () => {
    const ctx = createFakeCtx({ ids: [41] });
    const call: OneShotParticipant<CallOp> = new MiniCall();
    const op = fakeCallOp({ procedure: 'slow' });
    call.write(op, ctx);
    op.subscriber.unsubscribe();
    call.stop(op, ctx, ctx);
    expect(ctx.lastFrame()).toEqual([MessageType.CANCEL, 41, { mode: 'killnowait' }]);
    expect(call.inbound(inbound.error(49, 41, Uri.CANCELED), ctx)).toBe(false);
  });

  test('a finished request id can be drawn again when the ctx asks the participant what is in flight', () => {
    const call: OneShotParticipant<CallOp> = new MiniCall();
    const ctx = createFakeCtx({ ids: [7, 7, 8], inFlight: () => call.pendingIds() });
    const first = fakeCallOp({ procedure: 'a' });
    const second = fakeCallOp({ procedure: 'b' });
    const third = fakeCallOp({ procedure: 'c' });
    call.write(first, ctx);
    call.inbound(inbound.result(7), ctx);
    call.write(second, ctx); // 7 is free again
    call.write(third, ctx); // 7 is in flight: skipped
    expect(ctx.written.map((w) => w.requestId)).toEqual([7, 7, 8]);
  });

  test('session end: ConnectionLostError while retrying, ConnectionClosedError{gaveUp, cause: Lost} on give-up', () => {
    for (const willRetry of [true, false]) {
      const ctx = createFakeCtx();
      const fx = createFakeEffects();
      const call: OneShotParticipant<CallOp> = new MiniCall();
      const op = fakeCallOp({ procedure: 'p' });
      call.write(op, ctx);
      ctx.endSession();
      const end = fakeEndInfo({ willRetry });
      call.sessionEnded(end, fx);
      expect([...call.pendingIds()]).toEqual([]);
      fx.runDeliveries();
      expect(end.calls).toEqual([{ requestId: 1, procedure: 'p' }]);
      expect(op.subscriber.errors[0]).toMatchObject(
        willRetry ? { code: 'connection_lost', requestId: 1 } : { code: 'connection_closed', gaveUp: true },
      );
    }
  });
});

describe('an interest participant driven through fake-ctx', () => {
  test('dormant without a session; SUBSCRIBE at welcome in seq order; EVENTs delivered', () => {
    const topic: InterestParticipant<TopicOp> = new MiniTopic(60000);
    const fx = createFakeEffects();
    const b = fakeTopicOp({ topic: 'b' });
    const a = fakeTopicOp({ topic: 'a' }, b.seq - 1);
    topic.start(b, undefined, fx);
    topic.start(a, undefined, fx);
    const ctx = createFakeCtx();
    ctx.bindTimers('topic', topic);
    topic.welcome(ctx);
    expect(ctx.frames(MessageType.SUBSCRIBE)).toEqual([
      [32, 1, {}, 'a'],
      [32, 2, {}, 'b'],
    ]);
    expect(topic.inbound(inbound.subscribed(1, 900), ctx)).toBe(true);
    expect(ctx.armedTimers('topic').map((t) => t.key)).toEqual([2]); // a's request timer was cancelled
    expect(topic.inbound(inbound.event(900, 1, ['hi']), ctx)).toBe(true);
    ctx.runDeliveries();
    expect(a.subscriber.values).toEqual([{ args: ['hi'], kwargs: {}, details: {} }]);
    topic.stop(a, ctx, ctx);
    expect(ctx.lastFrame()).toEqual(unsubscribeFrame(3, 900));
  });

  test('an unanswered SUBSCRIBE asks liveness first: alive ⇒ the interest errors, dead ⇒ nothing', () => {
    for (const verdict of ['alive', 'dead'] as const) {
      const topic: InterestParticipant<TopicOp> = new MiniTopic(60000);
      const ctx = createFakeCtx({ now: 1000 });
      ctx.bindTimers('topic', topic);
      const op = fakeTopicOp({ topic: 't' });
      topic.start(op, ctx, ctx);
      expect(ctx.advance(60000)).toBe(1);
      expect(ctx.verdicts.map((v) => v.since)).toEqual([1000]);
      ctx.resolveVerdicts(verdict);
      ctx.runDeliveries();
      expect(op.subscriber.errors).toHaveLength(verdict === 'alive' ? 1 : 0);
    }
  });

  test('a session end turns interests dormant; the next session (new ctx) re-establishes them, never the old one', () => {
    const topic: InterestParticipant<TopicOp> = new MiniTopic(60000);
    const fx = createFakeEffects();
    const first = createFakeCtx({ connId: 1 });
    first.bindTimers('topic', topic);
    const op = fakeTopicOp({ topic: 't' });
    topic.start(op, first, fx);
    topic.inbound(inbound.subscribed(1, 5), first);
    first.endSession();
    topic.sessionEnded(fakeEndInfo(), fx);
    expect(op.subscriber.notifications).toEqual([]); // dormant, nothing emitted (the stream outlives the session)
    const second = createFakeCtx({ connId: 2, session: { id: 2 } });
    second.bindTimers('topic', topic);
    topic.welcome(second);
    expect(second.frames(MessageType.SUBSCRIBE)).toEqual([[32, 1, {}, 't']]);
    expect(first.frames(MessageType.SUBSCRIBE)).toHaveLength(1);
    expect(first.advance(120000)).toBe(0); // the first session's timers were cleared
    topic.clientClosed(fakeStopError(), fx);
    fx.runDeliveries();
    expect(op.subscriber.errors).toMatchObject([{ code: 'connection_closed', topic: 't' }]);
  });
});
