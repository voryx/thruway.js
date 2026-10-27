// Strict sequential request ids: Nexus main's `strict_request_ids` realm kills a session whose request id is not the
// next one. With `requestIds: 'sequential'` 10 000 mixed operations (calls, acknowledged publishes,
// subscribe/unsubscribe and register/unregister cycles, concurrently) run on one session without an ABORT or a close,
// and the trace checks verify 1, 2, 3, … per session. The default random ids are killed there (the canary that shows
// the realm is strict).
import { expect, test } from 'vitest';
import { firstValue, itClient, uri, eventually } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { callee, nextClose } from './harness/scenarios.js';

function strictRealm(r: Router): string {
  if (r.strictRealm === null) throw new Error(`${r.id} has no strict realm`);
  return r.strictRealm;
}

describeRouters('strict ids', (r) => {
  const strict = cap(r, 'strict_ids') === 'always';

  test.skipIf(!strict)("10 000 mixed operations with requestIds 'sequential': no abort, no close", async () => {
    const realm = strictRealm(r);
    const c = itClient(r, { realm, options: { requestIds: 'sequential' } });
    const procedure = uri('strict');
    await callee(c, procedure, (inv) => inv.args[0]);
    const before = (await c.opened()).id;
    const topic = uri('strict');
    let done = 0;
    const worker = async (lane: number): Promise<void> => {
      for (let i = lane; i < 10000; i += 50) {
        switch (i % 4) {
          case 0:
            expect((await firstValue(c.client.call(procedure, [i]))).args).toEqual([i]);
            break;
          case 1:
            await firstValue(c.client.publish(topic, [i], {}, { acknowledge: true }));
            break;
          case 2: {
            const sub = c.client.topic(`${topic}.${String(lane)}`).subscribe(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 1));
            sub.unsubscribe();
            break;
          }
          default: {
            const reg = c.client.register(`${procedure}.${String(lane)}`, () => 1).subscribe(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 1));
            reg.unsubscribe();
          }
        }
        done++;
      }
    };
    await Promise.all(Array.from({ length: 50 }, (_, lane) => worker(lane)));
    expect(done).toBe(10000);
    expect(c.onClose.values).toEqual([]);
    expect(c.client.session?.id).toBe(before);
  });

  test.skipIf(!strict)('random ids on the strict realm: killed (the canary)', async () => {
    const realm = strictRealm(r);
    const c = itClient(r, { realm, options: { retryOptions: { maxRetries: 0 } } });
    await c.opened();
    const call = c.observe('call', uri('strict'), c.client.call(uri('strict')));
    const end = await nextClose(c, 0, 10000);
    expect(end.willRetry).toBe(false);
    await eventually(() => call.errored, 3000, 'the call failed');
  });

  test.skipIf(strict)('no strict realm: sequential ids work on the default realm too', async () => {
    const c = itClient(r, { options: { requestIds: 'sequential' } });
    const procedure = uri('strict');
    await callee(c, procedure, () => 'ok');
    for (let i = 0; i < 20; i++) expect((await firstValue(c.client.call(procedure))).args).toEqual(['ok']);
  });
});
