// A peer leaving mid-call against every router: the callee leaves (close() or its TCP connection destroyed) ⇒ the
// caller gets an ERROR where the router answers (`callee_leave_answer`; Thruway/Crossbar/Nexus canceled, Bondy
// no_eligible_callee), else it waits — and the app's own bound (Rx timeout ⇒ unsubscribe ⇒ CANCEL) ends it without
// disturbing the session. The caller leaves ⇒ the v3 callee's handler is interrupted where the router forwards it
// (`caller_leave_interrupts`).
import { afterEach, expect, test } from 'vitest';
import { isWampError } from '../../src/index.js';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { eventually, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, delay, framesOf } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

describeRouters('leave', (r) => {
  for (const how of ['close', 'kill'] as const) {
    test(`the callee leaves mid-call (${how}): the caller is answered, or its own bound ends the wait`, async () => {
      const proxy = await ChaosProxy.start({ target: r.url });
      proxies.push(proxy);
      const procedure = uri('leave');
      const backend = itClient(r, { name: 'callee', url: proxy.url });
      let invoked = 0;
      await callee(backend, procedure, () => {
        invoked++;
        return new Promise(() => undefined);
      });
      const app = itClient(r, { name: 'caller' });
      const call = app.observe('call', procedure, app.client.call(procedure));
      await eventually(() => invoked === 1, 5000, 'the INVOCATION');
      if (how === 'close') await backend.close();
      else proxy.kill();
      if (cap(r, 'callee_leave_answer') === 'always') {
        await eventually(() => call.errored, 5000, 'the ERROR for the call');
        expect(isWampError(call.error)).toBe(true);
      } else {
        await delay(1500);
        if (!call.errored) {
          call.unsubscribe(); // the app's timeout(): CANCEL killnowait, settled locally
          expect(framesOf(app, 49, 'in').length).toBe(1);
        }
      }
      expect(app.client.session).toBeDefined();
      expect(app.onClose.values).toEqual([]);
    });
  }

  test('the caller leaves mid-call: the callee is interrupted where the router forwards it', async () => {
    const procedure = uri('leave');
    const backend = itClient(r, { name: 'callee' });
    let invoked = 0;
    let aborted: unknown;
    await callee(backend, procedure, (inv) => {
      invoked++;
      inv.signal.addEventListener('abort', () => {
        aborted = inv.signal.reason;
      });
      return new Promise(() => undefined);
    });
    const app = itClient(r, { name: 'caller' });
    app.observe('call', procedure, app.client.call(procedure));
    await eventually(() => invoked === 1, 5000, 'the INVOCATION');
    await app.close();
    if (cap(r, 'caller_leave_interrupts') === 'always') {
      await eventually(() => aborted !== undefined, 5000, 'the handler interrupted');
      expect((aborted as { code?: unknown }).code).toBe('canceled');
    } else {
      await delay(1000);
    }
    expect(backend.client.session).toBeDefined();
    expect(backend.onClose.values).toEqual([]);
  });
});
