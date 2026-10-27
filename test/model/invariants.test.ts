// Scenario tests of the INV-* checkers, at least two hand-written ones each: for every invariant, a scenario where
// the real client holds it (the checker finds nothing, and the scenario provably exercises what the invariant is
// about) and scenarios where a deliberately broken trace — or a broken client — is caught.
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import { ConnectionClosedError, ConnectionLostError, WampError } from '../../src/errors.js';
import { jsonSerializer } from '../../src/transport/json.js';
import type { CloseInfo, Status } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import {
  CHECKERS,
  compareR3,
  compareR8,
  INVARIANT_IDS,
  topicKey,
  type CheckOptions,
  type InvariantId,
  type InvariantViolation,
  type OpInfo,
} from '../helpers/invariants.js';
import type { FrameEvent, NotificationEvent, Trace, TraceEvent } from '../helpers/trace-types.js';

// --- helpers ------------------------------------------------------------------------------------------------------

const INTERNAL = Symbol.for('thruway.js.internal');

function harness(seed = 3, router: Parameters<typeof createHarness>[0] = {}): Harness {
  return createHarness({ seed, ...router });
}

function client(h: Harness, options: Record<string | symbol, unknown> = {}): SimClient<Client> {
  const c = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 }, ...options } });
  c.open();
  return c;
}

function check(id: InvariantId, trace: Trace, options: CheckOptions = {}): readonly InvariantViolation[] {
  return CHECKERS[id](trace, options);
}

/** A copy of `trace` with its events replaced (views recomputed). */
function rebuild(trace: Trace, events: readonly TraceEvent[]): Trace {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const only = <K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] =>
    sorted.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  return {
    source: trace.source,
    seed: trace.seed,
    events: sorted,
    frames: only('frame'),
    inputs: only('input'),
    deliveries: only('delivery'),
    notifications: only('notification'),
    observers: only('observer'),
    closeInfos: only('close-info'),
    api: only('api'),
    timers: only('timer'),
    logs: only('log'),
  };
}

function edit(trace: Trace, fn: (events: TraceEvent[]) => TraceEvent[]): Trace {
  return rebuild(trace, fn([...trace.events]));
}

type WithoutSeq<E> = E extends unknown ? Omit<E, 'seq'> : never;

/** Insert `event` right after the first event matching `where` (a fractional seq keeps the order). */
function insertAfter(trace: Trace, where: (e: TraceEvent) => boolean, event: WithoutSeq<TraceEvent>): Trace {
  const at = trace.events.find(where);
  if (at === undefined) throw new Error('insertAfter: no such event');
  return rebuild(trace, [...trace.events, { ...event, seq: at.seq + 0.5 }]);
}

const isIn =
  (type: number) =>
  (e: TraceEvent): e is FrameEvent =>
    e.kind === 'frame' && e.direction === 'in' && Array.isArray(e.frame) && e.frame[0] === type;
const isOut =
  (type: number) =>
  (e: TraceEvent): e is FrameEvent =>
    e.kind === 'frame' && e.direction === 'out' && Array.isArray(e.frame) && e.frame[0] === type;

/** A client frame written in step `stepId` on socket `connection`. */
function written(connection: number, frame: unknown[], stepId: number | undefined, at = 0): Omit<FrameEvent, 'seq'> {
  return { kind: 'frame', connection, direction: 'in', frame, at, stepId };
}

function frames(c: SimClient<Client>, type: number, direction: 'in' | 'out' = 'in'): FrameEvent[] {
  return c.trace().frames.filter((f) => f.direction === direction && Array.isArray(f.frame) && f.frame[0] === type);
}

const lastStatus = (c: SimClient<Client>): Status | undefined => c.status?.values.at(-1);

async function settle(h: Harness): Promise<void> {
  await h.closeAndSettle();
}

function codes(found: readonly InvariantViolation[]): string[] {
  return found.map((v) => v.message);
}

// --- a shared busy scenario: every checker finds nothing on a real client ----------------------------------------

describe('every checker passes a busy real-client run', () => {
  test('topics, registrations, calls, publishes, a drop, a router GOODBYE, reconnect and close()', async () => {
    const h = harness(5);
    h.router.declareTopic('com.t');
    h.router.procedure('com.ok', (args) => args[0]);
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h, {
      timeouts: { idle: 40, request: 200 },
      [INTERNAL]: { ping: 30, attemptFloor: 10, stable: 500 },
    });
    const ops = new Map<number, OpInfo>();
    await h.clock.advance(0);
    const t = c.observe('topic', 'com.t', c.client.topic('com.t'));
    ops.set(t.id, { kind: 'topic', key: topicKey('com.t', {}) });
    const r = c.observe(
      'register',
      'com.r',
      c.client.register('com.r', (inv) => inv.args[0]),
    );
    ops.set(r.id, { kind: 'register' });
    for (let i = 0; i < 3; i++) {
      const o = c.observe('call', 'com.ok', c.client.call('com.ok', [`op${String(i)}`]));
      ops.set(o.id, { kind: 'call', tag: `op${String(i)}` });
    }
    await h.clock.advance(5);
    const never = c.observe('call', 'com.never', c.client.call('com.never', ['opN']));
    ops.set(never.id, { kind: 'call', tag: 'opN' });
    h.router.publish('com.t', [1]);
    const invoked = h.router.invoke('com.r', { args: ['x'] });
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(3000);
    h.router.goodbye();
    await h.clock.advance(3000);
    c.reconnect();
    await h.clock.advance(3000);
    const p = c.observe('publish', 'com.t', c.client.publish('com.t', ['opP'], {}, { acknowledge: true }));
    ops.set(p.id, { kind: 'publish', tag: 'opP', ack: true });
    await h.clock.advance(300);
    await settle(h);
    const trace = c.trace();
    const options: CheckOptions = {
      ops,
      timings: { idle: 40, request: 200, ping: 30, attemptFloor: 10, stable: 500 },
      final: true,
    };
    for (const id of INVARIANT_IDS) expect(check(id, trace, options), id).toEqual([]);
    // the scenario did what it says
    expect(invoked.result?.args).toEqual(['x']);
    expect(never.error).toBeInstanceOf(ConnectionLostError);
    expect(t.values.length).toBeGreaterThanOrEqual(1);
    expect(c.trace().closeInfos.map((e) => e.info.initiator)).toEqual(
      expect.arrayContaining(['connection', 'router', 'app']),
    );
  });
});

// --- INV-CL01 ---------------------------------------------------------------------------------------------------

describe('INV-CL01', () => {
  test('holds: an anonymous WELCOME rejected with a single GOODBYE, then a router GOODBYE answered once', async () => {
    const h = harness(1, { router: { authenticate: () => ({ welcome: {} }) } });
    const c = client(h, { authmethods: ['ticket'], onChallenge: () => 'x' });
    await h.clock.advance(10);
    // the router welcomed anonymously: the client rejected it with GOODBYE (allowed before WELCOME, once)
    expect(frames(c, 6).map((f) => f.frame)).toContainEqual([6, {}, 'wamp.close.close_realm']);
    expect(check('INV-CL01', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches a CALL written after the client’s own GOODBYE and one before WELCOME', async () => {
    const h = harness();
    h.router.procedure('com.ok', () => 1);
    const c = client(h);
    await h.clock.advance(5);
    await settle(h);
    const trace = c.trace();
    const goodbye = trace.frames.find(isIn(6));
    expect(goodbye).toBeDefined();
    const afterEnd = insertAfter(
      trace,
      (e) => e === goodbye,
      written(goodbye!.connection, [48, 9, {}, 'com.ok'], goodbye!.stepId),
    );
    expect(codes(check('INV-CL01', afterEnd))).toEqual([expect.stringMatching(/after the client's own GOODBYE/)]);
    const hello = trace.frames.find(isIn(1))!;
    const early = insertAfter(
      trace,
      (e) => e === hello,
      written(hello.connection, [48, 9, {}, 'com.ok'], hello.stepId),
    );
    expect(codes(check('INV-CL01', early))).toEqual([expect.stringMatching(/session frame before WELCOME/)]);
  });

  test('catches a second reply to a router GOODBYE', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    h.router.goodbye('wamp.close.system_shutdown');
    await h.clock.advance(5);
    const trace = c.trace();
    const reply = trace.frames.find((e) => isIn(6)(e) && (e.frame as unknown[])[2] === 'wamp.close.goodbye_and_out')!;
    const twice = insertAfter(
      trace,
      (e) => e === reply,
      written(reply.connection, [6, {}, 'wamp.close.goodbye_and_out'], reply.stepId),
    );
    expect(codes(check('INV-CL01', twice))).toEqual([expect.stringMatching(/after the client's own GOODBYE reply/)]);
    await settle(h);
  });
});

// --- INV-CL02 ---------------------------------------------------------------------------------------------------

describe('INV-CL02', () => {
  test('holds: sequential ids 1, 2, 3 … per session, and UN*/CANCEL only for ids of their session', async () => {
    const h = harness(2, { router: { routerIds: 'per-session' } });
    h.router.declareTopic('com.t');
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h, { requestIds: 'sequential' });
    await h.clock.advance(5);
    const t = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const call = c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    t.unsubscribe();
    call.unsubscribe();
    c.connection.controls.drop();
    await h.clock.advance(3000);
    c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    const trace = c.trace();
    expect(frames(c, 34)).toHaveLength(1);
    expect(frames(c, 49)).toHaveLength(1);
    expect(check('INV-CL02', trace, { requestIds: 'sequential' })).toEqual([]);
    await settle(h);
  });

  test('catches a request id reused while its CALL is in flight, a gap in sequential ids, and stale ids', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h, { requestIds: 'sequential' });
    await h.clock.advance(5);
    c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    const trace = c.trace();
    const callFrame = trace.frames.find(isIn(48))!;
    const id = (callFrame.frame as unknown[])[1];
    const reuse = insertAfter(
      trace,
      (e) => e === callFrame,
      written(callFrame.connection, [48, id, {}, 'com.never'], callFrame.stepId),
    );
    expect(codes(check('INV-CL02', reuse))).toContainEqual(expect.stringMatching(/is still in flight/));
    const gap = insertAfter(
      trace,
      (e) => e === callFrame,
      written(callFrame.connection, [48, 7, {}, 'com.never'], callFrame.stepId),
    );
    expect(codes(check('INV-CL02', gap, { requestIds: 'sequential' }))).toContainEqual(
      expect.stringMatching(/sequential id 7/),
    );
    const stale = insertAfter(
      trace,
      (e) => e === callFrame,
      written(callFrame.connection, [34, 3, 999], callFrame.stepId),
    );
    expect(codes(check('INV-CL02', stale))).toContainEqual(
      expect.stringMatching(/UNSUBSCRIBE of a subscription id never received/),
    );
    const cancel = insertAfter(
      trace,
      (e) => e === callFrame,
      written(callFrame.connection, [49, 555, { mode: 'killnowait' }], callFrame.stepId),
    );
    expect(codes(check('INV-CL02', cancel))).toContainEqual(expect.stringMatching(/CANCEL of a CALL never written/));
    await settle(h);
  });

  test('an id received in an INVOCATION or an EVENT counts as given: one UNREGISTER/UNSUBSCRIBE of it, not two', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    h.router.sendRaw(JSON.stringify([68, 31337, 999999, {}])); // a registration the client holds no record of
    h.router.sendRaw(JSON.stringify([36, 8888, 1, {}]));
    await h.clock.advance(5);
    const trace = c.trace();
    const unregister = trace.frames.find(isIn(66))!;
    expect(unregister.frame).toEqual([66, expect.any(Number), 999999]);
    const last = trace.events.at(-1); // (after the step that processed the EVENT)
    const unsubscribe = insertAfter(
      trace,
      (e) => e === last,
      written(unregister.connection, [34, 4242, 8888], undefined),
    );
    for (const t of [trace, unsubscribe]) {
      expect(check('INV-CL02', t)).toEqual([]);
      expect(check('INV-R4', t)).toEqual([]);
    }
    const twice = insertAfter(
      trace,
      (e) => e === unregister,
      written(unregister.connection, [66, 4243, 999999], unregister.stepId),
    );
    expect(codes(check('INV-R4', twice))).toContainEqual(expect.stringMatching(/second UNSUBSCRIBE\/UNREGISTER/));
    await settle(h);
  });
});

// --- INV-R1 -----------------------------------------------------------------------------------------------------

describe('INV-R1', () => {
  test('holds: a router that refuses for 10 s, then heals: one connecting per end, open within the bound', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 1000 } });
    await h.clock.advance(10000);
    const healed = {
      seq: c.trace().events.at(-1)!.seq + 0.5,
      at: h.clock.now(),
      bound: 1000 + 10000 + 15000 + 1000 + 50,
    };
    h.router.setAvailable('ok');
    await h.clock.advance(5000);
    expect(lastStatus(c)?.state).toBe('open');
    expect(c.onClose?.values.length).toBeGreaterThan(3);
    expect(check('INV-R1', c.trace(), { final: true, healed, now: h.clock.now() })).toEqual([]);
    await settle(h);
  });

  test('catches an end not followed by connecting, a promised retry that never came, and a client that stays down', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 1000 } });
    await h.clock.advance(3000);
    const trace = c.trace();
    // drop every connecting after the first end: the next value after an end with willRetry is another end
    const firstEnd = c
      .trace()
      .notifications.find(
        (n) =>
          n.stream === 'status' &&
          (n.value as Status).state === 'closed' &&
          (n.value as { closed?: CloseInfo }).closed !== undefined,
      )!;
    const noConnecting = edit(trace, (events) =>
      events.filter(
        (e) =>
          !(
            e.kind === 'notification' &&
            e.stream === 'status' &&
            (e.value as Status).state === 'connecting' &&
            e.seq > firstEnd.seq
          ),
      ),
    );
    expect(codes(check('INV-R1', noConnecting))).toContainEqual(expect.stringMatching(/not one connecting/));
    // the trace ends long after the last end that announced a retry
    const last = c.status!.values.at(-1)!;
    expect(last.state).toBe('closed');
    expect(codes(check('INV-R1', trace, { now: h.clock.now() + 60000 }))).toContainEqual(
      expect.stringMatching(/no attempt .* announced a retry/),
    );
    // the router never heals: not open within the bound
    const healed = { seq: 1.5, at: 0, bound: 500 };
    expect(codes(check('INV-R1', trace, { final: true, healed }))).toContainEqual(
      expect.stringMatching(/not open within 500 ms/),
    );
    await settle(h);
  });

  test('after a backward clock jump, open() may wait one attempt floor from the call, not longer', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h);
    await h.clock.advance(0);
    const delay = c.onClose!.values.at(-1)!.delay!;
    expect(delay).toBeGreaterThan(1000); // the jitter of seed 3 draws a first delay above the 1 s floor
    await h.clock.advance(delay - 10);
    const skews = [{ seq: c.trace().events.at(-1)!.seq + 0.5, ms: -5000 }];
    h.clock.skew(-5000);
    c.open(); // the armed retry looks a floor away in now() terms: the client re-arms it for one floor
    await h.clock.advance(110);
    expect(lastStatus(c)?.state).toBe('closed');
    expect(check('INV-R1', c.trace(), { skews, now: h.clock.now() })).toEqual([]);
    expect(codes(check('INV-R1', c.trace(), { skews, now: h.clock.now() + 1000 }))).toContainEqual(
      expect.stringMatching(/no attempt .* announced a retry/),
    );
    await settle(h);
  });
});

// --- INV-R2 -----------------------------------------------------------------------------------------------------

describe('INV-R2', () => {
  test('holds: backoff delays in [100, maxRetryDelay], +1 attempt per failure, the attempt floor, give-up after N+1', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 2000, maxRetries: 4 } });
    await h.clock.advance(20000);
    c.open(); // from CLOSED after the give-up: floored, counter reset
    c.open();
    await h.clock.advance(5000);
    const ends = c.onClose!.values;
    expect(ends.slice(0, 5).map((i) => i.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(ends[4]?.willRetry).toBe(false);
    expect(check('INV-R2', c.trace(), { maxRetries: 4, timings: { maxRetryDelay: 2000 } })).toEqual([]);
    await settle(h);
  });

  test('catches a delay below the floor, a wrong attempt count, and an app-driven attempt inside the floor', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 2000 } });
    await h.clock.advance(5000);
    const trace = c.trace();
    const statusEnd = trace.notifications.find(
      (n) =>
        n.stream === 'status' &&
        (n.value as Status).state === 'closed' &&
        (n.value as { closed?: CloseInfo }).closed !== undefined,
    )!;
    const info = (statusEnd.value as { closed: CloseInfo }).closed;
    const forged = { ...info, delay: 50, attempt: 7 };
    const tampered = edit(trace, (events) =>
      events.map((e) =>
        e.kind === 'notification' && (e.value === info || (e.value as { closed?: unknown }).closed === info)
          ? { ...e, value: e.stream === 'status' ? { state: 'closed', closed: forged } : forged }
          : e,
      ),
    );
    const found = codes(check('INV-R2', tampered, { timings: { maxRetryDelay: 2000 } }));
    expect(found).toContainEqual(expect.stringMatching(/delay 50 outside \[100, 2000\]/));
    expect(found).toContainEqual(expect.stringMatching(/end attempt 7, expected 1/));
    await settle(h);
    // a broken client: no attempt floor, while the checker is told the default 1 s
    const h2 = harness();
    const c2 = client(h2, { [INTERNAL]: { attemptFloor: 0 } });
    await h2.clock.advance(10);
    c2.reconnect();
    await h2.clock.advance(1);
    c2.reconnect();
    await h2.clock.advance(1);
    void c2.close();
    c2.open();
    await h2.clock.advance(1);
    expect(codes(check('INV-R2', c2.trace(), { timings: { attemptFloor: 1000 } }))).toContainEqual(
      expect.stringMatching(/app-driven attempt started 1 ms after/),
    );
    await settle(h2);
  });
});

// --- INV-R3 -----------------------------------------------------------------------------------------------------

describe('INV-R3', () => {
  async function run(noise: boolean): Promise<Trace> {
    const h = harness(9);
    h.router.declareTopic('com.t');
    h.router.procedure('com.ok', () => 1);
    const c = client(h, { requestIds: 'sequential' });
    for (let round = 0; round < 3; round++) {
      await h.clock.advance(20);
      if (noise) {
        const t = c.observe('topic', 'com.t', c.client.topic('com.t'), {
          next: () => {
            throw new Error('noise');
          },
        });
        c.observe('call', 'com.ok', c.client.call('com.ok'));
        c.observe('call', 'bad', c.client.call('not a uri#'));
        h.router.publish('com.t', [1]);
        await h.clock.advance(2);
        t.unsubscribe();
      }
      h.router.drop();
      await h.clock.advance(5000);
    }
    await settle(h);
    return c.trace();
  }

  test('holds: the ends with app-stream noise equal the ends without it', async () => {
    const quiet = await run(false);
    const noisy = await run(true);
    expect(quiet.closeInfos.length).toBeGreaterThan(3);
    expect(compareR3(noisy, quiet)).toEqual([]);
    expect(check('INV-R3', noisy)).toEqual([]);
  });

  test('catches ends that differ, and an end caused by a contained internal error', async () => {
    const quiet = await run(false);
    const shorter = edit(quiet, (events) =>
      events.filter(
        (e) =>
          !(
            e.kind === 'notification' &&
            e.stream === 'status' &&
            e.seq === quiet.notifications.filter((n) => n.stream === 'status').at(-1)?.seq
          ),
      ),
    );
    expect(compareR3(shorter, quiet)).toHaveLength(1);
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    (c.faults as { inject(t: string): void }).inject('call.write');
    c.observe('call', 'com.ok', c.client.call('com.ok'));
    await h.clock.advance(5);
    expect(codes(check('INV-R3', c.trace()))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/contained internal error/),
        expect.stringMatching(/internal error logged/),
      ]),
    );
    expect(check('INV-R3', c.trace(), { faults: true })).toEqual([]);
    h.router.procedure('com.ok', () => 1);
    await settle(h);
  });
});

// --- INV-R4 -----------------------------------------------------------------------------------------------------

describe('INV-R4', () => {
  test('holds: one SUBSCRIBE/REGISTER per key at each WELCOME, one UNSUBSCRIBE, streams survive the ends', async () => {
    const h = harness(4, { router: { dialect: 'crossbar' } });
    h.router.declareTopic('com.t');
    const c = client(h);
    await h.clock.advance(5);
    const a = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const b = c.observe('topic', 'com.t', c.client.topic('com.t', { match: 'exact' })); // the same key
    const r = c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    await h.clock.advance(5);
    h.router.drop();
    await h.clock.advance(3000);
    h.router.goodbye();
    await h.clock.advance(3000);
    a.unsubscribe();
    b.unsubscribe();
    await h.clock.advance(5);
    expect(frames(c, 32)).toHaveLength(3); // one per session
    expect(frames(c, 64)).toHaveLength(3);
    expect(frames(c, 34)).toHaveLength(1);
    expect(r.closed).toBe(false);
    expect(check('INV-R4', c.trace())).toEqual([]);
    await settle(h);
  });

  test('holds: a SUBSCRIBE that cannot be serialized at a WELCOME fails its topic there, and only that topic', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    h.router.declareTopic('com.u');
    const json = jsonSerializer();
    let armed = false;
    const c = client(h, {
      serializer: {
        protocol: json.protocol,
        binary: json.binary,
        serialize: (message: unknown[]) => {
          if (armed && message[0] === 32) {
            armed = false;
            throw new Error('cannot serialize');
          }
          return json.serialize(message);
        },
        deserialize: (data: string | Uint8Array) => json.deserialize(data),
      },
    });
    await h.clock.advance(5);
    const t = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const u = c.observe('topic', 'com.u', c.client.topic('com.u'));
    await h.clock.advance(5);
    h.router.drop();
    armed = true; // the first SUBSCRIBE of the next WELCOME throws
    await h.clock.advance(3000);
    expect(lastStatus(c)?.state).toBe('open');
    expect([t.errored, u.errored]).toEqual([true, false]);
    expect((t.error as Error).message).toBe('cannot serialize');
    expect(frames(c, 32)).toHaveLength(3); // t and u in session 1, u in session 2
    expect(check('INV-R4', c.trace())).toEqual([]);
    await settle(h);
  });

  test('holds: after a SUBSCRIBE timed out across a suspend, the next subscription of its key writes a new one', async () => {
    const h = harness(4, { router: { dialect: 'thruway-php' } }); // never answers a wildcard SUBSCRIBE
    const c = client(h, { timeouts: { idle: 0, request: 300 } });
    await h.clock.advance(5);
    const key = topicKey('model..w', { match: 'wildcard' });
    const ops = new Map<number, OpInfo>();
    const first = c.observe('topic', 'model..w', c.client.topic('model..w', { match: 'wildcard' }));
    ops.set(first.id, { kind: 'topic', key });
    await h.clock.advance(0);
    const suspends = [{ seq: c.trace().events.at(-1)!.seq + 0.5, ms: 500 }];
    await h.clock.suspend(500); // the request timer fires at once on resume, no active time has passed
    expect(first.error).toMatchObject({ code: 'timeout', timer: 'request' });
    suspends.push({ seq: c.trace().events.at(-1)!.seq + 0.5, ms: 60000 });
    await h.clock.suspend(60000); // past the late-answer window: the late SUBSCRIBE is forgotten
    const second = c.observe('topic', 'model..w', c.client.topic('model..w', { match: 'wildcard' }));
    ops.set(second.id, { kind: 'topic', key });
    await h.clock.advance(0);
    expect(frames(c, 32)).toHaveLength(2);
    expect(check('INV-R4', c.trace(), { ops, suspends })).toEqual([]);
    // without the timeout in between, the second SUBSCRIBE is a duplicate
    const forged = edit(c.trace(), (events) =>
      events.filter((e) => !(e.kind === 'notification' && e.observer === first.id && e.notification === 'error')),
    );
    expect(codes(check('INV-R4', forged, { ops, suspends }))).toContainEqual(
      expect.stringMatching(/a second outstanding SUBSCRIBE/),
    );
    await settle(h);
  });

  test('catches a key missing its SUBSCRIBE at a WELCOME, a second UNSUBSCRIBE, and a stream ended by a loss', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    const c = client(h);
    await h.clock.advance(5);
    const t = c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(5);
    h.router.drop();
    await h.clock.advance(3000);
    t.unsubscribe();
    await h.clock.advance(5);
    const trace = c.trace();
    const second = trace.frames.filter(isIn(32))[1]!;
    const missing = edit(trace, (events) => events.filter((e) => e !== second));
    expect(codes(check('INV-R4', missing))).toContainEqual(expect.stringMatching(/0 SUBSCRIBEs for com.t/));
    const unsub = trace.frames.find(isIn(34))!;
    const twice = insertAfter(
      trace,
      (e) => e === unsub,
      written(unsub.connection, [34, 4242, (unsub.frame as unknown[])[2]], unsub.stepId),
    );
    expect(codes(check('INV-R4', twice))).toContainEqual(expect.stringMatching(/second UNSUBSCRIBE\/UNREGISTER/));
    const lost = edit(trace, (events) => [
      ...events,
      {
        kind: 'notification',
        seq: second.seq - 0.5,
        at: 0,
        observer: t.id,
        stream: 'topic',
        uri: 'com.t',
        notification: 'error',
        value: new ConnectionLostError({}),
        stepId: second.stepId,
      },
    ]);
    expect(codes(check('INV-R4', lost))).toContainEqual(expect.stringMatching(/ended with ConnectionLostError/));
    await settle(h);
  });

  test('holds and catches: a router ERROR or revocation ends the stream of its key only', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    h.router.declareTopic('com.u');
    h.router.deny((r) => r.type === 'subscribe' && r.uri === 'com.u');
    const c = client(h);
    await h.clock.advance(5);
    const t = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const u = c.observe('topic', 'com.u', c.client.topic('com.u'));
    const r = c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    const q = c.observe(
      'register',
      'com.q',
      c.client.register('com.q', () => 1),
    );
    await h.clock.advance(5);
    h.router.revokeRegistration('com.r');
    await h.clock.advance(5);
    expect(u.error).toMatchObject({ code: 'wamp_error', uri: 'wamp.error.not_authorized' });
    expect(r.error).toMatchObject({ code: 'wamp_error', uri: 'thruway.error.registration_revoked' });
    expect(t.closed || q.closed).toBe(false);
    const trace = c.trace();
    expect(check('INV-R4', trace)).toEqual([]);
    // the same errors delivered to the other topic and the other registration, in the steps that carried them
    const forge = (from: number, to: number, stream: 'topic' | 'register', uri: string): Trace => {
      const original = trace.notifications.find((n) => n.observer === from && n.notification === 'error')!;
      return edit(trace, (events) => [
        ...events,
        { ...original, seq: original.seq + 0.5, observer: to, stream, uri } satisfies NotificationEvent,
      ]);
    };
    for (const wrong of [forge(u.id, t.id, 'topic', 'com.t'), forge(r.id, q.id, 'register', 'com.q')]) {
      expect(codes(check('INV-R4', wrong))).toContainEqual(
        expect.stringMatching(/ended with WampError.*no router ERROR or revocation of its key/),
      );
    }
    await settle(h);
  });
});

// --- INV-R5 -----------------------------------------------------------------------------------------------------

describe('INV-R5', () => {
  test('holds: an unacknowledged PUBLISH written right before a contained fault gives up has completed', async () => {
    const h = harness();
    const c = client(h, { retryOptions: { maxRetries: 0 } });
    await h.clock.advance(5);
    (c.faults as { inject(t: string): void }).inject('liveness.wrote'); // throws after the PUBLISH is on the wire
    const p = c.observe('publish', 'com.t', c.client.publish('com.t', ['x']));
    await h.clock.advance(5);
    expect(p.completed).toBe(true);
    expect(lastStatus(c)).toMatchObject({ state: 'closed', closed: { willRetry: false } });
    expect(check('INV-R5', c.trace(), { faults: true })).toEqual([]);
    await settle(h);
  });

  test('holds: in flight at a drop ⇒ Lost in that step; waiting ⇒ written once after WELCOME; stopped ⇒ Closed at once', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    h.router.procedure('com.ok', (args) => args[0]);
    const c = client(h, { retryOptions: { maxRetryDelay: 500 } });
    const ops = new Map<number, OpInfo>();
    const waiting = c.observe('call', 'com.ok', c.client.call('com.ok', ['w']));
    ops.set(waiting.id, { kind: 'call', tag: 'w' });
    await h.clock.advance(5);
    const inflight = c.observe('call', 'com.never', c.client.call('com.never', ['f']));
    ops.set(inflight.id, { kind: 'call', tag: 'f' });
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(5);
    await c.close();
    const late = c.observe('call', 'com.ok', c.client.call('com.ok', ['s']));
    ops.set(late.id, { kind: 'call', tag: 's' });
    expect(waiting.values).toHaveLength(1);
    expect(inflight.error).toBeInstanceOf(ConnectionLostError);
    expect(late.error).toBeInstanceOf(ConnectionClosedError);
    expect(check('INV-R5', c.trace(), { ops, final: true })).toEqual([]);
    await settle(h);
  });

  test('catches an in-flight op that gets nothing at the end, an op written twice, and work started while stopped that waits', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h);
    const ops = new Map<number, OpInfo>();
    await h.clock.advance(5);
    const inflight = c.observe('call', 'com.never', c.client.call('com.never', ['f']));
    ops.set(inflight.id, { kind: 'call', tag: 'f' });
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(5);
    const trace = c.trace();
    const silenced = edit(trace, (events) =>
      events.filter((e) => !(e.kind === 'notification' && e.observer === inflight.id)),
    );
    expect(codes(check('INV-R5', silenced, { ops }))).toContainEqual(
      expect.stringMatching(/in flight at the end of socket 1 got nothing/),
    );
    const call = trace.frames.find(isIn(48))!;
    const twice = insertAfter(
      trace,
      (e) => e === call,
      written(call.connection, [48, 77, {}, 'com.never', ['f']], call.stepId),
    );
    expect(codes(check('INV-R5', twice, { ops }))).toContainEqual(expect.stringMatching(/written 2 times/));
    await settle(h);
    // work started after close() that is not failed in its own step
    const h2 = harness();
    const c2 = client(h2);
    await h2.clock.advance(5);
    const closing = c2.close();
    await h2.clock.advance(100);
    await closing;
    const started = c2.observe('call', 'com.ok', c2.client.call('com.ok', ['s']));
    expect(started.error).toBeInstanceOf(ConnectionClosedError);
    const hidden = edit(c2.trace(), (events) =>
      events.filter((e) => !(e.kind === 'notification' && e.observer === started.id)),
    );
    expect(codes(check('INV-R5', hidden))).toContainEqual(expect.stringMatching(/started while stopped/));
    await settle(h2);
  });
});

// --- INV-R6 -----------------------------------------------------------------------------------------------------

describe('INV-R6', () => {
  test('holds: every error the client delivers is typed, with context; every CloseInfo.error has its attempt', async () => {
    const h = harness();
    h.router.procedure('com.err', () => {
      throw new WampError('com.error.x');
    });
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h);
    await h.clock.advance(5);
    const err = c.observe('call', 'com.err', c.client.call('com.err'));
    const lost = c.observe('call', 'com.never', c.client.call('com.never'));
    const badUri = c.observe('call', 'bad', c.client.call('not a uri#'));
    const bad = c.observe('call', 'bad', c.client.call(42 as never));
    await h.clock.advance(5);
    h.router.abort('wamp.error.not_authorized');
    await h.clock.advance(5);
    expect(err.error).toBeInstanceOf(WampError);
    expect(lost.error).toMatchObject({
      code: 'connection_lost',
      requestId: expect.any(Number) as unknown,
      procedure: 'com.never',
    });
    expect(badUri.error).toMatchObject({ code: 'wamp_error', uri: 'wamp.error.invalid_uri' });
    expect(bad.error).toBeInstanceOf(TypeError);
    expect(c.onClose?.values[0]?.error).toMatchObject({ attempt: 1 });
    expect(check('INV-R6', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches an untyped error, a ConnectionLostError without context, and a CloseInfo.error without attempt', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h);
    await h.clock.advance(5);
    const lost = c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(5);
    const trace = c.trace();
    const replace = (value: unknown): Trace =>
      edit(trace, (events) =>
        events.map((e) => (e.kind === 'notification' && e.observer === lost.id ? { ...e, value } : e)),
      );
    expect(codes(check('INV-R6', replace(new Error('plain'))))).toContainEqual(
      expect.stringMatching(/not a typed error/),
    );
    expect(codes(check('INV-R6', replace(new ConnectionLostError({ sessionId: 1 }))))).toContainEqual(
      expect.stringMatching(/without sessionId\/requestId/),
    );
    const info = c.onClose!.values[0]!;
    const forged = { ...info, error: new ConnectionLostError({}) };
    const noAttempt = edit(trace, (events) =>
      events.map((e) =>
        e.kind === 'notification' && e.stream === 'status' && (e.value as { closed?: unknown }).closed === info
          ? { ...e, value: { state: 'closed', closed: forged } }
          : e,
      ),
    );
    expect(codes(check('INV-R6', noAttempt))).toContainEqual(expect.stringMatching(/has no attempt/));
    await settle(h);
  });
});

// --- INV-R7 -----------------------------------------------------------------------------------------------------

describe('INV-R7', () => {
  test('holds: status replays one value at once, onOpen replays iff open, one onClose per end per observer', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    const lateStatus = c.observe('status', undefined, c.client.status);
    const lateOpen = c.observe('onOpen', undefined, c.client.onOpen);
    const lateClose = c.observe('onClose', undefined, c.client.onClose);
    h.router.drop();
    await h.clock.advance(3000);
    void c.close();
    c.open();
    await h.clock.advance(3000);
    expect(lateStatus.values[0]).toMatchObject({ state: 'open' });
    expect(lateOpen.values.length).toBeGreaterThanOrEqual(2);
    expect(lateClose.values.length).toBe(2);
    expect(check('INV-R7', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches open → open, a missing onClose, a lifecycle stream that errors, and a replay while not open', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    h.router.drop();
    await h.clock.advance(3000);
    const trace = c.trace();
    const open = trace.notifications.find((n) => n.stream === 'status' && (n.value as Status).state === 'open')!;
    const twice = insertAfter(trace, (e) => e === open, { ...open, seq: 0 } as Omit<NotificationEvent, 'seq'>);
    expect(codes(check('INV-R7', twice))).toContainEqual(expect.stringMatching(/moved open → open/));
    const noClose = edit(trace, (events) =>
      events.filter((e) => !(e.kind === 'notification' && e.stream === 'onClose')),
    );
    expect(codes(check('INV-R7', noClose))).toContainEqual(expect.stringMatching(/got an end 0 times/));
    const errored = insertAfter(trace, (e) => e === open, { ...open, seq: 0, notification: 'error' } as Omit<
      NotificationEvent,
      'seq'
    >);
    expect(codes(check('INV-R7', errored))).toContainEqual(expect.stringMatching(/got error/));
    await settle(h);
  });
});

// --- INV-R8 -----------------------------------------------------------------------------------------------------

describe('INV-R8', () => {
  async function run(throwing: boolean): Promise<{ trace: Trace; peer: Trace }> {
    const h = harness(8);
    h.router.declareTopic('com.t');
    const c = client(h);
    const peer = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 } } });
    peer.open();
    await h.clock.advance(5);
    c.observe(
      'register',
      'com.thrower',
      c.client.register('com.thrower', () => {
        throw new Error('handler throws');
      }),
    );
    c.observe(
      'topic',
      'com.t',
      c.client.topic('com.t'),
      throwing
        ? {
            next: () => {
              throw new Error('observer throws');
            },
          }
        : {},
    );
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    c.observe(
      'status',
      undefined,
      c.client.status,
      throwing
        ? {
            next: () => {
              throw new Error('status observer throws');
            },
          }
        : {},
    );
    await h.clock.advance(5);
    const call = peer.observe('call', 'com.thrower', peer.client.call('com.thrower'));
    h.router.publish('com.t', [1]);
    h.router.publish('com.t', [2]);
    await h.clock.advance(5);
    expect(call.error).toMatchObject({ uri: 'wamp.error.runtime_error' });
    await settle(h);
    return { trace: c.trace(), peer: peer.trace() };
  }

  test('holds: a throwing handler answers runtime_error and stays registered; throwing observers change nobody else', async () => {
    const quiet = await run(false);
    const noisy = await run(true);
    expect(check('INV-R8', noisy.trace, { throwingHandlers: new Set(['com.thrower']) })).toEqual([]);
    // the throwing ones are topic:com.t#1 and status:undefined#2 (the harness's own status observer is #1)
    expect(compareR8(noisy.trace, quiet.trace, new Set(['topic:com.t#1', 'status:undefined#2']))).toEqual([]);
  });

  test('catches a YIELD from a throwing handler, a registration it ended, and an observer whose sequence changed', async () => {
    const { trace } = await run(false);
    const error = trace.frames.find(
      (f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 8 && f.frame[1] === 68,
    )!;
    const yielded = edit(trace, (events) =>
      events.map((e) => (e === error ? { ...error, frame: [70, (error.frame as unknown[])[2], {}, ['ok']] } : e)),
    );
    expect(codes(check('INV-R8', yielded, { throwingHandlers: new Set(['com.thrower']) }))).toContainEqual(
      expect.stringMatching(/answered YIELD/),
    );
    const other = edit(trace, (events) =>
      events.filter(
        (e) =>
          !(
            e.kind === 'notification' &&
            e.stream === 'topic' &&
            e.seq === trace.notifications.find((n) => n.stream === 'topic')?.seq
          ),
      ),
    );
    expect(compareR8(other, trace, new Set())).toHaveLength(1);
  });
});

// --- INV-R9 -----------------------------------------------------------------------------------------------------

describe('INV-R9', () => {
  test('holds: close() three times ⇒ one onClose; resolved with no timer and no frame after; open() after it works', async () => {
    const h = harness();
    const c = client(h, { timeouts: { idle: 1000 } });
    await h.clock.advance(5);
    const all = Promise.all([c.close(), c.close(), c.close()]);
    await h.clock.advance(100);
    await all;
    c.open();
    await h.clock.advance(2000);
    expect(c.onClose?.values.filter((i) => i.initiator === 'app')).toHaveLength(1);
    expect(lastStatus(c)?.state).toBe('open');
    expect(check('INV-R9', c.trace(), { final: true, healed: { seq: 0, at: 0, bound: 0 } })).toEqual([]);
    await settle(h);
  });

  test('catches two onClose for one close(), a timer left armed, and a frame after close() resolved', async () => {
    const h = harness();
    const c = client(h, { timeouts: { idle: 1000 } });
    await h.clock.advance(5);
    const p = c.close();
    await h.clock.advance(100);
    await p;
    const trace = c.trace();
    const end = trace.notifications.find((n) => n.stream === 'onClose')!;
    const statusEnd = trace.notifications.find(
      (n) => n.stream === 'status' && (n.value as Status).state === 'closed' && n.seq > 3,
    )!;
    const dup = { ...(end.value as CloseInfo) };
    const twice = edit(trace, (events) => [
      ...events,
      { ...statusEnd, seq: statusEnd.seq + 0.5, value: { state: 'closed', closed: dup } },
      { ...end, seq: end.seq + 0.5, value: dup },
    ]);
    expect(codes(check('INV-R9', twice))).toContainEqual(expect.stringMatching(/close\(\) produced 2 onClose/));
    const resolved = trace.api.find((a) => a.resolved)!;
    const armed = insertAfter(trace, (e) => e.kind === 'api' && !e.resolved, {
      kind: 'timer',
      at: 5,
      scope: 'client',
      action: 'arm',
      timerId: 999,
      delay: 5,
      due: 10,
    });
    expect(codes(check('INV-R9', armed))).toContainEqual(
      expect.stringMatching(/still pending when close\(\) resolved/),
    );
    const after = insertAfter(trace, (e) => e === resolved, written(1, [48, 1, {}, 'com.ok'], undefined));
    expect(codes(check('INV-R9', after))).toContainEqual(expect.stringMatching(/after close\(\) resolved/));
  });
});

// --- INV-R10 ----------------------------------------------------------------------------------------------------

describe('INV-R10', () => {
  test('holds: late events of released sockets change nothing', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(3000);
    const before = c.trace();
    for (const event of ['open', 'message', 'close', 'error'] as const) c.connections[0]!.controls.emitLate(event);
    const after = c.trace();
    expect(after.inputs.length).toBe(before.inputs.length);
    expect(check('INV-R10', after)).toEqual([]);
    await settle(h);
  });

  test('catches a stale socket event that wrote a frame and queued a delivery', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(3000);
    const trace = c.trace();
    const stale = { kind: 'input', at: 0, stepId: 999, input: 'ws.message', conn: 1 } as const;
    const forged = edit(trace, (events) => [
      ...events,
      { ...stale, seq: 1e6 },
      { kind: 'frame', seq: 1e6 + 1, at: 0, connection: 1, direction: 'in', frame: [48, 1, {}, 'x'], stepId: 999 },
      { kind: 'delivery', seq: 1e6 + 2, at: 0, deliveryId: 999, stepId: 999, phase: 'queued' },
    ]);
    expect(codes(check('INV-R10', forged))).toEqual([
      expect.stringMatching(/ws.message of ended connection 1 wrote 1 frame/),
    ]);
    await settle(h);
  });
});

// --- INV-ORDER --------------------------------------------------------------------------------------------------

describe('INV-ORDER', () => {
  test('holds: gate → notify → fail at a drop, and the retry fires after both', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h);
    await h.clock.advance(5);
    const call = c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(5000);
    const err = c.trace().notifications.find((n) => n.observer === call.id)!;
    const close = c.trace().notifications.find((n) => n.stream === 'onClose')!;
    expect(close.seq).toBeLessThan(err.seq);
    expect(check('INV-ORDER', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches a failure delivered before the end’s onClose and a frame after the ending step', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h);
    await h.clock.advance(5);
    const call = c.observe('call', 'com.never', c.client.call('com.never'));
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(10);
    const trace = c.trace();
    const err = trace.notifications.find((n) => n.observer === call.id)!;
    const first = trace.notifications.find((n) => n.stepId === err.stepId)!;
    const early = edit(trace, (events) => events.map((e) => (e === err ? { ...err, seq: first.seq - 0.5 } : e)));
    expect(codes(check('INV-ORDER', early))).toEqual([
      expect.stringMatching(/call failure delivered before the end's onClose/),
    ]);
    const late = edit(trace, (events) => [
      ...events,
      {
        kind: 'frame',
        seq: 1e6,
        at: 0,
        connection: 1,
        direction: 'in',
        frame: [48, 9, {}, 'x'],
        stepId: (err.stepId ?? 0) + 1,
      },
    ]);
    expect(codes(check('INV-ORDER', late))).toContainEqual(expect.stringMatching(/after the step that ended it/));
    await settle(h);
  });
});

// --- INV-INVOKE -------------------------------------------------------------------------------------------------

describe('INV-INVOKE', () => {
  test('holds: progress YIELDs only when asked, one final answer, nothing after killnowait', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    let release: (v: unknown) => void = () => undefined;
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => new Promise((r) => (release = r))),
    );
    c.observe(
      'register',
      'com.p',
      c.client.register('com.p', () => ({
        subscribe(o: { next(v: unknown): void; complete(): void }) {
          o.next(1);
          o.next(2);
          o.complete();
          return { unsubscribe: () => undefined };
        },
      })),
    );
    await h.clock.advance(5);
    const progressive = h.router.invoke('com.p', { options: { receive_progress: true } });
    const killed = h.router.invoke('com.r');
    await h.clock.advance(5);
    killed.interrupt('killnowait');
    await h.clock.advance(5);
    release(5);
    await h.clock.advance(5);
    expect(progressive.progress).toHaveLength(2);
    expect(frames(c, 70).length).toBe(3);
    expect(check('INV-INVOKE', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches a second final answer, an answer after killnowait, and unrequested progress', async () => {
    const h = harness();
    const c = client(h);
    await h.clock.advance(5);
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    await h.clock.advance(5);
    h.router.invoke('com.r');
    await h.clock.advance(5);
    const trace = c.trace();
    const yielded = trace.frames.find(isIn(70))!;
    const id = (yielded.frame as unknown[])[1];
    const twice = insertAfter(
      trace,
      (e) => e === yielded,
      written(yielded.connection, [70, id, {}, [2]], yielded.stepId),
    );
    expect(codes(check('INV-INVOKE', twice))).toEqual([expect.stringMatching(/after the final one/)]);
    const progress = edit(trace, (events) =>
      events.map((e) => (e === yielded ? { ...yielded, frame: [70, id, { progress: true }, [1]] } : e)),
    );
    expect(codes(check('INV-INVOKE', progress))).toContainEqual(
      expect.stringMatching(/progress YIELD the INVOCATION did not ask for/),
    );
    const invocation = trace.frames.find(isOut(68))!;
    const killed = edit(trace, (events) => [
      ...events,
      { ...invocation, seq: yielded.seq - 0.5, frame: [69, id, { mode: 'killnowait' }] },
    ]);
    expect(codes(check('INV-INVOKE', killed))).toContainEqual(expect.stringMatching(/after INTERRUPT killnowait/));
    await settle(h);
  });
});

// --- INV-CANCEL -------------------------------------------------------------------------------------------------

describe('INV-CANCEL', () => {
  test('holds: one CANCEL killnowait per unsubscribed CALL, none for an answered one', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    h.router.procedure('com.ok', () => 1);
    const c = client(h);
    await h.clock.advance(5);
    const never = c.observe('call', 'com.never', c.client.call('com.never'));
    const ok = c.observe('call', 'com.ok', c.client.call('com.ok'));
    await h.clock.advance(5);
    never.unsubscribe();
    ok.unsubscribe();
    never.unsubscribe();
    await h.clock.advance(5);
    expect(frames(c, 49).map((f) => (f.frame as unknown[])[2])).toEqual([{ mode: 'killnowait' }]);
    expect(check('INV-CANCEL', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches a CANCEL without killnowait, a second CANCEL, and a CANCEL after the final RESULT', async () => {
    const h = harness();
    h.router.procedure('com.never', () => new Promise(() => undefined));
    h.router.procedure('com.ok', () => 1);
    const c = client(h);
    await h.clock.advance(5);
    const never = c.observe('call', 'com.never', c.client.call('com.never'));
    c.observe('call', 'com.ok', c.client.call('com.ok'));
    await h.clock.advance(5);
    never.unsubscribe();
    await h.clock.advance(5);
    const trace = c.trace();
    const cancel = trace.frames.find(isIn(49))!;
    const id = (cancel.frame as unknown[])[1];
    const skip = edit(trace, (events) =>
      events.map((e) => (e === cancel ? { ...cancel, frame: [49, id, { mode: 'skip' }] } : e)),
    );
    expect(codes(check('INV-CANCEL', skip))).toEqual([expect.stringMatching(/without mode killnowait/)]);
    const twice = insertAfter(
      trace,
      (e) => e === cancel,
      written(cancel.connection, [49, id, { mode: 'killnowait' }], cancel.stepId),
    );
    expect(codes(check('INV-CANCEL', twice))).toEqual([expect.stringMatching(/second CANCEL/)]);
    const result = trace.frames.find(isOut(50))!;
    const okId = (result.frame as unknown[])[1];
    const afterResult = edit(trace, (events) => [
      ...events,
      { ...cancel, seq: 1e6, frame: [49, okId, { mode: 'killnowait' }], stepId: (result.stepId ?? 0) + 1 },
    ]);
    expect(codes(check('INV-CANCEL', afterResult))).toEqual([
      expect.stringMatching(/after the client processed the call's final answer/),
    ]);
    await settle(h);
  });
});

// --- INV-AUTH ---------------------------------------------------------------------------------------------------

describe('INV-AUTH', () => {
  const providers = (method: string) => [
    {
      method,
      extra: () => ({ nonce: 'n1' }),
      verify: (signature: string) => (signature === `sig|${method}|n1` ? { authid: 'joe', authrole: 'user' } : false),
    },
  ];
  const signature = (sig: string) => {
    const [, method, token] = sig.split('|');
    return method === undefined ? undefined : { method, token };
  };

  test('holds: one HELLO first, one AUTHENTICATE for the latest CHALLENGE of its round (Thruway PHP, two methods)', async () => {
    const h = harness(6, {
      router: {
        dialect: 'thruway-php',
        providers: [...providers('ticket'), ...providers('wampcra')],
      },
    });
    const c = client(h, {
      authmethods: ['ticket', 'wampcra'],
      authid: 'joe',
      onChallenge: (m: { authMethod: string; extra: Record<string, unknown> }) =>
        `sig|${m.authMethod}|${String(m.extra['nonce'])}`,
    });
    await h.clock.advance(100);
    expect(frames(c, 4, 'out')).toHaveLength(2); // one CHALLENGE per matching method
    expect(frames(c, 5)).toHaveLength(1); // answered once, for the latest
    expect(lastStatus(c)?.state).toBe('open');
    const options = {
      authmethods: ['ticket', 'wampcra'],
      signature,
      challengeToken: (e: Readonly<Record<string, unknown>>) => String(e['nonce']),
    };
    expect(check('INV-AUTH', c.trace(), options)).toEqual([]);
    await settle(h);
  });

  test('catches a second HELLO, an AUTHENTICATE without a CHALLENGE, one for an older CHALLENGE and an unoffered method', async () => {
    const h = harness(6, { router: { providers: providers('ticket') } });
    const c = client(h, {
      authmethods: ['ticket'],
      authid: 'joe',
      onChallenge: (m: { authMethod: string; extra: Record<string, unknown> }) =>
        `sig|${m.authMethod}|${String(m.extra['nonce'])}`,
    });
    await h.clock.advance(100);
    const trace = c.trace();
    const hello = trace.frames.find(isIn(1))!;
    const auth = trace.frames.find(isIn(5))!;
    const twice = insertAfter(trace, (e) => e === hello, { ...hello, seq: 0 } as Omit<FrameEvent, 'seq'>);
    expect(codes(check('INV-AUTH', twice))).toContainEqual(expect.stringMatching(/second HELLO/));
    const unasked = insertAfter(
      trace,
      (e) => e === hello,
      written(hello.connection, [5, 'sig|ticket|n1', {}], hello.stepId),
    );
    expect(codes(check('INV-AUTH', unasked))).toContainEqual(
      expect.stringMatching(/AUTHENTICATE without an unanswered CHALLENGE/),
    );
    const options = {
      authmethods: ['wampcra'],
      signature,
      challengeToken: (e: Readonly<Record<string, unknown>>) => String(e['nonce']),
    };
    const older = edit(trace, (events) =>
      events.map((e) => (e === auth ? { ...auth, frame: [5, 'sig|ticket|n0', {}] } : e)),
    );
    const found = codes(check('INV-AUTH', older, options));
    expect(found).toContainEqual(expect.stringMatching(/not the latest CHALLENGE/));
    expect(found).toContainEqual(expect.stringMatching(/"ticket", which was not offered/));
    await settle(h);
  });
});

// --- INV-ESTABLISH ----------------------------------------------------------------------------------------------

describe('INV-ESTABLISH', () => {
  test('holds: every key with locals and every registration is active or has a young request', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    const c = client(h, { timeouts: { idle: 0, request: 60000 } });
    await h.clock.advance(5);
    const unanswered = h.router.ignore((f) => f[0] === 32 && f[3] === 'com.slow');
    h.router.declareTopic('com.slow');
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    c.observe('topic', 'com.slow', c.client.topic('com.slow'));
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    await h.clock.advance(30000);
    expect(check('INV-ESTABLISH', c.trace(), { timings: { request: 60000, idle: 0 }, now: h.clock.now() })).toEqual([]);
    unanswered();
    await settle(h);
  });

  test('catches a SUBSCRIBE unanswered past the request timeout while its local is still live', async () => {
    const h = harness();
    h.router.declareTopic('com.slow');
    const c = client(h, { timeouts: { idle: 0, request: 60000 } });
    await h.clock.advance(5);
    const unanswered = h.router.ignore((f) => f[0] === 32);
    c.observe('topic', 'com.slow', c.client.topic('com.slow'));
    await h.clock.advance(30000);
    // judged as if the request timeout were 10 s: a client that never times its requests out
    expect(
      codes(check('INV-ESTABLISH', c.trace(), { timings: { request: 10000, idle: 0 }, now: h.clock.now() })),
    ).toEqual([expect.stringMatching(/its SUBSCRIBE is unanswered after 30000 ms/)]);
    unanswered();
    await settle(h);
  });

  /** A stray REGISTERED announces id 1, which the router then gives the pending REGISTER (ids from 1 per session):
   *  the client's UNREGISTER of the stray id races that REGISTER. */
  async function racedRegistration(h: Harness, held: boolean): Promise<SimClient<Client>> {
    const c = client(h, { timeouts: { idle: 0, request: 60000 } });
    await h.clock.advance(5);
    const unanswered = held ? h.router.ignore((f) => f[0] === 66) : undefined;
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    h.router.sendRaw(JSON.stringify([65, 4242, 1]));
    await h.clock.advance(held ? 30000 : 5);
    unanswered?.();
    return c;
  }

  test('holds: a REGISTERED that met the UNREGISTER of its id waits for that answer, then registers again', async () => {
    const h = harness(3, { router: { routerIds: 'per-session' }, checks: { unscripted: false } });
    const c = await racedRegistration(h, true);
    const options = { timings: { request: 60000, idle: 0 }, now: h.clock.now() };
    expect(c.trace().frames.filter(isIn(64))).toHaveLength(1); // still waiting for the UNREGISTER answer
    expect(check('INV-ESTABLISH', c.trace(), options)).toEqual([]);
    expect(codes(check('INV-ESTABLISH', c.trace(), { ...options, timings: { request: 10000, idle: 0 } }))).toEqual([
      expect.stringMatching(/register com\.r \{\}: 1 live record\(s\), 0 active, 0 pending/),
    ]);
    await settle(h);
  });

  test('holds: the UNREGISTER of a stray id, answered before the REGISTER the router then gives that id', async () => {
    const h = harness(3, { router: { routerIds: 'per-session' }, checks: { unscripted: false } });
    const c = client(h, { timeouts: { idle: 0, request: 60000 } });
    await h.clock.advance(5);
    h.router.sendRaw(JSON.stringify([65, 4242, 1]));
    await h.clock.advance(5); // UNREGISTER of registration 1, refused: the router has not issued it yet
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    await h.clock.advance(5);
    const [registered] = c.trace().frames.filter(isOut(65)).slice(-1);
    expect(registered?.frame).toEqual([65, expect.any(Number), 1]);
    expect(check('INV-ESTABLISH', c.trace(), { timings: { request: 60000, idle: 0 }, now: h.clock.now() })).toEqual([]);
    await settle(h);
  });

  test('catches a registration whose raced UNREGISTER was answered and that never registered again', async () => {
    const h = harness(3, { router: { routerIds: 'per-session' }, checks: { unscripted: false } });
    const c = await racedRegistration(h, false);
    const options = { timings: { request: 60000, idle: 0 }, now: h.clock.now() };
    expect(c.trace().frames.filter(isIn(64))).toHaveLength(2);
    expect(check('INV-ESTABLISH', c.trace(), options)).toEqual([]);
    const trace = c.trace();
    const second = trace.frames.filter(isIn(64))[1];
    const without = edit(trace, (events) => events.filter((e) => e !== second)); // the client never registers again
    expect(codes(check('INV-ESTABLISH', without, options))).toEqual([
      expect.stringMatching(/register com\.r \{\}: 1 live record\(s\), 0 active, 0 pending/),
    ]);
    await settle(h);
  });
});

// --- INV-EVENT --------------------------------------------------------------------------------------------------

describe('INV-EVENT', () => {
  test('holds: Crossbar’s shared subscription id: one EVENT reaches every local of each key once', async () => {
    const h = harness(7, { router: { dialect: 'crossbar' } });
    h.router.declareTopic('com.t');
    const c = client(h);
    await h.clock.advance(5);
    const a = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const b = c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(5);
    h.router.publish('com.t', [1]);
    await h.clock.advance(5);
    b.unsubscribe();
    h.router.publish('com.t', [2]);
    await h.clock.advance(5);
    expect(a.values.map((v) => (v as { args: unknown[] }).args)).toEqual([[1], [2]]);
    expect(b.values).toHaveLength(1);
    expect(check('INV-EVENT', c.trace())).toEqual([]);
    await settle(h);
  });

  test('catches an EVENT not delivered, delivered twice, and delivered to a local that left', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    const c = client(h);
    await h.clock.advance(5);
    const a = c.observe('topic', 'com.t', c.client.topic('com.t'));
    const b = c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(5);
    b.unsubscribe();
    await h.clock.advance(5);
    h.router.publish('com.t', [1]);
    await h.clock.advance(5);
    const trace = c.trace();
    const delivered = trace.notifications.find((n) => n.observer === a.id && n.notification === 'next')!;
    const dropped = edit(trace, (events) => events.filter((e) => e !== delivered));
    expect(codes(check('INV-EVENT', dropped))).toEqual([expect.stringMatching(/not delivered to observer/)]);
    const twice = insertAfter(trace, (e) => e === delivered, { ...delivered, seq: 0 } as Omit<
      NotificationEvent,
      'seq'
    >);
    expect(codes(check('INV-EVENT', twice))).toEqual([expect.stringMatching(/delivered 2 times/)]);
    const gone = insertAfter(trace, (e) => e === delivered, { ...delivered, seq: 0, observer: b.id } as Omit<
      NotificationEvent,
      'seq'
    >);
    expect(codes(check('INV-EVENT', gone))).toEqual([expect.stringMatching(/not a local of a key mapped to it/)]);
    await settle(h);
  });
});

// --- INV-LIVE ---------------------------------------------------------------------------------------------------

describe('INV-LIVE', () => {
  test('holds: a silent link gets a probe within idle, and a dead one ends within the budget', async () => {
    const h = harness();
    const c = client(h, { timeouts: { idle: 1000 }, [INTERNAL]: { ping: 500 } });
    await h.clock.advance(3000); // calibration probe answered
    c.connection.controls.freeze('drop');
    await h.clock.advance(5000);
    const ends = c.onClose!.values;
    expect(ends[0]?.error).toMatchObject({ timer: 'liveness' });
    expect(check('INV-LIVE', c.trace(), { timings: { idle: 1000, ping: 500 }, now: h.clock.now() })).toEqual([]);
    await settle(h);
  });

  test('holds: liveness turned off by the probe failure that ends the second dead session in a row', async () => {
    const h = harness();
    h.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping'); // the router drops every probe
    const c = client(h, { timeouts: { idle: 1000 }, [INTERNAL]: { ping: 500 } });
    await h.clock.advance(20000);
    const ends = c.onClose!.values;
    expect(ends.slice(0, 2).map((e) => (e.error as { timer?: unknown } | undefined)?.timer)).toEqual([
      'liveness',
      'liveness',
    ]);
    expect(ends).toHaveLength(2); // the third session stays silent and open: liveness is off
    expect(check('INV-LIVE', c.trace(), { timings: { idle: 1000, ping: 500 }, now: h.clock.now() })).toEqual([]);
    await settle(h);
  });

  test('catches a session that stays silent without a probe (liveness off, judged as on)', async () => {
    const h = harness();
    const c = client(h, { timeouts: { idle: 0 } });
    await h.clock.advance(5);
    c.connection.controls.freeze('drop');
    await h.clock.advance(5000);
    expect(codes(check('INV-LIVE', c.trace(), { timings: { idle: 1000, ping: 500 }, now: h.clock.now() }))).toEqual([
      expect.stringMatching(/no probe within 1000 ms of the last inbound frame/),
    ]);
    await settle(h);
  });

  test.each([
    { ping: 3000, next: 'a probe at its deadline (the idle deadline passed)' },
    { ping: 300, next: 'the next probe idle after the last inbound frame' },
  ])('holds: a router that drops probes but answers a call written after one: $next, then dead', async ({ ping }) => {
    const h = harness();
    h.router.procedure('com.p', () => 'pong');
    const c = client(h, { timeouts: { idle: 1000 }, [INTERNAL]: { ping } });
    await h.clock.advance(3000); // calibration probe answered
    h.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping'); // every later probe is dropped
    await h.clock.advance(1100); // idle at 4000: a probe the router drops
    c.observe('call', 'com.p', c.client.call('com.p')); // answered: the router provably works
    await h.clock.advance(8000);
    // the dropped probe is 'alive' at its deadline, so the session goes on; the next probe proves nothing: dead
    const ends = c.onClose!.values;
    expect((ends[0]?.error as { timer?: unknown } | undefined)?.timer).toBe('liveness');
    const probes = frames(c, 48).filter((f) => (f.frame as unknown[])[3] === 'thruway.js.ping');
    expect(probes.length).toBeGreaterThanOrEqual(5);
    const timings = { idle: 1000, ping };
    const trace = c.trace();
    expect(check('INV-LIVE', trace, { timings, now: h.clock.now() })).toEqual([]);
    // without the call's RESULT (the proof) the same trace is a pending probe that kept a silent session
    const result = trace.frames.find(
      (f) =>
        f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === 50 && (f.frame[3] as unknown[])[0] === 'pong',
    );
    expect(result).toBeDefined();
    const unproven = edit(trace, (events) => events.filter((e) => e !== result));
    expect(codes(check('INV-LIVE', unproven, { timings, now: h.clock.now() }))).toContainEqual(
      expect.stringMatching(/a pending probe kept a silent session/),
    );
    await settle(h);
  });

  test('catches a request left unproven on a one-way half-open link while EVENTs keep arriving', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    h.router.procedure('com.never', () => new Promise(() => undefined));
    const c = client(h, { timeouts: { idle: 0 } });
    await h.clock.advance(5);
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(5);
    c.connection.controls.freeze('drop', 'up'); // the client's frames are lost, the router's still arrive
    c.observe('call', 'com.never', c.client.call('com.never'));
    for (let i = 0; i < 10; i++) {
      h.router.publish('com.t', [i]);
      await h.clock.advance(500);
    }
    expect(
      codes(check('INV-LIVE', c.trace(), { timings: { idle: 1000, ping: 500 }, now: h.clock.now() })),
    ).toContainEqual(expect.stringMatching(/stayed unproven .* while the session went on/));
    c.connection.controls.thaw();
    await settle(h);
  });
});
