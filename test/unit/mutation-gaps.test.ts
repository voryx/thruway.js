// Behaviour pinned by a mutation run (`npm run test:mutation`): each test kills mutants of src/core/** that survived
// the rest of the suite. The core through the harness unless a single module is simpler to drive directly.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { clockAccess, systemClock, TimerScope } from '../../src/core/clock.js';
import { Connection, utf8Length } from '../../src/core/connection.js';
import { RandomIds } from '../../src/core/ids.js';
import type { FaultsHook } from '../../src/core/machine.js';
import { WampError } from '../../src/errors.js';
import { MAX_FRAME_BYTES } from '../../src/protocol/messages.js';
import { jsonSerializer } from '../../src/transport/json.js';
import type { CloseInfo, LogEntry, Status } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { registerKey, topicKey } from '../helpers/invariants.js';

const INTERNAL = Symbol.for('thruway.js.internal');

type Options = Record<string | symbol, unknown>;

function harness(router: Parameters<typeof createHarness>[0] extends infer O ? O : never = {}): Harness {
  return createHarness({ seed: 7, checks: { internalLogs: false }, ...router });
}

function client(h: Harness, options: Options = {}, url?: () => unknown): SimClient<Client> {
  const c = h.makeClient(Client, {
    options: { autoOpen: false, timeouts: { idle: 0 }, ...options },
    ...(url === undefined ? {} : { url: url as never }),
  });
  return c;
}

function logs(c: SimClient<Client>): LogEntry[] {
  return c.trace().logs.map((l) => l.entry);
}

function events(c: SimClient<Client>, event: string): LogEntry[] {
  return logs(c).filter((e) => e.event === event);
}

function sent(c: SimClient<Client>, type: number): unknown[][] {
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === type)
    .map((f) => f.frame as unknown[]);
}

const lastEnd = (c: SimClient<Client>): CloseInfo | undefined => c.onClose?.values.at(-1);
const lastStatus = (c: SimClient<Client>): Status | undefined => c.status?.values.at(-1);
const faults = (c: SimClient<Client>): FaultsHook => c.faults as FaultsHook;
interface Debug {
  readonly stopped: boolean;
  readonly lingering: number;
  readonly deliveries: number;
  readonly timers: number;
  readonly participants: {
    readonly call: { readonly inFlight: number };
    readonly publish: { readonly inFlight: number };
    readonly topic: { readonly requests: number };
    readonly liveness: { readonly probes: number };
  };
}
const debug = (c: SimClient<Client>): Debug => c.debug() as Debug;

/** A JSON serializer that throws for the frames `fails` picks. */
function failing(fails: (message: unknown[]) => boolean): Options {
  const json = jsonSerializer();
  return {
    serializer: {
      protocol: json.protocol,
      binary: json.binary,
      serialize: (message: unknown[]) => {
        if (fails(message)) throw new Error('cannot serialize');
        return json.serialize(message);
      },
      deserialize: (data: string | Uint8Array) => json.deserialize(data),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- single modules, driven directly --------------------------------------------------------------------------------

describe('utf8Length (connection.ts)', () => {
  test('equals the UTF-8 encoding length at every boundary, lone surrogates as U+FFFD', () => {
    const u = (...codes: number[]): string => String.fromCharCode(...codes);
    const samples = [
      u(0x7f),
      u(0x80),
      u(0x7ff),
      u(0x800),
      u(0xd7ff),
      u(0xe000),
      u(0xffff),
      u(0xd800, 0xdc00),
      u(0xdbff, 0xdfff),
      u(0xd83d, 0xde00, 0x78),
      u(0xd800), // a lone high surrogate at the end
      u(0xd800, 0x78), // a high surrogate followed by a non-surrogate
      u(0xdbff, 0xdbff), // a high surrogate followed by a high surrogate
      u(0xd800, 0xe000),
      u(0xdc00), // a lone low surrogate
      u(0xd7ff, 0xdc00),
      u(0x61, 0xdbff, 0xdc00, 0x62),
      u(0xd800, 0xdbff, 0xdfff),
      u(0xdc00, 0xdc00), // low surrogates never start a pair
      u(0xe000, 0xdc00),
      u(0xffff, 0xdfff),
    ];
    const encoder = new TextEncoder();
    for (const s of samples) expect(utf8Length(s), JSON.stringify(s)).toBe(encoder.encode(s).length);
  });

  test('an oversize frame throws payload_size_exceeded with [bytes, limit]', () => {
    const scope = new TimerScope(clockAccess(systemClock, () => undefined));
    const conn = new Connection(1, scope, jsonSerializer(), () => undefined);
    conn.gate = 'open';
    conn.transport = { send: () => true, close: () => undefined, terminate: () => undefined, bufferedAmount: () => 0 };
    const big = 'x'.repeat(MAX_FRAME_BYTES);
    let error: unknown;
    try {
      conn.write([16, 1, {}, 'com.t', [big]]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WampError);
    const args = (error as WampError).args;
    expect(args).toHaveLength(2);
    expect(args[0]).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(args[1]).toBe(MAX_FRAME_BYTES);
  });
});

describe('RandomIds (ids.ts)', () => {
  /** xorshift128+ over BigInt, seeded as ids.ts seeds it (mix32 of a Weyl sequence over the seed draw). */
  function reference(draw: number): () => bigint {
    const mix32 = (z: number): number => {
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    const n = Math.floor((Math.abs(draw) % 1) * 2 ** 53);
    let base = (Math.floor(n / 2 ** 32) ^ Math.imul(n >>> 0, 0x9e3779b9)) >>> 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i++) {
      base = (base + 0x9e3779b9) >>> 0;
      words.push(mix32(base));
    }
    const M = (1n << 64n) - 1n;
    let s0 = (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
    let s1 = (BigInt(words[2]!) << 32n) | BigInt(words[3]!);
    return () => {
      let x = s0;
      const y = s1;
      s0 = y;
      x ^= (x << 23n) & M;
      s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
      return (s1 + y) & M;
    };
  }

  test('the seeded stream is xorshift128+ (64-bit addition with carry)', () => {
    for (const seed of [0.1, 0.5, 0.987654321, 0.000123]) {
      const ids = new RandomIds(() => seed);
      const ref = reference(seed);
      for (let i = 0; i < 2000; i++) {
        const v = ref();
        const expected = Number(((v >> 43n) << 32n) | (v & 0xffffffffn)) + 1; // idOf: 21 high bits, 32 low bits
        expect(ids.next(() => false)).toBe(expected);
      }
    }
  });
});

describe('TimerScope deadlines against the wall clock (clock.ts)', () => {
  test('a deadline is late only when the wall clock passed its duration by more than the allowance', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let wall = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const access = clockAccess(systemClock, () => undefined);
    expect(access.wallNow).toBeDefined();
    const fired: string[] = [];
    const scope = new TimerScope(access);
    // exactly the allowance (1000 ms) late on the wall clock: not late, fires on time
    scope.arm('a', 100, () => fired.push('a'), true);
    wall += 100 + 1000;
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a']);
    // one ms more: late, re-armed for its duration
    scope.arm('b', 100, () => fired.push('b'), true);
    wall += 100 + 1001;
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a']);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a', 'b']);
    // the wall clock on time: fires on time
    scope.arm('c', 100, () => fired.push('c'), true);
    wall += 100;
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a', 'b', 'c']);
  });
});

// --- the core: stable log events (LogEntry) ----------------------------------------------------------------------

describe('core log events', () => {
  test('attempt, session and retry entries: level, event and data', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 200 } });
    c.open();
    await h.clock.advance(0);
    h.router.setAvailable('ok');
    await h.clock.advance(2000);
    expect(lastStatus(c)?.state).toBe('open');
    c.connection.controls.drop(); // a session end through the end procedure
    await h.clock.advance(1000);
    expect(lastStatus(c)?.state).toBe('open');
    const closing = c.close();
    await h.clock.advance(100);
    await closing;
    const pick = (e: LogEntry): unknown => ({ level: e.level, event: e.event, data: e.data });
    const starts = events(c, 'attempt.start');
    expect(starts.map(pick).slice(0, 2)).toEqual([
      { level: 'info', event: 'attempt.start', data: { attempt: 1, conn: 1, url: h.router.url } },
      { level: 'info', event: 'attempt.start', data: { attempt: 2, conn: 2, url: h.router.url } },
    ]);
    const ends = c.onClose!.values;
    expect(events(c, 'attempt.end').map(pick)).toEqual([
      { level: 'info', event: 'attempt.end', data: { info: ends[0] } },
    ]);
    expect(events(c, 'session.end').map(pick)).toEqual([
      { level: 'info', event: 'session.end', data: { info: ends[1] } },
      { level: 'info', event: 'session.end', data: { info: ends[2] } },
    ]);
    expect(events(c, 'retry.scheduled').map(pick)).toEqual([
      { level: 'info', event: 'retry.scheduled', data: { delay: ends[0]!.delay, attempt: 1 } },
      { level: 'info', event: 'retry.scheduled', data: { delay: ends[1]!.delay, attempt: 2 } }, // not stable yet
    ]);
    const session = c.onOpen!.values[0]!;
    expect(events(c, 'session.open').map(pick)[0]).toEqual({
      level: 'info',
      event: 'session.open',
      data: { sessionId: session.id, conn: 2 },
    });
    const outs = events(c, 'frame.out');
    expect(outs.length).toBeGreaterThan(0);
    expect(outs.every((e) => e.level === 'debug')).toBe(true);
    const ins = events(c, 'frame.in');
    expect(ins.length).toBeGreaterThan(0);
    expect(ins.every((e) => e.level === 'debug' && (e.data as { bytes: number }).bytes > 0)).toBe(true);
    await h.closeAndSettle();
  });

  test('stale inputs, frames before WELCOME, tolerated and fatal frames, skipped GOODBYE: levels and events', async () => {
    const h = harness();
    // before WELCOME: the router ignores HELLO, then sends an EVENT
    const hello = h.router.ignore((f) => f[0] === 1);
    let failGoodbye = false;
    const c = client(
      h,
      failing((m) => failGoodbye && m[0] === 6),
    );
    c.open();
    await h.clock.advance(0);
    h.router.sendRaw('[36,1,2,{}]');
    await h.clock.advance(0);
    const early = events(c, 'frame.dropped').find((e) => e.level === 'debug' && e.data === undefined);
    expect(early).toBeDefined();
    hello();
    c.reconnect();
    await h.clock.advance(2000);
    expect(lastStatus(c)?.state).toBe('open');
    // a tolerated warning: GOODBYE details that are not a dict
    const sessionId = c.onOpen!.values.at(-1)!.id;
    h.router.sendRaw('[6,"x","wamp.close.system_shutdown"]');
    await h.clock.advance(0);
    expect(events(c, 'protocol.violation')).toContainEqual(expect.objectContaining({ level: 'warn' }));
    expect(lastEnd(c)).toMatchObject({ initiator: 'router', sessionId });
    await h.clock.advance(2000);
    expect(lastStatus(c)?.state).toBe('open');
    // a fatal frame in a session: protocol.violation warn, an end by the connection
    const before = events(c, 'protocol.violation').length;
    h.router.sendRaw('[36,"x"]');
    await h.clock.advance(0);
    const violations = events(c, 'protocol.violation').slice(before);
    expect(violations).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({ frame: expect.any(String) as string }) as object,
      }),
    );
    expect(lastEnd(c)).toMatchObject({ initiator: 'connection', reason: 'wamp.error.protocol_violation' });
    await h.clock.advance(2000);
    expect(lastStatus(c)?.state).toBe('open');
    // a frame decode drops (an unknown type): frame.dropped with the frame
    h.router.sendRaw('[99]');
    await h.clock.advance(0);
    expect(events(c, 'frame.dropped')).toContainEqual(
      expect.objectContaining({ data: { frame: expect.any(String) as string } }),
    );
    // a stale input: an inbound frame on a lingering connection (its GOODBYE reply never comes)
    const goodbye = h.router.ignore((f) => f[0] === 6);
    const conn = c.connection;
    c.reconnect();
    conn.sendRaw('[36,1,2,{}]');
    await h.clock.advance(0);
    expect(events(c, 'frame.dropped')).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        data: { input: 'ws.message', state: 'HELLO_SENT', conn: expect.any(Number) as number },
      }),
    );
    goodbye();
    await h.clock.advance(3000);
    // close() whose GOODBYE cannot be serialized: request.error warn, the socket closed without terminate()
    const last = c.connection;
    failGoodbye = true;
    await c.close();
    expect(events(c, 'request.error')).toContainEqual(expect.objectContaining({ level: 'warn' }));
    expect(last.controls.terminateCalls).toBe(0);
    await h.closeAndSettle();
  });
});

// --- the core: CloseInfo of each kind of end (CloseInfo) ------------------------------------------------------------

describe('CloseInfo fields', () => {
  test('reconnect() and close(), in a session and while connecting', async () => {
    const h = harness();
    const c = client(h);
    c.open();
    await h.clock.advance(5);
    const sessionId = c.onOpen!.values[0]!.id;
    c.reconnect();
    expect(lastEnd(c)).toMatchObject({ initiator: 'app', reason: 'wamp.close.close_realm', wasClean: true, sessionId });
    await h.clock.advance(2000);
    h.router.setAvailable('hang');
    const s2 = c.onOpen!.values.at(-1)!.id;
    const closing = c.close();
    expect(lastEnd(c)).toMatchObject({
      initiator: 'app',
      reason: 'wamp.close.close_realm',
      wasClean: true,
      sessionId: s2,
      willRetry: false,
    });
    await h.clock.advance(3000);
    await closing;
    c.open();
    await h.clock.advance(2000); // connecting: the router hangs
    expect(lastStatus(c)?.state).toBe('connecting');
    c.reconnect();
    expect(lastEnd(c)).toMatchObject({ initiator: 'app', wasClean: true, sessionId: undefined });
    await h.clock.advance(2000);
    const closing2 = c.close();
    expect(lastEnd(c)).toMatchObject({ initiator: 'app', reason: undefined, wasClean: true, sessionId: undefined });
    await h.clock.advance(3000);
    await closing2;
    await h.closeAndSettle();
  });

  test('connection-side ends: url failure, WebSocket constructor, subprotocol, HELLO serialization, anonymous WELCOME, no onChallenge', async () => {
    // the url resolver fails: the app's error is the cause
    {
      const h = harness();
      const boom = new Error('no url');
      const c = client(h, {}, () => {
        throw boom;
      });
      c.open();
      await h.clock.advance(0);
      expect(lastEnd(c)).toMatchObject({ initiator: 'connection', wasClean: false });
      expect((lastEnd(c)!.error as { cause?: unknown }).cause).toBe(boom);
      await h.closeAndSettle();
    }
    // the WebSocket constructor throws
    {
      const h = harness();
      const c = h.makeClient(Client, {
        options: {
          autoOpen: false,
          timeouts: { idle: 0 },
          WebSocket: function () {
            throw new Error('no sockets');
          } as never,
        },
      });
      c.open();
      await h.clock.advance(0);
      expect(lastEnd(c)).toMatchObject({ initiator: 'connection', wasClean: false });
      await h.closeAndSettle();
    }
    // a subprotocol the client did not offer
    {
      const h = harness();
      const Wrapped = function (url: string, protocols?: string | string[]) {
        const ws = new (h.router.webSocketFor(1))(url, protocols);
        return new Proxy(ws, {
          get(target, prop) {
            if (prop === 'protocol') return 'wamp.2.msgpack';
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
          set(target, prop, value) {
            return Reflect.set(target, prop, value, target);
          },
        });
      };
      Object.defineProperty(Wrapped, 'OPEN', { value: 1 });
      const c = client(h, { WebSocket: Wrapped });
      c.open();
      await h.clock.advance(1);
      expect(lastEnd(c)).toMatchObject({ initiator: 'connection', closeCode: 4000, wasClean: false });
      await h.closeAndSettle();
    }
    // HELLO cannot be serialized
    {
      const h = harness();
      const c = client(
        h,
        failing((m) => m[0] === 1),
      );
      c.open();
      await h.clock.advance(0);
      expect(lastEnd(c)).toMatchObject({ initiator: 'connection', closeCode: 1000, wasClean: true });
      await h.closeAndSettle();
    }
    // an anonymous WELCOME for a client that offered ticket only
    {
      const h = harness();
      const c = client(h, { authmethods: ['ticket'], authid: 'joe', onChallenge: () => 'secret' });
      c.open();
      await h.clock.advance(0);
      expect(lastEnd(c)).toMatchObject({ initiator: 'connection', reason: 'wamp.close.close_realm', wasClean: true });
      await h.closeAndSettle();
    }
    // a CHALLENGE without an onChallenge handler
    {
      const h = harness({
        router: {
          providers: [{ method: 'ticket', extra: () => ({}), verify: () => ({ authid: 'joe', authrole: 'user' }) }],
        },
      });
      const c = client(h, { authmethods: ['ticket'], authid: 'joe' });
      c.open();
      await h.clock.advance(0);
      const end = lastEnd(c);
      expect(end).toMatchObject({ initiator: 'connection', reason: 'wamp.error.cannot_authenticate', wasClean: true });
      await h.closeAndSettle();
    }
  });
});

// --- the core: attempts, retries, timers ----------------------------------------------------------------------------

describe('attempts and timers', () => {
  test('an AUTHENTICATE that cannot be serialized ends the attempt, and the client retries', async () => {
    const h = harness({
      router: {
        providers: [{ method: 'ticket', extra: () => ({}), verify: () => ({ authid: 'joe', authrole: 'user' }) }],
      },
    });
    let fail = true;
    const c = client(h, {
      authmethods: ['ticket'],
      authid: 'joe',
      onChallenge: () => 'secret',
      retryOptions: { maxRetryDelay: 200 },
      ...failing((m) => fail && m[0] === 5),
    });
    c.open();
    await h.clock.advance(5);
    expect(lastEnd(c)).toMatchObject({ initiator: 'connection', wasClean: true, willRetry: true });
    fail = false;
    await h.clock.advance(2000);
    expect(lastStatus(c)?.state).toBe('open');
    await h.closeAndSettle();
  });

  test('a late failing challenge answer does not start the next attempt early (a late success does)', async () => {
    for (const outcome of ['fail', 'ok'] as const) {
      const h = harness({
        router: {
          providers: [{ method: 'ticket', extra: () => ({}), verify: () => ({ authid: 'joe', authrole: 'user' }) }],
        },
      });
      let pending: { next(v: string): void; error(e: unknown): void } | undefined;
      const c = client(h, {
        authmethods: ['ticket'],
        authid: 'joe',
        onChallenge: () => ({
          subscribe(observer: { next(v: string): void; error(e: unknown): void }) {
            pending = observer;
            return { unsubscribe: () => undefined };
          },
        }),
        retryOptions: { retryDelay: () => 20000 },
      });
      // answered from the end's own status notification, before the end's cancel reaches the round
      c.client.status.subscribe((s) => {
        if (s.state !== 'closed' || pending === undefined) return;
        const p = pending;
        pending = undefined;
        if (outcome === 'fail') p.error(new Error('no'));
        else p.next('secret');
      });
      c.open();
      await h.clock.advance(5);
      expect(pending).toBeDefined();
      c.connection.controls.drop();
      await h.clock.advance(3000);
      expect(c.connections.length, outcome).toBe(outcome === 'fail' ? 1 : 2);
      await h.closeAndSettle();
    }
  });

  test('open() cutting a wait cancels the armed retry; WELCOME cancels the handshake timer', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { retryDelay: () => 20000 }, timeouts: { idle: 0, handshake: 500 } });
    c.open();
    await h.clock.advance(1500);
    h.router.setAvailable('ok');
    c.open(); // past the 1 s floor: the next attempt starts now
    await h.clock.advance(5);
    expect(lastStatus(c)?.state).toBe('open');
    await h.clock.advance(25000);
    const dropped = events(c, 'frame.dropped').map((e) => (e.data as { input?: unknown } | undefined)?.input);
    expect(dropped).not.toContain('timer.retry');
    expect(dropped).not.toContain('timer.handshake');
    expect(debug(c).timers).toBe(1); // stable only
    await h.closeAndSettle();
  });

  test('request ids are random by default', async () => {
    const h = harness();
    h.router.procedure('com.ok', () => 1);
    const c = client(h);
    c.open();
    await h.clock.advance(5);
    c.observe('call', 'com.ok', c.client.call('com.ok'));
    c.observe('call', 'com.ok', c.client.call('com.ok'));
    await h.clock.advance(5);
    const ids = sent(c, 48).map((f) => f[1] as number);
    expect(ids).toHaveLength(2);
    expect(Math.abs(ids[1]! - ids[0]!)).not.toBe(1);
    await h.closeAndSettle();
  });

  test('the stable timer is not a deadline: overdue after a suspend, it marks the session stable at once', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 200 }, [INTERNAL]: { stable: 400 } });
    c.open();
    await h.clock.advance(0);
    h.router.setAvailable('ok');
    for (let i = 0; i < 300 && lastStatus(c)?.state !== 'open'; i++) await h.clock.advance(1); // one failure, then a session
    expect(lastStatus(c)?.state).toBe('open');
    await h.clock.suspend(5000); // the 400 ms stable timer is overdue: a deadline would wait 400 ms more
    c.connection.controls.drop();
    await h.clock.advance(0);
    expect(lastEnd(c)).toMatchObject({ attempt: 1 }); // the failure before the session no longer counts
    await h.closeAndSettle();
  });

  test('the settle window of a CHALLENGE is not a deadline: overdue after a suspend, the round runs at once', async () => {
    const h = harness({
      router: {
        dialect: 'thruway-php',
        providers: [
          { method: 'ticket', extra: () => ({ nonce: 'n1' }), verify: () => ({ authid: 'joe', authrole: 'user' }) },
          { method: 'wampcra', extra: () => ({ nonce: 'n1' }), verify: () => ({ authid: 'joe', authrole: 'user' }) },
        ],
      },
    });
    const asked: string[] = [];
    const c = client(h, {
      authmethods: ['ticket', 'wampcra'],
      authid: 'joe',
      onChallenge: (m: { authMethod: string }) => {
        asked.push(m.authMethod);
        return 'sig';
      },
      [INTERNAL]: { settle: 50 },
    });
    c.open();
    await h.clock.advance(0);
    expect(asked).toEqual([]); // inside the settle window
    await h.clock.suspend(5000);
    expect(asked).toHaveLength(1);
    await h.closeAndSettle();
  });

  test('a ghost re-REGISTER wait is not a deadline: overdue after a suspend, the REGISTER is written at once', async () => {
    const h = harness();
    const c = client(h, { retryOptions: { maxRetryDelay: 200 } });
    c.open();
    await h.clock.advance(5);
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    await h.clock.advance(5);
    c.connection.controls.vanish(); // the router keeps the session and its registration
    await h.clock.advance(1500);
    expect(lastStatus(c)?.state).toBe('open');
    const before = sent(c, 64).length; // the re-REGISTER met the ghost: waiting ~1 s
    await h.clock.suspend(10000);
    expect(sent(c, 64).length).toBe(before + 1);
    await h.closeAndSettle();
  });
});

// --- the core: contained faults (hardReset) -------------------------------------------------------------------------

describe('hardReset', () => {
  test('while connecting: one end with a retry (also at maxRetries), the queued call lost, the right log events', async () => {
    const h = harness();
    h.router.setAvailable('hang');
    const seen: CloseInfo[] = [];
    const c = client(h, {
      retryOptions: {
        maxRetries: 1,
        retryDelay: (_n: number, closed: CloseInfo) => {
          seen.push(closed);
          return 200;
        },
      },
    });
    c.open();
    await h.clock.advance(5);
    const call = c.observe('call', 'com.x', c.client.call('com.x'));
    faults(c).inject('topic.start');
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(0);
    expect(lastEnd(c)).toMatchObject({
      initiator: 'connection',
      wasClean: false,
      willRetry: true,
      attempt: 1,
      delay: 200,
    });
    expect(lastEnd(c)!.error).toMatchObject({ code: 'protocol' });
    expect(seen).toEqual([expect.objectContaining({ initiator: 'connection', willRetry: true, attempt: 1 })]);
    expect(events(c, 'attempt.end')).toHaveLength(1);
    expect(events(c, 'session.end')).toHaveLength(0);
    expect(events(c, 'retry.scheduled')).toEqual([expect.objectContaining({ data: { delay: 200, attempt: 1 } })]);
    expect(call.error).toMatchObject({ code: 'connection_lost', procedure: 'com.x' });
    await h.closeAndSettle();
  });

  test('in a session: the first internal error is the one reported', async () => {
    const h = harness();
    const c = client(h);
    c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    const first = new Error('first');
    faults(c).inject('call.pendingIds', 'once', first); // the REGISTER's id allocation at WELCOME
    faults(c).inject('liveness.wrote', 'once', new Error('second')); // after the SUBSCRIBE, same step
    c.open();
    await h.clock.advance(5);
    const internal = events(c, 'internal');
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ level: 'error', data: { error: first } });
    await h.closeAndSettle();
  });

  test('in a session: lingering sockets closed 4002 and terminated, onOpen cleared, only registrations become ghosts', async () => {
    const h = harness({ router: { terminate: true } });
    const c = client(h, { retryOptions: { maxRetryDelay: 200 } });
    c.open();
    await h.clock.advance(5);
    expect(topicKey('com.x', {})).toBe(registerKey('com.x', {})); // a topic key could pass for a registration's
    c.observe('topic', 'com.x', c.client.topic('com.x'));
    await h.clock.advance(5);
    const goodbye = h.router.ignore((f) => f[0] === 6);
    const old = c.connection;
    c.reconnect(); // the old socket lingers: its GOODBYE is never answered
    await h.clock.advance(1100);
    expect(lastStatus(c)?.state).toBe('open');
    expect(debug(c).lingering).toBe(1);
    h.router.declareTopic('com.p');
    const pending = h.router.ignore((f) => f[0] === 32 && f[3] === 'com.p');
    c.observe('topic', 'com.p', c.client.topic('com.p'));
    await h.clock.advance(1);
    expect(debug(c).participants.topic.requests).toBe(1);
    faults(c).inject('liveness.check');
    c.open(); // ESTABLISHED: a wake-up check, which throws
    expect(events(c, 'internal')).toHaveLength(1);
    expect(debug(c).participants.topic.requests).toBe(0); // fresh participants
    pending();
    expect(old.controls.closeCalls[0]).toMatchObject({ code: 4002 }); // CloseCode.INTERNAL_ERROR
    expect(old.controls.terminateCalls).toBe(1);
    expect(debug(c).lingering).toBe(0);
    const late = c.observe('onOpen', undefined, c.client.onOpen);
    expect(late.values).toHaveLength(0);
    goodbye();
    await h.clock.advance(1000);
    expect(lastStatus(c)?.state).toBe('open');
    expect(late.values).toHaveLength(1);
    // a genuine conflict for com.x is not ridden out as a ghost of the reset session
    const peer = h.makeClient(Client, { scope: 'peer', options: { autoOpen: false, timeouts: { idle: 0 } } });
    peer.open();
    await h.clock.advance(5);
    peer.observe(
      'register',
      'com.x',
      peer.client.register('com.x', () => 1),
    );
    await h.clock.advance(5);
    const mine = c.observe(
      'register',
      'com.x',
      c.client.register('com.x', () => 2),
    );
    await h.clock.advance(50);
    expect(mine.error).toMatchObject({ uri: 'wamp.error.procedure_already_exists' });
    await h.closeAndSettle();
  });

  test('while connecting: a registration of no session is not a ghost', async () => {
    const h = harness();
    const peer = h.makeClient(Client, { scope: 'peer', options: { autoOpen: false, timeouts: { idle: 0 } } });
    peer.open();
    await h.clock.advance(5);
    peer.observe(
      'register',
      'com.y',
      peer.client.register('com.y', () => 1),
    );
    await h.clock.advance(5);
    h.router.setAvailable('hang');
    const c = client(h, { retryOptions: { maxRetryDelay: 200 } });
    c.open();
    await h.clock.advance(5);
    const mine = c.observe(
      'register',
      'com.y',
      c.client.register('com.y', () => 2),
    );
    faults(c).inject('topic.start');
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(0);
    expect(events(c, 'internal')).toHaveLength(1);
    h.router.setAvailable('ok');
    await h.clock.advance(1100);
    expect(lastStatus(c)?.state).toBe('open');
    await h.clock.advance(50);
    expect(mine.error).toMatchObject({ uri: 'wamp.error.procedure_already_exists' });
    await h.closeAndSettle();
  });
});

// --- the core: the fault hook, the logger, the debug probe ----------------------------------------------------------

describe('fault hook, logger fallback, debug probe', () => {
  test("an 'always' fault keeps throwing; option.fallback carries the error", async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetryDelay: 200 } });
    const error = new Error('no random');
    faults(c).inject('clock.random', 'always', error);
    c.open();
    await h.clock.advance(1500);
    expect(c.onClose!.values.length).toBeGreaterThanOrEqual(2);
    const fallbacks = events(c, 'option.fallback');
    expect(fallbacks.length).toBe(c.onClose!.values.length);
    expect(fallbacks[0]).toMatchObject({ level: 'warn', data: { error } });
    await h.closeAndSettle();
  });

  test('a logger fault falls back to console.error once', async () => {
    const h = harness();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(h);
    faults(c).inject('logger');
    c.open(); // attempt.start: the logger throws
    await h.clock.advance(5);
    expect(spy).toHaveBeenCalledTimes(1);
    await h.closeAndSettle();
  });

  test('the debug probe counts calls in flight, pending probes and armed timers; close() empties the participants', async () => {
    const h = harness();
    h.router.procedure('com.slow', () => new Promise(() => undefined));
    const c = client(h, { timeouts: { idle: 50 } });
    c.open();
    await h.clock.advance(5);
    c.observe('call', 'com.slow', c.client.call('com.slow'));
    c.observe('publish', 'com.t', c.client.publish('com.t', [], {}, { acknowledge: true }));
    h.router.declareTopic('com.t');
    const unanswered = h.router.ignore((f) => f[0] === 16);
    await h.clock.advance(1);
    expect(debug(c).participants.call.inFlight).toBe(1);
    expect(debug(c).participants.publish.inFlight).toBe(1);
    unanswered();
    const pings = h.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping');
    await h.clock.advance(60); // idle: a probe is pending
    expect(debug(c).participants.liveness.probes).toBe(1);
    pings();
    const closing = c.close();
    await h.clock.advance(3000);
    await closing;
    expect(debug(c).participants.call.inFlight).toBe(0);
    expect(debug(c).participants.publish.inFlight).toBe(0);
    await h.closeAndSettle();
  });

  test('timers: an answered SUBSCRIBE and an answered probe leave no timer of theirs armed', async () => {
    const h = harness();
    h.router.declareTopic('com.t');
    const c = client(h, { timeouts: { idle: 50 } });
    c.open();
    await h.clock.advance(5);
    const base = debug(c).timers; // stable + idle
    c.observe('topic', 'com.t', c.client.topic('com.t'));
    await h.clock.advance(1);
    expect(debug(c).timers).toBe(base);
    await h.clock.advance(60); // the probe went out and was answered
    expect(
      events(c, 'frame.out').some((e) => String((e.data as { preview?: string }).preview).includes('thruway.js.ping')),
    ).toBe(true);
    expect(debug(c).timers).toBe(base);
    await h.closeAndSettle();
  });

  test('the delivery queue size seen from inside a delivery', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { maxRetries: 0 } });
    const seen: number[] = [];
    c.client.status.subscribe((s) => {
      if (s.state === 'closed' && s.closed !== undefined) seen.push(debug(c).deliveries);
    });
    c.open();
    await h.clock.advance(5);
    expect(seen).toEqual([2]); // onClose and the cancel delivery are still queued
    await h.closeAndSettle();
  });
});

// --- the core: stopping, closing, op records ------------------------------------------------------------------------

describe('stop, close and ops', () => {
  test('open() after close() is not stopped; close() after a give-up keeps gaveUp; ops carry their procedure', async () => {
    const h = harness();
    const c = client(h);
    c.open();
    await h.clock.advance(5);
    const closing = c.close();
    await h.clock.advance(3000);
    await closing;
    expect(debug(c).stopped).toBe(true);
    const late = c.observe('call', 'com.x', c.client.call('com.x'));
    expect(late.error).toMatchObject({ code: 'connection_closed', gaveUp: false, procedure: 'com.x' });
    const lateReg = c.observe(
      'register',
      'com.r',
      c.client.register('com.r', () => 1),
    );
    expect(lateReg.error).toMatchObject({ code: 'connection_closed', procedure: 'com.r' });
    expect(lateReg.error).not.toHaveProperty('topic');
    h.router.setAvailable('hang');
    c.open();
    await h.clock.advance(1100);
    expect(lastStatus(c)?.state).toBe('connecting');
    expect(debug(c).stopped).toBe(false);
    await h.closeAndSettle();
    // a give-up, then close(): new work still fails with gaveUp: true
    const h2 = harness();
    h2.router.setAvailable('refuse');
    const d = client(h2, { retryOptions: { maxRetries: 0 } });
    d.open();
    await h2.clock.advance(5);
    expect(lastEnd(d)).toMatchObject({ willRetry: false });
    await d.close();
    const after = d.observe('call', 'com.x', d.client.call('com.x'));
    expect(after.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
    await h2.closeAndSettle();
  });

  test('a call or topic subscribed and unsubscribed while a step runs (from the logger) writes nothing', async () => {
    const h = harness();
    h.router.procedure('com.x', () => 1);
    h.router.declareTopic('com.t');
    let fired = false;
    const c: SimClient<Client> = h.makeClient(Client, {
      options: {
        autoOpen: false,
        timeouts: { idle: 0 },
        logger: (entry: LogEntry) => {
          if (entry.event !== 'session.open' || fired) return;
          fired = true;
          c.client.call('com.x').subscribe().unsubscribe();
          c.client.topic('com.t').subscribe().unsubscribe();
        },
      },
    });
    c.open();
    await h.clock.advance(5);
    expect(fired).toBe(true);
    expect(sent(c, 48)).toHaveLength(0);
    expect(sent(c, 49)).toHaveLength(0);
    expect(sent(c, 32)).toHaveLength(0); // a topic participant would SUBSCRIBE it
    await h.closeAndSettle();
  });

  test('a CALL that cannot be serialized gives its sequential id back', async () => {
    const h = harness();
    h.router.procedure('com.ok', () => 1);
    const c = client(h, { requestIds: 'sequential', ...failing((m) => m[0] === 48 && m[3] === 'com.bad') });
    c.open();
    await h.clock.advance(5);
    const bad = c.observe('call', 'com.bad', c.client.call('com.bad'));
    expect(bad.errored).toBe(true);
    c.observe('call', 'com.ok', c.client.call('com.ok'));
    await h.clock.advance(5);
    expect(sent(c, 48).map((f) => f[1])).toEqual([1]);
    await h.closeAndSettle();
  });

  test('close(): the ops in flight error the stop’s own error (the participants fail them before the registry)', async () => {
    const h = harness();
    h.router.procedure('com.slow', () => new Promise(() => undefined));
    h.router.declareTopic('com.t');
    const c = client(h);
    c.open();
    await h.clock.advance(5);
    const unanswered = h.router.ignore((f) => f[0] === 16);
    const call = c.observe('call', 'com.slow', c.client.call('com.slow'));
    const pub = c.observe('publish', 'com.t', c.client.publish('com.t', [], {}, { acknowledge: true }));
    await h.clock.advance(1);
    const closing = c.close();
    await h.clock.advance(3000);
    await closing;
    unanswered();
    // each record its own error in its own context, all built from the one stop cause
    expect(call.error).toMatchObject({ code: 'connection_closed', gaveUp: false, procedure: 'com.slow' });
    expect(pub.error).toMatchObject({ code: 'connection_closed', gaveUp: false, topic: 'com.t' });
    expect(pub.error).not.toBe(call.error);
    expect(typeof (call.error as { requestId?: unknown }).requestId).toBe('number');
    await h.closeAndSettle();
  });

  test('no unhandled errors at an attempt end (no url resolver) or a close() while waiting', async () => {
    const h = harness();
    h.router.setAvailable('refuse');
    const c = client(h, { retryOptions: { retryDelay: () => 20000 } });
    c.open();
    await h.clock.advance(5);
    expect(lastStatus(c)?.state).toBe('closed');
    await c.close();
    expect(events(c, 'unhandled')).toEqual([]);
    await h.closeAndSettle();
  });

  test('a lingering connection runs no timers of its session; an unwritten GOODBYE is not followed by terminate()', async () => {
    const h = harness({ router: { terminate: true } });
    let failGoodbye = false;
    const c = client(h, { timeouts: { idle: 50 }, ...failing((m) => failGoodbye && m[0] === 6) });
    c.open();
    await h.clock.advance(5);
    const goodbye = h.router.ignore((f) => f[0] === 6);
    const closing = c.close();
    await h.clock.advance(1000); // idle 50: its timer would fire while the GOODBYE goes unanswered
    const dropped = events(c, 'frame.dropped').map((e) => (e.data as { input?: unknown } | undefined)?.input);
    expect(dropped).not.toContain('timer.idle');
    goodbye();
    await h.clock.advance(3000);
    await closing;
    c.open();
    await h.clock.advance(1100);
    expect(lastStatus(c)?.state).toBe('open');
    failGoodbye = true;
    const last = c.connection;
    await c.close();
    expect(last.controls.terminateCalls).toBe(0);
    await h.closeAndSettle();
  });

  test('close() does not count as a liveness death: the next session keeps the probe budget', async () => {
    const h = harness();
    const c = client(h, { timeouts: { idle: 100 }, [INTERNAL]: { ping: 50 } });
    c.open();
    await h.clock.advance(300); // probes answered: the endpoint supports them
    const closing = c.close();
    await h.clock.advance(3000);
    await closing;
    h.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping'); // the next session's probes go unanswered
    c.open();
    for (let i = 0; i < 2000 && c.onClose!.values.length < 2; i++) await h.clock.advance(1);
    expect(lastEnd(c)?.error).toMatchObject({ timer: 'liveness' });
    const probes = c
      .trace()
      .frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[3] === 'thruway.js.ping');
    const end = c.trace().closeInfos.at(-1)!;
    expect(end.at - probes.at(-1)!.at).toBeLessThanOrEqual(50 + 2); // the undoubled budget
    await h.closeAndSettle();
  });
});

describe('re-establishment order at a WELCOME (every dormant record is REGISTERed, FIFO by seq)', () => {
  const registers = (c: SimClient<Client>, connection: number): unknown[] =>
    c
      .trace()
      .frames.filter(
        (f) => f.direction === 'in' && f.connection === connection && Array.isArray(f.frame) && f.frame[0] === 64,
      )
      .map((f) => (f.frame as unknown[])[3]);

  test('registrations come back in subscription order', async () => {
    const h = harness();
    const c = client(h, { retryOptions: { maxRetryDelay: 100 } });
    c.open();
    await h.clock.advance(0);
    for (const p of ['rv.c', 'rv.a', 'rv.b'])
      c.observe(
        'register',
        p,
        c.client.register(p, () => 1),
      );
    await h.clock.advance(0);
    const first = c.connection.number;
    c.connection.controls.drop();
    await h.clock.advance(1000);
    expect(lastStatus(c)?.state).toBe('open');
    expect(c.connection.number).not.toBe(first);
    expect(registers(c, c.connection.number)).toEqual(['rv.c', 'rv.a', 'rv.b']);
    await h.closeAndSettle();
  });

  test('a subscription that adopted an older record goes by its own (later) seq', async () => {
    const h = harness();
    const c = client(h, { retryOptions: { maxRetryDelay: 100 } });
    c.open();
    await h.clock.advance(0);
    const unignore = h.router.ignore((f) => f[0] === 64 && f[3] === 'rv.a'); // its REGISTER stays outstanding
    const a = c.observe(
      'register',
      'rv.a',
      c.client.register('rv.a', () => 1),
    );
    await h.clock.advance(0);
    a.unsubscribe(); // stopped while registering: the record stays for an adopter
    c.observe(
      'register',
      'rv.b',
      c.client.register('rv.b', () => 1),
    );
    await h.clock.advance(0);
    c.observe(
      'register',
      'rv.a',
      c.client.register('rv.a', () => 2),
    ); // adopts the outstanding REGISTER
    await h.clock.advance(0);
    expect(registers(c, c.connection.number)).toEqual(['rv.a', 'rv.b']);
    unignore();
    c.connection.controls.drop();
    await h.clock.advance(1000);
    expect(lastStatus(c)?.state).toBe('open');
    expect(registers(c, c.connection.number)).toEqual(['rv.b', 'rv.a']);
    await h.closeAndSettle();
  });
});
