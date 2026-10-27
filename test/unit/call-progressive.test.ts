// Progressive results: `progressiveCall` is `call` with receive_progress: true — options copied, never mutated, no
// hidden re-send; progress RESULTs are emitted in order, then the final one (unless it is empty and something was
// emitted), then complete; unrequested and empty progress RESULTs are ignored; a router without progress support
// (Crossbar quirk 5) completes on its first answer; errors, payload-invalid frames and session ends after progress
// error the op and keep its values.
import { from, lastValueFrom, toArray } from 'rxjs';
import { describe, expect, test } from 'vitest';
import type { CallOp, CallSnapshot } from '../../src/core/contracts.js';
import { Observable } from '../../src/observable/observable.js';
import { CallParticipant } from '../../src/ops/call.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import type { ResultMessage } from '../../src/types.js';
import { snapshotCall, snapshotProgressiveCall } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeCallOp,
  fakeEndInfo,
  FakeSubscriber,
  inbound,
  nextSeq,
  type FakeSessionCtx,
} from '../helpers/fake-ctx.js';

const PROGRESS = Object.freeze({ progress: true });

function progressive(call: CallParticipant, ctx: FakeSessionCtx, snap?: CallSnapshot) {
  const op = Object.freeze({
    kind: 'call' as const,
    seq: nextSeq(),
    snap: snap ?? snapshotProgressiveCall('com.example.feed', [], {}, undefined),
    subscriber: new FakeSubscriber<ResultMessage>(),
  });
  call.write(op, ctx);
  return op;
}

describe('progressiveCall = call with receive_progress: true', () => {
  test('the CALL asks for progress; the app options are copied, never mutated, whatever receive_progress they hold', () => {
    for (const receive_progress of [false, undefined, 'yes']) {
      const call = new CallParticipant();
      const ctx = createFakeCtx();
      const appOptions = { receive_progress, disclose_me: true };
      const before = { ...appOptions };
      const snap = snapshotProgressiveCall('com.example.feed', ['x'], undefined, appOptions);
      progressive(call, ctx, snap);
      expect(ctx.frames()).toEqual([[48, 1, { disclose_me: true, receive_progress: true }, 'com.example.feed', ['x']]]);
      expect(appOptions).toEqual(before);
      expect(Object.isFrozen(snap.options)).toBe(true);
    }
  });

  test('call(…, {receive_progress: true}) behaves the same (recipe 1)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx, snapshotCall('com.example.feed', [], {}, { receive_progress: true }));
    call.inbound(inbound.result(1, [1], {}, PROGRESS), ctx);
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args: [1], kwargs: {}, details: PROGRESS } },
      { kind: 'complete' },
    ]);
  });
});

describe('emission rule', () => {
  test('progress RESULTs are emitted in order, each after its step, then the final one, then complete', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    expect(call.inbound(inbound.result(1, [1], {}, PROGRESS), ctx)).toBe(true);
    expect(call.inbound(inbound.result(1, [], { n: 2 }, PROGRESS), ctx)).toBe(true); // kwargs only: not empty
    expect(op.subscriber.notifications).toEqual([]);
    expect([...call.pendingIds()]).toEqual([1]); // still in flight between progress results
    ctx.runDeliveries();
    expect(op.subscriber.values.map((v) => [v.args, v.kwargs])).toEqual([
      [[1], {}],
      [[], { n: 2 }],
    ]);
    call.inbound(inbound.result(1, [3]), ctx);
    expect([...call.pendingIds()]).toEqual([]);
    ctx.runDeliveries();
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args: [1], kwargs: {}, details: PROGRESS } },
      { kind: 'next', value: { args: [], kwargs: { n: 2 }, details: PROGRESS } },
      { kind: 'next', value: { args: [3], kwargs: {}, details: {} } },
      { kind: 'complete' },
    ]);
  });

  test('an empty final RESULT after progress values is not emitted: the op just completes', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    call.inbound(inbound.result(1, [], {}, { callee: 1 }), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args: ['a'], kwargs: {}, details: PROGRESS } },
      { kind: 'complete' },
    ]);
  });

  test('an empty final RESULT with nothing emitted yet is emitted, so lastValueFrom always resolves', async () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([{ args: [], kwargs: {}, details: {} }]);
    expect(op.subscriber.completed).toBe(true);

    // the same through RxJS: lastValueFrom resolves with the empty result instead of rejecting with EmptyError
    const observable = new Observable<ResultMessage>((subscriber) => {
      const record: CallOp = Object.freeze({
        kind: 'call',
        seq: nextSeq(),
        snap: snapshotProgressiveCall('p', [], {}, {}),
        subscriber,
      });
      call.write(record, ctx);
      return () => {
        call.stop(record, ctx);
      };
    });
    const last = lastValueFrom(from(observable));
    call.inbound(inbound.result(2), ctx);
    ctx.runDeliveries();
    await expect(last).resolves.toEqual({ args: [], kwargs: {}, details: {} });
  });

  test('every value reaches an RxJS pipeline in order; an empty terminator is not surfaced', async () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const observable = new Observable<ResultMessage>((subscriber) => {
      const record: CallOp = Object.freeze({
        kind: 'call',
        seq: nextSeq(),
        snap: snapshotProgressiveCall('p', [], {}, {}),
        subscriber,
      });
      call.write(record, ctx);
      return () => {
        call.stop(record, ctx);
      };
    });
    const all = lastValueFrom(from(observable).pipe(toArray()));
    for (const n of [1, 2, 3]) call.inbound(inbound.result(1, [n], {}, PROGRESS), ctx);
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect((await all).map((r): unknown => r.args)).toEqual([[1], [2], [3]]);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([]); // completed: the teardown cancels nothing
  });

  test('a non-empty final RESULT after progress values is emitted', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    call.inbound(inbound.result(1, [], { total: 1 }), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values.map((v) => v.kwargs)).toEqual([{}, { total: 1 }]);
    expect(op.subscriber.completed).toBe(true);
  });

  test('an empty progress RESULT (Thruway PHP keepalive) is ignored: logged as dropped, the call stays in flight', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    expect(call.inbound(inbound.result(1, [], {}, PROGRESS), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(ctx.logged('frame.dropped')).toEqual([
      {
        level: 'debug',
        event: 'frame.dropped',
        message: 'dropped an empty progress RESULT to com.example.feed',
        data: { requestId: 1, procedure: 'com.example.feed' },
      },
    ]);
    // the empty keepalive does not count as an emitted value: an empty final RESULT is still emitted
    call.inbound(inbound.result(1), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([{ args: [], kwargs: {}, details: {} }]);
  });

  test('a progress RESULT for a call that did not ask for progress is ignored (Crossbar quirk 5)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = fakeCallOp({ procedure: 'plain' });
    call.write(op, ctx);
    expect(call.inbound(inbound.result(1, ['unrequested'], {}, PROGRESS), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(ctx.logged('frame.dropped')).toStrictEqual([
      {
        level: 'debug',
        event: 'frame.dropped',
        message: 'dropped an unrequested progress RESULT to plain',
        data: { requestId: 1, procedure: 'plain' },
      },
    ]);
    call.inbound(inbound.result(1, ['final']), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values.map((v): unknown => v.args)).toEqual([['final']]);
  });

  test('only details.progress === true marks a progress RESULT; anything else is the final one', () => {
    for (const progress of [false, 1, 'true', null]) {
      const call = new CallParticipant();
      const ctx = createFakeCtx();
      const op = progressive(call, ctx);
      call.inbound(inbound.result(1, ['x'], {}, { progress }), ctx);
      ctx.runDeliveries();
      expect(op.subscriber.completed).toBe(true);
      expect([...call.pendingIds()]).toEqual([]);
    }
  });

  test('a router without progress support answers with one final RESULT: emitted, then complete (Bondy, wamp-server)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['first chunk']), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.notifications).toEqual([
      { kind: 'next', value: { args: ['first chunk'], kwargs: {}, details: {} } },
      { kind: 'complete' },
    ]);
  });
});

describe('endings after progress values', () => {
  test('ERROR after progress results errors the op; the emitted values stay; nothing is re-sent', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    call.inbound(inbound.error(48, 1, Uri.CANCELED), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values.map((v): unknown => v.args)).toEqual([['a']]);
    expect(op.subscriber.errors).toMatchObject([{ code: 'wamp_error', uri: Uri.CANCELED }]);
    expect(ctx.frames()).toHaveLength(1); // no hidden re-send of the CALL
  });

  test('a payload-invalid RESULT after progress values errors the op with ProtocolError', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    call.inbound(inbound.invalid(inbound.result(1, [], {}, PROGRESS), 'RESULT kwargs is not a dict'), ctx);
    ctx.runDeliveries();
    expect(op.subscriber.values).toHaveLength(1);
    expect(op.subscriber.errors).toMatchObject([{ code: 'protocol', message: 'RESULT kwargs is not a dict' }]);
    expect([...call.pendingIds()]).toEqual([]);
  });

  test('a session end after progress values errors ConnectionLostError; the values stay (recipe 1 re-issues)', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    ctx.endSession();
    const fx = createFakeEffects();
    call.sessionEnded(fakeEndInfo(), fx);
    ctx.runDeliveries();
    fx.runDeliveries();
    expect(op.subscriber.notifications).toMatchObject([
      { kind: 'next', value: { args: ['a'] } },
      { kind: 'error', error: { code: 'connection_lost', procedure: 'com.example.feed' } },
    ]);
    expect(ctx.frames()).toHaveLength(1);
  });

  test('unsubscribe after progress values sends CANCEL killnowait; later progress is dropped', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = progressive(call, ctx);
    call.inbound(inbound.result(1, ['a'], {}, PROGRESS), ctx);
    ctx.runDeliveries();
    op.subscriber.unsubscribe();
    call.stop(op, ctx);
    expect(ctx.lastFrame()).toEqual([49, 1, { mode: 'killnowait' }]);
    expect(call.inbound(inbound.result(1, ['b'], {}, PROGRESS), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
  });
});
