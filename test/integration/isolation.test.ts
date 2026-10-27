// App code that throws never breaks the connection or another stream, against the real router: an EVENT observer that
// throws (its sibling local of the same topic and another topic keep receiving), lifecycle observers (status, onOpen,
// onClose) that throw on every value — through a connection loss the client still reconnects and re-establishes
// everything — and an app that unsubscribes its streams or re-subscribes a completed call. Each throw is reported once
// as `unhandled` (never `internal`, which the trace checks fail on).
import { afterEach, expect, test } from 'vitest';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { describeRouters } from './harness/routers.js';
import { callee, framesOf, nextClose, reopened, subscribed } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

describeRouters('isolation', (r) => {
  test('throwing app observers (an EVENT observer, every lifecycle observer): a loss still reconnects, nothing else notices', async () => {
    const proxy = await ChaosProxy.start({ target: r.url });
    proxies.push(proxy);
    const c = itClient(r, { name: 'app', url: proxy.url });
    const before = (await c.opened()).id;
    let thrown = 0;
    const boom = (): never => {
      thrown++;
      throw new Error('app observer bug');
    };
    // lifecycle observers that throw on every value (status replays its current value at once)
    c.client.status.subscribe(boom);
    c.client.onOpen.subscribe(boom);
    c.client.onClose.subscribe(boom);
    const topic = uri('isolation');
    const other = uri('isolation');
    const throwing = c.client.topic(topic).subscribe(boom);
    await eventually(() => framesOf(c, 33, 'out').length === 1, 5000, 'SUBSCRIBED');
    const sibling = c.observe('topic', topic, c.client.topic(topic)); // a second local: no second SUBSCRIBE
    const otherEvents = await subscribed(c, other);
    const procedure = uri('isolation');
    const registration = await callee(c, procedure, () => 'served');
    const publisher = itClient(r, { name: 'publisher' });
    await firstValue(publisher.client.publish(topic, [1], {}, { acknowledge: true }));
    await firstValue(publisher.client.publish(other, [1], {}, { acknowledge: true }));
    await eventually(() => sibling.values.length === 1 && otherEvents.values.length === 1, 5000, 'both topics');
    const thrownBeforeLoss = thrown;
    expect(thrownBeforeLoss).toBeGreaterThanOrEqual(2); // status (replay) and the EVENT

    proxy.kill();
    const end = await nextClose(c, 0);
    expect(end).toMatchObject({ initiator: 'connection', willRetry: true, attempt: 1 });
    await reopened(c, before);
    await eventually(() => registration.values.length === 2, 10000, 'REGISTERED again');
    await eventually(() => framesOf(c, 33, 'out').length === 4, 10000, 'both topics SUBSCRIBED again');
    expect((await firstValue(publisher.client.call(procedure))).args).toEqual(['served']);
    await firstValue(publisher.client.publish(topic, [2], {}, { acknowledge: true }));
    await firstValue(publisher.client.publish(other, [2], {}, { acknowledge: true }));
    await eventually(() => sibling.values.length === 2 && otherEvents.values.length === 2, 5000, 'both topics again');
    expect(thrown).toBeGreaterThan(thrownBeforeLoss + 2); // status, onClose, onOpen and the EVENT threw again
    expect(sibling.errored || otherEvents.errored || registration.errored).toBe(false);
    expect(throwing.closed).toBe(false); // a throwing observer stays subscribed (the throw is reported, not fatal)
    expect(c.logged('unhandled').length).toBe(thrown);
    expect(c.onClose.values.length).toBe(1); // exactly one end: the kill
  });

  test("the app's own unsubscribes, a completed call re-subscribed: the session is never touched", async () => {
    const c = itClient(r, { name: 'app' });
    const session = (await c.opened()).id;
    const procedure = uri('isolation');
    const backend = itClient(r, { name: 'backend' });
    await callee(backend, procedure, (inv) => inv.args[0]);
    // a call the app abandons at once, one it takes the first value of, a topic and a registration it drops
    c.client
      .call(procedure, [1])
      .subscribe(() => undefined)
      .unsubscribe();
    expect((await firstValue(c.client.call(procedure, [2]))).args).toEqual([2]);
    const topic = c.client.topic(uri('isolation')).subscribe(() => undefined);
    const registration = c.client.register(uri('isolation'), () => 1).subscribe(() => undefined);
    await eventually(() => framesOf(c, 33, 'out').length === 1 && framesOf(c, 65, 'out').length === 1, 5000, 'both');
    topic.unsubscribe();
    registration.unsubscribe();
    await eventually(() => framesOf(c, 35, 'out').length === 1 && framesOf(c, 67, 'out').length === 1, 5000, 'gone');
    // re-subscribing the same cold call re-issues it
    const again = c.client.call(procedure, [3]);
    expect((await firstValue(again)).args).toEqual([3]);
    expect((await firstValue(again)).args).toEqual([3]);
    expect(c.client.session?.id).toBe(session);
    expect(c.onClose.values).toEqual([]);
  });
});
