// Thruway PHP T1 (test/routers/ROUTERS-C.md): the Dealer's CALL index is realm-global and keyed by the caller's request
// id, so when two sessions have a CALL with the same id in flight only the latest can CANCEL it. The default
// `requestIds: 'random'` avoids that: 2 clients × 200 concurrent cancellable calls ⇒ every CANCEL interrupts the
// callee. The same scenario with `requestIds: 'sequential'` reproduces T1 — kept as a canary: if it ever stops
// reproducing, Thruway changed and the default may be revisited.
import { expect, test } from 'vitest';
import { eventually, itClient, uri } from './harness/recorder.js';
import { describeRouters, type Router } from './harness/routers.js';
import { callee } from './harness/scenarios.js';

const CALLS = 200;

async function cancelStorm(
  r: Router,
  requestIds: 'random' | 'sequential',
): Promise<{ invoked: number; interrupted: number }> {
  const procedure = uri('ids');
  const backend = itClient(r, { name: 'callee' });
  let invoked = 0;
  let interrupted = 0;
  await callee(backend, procedure, (inv) => {
    invoked++;
    inv.signal.addEventListener('abort', () => {
      interrupted++;
    });
    return new Promise(() => undefined);
  });
  const callers = [0, 1].map((i) => itClient(r, { name: `caller-${String(i)}`, options: { requestIds } }));
  await Promise.all(callers.map((c) => c.opened()));
  const calls = callers.flatMap((c) =>
    Array.from({ length: CALLS }, () => c.observe('call', procedure, c.client.call(procedure))),
  );
  await eventually(() => invoked === 2 * CALLS, 15000, `${String(2 * CALLS)} INVOCATIONs`);
  for (const call of calls) call.unsubscribe();
  await eventually(() => interrupted === 2 * CALLS, 5000, 'every INTERRUPT').catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { invoked, interrupted };
}

describeRouters(
  'thruway ids',
  (r) => {
    test(`random ids: 2 clients × ${String(CALLS)} concurrent calls, every CANCEL interrupts the callee`, async () => {
      const { invoked, interrupted } = await cancelStorm(r, 'random');
      expect(invoked).toBe(2 * CALLS);
      expect(interrupted).toBe(2 * CALLS);
    });

    test('sequential ids reproduce T1 (canary): some CANCELs are silently dropped by the realm-global index', async () => {
      const { invoked, interrupted } = await cancelStorm(r, 'sequential');
      expect(invoked).toBe(2 * CALLS);
      expect(interrupted).toBeLessThan(2 * CALLS);
    });
  },
  ['thruway-php'],
);
