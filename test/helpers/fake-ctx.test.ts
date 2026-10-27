// Self-test of test/helpers/fake-ctx.ts: the fake must behave like the SessionCtx/Effects contracts
// (src/core/contracts.ts) promise, or the participant unit tests would test against a wrong model.
import { fc, test as prop } from '@fast-check/vitest';
import { describe, expect, test } from 'vitest';
import type { SessionCtx } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { callFrame, cancelFrame, publishFrame, subscribeFrame } from '../../src/protocol/messages.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeCallOp,
  fakeEndInfo,
  fakePublishOp,
  fakeRegisterOp,
  fakeTopicOp,
  FakeSubscriber,
  inbound,
  serializerError,
  sizeError,
} from './fake-ctx.js';

describe('request ids', () => {
  test('sequential from 1; a write that was not sent rolls the counter back (no gaps)', () => {
    const ctx = createFakeCtx();
    expect(ctx.request((id) => callFrame(id, {}, 'a'))).toBe(1);
    expect(ctx.request((id) => callFrame(id, {}, 'b'))).toBe(2);
    ctx.refuseWrites = true;
    expect(ctx.request((id) => callFrame(id, {}, 'c'))).toBeUndefined();
    ctx.refuseWrites = false;
    expect(ctx.request((id) => callFrame(id, {}, 'd'))).toBe(3);
    expect(ctx.written.map((w) => w.requestId)).toEqual([1, 2, 3]);
    expect(ctx.refused).toMatchObject([{ releasedId: 3, reason: 'refused', via: 'request' }]);
  });

  test('a serializer error releases the id and records nothing written', () => {
    const ctx = createFakeCtx();
    expect(() => ctx.request((id) => callFrame(id, {}, 'p', [[10n]]))).toThrow(TypeError);
    expect(ctx.written).toEqual([]);
    expect(ctx.failed).toHaveLength(1);
    expect(ctx.request((id) => callFrame(id, {}, 'p'))).toBe(1);
  });

  prop.prop([fc.integer({ min: 0, max: 2 ** 31 }), fc.integer({ min: 1, max: 50 })])(
    'random ids are 53-bit, unique among ids in use, and deterministic per seed',
    (seed, n) => {
      const a = createFakeCtx({ ids: 'random', seed });
      const b = createFakeCtx({ ids: 'random', seed });
      const ids = Array.from({ length: n }, () => a.request((id) => callFrame(id, {}, 'p')));
      const same = Array.from({ length: n }, () => b.request((id) => callFrame(id, {}, 'p')));
      expect(ids).toEqual(same);
      expect(new Set(ids).size).toBe(n);
      for (const id of ids) {
        expect(Number.isSafeInteger(id) || id === 2 ** 53).toBe(true);
        expect(id).toBeGreaterThanOrEqual(1);
        expect(id).toBeLessThanOrEqual(2 ** 53);
      }
    },
  );

  test('scripted ids skip ids that are in flight elsewhere', () => {
    const ctx = createFakeCtx({ ids: [5, 6, 7, 8], inFlight: () => [6] });
    expect(ctx.request((id) => callFrame(id, {}, 'a'))).toBe(5);
    expect(ctx.request((id) => callFrame(id, {}, 'b'))).toBe(7);
    expect(() => ctx.request((id) => callFrame(id, {}, 'c'))).not.toThrow();
    expect(() => ctx.request((id) => callFrame(id, {}, 'd'))).toThrow(/exhausted/);
  });

  test('expectsReply defaults to true and is recorded', () => {
    const ctx = createFakeCtx();
    ctx.request((id) => publishFrame(id, {}, 't'), false);
    ctx.request((id) => subscribeFrame(id, {}, 't'));
    expect(ctx.written.map((w) => w.expectsReply)).toEqual([false, true]);
  });
});

describe('writes', () => {
  test('send records frames without an id; the gate closes for good', () => {
    const ctx = createFakeCtx();
    expect(ctx.send(cancelFrame(7))).toBe(true);
    expect(ctx.frames(MessageType.CANCEL)).toEqual([[49, 7, { mode: 'killnowait' }]]);
    expect(ctx.written[0]).toMatchObject({ via: 'send', requestId: undefined, data: '[49,7,{"mode":"killnowait"}]' });
    ctx.closeGate();
    expect(ctx.send(cancelFrame(8))).toBe(false);
    expect(ctx.request((id) => callFrame(id, {}, 'p'))).toBeUndefined();
    expect(ctx.refused.map((r) => r.reason)).toEqual(['gate-closed', 'gate-closed']);
    expect(ctx.isGateOpen).toBe(false);
  });

  test('frames over the size limit throw payload_size_exceeded; nothing is written', () => {
    const ctx = createFakeCtx({ maxFrameBytes: 64 });
    expect(() => ctx.send(callFrame(1, {}, 'p', [['x'.repeat(100)]]))).toThrow(Uri.PAYLOAD_SIZE_EXCEEDED);
    let thrown: unknown;
    try {
      ctx.request((id) => callFrame(id, {}, 'p', [['é'.repeat(40)]])); // 80 UTF-8 bytes > 64
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ uri: Uri.PAYLOAD_SIZE_EXCEEDED });
    expect(ctx.written).toEqual([]);
  });

  test('injected failures: once, persistent, by predicate', () => {
    const ctx = createFakeCtx();
    const boom = new Error('boom');
    ctx.failNextWrite(boom);
    expect(() => ctx.send(cancelFrame(1))).toThrow(boom);
    expect(ctx.send(cancelFrame(1))).toBe(true);
    ctx.failWrites(
      () => serializerError(),
      (frame) => frame[0] === MessageType.PUBLISH,
    );
    expect(() => ctx.request((id) => publishFrame(id, {}, 't'))).toThrow(TypeError);
    expect(ctx.request((id) => callFrame(id, {}, 'p'))).toBe(1);
    ctx.clearWriteFailures();
    expect(ctx.request((id) => publishFrame(id, {}, 't'))).toBe(2);
    expect(sizeError(10, 5)).toMatchObject({ uri: Uri.PAYLOAD_SIZE_EXCEEDED, args: [10, 5] });
  });
});

describe('deliveries and logs', () => {
  test('deliveries run on demand, FIFO, including ones queued while running', () => {
    const fx = createFakeEffects();
    const order: string[] = [];
    fx.deliver(() => {
      order.push('a');
      fx.deliver(() => order.push('c'));
    });
    fx.deliver(() => order.push('b'));
    expect(order).toEqual([]);
    expect(fx.runDeliveries()).toBe(3);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('a throwing delivery does not stop the queue; the first throw is rethrown after draining', () => {
    const fx = createFakeEffects();
    const ran: number[] = [];
    fx.deliver(() => {
      throw new Error('first');
    });
    fx.deliver(() => ran.push(2));
    expect(() => fx.runDeliveries()).toThrow('first');
    expect(ran).toEqual([2]);
    fx.deliver(() => {
      throw new Error('second');
    });
    expect(fx.runDeliveries({ rethrow: false })).toBe(1);
    expect(fx.deliveryErrors).toHaveLength(2);
  });

  test('log entries are lazy: built only with a custom logger', () => {
    let built = 0;
    const entry = () => {
      built++;
      return { level: 'debug', event: 'frame.dropped', message: 'x' } as const;
    };
    const quiet = createFakeEffects({ customLogger: false });
    quiet.log(entry);
    expect([quiet.logCalls, quiet.logs.length, built]).toEqual([1, 0, 0]);
    const loud = createFakeEffects();
    loud.log(entry);
    expect(loud.logged('frame.dropped')).toHaveLength(1);
    expect(built).toBe(1);
  });
});

describe('timers', () => {
  test('fire on demand through the bound participant; cancelled and cleared timers never fire', () => {
    const ctx = createFakeCtx();
    const fired: number[] = [];
    ctx.bindTimers('topic', {
      timer: (key: number, c: SessionCtx) => {
        expect(c).toBe(ctx);
        fired.push(key);
      },
    });
    const t1 = ctx.timer(1000, 'topic', 1, true);
    ctx.timer(1000, 'topic', 2);
    expect(ctx.armedTimers('topic').map((t) => [t.key, t.gen, t.deadline])).toEqual([
      [1, 1, true],
      [2, 2, false],
    ]);
    t1.cancel();
    expect(ctx.fire(ctx.timers[0]!)).toBe(false);
    expect(ctx.fire(ctx.timers[1]!)).toBe(true);
    expect(ctx.fire(ctx.timers[1]!)).toBe(false); // a timer fires once
    ctx.timer(10, 'topic', 3);
    ctx.endSession();
    expect(ctx.advance(100)).toBe(0);
    expect(fired).toEqual([2]);
  });

  test('advance fires due timers in (due, arming) order, including timers armed while firing', () => {
    const ctx = createFakeCtx({ now: 100 });
    const log: [number, number][] = [];
    ctx.bindTimers('register', {
      timer: (key) => {
        log.push([key, ctx.now]);
        if (key === 1) ctx.timer(5, 'register', 4);
      },
    });
    ctx.timer(30, 'register', 3);
    ctx.timer(10, 'register', 1);
    ctx.timer(10, 'register', 2);
    expect(ctx.advance(20)).toBe(3);
    expect(log).toEqual([
      [1, 110],
      [2, 110],
      [4, 115],
    ]);
    expect(ctx.now).toBe(120);
    expect(ctx.advance(10)).toBe(1);
    expect(log.at(-1)).toEqual([3, 130]);
  });

  test('a firing timer of an unbound owner is a test bug', () => {
    const ctx = createFakeCtx();
    ctx.timer(1, 'call', 1);
    expect(() => ctx.advance(1)).toThrow(/no timer target/);
  });
});

describe('verifyAlive and violation', () => {
  test('verdicts are recorded and settled on demand', () => {
    const ctx = createFakeCtx({ now: 50 });
    const ran: string[] = [];
    ctx.verifyAlive(10, () => ran.push('a'));
    ctx.verifyAlive(20, () => ran.push('b'));
    expect(ran).toEqual([]);
    expect(ctx.resolveVerdicts('alive')).toBe(2);
    expect(ran).toEqual(['a', 'b']);
    ctx.verifyAlive(30, () => ran.push('c'));
    expect(ctx.resolveVerdicts('dead')).toBe(1);
    expect(ran).toEqual(['a', 'b']);
    expect(ctx.verdicts.map((v) => [v.since, v.state])).toEqual([
      [10, 'alive'],
      [20, 'alive'],
      [30, 'dead'],
    ]);
  });

  test('violations are recorded', () => {
    const ctx = createFakeCtx();
    ctx.violation('bad', [99]);
    expect(ctx.violations).toEqual([{ message: 'bad', frame: [99] }]);
  });
});

describe('builders', () => {
  test('session defaults and overrides', () => {
    expect(createFakeCtx().session).toEqual({ id: 1, realm: 'realm1', details: {} });
    const ctx = createFakeCtx({ connId: 3, session: { id: 77, details: { authid: 'a' } } });
    expect([ctx.connId, ctx.session.id, ctx.session.details.authid]).toEqual([3, 77, 'a']);
    expect(Object.isFrozen(ctx.session)).toBe(true);
  });

  test('op records carry snapshots and recording subscribers', () => {
    const c = fakeCallOp({ procedure: 'p', options: { receive_progress: true } });
    expect([c.kind, c.snap.progressive]).toEqual(['call', true]);
    const p = fakePublishOp({ topic: 't', options: { acknowledge: true } });
    expect(p.snap.ack).toBe(true);
    const t1 = fakeTopicOp({ topic: 't', options: { match: 'prefix', b: 1, a: 2 } });
    const t2 = fakeTopicOp({ topic: 't', options: { a: 2, b: 1, match: 'prefix' } });
    expect(t1.snap.key).toBe(t2.snap.key);
    expect(t1.snap.group).toBe('tprefix');
    expect(t2.seq).toBeGreaterThan(t1.seq);
    const r = fakeRegisterOp({ procedure: 'p' });
    expect(r.snap.handler({} as never)).toBeUndefined();
  });

  test('FakeSubscriber enforces the grammar', () => {
    const s = new FakeSubscriber<number>();
    s.next(1);
    s.complete();
    s.next(2);
    s.error(new Error('late'));
    expect(s.notifications).toEqual([{ kind: 'next', value: 1 }, { kind: 'complete' }]);
    expect([s.values, s.completed, s.closed]).toEqual([[1], true, true]);
    const u = new FakeSubscriber<number>();
    u.unsubscribe();
    u.next(1);
    expect(u.notifications).toEqual([]);
  });

  test('EndInfo: Lost while retrying, Closed{gaveUp, cause: Lost} on give-up; calls recorded', () => {
    const retry = fakeEndInfo();
    expect(retry.inflightError({ requestId: 4, procedure: 'p' })).toMatchObject({
      code: 'connection_lost',
      requestId: 4,
      procedure: 'p',
    });
    const giveUp = fakeEndInfo({ willRetry: false });
    const error = giveUp.inflightError({ topic: 't' });
    expect(error).toMatchObject({ code: 'connection_closed', gaveUp: true, topic: 't' });
    expect(error.cause).toMatchObject({ code: 'connection_lost' });
    expect(giveUp.info.willRetry).toBe(false);
    expect(giveUp.calls).toEqual([{ topic: 't' }]);
  });

  test('inbound messages', () => {
    expect(inbound.result(5, [1])).toEqual({ type: 50, requestId: 5, details: {}, args: [1], kwargs: {} });
    expect(inbound.error(48, 5, Uri.NO_SUCH_PROCEDURE)).toMatchObject({ type: 8, requestType: 48, requestId: 5 });
    expect(inbound.subscriptionRevoked(9, 'gone')).toMatchObject({ type: 35, revocation: true, subscriptionId: 9 });
    expect(inbound.unregistered(3)).toEqual({ type: 67, revocation: false, requestId: 3 });
    const invalid = inbound.invalid(inbound.event(1, 2, ['x']));
    expect(invalid.args).toEqual([]);
    expect(invalid.invalid?.reason).toBeTypeOf('string');
    expect(inbound.interrupt(4, { mode: 'kill' }).options).toEqual({ mode: 'kill' });
  });
});
