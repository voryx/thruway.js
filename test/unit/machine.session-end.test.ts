// The core in a session and the end procedure: routing to the participants, a router GOODBYE answered for every reason
// (both goodbye_and_out spellings included) with exactly one reply and one reconnect, ABORT, header-fatal frames and
// ctx.violation, liveness timers, request timers, op.start in a session (FIFO order, refused writes), handler events,
// open() → probe; then the end procedure itself: gate → notify → fail (the app hears the loss before its in-flight ops
// fail, whatever the subscription order), the in-flight error kinds (Lost / Closed{gaveUp, cause: Lost}), exactly one
// end per connection, waiting ops untouched, interests dormant and re-established once, invocations aborted, and the
// CloseInfo of each end kind.
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import type { SessionCtx } from '../../src/core/contracts.js';
import { isThruwayError } from '../../src/errors.js';
import { Liveness } from '../../src/ops/liveness.js';
import { TopicParticipant } from '../../src/ops/topic.js';
import type { ClientOptions, CloseInfo, InvocationMessage } from '../../src/types.js';
import { closeReason, Connection, frameBytes, oversize, utf8Length } from '../../src/core/connection.js';
import { MAX_FRAME_BYTES } from '../../src/protocol/messages.js';
import { createHarness, useHarness, type Harness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 33 });

function start(options: ClientOptions = {}, setup?: (harness: Harness) => void): SimClient<Client> {
  setup?.(h.current);
  return h.current.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
}
function written(c: SimClient<Client>, n = 1): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket)
    .map((f) => f.frame as unknown[]);
}
const types = (c: SimClient<Client>, n = 1): unknown[] => written(c, n).map((f) => f[0]);
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const lastClose = (c: SimClient<Client>): CloseInfo => closes(c).at(-1)!;
const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s) => s.state);
const logs = (c: SimClient<Client>, event: string) => c.trace().logs.filter((l) => l.entry.event === event);
const raw = (frame: unknown[]): void => {
  h.current.router.sendRaw(JSON.stringify(frame));
};
const advance = (ms: number): Promise<void> => h.current.clock.advance(ms);
const never = (): Promise<never> => new Promise<never>(() => undefined);

describe('routing', () => {
  test('each reply reaches its participant; frames for unknown ids are dropped with one debug entry each, an unknown SUBSCRIBED/REGISTERED is withdrawn', async () => {
    const { router } = h.current;
    router.procedure('com.example.p', () => 'ok');
    router.declareTopic('com.example.t');
    const c = start();
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    const pub = c.observe('publish', 'com.example.t', c.client.publish('com.example.t', [], {}, { acknowledge: true }));
    const topic = c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'com.example.r',
      c.client.register('com.example.r', () => 1),
    );
    await advance(5);
    expect(call.values[0]?.args).toEqual(['ok']);
    expect(pub.completed).toBe(true);
    expect(reg.values).toHaveLength(1);
    router.publish('com.example.t', [1]);
    await advance(5);
    expect(topic.values).toHaveLength(1);
    const before = logs(c, 'frame.dropped').length;
    for (const frame of [
      [50, 999999, {}],
      [8, 48, 999999, {}, 'wamp.error.x'],
      [8, 49, 999999, {}, 'wamp.error.canceled'],
      [8, 16, 999999, {}, 'wamp.error.x'],
      [8, 32, 999999, {}, 'wamp.error.x'],
      [8, 34, 999999, {}, 'wamp.error.x'],
      [8, 64, 999999, {}, 'wamp.error.x'],
      [8, 66, 999999, {}, 'wamp.error.x'],
      [8, 8, 999999, {}, 'wamp.error.no_such_procedure'], // Thruway PHP after killnowait (T2)
      [8, 68, 999999, {}, 'wamp.error.x'],
      [17, 999999, 1],
      [33, 999999, 1],
      [35, 999999],
      [36, 999999, 1, {}],
      [65, 999999, 1],
      [67, 999999],
      [69, 999999, {}],
    ]) {
      raw(frame);
    }
    await advance(1);
    expect(logs(c, 'frame.dropped').length - before).toBe(17);
    // the answers to a SUBSCRIBE and a REGISTER this session never made (or gave up on): withdrawn once each
    expect(written(c).filter((f) => f[0] === 34 || f[0] === 66)).toEqual([
      [34, expect.any(Number), 1],
      [66, expect.any(Number), 1],
    ]);
    expect(states(c)).toEqual(['connecting', 'open']); // nothing of it ends the session (liberal acceptance)
  });

  test('an ERROR answering an UNSUBSCRIBE (34) or an UNREGISTER (66) reaches its participant, which forgets the request', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    const c = start({}, (x) => {
      x.router.ignore((f) => f[0] === 34 || f[0] === 66); // the router never answers them: the test does
    });
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    await advance(5);
    topic.unsubscribe();
    reg.unsubscribe();
    await advance(1);
    const unsub = written(c).find((f) => f[0] === 34)!;
    const unreg = written(c).find((f) => f[0] === 66)!;
    const sizes = () =>
      (c.debug() as { participants: { topic: { requests: number }; register: { requests: number } } }).participants;
    expect([sizes().topic.requests, sizes().register.requests]).toEqual([1, 1]);
    const before = logs(c, 'frame.dropped').length;
    raw([8, 34, unsub[1], {}, 'wamp.error.no_such_subscription']);
    raw([8, 66, unreg[1], {}, 'wamp.error.no_such_registration']);
    await advance(1);
    expect(logs(c, 'frame.dropped').length).toBe(before); // consumed, not dropped
    expect([sizes().topic.requests, sizes().register.requests]).toEqual([0, 0]);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('unknown and client-only message types are dropped with a warning; an ERROR of an unknown request type at debug', async () => {
    const c = start();
    await advance(1);
    const before = logs(c, 'frame.dropped').length;
    for (const frame of [
      [7],
      [300, 1],
      [1023],
      [48, 1, {}, 'com.example.p'],
      [70, 1, {}],
      [8, 8, 9, {}, 'wamp.error.x'],
    ]) {
      raw(frame);
    }
    await advance(1);
    const dropped = logs(c, 'frame.dropped').slice(before);
    expect(dropped.map((l) => l.entry.level)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn', 'debug']);
    expect(states(c)).toEqual(['connecting', 'open']); // none of it is fatal
  });

  test('WELCOME and CHALLENGE in an established session are dropped with a warning', async () => {
    const c = start();
    await advance(1);
    raw([2, 99, {}]);
    raw([4, 'ticket', {}]);
    await advance(1);
    const dropped = logs(c, 'frame.dropped').filter((l) => l.entry.level === 'warn');
    expect(dropped.map((l) => l.entry.message)).toEqual([
      'dropped message type 2 in an established session',
      'dropped message type 4 in an established session',
    ]);
    expect(c.client.session?.id).not.toBe(99);
  });

  test('payload-invalid frames are routed: the record fails, the session continues', async () => {
    h.current.router.procedure('com.example.p', never);
    const c = start();
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await advance(1);
    const id = written(c).find((f) => f[0] === 48)![1];
    raw([50, id, {}, { not: 'an array' }]);
    await advance(1);
    expect(call.error).toMatchObject({ code: 'protocol', requestId: id });
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('a decode normalisation is logged as a tolerated protocol violation (warn)', async () => {
    const c = start();
    await advance(1);
    raw([6, 'not a dict', 'wamp.close.system_shutdown']); // GOODBYE with an invalid details dict
    await advance(1);
    expect(logs(c, 'protocol.violation').map((l) => l.entry.message)[0]).toMatch(/^tolerated: GOODBYE/);
  });
});

describe('router GOODBYE in a session', () => {
  test.each([
    'wamp.close.system_shutdown',
    'wamp.close.normal',
    'wamp.close.goodbye_and_out',
    'wamp.error.goodbye_and_out',
    'wamp.close.killed',
    'com.example.session_ended',
  ])('%s ⇒ one GOODBYE goodbye_and_out reply, close 1000, then a reconnect; interests survive', async (reason) => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    router.procedure('com.example.slow', never);
    const c = start();
    const topic = c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
    const call = c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
    await advance(1);
    raw([6, { message: 'bye' }, reason]);
    await advance(1);
    expect(written(c).filter((f) => f[0] === 6)).toEqual([[6, {}, 'wamp.close.goodbye_and_out']]);
    expect(c.connections[0]!.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
    expect(lastClose(c)).toMatchObject({
      initiator: 'router',
      reason,
      details: { message: 'bye' },
      closeCode: 1000,
      wasClean: true,
      error: undefined,
      willRetry: true,
      attempt: 1,
    });
    expect(call.error).toMatchObject({ code: 'connection_lost', reason, procedure: 'com.example.slow' });
    expect(topic.closed).toBe(false);
    await advance(5000);
    expect(states(c)).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
    expect(types(c, 2).filter((t) => t === 32)).toHaveLength(1); // re-SUBSCRIBEd once
    expect(topic.closed).toBe(false);
  });

  test('a peer that echoes our reply (or sends GOODBYE twice) gets one reply; one end, one reconnect', async () => {
    const c = start();
    await advance(1);
    raw([6, {}, 'wamp.close.system_shutdown']);
    raw([6, {}, 'wamp.close.goodbye_and_out']);
    await advance(1);
    expect(written(c).filter((f) => f[0] === 6)).toHaveLength(1);
    expect(closes(c)).toHaveLength(1);
    await advance(5000);
    expect(c.connections).toHaveLength(2);
  });

  test('a GOODBYE reply that cannot be written changes nothing else: the router reason is heard once', async () => {
    const c = start({
      serializer: {
        protocol: 'wamp.2.json',
        binary: false,
        serialize: (m) => {
          if (m[0] === 6) throw new Error('cannot write GOODBYE');
          return JSON.stringify(m);
        },
        deserialize: (d) => JSON.parse(d as string) as unknown,
      },
    });
    await advance(1);
    raw([6, {}, 'wamp.close.system_shutdown']);
    await advance(1);
    expect(closes(c).map((i) => i.reason)).toEqual(['wamp.close.system_shutdown']);
    expect(logs(c, 'request.error').map((l) => l.entry.message)).toEqual(['GOODBYE could not be serialized; skipped']);
    await advance(5000);
    expect(states(c).at(-1)).toBe('open');
  });

  test('ops started after the GOODBYE wait for the next WELCOME and are written there once', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    await advance(1);
    raw([6, {}, 'wamp.close.system_shutdown']);
    await advance(1);
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await advance(5000);
    expect(call.values).toHaveLength(1);
    expect(types(c, 1).filter((t) => t === 48)).toHaveLength(0);
    expect(types(c, 2).filter((t) => t === 48)).toHaveLength(1);
  });
});

describe('other ends of a session', () => {
  test('a router close with a code and a reason: CloseInfo{closeCode, wasClean, details {}}; the close text is in the message', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start();
    const call = c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(1);
    c.connection.controls.close(4321, 'maintenance window');
    await advance(1);
    expect(lastClose(c)).toEqual(
      expect.objectContaining({
        initiator: 'connection',
        reason: undefined, // a WAMP URI only
        details: {},
        closeCode: 4321,
        wasClean: true,
        sessionId: 1,
      }),
    );
    expect(lastClose(c).error).toMatchObject({ code: 'connection_lost', closeCode: 4321 });
    expect((lastClose(c).error as { reason?: unknown }).reason).toBeUndefined();
    expect(lastClose(c).error?.message).toBe('socket closed (4321): maintenance window');
    expect(call.error).toMatchObject({ code: 'connection_lost', closeCode: 4321 });
    expect((call.error as { reason?: unknown }).reason).toBeUndefined();
  });

  test('ABORT ⇒ close 1000, AbortError; in-flight calls Lost{cause: AbortError}', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start();
    const call = c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
    await advance(1);
    raw([3, { message: 'kicked' }, 'wamp.close.killed']);
    await advance(1);
    expect(types(c).at(-1)).toBe(48); // nothing is written after an ABORT
    expect(lastClose(c)).toMatchObject({ initiator: 'router', reason: 'wamp.close.killed', closeCode: 1000 });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
    expect(lastClose(c).error).toMatchObject({ name: 'AbortError', reason: 'wamp.close.killed', sessionId: 1 });
    expect(call.error).toMatchObject({ code: 'connection_lost', reason: 'wamp.close.killed' });
    expect((call.error as { cause?: unknown }).cause).toBe(lastClose(c).error);
  });

  test('a header-fatal frame ⇒ ABORT protocol_violation, close 4000; in-flight Lost{cause: ProtocolError}', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start();
    const call = c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
    await advance(1);
    raw([50, 'not an id', {}]);
    await advance(1);
    expect(written(c).at(-1)?.[2]).toBe('wamp.error.protocol_violation');
    expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.protocol_violation', closeCode: 4000, wasClean: false });
    expect(c.connections[0]?.controls.closeCalls).toEqual([{ code: 4000, reason: 'protocol violation' }]);
    expect(lastClose(c).error).toMatchObject({ code: 'protocol', sessionId: 1, attempt: 1 });
    expect(lastClose(c).error).toHaveProperty('frame');
    expect(call.error).toMatchObject({ code: 'connection_lost' });
    expect((call.error as { cause?: { code?: string } }).cause?.code).toBe('protocol');
  });

  test('ctx.violation() aborts after the step, only while that session is still current and established', async () => {
    const spy = vi.spyOn(TopicParticipant.prototype, 'inbound').mockImplementationOnce(function (
      this: TopicParticipant,
      _msg,
      ctx: SessionCtx,
    ) {
      ctx.violation('the router sent nonsense', [36, 1]);
      ctx.violation('reported twice in one step', [36, 2]); // the first one ended the session: dropped
      return true;
    });
    try {
      const c = start();
      await advance(1);
      raw([36, 1, 2, {}]);
      await advance(1);
      expect(spy).toHaveBeenCalled();
      expect(closes(c)).toHaveLength(1);
      expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.protocol_violation', closeCode: 4000 });
      expect(lastClose(c).error).toMatchObject({ message: 'the router sent nonsense', frame: '[36,1]' });
    } finally {
      spy.mockRestore();
    }
  });

  test('a ctx.violation() in a step that ended the session anyway is ignored (one end only)', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const original = Liveness.prototype.inbound;
    const spy = vi.spyOn(Liveness.prototype, 'inbound').mockImplementation(function (this: Liveness, msg, ctx) {
      if (msg.type === 6) ctx.violation('late', []);
      return original.call(this, msg, ctx);
    });
    try {
      const c = start();
      await advance(1);
      raw([6, {}, 'wamp.close.system_shutdown']);
      await advance(1);
      expect(closes(c).map((i) => i.reason)).toEqual(['wamp.close.system_shutdown']);
    } finally {
      spy.mockRestore();
    }
  });

  test('liveness: an unanswered probe ⇒ close 4001, TimeoutError{liveness}; the next budget doubles', async () => {
    const c = start({ timeouts: { idle: 1000 } }, (x) => {
      x.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping');
    });
    await advance(1000); // the calibration probe
    expect(written(c).filter((f) => f[3] === 'thruway.js.ping')).toHaveLength(1);
    await advance(20000);
    expect(lastClose(c)).toMatchObject({ initiator: 'connection', closeCode: 4001, wasClean: false });
    expect(c.connections[0]?.controls.closeCalls).toEqual([{ code: 4001, reason: 'client timeout' }]);
    // the time without traffic before the end: idle + the ping budget
    expect(lastClose(c).error).toMatchObject({ name: 'TimeoutError', timer: 'liveness', timeout: 1000 + 20000 });
  });

  test('TimeoutError{liveness}.timeout reports the budget in force: idle + the doubled budget', async () => {
    const c = start({ timeouts: { idle: 1000 }, retryOptions: { retryDelay: () => 100 } }, (x) => {
      x.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping');
    });
    await advance(1000 + 20000); // the first calibration probe goes unanswered: dead, the budget doubles
    expect(closes(c)).toHaveLength(1);
    await advance(1000 + 1000 + 40000); // reconnected; the second one waits 40 s
    expect(closes(c).map((i) => (i.error as { timeout?: number } | undefined)?.timeout)).toEqual([
      1000 + 20000,
      1000 + 40000,
    ]);
    expect(lastClose(c).error).toMatchObject({ name: 'TimeoutError', timer: 'liveness' });
    // two liveness ends in a row with no probe answered: probing is off on this router, no third end
    expect(logs(c, 'liveness.unsupported')).toHaveLength(1);
    await advance(10 * 60000);
    expect(closes(c)).toHaveLength(2);
    expect(states(c).at(-1)).toBe('open');
  });

  test('a router that answers probes: every half-open link is found within idle + budget, the next session calibrates again, probing never goes off', async () => {
    const idle = 5000;
    const pings = (n: number): number => written(c, n).filter((f) => f[3] === 'thruway.js.ping').length;
    const c = start({ timeouts: { idle }, retryOptions: { retryDelay: () => 100 } });
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i < 5000 && (c.connections.length < n || c.client.session === undefined); i++) await advance(1);
      expect(c.connections).toHaveLength(n);
      // every session calibrates first, the first one after a liveness end too: a probe 1 s after WELCOME, not `idle`
      await advance(990);
      expect(pings(n)).toBe(0);
      await advance(20);
      expect(pings(n)).toBe(1);
      await advance(12000); // healthy: the router answers every probe
      expect(pings(n)).toBeGreaterThan(1);
      expect(closes(c)).toHaveLength(n - 1);
      const frozenAt = h.current.clock.now();
      c.connection.controls.freeze('drop'); // half-open: nothing arrives, nothing written leaves
      for (let t = 0; t < 2 * (idle + 20000) && closes(c).length < n; t += 10) await advance(10);
      expect(closes(c)).toHaveLength(n);
      expect(h.current.clock.now() - frozenAt).toBeLessThanOrEqual(idle + 20000 + 10);
      // the calibration was answered within the base budget: back to it (and TimeoutError reports it)
      expect(lastClose(c)).toMatchObject({ closeCode: 4001, willRetry: true });
      expect(lastClose(c).error).toMatchObject({ name: 'TimeoutError', timer: 'liveness', timeout: idle + 20000 });
    }
    expect(logs(c, 'liveness.unsupported')).toEqual([]);
  });

  test.each([
    ['a liveness timeout', true],
    ['a socket drop', false],
    ['a router GOODBYE', false],
  ] as const)(
    'the end tells liveness whether liveness ended it (the ping budget adapts): %s',
    async (how, byLiveness) => {
      const ended = vi.spyOn(Liveness.prototype, 'sessionEnded');
      try {
        const c = start({ timeouts: { idle: 1000 } }, (x) => {
          if (byLiveness) x.router.ignore((f) => f[3] === 'thruway.js.ping');
        });
        await advance(5);
        if (how === 'a socket drop') c.connection.controls.drop();
        else if (how === 'a router GOODBYE') h.current.router.goodbye('wamp.close.system_shutdown');
        else await advance(1000 + 20000);
        await advance(1);
        expect(closes(c)).toHaveLength(1);
        expect(ended.mock.calls).toEqual([[byLiveness]]);
      } finally {
        ended.mockRestore();
      }
    },
  );

  test('liveness: an answered probe keeps the session (alive)', async () => {
    const c = start({ timeouts: { idle: 1000 } });
    await advance(30000);
    expect(written(c).filter((f) => f[3] === 'thruway.js.ping').length).toBeGreaterThan(1);
    expect(closes(c)).toHaveLength(0);
  });

  test("the probe's answer is consumed by liveness: never routed to the call participant, never logged as dropped", async () => {
    const c = start({ timeouts: { idle: 1000 } });
    await advance(1000); // the calibration probe; the sim router answers ERROR(48, no_such_procedure) at once
    const probe = written(c).find((f) => f[3] === 'thruway.js.ping');
    expect(probe).toEqual([48, expect.any(Number), {}, 'thruway.js.ping']);
    await advance(1);
    const answers = c
      .trace()
      .frames.filter(
        (f) => f.direction === 'out' && (f.frame as unknown[])[0] === 8 && (f.frame as unknown[])[2] === probe![1],
      );
    expect(answers).toHaveLength(1);
    expect(logs(c, 'frame.dropped')).toEqual([]);
  });

  test('a request timer asks liveness, then errors the interest with TimeoutError{request}', async () => {
    h.current.router.declareTopic('com.example.t');
    const c = start({ timeouts: { idle: 1000, request: 2000 } }, (x) => {
      x.router.ignore((f) => f[0] === 32);
    });
    const topic = c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
    await advance(2100);
    expect(topic.error).toMatchObject({ name: 'TimeoutError', timer: 'request', topic: 'com.example.t' });
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('open() in a session probes when nothing arrived for 2 s, and not otherwise', async () => {
    const c = start({ timeouts: { idle: 60000 } });
    await advance(1000); // calibration probe answered at once
    const probes = () => written(c).filter((f) => f[3] === 'thruway.js.ping').length;
    expect(probes()).toBe(1);
    c.open();
    await advance(1);
    expect(probes()).toBe(1); // something arrived 1 s ago
    await advance(2000);
    c.open();
    await advance(1);
    expect(probes()).toBe(2);
  });
});

describe('op.start in a session', () => {
  test('a write the closing socket refuses keeps the op queued; it is written once after the next WELCOME', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    await advance(1);
    c.connection.controls.closingWindow(500); // the router's close frame is in, the close event is not
    await advance(1);
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    const second = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await advance(5000);
    expect(types(c, 1).filter((t) => t === 48)).toHaveLength(0);
    expect(types(c, 2).filter((t) => t === 48)).toHaveLength(2);
    expect(call.values).toHaveLength(1);
    expect(second.values).toHaveLength(1);
  });

  test('calls and publishes waiting for a session are written at WELCOME in the order the app started them', async () => {
    const { router } = h.current;
    router.procedure('com.example.p', () => 1);
    router.declareTopic('com.example.t');
    const c = start({ autoOpen: false });
    c.observe('call', 'p', c.client.call('com.example.p', [1]));
    c.observe('publish', 't', c.client.publish('com.example.t', [2]));
    c.observe('call', 'p', c.client.call('com.example.p', [3]));
    c.observe('topic', 't', c.client.topic('com.example.t'));
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    c.observe('publish', 't', c.client.publish('com.example.t', [4]));
    c.open();
    await advance(1);
    // HELLO; interests first (register, then topic), then the waiting one-shots in start order
    expect(written(c).map((f) => [f[0], f[0] === 48 || f[0] === 16 ? (f[4] as unknown[])[0] : undefined])).toEqual([
      [1, undefined],
      [64, undefined],
      [32, undefined],
      [48, 1],
      [16, 2],
      [48, 3],
      [16, 4],
    ]);
  });

  test('a one-shot started while others are queued goes behind them, even in a session', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    await advance(1);
    c.connection.controls.closingWindow(500);
    await advance(1);
    c.observe('call', 'p', c.client.call('com.example.p', [1])); // refused: queued
    c.observe('call', 'p', c.client.call('com.example.p', [2])); // FIFO not empty: queued behind
    await advance(5000);
    expect(
      written(c, 2)
        .filter((f) => f[0] === 48)
        .map((f) => (f[4] as unknown[])[0]),
    ).toEqual([1, 2]);
  });

  test('ctx.request tells liveness whether a reply is expected: false only for an unacknowledged PUBLISH', async () => {
    const { router } = h.current;
    router.procedure('com.example.p', () => 1);
    router.declareTopic('com.example.t');
    const wrote = vi.spyOn(Liveness.prototype, 'wrote');
    try {
      const c = start();
      await advance(1);
      const before = wrote.mock.calls.length;
      c.observe('publish', 't', c.client.publish('com.example.t', [1]));
      c.observe('publish', 't', c.client.publish('com.example.t', [2], {}, { acknowledge: true }));
      c.observe('call', 'p', c.client.call('com.example.p'));
      c.observe('topic', 't', c.client.topic('com.example.t'));
      c.observe(
        'register',
        'r',
        c.client.register('com.example.r', () => 1),
      );
      await advance(1);
      const requests = written(c).filter((f) => [16, 32, 48, 64].includes(f[0] as number));
      expect(requests.map((f) => f[0])).toEqual([16, 16, 48, 32, 64]);
      // one wrote() per request, synchronously in the write, in wire order, with its expectsReply
      expect(wrote.mock.calls.slice(before).map((call) => call[0])).toEqual([false, true, true, true, true]);
    } finally {
      wrote.mockRestore();
    }
  });

  test('ctx.send tells liveness after each frame it wrote: YIELD, an INVOCATION ERROR, CANCEL; never a refused write, a request or a frame of the core', async () => {
    const x = createHarness({
      seed: 34,
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) }),
      },
    });
    x.router.procedure('com.example.slow', never);
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const write = Connection.prototype.write;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const sent = Liveness.prototype.sent;
    const spies = [
      vi.spyOn(Connection.prototype, 'write').mockImplementation(function (this: Connection, frame) {
        const ok = write.call(this, frame);
        log.push(ok ? String(frame[0]) : `${String(frame[0])} refused`);
        return ok;
      }),
      vi.spyOn(Liveness.prototype, 'sent').mockImplementation(function (this: Liveness, ctx: SessionCtx) {
        log.push('sent');
        sent.call(this, ctx);
      }),
    ];
    try {
      const c = x.makeClient(Client, {
        options: {
          autoOpen: false,
          timeouts: { idle: 0 },
          retryOptions: { retryDelay: () => 100 },
          authmethods: ['ticket'],
          onChallenge: () => 'secret',
        },
      });
      const faults = c.faults as { inject(t: string): void; clear(): void };
      faults.inject('nothing'); // the faults hook wraps the sockets from now on
      faults.clear();
      let n = 0;
      c.observe(
        'register',
        'r',
        c.client.register('com.example.r', () => {
          if (++n === 2) throw new Error('kaput');
          return n;
        }),
      );
      c.open();
      await x.clock.advance(5);
      expect(x.router.invoke('com.example.r').done).toBe(false);
      await x.clock.advance(5); // YIELD
      x.router.invoke('com.example.r');
      await x.clock.advance(5); // ERROR (an INVOCATION's)
      const slow = c.observe('call', 's', c.client.call('com.example.slow'));
      await x.clock.advance(5);
      slow.unsubscribe(); // CANCEL
      await x.clock.advance(5);
      const refused = c.observe('call', 's', c.client.call('com.example.slow'));
      await x.clock.advance(5);
      faults.inject('ws.send');
      refused.unsubscribe(); // a refused CANCEL: the connection is lost
      await x.clock.advance(1000);
      x.router.sendRaw('garbage'); // a protocol violation in the next session: the client's ABORT
      await x.clock.advance(1000);
      await x.closeAndSettle(); // GOODBYE
      expect(log).toEqual(
        // prettier-ignore
        [
          '1', '5', '64', '70', 'sent', '8', 'sent', '48', '49', 'sent', '48', '49 refused',
          '1', '5', '64', '3',
          '1', '5', '64', '6',
        ],
      );
      expect(x.problems()).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('liveness hears the URL each socket was opened with at every WELCOME, before start, and only then', async () => {
    const { router } = h.current;
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const endpoint = Liveness.prototype.endpoint;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const startLiveness = Liveness.prototype.start;
    const spies = [
      vi.spyOn(Liveness.prototype, 'endpoint').mockImplementation(function (this: Liveness, url: string) {
        log.push(`endpoint ${url.slice(router.url.length)}`);
        endpoint.call(this, url);
      }),
      vi.spyOn(Liveness.prototype, 'start').mockImplementation(function (this: Liveness, ctx, roles) {
        log.push('start');
        startLiveness.call(this, ctx, roles);
      }),
    ];
    try {
      let n = 0;
      const c = h.current.makeClient(Client, {
        url: () => `${router.url}/r?ticket=${String(++n)}`,
        options: { timeouts: { idle: 0, handshake: 500 }, retryOptions: { retryDelay: () => 100 } },
      });
      await advance(5);
      let ignored = 0;
      router.ignore((f) => f[0] === 1 && ++ignored === 1); // the second attempt is never welcomed
      c.connection.controls.drop();
      await advance(3000);
      expect(closes(c).map((i) => (i.error as { timer?: unknown }).timer)).toEqual([undefined, 'handshake']);
      expect(states(c).at(-1)).toBe('open');
      expect(n).toBe(3);
      expect(log).toEqual(['endpoint /r?ticket=1', 'start', 'endpoint /r?ticket=3', 'start']);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('handler results are routed to the register participant (handler.*): YIELD', async () => {
    const c = start();
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', (inv: InvocationMessage) => (inv.args[0] as number) * 2),
    );
    await advance(1);
    const peer = h.current.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const result = peer.observe('call', 'r', peer.client.call('com.example.r', [21]));
    await advance(5);
    expect(result.values[0]?.args).toEqual([42]);
    expect(written(c).find((f) => f[0] === 70)).toEqual([70, expect.any(Number), {}, [42]]);
  });
});

describe('the end procedure', () => {
  test('gate → notify → fail: onClose and status are delivered before in-flight ops fail, whatever the order', async () => {
    h.current.router.procedure('com.example.slow', never);
    const order: string[] = [];
    const c = start({}, undefined);
    c.client.call('com.example.slow').subscribe({ error: () => order.push('call error') });
    c.client.onClose.subscribe(() => order.push('onClose'));
    c.client.status.subscribe((s) => {
      if (s.state === 'closed') order.push('status closed');
    });
    await advance(1);
    h.current.router.drop();
    await advance(1);
    expect(order).toEqual(['status closed', 'onClose', 'call error']);
  });

  test('the in-flight error carries the context (sessionId, requestId, procedure, closeCode); a fresh one per op', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start();
    const a = c.observe('call', 's', c.client.call('com.example.slow'));
    const b = c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(1);
    h.current.router.drop(1006);
    await advance(1);
    const ids = written(c)
      .filter((f) => f[0] === 48)
      .map((f) => f[1]);
    expect(a.error).toMatchObject({
      code: 'connection_lost',
      sessionId: 1,
      requestId: ids[0],
      procedure: 'com.example.slow',
      closeCode: 1006,
    });
    expect(b.error).toMatchObject({ requestId: ids[1] });
    expect(a.error).not.toBe(b.error);
    expect((a.error as { cause?: unknown }).cause).toBe(lastClose(c).error);
  });

  test('give-up: in-flight ops Closed{gaveUp, cause: Lost}; waiting ops and interests Closed{gaveUp}; stopped', async () => {
    const { router } = h.current;
    router.procedure('com.example.slow', never);
    router.declareTopic('com.example.t');
    const c = start({ retryOptions: { maxRetries: 0 } });
    const inflight = c.observe('call', 's', c.client.call('com.example.slow'));
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    await advance(1);
    c.connection.controls.closingWindow(100);
    await advance(1);
    const waiting = c.observe('call', 's', c.client.call('com.example.slow')); // refused, queued
    await advance(200);
    expect(lastClose(c)).toMatchObject({ willRetry: false, delay: undefined });
    for (const r of [inflight, waiting, topic]) {
      expect(isThruwayError(r.error) && r.error.code).toBe('connection_closed');
      expect((r.error as { gaveUp: boolean }).gaveUp).toBe(true);
    }
    expect((inflight.error as { cause?: { code?: string } }).cause?.code).toBe('connection_lost');
    expect((waiting.error as { procedure?: string }).procedure).toBe('com.example.slow');
    const late = c.observe('call', 's', c.client.call('com.example.slow'));
    expect(late.error).toMatchObject({ code: 'connection_closed', gaveUp: true }); // at once, while stopped
    expect(states(c).at(-1)).toBe('closed');
    c.open(); // a new start, no sooner than 1 s after the last attempt started (the floor)
    await advance(1000);
    expect(states(c).at(-1)).toBe('open');
  });

  test('give-up by a router ABORT: the in-flight op error wraps a fresh Lost with its context, not the AbortError (recipe 3)', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start({ retryOptions: { maxRetries: 0 } });
    const inflight = c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(1);
    const id = written(c).find((f) => f[0] === 48)![1];
    raw([3, { message: 'go away' }, 'wamp.close.killed']);
    await advance(1);
    const abort = lastClose(c).error;
    expect(abort).toMatchObject({ code: 'abort', reason: 'wamp.close.killed' });
    expect(inflight.error).toMatchObject({ code: 'connection_closed', gaveUp: true, sessionId: 1, requestId: id });
    const lost = (inflight.error as { cause?: unknown }).cause;
    // "cause.code === 'connection_lost' ⇒ the op was in flight at the final loss (outcome unknown)"
    expect(lost).toMatchObject({
      code: 'connection_lost',
      reason: 'wamp.close.killed',
      sessionId: 1,
      requestId: id,
      procedure: 'com.example.slow',
    });
    expect((lost as { cause?: unknown }).cause).toBe(abort);
  });

  test('exactly one end per connection: a late close event of a released socket changes nothing', async () => {
    const c = start();
    await advance(1);
    raw([3, {}, 'wamp.close.killed']);
    await advance(1);
    c.connections[0]!.controls.emitLate('close');
    c.connections[0]!.controls.emitLate('error');
    c.connections[0]!.controls.emitLate('message');
    await advance(1);
    expect(closes(c)).toHaveLength(1);
  });

  test('a session end aborts running invocations (signal reason ConnectionLostError) and writes nothing for them', async () => {
    let signal: AbortSignal | undefined;
    const c = start();
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', (inv) => {
        signal = inv.signal as AbortSignal;
        return never();
      }),
    );
    await advance(1);
    const peer = h.current.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    peer.observe('call', 'r', peer.client.call('com.example.r'));
    await advance(5);
    expect(signal?.aborted).toBe(false);
    c.connection.controls.drop();
    await advance(1);
    expect(signal?.reason).toMatchObject({ code: 'connection_lost' });
    expect(types(c).filter((t) => t === 70 || t === 8)).toEqual([]);
  });

  test('CloseInfo of each end kind', async () => {
    const c = start({ timeouts: { idle: 1000 } }, (x) => {
      x.router.ignore((f, conn) => f[3] === 'thruway.js.ping' && conn.number === 3);
    });
    await advance(1);
    h.current.router.drop(1011);
    await advance(5000);
    raw([3, { message: 'm' }, 'wamp.error.not_authorized']);
    await advance(5000);
    await advance(30000); // the probe of connection 3 is never answered
    expect(closes(c).map((i) => [i.initiator, i.reason, i.closeCode, i.wasClean, i.error?.code, i.sessionId])).toEqual([
      ['connection', undefined, 1011, true, 'connection_lost', 1], // the kit's drop(1011) is a clean close
      ['router', 'wamp.error.not_authorized', 1000, true, 'abort', expect.any(Number)],
      ['connection', undefined, 4001, false, 'timeout', expect.any(Number)],
    ]);
    for (const info of closes(c)) expect(Object.isFrozen(info)).toBe(true);
  });
});

describe('frames and their size (core/connection.ts)', () => {
  test('utf8Length: 1, 2, 3 and 4-byte characters; a lone surrogate counts 3 (its replacement character)', () => {
    expect(utf8Length('')).toBe(0);
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('\ud83d')).toBe(3); // a high surrogate at the end
    expect(utf8Length('\ud83dx')).toBe(4); // a high surrogate followed by a non-surrogate
    expect(utf8Length('\ude00')).toBe(3); // a lone low surrogate
    for (const text of ['a', 'é€😀', 'x\ud83dy\ude00z', '𝄞 music']) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  test('oversize: cheap below a third of the limit, exact in between, over above it; binary frames by length', () => {
    expect(oversize('x'.repeat(1000))).toBeUndefined();
    expect(oversize('x'.repeat(MAX_FRAME_BYTES))).toBeUndefined(); // in between, ASCII: exactly at the limit
    expect(oversize('é'.repeat(MAX_FRAME_BYTES / 2 + 1))).toBe(MAX_FRAME_BYTES + 2);
    expect(oversize('x'.repeat(MAX_FRAME_BYTES + 1))).toBe(MAX_FRAME_BYTES + 1);
    expect(oversize(new Uint8Array(10))).toBeUndefined();
    expect(oversize(new Uint8Array(MAX_FRAME_BYTES + 1))).toBe(MAX_FRAME_BYTES + 1);
    expect(frameBytes('é')).toBe(2);
    expect(frameBytes(new Uint8Array(7))).toBe(7);
    expect(closeReason(4000)).toBe('protocol violation');
  });

  test('a binary serializer: Uint8Array frames are written, measured and logged by their length', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const c = start({
      serializer: {
        protocol: 'wamp.2.json',
        binary: true,
        serialize: (m) => encoder.encode(JSON.stringify(m)),
        deserialize: (d) => JSON.parse(typeof d === 'string' ? d : decoder.decode(d)) as unknown,
      },
    });
    await advance(1);
    expect(c.client.session).toBeDefined();
    const out = logs(c, 'frame.out')[0]?.entry;
    expect(out?.data?.['bytes']).toBeGreaterThan(100);
  });

  test('received binary messages are decoded and logged by their byte length; other data is measured as 0', async () => {
    const asBinary = (h2: Harness, mode: 'buffer' | 'view' | 'object') => {
      const Inner = h2.router.webSocketFor(1);
      const Wrapped = function (url: string, protocols?: string | string[]) {
        const ws = new Inner(url, protocols);
        return new Proxy(ws, {
          get(target, prop) {
            if (prop === 'addEventListener') {
              return (type: string, listener: (ev: { data: unknown }) => void) => {
                const wrapped =
                  type === 'message'
                    ? (ev: { data: unknown }) => {
                        const text = String(ev.data);
                        const bytes = new TextEncoder().encode(text);
                        listener({ data: mode === 'buffer' ? bytes.buffer : mode === 'view' ? bytes : { text } });
                      }
                    : listener;
                target.addEventListener(type as 'message', wrapped as never);
              };
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
          set(target, prop, value) {
            return Reflect.set(target, prop, value, target);
          },
        });
      } as unknown as NonNullable<ClientOptions['WebSocket']>;
      Object.defineProperty(Wrapped, 'OPEN', { value: 1 });
      return Wrapped;
    };
    for (const mode of ['buffer', 'view', 'object'] as const) {
      const x = createHarness({ seed: 34 });
      const c = x.makeClient(Client, {
        options: {
          timeouts: { idle: 0 },
          WebSocket: asBinary(x, mode),
          serializer: {
            protocol: 'wamp.2.json',
            binary: false,
            serialize: (m) => JSON.stringify(m),
            deserialize: (d) =>
              JSON.parse(
                typeof d === 'string'
                  ? d
                  : d instanceof ArrayBuffer || ArrayBuffer.isView(d)
                    ? new TextDecoder().decode(d)
                    : (d as unknown as { text: string }).text,
              ) as unknown,
          },
        },
      });
      await x.clock.advance(1);
      expect(c.client.session, mode).toBeDefined();
      const inbound = c.trace().logs.find((l) => l.entry.event === 'frame.in')?.entry;
      const bytes = inbound?.data?.['bytes'] as number;
      if (mode === 'object') expect(bytes).toBe(0);
      else expect(bytes, mode).toBeGreaterThan(10);
      await x.closeAndSettle();
    }
  });
});

describe('more session paths', () => {
  test('a subscription unsubscribed before its op.start is processed starts nothing (a pure hook inside a step)', async () => {
    const ref: { client?: Client } = {};
    h.current.router.procedure('com.example.p', () => 1);
    const c = start({
      logger: (entry) => {
        if (entry.event === 'session.open') ref.client?.call('com.example.p').subscribe({}).unsubscribe();
      },
    });
    ref.client = c.client;
    await advance(5);
    expect(written(c).filter((f) => f[0] === 48)).toHaveLength(0);
    expect((c.debug() as { registry: number }).registry).toBe(0);
  });

  test('a write refused during WELCOME stops the drain: the rest stays queued, in order, for the next session', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    h.current.router.declareTopic('com.example.t');
    interface Faults {
      inject(t: string): void;
      clear(): void;
    }
    const ref: { faults?: Faults } = {};
    let injected = false;
    const c = start({
      autoOpen: false,
      // inside the HELLO's step: the next socket write (the SUBSCRIBE at WELCOME) will be refused
      logger: (entry) => {
        if (!injected && entry.event === 'frame.out' && entry.message.startsWith('sent HELLO')) {
          injected = true;
          ref.faults?.inject('ws.send');
        }
      },
    });
    const faults = c.faults as Faults;
    ref.faults = faults;
    faults.inject('nothing'); // the faults hook wraps the sockets from now on
    faults.clear();
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const a = c.observe('call', 'p', c.client.call('com.example.p', [1]));
    const b = c.observe('call', 'p', c.client.call('com.example.p', [2]));
    c.open();
    await advance(5000);
    expect(written(c, 1).map((f) => f[0])).toEqual([1]);
    expect(
      written(c, 2)
        .filter((f) => f[0] === 48)
        .map((f) => (f[4] as unknown[])[0]),
    ).toEqual([1, 2]);
    expect([a.values.length, b.values.length, topic.closed]).toEqual([1, 1, false]);
  });

  test('liveness: an unanswered probe whose outbound backlog is draining is alive, then dead when stuck', async () => {
    const c = start({ timeouts: { idle: 1000 } }, (x) => {
      x.router.ignore((f) => f[3] === 'thruway.js.ping');
    });
    await advance(1);
    let backlog = 100000;
    c.connection.controls.setBufferedAmount(() => (backlog = Math.max(0, backlog - 10000)));
    await advance(1000 + 20000); // the ping timer fires: the backlog shrank since the probe
    expect(closes(c)).toHaveLength(0);
    c.connection.controls.setBufferedAmount(5);
    await advance(30000);
    expect(closes(c)[0]?.error).toMatchObject({ timer: 'liveness' });
  });
});
