// Call cancellation: unsubscribe of an in-flight call writes CANCEL {mode: 'killnowait'} exactly once, only into the
// call's own session, and settles the call locally; late answers are dropped (Thruway PHP's ERROR(49, canceled), its
// not_supported refusal — logged `cancel.refused` once per procedure per session — and the RESULT that follows it); the
// diagnostics are bounded; and the app's Rx timeout() is the call timeout: it reaches the app as a TimeoutError and its
// unsubscribe sends CANCEL.
import { firstValueFrom, from, Subject, switchMap, throwError, timeout, TimeoutError as RxTimeoutError } from 'rxjs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CallOp, CallSnapshot } from '../../src/core/contracts.js';
import { ConnectionClosedError, isThruwayError, TimeoutError } from '../../src/errors.js';
import { createLogTarget, safeLogLazy } from '../../src/logger.js';
import { Observable } from '../../src/observable/observable.js';
import { CallParticipant, CANCELLED_LIMIT, REFUSED_LIMIT } from '../../src/ops/call.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import type { LogEntry, ResultMessage } from '../../src/types.js';
import { snapshotCall } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeCallOp,
  fakeEndInfo,
  inbound,
  nextSeq,
  type FakeSessionCtx,
} from '../helpers/fake-ctx.js';

const KILLNOWAIT = { mode: 'killnowait' } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every invocation of the subscriber's methods, also the no-op ones after it closed. */
function spy(op: ReturnType<typeof fakeCallOp>) {
  return [vi.spyOn(op.subscriber, 'next'), vi.spyOn(op.subscriber, 'error'), vi.spyOn(op.subscriber, 'complete')];
}

/** Write a call, then the app unsubscribes it (the facade's teardown submits op.stop). */
function inFlight(call: CallParticipant, ctx: FakeSessionCtx, procedure = 'p', options = {}) {
  const op = fakeCallOp({ procedure, options });
  call.write(op, ctx);
  return op;
}
function unsubscribe(
  call: CallParticipant,
  op: CallOp & { subscriber: { unsubscribe(): void } },
  ctx?: FakeSessionCtx,
) {
  op.subscriber.unsubscribe();
  call.stop(op, ctx);
}

describe('unsubscribe ⇒ CANCEL killnowait', () => {
  test('an in-flight call writes [49, id, {mode: "killnowait"}] exactly once and is settled locally', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [41] });
    const op = inFlight(call, ctx);
    const calls = spy(op);
    unsubscribe(call, op, ctx);
    expect(ctx.frames()).toEqual([
      [48, 41, {}, 'p'],
      [49, 41, KILLNOWAIT],
    ]);
    expect(ctx.written[1]).toMatchObject({ via: 'send', requestId: undefined });
    expect([...call.pendingIds()]).toEqual([]);
    call.stop(op, ctx); // a second op.stop (or the teardown after a terminal) writes nothing
    expect(ctx.frames(MessageType.CANCEL)).toHaveLength(1);
    // the router's answers are late now: consumed as such (logged here), never delivered
    expect(call.inbound(inbound.result(41, ['late']), ctx)).toBe(true);
    expect(call.inbound(inbound.error(48, 41, Uri.CANCELED), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
    for (const method of calls) expect(method).not.toHaveBeenCalled();
    const entry = {
      level: 'debug',
      event: 'frame.dropped',
      message: 'dropped an answer to a canceled call to p',
      data: { requestId: 41, procedure: 'p' },
    };
    expect(ctx.logged('frame.dropped')).toStrictEqual([entry, entry]);
    expect(ctx.timers).toEqual([]);
  });

  test('stop of a call that was answered, failed, or never written writes nothing', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const answered = inFlight(call, ctx);
    call.inbound(inbound.result(1), ctx);
    const failed = inFlight(call, ctx);
    call.inbound(inbound.error(48, 2, 'x'), ctx);
    const queued = fakeCallOp({ procedure: 'p' }); // the core keeps it in its FIFO (or removes it there)
    ctx.runDeliveries();
    const writes = ctx.written.length;
    for (const op of [answered, failed, queued]) call.stop(op, ctx);
    expect(ctx.written).toHaveLength(writes);
  });

  test('a CANCEL the closing socket refuses is ignored: the call is settled locally all the same', () => {
    for (const refuse of ['refuseWrites', 'closeGate'] as const) {
      const call = new CallParticipant();
      const ctx = createFakeCtx();
      const op = inFlight(call, ctx);
      if (refuse === 'refuseWrites') ctx.refuseWrites = true;
      else ctx.closeGate();
      unsubscribe(call, op, ctx);
      expect(ctx.refused).toMatchObject([{ frame: [49, 1, KILLNOWAIT], via: 'send' }]);
      expect([...call.pendingIds()]).toEqual([]);
      expect(ctx.logs).toEqual([]);
    }
  });

  test('a CANCEL the serializer cannot write is logged as an error entry that reaches the default logger', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [6] });
    const op = inFlight(call, ctx, 'com.example.slow');
    const broken = new Error('serializer broke');
    ctx.failNextWrite(broken, (frame) => frame[0] === MessageType.CANCEL);
    const log = vi.spyOn(ctx, 'log');
    unsubscribe(call, op, ctx);
    expect([...call.pendingIds()]).toEqual([]);
    expect(ctx.logged('internal')).toEqual([
      {
        level: 'error',
        event: 'internal',
        message: 'CANCEL for a call to com.example.slow could not be written: Error: serializer broke',
        data: { error: broken, requestId: 6, procedure: 'com.example.slow' },
      },
    ]);
    // built eagerly (logger.ts eager): the default logger prints it although no custom logger is set
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    safeLogLazy(createLogTarget(undefined), log.mock.calls[0]![0]);
    expect(printed).toHaveBeenCalledOnce();
    // the call is still settled: its answer is a late one
    expect(call.inbound(inbound.result(6), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
  });

  test("CANCEL goes only into the call's own session: none without a session or with another connection's ctx", () => {
    for (const other of [undefined, createFakeCtx({ connId: 2, session: { id: 2 } })]) {
      const call = new CallParticipant();
      const mine = createFakeCtx({ connId: 1 });
      const op = inFlight(call, mine);
      unsubscribe(call, op, other);
      expect(mine.frames(MessageType.CANCEL)).toEqual([]);
      expect(other?.written ?? []).toEqual([]);
      expect([...call.pendingIds()]).toEqual([]);
      expect(call.inbound(inbound.result(1), mine)).toBe(false); // not a cancellation of this session: unknown
    }
  });

  test('after the session ended, unsubscribing a call that already failed Lost writes nothing', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = inFlight(call, ctx);
    ctx.endSession();
    const fx = createFakeEffects();
    call.sessionEnded(fakeEndInfo(), fx);
    fx.runDeliveries();
    call.stop(op, ctx);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([]);
    expect(ctx.refused).toEqual([]);
    expect(op.subscriber.errors).toMatchObject([{ code: 'connection_lost' }]);
  });
});

describe('router answers to a CANCEL (Thruway T2, T3)', () => {
  test('Thruway PHP ERROR(49, canceled) right after killnowait, and Crossbar/Nexus ERROR(48, canceled), are dropped', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const a = inFlight(call, ctx);
    const b = inFlight(call, ctx);
    unsubscribe(call, a, ctx);
    unsubscribe(call, b, ctx);
    expect(call.inbound(inbound.error(49, 1, Uri.CANCELED), ctx)).toBe(true);
    expect(call.inbound(inbound.error(48, 2, Uri.CANCELLED), ctx)).toBe(true);
    expect(call.inbound(inbound.invalid(inbound.error(49, 1, Uri.CANCELED)), ctx)).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(ctx.logged('cancel.refused')).toEqual([]);
  });

  test('not_supported (callee without call_canceling) is logged cancel.refused once per procedure per session', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [1, 2, 3] });
    const slow1 = inFlight(call, ctx, 'php.slow');
    const slow2 = inFlight(call, ctx, 'php.slow');
    const other = inFlight(call, ctx, 'php.other');
    for (const op of [slow1, slow2, other]) unsubscribe(call, op, ctx);
    expect(call.inbound(inbound.error(49, 1, Uri.NOT_SUPPORTED), ctx)).toBe(true);
    expect(call.inbound(inbound.error(49, 2, Uri.NOT_SUPPORTED), ctx)).toBe(true);
    expect(call.inbound(inbound.error(49, 3, Uri.NOT_SUPPORTED), ctx)).toBe(true);
    // the call keeps running on the router (Thruway T2): its RESULT arrives later and is dropped
    expect(call.inbound(inbound.result(1, ['done anyway']), ctx)).toBe(true);
    expect(ctx.logged('cancel.refused')).toEqual([
      {
        level: 'warn',
        event: 'cancel.refused',
        message: 'The router refused to cancel a call to php.slow (wamp.error.not_supported); the callee keeps working',
        data: { requestId: 1, procedure: 'php.slow' },
      },
      {
        level: 'warn',
        event: 'cancel.refused',
        message:
          'The router refused to cancel a call to php.other (wamp.error.not_supported); the callee keeps working',
        data: { requestId: 3, procedure: 'php.other' },
      },
    ]);
    expect(ctx.logged('frame.dropped').map((e) => e.data?.['requestId'])).toEqual([2, 1]);
    expect(ctx.pendingDeliveries).toEqual([]);
  });

  test('cancel.refused is logged again in the next session, after a session end or close()', () => {
    for (const end of ['sessionEnded', 'clientClosed'] as const) {
      const call = new CallParticipant();
      const refusalIn = (ctx: FakeSessionCtx): LogEntry[] => {
        const op = inFlight(call, ctx, 'php.slow');
        unsubscribe(call, op, ctx);
        call.inbound(inbound.error(49, 1, Uri.NOT_SUPPORTED), ctx);
        return ctx.logged('cancel.refused');
      };
      const first = createFakeCtx({ connId: 1 });
      expect(refusalIn(first)).toHaveLength(1);
      first.endSession();
      if (end === 'sessionEnded') call.sessionEnded(fakeEndInfo(), first);
      else call.clientClosed(() => new ConnectionClosedError({}), first);
      const second = createFakeCtx({ connId: 2, session: { id: 2 } });
      expect(refusalIn(second)).toHaveLength(1);
    }
  });

  test('Thruway T3: a cancelled progressive call needs no final message; the values emitted before stay', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const op = inFlight(call, ctx, 'feed', { receive_progress: true });
    call.inbound(inbound.result(1, ['a'], {}, { progress: true }), ctx);
    ctx.runDeliveries();
    const calls = spy(op);
    unsubscribe(call, op, ctx);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([[49, 1, KILLNOWAIT]]);
    expect(call.inbound(inbound.result(1, ['b'], {}, { progress: true }), ctx)).toBe(true); // in transit
    expect(call.inbound(inbound.error(49, 1, Uri.CANCELED), ctx)).toBe(true);
    expect([...call.pendingIds()]).toEqual([]);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(op.subscriber.values).toEqual([{ args: ['a'], kwargs: {}, details: { progress: true } }]);
    for (const method of calls) expect(method).not.toHaveBeenCalled();
  });
});

describe('bounded diagnostics, no tombstones', () => {
  test('cancellations belong to their session: after a session end or close() an old id is unknown again', () => {
    for (const end of ['sessionEnded', 'clientClosed'] as const) {
      const call = new CallParticipant();
      const first = createFakeCtx({ connId: 1 });
      unsubscribe(call, inFlight(call, first, 'php.slow'), first);
      first.endSession();
      if (end === 'sessionEnded') call.sessionEnded(fakeEndInfo(), first);
      else call.clientClosed(() => new ConnectionClosedError({}), first);
      const second = createFakeCtx({ connId: 2, session: { id: 2 } });
      expect(call.inbound(inbound.error(49, 1, Uri.NOT_SUPPORTED), second)).toBe(false);
      expect(call.inbound(inbound.result(1), second)).toBe(false);
      expect(second.logs).toEqual([]);
    }
  });

  test("a settled call's late stop (the facade's teardown) never touches a newer call that reuses its id", () => {
    const call = new CallParticipant();
    const first = createFakeCtx({ connId: 1, ids: [3, 3], inFlight: () => call.pendingIds() });
    const answered = inFlight(call, first, 'a');
    call.inbound(inbound.result(3), first);
    const reused = inFlight(call, first, 'b'); // same session, id 3 again
    call.stop(answered, first);
    const lost = inFlight(call, first, 'c');
    first.endSession();
    call.sessionEnded(fakeEndInfo(), first);
    const second = createFakeCtx({ connId: 2, session: { id: 2 } });
    const next = inFlight(call, second, 'd'); // next session, sequential id 1 again
    call.stop(lost, second);
    call.stop(reused, second);
    expect([...call.pendingIds()]).toEqual([1]);
    expect(call.inbound(inbound.result(1, ['for d']), second)).toBe(true);
    second.runDeliveries();
    expect(next.subscriber.values).toEqual([{ args: ['for d'], kwargs: {}, details: {} }]);
    expect(second.frames(MessageType.CANCEL)).toEqual([]);
  });

  test(`only the last ${String(CANCELLED_LIMIT)} cancellations are recognised; older answers are unknown`, () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const ops = Array.from({ length: CANCELLED_LIMIT + 1 }, () => inFlight(call, ctx, 'php.slow'));
    for (const op of ops) unsubscribe(call, op, ctx);
    expect(call.inbound(inbound.error(49, 1, Uri.NOT_SUPPORTED), ctx)).toBe(false); // evicted
    expect(call.inbound(inbound.error(49, 2, Uri.NOT_SUPPORTED), ctx)).toBe(true);
    expect(call.inbound(inbound.result(CANCELLED_LIMIT + 1), ctx)).toBe(true);
    expect(ctx.logged('cancel.refused')).toMatchObject([{ data: { requestId: 2 } }]);
  });

  test(`at most ${String(REFUSED_LIMIT)} refused procedures are remembered per session: the oldest is forgotten`, () => {
    // A long session that cancels calls to ever new procedure URIs (one per entity) on Thruway PHP, whose PHP callees
    // refuse every CANCEL (Thruway T2), must not grow the participant without bound.
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const refuse = (procedure: string): void => {
      const op = inFlight(call, ctx, procedure);
      const id = ctx.written[ctx.written.length - 1]!.requestId!;
      unsubscribe(call, op, ctx);
      expect(call.inbound(inbound.error(49, id, Uri.NOT_SUPPORTED), ctx)).toBe(true);
    };
    for (let i = 0; i <= REFUSED_LIMIT; i++) refuse(`com.example.entity${String(i)}.watch`);
    expect(ctx.logged('cancel.refused')).toHaveLength(REFUSED_LIMIT + 1);
    refuse(`com.example.entity${String(REFUSED_LIMIT)}.watch`); // still remembered: not logged again
    expect(ctx.logged('cancel.refused')).toHaveLength(REFUSED_LIMIT + 1);
    refuse('com.example.entity0.watch'); // the oldest was forgotten: logged once more
    expect(ctx.logged('cancel.refused')).toHaveLength(REFUSED_LIMIT + 2);
    refuse('com.example.entity1.watch'); // and that evicted the next oldest
    expect(ctx.logged('cancel.refused')).toHaveLength(REFUSED_LIMIT + 3);
    refuse(`com.example.entity${String(REFUSED_LIMIT)}.watch`);
    expect(ctx.logged('cancel.refused')).toHaveLength(REFUSED_LIMIT + 3);
  });

  test('a cancelled id is not in flight: the allocator may draw it again, and its answers then belong to the new call', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [7, 7], inFlight: () => call.pendingIds() });
    const old = inFlight(call, ctx, 'old');
    unsubscribe(call, old, ctx);
    const fresh = inFlight(call, ctx, 'fresh');
    expect(ctx.written.map((w) => w.frame[0] === MessageType.CALL && w.requestId)).toEqual([7, false, 7]);
    expect(call.inbound(inbound.result(7, ['for fresh']), ctx)).toBe(true);
    ctx.runDeliveries();
    expect(fresh.subscriber.values).toEqual([{ args: ['for fresh'], kwargs: {}, details: {} }]);
  });
});

// The facade in miniature: subscribe ⇒ write, teardown ⇒ stop (the real one submits op.start/op.stop).
function callObservable(call: CallParticipant, ctx: FakeSessionCtx, snap: CallSnapshot): Observable<ResultMessage> {
  return new Observable<ResultMessage>((subscriber) => {
    const op: CallOp = Object.freeze({ kind: 'call', seq: nextSeq(), snap, subscriber });
    call.write(op, ctx);
    return () => {
      call.stop(op, ctx);
    };
  });
}

describe("call timeouts are the app's Rx timeout() (README recipes 2 and 19)", () => {
  test('recipe 19: the expiry reaches the app as TimeoutError{timer: "call"}; its unsubscribe sends CANCEL killnowait once', async () => {
    vi.useFakeTimers();
    const call = new CallParticipant();
    const ctx = createFakeCtx({ ids: [12], session: { id: 3 } });
    const procedure = 'com.example.report';
    const result = firstValueFrom(
      from(callObservable(call, ctx, snapshotCall(procedure, ['r'], undefined, undefined))).pipe(
        timeout({
          first: 5000,
          with: () =>
            throwError(() => new TimeoutError({ timer: 'call', timeout: 5000, procedure, sessionId: ctx.session.id })),
        }),
      ),
    );
    expect(ctx.frames()).toEqual([[48, 12, {}, procedure, ['r']]]);
    vi.advanceTimersByTime(5000);
    const error: unknown = await result.catch((e: unknown) => e);
    expect(isThruwayError(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'TimeoutError',
      code: 'timeout',
      timer: 'call',
      timeout: 5000,
      procedure,
      sessionId: 3,
    });
    expect(ctx.frames(MessageType.CANCEL)).toEqual([[49, 12, KILLNOWAIT]]);
    expect(call.inbound(inbound.result(12, ['too late']), ctx)).toBe(true);
    expect(ctx.runDeliveries()).toBe(0);
    expect([...call.pendingIds()]).toEqual([]);
  });

  test("recipe 2: a plain timeout() raises the Rx library's own TimeoutError and still cancels", async () => {
    vi.useFakeTimers();
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const result = firstValueFrom(from(callObservable(call, ctx, snapshotCall('p', [], {}, {}))).pipe(timeout(1000)));
    vi.advanceTimersByTime(1000);
    await expect(result).rejects.toBeInstanceOf(RxTimeoutError);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([[49, 1, KILLNOWAIT]]);
  });

  test('an answer before the deadline completes normally: no CANCEL (the teardown after complete is a no-op)', async () => {
    vi.useFakeTimers();
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const result = firstValueFrom(from(callObservable(call, ctx, snapshotCall('p', [], {}, {}))).pipe(timeout(1000)));
    call.inbound(inbound.result(1, [42]), ctx);
    ctx.runDeliveries();
    await expect(result).resolves.toEqual({ args: [42], kwargs: {}, details: {} });
    vi.advanceTimersByTime(1000);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([]);
  });

  test('switchMap: a new value cancels the running call and issues a new CALL with a new id', () => {
    const call = new CallParticipant();
    const ctx = createFakeCtx();
    const searches = new Subject<string>();
    const seen: unknown[] = [];
    const subscription = searches
      .pipe(switchMap((q) => from(callObservable(call, ctx, snapshotCall('search', [q], undefined, undefined)))))
      .subscribe((r) => seen.push(r.args));
    searches.next('a');
    searches.next('ab');
    expect(ctx.frames()).toEqual([
      [48, 1, {}, 'search', ['a']],
      [49, 1, KILLNOWAIT],
      [48, 2, {}, 'search', ['ab']],
    ]);
    call.inbound(inbound.result(1, ['for a']), ctx); // late: dropped
    call.inbound(inbound.result(2, ['for ab']), ctx);
    ctx.runDeliveries();
    expect(seen).toEqual([['for ab']]);
    subscription.unsubscribe();
    expect(ctx.frames(MessageType.CANCEL)).toHaveLength(1); // the answered call is not cancelled
  });
});
