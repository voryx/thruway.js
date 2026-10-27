// Reconnection against every router: every way a connection ends — the TCP connection destroyed (1006), a close with
// any code, a router restart, `reconnect()` — schedules exactly one reconnect with backoff (delays within [100,
// maxRetryDelay], attempt counters growing per consecutive failure, never reset by a socket that opens and then fails);
// attempts that never open (HTTP 503, TCP refused, an upgrade that never completes ⇒ TimeoutError{connect}) back off
// the same way; once the link heals the client is open again, its registration and topic re-established, and an
// in-flight call failed with a retryable ConnectionLostError carrying its procedure, request id and session id.
import { afterEach, expect, test } from 'vitest';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { errorFrom, eventually, firstValue, itClient, uri, type ItClient } from './harness/recorder.js';
import { describeRouters, type Router } from './harness/routers.js';
import { callee, framesOf, nextClose, reopened, subscribed } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

async function proxied(r: Router): Promise<ChaosProxy> {
  const proxy = await ChaosProxy.start({ target: r.url });
  proxies.push(proxy);
  return proxy;
}

/** A client through `proxy` with a registration, a topic and an in-flight call to a backend that never answers. */
async function workload(r: Router, proxy: ChaosProxy) {
  const procedure = uri('reconnect');
  const slow = uri('reconnect');
  const topic = uri('reconnect');
  const backend = itClient(r, { name: 'backend' });
  let invoked = 0;
  await callee(backend, slow, () => {
    invoked++;
    return new Promise(() => undefined);
  });
  const c = itClient(r, { name: 'proxied', url: proxy.url });
  const registration = await callee(c, procedure, () => 'served');
  const events = await subscribed(c, topic);
  const inflight = c.observe('call', slow, c.client.call(slow));
  await eventually(() => invoked === 1, 5000, 'the in-flight INVOCATION');
  return { c, backend, procedure, slow, topic, registration, events, inflight };
}

/** After an end: open again, the registration and the topic work, nothing errored. */
async function survived(r: Router, w: Awaited<ReturnType<typeof workload>>, before: number | undefined): Promise<void> {
  await reopened(w.c, before, 30000);
  await eventually(() => w.registration.values.length >= 2, 10000, 'REGISTERED again');
  const caller = itClient(r, { name: 'caller' });
  expect((await firstValue(caller.client.call(w.procedure))).args).toEqual(['served']);
  // the workload subscribed once on the first session: a second SUBSCRIBED is the re-subscription
  await eventually(() => framesOf(w.c, 33, 'out').length >= 2, 10000, 'SUBSCRIBED again');
  await firstValue(caller.client.publish(w.topic, ['after'], {}, { acknowledge: true }));
  await eventually(() => w.events.values.length >= 1, 5000, 'the EVENT after the reconnect');
  expect(w.registration.errored || w.events.errored).toBe(false);
}

function expectLost(error: unknown, procedure: string, sessionId: number | undefined): void {
  expect(error).toMatchObject({ code: 'connection_lost', procedure, sessionId });
  expect(typeof (error as { requestId?: unknown }).requestId).toBe('number');
}

describeRouters('reconnect', (r) => {
  test('the TCP connection destroyed (1006): one end, one reconnect, everything re-established', async () => {
    const proxy = await proxied(r);
    const w = await workload(r, proxy);
    const before = w.c.client.session?.id;
    proxy.kill();
    const end = await nextClose(w.c, 0);
    expect(end).toMatchObject({
      initiator: 'connection',
      closeCode: 1006,
      wasClean: false,
      willRetry: true,
      attempt: 1,
    });
    expect(end.error?.code).toBe('connection_lost');
    expect(end.delay).toBeGreaterThanOrEqual(100);
    expect(end.delay).toBeLessThanOrEqual(1000);
    expectLost(await errorFrom(w.inflight), w.slow, before);
    await survived(r, w, before);
    expect(w.c.onClose.values.length).toBe(1);
  });

  for (const code of [1001, 1011, 4000]) {
    test(`a close with code ${String(code)}: a disconnect like any other`, async () => {
      const proxy = await proxied(r);
      const w = await workload(r, proxy);
      const before = w.c.client.session?.id;
      proxy.close(code, 'chaos');
      const end = await nextClose(w.c, 0);
      expect(end).toMatchObject({ initiator: 'connection', closeCode: code, willRetry: true });
      expectLost(await errorFrom(w.inflight), w.slow, before);
      await survived(r, w, before);
    });
  }

  test('an undecodable frame from the router: ABORT protocol_violation, a ProtocolError end, everything re-established', async () => {
    const proxy = await proxied(r);
    const w = await workload(r, proxy);
    const before = w.c.client.session?.id;
    proxy.inject('this is not json', 'down');
    const end = await nextClose(w.c, 0);
    expect(end).toMatchObject({
      initiator: 'connection',
      reason: 'wamp.error.protocol_violation',
      closeCode: 4000,
      wasClean: false,
      willRetry: true,
      attempt: 1,
    });
    expect(end.error?.code).toBe('protocol');
    const aborts = framesOf(w.c, 3, 'in');
    expect(aborts.length).toBe(1);
    expect(aborts[0]?.[2]).toBe('wamp.error.protocol_violation');
    expectLost(await errorFrom(w.inflight), w.slow, before);
    await survived(r, w, before);
    expect(w.c.onClose.values.length).toBe(1);
  });

  test('no WELCOME in time (the answers lost on an open socket): TimeoutError{handshake}, backoff, open once healed', async () => {
    const proxy = await proxied(r);
    const c = itClient(r, { url: proxy.url, options: { timeouts: { handshake: 600 } } });
    const before = (await c.opened()).id;
    proxy.blackhole('down'); // HELLO reaches the router, nothing comes back
    proxy.kill();
    await nextClose(c, 2); // the loss, then two attempts without a WELCOME
    const timedOut = c.onClose.values.slice(1);
    for (const end of timedOut) {
      expect(end).toMatchObject({ initiator: 'connection', sessionId: undefined, willRetry: true });
      expect(end.error).toMatchObject({ code: 'timeout', timer: 'handshake' });
    }
    proxy.blackhole(undefined);
    await reopened(c, before, 20000);
    const ends = c.onClose.values;
    expect(ends.map((e) => e.attempt)).toEqual(ends.map((_, i) => i + 1)); // never reset by an opened socket
    for (const end of ends) {
      expect(end.delay).toBeGreaterThanOrEqual(100);
      expect(end.delay).toBeLessThanOrEqual(1000);
    }
    // each timed-out connection (2 … the one before the last) wrote its HELLO and at most the ABORT that ends it
    for (let conn = 2; conn < c.sockets.length; conn++) {
      const written = c
        .trace()
        .frames.filter((f) => f.connection === conn && f.direction === 'in')
        .map((f) => (f.frame as unknown[])[0]);
      expect(written[0]).toBe(1);
      expect(written.slice(1).every((t) => t === 3)).toBe(true);
    }
  });

  test('an acknowledged publish in flight when the link dies: a retryable ConnectionLostError with its topic', async () => {
    const proxy = await proxied(r);
    const c = itClient(r, { url: proxy.url });
    const before = (await c.opened()).id;
    const topic = uri('reconnect');
    proxy.on('down', (f) => f?.[0] === 17, { kind: 'drop' }, { count: 1 }); // the PUBLISHED never arrives
    const published = c.observe('publish', topic, c.client.publish(topic, ['x'], {}, { acknowledge: true }));
    await eventually(() => framesOf(c, 16, 'in').length === 1, 5000, 'the PUBLISH written');
    await eventually(
      () => proxy.frames.some((f) => f.fate === 'dropped' && f.text?.startsWith('[17,') === true),
      5000,
      'the PUBLISHED dropped',
    );
    proxy.kill(); // well inside the request timeout (2 s)
    const lost = await errorFrom(published);
    expect(lost).toMatchObject({ code: 'connection_lost', topic, sessionId: before });
    expect((lost as { requestId?: unknown }).requestId).toBe(framesOf(c, 16, 'in')[0]?.[1]);
    await reopened(c, before);
    expect(c.onClose.values).toMatchObject([{ initiator: 'connection', willRetry: true, attempt: 1 }]);
  });

  test('reconnect(): GOODBYE, a new session at once, streams kept, the in-flight call lost', async () => {
    const proxy = await proxied(r);
    const w = await workload(r, proxy);
    const before = w.c.client.session?.id;
    w.c.reconnect();
    const end = await nextClose(w.c, 0);
    expect(end).toMatchObject({ initiator: 'app', reason: 'wamp.close.close_realm', willRetry: true, attempt: 0 });
    expect(framesOf(w.c, 6, 'in')[0]).toEqual([6, {}, 'wamp.close.close_realm']);
    expectLost(await errorFrom(w.inflight), w.slow, before);
    await survived(r, w, before);
  });

  test('attempts that never open (503, refused, a stalled upgrade): backoff, then open once healed', async () => {
    const proxy = await proxied(r);
    const c = itClient(r, { url: proxy.url, options: { timeouts: { connect: 600 } } });
    const before = (await c.opened()).id;
    proxy.refuse(60000);
    proxy.kill();
    await nextClose(c, 2); // the loss, then two refused attempts
    await proxy.listen(false);
    proxy.refuse(0);
    await nextClose(c, 4); // two TCP refusals
    await proxy.listen(true);
    proxy.stallUpgrade(Infinity);
    const stalledFrom = c.onClose.values.length;
    const stalled = await nextClose(c, stalledFrom);
    expect(stalled.error).toMatchObject({ code: 'timeout', timer: 'connect' });
    proxy.stallUpgrade(0);
    await reopened(c, before, 20000);
    const ends = c.onClose.values;
    expect(ends[0]?.attempt).toBe(1);
    // consecutive failures: the counter grows and never resets on a socket that opened
    for (let i = 1; i < ends.length; i++) expect(ends[i]?.attempt).toBe((ends[i - 1]?.attempt ?? 0) + 1);
    for (const end of ends) {
      expect(end.willRetry).toBe(true);
      expect(end.delay).toBeGreaterThanOrEqual(100);
      expect(end.delay).toBeLessThanOrEqual(1000);
    }
  });

  // 100 + 25, not more: Nexus silently drops replies once ~200 requests arrive in one burst
  test('100 topics and 25 registrations: all re-established after a kill, each serving again', async () => {
    const proxy = await proxied(r);
    const c = itClient(r, { url: proxy.url, options: { timeouts: { request: 10000 } } });
    await c.opened();
    const base = uri('scale');
    const topics = Array.from({ length: 100 }, (_, i) =>
      c.observe('topic', `${base}.t${String(i)}`, c.client.topic(`${base}.t${String(i)}`)),
    );
    const registrations = Array.from({ length: 25 }, (_, i) =>
      c.observe(
        'register',
        `${base}.p${String(i)}`,
        c.client.register(`${base}.p${String(i)}`, () => i),
      ),
    );
    await eventually(
      () => framesOf(c, 33, 'out').length === 100 && registrations.every((x) => x.values.length === 1),
      20000,
      'all active',
    );
    const before = c.client.session?.id;
    proxy.kill();
    await reopened(c, before);
    await eventually(
      () => framesOf(c, 33, 'out').length === 200 && registrations.every((x) => x.values.length === 2),
      30000,
      'all re-established',
    );
    const caller = itClient(r, { name: 'caller' });
    for (const i of [0, 17, 24])
      expect((await firstValue(caller.client.call(`${base}.p${String(i)}`))).args).toEqual([i]);
    await firstValue(caller.client.publish(`${base}.t99`, ['last'], {}, { acknowledge: true }));
    await eventually(() => topics[99]?.values.length === 1, 5000, 'an EVENT on the last topic');
    expect([...topics, ...registrations].some((x) => x.errored || x.completed)).toBe(false);
  });

  test('a router restart: reconnect with backoff, interests re-established (RS)', async () => {
    const w = await (async () => {
      // directly on the router: the restart is the fault
      const procedure = uri('reconnect');
      const topic = uri('reconnect');
      const c: ItClient = itClient(r, { name: 'restarted' });
      const registration = await callee(c, procedure, () => 'served');
      const events = await subscribed(c, topic);
      return { c, procedure, topic, registration, events };
    })();
    const before = w.c.client.session?.id;
    await r.control.restart();
    const end = await nextClose(w.c, 0, 30000);
    expect(end.willRetry).toBe(true);
    await reopened(w.c, before, 60000);
    await eventually(() => w.registration.values.length >= 2, 15000, 'REGISTERED again');
    const caller = itClient(r, { name: 'caller' });
    await caller.opened(30000);
    expect((await firstValue(caller.client.call(w.procedure))).args).toEqual(['served']);
    await eventually(() => framesOf(w.c, 33, 'out').length >= 2, 15000, 'SUBSCRIBED again');
    await firstValue(caller.client.publish(w.topic, ['after'], {}, { acknowledge: true }));
    await eventually(() => w.events.values.length === 1, 5000, 'the EVENT after the restart');
  });
});
