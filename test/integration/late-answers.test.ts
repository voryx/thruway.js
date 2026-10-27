// Answers that arrive after the client gave up on a request (the request timer and `late` entries). Found by the chaos
// runs: a REGISTERED (or SUBSCRIBED) that arrives later than the late window — `request` ms after the request's
// TimeoutError — is dropped as unknown, so the router keeps a registration (subscription) for this session that the
// client never withdraws: on a single-invoke router the procedure is blocked for everyone else (and for the app's own
// retry: procedure_already_exists) and its INVOCATIONs are answered no_such_registration until the session ends. Seen
// first with Thruway's `replace_orphaned_session` (its 5 s ping delays the REGISTERED) and a 2 s request timeout.
//
// Reproduced here through the chaos proxy (the answer held 5 s, request timeout 1.5 s). The expected behaviour — an
// UNREGISTER/UNSUBSCRIBE for an answer nobody waits for any more — needs no memory: the router just issued the id to
// this session. Fixed in register.ts/topic.ts: every precondition is asserted (the answer delayed past the late
// window, or lost; the TimeoutError; the INVOCATION), then the UNREGISTER/UNSUBSCRIBE.
import { afterEach, expect, test } from 'vitest';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { errorFrom, eventually, itClient, uri, type ItClient } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { delay, framesOf } from './harness/scenarios.js';

/** Whether a withdrawal (UNREGISTER 66 / UNSUBSCRIBE 34) of `id` was written within `ms`. */
async function withdrawn(c: ItClient, type: 66 | 34, id: unknown, ms: number): Promise<boolean> {
  const seen = (): boolean => framesOf(c, type, 'in').some((f) => f[2] === id);
  for (const until = performance.now() + ms; performance.now() < until && !seen();) await delay(20);
  return seen();
}

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

describeRouters('late answers', (r) => {
  test('a REGISTERED after the late window is withdrawn with an UNREGISTER', async () => {
    const proxy = await ChaosProxy.start({ target: r.url });
    proxies.push(proxy);
    proxy.on('down', (f) => f?.[0] === 65, { kind: 'delay', ms: 5000 });
    const c = itClient(r, { url: proxy.url, options: { timeouts: { request: 1500 } } });
    await c.opened();
    const procedure = uri('late');
    const registration = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 1),
    );
    expect(await errorFrom(registration, 6000)).toMatchObject({ code: 'timeout', timer: 'request' });
    await eventually(() => framesOf(c, 65, 'out').length === 1, 8000, 'the delayed REGISTERED');
    const registrationId = framesOf(c, 65, 'out')[0]?.[2];
    expect(typeof registrationId).toBe('number');
    // an UNREGISTER for the registration nobody waits for
    expect(await withdrawn(c, 66, registrationId, 1500)).toBe(true);
  });

  // The answer never comes (a router that drops it — Nexus in a burst — or a link that lost it), but the router did
  // register. Only an INVOCATION ever names that registration id; the expected behaviour is to answer it and withdraw
  // the registration nobody holds.
  test('a REGISTERED that never arrives: its INVOCATION is answered and the registration withdrawn', async () => {
    const proxy = await ChaosProxy.start({ target: r.url });
    proxies.push(proxy);
    proxy.on('down', (f) => f?.[0] === 65, { kind: 'drop' });
    const c = itClient(r, { url: proxy.url, options: { timeouts: { request: 1500 } } });
    await c.opened();
    const procedure = uri('late');
    const registration = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 1),
    );
    expect(await errorFrom(registration, 6000)).toMatchObject({ code: 'timeout', timer: 'request' });
    const caller = itClient(r, { name: 'caller' });
    await caller.opened();
    const call = caller.observe('call', procedure, caller.client.call(procedure));
    await eventually(() => framesOf(c, 68, 'out').length === 1, 5000, 'an INVOCATION of the registration nobody holds');
    await eventually(() => call.errored, 5000, 'the call answered');
    if (cap(r, 'callee_error_forwarded') === 'always')
      expect(call.error).toMatchObject({ code: 'wamp_error', uri: 'wamp.error.no_such_registration' });
    // a router that does not forward the callee's ERROR as is still names the URI somewhere in its answer
    else expect(JSON.stringify(call.error)).toContain('no_such_registration');
    expect(framesOf(c, 65, 'out')).toEqual([]); // the REGISTERED really was lost
    const registrationId = framesOf(c, 68, 'out')[0]?.[2];
    expect(typeof registrationId).toBe('number');
    // an UNREGISTER for the registration nobody holds
    expect(await withdrawn(c, 66, registrationId, 1500)).toBe(true);
  });

  test('a SUBSCRIBED after the late window is withdrawn with an UNSUBSCRIBE', async () => {
    const proxy = await ChaosProxy.start({ target: r.url });
    proxies.push(proxy);
    proxy.on('down', (f) => f?.[0] === 33, { kind: 'delay', ms: 5000 });
    const c = itClient(r, { url: proxy.url, options: { timeouts: { request: 1500 } } });
    await c.opened();
    const topic = uri('late');
    const events = c.observe('topic', topic, c.client.topic(topic));
    expect(await errorFrom(events, 6000)).toMatchObject({ code: 'timeout', timer: 'request' });
    await eventually(() => framesOf(c, 33, 'out').length === 1, 8000, 'the delayed SUBSCRIBED');
    const subscriptionId = framesOf(c, 33, 'out')[0]?.[2];
    expect(typeof subscriptionId).toBe('number');
    // an UNSUBSCRIBE for the subscription nobody waits for
    expect(await withdrawn(c, 34, subscriptionId, 1500)).toBe(true);
  });
});
