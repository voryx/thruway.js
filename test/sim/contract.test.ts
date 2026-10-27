// The error and reconnection contract, one describe per guarantee, each a set of end-to-end scenarios: the real
// Client with every participant plugged in, against the reference router under the virtual clock. Every run ends with
// the harness's end-of-run checks (no client timer left, no listener on a client socket, no router violation, no
// unscripted traffic, no contained internal error).
import { createRequire } from 'node:module';
import { catchError, firstValueFrom, from, lastValueFrom, map, repeat, retry, toArray } from 'rxjs';
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { Observable } from '../../src/observable/observable.js';
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  ConnectionClosedError,
  ConnectionLostError,
  isThruwayError,
  isWampError,
  ProtocolError,
  TimeoutError,
  WampError,
} from '../../src/errors.js';
import { Yield } from '../../src/yield.js';
import { createSimRouter, type SimRouter } from '../../src/testing/sim.js';
import type { ClientOptions, CloseInfo, InvocationMessage, Status, WebSocketConstructorLike } from '../../src/types.js';
import { createHarness, useHarness, type Harness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 101 });

function start(options: ClientOptions = {}, setup?: (harness: Harness) => void): SimClient<Client> {
  setup?.(h.current);
  return h.current.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
}
function written(c: SimClient<Client>, n: number): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket)
    .map((f) => f.frame as unknown[]);
}
const closes = (c: SimClient<Client>): readonly CloseInfo[] => c.onClose?.values ?? [];
const statuses = (c: SimClient<Client>): readonly Status[] => c.status?.values ?? [];
const states = (c: SimClient<Client>): string[] => statuses(c).map((s) => s.state);
const advance = (ms: number): Promise<void> => h.current.clock.advance(ms);
const never = (): Promise<never> => new Promise<never>(() => undefined);
const raw = (frame: unknown[]): void => {
  h.current.router.sendRaw(JSON.stringify(frame));
};
const isLost = (e: unknown): boolean => isThruwayError(e) && e.code === 'connection_lost';
/** Every end the app hears, with the virtual time it heard it at. */
function endsOf(c: SimClient<Client>): { at: number; info: CloseInfo }[] {
  const ends: { at: number; info: CloseInfo }[] = [];
  c.client.onClose.subscribe((info) => ends.push({ at: h.current.clock.now(), info }));
  return ends;
}
const byLiveness = (info: CloseInfo): boolean => (info.error as { timer?: unknown } | undefined)?.timer === 'liveness';
/** One router-side CALL of `procedure` per second for `ms` (the INVOCATIONs a callee keeps receiving). */
async function invokeEverySecond(router: SimRouter, procedure: string, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1000) {
    router.invoke(procedure);
    await advance(1000);
  }
}

describe('never give up', () => {
  test('a long mix of failures of every kind, then the router heals: the client is open again', async () => {
    const c = start({ timeouts: { idle: 0, connect: 500, handshake: 500 } });
    const { router } = h.current;
    await advance(10);
    const heals: (() => void)[] = [];
    const faults: (() => void)[] = [
      () => {
        router.drop();
      },
      () => {
        router.setAvailable('refuse');
      },
      () => {
        router.setAvailable('error-only');
      },
      () => {
        router.setAvailable('hang');
      },
      () => {
        router.setAvailable('throw');
      },
      () => {
        heals.push(router.ignore((f) => f[0] === 1));
      },
      () => {
        router.goodbye();
      },
      () => {
        router.abort('wamp.error.no_such_realm');
      },
      () => {
        router.sendRaw('garbage');
      },
    ];
    for (const fault of faults) {
      fault();
      await advance(3000);
      router.drop();
      await advance(3000);
    }
    router.setAvailable('ok');
    for (const heal of heals) heal();
    await advance(120000);
    expect(states(c).at(-1)).toBe('open');
    expect(closes(c).every((i) => i.willRetry)).toBe(true);
  });

  test('every end is followed by exactly one connecting before any other end (INV-R1)', async () => {
    const c = start({}, (x) => {
      x.router.setAvailable('refuse');
    });
    await advance(30000);
    h.current.router.setAvailable('ok');
    await advance(70000);
    const seq = states(c);
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] === 'closed') expect(seq[i + 1]).toBe('connecting');
    }
    expect(seq.at(-1)).toBe('open');
  });

  test('a clean close (1000) is a disconnect, never "the end"', async () => {
    const c = start();
    await advance(10);
    c.connection.controls.close(1000, 'bye');
    await advance(5000);
    expect(closes(c)[0]).toMatchObject({ initiator: 'connection', closeCode: 1000, wasClean: true, willRetry: true });
    expect(states(c).at(-1)).toBe('open');
  });

  test.each(['error-only', 'refuse'] as const)(
    'a socket that never opens (%s: error, with or without close) is exactly one end per attempt',
    async (mode) => {
      const c = start({ retryOptions: { maxRetries: 4 } }, (x) => {
        x.router.setAvailable(mode);
      });
      await h.current.clock.runUntilIdle();
      const attempts = statuses(c).filter((s) => s.state === 'connecting').length;
      expect(attempts).toBe(5);
      expect(closes(c)).toHaveLength(5);
      for (const info of closes(c)) expect(info).toMatchObject({ closeCode: 1006, wasClean: false });
    },
  );

  test('a router that ends every session within a minute backs off instead of looping', async () => {
    const c = start();
    for (let i = 0; i < 6; i++) {
      await advance(30000);
      h.current.router.goodbye('wamp.close.system_shutdown');
    }
    await advance(10);
    const attempts = closes(c).map((i) => i.attempt);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a contained internal exception reconnects too', async () => {
    const x = createHarness({ seed: 102, checks: { internalLogs: false } });
    x.router.declareTopic('com.example.t');
    const c = x.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    await x.clock.advance(10);
    (c.faults as { inject(t: string): void }).inject('topic.inbound');
    x.router.publish('com.example.t', [1]);
    await x.clock.advance(5000);
    expect(states(c).at(-1)).toBe('open');
    x.router.publish('com.example.t', [2]);
    await x.clock.advance(1);
    expect(topic.values.at(-1)?.args).toEqual([2]);
    await x.closeAndSettle();
  });
  test('a callee whose uplink dies while INVOCATIONs keep arriving is found within idle + ping and registers again', async () => {
    const { router, clock } = h.current;
    const idle = 5000;
    const ping = 20000; // the default ping budget
    const c = start({ timeouts: { idle }, retryOptions: { retryDelay: () => 500 } });
    const ends = endsOf(c);
    let n = 0;
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => ++n),
    );
    await invokeEverySecond(router, 'com.example.r', 30000); // the router answers probes; every INVOCATION is answered
    expect(ends).toEqual([]);
    const ghost = c.onOpen?.values[0]?.id;
    const answered = n;
    const frozenAt = clock.now();
    c.connection.controls.freeze('drop', 'up'); // the uplink dies: INVOCATIONs still arrive, every YIELD is lost
    await invokeEverySecond(router, 'com.example.r', idle + ping + 1000);
    expect(n).toBeGreaterThan(answered + 5); // the handler ran for INVOCATIONs that kept arriving
    expect(ends).toHaveLength(1);
    expect(ends[0]?.info).toMatchObject({ initiator: 'connection', closeCode: 4001, willRetry: true });
    expect(ends[0]?.info.error).toMatchObject({ name: 'TimeoutError', timer: 'liveness' });
    expect(ends[0]!.at - frozenAt).toBeLessThanOrEqual(idle + ping);
    // The next session re-REGISTERs while the router still holds the dead session's registration (a ghost): the
    // conflict is ridden out until the router notices its peer is gone and ends that session
    await advance(3000);
    router.kill(ghost!);
    await advance(40000);
    const session = c.client.session;
    expect(router.sessions.find((x) => x.id === session?.id)?.registrations.map((r) => r.procedure)).toEqual([
      'com.example.r',
    ]);
    expect(reg.values).toHaveLength(2); // one REGISTERED per session
    expect(reg.closed).toBe(false);
    const call = router.invoke('com.example.r');
    await advance(10);
    expect(call.result?.args).toEqual([n]);
    expect(ends).toHaveLength(1);
  });

  test('a url resolver that moves to a router that drops the probe does not loop on liveness reconnects, and half-open detection still works back on the first', async () => {
    const { router: a, clock } = h.current;
    const b = createSimRouter({ clock: clock.scope('router-b') });
    b.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping'); // B drops CALLs to an unknown procedure
    const A = a.webSocketFor(1);
    const B = b.webSocketFor(1);
    const WebSocket = function (url: string, protocols?: string | string[]) {
      return url === b.url ? new B(url, protocols) : new A(url, protocols);
    } as unknown as WebSocketConstructorLike;
    Object.defineProperty(WebSocket, 'OPEN', { value: A.OPEN });
    let target = a.url;
    const idle = 5000;
    const ping = 20000;
    const c = h.current.makeClient(Client, {
      url: () => target,
      options: { WebSocket, timeouts: { idle }, retryOptions: { retryDelay: () => 500 } },
    });
    const ends = endsOf(c);
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 'ok'),
    );
    await invokeEverySecond(a, 'com.example.r', 20000);
    const pings = (c.trace().frames as readonly { direction: string; frame: unknown }[]).filter(
      (f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[3] === 'thruway.js.ping',
    );
    expect(pings.length).toBeGreaterThanOrEqual(2); // A answers the probe: probing goes on there
    expect(ends).toEqual([]);
    // A goes away; the resolver moves to B. A callee there writes YIELDs that only a probe's answer can prove
    target = b.url;
    a.setAvailable('refuse');
    a.drop();
    await invokeEverySecond(b, 'com.example.r', 600000);
    expect(ends.filter((e) => byLiveness(e.info))).toHaveLength(1); // B's calibration: one strike, then probing is off
    expect(states(c).at(-1)).toBe('open');
    expect(c.trace().logs.filter((l) => l.entry.event === 'liveness.unsupported')).toHaveLength(1);
    // back to A: what was learned there holds, so a half-open link to A is still found
    target = a.url;
    a.setAvailable('ok');
    b.setAvailable('refuse');
    b.drop();
    await invokeEverySecond(a, 'com.example.r', 10000);
    expect(states(c).at(-1)).toBe('open');
    const before = ends.length;
    const frozenAt = clock.now();
    c.connection.controls.freeze('drop');
    await advance(idle + ping + 1000);
    expect(ends).toHaveLength(before + 1);
    expect(byLiveness(ends[before]!.info)).toBe(true);
    expect(ends[before]!.at - frozenAt).toBeLessThanOrEqual(idle + ping);
    await h.current.closeAndSettle();
    expect([b.violations, b.unscripted, b.errors]).toEqual([[], [], []]);
    for (const link of b.connections) expect(link.controls.listenerCount).toBe(0);
  });
});

describe('backoff', () => {
  test('exponential with full jitter, capped, never under 100 ms; the counter grows across failed attempts', async () => {
    const c = start(
      { retryOptions: { initialRetryDelay: 1000, retryDelayGrowth: 2, maxRetryDelay: 8000, maxRetries: 8 } },
      (x) => {
        x.router.setAvailable('refuse');
      },
    );
    await h.current.clock.runUntilIdle();
    const infos = closes(c);
    expect(infos.map((i) => i.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    infos.slice(0, -1).forEach((info, i) => {
      expect(info.delay).toBeGreaterThanOrEqual(100);
      expect(info.delay).toBeLessThanOrEqual(Math.min(8000, 1000 * 2 ** i));
    });
    expect(infos.at(-1)?.willRetry).toBe(false);
  });

  test('a socket that opens and then fails the handshake keeps backing off', async () => {
    const c = start({ timeouts: { idle: 0, handshake: 200 } }, (x) => {
      x.router.ignore((f) => f[0] === 1);
    });
    await advance(20000);
    const attempts = closes(c).map((i) => i.attempt);
    expect(attempts.length).toBeGreaterThan(3);
    expect(attempts).toEqual(attempts.map((_, i) => i + 1));
  });

  test('the custom strategy receives the attempt, the CloseInfo and the default; null gives up (recipe 9)', async () => {
    const strategy = vi.fn((n: number, info: CloseInfo, d: number) =>
      info.initiator === 'router' && info.reason === 'com.example.login.failure' ? null : n * 10 + d * 0,
    );
    const c = start({ retryOptions: { retryDelay: strategy } }, (x) => {
      x.router.setAvailable('refuse');
    });
    await advance(1000);
    expect(strategy.mock.calls[0]?.[0]).toBe(1);
    expect(strategy.mock.calls[0]?.[1]).toMatchObject({ willRetry: true, attempt: 1 });
    expect(closes(c)[0]?.delay).toBe(100); // floored
    h.current.router.setAvailable('ok');
    await advance(5000);
    raw([3, {}, 'com.example.login.failure']);
    await advance(10);
    expect(closes(c).at(-1)).toMatchObject({ willRetry: false, reason: 'com.example.login.failure' });
    expect(states(c).at(-1)).toBe('closed');
  });

  test('an onClose observer that re-opens a client that gave up cannot spin: one attempt per second', async () => {
    const c = start({ autoOpen: false, retryOptions: { maxRetries: 0 } }, (x) => {
      x.router.setAvailable('refuse'); // every attempt fails at once
    });
    c.client.onClose.subscribe((info) => {
      if (!info.willRetry && info.initiator !== 'app') c.client.open();
    });
    c.open();
    await advance(5500);
    const starts = c
      .trace()
      .logs.filter((l) => l.entry.event === 'attempt.start')
      .map((l) => l.at);
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(closes(c).every((i) => !i.willRetry)).toBe(true);
    h.current.router.setAvailable('ok');
    await advance(1000);
    expect(states(c).at(-1)).toBe('open');
  });

  test('open() cuts a backoff wait but never starts within 1 s of the previous start; reconnect() resets the counter', async () => {
    const c = start({ retryOptions: { retryDelay: () => 100000 } });
    await advance(2000);
    h.current.router.drop();
    await advance(10);
    c.open();
    c.open();
    c.open();
    await advance(10);
    expect(states(c).at(-1)).toBe('open');
    expect(c.connections).toHaveLength(2);
  });
});

describe('app streams can never break the connection', () => {
  test('unsubscribing, erroring and completing app streams never stops reconnection or affects others', async () => {
    const { router } = h.current;
    router.procedure('com.example.p', () => 1);
    router.procedure('com.example.err', () => {
      throw new WampError('com.example.nope');
    });
    router.declareTopic('com.example.t');
    const c = start();
    const keep = c.observe('topic', 't', c.client.topic('com.example.t'));
    const a = c.observe('topic', 't', c.client.topic('com.example.t'));
    c.observe('call', 'p', c.client.call('com.example.p'));
    c.observe('call', 'e', c.client.call('com.example.err'));
    c.client.status.subscribe({}).unsubscribe();
    await advance(10);
    a.unsubscribe();
    router.drop();
    await advance(5000);
    router.publish('com.example.t', ['x']);
    await advance(1);
    expect(keep.values.map((e) => e.args as unknown[])).toEqual([['x']]);
    expect(states(c).at(-1)).toBe('open');
  });

  test('every Observable is cold: RxJS retry re-issues a call after connection_lost (recipe 1)', async () => {
    let n = 0;
    h.current.router.procedure('com.example.feed', () => (++n === 1 ? never() : 'second time'));
    const c = start();
    const errors: unknown[] = [];
    const result = firstValueFrom(
      from(c.client.call('com.example.feed')).pipe(
        catchError((e: unknown) => {
          errors.push(e);
          throw e;
        }),
        retry({ count: 3 }),
      ),
    );
    await advance(10);
    h.current.router.drop();
    await advance(5000);
    await expect(result).resolves.toMatchObject({ args: ['second time'] });
    expect(errors.map(isLost)).toEqual([true]);
  });

  test('RxJS 5 (prototype-patched operators): Observable.from(call).retry() re-issues the call after connection_lost', async () => {
    interface Rx5<T> {
      retry(count: number): Rx5<T>;
      toPromise(): Promise<T>;
    }
    const { Observable: Rx5Observable } = createRequire(import.meta.url)('rxjs5/Rx.js') as {
      Observable: { from<T>(input: unknown): Rx5<T> };
    };
    let n = 0;
    h.current.router.procedure('com.example.feed', () => (++n === 1 ? never() : 'second time'));
    const c = start();
    const result = Rx5Observable.from<{ args: unknown[] }>(c.client.call('com.example.feed')).retry(3).toPromise();
    await advance(10);
    h.current.router.drop();
    await advance(5000);
    await expect(result).resolves.toMatchObject({ args: ['second time'] });
    expect(n).toBe(2);
  });

  test('for await (RxJS 9, the platform Observable): leaving the loop unsubscribes, which CANCELs the call', async () => {
    h.current.router.procedure(
      'com.example.feed',
      () =>
        new Observable<string>((s) => {
          s.next('p1'); // one progress result, never a final one
        }),
    );
    const c = start();
    await advance(5);
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const result of c.client.progressiveCall('com.example.feed')) {
        seen.push(result.args);
        break;
      }
    })();
    await advance(5);
    await loop;
    expect(seen).toEqual([['p1']]);
    const call = written(c, 1).find((f) => f[0] === 48)!;
    expect(written(c, 1).filter((f) => f[0] === 49)).toEqual([[49, call[1], { mode: 'killnowait' }]]);
  });

  test('repeat re-subscribes a completed call; a re-subscribed topic re-establishes it', async () => {
    const { router } = h.current;
    let n = 0;
    router.procedure('com.example.count', () => ++n);
    router.declareTopic('com.example.t');
    const c = start();
    const values = lastValueFrom(from(c.client.call('com.example.count')).pipe(repeat(3), toArray()));
    await advance(10);
    await expect(values).resolves.toHaveLength(3);
    const t = c.client.topic('com.example.t');
    const s1 = t.subscribe({});
    await advance(5);
    s1.unsubscribe();
    await advance(5);
    const got = firstValueFrom(from(t));
    await advance(5);
    router.publish('com.example.t', ['again']);
    await advance(5);
    await expect(got).resolves.toMatchObject({ args: ['again'] });
  });

  test('an observer (or an operator in the app chain) that throws changes nothing for anyone else', async () => {
    h.current.router.declareTopic('com.example.t');
    const c = start();
    c.client.topic('com.example.t').subscribe(() => {
      throw new Error('app bug');
    });
    const other = c.observe('topic', 't', c.client.topic('com.example.t'));
    const operatorErrors: unknown[] = [];
    from(c.client.topic('com.example.t'))
      .pipe(
        map(() => {
          throw new Error('operator bug'); // an operator of the app chain throws: RxJS errors that chain only
        }),
      )
      .subscribe({ error: (e: unknown) => operatorErrors.push(e) });
    await advance(5);
    h.current.router.publish('com.example.t', [1]);
    h.current.router.publish('com.example.t', [2]);
    await advance(5);
    expect(other.values).toHaveLength(2);
    expect(operatorErrors).toHaveLength(1);
    expect(c.trace().logs.filter((l) => l.entry.event === 'unhandled').length).toBeGreaterThanOrEqual(2);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('a bad argument errors only that subscription, synchronously; nothing is written', async () => {
    const c = start();
    await advance(5);
    const before = written(c, 1).length;
    const bad = [
      c.observe('call', 'x', c.client.call('not a uri')),
      c.observe('call', 'x', c.client.call('a.b', 'args' as unknown as unknown[])),
      c.observe('topic', 'x', c.client.topic('a..b')),
      c.observe('publish', 'x', c.client.publish('a.b', [], {}, { acknowledge: 'yes' as unknown as boolean })),
      c.observe('register', 'x', c.client.register('a.b', 'not a function' as unknown as () => 1)),
    ];
    for (const r of bad) expect(r.errored).toBe(true);
    expect(isWampError(bad[0]?.error) && bad[0].error.uri).toBe('wamp.error.invalid_uri');
    expect(bad[1]?.error).toBeInstanceOf(TypeError);
    expect(written(c, 1).length).toBe(before);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('a mistyped Crossbar-checked option fails only its own stream: nothing is written, the connection and every other stream live on', async () => {
    const x = createHarness({ seed: 105, router: { dialect: 'crossbar' } });
    x.router.procedure('com.example.p', () => 'ok');
    x.router.declareTopic('com.example.t');
    const c = x.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    await x.clock.advance(5);
    const before = written(c, 1).length;
    const bad = [
      c.observe(
        'register',
        'x',
        c.client.register('com.example.x', () => 1, { concurrency: '2' }),
      ),
      c.observe('call', 'x', c.client.call('com.example.p', [], {}, { caller: -1 })),
      c.observe('call', 'x', c.client.call('com.example.p', [], {}, { caller_authid: 7 })),
      c.observe('publish', 'x', c.client.publish('com.example.t', [], {}, { transaction_hash: 1 })),
      c.observe('topic', 'x', c.client.topic('com.example.t', { forward_for: [{ session: 1, authid: 'a' }] })),
    ];
    for (const r of bad) expect(r.error).toBeInstanceOf(TypeError);
    expect((bad[0]?.error as Error).message).toMatch(/options\.concurrency/);
    expect(written(c, 1).length).toBe(before);
    const ok = c.observe('call', 'p', c.client.call('com.example.p', [], {}, { caller_authid: 'joe' }));
    x.router.publish('com.example.t', [1]);
    await x.clock.advance(5);
    expect(ok.values[0]?.args).toEqual(['ok']);
    expect(topic.values).toHaveLength(1);
    expect([topic.closed, reg.closed]).toEqual([false, false]);
    expect(states(c)).toEqual(['connecting', 'open']);
    await x.finish();
  });

  test('an async function* handler streams progressive YIELDs and then the final one; a plain call gets its last value', async () => {
    let finished = 0;
    const c = start();
    c.observe(
      'register',
      'gen',
      c.client.register('com.example.gen', async function* (inv: InvocationMessage) {
        try {
          for (let i = 1; i <= 3; i++) {
            await Promise.resolve();
            yield (inv.args[0] as number) * i;
          }
        } finally {
          finished++;
        }
      }),
    );
    await advance(5);
    const caller = h.current.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const progressive = caller.observe('call', 'gen', caller.client.progressiveCall('com.example.gen', [10]));
    await advance(10);
    expect(progressive.values.map((r): unknown => r.args)).toEqual([[10], [20], [30]]);
    expect(progressive.completed).toBe(true);
    const plain = caller.observe('call', 'gen', caller.client.call('com.example.gen', [10]));
    await advance(10);
    expect(plain.values.map((r): unknown => r.args)).toEqual([[30]]);
    expect(plain.completed).toBe(true);
    expect(finished).toBe(2);
    const yields = written(c, 1)
      .filter((f) => f[0] === 70)
      .map((f) => f.slice(2));
    expect(yields).toEqual([
      [{ progress: true }, [10]],
      [{ progress: true }, [20]],
      [{ progress: true }, [30]],
      [{}],
      [{}, [30]],
    ]);
  });

  test('an async-generator onChallenge answers the CHALLENGE with its first value and is then closed', async () => {
    const seen: unknown[] = [];
    let pulled = 0;
    let closed = 0;
    const x = createHarness({
      seed: 104,
      router: {
        authenticate: () => ({
          challenge: { method: 'ticket', extra: { hint: 'h' } },
          verify: (signature) =>
            signature === 'secret' ? { welcome: { authid: 'joe' } } : { abort: 'wamp.error.not_authorized' },
        }),
      },
    });
    const c = x.makeClient(Client, {
      options: {
        timeouts: { idle: 0 },
        authmethods: ['ticket'],
        authid: 'joe',
        onChallenge: async function* (challenge) {
          seen.push(challenge.authMethod, challenge.extra);
          try {
            await Promise.resolve();
            pulled++;
            yield 'secret';
            pulled++;
            yield 'never read';
          } finally {
            closed++;
          }
        },
      },
    });
    await x.clock.advance(10);
    expect(states(c)).toEqual(['connecting', 'open']);
    expect(written(c, 1).filter((f) => f[0] === 5)).toEqual([[5, 'secret', {}]]);
    expect(seen).toEqual(['ticket', { hint: 'h' }]);
    expect([pulled, closed]).toEqual([1, 1]);
    await x.finish();
  });

  test('cold and lazy: an Observable never subscribed does nothing; each subscription does it once; unsubscribe undoes it', async () => {
    const { router } = h.current;
    router.procedure('com.example.echo', (args) => args[0]);
    router.declareTopic('com.example.t');
    const c = start();
    // created, never subscribed: nothing reaches the wire, in this session or the next
    void c.client.call('com.example.echo', [0]);
    void c.client.progressiveCall('com.example.echo', [0]);
    void c.client.publish('com.example.t', [0]);
    void c.client.topic('com.example.t');
    void c.client.register('com.example.r', () => 1);
    await advance(10);
    router.drop();
    await advance(5000);
    expect([...written(c, 1), ...written(c, 2)].map((f) => f[0])).toEqual([1, 1]); // the two HELLOs only
    // one Observable, subscribed twice with plain positional callbacks (Rx 4 style): two CALLs, two results
    const call = c.client.call<[number]>('com.example.echo', [7]);
    const seen: unknown[] = [];
    call.subscribe(
      (r) => seen.push(r.args),
      (e: unknown) => seen.push(e),
      () => seen.push('done'),
    );
    call.subscribe(
      (r) => seen.push(r.args),
      undefined,
      () => seen.push('done'),
    );
    await advance(5);
    expect(written(c, 2).filter((f) => f[0] === 48)).toHaveLength(2);
    expect(seen).toEqual([[7], 'done', [7], 'done']);
    // a topic: subscribe ⇒ SUBSCRIBE, unsubscribe ⇒ UNSUBSCRIBE, re-subscribe ⇒ SUBSCRIBE again (starts over)
    const topic = c.client.topic('com.example.t');
    const first = topic.subscribe({});
    await advance(5);
    first.unsubscribe();
    expect(first.closed).toBe(true);
    await advance(5);
    const second = topic.subscribe({});
    await advance(5);
    expect(
      written(c, 2)
        .filter((f) => f[0] === 32 || f[0] === 34)
        .map((f) => f[0]),
    ).toEqual([32, 34, 32]);
    second.unsubscribe();
    // a publish: one PUBLISH per subscription, none for an Observable never subscribed
    const pub = c.client.publish('com.example.t', [1]);
    pub.subscribe({});
    pub.subscribe({});
    await advance(5);
    expect(written(c, 2).filter((f) => f[0] === 16)).toHaveLength(2);
  });

  test("progressiveCall: receive_progress is always true, the app's options are copied, never mutated", async () => {
    h.current.router.procedure(
      'com.example.feed',
      () =>
        new Observable<string>((s) => {
          s.next('p1');
          s.next('p2');
          s.complete();
        }),
    );
    const c = start();
    const options = Object.freeze({ receive_progress: false, disclose_me: true, custom_key: 'kept' });
    const results = c.observe('call', 'feed', c.client.progressiveCall('com.example.feed', [1], { k: 2 }, options));
    await advance(5);
    const frame = written(c, 1).find((f) => f[0] === 48)!;
    expect(frame.slice(2)).toEqual([
      { receive_progress: true, disclose_me: true, custom_key: 'kept' },
      'com.example.feed',
      [1],
      { k: 2 },
    ]);
    expect(options).toEqual({ receive_progress: false, disclose_me: true, custom_key: 'kept' });
    // every progress result; the empty final RESULT the sim router sends on completion completes the call without a
    // value (an empty terminator is not surfaced)
    expect(results.values.map((r) => [r.args, r.details])).toEqual([
      [['p1'], { progress: true }],
      [['p2'], { progress: true }],
    ]);
    expect(results.completed).toBe(true);
    // a plain call to the same procedure asks for no progress: only the last value comes back
    const plain = c.observe('call', 'feed', c.client.call('com.example.feed'));
    await advance(5);
    expect(written(c, 1).filter((f) => f[0] === 48)[1]?.[2]).toEqual({});
    expect(plain.values.map((r) => r.args as unknown[])).toEqual([['p2']]);
  });

  test('a re-subscription within one round trip adopts the pending REGISTER: exactly one registration (StrictMode)', async () => {
    const c = start();
    await advance(5);
    const r = c.client.register('com.example.r', () => 1);
    r.subscribe({}).unsubscribe();
    const second = c.observe('register', 'r', r);
    await advance(5);
    expect(written(c, 1).filter((f) => f[0] === 64)).toHaveLength(1);
    expect(written(c, 1).filter((f) => f[0] === 66)).toHaveLength(0);
    expect(second.values).toHaveLength(1);
  });
});

describe('long-lived interests survive reconnects', () => {
  test('topics and registrations are re-established on every new session, without errors or completions', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    const c = start();
    const topic = c.observe('topic', 't', c.client.topic('com.example.t'));
    const reg = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 'v'),
    );
    for (let i = 0; i < 4; i++) {
      await advance(5000);
      router.drop();
    }
    await advance(5000);
    expect(topic.closed || reg.closed).toBe(false);
    expect(reg.values).toHaveLength(5); // a RegisteredMessage per session
    for (let n = 1; n <= 5; n++) {
      expect(written(c, n).filter((f) => f[0] === 32)).toHaveLength(1);
      expect(written(c, n).filter((f) => f[0] === 64)).toHaveLength(1);
    }
    router.publish('com.example.t', ['still here']);
    await advance(1);
    expect(topic.values.at(-1)?.args).toEqual(['still here']);
  });

  test('a router rejection surfaces as a WampError on that stream only', async () => {
    const c = start({}, (x) => {
      x.router.declareTopic('com.example.ok');
      x.router.ignore((f) => {
        if (f[0] !== 32 || f[3] !== 'com.example.secret') return false;
        queueMicrotask(() => {
          x.router.sendRaw(JSON.stringify([8, 32, f[1], {}, 'wamp.error.not_authorized']));
        });
        return true;
      });
    });
    const secret = c.observe('topic', 's', c.client.topic('com.example.secret'));
    const ok = c.observe('topic', 'o', c.client.topic('com.example.ok'));
    await advance(5);
    expect(secret.error).toMatchObject({
      code: 'wamp_error',
      uri: 'wamp.error.not_authorized',
      topic: 'com.example.secret',
    });
    expect(ok.closed).toBe(false);
    expect(states(c)).toEqual(['connecting', 'open']);
  });

  test('revocation surfaces on that stream only (UNSUBSCRIBED/UNREGISTERED with a reason)', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    router.declareTopic('com.example.u');
    const c = start();
    const t = c.observe('topic', 't', c.client.topic('com.example.t'));
    const u = c.observe('topic', 'u', c.client.topic('com.example.u'));
    const r = c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => 1),
    );
    await advance(5);
    router.revokeSubscription('com.example.t', 'moderated');
    router.revokeRegistration('com.example.r', 'replaced');
    await advance(5);
    expect(t.error).toMatchObject({ uri: 'thruway.error.subscription_revoked', args: ['moderated'] });
    expect(r.error).toMatchObject({ uri: 'thruway.error.registration_revoked', args: ['replaced'] });
    expect(u.closed).toBe(false);
  });

  test('only close() (or give-up) ends interests, with ConnectionClosedError', async () => {
    h.current.router.declareTopic('com.example.t');
    const c = start();
    const t = c.observe('topic', 't', c.client.topic('com.example.t'));
    await advance(5);
    h.current.router.drop();
    await advance(5000);
    expect(t.closed).toBe(false);
    void c.close();
    await advance(5);
    expect(t.error).toBeInstanceOf(ConnectionClosedError);
  });

  test('a SUBSCRIBE the router never answers (Thruway wildcard) times out only after liveness proved the router alive', async () => {
    h.current.router.declareTopic('com.example');
    const c = start({ timeouts: { idle: 1000, request: 3000 } }, (x) => {
      x.router.ignore((f) => f[0] === 32);
    });
    const t = c.observe('topic', 'w', c.client.topic('com.example', { match: 'wildcard' }));
    await advance(3100);
    expect(t.error).toBeInstanceOf(TimeoutError);
    expect(t.error).toMatchObject({ timer: 'request', topic: 'com.example' });
    expect(states(c)).toEqual(['connecting', 'open']);
  });
});

describe('one-shot ops never hang, never leak into the wrong session', () => {
  test('a call in flight when its session ends errors ConnectionLostError (retryable), after onClose', async () => {
    h.current.router.procedure('com.example.slow', never);
    const order: string[] = [];
    const c = start();
    c.client.call('com.example.slow').subscribe({ error: (e: unknown) => order.push(isLost(e) ? 'lost' : 'other') });
    c.client.onClose.subscribe(() => order.push('onClose'));
    await advance(5);
    h.current.router.drop();
    await advance(1);
    expect(order).toEqual(['onClose', 'lost']);
  });

  test('work started without a session waits for WELCOME, is never written into a handshake, and is written once', async () => {
    const x = createHarness({
      seed: 103,
      router: {
        authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'joe' } }) }),
      },
    });
    x.router.procedure('com.example.p', () => 'ok');
    const d = x.makeClient(Client, {
      options: { timeouts: { idle: 0 }, authmethods: ['ticket'], onChallenge: () => 'secret' },
    });
    const call = d.observe('call', 'p', d.client.call('com.example.p'));
    await x.clock.advance(10);
    const frames = written(d, 1).map((f) => f[0]);
    expect(frames.indexOf(48)).toBeGreaterThan(frames.indexOf(5)); // after AUTHENTICATE and WELCOME
    expect(frames.filter((t) => t === 48)).toHaveLength(1);
    expect(call.values[0]?.args).toEqual(['ok']);
    await x.finish();
  });

  test('waiting is bounded by the app (Rx timeout() unsubscribes): the expired call leaves the queue unsent (recipe 2)', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start({ autoOpen: false });
    const waiting = c.client.call('com.example.p').subscribe({});
    expect((c.debug() as { queued: number }).queued).toBe(1);
    await advance(5000);
    waiting.unsubscribe(); // what timeout() does at expiry
    expect((c.debug() as { queued: number }).queued).toBe(0);
    c.open();
    await advance(5);
    expect(written(c, 1).filter((f) => f[0] === 48)).toHaveLength(0);
  });

  test('close() fails everything pending with ConnectionClosedError; in flight at a give-up ⇒ Closed{gaveUp, cause: Lost}', async () => {
    const { router } = h.current;
    router.procedure('com.example.slow', never);
    const c = start({ retryOptions: { maxRetries: 0 } });
    const inflight = c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(5);
    router.drop();
    await advance(5);
    expect(inflight.error).toMatchObject({ code: 'connection_closed', gaveUp: true });
    expect((inflight.error as ConnectionClosedError).cause).toBeInstanceOf(ConnectionLostError);
    const later = c.observe('call', 's', c.client.call('com.example.slow'));
    expect(later.error).toMatchObject({ code: 'connection_closed', gaveUp: true }); // stopped: at once
  });

  test('never into a dead socket: a write refused by a closing socket goes out once in the next session', async () => {
    h.current.router.procedure('com.example.p', () => 'ok');
    const c = start();
    await advance(5);
    c.connection.controls.closingWindow(300);
    await advance(1);
    const call = c.observe('call', 'p', c.client.call('com.example.p'));
    await advance(5000);
    const calls = c.connections.map((_, i) => written(c, i + 1).filter((f) => f[0] === 48).length);
    expect(calls).toEqual([0, 1]);
    expect(call.values).toHaveLength(1);
  });
});

describe('typed errors', () => {
  test('every error the client raises is branded, with a stable name and code and its context', async () => {
    const { router } = h.current;
    router.procedure('com.example.fail', () => {
      throw new WampError('com.example.bad', ['why'], { k: 1 });
    });
    router.procedure('com.example.slow', never);
    const c = start({ timeouts: { idle: 0 }, retryOptions: { maxRetries: 0 } });
    const fail = c.observe('call', 'f', c.client.call('com.example.fail'));
    const slow = c.observe('call', 's', c.client.call('com.example.slow'));
    await advance(5);
    expect(fail.error).toMatchObject({
      name: 'WampError',
      code: 'wamp_error',
      uri: 'com.example.bad',
      errorUri: 'com.example.bad',
      message: 'com.example.bad',
      args: ['why'],
      kwargs: { k: 1 },
      procedure: 'com.example.fail',
      sessionId: 1,
    });
    expect(typeof (fail.error as WampError).requestId).toBe('number');
    router.drop(1006);
    await advance(5);
    expect(slow.error).toMatchObject({
      name: 'ConnectionClosedError',
      code: 'connection_closed',
      procedure: 'com.example.slow',
    });
    for (const info of closes(c)) {
      expect(isThruwayError(info.error)).toBe(true);
      expect((info.error as { attempt?: number }).attempt).toBe(info.attempt);
    }
  });

  test.each([
    ['ConnectionLostError', new ConnectionLostError({ reason: 'r', closeCode: 1006 }), 'connection_lost'],
    ['ConnectionClosedError', new ConnectionClosedError({ gaveUp: true }), 'connection_closed'],
    ['TimeoutError', new TimeoutError({ timer: 'connect', timeout: 1 }), 'timeout'],
    ['AbortError', new AbortError({ reason: 'x' }), 'abort'],
    ['ProtocolError', new ProtocolError({ message: 'm' }), 'protocol'],
    ['CanceledError', new CanceledError(), 'canceled'],
    ['AuthenticationError', new AuthenticationError({ message: 'm' }), 'authentication'],
    ['WampError', new WampError('a.b'), 'wamp_error'],
  ])('%s: name, code, brand', (name, error, code) => {
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(isThruwayError(error)).toBe(true);
  });

  test('connection-level errors in CloseInfo: TimeoutError{connect/handshake/liveness}, AbortError, AuthenticationError', async () => {
    const x = createHarness({
      seed: 104,
      router: { authenticate: () => ({ abort: 'thruway.error.authentication_failure' }) },
    });
    const c = x.makeClient(Client, { options: { timeouts: { idle: 0 }, retryOptions: { maxRetries: 0 } } });
    await x.clock.advance(5);
    expect(closes(c)[0]?.error).toBeInstanceOf(AbortError);
    expect(closes(c)[0]?.error).toMatchObject({ reason: 'thruway.error.authentication_failure', attempt: 1 });
    await x.finish();
  });

  test('an invocation signal is aborted with CanceledError when the caller cancels (INTERRUPT)', async () => {
    let signal: AbortSignal | undefined;
    const c = start();
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', (inv: InvocationMessage) => {
        signal = inv.signal as AbortSignal;
        return never();
      }),
    );
    await advance(5);
    const caller = h.current.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const sub = caller.client.call('com.example.r').subscribe({});
    await advance(5);
    sub.unsubscribe(); // CANCEL killnowait ⇒ INTERRUPT
    await advance(5);
    expect(signal?.reason).toBeInstanceOf(CanceledError);
  });
});

describe('observability', () => {
  test('status replays the current value to every subscriber, at any time; it never errors or completes', async () => {
    const c = start();
    await advance(5);
    const late: Status[] = [];
    c.client.status.subscribe((s) => late.push(s));
    expect(late.map((s) => s.state)).toEqual(['open']);
    h.current.router.drop();
    await advance(5000);
    expect(late.map((s) => s.state)).toEqual(['open', 'closed', 'connecting', 'open']);
    void c.close();
    await advance(5);
    expect(late.at(-1)).toMatchObject({ state: 'closed', closed: { initiator: 'app' } });
  });

  test('onOpen replays the current session; onClose is not replayed; the session getter is never an ended session', async () => {
    const c = start();
    await advance(5);
    const opened: number[] = [];
    c.client.onOpen.subscribe((s) => opened.push(s.id));
    expect(opened).toEqual([1]);
    const closed: CloseInfo[] = [];
    c.client.onClose.subscribe((i) => closed.push(i));
    expect(closed).toEqual([]);
    h.current.router.drop();
    await advance(1);
    expect(c.client.session).toBeUndefined();
    const lateOpen: number[] = [];
    c.client.onOpen.subscribe((s) => lateOpen.push(s.id));
    expect(lateOpen).toEqual([]); // no replay of an ended session
    await advance(5000);
    expect(opened).toHaveLength(2);
  });

  test('onOpen emits on subscribe iff open (INV-R7): nothing after close(), nothing after a reconnect() until WELCOME', async () => {
    const c = start();
    await advance(5);
    const replayed = (): number[] => {
      const ids: number[] = [];
      c.client.onOpen.subscribe((s) => ids.push(s.id)).unsubscribe();
      return ids;
    };
    expect(replayed()).toEqual([1]);
    c.reconnect();
    expect(replayed()).toEqual([]); // the session ended in that step, the next one has not begun
    await advance(1000); // the next attempt starts 1 s after the previous one started (the floor)
    expect(replayed()).toEqual([2]);
    void c.close();
    expect(c.client.session).toBeUndefined();
    expect(replayed()).toEqual([]);
    await advance(2500);
    expect(replayed()).toEqual([]);
  });

  test('every observer hears status before onOpen at a WELCOME, and status before onClose at an end', async () => {
    const order: string[] = [];
    const c = start();
    c.client.status.subscribe((s) => order.push(`status ${s.state}`));
    c.client.onOpen.subscribe(() => order.push('onOpen'));
    c.client.onClose.subscribe(() => order.push('onClose'));
    await advance(5);
    h.current.router.drop();
    await advance(5000);
    expect(order).toEqual([
      'status connecting',
      'status open',
      'onOpen',
      'status closed',
      'onClose',
      'status connecting',
      'status open',
      'onOpen',
    ]);
  });

  test('the session getter is never an ended session, not even inside the app retryDelay of that end', async () => {
    const app: { client?: Client } = {};
    const seen: unknown[] = [];
    const c = start({
      retryOptions: {
        retryDelay: () => {
          seen.push(app.client?.session);
          return 100;
        },
      },
    });
    app.client = c.client;
    await advance(5);
    expect(c.client.session).toBeDefined();
    c.connection.controls.drop();
    await advance(1);
    expect(seen).toEqual([undefined]);
    expect(c.client.session).toBeUndefined();
  });

  test('CloseInfo says who ended it, why, whether and when the client retries, and which attempt it was', async () => {
    const c = start();
    await advance(5);
    raw([3, { message: 'maintenance' }, 'wamp.close.system_shutdown']);
    await advance(1);
    expect(closes(c)[0]).toEqual(
      expect.objectContaining({
        initiator: 'router',
        reason: 'wamp.close.system_shutdown',
        details: { message: 'maintenance' },
        sessionId: 1,
        willRetry: true,
        attempt: 1,
      }),
    );
    expect(closes(c)[0]?.delay).toBeGreaterThanOrEqual(100);
  });

  test('lifecycle subscriptions are safe to make repeatedly and to drop; status of a never-opened client', () => {
    const c = start({ autoOpen: false });
    for (let i = 0; i < 5; i++) c.client.status.subscribe({}).unsubscribe();
    expect(c.client.status).toBe(c.client.status);
    expect(c.client.onOpen).toBe(c.client.onOpen);
    expect(c.client.onClose).toBe(c.client.onClose);
    expect(statuses(c)).toEqual([{ state: 'closed', closed: undefined }]);
  });
});

describe('isolation', () => {
  test('a callee handler that throws sends ERROR runtime_error; a WampError its uri; the registration stays', async () => {
    const c = start();
    let n = 0;
    c.observe(
      'register',
      'r',
      c.client.register('com.example.r', () => {
        n++;
        if (n === 1) throw new Error('kaput');
        if (n === 2) throw new WampError('com.example.denied', ['no']);
        return new Yield(['fine']);
      }),
    );
    await advance(5);
    const caller = h.current.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const a = caller.observe('call', 'r', caller.client.call('com.example.r'));
    const b = caller.observe('call', 'r', caller.client.call('com.example.r'));
    const d = caller.observe('call', 'r', caller.client.call('com.example.r'));
    await advance(10);
    expect(a.error).toMatchObject({ uri: 'wamp.error.runtime_error', args: ['kaput'] });
    expect(b.error).toMatchObject({ uri: 'com.example.denied', args: ['no'] });
    expect(d.values[0]?.args).toEqual(['fine']);
  });

  test('an observer that throws never affects other observers, other streams or the session', async () => {
    const c = start();
    c.client.status.subscribe(() => {
      throw new Error('status observer bug');
    });
    c.client.onClose.subscribe(() => {
      throw new Error('onClose observer bug');
    });
    const fine = c.observe('status', undefined, c.client.status);
    await advance(5);
    h.current.router.drop();
    await advance(5000);
    expect(fine.values.map((s) => s.state)).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  test('a logger that throws loses that entry and nothing else', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const c = start({
        logger: () => {
          throw new Error('logger');
        },
      });
      await advance(5);
      h.current.router.drop();
      await advance(5000);
      expect(states(c).at(-1)).toBe('open');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('close() / open()', () => {
  test('close() is idempotent, sends GOODBYE when a session exists, waits for the reply (≤ 2 s), clears every timer', async () => {
    const c = start({ timeouts: { idle: 1000 } }, (x) => {
      x.router.ignore((f) => f[0] === 6);
    });
    await advance(1500);
    let resolved = 0;
    for (let i = 0; i < 3; i++) {
      void c.close().then(() => {
        resolved++;
      });
    }
    await advance(1999);
    expect(resolved).toBe(0);
    await advance(1);
    expect(resolved).toBe(3);
    expect(closes(c)).toHaveLength(1);
    expect(written(c, 1).filter((f) => f[0] === 6)).toEqual([[6, {}, 'wamp.close.close_realm']]);
    expect(c.scope.pendingTimers).toBe(0);
  });

  test('open() after close() works, in any timing', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    await advance(5);
    void c.close();
    c.open(); // within 1 s of the last attempt's start: the attempt floor applies, then the new session
    const call = c.observe('call', 'p', c.client.call('com.example.p'));
    await advance(1000);
    expect(call.values).toHaveLength(1);
    void c.close();
    await advance(1000);
    c.open();
    await advance(5);
    expect(states(c).at(-1)).toBe('open');
  });

  test('close() while connecting or waiting resolves at once and leaves nothing armed', async () => {
    const c = start({}, (x) => {
      x.router.setAvailable('hang');
    });
    await advance(5);
    let done = false;
    void c.close().then(() => {
      done = true;
    });
    await advance(0);
    expect(done).toBe(true);
    expect(c.scope.pendingTimers).toBe(0);
  });
});

describe('no leaks', () => {
  test('late events of released sockets never change status, write frames or reach ops', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    await advance(5);
    h.current.router.drop();
    await advance(5000);
    const statusCount = statuses(c).length;
    const old = c.connections[0]!.controls;
    old.emitLate('open');
    old.emitLate('message');
    old.emitLate('close');
    old.emitLate('error');
    await advance(5);
    expect(statuses(c)).toHaveLength(statusCount);
    expect(old.listenerCount).toBe(0);
  });

  test('the debug probe: queues drained, nothing held for ended connections, the registry is the live subscriptions', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    router.procedure('com.example.p', () => 1);
    const c = start();
    const t = c.observe('topic', 't', c.client.topic('com.example.t'));
    for (let i = 0; i < 20; i++) c.observe('call', 'p', c.client.call('com.example.p'));
    await advance(5);
    router.drop();
    await advance(5000);
    const debug = c.debug() as {
      inputs: number;
      deliveries: number;
      registry: number;
      queued: number;
      lingering: number;
      participants: { topic: Record<string, number>; call: { inFlight: number } };
    };
    expect(debug).toMatchObject({ inputs: 0, deliveries: 0, registry: 1, queued: 0, lingering: 0 });
    expect(debug.participants.call.inFlight).toBe(0);
    expect(debug.participants.topic).toMatchObject({ keys: 1, locals: 1, late: 0, deferred: 0 });
    t.unsubscribe();
    await advance(5);
    expect((c.debug() as { registry: number }).registry).toBe(0);
  });

  test('a thousand subscribe/unsubscribe cycles leave nothing behind', async () => {
    h.current.router.declareTopic('com.example.t');
    h.current.router.procedure('com.example.never', never);
    const c = start();
    await advance(5);
    for (let i = 0; i < 1000; i++) {
      c.client.topic('com.example.t').subscribe({}).unsubscribe();
      c.client.call('com.example.never').subscribe({}).unsubscribe();
    }
    await advance(100);
    const debug = c.debug() as { registry: number; queued: number; participants: { topic: Record<string, number> } };
    expect(debug.registry).toBe(0);
    expect(debug.queued).toBe(0);
    expect(debug.participants.topic['keys']).toBe(0);
  });
});
