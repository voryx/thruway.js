// Progressive results against every router: progressiveCall to a v3 callee whose handler is an Observable — every
// progress value arrives, the empty final terminator is not surfaced; a router without progressive results (Bondy)
// turns the first progress YIELD into the final RESULT, which is emitted and completes the op; a router that does not
// tell the callee that progress was asked for (Bondy: `invocation_receive_progress`) gets one final YIELD, whose
// payload a router may drop (`progressive_final_payload`). A Promise handler answers a progressive call with one final
// result. Unsubscribing mid-stream sends CANCEL killnowait (the Rx `timeout()` recipe), settles locally and interrupts
// the callee where the router forwards it. An ERROR after progress errors the op.
import { expect, test } from 'vitest';
import { isWampError, WampError } from '../../src/index.js';
import type { InvocationMessage } from '../../src/types.js';
import { allValues, errorOf, eventually, itClient, uri, valueOf } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, framesOf } from './harness/scenarios.js';

/** An Observable handler: `n` values `gap` ms apart, then completion (or an error). */
function ticks(n: number, gap: number, fail = false) {
  return (inv: InvocationMessage) => ({
    subscribe(observer: { next(v: unknown): void; error(e: unknown): void; complete(): void }) {
      let i = 0;
      const timer = setInterval(() => {
        if (i < n) {
          observer.next(i++);
          return;
        }
        clearInterval(timer);
        if (fail) observer.error(new WampError('com.thruwayjs.error.stream_broke', ['after progress']));
        else observer.complete();
      }, gap);
      inv.signal.addEventListener('abort', () => {
        clearInterval(timer);
      });
      return {
        unsubscribe: () => {
          clearInterval(timer);
        },
      };
    },
  });
}

describeRouters('progressive', (r) => {
  test('every progress value, then completion (the empty terminator is not emitted)', async () => {
    const procedure = uri('progressive');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, ticks(3, 30));
    const app = itClient(r, { name: 'caller' });
    const values = await allValues(app.client.progressiveCall(procedure));
    const told = cap(r, 'invocation_receive_progress');
    if (cap(r, 'progressive_results') === 'always' && told === 'always') {
      expect(values.map((v) => v.args as unknown[])).toEqual([[0], [1], [2]]);
      expect(values.every((v) => v.details.progress === true)).toBe(true);
    } else if (told === 'never' && cap(r, 'progressive_final_payload') === 'never') {
      // the callee is not told, answers with one final YIELD of its last value, and the router replaces it with an
      // empty final RESULT — emitted (nothing came before) without the value
      expect(values.map((v) => [v.args, v.kwargs])).toEqual([[[], {}]]);
    } else if (cap(r, 'progressive_results') === 'never' || told === 'never') {
      // Bondy does not pass receive_progress to the callee, so a v3 callee answers with one final YIELD (its last
      // value); a callee that sends progress anyway gets its first progress YIELD turned into the final RESULT
      expect(values.length).toBe(1);
    } else {
      expect(values.length).toBeGreaterThanOrEqual(1);
    }
    const [call] = framesOf(app, 48, 'in');
    expect((call?.[2] as { receive_progress?: unknown }).receive_progress).toBe(true);
  });

  test('a Promise handler answers a progressive call with one final result', async () => {
    const procedure = uri('progressive');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, () => Promise.resolve('done'));
    const app = itClient(r, { name: 'caller' });
    const values = await allValues(app.client.progressiveCall(procedure));
    // a router may drop the final YIELD's payload of a progressive call
    if (cap(r, 'progressive_final_payload') === 'never')
      expect(values.map((v) => [v.args, v.kwargs])).toEqual([[[], {}]]);
    else expect(values.map((v) => v.args as unknown[])).toEqual([['done']]);
  });

  test('unsubscribing mid-stream: CANCEL killnowait, settled locally, no further values', async () => {
    const procedure = uri('progressive');
    const backend = itClient(r, { name: 'callee' });
    let aborted: unknown;
    let invoked = 0;
    await callee(backend, procedure, (inv) => {
      invoked++;
      inv.signal.addEventListener('abort', () => {
        aborted = inv.signal.reason;
      });
      return ticks(1000, 50)(inv);
    });
    const app = itClient(r, { name: 'caller' });
    const stream = app.observe('call', procedure, app.client.progressiveCall(procedure));
    if (cap(r, 'progressive_results') === 'always' && cap(r, 'invocation_receive_progress') === 'always')
      await valueOf(stream, 1);
    else await eventually(() => invoked === 1, 5000, 'the INVOCATION');
    stream.unsubscribe();
    const seen = stream.values.length;
    await eventually(() => framesOf(app, 49, 'in').length === 1, 2000, 'CANCEL written');
    if (cap(r, 'cancel_interrupts_callee') === 'always') {
      await eventually(() => aborted !== undefined, 3000, 'the callee interrupted');
      expect((aborted as { code?: unknown }).code).toBe('canceled');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stream.values.length).toBe(seen);
    expect(stream.errored).toBe(false);
  });

  test('an ERROR after progress errors the op (a router without progress completed it at the first value)', async () => {
    const procedure = uri('progressive');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, ticks(2, 30, true));
    const app = itClient(r, { name: 'caller' });
    // without progressive results, or when the callee is not told about them, the callee's invocation is not
    // progressive: its error is the only answer
    const expected =
      cap(r, 'progressive_results') === 'never' || cap(r, 'invocation_receive_progress') === 'never' ? 0 : 2;
    const values: unknown[] = [];
    const error = await errorOf({
      subscribe: (o) =>
        app.client.progressiveCall(procedure).subscribe({
          next: (v) => values.push(v),
          error: (e: unknown) => o.error?.(e),
          complete: () => o.complete?.(),
        }),
    });
    expect(isWampError(error)).toBe(true);
    if (cap(r, 'progressive_results') !== 'sometimes') expect(values.length).toBe(expected);
    if (cap(r, 'callee_error_forwarded') === 'always')
      expect((error as WampError).uri).toBe('com.thruwayjs.error.stream_broke');
  });
});
