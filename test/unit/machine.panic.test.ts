// Contained internal exceptions. A throw out of a step is a client bug: `hardReset` closes every socket (4002) and
// terminates it, clears every timer, cancels a pending challenge on the same runner, builds fresh participants and
// liveness (the client-level register ghost memory survives), settles every one-shot with ConnectionLostError{cause:
// ProtocolError('internal error')}, restarts every interest dormant, tells the app (onClose) and reconnects — or, when
// the client was stopped, stays stopped (no resurrection after close()). Faults are injected into every participant and
// liveness method in turn through the faults hook, and into the serializer, clock.random, ws.send and ws.close, which
// are handled as the failures they represent (no hardReset). `lastResort` is exercised directly.
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { clockAccess, platformTimers, TimerScope } from '../../src/core/clock.js';
import { Connection } from '../../src/core/connection.js';
import type { LivenessHost, SessionCtx } from '../../src/core/contracts.js';
import { Core, type FaultsHook } from '../../src/core/machine.js';
import { isThruwayError } from '../../src/errors.js';
import { Liveness } from '../../src/ops/liveness.js';
import { TopicParticipant } from '../../src/ops/topic.js';
import { normalizeOptions } from '../../src/options.js';
import { createSimClock, createSimRouter } from '../../src/testing/sim.js';
import type { ClientOptions, CloseInfo, LogEntry } from '../../src/types.js';
import { createHarness, type Harness, type HarnessOptions, type SimClient } from '../helpers/harness.js';

interface Scenario {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly faults: FaultsHook;
}

function scenario(options: ClientOptions = {}, router: HarnessOptions['router'] = {}): Scenario {
  const h = createHarness({ seed: 66, router, checks: { internalLogs: false } });
  h.router.declareTopic('com.example.t');
  h.router.procedure('com.example.slow', () => new Promise(() => undefined));
  h.router.procedure('com.example.p', () => 'pong');
  const c = h.makeClient(Client, {
    options: { timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 100 }, ...options },
  });
  return { h, c, faults: c.faults as FaultsHook };
}

const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s) => s.state);
const internals = (c: SimClient<Client>) => c.trace().logs.filter((l) => l.entry.event === 'internal');

/** The client recovers: a new session, interests re-established there, a new call answered; close() works. */
async function recovered(s: Scenario, label: string): Promise<void> {
  const { h, c } = s;
  s.faults.clear();
  await h.clock.advance(5000);
  expect(states(c).at(-1), label).toBe('open');
  const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
  await h.clock.advance(5);
  expect(call.values.length, label).toBe(1);
  await h.closeAndSettle();
  expect(h.problems(), label).toEqual([]);
}

/** Every participant / liveness / runner method fault, with the action that makes the core call it. */
const PARTICIPANT_FAULTS: readonly (readonly [string, (s: Scenario) => Promise<void> | void])[] = [
  [
    'call.write',
    (s) => {
      s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    },
  ],
  [
    'call.inbound',
    (s) => {
      s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    },
  ],
  [
    'call.stop',
    async (s) => {
      s.faults.clear();
      const r = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
      await s.h.clock.advance(1);
      s.faults.inject('call.stop');
      r.unsubscribe();
    },
  ],
  [
    'call.sessionEnded',
    (s) => {
      s.c.connection.controls.drop();
    },
  ],
  [
    'call.pendingIds',
    (s) => {
      s.c.observe('publish', 't', s.c.client.publish('com.example.t'));
    },
  ],
  [
    'publish.write',
    (s) => {
      s.c.observe('publish', 't', s.c.client.publish('com.example.t'));
    },
  ],
  [
    'publish.inbound',
    (s) => {
      s.c.observe('publish', 't', s.c.client.publish('com.example.t', [], {}, { acknowledge: true }));
    },
  ],
  [
    'publish.sessionEnded',
    (s) => {
      s.c.connection.controls.drop();
    },
  ],
  [
    'topic.start',
    (s) => {
      s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    },
  ],
  [
    'topic.inbound',
    (s) => {
      s.h.router.publish('com.example.t', [1]);
    },
  ],
  [
    'topic.stop',
    async (s) => {
      s.faults.clear();
      const t = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
      await s.h.clock.advance(1);
      s.faults.inject('topic.stop');
      t.unsubscribe();
    },
  ],
  [
    'topic.welcome',
    async (s) => {
      s.c.connection.controls.drop();
      await s.h.clock.advance(200); // the next WELCOME
    },
  ],
  [
    'topic.sessionEnded',
    (s) => {
      s.c.connection.controls.drop();
    },
  ],
  [
    'register.start',
    (s) => {
      s.c.observe(
        'register',
        'r',
        s.c.client.register('com.example.r2', () => 1),
      );
    },
  ],
  [
    'register.inbound',
    (s) => {
      s.c.observe(
        'register',
        'r',
        s.c.client.register('com.example.r2', () => 1),
      );
    },
  ],
  [
    'register.welcome',
    async (s) => {
      s.c.connection.controls.drop();
      await s.h.clock.advance(200); // the next WELCOME
    },
  ],
  [
    'register.sessionEnded',
    (s) => {
      s.c.connection.controls.drop();
    },
  ],
  [
    'register.handlerEvent',
    async (s) => {
      s.faults.clear();
      s.c.observe(
        'register',
        'r',
        s.c.client.register('com.example.r2', () => 1),
      );
      await s.h.clock.advance(1);
      s.faults.inject('register.handlerEvent');
      s.c.observe('call', 'r', s.c.client.call('com.example.r2'));
    },
  ],
  [
    'liveness.inbound',
    (s) => {
      s.h.router.publish('com.example.t', [1]);
    },
  ],
  [
    'liveness.wrote',
    (s) => {
      s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    },
  ],
  [
    'liveness.check',
    (s) => {
      s.c.open();
    },
  ],
  [
    'liveness.sessionEnded',
    (s) => {
      s.c.connection.controls.drop();
    },
  ],
  [
    'liveness.pendingIds',
    (s) => {
      s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    },
  ],
  [
    'liveness.start',
    async (s) => {
      s.c.connection.controls.drop();
      await s.h.clock.advance(200); // the next WELCOME
    },
  ],
  [
    'liveness.endpoint',
    async (s) => {
      s.c.connection.controls.drop();
      await s.h.clock.advance(200); // the next WELCOME
    },
  ],
  [
    'liveness.sent',
    async (s) => {
      s.faults.clear();
      const r = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
      await s.h.clock.advance(1);
      s.faults.inject('liveness.sent');
      r.unsubscribe(); // CANCEL: written, then liveness throws
    },
  ],
];

describe('a fault in any participant or liveness method ⇒ hardReset, then a working session again', () => {
  test.each(PARTICIPANT_FAULTS)('%s', async (target, act) => {
    const s = scenario();
    const topic = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    const reg = s.c.observe(
      'register',
      'r',
      s.c.client.register('com.example.r', () => 'r'),
    );
    const inflight = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(2);
    s.faults.inject(target);
    await act(s);
    await s.h.clock.advance(2);
    expect(internals(s.c).length, target).toBeGreaterThanOrEqual(1);
    expect(internals(s.c)[0]?.entry.message).toMatch(/internal error, the client was reset/);
    // every one-shot settled; interests are alive (not errored) and come back
    expect(inflight.closed, target).toBe(true);
    if (inflight.errored) expect(isThruwayError(inflight.error), target).toBe(true);
    expect(topic.errored || reg.errored, target).toBe(false);
    await recovered(s, target);
  });

  test('hardReset closes the socket with 4002 and terminates it, then reconnects with backoff', async () => {
    const s = scenario({}, { terminate: true });
    await s.h.clock.advance(2);
    s.faults.inject('call.write');
    const call = s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(call.error).toMatchObject({ code: 'connection_lost', procedure: 'com.example.p' });
    expect((call.error as { cause?: unknown }).cause).toMatchObject({ code: 'protocol', message: 'internal error' });
    expect(s.c.connections[0]!.controls.closeCalls[0]).toEqual({ code: 4002, reason: 'client internal error' });
    expect(s.c.connections[0]!.controls.terminateCalls).toBe(1);
    expect(closes(s.c).at(-1)).toMatchObject({ initiator: 'connection', closeCode: 4002, willRetry: true, attempt: 1 });
    expect(closes(s.c).at(-1)?.error).toMatchObject({ code: 'protocol', message: 'internal error', attempt: 1 });
    await recovered(s, 'call.write');
  });

  test('queued (waiting) one-shots are failed too: re-subscribing is safe and waits for the next session', async () => {
    const s = scenario({}, {});
    s.h.router.setAvailable('refuse');
    await s.h.clock.advance(1);
    const waiting = s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    s.faults.inject('topic.start');
    s.c.observe('topic', 't', s.c.client.topic('com.example.t')); // in WAITING: start(op, undefined) throws
    expect(waiting.error).toMatchObject({ code: 'connection_lost' });
    expect(closes(s.c)).toHaveLength(1); // the WAITING end was told already: no second onClose
    s.h.router.setAvailable('ok');
    await recovered(s, 'waiting');
  });

  test('a fault in a participant during the end procedure: one onClose, everything settled, reconnect', async () => {
    const s = scenario();
    const inflight = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(2);
    s.faults.inject('topic.sessionEnded');
    s.c.connection.controls.drop();
    await s.h.clock.advance(1);
    expect(closes(s.c)).toHaveLength(1);
    expect(inflight.error).toMatchObject({ code: 'connection_lost' });
    await recovered(s, 'end');
  });

  test('a fault in sessionEnded keeps the retry the end announced: its delay, and one failure counted (INV-R2)', async () => {
    const s = scenario({ retryOptions: { retryDelay: (n) => n * 1000 } });
    s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(20);
    s.faults.inject('call.sessionEnded');
    s.c.connection.controls.drop();
    await s.h.clock.advance(1);
    expect(closes(s.c).map((i) => [i.attempt, i.delay, i.willRetry])).toEqual([[1, 1000, true]]);
    await s.h.clock.advance(998);
    expect(s.c.connections).toHaveLength(1); // not earlier than announced
    await s.h.clock.advance(2);
    expect(s.c.connections).toHaveLength(2);
    expect(s.c.status?.values.filter((v) => v.state === 'connecting')).toEqual([
      { state: 'connecting', attempt: 1 },
      { state: 'connecting', attempt: 2 }, // the one failure, not two
    ]);
    await recovered(s, 'sessionEnded');
  });

  test('a fault in sessionEnded at a give-up end: stopped, every op Closed{gaveUp}, one onClose, no reconnect', async () => {
    const s = scenario({ retryOptions: { maxRetries: 0 } });
    const topic = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    const inflight = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(20);
    s.faults.inject('call.sessionEnded');
    s.c.connection.controls.drop();
    await s.h.clock.advance(1);
    expect(closes(s.c).map((i) => i.willRetry)).toEqual([false]);
    for (const r of [inflight, topic]) expect(r.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
    await s.h.clock.advance(120000);
    expect(s.c.connections).toHaveLength(1);
    expect(closes(s.c)).toHaveLength(1);
    expect(s.c.debug()).toMatchObject({ state: 'CLOSED', stopped: true, registry: 0, timers: 0 });
    await s.h.closeAndSettle();
  });

  test('a hardReset while waiting keeps the scheduled retry: no extra failure, and no give-up the app is not told of', async () => {
    const h = createHarness({ seed: 68, checks: { internalLogs: false } });
    h.router.declareTopic('com.example.t');
    h.router.setAvailable('refuse');
    const c = h.makeClient(Client, {
      options: { timeouts: { idle: 0 }, retryOptions: { maxRetries: 1, retryDelay: () => 5000 } },
    });
    await h.clock.advance(10);
    expect(closes(c).map((i) => [i.attempt, i.willRetry, i.delay])).toEqual([[1, true, 5000]]);
    (c.faults as FaultsHook).inject('topic.start');
    const topic = c.observe('topic', 't', c.client.topic('com.example.t')); // throws in WAITING: hardReset
    expect(internals(c)).toHaveLength(1);
    expect(topic.closed).toBe(false); // restarted dormant: the client has not given up
    expect(closes(c)).toHaveLength(1);
    expect(c.debug()).toMatchObject({ state: 'WAITING', stopped: false });
    h.router.setAvailable('ok');
    await h.clock.advance(4989);
    expect(c.connections).toHaveLength(1);
    await h.clock.advance(2);
    expect(states(c).slice(-2)).toEqual(['connecting', 'open']);
    expect(topic.values).toHaveLength(0);
    expect(c.trace().frames.filter((f) => f.direction === 'in' && (f.frame as unknown[])[0] === 32)).toHaveLength(1);
    await h.closeAndSettle();
  });

  test('a fault in the end of a reconnect() with maxRetries 0: the announced retry comes, nothing gives up', async () => {
    const s = scenario({ retryOptions: { maxRetries: 0 } });
    s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(1500);
    s.faults.inject('call.sessionEnded'); // reconnect(): the end fails after it armed the retry it announced
    s.c.reconnect();
    await s.h.clock.advance(1);
    // the app was told "app, willRetry": the reset counts no failure, so it neither gives up nor changes that retry
    expect(closes(s.c).map((i) => [i.initiator, i.willRetry, i.attempt])).toEqual([['app', true, 0]]);
    expect(states(s.c).slice(-2)).toEqual(['connecting', 'open']);
    expect(s.c.status?.values.at(-2)).toMatchObject({ state: 'connecting', attempt: 1 });
    await recovered(s, 'reconnect, maxRetries 0');
  });

  test('a fault in the end of a reconnect(): told once (the reconnect), then the retry it announced', async () => {
    const s = scenario();
    const inflight = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(500); // within the attempt floor: the reconnect's retry waits the remaining 500 ms
    s.faults.inject('call.sessionEnded');
    s.c.reconnect();
    await s.h.clock.advance(1);
    expect(closes(s.c).map((i) => [i.initiator, i.willRetry, i.delay])).toEqual([['app', true, 500]]);
    expect(inflight.error).toMatchObject({ code: 'connection_lost' });
    expect(s.c.debug()).toMatchObject({ state: 'WAITING', timers: 1 });
    await s.h.clock.advance(498);
    expect(s.c.connections).toHaveLength(1);
    await s.h.clock.advance(2);
    expect(states(s.c).slice(-2)).toEqual(['connecting', 'open']);
    await recovered(s, 'reconnect');
  });

  test('hardReset in a session: the app hears the end (with its sessionId) before in-flight ops fail', async () => {
    const s = scenario();
    await s.h.clock.advance(10);
    const order: string[] = [];
    s.c.client.onClose.subscribe((i) => order.push(`onClose ${String(i.sessionId)}`));
    s.c.client.status.subscribe((v) => order.push(`status ${v.state}`));
    let lost: unknown;
    s.c.client.call('com.example.slow').subscribe({
      error: (e: unknown) => {
        lost = e;
        order.push('call error');
      },
    });
    await s.h.clock.advance(10);
    order.length = 0;
    s.faults.inject('topic.start');
    s.c.client.topic('com.example.t').subscribe(() => undefined);
    const sessionId = closes(s.c).at(-1)?.sessionId;
    expect(sessionId).toBeTypeOf('number');
    expect(order).toEqual(['status closed', `onClose ${String(sessionId)}`, 'call error']);
    expect(lost).toMatchObject({ code: 'connection_lost', sessionId, procedure: 'com.example.slow' });
    expect(closes(s.c).at(-1)).toMatchObject({ closeCode: 4002, willRetry: true, attempt: 1 });
    expect(s.c.trace().logs.some((l) => l.entry.event === 'session.end')).toBe(true);
    await recovered(s, 'session');
  });

  test('a liveness fault at the end of an attempt: the app is told once (never connecting → connecting)', async () => {
    const s = scenario({ autoOpen: false });
    s.faults.inject('liveness.sessionEnded');
    s.c.open();
    s.c.connection.controls.drop(); // CONNECTING: the end's liveness cleanup throws
    await s.h.clock.advance(1);
    expect(internals(s.c)).toHaveLength(1);
    expect(closes(s.c).map((i) => [i.attempt, i.willRetry, i.error?.code])).toEqual([[1, true, 'connection_lost']]);
    expect(states(s.c)).toEqual(['closed', 'connecting', 'closed']);
    await recovered(s, 'end');
  });

  test('a liveness fault inside close(): the socket still lingers and is released, the close is announced', async () => {
    const s = scenario();
    const topic = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    await s.h.clock.advance(5);
    s.faults.inject('liveness.sessionEnded');
    const done = { value: false };
    void s.c.close().then(() => {
      done.value = true;
    });
    await s.h.clock.advance(1);
    expect(internals(s.c)).toHaveLength(1);
    expect(closes(s.c).map((i) => [i.initiator, i.reason])).toEqual([['app', 'wamp.close.close_realm']]);
    expect(states(s.c).at(-1)).toBe('closed');
    expect(topic.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
    const socket = s.c.connections[0]!;
    expect(socket.controls.closeCalls.length).toBeGreaterThan(0); // released (hardReset closes the lingering socket)
    expect(socket.controls.listenerCount).toBe(0);
    expect(done.value).toBe(true);
    s.faults.clear();
    await s.h.closeAndSettle();
    expect(s.h.problems()).toEqual([]);
  });

  test('a fault while restarting interests inside hardReset is contained there (logged, the rest continues)', async () => {
    const s = scenario();
    s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    await s.h.clock.advance(2);
    s.faults.inject('topic.start', 'always');
    s.faults.inject('call.write');
    s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(s.c.trace().logs.some((l) => l.entry.event === 'unhandled' && l.entry.message.includes('hardReset'))).toBe(
      true,
    );
    s.faults.clear();
    await recovered(s, 'restart');
  });
});

describe('faults the client handles as the failure they represent (no hardReset)', () => {
  test('serializer.serialize on a CALL fails only that call', async () => {
    const s = scenario();
    await s.h.clock.advance(2);
    s.faults.inject('serializer.serialize', 'once', new TypeError('BigInt'));
    const call = s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(call.error).toBeInstanceOf(TypeError);
    expect(internals(s.c)).toEqual([]);
    expect(states(s.c).at(-1)).toBe('open');
    await recovered(s, 'serialize');
  });

  test('serializer.serialize on HELLO ends that attempt with a ProtocolError and retries', async () => {
    const s = scenario({ autoOpen: false });
    s.faults.inject('serializer.serialize');
    s.c.open();
    await s.h.clock.advance(1);
    expect(closes(s.c)[0]?.error).toMatchObject({
      code: 'protocol',
      message: 'a handshake frame could not be serialized',
    });
    expect(internals(s.c)).toEqual([]);
    await recovered(s, 'hello');
  });

  test('serializer.deserialize ⇒ a header-fatal frame: ABORT protocol_violation, reconnect', async () => {
    const s = scenario();
    await s.h.clock.advance(2);
    s.faults.inject('serializer.deserialize');
    s.h.router.publish('com.example.t', []);
    s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    await s.h.clock.advance(1);
    expect(closes(s.c)[0]).toMatchObject({ reason: 'wamp.error.protocol_violation' });
    expect(internals(s.c)).toEqual([]);
    await recovered(s, 'deserialize');
  });

  test('clock.random ⇒ option.fallback; ws.send ⇒ a refused write (a loss); ws.close ⇒ the adapter fallbacks', async () => {
    const s = scenario();
    await s.h.clock.advance(2);
    s.faults.inject('clock.random', 'always');
    s.c.connection.controls.drop();
    await s.h.clock.advance(5000);
    expect(s.c.trace().logs.some((l) => l.entry.event === 'option.fallback')).toBe(true);
    s.faults.clear();
    s.faults.inject('ws.send');
    s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    await s.h.clock.advance(1);
    expect(closes(s.c).at(-1)?.error).toMatchObject({ code: 'connection_lost', closeCode: 1006 });
    await s.h.clock.advance(5000);
    s.faults.inject('ws.close', 'always');
    s.c.reconnect();
    await s.h.clock.advance(5000);
    expect(internals(s.c)).toEqual([]);
    await recovered(s, 'clock/ws');
  });

  test('challenge.run (a runner bug) fails that round: ABORT cannot_authenticate, never a hang', async () => {
    let n = 0;
    const s = scenario(
      { authmethods: ['ticket'], onChallenge: () => 'x', autoOpen: false },
      {
        authenticate: () => ({
          challenge: { method: 'ticket' },
          verify: () => ({ welcome: { authid: `j${String(++n)}` } }),
        }),
      },
    );
    s.faults.inject('challenge.run');
    s.c.open();
    await s.h.clock.advance(1);
    expect(closes(s.c).at(-1)).toMatchObject({ reason: 'wamp.error.cannot_authenticate' });
    await recovered(s, 'challenge.run');
  });

  test('challenge.cancel (a runner bug) is reported as unhandled; nothing else changes', async () => {
    const s = scenario();
    await s.h.clock.advance(2);
    s.faults.inject('challenge.cancel', 'always');
    s.c.connection.controls.drop(); // … no session-less end here; reconnect() delivers one
    await s.h.clock.advance(5000);
    s.c.reconnect();
    await s.h.clock.advance(5000);
    s.faults.clear();
    expect(internals(s.c)).toEqual([]);
    await recovered(s, 'challenge.cancel');
  });
});

describe('the challenge and the ghost memory across hardReset', () => {
  test('a pending onChallenge is cancelled on the same runner with ConnectionLostError{cause: ProtocolError}', async () => {
    let signal: AbortSignal | undefined;
    const s = scenario(
      {
        authmethods: ['ticket'],
        onChallenge: (ch) => {
          signal ??= ch.signal as AbortSignal;
          return signal === ch.signal ? new Promise<string>(() => undefined) : 'ok';
        },
      },
      { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) }) },
    );
    await s.h.clock.advance(1);
    expect(signal?.aborted).toBe(false);
    s.faults.inject('topic.start');
    s.c.observe('topic', 't', s.c.client.topic('com.example.t')); // CHALLENGED: start(op, undefined) throws
    await s.h.clock.advance(1);
    expect(signal?.reason).toMatchObject({ code: 'connection_lost' });
    expect((signal?.reason as { cause?: unknown }).cause).toMatchObject({
      code: 'protocol',
      message: 'internal error',
    });
    await recovered(s, 'challenge');
  });

  test('a re-REGISTER after a hardReset still rides out its own ghost (procedure_already_exists is retried)', async () => {
    const s = scenario();
    const reg = s.c.observe(
      'register',
      'r',
      s.c.client.register('com.example.ghost', () => 1),
    );
    await s.h.clock.advance(2);
    expect(reg.values).toHaveLength(1);
    // the router still holds the crashed session's registration on the next connection(s): it answers
    // procedure_already_exists twice, then accepts
    let refusals = 0;
    s.h.router.ignore((f, conn) => {
      if (f[0] !== 64 || conn.number === 1 || refusals >= 2) return false;
      refusals++;
      queueMicrotask(() => {
        s.h.router.sendRaw(JSON.stringify([8, 64, f[1], {}, 'wamp.error.procedure_already_exists']));
      });
      return true;
    });
    s.faults.inject('topic.start');
    s.c.observe('topic', 't', s.c.client.topic('com.example.t')); // a client bug: hardReset
    await s.h.clock.advance(10000);
    expect(refusals).toBe(2);
    expect(reg.errored).toBe(false);
    expect(reg.values).toHaveLength(2); // registered again after riding out the ghost
    expect(s.c.trace().logs.filter((l) => l.entry.event === 'register.ghost')).toHaveLength(2);
    await recovered(s, 'ghost');
  });

  test('the ghost memory is bounded: at most 1024 keys are remembered', async () => {
    const s = scenario();
    for (let i = 0; i < 1030; i++) s.c.client.register(`com.example.r${String(i)}`, () => 1).subscribe({});
    await s.h.clock.advance(5);
    s.faults.inject('call.write');
    s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    const debug = s.c.debug() as { participants: { register: { ghostKeys: number } } };
    expect(debug.participants.register.ghostKeys).toBe(1024);
    await s.h.clock.advance(5000);
    await s.h.closeAndSettle();
  });
});

describe('no resurrection after close()', () => {
  test('a fault inside close() leaves the client stopped: everything Closed, no reconnect, the promise resolves', async () => {
    const s = scenario();
    const topic = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    const call = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(2);
    s.faults.inject('topic.clientClosed');
    const state = { done: false };
    void s.c.close().then(() => {
      state.done = true;
    });
    await s.h.clock.advance(3000);
    expect(state.done).toBe(true);
    expect(topic.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
    expect(call.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
    expect(internals(s.c)).toHaveLength(1);
    await s.h.clock.advance(120000);
    expect(s.c.connections).toHaveLength(1);
    expect(states(s.c).at(-1)).toBe('closed');
    const late = s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(late.error).toMatchObject({ code: 'connection_closed' });
    s.faults.clear();
    await s.h.closeAndSettle();
  });

  test('a never-opened client stays closed after a hardReset; its interests stay dormant', async () => {
    const s = scenario({ autoOpen: false });
    s.faults.inject('register.start');
    const reg = s.c.observe(
      'register',
      'r',
      s.c.client.register('com.example.r', () => 1),
    );
    expect(internals(s.c)).toHaveLength(1);
    await s.h.clock.advance(60000);
    expect(s.c.connections).toHaveLength(0);
    expect(reg.closed).toBe(false);
    s.c.open();
    await s.h.clock.advance(5);
    expect(reg.values).toHaveLength(1);
    await s.h.closeAndSettle();
  });

  test('give-up after a hardReset when maxRetries is exhausted', async () => {
    const s = scenario({ retryOptions: { maxRetries: 0 } });
    const topic = s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    await s.h.clock.advance(2);
    s.faults.inject('call.write');
    s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(closes(s.c).at(-1)).toMatchObject({ willRetry: false });
    expect(topic.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
    await s.h.closeAndSettle();
  });
});

describe('lastResort (a throw out of hardReset itself: impossible by construction)', () => {
  function core(options: Partial<ClientOptions> = {}) {
    const clock = createSimClock({ seed: 3 });
    const router = createSimRouter({ clock: clock.scope('router') });
    const entries: string[] = [];
    const c = new Core(
      normalizeOptions(router.url, 'realm1', {
        WebSocket: router.WebSocket,
        clock: clock.scope('client'),
        timeouts: { idle: 0 },
        logger: (e: LogEntry) => entries.push(e.event),
        ...options,
      }),
    );
    return { c, clock, entries };
  }

  test('logs, then retries on a platform timer of maxRetryDelay unless stopped', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const set = vi.spyOn(platformTimers, 'setTimeout').mockImplementation((fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    });
    const clear = vi.spyOn(platformTimers, 'clearTimeout').mockImplementation(() => undefined);
    try {
      const { c, clock, entries } = core({ retryOptions: { maxRetryDelay: 5000 } });
      c.submit({ kind: 'open' });
      await clock.advance(1);
      c.lastResort(new Error('beyond repair'));
      expect(entries).toContain('internal');
      expect(c.state).toBe('WAITING');
      expect(timers.map((t) => t.ms)).toEqual([5000]);
      c.lastResort(new Error('again')); // re-arms: the earlier platform timer is cleared
      expect(clear).toHaveBeenCalledWith(1);
      c.submit({ kind: 'timer.retry', conn: 0, gen: -1 }); // a stale lastResort input (not armed any more)? no: armed
      expect(c.state).not.toBe('WAITING');
      c.submit({ kind: 'timer.retry', conn: 0, gen: -1 }); // now stale: dropped
      timers[1]!.fn(); // the platform timer fires late: dropped too
      await clock.advance(1);
      c.lastResort(new Error('third'));
      c.submit({ kind: 'close', resolve: () => undefined }); // close() clears the platform timer
      expect(clear).toHaveBeenCalledTimes(2);
      const before = timers.length;
      c.lastResort(new Error('stopped')); // stopped: nothing is armed
      expect(timers.length).toBe(before);
      expect(c.state).toBe('CLOSED');
      await clock.runUntilIdle();
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  test('a lastResort retry that fires starts an attempt (and an attempt started meanwhile clears it)', async () => {
    const timers: (() => void)[] = [];
    const set = vi.spyOn(platformTimers, 'setTimeout').mockImplementation((fn) => {
      timers.push(fn);
      return timers.length;
    });
    const clear = vi.spyOn(platformTimers, 'clearTimeout').mockImplementation(() => undefined);
    try {
      const { c, clock } = core({ autoOpen: false });
      c.lastResort(new Error('x'));
      timers[0]!();
      expect(c.state).toBe('CONNECTING');
      await clock.advance(1);
      c.lastResort(new Error('y'));
      c.submit({ kind: 'reconnect' }); // WAITING + reconnect ⇒ startSoon ⇒ an attempt: the platform timer is cleared
      await clock.advance(1000);
      expect(clear).toHaveBeenCalled();
      c.submit({ kind: 'close', resolve: () => undefined });
      await clock.runUntilIdle();
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
  test('a fault while the last-resort retry waits keeps it: nothing announced again, no failure counted', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const set = vi.spyOn(platformTimers, 'setTimeout').mockImplementation((fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    });
    const clear = vi.spyOn(platformTimers, 'clearTimeout').mockImplementation(() => undefined);
    try {
      const { c, clock, entries } = core({ retryOptions: { maxRetryDelay: 5000 } });
      const ends: CloseInfo[] = [];
      c.onClose.subscribe({ next: (info) => ends.push(info) });
      c.submit({ kind: 'open' });
      await clock.advance(1);
      c.lastResort(new Error('beyond repair'));
      const announced = ends.length;
      c.panic(new Error('a fault while waiting')); // WAITING on the last-resort timer, no retry timer armed
      await clock.advance(1);
      expect(entries.filter((e) => e === 'internal')).toHaveLength(2);
      expect(c.state).toBe('WAITING');
      expect(ends).toHaveLength(announced); // the wait it is in was not announced again
      expect(clear).not.toHaveBeenCalled(); // the last-resort timer is kept
      timers[0]!.fn(); // it fires: an attempt starts
      expect(c.state).toBe('CONNECTING');
      c.submit({ kind: 'close', resolve: () => undefined });
      await clock.runUntilIdle();
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});

describe('more containment paths', () => {
  test('two client bugs inside ctx.request in one step: the first is reported, one hardReset', async () => {
    const s = scenario();
    s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    s.c.observe(
      'register',
      'r',
      s.c.client.register('com.example.r', () => 1),
    );
    await s.h.clock.advance(2);
    s.faults.inject('call.pendingIds', 'always', new Error('allocator bug'));
    s.c.connection.controls.drop(); // the next WELCOME allocates for the REGISTER and the SUBSCRIBE: both fail
    await s.h.clock.advance(150);
    const resets = internals(s.c);
    expect(resets).toHaveLength(1);
    expect(resets[0]?.entry.message).toMatch(/allocator bug/);
    s.faults.clear('call.pendingIds');
    await recovered(s, 'two in one step');
  });

  test('faults.clear(target) removes only that fault', async () => {
    const s = scenario();
    await s.h.clock.advance(2);
    s.faults.inject('topic.start', 'always');
    s.faults.inject('call.write', 'always');
    s.faults.clear('topic.start');
    s.c.observe('topic', 't', s.c.client.topic('com.example.t'));
    expect(internals(s.c)).toEqual([]);
    s.c.observe('call', 'p', s.c.client.call('com.example.p'));
    expect(internals(s.c)).toHaveLength(1);
    await recovered(s, 'clear(target)');
  });

  test('a challenge.cancel bug (reconnect() while connecting) is reported as unhandled; the attempt starts anyway', async () => {
    const s = scenario({}, {});
    s.h.router.setAvailable('hang');
    s.c.connection.controls.drop();
    await s.h.clock.advance(1500);
    s.faults.inject('challenge.cancel', 'always');
    s.h.router.setAvailable('ok');
    s.c.reconnect();
    await s.h.clock.advance(5);
    expect(s.c.trace().logs.some((l) => l.entry.event === 'unhandled' && l.entry.message.includes('a delivery'))).toBe(
      true,
    );
    expect(internals(s.c)).toEqual([]);
    await recovered(s, 'challenge.cancel while connecting');
  });

  test('a hardReset while resolving: the attempt without a socket is abandoned and retried', async () => {
    const h = createHarness({ seed: 67, checks: { internalLogs: false } });
    h.router.declareTopic('com.example.t');
    let calls = 0;
    const c = h.makeClient(Client, {
      url: () => (++calls === 1 ? new Promise<string>(() => undefined) : h.router.url),
      options: { timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 100 } },
    });
    await h.clock.advance(1);
    (c.faults as FaultsHook).inject('topic.start');
    c.observe('topic', 't', c.client.topic('com.example.t'));
    expect(closes(c).at(-1)).toMatchObject({ initiator: 'connection', closeCode: undefined, willRetry: true });
    await h.clock.advance(200);
    expect(states(c).at(-1)).toBe('open');
    await h.closeAndSettle();
  });

  test('a ctx captured by a participant is inert once its session ended: send false, request undefined, no timer', async () => {
    const s = scenario();
    let captured: SessionCtx | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const original = TopicParticipant.prototype.welcome;
    const spy = vi.spyOn(TopicParticipant.prototype, 'welcome').mockImplementation(function (
      this: TopicParticipant,
      ctx,
    ) {
      captured = ctx;
      original.call(this, ctx);
    });
    try {
      await s.h.clock.advance(5);
      expect(captured?.session.id).toBe(s.c.client.session?.id);
      s.c.connection.controls.drop();
      await s.h.clock.advance(1);
      const ctx = captured!;
      expect(ctx.send([49, 1, { mode: 'killnowait' }])).toBe(false);
      expect(ctx.request((id) => [48, id, {}, 'com.example.p'])).toBeUndefined();
      expect(s.c.scope.pendingTimers).toBe(1); // the retry timer
      const timer = ctx.timer(1000, 'topic', 1, true);
      expect(s.c.scope.pendingTimers).toBe(1); // nothing was armed for the ended session
      timer.cancel(); // and its handle is inert
      ctx.log(() => ({ level: 'debug', event: 'x', message: 'still logs' }));
      expect(s.c.trace().logs.some((l) => l.entry.message === 'still logs')).toBe(true);
      expect(typeof ctx.now).toBe('number');
    } finally {
      spy.mockRestore();
    }
    await recovered(s, 'stale ctx');
  });

  test('the liveness host ignores a ctx whose session has ended', async () => {
    const s = scenario({ timeouts: { idle: 1000 } });
    await s.h.clock.advance(2);
    let host: LivenessHost | undefined;
    let ctx: SessionCtx | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below
    const start = Liveness.prototype.start;
    const spy = vi.spyOn(Liveness.prototype, 'start').mockImplementation(function (this: Liveness, c, roles) {
      host = (this as unknown as { host: typeof host }).host;
      ctx = c;
      start.call(this, c, roles);
    });
    try {
      s.c.connection.controls.drop();
      await s.h.clock.advance(150);
      s.c.connection.controls.drop();
      await s.h.clock.advance(1);
      const timers = s.c.scope.pendingTimers;
      host!.armIdle(ctx!, 10);
      host!.armPing(ctx!, 10);
      host!.cancelPing(ctx!);
      expect(host!.bufferedAmount(ctx!)).toBe(0);
      expect(s.c.scope.pendingTimers).toBe(timers);
    } finally {
      spy.mockRestore();
    }
    await recovered(s, 'stale host calls');
  });

  test('a connection without a socket (resolving) writes nothing; its stand-in transport is inert', () => {
    const conn = new Connection(
      1,
      new TimerScope(clockAccess(createSimClock().scope('client'), () => undefined)),
      {
        protocol: 'wamp.2.json',
        binary: false,
        serialize: () => '[]',
        deserialize: () => [],
      },
      () => undefined,
    );
    expect(conn.hasSocket).toBe(false);
    expect(conn.write([6, {}, 'wamp.close.close_realm'])).toBe(false);
    expect(conn.transport.send('x')).toBe(false);
    expect(conn.transport.bufferedAmount()).toBe(0);
    conn.transport.terminate();
    conn.release(1000);
  });
});
