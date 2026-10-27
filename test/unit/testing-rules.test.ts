// The pure dialect decisions of the reference router (src/testing/rules.ts), pinned value by value: the router tests
// reach them through frames, where some outcomes look alike (an unknown option list, a verdict compared with
// 'malformed' only); here each table row is one decision.
import { describe, expect, test } from 'vitest';
import {
  authInfoOf,
  byteLength,
  forwardPayload,
  matches,
  optionTypesOk,
  read,
  requestIdVerdict,
  thruwayAuthDetails,
  thruwayEligible,
  uriAllowed,
} from '../../src/testing/rules.js';

describe('read', () => {
  test('a throwing getter reads as undefined', () => {
    const hostile = Object.defineProperty({}, 'x', {
      get: () => {
        throw new Error('no');
      },
    });
    expect([read(hostile, 'x'), read(null, 'x'), read({ x: 1 }, 'x')]).toEqual([undefined, undefined, 1]);
  });
});

describe('forwardPayload', () => {
  test('keep: the elements present, as they are', () => {
    expect(forwardPayload('keep', 'event', [1, [], {}], 1)).toEqual([[], {}]);
    expect(forwardPayload('keep', 'result', [1], 1)).toEqual([]);
  });
  test('strip-empty: null, empty args and empty kwargs are dropped; kwargs keep an args element', () => {
    expect(forwardPayload('strip-empty', 'event', [null], 0)).toEqual([]);
    expect(forwardPayload('strip-empty', 'event', [[], null], 0)).toEqual([]);
    expect(forwardPayload('strip-empty', 'event', [[1], {}], 0)).toEqual([[1]]);
    expect(forwardPayload('strip-empty', 'event', [null, { a: 1 }], 0)).toEqual([[], { a: 1 }]);
  });
  test('fox-wamp: a single null or array argument is unwrapped, others stay; kwargs null except for invocations', () => {
    expect(forwardPayload('fox-wamp', 'event', [[null]], 0)).toEqual([null, null]);
    expect(forwardPayload('fox-wamp', 'event', [[[1, 2]]], 0)).toEqual([[1, 2], null]);
    expect(forwardPayload('fox-wamp', 'event', [[null, 1]], 0)).toEqual([[null, 1], null]);
    expect(forwardPayload('fox-wamp', 'event', [[1]], 0)).toEqual([[1], null]);
    expect(forwardPayload('fox-wamp', 'invocation', [], 0)).toEqual([null, {}]);
  });
  test('wamp-server: null for absent elements; a RESULT carries args only', () => {
    expect(forwardPayload('wamp-server', 'result', [], 0)).toEqual([null]);
    expect(forwardPayload('wamp-server', 'event', [[1]], 0)).toEqual([[1], null]);
  });
});

describe('matches', () => {
  test.each([
    ['com.a', 'exact', 'com.a', false, true],
    ['com..b', 'exact', 'com.x.b', false, false],
    ['com.', 'prefix', 'com.x', false, true],
    ['com..b', 'wildcard', 'com.x.b', false, true],
    ['com..b', 'wildcard', 'com.x.y.b', false, false],
    ['#', 'exact', 'a.b', true, true],
    ['a.#', 'exact', 'a', true, true],
    ['a.*.#', 'exact', 'a', true, false],
    ['a.*.#', 'exact', 'a.b.c.d', true, true],
    ['a.*', 'exact', 'a.b.c', true, false],
    ['a.*', 'exact', 'a.b', true, true],
  ] as const)('%s %s %s (mqtt: %s) ⇒ %s', (pattern, match, uri, mqtt, expected) => {
    expect(matches(pattern, match, uri, mqtt)).toBe(expected);
  });
});

describe('uriAllowed', () => {
  test.each([
    ['none', 'Bad URI', 'exact', true],
    ['loose', 'com.a', 'exact', true],
    ['loose', 'com a', 'exact', false],
    ['strict', 'com.a', 'exact', true],
    ['strict', 'com.', 'exact', false],
    ['strict', 'com.', 'prefix', true],
    ['strict', 'com.x', 'prefix', true],
    ['strict', 'com..', 'prefix', false],
    ['strict', '', 'prefix', true],
    ['strict', '', 'exact', false],
    ['strict', 'Com', 'prefix', false],
  ] as const)('%s %j %s ⇒ %s', (rule, uri, match, expected) => {
    expect(uriAllowed(rule, uri, match)).toBe(expected);
  });
});

describe('requestIdVerdict', () => {
  test.each([
    ['spec', 1, 'ok'],
    ['spec', 0, 'malformed'],
    ['range', 0, 'ok'],
    ['range', 2 ** 53, 'ok'],
    ['range', 2 ** 53 + 2, 'malformed'],
    ['range', -1, 'malformed'],
    ['range', 1.5, 'malformed'],
    ['none', 'x', 'ok'],
    ['none-but-zero', 0, 'ignore'],
    ['none-but-zero', -3, 'ok'],
  ] as const)('%s %s ⇒ %s', (rule, id, expected) => {
    expect(requestIdVerdict(rule, id)).toBe(expected);
  });
});

describe('optionTypesOk (Crossbar)', () => {
  test.each([
    [16, 'acknowledge'],
    [16, 'exclude_me'],
    [16, 'disclose_me'],
    [16, 'retain'],
    [48, 'receive_progress'],
    [48, 'disclose_me'],
    [64, 'disclose_caller'],
  ])('type %d: %s must be a boolean', (type, key) => {
    expect(optionTypesOk(type, { [key]: true })).toBe(true);
    expect(optionTypesOk(type, { [key]: 1 })).toBe(false);
  });
  test('the boolean keys belong to their message type only', () => {
    expect(optionTypesOk(64, { acknowledge: 1, receive_progress: 1 })).toBe(true);
    expect(optionTypesOk(16, { disclose_caller: 1 })).toBe(true);
    expect(optionTypesOk(34, { acknowledge: 1 })).toBe(true);
  });
  test('timeout: an integer on CALL only; match: a known policy on SUBSCRIBE/REGISTER only; invoke: REGISTER only', () => {
    expect(optionTypesOk(48, { timeout: 1.5 })).toBe(false);
    expect(optionTypesOk(48, { timeout: 100 })).toBe(true);
    expect(optionTypesOk(32, { timeout: 'x' })).toBe(true);
    for (const type of [32, 64]) {
      expect(optionTypesOk(type, { match: 'exact' })).toBe(true);
      expect(optionTypesOk(type, { match: 'prefix' })).toBe(true);
      expect(optionTypesOk(type, { match: 'wildcard' })).toBe(true);
      expect(optionTypesOk(type, { match: 'regex' })).toBe(false);
    }
    expect(optionTypesOk(48, { match: 'regex' })).toBe(true);
    for (const invoke of ['single', 'roundrobin', 'random', 'first', 'last']) {
      expect(optionTypesOk(64, { invoke })).toBe(true);
    }
    expect(optionTypesOk(64, { invoke: 'fastest' })).toBe(false);
    expect(optionTypesOk(32, { invoke: 'fastest' })).toBe(true);
  });
  test('CANCEL: a known mode or none', () => {
    expect(['skip', 'kill', 'killnowait', undefined, 'other'].map((mode) => optionTypesOk(49, { mode }))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('auth details', () => {
  test('authInfoOf: the WELCOME details, Thruway’s anonymous defaults without them', () => {
    expect(authInfoOf({ authid: 'joe', authrole: 'user', authroles: ['user', 'x'], authmethod: 'ticket' })).toEqual({
      authid: 'joe',
      authrole: 'user',
      authroles: ['user', 'x'],
      authmethod: 'ticket',
    });
    expect(authInfoOf({ authrole: 'user', authroles: 'user' })).toEqual({
      authid: 'anonymous',
      authrole: 'user',
      authroles: ['user'],
      authmethod: 'anonymous',
    });
  });
  test('thruwayAuthDetails: addAuthRole order, authid default, authmethod only when forced', () => {
    const plain = thruwayAuthDetails({ authroles: ['a', 'b'], authrole: 'r', extra: 1 }, undefined);
    expect(plain).toStrictEqual({
      authroles: ['r', 'a', 'b', 'authenticated_user'],
      authrole: 'r',
      extra: 1,
      authid: 'authenticated_user',
    });
    expect(thruwayAuthDetails({ authid: 'joe' }, 'ticket')).toStrictEqual({
      authid: 'joe',
      authmethod: 'ticket',
      authrole: 'authenticated_user',
      authroles: ['authenticated_user'],
    });
  });
});

test('thruwayEligible: session lists, then any role and the authid against Thruway’s own lists', () => {
  const auth = authInfoOf({ authid: 'ann', authrole: 'user', authroles: ['user', 'authenticated_user'] });
  const verdicts = [
    {},
    { eligible: [7] },
    { eligible: [8] },
    { exclude: [7] },
    { exclude: [8] },
    { eligible: 7 }, // not an array: not a list (is_array)
    { _thruway_eligible_authroles: ['authenticated_user'] },
    { _thruway_eligible_authroles: ['admin'] },
    { _thruway_eligible_authroles: 'user' },
    { _thruway_eligible_authroles: null },
    { _thruway_eligible_authids: ['ann'] },
    { _thruway_eligible_authids: ['bob'] },
    { _thruway_eligible_authids: {} },
    { _thruway_eligible_authids: ['ann'], _thruway_eligible_authroles: ['admin'] },
    { eligible_authid: ['bob'], exclude_authid: ['ann'], eligible_authrole: ['admin'], exclude_authrole: ['user'] },
  ].map((options) => thruwayEligible(7, auth, options));
  expect(verdicts).toEqual([
    true,
    true,
    false,
    false,
    true,
    true,
    true,
    false,
    false,
    true,
    true,
    false,
    false,
    false,
    true,
  ]);
});

test('byteLength: UTF-8 bytes of text, the length of binary data', () => {
  expect([byteLength('é€'), byteLength(new Uint8Array(3))]).toEqual([5, 3]);
});
