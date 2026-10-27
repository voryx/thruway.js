// RPC against every router: args/kwargs round trips through a v3 callee on another session, handler results of every
// Input kind, router-forwarded callee errors (faithful where `callee_error_forwarded`, rewritten by fox-wamp),
// runtime_error for other throws (the registration stays), unknown procedures, many concurrent calls with unique
// in-flight ids (INV-CL02, the trace checks), and work subscribed before the first session waits for its WELCOME.
import { expect, test } from 'vitest';
import { isWampError, WampError, Yield } from '../../src/index.js';
import { errorOf, firstValue, itClient, uri } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee } from './harness/scenarios.js';

describeRouters('rpc', (r) => {
  test('args and kwargs round-trip through a callee on another session', async () => {
    const procedure = uri('rpc');
    const backend = itClient(r, { name: 'callee' });
    await callee(
      backend,
      procedure,
      (inv) => new Yield([...(inv.args as unknown[])].reverse(), { ...inv.kwargs, seen: true }),
    );
    const app = itClient(r, { name: 'caller' });
    const result = await firstValue(app.client.call(procedure, [1, 'two', { three: 3 }], { k: 'v', n: 2 ** 53 - 1 }));
    expect(result.args).toEqual([{ three: 3 }, 'two', 1]);
    expect(result.kwargs).toEqual({ k: 'v', n: 2 ** 53 - 1, seen: true });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('handler results: a value, a Promise, an Observable, undefined', async () => {
    const backend = itClient(r, { name: 'callee' });
    const base = uri('rpc');
    await callee(backend, `${base}.value`, () => 42);
    await callee(backend, `${base}.promise`, () => Promise.resolve('later'));
    await callee(backend, `${base}.observable`, () => ({
      subscribe(observer: { next(v: unknown): void; complete(): void }) {
        observer.next('streamed');
        observer.complete();
        return { unsubscribe: () => undefined };
      },
    }));
    await callee(backend, `${base}.nothing`, () => undefined);
    const app = itClient(r, { name: 'caller' });
    expect((await firstValue(app.client.call(`${base}.value`))).args).toEqual([42]);
    expect((await firstValue(app.client.call(`${base}.promise`))).args).toEqual(['later']);
    expect((await firstValue(app.client.call(`${base}.observable`))).args).toEqual(['streamed']);
    expect((await firstValue(app.client.call(`${base}.nothing`))).args).toEqual([]);
  });

  test('a WampError thrown by the callee reaches the caller (faithfully where the router forwards it)', async () => {
    const procedure = uri('rpc');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, () => {
      throw new WampError('com.thruwayjs.error.denied', ['no way'], { code: 7 });
    });
    const app = itClient(r, { name: 'caller' });
    const error = await errorOf(app.client.call(procedure));
    expect(isWampError(error)).toBe(true);
    const e = error as WampError;
    expect(e.procedure).toBe(procedure);
    if (cap(r, 'callee_error_forwarded') === 'always') {
      expect(e.uri).toBe('com.thruwayjs.error.denied');
      expect(e.args).toEqual(['no way']);
      expect(e.kwargs).toEqual({ code: 7 });
    } else {
      // fox-wamp: wamp.error.callee_failure ["com.thruwayjs.error.denied"]
      expect(JSON.stringify([e.uri, e.args])).toContain('com.thruwayjs.error.denied');
    }
  });

  test('any other throw is runtime_error and the registration stays', async () => {
    const procedure = uri('rpc');
    const backend = itClient(r, { name: 'callee' });
    let calls = 0;
    const registration = await callee(backend, procedure, () => {
      calls++;
      if (calls === 1) throw new TypeError('bug in the handler');
      return 'recovered';
    });
    const app = itClient(r, { name: 'caller' });
    const error = (await errorOf(app.client.call(procedure))) as WampError;
    expect(isWampError(error)).toBe(true);
    if (cap(r, 'callee_error_forwarded') === 'always') expect(error.uri).toBe('wamp.error.runtime_error');
    expect((await firstValue(app.client.call(procedure))).args).toEqual(['recovered']);
    expect(registration.closed).toBe(false);
  });

  test('an unknown procedure is a WampError on that call only', async () => {
    const app = itClient(r);
    const procedure = uri('rpc');
    const error = (await errorOf(app.client.call(procedure))) as WampError;
    expect(isWampError(error)).toBe(true);
    expect(error.uri).toMatch(/no_such_procedure|no_such_registration|no_eligible_callee/);
    expect(app.client.session).toBeDefined();
    expect(app.onClose.values).toEqual([]);
  });

  test('100 concurrent calls: every answer to its own call, unique in-flight ids', async () => {
    const procedure = uri('rpc');
    const backend = itClient(r, { name: 'callee' });
    await callee(
      backend,
      procedure,
      (inv) =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve(inv.args[0]);
          }, Math.random() * 50),
        ),
    );
    const app = itClient(r, { name: 'caller' });
    await app.opened();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        firstValue(app.client.call(procedure, [i]), 20000).then((m) => m.args[0] as number),
      ),
    );
    // 100, not 200: Nexus answers wamp.error.network_failure ("callee blocked") once ~120 INVOCATIONs are queued
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  test('a call subscribed before the first session waits for the WELCOME', async () => {
    const procedure = uri('rpc');
    const backend = itClient(r, { name: 'callee' });
    await callee(backend, procedure, () => 'answered');
    const app = itClient(r, { name: 'caller', options: { autoOpen: false } });
    const pending = firstValue(app.client.call(procedure));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.trace().frames).toEqual([]); // nothing written: there is no socket yet
    app.open();
    await expect(pending).resolves.toMatchObject({ args: ['answered'] });
  });
});
