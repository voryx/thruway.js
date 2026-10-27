// Re-entrancy: the reference router with 'sync' delivery — a client write is processed by the router inside send(), and
// the router's answer reaches the client inside that same call — so every router answer re-enters the client's loop;
// app callbacks re-enter the API from inside notifications. Each scenario runs with 'sync' delivery and, as the
// control, with the virtual clock's ordinary delivery; it ends with the harness's end-of-run checks (no router
// violation, no timer or listener left, no contained internal error) and every INV-* checker.
// Among the scenarios: an echoing GOODBYE and a reply whose send throws, close() inside onClose and status, a settled
// call and a re-entrant close(), subscribing and calling from inside callbacks of a synchronous transport.
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import type { CloseInfo, Status } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { checkInvariants, formatViolations, type OpInfo } from '../helpers/invariants.js';

type Delivery = 'sync' | 'clock';
const DELIVERIES: readonly Delivery[] = ['sync', 'clock'];

interface Env {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly ops: Map<number, OpInfo>;
}

function env(delivery: Delivery, options: { autoOpen?: boolean; throwOnSend?: (data: string) => boolean } = {}): Env {
  const h = createHarness({ seed: 9, router: { delivery }, checks: { unscripted: false } });
  h.router.declareTopic('re.t');
  h.router.procedure('re.p', () => 'pong');
  h.router.procedure('re.slow', () => new Promise(() => undefined));
  const throwOnSend = options.throwOnSend;
  const WebSocket =
    throwOnSend === undefined
      ? undefined
      : new Proxy(h.router.webSocketFor(1), {
          construct(target, args: [string, string[]]) {
            const socket = new target(...args) as unknown as { send(data: string): void };
            const send = socket.send.bind(socket);
            socket.send = (data: string) => {
              if (throwOnSend(data)) throw new Error('re: send failed');
              send(data);
            };
            return socket;
          },
        });
  const c = h.makeClient(Client, {
    options: {
      timeouts: { idle: 0 },
      ...(options.autoOpen === false ? { autoOpen: false } : {}),
      ...(WebSocket === undefined ? {} : { WebSocket }),
    },
  });
  return { h, c, ops: new Map() };
}

const states = (c: SimClient<Client>): string[] => (c.status?.values ?? []).map((s: Status) => s.state);
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const writtenTypes = (c: SimClient<Client>, n?: number): unknown[] => {
  const socket = n === undefined ? undefined : c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && (socket === undefined || f.connection === socket))
    .map((f) => (f.frame as unknown[])[0]);
};

async function finish(e: Env): Promise<void> {
  await e.h.finish();
  const trace = e.c.trace();
  const found = checkInvariants(trace, { ops: e.ops, timings: { idle: 0 }, final: true });
  expect(found, formatViolations(found, trace)).toEqual([]);
}

describe.each(DELIVERIES)('re-entrancy (%s delivery)', (delivery) => {
  test('an echoing router GOODBYE: one reply, one end with the router’s reason, one reconnect', async () => {
    const e = env(delivery);
    const { h, c } = e;
    await h.clock.advance(10);
    const call = c.observe('call', 're.slow', c.client.call('re.slow'));
    await h.clock.advance(0);
    h.router.kill(h.router.sessions[0]!.id, 'wamp.close.killed');
    await h.clock.advance(5000);
    expect(writtenTypes(c, 1).filter((t) => t === 6)).toHaveLength(1);
    expect(closes(c).map((i) => [i.initiator, i.reason])).toEqual([['router', 'wamp.close.killed']]);
    expect(c.connections).toHaveLength(2);
    expect(states(c).at(-1)).toBe('open');
    expect(call.errored).toBe(true);
    await finish(e);
  });

  test('the GOODBYE reply’s send throws: the app still hears the router’s reason once, then one reconnect', async () => {
    const e = env(delivery, { throwOnSend: (data) => data.startsWith('[6,') });
    const { h, c } = e;
    await h.clock.advance(10);
    h.router.kill(h.router.sessions[0]!.id, 'wamp.close.killed');
    await h.clock.advance(5000);
    expect(closes(c).map((i) => [i.initiator, i.reason])).toEqual([['router', 'wamp.close.killed']]);
    expect(c.connections).toHaveLength(2);
    expect(states(c).at(-1)).toBe('open');
    await finish(e);
  });

  test('close() inside onClose of a router GOODBYE: the client stops, no reconnect, close() resolves', async () => {
    const e = env(delivery);
    const { h, c } = e;
    let closed: Promise<void> | undefined;
    c.client.onClose.subscribe(() => {
      closed ??= c.close();
    });
    await h.clock.advance(10);
    h.router.kill(h.router.sessions[0]!.id);
    await h.clock.advance(10000);
    expect(closed).toBeDefined();
    await closed;
    expect(c.connections).toHaveLength(1);
    expect(states(c).at(-1)).toBe('closed');
    await finish(e);
  });

  test('close() inside onClose of a drop: no retry fires', async () => {
    const e = env(delivery);
    const { h, c } = e;
    c.client.onClose.subscribe(() => {
      void c.close();
    });
    await h.clock.advance(10);
    c.connection.controls.drop();
    await h.clock.advance(10000);
    expect(c.connections).toHaveLength(1);
    expect(states(c).at(-1)).toBe('closed');
    await finish(e);
  });

  test('close() three times from onClose and status: one onClose, no re-entrant re-emission', async () => {
    const e = env(delivery);
    const { h, c } = e;
    const heard: CloseInfo[] = [];
    c.client.onClose.subscribe((info) => {
      heard.push(info);
      void c.close();
      void c.close();
    });
    c.client.status.subscribe((s) => {
      if (s.state === 'closed') void c.close();
    });
    await h.clock.advance(10);
    await Promise.all([c.close(), h.clock.advance(5000)]);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.initiator).toBe('app');
    const seen = states(c);
    expect(seen.filter((s, i) => s === seen[i - 1])).toEqual([]); // no state twice in a row
    await finish(e);
  });

  test('close() from the result of a call: no CANCEL for the settled call, its result delivered once', async () => {
    const e = env(delivery);
    const { h, c } = e;
    await h.clock.advance(10);
    const values: unknown[] = [];
    let completions = 0;
    c.client.call('re.p').subscribe({
      next: (v) => {
        values.push(v);
        void c.close();
      },
      complete: () => completions++,
    });
    await h.clock.advance(5000);
    expect(values).toHaveLength(1);
    expect(completions).toBe(1);
    expect(writtenTypes(c).filter((t) => t === 49)).toEqual([]);
    expect(states(c).at(-1)).toBe('closed');
    await finish(e);
  });

  test('a RESULT observer that unsubscribes a sibling call and closes: one CANCEL, then GOODBYE, nothing after', async () => {
    const e = env(delivery);
    const { h, c } = e;
    await h.clock.advance(10);
    const slow = c.client.call('re.slow').subscribe({ error: () => undefined });
    c.client.call('re.p').subscribe(() => {
      slow.unsubscribe();
      void c.close();
    });
    await h.clock.advance(5000);
    expect(writtenTypes(c).slice(-2)).toEqual([49, 6]);
    await finish(e);
  });

  test('subscribing, calling and registering from inside callbacks of a synchronous transport', async () => {
    const e = env(delivery);
    const { h, c, ops } = e;
    const events: unknown[] = [];
    const results: unknown[] = [];
    let opened = 0;
    c.client.onOpen.subscribe(() => {
      if (opened++ > 0) return;
      // inside onOpen: a topic, whose first event publishes and unsubscribes itself, and a call whose result registers
      const topic = c.client.topic('re.t').subscribe((ev) => {
        events.push(ev.args);
        c.client.publish('re.t', ['from an event']).subscribe();
        topic.unsubscribe();
      });
      c.client.call('re.p').subscribe((r) => {
        results.push(r.args);
        const reg = c.observe(
          'register',
          're.r',
          c.client.register('re.r', () => 'from a callee'),
        );
        ops.set(reg.id, { kind: 'register' });
      });
    });
    await h.clock.advance(10);
    h.router.publish('re.t', ['e1']);
    await h.clock.advance(10);
    expect(events).toEqual([['e1']]);
    expect(results).toEqual([['pong']]);
    const answer = h.router.invoke('re.r');
    await h.clock.advance(10);
    expect(answer.result?.args).toEqual(['from a callee']);
    expect(writtenTypes(c).filter((t) => t === 34)).toHaveLength(1); // the topic left once
    await finish(e);
  });

  test('an error handler that re-subscribes after a drop: written once, in the next session', async () => {
    const e = env(delivery);
    const { h, c } = e;
    await h.clock.advance(10);
    let attempts = 0;
    const values: unknown[] = [];
    const go = (): void => {
      attempts++;
      c.client.call(attempts === 1 ? 're.slow' : 're.p').subscribe({
        next: (v) => values.push(v),
        error: () => {
          go();
        },
      });
    };
    go();
    await h.clock.advance(5);
    c.connection.controls.drop();
    await h.clock.advance(5000);
    expect(attempts).toBe(2);
    expect(values).toHaveLength(1);
    expect(writtenTypes(c, 2).filter((t) => t === 48)).toHaveLength(1);
    await finish(e);
  });

  test('status observers that reconnect() on every open (three times), then stay', async () => {
    const e = env(delivery);
    const { h, c } = e;
    let n = 0;
    c.client.status.subscribe((s) => {
      if (s.state === 'open' && n++ < 3) c.reconnect();
    });
    await h.clock.advance(10000);
    expect(states(c).at(-1)).toBe('open');
    expect(c.connections).toHaveLength(4);
    await finish(e);
  });

  test('close() on connecting, then open() later: a fresh session', async () => {
    const e = env(delivery, { autoOpen: false });
    const { h, c } = e;
    let once = true;
    c.client.status.subscribe((s) => {
      if (s.state === 'connecting' && once) {
        once = false;
        void c.close();
      }
    });
    c.open();
    await h.clock.advance(10);
    // with 'sync' delivery the session is open before the status observer hears 'connecting'
    expect(states(c)).toEqual(
      delivery === 'sync' ? ['closed', 'connecting', 'open', 'closed'] : ['closed', 'connecting', 'closed'],
    );
    expect(c.connections).toHaveLength(1);
    c.open();
    await h.clock.advance(2000);
    expect(states(c).at(-1)).toBe('open');
    await finish(e);
  });

  test('onOpen: close() and open() synchronously, then calls work', async () => {
    const e = env(delivery);
    const { h, c } = e;
    let once = true;
    c.client.onOpen.subscribe(() => {
      if (!once) return;
      once = false;
      void c.close();
      c.open();
    });
    const call = c.observe('call', 're.p', c.client.call('re.p'));
    await h.clock.advance(3000);
    expect(states(c).at(-1)).toBe('open');
    expect(call.closed).toBe(true);
    const again = c.observe('call', 're.p', c.client.call('re.p'));
    await h.clock.advance(5);
    expect(again.values).toHaveLength(1);
    await finish(e);
  });

  test('a callee handler that calls close() and answers: nothing after the GOODBYE', async () => {
    const e = env(delivery);
    const { h, c, ops } = e;
    const caller = h.makeClient(Client, { scope: 'client-2', options: { timeouts: { idle: 0 } } });
    const reg = c.observe(
      'register',
      're.r',
      c.client.register('re.r', () => {
        void c.close();
        return 'late';
      }),
    );
    ops.set(reg.id, { kind: 'register' });
    await h.clock.advance(10);
    const call = caller.observe('call', 're.r', caller.client.call('re.r'));
    await h.clock.advance(3000);
    expect(call.closed).toBe(true);
    const types = writtenTypes(c);
    expect(types.slice(types.indexOf(6) + 1)).toEqual([]);
    await finish(e);
  });
});
