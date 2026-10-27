// close() and open(): a never-opened client queues work and close() fails it; a stopped client fails new work at once;
// close() in every state (WAITING, connecting, established); the GOODBYE + lingering connection and every way it
// finishes (GOODBYE of any reason, ABORT, socket close, the 2 s timer with terminate()); nothing written after GOODBYE;
// idempotence; the close() promise resolving when the connections that existed at its call are released; open() right
// after close().
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { isThruwayError } from '../../src/errors.js';
import type { ClientOptions, CloseInfo } from '../../src/types.js';
import { createHarness, INTERNAL_OPTIONS_KEY, useHarness, type Harness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 44 });

function start(options: ClientOptions = {}, setup?: (harness: Harness) => void): SimClient<Client> {
  setup?.(h.current);
  return h.current.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
}
function written(c: SimClient<Client>, n = 1): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket)
    .map((f) => f.frame as unknown[]);
}
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s) => s.state);
const advance = (ms: number): Promise<void> => h.current.clock.advance(ms);
const raw = (frame: unknown[]): void => {
  h.current.router.sendRaw(JSON.stringify(frame));
};
const never = (): Promise<never> => new Promise<never>(() => undefined);

/** Resolution state of a close() promise. */
function tracked(p: Promise<void>): { readonly done: boolean } {
  const state = { done: false };
  void p.then(() => {
    state.done = true;
  });
  return state;
}

describe('a never-opened client (autoOpen: false)', () => {
  test('work waits: calls queue, interests are dormant, nothing is written', async () => {
    const { router } = h.current;
    router.procedure('com.example.p', () => 1);
    router.declareTopic('com.example.t');
    const c = start({ autoOpen: false });
    const call = c.observe('call', 'p', c.client.call('com.example.p'));
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    await advance(10000);
    expect(c.connections).toHaveLength(0);
    expect(call.closed || topic.closed).toBe(false);
    c.open();
    await advance(1);
    expect(call.values).toHaveLength(1);
  });

  test('close() fails what it queued with ConnectionClosedError{gaveUp: false}; no lifecycle event; stopped', async () => {
    const c = start({ autoOpen: false });
    const call = c.observe('call', 'p', c.client.call('com.example.p'));
    const pub = c.observe('publish', 't', c.client.publish('com.example.t'));
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    const done = tracked(c.close());
    await advance(0);
    expect(done.done).toBe(true);
    for (const r of [call, pub, topic, reg]) {
      expect(isThruwayError(r.error) && r.error.code).toBe('connection_closed');
      expect((r.error as { gaveUp: boolean }).gaveUp).toBe(false);
    }
    expect((call.error as { procedure?: string }).procedure).toBe('com.example.p');
    expect((pub.error as { topic?: string }).topic).toBe('com.example.t');
    expect(c.status?.values).toEqual([{ state: 'closed', closed: undefined }]);
    expect(closes(c)).toEqual([]);
    const late = c.observe('call', 'p', c.client.call('com.example.p'));
    expect(late.error).toMatchObject({ code: 'connection_closed', gaveUp: false }); // stopped: at once
    void c.close(); // idempotent
    await advance(0);
    expect(closes(c)).toEqual([]);
  });
});

describe('close() in every state', () => {
  test('established: GOODBYE close_realm, nothing else, every op Closed, no CANCEL/UNSUBSCRIBE/UNREGISTER', async () => {
    const { router } = h.current;
    router.procedure('com.example.slow', never);
    router.declareTopic('com.example.t');
    const c = start();
    const call = c.observe('call', 's', c.client.call('com.example.slow'));
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    await advance(1);
    const before = written(c).length;
    const done = tracked(c.close());
    expect(states(c).at(-1)).toBe('closed'); // stopped and CLOSED before any I/O
    expect(c.client.session).toBeUndefined();
    await advance(1);
    expect(written(c).slice(before)).toEqual([[6, {}, 'wamp.close.close_realm']]);
    for (const r of [call, topic, reg]) expect(r.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
    expect(closes(c).at(-1)).toMatchObject({
      initiator: 'app',
      reason: 'wamp.close.close_realm',
      error: undefined,
      willRetry: false,
      attempt: 0,
      sessionId: 1,
    });
    expect(done.done).toBe(true); // the router answered the GOODBYE and closed: the lingering record is done
    expect(c.connection.controls.listenerCount).toBe(0);
  });

  test('every op and interest failed by close() names its own procedure/topic; in-flight ones their request and session', async () => {
    const { router } = h.current;
    router.procedure('com.example.slow', never);
    router.declareTopic('com.example.t');
    router.declareTopic('com.example.ack');
    router.ignore((frame) => frame[0] === 16); // the acknowledged PUBLISH stays in flight
    const c = start();
    let invocationSignal: AbortSignal | undefined;
    const call = c.observe('call', 's', c.client.call('com.example.slow'));
    const ack = c.observe('publish', 'a', c.client.publish('com.example.ack', [1], {}, { acknowledge: true }));
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', (invocation) => {
        invocationSignal = invocation.signal as AbortSignal;
        return never();
      }),
    );
    await advance(1);
    const invocation = router.invoke('com.example.r');
    await advance(1);
    const frames = written(c);
    const callId = frames.find((f) => f[0] === 48 && f[3] === 'com.example.slow')?.[1];
    const publishId = frames.find((f) => f[0] === 16)?.[1];
    const invocationId = invocation.invocation?.id;
    const done = tracked(c.close());
    await advance(10);
    expect(done.done).toBe(true);
    const sessionId = closes(c).at(-1)?.sessionId;
    expect(sessionId).toBe(1);
    expect(call.error).toMatchObject({
      name: 'ConnectionClosedError',
      procedure: 'com.example.slow',
      requestId: callId,
      sessionId,
    });
    expect(ack.error).toMatchObject({
      name: 'ConnectionClosedError',
      topic: 'com.example.ack',
      requestId: publishId,
      sessionId,
    });
    expect(topic.error).toMatchObject({ name: 'ConnectionClosedError', topic: 'com.example.t' });
    expect(reg.error).toMatchObject({ name: 'ConnectionClosedError', procedure: 'com.example.r' });
    for (const interest of [topic.error, reg.error]) {
      expect(interest).not.toHaveProperty('requestId');
      expect(interest).not.toHaveProperty('sessionId');
    }
    expect(invocationSignal?.reason).toMatchObject({
      name: 'ConnectionClosedError',
      procedure: 'com.example.r',
      requestId: invocationId,
      sessionId,
    });
    // no two records share one error object
    const errors = [call.error, ack.error, topic.error, reg.error, invocationSignal?.reason];
    expect(new Set(errors).size).toBe(errors.length);
  });

  test('a give-up: every interest errors ConnectionClosedError{gaveUp: true, cause} with its own procedure/topic', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    const c = start({ retryOptions: { maxRetries: 0 } });
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    await advance(1);
    router.drop();
    await advance(1);
    const cause = closes(c).at(-1)?.error;
    expect(closes(c).at(-1)?.willRetry).toBe(false);
    expect(topic.error).toMatchObject({ name: 'ConnectionClosedError', gaveUp: true, topic: 'com.example.t' });
    expect(reg.error).toMatchObject({ name: 'ConnectionClosedError', gaveUp: true, procedure: 'com.example.r' });
    expect((topic.error as { cause?: unknown }).cause).toBe(cause);
    expect(topic.error).not.toBe(reg.error);
  });

  test.each(['close() in a session', 'close() while waiting', 'a give-up'] as const)(
    '%s: the app hears it (status, onClose) before any op fails, waiting ones included',
    async (how) => {
      const { router } = h.current;
      router.procedure('com.example.slow', never);
      router.declareTopic('com.example.t');
      const order: string[] = [];
      const c = start(
        how === 'a give-up'
          ? { retryOptions: { maxRetries: 0 } }
          : how === 'close() while waiting'
            ? { retryOptions: { retryDelay: () => 60000 } }
            : {},
        (x) => {
          if (how === 'close() while waiting') x.router.setAvailable('refuse');
        },
      );
      const expected = ['topic'];
      c.client.topic('com.example.t').subscribe({ error: () => order.push('topic') });
      c.client.status.subscribe((s) => {
        if (s.state === 'closed') order.push('status closed');
      });
      c.client.onClose.subscribe(() => order.push('onClose'));
      if (how !== 'close() while waiting') {
        c.client.call('com.example.slow').subscribe({ error: () => order.push('in-flight call') });
        expected.push('in-flight call');
      }
      await advance(1);
      if (how === 'a give-up') {
        c.connection.controls.closingWindow(100); // the next write is refused, which ends the session
        await advance(1);
      }
      if (how === 'close() while waiting') order.length = 0; // the refused attempt was announced already
      if (how !== 'close() in a session') {
        // in the FIFO; for the give-up its write is the one refused, which ends the session in this subscribe
        c.client.call('com.example.slow').subscribe({ error: () => order.push('waiting call') });
        expected.push('waiting call');
      }
      if (how !== 'a give-up') void c.close();
      await advance(200);
      expect(order.slice(0, 2)).toEqual(['status closed', 'onClose']);
      expect(order.slice(2).sort()).toEqual(expected.sort());
    },
  );

  test('waiting: the retry timer is cancelled; one onClose{app, reason undefined}; resolves at once', async () => {
    const c = start({ retryOptions: { retryDelay: () => 60000 } });
    await advance(1);
    h.current.router.drop();
    await advance(1);
    expect(states(c).at(-1)).toBe('closed');
    const done = tracked(c.close());
    await advance(0);
    expect(done.done).toBe(true);
    expect(closes(c).at(-1)?.attempt).toBe(0); // 0 for close(), whatever failures preceded it
    expect(closes(c).at(-1)).toMatchObject({
      initiator: 'app',
      reason: undefined,
      willRetry: false,
      closeCode: undefined,
      attempt: 0,
    });
    expect(c.scope.pendingTimers).toBe(0);
    await advance(120000);
    expect(c.connections).toHaveLength(1); // no resurrection
  });

  test.each([
    [
      'connecting',
      (x: Harness) => {
        x.router.setAvailable('hang');
      },
    ],
    ['hello sent', (x: Harness) => x.router.ignore((f) => f[0] === 1)],
  ])('%s: the socket is closed 1000; onClose{app}; nothing written but HELLO', async (_n, setup) => {
    const c = start({}, (x) => {
      setup(x);
    });
    await advance(1);
    const done = tracked(c.close());
    await advance(0);
    expect(done.done).toBe(true);
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
    expect(closes(c).at(-1)).toMatchObject({ initiator: 'app', reason: undefined, willRetry: false, closeCode: 1000 });
    expect(written(c).every((f) => f[0] === 1)).toBe(true);
  });

  test('resolving: the url resolver pending value is cancelled; no socket existed, so no closeCode', async () => {
    const teardown = vi.fn();
    const c = h.current.makeClient(Client, {
      url: () => ({
        subscribe: () => ({ unsubscribe: teardown }),
      }),
      options: { timeouts: { idle: 0 } },
    });
    await advance(1);
    void c.close();
    await advance(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(closes(c).at(-1)).toMatchObject({ initiator: 'app', willRetry: false, closeCode: undefined });
    expect(c.connections).toHaveLength(0);
  });

  test('reconnect() while resolving: no socket existed, so no closeCode; while connecting: 1000', async () => {
    let n = 0;
    const c = h.current.makeClient(Client, {
      url: () => (++n === 1 ? new Promise<string>(() => undefined) : h.current.router.url),
      options: { timeouts: { idle: 0 } },
    });
    await advance(1);
    c.reconnect();
    expect(closes(c).at(-1)).toMatchObject({ initiator: 'app', willRetry: true, closeCode: undefined });
    h.current.router.setAvailable('hang');
    await advance(1000); // the floor: the second attempt resolves at once and hangs in CONNECTING
    expect(c.connections).toHaveLength(1);
    c.reconnect();
    expect(closes(c).at(-1)).toMatchObject({ initiator: 'app', willRetry: true, closeCode: 1000 });
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]); // release(1000)
    h.current.router.setAvailable('ok');
  });

  test('close() k times ⇒ one onClose; every promise resolves (INV-R9)', async () => {
    const c = start();
    await advance(1);
    const promises = [c.close(), c.close(), c.close()].map(tracked);
    await advance(10);
    expect(closes(c)).toHaveLength(1);
    expect(promises.every((p) => p.done)).toBe(true);
  });
});

describe('the lingering connection', () => {
  /** A router that never answers the client's GOODBYE. */
  const silentGoodbye = (x: Harness): void => {
    x.router.ignore((f) => f[0] === 6);
  };

  test.each([
    ['wamp.close.goodbye_and_out'],
    ['wamp.error.goodbye_and_out'],
    ['wamp.close.normal'],
    ['wamp.close.system_shutdown'],
  ])('a GOODBYE reply of any reason (%s) finishes it: socket closed 1000, never answered', async (reason) => {
    const c = start({}, silentGoodbye);
    await advance(1);
    const done = tracked(c.close());
    await advance(100);
    expect(done.done).toBe(false);
    raw([6, {}, reason]);
    await advance(1);
    expect(done.done).toBe(true);
    expect(written(c).filter((f) => f[0] === 6)).toEqual([[6, {}, 'wamp.close.close_realm']]); // no reply
    expect(c.connection.controls.closeCalls).toEqual([{ code: 1000, reason: 'normal closure' }]);
  });

  test('an ABORT or a socket close finishes it; other frames are ignored (never answered)', async () => {
    const c = start({}, silentGoodbye);
    await advance(1);
    const done = tracked(c.close());
    raw([50, 1, {}]);
    raw([68, 1, 2, {}]);
    h.current.router.sendRaw('{not json');
    await advance(10);
    expect(done.done).toBe(false);
    expect(written(c).at(-1)).toEqual([6, {}, 'wamp.close.close_realm']);
    raw([3, {}, 'wamp.error.x']);
    await advance(1);
    expect(done.done).toBe(true);

    const c2 = start({}, silentGoodbye);
    await advance(1);
    const done2 = tracked(c2.close());
    c2.connection.controls.drop(); // Nexus/nxt drop the reply: a close after our GOODBYE is a clean leave
    await advance(1);
    expect(done2.done).toBe(true);
  });

  test('a frozen peer: after 2 s the socket is closed and terminate()d; no client timer remains', async () => {
    const c = start({}, (x) => {
      silentGoodbye(x);
    });
    h.current.router.ignore(() => false);
    await advance(1);
    const done = tracked(c.close());
    await advance(1999);
    expect(done.done).toBe(false);
    await advance(1);
    expect(done.done).toBe(true);
    expect(c.scope.pendingTimers).toBe(0);
  });

  test('with the ws-style terminate(), a frozen peer is terminated at the GOODBYE timeout', async () => {
    const x = createHarness({ seed: 45, router: { terminate: true } });
    x.router.ignore((f) => f[0] === 6);
    const c = x.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    await x.clock.advance(1);
    c.connection.controls.freeze('drop');
    const done = tracked(c.close());
    await x.clock.advance(1999);
    expect(c.connection.controls.terminateCalls).toBe(0); // still waiting for the reply
    await x.clock.advance(1);
    expect(done.done).toBe(true);
    expect(c.connection.controls.closeCalls[0]).toEqual({ code: 1000, reason: 'normal closure' });
    expect(c.connection.controls.terminateCalls).toBe(1); // a frozen peer never answers the closing handshake
    await x.finish();
  });

  test('a lingering connection that the router answers is closed, never terminated', async () => {
    const x = createHarness({ seed: 46, router: { terminate: true } });
    const c = x.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    await x.clock.advance(1);
    const done = tracked(c.close());
    await x.clock.advance(1);
    expect(done.done).toBe(true);
    expect(c.connection.controls.terminateCalls).toBe(0);
    await x.finish();
  });

  test('the goodbye wait is an internal constant (fast profile)', async () => {
    const c = start({ [INTERNAL_OPTIONS_KEY]: { goodbye: 50 } }, silentGoodbye);
    await advance(1);
    const done = tracked(c.close());
    await advance(50);
    expect(done.done).toBe(true);
  });

  test('a GOODBYE that cannot be written finishes the lingering record at once', async () => {
    const c = start({
      serializer: {
        protocol: 'wamp.2.json',
        binary: false,
        serialize: (m) => {
          if (m[0] === 6) throw new Error('no GOODBYE for you');
          return JSON.stringify(m);
        },
        deserialize: (d) => JSON.parse(d as string) as unknown,
      },
    });
    await advance(1);
    const done = tracked(c.close());
    await advance(0);
    expect(done.done).toBe(true);
  });

  test('lingering never touches participants or lifecycle: late frames of it change nothing', async () => {
    const c = start({}, silentGoodbye);
    await advance(1);
    void c.close();
    raw([6, {}, 'wamp.close.goodbye_and_out']);
    raw([6, {}, 'wamp.close.goodbye_and_out']); // after it finished: neither lingering nor current
    await advance(1);
    expect(closes(c)).toHaveLength(1);
  });
});

describe('open() after close()', () => {
  test('in the same tick: a new connection whose first frame is HELLO; the old one lingers on its own', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start({}, (x) => {
      x.router.ignore((f, conn) => f[0] === 6 && conn.number === 1);
    });
    await advance(1);
    const old = c.client.call('com.example.p');
    const closed = tracked(c.close());
    c.open();
    const call = c.observe('call', 'p', c.client.call('com.example.p'));
    await advance(1);
    expect(c.connections).toHaveLength(1); // the attempt floor: 1 s after the previous attempt's start
    expect(call.closed).toBe(false); // it waits (the client is not stopped)
    await advance(998);
    expect(c.connections).toHaveLength(2);
    expect(written(c, 2)[0]?.[0]).toBe(1);
    expect(call.values).toHaveLength(1); // written in the new session, no ConnectionClosedError
    expect(closed.done).toBe(false); // the old connection is still waiting for its GOODBYE reply
    await advance(1001);
    expect(closed.done).toBe(true);
    expect(old).toBeDefined();
  });

  test('close() while an open() waits for the floor is as quiet as CLOSED: no second onClose, its work Closed', async () => {
    const c = start();
    await advance(5);
    void c.close();
    c.open(); // waits for the floor (the attempt started at 0)
    const waiting = c.observe('call', 'p', c.client.call('com.example.p'));
    void c.close();
    await advance(3000);
    expect(closes(c).map((i) => i.initiator)).toEqual(['app']);
    expect(states(c)).toEqual(['connecting', 'open', 'closed']);
    expect(waiting.error).toMatchObject({ code: 'connection_closed', gaveUp: false });
    expect(c.connections).toHaveLength(1);
  });

  test('open() after give-up starts again with the counter reset', async () => {
    const c = start({ retryOptions: { maxRetries: 1 } }, (x) => {
      x.router.setAvailable('refuse');
    });
    await advance(10000);
    expect(closes(c).at(-1)?.willRetry).toBe(false);
    h.current.router.setAvailable('ok');
    c.open();
    await advance(1);
    expect(c.status?.values.at(-2)).toEqual({ state: 'connecting', attempt: 1 });
    expect(states(c).at(-1)).toBe('open');
  });

  test('reconnect() from CLOSED is open()', async () => {
    const c = start({ autoOpen: false });
    c.reconnect();
    await advance(1);
    expect(states(c)).toEqual(['closed', 'connecting', 'open']);
  });

  test('after close() resolves: no client timer, no listener, no further frame on those connections (INV-R9)', async () => {
    h.current.router.procedure('com.example.slow', never);
    const c = start({ timeouts: { idle: 1000 } });
    c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(5000);
    const count = c.trace().frames.filter((f) => f.direction === 'in').length;
    const closed = tracked(c.close());
    await advance(10);
    expect(closed.done).toBe(true);
    await advance(60000);
    expect(c.scope.pendingTimers).toBe(0);
    expect(c.connection.controls.listenerCount).toBe(0);
    expect(c.trace().frames.filter((f) => f.direction === 'in').length).toBe(count + 1); // the GOODBYE
  });
});
