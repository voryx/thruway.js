// Publish/subscribe against every router: events between two sessions with their payload, acknowledged publishes
// complete on PUBLISHED, `exclude_me` (default true, false honoured where `exclude_me`), black/white listing by session
// id (`blackwhite_listing`), publisher disclosure (`publisher_always_disclosed`), the order of PUBLISHED and the own
// EVENT (`self_publish_order`), and publishes made before the first session wait for it.
import { expect, test } from 'vitest';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { delay, framesOf, subscribed } from './harness/scenarios.js';

describeRouters('pubsub', (r) => {
  test('an event from another session, with its payload', async () => {
    const topic = uri('pubsub');
    const sub = itClient(r, { name: 'subscriber' });
    const events = await subscribed(sub, topic);
    const pub = itClient(r, { name: 'publisher' });
    await firstValue(pub.client.publish(topic, [1, 'two', { three: [3] }], { k: 'v' }, { acknowledge: true }));
    await eventually(() => events.values.length === 1, 5000, 'the EVENT');
    const [event] = events.values;
    expect(event?.args).toEqual([1, 'two', { three: [3] }]);
    expect(event?.kwargs).toEqual({ k: 'v' });
    expect(Object.isFrozen(event)).toBe(true);
    if (cap(r, 'publisher_always_disclosed') === 'always') expect(event?.details['publisher']).toBeDefined();
    if (cap(r, 'publisher_always_disclosed') === 'never') expect(event?.details['publisher']).toBeUndefined();
  });

  test('an unacknowledged publish completes when written; an acknowledged one on PUBLISHED', async () => {
    const pub = itClient(r);
    const topic = uri('pubsub');
    await expect(firstValue(pub.client.publish(topic, ['fire and forget']))).resolves.toBeUndefined();
    await expect(firstValue(pub.client.publish(topic, ['acked'], {}, { acknowledge: true }))).resolves.toBeUndefined();
    expect(framesOf(pub, 17, 'out').length).toBe(1);
  });

  test('exclude_me: the publisher does not get its own event unless it asks (where the router honours it)', async () => {
    const topic = uri('pubsub');
    const c = itClient(r);
    const events = await subscribed(c, topic);
    await firstValue(c.client.publish(topic, ['default'], {}, { acknowledge: true }));
    await firstValue(c.client.publish(topic, ['included'], {}, { acknowledge: true, exclude_me: false }));
    await delay(300);
    const seen = events.values.map((e) => e.args[0] as unknown);
    if (cap(r, 'exclude_me') === 'always') expect(seen).toEqual(['included']);
    if (cap(r, 'exclude_me') === 'never') expect(seen).not.toEqual(['included']);
  });

  test('eligible / exclude by session id (where the router supports black/white listing)', async () => {
    const topic = uri('pubsub');
    const a = itClient(r, { name: 'a' });
    const b = itClient(r, { name: 'b' });
    const ea = await subscribed(a, topic);
    const eb = await subscribed(b, topic);
    const pub = itClient(r, { name: 'publisher' });
    const bSession = (await b.opened()).id;
    const aSession = (await a.opened()).id;
    await firstValue(pub.client.publish(topic, ['only b'], {}, { acknowledge: true, eligible: [bSession] }));
    await firstValue(pub.client.publish(topic, ['not a'], {}, { acknowledge: true, exclude: [aSession] }));
    if (cap(r, 'blackwhite_listing') === 'always') {
      await eventually(() => eb.values.length >= 2, 5000, 'b gets both');
      await delay(200);
      expect(ea.values).toEqual([]);
    } else {
      // Bondy's lists are broken, nxt and fox-wamp ignore them: whatever arrives, every session stays healthy
      await delay(500);
      expect([a, b, pub].every((x) => x.client.session !== undefined)).toBe(true);
    }
  });

  test('PUBLISHED and the own EVENT: either order is handled', async () => {
    const topic = uri('pubsub');
    const c = itClient(r);
    const events = await subscribed(c, topic);
    await firstValue(c.client.publish(topic, ['self'], {}, { acknowledge: true, exclude_me: false }));
    if (cap(r, 'exclude_me') !== 'always') return; // the own event may not arrive at all
    await eventually(() => events.values.length === 1, 3000, 'the own EVENT');
    const frames = c.trace().frames.filter((f) => f.direction === 'out' && Array.isArray(f.frame));
    const published = frames.findIndex((f) => (f.frame as readonly unknown[])[0] === 17);
    const event = frames.findIndex((f) => (f.frame as readonly unknown[])[0] === 36);
    if (cap(r, 'self_publish_order') === 'always') expect(published).toBeLessThan(event);
    if (cap(r, 'self_publish_order') === 'never') expect(event).toBeLessThan(published);
  });

  test('publishes made before the first session wait for it, in order', async () => {
    const topic = uri('pubsub');
    const sub = itClient(r, { name: 'subscriber' });
    const events = await subscribed(sub, topic);
    const pub = itClient(r, { name: 'publisher', options: { autoOpen: false } });
    const done = [1, 2, 3].map((n) => firstValue(pub.client.publish(topic, [n], {}, { acknowledge: true })));
    pub.open();
    await Promise.all(done);
    await eventually(() => events.values.length === 3, 5000, 'three events');
    // written in subscription order (one FIFO for every op waiting for a session)
    expect(framesOf(pub, 16, 'in').map((f) => (f[4] as unknown[])[0])).toEqual([1, 2, 3]);
    const order = events.values.map((e) => e.args[0] as unknown);
    if (cap(r, 'publisher_order_kept') === 'always') expect(order).toEqual([1, 2, 3]);
    else expect([...order].sort()).toEqual([1, 2, 3]);
  });
});
