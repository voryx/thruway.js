// Deterministic reproduction of a bug the integration suite found (live: test/integration/late-answers.test.ts): a
// REGISTERED or SUBSCRIBED that arrives after the late window (`request` ms after the request's TimeoutError) is
// dropped as unknown, so the router keeps a registration/subscription of this session that the client never withdraws
// (a single-invoke procedure stays blocked — also for the app's own retry — and its INVOCATIONs are answered
// no_such_registration until the session ends). The answer the router issued to this session can always be withdrawn
// (UNREGISTER/UNSUBSCRIBE of an id received on this connection is valid, INV-CL02), so the expected behaviour needs no
// memory. Fixed in src/ops/register.ts and src/ops/topic.ts: such an answer is withdrawn once, and so is a registration
// whose REGISTERED was lost when the router invokes it.
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import { useHarness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 1313, checks: { unscripted: false } });

function written(c: SimClient<Client>, type: number): unknown[][] {
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === type)
    .map((f) => f.frame as unknown[]);
}

test('a REGISTERED after the late window is withdrawn with an UNREGISTER', async () => {
  const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
  const { router, clock } = h.current;
  await clock.advance(10);
  router.ignore((frame) => frame[0] === 64); // the router sits on the REGISTER (Thruway pinging a ghost, a busy router)
  const registration = c.observe(
    'register',
    'com.example.late',
    c.client.register('com.example.late', () => 1),
  );
  await clock.advance(3500); // request timer (2 s) → the router answers a probe → TimeoutError{request}
  expect(registration.error).toMatchObject({ code: 'timeout', timer: 'request' });
  await clock.advance(2500); // the late window (another 2 s) is over
  const [register] = written(c, 64);
  expect(typeof register?.[1]).toBe('number');
  router.sendRaw(JSON.stringify([65, register?.[1], 4242])); // the REGISTERED, finally
  await clock.advance(10);
  expect(written(c, 66).map((f) => f[2])).toEqual([4242]);
  router.sendRaw(JSON.stringify([65, register?.[1], 4242])); // a duplicate of that answer: no second UNREGISTER
  await clock.advance(10);
  expect(written(c, 66).map((f) => f[2])).toEqual([4242]);
});

test('a SUBSCRIBED after the late window is withdrawn with an UNSUBSCRIBE', async () => {
  const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
  const { router, clock } = h.current;
  await clock.advance(10);
  router.ignore((frame) => frame[0] === 32);
  const events = c.observe('topic', 'com.example.late', c.client.topic('com.example.late'));
  await clock.advance(3500);
  expect(events.error).toMatchObject({ code: 'timeout', timer: 'request' });
  await clock.advance(2500);
  const [subscribe] = written(c, 32);
  expect(typeof subscribe?.[1]).toBe('number');
  router.sendRaw(JSON.stringify([33, subscribe?.[1], 4343]));
  await clock.advance(10);
  expect(written(c, 34).map((f) => f[2])).toEqual([4343]);
});

test('control: a REGISTERED inside the late window is withdrawn (the bounded window works)', async () => {
  const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
  const { router, clock } = h.current;
  await clock.advance(10);
  router.ignore((frame) => frame[0] === 64);
  const registration = c.observe(
    'register',
    'com.example.late',
    c.client.register('com.example.late', () => 1),
  );
  await clock.advance(3500);
  expect(registration.error).toMatchObject({ code: 'timeout', timer: 'request' });
  const [register] = written(c, 64);
  router.sendRaw(JSON.stringify([65, register?.[1], 4444]));
  await clock.advance(10);
  expect(written(c, 66).map((f) => f[2])).toEqual([4444]);
});

describe('a forged INVOCATION (the reference router never issued its id, so its oracle is off here)', () => {
  const forged = useHarness({ seed: 1414, checks: { unscripted: false, violations: false } });
  test('an INVOCATION of a registration no record holds is answered and withdrawn once', async () => {
    const h = forged;
    const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
    const { router, clock } = h.current;
    await clock.advance(10);
    router.sendRaw(JSON.stringify([68, 901, 5151, {}])); // the router invokes a registration whose REGISTERED was lost
    router.sendRaw(JSON.stringify([68, 902, 5151, {}])); // and again, before the UNREGISTER is processed
    await clock.advance(10);
    const errors = written(c, 8).filter((f) => f[1] === 68);
    expect(errors.map((f) => [f[2], f[4]])).toEqual([
      [901, 'wamp.error.no_such_registration'],
      [902, 'wamp.error.no_such_registration'],
    ]);
    expect(written(c, 66).map((f) => f[2])).toEqual([5151]);
  });
});

test('an INVOCATION racing the UNREGISTER of a stopped registration writes no second UNREGISTER', async () => {
  const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
  const { router, clock } = h.current;
  await clock.advance(10);
  const registration = c.client.register('com.example.stop', () => 1).subscribe({});
  await clock.advance(10);
  const [registered] = c
    .trace()
    .frames.filter((f) => f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === 65)
    .map((f) => f.frame as unknown[]);
  const registrationId = registered?.[2];
  expect(typeof registrationId).toBe('number');
  registration.unsubscribe();
  await clock.advance(10); // UNREGISTER written and answered
  expect(written(c, 66).map((f) => f[2])).toEqual([registrationId]);
  router.sendRaw(JSON.stringify([68, 903, registrationId, {}])); // an INVOCATION the router sent before the UNREGISTER
  await clock.advance(10);
  expect(written(c, 66).map((f) => f[2])).toEqual([registrationId]);
});

describe('a stray REGISTERED with the id the router then gives a pending REGISTER (router ids from 1 per session)', () => {
  const stray = useHarness({ seed: 1515, router: { routerIds: 'per-session' }, checks: { unscripted: false } });
  test('the registration its UNREGISTER removed is REGISTERed again, and the app gets a working one', async () => {
    const h = stray;
    const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
    const { router, clock } = h.current;
    await clock.advance(10);
    const registration = c.observe(
      'register',
      'com.example.stray',
      c.client.register('com.example.stray', () => 'served'),
    );
    router.sendRaw(JSON.stringify([65, 4242, 1])); // REGISTERED for a request never made, with the id the router issues
    await clock.advance(10);
    // the stray id is withdrawn; the router processes that UNREGISTER after the REGISTER, so it removes the new
    // registration: registered again, and only then announced
    expect(written(c, 66).map((f) => f[2])).toEqual([1]);
    expect(written(c, 64)).toHaveLength(2);
    expect(registration.values).toMatchObject([{ registrationId: 2, procedure: 'com.example.stray' }]);
    expect(registration.error).toBeUndefined();
    const call = router.invoke('com.example.stray');
    await clock.advance(10);
    expect(call.result?.args).toEqual(['served']);
  });

  test('a router that refuses that UNREGISTER keeps the registration: announced once, no second REGISTER', async () => {
    const h = stray;
    const c = h.current.makeClient(Client, { options: { timeouts: { idle: 1000, request: 2000 } } });
    const { router, clock } = h.current;
    await clock.advance(10);
    router.ignore((frame) => frame[0] === 66); // the router keeps registration 1 and refuses the UNREGISTER
    const registration = c.observe(
      'register',
      'com.example.stray',
      c.client.register('com.example.stray', () => 'served'),
    );
    router.sendRaw(JSON.stringify([65, 4242, 1]));
    await clock.advance(10);
    const [unregister] = written(c, 66);
    router.sendRaw(JSON.stringify([8, 66, unregister?.[1], {}, 'wamp.error.not_authorized']));
    await clock.advance(10);
    expect(written(c, 64)).toHaveLength(1);
    expect(registration.values).toMatchObject([{ registrationId: 1, procedure: 'com.example.stray' }]);
    expect(registration.error).toBeUndefined();
    const call = router.invoke('com.example.stray');
    await clock.advance(10);
    expect(call.result?.args).toEqual(['served']);
  });
});
