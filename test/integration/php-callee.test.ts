// v3 as caller of real thruway/client PHP callees (Thruway T2): the image's router runs two thruway/client 0.5.8
// callees as internal clients (the in-router backend pattern) — `thruway_test.php.*` with the stock Callee role (it
// announces call_canceling and honours INTERRUPT by cancelling the handler's promise) and `thruway_test.php_legacy.*`,
// which does not announce call_canceling (older thruway/client releases). Each slow job publishes
// `thruway_test.php.done [tag, "completed" | "canceled", callee]`.
//
// Against both: results and errors arrive faithfully; unsubscribing settles the call locally at once. The stock callee
// is interrupted (its job ends "canceled"); the legacy callee's CANCEL is refused (not_supported): `cancel.refused` is
// logged once per procedure, and its job runs to completion — unsubscribing cannot stop that work. A caller that leaves
// mid-call interrupts the stock callee the same way. No stream hangs.
import { expect, test } from 'vitest';
import { isWampError, type WampError } from '../../src/index.js';
import { allValues, errorOf, eventually, firstValue, itClient, unique, type ItClient } from './harness/recorder.js';
import { describeRouters } from './harness/routers.js';
import { framesOf, subscribed } from './harness/scenarios.js';

async function doneEvents(c: ItClient) {
  return subscribed(c, 'thruway_test.php.done');
}

describeRouters(
  'php callee',
  (r) => {
    test('results and errors of a thruway/client callee arrive faithfully', async () => {
      const c = itClient(r);
      expect((await firstValue(c.client.call('thruway_test.php.add', [2, 3]))).args).toEqual([5]);
      expect((await firstValue(c.client.call('thruway_test.php_legacy.add', [40, 2]))).args).toEqual([42]);
      const error = (await errorOf(c.client.call('thruway_test.php.fail', ['nope']))) as WampError;
      expect(isWampError(error)).toBe(true);
      expect(error).toMatchObject({ uri: 'thruway_test.php.failed', args: ['nope'], kwargs: { code: 42 } });
    });

    test('progressive results from the PHP callee: every progress value, then the final one', async () => {
      const c = itClient(r);
      const values = await allValues(c.client.progressiveCall('thruway_test.php.progress', [3, 30]));
      expect(values.map((v) => [v.args, v.details.progress === true])).toEqual([
        [[0], true],
        [[1], true],
        [[2], true],
        [[3], false],
      ]);
    });

    test('unsubscribe: the stock callee is interrupted; the legacy callee refuses, logged once, its job completes', async () => {
      const c = itClient(r);
      const done = await doneEvents(c);
      const stockTag = unique('stock');
      const stock = c.observe(
        'call',
        'thruway_test.php.slow',
        c.client.call('thruway_test.php.slow', [1500, stockTag]),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      stock.unsubscribe();
      await eventually(() => done.values.some((e) => e.args[0] === stockTag), 3000, 'the stock job ended');
      expect(done.values.find((e) => e.args[0] === stockTag)?.args[1]).toBe('canceled');
      expect(c.logged('cancel.refused')).toEqual([]);

      const tags = [unique('legacy'), unique('legacy')];
      for (const tag of tags) {
        const legacy = c.observe(
          'call',
          'thruway_test.php_legacy.slow',
          c.client.call('thruway_test.php_legacy.slow', [800, tag]),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        legacy.unsubscribe();
        expect(legacy.errored).toBe(false); // settled locally at once
      }
      await eventually(
        () => tags.every((tag) => done.values.some((e) => e.args[0] === tag)),
        4000,
        'the legacy jobs ended',
      );
      for (const tag of tags) expect(done.values.find((e) => e.args[0] === tag)?.args[1]).toBe('completed');
      const refusals = framesOf(c, 8, 'out').filter((f) => f[1] === 49 && f[4] === 'wamp.error.not_supported');
      expect(refusals.length).toBe(2);
      expect(c.logged('cancel.refused').length).toBe(1); // once per procedure and session
      expect(c.client.session).toBeDefined();
    });

    test('the caller leaves mid-call: the stock callee is interrupted, the legacy one completes', async () => {
      const watcher = itClient(r, { name: 'watcher' });
      const done = await doneEvents(watcher);
      const app = itClient(r, { name: 'leaving' });
      const stockTag = unique('stock');
      const legacyTag = unique('legacy');
      app.observe('call', 'thruway_test.php.slow', app.client.call('thruway_test.php.slow', [1500, stockTag]));
      app.observe(
        'call',
        'thruway_test.php_legacy.slow',
        app.client.call('thruway_test.php_legacy.slow', [800, legacyTag]),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await app.close();
      await eventually(
        () => [stockTag, legacyTag].every((tag) => done.values.some((e) => e.args[0] === tag)),
        4000,
        'both jobs ended',
      );
      expect(done.values.find((e) => e.args[0] === stockTag)?.args[1]).toBe('canceled');
      expect(done.values.find((e) => e.args[0] === legacyTag)?.args[1]).toBe('completed');
    });
  },
  ['thruway-php'],
);
