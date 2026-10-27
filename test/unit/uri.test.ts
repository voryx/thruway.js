// protocol/uri.ts: the loose rules by `match`, the implementation-specific `_…` escape hatch, Crossbar's quirk-8 URIs
// (which kill its connection) rejected locally, Thruway's T7 URIs accepted, linear time.
import { fc } from '@fast-check/vitest';
import { describe, expect, test } from 'vitest';
import { IMPLEMENTATION_SPECIFIC_POLICY, isValidUri } from '../../src/protocol/uri.js';
import { replayParameters } from '../setup-fast-check.js';

// JavaScript's `\s`, plus U+001C–U+001F and U+0085, which Python's `\s` (Crossbar's URI patterns) also matches.
const WHITESPACE = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  '　',
  '﻿',
  '\x1c',
  '\x1d',
  '\x1e',
  '\x1f',
  '\x85',
];

describe('exact (default, also realms and handler error URIs)', () => {
  test.each([
    'a',
    'a.b',
    'com.example.procedure',
    'wamp.session.on_join', // `wamp.` is not reserved by the client
    'com.example.get_items',
    'A.B', // Thruway lowercases procedures itself (T7)
    'a-b.c_d',
    'a/b:c',
    'café.ünïcödé',
    '*',
    '1.2.3',
    'thruway.js.ping',
    'x'.repeat(10000),
  ])('%s is valid', (uri) => {
    expect(isValidUri(uri)).toBe(true);
    expect(isValidUri(uri, 'exact')).toBe(true);
  });

  test.each(['', '.', '..', 'a.', '.a', 'a..b', 'a.b.', '#', 'a#', 'a#b', 'a.#.b'])('%j is invalid', (uri) => {
    expect(isValidUri(uri)).toBe(false);
    expect(isValidUri(uri, 'exact')).toBe(false);
  });

  test.each(WHITESPACE)('whitespace %j anywhere is invalid', (ws) => {
    for (const uri of [`a${ws}b`, `${ws}a`, `a${ws}`, `a.${ws}.b`, ws]) {
      expect(isValidUri(uri)).toBe(false);
      expect(isValidUri(uri, 'prefix')).toBe(false);
      expect(isValidUri(uri, 'wildcard')).toBe(false);
      expect(isValidUri(uri, '_mqtt')).toBe(false);
    }
  });

  test("whitespace is JavaScript's \\s and Python's \\s together (Crossbar quirk 8 checks with Python patterns)", () => {
    // python3 -c "import re; print([hex(c) for c in range(0x110000) if re.match(r'\s', chr(c))])"
    const python = new Set([
      0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
      0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ]);
    const wrong: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if ((code >= 0xd800 && code <= 0xdfff) || code === 0x2e) continue; // lone surrogates; '.' is the separator
      const ch = String.fromCharCode(code);
      const space = python.has(code) || /\s/.test(ch);
      const valid = !space && ch !== '#';
      const hex = `U+${code.toString(16)}`;
      if (isValidUri(`a${ch}b`) !== valid) wrong.push(`exact ${hex}`);
      if (isValidUri(`a.${ch}`, 'prefix') !== valid) wrong.push(`prefix ${hex}`);
      if (isValidUri(`a..${ch}`, 'wildcard') !== valid) wrong.push(`wildcard ${hex}`);
      if (isValidUri(`a${ch}b`, '_mqtt') !== !space) wrong.push(`_mqtt ${hex}`);
    }
    expect(wrong).toEqual([]);
  });

  test.each(['com..bad', 'com.bad uri', 'com.bad#x', '', 'com..x'])(
    'Crossbar quirk 8: %j (kills a Crossbar connection with 1011) is rejected',
    (uri) => {
      expect(isValidUri(uri)).toBe(false);
    },
  );

  test('non-strings are never valid', () => {
    const values: unknown[] = [undefined, null, 1, {}, [], ['a'], true];
    for (const value of values) {
      expect(isValidUri(value as string)).toBe(false);
      expect(isValidUri(value as string, '_mqtt')).toBe(false);
    }
  });
});

describe('prefix', () => {
  test.each(['', 'a', 'a.', 'a.b', 'a.b.', 'com.example.'])(
    '%j is valid (empty prefix and trailing dot allowed)',
    (uri) => {
      expect(isValidUri(uri, 'prefix')).toBe(true);
    },
  );
  test.each(['.', '.a', 'a..b', 'a..', 'a#', 'a.#'])('%j is invalid', (uri) => {
    expect(isValidUri(uri, 'prefix')).toBe(false);
  });
});

describe('wildcard', () => {
  test.each(['', '.', '..', 'a..b', '.a', 'a.', '.b.', 'com..get', 'a.b.c'])(
    '%j is valid (empty components allowed)',
    (uri) => {
      expect(isValidUri(uri, 'wildcard')).toBe(true);
    },
  );
  test.each(['a#', 'a.#.b', '#'])('%j is invalid', (uri) => {
    expect(isValidUri(uri, 'wildcard')).toBe(false);
  });
});

describe('implementation-specific match (`_…`)', () => {
  test.each(['_mqtt', '_thruway', '_abc', '_a_b_c', '_123'])('%s selects "non-empty, no whitespace"', (match) => {
    expect(IMPLEMENTATION_SPECIFIC_POLICY.test(match)).toBe(true);
    for (const uri of ['a/+/b', 'a.#', '#', 'a..b', '.', 'sensors/*/temp', 'ab']) {
      expect(isValidUri(uri, match)).toBe(true);
    }
    expect(isValidUri('', match)).toBe(false);
    expect(isValidUri('a b', match)).toBe(false);
  });

  test.each(['_', '_ab', '_ABC', '_a-b', 'mqtt', '__', ' _abc', '_abc '])(
    '%j is not an implementation-specific value: the exact rule applies',
    (match) => {
      expect(IMPLEMENTATION_SPECIFIC_POLICY.test(match)).toBe(false);
      expect(isValidUri('a..b', match)).toBe(false);
      expect(isValidUri('a.b', match)).toBe(true);
    },
  );

  test('an unknown policy selects the exact rule', () => {
    expect(isValidUri('a..b', 'regex')).toBe(false);
    expect(isValidUri('a.b', 'regex')).toBe(true);
  });
});

describe('properties', () => {
  const component = fc.string({ minLength: 1, maxLength: 6 }).filter((c) => !/[\s.#]/.test(c));

  test('components joined by dots are valid under every rule', () => {
    fc.assert(
      fc.property(fc.array(component, { minLength: 1, maxLength: 6 }), (parts) => {
        const uri = parts.join('.');
        expect(isValidUri(uri)).toBe(true);
        expect(isValidUri(uri, 'prefix')).toBe(true);
        expect(isValidUri(uri, 'wildcard')).toBe(true);
        expect(isValidUri(uri, '_mqtt')).toBe(true);
      }),
      replayParameters(),
    );
  });

  test('an empty component is invalid for exact, valid for wildcard; a whitespace or # anywhere is invalid', () => {
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 2, maxLength: 6 }),
        fc.nat(),
        fc.constantFrom(...WHITESPACE, '#'),
        (parts, at, bad) => {
          const emptied = parts.slice();
          emptied[at % parts.length] = '';
          const uri = emptied.join('.');
          expect(isValidUri(uri)).toBe(false);
          expect(isValidUri(uri, 'wildcard')).toBe(true);
          const spoilt = parts.slice();
          spoilt[at % parts.length] = `${spoilt[at % parts.length] ?? ''}${bad}`;
          for (const match of [undefined, 'prefix', 'wildcard'])
            expect(isValidUri(spoilt.join('.'), match)).toBe(false);
        },
      ),
      replayParameters(),
    );
  });

  test('exact ⇒ prefix and wildcard', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12, unit: fc.constantFrom('a', 'b', '.', '#', ' ', ' ') }), (uri) => {
        if (isValidUri(uri)) {
          expect(isValidUri(uri, 'prefix')).toBe(true);
          expect(isValidUri(uri, 'wildcard')).toBe(true);
        }
      }),
      replayParameters(),
    );
  });
});

describe('linear time (no catastrophic backtracking)', () => {
  const long = 200000;
  test.each([
    'a'.repeat(long) + '#',
    'a.'.repeat(long / 2) + '#',
    'ab.'.repeat(long / 3) + ' ',
    '.'.repeat(long) + '#',
    'a.'.repeat(long / 2) + '.',
  ])('a %i-char URI that fails at its end is rejected quickly', (uri) => {
    const started = performance.now();
    for (const match of [undefined, 'prefix', 'wildcard', '_mqtt']) isValidUri(uri, match);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
