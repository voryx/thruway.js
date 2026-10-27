// TopicParticipant: every rule of the topic participant against fake-ctx — dormant without a session, SUBSCRIBE at
// WELCOME (FIFO by first local), events per local, router errors and payload-invalid frames, request timers verified
// against liveness, late keys (adoption, expiry, cap), UNSUBSCRIBE and its answers, revocation, session end / close,
// write outcomes (not sent, serializer and size errors). Shared router ids and the deferred-UNSUBSCRIBE races are in
// topic-shared-ids.test.ts, local refcounting in topic-refcount.test.ts.
import { describe, expect, test } from 'vitest';
import type { TopicOp } from '../../src/core/contracts.js';
import { isThruwayError, isWampError, WampError } from '../../src/errors.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { subscribeFrame, unsubscribeFrame } from '../../src/protocol/messages.js';
import { LATE_LIMIT, TopicParticipant } from '../../src/ops/topic.js';
import type { EventMessage } from '../../src/types.js';
import { snapshotTopic } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeStopError,
  fakeTopicOp,
  inbound,
  nextSeq,
  serializerError,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';

const TIMEOUT = 60000;

type Local = TopicOp & { readonly subscriber: FakeSubscriber<EventMessage> };

/** A topic op with the real key/group of validate.ts (`{}` ≡ `{match: 'exact'}`). */
function local(topic: string, options?: Record<string, unknown>, seq: number = nextSeq()): Local {
  return fakeTopicOp(snapshotTopic(topic, options), seq);
}

function setup(): { readonly topic: TopicParticipant; readonly ctx: FakeSessionCtx } {
  const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
  const ctx = createFakeCtx({ inFlight: () => topic.pendingIds() });
  ctx.bindTimers('topic', topic);
  topic.welcome(ctx);
  return { topic, ctx };
}

/** A new session (connection `connId`) for `topic`. */
function nextSession(topic: TopicParticipant, connId: number): FakeSessionCtx {
  const ctx = createFakeCtx({ connId, session: { id: connId }, inFlight: () => topic.pendingIds() });
  ctx.bindTimers('topic', topic);
  topic.welcome(ctx);
  return ctx;
}

function endSession(topic: TopicParticipant, ctx: FakeSessionCtx): void {
  ctx.endSession();
  topic.sessionEnded(fakeEndInfo(), createFakeEffects());
}

describe('dormant without a session, SUBSCRIBE at WELCOME', () => {
  test('start without a session writes nothing and emits nothing; WELCOME SUBSCRIBEs once per key, FIFO', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const fx = createFakeEffects();
    const b = local('com.b', { match: 'prefix' }, 10);
    const a1 = local('com.a', {}, 11);
    const a2 = local('com.a', { match: 'exact' }, 12); // the same key as a1
    const c = local('com.c', undefined, 5);
    for (const op of [b, a1, a2, c]) topic.start(op, undefined, fx);
    expect(fx.pendingDeliveries).toHaveLength(0);
    expect([...topic.pendingIds()]).toEqual([]);
    const ctx = createFakeCtx();
    topic.welcome(ctx);
    expect(ctx.frames()).toEqual([
      subscribeFrame(1, {}, 'com.c'),
      subscribeFrame(2, { match: 'prefix' }, 'com.b'),
      subscribeFrame(3, {}, 'com.a'),
    ]);
    expect(ctx.armedTimers('topic').map((t) => [t.key, t.ms, t.deadline])).toEqual([
      [1, TIMEOUT, true],
      [2, TIMEOUT, true],
      [3, TIMEOUT, true],
    ]);
    expect([...topic.pendingIds()]).toEqual([1, 2, 3]);
    topic.welcome(ctx); // idempotent within a session
    expect(ctx.frames()).toHaveLength(3);
  });

  test('a local that leaves before the WELCOME is forgotten (nothing written)', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const op = local('com.a');
    topic.start(op, undefined, createFakeEffects());
    topic.stop(op, undefined, createFakeEffects());
    const ctx = createFakeCtx();
    topic.welcome(ctx);
    expect(ctx.frames()).toEqual([]);
  });

  test('start with a session writes SUBSCRIBE [32, id, options, topic] with the snapshot options', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.a', { get_retained: true, match: 'prefix' }), ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, { get_retained: true, match: 'prefix' }, 'com.a')]);
    expect(ctx.written[0]!.expectsReply).toBe(true);
  });

  test('a start with a ctx before any WELCOME was reported establishes that session', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const ctx = createFakeCtx();
    topic.start(local('com.a'), ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 'com.a')]);
  });

  test('starting the same op twice is ignored', () => {
    const { topic, ctx } = setup();
    const op = local('com.a');
    topic.start(op, ctx, ctx);
    topic.start(op, ctx, ctx);
    expect(ctx.frames()).toHaveLength(1);
  });
});

describe('SUBSCRIBED and EVENT', () => {
  test('every local of the key gets each EVENT, after the step, as a frozen {args, kwargs, details}', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx); // joins the pending SUBSCRIBE
    expect(ctx.frames()).toHaveLength(1);
    expect(topic.inbound(inbound.subscribed(1, 900), ctx)).toBe(true);
    expect(ctx.armedTimers('topic')).toEqual([]);
    expect([...topic.pendingIds()]).toEqual([]);
    const details = Object.freeze({ publisher: 7 });
    expect(topic.inbound(inbound.event(900, 1, [1, 2], { k: 'v' }, details), ctx)).toBe(true);
    expect(a.subscriber.values).toEqual([]);
    expect(ctx.runDeliveries()).toBe(2);
    const event = a.subscriber.values[0]!;
    expect(event).toEqual({ args: [1, 2], kwargs: { k: 'v' }, details: { publisher: 7 } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(b.subscriber.values).toEqual([event]);
    expect(event.details).toBe(details); // received payloads are not copied
  });

  test('a local that joins an active key writes nothing and gets the next EVENT (no retained replay)', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.a', { get_retained: true }), ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    const late = local('com.a', { get_retained: true });
    topic.start(late, ctx, ctx);
    expect(ctx.frames()).toHaveLength(1);
    topic.inbound(inbound.event(5, 2, ['x']), ctx);
    ctx.runDeliveries();
    expect(late.subscriber.values).toEqual([{ args: ['x'], kwargs: {}, details: {} }]);
  });

  test('an observer that throws does not keep the event from the other locals (one delivery each)', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    a.subscriber.next = () => {
      throw new Error('observer bug');
    };
    topic.inbound(inbound.event(5, 1, ['x']), ctx);
    ctx.runDeliveries({ rethrow: false });
    expect(ctx.deliveryErrors).toEqual([new Error('observer bug')]);
    expect(b.subscriber.values).toHaveLength(1);
  });

  test('a local that unsubscribed before the delivery ran receives nothing', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    topic.inbound(inbound.event(5, 1, ['x']), ctx);
    a.subscriber.unsubscribe();
    topic.stop(a, ctx, ctx);
    ctx.runDeliveries();
    expect(a.subscriber.values).toEqual([]);
    expect(b.subscriber.values).toHaveLength(1);
  });

  test('unknown subscription ids and duplicate SUBSCRIBED are not consumed; an unknown request id is withdrawn', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.a'), ctx, ctx);
    expect(topic.inbound(inbound.event(5, 1), ctx)).toBe(false);
    // the answer to a SUBSCRIBE given up on is withdrawn, once no SUBSCRIBE is pending (Crossbar may reuse the id)
    expect(topic.inbound(inbound.subscribed(99, 6), ctx)).toBe(true);
    expect(topic.inbound(inbound.subscribed(99, 6), ctx)).toBe(false);
    expect(topic.inbound(inbound.subscribed(98, 0), ctx)).toBe(false); // id 0: nothing an UNSUBSCRIBE may name
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    expect(topic.inbound(inbound.subscribed(1, 5), ctx)).toBe(true);
    expect(topic.inbound(inbound.subscribed(1, 5), ctx)).toBe(false); // duplicate
    expect(topic.inbound(inbound.unsubscribed(1), ctx)).toBe(false);
    expect(topic.inbound(inbound.error(MessageType.SUBSCRIBE, 1, Uri.NOT_AUTHORIZED), ctx)).toBe(false);
    expect(topic.inbound(inbound.error(MessageType.UNSUBSCRIBE, 1, Uri.NOT_AUTHORIZED), ctx)).toBe(false);
    expect(ctx.pendingDeliveries).toEqual([]);
  });

  test('frames routed to other participants are not consumed', () => {
    const { topic, ctx } = setup();
    expect(topic.inbound(inbound.registered(1, 2), ctx)).toBe(false);
    expect(topic.inbound(inbound.result(1), ctx)).toBe(false);
    expect(topic.inbound(inbound.error(MessageType.CALL, 1, Uri.CANCELED), ctx)).toBe(false);
    expect(topic.inbound(inbound.error(MessageType.REGISTER, 1, Uri.CANCELED), ctx)).toBe(false);
  });

  test('a payload-invalid EVENT is dropped with a warn frame.dropped entry; the subscription continues', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    expect(
      topic.inbound(inbound.invalid(inbound.event(5, 1, ['x']), 'args is not an array', '[36,5,1,{},{}]'), ctx),
    ).toBe(true);
    expect(ctx.pendingDeliveries).toEqual([]);
    expect(ctx.logged('frame.dropped')).toEqual([
      {
        level: 'warn',
        event: 'frame.dropped',
        message: 'EVENT dropped: invalid payload (args is not an array)',
        data: { subscriptionId: 5, frame: '[36,5,1,{},{}]' },
      },
    ]);
    topic.inbound(inbound.event(5, 2, ['ok']), ctx);
    ctx.runDeliveries();
    expect(a.subscriber.values).toEqual([{ args: ['ok'], kwargs: {}, details: {} }]);
  });
});

describe('router errors (ERROR(32))', () => {
  test('ERROR(32) errors every local with WampError{uri, args, kwargs, details, topic, requestId, sessionId}', () => {
    const { topic, ctx } = setup();
    const a = local('com.secret');
    const b = local('com.secret');
    const other = local('com.other');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.start(other, ctx, ctx);
    const details = { reason: 'denied' };
    expect(topic.inbound(inbound.error(32, 1, Uri.NOT_AUTHORIZED, ['no'], { why: 1 }, details), ctx)).toBe(true);
    expect([...topic.pendingIds()]).toEqual([2]);
    ctx.runDeliveries();
    const error = a.subscriber.errors[0] as WampError;
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({
      uri: Uri.NOT_AUTHORIZED,
      args: ['no'],
      kwargs: { why: 1 },
      details,
      topic: 'com.secret',
      requestId: 1,
      sessionId: 1,
    });
    expect(b.subscriber.errors).toEqual([error]);
    expect(other.subscriber.notifications).toEqual([]);
    // the key is gone: a new local subscribes again
    topic.start(local('com.secret'), ctx, ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(3, {}, 'com.secret'));
    topic.stop(a, ctx, ctx); // the errored local's teardown: a no-op
    expect(ctx.frames()).toHaveLength(3);
  });

  test('a payload-invalid ERROR(32) errors the locals with ProtocolError{frame, topic, requestId}', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    const frame = '[8,32,1,{},"wamp.error.not_authorized",{"0":1}]';
    topic.inbound(inbound.invalid(inbound.error(32, 1, Uri.NOT_AUTHORIZED), 'args is not an array', frame), ctx);
    ctx.runDeliveries();
    expect(a.subscriber.errors[0]).toMatchObject({
      name: 'ProtocolError',
      code: 'protocol',
      frame,
      topic: 'com.a',
      requestId: 1,
      sessionId: 1,
    });
  });
});

describe('request timer: liveness verdict first', () => {
  test('router alive ⇒ every local errors TimeoutError{request}; dead ⇒ nothing (the session ends instead)', () => {
    for (const verdict of ['alive', 'dead'] as const) {
      const { topic, ctx } = setup();
      ctx.now = 500;
      const a = local('com.wild', { match: 'wildcard' });
      const b = local('com.wild', { match: 'wildcard' });
      topic.start(a, ctx, ctx);
      topic.start(b, ctx, ctx);
      expect(ctx.advance(TIMEOUT)).toBe(1);
      expect(ctx.verdicts.map((v) => v.since)).toEqual([500]);
      expect(ctx.pendingDeliveries).toEqual([]);
      ctx.resolveVerdicts(verdict);
      ctx.runDeliveries();
      if (verdict === 'dead') {
        expect(a.subscriber.notifications).toEqual([]);
        continue;
      }
      const error = a.subscriber.errors[0];
      expect(isThruwayError(error)).toBe(true);
      expect(error).toMatchObject({
        name: 'TimeoutError',
        timer: 'request',
        timeout: TIMEOUT,
        topic: 'com.wild',
        requestId: 1,
        sessionId: 1,
      });
      expect(b.subscriber.errors).toEqual([error]);
      expect([...topic.pendingIds()]).toEqual([1]); // still outstanding: late
    }
  });

  test('a late SUBSCRIBED that nobody adopted is UNSUBSCRIBEd at once', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.slow'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    expect(topic.inbound(inbound.subscribed(1, 77), ctx)).toBe(true);
    expect(ctx.lastFrame()).toEqual(unsubscribeFrame(2, 77));
    expect(topic.inbound(inbound.event(77, 1), ctx)).toBe(false);
  });

  test('a re-subscription adopts the late key (no new SUBSCRIBE) with a fresh request timer (retry)', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.slow'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.runDeliveries();
    ctx.advance(1000);
    const again = local('com.slow');
    topic.start(again, ctx, ctx);
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(1);
    expect(ctx.armedTimers('topic').map((t) => [t.key, t.armedAt, t.deadline])).toEqual([[1, TIMEOUT + 1000, true]]);
    topic.inbound(inbound.subscribed(1, 9), ctx);
    topic.inbound(inbound.event(9, 1, ['late']), ctx);
    ctx.runDeliveries();
    expect(again.subscriber.values).toEqual([{ args: ['late'], kwargs: {}, details: {} }]);
  });

  test('an adopted late key whose fresh timer also expires errors again (alive router)', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.never'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    const again = local('com.never');
    topic.start(again, ctx, ctx);
    ctx.advance(TIMEOUT);
    expect(ctx.verdicts.map((v) => v.since)).toEqual([0, 0]);
    ctx.resolveVerdicts('alive');
    ctx.runDeliveries();
    expect(again.subscriber.errors[0]).toMatchObject({ name: 'TimeoutError', topic: 'com.never' });
  });

  test('a late key expires `request` ms after its timeout (lazily): its answer is then unknown', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.never'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.advance(TIMEOUT - 1);
    topic.inbound(inbound.event(1, 1), ctx); // an access before the expiry keeps it
    expect([...topic.pendingIds()]).toEqual([1]);
    ctx.advance(1);
    expect(topic.inbound(inbound.subscribed(1, 5), ctx)).toBe(true); // its answer is now unknown: withdrawn
    expect(ctx.frames(MessageType.UNSUBSCRIBE).map((f) => f[2])).toEqual([5]);
    expect([...topic.pendingIds()]).toEqual([2]); // the UNSUBSCRIBE
    expect(ctx.logged('request.timeout')).toEqual([
      {
        level: 'debug',
        event: 'request.timeout',
        message: 'late SUBSCRIBE 1 forgotten',
        data: { requestId: 1, topic: 'com.never' },
      },
    ]);
    // the key is gone: a new local writes a new SUBSCRIBE
    topic.start(local('com.never'), ctx, ctx);
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(2);
  });

  test('the expiry is checked by start and by timers too, not only by inbound frames', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.never'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.advance(TIMEOUT);
    topic.start(local('com.never'), ctx, ctx); // not adopted: forgotten first
    expect(ctx.frames(MessageType.SUBSCRIBE)).toEqual([
      subscribeFrame(1, {}, 'com.never'),
      subscribeFrame(2, {}, 'com.never'),
    ]);

    const second = setup();
    second.topic.start(local('com.never'), second.ctx, second.ctx);
    second.topic.start(local('com.other'), second.ctx, second.ctx);
    second.topic.inbound(inbound.subscribed(2, 5), second.ctx);
    second.ctx.advance(TIMEOUT);
    second.ctx.resolveVerdicts('alive');
    second.ctx.advance(TIMEOUT);
    second.topic.timer(99, second.ctx); // any timer input
    expect([...second.topic.pendingIds()]).toEqual([]);
  });

  test('late keys are capped per session: the oldest is forgotten first', () => {
    const { topic, ctx } = setup();
    for (let i = 0; i <= LATE_LIMIT; i++) topic.start(local(`com.t${String(i)}`), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    expect([...topic.pendingIds()]).toHaveLength(LATE_LIMIT);
    expect([...topic.pendingIds()]).not.toContain(1);
    expect(topic.inbound(inbound.subscribed(1, 5), ctx)).toBe(true); // the forgotten oldest: withdrawn
    expect(topic.inbound(inbound.subscribed(2, 6), ctx)).toBe(true);
  });

  test('a verdict that arrives after the answer, or after the session ended, does nothing', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    ctx.advance(TIMEOUT);
    topic.inbound(inbound.subscribed(1, 5), ctx); // answered before the probe was
    ctx.resolveVerdicts('alive');
    expect(ctx.pendingDeliveries).toEqual([]);

    const second = setup();
    const b = local('com.b');
    second.topic.start(b, second.ctx, second.ctx);
    second.ctx.advance(TIMEOUT);
    const verdict = second.ctx.verdicts[0]!;
    endSession(second.topic, second.ctx);
    verdict.onTimeout(); // a core that ran it anyway
    expect(second.ctx.pendingDeliveries).toEqual([]);
  });

  test('a timer whose request was answered meanwhile asks nothing', () => {
    const { topic, ctx } = setup();
    topic.start(local('com.a'), ctx, ctx);
    const timer = ctx.armedTimers('topic')[0]!;
    topic.inbound(inbound.subscribed(1, 5), ctx);
    topic.timer(timer.key, ctx); // a timer input that raced the answer
    expect(ctx.verdicts).toEqual([]);
  });
});

describe('UNSUBSCRIBE', () => {
  test('the last local of an active key ⇒ UNSUBSCRIBE [34, id, subId] with a request timer', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 900), ctx);
    topic.stop(a, ctx, ctx);
    expect(ctx.frames()).toHaveLength(1);
    topic.stop(b, ctx, ctx);
    expect(ctx.lastFrame()).toEqual(unsubscribeFrame(2, 900));
    expect(ctx.armedTimers('topic').map((t) => [t.key, t.deadline])).toEqual([[2, true]]);
    expect([...topic.pendingIds()]).toEqual([2]);
    expect(topic.inbound(inbound.event(900, 1), ctx)).toBe(false); // events racing the UNSUBSCRIBE: dropped
    expect(topic.inbound(inbound.error(MessageType.CALL, 2, Uri.CANCELED), ctx)).toBe(false); // not an UNSUBSCRIBE answer
    expect(topic.inbound(inbound.unsubscribed(2), ctx)).toBe(true);
    expect([...topic.pendingIds()]).toEqual([]);
    expect(ctx.armedTimers('topic')).toEqual([]);
    expect(topic.inbound(inbound.unsubscribed(2), ctx)).toBe(false);
  });

  test('ERROR(34), also payload-invalid, ends the UNSUBSCRIBE (logged); nothing reaches the app', () => {
    for (const invalid of [false, true]) {
      const { topic, ctx } = setup();
      const a = local('com.a');
      topic.start(a, ctx, ctx);
      topic.inbound(inbound.subscribed(1, 900), ctx);
      topic.stop(a, ctx, ctx);
      const error = inbound.error(34, 2, Uri.NO_SUCH_SUBSCRIPTION);
      expect(topic.inbound(invalid ? inbound.invalid(error) : error, ctx)).toBe(true);
      expect([...topic.pendingIds()]).toEqual([]);
      expect(ctx.logged('request.error')).toMatchObject([
        { level: 'debug', data: { requestId: 2, subscriptionId: 900, error: Uri.NO_SUCH_SUBSCRIPTION } },
      ]);
      expect(ctx.pendingDeliveries).toEqual([]);
    }
  });

  test('an unanswered UNSUBSCRIBE is forgotten after the verdict (logged, warn)', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 900), ctx);
    ctx.now = 100;
    topic.stop(a, ctx, ctx);
    ctx.advance(TIMEOUT);
    expect(ctx.verdicts.map((v) => v.since)).toEqual([100]);
    ctx.resolveVerdicts('alive');
    expect([...topic.pendingIds()]).toEqual([]);
    expect(ctx.logged('request.timeout')).toMatchObject([
      { level: 'warn', data: { requestId: 2, subscriptionId: 900 } },
    ]);
    expect(topic.inbound(inbound.unsubscribed(2), ctx)).toBe(false); // late answer
  });

  test('a local that leaves while the SUBSCRIBE is pending: the key waits; on SUBSCRIBED it is UNSUBSCRIBEd', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.stop(a, ctx, ctx);
    expect(ctx.frames()).toHaveLength(1);
    topic.inbound(inbound.subscribed(1, 4), ctx);
    expect(ctx.lastFrame()).toEqual(unsubscribeFrame(2, 4));
    // the key is gone: a new local of it subscribes anew
    topic.start(local('com.a'), ctx, ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(3, {}, 'com.a'));
  });

  test('a local that leaves while its key is dormant (SUBSCRIBE not sent) is forgotten', () => {
    const { topic, ctx } = setup();
    ctx.refuseWrites = true;
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.stop(a, ctx, ctx);
    endSession(topic, ctx);
    const next = nextSession(topic, 2);
    expect(next.frames()).toEqual([]);
  });

  test('an active key without a ctx (no session) is forgotten without writing anything', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 4), ctx);
    topic.stop(a, undefined, ctx);
    expect(ctx.frames()).toHaveLength(1);
  });

  test('an UNSUBSCRIBE that cannot be written is logged and forgotten; one that is not sent writes nothing', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.b');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 4), ctx);
    topic.inbound(inbound.subscribed(2, 5), ctx);
    ctx.failNextWrite(serializerError());
    topic.stop(a, ctx, ctx);
    expect(ctx.logged('request.error')).toMatchObject([{ level: 'warn', data: { subscriptionId: 4 } }]);
    ctx.refuseWrites = true;
    topic.stop(b, ctx, ctx);
    expect([...topic.pendingIds()]).toEqual([]);
    expect(ctx.frames()).toHaveLength(2);
  });
});

describe('revocation [35, 0, {subscription, reason}]', () => {
  test('every local of every key mapped to it errors subscription_revoked; nothing is unsubscribed later', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    const other = local('com.other');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.start(other, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 40), ctx);
    topic.inbound(inbound.subscribed(2, 41), ctx);
    expect(topic.inbound(inbound.subscriptionRevoked(40, 'wamp.subscription.revoked.by_admin'), ctx)).toBe(true);
    ctx.runDeliveries();
    const error = a.subscriber.errors[0] as WampError;
    expect(error).toMatchObject({
      uri: Uri.SUBSCRIPTION_REVOKED,
      args: ['wamp.subscription.revoked.by_admin'],
      kwargs: {},
      details: { subscription: 40, reason: 'wamp.subscription.revoked.by_admin' },
      topic: 'com.a',
      sessionId: 1,
    });
    expect(b.subscriber.errors).toEqual([error]);
    expect(other.subscriber.notifications).toEqual([]);
    topic.stop(a, ctx, ctx);
    topic.stop(b, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    expect(topic.inbound(inbound.event(40, 1), ctx)).toBe(false);
    // the key is gone: subscribing again (the app's retry) writes a new SUBSCRIBE
    const again = local('com.a');
    topic.start(again, ctx, ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(3, {}, 'com.a'));
  });

  test('without a reason the error has no args; an unknown subscription is not consumed', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 40), ctx);
    expect(topic.inbound(inbound.subscriptionRevoked(41), ctx)).toBe(false);
    expect(topic.inbound(inbound.subscriptionRevoked(40), ctx)).toBe(true);
    ctx.runDeliveries();
    expect((a.subscriber.errors[0] as WampError).args).toEqual([]);
  });
});

describe('session end, re-establishment, close', () => {
  test('a session end turns keys dormant without emitting anything; the next WELCOME SUBSCRIBEs once per key', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    const c = local('com.c');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.start(c, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 900), ctx);
    endSession(topic, ctx);
    expect([...topic.pendingIds()]).toEqual([]);
    for (const op of [a, b, c]) expect(op.subscriber.notifications).toEqual([]);
    const next = nextSession(topic, 2);
    expect(next.frames()).toEqual([subscribeFrame(1, {}, 'com.a'), subscribeFrame(2, {}, 'com.c')]);
    // old ids are never touched again: no UNSUBSCRIBE for 900, its events are unknown
    expect(topic.inbound(inbound.event(900, 1), next)).toBe(false);
    topic.inbound(inbound.subscribed(1, 900), next);
    topic.inbound(inbound.event(900, 2, ['again']), next);
    next.runDeliveries();
    expect(a.subscriber.values).toEqual([{ args: ['again'], kwargs: {}, details: {} }]);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
  });

  test('keys without locals (left while pending, late) are deleted at the session end, never re-SUBSCRIBEd', () => {
    const { topic, ctx } = setup();
    const left = local('com.left');
    topic.start(left, ctx, ctx);
    topic.stop(left, ctx, ctx);
    topic.start(local('com.late'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    endSession(topic, ctx);
    expect(nextSession(topic, 2).frames()).toEqual([]);
  });

  test('a key deleted at the session end is created anew by the next local of that key, which SUBSCRIBEs', () => {
    const { topic, ctx } = setup();
    const left = local('com.left');
    topic.start(left, ctx, ctx);
    topic.stop(left, ctx, ctx);
    endSession(topic, ctx);
    const next = nextSession(topic, 2);
    const again = local('com.left');
    topic.start(again, next, next);
    expect(next.frames()).toEqual([subscribeFrame(1, {}, 'com.left')]);
  });

  test('a SUBSCRIBE that is not sent is not retried before the next WELCOME, whatever arrives meanwhile', () => {
    const { topic, ctx } = setup();
    ctx.refuseWrites = true;
    topic.start(local('com.a'), ctx, ctx);
    ctx.refuseWrites = false;
    topic.inbound(inbound.event(1, 1), ctx);
    topic.timer(1, ctx);
    expect(ctx.frames()).toEqual([]);
    expect(ctx.armedTimers('topic')).toEqual([]);
  });

  test('a SUBSCRIBE that is not sent (closing socket) keeps the key dormant until the next WELCOME', () => {
    const { topic, ctx } = setup();
    ctx.refuseWrites = true;
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    expect([...topic.pendingIds()]).toEqual([]);
    expect(ctx.refused).toHaveLength(1);
    endSession(topic, ctx);
    expect(nextSession(topic, 2).frames()).toEqual([subscribeFrame(1, {}, 'com.a')]);
    expect(a.subscriber.notifications).toEqual([]);
  });

  test('clientClosed errors every local with its own stop error (its topic); nothing is written', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.b');
    const c = local('com.c');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.start(c, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 900), ctx);
    topic.inbound(inbound.subscribed(2, 901), ctx);
    topic.stop(b, ctx, ctx); // UNSUBSCRIBE in flight
    const fx = createFakeEffects();
    const stopError = fakeStopError();
    topic.clientClosed(stopError, fx);
    fx.runDeliveries();
    expect(stopError.calls).toEqual([{ topic: 'com.a' }, { topic: 'com.c' }]);
    expect(a.subscriber.errors).toMatchObject([{ code: 'connection_closed', topic: 'com.a' }]);
    expect(c.subscriber.errors).toMatchObject([{ code: 'connection_closed', topic: 'com.c' }]);
    expect(b.subscriber.notifications).toEqual([]);
    expect([...topic.pendingIds()]).toEqual([]);
    expect(ctx.frames()).toHaveLength(4);
    topic.stop(a, undefined, fx); // teardown after close: a no-op
    // a later session starts from nothing
    expect(nextSession(topic, 2).frames()).toEqual([]);
  });

  test('clientClosed without a session (keys dormant): the next session subscribes nothing', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const fx = createFakeEffects();
    const a = local('com.a');
    topic.start(a, undefined, fx);
    topic.clientClosed(fakeStopError({ gaveUp: true }), fx);
    fx.runDeliveries();
    expect(a.subscriber.errors).toHaveLength(1);
    expect(nextSession(topic, 2).frames()).toEqual([]);
  });

  test('a ctx of a session the participant was not told about is treated as a new session', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 900), ctx);
    const other = createFakeCtx({ connId: 2, session: { id: 2 } });
    expect(topic.inbound(inbound.event(900, 1), other)).toBe(false); // the old maps are gone
    expect(other.frames()).toEqual([subscribeFrame(1, {}, 'com.a')]);
    topic.stop(a, other, other); // its key is subscribing in the new session: kept
    expect(other.frames()).toHaveLength(1);
    const b = local('com.b');
    topic.start(b, ctx, ctx); // the first ctx again: a new session once more
    topic.inbound(inbound.subscribed(2, 7), ctx);
    const third = createFakeCtx({ connId: 3, session: { id: 3 } });
    topic.stop(b, third, third); // an active key of an unknown session: dropped, nothing written to the new one
    expect(third.frames()).toEqual([]);
  });
});

describe('write failures', () => {
  test('a SUBSCRIBE that cannot be serialized or is too large errors its locals only; other keys continue', () => {
    const { topic, ctx } = setup();
    const a = local('com.a');
    const b = local('com.a');
    const huge = local('com.huge');
    ctx.failNextWrite(serializerError());
    topic.start(a, ctx, ctx);
    ctx.runDeliveries();
    expect(a.subscriber.errors).toEqual([serializerError()]);
    topic.start(b, ctx, ctx); // the key was removed: a new attempt
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 'com.a')]);
    const small = createFakeCtx({ maxFrameBytes: 10 });
    topic.start(huge, small, small);
    small.runDeliveries();
    expect(huge.subscriber.errors[0]).toMatchObject({ uri: Uri.PAYLOAD_SIZE_EXCEEDED, topic: 'com.huge' });
    expect(isWampError(huge.subscriber.errors[0])).toBe(true);
    expect(topic.sizes()).toMatchObject({ keys: 1, locals: 1 }); // the failed keys are not kept (no leak)
    // the failed key is gone for good: the next session does not SUBSCRIBE it
    endSession(topic, small);
    expect(nextSession(topic, 2).frames()).toEqual([subscribeFrame(1, {}, 'com.a')]);
  });

  test.each([
    ['frozen', () => Object.freeze(new WampError('com.serializer.refused'))],
    [
      'a Proxy whose set throws',
      () =>
        new Proxy(new WampError('com.serializer.refused'), {
          set: () => {
            throw new Error('read-only');
          },
        }),
    ],
  ])(
    'a custom serializer error that refuses the context (%s) fails only its key; start and welcome never throw',
    (_name, make) => {
      const { topic, ctx } = setup();
      const refused = make();
      const a = local('com.a');
      const b = local('com.b');
      ctx.failNextWrite(refused);
      topic.start(a, ctx, ctx); // a throw here would be a hardReset that fails every stream
      topic.start(b, ctx, ctx);
      ctx.runDeliveries();
      expect(a.subscriber.errors).toHaveLength(1);
      expect(a.subscriber.errors[0]).toBe(refused); // passed on unchanged
      expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 'com.b')]);
      // the WELCOME path: the same failure at every re-establishment would otherwise be a hardReset loop
      const c = local('com.c');
      endSession(topic, ctx);
      topic.start(c, undefined, ctx);
      const next = createFakeCtx({ connId: 2, session: { id: 2 } });
      next.failNextWrite(make(), (frame) => frame[3] === 'com.c');
      topic.welcome(next);
      next.runDeliveries();
      expect(c.subscriber.errors).toHaveLength(1);
      expect(next.frames()).toEqual([subscribeFrame(1, {}, 'com.b')]);
      expect(topic.sizes()).toMatchObject({ keys: 1, locals: 1 });
    },
  );
});

describe('pendingIds() (the allocator redraws ids in flight)', () => {
  test('a live view that can be iterated again and again, across sessions (an allocator may rescan it per redraw)', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    let ids: Iterable<number> = [];
    const ctx = createFakeCtx({ ids: [5, 5, 5, 6], inFlight: () => ids });
    topic.welcome(ctx);
    ids = topic.pendingIds(); // taken once; the fake allocator scans it again on every redraw
    topic.start(local('com.a'), ctx, ctx);
    expect([...ids]).toEqual([5]);
    expect([...ids]).toEqual([5]); // a bare Map iterator would be exhausted here
    topic.start(local('com.b'), ctx, ctx); // 5, 5 are redrawn, then 6
    expect(ctx.written.map((w) => w.requestId)).toEqual([5, 6]);
    topic.inbound(inbound.subscribed(5, 50), ctx);
    expect([...ids]).toEqual([6]);
    endSession(topic, ctx);
    expect([...ids]).toEqual([]);
    nextSession(topic, 2); // both keys are dormant again: SUBSCRIBEd in the new session
    expect([...ids]).toEqual([1, 2]);
  });
});
