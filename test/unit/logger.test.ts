// Logging: safeLog's containment and its single console.error fallback, the default logger, lazy entries (never built
// without a custom logger), frame entries (byte length + redacted preview ≤ 512 chars, never the frame object) and
// every redaction rule.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  createLogTarget,
  defaultLogger,
  describeError,
  eager,
  FRAME_PREVIEW_LIMIT,
  frameEntry,
  framePreview,
  REDACTED,
  redactFrame,
  redactUrl,
  safeLog,
  safeLogLazy,
  unhandledEntry,
  type LogTarget,
} from '../../src/logger.js';
import type { LogEntry } from '../../src/types.js';

const entry = (level: LogEntry['level'] = 'debug', event = 'frame.in'): LogEntry => ({ level, event, message: 'm' });

let consoleError: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

/** Run `fn` with `globalThis.console` replaced (restored before returning). */
function withConsole(replacement: unknown, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'console')!;
  Object.defineProperty(globalThis, 'console', { value: replacement, configurable: true, writable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, 'console', original);
  }
}

/** Every object reachable from `root` (own enumerable string keys). */
function reachable(root: unknown, into = new Set<object>()): Set<object> {
  if ((typeof root === 'object' || typeof root === 'function') && root !== null && !into.has(root)) {
    into.add(root);
    for (const key of Object.keys(root)) reachable((root as Record<string, unknown>)[key], into);
  }
  return into;
}

describe('createLogTarget', () => {
  test('no logger: the default logger, not custom; a function: custom', () => {
    expect(createLogTarget(undefined)).toEqual({ logger: defaultLogger, custom: false, fallbackUsed: false });
    const logger = (): void => undefined;
    expect(createLogTarget(logger)).toEqual({ logger, custom: true, fallbackUsed: false });
  });

  test('a non-function (unvalidated JavaScript input) falls back to the default logger', () => {
    const target = createLogTarget('nope' as unknown as () => void);
    expect(target.logger).toBe(defaultLogger);
    expect(target.custom).toBe(false);
  });
});

describe('safeLog', () => {
  test('calls the logger once with the entry, without a `this`', () => {
    const calls: unknown[] = [];
    const target = createLogTarget(function (this: unknown, e) {
      calls.push(this, e);
    });
    const e = entry();
    safeLog(target, e);
    expect(calls).toEqual([undefined, e]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('a throwing logger: one console.error fallback, later throws swallowed, never re-logged or rethrown', () => {
    const failure = new Error('logger broke');
    const logger = vi.fn(() => {
      throw failure;
    });
    const target = createLogTarget(logger);
    for (let i = 0; i < 5; i++)
      expect(() => {
        safeLog(target, entry('error', 'unhandled'));
      }).not.toThrow();
    expect(logger).toHaveBeenCalledTimes(5); // once per entry, never for its own failure
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('thruway.js: logger threw', failure);
    expect(target.fallbackUsed).toBe(true);
  });

  test('the fallback is per client (per target)', () => {
    const throwing = (): void => {
      throw new Error('x');
    };
    const a = createLogTarget(throwing);
    const b = createLogTarget(throwing);
    safeLog(a, entry());
    safeLog(a, entry());
    safeLog(b, entry());
    safeLog(b, entry());
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  test('a logger that recovers keeps receiving entries', () => {
    let fail = true;
    const seen: LogEntry[] = [];
    const target = createLogTarget((e) => {
      if (fail) throw new Error('once');
      seen.push(e);
    });
    safeLog(target, entry());
    fail = false;
    const e = entry('info');
    safeLog(target, e);
    expect(seen).toEqual([e]);
  });

  test('fallback skipped when console.error is not a function, or console is missing; a throwing console.error is swallowed', () => {
    const throwing = (): void => {
      throw new Error('x');
    };
    for (const replacement of [{ error: 'not a function' }, {}, undefined, null, 42]) {
      withConsole(replacement, () => {
        const target = createLogTarget(throwing);
        expect(() => {
          safeLog(target, entry());
        }).not.toThrow();
        expect(target.fallbackUsed).toBe(true);
      });
    }
    const explodingConsole = {
      error: () => {
        throw new Error('console broke');
      },
    };
    withConsole(explodingConsole, () => {
      const target = createLogTarget(throwing);
      expect(() => {
        safeLog(target, entry());
      }).not.toThrow();
      expect(() => {
        safeLog(target, entry());
      }).not.toThrow();
    });
    const getterConsole = Object.defineProperty({}, 'error', {
      get() {
        throw new Error('getter');
      },
    });
    withConsole(getterConsole, () => {
      expect(() => {
        safeLog(createLogTarget(throwing), entry());
      }).not.toThrow();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('the default logger with a throwing console.error never escapes', () => {
    consoleError.mockImplementation(() => {
      throw new Error('console broke');
    });
    const target = createLogTarget(undefined);
    expect(() => {
      safeLog(target, entry('error'));
    }).not.toThrow();
    expect(() => {
      safeLog(target, entry('error'));
    }).not.toThrow();
  });

  test('property: whatever the logger throws, safeLog never throws, the logger sees each entry once, ≤ 1 fallback', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.anything(), { nil: undefined }), { maxLength: 20 }), (throws) => {
        consoleError.mockClear();
        let call = 0;
        const target = createLogTarget(() => {
          const thrown = throws[call++];
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- loggers may throw anything
          if (thrown !== undefined) throw thrown;
        });
        throws.forEach(() => {
          safeLog(target, entry());
        });
        expect(call).toBe(throws.length);
        expect(consoleError.mock.calls.length).toBe(throws.some((t) => t !== undefined) ? 1 : 0);
      }),
    );
  });
});

describe('defaultLogger', () => {
  test('prints only level error, prefixed, with data.error (else data) as the second argument', () => {
    for (const level of ['debug', 'info', 'warn'] as const) defaultLogger({ level, event: 'x', message: 'quiet' });
    expect(consoleError).not.toHaveBeenCalled();
    const error = new TypeError('boom');
    defaultLogger({ level: 'error', event: 'unhandled', message: 'loud', data: { error, context: 'next' } });
    defaultLogger({ level: 'error', event: 'internal', message: 'with data', data: { x: 1 } });
    defaultLogger({ level: 'error', event: 'internal', message: 'bare' });
    expect(consoleError.mock.calls).toEqual([
      ['thruway.js: loud', error],
      ['thruway.js: with data', { x: 1 }],
      ['thruway.js: bare'],
    ]);
  });

  test('does nothing (and does not throw) when console.error is not a function', () => {
    withConsole({ error: 1 }, () => {
      expect(() => {
        defaultLogger(entry('error'));
      }).not.toThrow();
    });
  });
});

describe('safeLogLazy (Effects.log)', () => {
  test('default logger: the builder is never called', () => {
    const build = vi.fn(() => entry('error'));
    safeLogLazy(createLogTarget(undefined), build);
    expect(build).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('custom logger: built once and logged', () => {
    const seen: LogEntry[] = [];
    const e = entry('warn');
    const build = vi.fn(() => e);
    safeLogLazy(
      createLogTarget((x) => seen.push(x)),
      build,
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([e]);
  });

  test('eager entries reach the default logger (printed when level error) and custom loggers', () => {
    const error = new Error('handler result invalid');
    const unhandled = unhandledEntry(error, 'invocation handler');
    safeLogLazy(createLogTarget(undefined), eager(unhandled));
    safeLogLazy(createLogTarget(undefined), eager(entry('debug')));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(`thruway.js: ${unhandled.message}`, error);
    const seen: LogEntry[] = [];
    safeLogLazy(
      createLogTarget((x) => seen.push(x)),
      eager(unhandled),
    );
    expect(seen).toEqual([unhandled]);
  });

  test('a throwing builder becomes an internal entry; nothing escapes, even with a throwing logger', () => {
    const failure = new Error('bug in an entry');
    const seen: LogEntry[] = [];
    safeLogLazy(
      createLogTarget((x) => seen.push(x)),
      () => {
        throw failure;
      },
    );
    expect(seen).toEqual([
      { level: 'error', event: 'internal', message: 'a log entry could not be built', data: { error: failure } },
    ]);
    const throwingLogger = createLogTarget(() => {
      throw new Error('logger');
    });
    expect(() => {
      safeLogLazy(throwingLogger, () => {
        throw failure;
      });
    }).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('frame entries are never built without a custom logger (the frame is not even read)', () => {
    let reads = 0;
    const frame = new Proxy([48, 1, {}, 'com.app.proc', ['secret']], {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    safeLogLazy(createLogTarget(undefined), () => frameEntry('out', frame, 40));
    expect(reads).toBe(0);
    const seen: LogEntry[] = [];
    safeLogLazy(
      createLogTarget((x) => seen.push(x)),
      () => frameEntry('out', frame, 40),
    );
    expect(reads).toBeGreaterThan(0);
    expect(seen[0]?.event).toBe('frame.out');
  });
});

describe('unhandledEntry and describeError', () => {
  test('shape: level error, event unhandled, message with context and error text, data holds the error', () => {
    const error = new TypeError('boom');
    expect(unhandledEntry(error, 'topic observer')).toEqual({
      level: 'error',
      event: 'unhandled',
      message: 'unhandled error in topic observer: TypeError: boom',
      data: { error, context: 'topic observer' },
    });
  });

  test('never throws: throwing message getter, null prototype, hostile Proxy, symbols, primitives', () => {
    const throwingMessage = Object.defineProperty(new Error('x'), 'message', {
      get() {
        throw new Error('getter');
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
    expect(describeError(throwingMessage)).toBe('[unprintable value]');
    expect(describeError(Object.create(null))).toBe('[unprintable value]');
    expect(describeError(hostile)).toBe('[unprintable value]');
    expect(describeError(Symbol('s'))).toBe('Symbol(s)');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(42)).toBe('42');
    expect(describeError({ message: 'plain' })).toBe('plain');
    expect(describeError({ name: '', message: 'unnamed' })).toBe('unnamed');
    expect(unhandledEntry(throwingMessage, 'next').message).toBe('unhandled error in next: [unprintable value]');
  });

  test('a huge message is cut to 512 characters in the entry message', () => {
    const e = unhandledEntry(new Error('x'.repeat(100000)), 'c');
    expect(e.message.length).toBeLessThanOrEqual('unhandled error in c: '.length + FRAME_PREVIEW_LIMIT);
  });

  test('a cut message or frame preview never ends in half a surrogate pair', () => {
    const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
    for (let pad = 0; pad < 4; pad++) {
      const text = `${'x'.repeat(pad)}${'\u{1F600}'.repeat(400)}`;
      for (const out of [unhandledEntry(new Error(text), 'c').message, framePreview(text), framePreview([8, text])]) {
        expect(out.endsWith('…')).toBe(true);
        expect(isHighSurrogate(out.charCodeAt(out.length - 2))).toBe(false);
      }
    }
  });

  test('property: any thrown value gives an error entry without throwing', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withBigInt: true }), (value) => {
        const e = unhandledEntry(value, 'ctx');
        expect(e.level).toBe('error');
        expect(e.event).toBe('unhandled');
        expect(typeof e.message).toBe('string');
      }),
    );
  });
});

describe('frameEntry', () => {
  test('event, level, message and data fields', () => {
    expect(frameEntry('out', [1, 'realm1', {}], 17)).toEqual({
      level: 'debug',
      event: 'frame.out',
      message: 'sent HELLO (17 bytes)',
      data: { bytes: 17, preview: '[1,"realm1",{}]' },
    });
    const welcome = frameEntry('in', [2, 99, {}], 11);
    expect(welcome.event).toBe('frame.in');
    expect(welcome.message).toBe('received WELCOME (11 bytes)');
    expect(frameEntry('in', [99], 4).message).toBe('received #99 (4 bytes)');
    expect(frameEntry('in', ['x'], 5).message).toBe('received frame (5 bytes)');
    expect(frameEntry('in', 'garbage', 7).message).toBe('received frame (7 bytes)');
  });

  test('never holds the frame object: data holds only the byte length and a string preview', () => {
    const args = [{ deep: { deeper: [1, 2, 3] } }];
    const frame = [48, 7, { receive_progress: true }, 'com.app.proc', args, { k: { v: 1 } }];
    const e = frameEntry('out', frame, 80);
    expect(Object.keys(e.data!)).toEqual(['bytes', 'preview']);
    expect(typeof e.data!['bytes']).toBe('number');
    expect(typeof e.data!['preview']).toBe('string');
    const frameObjects = reachable(frame);
    for (const object of reachable(e)) expect(frameObjects.has(object)).toBe(false);
  });

  test('preview ≤ 512 characters and bounded work for huge frames', () => {
    let reads = 0;
    const items = new Proxy(new Array<number>(1000000).fill(7), {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const e = frameEntry('out', [16, 1, {}, 'com.app.topic', items, { blob: 'z'.repeat(5000000) }], 9999999);
    const preview = e.data!['preview'] as string;
    expect(preview.length).toBeLessThanOrEqual(FRAME_PREVIEW_LIMIT);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.startsWith('[16,1,{},"com.app.topic",[7,7,')).toBe(true);
    expect(reads).toBeLessThan(2 * FRAME_PREVIEW_LIMIT);
    const longString = framePreview([36, 1, 2, {}, ['q'.repeat(100000)]]);
    expect(longString.length).toBeLessThanOrEqual(FRAME_PREVIEW_LIMIT);
    const deep = framePreview([1, JSON.parse(`${'['.repeat(5000)}${']'.repeat(5000)}`)]);
    expect(deep.length).toBeLessThanOrEqual(FRAME_PREVIEW_LIMIT);
  });

  test('does not mutate the frame (deep-frozen input)', () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
        Object.freeze(value);
      }
      return value;
    };
    const frame = deepFreeze([
      2,
      5,
      { authextra: { pubkey: 'P', secret: 'S' }, transport: { headers: { cookie: 'c' }, cookies: { a: 'b' } } },
    ]);
    const before = JSON.stringify(frame);
    expect(() => frameEntry('in', frame, 1)).not.toThrow();
    expect(() => redactFrame(frame)).not.toThrow();
    expect(JSON.stringify(frame)).toBe(before);
  });

  test('values that JSON cannot show: undefined, NaN, Infinity, BigInt, functions, symbols, cycles, binary', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const preview = framePreview([
      50,
      1,
      {},
      [undefined, Number.NaN, -Infinity, 10n, () => 1, Symbol('s'), cyclic, new Uint8Array(3), new ArrayBuffer(5)],
    ]);
    expect(preview).toBe(
      '[50,1,{},[undefined,NaN,-Infinity,10n,[function],Symbol(s),{"a":1,"self":[circular]},[binary 3 bytes],[binary 5 bytes]]]',
    );
    // a shared (non-cyclic) object is shown each time it appears
    const shared = { s: 1 };
    expect(framePreview([36, 1, 2, {}, [shared, shared]])).toBe('[36,1,2,{},[{"s":1},{"s":1}]]');
  });

  test('text frames: a JSON array is parsed and redacted; other text is shown raw, cut to 512', () => {
    const text = JSON.stringify([5, 'SIGNATURE-123', {}]);
    expect(framePreview(text)).toBe(`[5,"${REDACTED}",{}]`);
    expect(frameEntry('out', text, text.length).message).toBe(`sent AUTHENTICATE (${String(text.length)} bytes)`);
    expect(framePreview('  [2, 1, {"authextra": {"t": "SECRET"}}]')).not.toContain('SECRET');
    expect(framePreview('not json')).toBe('not json');
    expect(framePreview('[broken')).toBe('[broken');
    expect(framePreview('{"a":1}')).toBe('{"a":1}');
    expect(framePreview('x'.repeat(2000))).toHaveLength(FRAME_PREVIEW_LIMIT);
  });

  test('binary and other non-array frames: no content', () => {
    expect(framePreview(new Uint8Array(12))).toBe('[binary 12 bytes]');
    expect(framePreview(new ArrayBuffer(4))).toBe('[binary 4 bytes]');
    expect(framePreview(new DataView(new ArrayBuffer(2)))).toBe('[binary 2 bytes]');
    expect(framePreview({ type: 2, details: { authextra: { secret: 'S' } } })).toBe('[object]');
    expect(framePreview(null)).toBe('[null]');
    expect(framePreview(undefined)).toBe('[undefined]');
    expect(framePreview(42)).toBe('[number]');
  });

  test('unreadable frames (throwing getters, revoked Proxies) never throw', () => {
    const throwing = [
      48,
      1,
      {},
      'p',
      [
        Object.defineProperty({}, 'x', {
          enumerable: true,
          get: () => {
            throw new Error('getter');
          },
        }),
      ],
    ];
    expect(framePreview(throwing)).toBe('[unreadable frame]');
    const { proxy, revoke } = Proxy.revocable<unknown[]>([], {});
    revoke();
    expect(framePreview(proxy)).toBe('[unreadable frame]');
    expect(frameEntry('in', proxy, 3).data).toEqual({ bytes: 3, preview: '[unreadable frame]' });
  });

  test('property: any frame gives a debug entry with a preview ≤ 512 chars, without throwing', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(
            fc.anything({ withBigInt: true, withTypedArray: true, withSparseArray: true, withNullPrototype: true }),
          ),
          fc.anything(),
          fc.string({ unit: 'binary' }),
        ),
        fc.nat(),
        fc.constantFrom('in' as const, 'out' as const),
        (frame, bytes, direction) => {
          const e = frameEntry(direction, frame, bytes);
          expect(e.level).toBe('debug');
          expect(e.data!['bytes']).toBe(bytes);
          expect((e.data!['preview'] as string).length).toBeLessThanOrEqual(FRAME_PREVIEW_LIMIT);
        },
      ),
    );
  });
});

describe('redactFrame', () => {
  test('AUTHENTICATE: the signature', () => {
    const frame = [5, 'c2lnbmF0dXJl', {}];
    expect(redactFrame(frame)).toEqual([5, REDACTED, {}]);
    expect(framePreview(frame)).not.toContain('c2lnbmF0dXJl');
    expect(redactFrame([5])).toEqual([5]);
  });

  test('HELLO: authextra values except pubkey; everything else kept', () => {
    const details = {
      roles: { caller: {} },
      authmethods: ['ticket', 'cryptosign'],
      authid: 'joe',
      authextra: { pubkey: 'ab'.repeat(16), ticket: 'T0KEN', nested: { secret: 'N3STED' }, list: ['L1ST'] },
    };
    const redacted = redactFrame([1, 'realm1', details]);
    expect(redacted).toEqual([
      1,
      'realm1',
      {
        roles: { caller: {} },
        authmethods: ['ticket', 'cryptosign'],
        authid: 'joe',
        authextra: { pubkey: 'ab'.repeat(16), ticket: REDACTED, nested: REDACTED, list: REDACTED },
      },
    ]);
    const preview = framePreview([1, 'realm1', details]);
    for (const secret of ['T0KEN', 'N3STED', 'L1ST']) expect(preview).not.toContain(secret);
    expect(preview).toContain('ab'.repeat(16));
    expect(redactFrame([1, 'realm1', { authid: 'joe' }])).toEqual([1, 'realm1', { authid: 'joe' }]);
  });

  test('CHALLENGE: extra values except pubkey (wampcra and cryptosign)', () => {
    const cra = [4, 'wampcra', { challenge: '{"nonce":"N0NCE"}', salt: 'SALT', keylen: 32, iterations: 1000 }];
    expect(redactFrame(cra)).toEqual([
      4,
      'wampcra',
      { challenge: REDACTED, salt: REDACTED, keylen: REDACTED, iterations: REDACTED },
    ]);
    const cs = [4, 'cryptosign', { challenge: 'fa'.repeat(32), pubkey: 'PUBKEY', channel_binding: null }];
    expect(redactFrame(cs)).toEqual([
      4,
      'cryptosign',
      { challenge: REDACTED, pubkey: 'PUBKEY', channel_binding: REDACTED },
    ]);
    expect(redactFrame([4, 'ticket'])).toEqual([4, 'ticket']);
    expect(redactFrame([4, 'ticket', undefined])).toEqual([4, 'ticket', undefined]);
  });

  test('WELCOME: authextra (pubkey kept) and transport headers/cookies/query_params values; keys kept', () => {
    const details = {
      authid: 'joe',
      authrole: 'user',
      authextra: { pubkey: 'PK', session_token: 'S3SSION' },
      transport: {
        type: 'websocket',
        peer: 'tcp4:127.0.0.1:50000',
        headers: { authorization: 'Bearer H3ADER', cookie: 'sid=C00KIE', host: 'example.org' },
        cookies: { sid: 'C00KIE' },
        query_params: { token: ['QU3RY'] },
      },
    };
    expect(redactFrame([2, 12345, details])).toEqual([
      2,
      12345,
      {
        authid: 'joe',
        authrole: 'user',
        authextra: { pubkey: 'PK', session_token: REDACTED },
        transport: {
          type: 'websocket',
          peer: 'tcp4:127.0.0.1:50000',
          headers: { authorization: REDACTED, cookie: REDACTED, host: REDACTED },
          cookies: { sid: REDACTED },
          query_params: { token: REDACTED },
        },
      },
    ]);
    const preview = framePreview([2, 12345, details]);
    for (const secret of ['S3SSION', 'H3ADER', 'C00KIE', 'QU3RY']) expect(preview).not.toContain(secret);
  });

  test('WELCOME: a non-dict transport field is replaced whole; absent or non-dict transport is fine', () => {
    expect(redactFrame([2, 1, { transport: { headers: 'Authorization: x', cookies: 'a=b' } }])).toEqual([
      2,
      1,
      { transport: { headers: REDACTED, cookies: REDACTED } },
    ]);
    expect(redactFrame([2, 1, { transport: 'ws' }])).toEqual([2, 1, { transport: 'ws' }]);
    expect(redactFrame([2, 1, { authid: 'a' }])).toEqual([2, 1, { authid: 'a' }]);
    expect(redactFrame([2, 1])).toEqual([2, 1]);
    expect(redactFrame([2, 1, 'not a dict'])).toEqual([2, 1, 'not a dict']);
  });

  test('a non-dict authextra is replaced whole', () => {
    expect(redactFrame([1, 'r', { authextra: 'T0KEN' }])).toEqual([1, 'r', { authextra: REDACTED }]);
    expect(redactFrame([2, 1, { authextra: ['T0KEN'] }])).toEqual([2, 1, { authextra: REDACTED }]);
    expect(redactFrame([4, 'm', 'T0KEN'])).toEqual([4, 'm', REDACTED]);
  });

  test('a __proto__ key (from JSON.parse) is redacted and kept as a key', () => {
    const frame = JSON.parse('[1,"r",{"authextra":{"__proto__":"PR0TO","pubkey":"k"}}]') as unknown[];
    const preview = framePreview(frame);
    expect(preview).not.toContain('PR0TO');
    expect(preview).toContain(`"__proto__":"${REDACTED}"`);
  });

  test('other message types are copied unchanged; the result is a copy', () => {
    const call = [48, 1, {}, 'com.app.login', ['user', 'password-is-app-data'], { authextra: 'app payload' }];
    const copy = redactFrame(call);
    expect(copy).toEqual(call);
    expect(copy).not.toBe(call);
    for (const frame of [[], [3, {}, 'wamp.error.x'], ['x', 1], [6, {}, 'wamp.close.normal']]) {
      expect(redactFrame(frame)).toEqual(frame);
    }
  });

  test('property: a secret in any redacted position never shows in the preview; pubkey always does', () => {
    const marker = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `☃${s}☃`);
    const key = fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== 'pubkey');
    fc.assert(
      fc.property(
        marker,
        key,
        fc.constantFrom('hello', 'welcome', 'welcome-transport', 'challenge', 'authenticate'),
        (secret, name, where) => {
          const pubkey = 'PUBKEY';
          const frame =
            where === 'hello'
              ? [1, 'realm1', { authextra: { [name]: secret, pubkey } }]
              : where === 'welcome'
                ? [2, 1, { authextra: { [name]: { inner: secret }, pubkey } }]
                : where === 'welcome-transport'
                  ? [
                      2,
                      1,
                      {
                        transport: {
                          headers: { [name]: secret },
                          cookies: { [name]: secret },
                          query_params: { [name]: [secret] },
                        },
                      },
                    ]
                  : where === 'challenge'
                    ? [4, 'cryptosign', { [name]: secret, pubkey }]
                    : [5, secret, {}];
          const preview = framePreview(frame);
          expect(preview).not.toContain('☃');
          expect(framePreview(JSON.stringify(frame))).not.toContain('☃');
          if (where === 'hello' || where === 'welcome' || where === 'challenge') expect(preview).toContain(pubkey);
        },
      ),
    );
  });
});

describe('redactUrl', () => {
  test.each([
    ['ws://127.0.0.1:18080/ws', 'ws://127.0.0.1:18080/ws'],
    ['wss://example.org/ws?ticket=SECRET&x=1', 'wss://example.org/ws?…'],
    ['wss://example.org/?', 'wss://example.org/?…'],
    ['wss://example.org/ws#frag', 'wss://example.org/ws#…'],
    ['wss://example.org/ws?a=1#frag', 'wss://example.org/ws?…#…'],
    ['wss://example.org/ws#frag?not-a-query', 'wss://example.org/ws#…'],
    ['wss://user:pa55@example.org/ws', 'wss://…@example.org/ws'],
    ['wss://user:p@ss@example.org:443/ws?t=1', 'wss://…@example.org:443/ws?…'],
    ['wss://example.org/path@with-at', 'wss://example.org/path@with-at'],
    ['WSS://u@HOST/x', 'WSS://…@HOST/x'],
    ['', ''],
    ['relative/path?q=1', 'relative/path?…'],
  ])('%s → %s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  test('property: nothing after ? or # and no user info survives', () => {
    const part = fc.string({ maxLength: 20 }).map((s) => s.replace(/[?#@/]/g, ''));
    fc.assert(
      fc.property(part, part, fc.string({ minLength: 1 }), fc.boolean(), (host, path, secret, userinfo) => {
        const url = `wss://${userinfo ? `${secret.replace(/[/?#]/g, '')}x@` : ''}${host}/${path}?q=${secret}#${secret}`;
        const out = redactUrl(url);
        expect(out).toBe(`wss://${userinfo ? '…@' : ''}${host}/${path}?…#…`);
      }),
    );
  });
});

// LogTarget is the per-client state the core holds; its shape is part of the logger contract.
test('LogTarget fallbackUsed is the only mutable field', () => {
  const target: LogTarget = createLogTarget(undefined);
  target.fallbackUsed = true;
  expect(target.fallbackUsed).toBe(true);
});
