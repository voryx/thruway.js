// The handshake transitions of the core, each driven through the real client against the sim router: CLOSED → attempt,
// url resolution, connect timeout, ws.open and the subprotocol check, HELLO, CHALLENGE rounds (no handler / method not
// offered / 8 rounds ⇒ ABORT cannot_authenticate), the 50 ms settle window (two CHALLENGEs 0/10/49 ms apart ⇒ one run,
// for the latest; a CHALLENGE after an AUTHENTICATE for another method ⇒ challenge.mismatch + a new round; one offered
// method ⇒ no window), latest-wins, challenge.ok/fail, ABORT and GOODBYE before WELCOME, header-fatal frames, the
// handshake timer (paused while the app answers), and the anonymous-WELCOME rule with each of its criteria and
// exemptions (Thruway PHP's echo).
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { isThruwayError } from '../../src/errors.js';
import { Observable } from '../../src/observable/observable.js';
import { AGENT, HELLO_ROLES } from '../../src/protocol/hello.js';
import type { ChallengeMessage, ClientOptions, CloseInfo } from '../../src/types.js';
import { useHarness, type Harness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 21 });

function start(options: ClientOptions = {}, setup?: (harness: Harness) => void): SimClient<Client> {
  setup?.(h.current);
  return h.current.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
}

/** Frames the client wrote on its `n`-th connection (1-based). */
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

/** The router stays silent on HELLO (and AUTHENTICATE): the test scripts the handshake with raw frames. */
function scripted(harness: Harness): void {
  harness.router.ignore((f) => f[0] === 1 || f[0] === 5);
}
const raw = (frame: unknown[]): void => {
  h.current.router.sendRaw(JSON.stringify(frame));
};
const WELCOME_AUTH = { authid: 'joe', authrole: 'user', authmethod: 'ticket', roles: { dealer: {}, broker: {} } };

describe('CLOSED + open: an attempt starts', () => {
  test('autoOpen: connecting at once (attempt 1), HELLO with the exact details, then open', async () => {
    const c = start({ authid: 'joe', authmethods: ['ticket'], authextra: { k: 1 }, onChallenge: () => 'x' }, (x) => {
      x.router.ignore(() => false);
    });
    expect(c.status?.values[0]).toEqual({ state: 'connecting', attempt: 1 });
    await h.current.clock.advance(1);
    const [hello] = written(c);
    expect(hello?.slice(0, 2)).toEqual([1, 'realm1']);
    expect(c.connection.protocols).toEqual(['wamp.2.json']); // exactly the serializer's subprotocol
    expect(Object.keys(hello?.[2] as object).sort()).toEqual(['agent', 'authextra', 'authid', 'authmethods', 'roles']);
    expect(hello?.[2]).toMatchObject({ authid: 'joe', authmethods: ['ticket'], authextra: { k: 1 } });
  });

  test.each([
    ['no auth options', {}],
    [
      'an explicit empty authmethods and options that are not HELLO keys (v2 sent them)',
      { authmethods: [], requestIds: 'sequential', autoOpen: true, retryOptions: { maxRetries: 3 } },
    ],
  ] as const)(
    'an anonymous client (%s): HELLO is exactly [1, realm, {agent, roles}], its first and only HELLO',
    async (_n, options) => {
      const c = start(options);
      await h.current.clock.advance(1);
      expect(written(c)[0]).toEqual([1, 'realm1', { agent: AGENT, roles: HELLO_ROLES }]);
      expect(types(c).filter((t) => t === 1)).toHaveLength(1);
      // every role, with only the features implemented end to end
      expect(Object.keys(HELLO_ROLES).sort()).toEqual(['callee', 'caller', 'publisher', 'subscriber']);
      expect(c.client.session).toBeDefined();
    },
  );

  test('autoOpen false: closed{undefined} until open(); open() starts it', async () => {
    const c = start({ autoOpen: false });
    await h.current.clock.advance(100);
    expect(c.status?.values).toEqual([{ state: 'closed', closed: undefined }]);
    expect(c.connections).toHaveLength(0);
    c.open();
    await h.current.clock.advance(1);
    expect(states(c)).toEqual(['closed', 'connecting', 'open']);
  });
});

describe('RESOLVING: the url resolver runs once per attempt, in a delivery', () => {
  test('a Promise, an Observable or a plain value; each attempt calls it again', async () => {
    const values: unknown[] = [];
    let n = 0;
    const url = (): unknown => {
      n++;
      const u = h.current.router.url;
      return n === 1
        ? Promise.resolve(u)
        : n === 2
          ? new Observable((s) => {
              s.next(u);
            })
          : u;
    };
    const c = h.current.makeClient(Client, { url: url as () => string, options: { timeouts: { idle: 0 } } });
    values.push(...states(c));
    await h.current.clock.advance(1);
    expect(states(c)).toEqual(['connecting', 'open']);
    h.current.router.drop();
    await h.current.clock.advance(5000);
    h.current.router.drop();
    await h.current.clock.advance(5000);
    expect(n).toBe(3);
    expect(states(c).filter((s) => s === 'open')).toHaveLength(3);
  });

  test.each([
    [
      'throws',
      () => {
        throw new Error('no config');
      },
    ],
    ['rejects', () => Promise.reject(new Error('storage down'))],
    [
      'errors',
      () =>
        new Observable((s) => {
          s.error(new Error('nope'));
        }),
    ],
    [
      'completes empty',
      () =>
        new Observable((s) => {
          s.complete();
        }),
    ],
    ['answers a non-string', () => 42],
    ['answers an empty string', () => ''],
  ])('url() that %s ⇒ ConnectionLostError(url resolution failed), backoff, retried', async (_name, resolver) => {
    const c = h.current.makeClient(Client, {
      url: resolver as () => string,
      options: { timeouts: { idle: 0 }, retryOptions: { maxRetries: 1 }, autoOpen: false },
    });
    c.open(); // a synchronous failure inside the constructor would end the attempt before anyone subscribed
    await h.current.clock.runUntilIdle();
    expect(closes(c)).toHaveLength(2);
    const info = closes(c)[0]!;
    expect(info).toMatchObject({ initiator: 'connection', willRetry: true, attempt: 1, closeCode: undefined });
    expect(isThruwayError(info.error) && info.error.code).toBe('connection_lost');
    expect(info.error?.message).toBe('url resolution failed');
    expect((info.error as { cause?: unknown }).cause).toBeDefined();
    expect(c.connections).toHaveLength(0); // no socket was ever created
  });

  test('a resolver that never answers is bounded by the connect timer; its pending value is cancelled', async () => {
    const teardown = vi.fn();
    const c = h.current.makeClient(Client, {
      url: () => new Observable<string>(() => teardown),
      options: { timeouts: { idle: 0, connect: 500 }, retryOptions: { maxRetries: 0 } },
    });
    await h.current.clock.advance(500);
    expect(lastClose(c)).toMatchObject({ willRetry: false, closeCode: undefined });
    expect(lastClose(c).error).toMatchObject({ code: 'timeout', timer: 'connect', timeout: 500 });
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("a resolver whose teardown throws when it is cancelled is reported to the client's logger, not console.error", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const c = h.current.makeClient(Client, {
        // an app Observable (any subscribe-object) that never answers and whose unsubscribe throws
        url: () => ({
          subscribe: () => ({
            unsubscribe: () => {
              throw new Error('teardown bug');
            },
          }),
        }),
        options: { timeouts: { idle: 0, connect: 500 }, retryOptions: { maxRetries: 0 } },
      });
      await h.current.clock.advance(500);
      expect(lastClose(c).error).toMatchObject({ timer: 'connect' });
      const unhandled = logs(c, 'unhandled');
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]!.entry.level).toBe('error');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test('an attempt that ended before its resolver delivery ran never calls url()', async () => {
    const url = vi.fn(() => h.current.router.url);
    const c = h.current.makeClient(Client, { url, options: { timeouts: { idle: 0 }, autoOpen: false } });
    c.client.status.subscribe((s) => {
      if (s.state === 'connecting') void c.client.close(); // queued before the resolver's delivery
    });
    c.open();
    await h.current.clock.advance(10);
    expect(url).not.toHaveBeenCalled();
  });
});

/** A WebSocket class of the router whose sockets report `protocol` as given. */
function reporting(protocol: string): NonNullable<ClientOptions['WebSocket']> {
  const Wrapped = function (url: string, protocols?: string | string[]) {
    const ws = new (h.current.router.webSocketFor(1))(url, protocols);
    return new Proxy(ws, {
      get(target, prop) {
        if (prop === 'protocol') return protocol;
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
}

describe('CONNECTING', () => {
  test('timer.connect ⇒ close 4001, TimeoutError{connect}, retried', async () => {
    const c = start({ timeouts: { idle: 0, connect: 300 }, retryOptions: { maxRetries: 0 } }, (x) => {
      x.router.setAvailable('hang');
    });
    await h.current.clock.advance(300);
    expect(lastClose(c)).toMatchObject({ initiator: 'connection', closeCode: 4001, wasClean: false, attempt: 1 });
    expect(lastClose(c).error).toMatchObject({ name: 'TimeoutError', timer: 'connect', timeout: 300, attempt: 1 });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 4001, reason: 'client timeout' }]);
  });

  test('ws.open with a subprotocol that was not offered ⇒ close 4000, ProtocolError', async () => {
    const c = start({ WebSocket: reporting('wamp.2.msgpack'), retryOptions: { maxRetries: 0 } });
    await h.current.clock.advance(1);
    expect(types(c)).toEqual([]);
    expect(lastClose(c)).toMatchObject({ closeCode: 4000, wasClean: false });
    expect(lastClose(c).error).toMatchObject({ code: 'protocol' });
    expect(lastClose(c).error?.message).toMatch(/wamp\.2\.msgpack/);
    expect(c.connection.controls.closeCalls).toEqual([{ code: 4000, reason: 'protocol violation' }]);
  });

  test("ws.open with protocol '' (a custom transport that does not echo it) is accepted", async () => {
    const c = start({ WebSocket: reporting('') });
    await h.current.clock.advance(1);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('a WebSocket constructor that throws ⇒ ConnectionLostError{cause}, retried', async () => {
    const error = new SyntaxError('bad url');
    const Throwing = function () {
      throw error;
    } as unknown as ClientOptions['WebSocket'];
    const c = start({ WebSocket: Throwing, retryOptions: { maxRetries: 1 }, autoOpen: false });
    c.open();
    await h.current.clock.runUntilIdle();
    expect(closes(c).map((i) => i.willRetry)).toEqual([true, false]);
    expect((closes(c)[0]!.error as { cause?: unknown }).cause).toBe(error);
  });

  test('ws.closed while connecting (refused, error-only) ⇒ ConnectionLostError{closeCode 1006}', async () => {
    const c = start({ retryOptions: { maxRetries: 1 } }, (x) => {
      x.router.setAvailable('error-only');
    });
    await h.current.clock.runUntilIdle();
    expect(closes(c)).toHaveLength(2);
    expect(closes(c)[0]).toMatchObject({ initiator: 'connection', closeCode: 1006, wasClean: false });
    expect(closes(c)[0]!.error).toMatchObject({ code: 'connection_lost', closeCode: 1006 });
    expect(closes(c)[0]!.error?.message).toMatch(/^socket closed \(1006\)/);
    // the platform's error (the `error` event's `error`) is kept as the cause
    const cause = (closes(c)[0]!.error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(closes(c)[0]!.error?.message).toBe(`socket closed (1006): ${(cause as Error).message}`);
  });
});

describe('HELLO_SENT', () => {
  test('timer.handshake ⇒ close 4001, TimeoutError{handshake}', async () => {
    const c = start({ timeouts: { idle: 0, handshake: 700 }, retryOptions: { maxRetries: 0 } }, scripted);
    await h.current.clock.advance(700);
    expect(lastClose(c)).toMatchObject({ closeCode: 4001, attempt: 1 });
    expect(lastClose(c).error).toMatchObject({ timer: 'handshake', timeout: 700 });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 4001, reason: 'client timeout' }]);
  });

  test('the default deadlines: connect 10 s, handshake 15 s', async () => {
    const c = start({ retryOptions: { maxRetries: 1, retryDelay: () => 100 } }, (x) => {
      x.router.setAvailable('hang');
    });
    await h.current.clock.advance(9999);
    expect(closes(c)).toHaveLength(0);
    await h.current.clock.advance(1);
    expect(lastClose(c).error).toMatchObject({ timer: 'connect', timeout: 10000 });
    h.current.router.setAvailable('ok');
    h.current.router.ignore((f) => f[0] === 1);
    await h.current.clock.advance(100); // the retry: the socket opens, HELLO is never answered
    await h.current.clock.advance(14999);
    expect(closes(c)).toHaveLength(1);
    await h.current.clock.advance(1);
    expect(lastClose(c).error).toMatchObject({ timer: 'handshake', timeout: 15000 });
  });

  // The router answers HELLO with ABORT (scripted: the sim router never welcomes): every reason the tested routers
  // send, wamp-server's swapped fields and a reason-less ABORT (normalised on decode). Nothing is written in reply.
  test.each([
    [
      'an application-defined reason with details.message',
      [3, { message: 'Expired token' }, 'com.example.login.failure'],
      'com.example.login.failure',
      'Expired token',
    ],
    ['no such realm', [3, {}, 'wamp.error.no_such_realm'], 'wamp.error.no_such_realm', 'wamp.error.no_such_realm'],
    [
      'Thruway PHP: a bad ticket',
      [3, {}, 'thruway.error.authentication_failure'],
      'thruway.error.authentication_failure',
      'thruway.error.authentication_failure',
    ],
    [
      'Crossbar: not_authorized, text in details',
      [3, { message: 'no principal' }, 'wamp.error.not_authorized'],
      'wamp.error.not_authorized',
      'no principal',
    ],
    [
      'Thruway PHP: a stale provider',
      [3, {}, 'thruway.error.unknown'],
      'thruway.error.unknown',
      'thruway.error.unknown',
    ],
    [
      'Thruway PHP: the manager registered late',
      [3, {}, 'thruway.authenticator.not_ready'],
      'thruway.authenticator.not_ready',
      'thruway.authenticator.not_ready',
    ],
    [
      'wamp-server: reason and details swapped',
      [3, 'wamp.error.no_such_realm', { message: 'no realm' }],
      'wamp.error.no_such_realm',
      'no realm',
    ],
    ['without a reason string', [3, { message: 'x' }], 'wamp.error.unknown', 'x'],
  ])(
    'ABORT before WELCOME (%s) ⇒ release 1000, AbortError{reason, details}, initiator router, backoff',
    async (_n, frame, reason, message) => {
      const c = start({ retryOptions: { maxRetries: 1, retryDelay: () => 100 } }, scripted);
      await h.current.clock.advance(1);
      raw(frame);
      await h.current.clock.advance(1);
      const details = (frame as unknown[]).find((x) => typeof x === 'object')!;
      expect(closes(c)).toHaveLength(1);
      expect(closes(c)[0]).toMatchObject({
        initiator: 'router',
        reason,
        details,
        closeCode: 1000,
        wasClean: true,
        sessionId: undefined, // no session existed
        willRetry: true,
        attempt: 1,
      });
      expect(closes(c)[0]!.error).toMatchObject({ name: 'AbortError', code: 'abort', reason, details, attempt: 1 });
      expect((closes(c)[0]!.error as { sessionId?: number }).sessionId).toBeUndefined();
      expect(closes(c)[0]!.error?.message).toBe(message); // details.message ?? reason
      expect(types(c)).toEqual([1]); // HELLO only: an ABORT is never answered
      expect(c.connections[0]!.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]); // the client closes it (Crossbar keeps it open)
      expect(states(c)).toEqual(['connecting', 'closed']);
      await h.current.clock.advance(100);
      expect(c.connections).toHaveLength(2); // reconnect with backoff
    },
  );

  test.each([
    ['ABORT', [3, { message: 'bad ticket' }, 'thruway.error.authentication_failure'], 'abort'],
    ['GOODBYE (no reply)', [6, {}, 'wamp.close.system_shutdown'], 'abort'],
    ['a header-fatal frame', [17, 'x', 1], 'protocol'],
  ])(
    '%s while onChallenge is pending: its signal is aborted with ConnectionLostError{cause}',
    async (_n, frame, cause) => {
      let signal: AbortSignal | undefined;
      const c = start(
        {
          authmethods: ['ticket'],
          onChallenge: (ch: ChallengeMessage) => {
            signal ??= ch.signal as AbortSignal;
            return new Promise<string>(() => undefined);
          },
          retryOptions: { retryDelay: () => 100 },
        },
        scripted,
      );
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(1);
      expect(signal?.aborted).toBe(false);
      raw(frame);
      await h.current.clock.advance(1);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject({ code: 'connection_lost' }); // the client retries (recipe 17)
      expect((signal?.reason as { cause?: unknown }).cause).toBe(lastClose(c).error);
      expect(lastClose(c).error).toMatchObject({ code: cause });
      expect(types(c)).toEqual(cause === 'protocol' ? [1, 3] : [1]); // only the client's own ABORT for a violation
      expect(c.connections[0]!.controls.closeCalls).toHaveLength(1);
    },
  );

  test('GOODBYE before WELCOME is an ABORT: no reply', async () => {
    const c = start({ retryOptions: { maxRetries: 0 } }, scripted);
    await h.current.clock.advance(1);
    raw([6, {}, 'wamp.close.system_shutdown']);
    await h.current.clock.advance(1);
    expect(types(c)).toEqual([1]); // HELLO only: no GOODBYE reply
    expect(lastClose(c)).toMatchObject({ initiator: 'router', reason: 'wamp.close.system_shutdown' });
    expect(lastClose(c).error).toMatchObject({ code: 'abort' });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
  });

  test('any other message before WELCOME is dropped (debug); the handshake continues', async () => {
    const c = start({}, scripted);
    await h.current.clock.advance(1);
    for (const frame of [
      [50, 1, {}],
      [8, 48, 1, {}, 'wamp.error.x'],
      [36, 1, 2, {}],
      [68, 1, 2, {}],
      [69, 1, {}],
      [17, 1, 2],
      [33, 1, 2],
      [35, 1],
      [65, 1, 2],
      [67, 1],
      [99],
      [48, 1, {}, 'a'],
    ]) {
      raw(frame);
    }
    await h.current.clock.advance(1);
    expect(states(c)).toEqual(['connecting']);
    raw([2, 7, WELCOME_AUTH]);
    await h.current.clock.advance(1);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test.each([
    ['invalid JSON', '[1,'],
    ['not an array', '{"a":1}'],
    ['an empty array', '[]'],
    ['a non-integer type', '["2"]'],
    ['a WELCOME without a session id', '[2,"x",{}]'],
    ['a CHALLENGE without a method', '[4,7,{}]'],
  ])('a header-fatal frame (%s) ⇒ ABORT protocol_violation, close 4000, ProtocolError', async (_name, text) => {
    const c = start({ retryOptions: { maxRetries: 0 } }, scripted);
    await h.current.clock.advance(1);
    h.current.router.sendRaw(text);
    await h.current.clock.advance(1);
    const abort = written(c).at(-1);
    expect(abort?.[0]).toBe(3);
    expect(abort?.[2]).toBe('wamp.error.protocol_violation');
    expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.protocol_violation', closeCode: 4000 });
    expect(lastClose(c).error).toMatchObject({ code: 'protocol' });
    // the ABORT tells the router what was wrong: {message} = the ProtocolError's message
    expect(abort?.[1]).toEqual({ message: lastClose(c).error?.message });
    expect(lastClose(c).error?.message.length).toBeGreaterThan(0);
    expect(lastClose(c).error).toMatchObject({ frame: text }); // the offending frame, as received (≤ 256 chars)
    expect(logs(c, 'protocol.violation')).toHaveLength(1);
  });
});

describe('CHALLENGE', () => {
  const ticket = (extra: Partial<ClientOptions> = {}): ClientOptions => ({
    authmethods: ['ticket'],
    onChallenge: () => 'secret',
    ...extra,
  });

  test('one method offered: no settle window; AUTHENTICATE with the answer; handshake timer re-armed; WELCOME', async () => {
    const onChallenge = vi.fn((c: ChallengeMessage) => `${c.authMethod}:${String(c.extra['n'])}`);
    const c = start(ticket({ onChallenge }), scripted);
    await h.current.clock.advance(1);
    raw([4, 'ticket', { n: 1 }]);
    await h.current.clock.advance(0);
    expect(onChallenge).toHaveBeenCalledTimes(1); // no window with one method
    expect(written(c).at(-1)).toEqual([5, 'ticket:1', {}]);
    raw([2, 9, WELCOME_AUTH]);
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(9);
  });

  test('the handshake timer does not run while onChallenge is pending (a login dialog)', async () => {
    let answer: (v: string) => void = () => undefined;
    const c = start(
      ticket({ onChallenge: () => new Promise<string>((r) => (answer = r)), timeouts: { idle: 0, handshake: 1000 } }),
      scripted,
    );
    await h.current.clock.advance(500);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(600000); // ten minutes in the dialog
    expect(states(c)).toEqual(['connecting']);
    answer('typed');
    await h.current.clock.advance(999);
    expect(written(c).at(-1)).toEqual([5, 'typed', {}]);
    expect(states(c)).toEqual(['connecting']);
    await h.current.clock.advance(1); // the handshake timer runs again after AUTHENTICATE
    expect(lastClose(c).error).toMatchObject({ timer: 'handshake' });
  });

  const answerX = (): string => 'x';
  test.each([
    ['no onChallenge', { authmethods: ['ticket'] }, 'ticket', /no onChallenge/],
    ['a method that was not offered', { authmethods: ['ticket'], onChallenge: answerX }, 'wampcra', /not offered/],
    ['no authmethods at all', { onChallenge: answerX }, 'ticket', /not offered/],
  ])('%s ⇒ ABORT cannot_authenticate, AuthenticationError{authMethod}, backoff', async (_n, options, method, why) => {
    const c = start({ ...(options as ClientOptions), retryOptions: { maxRetries: 0 } }, scripted);
    await h.current.clock.advance(1);
    raw([4, method, {}]);
    await h.current.clock.advance(1);
    const abort = written(c).at(-1)!;
    expect(abort[0]).toBe(3);
    expect(abort[2]).toBe('wamp.error.cannot_authenticate');
    expect((abort[1] as { message: string }).message).toMatch(why);
    expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.cannot_authenticate', initiator: 'connection' });
    expect(lastClose(c).error).toMatchObject({ code: 'authentication', authMethod: method, attempt: 1 });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
  });

  test('more than 8 rounds ⇒ ABORT cannot_authenticate (INV-AUTH)', async () => {
    const onChallenge = vi.fn(() => 'answer');
    const c = start(ticket({ onChallenge, retryOptions: { maxRetries: 0 } }), scripted);
    await h.current.clock.advance(1);
    for (let i = 0; i < 9; i++) {
      raw([4, 'ticket', { round: i + 1 }]);
      await h.current.clock.advance(1);
    }
    expect(onChallenge).toHaveBeenCalledTimes(8);
    expect(written(c).filter((f) => f[0] === 5)).toHaveLength(8);
    expect(lastClose(c).error?.message).toMatch(/more than 8 CHALLENGE rounds/);
  });

  test('onChallenge throws / rejects / errors / completes empty / answers a non-string ⇒ ABORT, AuthenticationError{cause}', async () => {
    const failures = [
      () => {
        throw new Error('dialog crashed');
      },
      () => Promise.reject(new Error('cancelled by user')),
      () =>
        new Observable<string>((s) => {
          s.error(new Error('token service'));
        }),
      () =>
        new Observable<string>((s) => {
          s.complete();
        }),
      () => 42 as unknown as string,
    ];
    let k = 0;
    const c = start(
      {
        authmethods: ['ticket'],
        onChallenge: () => failures[k++]!(),
        retryOptions: { maxRetries: 4, retryDelay: () => 100 },
      },
      scripted,
    );
    for (const failure of failures) {
      expect(failure).toBeTypeOf('function');
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(150);
    }
    const infos = closes(c);
    expect(infos).toHaveLength(5);
    for (const info of infos) {
      expect(info.reason).toBe('wamp.error.cannot_authenticate');
      expect(info.error).toMatchObject({ code: 'authentication', authMethod: 'ticket' });
      expect((info.error as { cause?: unknown }).cause).toBeDefined();
    }
    expect((infos[3]!.error as { cause: Error }).cause.message).toMatch(/completed without a value/);
    expect((infos[4]!.error as { cause: Error }).cause.message).toMatch(/must answer a string/);
  });

  test('latest wins: a newer CHALLENGE cancels the running handler (CanceledError) and runs for the new round', async () => {
    const signals: AbortSignal[] = [];
    const answers: ((v: string) => void)[] = [];
    const c = start(
      ticket({
        onChallenge: (ch) => {
          signals.push(ch.signal as AbortSignal);
          return new Promise<string>((resolve) => answers.push(resolve));
        },
      }),
      scripted,
    );
    await h.current.clock.advance(1);
    raw([4, 'ticket', { n: 1 }]);
    await h.current.clock.advance(1);
    raw([4, 'ticket', { n: 2 }]);
    await h.current.clock.advance(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[0]!.reason).toMatchObject({ code: 'canceled' });
    answers[0]!('stale'); // unsubscribed: never sent
    answers[1]!('fresh');
    await h.current.clock.advance(1);
    expect(written(c).filter((f) => f[0] === 5)).toEqual([[5, 'fresh', {}]]);
  });

  test('WELCOME while the handler is pending cancels it (CanceledError)', async () => {
    let signal: AbortSignal | undefined;
    const c = start(
      ticket({
        onChallenge: (ch) => {
          signal = ch.signal as AbortSignal;
          return new Promise<string>(() => undefined);
        },
      }),
      scripted,
    );
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    raw([2, 3, { authid: 'joe', roles: {} }]); // after a CHALLENGE: never "anonymous"
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(3);
    expect(signal?.reason).toMatchObject({ code: 'canceled' });
  });

  test('a stale answer (another round) is dropped', async () => {
    const answers: ((v: string) => void)[] = [];
    const c = start(ticket({ onChallenge: () => new Promise<string>((r) => answers.push(r)) }), scripted);
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    answers[0]!('one');
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]); // round 2 (multi-round auth)
    await h.current.clock.advance(1);
    expect(written(c).filter((f) => f[0] === 5)).toEqual([[5, 'one', {}]]);
    expect(answers).toHaveLength(2);
  });

  describe('the settle window (Thruway T6): several methods offered', () => {
    test.each([0, 10, 49])('two CHALLENGEs %i ms apart ⇒ one run, for the latest', async (gap) => {
      const onChallenge = vi.fn((ch: ChallengeMessage) => `answer-for-${ch.authMethod}`);
      const c = start({ authmethods: ['ticket', 'wampcra'], onChallenge }, scripted);
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(gap);
      raw([4, 'wampcra', { challenge: 'c' }]);
      await h.current.clock.advance(60);
      expect(onChallenge).toHaveBeenCalledTimes(1);
      expect(onChallenge.mock.calls[0]![0]).toMatchObject({ authMethod: 'wampcra', extra: { challenge: 'c' } });
      expect(written(c).filter((f) => f[0] === 5)).toEqual([[5, 'answer-for-wampcra', {}]]);
    });

    test('the window is bounded by the first CHALLENGE: 50 ms after it the latest is answered', async () => {
      const onChallenge = vi.fn((ch: ChallengeMessage) => ch.authMethod);
      start({ authmethods: ['ticket', 'wampcra'], onChallenge }, scripted);
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(30);
      raw([4, 'wampcra', {}]);
      await h.current.clock.advance(19);
      expect(onChallenge).not.toHaveBeenCalled();
      await h.current.clock.advance(1);
      expect(onChallenge).toHaveBeenCalledTimes(1);
    });

    test('a method not offered during the window still ABORTs at once', async () => {
      const c = start(
        { authmethods: ['ticket', 'wampcra'], onChallenge: () => 'x', retryOptions: { maxRetries: 0 } },
        scripted,
      );
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(5);
      raw([4, 'cryptosign', {}]);
      await h.current.clock.advance(1);
      expect(lastClose(c).error).toMatchObject({ authMethod: 'cryptosign' });
    });

    test('a CHALLENGE after an AUTHENTICATE for another method ⇒ challenge.mismatch (warn) and a new round', async () => {
      const onChallenge = vi.fn((ch: ChallengeMessage) => `a-${ch.authMethod}`);
      const c = start({ authmethods: ['ticket', 'wampcra'], onChallenge, logger: () => undefined }, scripted);
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(60); // the window closes: answered for ticket
      expect(written(c).filter((f) => f[0] === 5)).toEqual([[5, 'a-ticket', {}]]);
      raw([4, 'wampcra', {}]); // missed the window (a retransmission, Thruway's 200 ms gap)
      await h.current.clock.advance(1);
      expect(logs(c, 'challenge.mismatch')).toHaveLength(1);
      expect(logs(c, 'challenge.mismatch')[0]!.entry.level).toBe('warn');
      expect(onChallenge).toHaveBeenCalledTimes(2); // round 2 runs at once: no second window
      expect(written(c).filter((f) => f[0] === 5)).toEqual([
        [5, 'a-ticket', {}],
        [5, 'a-wampcra', {}],
      ]);
    });

    test('a second round for the same method after AUTHENTICATE is multi-round auth, not a mismatch', async () => {
      const c = start(
        { authmethods: ['ticket', 'wampcra'], onChallenge: () => 'x', logger: () => undefined },
        scripted,
      );
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(60);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(1);
      expect(logs(c, 'challenge.mismatch')).toHaveLength(0);
      expect(written(c).filter((f) => f[0] === 5)).toHaveLength(2);
    });

    test('WELCOME during the window: nothing runs, the window timer is gone', async () => {
      const onChallenge = vi.fn(() => 'x');
      const c = start({ authmethods: ['ticket', 'wampcra'], onChallenge }, scripted);
      await h.current.clock.advance(1);
      raw([4, 'ticket', {}]);
      await h.current.clock.advance(10);
      expect((c.debug() as { timers: number }).timers).toBe(1); // the settle window
      raw([2, 4, WELCOME_AUTH]);
      await h.current.clock.advance(1);
      expect((c.debug() as { timers: number }).timers).toBe(1); // only the stable timer (idle 0: no liveness)
      await h.current.clock.advance(100);
      expect(onChallenge).not.toHaveBeenCalled();
      expect(c.client.session?.id).toBe(4);
    });
  });

  test('a late answer for an ended attempt while waiting starts the next attempt early', async () => {
    let answer: ((v: string) => void) | undefined;
    const c = start(
      {
        authmethods: ['ticket'],
        // a synchronous answer pushed from an onClose observer lands before the end's cancel delivery
        onChallenge: () =>
          new Observable<string>((s) => {
            answer = (v) => {
              s.next(v);
            };
          }),
        retryOptions: { retryDelay: () => 60000 },
      },
      scripted,
    );
    c.client.onClose.subscribe(() => answer?.('late'));
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    await h.current.clock.advance(2000); // past the attempt floor
    c.connection.controls.drop();
    await h.current.clock.advance(1);
    expect(c.connections).toHaveLength(2); // started at once, not 60 s later
    expect(logs(c, 'frame.dropped').some((l) => l.entry.message.includes('late answer'))).toBe(true);
  });

  test('a late answer within 1 s of the attempt start still waits for the attempt floor (INV-R2)', async () => {
    let answer: ((v: string) => void) | undefined;
    const c = start(
      {
        authmethods: ['ticket'],
        onChallenge: () =>
          new Observable<string>((s) => {
            answer = (v) => {
              s.next(v);
            };
          }),
        retryOptions: { retryDelay: () => 60000 },
      },
      scripted,
    );
    c.client.onClose.subscribe(() => answer?.('late'));
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    c.connection.controls.drop(); // 2 ms after the attempt started
    await h.current.clock.advance(1);
    expect(c.connections).toHaveLength(1); // not at once: an app-driven start is floored
    await h.current.clock.advance(996);
    expect(c.connections).toHaveLength(1);
    await h.current.clock.advance(1); // 1000 ms after the first attempt started
    expect(c.connections).toHaveLength(2); // and not 60 s later either
  });

  test.each([
    ['the socket drops (the client will retry)', 'drop', 'connection_lost'],
    ['close()', 'close', 'connection_closed'],
    ['reconnect()', 'reconnect', 'canceled'],
    ['give-up (maxRetries 0)', 'give-up', 'connection_closed'],
  ])('the pending handler is cancelled when %s: its signal says why', async (_n, how, code) => {
    let signal: AbortSignal | undefined;
    const c = start(
      {
        authmethods: ['ticket'],
        onChallenge: (ch) => {
          signal ??= ch.signal as AbortSignal;
          return new Promise<string>(() => undefined);
        },
        retryOptions: { maxRetries: how === 'give-up' ? 0 : 5 },
      },
      scripted,
    );
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    if (how === 'drop' || how === 'give-up') c.connection.controls.drop();
    else if (how === 'close') void c.close();
    else c.reconnect();
    await h.current.clock.advance(1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ code });
    if (how === 'give-up') expect((signal?.reason as { gaveUp?: boolean }).gaveUp).toBe(true);
  });
});

describe('authmethods, authid and authextra as functions: called for every HELLO', () => {
  test('called when each HELLO is written (authmethods, authid, authextra); undefined leaves the key out; a new identity takes effect with reconnect()', async () => {
    let user: { authid: string; ticket: string } | undefined = undefined;
    const calls: string[] = [];
    const c = start(
      {
        authmethods: () => {
          calls.push('authmethods');
          return user === undefined ? undefined : ['ticket'];
        },
        authid: () => {
          calls.push('authid');
          return user?.authid;
        },
        authextra: () => {
          calls.push('authextra');
          return user === undefined ? undefined : { device: 'd1' };
        },
        onChallenge: () => user?.ticket ?? '',
      },
      scripted,
    );
    expect(calls).toEqual([]); // not at construction
    await h.current.clock.advance(1);
    expect(calls).toEqual(['authmethods', 'authid', 'authextra']);
    expect(Object.keys(written(c)[0]?.[2] as object).sort()).toEqual(['agent', 'roles']);
    raw([2, 70, { authid: 'anon-1', authrole: 'anonymous', authmethod: 'anonymous', roles: { broker: {} } }]);
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(70); // offered nothing: an anonymous session is what was asked for
    user = { authid: 'joe', ticket: 't0k3n' };
    c.reconnect();
    await h.current.clock.advance(3000);
    expect(calls).toHaveLength(6);
    const [hello] = written(c, 2);
    expect(hello?.[2]).toMatchObject({ authmethods: ['ticket'], authid: 'joe', authextra: { device: 'd1' } });
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    expect(written(c, 2).at(-1)).toEqual([5, 't0k3n', {}]);
    raw([2, 71, WELCOME_AUTH]);
    await h.current.clock.advance(1);
    expect(c.client.session).toMatchObject({ id: 71, details: { authid: 'joe' } });
    expect(calls).toHaveLength(6); // a CHALLENGE does not call them again
  });

  test('a function that throws or returns an invalid value ends the attempt before any HELLO: AuthenticationError{cause}, retried', async () => {
    let k = 0;
    const c = start(
      {
        authid: () => {
          k++;
          if (k === 1) throw new Error('no user yet');
          return k === 2 ? (7 as unknown as string) : 'joe';
        },
        retryOptions: { retryDelay: () => 100 },
      },
      scripted,
    );
    await h.current.clock.advance(1);
    await h.current.clock.advance(1200);
    await h.current.clock.advance(1200);
    const infos = closes(c);
    expect(infos.slice(0, 2).map((i) => [i.initiator, i.closeCode, i.willRetry])).toEqual([
      ['connection', 1000, true],
      ['connection', 1000, true],
    ]);
    expect(infos[0]?.error).toMatchObject({
      code: 'authentication',
      message: 'the authmethods, authid or authextra option failed',
    });
    expect((infos[0]?.error as { cause: Error }).cause.message).toBe('no user yet');
    expect((infos[1]?.error as { cause: Error }).cause).toBeInstanceOf(TypeError);
    expect((infos[1]?.error as { cause: Error }).cause.message).toBe('authid() must be a string or undefined');
    expect(types(c, 1)).toEqual([]);
    expect(types(c, 2)).toEqual([]);
    expect(c.connections[0]!.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
    expect(written(c, 3)[0]?.[2]).toMatchObject({ authid: 'joe' });
  });

  test("the CHALLENGE check and the anonymous-WELCOME rule use the methods of that attempt's HELLO", async () => {
    let methods: string[] | undefined = ['ticket'];
    const c = start(
      { authmethods: () => methods, onChallenge: () => 'x', retryOptions: { retryDelay: () => 100 } },
      scripted,
    );
    const next = async (): Promise<void> => {
      await h.current.clock.advance(1200);
    };
    await h.current.clock.advance(1);
    raw([4, 'wampcra', {}]); // not offered in this HELLO
    await h.current.clock.advance(1);
    expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.cannot_authenticate', attempt: 1 });
    methods = ['wampcra'];
    await next();
    raw([4, 'wampcra', {}]); // offered in this one
    await h.current.clock.advance(1);
    expect(written(c, 2).at(-1)).toEqual([5, 'x', {}]);
    raw([3, {}, 'wamp.error.not_authorized']);
    await next();
    raw([2, 80, { authid: 'anon-2', authmethod: 'anonymous', roles: {} }]); // asked for wampcra, welcomed anonymously
    await h.current.clock.advance(1);
    expect(lastClose(c).error?.message).toBe('router welcomed the session anonymously');
    methods = undefined; // anonymous now: the same WELCOME is what was asked for
    await next();
    raw([2, 81, { authid: 'anon-3', authmethod: 'anonymous', roles: {} }]);
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(81);
    expect(written(c, 4)[0]?.[2]).not.toHaveProperty('authmethods');
  });
});

describe('the anonymous-WELCOME rule', () => {
  const offered: ClientOptions = { authmethods: ['ticket'], onChallenge: () => 'x' };

  test.each([
    ['authmethod anonymous', { authid: 'anonymous-7', authmethod: 'anonymous', roles: {} }],
    ['neither authmethod nor authid (Thruway {roles})', { roles: {} }],
    ['the echo WELCOME (authmethods key), without authid', { authmethods: ['ticket'], roles: {}, transport: {} }],
    ['the echo WELCOME with the app own authid', { authmethods: ['ticket'], authid: 'joe', roles: {} }],
  ])('%s ⇒ GOODBYE close_realm, AuthenticationError, no onOpen, backoff', async (_n, details) => {
    const opened = vi.fn();
    const c = start({ ...offered, retryOptions: { maxRetries: 1 } }, scripted);
    c.client.onOpen.subscribe(opened);
    await h.current.clock.advance(1);
    raw([2, 77, details]);
    await h.current.clock.advance(1);
    expect(written(c).at(-1)).toEqual([6, {}, 'wamp.close.close_realm']);
    expect(c.connections[0]!.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]); // released right after the GOODBYE
    expect(opened).not.toHaveBeenCalled();
    expect(states(c)).toEqual(['connecting', 'closed']);
    expect(lastClose(c)).toMatchObject({
      initiator: 'connection',
      reason: 'wamp.close.close_realm',
      sessionId: 77,
      willRetry: true,
      attempt: 1,
    });
    expect(lastClose(c).error).toMatchObject({ code: 'authentication' });
    expect(lastClose(c).error?.message).toBe('router welcomed the session anonymously');
    expect(c.client.session).toBeUndefined();
    await h.current.clock.runUntilIdle();
    expect(closes(c).map((i) => i.attempt)).toEqual([1, 2]); // backoff keeps growing, no stable reset
  });

  test.each([
    ['no authmethods offered', {}, { roles: {} }],
    ["'anonymous' offered", { authmethods: ['ticket', 'anonymous'], onChallenge: () => 'x' }, { roles: {} }],
    ['a trusted transport (internalClient)', offered, { authmethod: 'internalClient', authrole: 'admin', roles: {} }],
    ['a NOCHALLENGE provider (authmethod and authid)', offered, { authmethod: 'ticket', authid: 'joe', roles: {} }],
    ['an authid without authmethod', offered, { authid: 'joe', roles: {} }],
  ])('accepted: %s', async (_n, options, details) => {
    const c = start(options, scripted);
    await h.current.clock.advance(1);
    raw([2, 5, details]);
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(5);
  });

  test('the Session: the WELCOME id, the client realm (Crossbar and fox-wamp add their own `realm`), the details as received; frozen like every Status', async () => {
    const c = start({}, scripted);
    await h.current.clock.advance(1);
    const details = { authid: 'joe', realm: 'crossbar.realm', x_cb_node: 'n1', roles: { dealer: {} } };
    raw([2, 42, details]);
    await h.current.clock.advance(1);
    const session = c.client.session!;
    expect(session).toEqual({ id: 42, realm: 'realm1', details });
    expect(c.onOpen?.values).toEqual([session]);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.details)).toBe(true);
    const statuses = c.status?.values ?? [];
    expect(statuses.at(-1)).toEqual({ state: 'open', session });
    for (const status of statuses) expect(Object.isFrozen(status)).toBe(true);
  });

  test('exempt after a CHALLENGE on this connection (a WELCOME with no authmethod in its details)', async () => {
    const c = start(offered, scripted);
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    raw([2, 6, { roles: {} }]);
    await h.current.clock.advance(1);
    expect(c.client.session?.id).toBe(6);
  });

  test('ops wait through a rejected WELCOME: nothing is written, they go out in the next real session', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start({ ...offered, retryOptions: { retryDelay: () => 100 } }, scripted);
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await h.current.clock.advance(1);
    raw([2, 1, { roles: {} }]);
    await h.current.clock.advance(1);
    expect(types(c)).toEqual([1, 6]);
    expect(call.closed).toBe(false);
  });
});

describe('hooks that misbehave during the handshake (pure hooks are contained)', () => {
  /** jsonSerializer, except that frames of `type` cannot be serialized. */
  const refusing = (type: number): NonNullable<ClientOptions['serializer']> => ({
    protocol: 'wamp.2.json',
    binary: false,
    serialize: (m) => {
      if (m[0] === type) throw new TypeError(`cannot serialize type ${String(type)}`);
      return JSON.stringify(m);
    },
    deserialize: (d) => JSON.parse(d as string) as unknown,
  });

  test('a WELCOME without roles: liveness treats it as having a dealer', async () => {
    const c = start({ timeouts: { idle: 1000 } }, scripted);
    await h.current.clock.advance(1);
    raw([2, 8, { authid: 'joe', authmethod: 'ticket' }]);
    await h.current.clock.advance(1000);
    expect(written(c).filter((f) => f[3] === 'thruway.js.ping')).toHaveLength(1);
  });

  test.each([
    ['roles without a dealer: no CALL probe (option.fallback)', { broker: {} }, 0],
    ['roles with a dealer: the calibration probe', { broker: {}, dealer: {} }, 1],
    ['roles that are not a dict: treated as absent', 'dealer', 1],
  ])('the WELCOME roles reach liveness — %s', async (_n, roles, probes) => {
    const c = start({ timeouts: { idle: 1000 } }, scripted);
    await h.current.clock.advance(1);
    raw([2, 8, { authid: 'joe', authmethod: 'ticket', roles }]);
    await h.current.clock.advance(1000);
    expect(written(c).filter((f) => f[3] === 'thruway.js.ping')).toHaveLength(probes);
    expect(logs(c, 'option.fallback')).toHaveLength(1 - probes);
  });

  test('an AUTHENTICATE the serializer refuses ends the attempt with a ProtocolError', async () => {
    const c = start(
      {
        ...{ authmethods: ['ticket'], onChallenge: () => 's' },
        serializer: refusing(5),
        retryOptions: { maxRetries: 0 },
      },
      scripted,
    );
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    expect(lastClose(c).error).toMatchObject({
      code: 'protocol',
      message: 'a handshake frame could not be serialized',
    });
  });

  test('an ABORT the serializer refuses is skipped (request.error); the attempt still ends', async () => {
    const c = start({ authmethods: ['ticket'], serializer: refusing(3), retryOptions: { maxRetries: 0 } }, scripted);
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]); // no onChallenge: ABORT cannot_authenticate, which cannot be written
    await h.current.clock.advance(1);
    expect(logs(c, 'request.error').map((l) => l.entry.message)).toEqual(['ABORT could not be serialized; skipped']);
    expect(lastClose(c)).toMatchObject({ reason: 'wamp.error.cannot_authenticate' });
  });

  test('a challenge round that ended before its delivery ran never calls onChallenge', async () => {
    const onChallenge = vi.fn(() => new Promise<string>(() => undefined));
    const ref: { client?: Client } = {};
    const c = start(
      {
        authmethods: ['ticket'],
        onChallenge,
        // the logger runs inside steps: on the CHALLENGE's frame entry it asks for reconnect(), queued behind the step
        logger: (entry) => {
          if (entry.event === 'frame.in' && entry.message.startsWith('received CHALLENGE')) ref.client?.reconnect();
        },
      },
      scripted,
    );
    ref.client = c.client;
    await h.current.clock.advance(1);
    raw([4, 'ticket', {}]);
    await h.current.clock.advance(1);
    expect(onChallenge).not.toHaveBeenCalled(); // the attempt was abandoned before the run delivery
  });

  test('a run superseded by a newer CHALLENGE processed before its delivery is skipped', async () => {
    // a synchronous transport: a CHALLENGE delivered from inside the step of the first one is queued behind it
    // and processed before the first round's run delivery
    let deliver: ((ev: { data: unknown }) => void) | undefined;
    const Inner = h.current.router.webSocketFor(1);
    const Synchronous = function (url: string, protocols?: string | string[]) {
      const ws = new Inner(url, protocols);
      return new Proxy(ws, {
        get(target, prop) {
          if (prop === 'addEventListener') {
            return (type: string, listener: (ev: { readonly data: unknown }) => void) => {
              if (type === 'message') deliver = listener;
              target.addEventListener(type as 'message', listener);
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
    Object.defineProperty(Synchronous, 'OPEN', { value: 1 });
    const onChallenge = vi.fn((ch: ChallengeMessage) => String(ch.extra['n']));
    let injected = false;
    const c = start(
      {
        WebSocket: Synchronous,
        authmethods: ['ticket'],
        onChallenge,
        logger: (entry) => {
          if (!injected && entry.event === 'frame.in' && entry.message.startsWith('received CHALLENGE')) {
            injected = true;
            deliver?.({ data: JSON.stringify([4, 'ticket', { n: 2 }]) });
          }
        },
      },
      scripted,
    );
    await h.current.clock.advance(1);
    raw([4, 'ticket', { n: 1 }]);
    await h.current.clock.advance(1);
    expect(onChallenge).toHaveBeenCalledTimes(1); // only round 2 ran
    expect(onChallenge.mock.calls[0]![0].extra).toEqual({ n: 2 });
    expect(written(c).filter((f) => f[0] === 5)).toEqual([[5, '2', {}]]);
  });

  test('a clock.random that throws while seeding the id stream: the system random is used (option.fallback)', async () => {
    const x = h.current;
    const scope = x.clock.scope('client');
    let first = true;
    const c = start({
      clock: {
        now: () => scope.now(),
        setTimeout: (fn, ms) => scope.setTimeout(fn, ms),
        clearTimeout: (handle) => {
          scope.clearTimeout(handle);
        },
        random: () => {
          if (first) {
            first = false;
            throw new Error('no entropy yet');
          }
          return 0.5;
        },
      },
    });
    await h.current.clock.advance(1);
    expect(logs(c, 'option.fallback').map((l) => l.entry.message)).toEqual([
      'clock.random threw while seeding the request-id stream; the system random was used',
    ]);
    expect(c.client.session).toBeDefined();
  });

  test('a clock.now that throws: the last good reading is used and option.fallback is logged once per failure', async () => {
    const scope = h.current.clock.scope('client');
    let broken = false;
    const c = start({
      clock: {
        now: () => {
          if (broken) throw new Error('clock broken');
          return scope.now();
        },
        setTimeout: (fn, ms) => scope.setTimeout(fn, ms),
        clearTimeout: (handle) => {
          scope.clearTimeout(handle);
        },
      },
    });
    await h.current.clock.advance(1);
    broken = true;
    h.current.router.drop();
    await h.current.clock.advance(5000);
    broken = false;
    expect(logs(c, 'option.fallback').length).toBeGreaterThan(0);
    expect(logs(c, 'option.fallback')[0]!.entry.message).toMatch(/^clock.now threw/);
    await h.current.clock.advance(5000);
    expect(c.client.session).toBeDefined();
  });

  test('a retryDelay that throws falls back to the default and says so (option.fallback)', async () => {
    const c = start(
      {
        retryOptions: {
          retryDelay: () => {
            throw new Error('strategy bug');
          },
        },
      },
      (x) => {
        x.router.setAvailable('refuse');
      },
    );
    await h.current.clock.advance(1);
    expect(logs(c, 'option.fallback')[0]?.entry.message).toBe(
      'retryOptions.retryDelay threw or returned an unusable value; the default was used',
    );
    h.current.router.setAvailable('ok');
    await h.current.clock.advance(5000);
  });
});
