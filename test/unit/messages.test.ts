// protocol/codes.ts and protocol/messages.ts: every message type code, the URI constants, and one builder per outbound
// frame producing exactly the specified tuple.
import { fc, test as prop } from '@fast-check/vitest';
import { describe, expect, test } from 'vitest';
import {
  CLIENT_ONLY_TYPES,
  CloseCode,
  GOODBYE_REPLY_REASONS,
  IMPLEMENTATION_SPECIFIC_TYPES,
  MessageType,
  ROUTER_TO_CLIENT_TYPES,
  Uri,
} from '../../src/protocol/codes.js';
import {
  abortFrame,
  authenticateFrame,
  callFrame,
  cancelFrame,
  goodbyeFrame,
  helloFrame,
  invocationErrorFrame,
  MAX_FRAME_BYTES,
  probeFrame,
  publishFrame,
  registerFrame,
  subscribeFrame,
  unregisterFrame,
  unsubscribeFrame,
  yieldFrame,
  type OutboundPayload,
} from '../../src/protocol/messages.js';

describe('codes', () => {
  test('every WAMP v2 message type code', () => {
    expect(MessageType).toEqual({
      HELLO: 1,
      WELCOME: 2,
      ABORT: 3,
      CHALLENGE: 4,
      AUTHENTICATE: 5,
      GOODBYE: 6,
      HEARTBEAT: 7,
      ERROR: 8,
      PUBLISH: 16,
      PUBLISHED: 17,
      SUBSCRIBE: 32,
      SUBSCRIBED: 33,
      UNSUBSCRIBE: 34,
      UNSUBSCRIBED: 35,
      EVENT: 36,
      CALL: 48,
      CANCEL: 49,
      RESULT: 50,
      REGISTER: 64,
      REGISTERED: 65,
      UNREGISTER: 66,
      UNREGISTERED: 67,
      INVOCATION: 68,
      INTERRUPT: 69,
      YIELD: 70,
    });
  });
  test('router→client and client-only sets partition the types (HEARTBEAT is in neither)', () => {
    const all = Object.values(MessageType);
    for (const type of all) {
      const inRouter = ROUTER_TO_CLIENT_TYPES.has(type);
      const inClient = CLIENT_ONLY_TYPES.has(type);
      expect(inRouter && inClient).toBe(false);
      expect(inRouter || inClient).toBe(type !== MessageType.HEARTBEAT);
    }
    expect([...CLIENT_ONLY_TYPES].sort((a, b) => a - b)).toEqual([1, 5, 16, 32, 34, 48, 49, 64, 66, 70]);
    expect(IMPLEMENTATION_SPECIFIC_TYPES).toEqual({ min: 256, max: 1023 });
  });
  test('URIs: both goodbye_and_out spellings, the client reasons, revocations, the probe', () => {
    expect(Uri.GOODBYE_AND_OUT).toBe('wamp.close.goodbye_and_out');
    expect(Uri.GOODBYE_AND_OUT_LEGACY).toBe('wamp.error.goodbye_and_out');
    expect(Uri.CLOSE_REALM).toBe('wamp.close.close_realm');
    expect(Uri.CLOSE_NORMAL).toBe('wamp.close.normal');
    expect(Uri.PROTOCOL_VIOLATION).toBe('wamp.error.protocol_violation');
    expect(Uri.CANNOT_AUTHENTICATE).toBe('wamp.error.cannot_authenticate');
    expect(Uri.CANCELED).toBe('wamp.error.canceled');
    expect(Uri.CANCELLED).toBe('wamp.error.cancelled');
    expect(Uri.PAYLOAD_SIZE_EXCEEDED).toBe('wamp.error.payload_size_exceeded');
    expect(Uri.SUBSCRIPTION_REVOKED).toBe('thruway.error.subscription_revoked');
    expect(Uri.REGISTRATION_REVOKED).toBe('thruway.error.registration_revoked');
    expect(Uri.THRUWAY_AUTHENTICATION_FAILURE).toBe('thruway.error.authentication_failure');
    expect(Uri.PING_PROCEDURE).toBe('thruway.js.ping');
    expect([...GOODBYE_REPLY_REASONS].sort()).toEqual([
      'wamp.close.goodbye_and_out',
      'wamp.close.normal',
      'wamp.error.goodbye_and_out',
    ]);
    for (const uri of Object.values(Uri)) expect(uri).toMatch(/^([^\s.#]+\.)*([^\s.#]+)$/);
  });
  test('close codes and the frame limit', () => {
    expect(CloseCode).toEqual({ NORMAL: 1000, PROTOCOL_VIOLATION: 4000, CLIENT_TIMEOUT: 4001, INTERNAL_ERROR: 4002 });
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe('outbound builders: every outbound frame', () => {
  const options = { disclose_me: true };
  test('HELLO, AUTHENTICATE, ABORT, GOODBYE', () => {
    expect(helloFrame('realm1', { agent: 'thruway.js/3.0.0' })).toEqual([1, 'realm1', { agent: 'thruway.js/3.0.0' }]);
    expect(authenticateFrame('sig')).toEqual([5, 'sig', {}]);
    expect(authenticateFrame('')).toEqual([5, '', {}]);
    expect(abortFrame('wamp.error.cannot_authenticate', 'no')).toEqual([
      3,
      { message: 'no' },
      'wamp.error.cannot_authenticate',
    ]);
    expect(abortFrame('wamp.error.protocol_violation', 'bad')).toEqual([
      3,
      { message: 'bad' },
      'wamp.error.protocol_violation',
    ]);
    expect(goodbyeFrame('wamp.close.goodbye_and_out')).toEqual([6, {}, 'wamp.close.goodbye_and_out']);
    expect(goodbyeFrame('wamp.close.close_realm')).toEqual([6, {}, 'wamp.close.close_realm']);
  });
  test('CALL (+ probe) and CANCEL', () => {
    expect(callFrame(7, options, 'com.p')).toEqual([48, 7, options, 'com.p']);
    expect(callFrame(7, {}, 'com.p', [[1, 2]])).toEqual([48, 7, {}, 'com.p', [1, 2]]);
    expect(callFrame(7, {}, 'com.p', [[], { a: 1 }])).toEqual([48, 7, {}, 'com.p', [], { a: 1 }]);
    expect(probeFrame(9)).toEqual([48, 9, {}, 'thruway.js.ping']);
    expect(cancelFrame(7)).toEqual([49, 7, { mode: 'killnowait' }]);
  });
  test('PUBLISH, SUBSCRIBE, UNSUBSCRIBE', () => {
    expect(publishFrame(3, { acknowledge: true }, 'com.t')).toEqual([16, 3, { acknowledge: true }, 'com.t']);
    expect(publishFrame(3, {}, 'com.t', [['x'], { y: 1 }])).toEqual([16, 3, {}, 'com.t', ['x'], { y: 1 }]);
    expect(subscribeFrame(4, { match: 'prefix' }, 'com.')).toEqual([32, 4, { match: 'prefix' }, 'com.']);
    expect(unsubscribeFrame(5, 12345)).toEqual([34, 5, 12345]);
  });
  test('REGISTER, UNREGISTER, YIELD, ERROR', () => {
    expect(registerFrame(6, {}, 'com.p')).toEqual([64, 6, {}, 'com.p']);
    expect(unregisterFrame(8, 99)).toEqual([66, 8, 99]);
    expect(yieldFrame(11, false)).toEqual([70, 11, {}]);
    expect(yieldFrame(11, true, [[1]])).toEqual([70, 11, { progress: true }, [1]]);
    expect(yieldFrame(11, false, [[], { k: 'v' }])).toEqual([70, 11, {}, [], { k: 'v' }]);
    expect(invocationErrorFrame(11, {}, 'wamp.error.canceled')).toEqual([8, 68, 11, {}, 'wamp.error.canceled']);
    expect(invocationErrorFrame(11, {}, 'wamp.error.runtime_error', [['boom']])).toEqual([
      8,
      68,
      11,
      {},
      'wamp.error.runtime_error',
      ['boom'],
    ]);
  });

  const payload: fc.Arbitrary<OutboundPayload> = fc.oneof(
    fc.constant([] as const),
    fc.tuple(fc.array(fc.jsonValue(), { maxLength: 3 })),
    fc.tuple(fc.array(fc.jsonValue(), { maxLength: 3 }), fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 3 })),
  );
  const id = fc.integer({ min: 1, max: 2 ** 53 });
  prop.prop([id, payload])('payload frames end with the payload, unchanged and in order', (requestId, tail) => {
    for (const frame of [
      callFrame(requestId, {}, 'p', tail),
      publishFrame(requestId, {}, 't', tail),
      yieldFrame(requestId, false, tail),
      invocationErrorFrame(requestId, {}, 'u', tail),
    ]) {
      expect(frame.slice(frame.length - tail.length)).toEqual(tail);
      expect(frame).toContain(requestId);
      for (let i = 0; i < tail.length; i++) expect(frame[frame.length - tail.length + i]).toBe(tail[i]);
    }
  });
});
