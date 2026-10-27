// URIs against every router: URIs the spec's loose rule rejects (an empty component, whitespace, '#') are refused
// locally with WampError invalid_uri and never written — Crossbar would kill the whole connection for one (quirk 8 of
// test/routers/crossbar/README.md); a URI the client accepts but the router does not (Thruway's strict lowercase regex
// for SUBSCRIBE) errors that op only; the session and every other stream continue.
import { expect, test } from 'vitest';
import { isWampError, type WampError } from '../../src/index.js';
import { errorOf, firstValue, itClient, uri } from './harness/recorder.js';
import { describeRouters } from './harness/routers.js';
import { callee, framesOf } from './harness/scenarios.js';

const INVALID = ['com..empty', 'com.white space', 'com.hash#tag', '', 'com.trailing.'];

describeRouters('uri', (r) => {
  test('invalid URIs are refused locally: nothing is written, the connection is untouched', async () => {
    const c = itClient(r);
    await c.opened();
    for (const bad of INVALID) {
      for (const op of [
        () => c.client.call(bad),
        () => c.client.publish(bad, [], {}, { acknowledge: true }),
        () => c.client.topic(bad),
        () => c.client.register(bad, () => 1),
      ]) {
        const error = (await errorOf(op())) as WampError;
        expect(isWampError(error)).toBe(true);
        expect(error.uri).toBe('wamp.error.invalid_uri');
      }
    }
    const written = c
      .trace()
      .frames.filter((f) => f.direction === 'in')
      .map((f) => (f.frame as unknown[])[0]);
    expect(written.filter((t) => t !== 1 && t !== 48)).toEqual([]); // HELLO and liveness probes only
    expect(c.onClose.values).toEqual([]);
  });

  test('a URI the router rejects errors that op only; the session and other streams continue', async () => {
    const c = itClient(r);
    const procedure = uri('uri');
    await callee(c, procedure, () => 'fine');
    // valid for the spec's loose rule, rejected by strict routers (Thruway: uppercase and '-' are not in its regex)
    const strict = c.observe('topic', 'com.ThruwayJS.Mixed-Case', c.client.topic('com.ThruwayJS.Mixed-Case'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (strict.errored) expect(isWampError(strict.error)).toBe(true);
    const other = itClient(r, { name: 'caller' });
    expect((await firstValue(other.client.call(procedure))).args).toEqual(['fine']);
    expect(c.onClose.values).toEqual([]);
    expect(framesOf(c, 3, 'out')).toEqual([]);
  });
});
