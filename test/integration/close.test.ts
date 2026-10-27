// close() and open() against every router: GOODBYE close_realm once, any reply (or a close) ends the lingering wait,
// close() resolves within the GOODBYE wait (+ε) and is idempotent (one onClose); pending ops and interests fail with
// ConnectionClosedError{gaveUp: false}; work started afterwards fails at once; open() right after close() reaches a new
// session whose first frame is HELLO; close() while connecting starts nothing new; against a frozen peer close() still
// resolves on time — the `ws` transport is then terminated, undici keeps its socket until the peer answers (measured on
// Node 22, 24 and 26).
import WebSocketNode from 'ws';
import { afterEach, expect, test } from 'vitest';
import type { WebSocketConstructorLike } from '../../src/types.js';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { errorFrom, eventually, firstValue, itClient, uri, type ItClient } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, delay, framesOf, subscribed } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

async function timed(c: ItClient): Promise<number> {
  const started = performance.now();
  await c.close();
  return performance.now() - started;
}

describeRouters('close', (r) => {
  test('GOODBYE close_realm once, the reply ends the wait, close() is idempotent', async () => {
    const c = itClient(r);
    await c.opened();
    const first = c.close();
    const second = c.close();
    const started = performance.now();
    await Promise.all([first, second]);
    expect(performance.now() - started).toBeLessThan(1500); // the fast profile's GOODBYE wait is 1 s
    const goodbyes = framesOf(c, 6, 'in');
    expect(goodbyes).toEqual([[6, {}, 'wamp.close.close_realm']]);
    if (cap(r, 'goodbye_reply_delivered') === 'always') {
      await eventually(() => framesOf(c, 6, 'out').length === 1, 1000, 'the GOODBYE reply');
    }
    const ends = c.onClose.values;
    expect(ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ initiator: 'app', willRetry: false, error: undefined, attempt: 0 });
    await expect(c.close()).resolves.toBeUndefined();
    expect(c.onClose.values.length).toBe(1);
  });

  test('pending work fails with ConnectionClosedError; work after close() fails at once', async () => {
    const procedure = uri('close');
    const backend = itClient(r, { name: 'callee' });
    let invoked = 0;
    await callee(backend, procedure, () => {
      invoked++;
      return new Promise(() => undefined); // never answers
    });
    const c = itClient(r);
    const call = c.observe('call', procedure, c.client.call(procedure));
    const topic = await subscribed(c, uri('close'));
    await eventually(() => invoked === 1, 5000, 'the INVOCATION');
    await c.close();
    for (const stream of [call, topic]) {
      const error = (await errorFrom(stream, 1000)) as { code?: unknown; gaveUp?: unknown };
      expect(error.code).toBe('connection_closed');
      expect(error.gaveUp).toBe(false);
    }
    const after = (await errorFrom(c.observe('call', procedure, c.client.call(procedure)), 1000)) as { code?: unknown };
    expect(after.code).toBe('connection_closed');
  });

  test('open() right after close(): a new connection, HELLO first, a new session', async () => {
    const c = itClient(r);
    const first = await c.opened();
    const closing = c.close();
    c.open();
    await closing;
    await eventually(() => c.client.session !== undefined && c.client.session.id !== first.id, 10000, 'a new session');
    expect(c.sockets.length).toBe(2);
    const hello = c.trace().frames.find((f) => f.connection === 2 && f.direction === 'in')?.frame as unknown[];
    expect(hello.slice(0, 2)).toEqual([1, r.realm]);
  });

  test('close() while connecting: resolves, nothing new is started', async () => {
    const proxy = await ChaosProxy.start({ target: r.url });
    proxies.push(proxy);
    proxy.stallUpgrade(Infinity);
    const c = itClient(r, { url: proxy.url });
    await eventually(() => c.status.values.at(-1)?.state === 'connecting', 2000, 'connecting');
    await delay(100);
    expect(await timed(c)).toBeLessThan(1500);
    await delay(500);
    expect(c.status.values.at(-1)?.state).toBe('closed');
    expect(c.sockets.length).toBe(1);
  });

  for (const transport of ['undici', 'ws'] as const) {
    test(`a frozen peer (${transport}): close() still resolves within the GOODBYE wait`, async () => {
      const proxy = await ChaosProxy.start({ target: r.url });
      proxies.push(proxy);
      const c = itClient(r, {
        url: proxy.url,
        ...(transport === 'ws' ? { WebSocket: WebSocketNode as unknown as WebSocketConstructorLike } : {}),
      });
      await c.opened();
      proxy.freeze();
      const took = await timed(c);
      expect(took).toBeGreaterThan(900); // waited for the reply that never comes …
      expect(took).toBeLessThan(1800); // … but only for the GOODBYE wait (1 s in the fast profile)
      if (transport === 'ws') {
        // terminate() after the wait: the socket is gone although the peer never answered
        await eventually(() => c.openSockets() === 0, 1000, 'the ws socket terminated');
      } else {
        c.allowOpenSockets = true; // undici has no terminate(): its socket waits for the peer
      }
      expect(c.debug().timers).toBe(0);
    });
  }

  test('a router that keeps the socket open after GOODBYE: the client closes it itself', async () => {
    const c = itClient(r);
    await c.opened();
    await c.close();
    await eventually(() => c.openSockets() === 0, 2500, 'the socket closed');
    const closed = c.sockets[0]?.closed;
    expect(closed).toBeDefined();
    if (cap(r, 'router_closes_after_goodbye') === 'never') expect(c.sockets[0]?.released).toBe(true);
  });

  test('close() during a session with a registration: UNREGISTER is not sent, only GOODBYE', async () => {
    const c = itClient(r);
    await callee(c, uri('close'), () => 1);
    await subscribed(c, uri('close'));
    await c.close();
    const written = c
      .trace()
      .frames.filter((f) => f.direction === 'in')
      .map((f) => (f.frame as unknown[])[0]);
    expect(written.at(-1)).toBe(6);
    expect(written).not.toContain(66);
    expect(written).not.toContain(34);
    // and a CALL from elsewhere no longer reaches it
    const other = itClient(r, { name: 'other' });
    await other.opened();
    await expect(firstValue(other.client.call(uri('close')))).rejects.toMatchObject({ code: 'wamp_error' });
  });
});
