// protocol/decode.ts: the table — every inbound message type × allowed lengths × each field mutation ⇒ the expected
// class (header-fatal / payload-invalid / normalised / dropped), against the independent oracle of
// test/helpers/inbound-frames.ts — then the router quirks one by one, freezing, and frame texts.
import { describe, expect, test } from 'vitest';
import { decode, FRAME_TEXT_LIMIT, frameText, isId } from '../../src/protocol/decode.js';
import type { DecodeResult, InboundMessage } from '../../src/protocol/messages.js';
import {
  ANSWERABLE_REQUEST_TYPES,
  baseFrame,
  CLIENT_ONLY,
  CLOSING_TYPES,
  expectedClosing,
  expectedFor,
  FRAME_SPECS,
  MUTATIONS,
  type Expected,
} from '../helpers/inbound-frames.js';

function show(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (value === undefined) return 'missing';
  if (value instanceof Map) return 'Map';
  if (value instanceof Date) return 'Date';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null) return 'null-proto {}';
  return JSON.stringify(value);
}

function message(result: DecodeResult): InboundMessage {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.kind}: ${result.reason}`);
  return result.message;
}

/** Checks decode(frame) against the oracle; every reason and warning names the message type (`name`). */
function check(frame: readonly unknown[], expected: Expected, name: string): void {
  const result = decode(frame);
  expect(result.kind).toBe(expected.kind);
  if (result.kind !== 'message' || expected.kind !== 'message') {
    if (result.kind !== 'message') {
      expect(result.reason.startsWith(`${name} `)).toBe(true);
      expect(result.frame.length).toBeLessThanOrEqual(FRAME_TEXT_LIMIT);
    }
    if (result.kind === 'dropped') expect(['debug', 'warn']).toContain(result.level);
    return;
  }
  const { invalid, ...fields } = result.message as InboundMessage & { invalid?: { reason: string; frame: string } };
  expect(fields).toEqual(expected.fields);
  expect(invalid !== undefined).toBe(expected.invalid);
  if (invalid !== undefined) {
    expect(invalid.reason).toMatch(new RegExp(`^${name} (args|kwargs|details) is not (an array|a dict)$`));
    expect(invalid.frame).toBe(frameText(frame));
  }
  expect(result.warnings).toHaveLength(expected.warnings);
  for (const warning of result.warnings) expect(warning.startsWith(`${name} `)).toBe(true);
}

describe('the decode table', () => {
  for (const spec of FRAME_SPECS) {
    describe(spec.name, () => {
      const base = baseFrame(spec);
      const lengths = Array.from({ length: spec.fields.length + 2 }, (_, i) => i + 1);
      test.each(lengths)('length %i', (length) => {
        const frame = base.slice(0, length);
        if (length > base.length) frame.push('trailing', { extra: true });
        check(frame, expectedFor(spec, frame), spec.name);
      });
      const rows = spec.fields.flatMap((f, i) =>
        MUTATIONS[f.kind].map((value) => ({ name: `${f.prop} = ${show(value)}`, index: i + 1, value })),
      );
      test.each(rows)('$name', ({ index, value }) => {
        const frame = base.slice();
        frame[index] = value;
        check(frame, expectedFor(spec, frame), spec.name);
      });
    });
  }

  for (const { name, type } of CLOSING_TYPES) {
    describe(name, () => {
      const values: unknown[] = [undefined, null, [], 'wamp.error.x', '', { message: 'm' }, {}, 1, [1], true];
      const rows = values.flatMap((first) => values.map((second) => ({ first, second })));
      test.each(rows)('[%#] elements 1–2', ({ first, second }) => {
        const frame: unknown[] = [type, first, second];
        while (frame.length > 1 && frame[frame.length - 1] === undefined) frame.pop();
        check(frame, expectedClosing(type, frame), name);
      });
      test.each([1, 2, 3, 4, 5, 6])('length %i', (length) => {
        const frame = [type, { message: 'bye' }, 'wamp.close.system_shutdown', ['arg'], { kw: 1 }, 'x'].slice(
          0,
          length,
        );
        check(frame, expectedClosing(type, frame), name);
      });
    });
  }

  describe('revocation forms', () => {
    const forms: { name: string; frame: unknown[]; expected: string }[] = [
      { name: 'UNSUBSCRIBED revocation', frame: [35, 0, { subscription: 99, reason: 'gone' }], expected: 'message' },
      { name: 'UNREGISTERED revocation', frame: [67, 0, { registration: 77 }], expected: 'message' },
      { name: 'UNSUBSCRIBED 0, no dict', frame: [35, 0], expected: 'message' },
      { name: 'UNSUBSCRIBED 0, empty dict', frame: [35, 0, {}], expected: 'dropped' },
      { name: 'UNSUBSCRIBED 0, [] dict', frame: [35, 0, []], expected: 'dropped' },
      { name: 'UNSUBSCRIBED 0, null dict', frame: [35, 0, null], expected: 'dropped' },
      { name: 'UNSUBSCRIBED 0, string id', frame: [35, 0, { subscription: '99' }], expected: 'dropped' },
      { name: 'UNREGISTERED 0, negative id', frame: [67, 0, { registration: -1 }], expected: 'dropped' },
      { name: 'UNREGISTERED 0, wrong key', frame: [67, 0, { subscription: 77 }], expected: 'dropped' },
      { name: 'UNSUBSCRIBED 0, id 0', frame: [35, 0, { subscription: 0 }], expected: 'message' },
      { name: 'UNSUBSCRIBED 5 with dict', frame: [35, 5, { subscription: 99 }], expected: 'message' },
      {
        name: 'UNSUBSCRIBED revocation, reason not a string',
        frame: [35, 0, { subscription: 9, reason: 4 }],
        expected: 'message',
      },
      {
        name: 'UNREGISTERED revocation, extra elements',
        frame: [67, 0, { registration: 7, reason: 'r' }, 'x'],
        expected: 'message',
      },
    ];
    test.each(forms)('$name', ({ frame, expected }) => {
      const spec = FRAME_SPECS.find((s) => s.type === frame[0])!;
      const oracle = expectedFor(spec, frame);
      expect(oracle.kind).toBe(expected);
      check(frame, oracle, spec.name);
    });
  });
});

describe('element 0 and the frame itself', () => {
  test.each([{}, 'x', '[2,1,{}]', 1, null, undefined, true, new Uint8Array([91, 93])])(
    'a non-array (%s) is fatal',
    (value) => {
      expect(decode(value)).toMatchObject({ kind: 'fatal', reason: 'frame is not an array' });
    },
  );
  test('the empty array is fatal', () => {
    expect(decode([])).toMatchObject({ kind: 'fatal', reason: 'frame is empty' });
  });
  test.each([['2'], [2.5], [null], [NaN], [Infinity], [{}], [[2]], [true]])('type %j is fatal', (...frame) => {
    expect(decode([...frame, 1, {}])).toMatchObject({ kind: 'fatal', reason: 'message type is not an integer' });
  });
  test.each([0, -1, 7, 9, 18, 255, 256, 1000, 1023, 1024, 2 ** 40])('unknown type %i is dropped (warn)', (type) => {
    expect(decode([type, 1, {}])).toMatchObject({
      kind: 'dropped',
      level: 'warn',
      reason: `unknown message type ${String(type)}`,
    });
  });
  test('7 HEARTBEAT is dropped', () => {
    expect(decode([7, 1, 2])).toMatchObject({ kind: 'dropped', level: 'warn' });
  });
  test.each(CLIENT_ONLY)('client-only type %i is dropped (warn)', (type) => {
    expect(decode([type, 1, {}, 'a.b'])).toMatchObject({
      kind: 'dropped',
      level: 'warn',
      reason: `client-only message type ${String(type)}`,
    });
  });
  test('a type given as 2.0 is the integer 2', () => {
    expect(decode([2.0, 1, {}]).kind).toBe('message');
  });
});

describe('ids', () => {
  test.each([0, 1, 2 ** 31, 2 ** 53 - 1, 2 ** 53])('%d is an id', (n) => {
    expect(isId(n)).toBe(true);
  });
  test.each([-1, 0.5, 2 ** 53 + 2, 2 ** 54, NaN, Infinity, -Infinity, '1', null, undefined, 1n, {}, []])(
    '%s is not an id',
    (v) => {
      expect(isId(v)).toBe(false);
    },
  );
});

describe('router quirks', () => {
  test('Thruway T2: the bogus [8,8,…] after killnowait is a message for routing to drop', () => {
    const msg = message(decode([8, 8, 123, {}, 'wamp.error.no_such_procedure']));
    expect(msg).toMatchObject({ type: 8, requestType: 8, requestId: 123, error: 'wamp.error.no_such_procedure' });
  });
  test('Thruway T2, malformed: an ERROR for a request type the client never sends is dropped, never fatal', () => {
    for (const [type, frame] of [
      [8, [8, 8, 'x', {}, 'wamp.error.no_such_procedure']],
      [8, [8, 8, 123, {}, null]],
      [68, [8, 68, -1]],
      [70, [8, 70]],
    ] as const) {
      expect(decode(frame)).toMatchObject({
        kind: 'dropped',
        level: 'warn',
        reason: `ERROR for request type ${String(type)} is malformed`,
      });
    }
  });
  test('an ERROR for a request type the client sends is fatal when its id or URI is broken', () => {
    expect(decode([8, 48, 'x', {}, 'wamp.error.canceled'])).toMatchObject({
      kind: 'fatal',
      reason: 'ERROR request id is not an id',
    });
    expect(decode([8, 48, 7, {}, 42])).toMatchObject({ kind: 'fatal', reason: 'ERROR URI is not a string' });
    expect(decode([8, '48', 7, {}, 'u'])).toMatchObject({
      kind: 'fatal',
      reason: 'ERROR request type is not an integer',
    });
  });
  test.each(ANSWERABLE_REQUEST_TYPES)(
    'an ERROR answering request type %i (49 = Thruway T2 cancel replies) is fatal with a broken id or URI',
    (type) => {
      for (const id of ['7', -1, 1.5, null, undefined]) {
        expect(decode([8, type, id, {}, 'wamp.error.canceled'])).toMatchObject({
          kind: 'fatal',
          reason: 'ERROR request id is not an id',
        });
      }
      for (const uri of [42, null, undefined, {}, ['u']]) {
        expect(decode([8, type, 7, {}, uri])).toMatchObject({ kind: 'fatal', reason: 'ERROR URI is not a string' });
      }
    },
  );
  test.each([8, 68, 70, 0, -1, 1, 50, 1024])('a broken ERROR for request type %i (never sent) is dropped', (type) => {
    for (const frame of [
      [8, type, '7', {}, 'u'],
      [8, type, 7, {}, 42],
    ]) {
      expect(decode(frame)).toMatchObject({ kind: 'dropped', level: 'warn' });
    }
  });
  test('Thruway T2 / Bondy: ERROR with request type 49 keeps its type (routed like 48)', () => {
    const msg = message(decode([8, 49, 7, {}, 'wamp.error.canceled']));
    expect(msg).toMatchObject({ requestType: 49, requestId: 7, error: 'wamp.error.canceled', args: [], kwargs: {} });
  });
  test('Thruway IC: a PHP array with holes as args is payload-invalid, not fatal', () => {
    const result = decode([36, 99, 5, {}, { 0: 'a', 2: 'c' }]);
    const msg = message(result) as InboundMessage & { invalid?: { reason: string; frame: string } };
    expect(msg).toMatchObject({ type: 36, subscriptionId: 99, publicationId: 5, args: [], kwargs: {}, details: {} });
    expect(msg.invalid).toEqual({ reason: 'EVENT args is not an array', frame: '[36,99,5,{},{"0":"a","2":"c"}]' });
  });
  test('Thruway IC: json_encode([]) dicts (details, options, kwargs) are {}', () => {
    expect(message(decode([50, 7, [], ['x'], []]))).toEqual({
      type: 50,
      requestId: 7,
      details: {},
      args: ['x'],
      kwargs: {},
    });
    expect(message(decode([69, 8, []]))).toEqual({ type: 69, requestId: 8, options: {} });
    expect(decode([2, 1, []])).toEqual({
      kind: 'message',
      message: { type: 2, sessionId: 1, details: {} },
      warnings: [],
    });
  });
  test('a non-empty array as a dict is invalid', () => {
    expect(message(decode([50, 7, [1]]))).toHaveProperty('invalid.reason', 'RESULT details is not a dict');
    expect(message(decode([50, 7, {}, [], [1]]))).toHaveProperty('invalid.reason', 'RESULT kwargs is not a dict');
  });
  test('fox-wamp / wamp-server: null args and kwargs are [] and {}', () => {
    expect(message(decode([50, 7, {}, null, null]))).toEqual({
      type: 50,
      requestId: 7,
      details: {},
      args: [],
      kwargs: {},
    });
    expect(message(decode([68, 8, 77, {}, ['a'], null]))).toMatchObject({ args: ['a'], kwargs: {} });
  });
  test('Thruway INTERRUPT carries {} (no mode)', () => {
    expect(message(decode([69, 8, {}]))).toEqual({ type: 69, requestId: 8, options: {} });
  });
  test('wamp-server: swapped ABORT fields', () => {
    const result = decode([3, 'wamp.error.no_such_realm', { message: 'no realm' }]);
    expect(result).toEqual({
      kind: 'message',
      message: { type: 3, reason: 'wamp.error.no_such_realm', details: { message: 'no realm' } },
      warnings: [],
    });
  });
  test('Thruway / fox-wamp legacy GOODBYE reply', () => {
    expect(message(decode([6, {}, 'wamp.error.goodbye_and_out']))).toEqual({
      type: 6,
      details: {},
      reason: 'wamp.error.goodbye_and_out',
    });
  });
  test('ABORT without a reason: wamp.error.unknown, with a warning; never fatal', () => {
    expect(decode([3])).toEqual({
      kind: 'message',
      message: { type: 3, reason: 'wamp.error.unknown', details: {} },
      warnings: ['ABORT has no reason; using wamp.error.unknown'],
    });
    expect(decode([6, 42, 43]).kind).toBe('message');
  });
  test('ABORT with args/kwargs: the payload is ignored', () => {
    expect(message(decode([3, { message: 'm' }, 'wamp.error.not_authorized', ['a'], { k: 1 }]))).toEqual({
      type: 3,
      details: { message: 'm' },
      reason: 'wamp.error.not_authorized',
    });
  });
  test('an invalid WELCOME/CHALLENGE/INTERRUPT dict becomes {} with a warning', () => {
    expect(decode([2, 1, 'x'])).toEqual({
      kind: 'message',
      message: { type: 2, sessionId: 1, details: {} },
      warnings: ['WELCOME details is not a dict; using {}'],
    });
    expect(decode([4, 'ticket', 5])).toMatchObject({ warnings: ['CHALLENGE extra is not a dict; using {}'] });
    expect(decode([69, 1, 'kill'])).toMatchObject({ warnings: ['INTERRUPT options is not a dict; using {}'] });
  });
  test('Crossbar x_cb_* and other unknown WELCOME keys pass through', () => {
    const details = { x_cb_node: 'n', authroles: ['a'], roles: {} };
    expect(message(decode([2, 5, details]))).toEqual({ type: 2, sessionId: 5, details });
  });
  test('2^53 is a valid id (Thruway payload fidelity), 2^53 + 2 is not', () => {
    expect(message(decode([50, 2 ** 53, {}]))).toMatchObject({ requestId: 2 ** 53 });
    expect(decode([50, 2 ** 53 + 2, {}]).kind).toBe('fatal');
  });
  test('an empty progress RESULT (Thruway keepalive) is a valid message', () => {
    expect(message(decode([50, 7, { progress: true }]))).toEqual({
      type: 50,
      requestId: 7,
      details: { progress: true },
      args: [],
      kwargs: {},
    });
  });
});

describe('what the decoder hands on', () => {
  test('received dicts are frozen in place', () => {
    const details = { a: { nested: true } };
    const msg = message(decode([36, 1, 2, details, [1], { k: 1 }]));
    expect(msg).toHaveProperty('details', details);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.a)).toBe(false); // shallow
    for (const frame of [
      [2, 1, {}],
      [3, {}, 'r'],
      [4, 'm', {}],
      [6, {}, 'r'],
      [8, 48, 1, {}, 'u'],
      [50, 1, {}],
      [68, 1, 2, {}],
      [69, 1, {}],
      [35, 0, { subscription: 1 }],
      [67, 0, { registration: 1 }],
    ]) {
      const decoded = message(decode(frame)) as unknown as Record<string, unknown>;
      const dict = decoded['details'] ?? decoded['extra'] ?? decoded['options'];
      expect(Object.isFrozen(dict)).toBe(true);
    }
  });
  test('payloads are neither copied nor frozen', () => {
    const args = [1, 2];
    const kwargs = { k: 1 };
    const msg = message(decode([50, 7, {}, args, kwargs])) as unknown as { args: unknown; kwargs: unknown };
    expect(msg.args).toBe(args);
    expect(msg.kwargs).toBe(kwargs);
    expect(Object.isFrozen(args)).toBe(false);
    expect(Object.isFrozen(kwargs)).toBe(false);
  });
  test('missing payloads are fresh objects per message (an app mutating one changes nothing else)', () => {
    const a = message(decode([50, 7, {}])) as unknown as { args: unknown[]; kwargs: Record<string, unknown> };
    const b = message(decode([50, 8, {}])) as unknown as { args: unknown[]; kwargs: Record<string, unknown> };
    expect(a.args).not.toBe(b.args);
    expect(a.kwargs).not.toBe(b.kwargs);
    a.args.push(1);
    a.kwargs['x'] = 1;
    expect(b).toMatchObject({ args: [], kwargs: {} });
  });
  test('trailing elements beyond the arity are ignored', () => {
    expect(message(decode([33, 7, 99, 'extra', { more: 1 }]))).toEqual({
      type: 33,
      requestId: 7,
      subscriptionId: 99,
    });
  });
  test('a frame that cannot be read (hostile Proxy, throwing getter) is fatal, never a throw', () => {
    const throwing = new Proxy([50, 1, {}], {
      get() {
        throw new Error('boom');
      },
    });
    const revocable = Proxy.revocable([50, 1, {}], {});
    revocable.revoke();
    const getter = [50, 1];
    Object.defineProperty(getter, 2, {
      get() {
        throw new Error('getter');
      },
      enumerable: true,
    });
    const freezeTrap = [
      50,
      1,
      new Proxy(
        {},
        {
          preventExtensions() {
            throw new Error('no');
          },
        },
      ),
    ];
    for (const frame of [throwing, revocable.proxy, getter, freezeTrap]) {
      const result = decode(frame);
      expect(result.kind).toBe('fatal');
    }
  });
});

describe('frame texts', () => {
  test('arrays are rendered as JSON and truncated to 256 characters', () => {
    expect(frameText([2, 'x', {}])).toBe('[2,"x",{}]');
    const long = frameText([50, 1, {}, ['x'.repeat(10000)]]);
    expect(long.length).toBe(FRAME_TEXT_LIMIT);
    expect(long.endsWith('…')).toBe(true);
    const fatal = decode([33, 'id', 'y'.repeat(1000)]);
    expect(fatal.kind === 'fatal' && fatal.frame.length).toBe(FRAME_TEXT_LIMIT);
  });
  test('secrets are redacted (the text reaches the app in ProtocolError.frame)', () => {
    const welcome = [
      2,
      'not-an-id',
      { authextra: { token: 'SECRET-1' }, transport: { headers: { cookie: 'SECRET-2' }, peer: 'tcp' } },
    ];
    const result = decode(welcome);
    expect(result.kind).toBe('fatal');
    expect(result.kind === 'fatal' && result.frame).not.toMatch(/SECRET/);
    expect(frameText([4, 'wampcra', { challenge: 'SECRET-3' }])).not.toMatch(/SECRET/);
    expect(frameText([5, 'SECRET-4', {}])).not.toMatch(/SECRET/);
    // a text frame (what the core passes when deserialize throws, e.g. a custom serializer) is redacted too
    const text = JSON.stringify([
      2,
      1,
      { authextra: { token: 'SECRET-5' }, transport: { headers: { c: 'SECRET-6' } } },
    ]);
    expect(frameText(text)).not.toMatch(/SECRET/);
    expect(frameText(text)).toMatch(/^\[2,1,\{/);
    // text that does not parse cannot be redacted: it is shown as it is (truncated)
    expect(frameText('[2,1,{"authextra":{"t":"SECRET-7"}}, NaN')).toBe('[2,1,{"authextra":{"t":"SECRET-7"}}, NaN');
    const custom = decode(text);
    expect(custom.kind === 'fatal' && custom.frame).not.toMatch(/SECRET/);
  });
  test('non-arrays', () => {
    expect(frameText({ a: 1 })).toBe('{"a":1}');
    expect(frameText('x')).toBe('x'); // a string is a text frame (raw data that failed to deserialize)
    expect(frameText(42)).toBe('42');
    expect(frameText(null)).toBe('null');
    expect(frameText(undefined)).toBe('undefined');
    expect(frameText(new Uint8Array(3))).toBe('[binary 3 bytes]');
    const truncated = frameText({ big: 'z'.repeat(1000) });
    expect(truncated.length).toBe(FRAME_TEXT_LIMIT);
    expect(truncated.startsWith('{"big":"zzz')).toBe(true);
    expect(truncated.endsWith('…')).toBe(true); // only the opening bracket of the wrapper is removed
  });
  test('never throws: cycles, BigInt, throwing getters, revoked Proxies', () => {
    const cyclic: unknown[] = [50, 1];
    cyclic.push(cyclic);
    const getter = {};
    Object.defineProperty(getter, 'x', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const value of [cyclic, [1n], 1n, getter, [getter], revocable.proxy, Symbol('s'), () => 1]) {
      const text = frameText(value);
      expect(typeof text).toBe('string');
      expect(text.length).toBeLessThanOrEqual(FRAME_TEXT_LIMIT);
    }
    expect(frameText(cyclic)).toContain('[circular]');
    expect(frameText(revocable.proxy)).toBe('[unreadable frame]');
    expect(frameText([getter])).toBe('[unreadable frame]');
  });
});
