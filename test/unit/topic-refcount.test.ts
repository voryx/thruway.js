// Local refcounting of topic keys: one router subscription per key whatever the number of local subscribers; the last
// one out unsubscribes; StrictMode mount/unmount/mount in one tick joins the pending SUBSCRIBE. A property drives
// random interleavings (subscribe, unsubscribe, router answers, never-answered SUBSCRIBEs, request timeouts with either
// verdict, session drops, close) and checks the refcount invariants on every frame written.
import { fc } from '@fast-check/vitest';
import { describe, expect, test, vi } from 'vitest';
import type { TopicOp } from '../../src/core/contracts.js';
import { isThruwayError } from '../../src/errors.js';
import { MessageType } from '../../src/protocol/codes.js';
import { subscribeFrame, unsubscribeFrame, type InboundMessage } from '../../src/protocol/messages.js';
import { TopicParticipant } from '../../src/ops/topic.js';
import type { EventMessage } from '../../src/types.js';
import { snapshotTopic } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeStopError,
  fakeTopicOp,
  inbound,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

// The properties generate up to 60 commands per run (`size: 'max'`: fast-check's default size caps arrays at 10). The
// time budget scales with FC_NUM_RUNS: 2 ms per run and property, never below the default 5 s.
vi.setConfig({ testTimeout: Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 2) });

const TIMEOUT = 60000;
type Local = TopicOp & { readonly subscriber: FakeSubscriber<EventMessage> };

function local(topic: string, options?: Record<string, unknown>): Local {
  return fakeTopicOp(snapshotTopic(topic, options));
}

function setup(): { readonly topic: TopicParticipant; readonly ctx: FakeSessionCtx } {
  const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
  const ctx = createFakeCtx();
  ctx.bindTimers('topic', topic);
  topic.welcome(ctx);
  return { topic, ctx };
}

describe('refcounting', () => {
  test('n locals of one key ⇒ one SUBSCRIBE; only the last one out writes UNSUBSCRIBE, once', () => {
    const { topic, ctx } = setup();
    const locals = [local('t'), local('t'), local('t', { match: 'exact' })];
    for (const op of locals) topic.start(op, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    for (const op of locals.slice(0, 2)) topic.stop(op, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    topic.stop(locals[2]!, ctx, ctx);
    topic.stop(locals[2]!, ctx, ctx); // a second stop of the same op: a no-op
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(2, 5)]);
  });

  test('StrictMode: subscribe, unsubscribe, subscribe in one tick ⇒ exactly one SUBSCRIBE', () => {
    const { topic, ctx } = setup();
    const mount1 = local('t');
    topic.start(mount1, ctx, ctx);
    topic.stop(mount1, ctx, ctx);
    const mount2 = local('t');
    topic.start(mount2, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    topic.inbound(inbound.event(5, 1, ['x']), ctx);
    ctx.runDeliveries();
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't')]);
    expect(mount2.subscriber.values).toHaveLength(1);
  });

  test('switchMap re-keying: leaving an active key and joining again before UNSUBSCRIBED ⇒ ordered UNSUB, SUB', () => {
    const { topic, ctx } = setup();
    const first = local('t');
    topic.start(first, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 5), ctx);
    topic.stop(first, ctx, ctx);
    const second = local('t');
    topic.start(second, ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't'), unsubscribeFrame(2, 5), subscribeFrame(3, {}, 't')]);
    topic.inbound(inbound.unsubscribed(2), ctx);
    topic.inbound(inbound.subscribed(3, 6), ctx);
    topic.inbound(inbound.event(6, 1), ctx);
    ctx.runDeliveries();
    expect(second.subscriber.values).toHaveLength(1);
  });

  test('the same subscriber unsubscribing while its key is dormant, then the key re-established for the others', () => {
    const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const fx = createFakeEffects();
    const a = local('t');
    const b = local('t');
    topic.start(a, undefined, fx);
    topic.start(b, undefined, fx);
    topic.stop(a, undefined, fx);
    const ctx = createFakeCtx();
    topic.welcome(ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't')]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------------------------------------

const VARIANTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['t', {}],
  ['t', { get_retained: true }],
  ['u', {}],
  ['w', { match: 'wildcard' }], // never answered (Thruway PHP T4)
];

type Command =
  | { readonly kind: 'subscribe'; readonly variant: number }
  | { readonly kind: 'unsubscribe'; readonly index: number }
  | { readonly kind: 'answer'; readonly count: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'verdicts'; readonly alive: boolean }
  | { readonly kind: 'drop' };

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('subscribe'), variant: fc.nat(VARIANTS.length - 1) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('unsubscribe'), index: fc.nat() }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('answer'), count: fc.integer({ min: 1, max: 3 }) }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('advance'), ms: fc.constantFrom(1, 1000, TIMEOUT / 2, TIMEOUT) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('verdicts'), alive: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'drop' as const }) },
);

function run(commands: readonly Command[]): void {
  const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
  const live: Local[] = []; // subscribed and not unsubscribed by the app (may have errored)
  const ended: FakeSessionCtx[] = [];
  let connId = 1;
  let now = 0;
  let ctx = createFakeCtx({ connId });
  let seen = 0;
  /** Raw error calls per op (the fake subscriber enforces the grammar, so a second call would otherwise vanish). */
  const errorCalls = new Map<Local, number>();
  let nextSubscription = 100;
  const outbox: InboundMessage[] = [];
  /** This session's SUBSCRIBEs not answered yet: request id → key, write time. */
  const outstanding = new Map<number, { readonly key: string; readonly at: number }>();
  /** Subscription id → key, from the SUBSCRIBED answers delivered in this session. */
  const subscriptionKey = new Map<number, string>();
  const liveKeys = (): Set<string> => new Set(live.filter((op) => !op.subscriber.closed).map((op) => op.snap.key));

  const collect = (): void => {
    for (; seen < ctx.written.length; seen++) {
      const frame = ctx.written[seen]!.frame;
      if (frame[0] === MessageType.SUBSCRIBE) {
        const key = snapshotTopic(frame[3], frame[2]).key;
        expect(liveKeys().has(key), 'SUBSCRIBE for a key without a live local').toBe(true);
        for (const other of outstanding.values()) {
          // a late SUBSCRIBE is forgotten `request` ms after its timeout: only then may the key be subscribed again
          if (other.key === key)
            expect(now - other.at, 'two outstanding SUBSCRIBEs for one key').toBeGreaterThanOrEqual(2 * TIMEOUT);
        }
        outstanding.set(frame[1], { key, at: now });
        if (frame[3] !== 'w') outbox.push(inbound.subscribed(frame[1], nextSubscription++));
      } else if (frame[0] === MessageType.UNSUBSCRIBE) {
        const key = subscriptionKey.get(frame[2]);
        expect(key, 'UNSUBSCRIBE of an id not received in this session').toBeDefined();
        // refcount: no live local of that key may be served by the id (Thruway-style ids: one key per id)
        const served = live.some((op) => !op.subscriber.closed && op.snap.key === key && servedBy(op) === frame[2]);
        expect(served, 'UNSUBSCRIBE while a live local uses the subscription').toBe(false);
        outbox.push(inbound.unsubscribed(frame[1]));
      }
    }
  };
  /** Which subscription id currently serves `op` (from the participant's behaviour: the last SUBSCRIBED of its key). */
  const serving = new Map<string, number>();
  const servedBy = (op: Local): number | undefined => serving.get(op.snap.key);

  const begin = (): void => {
    ctx = createFakeCtx({ connId, session: { id: connId }, now });
    ctx.bindTimers('topic', topic);
    seen = 0;
    outbox.length = 0;
    outstanding.clear();
    subscriptionKey.clear();
    serving.clear();
    topic.welcome(ctx);
    collect();
  };
  begin();
  const drop = (): void => {
    ctx.endSession();
    ended.push(ctx);
    topic.sessionEnded(fakeEndInfo(), createFakeEffects());
    connId++;
    begin();
    // keys without locals (left while pending, late) did not survive the session end
    expect(topic.sizes().keys, 'keys after a session end').toBe(liveKeys().size);
  };

  const step = (): void => {
    ctx.runDeliveries();
    collect();
    // no leak (INV-R10): the participant holds exactly the live locals that have not errored
    expect(topic.sizes().locals, 'locals held by the participant').toBe(
      live.filter((op) => !op.subscriber.closed).length,
    );
  };
  const answer = (): boolean => {
    const msg = outbox.shift();
    if (msg === undefined) return false;
    if (msg.type === MessageType.SUBSCRIBED) {
      const key = outstanding.get(msg.requestId)!.key;
      outstanding.delete(msg.requestId);
      subscriptionKey.set(msg.subscriptionId, key);
      serving.set(key, msg.subscriptionId);
    }
    topic.inbound(msg, ctx);
    return true;
  };

  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'subscribe': {
        const [name, options] = VARIANTS[cmd.variant]!;
        const op = local(name, options);
        const error = op.subscriber.error.bind(op.subscriber);
        op.subscriber.error = (e: unknown): void => {
          errorCalls.set(op, (errorCalls.get(op) ?? 0) + 1);
          error(e);
        };
        live.push(op);
        topic.start(op, ctx, ctx);
        break;
      }
      case 'unsubscribe': {
        if (live.length === 0) break;
        const [op] = live.splice(cmd.index % live.length, 1);
        op!.subscriber.unsubscribe();
        topic.stop(op!, ctx, ctx);
        // the last live local of its key left: that key's subscription id serves nobody any more (a later local of the
        // key is served by the answer to its own SUBSCRIBE, or by the pending one it joins), so an UNSUBSCRIBE of the
        // old id written in a later step (e.g. a deferred one, flushed by that local's start) is no refcount violation
        if (!live.some((other) => !other.subscriber.closed && other.snap.key === op!.snap.key)) {
          serving.delete(op!.snap.key);
        }
        break;
      }
      case 'answer':
        for (let i = 0; i < cmd.count && answer(); i++);
        break;
      case 'advance':
        now += cmd.ms;
        ctx.advance(cmd.ms);
        break;
      case 'verdicts':
        // a failed probe ends the session: the records go dormant instead of erroring
        if (ctx.resolveVerdicts(cmd.alive ? 'alive' : 'dead') > 0 && !cmd.alive) drop();
        break;
      case 'drop':
        drop();
        break;
    }
    step();
  }
  // heal: the router answers everything it ever answers, and the request timers of the rest run out against a live
  // router; then every live local that has not errored is served (INV-ESTABLISH, INV-EVENT): one EVENT on every
  // subscription id the client was given reaches it exactly once
  for (let round = 0; round < 10; round++) {
    while (answer());
    step();
    if (ctx.armedTimers('topic').length === 0 && ctx.verdicts.every((v) => v.state !== 'pending')) break;
    now += TIMEOUT;
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    step();
  }
  expect(outbox, 'unanswered frames after healing').toEqual([]);
  const received = live.map((op) => op.subscriber.values.length);
  for (const id of new Set(serving.values())) topic.inbound(inbound.event(id, 1), ctx);
  ctx.runDeliveries();
  live.forEach((op, i) => {
    if (!op.subscriber.closed) expect(op.subscriber.values.length - received[i]!, 'a live local served').toBe(1);
  });
  for (const old of ended) expect(old.refused, 'a write into an ended session').toEqual([]);
  // the only error an interest can see before close is a request timeout the router was proven alive for
  for (const op of live) {
    for (const error of op.subscriber.errors) expect(error).toMatchObject({ name: 'TimeoutError', timer: 'request' });
  }
  // close: every live local that has not errored errors the close error, exactly once
  const fx = createFakeEffects();
  topic.clientClosed(fakeStopError({ gaveUp: true }), fx);
  fx.runDeliveries();
  for (const op of live) {
    expect(op.subscriber.notifications.filter((n) => n.kind !== 'next')).toHaveLength(1);
    expect(isThruwayError(op.subscriber.errors[0])).toBe(true);
  }
  for (const calls of errorCalls.values()) expect(calls, 'an interest errored twice').toBeLessThanOrEqual(1);
  expect([...topic.pendingIds()]).toEqual([]);
  expect(topic.sizes()).toEqual({ keys: 0, locals: 0, requests: 0, late: 0, routerIds: 0, deferred: 0 });
}

describe('property: refcounts over random interleavings', () => {
  test('never a SUBSCRIBE without a live local, never two per key, never an UNSUBSCRIBE in use, no dead writes', () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 60, size: 'max' }), (commands) => {
        run(commands);
      }),
      replayParameters(),
    );
  });
});
