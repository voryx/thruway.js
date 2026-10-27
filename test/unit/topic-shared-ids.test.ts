// Router subscription ids: Crossbar-style brokers return the session's existing subscription id for a repeated
// SUBSCRIBE of one topic + match, and one UNSUBSCRIBE removes the session from it; Thruway PHP and fox-wamp give every
// SUBSCRIBE a new id; Bondy kills the connection (1011) for an UNSUBSCRIBE of an id it does not know. The
// deferred-UNSUBSCRIBE races are reproduced one by one, then a property drives random interleavings against a small
// broker of each kind and checks, after the run settles, that every live local gets each event exactly once and that no
// router subscription is leaked.
import { fc } from '@fast-check/vitest';
import { describe, expect, test, vi } from 'vitest';
import type { TopicOp } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import {
  subscribeFrame,
  unsubscribeFrame,
  type InboundMessage,
  type OutboundFrame,
} from '../../src/protocol/messages.js';
import { TopicParticipant } from '../../src/ops/topic.js';
import type { EventMessage } from '../../src/types.js';
import { snapshotTopic } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
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

describe('Crossbar-style shared subscription ids', () => {
  test('two keys of one topic share the router id: each EVENT reaches both; the last one out UNSUBSCRIBEs once', () => {
    const { topic, ctx } = setup();
    const plain = local('t');
    const retained = local('t', { get_retained: true }); // another key, same topic + match
    topic.start(plain, ctx, ctx);
    topic.start(retained, ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't'), subscribeFrame(2, { get_retained: true }, 't')]);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.inbound(inbound.subscribed(2, 7), ctx);
    topic.inbound(inbound.event(7, 1, ['e']), ctx);
    ctx.runDeliveries();
    expect(plain.subscriber.values).toHaveLength(1);
    expect(retained.subscriber.values).toHaveLength(1);
    topic.stop(plain, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]); // the other key still uses id 7
    topic.inbound(inbound.event(7, 2, ['f']), ctx);
    ctx.runDeliveries();
    expect(retained.subscriber.values).toHaveLength(2);
    topic.stop(retained, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 7)]);
  });

  test('scenario 1: the last local of A leaves while B (same topic + match) is pending ⇒ UNSUBSCRIBE deferred', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    const b = local('t', { get_retained: true });
    topic.start(b, ctx, ctx);
    topic.stop(a, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]); // the router may be about to answer B with id 7
    topic.inbound(inbound.subscribed(2, 7), ctx); // it does: B now uses 7, nothing is unsubscribed
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    topic.inbound(inbound.event(7, 1, ['alive']), ctx);
    ctx.runDeliveries();
    expect(b.subscriber.values).toEqual([{ args: ['alive'], kwargs: {}, details: {} }]);
  });

  test('a deferred UNSUBSCRIBE is written once the pending SUBSCRIBE got another id (Thruway-style answer)', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    const b = local('t', { get_retained: true });
    topic.start(b, ctx, ctx);
    topic.stop(a, ctx, ctx);
    topic.inbound(inbound.subscribed(2, 8), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 7)]);
  });

  test('a deferred UNSUBSCRIBE waits for every pending SUBSCRIBE of its group, and is written after an ERROR too', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    const b = local('t', { get_retained: true });
    const c = local('t', { x_custom: 1 });
    const other = local('t', { match: 'prefix' }); // another group: not a reason to wait
    topic.start(b, ctx, ctx);
    topic.start(c, ctx, ctx);
    topic.start(other, ctx, ctx);
    topic.stop(a, ctx, ctx);
    topic.inbound(inbound.subscribed(2, 9), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]); // c is still pending
    topic.inbound(inbound.error(MessageType.SUBSCRIBE, 3, Uri.NOT_AUTHORIZED), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(5, 7)]);
  });

  test('a late SUBSCRIBE of the group keeps the UNSUBSCRIBE deferred until it is forgotten (lazily)', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.start(local('t', { get_retained: true }), ctx, ctx);
    topic.stop(a, ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive'); // the late key may still be answered with id 7
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    ctx.advance(TIMEOUT);
    topic.inbound(inbound.event(7, 1), ctx); // the next access forgets the late SUBSCRIBE
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 7)]);
  });

  test('a late SUBSCRIBE that has expired by the time the last local leaves does not defer its UNSUBSCRIBE', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.start(local('t', { get_retained: true }), ctx, ctx); // never answered (Thruway PHP T4 style)
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive'); // late until TIMEOUT later
    ctx.advance(TIMEOUT);
    topic.stop(a, ctx, ctx); // the stop itself forgets the expired late SUBSCRIBE first
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 7)]);
    expect(topic.sizes()).toMatchObject({ keys: 0, locals: 0, late: 0, deferred: 0, routerIds: 0 });
  });

  test('{} and {match: "exact"} are one key ⇒ one SUBSCRIBE; the second spelling cannot race the first', () => {
    const { topic, ctx } = setup();
    const a = local('t', {});
    const b = local('t', { match: 'exact', get_retained: false, exclude_me: false });
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.start(b, ctx, ctx);
    topic.stop(a, ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't')]);
    topic.inbound(inbound.event(7, 1, ['x']), ctx);
    ctx.runDeliveries();
    expect(b.subscriber.values).toHaveLength(1);
  });

  test('scenario 2: a late SUBSCRIBED while a retry is pending is not UNSUBSCRIBEd if the retry adopts it', () => {
    const { topic, ctx } = setup();
    const first = local('t');
    topic.start(first, ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.runDeliveries();
    expect(first.subscriber.errors).toHaveLength(1);
    const retry = local('t'); // the app's retry: same key, adopts the late SUBSCRIBE
    topic.start(retry, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(1);
    topic.inbound(inbound.event(7, 1), ctx);
    ctx.runDeliveries();
    expect(retry.subscriber.values).toHaveLength(1);
  });

  test('a late, unadopted SUBSCRIBED whose id another key uses is not UNSUBSCRIBEd', () => {
    const { topic, ctx } = setup();
    topic.start(local('t', { get_retained: true }), ctx, ctx); // request 1: will be late
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    const b = local('t');
    topic.start(b, ctx, ctx); // request 2
    topic.inbound(inbound.subscribed(2, 7), ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx); // the late answer, same id
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    topic.inbound(inbound.event(7, 1), ctx);
    ctx.runDeliveries();
    expect(b.subscriber.values).toHaveLength(1);
  });

  test('a SUBSCRIBED returning the id whose UNSUBSCRIBE is in flight ⇒ SUBSCRIBE again once that is answered', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.stop(a, ctx, ctx); // UNSUBSCRIBE(7) is request 2
    const b = local('t');
    const c = local('t');
    topic.start(b, ctx, ctx); // a new key for 't': request 3
    topic.start(c, ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't'), unsubscribeFrame(2, 7), subscribeFrame(3, {}, 't')]);
    topic.inbound(inbound.subscribed(3, 7), ctx); // the router answered with 7 before it dropped it
    expect(topic.inbound(inbound.event(7, 1), ctx)).toBe(false); // not mapped: 7 is about to go away
    topic.stop(c, ctx, ctx); // a local may leave meanwhile; the key keeps waiting for b
    topic.inbound(inbound.unsubscribed(2), ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(4, {}, 't'));
    topic.inbound(inbound.subscribed(4, 7), ctx);
    topic.inbound(inbound.event(7, 2, ['ok']), ctx);
    ctx.runDeliveries();
    expect(b.subscriber.values).toEqual([{ args: ['ok'], kwargs: {}, details: {} }]);
    expect(c.subscriber.values).toEqual([]);
  });

  test('a re-subscription waiting on an UNSUBSCRIBE: its locals may all leave (deleted), or the UNSUBSCRIBE fail', () => {
    for (const answer of ['error', 'timeout'] as const) {
      const { topic, ctx } = setup();
      const a = local('t');
      topic.start(a, ctx, ctx);
      topic.inbound(inbound.subscribed(1, 7), ctx);
      topic.stop(a, ctx, ctx);
      const gone = local('t');
      topic.start(gone, ctx, ctx);
      const u = local('u');
      topic.start(u, ctx, ctx); // request 4
      topic.inbound(inbound.subscribed(4, 8), ctx);
      topic.stop(u, ctx, ctx); // UNSUBSCRIBE(8) is request 5
      const waiting = local('u');
      topic.start(waiting, ctx, ctx); // request 6
      topic.inbound(inbound.subscribed(3, 7), ctx);
      topic.inbound(inbound.subscribed(6, 8), ctx);
      topic.stop(gone, ctx, ctx);
      if (answer === 'error') {
        topic.inbound(inbound.error(MessageType.UNSUBSCRIBE, 2, Uri.NO_SUCH_SUBSCRIPTION), ctx);
        expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(4); // 'u' waits for its own UNSUBSCRIBE (8)
        topic.inbound(inbound.error(MessageType.UNSUBSCRIBE, 5, Uri.NO_SUCH_SUBSCRIPTION), ctx);
      } else {
        ctx.advance(TIMEOUT);
        ctx.resolveVerdicts('alive');
      }
      // 't' lost its last local while waiting: nothing more; 'u' subscribes again
      expect(ctx.frames(MessageType.SUBSCRIBE).slice(4)).toEqual([subscribeFrame(7, {}, 'u')]);
    }
  });

  test('a re-subscription waiting on an UNSUBSCRIBE stays findable: a local joining it waits for the answer too', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.stop(a, ctx, ctx); // UNSUBSCRIBE(7): request 2
    const b = local('t');
    topic.start(b, ctx, ctx); // request 3
    topic.inbound(inbound.subscribed(3, 7), ctx); // waits for request 2
    topic.stop(b, ctx, ctx); // its last local leaves …
    const c = local('t');
    topic.start(c, ctx, ctx); // … and another joins before the UNSUBSCRIBE is answered
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(2);
    topic.inbound(inbound.unsubscribed(2), ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(4, {}, 't'));
  });

  test('a re-subscription that lost its locals is deleted at the answer; the next local subscribes anew', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.stop(a, ctx, ctx);
    const b = local('t');
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(3, 7), ctx);
    topic.stop(b, ctx, ctx);
    topic.inbound(inbound.unsubscribed(2), ctx);
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(2);
    topic.start(local('t'), ctx, ctx);
    expect(ctx.lastFrame()).toEqual(subscribeFrame(4, {}, 't'));
  });

  test('a deferred id that the SUBSCRIBED of a key without locals UNSUBSCRIBEs is unsubscribed once', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    const b = local('t', { get_retained: true });
    topic.start(b, ctx, ctx);
    topic.stop(a, ctx, ctx); // deferred: b is pending
    topic.stop(b, ctx, ctx); // b's key waits for its answer
    topic.inbound(inbound.subscribed(2, 7), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 7)]);
  });

  test('scenario 3 (StrictMode): mount, unmount, mount in one tick ⇒ one SUBSCRIBE; the key stays findable', () => {
    const { topic, ctx } = setup();
    const first = local('t');
    topic.start(first, ctx, ctx);
    topic.stop(first, ctx, ctx);
    const second = local('t');
    topic.start(second, ctx, ctx);
    expect(ctx.frames()).toEqual([subscribeFrame(1, {}, 't')]);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
    topic.inbound(inbound.event(7, 1), ctx);
    ctx.runDeliveries();
    expect(second.subscriber.values).toHaveLength(1);
    expect(first.subscriber.values).toEqual([]);
  });

  test('a revoked id that was waiting for a deferred UNSUBSCRIBE is never UNSUBSCRIBEd (Bondy would close 1011)', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    topic.start(a, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 7), ctx);
    topic.start(local('t', { get_retained: true }), ctx, ctx);
    topic.stop(a, ctx, ctx); // deferred
    expect(topic.inbound(inbound.subscriptionRevoked(7), ctx)).toBe(true);
    topic.inbound(inbound.subscribed(2, 8), ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([]);
  });
});

describe('Thruway-style ids: a new id for every SUBSCRIBE', () => {
  test('two keys of one topic get two ids: each local gets the events of its own key once', () => {
    const { topic, ctx } = setup();
    const plain = local('t');
    const retained = local('t', { get_retained: true });
    topic.start(plain, ctx, ctx);
    topic.start(retained, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 11), ctx);
    topic.inbound(inbound.subscribed(2, 12), ctx);
    // the router sends one copy per subscription
    topic.inbound(inbound.event(11, 1, ['e']), ctx);
    topic.inbound(inbound.event(12, 1, ['e']), ctx);
    ctx.runDeliveries();
    expect(plain.subscriber.values).toHaveLength(1);
    expect(retained.subscriber.values).toHaveLength(1);
    topic.stop(plain, ctx, ctx);
    expect(ctx.frames(MessageType.UNSUBSCRIBE)).toEqual([unsubscribeFrame(3, 11)]);
  });

  test('two local subscribers of one key ⇒ one SUBSCRIBE and one EVENT each', () => {
    const { topic, ctx } = setup();
    const a = local('t');
    const b = local('t');
    topic.start(a, ctx, ctx);
    topic.start(b, ctx, ctx);
    topic.inbound(inbound.subscribed(1, 11), ctx);
    topic.inbound(inbound.event(11, 1), ctx);
    ctx.runDeliveries();
    expect(ctx.frames(MessageType.SUBSCRIBE)).toHaveLength(1);
    expect([a.subscriber.values.length, b.subscriber.values.length]).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property: random interleavings against a small broker of each kind
// ---------------------------------------------------------------------------------------------------------------------

type Mode = 'crossbar' | 'thruway' | 'bondy';

/** A broker for one client session. `crossbar`: one id per topic + match, shared by repeated SUBSCRIBEs, removed by one
 *  UNSUBSCRIBE (other sessions may keep the id alive: `shared`); `thruway`/`bondy`: a new id per SUBSCRIBE. */
class Broker {
  readonly inbox: OutboundFrame[] = [];
  readonly outbox: InboundMessage[] = [];
  /** This session's subscriptions: id → topic + match. */
  readonly subs = new Map<number, { readonly topic: string; readonly group: string }>();
  readonly violations: string[] = [];
  private readonly global = new Map<string, number>();
  private nextId = 100;
  private nextPublication = 1;
  constructor(
    readonly mode: Mode,
    readonly shared: ReadonlySet<string>,
  ) {}

  /** Process one request: the oldest, or (`pick`) any — a broker that answers some requests asynchronously (Crossbar's
   *  authorizer) may effectively handle a later request first. */
  process(pick?: number): boolean {
    if (this.inbox.length === 0) return false;
    const [frame] = this.inbox.splice(pick === undefined ? 0 : pick % this.inbox.length, 1) as [OutboundFrame];
    if (frame[0] === MessageType.SUBSCRIBE) {
      const [, requestId, options, topic] = frame;
      const match = typeof options['match'] === 'string' ? options['match'] : 'exact';
      const group = `${topic} ${match}`;
      let id: number;
      if (this.mode === 'crossbar') {
        id = this.global.get(group) ?? this.nextId++;
        this.global.set(group, id);
      } else {
        id = this.nextId++;
      }
      this.subs.set(id, { topic, group });
      this.outbox.push(inbound.subscribed(requestId, id));
    } else if (frame[0] === MessageType.UNSUBSCRIBE) {
      const [, requestId, id] = frame;
      const sub = this.subs.get(id);
      if (sub === undefined) {
        this.violations.push(`UNSUBSCRIBE of unknown id ${String(id)} (${this.mode})`);
        this.outbox.push(inbound.error(MessageType.UNSUBSCRIBE, requestId, Uri.NO_SUCH_SUBSCRIPTION));
      } else {
        this.subs.delete(id);
        if (!this.shared.has(sub.group)) this.global.delete(sub.group);
        this.outbox.push(inbound.unsubscribed(requestId));
      }
    } else {
      this.violations.push(`unexpected frame ${JSON.stringify(frame)}`);
    }
    return true;
  }

  publish(topic: string): void {
    const publication = this.nextPublication++;
    for (const [id, sub] of this.subs) if (sub.topic === topic) this.outbox.push(inbound.event(id, publication));
  }

  /** The session ended: its subscriptions are gone. */
  drop(): void {
    this.inbox.length = 0;
    this.outbox.length = 0;
    for (const sub of this.subs.values()) if (!this.shared.has(sub.group)) this.global.delete(sub.group);
    this.subs.clear();
  }
}

const VARIANTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['t', {}],
  ['t', { match: 'exact' }], // the same key as {}
  ['t', { get_retained: true }], // another key, same group
  ['t', { match: 'prefix' }], // another group
  ['u', {}],
];

type Command =
  | { readonly kind: 'subscribe'; readonly variant: number }
  | { readonly kind: 'unsubscribe'; readonly index: number }
  | { readonly kind: 'router'; readonly count: number; readonly pick: number }
  | { readonly kind: 'deliver'; readonly count: number }
  | { readonly kind: 'publish'; readonly topic: string }
  | { readonly kind: 'drop' };

/** Commands over the first `variants` entries of VARIANTS (fewer variants: more collisions on one key and group). */
const commands = (variants: number): fc.Arbitrary<Command[]> =>
  fc.array(command(variants), { maxLength: 60, size: 'max' });
const command = (variants: number): fc.Arbitrary<Command> =>
  fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('subscribe'), variant: fc.nat(variants - 1) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('unsubscribe'), index: fc.nat() }) },
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant('router'), count: fc.integer({ min: 1, max: 3 }), pick: fc.nat() }),
    },
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant('deliver'), count: fc.integer({ min: 1, max: 3 }) }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('publish'), topic: fc.constantFrom('t', 'u') }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'drop' as const }) },
  );

/** `reorder`: the broker handles requests in any order (an asynchronous authorizer may finish a later request first);
 *  its answers still arrive in the order it sent them (one ordered connection). */
function run(mode: Mode, reorder: boolean, shared: boolean, commands: readonly Command[]): void {
  const broker = new Broker(mode, new Set(shared ? ['t exact', 'u exact', 't prefix'] : []));
  const topic = new TopicParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
  const live: Local[] = [];
  const ended: FakeSessionCtx[] = [];
  let connId = 1;
  let ctx = createFakeCtx({ connId });
  let seen = 0;
  /** SUBSCRIBEs written and not yet answered (request id → key), this session. */
  const outstanding = new Map<number, string>();
  /** Subscription ids the client received in this session, and those it is unsubscribing. */
  const received = new Set<number>();
  const unsubscribing = new Set<number>();
  const keyOf = (frame: OutboundFrame): string => snapshotTopic(frame[3], frame[2]).key;

  const collect = (): void => {
    for (; seen < ctx.written.length; seen++) {
      const frame = ctx.written[seen]!.frame;
      if (frame[0] === MessageType.SUBSCRIBE) {
        const key = keyOf(frame);
        expect([...outstanding.values()], 'two outstanding SUBSCRIBEs for one key').not.toContain(key);
        outstanding.set(frame[1], key);
      } else if (frame[0] === MessageType.UNSUBSCRIBE) {
        expect(received.has(frame[2]), 'UNSUBSCRIBE of an id not received in this session').toBe(true);
        expect(unsubscribing.has(frame[2]), 'two UNSUBSCRIBEs in flight for one id').toBe(false);
        unsubscribing.add(frame[2]);
      }
      broker.inbox.push(frame);
    }
  };
  const deliver = (msg: InboundMessage): boolean => {
    if (msg.type === MessageType.SUBSCRIBED) {
      outstanding.delete(msg.requestId);
      received.add(msg.subscriptionId);
    }
    const consumed = topic.inbound(msg, ctx);
    if (msg.type === MessageType.UNSUBSCRIBED || msg.type === MessageType.ERROR) {
      for (const w of ctx.written) {
        if (w.frame[0] === MessageType.UNSUBSCRIBE && w.frame[1] === msg.requestId) unsubscribing.delete(w.frame[2]);
      }
    }
    ctx.runDeliveries();
    collect();
    return consumed;
  };
  const begin = (): void => {
    ctx = createFakeCtx({ connId, session: { id: connId } });
    seen = 0;
    outstanding.clear();
    received.clear();
    unsubscribing.clear();
    topic.welcome(ctx);
    collect();
  };
  begin();

  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'subscribe': {
        const [name, options] = VARIANTS[cmd.variant]!;
        const op = local(name, options);
        live.push(op);
        topic.start(op, ctx, ctx);
        collect();
        break;
      }
      case 'unsubscribe': {
        if (live.length === 0) break;
        const [op] = live.splice(cmd.index % live.length, 1);
        op!.subscriber.unsubscribe();
        topic.stop(op!, ctx, ctx);
        collect();
        break;
      }
      case 'router':
        for (let i = 0; i < cmd.count; i++) broker.process(reorder ? cmd.pick + i : undefined);
        break;
      case 'deliver':
        for (let i = 0; i < cmd.count && broker.outbox.length > 0; i++) {
          deliver(broker.outbox.shift()!);
        }
        break;
      case 'publish':
        broker.publish(cmd.topic);
        break;
      case 'drop':
        ctx.endSession();
        ended.push(ctx);
        topic.sessionEnded(fakeEndInfo(), createFakeEffects());
        broker.drop();
        connId++;
        begin();
        break;
    }
  }

  // settle: the router answers everything, every answer is delivered
  for (;;) {
    while (broker.process());
    const msg = broker.outbox.shift();
    if (msg === undefined) break;
    deliver(msg);
  }
  ctx.runDeliveries();
  expect(broker.violations).toEqual([]);
  expect([...topic.pendingIds()]).toEqual([]);
  // nothing was ever written into an ended session (no frame for a dead op)
  for (const old of ended) expect(old.refused).toEqual([]);
  // no interest ever errored or completed: no router error, no timeout, no revocation in this model
  for (const op of live) expect(op.subscriber.errors).toEqual([]);

  // a final publication per topic: every EVENT is consumed (no leaked router subscription), each live local of a key
  // on that topic gets exactly one copy
  for (const name of ['t', 'u']) {
    const before = live.map((op) => op.subscriber.values.length);
    broker.publish(name);
    for (let msg = broker.outbox.shift(); msg !== undefined; msg = broker.outbox.shift()) {
      expect(deliver(msg), `EVENT for a leaked subscription in ${mode}`).toBe(true);
    }
    live.forEach((op, i) => {
      const expected = op.snap.topic === name ? 1 : 0;
      expect(op.subscriber.values.length - before[i]!).toBe(expected);
    });
  }
  // every router subscription serves a live key
  const liveGroups = new Set(live.map((op) => op.snap.group));
  for (const sub of broker.subs.values()) expect(liveGroups.has(sub.group)).toBe(true);
  // no leak (INV-R10): one key per live key, nothing pending, deferred or late
  expect(topic.sizes()).toMatchObject({
    keys: new Set(live.map((op) => op.snap.key)).size,
    locals: live.length,
    requests: 0,
    late: 0,
    deferred: 0,
  });
}

describe('property: random interleavings of subscribe/unsubscribe/answers/session drops', () => {
  test.each(['crossbar', 'thruway', 'bondy'] as const)(
    '%s broker: exactly-once events, no leak, no bad UNSUBSCRIBE',
    (mode) => {
      fc.assert(
        fc.property(fc.boolean(), fc.boolean(), commands(VARIANTS.length), (reorder, shared, list) => {
          run(mode, reorder, shared, list);
        }),
        replayParameters(),
      );
    },
  );

  test.each(['crossbar', 'thruway'] as const)(
    '%s broker, one topic, requests handled out of order: the same guarantees',
    (mode) => {
      fc.assert(
        fc.property(fc.boolean(), commands(2), (shared, list) => {
          run(mode, true, shared, list);
        }),
        replayParameters(),
      );
    },
  );

  test('a known tricky schedule: shared id kept alive by other sessions, unsubscribe and re-subscribe interleaved', () => {
    run('crossbar', false, true, [
      { kind: 'subscribe', variant: 0 },
      { kind: 'router', count: 1, pick: 0 },
      { kind: 'deliver', count: 1 },
      { kind: 'unsubscribe', index: 0 },
      { kind: 'subscribe', variant: 2 },
      { kind: 'subscribe', variant: 1 },
      { kind: 'router', count: 3, pick: 0 },
      { kind: 'deliver', count: 3 },
    ]);
    run('crossbar', true, false, [
      { kind: 'subscribe', variant: 0 },
      { kind: 'router', count: 1, pick: 0 },
      { kind: 'deliver', count: 1 },
      { kind: 'unsubscribe', index: 0 },
      { kind: 'subscribe', variant: 0 },
      { kind: 'router', count: 1, pick: 1 }, // the later SUBSCRIBE is handled first (the session still holds the id) …
      { kind: 'router', count: 1, pick: 0 }, // … then the UNSUBSCRIBE removes the session from it
      { kind: 'deliver', count: 2 }, // SUBSCRIBED(id) arrives while UNSUBSCRIBE(id) is in flight
    ]);
  });
});
