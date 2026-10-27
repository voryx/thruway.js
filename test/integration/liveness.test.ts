// Liveness against every router (fast profile: idle 1 s, ping budget 1 s): a frozen link (half-open both ways) ends the
// session within idle + budget with TimeoutError{liveness} and the client reconnects; a link that delivers EVENTs but
// drops everything the client writes (blackhole up) is detected through the request that never gets a reply, and the
// topic survives; a result that needs longer than idle + budget converges after at most one liveness reconnect (the
// budget doubles); a router paused for 3 s costs each of 20 idle clients at most one reconnect; a callee whose uplink
// dies while INVOCATIONs keep arriving is detected through its own unanswered YIELDs.
import { afterEach, expect, test } from 'vitest';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { errorFrom, eventually, firstValue, itClient, uri, type ItClient } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { callee, delay, nextClose, reopened, subscribed } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

/** idle + ping budget of the fast profile, plus scheduling slack on loopback. */
const DETECT_MS = 1000 + 1000 + 600;

async function proxied(r: Router): Promise<ChaosProxy> {
  const proxy = await ChaosProxy.start({ target: r.url });
  proxies.push(proxy);
  return proxy;
}

async function calibrated(c: ItClient): Promise<void> {
  // the first probe of a session calibrates (1 s after WELCOME): wait for its answer so the timing below is the
  // steady-state one
  await eventually(
    () => c.logged('liveness.unsupported').length > 0 || probeAnswered(c),
    4000,
    'the calibration probe',
  );
}

function probeAnswered(c: ItClient): boolean {
  const frames = c.trace().frames;
  const probes = frames
    .filter(
      (f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 48 && f.frame[3] === 'thruway.js.ping',
    )
    .map((f) => (f.frame as unknown[])[1]);
  return frames.some(
    (f) =>
      f.direction === 'out' &&
      Array.isArray(f.frame) &&
      ((f.frame[0] === 8 && probes.includes(f.frame[2])) || (f.frame[0] === 50 && probes.includes(f.frame[1]))),
  );
}

describeRouters('liveness', (r) => {
  const probing = cap(r, 'probe_answered') === 'always';

  test.skipIf(!probing)('a frozen link: TimeoutError{liveness} within idle + budget, then a new session', async () => {
    const proxy = await proxied(r);
    const c = itClient(r, { url: proxy.url });
    const before = (await c.opened()).id;
    await calibrated(c);
    const frozenAt = performance.now();
    proxy.freeze();
    const end = await nextClose(c, 0, 10000);
    const took = performance.now() - frozenAt;
    expect(end.error).toMatchObject({ code: 'timeout', timer: 'liveness' });
    expect(end).toMatchObject({ initiator: 'connection', willRetry: true });
    expect(took).toBeLessThan(DETECT_MS);
    await reopened(c, before);
  });

  test.skipIf(!probing)(
    'blackhole up with a busy topic: the unanswered request ends it, the topic survives',
    async () => {
      const proxy = await proxied(r);
      const topic = uri('liveness');
      const procedure = uri('liveness');
      const backend = itClient(r, { name: 'backend' });
      await callee(backend, procedure, () => 'answered');
      const c = itClient(r, { url: proxy.url });
      const events = await subscribed(c, topic);
      await calibrated(c);
      const publishing = { on: true };
      const publisher = (async () => {
        while (publishing.on) {
          await firstValue(backend.client.publish(topic, ['tick'], {}, { acknowledge: true }));
          await delay(100);
        }
      })();
      await eventually(() => events.values.length >= 3, 5000, 'events flowing');
      proxy.blackhole('up');
      const before = c.client.session?.id;
      const writtenAt = performance.now();
      const call = c.observe('call', procedure, c.client.call(procedure));
      const end = await nextClose(c, 0, 10000);
      expect(performance.now() - writtenAt).toBeLessThan(DETECT_MS);
      expect(end.error).toMatchObject({ code: 'timeout', timer: 'liveness' });
      expect(await errorFrom(call)).toMatchObject({ code: 'connection_lost' });
      proxy.blackhole(undefined);
      await reopened(c, before);
      const count = events.values.length;
      await eventually(() => events.values.length > count + 2, 5000, 'events after the reconnect');
      publishing.on = false;
      await publisher;
      expect(events.errored).toBe(false);
    },
  );

  test.skipIf(!probing)(
    'a result slower than idle + budget converges after at most one liveness reconnect',
    async () => {
      const proxy = await proxied(r);
      const procedure = uri('liveness');
      const backend = itClient(r, { name: 'backend' });
      const big = 'x'.repeat(250000); // 2.5 s at 100 kB/s: more than idle + 1 s, less than idle + 2 s (doubled)
      await callee(backend, procedure, () => big);
      const c = itClient(r, { url: proxy.url });
      await c.opened();
      await calibrated(c);
      proxy.throttle(100000);
      let result: string | undefined;
      for (let attempt = 0; attempt < 3 && result === undefined; attempt++) {
        // recipe 1: re-issue a read after a connection loss
        try {
          result = (await firstValue(c.client.call(procedure), 15000)).args[0] as string;
        } catch (error) {
          expect(error).toMatchObject({ code: 'connection_lost' });
        }
      }
      expect(result?.length).toBe(big.length);
      expect(c.onClose.values.filter((e) => e.error?.code === 'timeout').length).toBeLessThanOrEqual(1);
    },
  );

  test.skipIf(!probing)(
    'the router paused for 3 s: 20 idle clients, each at most one reconnect, all converge',
    async () => {
      const clients = Array.from({ length: 20 }, (_, i) => itClient(r, { name: `idle-${String(i)}` }));
      await Promise.all(clients.map((c) => c.opened()));
      await Promise.all(clients.map(calibrated));
      await r.control.pause();
      try {
        await delay(3000);
      } finally {
        await r.control.unpause();
      }
      await Promise.all(clients.map((c) => eventually(() => c.client.session !== undefined, 20000, `${c.name} open`)));
      await delay(1500);
      for (const c of clients) {
        expect(c.onClose.values.length).toBeLessThanOrEqual(1);
        expect(c.client.session).toBeDefined();
      }
    },
  );

  test.skipIf(!probing)(
    "a callee's uplink dies while INVOCATIONs keep arriving: detected through its YIELDs",
    async () => {
      const proxy = await proxied(r);
      const procedure = uri('liveness');
      const c = itClient(r, { name: 'callee', url: proxy.url });
      await callee(c, procedure, () => 'yielded');
      await calibrated(c);
      const caller = itClient(r, { name: 'caller' });
      const calling = { on: true };
      const calls = (async () => {
        while (calling.on) {
          // the caller bounds its own wait (Rx timeout); the callee's answers are lost upstream
          await firstValue(caller.client.call(procedure), 400).catch(() => undefined);
          await delay(100);
        }
      })();
      await delay(500);
      proxy.blackhole('up');
      const blackholed = performance.now();
      const end = await nextClose(c, 0, 10000);
      calling.on = false;
      await calls;
      expect(end.error).toMatchObject({ code: 'timeout', timer: 'liveness' });
      expect(performance.now() - blackholed).toBeLessThan(DETECT_MS + 500);
    },
  );
});
