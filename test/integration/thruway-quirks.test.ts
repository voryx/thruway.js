// Thruway PHP quirks that need the real router (T2, T4 and T7 of test/routers/ROUTERS-C.md): the wildcard SUBSCRIBE
// that is never answered errors that topic only, with a bounded late entry; procedure URIs are case-insensitive on
// Thruway (it lowercases them) while the client keeps the app's spelling; the bogus `[8, 8, …]` Thruway sends a callee
// after a killnowait is dropped without consequence; the legacy GOODBYE reply `wamp.error.goodbye_and_out` ends close()
// at once; empty args/kwargs dropped by the router are normalised.
import { expect, test } from 'vitest';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { MSG, RawPeer } from './harness/raw-peer.js';
import { describeRouters } from './harness/routers.js';
import { callee, framesOf } from './harness/scenarios.js';

describeRouters(
  'thruway quirks',
  (r) => {
    test('T4: the unanswered wildcard SUBSCRIBE errors that topic only; its late entry is bounded', async () => {
      const c = itClient(r);
      await c.opened();
      const exact = c.observe('topic', uri('quirk'), c.client.topic(uri('quirk')));
      const wildcard = c.observe(
        'topic',
        'com.thruwayjs.quirk..end',
        c.client.topic('com.thruwayjs.quirk..end', { match: 'wildcard' }),
      );
      await eventually(() => wildcard.errored, 8000, 'the request timeout');
      expect(wildcard.error).toMatchObject({ code: 'timeout', timer: 'request' });
      const sizes = (): Record<string, number> => c.debug().participants['topic'] as unknown as Record<string, number>;
      expect(sizes()['late']).toBe(1);
      expect(exact.errored).toBe(false);
      // the late entry expires `request` ms later (lazily, on the next topic activity)
      await new Promise((resolve) => setTimeout(resolve, 2500));
      c.observe('topic', uri('quirk'), c.client.topic(uri('quirk'))).unsubscribe();
      expect(sizes()['late']).toBe(0);
    });

    test('T7: procedures are lowercased by Thruway; the client keeps the spelling of the app', async () => {
      const id = uri('quirk');
      const mixed = id.replace('quirk', 'Quirk');
      const backend = itClient(r, { name: 'callee' });
      await callee(backend, mixed, (inv) => inv.procedure);
      const app = itClient(r, { name: 'caller' });
      expect((await firstValue(app.client.call(id))).args).toEqual([mixed]);
      expect((await firstValue(app.client.call(mixed))).args).toEqual([mixed]);
    });

    test('T2: the bogus [8, 8, …] after killnowait is dropped; the callee session continues', async () => {
      const procedure = uri('quirk');
      const backend = itClient(r, { name: 'callee' });
      let invoked = 0;
      await callee(backend, procedure, () => {
        invoked++;
        return new Promise((resolve) =>
          setTimeout(() => {
            resolve('late');
          }, 300),
        );
      });
      const caller = await RawPeer.join(r.url, r.realm);
      try {
        const call = caller.call(procedure);
        await eventually(() => invoked === 1, 3000, 'the INVOCATION');
        caller.send([MSG.CANCEL, call.id, { mode: 'killnowait' }]);
        expect((await call.answer)?.[4]).toBe('wamp.error.canceled');
        // the v3 callee writes nothing after an INTERRUPT killnowait; Thruway's stray ERROR, if any, is dropped
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(backend.onClose.values).toEqual([]);
        const again = caller.call(procedure);
        expect((await again.answer)?.[0]).toBe(MSG.RESULT);
      } finally {
        caller.close();
      }
    });

    test("5: Thruway's legacy GOODBYE reply (wamp.error.goodbye_and_out) ends the wait at once", async () => {
      const c = itClient(r);
      await c.opened();
      const started = performance.now();
      await c.close();
      expect(performance.now() - started).toBeLessThan(500);
      expect(framesOf(c, 6, 'out')[0]?.[2]).toBe('wamp.error.goodbye_and_out');
    });
  },
  ['thruway-php'],
);
