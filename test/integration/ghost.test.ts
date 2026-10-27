// The client's own ghost registration against every router (README recipe 16): a callee's link freezes (half-open),
// liveness replaces the connection, and the router — which has not noticed the old session die (Thruway with keepalive
// 0 never does) — answers the re-REGISTER with procedure_already_exists. The client rides it out: the registration
// stream does not error (the 5-minute window), REGISTER is retried with backoff, and once the ghost is gone (its TCP
// connection closed here) the registration is active again and a CALL from another client is served. With Thruway's
// `replace_orphaned_session: 'yes'` the router pings the ghost and evicts it (≈5 s) while it is still frozen; with
// Crossbar's `force_reregister: true` the new REGISTER replaces it at once.
import { afterEach, expect, test } from 'vitest';
import type { RegisterOptions } from '../../src/types.js';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { callee, delay, framesOf, nextClose } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

async function ghostScenario(r: Router, options: RegisterOptions | undefined, evictedByRouter: boolean): Promise<void> {
  const proxy = await ChaosProxy.start({ target: r.url });
  proxies.push(proxy);
  const procedure = uri('ghost');
  // the request timeout must outlast the router's eviction (Thruway pings the ghost for 5 s before it answers the
  // REGISTER): an answer later than 2 × request is the late-answer leak, tested in late-answers.test.ts
  const c = itClient(r, { name: 'callee', url: proxy.url, options: { timeouts: { request: 10000 } } });
  const registration = await callee(c, procedure, () => 'alive', options);
  const ghost = proxy.open[0];
  if (ghost === undefined) throw new Error('no proxied connection');
  ghost.freeze();
  const end = await nextClose(c, 0, 10000);
  expect(end.error).toMatchObject({ code: 'timeout', timer: 'liveness' });
  await eventually(() => c.client.session !== undefined, 15000, 'a new session');
  const rejected = (): number =>
    framesOf(c, 8, 'out').filter((f) => f[1] === 64 && f[4] === 'wamp.error.procedure_already_exists').length;
  const caller = itClient(r, { name: 'caller' });
  if (evictedByRouter) {
    // the router evicts (or replaces) the ghost on its own while it is still frozen
    await eventually(() => registration.values.length === 2, 20000, 'REGISTERED again while the ghost is frozen');
  } else {
    if (cap(r, 'ghost_registrations') === 'always') {
      await eventually(() => rejected() >= 1, 10000, 'procedure_already_exists from the ghost');
      expect(c.logged('register.ghost').length).toBeGreaterThanOrEqual(1);
      await delay(3000);
      expect(registration.errored).toBe(false); // inside the ghost window: never surfaced
      expect(registration.values.length).toBe(1);
    }
    ghost.kill(); // the ghost's TCP connection closes: the router drops its session
    await eventually(() => registration.values.length === 2, 40000, 'REGISTERED again after the ghost left');
  }
  expect(registration.errored).toBe(false);
  expect((await firstValue(caller.client.call(procedure), 5000)).args).toEqual(['alive']);
}

describeRouters('ghost', (r) => {
  test('a frozen callee: the re-REGISTER rides out its own ghost, then serves calls again', async () => {
    await ghostScenario(r, undefined, false);
  });
});

// router-specific REGISTER options (recipe 16): run where they exist
describeRouters(
  'ghost replace_orphaned_session',
  (r) => {
    test("replace_orphaned_session: 'yes' — the router evicts the frozen ghost", async () => {
      await ghostScenario(r, { replace_orphaned_session: 'yes' }, true);
    });
  },
  ['thruway-php'],
);

describeRouters(
  'ghost force_reregister',
  (r) => {
    test('force_reregister: true — the new REGISTER replaces the ghost', async () => {
      await ghostScenario(r, { force_reregister: true }, true);
    });
  },
  ['crossbar'],
);
