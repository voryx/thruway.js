// protocol/payload.ts: outbound and inbound payload rules, the cycle-safe canonical JSON of topic/registration keys,
// key normalisation.
import { fc } from '@fast-check/vitest';
import { describe, expect, test } from 'vitest';
import {
  canonicalJson,
  inboundPayload,
  isEmptyArray,
  isPlainObject,
  normalizeKeyOptions,
  outboundPayload,
  SPEC_BOOLEAN_KEYS,
} from '../../src/protocol/payload.js';
import { replayParameters } from '../setup-fast-check.js';
import { createContext, runInContext } from 'node:vm';

describe('outboundPayload', () => {
  const a = [1, 'x'];
  const k = { key: 'v' };
  test.each([
    { args: undefined, kwargs: undefined, out: [] },
    { args: [], kwargs: undefined, out: [] },
    { args: undefined, kwargs: {}, out: [] },
    { args: [], kwargs: {}, out: [] },
    { args: a, kwargs: undefined, out: [a] },
    { args: a, kwargs: {}, out: [a] },
    { args: undefined, kwargs: k, out: [[], k] },
    { args: [], kwargs: k, out: [[], k] },
    { args: a, kwargs: k, out: [a, k] },
  ])('args $args, kwargs $kwargs ⇒ $out', ({ args, kwargs, out }) => {
    expect(outboundPayload(args, kwargs)).toEqual(out);
  });

  test('values are passed through untouched: same objects, nothing appended (v2 appended {uri} to ERROR args)', () => {
    const args = [{ deep: [1] }];
    const kwargs = { k: new Uint8Array(2) };
    const [outArgs, outKwargs] = outboundPayload(args, kwargs) as [unknown, unknown];
    expect(outArgs).toBe(args);
    expect(outKwargs).toBe(kwargs);
    expect(args).toEqual([{ deep: [1] }]);
    const [only] = outboundPayload(args, undefined) as [unknown];
    expect(only).toBe(args);
  });

  test('property: never an empty trailing element, and the payload is recoverable', () => {
    fc.assert(
      fc.property(
        fc.option(fc.array(fc.jsonValue(), { maxLength: 3 }), { nil: undefined }),
        fc.option(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 3 }), { nil: undefined }),
        (args, kwargs) => {
          const out = outboundPayload(args, kwargs);
          const hasArgs = args !== undefined && args.length > 0;
          const hasKwargs = kwargs !== undefined && Object.keys(kwargs).length > 0;
          expect(out.length).toBe(hasKwargs ? 2 : hasArgs ? 1 : 0);
          if (out.length === 2) expect(out[1]).toBe(kwargs);
          if (hasArgs) expect(out[0]).toBe(args);
          if (out.length === 1) expect(out[0].length).toBeGreaterThan(0);
        },
      ),
      replayParameters(),
    );
  });
});

describe('inboundPayload', () => {
  test.each([
    { args: undefined, kwargs: undefined },
    { args: null, kwargs: null },
    { args: null, kwargs: [] },
  ])('absent ($args, $kwargs) ⇒ [] and {}', ({ args, kwargs }) => {
    expect(inboundPayload(args, kwargs)).toEqual({ args: [], kwargs: {} });
  });

  test('present payloads are returned as they are (not copied)', () => {
    const args = [1];
    const kwargs = { a: 1 };
    const out = inboundPayload(args, kwargs) as { args: unknown; kwargs: unknown };
    expect(out.args).toBe(args);
    expect(out.kwargs).toBe(kwargs);
    const bare = Object.create(null) as Record<string, unknown>;
    expect((inboundPayload(undefined, bare) as { kwargs: unknown }).kwargs).toBe(bare);
  });

  test.each([{}, { 0: 'a', 2: 'c' }, 'x', 1, true, new Uint8Array(1)])('args %j is payload-invalid', (args) => {
    expect(inboundPayload(args, undefined)).toEqual({ invalid: { reason: 'args is not an array' } });
  });

  test.each([[1], [[]], 'x', 1, false, new Map(), new Date(0), Object.create({ inherited: true }) as object])(
    'kwargs %j is payload-invalid',
    (kwargs) => {
      expect(inboundPayload([], kwargs)).toEqual({ invalid: { reason: 'kwargs is not a dict' } });
    },
  );

  test('defaults are fresh objects each time', () => {
    const one = inboundPayload(undefined, undefined) as { args: unknown[]; kwargs: object };
    const two = inboundPayload(undefined, undefined) as { args: unknown[]; kwargs: object };
    expect(one.args).not.toBe(two.args);
    expect(one.kwargs).not.toBe(two.kwargs);
  });
});

describe('helpers', () => {
  test('isPlainObject: object literals and null-prototype objects, from any realm; nothing else', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse('{"__proto__": 1}'))).toBe(true);
    expect(isPlainObject(runInContext('({a: 1})', createContext()))).toBe(true);
    for (const value of [
      [],
      new Map(),
      new Date(),
      new Uint8Array(1),
      Object.create({ inherited: true }) as object,
      Object(1),
      Object('s'),
      null,
      1,
      's',
      () => 1,
    ]) {
      expect(isPlainObject(value)).toBe(false);
    }
    expect(isPlainObject(runInContext('[]', createContext()))).toBe(false);
  });

  test('isEmptyArray', () => {
    expect(isEmptyArray([])).toBe(true);
    expect(isEmptyArray([undefined])).toBe(false);
    expect(isEmptyArray({})).toBe(false);
  });
});

describe('canonicalJson', () => {
  test('object keys are sorted recursively; arrays keep their order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  test('key order does not matter', () => {
    expect(canonicalJson({ match: 'prefix', get_retained: true })).toBe(
      canonicalJson({ get_retained: true, match: 'prefix' }),
    );
  });

  test('otherwise exactly JSON: toJSON, boxed primitives, omitted values, non-finite numbers', () => {
    const value = {
      date: new Date(0),
      custom: { toJSON: () => ({ y: 1, x: 2 }) },
      boxed: [Object(1), Object('a long boxed string'), Object(false)],
      gone: undefined,
      fn: () => 1,
      sym: Symbol('s'),
      list: [undefined, () => 1, NaN, Infinity],
      map: new Map([[1, 2]]),
    };
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
    expect(canonicalJson(value)).toContain('"custom":{"x":2,"y":1}');
  });

  test('`__proto__` keys and null-prototype objects are kept', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['b'] = 1;
    bare['a'] = 2;
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
    expect(canonicalJson(JSON.parse('{"z":1,"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1},"z":1}');
  });

  test('a cycle throws TypeError (self, mutual, through arrays)', () => {
    const self: Record<string, unknown> = { z: 1 };
    self['self'] = self;
    const a: Record<string, unknown> = {};
    const b = { a };
    a['b'] = b;
    const list: unknown[] = [];
    list.push({ list });
    for (const cyclic of [self, a, { x: [a] }, list]) {
      expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    }
  });

  test('a shared (non-cyclic) object is fine', () => {
    const shared = { b: 1, a: 2 };
    expect(canonicalJson({ x: shared, y: [shared, shared] })).toBe(
      '{"x":{"a":2,"b":1},"y":[{"a":2,"b":1},{"a":2,"b":1}]}',
    );
  });

  test('a BigInt throws TypeError', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
    expect(() => canonicalJson([[2n]])).toThrow(TypeError);
  });

  test('a throwing getter or toJSON throws its own error; each getter runs once', () => {
    const boom = new Error('boom');
    let reads = 0;
    const getter = {
      get x() {
        reads++;
        return 1;
      },
      get y() {
        throw boom;
      },
    };
    expect(() => canonicalJson(getter)).toThrow(boom);
    const counted = {
      get x() {
        reads++;
        return { b: 1, a: 1 };
      },
    };
    reads = 0;
    expect(canonicalJson(counted)).toBe('{"x":{"a":1,"b":1}}');
    expect(reads).toBe(1);
    expect(() =>
      canonicalJson({
        v: {
          toJSON: () => {
            throw boom;
          },
        },
      }),
    ).toThrow(boom);
  });

  test('a top-level value JSON omits gives "null"', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(() => 1)).toBe('null');
  });

  test('never mutates its input', () => {
    const input = Object.freeze({ b: Object.freeze([Object.freeze({ d: 1, c: 2 })]), a: 1 });
    expect(canonicalJson(input)).toBe('{"a":1,"b":[{"c":2,"d":1}]}');
  });

  test('property: same content in any key order ⇒ the same text, which parses back to the same value', () => {
    const shuffled = (value: unknown, seed: number): unknown => {
      if (Array.isArray(value)) return value.map((v, i) => shuffled(v, seed + i));
      if (typeof value !== 'object' || value === null) return value;
      const keys = Object.keys(value);
      const order = keys.map((k, i) => ({ k, r: Math.sin(seed * 7919 + i) })).sort((x, y) => x.r - y.r);
      return Object.fromEntries(order.map(({ k }) => [k, shuffled((value as Record<string, unknown>)[k], seed + 1)]));
    };
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (value, seed) => {
        const text = canonicalJson(value);
        expect(canonicalJson(shuffled(value, seed))).toBe(text);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      replayParameters(),
    );
  });
});

describe('normalizeKeyOptions', () => {
  test('{} ≡ {match: "exact"} ≡ spec booleans false; undefined dropped', () => {
    const empty = normalizeKeyOptions({}, 'topic');
    for (const options of [
      { match: 'exact' },
      { get_retained: false },
      { match: 'exact', get_retained: false, x: undefined },
    ]) {
      expect(normalizeKeyOptions(options, 'topic')).toEqual(empty);
    }
  });

  test('only the key match is dropped for "exact" and only invoke for "single"', () => {
    expect(normalizeKeyOptions({ invoke: 'exact', custom: 'exact' }, 'topic')).toEqual({
      invoke: 'exact',
      custom: 'exact',
    });
    expect(normalizeKeyOptions({ match: 'single', custom: 'single' }, 'register')).toEqual({
      match: 'single',
      custom: 'single',
    });
  });

  test('undefined values leave no key behind', () => {
    expect(Object.keys(normalizeKeyOptions({ a: undefined, b: 1, c: undefined }, 'topic'))).toEqual(['b']);
  });

  test('invoke: "single" is a default for registrations only', () => {
    expect(normalizeKeyOptions({ invoke: 'single', match: 'exact', disclose_caller: false }, 'register')).toEqual({});
    expect(normalizeKeyOptions({ invoke: 'single' }, 'topic')).toEqual({ invoke: 'single' });
  });

  test('every spec boolean set to false is dropped; true is kept', () => {
    for (const key of SPEC_BOOLEAN_KEYS) {
      expect(normalizeKeyOptions({ [key]: false }, 'topic')).toEqual({});
      expect(normalizeKeyOptions({ [key]: true }, 'register')).toEqual({ [key]: true });
    }
  });

  test('everything else is kept as it is (router-specific keys, other policies, false non-spec booleans)', () => {
    const options = {
      match: 'prefix',
      invoke: 'roundrobin',
      thruway_multiregister: false,
      replace_orphaned_session: 'yes',
      nested: { a: 1 },
    };
    expect(normalizeKeyOptions(options, 'register')).toEqual(options);
  });

  test('never mutates the options; returns a new frozen object; `__proto__` stays an own key', () => {
    const options = Object.freeze(JSON.parse('{"match":"exact","__proto__":{"x":1},"get_retained":true}') as object);
    const out = normalizeKeyOptions(options as Readonly<Record<string, unknown>>, 'topic');
    expect(out).not.toBe(options);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.keys(out)).toEqual(['__proto__', 'get_retained']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
