// The behaviour matrix: one test per cell — every condition (row) × call, progressive call, register, topic, publish
// (ack), publish (no ack), challenge (onChallenge) — driven end to end through the real Client and every participant
// against the reference router under the virtual clock. "Lost" = error(ConnectionLostError) at the moment of the loss,
// after onClose/status were delivered; "Closed" = error(ConnectionClosedError); "waits" = no frame until the next
// WELCOME, then written once; "dormant" = no emission, re-established at the next WELCOME. A "—"/"n/a" cell checks that
// the condition indeed leaves that column alone. Every run ends with the harness's end-of-run checks (no timer, no
// listener, no router violation, no unscripted traffic).
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { isThruwayError, isWampError } from '../../src/errors.js';
import { Observable } from '../../src/observable/observable.js';
import type { ChallengeMessage, ClientOptions, CloseInfo, InvocationMessage } from '../../src/types.js';
import type { Recorded } from '../helpers/trace.js';
import { createHarness, type Harness, type HarnessOptions, type SimClient } from '../helpers/harness.js';

type Column = 'call' | 'progressive call' | 'register' | 'topic' | 'publish (ack)' | 'publish (no ack)';
const OPS: readonly Column[] = ['call', 'progressive call', 'register', 'topic', 'publish (ack)', 'publish (no ack)'];

interface Env {
  readonly h: Harness;
  readonly c: SimClient<Client>;
}

interface EnvOptions {
  readonly options?: ClientOptions;
  readonly checks?: HarnessOptions['checks'];
  readonly router?: HarnessOptions['router'];
  /** Runs before the client is built (router availability, ignore predicates). */
  readonly setup?: (h: Harness) => void;
  /** Acknowledged PUBLISHes are never acknowledged (they stay in flight). */
  readonly holdAcks?: boolean;
}

/** The procedures and topics every cell may use. `m.feed` emits one progress result, then never completes. */
function env(o: EnvOptions = {}): Env {
  const h = createHarness({
    seed: 202,
    router: o.router ?? {},
    ...(o.checks === undefined ? {} : { checks: o.checks }),
  });
  h.router.procedure('m.slow', () => new Promise(() => undefined));
  h.router.procedure('m.ok', () => 'ok');
  h.router.procedure(
    'm.feed',
    () =>
      new Observable<string>((s) => {
        s.next('p1');
      }),
  );
  h.router.declareTopic('m.t');
  if (o.holdAcks === true) {
    h.router.ignore((f) => f[0] === 16 && (f[2] as { acknowledge?: boolean }).acknowledge === true);
  }
  o.setup?.(h);
  const c = h.makeClient(Client, {
    options: { timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 100 }, ...o.options },
  });
  return { h, c };
}

/** A client that authenticates with a ticket on every attempt; `answered()` counts the onChallenge calls. */
function ticketEnv(o: EnvOptions = {}): Env & { readonly answered: () => number } {
  let n = 0;
  const onChallenge = (): string => {
    n++;
    return 'secret';
  };
  const e = env({
    ...o,
    options: { authmethods: ['ticket'], onChallenge, ...o.options },
    router: {
      authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) }),
    },
  });
  return { ...e, answered: () => n };
}

/** onChallenge ran once, one AUTHENTICATE was written, and the session it opened is still the only one. */
function untouchedHandshake(e: ReturnType<typeof ticketEnv>): void {
  expect(e.answered()).toBe(1);
  expect(count(e.c, 1, 5)).toBe(1);
  expect(closes(e.c)).toEqual([]);
  expect(e.c.client.session).toBeDefined();
}

/** Subscribe the subject of `column` (in flight once the client is open: CALL/feed/held PUBLISH). */
function subject(e: Env, column: Column, handler?: (inv: InvocationMessage) => unknown): Recorded<unknown> {
  const { c } = e;
  switch (column) {
    case 'call':
      return c.observe('call', 'm.slow', c.client.call('m.slow'));
    case 'progressive call':
      return c.observe('call', 'm.feed', c.client.progressiveCall('m.feed'));
    case 'register':
      return c.observe('register', 'm.r', c.client.register('m.r', handler ?? (() => 'r')));
    case 'topic':
      return c.observe('topic', 'm.t', c.client.topic('m.t'));
    case 'publish (ack)':
      return c.observe('publish', 'm.t', c.client.publish('m.t', [1], {}, { acknowledge: true }));
    case 'publish (no ack)':
      return c.observe('publish', 'm.t', c.client.publish('m.t', [1]));
  }
}

/** The wire type of the request of `column`. */
const REQUEST: Readonly<Record<Column, number>> = {
  call: 48,
  'progressive call': 48,
  register: 64,
  topic: 32,
  'publish (ack)': 16,
  'publish (no ack)': 16,
};

function written(c: SimClient<Client>, n: number): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket)
    .map((f) => f.frame as unknown[]);
}
const count = (c: SimClient<Client>, n: number, type: number): number =>
  written(c, n).filter((f) => f[0] === type).length;
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const code = (e: unknown): string | undefined => (isThruwayError(e) ? e.code : undefined);
const raw = (h: Harness, frame: unknown[]): void => {
  h.router.sendRaw(JSON.stringify(frame));
};
const isOneShot = (column: Column): boolean => column !== 'register' && column !== 'topic';

/** In flight (or active) for each column after the session is up. */
async function opened(e: Env, column: Column): Promise<Recorded<unknown>> {
  await e.h.clock.advance(5);
  const r = subject(e, column);
  await e.h.clock.advance(5);
  return r;
}

/** After a session end: one-shots in flight are Lost (or, unacknowledged, already completed); interests are alive,
 *  silent, and re-established once at the next WELCOME. */
async function expectEndOutcome(e: Env, column: Column, r: Recorded<unknown>, lostCause?: string): Promise<void> {
  if (column === 'publish (no ack)') {
    expect(r.completed).toBe(true); // completed when it was written: the end does not touch it
  } else if (isOneShot(column)) {
    expect(code(r.error)).toBe('connection_lost');
    if (lostCause !== undefined) expect(code((r.error as { cause?: unknown }).cause)).toBe(lostCause);
    if (column === 'progressive call') expect(r.values).toHaveLength(1); // values already emitted stay
  } else {
    expect(r.closed).toBe(false);
    await e.h.clock.advance(5000);
    expect(r.closed).toBe(false);
    const last = e.c.connections.length;
    expect(count(e.c, last, REQUEST[column])).toBe(1); // re-established once
    if (column === 'register') expect(r.values.length).toBe(last); // a RegisteredMessage per session
  }
  await e.h.finish();
}

// ---------------------------------------------------------------------------------------------------------------------

describe('Not connected yet (never opened, WAITING, connecting)', () => {
  test.each(OPS)('%s: waits (one-shots) / dormant (interests); written once at the next WELCOME', async (column) => {
    const e = env({ options: { autoOpen: false }, holdAcks: false });
    const r = subject(e, column);
    await e.h.clock.advance(10000);
    expect(e.c.connections).toHaveLength(0);
    expect(r.closed).toBe(false);
    e.c.open();
    await e.h.clock.advance(5);
    expect(count(e.c, 1, REQUEST[column])).toBe(1);
    if (column === 'call') expect(r.closed).toBe(false); // in flight
    if (column === 'publish (no ack)' || column === 'publish (ack)') expect(r.completed).toBe(true);
    await e.h.finish();
  });

  test.each(['WAITING', 'connecting'] as const)('every column waits through %s too', async (phase) => {
    const e = env({
      setup: (h) => {
        if (phase === 'WAITING') h.router.setAvailable('refuse');
        else h.router.setAvailable('hang');
      },
    });
    const rs = OPS.map((column) => subject(e, column));
    await e.h.clock.advance(50);
    for (const r of rs) expect(r.closed).toBe(false);
    e.h.router.setAvailable('ok');
    await e.h.clock.advance(15000);
    const last = e.c.connections.length;
    for (const column of OPS) {
      const type = REQUEST[column];
      const expected = OPS.filter((x) => REQUEST[x] === type).length;
      expect(count(e.c, last, type)).toBe(expected);
    }
    await e.h.finish();
  });

  test('challenge: onChallenge is invoked only on a CHALLENGE', async () => {
    const onChallenge = vi.fn(() => 'secret');
    const e = env({
      options: { authmethods: ['ticket'], onChallenge, autoOpen: false },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) }),
      },
    });
    await e.h.clock.advance(1000);
    expect(onChallenge).not.toHaveBeenCalled();
    e.c.open();
    await e.h.clock.advance(5);
    expect(onChallenge).toHaveBeenCalledTimes(1);
    await e.h.finish();
  });
});

describe('Started while stopped (after close() or give-up, before open())', () => {
  test.each(OPS)('%s: Closed at once with the stop error', async (column) => {
    for (const stop of ['close', 'give-up'] as const) {
      const e = env({
        options: stop === 'give-up' ? { retryOptions: { maxRetries: 0 } } : {},
        setup: (h) => {
          if (stop === 'give-up') h.router.setAvailable('refuse');
        },
      });
      await e.h.clock.advance(5);
      if (stop === 'close') void e.c.client.close();
      await e.h.clock.advance(5);
      const r = subject(e, column);
      expect(code(r.error)).toBe('connection_closed');
      expect((r.error as { gaveUp: boolean }).gaveUp).toBe(stop === 'give-up');
      // a give-up's error carries the last attempt's error as its cause; close() has none
      expect((r.error as { cause?: unknown }).cause).toBe(stop === 'give-up' ? closes(e.c).at(-1)?.error : undefined);
      if (stop === 'give-up') expect(code(closes(e.c).at(-1)?.error)).toBe('connection_lost');
      await e.h.finish();
    }
  });

  test('challenge: — (no attempt, so no CHALLENGE)', async () => {
    const onChallenge = vi.fn(() => 'x');
    const e = env({ options: { authmethods: ['ticket'], onChallenge, autoOpen: false } });
    void e.c.client.close();
    e.c.client.call('m.ok').subscribe({ error: () => undefined });
    await e.h.clock.advance(5000);
    expect(onChallenge).not.toHaveBeenCalled();
    await e.h.finish();
  });
});

describe('Socket drop', () => {
  test.each(OPS)('%s', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    e.c.connection.controls.drop();
    await e.h.clock.advance(1);
    expect(count(e.c, 1, 49)).toBe(0); // no CANCEL
    expect(count(e.c, 1, 34) + count(e.c, 1, 66)).toBe(0); // no UNSUBSCRIBE/UNREGISTER for old ids
    await expectEndOutcome(e, column, r);
  });

  test('call and publish waiting for a session keep waiting through a drop', async () => {
    const e = env({
      options: { autoOpen: false },
      setup: (h) => {
        h.router.ignore((f, conn) => f[0] === 1 && conn.number === 1); // the first attempt never gets a WELCOME
      },
    });
    const call = subject(e, 'call');
    const pub = subject(e, 'publish (no ack)');
    e.c.open();
    await e.h.clock.advance(5);
    e.h.router.drop(); // before WELCOME: they are still waiting
    await e.h.clock.advance(5000);
    const total = (type: number): number =>
      e.c.connections.map((_, i) => count(e.c, i + 1, type)).reduce((a, b) => a + b, 0);
    expect(count(e.c, 1, 48) + count(e.c, 1, 16)).toBe(0);
    expect([total(48), total(16)]).toEqual([1, 1]); // written once, in the next session
    expect(call.errored).toBe(false);
    expect(pub.completed).toBe(true);
    await e.h.finish();
  });

  test('register: running invocations are aborted (reason Lost), their results discarded', async () => {
    let signal: AbortSignal | undefined;
    let resolve: (v: string) => void = () => undefined;
    const e = env();
    subject(e, 'register', (inv) => {
      signal = inv.signal as AbortSignal;
      return new Promise<string>((r) => (resolve = r));
    });
    await e.h.clock.advance(5);
    const caller = e.h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    caller.observe('call', 'm.r', caller.client.call('m.r'));
    await e.h.clock.advance(5);
    e.c.connection.controls.drop();
    await e.h.clock.advance(1);
    expect(code(signal?.reason)).toBe('connection_lost');
    resolve('too late');
    await e.h.clock.advance(5);
    expect(count(e.c, 1, 70)).toBe(0);
    await e.h.finish();
  });

  test('challenge: the pending handler is cancelled (reason Lost); the next CHALLENGE calls it again', async () => {
    const signals: AbortSignal[] = [];
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: (ch: ChallengeMessage) => {
          signals.push(ch.signal as AbortSignal);
          return signals.length === 1 ? new Promise<string>(() => undefined) : 'secret';
        },
      },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(5);
    e.c.connection.controls.drop();
    await e.h.clock.advance(5000);
    expect(code(signals[0]?.reason)).toBe('connection_lost');
    expect(signals).toHaveLength(2);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });
});

describe('Write refused by a closing socket', () => {
  test.each(OPS)(
    '%s: not sent ⇒ waits / dormant; written once after the next WELCOME; the connection ends as a drop',
    async (column) => {
      const e = env();
      await e.h.clock.advance(5);
      e.c.connection.controls.closingWindow(500);
      await e.h.clock.advance(1);
      const r = subject(e, column);
      await e.h.clock.advance(5000);
      expect(count(e.c, 1, REQUEST[column])).toBe(0);
      expect(count(e.c, 2, REQUEST[column])).toBe(1);
      expect(closes(e.c)[0]).toMatchObject({ closeCode: 1006, initiator: 'connection' });
      expect(r.errored).toBe(false);
      await e.h.finish();
    },
  );

  test('challenge: an AUTHENTICATE that is not sent ends the attempt as a drop', async () => {
    let answer: (v: string) => void = () => undefined;
    const e = env({
      options: { authmethods: ['ticket'], onChallenge: () => new Promise<string>((r) => (answer = r)) },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(5);
    e.c.connection.controls.closingWindow(500);
    await e.h.clock.advance(1);
    answer('late');
    await e.h.clock.advance(1);
    expect(count(e.c, 1, 5)).toBe(0);
    expect(closes(e.c)[0]).toMatchObject({ closeCode: 1006 });
    await e.h.finish();
  });
});

describe('Router ABORT', () => {
  test.each(OPS)('%s', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    raw(e.h, [3, { message: 'bye' }, 'wamp.close.killed']);
    await e.h.clock.advance(1);
    await expectEndOutcome(e, column, r, 'abort');
  });

  test('challenge: a handshake ABORT (auth failure, no_such_realm, thruway authentication_failure) cancels the handler; AbortError; backoff', async () => {
    for (const reason of [
      'wamp.error.not_authorized',
      'wamp.error.no_such_realm',
      'thruway.error.authentication_failure',
    ]) {
      let signal: AbortSignal | undefined;
      const e = env({
        options: {
          authmethods: ['ticket'],
          onChallenge: (ch: ChallengeMessage) => {
            signal = ch.signal as AbortSignal;
            return new Promise<string>(() => undefined);
          },
          retryOptions: { maxRetries: 0 },
        },
        router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ abort: reason }) }) },
      });
      await e.h.clock.advance(5);
      raw(e.h, [3, {}, reason]);
      await e.h.clock.advance(1);
      expect(closes(e.c).at(-1)).toMatchObject({ initiator: 'router', reason });
      expect(code(closes(e.c).at(-1)?.error)).toBe('abort');
      expect(signal?.aborted).toBe(true);
      // the end gave up (maxRetries 0): Closed{gaveUp, cause: Lost{cause: the AbortError}}
      expect(signal?.reason).toMatchObject({ code: 'connection_closed', gaveUp: true });
      const lost = (signal?.reason as { cause?: { code?: string; cause?: unknown } }).cause;
      expect(lost?.code).toBe('connection_lost');
      expect(lost?.cause).toBe(closes(e.c).at(-1)?.error);
      await e.h.finish();
    }
  });
});

describe('Router GOODBYE', () => {
  test.each(OPS)('%s: Lost{reason} / dormant (survives); one GOODBYE reply', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    e.h.router.goodbye('com.example.session_ended');
    await e.h.clock.advance(1);
    expect(written(e.c, 1).filter((f) => f[0] === 6)).toEqual([[6, {}, 'wamp.close.goodbye_and_out']]);
    if (isOneShot(column) && column !== 'publish (no ack)') {
      expect((r.error as { reason?: string }).reason).toBe('com.example.session_ended');
    }
    await expectEndOutcome(e, column, r);
  });

  test('waiting ops are untouched by a router GOODBYE', async () => {
    const e = env();
    await e.h.clock.advance(5);
    e.c.connection.controls.closingWindow(10);
    await e.h.clock.advance(1);
    const waiting = subject(e, 'call'); // refused: waiting
    await e.h.clock.advance(2);
    expect(waiting.closed).toBe(false);
    await e.h.clock.advance(5000);
    expect(count(e.c, 2, 48)).toBe(1);
    await e.h.finish();
  });

  test('challenge: a GOODBYE before WELCOME is an ABORT, without a reply', async () => {
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: () => new Promise<string>(() => undefined),
        retryOptions: { maxRetries: 0 },
      },
      router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) },
    });
    await e.h.clock.advance(5);
    raw(e.h, [6, {}, 'wamp.close.system_shutdown']);
    await e.h.clock.advance(1);
    expect(count(e.c, 1, 6)).toBe(0);
    expect(code(closes(e.c)[0]?.error)).toBe('abort');
    await e.h.finish();
  });
});

describe('Router welcomes anonymously although authmethods did not offer it', () => {
  const anon = { authmethods: ['ticket'], onChallenge: () => 'x', retryOptions: { maxRetries: 0 } };

  test.each(OPS)('%s: keeps waiting / stays dormant; nothing written', async (column) => {
    const e = env({ options: { ...anon, retryOptions: { retryDelay: () => 100000 } } });
    const r = subject(e, column);
    await e.h.clock.advance(5);
    expect(written(e.c, 1).map((f) => f[0])).toEqual([1, 6]); // HELLO, then the GOODBYE that rejects the WELCOME
    expect(r.closed).toBe(false);
    expect(e.c.onOpen?.values).toEqual([]);
    await e.h.finish();
  });

  test('challenge: GOODBYE + onClose with AuthenticationError; reconnect with backoff', async () => {
    const e = env({ options: { ...anon, retryOptions: { maxRetries: 1 } } });
    await e.h.clock.runUntilIdle();
    expect(closes(e.c).map((i) => code(i.error))).toEqual(['authentication', 'authentication']);
    await e.h.finish();
  });
});

describe('Protocol violation (the client ABORTs on a header-fatal frame)', () => {
  test.each(OPS)('%s: Lost{cause: ProtocolError} / dormant', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    e.h.router.sendRaw('{"not": "a frame"}');
    await e.h.clock.advance(1);
    expect(written(e.c, 1).at(-1)?.[2]).toBe('wamp.error.protocol_violation');
    await expectEndOutcome(e, column, r, 'protocol');
  });

  test('challenge: the pending handler is cancelled; reconnect', async () => {
    let signal: AbortSignal | undefined;
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: (ch: ChallengeMessage) => {
          signal ??= ch.signal as AbortSignal;
          return signal === ch.signal ? new Promise<string>(() => undefined) : 's';
        },
      },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(5);
    e.h.router.sendRaw('[]');
    await e.h.clock.advance(1);
    expect(signal?.reason).toMatchObject({ code: 'connection_lost' }); // the client retries: Lost{cause: ProtocolError}
    expect(code((signal?.reason as { cause?: unknown }).cause)).toBe('protocol');
    await e.h.clock.advance(5000);
    expect(signal?.aborted).toBe(true);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });
});

describe('Payload-invalid frame', () => {
  test.each(['call', 'progressive call'] as const)(
    '%s: its RESULT/ERROR ⇒ that op errors ProtocolError; the session continues',
    async (column) => {
      const e = env();
      const r = await opened(e, column);
      const id = written(e.c, 1).find((f) => f[0] === 48)?.[1];
      raw(e.h, [50, id, {}, 'not args']);
      await e.h.clock.advance(1);
      expect(code(r.error)).toBe('protocol');
      expect(e.c.client.session).toBeDefined();
      await e.h.finish();
    },
  );

  test('register: an invalid INVOCATION ⇒ ERROR invalid_argument; the registration stays', async () => {
    const e = env();
    const r = await opened(e, 'register');
    const regId = (r.values[0] as { registrationId: number }).registrationId;
    raw(e.h, [68, 4242, regId, {}, 'not args']);
    await e.h.clock.advance(1);
    expect(written(e.c, 1).find((f) => f[0] === 8)).toEqual([8, 68, 4242, {}, 'wamp.error.invalid_argument']);
    expect(r.closed).toBe(false);
    await e.h.finish();
  });

  test('topic: an invalid EVENT is dropped (warn); a payload-invalid ERROR(32) ⇒ locals ProtocolError', async () => {
    const e = env();
    const r = await opened(e, 'topic');
    e.h.router.publish('m.t', [1]);
    await e.h.clock.advance(1);
    const sub = e.h.router.sessions[0]?.subscriptions[0]?.id;
    raw(e.h, [36, sub, 7, {}, 'not args']);
    await e.h.clock.advance(1);
    expect(r.values).toHaveLength(1);
    expect(e.c.trace().logs.some((l) => l.entry.event === 'frame.dropped' && l.entry.level === 'warn')).toBe(true);
    const e2 = env({
      setup: (h) => {
        h.router.ignore((f) => {
          if (f[0] !== 32) return false;
          queueMicrotask(() => {
            h.router.sendRaw(JSON.stringify([8, 32, f[1], {}, 'wamp.error.x', 'not args']));
          });
          return true;
        });
      },
    });
    const t = subject(e2, 'topic');
    await e2.h.clock.advance(5);
    expect(code(t.error)).toBe('protocol');
    await e.h.finish();
    await e2.h.finish();
  });

  test('publish (ack): a payload-invalid ERROR(16) ⇒ ProtocolError', async () => {
    const e = env({ holdAcks: true });
    const r = await opened(e, 'publish (ack)');
    const id = written(e.c, 1).find((f) => f[0] === 16)?.[1];
    raw(e.h, [8, 16, id, {}, 'wamp.error.x', 'not args']);
    await e.h.clock.advance(1);
    expect(code(r.error)).toBe('protocol');
    await e.h.finish();
  });

  test('publish (no ack) and challenge: — (no reply to be invalid)', async () => {
    const e = env();
    const r = await opened(e, 'publish (no ack)');
    expect(r.completed).toBe(true);
    await e.h.finish();
  });
});

describe('Handshake timeout', () => {
  test.each(OPS)('%s: keeps waiting / stays dormant', async (column) => {
    const e = env({
      options: { timeouts: { idle: 0, handshake: 1000 } },
      setup: (h) => {
        h.router.ignore((f, conn) => f[0] === 1 && conn.number === 1);
      },
    });
    const r = subject(e, column);
    await e.h.clock.advance(1050);
    expect(code(closes(e.c)[0]?.error)).toBe('timeout');
    expect(r.closed).toBe(false);
    await e.h.clock.advance(5000);
    expect(count(e.c, 2, REQUEST[column])).toBe(1);
    await e.h.finish();
  });

  test('challenge: never fires while the handler is pending; fires if the router does not answer AUTHENTICATE; doubles', async () => {
    let answer: (v: string) => void = () => undefined;
    const e = env({
      options: {
        timeouts: { idle: 0, handshake: 1000 },
        authmethods: ['ticket'],
        onChallenge: () => new Promise<string>((r) => (answer = r)),
      },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
      setup: (h) => {
        h.router.ignore((f, conn) => f[0] === 5 && conn.number <= 2);
      },
    });
    await e.h.clock.advance(60000); // a person at a login dialog
    expect(closes(e.c)).toHaveLength(0);
    answer('typed');
    await e.h.clock.advance(1000);
    expect(closes(e.c)[0]?.error).toMatchObject({ timer: 'handshake', timeout: 1000 });
    await e.h.clock.advance(150);
    answer('again');
    await e.h.clock.advance(2000);
    expect(closes(e.c)[1]?.error).toMatchObject({ timer: 'handshake', timeout: 2000 }); // doubled
    await e.h.clock.advance(150);
    answer('third');
    await e.h.clock.advance(10);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });
});

describe('Liveness timeout', () => {
  test.each(OPS)('%s: Lost{cause: TimeoutError{liveness}} / dormant', async (column) => {
    const e = env({
      options: { timeouts: { idle: 1000 } },
      holdAcks: true,
      setup: (h) => {
        h.router.ignore((f, conn) => conn.number === 1 && f[3] === 'thruway.js.ping');
      },
    });
    const r = await opened(e, column);
    await e.h.clock.advance(21000);
    expect(closes(e.c)[0]?.error).toMatchObject({ timer: 'liveness' });
    await expectEndOutcome(e, column, r, 'timeout');
  });

  test('challenge: n/a (no session, no probe)', async () => {
    const e = env({
      options: {
        timeouts: { idle: 1000 },
        authmethods: ['ticket'],
        onChallenge: () => new Promise<string>(() => undefined),
      },
      router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) },
    });
    await e.h.clock.advance(60000);
    expect(written(e.c, 1).filter((f) => f[3] === 'thruway.js.ping')).toHaveLength(0);
    await e.h.finish();
  });
});

describe('Request-ack timeout', () => {
  test.each(['register', 'topic'] as const)('%s: probe first; router alive ⇒ TimeoutError{request}', async (column) => {
    const e = env({
      options: { timeouts: { idle: 1000, request: 2000 } },
      setup: (h) => {
        h.router.ignore((f) => f[0] === REQUEST[column]);
      },
    });
    const r = subject(e, column);
    await e.h.clock.advance(2100);
    expect(r.error).toMatchObject({ name: 'TimeoutError', timer: 'request' });
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });

  test.each(['register', 'topic'] as const)(
    '%s: the probe fails ⇒ the session ends, the interest is dormant',
    async (column) => {
      const e = env({
        options: { timeouts: { idle: 60000, request: 2000 } },
        setup: (h) => {
          h.router.ignore((f, conn) => conn.number === 1 && (f[0] === REQUEST[column] || f[3] === 'thruway.js.ping'));
        },
      });
      const r = subject(e, column);
      await e.h.clock.advance(30000);
      expect(closes(e.c)[0]?.error).toMatchObject({ timer: 'liveness' });
      expect(r.closed).toBe(false);
      expect(count(e.c, 2, REQUEST[column])).toBe(1);
      await e.h.finish();
    },
  );

  test.each(['register', 'topic'] as const)(
    '%s: the late answer of a timed-out request ⇒ UN* unless a new subscription adopts it',
    async (column) => {
      let held: readonly unknown[] | undefined;
      const e = env({
        options: { timeouts: { idle: 1000, request: 2000 } },
        setup: (h) => {
          h.router.ignore((f) => {
            if (f[0] !== REQUEST[column] || held !== undefined) return false;
            held = f;
            return true;
          });
        },
      });
      const r = subject(e, column);
      await e.h.clock.advance(2100);
      expect(code(r.error)).toBe('timeout');
      raw(e.h, column === 'register' ? [65, held?.[1], 9001] : [33, held?.[1], 9001]);
      await e.h.clock.advance(1);
      expect(count(e.c, 1, column === 'register' ? 66 : 34)).toBe(1);
      // the late answer is forged (the router never processed the request), but the oracle judges UN* ids against the
      // ids the client received on the connection (INV-CL02), so the UN* for 9001 is no violation
      expect(e.h.router.violations).toEqual([]);
      await e.h.finish();
    },
  );

  test.each(['call', 'progressive call', 'publish (ack)', 'publish (no ack)'] as const)(
    '%s: n/a (no client timer; Rx timeout())',
    async (column) => {
      const e = env({ holdAcks: true });
      const r = await opened(e, column);
      await e.h.clock.advance(300000);
      if (column !== 'publish (no ack)') expect(r.closed).toBe(false); // still in flight: the app bounds it
      await e.h.finish();
    },
  );

  test('challenge: n/a (a request timeout never calls onChallenge and leaves the session alone)', async () => {
    const e = ticketEnv({
      options: { timeouts: { idle: 1000, request: 2000 } },
      setup: (h) => {
        h.router.ignore((f) => f[0] === 32);
      },
    });
    await e.h.clock.advance(5);
    const r = subject(e, 'topic');
    await e.h.clock.advance(2100);
    expect(code(r.error)).toBe('timeout');
    untouchedHandshake(e);
    await e.h.finish();
  });
});

describe('close()', () => {
  test.each(OPS)(
    '%s: in flight and waiting ⇒ Closed; no CANCEL / UNSUBSCRIBE / UNREGISTER, only the GOODBYE',
    async (column) => {
      const e = env({ holdAcks: true });
      const r = await opened(e, column);
      const before = written(e.c, 1).length;
      void e.c.client.close();
      await e.h.clock.advance(5);
      if (column === 'publish (no ack)') expect(r.completed).toBe(true);
      else expect(r.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
      expect(written(e.c, 1).slice(before)).toEqual([[6, {}, 'wamp.close.close_realm']]);
      await e.h.finish();
    },
  );

  test('a waiting publish (no ack) is Closed', async () => {
    const e = env({ options: { autoOpen: false } });
    const r = subject(e, 'publish (no ack)');
    void e.c.client.close();
    expect(code(r.error)).toBe('connection_closed');
    await e.h.finish();
  });

  test('register: invocations aborted (reason Closed), nothing written for them', async () => {
    let signal: AbortSignal | undefined;
    const e = env();
    subject(e, 'register', (inv) => {
      signal = inv.signal as AbortSignal;
      return new Promise(() => undefined);
    });
    await e.h.clock.advance(5);
    const caller = e.h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    caller.observe('call', 'r', caller.client.call('m.r'));
    await e.h.clock.advance(5);
    void e.c.client.close();
    await e.h.clock.advance(5);
    expect(code(signal?.reason)).toBe('connection_closed');
    expect(count(e.c, 1, 8) + count(e.c, 1, 70)).toBe(0);
    await e.h.finish();
  });

  test('challenge: cancelled (reason Closed)', async () => {
    let signal: AbortSignal | undefined;
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: (ch: ChallengeMessage) => {
          signal = ch.signal as AbortSignal;
          return new Promise<string>(() => undefined);
        },
      },
      router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) },
    });
    await e.h.clock.advance(5);
    void e.c.client.close();
    await e.h.clock.advance(1);
    expect(code(signal?.reason)).toBe('connection_closed');
    await e.h.finish();
  });
});

describe('Give-up (maxRetries exhausted, or retryDelay returned null)', () => {
  test.each(OPS)(
    '%s: in flight at the last loss ⇒ Closed{gaveUp, cause: Lost}; waiting / interests ⇒ Closed{gaveUp}',
    async (column) => {
      for (const how of ['maxRetries', 'retryDelay null'] as const) {
        const e = env({
          holdAcks: true,
          options: { retryOptions: how === 'maxRetries' ? { maxRetries: 0 } : { retryDelay: () => null } },
        });
        const r = await opened(e, column);
        e.c.connection.controls.drop();
        await e.h.clock.advance(1);
        if (column === 'publish (no ack)') {
          expect(r.completed).toBe(true);
        } else {
          expect(r.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
          if (isOneShot(column)) expect(code((r.error as { cause?: unknown }).cause)).toBe('connection_lost');
        }
        await e.h.finish();
      }
    },
  );

  test('waiting one-shots ⇒ Closed{gaveUp, cause: the last attempt error} (not a Lost: they were never sent)', async () => {
    const e = env({
      options: { retryOptions: { maxRetries: 0 } },
      setup: (h) => {
        h.router.setAvailable('refuse');
      },
    });
    const call = subject(e, 'call');
    const pub = subject(e, 'publish (no ack)');
    await e.h.clock.advance(5);
    const last = closes(e.c).at(-1)?.error;
    expect(code(last)).toBe('connection_lost'); // the refused socket
    for (const r of [call, pub]) {
      expect(r.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
      expect((r.error as { cause?: unknown }).cause).toBe(last); // the last attempt's error when gaveUp
    }
    await e.h.finish();
  });

  test('challenge: cancelled (reason Closed{gaveUp})', async () => {
    let signal: AbortSignal | undefined;
    const e = env({
      options: {
        authmethods: ['ticket'],
        retryOptions: { maxRetries: 0 },
        onChallenge: (ch: ChallengeMessage) => {
          signal = ch.signal as AbortSignal;
          return new Promise<string>(() => undefined);
        },
      },
      router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) },
    });
    await e.h.clock.advance(5);
    e.c.connection.controls.drop();
    await e.h.clock.advance(1);
    expect(signal?.reason).toMatchObject({ code: 'connection_closed', gaveUp: true });
    await e.h.finish();
  });
});

describe('reconnect() while open', () => {
  test.each(OPS)('%s: in flight ⇒ Lost{reason close_realm}; interests dormant, re-established', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    await e.h.clock.advance(1000);
    e.c.reconnect();
    await e.h.clock.advance(1);
    if (isOneShot(column) && column !== 'publish (no ack)') {
      expect((r.error as { reason?: string }).reason).toBe('wamp.close.close_realm');
    }
    await expectEndOutcome(e, column, r);
  });

  test('waiting ops keep waiting through reconnect()', async () => {
    const e = env();
    await e.h.clock.advance(1000);
    e.c.connection.controls.closingWindow(5);
    await e.h.clock.advance(1);
    const waiting = subject(e, 'call');
    e.c.reconnect();
    await e.h.clock.advance(5000);
    expect(waiting.errored).toBe(false);
    expect(e.c.connections.map((_, i) => count(e.c, i + 1, 48)).reduce((a, b) => a + b, 0)).toBe(1);
    await e.h.finish();
  });

  test('challenge: — (a session exists: no handler is pending); the new handshake calls it again', async () => {
    const onChallenge = vi.fn(() => 's');
    const e = env({
      options: { authmethods: ['ticket'], onChallenge },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(1500);
    e.c.reconnect();
    await e.h.clock.advance(5);
    expect(onChallenge).toHaveBeenCalledTimes(2);
    await e.h.finish();
  });
});

describe('reconnect() while connecting', () => {
  test.each(OPS)('%s: keeps waiting / stays dormant', async (column) => {
    const e = env({
      setup: (h) => {
        h.router.setAvailable('hang');
      },
    });
    const r = subject(e, column);
    await e.h.clock.advance(1500);
    e.h.router.setAvailable('ok');
    e.c.reconnect();
    await e.h.clock.advance(5);
    expect(r.errored).toBe(false);
    expect(count(e.c, 2, REQUEST[column])).toBe(1);
    await e.h.finish();
  });

  test('challenge: the pending handler is cancelled (reason Canceled) and called again on the new handshake', async () => {
    const signals: AbortSignal[] = [];
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: (ch: ChallengeMessage) => {
          signals.push(ch.signal as AbortSignal);
          return signals.length === 1 ? new Promise<string>(() => undefined) : 's';
        },
      },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(1500);
    e.c.reconnect();
    await e.h.clock.advance(5);
    expect(code(signals[0]?.reason)).toBe('canceled');
    expect(signals).toHaveLength(2);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });
});

describe('open() after close()', () => {
  test.each(OPS)('%s: new subscriptions are written in the new session; old ones were Closed', async (column) => {
    const e = env();
    const old = await opened(e, column);
    void e.c.client.close();
    e.c.open(); // the new attempt starts once the 1 s attempt floor has passed
    const fresh = subject(e, column);
    await e.h.clock.advance(1000);
    if (column !== 'publish (no ack)' && column !== 'publish (ack)') expect(code(old.error)).toBe('connection_closed');
    expect(fresh.errored).toBe(false);
    expect(count(e.c, 2, REQUEST[column])).toBe(1);
    await e.h.finish();
  });

  test('challenge: invoked on the new handshake', async () => {
    const onChallenge = vi.fn(() => 's');
    const e = env({
      options: { authmethods: ['ticket'], onChallenge },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(5);
    void e.c.client.close();
    e.c.open();
    await e.h.clock.advance(1000);
    expect(onChallenge).toHaveBeenCalledTimes(2);
    await e.h.finish();
  });
});

describe('App unsubscribes', () => {
  test.each(OPS)('%s: waiting ⇒ removed, nothing written', async (column) => {
    const e = env({ options: { autoOpen: false } });
    const r = subject(e, column);
    r.unsubscribe();
    e.c.open();
    await e.h.clock.advance(5);
    expect(count(e.c, 1, REQUEST[column])).toBe(0);
    await e.h.finish();
  });

  test.each(['call', 'progressive call'] as const)(
    '%s: in flight ⇒ CANCEL killnowait; answered ⇒ nothing',
    async (column) => {
      const e = env();
      const r = await opened(e, column);
      r.unsubscribe();
      await e.h.clock.advance(5);
      expect(
        written(e.c, 1)
          .filter((f) => f[0] === 49)
          .map((f) => f[2]),
      ).toEqual([{ mode: 'killnowait' }]);
      const done = e.c.observe('call', 'm.ok', e.c.client.call('m.ok'));
      await e.h.clock.advance(5);
      done.unsubscribe();
      await e.h.clock.advance(5);
      expect(count(e.c, 1, 49)).toBe(1);
      await e.h.finish();
    },
  );

  test('call: a refused CANCEL is logged cancel.refused', async () => {
    const e = env();
    const r = await opened(e, 'call');
    const id = written(e.c, 1).find((f) => f[0] === 48)?.[1];
    r.unsubscribe();
    raw(e.h, [8, 49, id, {}, 'wamp.error.not_supported']);
    await e.h.clock.advance(1);
    expect(e.c.trace().logs.filter((l) => l.entry.event === 'cancel.refused')).toHaveLength(1);
    await e.h.finish();
  });

  test('register: running invocations ⇒ ERROR canceled; UNREGISTER (or on arrival unless adopted)', async () => {
    const e = env();
    const r = subject(e, 'register', () => new Promise(() => undefined));
    await e.h.clock.advance(5);
    const caller = e.h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const call = caller.observe('call', 'r', caller.client.call('m.r'));
    await e.h.clock.advance(5);
    r.unsubscribe();
    await e.h.clock.advance(5);
    expect(written(e.c, 1).find((f) => f[0] === 8)?.[4]).toBe('wamp.error.canceled');
    expect(count(e.c, 1, 66)).toBe(1);
    expect(isWampError(call.error) && call.error.uri).toBe('wamp.error.canceled');
    await e.h.finish();
  });

  test('topic: the last local of the key ⇒ UNSUBSCRIBE; deferred while a SUBSCRIBE of the same topic is pending', async () => {
    const e = env();
    const a = await opened(e, 'topic');
    const b = subject(e, 'topic');
    a.unsubscribe();
    await e.h.clock.advance(5);
    expect(count(e.c, 1, 34)).toBe(0);
    b.unsubscribe();
    await e.h.clock.advance(5);
    expect(count(e.c, 1, 34)).toBe(1);
    await e.h.finish();
  });

  test('publish (ack): nothing written; the late PUBLISHED is dropped', async () => {
    const e = env({ holdAcks: true });
    const r = await opened(e, 'publish (ack)');
    const id = written(e.c, 1).find((f) => f[0] === 16)?.[1];
    r.unsubscribe();
    await e.h.clock.advance(1);
    // the participant forgot it (no leak while a router never acknowledges, e.g. wamp-server)
    expect((e.c.debug() as { participants: { publish: { inFlight: number } } }).participants.publish.inFlight).toBe(0);
    raw(e.h, [17, id, 1]);
    await e.h.clock.advance(1);
    expect(written(e.c, 1).filter((f) => f[0] !== 1 && f[0] !== 16)).toEqual([]);
    expect(r.values).toEqual([]);
    const dropped = e.c.trace().logs.filter((l) => l.entry.event === 'frame.dropped');
    expect(dropped.map((l) => l.entry.message)).toEqual(['dropped message type 17: no record for it']);
    await e.h.finish();
  });

  test('challenge: an Observable answer is unsubscribed when the connection ends', async () => {
    const teardown = vi.fn();
    const e = env({
      options: { authmethods: ['ticket'], onChallenge: () => new Observable<string>(() => teardown) },
      router: { authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }) },
    });
    await e.h.clock.advance(5);
    e.c.connection.controls.drop();
    await e.h.clock.advance(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    await e.h.finish();
  });
});

describe('Re-subscribe within one round trip (StrictMode, switchMap, retry)', () => {
  test.each(OPS)('%s', async (column) => {
    const e = env({ holdAcks: true });
    await e.h.clock.advance(5);
    subject(e, column).unsubscribe();
    const again = subject(e, column);
    await e.h.clock.advance(5);
    const sent = count(e.c, 1, REQUEST[column]);
    if (column === 'register' || column === 'topic') {
      expect(sent).toBe(1); // adopts / joins the pending request: exactly one registration / subscription
      expect(count(e.c, 1, column === 'register' ? 66 : 34)).toBe(0);
      expect(again.values.length).toBe(column === 'register' ? 1 : 0);
    } else {
      expect(sent).toBe(2); // a new CALL / PUBLISH
    }
    await e.h.finish();
  });

  test('challenge: — (a re-subscription never calls onChallenge again)', async () => {
    const e = ticketEnv();
    await e.h.clock.advance(5);
    subject(e, 'register').unsubscribe();
    const again = subject(e, 'register');
    await e.h.clock.advance(5);
    expect(count(e.c, 1, 64)).toBe(1);
    expect(again.values).toHaveLength(1);
    untouchedHandshake(e);
    await e.h.finish();
  });
});

describe('App observer throws', () => {
  test.each(OPS)('%s: logged unhandled; the op continues; other subscriptions unaffected', async (column) => {
    const e = env();
    await e.h.clock.advance(5);
    const throwing = {
      next: () => {
        throw new Error('observer bug');
      },
    };
    const other = subject(e, 'topic');
    let r: { closed: boolean } | undefined;
    switch (column) {
      case 'call':
        r = e.c.client.call('m.ok').subscribe(throwing);
        break;
      case 'progressive call':
        r = e.c.client.progressiveCall('m.feed').subscribe(throwing);
        break;
      case 'register':
        r = e.c.client.register('m.r', () => 1).subscribe(throwing);
        break;
      case 'topic':
        r = e.c.client.topic('m.t').subscribe(throwing);
        break;
      case 'publish (ack)':
        r = e.c.client.publish('m.t', [], {}, { acknowledge: true }).subscribe(throwing);
        break;
      case 'publish (no ack)':
        r = e.c.client.publish('m.t').subscribe(throwing);
        break;
    }
    await e.h.clock.advance(5);
    e.h.router.publish('m.t', ['e']);
    await e.h.clock.advance(5);
    expect(e.c.trace().logs.some((l) => l.entry.event === 'unhandled')).toBe(true);
    if (column === 'call' || column === 'publish (ack)' || column === 'publish (no ack)') expect(r.closed).toBe(true); // complete still delivered
    expect(other.values.length).toBeGreaterThanOrEqual(1);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });

  test('register: a handler throw ⇒ ERROR runtime_error to the caller; the registration is kept', async () => {
    const e = env();
    const r = subject(e, 'register', () => {
      throw new Error('handler bug');
    });
    await e.h.clock.advance(5);
    const caller = e.h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const a = caller.observe('call', 'r', caller.client.call('m.r'));
    await e.h.clock.advance(5);
    expect(a.error).toMatchObject({ uri: 'wamp.error.runtime_error', args: ['handler bug'] });
    expect(r.closed).toBe(false);
    await e.h.finish();
  });

  test('challenge: a handler throw ⇒ ABORT cannot_authenticate, reconnect', async () => {
    let n = 0;
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: () => {
          if (n++ === 0) throw new Error('dialog bug');
          return 's';
        },
      },
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) }),
      },
    });
    await e.h.clock.advance(5000);
    expect(closes(e.c)[0]).toMatchObject({ reason: 'wamp.error.cannot_authenticate' });
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });
});

describe('Bad argument (TypeError, invalid URI, cyclic options, bad option type)', () => {
  test.each(OPS)(
    '%s: that subscription errors synchronously; nothing written; the connection untouched',
    async (column) => {
      const e = env();
      await e.h.clock.advance(5);
      const before = written(e.c, 1).length;
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      const attempts: (() => Recorded<unknown>)[] = (() => {
        const c = e.c;
        switch (column) {
          case 'call':
            return [
              () => c.observe('call', 'x', c.client.call('a b')),
              () => c.observe('call', 'x', c.client.call('a.b', [], {}, cyclic)),
            ];
          case 'progressive call':
            return [() => c.observe('call', 'x', c.client.progressiveCall('a..b'))];
          case 'register':
            return [
              () =>
                c.observe(
                  'register',
                  'x',
                  c.client.register('a.b', () => 1, { invoke: 'everyone' as 'single' }),
                ),
            ];
          case 'topic':
            return [
              () => c.observe('topic', 'x', c.client.topic('a#b')),
              () => c.observe('topic', 'x', c.client.topic('a.b', { match: 5 as unknown as 'exact' })),
            ];
          case 'publish (ack)':
            return [
              () =>
                c.observe(
                  'publish',
                  'x',
                  c.client.publish('a.b', [], {}, { acknowledge: 'yes' as unknown as boolean }),
                ),
            ];
          case 'publish (no ack)':
            return [() => c.observe('publish', 'x', c.client.publish('a.b', 'not args' as unknown as unknown[]))];
        }
      })();
      for (const a of attempts) {
        const r = a();
        expect(r.errored).toBe(true);
        expect(r.error instanceof TypeError || (isWampError(r.error) && r.error.uri === 'wamp.error.invalid_uri')).toBe(
          true,
        );
      }
      expect(written(e.c, 1).length).toBe(before);
      expect(e.c.client.session).toBeDefined();
      await e.h.finish();
    },
  );

  test('challenge: — (a bad argument never reaches onChallenge or the handshake)', async () => {
    const e = ticketEnv();
    await e.h.clock.advance(5);
    const before = written(e.c, 1).length;
    const bad = [
      e.c.observe('call', 'x', e.c.client.call('a b')),
      e.c.observe(
        'register',
        'x',
        e.c.client.register('a.b', () => 1, { concurrency: 0 }),
      ),
    ];
    for (const r of bad) expect(r.errored).toBe(true);
    expect(written(e.c, 1).length).toBe(before);
    untouchedHandshake(e);
    await e.h.finish();
  });
});

describe('Result too large / not serializable', () => {
  test.each(['call', 'progressive call', 'publish (ack)', 'publish (no ack)'] as const)(
    '%s: the op errors; nothing written',
    async (column) => {
      const e = env();
      await e.h.clock.advance(5);
      const big = 'x'.repeat(16 * 1024 * 1024 + 1);
      const c = e.c;
      const r =
        column === 'call'
          ? c.observe('call', 'x', c.client.call('m.ok', [big]))
          : column === 'progressive call'
            ? c.observe('call', 'x', c.client.progressiveCall('m.feed', [10n]))
            : column === 'publish (ack)'
              ? c.observe('publish', 'x', c.client.publish('m.t', [big], {}, { acknowledge: true }))
              : c.observe('publish', 'x', c.client.publish('m.t', [10n]));
      if (column === 'call' || column === 'publish (ack)') {
        expect(r.error).toMatchObject({ uri: 'wamp.error.payload_size_exceeded' });
      } else {
        expect(r.error).toBeInstanceOf(TypeError); // BigInt: the serializer's own error
      }
      expect(written(e.c, 1).filter((f) => f[0] === REQUEST[column])).toHaveLength(0);
      expect(e.c.client.session).toBeDefined();
      await e.h.finish();
    },
  );

  test('register: the caller gets ERROR payload_size_exceeded / runtime_error; the registration is kept', async () => {
    const e = env();
    let n = 0;
    const r = subject(e, 'register', () => (n++ === 0 ? 'x'.repeat(16 * 1024 * 1024 + 1) : 10n));
    await e.h.clock.advance(5);
    const caller = e.h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const a = caller.observe('call', 'r', caller.client.call('m.r'));
    const b = caller.observe('call', 'r', caller.client.call('m.r'));
    await e.h.clock.advance(5);
    expect(isWampError(a.error) && a.error.uri).toBe('wamp.error.payload_size_exceeded');
    expect(b.error).toMatchObject({ uri: 'wamp.error.runtime_error', args: ['result could not be serialized'] });
    expect(r.closed).toBe(false);
    await e.h.finish();
  });

  test('topic and challenge: — (nothing of the app is serialized beyond the options, checked at subscribe)', async () => {
    const e = env();
    const r = await opened(e, 'topic');
    expect(r.errored).toBe(false);
    await e.h.finish();
  });
});

describe('Router error reply', () => {
  test.each(['call', 'progressive call'] as const)(
    '%s: ERROR(48 or 49) ⇒ WampError with uri, args, kwargs, details, procedure',
    async (column) => {
      for (const type of [48, 49]) {
        const e = env();
        const r = await opened(e, column);
        const id = written(e.c, 1).find((f) => f[0] === 48)?.[1];
        raw(e.h, [8, type, id, { d: 1 }, 'com.example.denied', ['why'], { k: 2 }]);
        await e.h.clock.advance(1);
        expect(r.error).toMatchObject({
          uri: 'com.example.denied',
          args: ['why'],
          kwargs: { k: 2 },
          details: { d: 1 },
        });
        if (column === 'progressive call') expect(r.values).toHaveLength(1); // also after progress
        await e.h.finish();
      }
    },
  );

  test.each([
    ['register', 64, 'wamp.error.procedure_already_exists'],
    ['topic', 32, 'wamp.error.not_authorized'],
    ['publish (ack)', 16, 'wamp.error.not_authorized'],
  ] as const)('%s: ERROR(%i) ⇒ WampError (%s)', async (column, type, uri) => {
    const e = env({
      setup: (h) => {
        h.router.ignore((f) => {
          if (f[0] !== type) return false;
          queueMicrotask(() => {
            h.router.sendRaw(JSON.stringify([8, type, f[1], {}, uri]));
          });
          return true;
        });
      },
    });
    const r = subject(e, column);
    await e.h.clock.advance(5);
    expect(isWampError(r.error) && r.error.uri).toBe(uri);
    await e.h.finish();
  });

  test('publish (no ack): none possible; challenge: auth failure arrives as ABORT', async () => {
    const e = env();
    const r = await opened(e, 'publish (no ack)');
    expect(r.completed).toBe(true);
    await e.h.finish();
  });
});

describe('Router revocation', () => {
  test('register: [67, 0, {registration}] ⇒ WampError thruway.error.registration_revoked', async () => {
    const e = env();
    const r = await opened(e, 'register');
    e.h.router.revokeRegistration('m.r', 'kicked');
    await e.h.clock.advance(1);
    expect(r.error).toMatchObject({ uri: 'thruway.error.registration_revoked', args: ['kicked'] });
    await e.h.finish();
  });

  test('topic: [35, 0, {subscription}] ⇒ WampError thruway.error.subscription_revoked', async () => {
    const e = env();
    const r = await opened(e, 'topic');
    e.h.router.revokeSubscription('m.t');
    await e.h.clock.advance(1);
    expect(r.error).toMatchObject({ uri: 'thruway.error.subscription_revoked', args: [] });
    await e.h.finish();
  });

  test.each(['call', 'progressive call', 'publish (ack)', 'publish (no ack)'] as const)('%s: n/a', async (column) => {
    const e = env({ holdAcks: true });
    const r = await opened(e, column);
    e.h.router.revokeSubscription('m.t');
    e.h.router.revokeRegistration('m.r');
    await e.h.clock.advance(1);
    expect(r.errored).toBe(false);
    await e.h.finish();
  });

  test('challenge: n/a (a revocation never calls onChallenge and leaves the session alone)', async () => {
    const e = ticketEnv();
    const r = await opened(e, 'register');
    e.h.router.revokeRegistration('m.r');
    await e.h.clock.advance(1);
    expect(r.error).toMatchObject({ uri: 'thruway.error.registration_revoked' });
    untouchedHandshake(e);
    await e.h.finish();
  });
});

describe('Duplicate / late / unknown replies', () => {
  test('call: dropped (also after a cancel; ERROR type 49 accepted)', async () => {
    const e = env();
    const r = await opened(e, 'call');
    const id = written(e.c, 1).find((f) => f[0] === 48)?.[1];
    r.unsubscribe();
    raw(e.h, [8, 49, id, {}, 'wamp.error.canceled']);
    raw(e.h, [50, id, {}, ['late']]);
    raw(e.h, [50, 777, {}, ['unknown']]);
    await e.h.clock.advance(1);
    expect(r.values).toEqual([]);
    expect(e.c.client.session).toBeDefined();
    await e.h.finish();
  });

  test('progressive call: a progress RESULT unrequested or empty is ignored', async () => {
    const e = env();
    const plain = await opened(e, 'call');
    const prog = subject(e, 'progressive call');
    await e.h.clock.advance(5);
    const [callId, progId] = written(e.c, 1)
      .filter((f) => f[0] === 48)
      .map((f) => f[1]);
    raw(e.h, [50, callId, { progress: true }, ['unrequested']]);
    raw(e.h, [50, progId, { progress: true }]);
    await e.h.clock.advance(1);
    expect(plain.values).toEqual([]);
    expect(prog.values).toHaveLength(1); // only the real progress result p1
    await e.h.finish();
  });

  test('register: unknown INVOCATION ⇒ ERROR no_such_registration and one UNREGISTER of it; unknown INTERRUPT ignored; duplicate REGISTERED ignored', async () => {
    const e = env();
    const r = await opened(e, 'register');
    const registered = e.c.trace().frames.find((f) => f.direction === 'out' && (f.frame as unknown[])[0] === 65);
    raw(e.h, [68, 31337, 999999, {}]);
    raw(e.h, [68, 31338, 999999, {}]); // racing that UNREGISTER: answered, not withdrawn again
    raw(e.h, [69, 424242, {}]);
    raw(e.h, registered?.frame as unknown[]); // a duplicate: its id is held
    await e.h.clock.advance(1);
    expect(written(e.c, 1).filter((f) => f[0] === 8)).toEqual([
      [8, 68, 31337, {}, 'wamp.error.no_such_registration'],
      [8, 68, 31338, {}, 'wamp.error.no_such_registration'],
    ]);
    expect(written(e.c, 1).filter((f) => f[0] === 66)).toEqual([[66, expect.any(Number), 999999]]);
    expect(r.values).toHaveLength(1);
    await e.h.finish();
  });

  test('topic: EVENT for an unknown subscription dropped; duplicate SUBSCRIBED ignored', async () => {
    const e = env();
    const r = await opened(e, 'topic');
    const subscribed = e.c.trace().frames.find((f) => f.direction === 'out' && (f.frame as unknown[])[0] === 33);
    raw(e.h, [36, 99999, 1, {}, ['x']]);
    raw(e.h, subscribed?.frame as unknown[]); // a duplicate: its id is held
    await e.h.clock.advance(1);
    expect(r.values).toEqual([]);
    expect(count(e.c, 1, 34)).toBe(0);
    await e.h.finish();
  });

  test('publish (ack): late / duplicate PUBLISHED dropped', async () => {
    const e = env();
    const r = await opened(e, 'publish (ack)');
    const id = written(e.c, 1).find((f) => f[0] === 16)?.[1];
    raw(e.h, [17, id, 1]);
    await e.h.clock.advance(1);
    expect(r.values).toHaveLength(1);
    await e.h.finish();
  });

  test('publish (no ack): — (no reply exists)', async () => {
    const e = env();
    const r = await opened(e, 'publish (no ack)');
    expect(r.values).toHaveLength(1);
    await e.h.finish();
  });

  test('challenge: a newer CHALLENGE replaces the pending one; a method not offered ⇒ ABORT; a late answer is dropped', async () => {
    const answers: ((v: string) => void)[] = [];
    const e = env({
      options: {
        authmethods: ['ticket'],
        onChallenge: () => new Promise<string>((r) => answers.push(r)),
        retryOptions: { maxRetries: 0 },
      },
      setup: (h) => {
        h.router.ignore((f) => f[0] === 1 || f[0] === 5);
      },
    });
    await e.h.clock.advance(1);
    raw(e.h, [4, 'ticket', {}]);
    await e.h.clock.advance(1);
    raw(e.h, [4, 'ticket', {}]);
    await e.h.clock.advance(1);
    answers[0]?.('stale');
    await e.h.clock.advance(1);
    expect(count(e.c, 1, 5)).toBe(0); // the late answer of the replaced round is dropped
    answers[1]?.('fresh');
    await e.h.clock.advance(1);
    expect(written(e.c, 1).filter((f) => f[0] === 5)).toEqual([[5, 'fresh', {}]]);
    raw(e.h, [4, 'cryptosign', {}]);
    await e.h.clock.advance(1);
    expect(closes(e.c).at(-1)).toMatchObject({ reason: 'wamp.error.cannot_authenticate' });
    await e.h.finish();
  });
});

describe('lifecycle streams on every condition', () => {
  test('one onClose + one status{closed} per end, one status{connecting} per attempt, one onOpen per WELCOME; none for a rejected anonymous WELCOME', async () => {
    const e = env({
      options: { authmethods: ['ticket'], onChallenge: () => 's' },
      router: {
        authenticate: (() => {
          let n = 0;
          return () =>
            n++ === 0
              ? { welcome: {} }
              : { challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'j' } }) };
        })(),
      },
    });
    await e.h.clock.advance(5000);
    e.h.router.drop();
    await e.h.clock.advance(5000);
    const st = e.c.status?.values ?? [];
    expect(st.map((s) => s.state)).toEqual([
      'connecting',
      'closed',
      'connecting',
      'open',
      'closed',
      'connecting',
      'open',
    ]);
    expect(closes(e.c)).toHaveLength(2);
    expect(e.c.onOpen?.values).toHaveLength(2);
    for (const r of [e.c.status, e.c.onOpen, e.c.onClose]) expect([r?.errored, r?.completed]).toEqual([false, false]);
    await e.h.finish();
  });
});
