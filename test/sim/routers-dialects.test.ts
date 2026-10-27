// The quirks of real routers, reproduced by the reference router's dialects (src/testing/dialects.ts), and the client
// handling each one needs — in the sim, under the virtual clock; the integration suite runs the same cases against
// the real routers. Thruway PHP first. Every scenario ends with the harness's end-of-run checks and the INV-*
// checkers that apply. First, a router GOODBYE against routers that close at once, later, never, or lose the closing
// frames.
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import { isThruwayError, type AbortError, type TimeoutError, type WampError } from '../../src/errors.js';
import { Observable } from '../../src/observable/observable.js';
import type { DialectName, SimAuthProvider, SimRouterOptions } from '../../src/testing/sim.js';
import type { ClientOptions, CloseInfo, Status } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { checkInvariants, formatViolations, topicKey, type InvariantId, type OpInfo } from '../helpers/invariants.js';

interface Env {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly ops: Map<number, OpInfo>;
}

function start(
  dialect: DialectName,
  options: ClientOptions = {},
  router: Omit<SimRouterOptions, 'clock' | 'dialect'> = {},
  setup?: (h: Harness) => void,
): Env {
  const h = createHarness({ seed: 21, router: { dialect, ...router }, checks: { unscripted: false } });
  h.router.declareTopic('rd.t');
  h.router.procedure('rd.p', (args) => args[0] ?? 'pong');
  h.router.procedure('rd.never', () => new Promise(() => undefined));
  setup?.(h);
  const c = h.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
  return { h, c, ops: new Map() };
}

async function finish(e: Env, ids?: readonly InvariantId[], timings = { idle: 0 }): Promise<void> {
  await e.h.finish();
  const trace = e.c.trace();
  const found = checkInvariants(trace, { ops: e.ops, timings, final: true }, ids);
  expect(found, formatViolations(found, trace)).toEqual([]);
}

const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s: Status) => s.state);
function written(c: SimClient<Client>, n?: number): unknown[][] {
  const socket = n === undefined ? undefined : c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && (socket === undefined || f.connection === socket))
    .map((f) => f.frame as unknown[]);
}
function received(c: SimClient<Client>): unknown[][] {
  return c
    .trace()
    .frames.filter((f) => f.direction === 'out' && Array.isArray(f.frame))
    .map((f) => f.frame as unknown[]);
}
const code = (e: unknown): unknown => (isThruwayError(e) ? e.code : e);

const TICKET: readonly SimAuthProvider[] = [
  { method: 'ticket', verify: (signature) => (signature === 'secret' ? { authid: 'joe', authrole: 'user' } : false) },
];
const ticket = (signature = 'secret'): ClientOptions => ({
  authmethods: ['ticket'],
  authid: 'joe',
  onChallenge: () => signature,
});

// --- a router GOODBYE, on every dialect ------------------------------------------------------------------------------

/** How each dialect ends the connection after the GOODBYE handshake: what the client must cope with. */
const GOODBYE_CLOSE: Readonly<Record<DialectName, string>> = {
  spec: 'the router closes at once',
  'thruway-php': 'the router answers the reply and closes (1000)',
  crossbar: 'the socket is left open: the client closes it',
  nexus: 'the closing frames are lost: a bare 1006',
  bondy: 'the router closes (1005)',
  'fox-wamp': 'the router closes (1000)',
  'wamp-server': 'the router closes (1005)',
};

describe('a router GOODBYE on every dialect: one reply (if it arrived), reconnect, interests re-established', () => {
  for (const [dialect, how] of Object.entries(GOODBYE_CLOSE) as [DialectName, string][]) {
    test(`${dialect}: ${how}`, async () => {
      const e = start(dialect);
      const { h, c, ops } = e;
      const topic = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
      ops.set(topic.id, { kind: 'topic', key: topicKey('rd.t', {}) });
      const reg = c.observe(
        'register',
        'rd.r',
        c.client.register('rd.r', () => 'callee'),
      );
      ops.set(reg.id, { kind: 'register' });
      const inFlight = c.observe('call', 'rd.never', c.client.call('rd.never'));
      ops.set(inFlight.id, { kind: 'call' });
      await h.clock.advance(10);
      h.router.kill(h.router.sessions[0]!.id, 'wamp.close.killed');
      await h.clock.advance(10000);
      const first = written(c, 1);
      const delivered = h.router.quirks.closing_frames_delivered;
      expect(first.filter((f) => f[0] === 6)).toHaveLength(delivered ? 1 : 0);
      expect(first.filter((f) => f[0] === 1)).toHaveLength(1); // never a second HELLO on the old socket
      expect(closes(c).map((i) => (delivered ? i.initiator : i.initiator === 'connection'))).toEqual([
        delivered ? 'router' : true,
      ]);
      if (delivered) expect(closes(c)[0]?.reason).toBe('wamp.close.killed');
      expect(code(inFlight.error)).toBe('connection_lost');
      expect(c.connections).toHaveLength(2);
      expect(states(c).at(-1)).toBe('open');
      // the interests survive and are re-established on the new session
      expect(written(c, 2).filter((f) => f[0] === 32 || f[0] === 64)).toHaveLength(2);
      expect([topic.closed, reg.closed]).toEqual([false, false]);
      h.router.publish('rd.t', ['after']);
      const call = h.router.invoke('rd.r');
      await h.clock.advance(10);
      expect(topic.values.length).toBeGreaterThanOrEqual(1);
      expect(call.result?.args).toEqual(['callee']);
      await finish(e);
    });
  }
});

// --- Thruway PHP -----------------------------------------------------------------------------------------------------

describe('Thruway PHP', () => {
  test('a wildcard SUBSCRIBE never answered: TimeoutError{request} on that stream only, the session goes on', async () => {
    const e = start('thruway-php', { timeouts: { idle: 0, request: 2000 } });
    const { h, c, ops } = e;
    const wild = c.observe('topic', 'rd..t', c.client.topic('rd..t', { match: 'wildcard' }));
    ops.set(wild.id, { kind: 'topic', key: topicKey('rd..t', { match: 'wildcard' }) });
    const plain = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    ops.set(plain.id, { kind: 'topic', key: topicKey('rd.t', {}) });
    await h.clock.advance(3000);
    expect(code(wild.error)).toBe('timeout');
    expect((wild.error as TimeoutError).timer).toBe('request');
    expect(plain.closed).toBe(false);
    expect(closes(c)).toEqual([]);
    h.router.publish('rd.t', ['still here']);
    await h.clock.advance(10);
    expect(plain.values).toHaveLength(1);
    await finish(e);
  });

  test('the legacy GOODBYE reply wamp.error.goodbye_and_out and the router’s close: close() resolves cleanly', async () => {
    const e = start('thruway-php');
    const { h, c } = e;
    await h.clock.advance(10);
    await Promise.all([c.close(), h.clock.advance(5000)]);
    expect(received(c).filter((f) => f[0] === 6)).toEqual([[6, {}, 'wamp.error.goodbye_and_out']]);
    expect(closes(c).map((i) => [i.initiator, i.reason, i.error])).toEqual([
      ['app', 'wamp.close.close_realm', undefined],
    ]);
    await finish(e);
  });

  test('a new subscription id per SUBSCRIBE: two local subscribers ⇒ one SUBSCRIBE, one EVENT each', async () => {
    const e = start('thruway-php');
    const { h, c } = e;
    const a = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    const b = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    await h.clock.advance(10);
    h.router.publish('rd.t', ['e1']);
    await h.clock.advance(10);
    expect(written(c).filter((f) => f[0] === 32)).toHaveLength(1);
    expect([a.values.length, b.values.length]).toEqual([1, 1]);
    a.unsubscribe();
    await h.clock.advance(10);
    expect(written(c).filter((f) => f[0] === 34)).toHaveLength(0); // b still holds the key
    await finish(e);
  });

  test('frames are routed before AUTHENTICATE there, so the client sends nothing but HELLO and AUTHENTICATE first', async () => {
    let answer: ((s: string) => void) | undefined;
    const e = start(
      'thruway-php',
      {
        authmethods: ['ticket'],
        authid: 'joe',
        onChallenge: () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
      },
      { providers: TICKET },
    );
    const { h, c } = e;
    const call = c.observe('call', 'rd.p', c.client.call('rd.p', ['early']));
    c.observe('publish', 'rd.t', c.client.publish('rd.t', ['early']));
    await h.clock.advance(2000);
    expect(written(c).map((f) => f[0])).toEqual([1]);
    answer?.('secret');
    await h.clock.advance(10);
    expect(written(c).map((f) => f[0])).toEqual([1, 5, 48, 16]);
    expect(call.values).toMatchObject([{ args: ['early'] }]);
    await finish(e);
  });

  test('CANCEL answered ERROR(49, canceled) at once: the call settled locally, the answer dropped', async () => {
    const e = start('thruway-php');
    const { h, c } = e;
    await h.clock.advance(10);
    const call = c.observe('call', 'rd.never', c.client.call('rd.never'));
    await h.clock.advance(10);
    call.unsubscribe();
    await h.clock.advance(10);
    expect(written(c).filter((f) => f[0] === 49)).toMatchObject([[49, expect.any(Number), { mode: 'killnowait' }]]);
    expect(received(c).filter((f) => f[0] === 8 && f[1] === 49)).toHaveLength(1);
    expect(call.errored).toBe(false);
    expect(closes(c)).toEqual([]);
    await finish(e);
  });

  test('INTERRUPT {} (no mode) is a kill: the handler is aborted and ERROR(68, canceled) answers it', async () => {
    const e = start('thruway-php');
    const { h, c, ops } = e;
    let aborted = false;
    const reg = c.observe(
      'register',
      'rd.slow',
      c.client.register(
        'rd.slow',
        (inv) =>
          new Promise(() => {
            inv.signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      ),
    );
    ops.set(reg.id, { kind: 'register' });
    await h.clock.advance(10);
    const call = h.router.invoke('rd.slow');
    await h.clock.advance(10);
    call.interrupt('kill');
    await h.clock.advance(10);
    expect(received(c).filter((f) => f[0] === 69)).toMatchObject([[69, expect.any(Number), {}]]);
    expect(written(c).filter((f) => f[0] === 8)).toMatchObject([
      [8, 68, expect.any(Number), {}, 'wamp.error.canceled'],
    ]);
    expect(aborted).toBe(true);
    expect(reg.closed).toBe(false);
    await finish(e);
  });

  test('the bogus ERROR(8, INVOCATION) after a killnowait is dropped: the session and the registration go on', async () => {
    const e = start('thruway-php');
    const { h, c, ops } = e;
    const reg = c.observe(
      'register',
      'rd.slow',
      c.client.register('rd.slow', (inv) => (inv.args[0] === 'now' ? 'done' : new Promise(() => undefined))),
    );
    ops.set(reg.id, { kind: 'register' });
    await h.clock.advance(10);
    const first = h.router.invoke('rd.slow');
    await h.clock.advance(10);
    first.interrupt('killnowait'); // the router forgets the INVOCATION; the client's ERROR(68) meets nothing
    await h.clock.advance(10);
    expect(written(c).filter((f) => f[0] === 8)).toMatchObject([
      [8, 68, expect.any(Number), {}, 'wamp.error.canceled'],
    ]);
    expect(received(c).filter((f) => f[0] === 8 && f[1] === 8)).toMatchObject([
      [8, 8, expect.any(Number), {}, 'wamp.error.no_such_procedure'],
    ]);
    const second = h.router.invoke('rd.slow', { args: ['now'] });
    await h.clock.advance(10);
    expect(second.result?.args).toEqual(['done']);
    expect(closes(c)).toEqual([]);
    expect(states(c).at(-1)).toBe('open');
    expect(reg.closed).toBe(false);
    await finish(e);
  });

  test('the echo WELCOME of a realm without an AuthenticationManager (HELLO details back, authid included): GOODBYE, AuthenticationError, backoff', async () => {
    const e = start('thruway-php', ticket(), { authManager: 'none' });
    const { h, c } = e;
    await h.clock.advance(10000);
    const welcomes = received(c).filter((f) => f[0] === 2);
    expect(welcomes.length).toBeGreaterThanOrEqual(2);
    expect(welcomes[0]?.[2]).toMatchObject({ authid: 'joe', authmethods: ['ticket'] }); // only `authmethods` gives it away
    const ends = closes(c);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const end of ends) expect(code(end.error)).toBe('authentication');
    expect(ends.every((end) => end.willRetry)).toBe(true);
    expect(ends.map((end) => end.attempt)).toEqual(ends.map((_end, i) => i + 1));
    expect(states(c)).not.toContain('open');
    expect(written(c, 1).map((f) => f[0])).toEqual([1, 6]);
    await finish(e);
  });

  test('an anonymous WELCOME to a HELLO offering ticket (no provider for the realm): GOODBYE, AuthenticationError, backoff', async () => {
    const e = start('thruway-php', ticket(), { providers: [{ ...TICKET[0]!, realms: ['other'] }] });
    const { h, c } = e;
    await h.clock.advance(10000);
    const ends = closes(c);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const end of ends) expect(code(end.error)).toBe('authentication');
    expect(ends.every((end) => end.willRetry)).toBe(true);
    // the backoff grows: never reset, there was no real session
    expect(ends.map((end) => end.attempt)).toEqual(ends.map((_end, i) => i + 1));
    expect(written(c, 1).map((f) => f[0])).toEqual([1, 6]);
    await finish(e);
  });

  test('a bad ticket ABORTs thruway.error.authentication_failure: AbortError in CloseInfo, reconnect with backoff', async () => {
    const e = start('thruway-php', ticket('wrong'), { providers: TICKET });
    const { h, c } = e;
    await h.clock.advance(5000);
    const ends = closes(c);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(code(ends[0]?.error)).toBe('abort');
    expect((ends[0]?.error as AbortError).reason).toBe('thruway.error.authentication_failure');
    expect(ends.map((end) => end.attempt)).toEqual(ends.map((_end, i) => i + 1));
    await finish(e);
  });
});

// --- Crossbar --------------------------------------------------------------------------------------------------------

describe('Crossbar', () => {
  test('the socket stays open after the GOODBYE reply wamp.close.normal: the client closes it itself', async () => {
    const e = start('crossbar');
    const { h, c } = e;
    await h.clock.advance(10);
    await Promise.all([c.close(), h.clock.advance(5000)]);
    expect(received(c).filter((f) => f[0] === 6)).toMatchObject([[6, expect.anything(), 'wamp.close.normal']]);
    expect(c.connection.socket.controls.closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(c.connection.state).toBe('closed');
    await finish(e);
  });

  test('an ABORT does not close the transport: the client releases it, AbortError carries the message', async () => {
    const e = start('crossbar', ticket('wrong'), { providers: TICKET });
    const { h, c } = e;
    await h.clock.advance(5000);
    const first = closes(c)[0];
    expect(code(first?.error)).toBe('abort');
    expect((first?.error as AbortError).reason).toBe('wamp.error.not_authorized');
    expect(c.connections[0]?.socket.controls.closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(c.connections.length).toBeGreaterThanOrEqual(2);
    await finish(e);
  });

  test('shared subscription ids across sessions: one client leaving does not end the other’s events', async () => {
    const e = start('crossbar');
    const { h, c, ops } = e;
    const other = h.makeClient(Client, { scope: 'client-2', options: { timeouts: { idle: 0 } } });
    const mine = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    ops.set(mine.id, { kind: 'topic', key: topicKey('rd.t', {}) });
    const theirs = other.observe('topic', 'rd.t', other.client.topic('rd.t'));
    await h.clock.advance(10);
    const ids = (cl: SimClient<Client>): unknown[] =>
      received(cl)
        .filter((f) => f[0] === 33)
        .map((f) => f[2]);
    expect(ids(c)).toEqual(ids(other));
    theirs.unsubscribe();
    await h.clock.advance(10);
    h.router.publish('rd.t', ['e1']);
    await h.clock.advance(10);
    expect(mine.values).toHaveLength(1);
    await finish(e);
  });

  test('what Crossbar answers with 1002/1011 is refused locally: a bad option or URI errors one op, the connection stays', async () => {
    const e = start('crossbar');
    const { h, c } = e;
    await h.clock.advance(10);
    const badOption = c.observe(
      'call',
      'rd.p',
      c.client.call('rd.p', [], {}, { receive_progress: 'yes' as unknown as boolean }),
    );
    const badUri = c.observe('call', 'rd..p', c.client.call('rd..p'));
    const good = c.observe('call', 'rd.p', c.client.call('rd.p', ['ok']));
    await h.clock.advance(10);
    expect(badOption.errored).toBe(true);
    expect(badUri.errored).toBe(true);
    expect(good.values).toMatchObject([{ args: ['ok'] }]);
    expect(written(c).filter((f) => f[0] === 48)).toHaveLength(1);
    expect(closes(c)).toEqual([]);
    await finish(e);
  });
});

// --- Bondy -----------------------------------------------------------------------------------------------------------

describe('Bondy', () => {
  test('exclude_me ignored: the publisher gets its own EVENT (tolerated: delivered, nothing breaks)', async () => {
    const e = start('bondy');
    const { h, c } = e;
    const topic = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    await h.clock.advance(10);
    c.observe('publish', 'rd.t', c.client.publish('rd.t', ['own'], {}, { acknowledge: true }));
    await h.clock.advance(10);
    expect(topic.values).toMatchObject([{ args: ['own'] }]);
    await finish(e);
  });

  test('a CANCEL with a mode gets bondy.error.internal_error and no INTERRUPT: the caller is settled locally', async () => {
    const e = start('bondy');
    const { h, c } = e;
    await h.clock.advance(10);
    const call = c.observe('call', 'rd.never', c.client.call('rd.never'));
    await h.clock.advance(10);
    call.unsubscribe();
    await h.clock.advance(10);
    expect(call.errored).toBe(false);
    expect(closes(c)).toEqual([]);
    const again = c.observe('call', 'rd.p', c.client.call('rd.p', ['after']));
    await h.clock.advance(10);
    expect(again.values).toMatchObject([{ args: ['after'] }]);
    await finish(e);
  });

  test('no progressive results: the first progress YIELD is the final RESULT, the op completes', async () => {
    const e = start('bondy', {}, {}, (h) => {
      h.router.procedure(
        'rd.progress',
        () =>
          new Observable<string>((s) => {
            s.next('p1');
            s.next('p2');
            s.complete();
          }),
      );
    });
    const { h, c } = e;
    const call = c.observe('call', 'rd.progress', c.client.progressiveCall('rd.progress'));
    await h.clock.advance(10);
    expect(call.completed).toBe(true);
    expect(call.values.length).toBeGreaterThanOrEqual(1);
    await finish(e);
  });

  test('UNSUBSCRIBE of an unknown id would close 1011: per-session ids only, across reconnects', async () => {
    const e = start('bondy', { requestIds: 'sequential' }, { routerIds: 'per-session' });
    const { h, c, ops } = e;
    const topic = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    ops.set(topic.id, { kind: 'topic', key: topicKey('rd.t', {}) });
    await h.clock.advance(10);
    c.connection.controls.drop();
    await h.clock.advance(5000);
    topic.unsubscribe();
    await h.clock.advance(10);
    expect(c.connections).toHaveLength(2);
    expect(closes(c)).toHaveLength(1); // no 1011
    await finish(e, ['INV-CL02', 'INV-R4']);
  });
});

// --- Nexus -----------------------------------------------------------------------------------------------------------

describe('Nexus', () => {
  test('closing frames lost: close() after our GOODBYE meets a bare 1006 and still resolves as a clean leave', async () => {
    const e = start('nexus');
    const { h, c } = e;
    await h.clock.advance(10);
    await Promise.all([c.close(), h.clock.advance(5000)]);
    expect(received(c).filter((f) => f[0] === 6)).toEqual([]);
    expect(closes(c).map((i) => [i.initiator, i.error])).toEqual([['app', undefined]]);
    expect(states(c).at(-1)).toBe('closed');
    await finish(e);
  });

  test('strict request ids (realm1.strict): a mixed workload with requestIds sequential runs without a kill', async () => {
    const e = start('nexus', { requestIds: 'sequential' }, { quirks: { strict_ids: true } });
    const { h, c, ops } = e;
    const topic = c.observe('topic', 'rd.t', c.client.topic('rd.t'));
    ops.set(topic.id, { kind: 'topic', key: topicKey('rd.t', {}) });
    const reg = c.observe(
      'register',
      'rd.r',
      c.client.register('rd.r', () => 'r'),
    );
    ops.set(reg.id, { kind: 'register' });
    for (let i = 0; i < 20; i++) {
      c.observe('call', 'rd.p', c.client.call('rd.p', [i]));
      c.observe('publish', 'rd.t', c.client.publish('rd.t', [i], {}, { acknowledge: i % 2 === 0 }));
      if (i % 5 === 0) c.observe('call', 'rd.never', c.client.call('rd.never')).unsubscribe();
      await h.clock.advance(5);
    }
    topic.unsubscribe();
    await h.clock.advance(10);
    expect(closes(c)).toEqual([]);
    expect(c.connections).toHaveLength(1);
    await finish(e, ['INV-CL01', 'INV-CL02', 'INV-CANCEL']);
  });

  test('CANCEL reaches the callee as INTERRUPT {mode, reason}: the client’s handler is aborted, ERROR canceled', async () => {
    const e = start('nexus');
    const { h, c, ops } = e;
    const caller = h.makeClient(Client, { scope: 'client-2', options: { timeouts: { idle: 0 } } });
    let aborted = false;
    const reg = c.observe(
      'register',
      'rd.slow',
      c.client.register(
        'rd.slow',
        (inv) =>
          new Promise(() => {
            inv.signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      ),
    );
    ops.set(reg.id, { kind: 'register' });
    await h.clock.advance(10);
    const call = caller.observe('call', 'rd.slow', caller.client.call('rd.slow'));
    await h.clock.advance(10);
    call.unsubscribe();
    await h.clock.advance(10);
    const interrupts = received(c).filter((f) => f[0] === 69);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.[2]).toMatchObject({ mode: 'killnowait' });
    expect(typeof (interrupts[0]?.[2] as { reason?: unknown } | undefined)?.reason).toBe('string');
    expect(aborted).toBe(true);
    await finish(e);
  });
});

// --- fox-wamp --------------------------------------------------------------------------------------------------------

describe('fox-wamp', () => {
  test('an invalid realm gets no ABORT: the handshake timer ends the attempt, reconnect with backoff', async () => {
    const h = createHarness({ seed: 21, router: { dialect: 'fox-wamp' }, checks: { unscripted: false } });
    const c = h.makeClient(Client, { realm: 'Bad-Realm', options: { timeouts: { idle: 0, handshake: 2000 } } });
    await h.clock.advance(15000);
    const ends = closes(c);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(code(ends[0]?.error)).toBe('timeout');
    expect((ends[0]?.error as TimeoutError).timer).toBe('handshake');
    expect(ends.every((end) => end.willRetry)).toBe(true);
    await finish({ h, c, ops: new Map() });
  });

  test('CANCEL ignored: the call settles locally and its late RESULT is dropped as unknown', async () => {
    let release: ((v: unknown) => void) | undefined;
    const e = start('fox-wamp', {}, {}, (h) => {
      h.router.procedure('rd.late', () => new Promise((resolve) => (release = resolve)));
    });
    const { h, c } = e;
    await h.clock.advance(10);
    const call = c.observe('call', 'rd.late', c.client.call('rd.late'));
    await h.clock.advance(10);
    call.unsubscribe();
    await h.clock.advance(10);
    release?.('too late');
    await h.clock.advance(10);
    expect(received(c).filter((f) => f[0] === 50)).toHaveLength(1);
    expect(call.values).toEqual([]);
    expect(closes(c)).toEqual([]);
    await finish(e);
  });

  test('a callee ERROR is rewritten to wamp.error.callee_failure [uri]: the WampError keeps what arrived', async () => {
    const e = start('fox-wamp');
    const { h, c, ops } = e;
    const caller = h.makeClient(Client, { scope: 'client-2', options: { timeouts: { idle: 0 } } });
    const reg = c.observe(
      'register',
      'rd.fail',
      c.client.register('rd.fail', () => {
        throw new Error('no');
      }),
    );
    ops.set(reg.id, { kind: 'register' });
    await h.clock.advance(10);
    const call = caller.observe('call', 'rd.fail', caller.client.call('rd.fail'));
    await h.clock.advance(10);
    expect(code(call.error)).toBe('wamp_error');
    expect((call.error as WampError).uri).toBe('wamp.error.callee_failure');
    await finish(e);
  });

  test('WELCOME without authrole: the session details are passed through as they came', async () => {
    const e = start('fox-wamp');
    const { h, c } = e;
    await h.clock.advance(10);
    expect(c.client.session).toBeDefined();
    expect(c.client.session?.details.authrole).toBeUndefined();
    await finish(e);
  });
});

// --- wamp-server -----------------------------------------------------------------------------------------------------

describe('wamp-server (hostile)', () => {
  test('a CANCEL is answered with GOODBYE: one reply, the in-flight ops are Lost, reconnect', async () => {
    const e = start('wamp-server');
    const { h, c } = e;
    await h.clock.advance(10);
    const other = c.observe('call', 'rd.never', c.client.call('rd.never', ['other']));
    const cancelled = c.observe('call', 'rd.never', c.client.call('rd.never', ['cancelled']));
    await h.clock.advance(10);
    cancelled.unsubscribe();
    await h.clock.advance(5000);
    expect(closes(c).map((i) => i.initiator)).toEqual(['router']);
    expect(written(c, 1).filter((f) => f[0] === 6)).toHaveLength(1);
    expect(code(other.error)).toBe('connection_lost');
    expect(c.connections).toHaveLength(2);
    expect(states(c).at(-1)).toBe('open');
    await finish(e);
  });

  test('ABORT fields swapped: the reason is still read (liberal ABORT parse)', async () => {
    const h = createHarness({
      seed: 21,
      router: { dialect: 'wamp-server', realms: ['realm1'] },
      checks: { unscripted: false },
    });
    const c = h.makeClient(Client, { realm: 'nope', options: { timeouts: { idle: 0 } } });
    await h.clock.advance(3000);
    const first = closes(c)[0];
    expect(code(first?.error)).toBe('abort');
    expect((first?.error as AbortError).reason).toMatch(/^wamp\.error\./);
    await finish({ h, c, ops: new Map() });
  });

  test('an acknowledged PUBLISH without subscribers is never acked: it stays pending, close() settles it', async () => {
    const e = start('wamp-server');
    const { h, c } = e;
    await h.clock.advance(10);
    const pub = c.observe('publish', 'rd.t', c.client.publish('rd.t', ['x'], {}, { acknowledge: true }));
    await h.clock.advance(5000);
    expect(pub.closed).toBe(false);
    await Promise.all([c.close(), h.clock.advance(5000)]);
    expect(code(pub.error)).toBe('connection_closed');
    await finish(e);
  });
});
