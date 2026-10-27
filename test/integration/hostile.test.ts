// The hostile suite against wamp-server 0.0.9: a deliberately buggy router. Acceptance: no host exception
// (process-level hooks below), nothing unsettled after close(), no leaked timer (the afterEach checks), and every
// request either answered, timed out (the client's request timer, or the workload's own bound — the app's Rx timeout())
// or failed. Covered: CANCEL answered with GOODBYE + close 1005 (the router-GOODBYE path: reply, reconnect, in-flight
// Lost); an acknowledged PUBLISH without subscribers never acked; a callee ERROR never forwarded and a callee that
// leaves (the caller waits until its own bound); INVOCATION kwargs null; ABORT with swapped fields; a mixed workload
// that ends with close() and leaves nothing behind.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WampError } from '../../src/index.js';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { describeRouters, HOSTILE } from './harness/routers.js';
import { callee, delay, framesOf, nextClose, reopened, subscribed } from './harness/scenarios.js';

const hostErrors: unknown[] = [];
const onError = (error: unknown): void => {
  hostErrors.push(error);
};
beforeAll(() => {
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
});
afterAll(() => {
  process.off('uncaughtException', onError);
  process.off('unhandledRejection', onError);
  expect(hostErrors).toEqual([]);
});

/** The app's own bound (Rx timeout()): settle within `ms`, whatever the router does. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, delay(ms).then(() => 'timeout' as const)]);
}

describeRouters(
  'hostile',
  (r) => {
    test('CANCEL answered with GOODBYE + 1005: reply, in-flight Lost, reconnect', async () => {
      const procedure = uri('hostile');
      const backend = itClient(r, { name: 'callee' });
      let invoked = 0;
      await callee(backend, procedure, () => {
        invoked++;
        return new Promise(() => undefined);
      });
      const c = itClient(r, { name: 'canceller' });
      const before = (await c.opened()).id;
      const other = c.observe('call', procedure, c.client.call(procedure));
      const cancelled = c.observe('call', procedure, c.client.call(procedure));
      await eventually(() => invoked === 2, 5000, 'two INVOCATIONs');
      cancelled.unsubscribe();
      const end = await nextClose(c, 0);
      expect(end.initiator).toBe('router');
      expect(framesOf(c, 6, 'in').at(-1)).toEqual([6, {}, 'wamp.close.goodbye_and_out']);
      await eventually(() => other.errored, 3000, 'the other in-flight call failed');
      expect(other.error).toMatchObject({ code: 'connection_lost' });
      await reopened(c, before);
    });

    test('an acknowledged PUBLISH without subscribers is never acked: the app bound ends it', async () => {
      const c = itClient(r);
      await c.opened();
      expect(
        await bounded(firstValue(c.client.publish(uri('hostile'), ['x'], {}, { acknowledge: true }), 60000), 1500),
      ).toBe('timeout');
      expect(c.client.session).toBeDefined();
    });

    test('a callee ERROR (maybe never forwarded) and a callee that leaves: the caller waits only as long as it chose', async () => {
      const procedure = uri('hostile');
      const leaving = uri('hostile');
      const backend = itClient(r, { name: 'callee' });
      await callee(backend, procedure, () => {
        throw new WampError('com.thruwayjs.hostile.error');
      });
      let invoked = 0;
      await callee(backend, leaving, () => {
        invoked++;
        return new Promise(() => undefined);
      });
      const c = itClient(r, { name: 'caller' });
      // forwarded or not (ROUTERS-C saw callee ERRORs dropped; a uri-only one comes through): answered or bounded
      const outcome = await bounded(
        firstValue(c.client.call(procedure), 60000).catch((e: unknown) => e),
        1500,
      );
      if (outcome !== 'timeout') expect(outcome).toMatchObject({ code: 'wamp_error' });
      const call = c.observe('call', leaving, c.client.call(leaving));
      await eventually(() => invoked === 1, 3000, 'the INVOCATION');
      await backend.close();
      await delay(1000);
      call.unsubscribe(); // the app's timeout(); wamp-server kills the session on CANCEL (the case above)
      expect(call.errored).toBe(false);
    });

    test('INVOCATION kwargs null are normalised; results arrive', async () => {
      const procedure = uri('hostile');
      const backend = itClient(r, { name: 'callee' });
      await callee(backend, procedure, (inv) => ({ kwargs: inv.kwargs, args: inv.args }));
      const c = itClient(r, { name: 'caller' });
      const result = await firstValue(c.client.call(procedure, [1]));
      expect(result.args).toEqual([{ kwargs: {}, args: [1] }]);
    });

    test('ABORT with swapped fields (unknown realm): an AbortError with the reason, then backoff', async () => {
      const c = itClient(r, { realm: 'com.thruwayjs.nosuch', options: { retryOptions: { maxRetries: 1 } } });
      const end = await nextClose(c, 0);
      expect(end).toMatchObject({ initiator: 'router', reason: 'wamp.error.no_such_realm', willRetry: true });
      expect(end.error?.code).toBe('abort');
      await nextClose(c, 1);
      await eventually(() => c.status.values.at(-1)?.state === 'closed', 3000, 'gave up');
    });

    test('a mixed workload, then close(): nothing unsettled, no timer, no host exception', async () => {
      const procedure = uri('hostile');
      const backend = itClient(r, { name: 'callee' });
      await callee(backend, procedure, (inv) => inv.args[0]);
      const c = itClient(r, { name: 'worker' });
      const topic = uri('hostile');
      const events = await subscribed(c, topic);
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => bounded(firstValue(c.client.call(procedure, [i]), 60000), 3000)),
      );
      expect(results.filter((x) => x === 'timeout')).toEqual([]);
      for (let i = 0; i < 10; i++) await firstValue(backend.client.publish(topic, [i]));
      await eventually(() => events.values.length === 10, 3000, 'ten events');
      const pending = c.observe('call', uri('hostile'), c.client.call(uri('hostile'))); // unknown: answered or not
      await c.close();
      await eventually(() => pending.closed, 1000, 'the pending call settled by close()');
      expect(c.debug()).toMatchObject({ state: 'CLOSED', timers: 0, registry: 0 });
    });
  },
  HOSTILE,
);
