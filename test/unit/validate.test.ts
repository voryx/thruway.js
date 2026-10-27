// validate.ts: every spec-typed key, the router-specific keys Crossbar type-checks, the rejected keys (CALL `progress`,
// `ppt_*`, REGISTER `forward_timeout`), args/kwargs/options shapes, hostile app objects (revoked Proxy, throwing
// getter, cyclic options, BigInt), key normalisation ({} ≡ {match:'exact'}), snapshots that are frozen shallow copies
// of app objects that are never mutated, `undefined` values dropped.
import { fc } from '@fast-check/vitest';
import { describe, expect, test } from 'vitest';
import { isWampError, type WampError } from '../../src/errors.js';
import {
  snapshotCall,
  snapshotProgressiveCall,
  snapshotPublish,
  snapshotRegister,
  snapshotTopic,
} from '../../src/validate.js';
import { replayParameters } from '../setup-fast-check.js';

type Op = 'call' | 'publish' | 'topic' | 'register';
const OPS: readonly Op[] = ['call', 'publish', 'topic', 'register'];
const handler = (): unknown => 1;

/** Snapshot `options` for `op` with valid other arguments. */
function withOptions(
  op: Op,
  options: unknown,
  uri = 'com.example.x',
): { readonly options: Readonly<Record<string, unknown>> } {
  switch (op) {
    case 'call':
      return snapshotCall(uri, [1], { k: 1 }, options);
    case 'publish':
      return snapshotPublish(uri, [1], { k: 1 }, options);
    case 'topic':
      return snapshotTopic(uri, options);
    case 'register':
      return snapshotRegister(uri, handler, options);
  }
}

function uriOf(op: Op, uri: unknown, options?: unknown): unknown {
  switch (op) {
    case 'call':
      return snapshotCall(uri, undefined, undefined, options).procedure;
    case 'publish':
      return snapshotPublish(uri, undefined, undefined, options).topic;
    case 'topic':
      return snapshotTopic(uri, options).topic;
    case 'register':
      return snapshotRegister(uri, handler, options).procedure;
  }
}

function invalidUri(op: Op, uri: unknown, options?: unknown): WampError {
  try {
    uriOf(op, uri, options);
  } catch (error) {
    expect(isWampError(error)).toBe(true);
    return error as WampError;
  }
  throw new Error(`${op}(${JSON.stringify(uri)}) was accepted`);
}

describe('spec-typed option keys, for every op', () => {
  const booleans = [
    'receive_progress',
    'acknowledge',
    'disclose_me',
    'disclose_caller',
    'exclude_me',
    'retain',
    'get_retained',
    'force_reregister',
  ];
  const cases: { key: string; good: unknown[]; bad: unknown[] }[] = [
    ...booleans.map((key) => ({ key, good: [true, false], bad: ['true', 1, 0, null, {}, [], 'false'] })),
    { key: 'timeout', good: [0, 1, 5000, 2 ** 53 - 1], bad: [-1, 1.5, NaN, Infinity, '100', 2 ** 53, 1n, null, true] },
    ...['exclude', 'eligible'].map((key) => ({
      key,
      good: [[], [1], [0, 2 ** 53]],
      bad: [1, 'x', {}, [-1], [1.5], ['1'], [null], [2 ** 53 + 2], null],
    })),
    ...['exclude_authid', 'exclude_authrole', 'eligible_authid', 'eligible_authrole'].map((key) => ({
      key,
      good: [[], ['a'], ['', 'b']],
      bad: ['a', [1], [null], [['a']], {}, null],
    })),
    {
      key: 'match',
      good: ['exact', 'prefix', 'wildcard', '_mqtt', '_abc', '_a_1'],
      bad: ['regex', '', 'EXACT', 'Prefix', '_ab', '_A_B', '_a-b', 'exact ', 1, null, true, ['_abc'], ['exact']],
    },
    {
      key: 'invoke',
      good: ['single', 'roundrobin', 'random', 'first', 'last', '_thruway'],
      bad: ['sometimes', 'Single', '', '_x', 2, null, ['_thruway'], { toString: () => '_thruway' }],
    },
  ];

  for (const { key, good, bad } of cases) {
    for (const op of OPS) {
      test(`${op}: ${key}`, () => {
        for (const value of good) {
          // an empty prefix/wildcard URI is still a valid topic, so the default URI fits every policy
          expect(withOptions(op, { [key]: value }).options[key]).toEqual(value);
        }
        for (const value of bad) {
          expect(() => withOptions(op, { [key]: value })).toThrow(TypeError);
          expect(() => withOptions(op, { [key]: value })).toThrow(`${op}: options.${key} must be `);
        }
      });
    }
  }

  test('the error message says what is expected', () => {
    expect(() => withOptions('call', { acknowledge: 1 })).toThrow('call: options.acknowledge must be a boolean');
    expect(() => withOptions('publish', { exclude: [-1] })).toThrow('publish: options.exclude must be an array of ids');
    expect(() => withOptions('publish', { eligible_authrole: [1] })).toThrow(
      'publish: options.eligible_authrole must be an array of strings',
    );
    expect(() => withOptions('topic', { match: 'regex' })).toThrow(
      'topic: options.match must be one of exact, prefix, wildcard or an implementation-specific value matching ^_[a-z0-9_]{3,}$',
    );
    expect(() => withOptions('call', { timeout: 1.5 })).toThrow(
      'call: options.timeout must be a non-negative safe integer (milliseconds)',
    );
    expect(() => withOptions('register', { invoke: 'sometimes' })).toThrow(
      'register: options.invoke must be one of single, roundrobin, random, first, last or an implementation-specific value matching ^_[a-z0-9_]{3,}$',
    );
  });

  test('router-specific keys pass through untouched (Thruway, Crossbar, fox-wamp)', () => {
    const thruway = {
      replace_orphaned_session: 'yes',
      thruway_multiregister: true,
      _thruway_eligible_authids: ['a'],
      concurrency: 2,
      x_cb_whatever: { deep: [1] },
      progress: 'not a call option here',
    };
    expect(withOptions('register', thruway).options).toEqual(thruway);
    expect(withOptions('publish', { _thruway_eligible_authroles: ['admin'], retain: true }).options).toEqual({
      _thruway_eligible_authroles: ['admin'],
      retain: true,
    });
  });
});

// Crossbar 26.10 (autobahn 26.10.2 `message.py`, probed in the router image) closes the connection with 1002 when one of
// these router-specific keys has the wrong type, and with 1011 for a malformed forward_for principal (an assertion in
// the message constructor). One bad option must not kill every other stream.
describe('Crossbar-checked router-specific keys, for every op', () => {
  const principal = { session: 1, authid: 'joe', authrole: 'user' };
  const cases: { key: string; good: unknown[]; bad: unknown[] }[] = [
    {
      key: 'concurrency',
      good: [1, 2, 1000, 2 ** 53 - 1],
      bad: [0, -1, 1.5, NaN, Infinity, 1e21, 2 ** 53, '2', true, null, 1n, [1], {}],
    },
    { key: 'caller', good: [0, 1, 2 ** 53], bad: [-1, 1.5, NaN, 2 ** 53 + 2, '1', true, null, 1n, [1], {}] },
    ...['caller_authid', 'caller_authrole', 'transaction_hash'].map((key) => ({
      key,
      good: ['', 'a', '0x6b1f…', 'x'.repeat(1000)],
      bad: [1, 0, true, null, 1n, ['a'], {}, { toString: () => 'a' }],
    })),
    {
      key: 'forward_for',
      good: [
        [],
        [principal],
        [principal, { session: 2 ** 53, authid: '', authrole: '' }],
        [{ ...principal, session: 0, x_extra: [1], more: { deep: true } }],
      ],
      bad: [
        {},
        'x',
        null,
        principal,
        [1],
        ['x'],
        [null],
        [[principal]],
        [{ authid: 'a', authrole: 'r' }],
        [{ session: 1, authrole: 'r' }],
        [{ session: 1, authid: 'a' }],
        [{ ...principal, session: '1' }],
        [{ ...principal, session: true }],
        [{ ...principal, session: 1.5 }],
        [{ ...principal, session: -1 }],
        [{ ...principal, authid: null }],
        [{ ...principal, authid: undefined }],
        [{ ...principal, authid: 1 }],
        [{ ...principal, authrole: null }],
        [principal, { ...principal, authrole: ['user'] }],
        [
          new (class Principal {
            session = 1;
            authid = 'a';
            authrole = 'r';
          })(),
        ],
      ],
    },
  ];

  for (const { key, good, bad } of cases) {
    for (const op of OPS) {
      test(`${op}: ${key}`, () => {
        for (const value of good) expect(withOptions(op, { [key]: value }).options[key]).toEqual(value);
        for (const [i, value] of bad.entries()) {
          expect(() => withOptions(op, { [key]: value }), `bad[${String(i)}]`).toThrow(TypeError);
          expect(() => withOptions(op, { [key]: value })).toThrow(`${op}: options.${key} must be `);
        }
      });
    }
  }

  test('the error message says what is expected', () => {
    expect(() => withOptions('register', { concurrency: 0 })).toThrow(
      'register: options.concurrency must be a positive safe integer',
    );
    expect(() => withOptions('call', { caller: '1' })).toThrow('call: options.caller must be an id');
    expect(() => withOptions('call', { caller_authid: 1 })).toThrow('call: options.caller_authid must be a string');
    expect(() => withOptions('call', { caller_authrole: null })).toThrow(
      'call: options.caller_authrole must be a string',
    );
    expect(() => withOptions('publish', { transaction_hash: 7 })).toThrow(
      'publish: options.transaction_hash must be a string',
    );
    expect(() => withOptions('topic', { forward_for: [{ session: 1 }] })).toThrow(
      'topic: options.forward_for must be an array of {session: id, authid: string, authrole: string}',
    );
  });

  test('forward_for principals are copied and frozen too: what was validated is what is sent', () => {
    const mine = { session: 1, authid: 'joe', authrole: 'user', note: undefined };
    const list = [mine];
    const snap = snapshotCall('com.p', undefined, undefined, { forward_for: list });
    const sent = snap.options['forward_for'] as readonly Record<string, unknown>[];
    expect(sent).not.toBe(list);
    expect(sent[0]).not.toBe(mine);
    expect(sent).toEqual([{ session: 1, authid: 'joe', authrole: 'user' }]);
    expect(Object.keys(sent[0] ?? {})).toEqual(['session', 'authid', 'authrole']); // undefined values dropped
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent[0])).toBe(true);
    mine.authid = 42 as unknown as string;
    list.push('not a principal' as unknown as typeof mine);
    expect(sent).toEqual([{ session: 1, authid: 'joe', authrole: 'user' }]);
  });

  test('each property of a principal is read once; a throwing getter propagates its own error', () => {
    const reads: string[] = [];
    const counted = {
      get session() {
        reads.push('session');
        return 1;
      },
      get authid() {
        reads.push('authid');
        return 'a';
      },
      get authrole() {
        reads.push('authrole');
        return 'r';
      },
    };
    expect(withOptions('register', { forward_for: [counted] }).options['forward_for']).toEqual([
      { session: 1, authid: 'a', authrole: 'r' },
    ]);
    expect(reads).toEqual(['session', 'authid', 'authrole']);
    const boom = new Error('getter');
    const hostile = Object.defineProperty({ session: 1, authrole: 'r' }, 'authid', {
      enumerable: true,
      get() {
        throw boom;
      },
    });
    expect(() => withOptions('publish', { forward_for: [hostile] })).toThrow(boom);
  });

  test('the keys stay in the topic/registration key (a different concurrency is a different REGISTER)', () => {
    expect(snapshotRegister('p', handler, { concurrency: 1 }).key).not.toBe(
      snapshotRegister('p', handler, { concurrency: 2 }).key,
    );
    expect(snapshotRegister('p', handler, { concurrency: 2 }).key).toBe(
      snapshotRegister('p', handler, { concurrency: 2, force_reregister: false }).key,
    );
  });

  /** Crossbar's own rules after the JSON round trip (Python's int is a JSON number without fraction or exponent). */
  function crossbarAccepts(op: Op, key: string, sent: unknown): boolean {
    const pyInt = (v: unknown): boolean => typeof v === 'number' && /^-?\d+$/.test(JSON.stringify(v));
    const value: unknown = JSON.parse(JSON.stringify(sent));
    switch (key) {
      case 'concurrency':
        return op !== 'register' || (pyInt(value) && (value as number) >= 1);
      case 'caller':
        return op !== 'call' || pyInt(value);
      case 'caller_authid':
      case 'caller_authrole':
        return op !== 'call' || typeof value === 'string';
      case 'transaction_hash':
        return (op !== 'call' && op !== 'publish') || typeof value === 'string';
      default: // forward_for: the parser checks for a list, the message constructor asserts each principal
        return (
          Array.isArray(value) &&
          value.every((p: unknown) => {
            if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
            const r = p as Record<string, unknown>;
            return (
              pyInt(r['session']) &&
              'authid' in r &&
              (r['authid'] === null || typeof r['authid'] === 'string') &&
              typeof r['authrole'] === 'string'
            );
          })
        );
    }
  }

  test('property: whatever is accepted locally, Crossbar accepts too (no option can close the connection)', () => {
    const scalar = fc.oneof(
      fc.integer(),
      fc.integer({ min: -3, max: 3 }),
      fc.maxSafeNat(),
      fc.double(),
      fc.string({ maxLength: 4 }),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constantFrom(2 ** 53, 2 ** 53 + 2, 1e21, -0),
    );
    // biased towards well-formed principals, so that accepted forward_for lists are common too
    const principalLike = fc.record(
      {
        session: fc.oneof(fc.maxSafeNat(), scalar),
        authid: fc.oneof(fc.string(), scalar),
        authrole: fc.oneof(fc.string(), scalar),
        extra: scalar,
      },
      { requiredKeys: [] },
    );
    const anyValue = fc.oneof(scalar, fc.array(fc.oneof(principalLike, scalar), { maxLength: 3 }), principalLike);
    const integer = fc.oneof(fc.integer({ min: -2, max: 5 }), fc.maxSafeNat(), fc.constantFrom(2 ** 53, 2 ** 53 + 2));
    // half of the values are of roughly the right kind for their key, so that both outcomes are common
    const nearlyRight: Record<string, fc.Arbitrary<unknown>> = {
      concurrency: integer,
      caller: integer,
      caller_authid: fc.string(),
      caller_authrole: fc.string(),
      transaction_hash: fc.string(),
      forward_for: fc.array(principalLike, { maxLength: 3 }),
    };
    const keyAndValue = fc
      .constantFrom(...Object.keys(nearlyRight))
      .chain((key) => fc.tuple(fc.constant(key), fc.oneof(nearlyRight[key] ?? anyValue, anyValue)));
    fc.assert(
      fc.property(fc.constantFrom(...OPS), keyAndValue, (op, [key, v]) => {
        let options: Readonly<Record<string, unknown>>;
        try {
          options = withOptions(op, { [key]: v }).options;
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          return;
        }
        if (v === undefined) {
          expect(options).toEqual({});
          return;
        }
        expect(crossbarAccepts(op, key, options[key])).toBe(true);
      }),
      replayParameters(),
    );
  });
});

describe('rejected keys (progressive call invocations, call timeout, payload passthru mode)', () => {
  test('CALL progress (progressive call invocations are not announced)', () => {
    expect(() => snapshotCall('p', [], {}, { progress: true })).toThrow(TypeError);
    expect(() => snapshotCall('p', [], {}, { progress: false })).toThrow(
      'call: options.progress is not supported (progressive call invocations are not announced)',
    );
    for (const op of ['publish', 'topic', 'register'] as const)
      expect(() => withOptions(op, { progress: true })).not.toThrow();
  });

  test('REGISTER forward_timeout (the callee would have to time out invocations itself)', () => {
    expect(() => snapshotRegister('p', handler, { forward_timeout: true })).toThrow(
      'register: options.forward_timeout is not supported (a callee registered with it must time out invocations itself, which thruway.js does not do)',
    );
    expect(() => snapshotRegister('p', handler, { forward_timeout: false })).toThrow(TypeError);
    for (const op of ['call', 'publish', 'topic'] as const)
      expect(() => withOptions(op, { forward_timeout: true })).not.toThrow();
  });

  test.each(OPS)('%s: any ppt_* key (payload passthru is not announced)', (op) => {
    for (const key of ['ppt_scheme', 'ppt_serializer', 'ppt_cipher', 'ppt_keyid', 'ppt_']) {
      expect(() => withOptions(op, { [key]: 'mqtt' })).toThrow(
        `${op}: options.${key} is not supported (payload passthru mode is not announced)`,
      );
    }
    expect(() => withOptions(op, { ppt: 'x', _ppt_x: 1, xppt_scheme: 1 })).not.toThrow();
  });

  test('a rejected key set to undefined is absent, so it is fine', () => {
    expect(snapshotCall('p', [], {}, { progress: undefined }).options).toEqual({});
    expect(snapshotRegister('p', handler, { forward_timeout: undefined, ppt_scheme: undefined }).options).toEqual({});
  });
});

describe('URIs', () => {
  // U+001F and U+0085 are whitespace to the Python patterns Crossbar checks URIs with (not to JavaScript's \s)
  test.each(['com..bad', 'com.bad uri', 'com.bad#x', '', 'com..x', 'com.bad\x1furi', 'com.bad\x85uri'])(
    'Crossbar quirk 8: %j is rejected for CALL, PUBLISH and REGISTER before anything is written',
    (uri) => {
      for (const op of ['call', 'publish', 'register'] as const) {
        const error = invalidUri(op, uri);
        expect(error.uri).toBe('wamp.error.invalid_uri');
        expect(error.message).toBe('wamp.error.invalid_uri');
        expect(error.args).toEqual([uri]);
        expect(error[op === 'publish' ? 'topic' : 'procedure']).toBe(uri);
      }
      if (uri !== '') expect(invalidUri('topic', uri).topic).toBe(uri);
    },
  );

  test('calls and publishes always use the exact rule; a match option does not relax it', () => {
    for (const op of ['call', 'publish'] as const) {
      invalidUri(op, 'a..b', { match: 'wildcard' });
      invalidUri(op, 'a.', { match: 'prefix' });
      invalidUri(op, 'a/#', { match: '_mqtt' });
    }
  });

  test('topics use the rule of their match: the empty prefix, wildcards, fox-wamp MQTT URIs', () => {
    expect(uriOf('topic', '', { match: 'prefix' })).toBe('');
    expect(uriOf('topic', 'com.', { match: 'prefix' })).toBe('com.');
    expect(uriOf('topic', 'com..get', { match: 'wildcard' })).toBe('com..get');
    expect(uriOf('topic', 'sensors/+/temp#', { match: '_mqtt' })).toBe('sensors/+/temp#');
    invalidUri('topic', '');
    invalidUri('topic', 'com.', { match: 'exact' });
    invalidUri('topic', 'a b', { match: '_mqtt' });
  });

  test('registrations use the rule of their match, but never register the empty procedure', () => {
    expect(uriOf('register', 'com.', { match: 'prefix' })).toBe('com.');
    expect(uriOf('register', 'com..get', { match: 'wildcard' })).toBe('com..get');
    for (const match of ['prefix', 'wildcard', 'exact', undefined]) invalidUri('register', '', { match });
  });

  test('wamp.* URIs are not rejected locally (routers decide); Thruway T7 spellings pass', () => {
    expect(uriOf('call', 'wamp.session.count')).toBe('wamp.session.count');
    expect(uriOf('topic', 'wamp.session.on_join')).toBe('wamp.session.on_join');
    expect(uriOf('register', 'Com.Example.UPPER')).toBe('Com.Example.UPPER');
  });

  test.each(OPS)('%s: a URI that is not a string is a TypeError', (op) => {
    for (const uri of [undefined, null, 1, {}, ['a'], new String('a')]) {
      expect(() => uriOf(op, uri)).toThrow(TypeError);
      expect(() => uriOf(op, uri)).toThrow(
        `${op}: ${op === 'call' || op === 'register' ? 'procedure' : 'topic'} must be a string`,
      );
    }
  });

  test('an invalid URI is checked after the options, so the right rule applies', () => {
    expect(() => snapshotTopic('a..b', { match: 'nope' })).toThrow(TypeError);
  });
});

describe('args, kwargs, options shapes (Crossbar quirk 3)', () => {
  test('args: an array, or absent (undefined or null)', () => {
    expect(snapshotCall('p', undefined, undefined, undefined).args).toBeUndefined();
    expect(snapshotPublish('t', null, null, null).args).toBeUndefined();
    expect(snapshotCall('p', [1, 'a'], undefined, undefined).args).toEqual([1, 'a']);
    for (const bad of ['', 'x', 1, {}, { length: 1, 0: 'a' }, new Uint8Array(1), true]) {
      expect(() => snapshotCall('p', bad, undefined, undefined)).toThrow('call: args must be an array');
      expect(() => snapshotPublish('t', bad, undefined, undefined)).toThrow('publish: args must be an array');
    }
  });

  test('kwargs: a plain object, or absent', () => {
    expect(snapshotCall('p', undefined, undefined, undefined).kwargs).toBeUndefined();
    expect(snapshotCall('p', undefined, null, undefined).kwargs).toBeUndefined();
    const bare = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(snapshotCall('p', undefined, bare, undefined).kwargs).toEqual({ a: 1 });
    for (const bad of [[], [1], 'x', 1, new Map(), new Date(0), Object.create({ inherited: true }) as object, true]) {
      expect(() => snapshotCall('p', undefined, bad, undefined)).toThrow('call: kwargs must be a plain object');
      expect(() => snapshotPublish('t', undefined, bad, undefined)).toThrow('publish: kwargs must be a plain object');
    }
  });

  test.each(OPS)('%s: options a plain object, or absent', (op) => {
    expect(withOptions(op, undefined).options).toEqual({});
    expect(withOptions(op, null).options).toEqual({});
    for (const bad of [[], 'x', 1, new Map(), true, new Date(0)]) {
      expect(() => withOptions(op, bad)).toThrow(`${op}: options must be a plain object`);
    }
  });

  test('register: the handler must be a function', () => {
    for (const bad of [undefined, null, {}, 'f', 1]) {
      expect(() => snapshotRegister('p', bad, undefined)).toThrow('register: handler must be a function');
    }
    const fn = (): string => 'x';
    expect(snapshotRegister('p', fn, undefined).handler).toBe(fn);
  });
});

describe('snapshots: frozen shallow copies; app objects never mutated', () => {
  test('call: args/kwargs/options are new frozen objects; the values inside are shared', () => {
    const inner = { deep: true };
    const args = [inner, 2];
    const kwargs = { k: inner };
    const options = { receive_progress: true, custom: inner };
    const snap = snapshotCall('p', args, kwargs, options);
    expect(Object.isFrozen(snap)).toBe(true);
    for (const [copy, original] of [
      [snap.args, args],
      [snap.kwargs, kwargs],
      [snap.options, options],
    ] as const) {
      expect(copy).not.toBe(original);
      expect(copy).toEqual(original);
      expect(Object.isFrozen(copy)).toBe(true);
      expect(Object.isFrozen(original)).toBe(false);
    }
    expect(snap.args![0]).toBe(inner);
    expect(snap.options['custom']).toBe(inner);
    args.push(3);
    kwargs.k = { deep: false };
    options.receive_progress = false;
    expect(snap.args).toHaveLength(2);
    expect(snap.kwargs).toEqual({ k: inner });
    expect(snap.progressive).toBe(true);
  });

  test('frozen app objects are accepted (nothing is written to them)', () => {
    const options = Object.freeze({ acknowledge: true, exclude: Object.freeze([1]), x: undefined });
    const snap = snapshotPublish('t', Object.freeze([1]), Object.freeze({ a: 1 }), options);
    expect(snap.ack).toBe(true);
    expect(snap.options).toEqual({ acknowledge: true, exclude: [1] });
    expect(Object.keys(options)).toEqual(['acknowledge', 'exclude', 'x']);
  });

  test('spec-typed arrays are copied too: what was validated is what is sent', () => {
    const exclude = [1, 2];
    const snap = snapshotPublish('t', undefined, undefined, { exclude, eligible_authid: ['a'] });
    expect(snap.options['exclude']).not.toBe(exclude);
    expect(Object.isFrozen(snap.options['exclude'])).toBe(true);
    exclude.push('not an id' as unknown as number);
    expect(snap.options['exclude']).toEqual([1, 2]);
  });

  test('undefined values are dropped from options and kwargs; kept in args (JSON makes them null)', () => {
    const snap = snapshotCall('p', [undefined, 1], { a: undefined, b: 2 }, { timeout: undefined, disclose_me: true });
    expect(snap.options).toEqual({ disclose_me: true });
    expect(Object.keys(snap.options)).toEqual(['disclose_me']);
    expect(Object.keys(snap.kwargs!)).toEqual(['b']);
    expect(snap.args).toEqual([undefined, 1]);
    expect(snapshotCall('p', undefined, { a: undefined }, undefined).kwargs).toEqual({});
  });

  test('a `__proto__` key is copied as an own key, never as a prototype', () => {
    const options = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as Record<string, unknown>;
    const kwargs = JSON.parse('{"__proto__": 5}') as Record<string, unknown>;
    const snap = snapshotCall('p', undefined, kwargs, options);
    expect(Object.getPrototypeOf(snap.options)).toBe(Object.prototype);
    expect(Object.keys(snap.options)).toEqual(['__proto__', 'x']);
    expect(Object.getPrototypeOf(snap.kwargs)).toBe(Object.prototype);
    expect(JSON.stringify(snap.kwargs)).toBe('{"__proto__":5}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('symbol keys and non-enumerable properties are not copied (JSON would not send them)', () => {
    const options: Record<string | symbol, unknown> = { a: 1, [Symbol('s')]: 2 };
    Object.defineProperty(options, 'hidden', { value: 3, enumerable: false });
    expect(snapshotTopic('t', options).options).toEqual({ a: 1 });
    expect(Reflect.ownKeys(snapshotTopic('t', options).options)).toEqual(['a']);
  });

  test('progressive and ack mirror the spec booleans', () => {
    expect(snapshotCall('p', [], {}, { receive_progress: true }).progressive).toBe(true);
    expect(snapshotCall('p', [], {}, { receive_progress: false }).progressive).toBe(false);
    expect(snapshotCall('p', [], {}, {}).progressive).toBe(false);
    expect(snapshotPublish('t', [], {}, { acknowledge: true }).ack).toBe(true);
    expect(snapshotPublish('t', [], {}, undefined).ack).toBe(false);
  });
});

describe('hostile app objects: they only fail this subscription, synchronously', () => {
  const revoked = (target: object): object => {
    const r = Proxy.revocable(target, {});
    r.revoke();
    return r.proxy;
  };

  test.each(OPS)('%s: revoked Proxy as options', (op) => {
    expect(() => withOptions(op, revoked({}))).toThrow(TypeError);
  });

  test('revoked Proxy as args or kwargs', () => {
    expect(() => snapshotCall('p', revoked([]), undefined, undefined)).toThrow(TypeError);
    expect(() => snapshotPublish('t', undefined, revoked({}), undefined)).toThrow(TypeError);
  });

  test.each(OPS)('%s: a throwing getter in options propagates its own error', (op) => {
    const boom = new Error('getter');
    const options = {
      get match() {
        throw boom;
      },
    };
    expect(() => withOptions(op, options)).toThrow(boom);
  });

  test('throwing getters in args and kwargs propagate', () => {
    const boom = new Error('getter');
    const args = [1];
    Object.defineProperty(args, 0, {
      get() {
        throw boom;
      },
    });
    const kwargs = {
      get k(): unknown {
        throw boom;
      },
    };
    expect(() => snapshotCall('p', args, undefined, undefined)).toThrow(boom);
    expect(() => snapshotCall('p', undefined, kwargs, undefined)).toThrow(boom);
  });

  test('Proxies whose traps throw (ownKeys, getPrototypeOf, get)', () => {
    const boom = new Error('trap');
    for (const trap of ['ownKeys', 'getPrototypeOf', 'get', 'getOwnPropertyDescriptor'] as const) {
      const hostile = new Proxy(
        { a: 1 },
        {
          [trap]: () => {
            throw boom;
          },
        },
      );
      expect(() => withOptions('topic', hostile)).toThrow(boom);
      expect(() => snapshotCall('p', undefined, hostile, undefined)).toThrow(boom);
    }
    const arrayProxy = new Proxy([1, 2], {
      get(target, key, receiver) {
        if (key === '1') throw boom;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(() => snapshotCall('p', arrayProxy, undefined, undefined)).toThrow(boom);
  });

  test('a well-behaved Proxy is read once and copied', () => {
    const reads: (string | symbol)[] = [];
    const options = new Proxy(
      { disclose_me: true, b: 2 },
      {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const snap = snapshotCall('p', undefined, undefined, options);
    expect(snap.options).toEqual({ disclose_me: true, b: 2 });
    expect(reads).toEqual(['disclose_me', 'b']);
  });

  test('each getter is read exactly once', () => {
    let count = 0;
    const options = {
      get get_retained() {
        count++;
        return true;
      },
    };
    expect(snapshotTopic('t', options).options).toEqual({ get_retained: true });
    expect(count).toBe(1);
  });

  test.each(OPS)('%s: cyclic options are a TypeError', (op) => {
    const options: Record<string, unknown> = { a: 1 };
    options['self'] = options;
    expect(() => withOptions(op, options)).toThrow(TypeError);
    const deep: Record<string, unknown> = {};
    deep['list'] = [{ back: deep }];
    expect(() => withOptions(op, { nested: deep })).toThrow(TypeError);
  });

  test.each(OPS)('%s: a BigInt in options is a TypeError', (op) => {
    expect(() => withOptions(op, { custom: 10n })).toThrow(TypeError);
    expect(() => withOptions(op, { nested: { deeper: [1n] } })).toThrow(TypeError);
    expect(() => withOptions(op, { timeout: 5n })).toThrow(TypeError);
  });

  test.each(OPS)('%s: a throwing toJSON in options propagates its own error', (op) => {
    const boom = new Error('toJSON');
    expect(() =>
      withOptions(op, {
        custom: {
          toJSON: () => {
            throw boom;
          },
        },
      }),
    ).toThrow(boom);
  });

  test('a cycle or BigInt in args/kwargs is left to the serializer at write time (shallow snapshot)', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => snapshotCall('p', cyclic, { big: 1n }, undefined)).not.toThrow();
  });

  test('property: hostile values in any position never escape as anything but a throw of this call', () => {
    const boom = new Error('hostile');
    const hostile = fc.constantFrom<() => unknown>(
      () => revoked({}),
      () => revoked([]),
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw boom;
            },
          },
        ),
      () =>
        new Proxy([], {
          get: () => {
            throw boom;
          },
        }),
      () => ({
        get x() {
          throw boom;
        },
      }),
      () => 1n,
      () => Symbol('s'),
    );
    fc.assert(
      fc.property(fc.constantFrom(...OPS), fc.nat(3), hostile, (op, position, make) => {
        const values: unknown[] = ['com.example.x', [1], { k: 1 }, {}];
        values[position] = make();
        let outcome: 'ok' | 'threw' = 'ok';
        try {
          if (op === 'call') snapshotCall(values[0], values[1], values[2], values[3]);
          else if (op === 'publish') snapshotPublish(values[0], values[1], values[2], values[3]);
          else if (op === 'topic') snapshotTopic(values[0], values[3]);
          else snapshotRegister(values[0], handler, values[3]);
        } catch (error) {
          outcome = 'threw';
          expect(error === boom || error instanceof TypeError || isWampError(error)).toBe(true);
        }
        expect(['ok', 'threw']).toContain(outcome);
      }),
      replayParameters(),
    );
  });
});

describe('progressiveCall: receive_progress is always true, whatever options says', () => {
  test.each([
    undefined,
    null,
    {},
    { receive_progress: true },
    { receive_progress: false },
    { receive_progress: 'yes' },
  ])('options %j', (options) => {
    const snap = snapshotProgressiveCall('com.feed', [1], { k: 1 }, options);
    expect(snap.progressive).toBe(true);
    expect(snap.options).toEqual({ receive_progress: true });
    expect(Object.isFrozen(snap.options)).toBe(true);
    expect(snap).toMatchObject({ procedure: 'com.feed', args: [1], kwargs: { k: 1 } });
  });

  test("the app's receive_progress is not even read; the other keys are validated and copied as for call", () => {
    const options = {
      get receive_progress(): unknown {
        throw new Error('must not be read');
      },
      disclose_me: true,
      custom: 'x',
      dropped: undefined,
    };
    const snap = snapshotProgressiveCall('p', undefined, undefined, options);
    expect(snap.options).toEqual({ receive_progress: true, disclose_me: true, custom: 'x' });
    expect(Object.keys(options)).toEqual(['receive_progress', 'disclose_me', 'custom', 'dropped']);
    const frozen = Object.freeze({ receive_progress: false, timeout: 5 });
    expect(snapshotProgressiveCall('p', undefined, undefined, frozen).options).toEqual({
      receive_progress: true,
      timeout: 5,
    });
    expect(frozen.receive_progress).toBe(false);
  });

  test('everything else is rejected exactly as for call', () => {
    expect(() => snapshotProgressiveCall('p', [], {}, { progress: true })).toThrow('call: options.progress');
    expect(() => snapshotProgressiveCall('p', [], {}, { disclose_me: 1 })).toThrow('call: options.disclose_me');
    for (const bad of [['receive_progress'], 'x', new Map(), 1]) {
      expect(() => snapshotProgressiveCall('p', [], {}, bad)).toThrow('call: options must be a plain object');
    }
    expect(() => snapshotProgressiveCall('p', 'x', {}, {})).toThrow('call: args must be an array');
    expect(() => snapshotProgressiveCall('p', [], [], {})).toThrow('call: kwargs must be a plain object');
    expect(() => snapshotProgressiveCall(1, [], {}, {})).toThrow('call: procedure must be a string');
    expect(isWampError(invalidUriOf(() => snapshotProgressiveCall('a..b', [], {}, {})))).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => snapshotProgressiveCall('p', [], {}, { cyclic })).toThrow(TypeError);
  });

  test('property: the same snapshot as call with receive_progress: true', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 3, maxLength: 8 }).map((k) => `x_${k}`),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          { maxKeys: 4 },
        ),
        (options) => {
          const progressive = snapshotProgressiveCall('com.x', [1], undefined, { ...options, receive_progress: false });
          const call = snapshotCall('com.x', [1], undefined, { ...options, receive_progress: true });
          expect(progressive).toEqual(call);
        },
      ),
      replayParameters(),
    );
  });
});

function invalidUriOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('topic and registration keys', () => {
  test('{} ≡ {match: "exact"} ≡ {get_retained: false} ≡ undefined values (one router subscription)', () => {
    const key = snapshotTopic('a.b', {}).key;
    for (const options of [
      undefined,
      null,
      { match: 'exact' },
      { get_retained: false },
      { match: 'exact', get_retained: false, other: undefined },
    ]) {
      expect(snapshotTopic('a.b', options).key).toBe(key);
    }
  });

  test('registrations: {} ≡ {match: "exact"} ≡ {invoke: "single"} ≡ {disclose_caller: false} ≡ {force_reregister: false}', () => {
    const key = snapshotRegister('a.b', handler, {}).key;
    for (const options of [
      { match: 'exact' },
      { invoke: 'single' },
      { disclose_caller: false },
      { force_reregister: false },
    ]) {
      expect(snapshotRegister('a.b', handler, options).key).toBe(key);
    }
  });

  test('key order does not matter', () => {
    expect(snapshotTopic('t', { match: 'prefix', get_retained: true }).key).toBe(
      snapshotTopic('t', { get_retained: true, match: 'prefix' }).key,
    );
    expect(snapshotRegister('p', handler, { invoke: 'roundrobin', x: { b: 1, a: 2 } }).key).toBe(
      snapshotRegister('p', handler, { x: { a: 2, b: 1 }, invoke: 'roundrobin' }).key,
    );
  });

  test('different URIs or meaningful options are different keys', () => {
    const keys = new Set([
      snapshotTopic('a.b', {}).key,
      snapshotTopic('a.b', { match: 'prefix' }).key,
      snapshotTopic('a.b', { get_retained: true }).key,
      snapshotTopic('a.b', { custom: false }).key,
      snapshotTopic('a.c', {}).key,
      snapshotTopic('a.', { match: 'prefix' }).key,
      snapshotTopic('a', { match: 'prefix' }).key,
    ]);
    expect(keys.size).toBe(7);
    expect(snapshotRegister('p', handler, { invoke: 'roundrobin' }).key).not.toBe(
      snapshotRegister('p', handler, {}).key,
    );
  });

  test('the key is unambiguous: URIs never contain whitespace, the separator', () => {
    expect(snapshotTopic('a', { match: 'prefix' }).key).toBe('a {"match":"prefix"}');
    expect(snapshotTopic('a{}', {}).key).toBe('a{} {}');
    expect(snapshotTopic('a', {}).key).toBe('a {}');
  });

  test('group = topic + match (what a broker that reuses subscription ids keys on)', () => {
    expect(snapshotTopic('a.b', {}).group).toBe('a.b exact');
    expect(snapshotTopic('a.b', { match: 'exact', get_retained: true }).group).toBe('a.b exact');
    expect(snapshotTopic('a.b', { match: 'prefix' }).group).toBe('a.b prefix');
    expect(snapshotTopic('a/#', { match: '_mqtt' }).group).toBe('a/# _mqtt');
  });

  test('the options sent keep what the app passed (only the key is normalised)', () => {
    expect(snapshotTopic('t', { match: 'exact', get_retained: false }).options).toEqual({
      match: 'exact',
      get_retained: false,
    });
  });

  test('property: adding spec defaults never changes the key; any other key does', () => {
    const custom = fc.dictionary(
      fc.string({ maxLength: 6 }).map((k) => `x_${k}`),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      { maxKeys: 3 },
    );
    fc.assert(
      fc.property(custom, fc.boolean(), (options, register) => {
        const keyOf = (o: Record<string, unknown>): string =>
          register ? snapshotRegister('p', handler, o).key : snapshotTopic('t', o).key;
        const defaults = register
          ? { match: 'exact', invoke: 'single', disclose_caller: false, force_reregister: false }
          : { match: 'exact', get_retained: false };
        const base = keyOf(options);
        expect(keyOf({ ...defaults, ...options })).toBe(base);
        expect(keyOf({ ...options, x_extra_: 1 })).not.toBe(base);
      }),
      replayParameters(),
    );
  });
});

describe('every snapshot passes its own validation again (idempotent)', () => {
  test('property: snapshotting a snapshot gives an equal snapshot', () => {
    const optionValue = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.integer({ min: 0, max: 10 })));
    const options = fc.dictionary(
      fc.string({ minLength: 4, maxLength: 8 }).map((k) => `x_${k}`),
      optionValue,
      { maxKeys: 4 },
    );
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 3 }),
        fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 3 }),
        options,
        (args, kwargs, opts) => {
          const once = snapshotCall('com.x', args, kwargs, opts);
          const twice = snapshotCall(once.procedure, once.args, once.kwargs, once.options);
          expect(twice).toEqual(once);
          const topic = snapshotTopic('t', opts);
          expect(snapshotTopic(topic.topic, topic.options)).toEqual(topic);
        },
      ),
      replayParameters(),
    );
  });
});
