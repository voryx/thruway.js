// Yield: defaults, payloads kept as given, the Symbol.for brand and the isYield brand check (any package copy, never
// duck typing, never throws).
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { isYield, Yield, YIELD_BRAND } from '../../src/yield.js';

const BRAND = Symbol.for('thruway.js.yield');

describe('Yield', () => {
  test('defaults: args [] and kwargs {}', () => {
    const y = new Yield();
    expect(y.args).toEqual([]);
    expect(y.kwargs).toEqual({});
    expect(Object.keys(y)).toEqual(['args', 'kwargs']);
  });

  test('args and kwargs are kept by reference', () => {
    const args = [1, { a: 2 }];
    const kwargs = { k: 'v' };
    const y = new Yield(args, kwargs);
    expect(y.args).toBe(args);
    expect(y.kwargs).toBe(kwargs);
    expect(new Yield(undefined, kwargs).args).toEqual([]);
  });

  test('null means absent; other malformed payloads are kept for the sender to reject', () => {
    const fromJs = Yield as unknown as new (...a: unknown[]) => Yield;
    const absent = new fromJs(null, null);
    expect(absent.args).toEqual([]);
    expect(absent.kwargs).toEqual({});
    const malformed = new fromJs('x', [1]);
    expect(malformed.args).toBe('x');
    expect(malformed.kwargs).toEqual([1]);
  });

  test('brand: Symbol.for(thruway.js.yield), own, non-enumerable, read-only', () => {
    expect(YIELD_BRAND).toBe(BRAND);
    expect(Object.getOwnPropertyDescriptor(new Yield(), BRAND)).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(JSON.parse(JSON.stringify(new Yield([1], { a: 1 })))).toEqual({ args: [1], kwargs: { a: 1 } });
  });

  test('subclasses stay Yields', () => {
    class Tagged extends Yield {
      readonly tag = 'x';
    }
    expect(isYield(new Tagged([1]))).toBe(true);
  });
});

describe('isYield', () => {
  test('true for a Yield and for a branded object from another copy', () => {
    expect(isYield(new Yield())).toBe(true);
    expect(isYield(Object.defineProperty({ args: [], kwargs: {} }, BRAND, { value: true }))).toBe(true);
  });

  test('false for look-alikes, other brand values and non-objects', () => {
    expect(isYield({ args: [1], kwargs: {} })).toBe(false);
    for (const brand of [1, 'true', {}, null, undefined, false]) expect(isYield({ [BRAND]: brand })).toBe(false);
    for (const value of [undefined, null, 0, '', 'yield', Symbol('y'), true, () => 1, [], new Error('x')]) {
      expect(isYield(value)).toBe(false);
    }
  });

  test('never throws: throwing getter, hostile and revoked Proxies', () => {
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
    for (const value of [throwing, hostile, revoked]) expect(isYield(value)).toBe(false);
  });

  test('property: arbitrary values are not Yields', () => {
    fc.assert(
      fc.property(fc.anything({ withMap: true, withSet: true, withTypedArray: true }), (value) => {
        expect(isYield(value)).toBe(false);
      }),
    );
  });
});
