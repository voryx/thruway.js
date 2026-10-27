// The client in real browsers (chromium + webkit, firefox best effort) with the browser's own WebSocket, against every
// target of this run — the reference server and, with BROWSER_ROUTER, Thruway PHP (and Crossbar on demand) — each test
// through its own fault proxy (commands.ts): handshake, call/register/topic; a server-side drop ⇒ reconnect with the
// interests re-established; a frozen link ⇒ the liveness probe ends the session and the client reconnects; a closing
// window ⇒ calls started while the socket is CLOSING (Chromium; WebKit has no such window) are written after the next
// WELCOME and none fails; close() ⇒ no timer left; the binary convention. Then the connect failures (DNS, TLS to a
// plain port, an untrusted certificate, a refused port): each gives exactly one onClose (ConnectionLostError, 1006,
// willRetry) per attempt and one next status{connecting}.
import { afterEach, describe, expect, inject, test } from 'vitest';
import { commands } from 'vitest/browser';
import {
  Client,
  isThruwayError,
  jsonSerializer,
  type ClientOptions,
  type CloseInfo,
  type Observable,
  type Status,
} from '../../src/index.js';

const INTERNAL = Symbol.for('thruway.js.internal');
const targets = inject('browserTargets');
const failures = inject('browserFailures');

/** The fast profile: short backoff and timeouts, a 1 s liveness budget (the internal test knob). */
function fast(options: ClientOptions = {}): ClientOptions {
  return {
    retryOptions: { initialRetryDelay: 100, maxRetryDelay: 300 },
    ...options,
    timeouts: { connect: 8000, handshake: 8000, request: 8000, idle: 30000, ...options.timeouts },
    [INTERNAL]: { ping: 1000, attemptFloor: 0, goodbye: 500 },
  } as ClientOptions;
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function first<T>(observable: Observable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sub = observable.subscribe({
      next: (value) => {
        resolve(value);
        queueMicrotask(() => {
          sub.unsubscribe();
        });
      },
      error: reject,
    });
  });
}

/** A URI namespace no other test, browser or run shares (Thruway: lowercase letters, digits, dots). */
function namespace(): string {
  return `com.browser.t${Math.random().toString(36).slice(2, 10)}`;
}

interface Watched {
  readonly client: Client;
  readonly statuses: Status[];
  readonly closes: CloseInfo[];
  readonly opens: number[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function watch(url: string, realm: string, options: ClientOptions = {}): Watched {
  const client = new Client(url, realm, fast(options));
  const watched: Watched = { client, statuses: [], closes: [], opens: [] };
  client.status.subscribe((s) => watched.statuses.push(s));
  client.onClose.subscribe((c) => watched.closes.push(c));
  client.onOpen.subscribe((s) => watched.opens.push(s.id));
  cleanups.push(() => client.close());
  return watched;
}

async function proxied(target: string): Promise<{ id: number; url: string }> {
  const proxy = await commands.proxy(target);
  cleanups.push(() => commands.closeProxy(proxy.id));
  return proxy;
}

/** Register `<ns>.double` and subscribe `<ns>.topic`; resolves once registered. */
async function interests(client: Client, ns: string, events: unknown[], registered: number[]): Promise<void> {
  client.topic(`${ns}.topic`).subscribe({ next: (e) => events.push(e.args[0]), error: () => undefined });
  await new Promise<void>((resolve, reject) => {
    client
      .register(`${ns}.double`, (inv) => Number(inv.args[0]) * 2)
      .subscribe({
        next: (r) => {
          registered.push(r.registrationId);
          resolve();
        },
        error: reject,
      });
  });
}

/** Publish (acknowledged, to ourselves) until the event arrives: the SUBSCRIBE may still be on its way. */
async function publishUntilSeen(client: Client, ns: string, events: unknown[], value: string): Promise<void> {
  const before = events.length;
  for (let i = 0; i < 20 && events.length === before; i++) {
    await first(client.publish(`${ns}.topic`, [value], {}, { acknowledge: true, exclude_me: false }));
    await until(() => events.length > before, 'an event', 300).catch(() => undefined);
  }
  expect(events.slice(before)).toEqual([value]);
}

describe.each(targets)('$name', ({ name, realm }) => {
  test('handshake, then a call, a registration and a topic', async () => {
    const { url } = await proxied(name);
    const { client, opens } = watch(url, realm);
    const ns = namespace();
    const events: unknown[] = [];
    await interests(client, ns, events, []);
    expect(opens).toHaveLength(1);
    expect(client.session?.realm).toBe(realm);
    expect((await first(client.call(`${ns}.double`, [21]))).args).toEqual([42]);
    if (name === 'reference') expect((await first(client.call('com.example.add', [2, 3]))).args).toEqual([5]);
    await publishUntilSeen(client, ns, events, 'hi');
  });

  test('a server-side drop: one ConnectionLostError onClose, a reconnect, the interests re-established', async () => {
    const { id, url } = await proxied(name);
    const { client, opens, closes } = watch(url, realm);
    const ns = namespace();
    const events: unknown[] = [];
    const registered: number[] = [];
    await interests(client, ns, events, registered);
    await publishUntilSeen(client, ns, events, 'before');
    expect(await commands.fault(id, 'drop')).toBe(1); // the client's one connection
    await until(() => opens.length === 2 && registered.length === 2, 'the second session and the re-registration');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ initiator: 'connection', willRetry: true, closeCode: 1006 });
    expect(closes[0]?.error?.name).toBe('ConnectionLostError');
    expect((await first(client.call(`${ns}.double`, [4]))).args).toEqual([8]);
    await publishUntilSeen(client, ns, events, 'after');
  });

  test('a frozen link: the liveness probe ends the session (TimeoutError liveness) and the client reconnects', async () => {
    // the callee is another client on its own connection: the frozen session stays a ghost on the router until it
    // notices, and a call routed to the ghost's registration would wait for it
    const ns = namespace();
    const callee = watch((await proxied(name)).url, realm);
    await interests(callee.client, ns, [], []);
    const { id, url } = await proxied(name);
    const { client, opens, closes } = watch(url, realm, { timeouts: { idle: 500 } });
    await until(() => opens.length === 1, 'the session');
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the calibration probe has been answered
    expect(await commands.fault(id, 'freeze')).toBe(1);
    await until(() => closes.length === 1, 'the liveness end', 15_000);
    const error = closes[0]?.error;
    expect(isThruwayError(error) && error.code === 'timeout' ? error.timer : error).toBe('liveness');
    expect(closes[0]?.willRetry).toBe(true);
    await until(() => opens.length === 2, 'the next session (through a fresh connection)');
    expect((await first(client.call(`${ns}.double`, [5]))).args).toEqual([10]);
    await commands.fault(id, 'thaw');
  });

  test('a closing window: calls started after a router close frame (Chromium: socket CLOSING) are written after the next WELCOME; none fails', async () => {
    const ns = namespace();
    const callee = watch((await proxied(name)).url, realm);
    await interests(callee.client, ns, [], []);
    const { id, url } = await proxied(name);
    const sockets: WebSocket[] = [];
    const Recorded = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    const { client, opens, closes } = watch(url, realm, { WebSocket: Recorded });
    await until(() => opens.length === 1, 'the session');
    expect(await commands.fault(id, 'closingWindow', 1500)).toBe(1);
    // Measured: Chromium answers the close frame and stays CLOSING until the TCP connection ends — the window, in
    // which the client has noticed nothing yet. WebKit has no window: on macOS it fires close (1000) at once; on Linux
    // it keeps the socket OPEN, hiding the close frame, until the connection is reset (1.5 s here). Either way its calls
    // simply wait for the next session. A browser that changes either way fails here (firefox: either).
    const chromium = navigator.userAgent.includes('Chrome/');
    const webkit = !chromium && navigator.userAgent.includes('AppleWebKit/');
    await until(() => sockets[0]?.readyState !== WebSocket.OPEN, 'the router close frame', chromium ? 1000 : 5000);
    const state = sockets[0]?.readyState;
    if (chromium) expect([state, closes.length]).toEqual([WebSocket.CLOSING, 0]);
    if (webkit) expect(state).toBe(WebSocket.CLOSED);
    const results = await Promise.all([1, 2, 3].map((n) => first(client.call(`${ns}.double`, [n]))));
    expect(results.map((r): unknown[] => r.args)).toEqual([[2], [4], [6]]);
    expect(opens).toHaveLength(2);
    expect(closes).toHaveLength(1);
  });

  test('close(): every timer the client armed is cleared, the session and status say closed', async () => {
    const { url } = await proxied(name);
    const live = new Set<unknown>();
    const clock = {
      now: () => performance.now(),
      setTimeout: (fn: () => void, ms: number): unknown => {
        const handle = setTimeout(() => {
          live.delete(handle);
          fn();
        }, ms);
        live.add(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        live.delete(handle);
        clearTimeout(handle as number);
      },
    };
    const { client, statuses } = watch(url, realm, { clock, timeouts: { idle: 1000 } });
    const ns = namespace();
    await interests(client, ns, [], []);
    expect((await first(client.call(`${ns}.double`, [1]))).args).toEqual([2]);
    expect(live.size).toBeGreaterThan(0); // liveness, the stable-session timer, …
    await client.close();
    expect(live.size).toBe(0);
    expect(client.session).toBeUndefined();
    expect(statuses.at(-1)?.state).toBe('closed');
  });

  test('the binary convention: a Uint8Array round-trips as "\\u0000"+base64 through the router', async () => {
    const { url } = await proxied(name);
    const { client } = watch(url, realm, { serializer: jsonSerializer({ binary: true }) });
    const ns = namespace();
    await new Promise<void>((resolve, reject) => {
      client
        .register(`${ns}.bytes`, (inv): unknown => inv.args[0])
        .subscribe({
          next: () => {
            resolve();
          },
          error: reject,
        });
    });
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]);
    const [echoed] = (await first(client.call(`${ns}.bytes`, [bytes]))).args as unknown[];
    expect(echoed).toBeInstanceOf(Uint8Array);
    expect(Array.from(echoed as Uint8Array)).toEqual(Array.from(bytes));
  });
});

describe("connect failures with the browser's WebSocket", () => {
  test.for(['dns', 'tlsToPlain', 'tlsUntrusted', 'refused'] as const)(
    '%s: one ConnectionLostError onClose (1006, willRetry) per attempt and exactly one next status{connecting}',
    async (kind) => {
      const { client, statuses, closes } = watch(failures[kind], 'realm1', {
        retryOptions: { initialRetryDelay: 200, maxRetryDelay: 200 },
      });
      const connecting = (): number => statuses.filter((s) => s.state === 'connecting').length;
      await until(() => connecting() >= 3, 'the third attempt', 20_000);
      await client.close();
      const ends = closes.filter((c) => c.initiator === 'connection');
      // attempts 1 and 2 ended once each before the 3rd started (the 3rd may have ended before close())
      expect(ends.length === 2 || ends.length === 3, JSON.stringify(closes)).toBe(true);
      for (const end of ends) {
        expect(end).toMatchObject({ closeCode: 1006, willRetry: true, wasClean: false, reason: undefined });
        expect(end.error?.name).toBe('ConnectionLostError');
      }
      // between two connecting statuses exactly one end: connecting, closed, connecting, closed, connecting
      const states = statuses.map((s) => s.state).slice(0, 5);
      expect(states).toEqual(['connecting', 'closed', 'connecting', 'closed', 'connecting']);
      expect(
        statuses
          .filter((s) => s.state === 'connecting')
          .map((s) => (s as { attempt: number }).attempt)
          .slice(0, 3),
      ).toEqual([1, 2, 3]);
    },
  );
});
