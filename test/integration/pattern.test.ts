// Pattern subscriptions and registrations against every router: a prefix subscription gets the events of every topic
// under it with `details.topic` where `event_details_topic` (nxt omits it); a wildcard subscription matches where
// `wildcard_match`, and where the router never answers it (`wildcard_subscribe_answered` never: Thruway T4) the stream
// errors TimeoutError{request} once the router has answered a liveness probe — that stream only; a prefix registration
// serves calls under it where `register_match`.
import { expect, test } from 'vitest';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { delay } from './harness/scenarios.js';

describeRouters('pattern', (r) => {
  test('prefix subscription: events of every topic under the prefix', async () => {
    const base = uri('pattern');
    const c = itClient(r);
    const events = c.observe('topic', base, c.client.topic(base, { match: 'prefix' }));
    await eventually(
      () => c.trace().frames.some((f) => f.direction === 'out' && (f.frame as unknown[])[0] === 33),
      5000,
      'SUBSCRIBED',
    );
    const pub = itClient(r, { name: 'publisher' });
    await firstValue(pub.client.publish(`${base}.one`, ['1'], {}, { acknowledge: true }));
    await firstValue(pub.client.publish(`${base}.two.deeper`, ['2'], {}, { acknowledge: true }));
    if (cap(r, 'subscribe_match') === 'always') {
      await eventually(() => events.values.length === 2, 5000, 'both events');
      if (cap(r, 'event_details_topic') === 'always') {
        expect(events.values.map((e) => e.details['topic'])).toEqual([`${base}.one`, `${base}.two.deeper`]);
      }
    } else {
      await delay(500); // fox-wamp ignores `match`: no event for other topics, nothing breaks
      expect(c.client.session).toBeDefined();
    }
  });

  test('wildcard subscription: matched where supported; never answered ⇒ TimeoutError{request} on it only', async () => {
    const base = uri('pattern');
    const c = itClient(r);
    await c.opened();
    const wildcard = `${base}..end`;
    const events = c.observe('topic', wildcard, c.client.topic(wildcard, { match: 'wildcard' }));
    const exact = c.observe('topic', `${base}.x.end`, c.client.topic(`${base}.x.end`));
    if (cap(r, 'wildcard_subscribe_answered') === 'never') {
      await eventually(() => events.errored, 8000, 'the request timeout');
      expect(events.error).toMatchObject({ code: 'timeout', timer: 'request', topic: wildcard });
      expect(exact.errored).toBe(false);
      expect(c.onClose.values).toEqual([]);
      return;
    }
    await delay(500);
    const pub = itClient(r, { name: 'publisher' });
    await firstValue(pub.client.publish(`${base}.x.end`, ['w'], {}, { acknowledge: true }));
    await eventually(() => exact.values.length === 1, 5000, 'the exact subscriber');
    if (cap(r, 'wildcard_match') === 'always') {
      await eventually(() => events.values.length === 1, 5000, 'the wildcard event');
    }
    expect(events.errored && cap(r, 'wildcard_subscribe_answered') === 'always').toBe(false);
  });

  test('prefix registration: calls under the prefix are served where supported', async () => {
    const base = uri('pattern');
    const backend = itClient(r, { name: 'callee' });
    const registration = backend.observe(
      'register',
      base,
      backend.client.register(base, (inv) => inv.procedure, { match: 'prefix' }),
    );
    await eventually(() => registration.values.length === 1 || registration.errored, 5000, 'REGISTERED');
    const app = itClient(r, { name: 'caller' });
    if (cap(r, 'register_match') === 'always') {
      // InvocationMessage.procedure is details.procedure when the router sends it (nxt does not: then the registered URI)
      expect([`${base}.leaf`, base]).toContain((await firstValue(app.client.call(`${base}.leaf`))).args[0]);
    } else {
      // Thruway registers it as exact, others refuse or ignore `match`: the exact URI still works
      if (!registration.errored) expect((await firstValue(app.client.call(base))).args).toEqual([base]);
    }
    expect(app.client.session).toBeDefined();
  });
});
