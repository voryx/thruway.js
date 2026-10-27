// Call participant, driven through fake-ctx: the CALL write and its three outcomes (written; not sent ⇒ stays queued;
// serializer or size error ⇒ only that op fails), RESULT and ERROR delivery after the step, payload-invalid answers,
// session end (ConnectionLostError after the core notified, ConnectionClosedError{gaveUp, cause} on give-up), close(),
// one connection per record, options never mutated, no client-side timers, and a model-based property over random
// interleavings of writes, inbound frames, unsubscribes, deliveries, session ends and close(): no double settle, no
// frame after settle, no leak, no hang.
// Cancellation is in call-cancel.test.ts, progressive results in call-progressive.test.ts.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { CallOp, CallSnapshot, OpSubscriber } from '../../src/core/contracts.js';
import { ConnectionClosedError, isThruwayError, isWampError, WampError } from '../../src/errors.js';
import { CallParticipant } from '../../src/ops/call.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { MAX_FRAME_BYTES, type OutboundFrame } from '../../src/protocol/messages.js';
import { outboundPayload } from '../../src/protocol/payload.js';
import type { ResultMessage } from '../../src/types.js';
import { snapshotCall } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  FakeEffects,
  fakeCallOp,
  fakeEndInfo,
  fakeStopError,
  FakeSessionCtx,
  FakeSubscriber,
  inbound,
  nextSeq,
  type FakeCtxOptions,
} from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

/** An op record built from a real validated snapshot (what the facade hands to the core). */
function callOf<S extends OpSubscriber<ResultMessage>>(snap: CallSnapshot, subscriber: S): CallOp & { subscriber: S } {
  return Object.freeze({ kind: 'call' as const, seq: nextSeq(), snap, subscriber });
}

/** A subscriber that appends its name to `order` when it is errored (delivery order across ops). */
class Named extends FakeSubscriber<ResultMessage> {
  constructor(
    private readonly label: string,
    private readonly order: string[],
  ) {
    super();
  }
  override error(error: unknown): void {
    this.order.push(this.label);
    super.error(error);
  }
}

describe('write', () => {
  test('the CALL gets its request id at write time; the call is then in flight, nothing is delivered', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [77] });
    const op = fakeCallOp({ procedure: 'com.example.add', args: [1, 2] });
    expect(call.write(op, ctx)).toBe('done');
    expect(ctx.written).toMatchObject([
      { via: 'request', requestId: 77, expectsReply: true, frame: [48, 77, {}, 'com.example.add', [1, 2]] },
    ]);
    expect([...call.pendingIds()]).toEqual([77]);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(op.subscriber.notifications).toEqual([]);
  });

  test.each([
    ['no payload', undefined, undefined, [48, 1, {}, 'p']],
    ['empty args and kwargs (omitted)', [], {}, [48, 1, {}, 'p']],
    ['args only', [1, 'a', null], undefined, [48, 1, {}, 'p', [1, 'a', null]]],
    ['args and empty kwargs', [1], {}, [48, 1, {}, 'p', [1]]],
    ['kwargs only (args [] first)', undefined, { a: 1 }, [48, 1, {}, 'p', [], { a: 1 }]],
    ['args and kwargs', [1], { a: 1 }, [48, 1, {}, 'p', [1], { a: 1 }]],
  ] as const)('payload: %s', (_name, args, kwargs, frame) => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    call.write(fakeCallOp({ procedure: 'p', args, kwargs }), ctx);
    expect(ctx.frames()).toEqual([frame]);
  });

  test("a refused write is 'not-sent': nothing held or delivered, the id released; the next session writes it once", () => {
    const call = new CallParticipant();
    const ending = createFakeCtx({ connId: 1 });
    ending.refuseWrites = true;
    const op = fakeCallOp({ procedure: 'p', args: [1] });
    expect(call.write(op, ending)).toBe('not-sent');
    expect(ending.written).toEqual([]);
    expect(ending.refused).toMatchObject([{ releasedId: 1, reason: 'refused' }]);
    expect(ending.allocatedIds.size).toBe(0);
    expect([...call.pendingIds()]).toEqual([]);
    expect(ending.pendingDeliveries).toEqual([]);
    // the adapter reported the loss; the core ends the session: the queued op was never in flight
    ending.endSession();
    const fx = createFakeEffects();
    call.sessionEnded(fakeEndInfo(), fx);
    expect(fx.pendingDeliveries).toEqual([]);
    const next = createFakeCtx({ connId: 2, session: { id: 2 } });
    expect(call.write(op, next)).toBe('done');
    expect(next.frames()).toEqual([[48, 1, {}, 'p', [1]]]);
    expect(call.inbound(inbound.result(1, ['ok']), next)).toBe(true);
    next.runDeliveries();
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args: ['ok'], kwargs: {}, details: {} } },
      { kind: 'complete' },
    ]);
    expect(ending.written).toEqual([]);
  });

  test("a closed gate (the session is ending) is 'not-sent' as well", () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    ctx.closeGate();
    expect(call.write(fakeCallOp({ procedure: 'p' }), ctx)).toBe('not-sent');
    expect(ctx.refused).toMatchObject([{ reason: 'gate-closed', releasedId: 1 }]);
    expect([...call.pendingIds()]).toEqual([]);
  });

  test('a serializer error fails only this op, after the step: nothing written, the id released, the session goes on', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const bad = fakeCallOp({ procedure: 'p', args: [10n] });
    expect(call.write(bad, ctx)).toBe('done');
    expect(ctx.written).toEqual([]);
    expect(ctx.failed).toMatchObject([{ releasedId: 1 }]);
    expect(bad.subscriber.notifications).toEqual([]); // never synchronously: a step never runs app code
    expect(ctx.runDeliveries()).toBe(1);
    const [error] = bad.subscriber.errors;
    expect(error).toBeInstanceOf(TypeError); // JSON's own error, unchanged
    expect(isThruwayError(error)).toBe(false);
    expect([...call.pendingIds()]).toEqual([]);
    const good = fakeCallOp({ procedure: 'p' });
    expect(call.write(good, ctx)).toBe('done');
    expect(ctx.written.map((w) => w.requestId)).toEqual([1]); // the released id is free again
  });

  test("a throwing toJSON in the args fails the op with that error; a custom serializer's error is passed through unchanged", () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const boom = new Error('toJSON exploded');
    const a = fakeCallOp({
      procedure: 'p',
      args: [
        {
          toJSON() {
            throw boom;
          },
        },
      ],
    });
    const thrown = new RangeError('msgpack: nesting too deep');
    const b = fakeCallOp({ procedure: 'p', args: [1] });
    call.write(a, ctx);
    ctx.failNextWrite(thrown);
    call.write(b, ctx);
    ctx.runDeliveries();
    expect(a.subscriber.errors).toEqual([boom]);
    expect(b.subscriber.errors[0]).toBe(thrown);
    expect(thrown).not.toHaveProperty('procedure');
    expect(ctx.written).toEqual([]);
  });

  test('a frame over 16 MiB errors the op with WampError payload_size_exceeded [bytes, limit] and its context', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ session: { id: 42 } });
    const big = 'x'.repeat(MAX_FRAME_BYTES);
    const op = fakeCallOp({ procedure: 'com.example.upload', args: [big] });
    expect(call.write(op, ctx)).toBe('done');
    ctx.runDeliveries();
    const [error] = op.subscriber.errors;
    const bytes = JSON.stringify([48, 1, {}, 'com.example.upload', [big]]).length;
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({
      uri: Uri.PAYLOAD_SIZE_EXCEEDED,
      message: Uri.PAYLOAD_SIZE_EXCEEDED,
      args: [bytes, MAX_FRAME_BYTES],
      procedure: 'com.example.upload',
      sessionId: 42,
    });
    expect(error).not.toHaveProperty('requestId'); // no id was consumed
    expect(ctx.written).toEqual([]);
    // the connection is untouched: the next call goes out with the same id
    call.write(fakeCallOp({ procedure: 'com.example.small' }), ctx);
    expect(ctx.frames()).toEqual([[48, 1, {}, 'com.example.small']]);
  });

  test('a WampError that refuses the context (frozen, or a Proxy whose set throws) fails only this op: write never throws', () => {
    // A custom serializer may throw a shared, frozen WampError (its own size limit). Decorating it must not throw out
    // of write(): the core would treat that as a client bug and hardReset, failing every other op.
    const call = new CallParticipant();
    const ctx = createFakeCtx({ session: { id: 4 } });
    const frozen = Object.freeze(new WampError(Uri.PAYLOAD_SIZE_EXCEEDED, [1, 2]));
    const hostile = new Proxy(new WampError(Uri.RUNTIME_ERROR), {
      set() {
        throw new Error('read-only');
      },
    });
    const a = fakeCallOp({ procedure: 'a' });
    const b = fakeCallOp({ procedure: 'b' });
    ctx.failNextWrite(frozen);
    expect(call.write(a, ctx)).toBe('done');
    ctx.failNextWrite(hostile);
    expect(call.write(b, ctx)).toBe('done');
    ctx.runDeliveries();
    expect(a.subscriber.errors[0]).toBe(frozen);
    expect(b.subscriber.errors[0]).toBe(hostile);
    expect(frozen).not.toHaveProperty('procedure');
    const next = fakeCallOp({ procedure: 'c' });
    call.write(next, ctx); // the session goes on
    expect(ctx.frames()).toEqual([[48, 1, {}, 'c']]);
  });

  test('an op whose subscriber already closed is not written (unsubscribed by app code inside a step)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p' });
    op.subscriber.unsubscribe();
    expect(call.write(op, ctx)).toBe('done');
    expect(ctx.written).toEqual([]);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect([...call.pendingIds()]).toEqual([]);
  });
});

describe('RESULT', () => {
  test('the final RESULT is delivered after the step as next(result), complete; frozen, payload not copied', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p' });
    call.write(op, ctx);
    const args = [1, { deep: true }];
    const kwargs = Object.freeze({ k: 'v' });
    const details = Object.freeze({ callee: 7 });
    expect(call.inbound(inbound.result(1, args, kwargs, details), ctx)).toBe(true);
    expect([...call.pendingIds()]).toEqual([]);
    expect(op.subscriber.notifications).toEqual([]);
    expect(ctx.runDeliveries()).toBe(2);
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args, kwargs, details } },
      { kind: 'complete' },
    ]);
    const result = op.subscriber.values[0]!;
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.args).toBe(args);
    expect(result.kwargs).toBe(kwargs);
    expect(result.details).toBe(details);
  });

  test('an empty final RESULT of a plain call is still emitted (args [], kwargs {})', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p' });
    call.write(op, ctx);
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([{ args: [], kwargs: {}, details: {} }]);
    expect(op.subscriber.completed).toBe(true);
  });

  test('next and complete are separate deliveries: a throwing next (logged by the loop) still lets the call complete', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    class Throwing extends FakeSubscriber<ResultMessage> {
      override next(value: ResultMessage): void {
        super.next(value);
        throw new Error('observer bug');
      }
    }
    const op = callOf(snapshotCall('p', [], {}, {}), new Throwing());
    call.write(op, ctx);
    call.inbound(inbound.result(1, [1]), ctx);
    expect(ctx.runDeliveries({ rethrow: false })).toBe(2);
    expect(ctx.deliveryErrors).toMatchObject([{ message: 'observer bug' }]);
    expect(op.subscriber.completed).toBe(true);
  });

  test('a RESULT for an unknown id, and a duplicate of an answered one, are not consumed (the core logs the drop)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p' });
    expect(call.inbound(inbound.result(5), ctx)).toBe(false);
    call.write(op, ctx);
    expect(call.inbound(inbound.result(1, ['a']), ctx)).toBe(true);
    expect(call.inbound(inbound.result(1, ['b']), ctx)).toBe(false); // Crossbar quirk 4: duplicate replies
    ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([{ args: ['a'], kwargs: {}, details: {} }]);
    expect(ctx.logs).toEqual([]);
  });

  test('the call is forgotten before its RESULT is delivered — stop() and close() from the observer change nothing', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const fx = createFakeEffects();
    const reactions: string[] = [];
    class Logout extends FakeSubscriber<ResultMessage> {
      override next(value: ResultMessage): void {
        super.next(value);
        // the app's RESULT handler logs out: unsubscribe (op.stop) and close() (clientClosed), synchronously
        call.stop(op, ctx);
        call.clientClosed(() => new ConnectionClosedError({}), fx);
        reactions.push('logout');
      }
    }
    const subscriber = new Logout();
    const op = callOf(snapshotCall('com.example.logout', undefined, undefined, undefined), subscriber);
    call.write(op, ctx);
    call.inbound(inbound.result(1, [true]), ctx);
    ctx.runDeliveries();
    expect(reactions).toEqual(['logout']);
    expect(subscriber.notifications).toEqual([
      { kind: 'next', value: { args: [true], kwargs: {}, details: {} } },
      { kind: 'complete' },
    ]);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([]);
    expect(fx.pendingDeliveries).toEqual([]);
  });
});

describe('ERROR', () => {
  test.each([48, 49])(
    'ERROR(%i) for an in-flight call ⇒ WampError with uri, args, kwargs, details and the call context',
    (requestType) => {
      const call = new CallParticipant();
      const ctx = createFakeCtx({ ids: [9], session: { id: 5 } });
      const op = fakeCallOp({ procedure: 'com.example.Report' });
      call.write(op, ctx);
      const args = ['com.example.error.not_authorized: [denied]'];
      const kwargs = Object.freeze({ reason: 'x' });
      const details = Object.freeze({ extra: 1 });
      const uri = Uri.RUNTIME_ERROR;
      expect(call.inbound(inbound.error(requestType, 9, uri, args, kwargs, details), ctx)).toBe(true);
      expect([...call.pendingIds()]).toEqual([]);
      expect(op.subscriber.notifications).toEqual([]);
      ctx.runDeliveries();
      const [error] = op.subscriber.errors;
      expect(isWampError(error)).toBe(true);
      expect(error).toMatchObject({
        name: 'WampError',
        code: 'wamp_error',
        uri,
        errorUri: uri,
        message: uri,
        kwargs,
        details,
        procedure: 'com.example.Report', // the app's spelling (Thruway PHP lowercases)
        requestId: 9,
        sessionId: 5,
      });
      expect((error as { args: unknown }).args).toBe(args); // args[0] untouched (PW)
      expect(call.inbound(inbound.error(requestType, 9, uri), ctx)).toBe(false); // late duplicate
    },
  );

  test("the dealer's wamp.error.canceled (callee left mid-call on Thruway PHP) errors the call; nothing is re-sent", () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p', options: { receive_progress: true } });
    call.write(op, ctx);
    call.inbound(inbound.error(48, 1, Uri.CANCELED), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.errors).toMatchObject([{ uri: Uri.CANCELED }]);
    expect(ctx.frames()).toEqual([[48, 1, { receive_progress: true }, 'p']]);
  });

  test('ERRORs of other request types never touch a call (Thruway sends [8,8,…] after killnowait); unknown ids are not consumed', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'p' });
    call.write(op, ctx);
    for (const type of [8, 16, 32, 34, 64, 66, 68, 70])
      expect(call.inbound(inbound.error(type, 1, Uri.NO_SUCH_PROCEDURE), ctx)).toBe(false);
    expect(call.inbound(inbound.error(48, 2, Uri.NO_SUCH_PROCEDURE), ctx)).toBe(false);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(ctx.pendingDeliveries).toEqual([]);
  });

  test('messages a call does not own are not consumed', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    call.write(fakeCallOp({ procedure: 'p' }), ctx);
    for (const msg of [
      inbound.published(1, 2),
      inbound.subscribed(1, 2),
      inbound.registered(1, 2),
      inbound.event(1, 2),
    ])
      expect(call.inbound(msg, ctx)).toBe(false);
    expect([...call.pendingIds()]).toEqual([1]);
  });
});

describe('payload-invalid answers', () => {
  test.each(['RESULT', 'ERROR'] as const)(
    'a payload-invalid %s errors the call with ProtocolError{frame, context}; the session continues',
    (kind) => {
      const call = new CallParticipant();
      const ctx = createFakeCtx({ ids: [3, 4], session: { id: 8 } });
      const op = fakeCallOp({ procedure: 'p' });
      const other = fakeCallOp({ procedure: 'q' });
      call.write(op, ctx);
      call.write(other, ctx);
      const frame = '[50,3,{},{"0":1,"2":3}]';
      const message =
        kind === 'RESULT'
          ? inbound.invalid(inbound.result(3, [1]), 'RESULT args is not an array', frame)
          : inbound.invalid(inbound.error(48, 3, Uri.RUNTIME_ERROR), 'ERROR kwargs is not a dict', frame);
      expect(call.inbound(message, ctx)).toBe(true);
      ctx.runDeliveries();
      const [error] = op.subscriber.errors;
      expect(isThruwayError(error)).toBe(true);
      expect(error).toMatchObject({
        name: 'ProtocolError',
        code: 'protocol',
        message: kind === 'RESULT' ? 'RESULT args is not an array' : 'ERROR kwargs is not a dict',
        frame,
        requestId: 3,
        procedure: 'p',
        sessionId: 8,
      });
      expect(ctx.violations).toEqual([]);
      expect([...call.pendingIds()]).toEqual([4]); // the other call is untouched
    },
  );

  test('a payload-invalid frame for an unknown id is not consumed', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    expect(call.inbound(inbound.invalid(inbound.result(1)), ctx)).toBe(false);
    expect(call.inbound(inbound.invalid(inbound.error(48, 1, 'x')), ctx)).toBe(false);
  });
});

describe('session end', () => {
  test('in-flight calls error ConnectionLostError with their context, after the notification the core queued first', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [3, 4], session: { id: 11 } });
    const order: string[] = [];
    const a = callOf(snapshotCall('a', [], {}, {}), new Named('a', order));
    const b = callOf(snapshotCall('b', [], {}, {}), new Named('b', order));
    call.write(a, ctx);
    call.write(b, ctx);
    ctx.endSession(); // gate: closed
    const fx = createFakeEffects();
    fx.deliver(() => order.push('onClose')); // notify: the app is notified first
    const end = fakeEndInfo({ willRetry: true, info: { sessionId: 11, closeCode: 1006 } });
    call.sessionEnded(end, fx); // fail
    expect([...call.pendingIds()]).toEqual([]);
    expect(order).toEqual([]);
    expect(end.calls).toEqual([
      { requestId: 3, procedure: 'a' },
      { requestId: 4, procedure: 'b' },
    ]);
    fx.runDeliveries();
    expect(order).toEqual(['onClose', 'a', 'b']);
    expect(a.subscriber.errors[0]).toMatchObject({
      name: 'ConnectionLostError',
      code: 'connection_lost',
      requestId: 3,
      procedure: 'a',
      sessionId: 11,
      closeCode: 1006,
    });
    expect(ctx.frames()).toHaveLength(2); // only the CALLs: no CANCEL into the dead session
  });

  test('give-up: in-flight calls error ConnectionClosedError{gaveUp: true, cause: ConnectionLostError} (README recipe 3)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'com.example.write' });
    call.write(op, ctx);
    ctx.endSession();
    const fx = createFakeEffects();
    call.sessionEnded(fakeEndInfo({ willRetry: false }), fx);
    fx.runDeliveries();
    const [error] = op.subscriber.errors;
    expect(error).toMatchObject({ name: 'ConnectionClosedError', code: 'connection_closed', gaveUp: true });
    const { cause } = error as { cause: unknown };
    expect(cause).toMatchObject({ code: 'connection_lost', requestId: 1, procedure: 'com.example.write' });
    // the core's give-up step then calls clientClosed: nothing is left to fail twice
    call.clientClosed(fakeStopError({ gaveUp: true }), fx);
    expect(fx.pendingDeliveries).toEqual([]);
    expect(op.subscriber.errors).toHaveLength(1);
  });

  test('frames of the ended session are unknown afterwards; the next session starts empty and reuses ids freely', () => {
    const call = new CallParticipant();
    const first = createFakeCtx({ connId: 1 });
    const op = fakeCallOp({ procedure: 'p' });
    call.write(op, first);
    first.endSession();
    call.sessionEnded(fakeEndInfo(), createFakeEffects());
    expect(call.inbound(inbound.result(1), first)).toBe(false);
    const second = createFakeCtx({ connId: 2, session: { id: 2 } });
    const next = fakeCallOp({ procedure: 'p' });
    call.write(next, second);
    expect(second.frames()).toEqual([[48, 1, {}, 'p']]); // sequential ids start again at 1
    call.inbound(inbound.result(1, ['second']), second);
    second.runDeliveries();
    expect(next.subscriber.values).toEqual([{ args: ['second'], kwargs: {}, details: {} }]);
  });
});

describe('close() and give-up', () => {
  test('every in-flight call errors its own stop error (procedure, request id), in write order; nothing is written', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [41, 42] });
    const order: string[] = [];
    const a = callOf(snapshotCall('a', [], {}, {}), new Named('a', order));
    const b = callOf(snapshotCall('b', [], {}, {}), new Named('b', order));
    call.write(a, ctx);
    call.write(b, ctx);
    const fx = createFakeEffects();
    const stopError = fakeStopError();
    call.clientClosed(stopError, fx);
    expect([...call.pendingIds()]).toEqual([]);
    expect(stopError.calls).toEqual([
      { requestId: 41, procedure: 'a' },
      { requestId: 42, procedure: 'b' },
    ]);
    fx.runDeliveries();
    expect(order).toEqual(['a', 'b']);
    expect(a.subscriber.errors).toMatchObject([{ code: 'connection_closed', procedure: 'a', requestId: 41 }]);
    expect(b.subscriber.errors).toMatchObject([{ code: 'connection_closed', procedure: 'b', requestId: 42 }]);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([]); // GOODBYE ends them on the router
    expect(call.inbound(inbound.result(1), ctx)).toBe(false);
  });
});

describe('one connection per record', () => {
  test("an answer handed in with another connection's ctx never settles a call written on this one", () => {
    const call = new CallParticipant();
    const mine = createFakeCtx({ connId: 1 });
    const other = createFakeCtx({ connId: 2 });
    const op = fakeCallOp({ procedure: 'p' });
    call.write(op, mine);
    expect(call.inbound(inbound.result(1), other)).toBe(false);
    expect(call.inbound(inbound.error(48, 1, 'x'), other)).toBe(false);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(call.inbound(inbound.result(1), mine)).toBe(true);
  });
});

describe('request ids', () => {
  test('pendingIds() is exactly the ids in flight: a random allocator never reuses one while it is in flight', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [5, 5, 6, 5], inFlight: () => call.pendingIds() });
    const a = fakeCallOp({ procedure: 'a' });
    const b = fakeCallOp({ procedure: 'b' });
    const c = fakeCallOp({ procedure: 'c' });
    call.write(a, ctx); // 5
    call.write(b, ctx); // 5 is in flight: redrawn, 6
    expect([...call.pendingIds()]).toEqual([5, 6]);
    call.inbound(inbound.result(5), ctx);
    call.write(c, ctx); // 5 is free again
    expect(ctx.written.map((w) => w.requestId)).toEqual([5, 6, 5]);
    expect([...call.pendingIds()]).toEqual([6, 5]);
  });

  test('pendingIds() is a live view that can be iterated again and again (an allocator may rescan it per redraw)', () => {
    const call = new CallParticipant();
    const ids = call.pendingIds(); // taken once, before anything is in flight
    // what an allocator could do: keep the Iterable and scan it on every redraw
    const scan = (id: number): boolean => [...ids].includes(id);
    const ctx = createFakeCtx({ ids: [5, 5, 5, 6], inFlight: () => ids });
    call.write(fakeCallOp({ procedure: 'a' }), ctx);
    expect([...ids]).toEqual([5]);
    expect(scan(5)).toBe(true);
    expect(scan(5)).toBe(true); // a bare Map iterator would be exhausted here
    call.write(fakeCallOp({ procedure: 'b' }), ctx); // 5, 5 are redrawn, 6
    expect(ctx.written.map((w) => w.requestId)).toEqual([5, 6]);
    call.inbound(inbound.result(5), ctx);
    expect([...ids]).toEqual([6]);
  });
});

describe('options are never mutated; calls never time out inside the client', () => {
  test('the CALL carries the frozen snapshot as is: the app object stays untouched and nothing is added', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const appOptions = { disclose_me: true, x_custom: { nested: [1] }, receive_progress: false, gone: undefined };
    const before = structuredClone(appOptions);
    const snap = snapshotCall('com.example.p', [1], { a: 1 }, appOptions);
    const op = callOf(snap, new FakeSubscriber<ResultMessage>());
    call.write(op, ctx);
    const [frame] = ctx.frames(MessageType.CALL);
    expect(frame![2]).toBe(snap.options);
    expect(Object.isFrozen(frame![2])).toBe(true);
    expect(frame).toEqual([
      48,
      1,
      { disclose_me: true, x_custom: { nested: [1] }, receive_progress: false },
      'com.example.p',
      [1],
      { a: 1 },
    ]);
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect(appOptions).toEqual(before);
    expect(snap.options).toEqual({ disclose_me: true, x_custom: { nested: [1] }, receive_progress: false });
  });

  test('no timer is ever armed; a router-side options.timeout is passed through untouched; timer() does nothing', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = callOf(snapshotCall('p', [], {}, { timeout: 5000 }), new FakeSubscriber<ResultMessage>());
    call.write(op, ctx);
    expect(ctx.frames()).toEqual([[48, 1, { timeout: 5000 }, 'p']]);
    expect(ctx.timers).toEqual([]);
    call.timer();
    expect(ctx.advance(10 * 60 * 1000)).toBe(0);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(op.subscriber.notifications).toEqual([]);
  });
});

// =====================================================================================================================
// Model-based property: one participant, random interleavings
// =====================================================================================================================

type Payload = 'none' | 'args' | 'kwargs' | 'bigint';
/** Which op a frame answers: one in flight, one cancelled in this session (refusals, late answers), one cancelled in
 *  any session, or any op at all. */
type Pick = 'live' | 'refusable' | 'cancelled' | 'any';
const pickArb = fc.constantFrom<Pick>('live', 'live', 'refusable', 'cancelled', 'any');
type Command =
  | { kind: 'start'; procedure: 'p0' | 'p1'; progressive: boolean; payload: Payload }
  | { kind: 'refuse'; on: boolean }
  | { kind: 'drain' }
  | { kind: 'result'; pick: Pick; target: number; progress: boolean; empty: boolean }
  | { kind: 'error'; pick: Pick; target: number; requestType: 48 | 49; uri: string }
  | { kind: 'invalid'; pick: Pick; target: number; result: boolean }
  | { kind: 'stale'; target: number }
  | { kind: 'unsubscribe'; pick: Pick; target: number }
  | { kind: 'end'; willRetry: boolean }
  | { kind: 'close' }
  | { kind: 'deliver' };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('start' as const),
      procedure: fc.constantFrom('p0' as const, 'p1' as const),
      progressive: fc.boolean(),
      payload: fc.constantFrom<Payload>('none', 'args', 'kwargs', 'bigint'),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('refuse' as const), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('drain' as const) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('result' as const),
      pick: pickArb,
      target: fc.nat(),
      progress: fc.boolean(),
      empty: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('error' as const),
      pick: pickArb,
      target: fc.nat(),
      requestType: fc.constantFrom(48 as const, 49 as const),
      uri: fc.constantFrom(Uri.NOT_SUPPORTED, Uri.NOT_SUPPORTED, Uri.CANCELED, 'com.example.error'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('invalid' as const),
      pick: pickArb,
      target: fc.nat(),
      result: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stale' as const), target: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('unsubscribe' as const),
      pick: fc.constantFrom<Pick>('live', 'live', 'any'),
      target: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('end' as const), willRetry: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('close' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('deliver' as const) }) },
);

type Shape = Record<string, unknown>;
type Expected = { kind: 'next'; value: Shape } | { kind: 'error'; error: Shape } | { kind: 'complete' };

function shapeOf(error: unknown): Shape {
  const e = error as Record<string, unknown>;
  return {
    name: e['name'],
    code: e['code'],
    uri: e['uri'],
    gaveUp: e['gaveUp'],
    requestId: e['requestId'],
    procedure: e['procedure'],
  };
}

/** Request ids from a pool of six (then unique ones), so finished ids are drawn again at once and the redraw loop
 *  runs. */
const DEGENERATE_IDS: readonly number[] = Array.from({ length: 5000 }, (_, i) => (i < 4000 ? (i % 6) + 1 : i));
type IdMode = 'sequential' | 'random' | 'degenerate';

function runModel(ids: IdMode, commands: readonly Command[]): void {
  // One delivery queue for every ctx/effects (the real loop has one), each delivery tagged at queue time.
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

  const participant = new CallParticipant();

  /** Records every invocation (raw, with the tag of the delivery it ran in) and the effective notifications. */
  class Recorder implements OpSubscriber<ResultMessage> {
    readonly raw: { kind: string; tag: number }[] = [];
    readonly effective: Expected[] = [];
    stopTag = Infinity;
    unsubscribed = false;
    private isClosed = false;
    constructor(private readonly teardown: () => void) {}
    get closed(): boolean {
      return this.isClosed;
    }
    next(value: ResultMessage): void {
      this.raw.push({ kind: 'next', tag: running });
      if (!this.isClosed) this.effective.push({ kind: 'next', value: { ...value } });
    }
    error(error: unknown): void {
      this.raw.push({ kind: 'error', tag: running });
      if (this.isClosed) return;
      this.isClosed = true;
      this.effective.push({ kind: 'error', error: shapeOf(error) });
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
    readonly op: CallOp & { readonly subscriber: Recorder };
    readonly payload: Payload;
    status: 'queued' | 'inflight' | 'done';
    id?: number;
    conn?: number;
    emitted: boolean;
    closed: boolean; // the model's view of the subscriber
    readonly expected: Expected[];
  }

  let connId = 1;
  const newCtx = (): Ctx => {
    const options: FakeCtxOptions = {
      connId,
      session: { id: connId },
      ids: ids === 'degenerate' ? DEGENERATE_IDS : ids,
      inFlight: () => participant.pendingIds(),
    };
    return new Ctx(options);
  };
  let ctx = newCtx();
  const ended: { ctx: Ctx; written: number; refused: number; failed: number }[] = [];
  let expectedFrames: OutboundFrame[] = [];
  let refusals = 0; // cancel.refused entries expected on the current ctx
  const models: M[] = [];
  const fifo: M[] = [];
  const inflight = new Map<number, M>();
  const cancelled = new Map<number, string>();
  const refused = new Set<string>();
  const pending: { m: M; n: Expected }[] = []; // the model's mirror of the queue
  let counter = 0;

  const enqueue = (m: M, n: Expected): void => {
    pending.push({ m, n });
  };
  const lost = (m: M, willRetry: boolean): Shape =>
    willRetry
      ? { name: 'ConnectionLostError', code: 'connection_lost', requestId: m.id, procedure: m.op.snap.procedure }
      : {
          name: 'ConnectionClosedError',
          code: 'connection_closed',
          gaveUp: true,
          requestId: m.id,
          procedure: m.op.snap.procedure,
        };

  const write = (m: M): 'done' | 'not-sent' => {
    const outcome = participant.write(m.op, ctx);
    if (m.payload === 'bigint') {
      expect(outcome).toBe('done');
      m.status = 'done';
      enqueue(m, { kind: 'error', error: { ...shapeOf(new TypeError()), name: 'TypeError' } });
      return outcome;
    }
    if (ctx.refuseWrites) {
      expect(outcome).toBe('not-sent');
      return outcome;
    }
    expect(outcome).toBe('done');
    const id = ctx.written[ctx.written.length - 1]!.requestId!;
    expect(inflight.has(id)).toBe(false); // ids are unique among the session's in-flight requests
    const { snap } = m.op;
    expectedFrames.push([48, id, snap.options, snap.procedure, ...outboundPayload(snap.args, snap.kwargs)]);
    Object.assign(m, { status: 'inflight', id, conn: connId });
    inflight.set(id, m);
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

  const newSession = (): void => {
    ended.push({ ctx, written: ctx.written.length, refused: ctx.refused.length, failed: ctx.failed.length });
    inflight.clear();
    cancelled.clear();
    refused.clear();
    connId++;
    ctx = newCtx();
    expectedFrames = [];
    refusals = 0;
  };

  /** close() or give-up: the participant fails what it holds, the core fails its FIFO. */
  const stopAll = (error: ConnectionClosedError, fx: Fx): void => {
    participant.clientClosed(() => error, fx);
    for (const m of inflight.values()) {
      m.status = 'done';
      enqueue(m, { kind: 'error', error: shapeOf(error) });
    }
    for (const m of fifo.splice(0)) {
      m.status = 'done';
      fx.deliver(() => {
        m.op.subscriber.error(error);
      });
      enqueue(m, { kind: 'error', error: shapeOf(error) });
    }
  };

  const cancelledOps: M[] = []; // every op cancelled while in flight, in any session
  const target = (index: number, pick: Pick = 'any'): M | undefined => {
    const pool =
      pick === 'live'
        ? [...inflight.values()]
        : pick === 'refusable'
          ? cancelledOps.filter((m) => cancelled.has(m.id!) && m.conn === connId)
          : pick === 'cancelled'
            ? cancelledOps
            : models;
    const from = pool.length > 0 ? pool : models;
    return from[index % Math.max(1, from.length)];
  };
  const idOf = (m: M | undefined): number => m?.id ?? 2 ** 53;

  const check = (): void => {
    expect(new Set(participant.pendingIds())).toEqual(new Set(inflight.keys()));
    expect(ctx.written.map((w) => w.frame)).toEqual(expectedFrames);
    expect(ctx.logged('cancel.refused')).toHaveLength(refusals);
    expect(ctx.logged('internal')).toEqual([]);
    for (const old of ended) {
      // nothing is ever written into an ended session, not even an attempt
      expect([old.ctx.written.length, old.ctx.refused.length, old.ctx.failed.length]).toEqual([
        old.written,
        old.refused,
        old.failed,
      ]);
    }
    for (const m of models) {
      const { raw } = m.op.subscriber;
      const terminal = raw.findIndex((r) => r.kind !== 'next');
      expect(raw.filter((r) => r.kind !== 'next')).toHaveLength(terminal < 0 ? 0 : 1); // no double settle
      if (terminal >= 0) expect(raw.slice(terminal + 1)).toEqual([]); // nothing after a terminal call
      const stop = m.op.subscriber.stopTag;
      expect(raw.filter((r) => r.tag > stop)).toEqual([]); // nothing queued after the app unsubscribed
    }
  };

  for (const command of commands) {
    switch (command.kind) {
      case 'start': {
        const args = command.payload === 'args' ? [++counter] : command.payload === 'bigint' ? [10n] : undefined;
        const kwargs = command.payload === 'kwargs' ? { n: ++counter } : undefined;
        const snap = snapshotCall(
          command.procedure,
          args,
          kwargs,
          command.progressive ? { receive_progress: true } : {},
        );
        const m: M = {
          op: undefined as never,
          payload: command.payload,
          status: 'queued',
          emitted: false,
          closed: false,
          expected: [],
        };
        const subscriber = new Recorder(() => {
          participant.stop(m.op, ctx); // the facade's teardown submits op.stop at every end (a no-op here)
        });
        Object.assign(m, { op: callOf(snap, subscriber) });
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
      case 'result': {
        const id = idOf(target(command.target, command.pick));
        const owner = inflight.get(id);
        const args = command.empty ? [] : [++counter];
        const details = command.progress ? { progress: true } : {};
        const consumed = participant.inbound(inbound.result(id, args, {}, details), ctx);
        expect(consumed).toBe(owner !== undefined || cancelled.has(id));
        if (owner === undefined) break;
        const value = { args, kwargs: {}, details };
        if (command.progress) {
          if (owner.op.snap.progressive && !command.empty) {
            owner.emitted = true;
            enqueue(owner, { kind: 'next', value });
          }
          break;
        }
        inflight.delete(id);
        owner.status = 'done';
        if (!(owner.op.snap.progressive && command.empty && owner.emitted)) enqueue(owner, { kind: 'next', value });
        enqueue(owner, { kind: 'complete' });
        break;
      }
      case 'error': {
        const id = idOf(target(command.target, command.pick));
        const owner = inflight.get(id);
        const consumed = participant.inbound(inbound.error(command.requestType, id, command.uri), ctx);
        expect(consumed).toBe(owner !== undefined || cancelled.has(id));
        if (owner !== undefined) {
          inflight.delete(id);
          owner.status = 'done';
          const { procedure } = owner.op.snap;
          enqueue(owner, {
            kind: 'error',
            error: { name: 'WampError', code: 'wamp_error', uri: command.uri, requestId: id, procedure },
          });
        } else {
          const procedure = cancelled.get(id);
          if (procedure !== undefined && command.uri === Uri.NOT_SUPPORTED && !refused.has(procedure)) {
            refused.add(procedure);
            refusals++;
          }
        }
        break;
      }
      case 'invalid': {
        const id = idOf(target(command.target, command.pick));
        const owner = inflight.get(id);
        const msg = command.result ? inbound.invalid(inbound.result(id)) : inbound.invalid(inbound.error(49, id, 'x'));
        expect(participant.inbound(msg, ctx)).toBe(owner !== undefined || cancelled.has(id));
        if (owner !== undefined) {
          inflight.delete(id);
          owner.status = 'done';
          const { procedure } = owner.op.snap;
          enqueue(owner, {
            kind: 'error',
            error: { name: 'ProtocolError', code: 'protocol', requestId: id, procedure },
          });
        }
        break;
      }
      case 'stale': {
        const old = ended[ended.length - 1];
        if (old === undefined) break;
        const before = queue.length;
        participant.inbound(inbound.result(idOf(target(command.target)), [1]), old.ctx);
        expect(queue.length).toBe(before); // an answer from another connection settles nothing
        break;
      }
      case 'unsubscribe': {
        const m = target(command.target, command.pick);
        if (m === undefined || m.op.subscriber.closed) break; // a Subscription unsubscribes once
        m.op.subscriber.unsubscribe();
        m.closed = true;
        if (m.status === 'queued') {
          fifo.splice(fifo.indexOf(m), 1); // still queued: the core removes it, nothing is written
          m.status = 'done';
          break;
        }
        participant.stop(m.op, ctx);
        if (m.status === 'inflight') {
          const id = m.id!;
          inflight.delete(id);
          m.status = 'done';
          cancelled.set(id, m.op.snap.procedure);
          cancelledOps.push(m);
          if (!ctx.refuseWrites) expectedFrames.push([49, id, { mode: 'killnowait' }]);
        }
        break;
      }
      case 'end': {
        ctx.endSession();
        const fx = new Fx();
        const end = fakeEndInfo({ willRetry: command.willRetry, info: { sessionId: connId } });
        const order = [...inflight.values()];
        participant.sessionEnded(end, fx);
        expect(end.calls).toEqual(order.map((m) => ({ requestId: m.id, procedure: m.op.snap.procedure })));
        for (const m of order) {
          m.status = 'done';
          enqueue(m, { kind: 'error', error: lost(m, command.willRetry) });
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
        break;
    }
    check();
    if (command.kind === 'deliver') {
      for (const m of models) expect(m.op.subscriber.effective).toEqual(m.expected);
    }
  }

  // Heal: close(), deliver everything. Every op the app did not unsubscribe has settled exactly once (no hang).
  ctx.endSession();
  stopAll(new ConnectionClosedError({}), new Fx());
  newSession();
  flush();
  check();
  for (const m of models) {
    expect(m.op.subscriber.effective).toEqual(m.expected);
    const terminals = m.op.subscriber.effective.filter((n) => n.kind !== 'next');
    expect(terminals).toHaveLength(m.op.subscriber.unsubscribed && terminals.length === 0 ? 0 : 1);
  }
  // No leak: the participant holds nothing — a stop for any op, into the connection it was written on, writes nothing.
  expect([...participant.pendingIds()]).toEqual([]);
  for (const m of models) {
    if (m.conn === undefined) continue;
    const probe = createFakeCtx({ connId: m.conn });
    participant.stop(m.op, probe);
    expect(probe.written).toEqual([]);
  }
}

/** The model runs take a few ms each, so a deeper `FC_NUM_RUNS=20000` run needs far more than vitest's default 5 s
 *  (per-file timeouts scale with FC_NUM_RUNS; fast-check's own time limit still applies). */
const PROPERTY_TIMEOUT = Math.max(5000, (fc.readConfigureGlobal().numRuns ?? 100) * 20);

describe('property: random interleavings of writes, frames, unsubscribes, deliveries, session ends and close()', () => {
  test(
    'no double settle, no frame after settle, no frame into an ended session, no leak, every op settles',
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

  test('a fixed interleaving: progress, unsubscribe while the RESULT delivery is pending, refusal, end, close', () => {
    runModel('sequential', [
      { kind: 'start', procedure: 'p0', progressive: true, payload: 'args' },
      { kind: 'start', procedure: 'p1', progressive: false, payload: 'kwargs' },
      { kind: 'result', pick: 'any', target: 0, progress: true, empty: false },
      { kind: 'result', pick: 'any', target: 1, progress: false, empty: false },
      { kind: 'unsubscribe', pick: 'any', target: 1 }, // its RESULT is still queued: dropped by the closed subscriber
      { kind: 'unsubscribe', pick: 'any', target: 0 }, // in flight: CANCEL
      { kind: 'error', pick: 'any', target: 0, requestType: 49, uri: Uri.NOT_SUPPORTED },
      { kind: 'deliver' },
      { kind: 'refuse', on: true },
      { kind: 'start', procedure: 'p0', progressive: false, payload: 'none' },
      { kind: 'start', procedure: 'p0', progressive: false, payload: 'bigint' },
      { kind: 'end', willRetry: true },
      { kind: 'drain' },
      { kind: 'stale', target: 0 },
      { kind: 'deliver' },
      { kind: 'end', willRetry: false },
      { kind: 'deliver' },
    ]);
  });
});
