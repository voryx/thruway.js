// Registrations against every router: the RegisteredMessage, a second session's REGISTER of the same procedure rejected
// on that stream only (`duplicate_register_rejected`; fox-wamp accepts duplicates), UNREGISTER on unsubscribe,
// re-REGISTER on every new session, and the remount cycles — (a) StrictMode mount/unmount/mount in one tick, (b)
// switchMap re-keying across round trips (unsubscribe right after REGISTERED and subscribe again before UNREGISTERED;
// subscribe again while the first REGISTER is still pending), (c) 50 seeded cycles with random gaps of 0–2 round trips
// — after each of which exactly one registration is active (client debug probe; the router's own count where it has
// one: Thruway's test RPC, the meta API elsewhere), no ERROR(64) procedure_already_exists was on the wire or the
// stream, and a CALL from a second client is answered once, by the last-mounted handler.
import { expect, test } from 'vitest';
import { isWampError, type WampError } from '../../src/index.js';
import type { RegisteredMessage } from '../../src/types.js';
import type { Recorded } from '../helpers/trace.js';
import { errorFrom, eventually, firstValue, itClient, uri, valueOf, type ItClient } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { callee, delay, framesOf, prng, reopened } from './harness/scenarios.js';

interface RegisterSizes {
  readonly records: number;
  readonly ops: number;
  readonly requests: number;
  readonly invocations: number;
}

function registerSizes(c: ItClient): RegisterSizes {
  return c.debug().participants['register'] as unknown as RegisterSizes;
}

/** The router's own count of registrations of `procedure`, where it can tell (undefined otherwise). */
export async function routerCallees(r: Router, helper: ItClient, procedure: string): Promise<number | undefined> {
  try {
    if (r.id === 'thruway-php') {
      return (await firstValue(helper.client.call('thruway_test.count_callees', [procedure]), 3000)).args[0] as number;
    }
    const lookup = await firstValue(helper.client.call('wamp.registration.lookup', [procedure]), 3000);
    const id = lookup.args[0] as number | null | undefined;
    if (id === null || id === undefined) return 0;
    return (await firstValue(helper.client.call('wamp.registration.count_callees', [id]), 3000)).args[0] as number;
  } catch {
    return undefined; // no meta API (nxt, fox-wamp, Bondy without the procedure)
  }
}

async function settled(c: ItClient): Promise<void> {
  await eventually(() => registerSizes(c).requests === 0, 8000, 'no REGISTER/UNREGISTER in flight');
}

/** The checks after a remount scenario. */
async function exactlyOne(r: Router, c: ItClient, procedure: string, expected: string): Promise<void> {
  await settled(c);
  expect(registerSizes(c)).toMatchObject({ records: 1, ops: 1 });
  const alreadyExists = (frames: readonly (readonly unknown[])[]): number =>
    frames.filter((f) => f[1] === 64 && f[4] === 'wamp.error.procedure_already_exists').length;
  expect(alreadyExists(framesOf(c, 8, 'out'))).toBe(0);
  const caller = itClient(r, { name: 'second-client' });
  const counted = await routerCallees(r, caller, procedure);
  if (counted !== undefined) expect(counted).toBe(1);
  expect((await firstValue(caller.client.call(procedure), 5000)).args).toEqual([expected]);
  await caller.close();
}

describeRouters('register', (r) => {
  test('REGISTERED: the message names the procedure and the session', async () => {
    const procedure = uri('register');
    const c = itClient(r);
    const registration = await callee(c, procedure, () => 1);
    const message = registration.values[0]!;
    expect(message.procedure).toBe(procedure);
    expect(message.sessionId).toBe(c.client.session?.id);
    expect(typeof message.registrationId).toBe('number');
  });

  test("another session's REGISTER of the same procedure: rejected on that stream only", async () => {
    const procedure = uri('register');
    const first = itClient(r, { name: 'first' });
    await callee(first, procedure, () => 'first');
    const second = itClient(r, { name: 'second' });
    const duplicate = second.observe(
      'register',
      procedure,
      second.client.register(procedure, () => 'second'),
    );
    if (cap(r, 'duplicate_register_rejected') === 'always') {
      const error = (await errorFrom(duplicate)) as WampError;
      expect(isWampError(error)).toBe(true);
      expect(error.uri).toBe('wamp.error.procedure_already_exists');
      expect(error.procedure).toBe(procedure);
    } else {
      await valueOf(duplicate); // fox-wamp: an implicit shared registration
    }
    const caller = itClient(r, { name: 'caller' });
    expect(['first', 'second']).toContain((await firstValue(caller.client.call(procedure))).args[0]);
    expect(second.client.session).toBeDefined();
  });

  test('unsubscribe writes UNREGISTER; the procedure is gone', async () => {
    const procedure = uri('register');
    const c = itClient(r);
    const registration = await callee(c, procedure, () => 1);
    registration.unsubscribe();
    await eventually(() => framesOf(c, 67, 'out').length === 1, 5000, 'UNREGISTERED');
    const caller = itClient(r, { name: 'caller' });
    await expect(firstValue(caller.client.call(procedure))).rejects.toMatchObject({ code: 'wamp_error' });
  });

  test('reconnect(): REGISTER again on the new session, calls served, the stream never ends', async () => {
    const procedure = uri('register');
    const c = itClient(r);
    const registration = await callee(c, procedure, () => 'served');
    const before = c.client.session?.id;
    c.reconnect();
    await reopened(c, before);
    await valueOf(registration, 1);
    const caller = itClient(r, { name: 'caller' });
    expect((await firstValue(caller.client.call(procedure))).args).toEqual(['served']);
    expect(registration.errored || registration.completed).toBe(false);
  });

  test('#remount (a) StrictMode: mount, unmount, mount in one tick', async () => {
    const procedure = uri('remount');
    const c = itClient(r);
    await c.opened();
    c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 'first'),
    ).unsubscribe();
    const live = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 'second'),
    );
    await valueOf(live);
    await exactlyOne(r, c, procedure, 'second');
  });

  test('#remount (b) switchMap re-keying across round trips', async () => {
    const procedure = uri('remount');
    const c = itClient(r);
    await c.opened();
    const first = await callee(c, procedure, () => 'first');
    first.unsubscribe(); // UNREGISTER in flight
    const second = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 'second'),
    );
    await valueOf(second);
    await exactlyOne(r, c, procedure, 'second');
    second.unsubscribe();
    await settled(c);
    const third = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 'third'),
    );
    third.unsubscribe(); // REGISTER still pending
    const fourth = c.observe(
      'register',
      procedure,
      c.client.register(procedure, () => 'fourth'),
    );
    await valueOf(fourth);
    await exactlyOne(r, c, procedure, 'fourth');
  });

  test('#remount (c) 50 seeded cycles with random gaps of 0–2 round trips', async () => {
    const seed = Number(process.env['REMOUNT_SEED'] ?? Date.now() % 100000);
    const random = prng(seed);
    const procedure = uri('remount');
    const c = itClient(r);
    await c.opened();
    let live: Recorded<RegisteredMessage> | undefined;
    let tag = '';
    try {
      for (let cycle = 0; cycle < 50; cycle++) {
        live?.unsubscribe();
        if (random() < 0.5) {
          c.observe(
            'register',
            procedure,
            c.client.register(procedure, () => 'stale'),
          ).unsubscribe();
        } else {
          const stale = c.observe(
            'register',
            procedure,
            c.client.register(procedure, () => 'stale'),
          );
          await delay(Math.floor(random() * 3) * 4);
          stale.unsubscribe();
        }
        await delay(Math.floor(random() * 3) * 4);
        const mine = `cycle-${String(cycle)}`;
        tag = mine;
        live = c.observe(
          'register',
          procedure,
          c.client.register(procedure, () => mine),
        );
        await delay(Math.floor(random() * 3) * 4);
      }
      if (live === undefined) throw new Error('nothing mounted');
      await valueOf(live);
      expect(live.errored).toBe(false);
      await exactlyOne(r, c, procedure, tag);
    } catch (error) {
      throw new Error(`#remount (c) failed with REMOUNT_SEED=${String(seed)}: ${String(error)}`, { cause: error });
    }
  });
});
