// Client options: defaults, every validation rule with the option path in the TypeError, `undefined` meaning "default",
// frozen copies that never alias or mutate the caller's objects, the `maxRetries` cases (−1 / −2 / 1.5 / NaN rejected
// naming Infinity; 0 / 3 / Infinity accepted) and the realm cases ('' / 'a b' / 'a..b' / '.a' / 'a#' rejected; 'realm1'
// / 'com.example' / 'realm1.strict' accepted), the internal fast-profile option and its trace sink, and the Client
// constructor throwing synchronously only for these.
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { systemClock } from '../../src/core/clock.js';
import { DEFAULTS, INTERNAL_DEFAULTS, INTERNAL_OPTIONS, normalizeOptions } from '../../src/options.js';
import { jsonSerializer } from '../../src/transport/json.js';
import type { WebSocketConstructorLike } from '../../src/types.js';

const WS = function FakeWebSocket() {
  // never constructed in these tests
} as unknown as WebSocketConstructorLike;
const URL = 'ws://127.0.0.1:1/';

function norm(options?: unknown, url: unknown = URL, realm: unknown = 'realm1') {
  return normalizeOptions(
    url,
    realm,
    options === undefined ? { WebSocket: WS } : { WebSocket: WS, ...(options as object) },
  );
}

function rejects(options: unknown, message: RegExp): void {
  expect(() => norm(options)).toThrow(TypeError);
  expect(() => norm(options)).toThrow(message);
}

describe('defaults', () => {
  test('every option has its documented default', () => {
    const o = norm();
    expect(o.url).toBe(URL);
    expect(o.realm).toBe('realm1');
    expect(o.authmethods).toEqual([]);
    expect(o.authid).toBeUndefined();
    expect(o.authextra).toBeUndefined();
    expect(o.onChallenge).toBeUndefined();
    expect(o.autoOpen).toBe(true);
    // the documented literal values (not the DEFAULTS constant itself, which a test must not trust)
    expect(o.retry).toEqual({
      initialRetryDelay: 1500,
      retryDelayGrowth: 1.5,
      maxRetryDelay: 60000,
      maxRetries: Number.POSITIVE_INFINITY,
      retryDelay: undefined,
    });
    expect(o.timeouts).toEqual({ connect: 10000, handshake: 15000, request: 60000, idle: 30000 });
    expect(o.requestIds).toBe('random');
    expect(o.WebSocket).toBe(WS);
    expect(o.serializer.protocol).toBe('wamp.2.json');
    expect(o.clock).toBe(systemClock);
    expect(o.random).toBeUndefined();
    expect(o.logger).toBeUndefined();
    expect(o.internal).toEqual({ ping: 20000, stable: 60000, goodbye: 2000, settle: 50, attemptFloor: 1000 });
    expect(o.internal).toEqual(INTERNAL_DEFAULTS);
    expect(o.trace).toBeUndefined();
    expect(DEFAULTS.retryOptions.maxRetries).toBe(Number.POSITIVE_INFINITY);
  });

  test('keys set to undefined mean "default", at every level', () => {
    const o = norm({
      authmethods: undefined,
      authid: undefined,
      authextra: undefined,
      onChallenge: undefined,
      autoOpen: undefined,
      retryOptions: { initialRetryDelay: undefined, maxRetries: undefined, retryDelay: undefined },
      timeouts: { connect: undefined, idle: undefined },
      requestIds: undefined,
      serializer: undefined,
      clock: undefined,
      logger: undefined,
      [INTERNAL_OPTIONS]: undefined,
    });
    const { serializer, ...rest } = o;
    const { serializer: defaultSerializer, ...defaults } = norm();
    expect(rest).toEqual(defaults);
    expect(serializer.protocol).toBe(defaultSerializer.protocol);
  });

  test('options, retryOptions and timeouts may be undefined or null', () => {
    expect(normalizeOptions(URL, 'r', { WebSocket: WS, retryOptions: null, timeouts: null }).timeouts).toEqual(
      DEFAULTS.timeouts,
    );
    const global = vi.spyOn(globalThis as { WebSocket: unknown }, 'WebSocket', 'get').mockReturnValue(WS);
    try {
      expect(normalizeOptions(URL, 'r', undefined).WebSocket).toBe(WS);
      expect(normalizeOptions(URL, 'r', null).WebSocket).toBe(WS);
    } finally {
      global.mockRestore();
    }
  });

  test('the result and its nested objects are frozen', () => {
    const o = norm({ authmethods: ['ticket'], authextra: { a: 1 } });
    for (const part of [o, o.authmethods, o.authextra, o.retry, o.timeouts, o.internal]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });
});

describe('copies: the caller objects are never aliased or mutated', () => {
  test('authmethods and authextra are copied; the caller can change them afterwards', () => {
    const authmethods = ['ticket'];
    const authextra = { pubkey: 'ab' };
    const options = { WebSocket: WS, authmethods, authextra };
    const before = JSON.stringify(options);
    const o = normalizeOptions(URL, 'realm1', options);
    authmethods.push('wampcra');
    authextra.pubkey = 'cd';
    expect(o.authmethods).toEqual(['ticket']);
    expect(o.authextra).toEqual({ pubkey: 'ab' });
    expect(JSON.stringify({ WebSocket: WS, authmethods: ['ticket'], authextra: { pubkey: 'ab' } })).toBe(before);
    expect(Object.isFrozen(options)).toBe(false);
  });
});

describe('url and realm', () => {
  test('url: a non-empty string or a function', () => {
    expect(norm(undefined, () => URL).url).toBeTypeOf('function');
    for (const url of ['', 5, undefined, null, {}]) {
      expect(() => normalizeOptions(url, 'realm1', { WebSocket: WS })).toThrow(
        /url must be a non-empty string or a function/,
      );
    }
  });

  test.each(['realm1', 'com.example', 'realm1.strict', 'a', 'thruway.auth', 'é.ü'])('realm %j is accepted', (realm) => {
    expect(norm(undefined, URL, realm).realm).toBe(realm);
  });

  test.each(['', 'a b', 'a..b', '.a', 'a.', 'a#', '#', ' ', 'a\tb', 'a\x1fb'])('realm %j is a TypeError', (realm) => {
    expect(() => norm(undefined, URL, realm)).toThrow(TypeError);
    expect(() => norm(undefined, URL, realm)).toThrow(/realm must be a URI/);
  });

  test('a realm that is not a string is a TypeError', () => {
    for (const realm of [undefined, null, 1, ['realm1']]) {
      expect(() => normalizeOptions(URL, realm, { WebSocket: WS })).toThrow(/realm must be a URI/);
    }
  });
});

describe('retryOptions', () => {
  test.each([0, 3, 100, Number.POSITIVE_INFINITY])('maxRetries %s is accepted', (maxRetries) => {
    expect(norm({ retryOptions: { maxRetries } }).retry.maxRetries).toBe(maxRetries);
  });

  test.each([-1, -2, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '3', null])(
    'maxRetries %s is a TypeError naming Infinity',
    (maxRetries) => {
      expect(() => norm({ retryOptions: { maxRetries } })).toThrow(
        'retryOptions.maxRetries must be a non-negative integer or Infinity (use Infinity for unlimited retries)',
      );
    },
  );

  test('initialRetryDelay: an integer in [0, 2^31−1]', () => {
    expect(norm({ retryOptions: { initialRetryDelay: 0 } }).retry.initialRetryDelay).toBe(0);
    for (const v of [-1, 1.5, Number.NaN, 2 ** 31, '5'])
      rejects({ retryOptions: { initialRetryDelay: v } }, /initialRetryDelay/);
  });

  test('retryDelayGrowth: a finite number ≥ 1', () => {
    expect(norm({ retryOptions: { retryDelayGrowth: 1 } }).retry.retryDelayGrowth).toBe(1);
    expect(norm({ retryOptions: { retryDelayGrowth: 2.5 } }).retry.retryDelayGrowth).toBe(2.5);
    for (const v of [0.99, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      rejects({ retryOptions: { retryDelayGrowth: v } }, /retryOptions.retryDelayGrowth must be a finite number ≥ 1/);
    }
  });

  test('maxRetryDelay: an integer in [100, 2^31−1]', () => {
    expect(norm({ retryOptions: { maxRetryDelay: 100 } }).retry.maxRetryDelay).toBe(100);
    expect(norm({ retryOptions: { maxRetryDelay: 2 ** 31 - 1 } }).retry.maxRetryDelay).toBe(2 ** 31 - 1);
    for (const v of [99, 0, 150.5, 2 ** 31])
      rejects({ retryOptions: { maxRetryDelay: v } }, /maxRetryDelay must be an integer ≥ 100/);
  });

  test('retryDelay: a function', () => {
    const retryDelay = (): null => null;
    expect(norm({ retryOptions: { retryDelay } }).retry.retryDelay).toBe(retryDelay);
    rejects({ retryOptions: { retryDelay: 1000 } }, /retryOptions.retryDelay must be a function/);
  });

  test('retryOptions itself must be an object', () => {
    rejects({ retryOptions: 5 }, /retryOptions must be an object/);
    rejects({ retryOptions: [] }, /retryOptions must be an object/);
  });
});

describe('timeouts', () => {
  test('connect, handshake and request are positive integers; idle may be 0 (liveness off)', () => {
    const o = norm({ timeouts: { connect: 1, handshake: 2, request: 3, idle: 0 } });
    expect(o.timeouts).toEqual({ connect: 1, handshake: 2, request: 3, idle: 0 });
    for (const key of ['connect', 'handshake', 'request']) {
      for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '10']) {
        rejects({ timeouts: { [key]: v } }, new RegExp(`timeouts.${key} must be an integer ≥ 1`));
      }
    }
    for (const v of [-1, 0.5, 2 ** 31])
      rejects({ timeouts: { idle: v } }, /timeouts.idle must be a non-negative integer/);
    rejects({ timeouts: 'fast' }, /timeouts must be an object/);
  });
});

describe('the other options', () => {
  test('authmethods: an array of non-empty strings', () => {
    expect(norm({ authmethods: ['ticket', 'wampcra'] }).authmethods).toEqual(['ticket', 'wampcra']);
    for (const v of ['ticket', [''], [1], [null], {}])
      rejects({ authmethods: v }, /authmethods must be an array of non-empty strings/);
  });

  test('authid a string, authextra a plain object, onChallenge and logger functions, autoOpen a boolean', () => {
    const onChallenge = (): string => 'x';
    const logger = (): void => undefined;
    const o = norm({ authid: 'joe', authextra: { pubkey: 'ab' }, onChallenge, logger, autoOpen: false });
    expect([o.authid, o.authextra, o.onChallenge, o.logger, o.autoOpen]).toEqual([
      'joe',
      { pubkey: 'ab' },
      onChallenge,
      logger,
      false,
    ]);
    rejects({ authid: 7 }, /authid must be a string/);
    rejects({ authextra: [] }, /authextra must be a plain object/);
    rejects({ authextra: new Map() }, /authextra must be a plain object/);
    rejects({ onChallenge: 'x' }, /onChallenge must be a function/);
    rejects({ logger: console }, /logger must be a function/);
    rejects({ autoOpen: 'yes' }, /autoOpen must be a boolean/);
  });

  test("requestIds: 'random' or 'sequential'", () => {
    expect(norm({ requestIds: 'sequential' }).requestIds).toBe('sequential');
    rejects({ requestIds: 'strict' }, /requestIds must be 'random' or 'sequential'/);
  });

  test('WebSocket: a constructor, else globalThis.WebSocket, else a TypeError', () => {
    rejects({ WebSocket: {} }, /WebSocket must be a WebSocket constructor/);
    const global = vi.spyOn(globalThis as { WebSocket: unknown }, 'WebSocket', 'get').mockReturnValue(undefined);
    try {
      expect(() => normalizeOptions(URL, 'r', {})).toThrow(/no WebSocket implementation/);
    } finally {
      global.mockRestore();
    }
    expect(normalizeOptions(URL, 'r', {}).WebSocket).toBe(globalThis.WebSocket);
  });

  test('serializer: protocol, serialize and deserialize; the object is used as given', () => {
    const serializer = { protocol: 'wamp.2.msgpack', binary: true, serialize: () => '', deserialize: () => [] };
    expect(norm({ serializer }).serializer).toBe(serializer);
    expect(norm({ serializer: jsonSerializer({ binary: true }) }).serializer.protocol).toBe('wamp.2.json');
    rejects({ serializer: 'json' }, /serializer must be an object/);
    rejects({ serializer: { ...serializer, protocol: '' } }, /serializer.protocol must be a non-empty string/);
    rejects({ serializer: { ...serializer, protocol: 5 } }, /serializer.protocol/);
    rejects({ serializer: { ...serializer, serialize: undefined } }, /serializer.serialize must be a function/);
    rejects({ serializer: { ...serializer, deserialize: 'x' } }, /serializer.deserialize must be a function/);
  });

  test('clock: now, setTimeout, clearTimeout functions; an injected random is bound to the clock', () => {
    const clock = {
      seedBase: 0.25,
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      random(this: { seedBase: number }) {
        return this.seedBase;
      },
    };
    const o = norm({ clock });
    expect(o.clock).toBe(clock);
    expect(o.random?.()).toBe(0.25);
    expect(norm({ clock: { ...clock, random: undefined } }).random).toBeUndefined();
    for (const key of ['now', 'setTimeout', 'clearTimeout']) {
      rejects({ clock: { ...clock, [key]: 1 } }, new RegExp(`clock.${key} must be a function`));
    }
    rejects({ clock: { ...clock, random: 0.5 } }, /clock.random must be a function/);
    rejects({ clock: Date.now }, /clock must be an object/);
  });

  test('options itself must be an object', () => {
    expect(() => normalizeOptions(URL, 'r', 'fast')).toThrow(/options must be an object/);
    expect(() => normalizeOptions(URL, 'r', [WS])).toThrow(/options must be an object/);
  });

  test('getters are read once; a throwing getter propagates (the constructor throws)', () => {
    let reads = 0;
    const options = {
      WebSocket: WS,
      get authid() {
        reads++;
        return 'joe';
      },
    };
    expect(normalizeOptions(URL, 'r', options).authid).toBe('joe');
    expect(reads).toBe(1);
    expect(() =>
      normalizeOptions(
        URL,
        'r',
        Object.defineProperty({ WebSocket: WS }, 'authid', {
          get() {
            throw new RangeError('boom');
          },
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe('the internal option (fast profiles and the trace sink)', () => {
  test('overrides the internal timings; positive integers (attemptFloor may be 0)', () => {
    const o = norm({ [INTERNAL_OPTIONS]: { ping: 5, stable: 6, goodbye: 7, settle: 8, attemptFloor: 0 } });
    expect(o.internal).toEqual({ ping: 5, stable: 6, goodbye: 7, settle: 8, attemptFloor: 0 });
    for (const key of ['ping', 'stable', 'goodbye', 'settle']) {
      expect(() => norm({ [INTERNAL_OPTIONS]: { [key]: 0 } })).toThrow(new RegExp(`internal ${key}`));
    }
    expect(() => norm({ [INTERNAL_OPTIONS]: 5 })).toThrow(/internal options must be an object/);
  });

  test('a trace sink object is passed through; anything else is ignored', () => {
    const trace = {
      stepStart: () => undefined,
      stepEnd: () => undefined,
      deliveryQueued: () => undefined,
      deliveryStart: () => undefined,
      deliveryEnd: () => undefined,
    };
    expect(norm({ [INTERNAL_OPTIONS]: { trace } }).trace).toBe(trace);
    expect(norm({ [INTERNAL_OPTIONS]: { trace: 'yes' } }).trace).toBeUndefined();
    expect(norm({ [INTERNAL_OPTIONS]: { trace: null } }).trace).toBeUndefined();
  });
});

describe('the Client constructor', () => {
  test('throws TypeError synchronously for invalid options; nothing else of the API throws', () => {
    expect(() => new Client(URL, 'a b', { WebSocket: WS })).toThrow(TypeError);
    expect(() => new Client(URL, 'realm1', { WebSocket: WS, retryOptions: { maxRetries: -1 } })).toThrow(/Infinity/);
    const client = new Client(URL, 'realm1', { WebSocket: WS, autoOpen: false });
    expect(() => client.call('not a uri!').subscribe({ error: () => undefined })).not.toThrow();
    void client.close();
  });

  test('at runtime the surface is the 12 Client members: nothing enumerable, the internal hooks symbol-keyed', () => {
    const client = new Client(URL, 'realm1', { WebSocket: WS, autoOpen: false });
    expect(Object.keys(client)).toEqual([]); // the core lives off the instance
    const enumerable: string[] = [];
    for (const key in client) enumerable.push(key);
    expect(enumerable).toEqual([]);
    expect(Object.getOwnPropertyNames(Client.prototype).sort()).toEqual(
      [
        'call',
        'close',
        'constructor',
        'onClose',
        'onOpen',
        'open',
        'progressiveCall',
        'publish',
        'reconnect',
        'register',
        'session',
        'status',
        'topic',
      ].sort(),
    );
    expect(
      Object.getOwnPropertySymbols(Client.prototype)
        .map((s) => s.description)
        .sort(),
    ).toEqual(['thruway.js.debug', 'thruway.js.faults']);
    void client.close();
  });

  test('the methods refuse a foreign `this` with a TypeError', () => {
    expect(() => {
      Client.prototype.open.call({});
    }).toThrow(/not a thruway.js Client/);
  });
});

describe('the root entry "thruway.js" (src/index.ts)', () => {
  test('exports exactly the public runtime names (types are erased), each the implementation itself', async () => {
    const root = await import('../../src/index.js');
    const errors = await import('../../src/errors.js');
    expect(Object.keys(root).sort()).toEqual(
      [
        'AbortError',
        'AuthenticationError',
        'CanceledError',
        'Client',
        'ConnectionClosedError',
        'ConnectionLostError',
        'ProtocolError',
        'TimeoutError',
        'WampError',
        'Yield',
        'isThruwayError',
        'isWampError',
        'jsonSerializer',
      ].sort(),
    );
    expect(root.Client).toBe(Client);
    expect(root.jsonSerializer).toBe(jsonSerializer);
    expect(root.WampError).toBe(errors.WampError);
    expect(root.isThruwayError).toBe(errors.isThruwayError);
    // the ponyfill is in place: the client's Observables carry the interop key RxJS 5/7 look up
    expect(typeof Symbol.observable).toBe('symbol');
    const client = new root.Client(URL, 'realm1', { WebSocket: WS, autoOpen: false });
    const status = client.status as unknown as Record<symbol, () => unknown>;
    expect(status[Symbol.observable]?.()).toBe(client.status);
    void client.close();
  });
});
