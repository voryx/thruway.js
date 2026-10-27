// Topics against every router: local subscribers of one topic share one router subscription (one SUBSCRIBE, each local
// gets each EVENT once); the last one leaving writes the UNSUBSCRIBE; a reconnect re-establishes the subscription
// without the stream noticing.
//
// #remount runs the remount cycles against the real broker — (a) StrictMode subscribe/unsubscribe/subscribe in one
// tick, (b) switchMap re-keying across round trips (unsubscribe right after SUBSCRIBED and subscribe again before the
// UNSUBSCRIBED; subscribe again while the first SUBSCRIBE is pending), (c) 50 seeded cycles with random gaps of 0–2
// round trips mixing both — and requires after each: one router subscription for the key (client debug probe, and the
// number of EVENT frames a publication produces on the client's socket: Thruway and fox-wamp give every SUBSCRIBE its
// own id, so a leaked router subscription would show as a second copy), each EVENT delivered once to the live local.
import { expect, test } from 'vitest';
import type { EventMessage } from '../../src/types.js';
import type { Recorded } from '../helpers/trace.js';
import { eventually, firstValue, itClient, uri, type ItClient } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { delay, framesOf, prng, reopened, subscribed } from './harness/scenarios.js';

interface TopicSizes {
  readonly keys: number;
  readonly locals: number;
  readonly requests: number;
  readonly routerIds: number;
  readonly deferred: number;
}

function topicSizes(c: ItClient): TopicSizes {
  return c.debug().participants['topic'] as unknown as TopicSizes;
}

/** Publish from another session and require exactly one EVENT frame on `c` and exactly one delivery to `live`. */
async function oneDelivery(
  r: Router,
  c: ItClient,
  topic: string,
  live: Recorded<EventMessage>,
  publisher: ItClient,
  marker: string,
): Promise<void> {
  const framesBefore = framesOf(c, 36, 'out').length;
  const before = live.values.length;
  await firstValue(publisher.client.publish(topic, [marker], {}, { acknowledge: true }));
  await eventually(() => live.values.length > before, 5000, `the EVENT ${marker}`);
  await delay(100);
  expect(live.values.slice(before).map((e) => e.args[0] as unknown)).toEqual([marker]);
  if (cap(r, 'shared_subscription_ids') !== 'sometimes') {
    expect(framesOf(c, 36, 'out').length - framesBefore).toBe(1);
  }
}

async function settled(c: ItClient): Promise<void> {
  await eventually(
    () => {
      const s = topicSizes(c);
      return s.requests === 0 && s.deferred === 0;
    },
    8000,
    'no SUBSCRIBE/UNSUBSCRIBE in flight',
  );
}

describeRouters('topic', (r) => {
  test('two locals of one topic: one SUBSCRIBE, each gets each EVENT once; the last one out unsubscribes', async () => {
    const topic = uri('topic');
    const c = itClient(r);
    const first = await subscribed(c, topic);
    const second = c.observe('topic', topic, c.client.topic(topic, { match: 'exact' })); // the same key
    const pub = itClient(r, { name: 'publisher' });
    await firstValue(pub.client.publish(topic, ['one'], {}, { acknowledge: true }));
    await eventually(() => first.values.length === 1 && second.values.length === 1, 5000, 'both locals');
    expect(framesOf(c, 32, 'in').length).toBe(1);
    first.unsubscribe();
    expect(framesOf(c, 34, 'in').length).toBe(0);
    await firstValue(pub.client.publish(topic, ['two'], {}, { acknowledge: true }));
    await eventually(() => second.values.length === 2, 5000, 'the remaining local');
    second.unsubscribe();
    await eventually(() => framesOf(c, 35, 'out').length === 1, 5000, 'UNSUBSCRIBED');
    expect(topicSizes(c)).toMatchObject({ keys: 0, locals: 0, routerIds: 0 });
  });

  test('reconnect() re-establishes the subscription; the stream never notices', async () => {
    const topic = uri('topic');
    const c = itClient(r);
    const events = await subscribed(c, topic);
    const pub = itClient(r, { name: 'publisher' });
    const before = c.client.session?.id;
    c.reconnect();
    await reopened(c, before);
    await eventually(() => framesOf(c, 33, 'out').length === 2, 5000, 'SUBSCRIBED on the new session');
    await firstValue(pub.client.publish(topic, ['after'], {}, { acknowledge: true }));
    await eventually(() => events.values.length === 1, 5000, 'the EVENT after the reconnect');
    expect(events.errored || events.completed).toBe(false);
  });

  test('#remount (a) StrictMode: subscribe, unsubscribe, subscribe in one tick', async () => {
    const topic = uri('remount');
    const c = itClient(r);
    await c.opened();
    const pub = itClient(r, { name: 'publisher' });
    await pub.opened();
    const firstMount = c.observe('topic', topic, c.client.topic(topic));
    firstMount.unsubscribe();
    const live = c.observe('topic', topic, c.client.topic(topic));
    await settled(c);
    expect(topicSizes(c)).toMatchObject({ keys: 1, locals: 1, routerIds: 1 });
    await oneDelivery(r, c, topic, live, pub, 'strict');
    expect(firstMount.values).toEqual([]);
  });

  test('#remount (b) switchMap re-keying across round trips', async () => {
    const topic = uri('remount');
    const c = itClient(r);
    await c.opened();
    const pub = itClient(r, { name: 'publisher' });
    await pub.opened();
    // unsubscribe right after SUBSCRIBED, subscribe again before UNSUBSCRIBED is answered
    const first = await subscribed(c, topic);
    first.unsubscribe();
    const second = c.observe('topic', topic, c.client.topic(topic));
    await settled(c);
    await oneDelivery(r, c, topic, second, pub, 'rekeyed');
    // subscribe again while the first SUBSCRIBE is still pending
    second.unsubscribe();
    await settled(c);
    const third = c.observe('topic', topic, c.client.topic(topic));
    third.unsubscribe();
    const fourth = c.observe('topic', topic, c.client.topic(topic));
    await settled(c);
    expect(topicSizes(c)).toMatchObject({ keys: 1, locals: 1, routerIds: 1 });
    await oneDelivery(r, c, topic, fourth, pub, 'pending');
  });

  test('#remount (c) 50 seeded cycles with random gaps of 0–2 round trips', async () => {
    const seed = Number(process.env['REMOUNT_SEED'] ?? Date.now() % 100000);
    const random = prng(seed);
    const topic = uri('remount');
    const c = itClient(r);
    await c.opened();
    const pub = itClient(r, { name: 'publisher' });
    await pub.opened();
    let live: Recorded<EventMessage> | undefined;
    try {
      for (let cycle = 0; cycle < 50; cycle++) {
        if (live !== undefined) live.unsubscribe();
        if (random() < 0.5) {
          // (a) in one tick
          c.observe('topic', topic, c.client.topic(topic)).unsubscribe();
        } else {
          // (b) across 0–2 round trips (a loopback round trip is a few ms)
          const stale = c.observe('topic', topic, c.client.topic(topic));
          await delay(Math.floor(random() * 3) * 4);
          stale.unsubscribe();
        }
        await delay(Math.floor(random() * 3) * 4);
        live = c.observe('topic', topic, c.client.topic(topic));
        await delay(Math.floor(random() * 3) * 4);
      }
      await settled(c);
      expect(topicSizes(c)).toMatchObject({ keys: 1, locals: 1, routerIds: 1 });
      if (live === undefined) throw new Error('no live subscription');
      await oneDelivery(r, c, topic, live, pub, 'cycled');
    } catch (error) {
      throw new Error(`#remount (c) failed with REMOUNT_SEED=${String(seed)}: ${String(error)}`, { cause: error });
    }
  });
});
