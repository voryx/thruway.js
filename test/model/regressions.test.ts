// Minimal deterministic regressions for client bugs the model suite and the fuzzers found. Each test fails on the
// code before its fix.
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import type { FaultsHook } from '../../src/core/machine.js';
import type { Status } from '../../src/types.js';
import { useHarness } from '../helpers/harness.js';
import { checkInvariants, formatViolations } from '../helpers/invariants.js';

const h = useHarness({ seed: 1, checks: { internalLogs: false } });
const FAST = { [Symbol.for('thruway.js.internal')]: { attemptFloor: 10, ping: 1, stable: 40, goodbye: 5, settle: 2 } };

describe('a contained fault inside reconnect()’s end keeps the announced retry', () => {
  test('the next attempt starts after the announced delay, as attempt 1', async () => {
    const c = h.current.makeClient(Client, {
      options: { autoOpen: false, timeouts: { idle: 0 }, retryOptions: { maxRetryDelay: 100 }, ...FAST },
    });
    c.open();
    await h.current.clock.advance(0);
    expect(c.status?.values.at(-1)?.state).toBe('open');
    (c.faults as FaultsHook).inject('liveness.sessionEnded', 'once');
    c.reconnect();
    const end = c.onClose?.values.at(-1);
    expect(end).toMatchObject({ initiator: 'app', willRetry: true, attempt: 0 });
    await h.current.clock.advance(1000);
    const connecting = (c.status?.values ?? []).filter(
      (s): s is Extract<Status, { state: 'connecting' }> => s.state === 'connecting',
    );
    expect(connecting.at(-1)?.attempt).toBe(1);
    const found = checkInvariants(
      c.trace(),
      { timings: { idle: 0, attemptFloor: 10, maxRetryDelay: 100 }, faults: true },
      ['INV-R2'],
    );
    expect(found, formatViolations(found, c.trace())).toEqual([]);
  });
});

describe('close() settles a subscription that a hardReset could not restart', () => {
  test.each(['topic.start', 'register.start'])(
    '%s throwing on every call: the stream still errors ConnectionClosedError at close()',
    async (target) => {
      h.current.router.declareTopic('com.example.t');
      const c = h.current.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 } } });
      c.open();
      await h.current.clock.advance(0);
      (c.faults as FaultsHook).inject(target, 'always'); // the start throws, and so does hardReset's restart
      const stream =
        target === 'topic.start'
          ? c.observe('topic', 'com.example.t', c.client.topic('com.example.t'))
          : c.observe(
              'register',
              'com.example.r',
              c.client.register('com.example.r', () => 1),
            );
      await h.current.clock.advance(10);
      expect(stream.closed).toBe(false);
      (c.faults as FaultsHook).clear();
      await c.close();
      expect(stream.error).toMatchObject({ code: 'connection_closed' });
      expect(c.debug()).toMatchObject({ registry: 0 });
    },
  );
});

describe('open() after the clock went back never postpones a retry that is due sooner', () => {
  test('the retry announced before the jump fires on time', async () => {
    h.current.router.setAvailable('hang'); // connecting: reconnect() then waits for the floor
    const c = h.current.makeClient(Client, {
      options: {
        autoOpen: false,
        timeouts: { idle: 0, connect: 200 },
        [Symbol.for('thruway.js.internal')]: { attemptFloor: 100 },
      },
    });
    c.open();
    c.reconnect(); // abandons the attempt: the retry is due when the floor ends, 100 ms after the first start
    expect(c.onClose?.values.at(-1)).toMatchObject({ initiator: 'app', willRetry: true, delay: 100 });
    h.current.router.setAvailable('ok');
    h.current.clock.skew(-5000);
    await h.current.clock.advance(40);
    c.open(); // while waiting: may cut the wait, never lengthen it
    await h.current.clock.advance(60);
    expect(c.status?.values.at(-1)?.state).toBe('open'); // 100 ms of timer time after the reconnect, not 140
  });
});

describe('a contained fault inside a session end keeps that session’s ghost registrations', () => {
  test.each(['register.sessionEnded', 'liveness.sessionEnded'])(
    '%s throwing: the re-REGISTER rides out its own ghost instead of failing procedure_already_exists',
    async (target) => {
      const h2 = h.current;
      const c = h2.makeClient(Client, {
        options: { autoOpen: false, timeouts: { idle: 0 }, retryOptions: { maxRetryDelay: 100 } },
      });
      c.open();
      await h2.clock.advance(0);
      const reg = c.observe(
        'register',
        'com.example.r',
        c.client.register('com.example.r', () => 1),
      );
      await h2.clock.advance(0);
      expect(reg.values).toHaveLength(1);
      (c.faults as FaultsHook).inject(target, 'once');
      c.connection.controls.vanish(); // the router keeps the old session: a ghost that still holds the registration
      await h2.clock.advance(500);
      expect(reg.error).toBeUndefined(); // retried inside the ghost window, not surfaced
      h2.router.connections[0]?.controls.drop(); // the router finally learns: the ghost goes
      await h2.clock.advance(70000);
      expect(reg.closed).toBe(false);
      expect(reg.values.length).toBeGreaterThanOrEqual(2); // registered again
    },
  );
});

describe('an UNREGISTER given up on keeps its key for the ghost memory of the session end', () => {
  test('the next registration of that procedure rides out the ghost instead of failing procedure_already_exists', async () => {
    const h2 = h.current;
    const c = h2.makeClient(Client, {
      options: { autoOpen: false, timeouts: { idle: 0, request: 50 }, retryOptions: { maxRetryDelay: 100 } },
    });
    c.open();
    await h2.clock.advance(0);
    const first = c.observe(
      'register',
      'com.example.r',
      c.client.register('com.example.r', () => 1),
    );
    await h2.clock.advance(0);
    expect(first.values).toHaveLength(1);
    c.connection.controls.freeze('drop', 'both'); // the UNREGISTER never reaches the router
    first.unsubscribe();
    await h2.clock.advance(100); // its request timeout: forgotten
    c.connection.controls.vanish(); // the router keeps the session and the registration: a ghost
    await h2.clock.advance(0); // the session has ended
    const again = c.observe(
      'register',
      'com.example.r',
      c.client.register('com.example.r', () => 2),
    );
    await h2.clock.advance(500);
    expect(again.error).toBeUndefined(); // retried inside the ghost window, not surfaced
    h2.router.connections[0]?.controls.drop(); // the router finally learns: the ghost goes
    await h2.clock.advance(70000);
    expect(again.closed).toBe(false);
    expect(again.values.length).toBeGreaterThanOrEqual(1);
  });

  test('so does a REGISTER whose late answer was forgotten', async () => {
    const h2 = h.current;
    const c = h2.makeClient(Client, {
      options: { autoOpen: false, timeouts: { idle: 0, request: 50 }, retryOptions: { maxRetryDelay: 100 } },
    });
    c.open();
    await h2.clock.advance(0);
    c.connection.controls.freeze('drop', 'down'); // the router registers it; its REGISTERED is lost
    const first = c.observe(
      'register',
      'com.example.r',
      c.client.register('com.example.r', () => 1),
    );
    await h2.clock.advance(60);
    expect(first.error).toMatchObject({ code: 'timeout' }); // late now
    await h2.clock.advance(60);
    c.observe(
      'register',
      'com.example.other',
      c.client.register('com.example.other', () => 1),
    ); // the next entry forgets the late REGISTER
    expect(c.trace().logs.some((l) => /late REGISTER .* forgotten/.test(l.entry.message))).toBe(true);
    c.connection.controls.vanish();
    await h2.clock.advance(0);
    const again = c.observe(
      'register',
      'com.example.r',
      c.client.register('com.example.r', () => 2),
    );
    await h2.clock.advance(500);
    expect(again.error).toBeUndefined();
  });
});
