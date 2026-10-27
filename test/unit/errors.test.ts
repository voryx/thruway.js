// Error classes, brand and guards: name/code stable, brand non-enumerable with the code as value, `message === uri`,
// constructor field defaults, context fields, `cause: unknown`, guards that never throw and recognise branded errors
// from any copy (the cross-copy cases with real builds: test/node/errors-copies).
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  ConnectionClosedError,
  ConnectionLostError,
  ERROR_BRAND,
  isThruwayError,
  isWampError,
  PROTOCOL_FRAME_LIMIT,
  ProtocolError,
  TimeoutError,
  truncateText,
  WampError,
  withContext,
  type ThruwayError,
} from '../../src/errors.js';
import type { ErrorCode } from '../../src/types.js';

const BRAND = Symbol.for('thruway.js.error');

/** One instance of every class, built with the smallest valid arguments. */
const samples: readonly (readonly [string, ErrorCode, () => ThruwayError])[] = [
  ['WampError', 'wamp_error', () => new WampError('wamp.error.no_such_procedure')],
  ['ConnectionLostError', 'connection_lost', () => new ConnectionLostError({})],
  ['ConnectionClosedError', 'connection_closed', () => new ConnectionClosedError({})],
  ['TimeoutError', 'timeout', () => new TimeoutError({ timer: 'connect', timeout: 10000 })],
  ['AbortError', 'abort', () => new AbortError({ reason: 'wamp.error.no_such_realm' })],
  ['ProtocolError', 'protocol', () => new ProtocolError({ message: 'bad frame' })],
  ['CanceledError', 'canceled', () => new CanceledError()],
  ['AuthenticationError', 'authentication', () => new AuthenticationError({ message: 'no onChallenge' })],
];

describe('every class', () => {
  test('the eight codes are exactly ErrorCode, one class each', () => {
    const codes = samples.map(([, code]) => code);
    expect(new Set(codes).size).toBe(8);
    expect([...codes].sort()).toEqual(
      [
        'abort',
        'authentication',
        'canceled',
        'connection_closed',
        'connection_lost',
        'protocol',
        'timeout',
        'wamp_error',
      ].sort(),
    );
  });

  test.each(samples)('%s: name and code are stable', (name, code, make) => {
    const error = make();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    // name lives on the prototype (literal, minifier-safe); code is an own enumerable property
    expect(Object.prototype.hasOwnProperty.call(error, 'name')).toBe(false);
    expect(Object.getPrototypeOf(error)).toHaveProperty('name', name);
    expect(Object.keys(error)).toContain('code');
    expect(String(error)).toBe(`${name}: ${error.message}`);
    expect(error.stack?.startsWith(`${name}: `)).toBe(true);
    // a second instance agrees (nothing is computed per instance)
    expect(make().name).toBe(name);
    expect(make().code).toBe(code);
  });

  test.each(samples)(
    '%s: brand is Symbol.for(thruway.js.error), own, non-enumerable, read-only, value = code',
    (_, code, make) => {
      const error = make();
      expect(ERROR_BRAND).toBe(BRAND);
      const descriptor = Object.getOwnPropertyDescriptor(error, BRAND);
      expect(descriptor).toEqual({ value: code, enumerable: false, writable: false, configurable: false });
      expect(Object.keys(error)).not.toContain(String(BRAND));
      expect(Object.getOwnPropertySymbols(error)).toEqual([BRAND]);
      expect(isThruwayError(error)).toBe(true);
      expect(isWampError(error)).toBe(code === 'wamp_error');
    },
  );

  test.each(samples)('%s: instances are not frozen (frameworks annotate errors)', (_, __, make) => {
    const error = make() as ThruwayError & { annotated?: boolean };
    expect(Object.isFrozen(error)).toBe(false);
    error.annotated = true;
    expect(error.annotated).toBe(true);
  });
});

describe('context fields and cause', () => {
  const context = { sessionId: 7, requestId: 42, procedure: 'com.app.proc', topic: 'com.app.topic', attempt: 3 };
  const builders: readonly (readonly [string, (ctx: typeof context & { cause?: unknown }) => ThruwayError])[] = [
    ['ConnectionLostError', (ctx) => new ConnectionLostError(ctx)],
    ['ConnectionClosedError', (ctx) => new ConnectionClosedError(ctx)],
    ['TimeoutError', (ctx) => new TimeoutError({ timer: 'request', timeout: 5, ...ctx })],
    ['AbortError', (ctx) => new AbortError({ reason: 'wamp.error.x', ...ctx })],
    ['ProtocolError', (ctx) => new ProtocolError({ message: 'm', ...ctx })],
    ['CanceledError', (ctx) => new CanceledError(ctx)],
    ['AuthenticationError', (ctx) => new AuthenticationError({ message: 'm', ...ctx })],
  ];

  test.each(builders)('%s copies every defined context field', (_, build) => {
    const error = build(context);
    expect(error).toMatchObject(context);
    for (const key of Object.keys(context)) expect(Object.keys(error)).toContain(key);
  });

  test.each(builders)('%s leaves absent and undefined context fields absent', (_, build) => {
    const error = build({
      sessionId: undefined,
      requestId: undefined,
      procedure: undefined,
      topic: undefined,
      attempt: undefined,
    } as unknown as typeof context);
    for (const key of ['sessionId', 'requestId', 'procedure', 'topic', 'attempt', 'cause']) {
      expect(key in error).toBe(false);
    }
  });

  test.each(builders)('%s: cause is unknown — any value, own, non-enumerable like the ES2022 option', (_, build) => {
    fc.assert(
      fc.property(
        fc.anything().filter((v) => v !== undefined),
        (cause) => {
          const error = build({ ...context, cause });
          expect(error.cause).toBe(cause);
          const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
          expect(descriptor).toEqual({ value: cause, enumerable: false, writable: true, configurable: true });
        },
      ),
      { numRuns: 25 },
    );
    const inner = new TimeoutError({ timer: 'liveness', timeout: 1 });
    expect(build({ ...context, cause: inner }).cause).toBe(inner);
    expect('cause' in build({ ...context, cause: undefined })).toBe(false);
  });

  test('withContext sets defined fields on a WampError and returns it', () => {
    const error = new WampError('wamp.error.not_authorized');
    expect(withContext(error, { procedure: 'p', requestId: 9, sessionId: undefined })).toBe(error);
    expect(error.procedure).toBe('p');
    expect(error.requestId).toBe(9);
    expect('sessionId' in error).toBe(false);
    withContext(error, { topic: 't', sessionId: 1, attempt: 2 });
    expect(error).toMatchObject({ procedure: 'p', requestId: 9, topic: 't', sessionId: 1, attempt: 2 });
  });
});

describe('WampError', () => {
  test('message === uri === errorUri, for any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (uri) => {
        const error = new WampError(uri);
        expect(error.message).toBe(uri);
        expect(error.uri).toBe(uri);
        expect(error.errorUri).toBe(uri);
      }),
    );
  });

  test('defaults: args [], kwargs {}, details {}, no context', () => {
    const error = new WampError('wamp.error.canceled');
    expect(error.args).toEqual([]);
    expect(error.kwargs).toEqual({});
    expect(error.details).toEqual({});
    expect(Object.keys(error)).toEqual(['code', 'uri', 'errorUri', 'args', 'kwargs', 'details']);
  });

  test('args, kwargs and details are kept by reference (args[0] untouched)', () => {
    const args = ['The procedure failed: x', 2];
    const kwargs = { a: 1 };
    const details = { callee: 5 };
    const error = new WampError('app.error', args, kwargs, details);
    expect(error.args).toBe(args);
    expect(error.kwargs).toBe(kwargs);
    expect(error.details).toBe(details);
    expect(error.args[0]).toBe('The procedure failed: x');
  });

  test('null args/kwargs/details mean absent; other malformed payloads are kept for the sender to reject', () => {
    const fromJs = WampError as unknown as new (...a: unknown[]) => WampError;
    const absent = new fromJs('u', null, null, null);
    expect(absent.args).toEqual([]);
    expect(absent.kwargs).toEqual({});
    expect(absent.details).toEqual({});
    const malformed = new fromJs('u', 'not an array', 5);
    expect(malformed.args).toBe('not an array');
    expect(malformed.kwargs).toBe(5);
  });

  test('a non-string uri from JavaScript is coerced, so message === uri still holds', () => {
    const fromJs = WampError as unknown as new (...a: unknown[]) => WampError;
    for (const uri of [42, undefined, null, true]) {
      const error = new fromJs(uri);
      expect(typeof error.uri).toBe('string');
      expect(error.message).toBe(error.uri);
      expect(error.errorUri).toBe(error.uri);
    }
  });
});

describe('defaults and field rules per class', () => {
  test('ConnectionLostError', () => {
    const plain = new ConnectionLostError({});
    expect(plain.message).toBe('The connection was lost');
    expect(Object.keys(plain)).toEqual(['code']);
    const full = new ConnectionLostError({
      message: 'socket closed: 1006',
      reason: 'wamp.close.close_realm',
      closeCode: 1006,
    });
    expect(full).toMatchObject({ message: 'socket closed: 1006', reason: 'wamp.close.close_realm', closeCode: 1006 });
    expect(new ConnectionLostError({ message: '' }).message).toBe('');
  });

  test('ConnectionClosedError: gaveUp is false unless exactly true', () => {
    expect(new ConnectionClosedError({}).gaveUp).toBe(false);
    expect(new ConnectionClosedError({}).message).toBe('The client was closed');
    const gaveUp = new ConnectionClosedError({ gaveUp: true });
    expect(gaveUp.gaveUp).toBe(true);
    expect(gaveUp.message).toBe('The client gave up reconnecting');
    expect(new ConnectionClosedError({ gaveUp: 'yes' as unknown as boolean }).gaveUp).toBe(false);
    expect(new ConnectionClosedError({ message: 'm', gaveUp: false }).message).toBe('m');
  });

  test('TimeoutError: timer and timeout kept; the default message names both', () => {
    for (const timer of ['connect', 'handshake', 'request', 'liveness', 'call'] as const) {
      const error = new TimeoutError({ timer, timeout: 1234 });
      expect(error).toMatchObject({ timer, timeout: 1234 });
      expect(error.message).toBe(`The ${timer} timeout of 1234 ms expired`);
    }
    expect(new TimeoutError({ timer: 'call', timeout: 5, message: 'x' }).message).toBe('x');
  });

  test('AbortError: message = init.message, else a non-empty details.message, else reason; details default {}', () => {
    const bare = new AbortError({ reason: 'wamp.error.no_such_realm' });
    expect(bare.message).toBe('wamp.error.no_such_realm');
    expect(bare.reason).toBe('wamp.error.no_such_realm');
    expect(bare.details).toEqual({});
    const details = { message: 'Realm does not exist' };
    const withText = new AbortError({ reason: 'wamp.error.no_such_realm', details });
    expect(withText.message).toBe('Realm does not exist');
    expect(withText.details).toBe(details);
    expect(new AbortError({ reason: 'r', details: { message: '' } }).message).toBe('r');
    expect(new AbortError({ reason: 'r', details: { message: 42 } }).message).toBe('r');
    expect(new AbortError({ reason: 'r', details, message: 'explicit' }).message).toBe('explicit');
  });

  test('ProtocolError: frame kept up to 256 chars, cut with … beyond, never splitting a surrogate pair', () => {
    expect(PROTOCOL_FRAME_LIMIT).toBe(256);
    const short = 'x'.repeat(256);
    expect(new ProtocolError({ message: 'm', frame: short }).frame).toBe(short);
    const long = new ProtocolError({ message: 'm', frame: 'y'.repeat(10000) }).frame!;
    expect(long).toHaveLength(256);
    expect(long.endsWith('…')).toBe(true);
    const pairAtCut = `${'a'.repeat(254)}😀tail`; // the emoji occupies 254–255; the cut is at 255
    const cut = new ProtocolError({ message: 'm', frame: pairAtCut }).frame!;
    expect(cut).toBe(`${'a'.repeat(254)}…`);
    expect('frame' in new ProtocolError({ message: 'm' })).toBe(false);
    expect('frame' in new ProtocolError({ message: 'm', frame: [1, 2] as unknown as string })).toBe(false);
  });

  test('CanceledError: init optional', () => {
    expect(new CanceledError().message).toBe('The operation was canceled');
    expect(new CanceledError({ message: 'superseded', requestId: 3, procedure: 'p' })).toMatchObject({
      message: 'superseded',
      requestId: 3,
      procedure: 'p',
    });
  });

  test('AuthenticationError: authMethod and cause', () => {
    const cause = new TypeError('handler failed');
    const error = new AuthenticationError({
      message: 'challenge handler failed',
      authMethod: 'wampcra',
      cause,
      attempt: 2,
    });
    expect(error).toMatchObject({ message: 'challenge handler failed', authMethod: 'wampcra', attempt: 2 });
    expect(error.cause).toBe(cause);
    expect('authMethod' in new AuthenticationError({ message: 'm' })).toBe(false);
  });

  test('JavaScript callers may omit the init of every constructor', () => {
    const loose = (ctor: unknown): ThruwayError => new (ctor as new () => ThruwayError)();
    expect(loose(ConnectionLostError).message).toBe('The connection was lost');
    expect((loose(ConnectionClosedError) as ConnectionClosedError).gaveUp).toBe(false);
    expect(loose(TimeoutError).code).toBe('timeout');
    expect(loose(AbortError).message).toBe('undefined');
    expect(loose(ProtocolError).message).toBe('Protocol violation');
    expect(loose(AuthenticationError).message).toBe('Authentication failed');
  });
});

describe('guards', () => {
  test('true for branded values from another copy (Symbol.for brand, any known code)', () => {
    for (const [, code] of samples) {
      const foreign = Object.defineProperty(new Error('x'), BRAND, { value: code });
      expect(isThruwayError(foreign)).toBe(true);
      expect(isWampError(Object.assign(foreign, { code }))).toBe(code === 'wamp_error');
    }
  });

  test('false for duck-typed look-alikes, unknown brand values and non-objects', () => {
    const lookalike = Object.assign(new Error('wamp.error.x'), { name: 'WampError', code: 'wamp_error', uri: 'x' });
    expect(isThruwayError(lookalike)).toBe(false);
    expect(isWampError(lookalike)).toBe(false);
    for (const brand of ['nope', 'toString', '__proto__', 'constructor', 1, true, null, undefined, {}]) {
      expect(isThruwayError({ [BRAND]: brand })).toBe(false);
    }
    for (const value of [undefined, null, 0, 'wamp_error', Symbol('x'), true, new Error('x'), [], () => 1]) {
      expect(isThruwayError(value)).toBe(false);
      expect(isWampError(value)).toBe(false);
    }
  });

  test('isWampError needs the wamp_error brand and code', () => {
    const changed = new WampError('x');
    (changed as unknown as { code: string }).code = 'other';
    expect(isThruwayError(changed)).toBe(true);
    expect(isWampError(changed)).toBe(false);
    expect(isWampError({ [BRAND]: 'wamp_error' })).toBe(false);
    expect(isWampError({ [BRAND]: 'wamp_error', code: 'wamp_error' })).toBe(true);
    expect(isWampError(new ConnectionLostError({}))).toBe(false);
  });

  test('never throw: throwing getters, hostile and revoked Proxies, functions', () => {
    const throwing = Object.defineProperty({}, BRAND, {
      get() {
        throw new Error('boom');
      },
    });
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const value of [throwing, hostile, revoked]) {
      expect(isThruwayError(value)).toBe(false);
      expect(isWampError(value)).toBe(false);
    }
    const branded = Object.assign(() => 1, { [BRAND]: 'timeout' });
    expect(isThruwayError(branded)).toBe(true);
  });

  test('property: arbitrary values are never recognised and never throw', () => {
    fc.assert(
      fc.property(
        fc.anything({ withMap: true, withSet: true, withTypedArray: true, withSparseArray: true }),
        (value) => {
          expect(isThruwayError(value)).toBe(false);
          expect(isWampError(value)).toBe(false);
        },
      ),
    );
  });
});

describe('truncateText', () => {
  test('property: at most limit chars, a prefix of the text, never ending in half a surrogate pair', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), fc.integer({ min: 1, max: 600 }), (text, limit) => {
        const out = truncateText(text, limit);
        expect(out.length).toBeLessThanOrEqual(limit);
        if (text.length <= limit) {
          expect(out).toBe(text);
          return;
        }
        expect(out.endsWith('…')).toBe(true);
        const kept = out.slice(0, -1);
        expect(text.startsWith(kept)).toBe(true);
        const last = kept.charCodeAt(kept.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }),
    );
  });

  test('limit below 1 gives the empty string', () => {
    expect(truncateText('abc', 0)).toBe('');
    expect(truncateText('', 0)).toBe('');
  });
});
