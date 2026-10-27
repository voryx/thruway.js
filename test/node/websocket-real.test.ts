// The WebSocket adapter against real sockets: Node's global (undici) WebSocket and the `ws` package as clients, local
// `ws`, HTTP, HTTPS and raw TCP servers as peers. Normal open/message/close, text and binary frames, close codes, close
// while CONNECTING, send while CLOSING, terminate, bufferedAmount, and the connect failures (DNS, TLS, refused, 4xx on
// upgrade, subprotocol mismatch), each at adapter level: exactly one `sink.closed` (1006, not clean), no `open`. Runs
// on every supported Node (22.13 floor, 26 here; the event sequences differ — Node 22 fires `error` without `close` —
// and the adapter hides that). Then the same failures through a real Client (one end, one retry.scheduled, no connect
// timeout), the connect timeout, close() after a session against a minimal WAMP peer, and the process exiting right
// after close() resolves.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { Client } from '../../src/client.js';
import { ConnectionLostError, TimeoutError } from '../../src/errors.js';
import { openWebSocket, SEND_REFUSED, type Transport, type TransportSink } from '../../src/transport/websocket.js';
import type {
  CloseInfo,
  LogEntry,
  Status,
  Timeouts,
  WebSocketConstructorLike,
  WebSocketLike,
} from '../../src/types.js';

const PROTOCOLS = ['wamp.2.json'] as const;
const TLS_DIR = new URL('../fixtures/tls/', import.meta.url);
const KEY = fs.readFileSync(new URL('self-signed.key', TLS_DIR));
const CERT = fs.readFileSync(new URL('self-signed.crt', TLS_DIR));
/** How long to keep listening for a (wrong) second report after the first one. */
const SETTLE_MS = 300;

const clients: readonly { readonly name: string; readonly Ctor: WebSocketConstructorLike }[] = [
  { name: 'undici (globalThis.WebSocket)', Ctor: globalThis.WebSocket },
  { name: 'ws', Ctor: WsWebSocket },
];

/** Wraps a constructor so the test can reach the socket the adapter created. */
function capturing(Ctor: WebSocketConstructorLike): { Ctor: WebSocketConstructorLike; made: WebSocketLike[] } {
  const made: WebSocketLike[] = [];
  const Wrapped = function (url: string, protocols?: string | string[]): WebSocketLike {
    const socket = new Ctor(url, protocols);
    made.push(socket);
    return socket;
  } as unknown as WebSocketConstructorLike;
  Object.defineProperty(Wrapped, 'OPEN', { value: Ctor.OPEN });
  return { Ctor: Wrapped, made };
}

interface Recorder {
  readonly calls: unknown[][];
  readonly sink: TransportSink;
  of(kind: 'open' | 'message' | 'closed'): unknown[][];
}
function recorder(onClosed?: () => void): Recorder {
  const calls: unknown[][] = [];
  return {
    calls,
    sink: {
      open: (protocol) => calls.push(['open', protocol]),
      message: (data) => calls.push(['message', data]),
      closed: (...args) => {
        calls.push(['closed', ...args]);
        onClosed?.();
      },
    },
    of: (kind) => calls.filter((c) => c[0] === kind).map((c) => c.slice(1)),
  };
}

// --- peers ------------------------------------------------------------------------------------------------------

interface Peer {
  readonly path: string;
  readonly socket: WsWebSocket;
  readonly frames: { data: Buffer; isBinary: boolean }[];
  closed?: { code: number; reason: string };
}
const peers: Peer[] = [];
const servers: { close(cb?: (err?: Error) => void): unknown }[] = [];
const rawSockets = new Set<net.Socket>();
let seq = 0;
let wsBase = '';
let ports: Record<
  'plain' | 'selfSigned' | 'forbidden' | 'mismatch' | 'noEcho' | 'closing' | 'frozen' | 'silent' | 'refused',
  number
>;

/** `scheme://127.0.0.1:port/` */
function local(scheme: 'ws' | 'wss', port: number): string {
  return `${scheme}://127.0.0.1:${String(port)}/`;
}

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** A raw TCP peer that completes the WebSocket upgrade (optionally with a given subprotocol header), then runs
 *  `after`. allowHalfOpen: it never ends its side unless told to, so a client's closing handshake stays pending. */
function rawUpgrade(protocol: string | undefined, after: (socket: net.Socket) => void): net.Server {
  return net.createServer({ allowHalfOpen: true }, (socket) => {
    rawSockets.add(socket);
    socket.on('error', () => {
      // peers ignore resets
    });
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? '';
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          (protocol === undefined ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`) +
          '\r\n',
      );
      after(socket);
    };
    socket.on('data', onData);
  });
}

beforeAll(async () => {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (offered) => (offered.has('wamp.2.json') ? 'wamp.2.json' : false),
  });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wsBase = local('ws', (wss.address() as net.AddressInfo).port).slice(0, -1);
  wss.on('connection', (socket, request) => {
    const peer: Peer = { path: request.url ?? '', socket, frames: [] };
    peers.push(peer);
    socket.on('message', (data, isBinary) => peer.frames.push({ data: data as Buffer, isBinary }));
    socket.on('close', (code, reason) => {
      peer.closed = { code, reason: reason.toString() };
    });
  });

  const selfSigned = https.createServer({ key: KEY, cert: CERT }, (_req, res) => res.writeHead(400).end());
  selfSigned.on('tlsClientError', () => {
    // the client rejects the certificate
  });
  const dead = net.createServer();
  const refused = await listen(dead);
  await new Promise<void>((resolve) => {
    dead.close(() => {
      resolve();
    });
  });
  servers.pop();
  ports = {
    plain: await listen(http.createServer((_req, res) => res.writeHead(400).end())),
    selfSigned: await listen(selfSigned),
    forbidden: await listen(http.createServer((_req, res) => res.writeHead(403).end('forbidden'))),
    mismatch: await listen(rawUpgrade('other.protocol', () => undefined)),
    // completes the upgrade without echoing a subprotocol although the client offered one
    noEcho: await listen(rawUpgrade(undefined, () => undefined)),
    // the router's close frame (1000), then silence with the TCP connection kept open: the client stays CLOSING
    closing: await listen(rawUpgrade('wamp.2.json', (s) => s.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])))),
    // upgrade completed, then never reads again (a frozen router, podman pause, a stuck proxy)
    frozen: await listen(rawUpgrade('wamp.2.json', (s) => s.pause())),
    // accepts TCP, never answers the upgrade (drives the connect timeout)
    silent: await listen(
      net.createServer((s) => {
        rawSockets.add(s);
        s.on('error', () => undefined);
      }),
    ),
    refused,
  };
});

afterAll(async () => {
  for (const socket of rawSockets) socket.destroy();
  for (const peer of peers) peer.socket.terminate();
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** `release`: close the transport from inside `sink.closed`, as the core does (its end() runs synchronously there
 *  and releases the socket; undici's close() on a socket that is still CONNECTING then dispatches events from
 *  inside close(): Node 22 `error`, Node 24/26 `error` + `close 1006`). */
function open(
  Ctor: WebSocketConstructorLike,
  url: string,
  options: { readonly release?: boolean } = {},
): { t: Transport; rec: Recorder; socket: () => WebSocketLike } {
  const c = capturing(Ctor);
  const ref: { t?: Transport } = {};
  const rec = recorder(() => {
    if (options.release) ref.t?.close(1000, '');
  });
  const t = openWebSocket(c.Ctor, url, PROTOCOLS, rec.sink);
  ref.t = t;
  return {
    t,
    rec,
    socket: () => {
      const s = c.made[0];
      if (!s) throw new Error('no socket');
      return s;
    },
  };
}

/** Opens against the `ws` server under a fresh path and waits for both ends. */
async function session(
  Ctor: WebSocketConstructorLike,
): Promise<{ t: Transport; rec: Recorder; peer: Peer; socket: () => WebSocketLike }> {
  const path = `/s${String(++seq)}`;
  const { t, rec, socket } = open(Ctor, wsBase + path);
  await vi.waitFor(() => {
    expect(rec.of('open')).toHaveLength(1);
  });
  const peer = await vi.waitFor(() => {
    const found = peers.find((p) => p.path === path);
    if (!found) throw new Error('peer not connected yet');
    return found;
  });
  return { t, rec, peer, socket };
}

/** Exactly one `closed` — 1006, not clean, a text — and no `open`, also after a settle period. */
async function expectOneFailure(rec: Recorder): Promise<unknown[]> {
  await vi.waitFor(
    () => {
      expect(rec.of('closed')).toHaveLength(1);
    },
    { timeout: 10000 },
  );
  await delay(SETTLE_MS);
  expect(rec.of('open')).toEqual([]);
  expect(rec.calls).toHaveLength(1);
  const [code, reason, wasClean, cause] = rec.of('closed')[0] ?? [];
  expect(code).toBe(1006);
  expect(wasClean).toBe(false);
  expect(typeof reason === 'string' && reason !== '').toBe(true);
  expect(cause).toBeInstanceOf(Error);
  return [code, reason, wasClean, cause];
}

describe.each(clients)('$name', ({ name, Ctor }) => {
  const isWs = name === 'ws';

  test('open reports the negotiated subprotocol; text and binary frames in both directions', async () => {
    const { t, rec, peer } = await session(Ctor);
    expect(rec.of('open')).toEqual([['wamp.2.json']]);
    peer.socket.send('[2,1,{}]');
    peer.socket.send(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => {
      expect(rec.of('message')).toHaveLength(2);
    });
    const [text, binary] = rec.of('message').map(([data]) => data);
    expect(text).toBe('[2,1,{}]');
    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(binary as ArrayBuffer)]).toEqual([1, 2, 3]);

    expect(t.send('[1,"realm1",{}]')).toBe(true);
    expect(t.send(new Uint8Array([9, 4, 5, 6, 9]).subarray(1, 4))).toBe(true);
    await vi.waitFor(() => {
      expect(peer.frames).toHaveLength(2);
    });
    expect(peer.frames[0]).toEqual({ data: Buffer.from('[1,"realm1",{}]'), isBinary: false });
    expect(peer.frames[1]).toEqual({ data: Buffer.from([4, 5, 6]), isBinary: true });
    expect(rec.of('closed')).toEqual([]);
    t.close(1000, '');
  });

  test('the router closes with a code and reason: closed(code, reason, true), once', async () => {
    const { t, rec, peer } = await session(Ctor);
    peer.socket.close(4321, 'router bye');
    await vi.waitFor(() => {
      expect(rec.of('closed')).toHaveLength(1);
    });
    await delay(SETTLE_MS);
    expect(rec.of('closed')).toEqual([[4321, 'router bye', true, undefined]]);
    expect(t.send('x')).toBe(false);
    expect(rec.of('closed')).toHaveLength(1);
  });

  test('the router drops the TCP connection: closed(1006, …, false), once', async () => {
    const { rec, peer } = await session(Ctor);
    peer.socket.terminate();
    await vi.waitFor(() => {
      expect(rec.of('closed')).toHaveLength(1);
    });
    await delay(SETTLE_MS);
    const [code, , wasClean] = rec.of('closed')[0] ?? [];
    expect([code, wasClean]).toEqual([1006, false]);
    expect(rec.of('closed')).toHaveLength(1);
  });

  test('the client closes: the router sees the code and reason, nothing is reported', async () => {
    const { t, rec, peer } = await session(Ctor);
    t.close(4000, 'protocol violation');
    await vi.waitFor(() => {
      expect(peer.closed).toEqual({ code: 4000, reason: 'protocol violation' });
    });
    await delay(SETTLE_MS);
    expect(rec.of('closed')).toEqual([]);
  });

  // On the real `ws` (an EventEmitter, so its listeners can be counted): release removes the adapter's four listeners
  // through `ws`'s own removeEventListener matching, and only the guard stays.
  test.runIf(isWs)('release leaves only the guard on the socket (client close, and the router closing)', async () => {
    const counts = (s: WebSocketLike): number[] =>
      (['open', 'message', 'error', 'close'] as const).map((type) => (s as WsWebSocket).listenerCount(type));
    const a = await session(Ctor);
    expect(counts(a.socket())).toEqual([1, 1, 2, 1]);
    a.t.close(1000, '');
    expect(counts(a.socket())).toEqual([0, 0, 1, 0]);

    const b = await session(Ctor);
    b.peer.socket.close(1000, '');
    await vi.waitFor(() => {
      expect(b.rec.of('closed')).toHaveLength(1);
    });
    expect(counts(b.socket())).toEqual([0, 0, 1, 0]);
  });

  test('close while CONNECTING (the connect timeout): nothing reported and no uncaught error', async () => {
    const { t, rec } = open(Ctor, local('ws', ports.silent));
    await delay(50);
    t.close(4001, 'connect timeout');
    t.terminate();
    // `ws` emits `error` + `close` a tick later; without the adapter's guard that `error` is an uncaught exception
    await delay(SETTLE_MS);
    expect(rec.calls).toEqual([]);
  });

  test('send while CONNECTING returns false and reports the loss once; the refused write closes the socket', async () => {
    const { t, rec, socket } = open(Ctor, local('ws', ports.silent));
    await delay(50);
    expect(t.send('[1,"realm1",{}]')).toBe(false);
    expect(t.send('[1,"realm1",{}]')).toBe(false);
    expect(rec.calls).toEqual([['closed', 1006, SEND_REFUSED, false, undefined]]);
    // `ws` (which throws on send while CONNECTING) emits `error` + `close` a tick after the close: the guard takes it
    await delay(SETTLE_MS);
    expect(rec.calls).toHaveLength(1);
    expect(socket().readyState).toBeGreaterThanOrEqual(2);
  });

  test('send while CLOSING (router close frame, no close event yet) returns false and reports the loss once', async () => {
    const { t, rec, socket } = open(Ctor, local('ws', ports.closing));
    await vi.waitFor(() => {
      expect(rec.of('open')).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(socket().readyState).toBe(2);
    });
    expect(rec.of('closed')).toEqual([]);
    expect(t.send('[16,1,{},"t"]')).toBe(false);
    expect(t.send('[16,2,{},"t"]')).toBe(false);
    expect(rec.of('closed')).toEqual([[1006, SEND_REFUSED, false, undefined]]);
    for (const s of rawSockets) s.destroy();
    await delay(SETTLE_MS);
    expect(rec.of('closed')).toHaveLength(1);
  });

  test(
    isWs
      ? 'terminate() destroys the socket of a frozen peer at once'
      : 'terminate() is a no-op: the TCP connection outlives close() against a frozen peer',
    async () => {
      const before = new Set(rawSockets);
      const { t, rec, socket } = open(Ctor, local('ws', ports.frozen));
      await vi.waitFor(() => {
        expect(rec.of('open')).toHaveLength(1);
      });
      const tcp = [...rawSockets].find((s) => !before.has(s));
      if (!tcp) throw new Error('peer socket not found');
      let tcpClosed = false; // the client ended its side (allowHalfOpen: 'end' comes before any 'close')
      for (const event of ['end', 'close']) {
        tcp.on(event, () => {
          tcpClosed = true;
        });
      }
      t.close(1000, '');
      t.terminate();
      // the peer reads again (so it can see the TCP connection end) but never answers the closing handshake
      tcp.on('data', () => undefined).resume();
      if (isWs) {
        await vi.waitFor(() => {
          expect(tcpClosed).toBe(true);
          expect(socket().readyState).toBe(3);
        });
      } else {
        await delay(1000);
        expect(tcpClosed).toBe(false);
        expect(socket().readyState).toBe(2);
        tcp.destroy();
      }
      expect(rec.calls).toEqual([['open', 'wamp.2.json']]);
    },
  );

  test('bufferedAmount(): the outbound backlog, back to 0 once flushed', async () => {
    const { t, peer } = await session(Ctor);
    expect(t.bufferedAmount()).toBe(0);
    expect(t.send('x'.repeat(8 * 1024 * 1024))).toBe(true);
    expect(t.bufferedAmount()).toBeGreaterThan(0);
    await vi.waitFor(
      () => {
        expect(peer.frames).toHaveLength(1);
        expect(t.bufferedAmount()).toBe(0);
      },
      { timeout: 10000 },
    );
    t.close(1000, '');
  });

  describe.each([
    { mode: 'adapter only', options: {} },
    { mode: 'released from inside sink.closed, as the core does', options: { release: true } },
  ])('a socket that never opens, $mode: exactly one closed (1006, not clean), no open', ({ options }) => {
    test('DNS failure (ws://nonexistent.invalid/)', async (ctx) => {
      const answered = await dns.promises.lookup('nonexistent.invalid').then(
        (a) => a.address,
        () => undefined,
      );
      if (answered !== undefined) {
        ctx.skip(`the resolver answers .invalid (${answered}): a captive resolver, the DNS case cannot run here`);
      }
      const [, reason] = await expectOneFailure(open(Ctor, 'ws://nonexistent.invalid/', options).rec);
      if (isWs) expect(reason).toMatch(/ENOTFOUND|EAI_AGAIN/);
    });

    test('TLS failure: wss:// to a plain HTTP server', async () => {
      await expectOneFailure(open(Ctor, local('wss', ports.plain), options).rec);
    });

    test('TLS failure: wss:// to a server with an untrusted (self-signed) certificate', async () => {
      // control: the same server completes a handshake for a client that trusts the certificate
      await new Promise<void>((resolve, reject) => {
        const control = tls.connect({ host: '127.0.0.1', port: ports.selfSigned, ca: CERT }, () => {
          control.end();
          resolve();
        });
        control.on('error', reject);
      });
      const [, reason] = await expectOneFailure(open(Ctor, local('wss', ports.selfSigned), options).rec);
      if (isWs) expect(reason).toMatch(/self-signed certificate/);
    });

    test('connection refused', async () => {
      const [, reason] = await expectOneFailure(open(Ctor, local('ws', ports.refused), options).rec);
      if (isWs) expect(reason).toMatch(/ECONNREFUSED/);
    });

    test('upgrade rejected with 403', async () => {
      const [, reason] = await expectOneFailure(open(Ctor, local('ws', ports.forbidden), options).rec);
      if (isWs) expect(reason).toMatch(/403/);
    });

    test('subprotocol mismatch (the server selects a protocol that was not offered)', async () => {
      await expectOneFailure(open(Ctor, local('ws', ports.mismatch), options).rec);
    });

    // WHATWG requires the echo when protocols were offered, and `ws` 8 agrees, so `ws.protocol === ''` after `open`
    // only ever comes from custom transports; a platform that starts accepting a missing echo fails this test visibly
    // (the core would then see protocol '' and accept it).
    test('no subprotocol echoed although one was offered', async () => {
      const [, reason] = await expectOneFailure(open(Ctor, local('ws', ports.noEcho), options).rec);
      if (isWs) expect(reason).toMatch(/no subprotocol/);
    });
  });

  describe('through a real Client: each failure is exactly one end and one scheduled reconnect', () => {
    /** undici is Node's default WebSocket: that client is built without the option, so the default is what runs. */
    const webSocket = isWs ? { WebSocket: Ctor } : {};

    /** A client with this WebSocket, a fast profile and a recording logger; one retry, then give-up. */
    function client(url: string, timeouts: Timeouts = {}) {
      const logs: LogEntry[] = [];
      const closes: CloseInfo[] = [];
      const statuses: Status[] = [];
      const c = new Client(url, 'realm1', {
        ...webSocket,
        timeouts: { idle: 0, ...timeouts },
        retryOptions: { maxRetries: 1, retryDelay: () => 150 },
        logger: (e) => logs.push(e),
      });
      c.onClose.subscribe((i) => closes.push(i));
      c.status.subscribe((st) => statuses.push(st));
      return { c, logs, closes, statuses };
    }

    /** Both attempts failed (the retry, then the give-up): one end per attempt, one retry.scheduled, no timeout. */
    async function expectFailures(r: ReturnType<typeof client>): Promise<CloseInfo> {
      await vi.waitFor(
        () => {
          expect(r.closes).toHaveLength(2);
        },
        { timeout: 10000 },
      );
      await delay(SETTLE_MS);
      expect(r.closes).toHaveLength(2);
      const [first, last] = r.closes as [CloseInfo, CloseInfo];
      expect(first).toMatchObject({
        initiator: 'connection',
        closeCode: 1006,
        wasClean: false,
        willRetry: true,
        attempt: 1,
      });
      expect(first.error).toBeInstanceOf(ConnectionLostError);
      expect(first.error).toMatchObject({ closeCode: 1006, attempt: 1 });
      expect(last).toMatchObject({ willRetry: false, attempt: 2 });
      expect(r.logs.filter((l) => l.event === 'retry.scheduled')).toHaveLength(1);
      expect(r.statuses.filter((st) => st.state === 'connecting')).toHaveLength(2);
      expect(r.closes.some((i) => i.error instanceof TimeoutError)).toBe(false);
      await r.c.close();
      return first;
    }

    test('DNS failure (ws://nonexistent.invalid/)', async (ctx) => {
      const answered = await dns.promises.lookup('nonexistent.invalid').then(
        (a) => a.address,
        () => undefined,
      );
      if (answered !== undefined) {
        ctx.skip(`the resolver answers .invalid (${answered}): a captive resolver, the DNS case cannot run here`);
      }
      await expectFailures(client('ws://nonexistent.invalid/'));
    });

    test('TLS failure: wss:// to a plain HTTP server', async () => {
      await expectFailures(client(local('wss', ports.plain)));
    });

    test('TLS failure: wss:// to a server with an untrusted (self-signed) certificate', async () => {
      await expectFailures(client(local('wss', ports.selfSigned)));
    });

    test('connection refused', async () => {
      await expectFailures(client(local('ws', ports.refused)));
    });

    test('upgrade rejected with 403', async () => {
      await expectFailures(client(local('ws', ports.forbidden)));
    });

    test('connect timeout: a peer that accepts TCP and never answers the upgrade ⇒ TimeoutError{connect}, close 4001', async () => {
      const r = client(local('ws', ports.silent), { connect: 300 });
      await vi.waitFor(
        () => {
          expect(r.closes).toHaveLength(2);
        },
        { timeout: 10000 },
      );
      expect(r.closes[0]).toMatchObject({ initiator: 'connection', closeCode: 4001, willRetry: true });
      expect(r.closes[0]?.error).toMatchObject({ name: 'TimeoutError', timer: 'connect', timeout: 300 });
      expect(r.closes[1]?.error).toMatchObject({ timer: 'connect', timeout: 600 }); // the next deadline doubled
      await r.c.close();
    });

    test('close() after a session: GOODBYE close_realm, the reply, the socket closed 1000; close() resolves at once', async () => {
      const wamp = await wampPeer();
      const c = new Client(wamp.url, 'realm1', { ...webSocket, timeouts: { idle: 0 } });
      await new Promise<void>((resolve) => {
        c.onOpen.subscribe(() => {
          resolve();
        });
      });
      const started = performance.now();
      await c.close();
      expect(performance.now() - started).toBeLessThan(1000);
      await vi.waitFor(() => {
        expect(wamp.closed).toEqual([1000]);
      });
      expect(wamp.received.map((f) => f[0])).toEqual([1, 6]);
      expect(wamp.received[1]).toEqual([6, {}, 'wamp.close.close_realm']);
      await wamp.stop();
    });

    test('the process exits right after close() resolves, with this WebSocket', async () => {
      const wamp = await wampPeer();
      const entry = await builtEntry();
      const script = `
        import { Client } from ${JSON.stringify(pathToFileURL(entry).href)};
        ${isWs ? "import { WebSocket } from 'ws';" : 'const WebSocket = undefined; // the default: globalThis.WebSocket'}
        let closedAt = 0;
        process.on('exit', () => console.log('exit ' + String(Math.round(performance.now() - closedAt))));
        const client = new Client(${JSON.stringify(wamp.url)}, 'realm1', { ...(WebSocket ? { WebSocket } : {}), timeouts: { idle: 0 } });
        client.call('com.example.never').subscribe({ error: () => undefined });
        client.topic('com.example.t').subscribe({ error: () => undefined });
        client.onOpen.subscribe(async () => {
          await client.close();
          closedAt = performance.now();
          console.log('closed');
        });
      `;
      const file = fileURLToPath(new URL('../../node_modules/.cache/thruway-ws-real/exit.mjs', import.meta.url));
      fs.writeFileSync(file, script);
      const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.on('exit', (code) => {
          clearTimeout(kill);
          resolve({ code, out });
        });
      });
      expect(result.out).toMatch(/closed/);
      const exited = /exit (\d+)/.exec(result.out);
      expect(result.code, result.out).toBe(0);
      expect(Number(exited?.[1])).toBeLessThan(500);
      await wamp.stop();
    });
  });
});

/** A minimal WAMP peer on a real `ws` server: WELCOME for HELLO, GOODBYE reply then close 1000 for GOODBYE; it records
 *  what it received and the close codes it saw. */
async function wampPeer(): Promise<{
  readonly url: string;
  readonly received: unknown[][];
  readonly closed: number[];
  stop(): Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'wamp.2.json' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const received: unknown[][] = [];
  const closed: number[] = [];
  let session = 0;
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString()) as unknown[];
      received.push(frame);
      if (frame[0] === 1) socket.send(JSON.stringify([2, ++session, { roles: { broker: {}, dealer: {} } }]));
      if (frame[0] === 6) {
        socket.send(JSON.stringify([6, {}, 'wamp.close.goodbye_and_out']));
        socket.close(1000);
      }
    });
    socket.on('close', (code) => closed.push(code));
  });
  return {
    url: local('ws', (server.address() as net.AddressInfo).port),
    received,
    closed,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The ESM build of src (TypeScript 7 through the shipping tsconfig), once per run, in a private directory. */
let built: Promise<string> | undefined;
function builtEntry(): Promise<string> {
  built ??= new Promise<string>((resolve, reject) => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const out = fileURLToPath(new URL('../../node_modules/.cache/thruway-ws-real/esm/', import.meta.url));
    fs.rmSync(out, { recursive: true, force: true });
    const child = spawn(
      process.execPath,
      ['node_modules/typescript7/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', out],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (log += d.toString()));
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`tsc failed:\n${log}`));
        return;
      }
      fs.writeFileSync(`${out}package.json`, '{"type":"module"}\n');
      resolve(`${out}index.js`);
    });
  });
  return built;
}
