// The client-level ghost memory filled by hardReset keeps the most recent keys (machine.ts `rememberGhost`), with
// GHOST_MEMORY mocked down to 2 for the core so that eviction is reachable cheaply (see mutation-gaps.test.ts).
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import type { FaultsHook } from '../../src/core/machine.js';
import type * as RegisterModule from '../../src/ops/register.js';
import { createHarness } from '../helpers/harness.js';

vi.mock('../../src/ops/register.js', async (original) => ({
  ...(await original<typeof RegisterModule>()),
  GHOST_MEMORY: 2,
}));

describe('hardReset ghost memory', () => {
  test('a key remembered again becomes the most recent: the oldest other key is evicted first', async () => {
    const h = createHarness({ seed: 7, checks: { internalLogs: false } });
    const c = h.makeClient(Client, {
      options: { autoOpen: false, timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 1000 } },
    });
    const faults = c.faults as FaultsHook;
    const reg = (uri: string) =>
      c.observe(
        'register',
        uri,
        c.client.register(uri, () => uri),
      );
    c.open();
    await h.clock.advance(5);
    const k1 = reg('com.k1');
    const k2 = reg('com.k2');
    await h.clock.advance(5);
    faults.inject('liveness.check');
    c.open(); // hardReset in the session: remembers k1, k2
    // the next session's REGISTERs of k1 and k2 stay unanswered: a REGISTERED would clear them from the memory
    const unanswered = h.router.ignore((f) => f[0] === 64 && (f[3] === 'com.k1' || f[3] === 'com.k2'));
    await h.clock.advance(1100);
    expect(c.status?.values.at(-1)?.state).toBe('open');
    k2.unsubscribe();
    reg('com.k3');
    await h.clock.advance(5);
    faults.inject('liveness.check');
    c.open(); // remembers k1 (again: now the most recent) and k3; k2 is evicted
    unanswered();
    await h.clock.advance(5); // waiting 1 s: another client takes com.k1 meanwhile
    const peer = h.makeClient(Client, { scope: 'peer', options: { autoOpen: false, timeouts: { idle: 0 } } });
    peer.open();
    await h.clock.advance(5);
    peer.observe(
      'register',
      'com.k1',
      peer.client.register('com.k1', () => 'peer'),
    );
    await h.clock.advance(1100);
    expect(c.status?.values.at(-1)?.state).toBe('open');
    expect(k1.error).toBeUndefined(); // its procedure_already_exists is ridden out as a ghost of the reset session
    await h.closeAndSettle();
  });
});
