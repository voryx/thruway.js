// Smoke: one client per router does what every app does — open, register, call itself, subscribe, publish
// (acknowledged, exclude_me false), close — before the targeted files run.
import { expect, test } from 'vitest';
import { describeRouters } from './harness/routers.js';
import { firstValue, itClient, uri, valueOf } from './harness/recorder.js';

describeRouters('smoke', (r) => {
  test('open, register + call, subscribe + publish, close', async () => {
    const c = itClient(r);
    const session = await c.opened();
    expect(session.id).toBeGreaterThan(0);
    const procedure = uri('smoke');
    const registration = c.observe(
      'register',
      procedure,
      c.client.register(procedure, (inv) => (inv.args[0] as number) + (inv.args[1] as number)),
    );
    expect((await valueOf(registration)).procedure).toBe(procedure);
    const result = await firstValue(c.client.call(procedure, [2, 3]));
    expect(result.args).toEqual([5]);
    const topic = uri('smoke');
    const events = c.observe('topic', topic, c.client.topic(topic));
    await firstValue(c.client.publish(topic, ['warmup'], {}, { acknowledge: true, exclude_me: false }));
    await firstValue(c.client.publish(topic, ['hello'], {}, { acknowledge: true, exclude_me: false }));
    // the first publish may race the SUBSCRIBE on routers that answer it later; the second must arrive
    await expect.poll(() => events.values.map((e) => e.args[0] as unknown)).toContain('hello');
    await c.close();
  });
});
