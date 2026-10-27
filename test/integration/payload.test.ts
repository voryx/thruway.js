// Payload fidelity against every router: JSON values survive the round trip through a v3 callee on another session —
// 2^53−1, negative and fractional numbers, astral unicode, nested containers, empty containers (routers drop empty
// args/kwargs: normalised to [] / {}), a nested single array where `args_nested_array_preserved` (fox-wamp unwraps
// `[[x]]`); a 1 MiB result everywhere; a frame over the router's limit (`max_message_bytes`, Bondy 4 MB) closes the
// connection (1009) and the client reconnects; a frame over 16 MiB is never written (payload_size_exceeded on that op
// only); a callee error's `args[0]` sentence reaches the caller untouched (as backends behind Thruway PHP need).
import { expect, test } from 'vitest';
import { WampError, Yield } from '../../src/index.js';
import { errorOf, firstValue, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, nextClose, reopened } from './harness/scenarios.js';

const VALUES: readonly (readonly [string, unknown])[] = [
  ['max safe integer', 2 ** 53 - 1],
  ['min safe integer', -(2 ** 53 - 1)],
  ['fraction', 0.1 + 0.2],
  ['unicode', 'grüße ✓ 𝄞 🥚  '],
  ['nested', { a: [1, { b: [null, true, false, ''] }], c: {} }],
  ['empty string', ''],
  ['null', null],
];

describeRouters('payload', (r) => {
  test('JSON values round-trip through a callee on another session', async () => {
    const procedure = uri('payload');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, (inv) => new Yield([...(inv.args as unknown[])], { ...inv.kwargs }));
    const app = itClient(r, { name: 'caller' });
    for (const [name, value] of VALUES) {
      const result = await firstValue(app.client.call(procedure, [value, 'tail'], { v: value }));
      expect([name, result.args, result.kwargs]).toEqual([name, [value, 'tail'], { v: value }]);
    }
  });

  test('empty args and kwargs are normalised to [] and {}', async () => {
    const procedure = uri('payload');
    const backend = itClient(r, { name: 'callee' });
    await callee(
      backend,
      procedure,
      (inv) => new Yield([], { sawArgs: inv.args.length, sawKwargs: Object.keys(inv.kwargs).length }),
    );
    const app = itClient(r, { name: 'caller' });
    const result = await firstValue(app.client.call(procedure, [], {}));
    expect(result.args).toEqual([]);
    expect(result.kwargs).toMatchObject({ sawArgs: 0, sawKwargs: 0 });
  });

  test('a nested single array: kept where the router preserves it', async () => {
    const procedure = uri('payload');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, (inv) => new Yield([...(inv.args as unknown[])]));
    const app = itClient(r, { name: 'caller' });
    const result = await firstValue(app.client.call(procedure, [['x']]));
    if (cap(r, 'args_nested_array_preserved') === 'always') expect(result.args).toEqual([['x']]);
    else expect(JSON.stringify(result.args)).toContain('x'); // fox-wamp: [[x]] → [x] (silent corruption, documented)
  });

  // 1 MiB, or just under the limit of a router whose limit is the whole frame
  test('a 1 MiB result arrives (or the largest under the router limit)', async () => {
    const procedure = uri('payload');
    const big = 'b'.repeat(Math.min(1024 * 1024, cap(r, 'max_message_bytes') - 1024));
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, () => big);
    const app = itClient(r, { name: 'caller' });
    expect(((await firstValue(app.client.call(procedure), 20000)).args[0] as string).length).toBe(big.length);
  });

  const limit = cap(r, 'max_message_bytes');
  test.skipIf(limit >= 16 * 1024 * 1024)(
    "a frame over the router's limit: the connection closes, the client reconnects",
    async () => {
      const app = itClient(r);
      const before = (await app.opened()).id;
      const call = app.observe('call', uri('payload'), app.client.call(uri('payload'), ['o'.repeat(limit + 1024)]));
      const end = await nextClose(app, 0, 10000);
      expect(end.willRetry).toBe(true);
      expect([1009, 1006]).toContain(end.closeCode);
      expect(call.errored).toBe(true);
      await reopened(app, before);
    },
  );

  test('a frame over 16 MiB is never written: payload_size_exceeded on that op only', async () => {
    const app = itClient(r);
    await app.opened();
    const error = (await errorOf(app.client.call(uri('payload'), ['h'.repeat(16 * 1024 * 1024 + 16)]))) as WampError;
    expect(error.uri).toBe('wamp.error.payload_size_exceeded');
    expect(
      app.trace().frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 48),
    ).toEqual([]);
    expect(app.onClose.values).toEqual([]);
  });

  test("a callee error's args[0] sentence reaches the caller untouched (PW)", async () => {
    const procedure = uri('payload');
    const backend = itClient(r, { name: 'callee' });
    const sentence = 'com.example.error.not_authorized: [you may not]';
    await callee(backend, procedure, () => {
      throw new WampError('wamp.error.runtime_error', [sentence]);
    });
    const app = itClient(r, { name: 'caller' });
    const error = (await errorOf(app.client.call(procedure))) as WampError;
    if (cap(r, 'callee_error_forwarded') === 'always') expect(error.args).toEqual([sentence]);
    else expect(JSON.stringify(error.args)).toBeDefined();
  });
});
