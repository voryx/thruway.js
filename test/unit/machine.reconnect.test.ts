// Reconnecting: after every way an attempt or session can end — socket error, close with any code (clean or not), a
// socket that never opens, connect timeout, no WELCOME, ABORT of any reason, an unsupported CHALLENGE, onChallenge
// throwing/rejecting/erroring/completing empty, a router GOODBYE (reply, then reconnect), protocol violations (ABORT,
// then reconnect), a liveness timeout, a transport that completes (a clean close), an internal exception — the next
// session is established, every interest is re-established exactly once and work that waited is written once. Then
// reconnect() in each state: established (GOODBYE, lingering, in-flight Lost{close_realm}, interests and waiting ops
// kept, onChallenge again), connecting (the attempt abandoned, a fresh one), waiting (counter reset, the 1 s floor),
// and open() while connecting (no-op).
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { Observable } from '../../src/observable/observable.js';
import type { ChallengeMessage, ClientOptions, CloseInfo } from '../../src/types.js';
import { createHarness, type Harness, type HarnessOptions, type SimClient } from '../helpers/harness.js';

interface Scenario {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly topic: ReturnType<SimClient<Client>['observe']>;
  readonly reg: ReturnType<SimClient<Client>['observe']>;
}

/** A client with a topic and a registration, against a router configured by `router`/`setup`. */
function scenario(
  options: ClientOptions = {},
  setup: (h: Harness) => void = () => undefined,
  router: HarnessOptions['router'] = {},
): Scenario {
  const h = createHarness({ seed: 55, router });
  h.router.declareTopic('com.example.t');
  h.router.procedure('com.example.p', () => 'pong');
  setup(h);
  const c = h.makeClient(Client, {
    options: { timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 100 }, ...options },
  });
  const topic = c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
  const reg = c.observe(
    'register',
    'com.example.r',
    c.client.register('com.example.r', () => 'r'),
  );
  return { h, c, topic, reg };
}

function written(c: SimClient<Client>, n: number): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket)
    .map((f) => f.frame as unknown[]);
}
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s) => s.state);

/** After the end: a new session, every interest re-established once on it, a waiting call written once there. */
async function expectRecovered(s: Scenario, kind: string): Promise<void> {
  const { h, c, topic, reg } = s;
  await h.clock.advance(1); // the end is processed (the new session may already be up when it came earlier)
  const waiting = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
  await h.clock.advance(70000);
  expect(states(c).at(-1), kind).toBe('open');
  expect(closes(c).length, kind).toBeGreaterThan(0);
  const last = c.connections.length;
  const frames = written(c, last);
  expect(
    frames.filter((f) => f[0] === 32),
    `${kind}: one SUBSCRIBE on the new session`,
  ).toHaveLength(1);
  expect(
    frames.filter((f) => f[0] === 64),
    `${kind}: one REGISTER on the new session`,
  ).toHaveLength(1);
  expect(topic.closed || reg.closed, `${kind}: the interests never ended`).toBe(false);
  expect(
    waiting.values.map((r) => (r as { args: unknown[] }).args),
    kind,
  ).toEqual([['pong']]);
  h.router.publish('com.example.t', ['after']);
  await h.clock.advance(1);
  expect((topic.values.at(-1) as { args: unknown[] }).args).toEqual(['after']);
  await h.finish();
}

const raw = (h: Harness, frame: unknown[]): void => {
  h.router.sendRaw(JSON.stringify(frame));
};
const first = (conn: { number: number }): boolean => conn.number === 1;

describe('every end kind reconnects and re-establishes every interest', () => {
  test.each([
    [
      'a socket error (error, then close 1006)',
      (s: Scenario) => {
        s.c.connection.controls.drop();
      },
    ],
    [
      'a clean close 1000 (a transport that completes)',
      (s: Scenario) => {
        s.c.connection.controls.close(1000, '');
      },
    ],
    [
      'close 1001 going away',
      (s: Scenario) => {
        s.c.connection.controls.close(1001, 'restart');
      },
    ],
    [
      'close 1011 router error',
      (s: Scenario) => {
        s.c.connection.controls.close(1011, '');
      },
    ],
    [
      'close 4999 (an app code)',
      (s: Scenario) => {
        s.c.connection.controls.close(4999, 'x');
      },
    ],
    [
      'an unclean drop with code 1000',
      (s: Scenario) => {
        s.c.connection.controls.drop(1000, false);
      },
    ],
    [
      'a router GOODBYE (reply, then reconnect)',
      (s: Scenario) => {
        s.h.router.goodbye('wamp.close.system_shutdown');
      },
    ],
    [
      'a router ABORT in the session',
      (s: Scenario) => {
        s.h.router.abort('wamp.close.killed');
      },
    ],
    [
      'a protocol violation (ABORT, then reconnect)',
      (s: Scenario) => {
        raw(s.h, [17, 'x', 1]);
      },
    ],
    [
      'an undecodable frame',
      (s: Scenario) => {
        s.h.router.sendRaw('not json');
      },
    ],
    [
      'the router closes every socket and comes back',
      (s: Scenario) => {
        s.h.router.drop(1006);
      },
    ],
  ])('in a session: %s', async (kind, end) => {
    const s = scenario();
    await s.h.clock.advance(5);
    end(s);
    await expectRecovered(s, kind);
  });

  test('a liveness timeout (a half-open socket)', async () => {
    const s = scenario({ timeouts: { idle: 1000 } }, (h) => {
      h.router.ignore((f, conn) => first(conn) && f[3] === 'thruway.js.ping');
    });
    await s.h.clock.advance(30000);
    expect(closes(s.c)[0]?.error).toMatchObject({ timer: 'liveness' });
    await expectRecovered(s, 'liveness');
  });

  test.each([
    ['refused', 'refuse'],
    ['an error without close (Node 22 undici: DNS, TLS, refused)', 'error-only'],
    ['a WebSocket constructor that throws', 'throw'],
    ['never opens: the connect timeout', 'hang'],
  ] as const)('a socket that never opens: %s', async (kind, mode) => {
    const s = scenario({ timeouts: { idle: 0, connect: 1000 } }, (h) => {
      h.router.setAvailable(mode);
    });
    await s.h.clock.advance(1200);
    s.h.router.setAvailable('ok');
    await expectRecovered(s, kind);
  });

  test('no WELCOME in time (handshake timeout)', async () => {
    const s = scenario({ timeouts: { idle: 0, handshake: 1000 } }, (h) => {
      h.router.ignore((f, conn) => first(conn) && f[0] === 1);
    });
    await s.h.clock.advance(1100);
    expect(closes(s.c)[0]?.error).toMatchObject({ timer: 'handshake' });
    await expectRecovered(s, 'handshake timeout');
  });

  test.each(['wamp.error.no_such_realm', 'thruway.error.authentication_failure', 'wamp.error.not_authorized', 'x.y'])(
    'a handshake ABORT (%s)',
    async (reason) => {
      let n = 0;
      const s = scenario({}, undefined, {
        authenticate: () => (n++ === 0 ? { abort: reason } : { welcome: { authid: 'a', authmethod: 'anonymous' } }),
      });
      await expectRecovered(s, reason);
      expect(closes(s.c)[0]).toMatchObject({ initiator: 'router', reason });
    },
  );

  const challenged = (decide: (n: number) => 'challenge-unsupported' | 'challenge' | 'welcome') => {
    let n = 0;
    const welcome = { welcome: { authid: 'joe', authmethod: 'ticket' } };
    return {
      authenticate: () => {
        const d = decide(n++);
        if (d === 'welcome') return welcome;
        return {
          challenge: { method: d === 'challenge' ? 'ticket' : 'cryptosign' },
          verify: () => welcome,
        };
      },
    };
  };

  test('a CHALLENGE for an unsupported method', async () => {
    const s = scenario(
      { authmethods: ['ticket'], onChallenge: () => 't' },
      undefined,
      challenged((n) => (n === 0 ? 'challenge-unsupported' : 'challenge')),
    );
    await expectRecovered(s, 'unsupported CHALLENGE');
    expect(closes(s.c)[0]?.error).toMatchObject({ code: 'authentication', authMethod: 'cryptosign' });
  });

  test.each([
    [
      'throws',
      () => {
        throw new Error('x');
      },
    ],
    ['rejects', () => Promise.reject(new Error('x'))],
    [
      'errors',
      () =>
        new Observable<string>((sub) => {
          sub.error(new Error('x'));
        }),
    ],
    [
      'completes without a value',
      () =>
        new Observable<string>((sub) => {
          sub.complete();
        }),
    ],
  ])('onChallenge %s', async (kind, failing) => {
    let n = 0;
    const s = scenario(
      { authmethods: ['ticket'], onChallenge: () => (n++ === 0 ? failing() : 'ok') },
      undefined,
      challenged(() => 'challenge'),
    );
    await expectRecovered(s, kind);
    expect(closes(s.c)[0]).toMatchObject({ reason: 'wamp.error.cannot_authenticate' });
  });

  test('an unrequested anonymous WELCOME', async () => {
    let n = 0;
    const s = scenario({ authmethods: ['ticket'], onChallenge: () => 't' }, undefined, {
      authenticate: () =>
        n++ === 0
          ? { welcome: {} }
          : { challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) },
    });
    await expectRecovered(s, 'anonymous WELCOME');
    expect(closes(s.c)[0]?.error).toMatchObject({ code: 'authentication' });
  });

  test('an internal exception (a participant throws: hardReset)', async () => {
    const s = scenario();
    await s.h.clock.advance(5);
    (s.c.faults as { inject(target: string): void }).inject('topic.inbound');
    s.h.router.publish('com.example.t', ['boom']);
    await s.h.clock.advance(1);
    expect(closes(s.c).at(-1)?.error).toMatchObject({ code: 'protocol', message: 'internal error' });
    const internal = s.c.trace().logs.filter((l) => l.entry.event === 'internal');
    expect(internal).toHaveLength(1);
    // the run logged an internal error on purpose: check the recovery, then settle without the internal-log check
    const waiting = s.c.observe('call', 'com.example.p', s.c.client.call('com.example.p'));
    await s.h.clock.advance(70000);
    expect(states(s.c).at(-1)).toBe('open');
    expect(written(s.c, 2).filter((f) => f[0] === 32)).toHaveLength(1);
    expect(written(s.c, 2).filter((f) => f[0] === 64)).toHaveLength(1);
    expect(waiting.values).toHaveLength(1);
    await s.h.closeAndSettle();
    expect(s.h.problems().filter((p) => !p.includes('internal error logged'))).toEqual([]);
  });
});

describe('reconnect()', () => {
  test('established: GOODBYE close_realm, lingering, in-flight Lost{close_realm}; interests and waiting ops kept', async () => {
    const s = scenario({ autoOpen: true });
    s.h.router.procedure('com.example.slow', () => new Promise(() => undefined));
    const inflight = s.c.observe('call', 's', s.c.client.call('com.example.slow'));
    await s.h.clock.advance(1500);
    s.c.reconnect();
    expect(written(s.c, 1).at(-1)).toEqual([6, {}, 'wamp.close.close_realm']);
    expect(closes(s.c).at(-1)).toMatchObject({
      initiator: 'app',
      reason: 'wamp.close.close_realm',
      error: undefined,
      willRetry: true,
      attempt: 0,
      sessionId: 1,
    });
    expect(inflight.error).toMatchObject({ code: 'connection_lost', reason: 'wamp.close.close_realm' });
    expect(states(s.c).slice(-2)).toEqual(['closed', 'connecting']); // ≥ 1 s since the last start: at once
    await expectRecovered(s, 'reconnect()');
  });

  test.each(['established', 'connecting'] as const)(
    'the retry counter is reset by reconnect() %s: attempt 1 again, the first backoff step again',
    async (when) => {
      const delays: number[] = [];
      const s = scenario({ retryOptions: { retryDelay: (n) => (delays.push(n), 100) } }, (h) => {
        h.router.setAvailable('refuse');
      });
      await s.h.clock.advance(250); // three refused attempts, 100 ms apart: the counter is at 3
      expect(closes(s.c).map((i) => i.attempt)).toEqual([1, 2, 3]);
      if (when === 'connecting') s.h.router.setAvailable('hang');
      else s.h.router.setAvailable('ok');
      await s.h.clock.advance(100); // attempt 4 starts: open (session < 60 s: no stable reset) or hanging
      expect(s.c.status?.values.at(-1)).toMatchObject(
        when === 'established' ? { state: 'open' } : { state: 'connecting', attempt: 4 },
      );
      s.h.router.setAvailable('refuse');
      s.c.reconnect();
      await s.h.clock.advance(1000);
      const connecting = (s.c.status?.values ?? []).filter((st) => st.state === 'connecting');
      expect(connecting.at(-1)).toEqual({ state: 'connecting', attempt: 1 });
      expect(closes(s.c).at(-1)).toMatchObject({ attempt: 1, willRetry: true }); // that attempt was refused: failure 1
      expect(delays.at(-1)).toBe(1);
      s.h.router.setAvailable('ok');
      await s.h.finish();
    },
  );

  test('established, within 1 s of the attempt start: the new attempt waits for the floor', async () => {
    const s = scenario();
    await s.h.clock.advance(300);
    s.c.reconnect();
    expect(closes(s.c).at(-1)?.delay).toBe(700);
    await s.h.clock.advance(699);
    expect(s.c.connections).toHaveLength(1);
    await s.h.clock.advance(1);
    expect(s.c.connections).toHaveLength(2);
    await s.h.finish();
  });

  test('re-authenticates: the new handshake calls onChallenge again (recipe 11)', async () => {
    const onChallenge = vi.fn((c: ChallengeMessage) => `token-${String(c.extra['n'])}`);
    let n = 0;
    const s = scenario({ authmethods: ['ticket'], onChallenge }, undefined, {
      authenticate: () => ({
        challenge: { method: 'ticket', extra: { n: ++n } },
        verify: (sig: string) => ({ welcome: { authid: sig, authmethod: 'ticket' } }),
      }),
    });
    await s.h.clock.advance(1500);
    expect(s.c.client.session?.details.authid).toBe('token-1');
    s.c.reconnect();
    await s.h.clock.advance(10);
    expect(onChallenge).toHaveBeenCalledTimes(2);
    expect(s.c.client.session?.details.authid).toBe('token-2');
    await s.h.finish();
  });

  test.each([
    ['resolving', 'resolving'],
    ['connecting', 'hang'],
    ['hello sent', 'silent'],
    ['challenged', 'challenge'],
  ] as const)(
    'while %s: the attempt is abandoned (CanceledError for a pending handler) and a fresh one starts',
    async (_n, how) => {
      let signal: AbortSignal | undefined;
      let resolves = 0;
      const h = createHarness({
        seed: 56,
        router:
          how === 'challenge'
            ? {
                authenticate: () => ({
                  challenge: { method: 'ticket' },
                  verify: () => ({ welcome: { authid: 'joe' } }),
                }),
              }
            : {},
      });
      if (how === 'hang') h.router.setAvailable('hang');
      if (how === 'silent') h.router.ignore((f, conn) => first(conn) && f[0] === 1);
      const c = h.makeClient(Client, {
        url:
          how === 'resolving'
            ? () => (++resolves === 1 ? new Promise<string>(() => undefined) : h.router.url)
            : h.router.url,
        options: {
          timeouts: { idle: 0 },
          ...(how === 'challenge'
            ? {
                authmethods: ['ticket'],
                onChallenge: (ch: ChallengeMessage) => {
                  if (signal === undefined) {
                    signal = ch.signal as AbortSignal;
                    return new Promise<string>(() => undefined);
                  }
                  return 'second';
                },
              }
            : {}),
        },
      });
      await h.clock.advance(1500);
      expect(states(c).at(-1)).toBe('connecting');
      const before = { states: states(c).length, sockets: c.connections.length };
      c.open(); // while connecting: a no-op
      await h.clock.advance(1);
      expect(closes(c)).toHaveLength(0);
      expect({ states: states(c).length, sockets: c.connections.length }).toEqual(before); // no new attempt
      if (how === 'hang') h.router.setAvailable('ok');
      c.reconnect();
      expect(closes(c).at(-1)).toMatchObject({ initiator: 'app', reason: undefined, willRetry: true, attempt: 0 });
      // release(1000) without a frame (nothing but HELLO/AUTHENTICATE/ABORT may precede WELCOME); resolving had
      // no socket: the one that exists now is the fresh attempt's (the floor has passed, it started at once)
      expect(c.connections[0]!.controls.closeCalls).toEqual(
        how === 'resolving' ? [] : [{ code: 1000, reason: 'normal closure' }],
      );
      await h.clock.advance(10);
      expect(states(c).at(-1)).toBe('open');
      if (how === 'challenge') expect(signal?.reason).toMatchObject({ code: 'canceled' });
      if (how === 'resolving') expect(resolves).toBe(2);
      await h.finish();
    },
  );

  test('while waiting: the counter is reset and the next attempt starts at once (≥ 1 s after the last)', async () => {
    const s = scenario({ retryOptions: { retryDelay: () => 50000 } }, (h) => {
      h.router.setAvailable('refuse');
    });
    await s.h.clock.advance(3000);
    expect(closes(s.c).at(-1)?.attempt).toBe(1);
    s.h.router.setAvailable('ok');
    s.c.reconnect();
    await s.h.clock.advance(1);
    expect(s.c.status?.values.slice(-2)).toEqual([
      { state: 'connecting', attempt: 1 },
      expect.objectContaining({ state: 'open' }),
    ]);
    await s.h.finish();
  });

  test('WAITING + timer.retry ⇒ the next attempt, with the attempt number of the consecutive failures', async () => {
    const s = scenario({}, (h) => {
      h.router.setAvailable('refuse');
    });
    await s.h.clock.advance(250);
    expect(
      s.c.status?.values.filter((v) => v.state === 'connecting').map((v) => (v as { attempt: number }).attempt),
    ).toEqual([1, 2, 3]);
    s.h.router.setAvailable('ok');
    await expectRecovered(s, 'retry');
  });
});
