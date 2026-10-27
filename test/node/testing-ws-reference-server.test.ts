// The reference router behind a real `ws` server (test/helpers/ws-reference-server.ts): real clients — Node's global
// WebSocket (undici) and the `ws` package — talk WAMP to the simulation's router over TCP: handshake, calls to scripted
// procedures, router GOODBYE, closes both ways, a dialect's subprotocol rules and its replies, the fault controls of
// the fake end, and the oracle.
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import type { WebSocketConstructorLike, WebSocketLike } from '../../src/types.js';
import { type ReferenceServer, startReferenceServer } from '../helpers/ws-reference-server.js';

const clients: readonly { readonly name: string; readonly Ctor: WebSocketConstructorLike }[] = [
  { name: 'undici', Ctor: globalThis.WebSocket },
  { name: 'ws', Ctor: WsWebSocket },
];

let server: ReferenceServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Peer {
  readonly ws: WebSocketLike;
  readonly frames: unknown[][];
  readonly events: string[];
  next(type: number, ms?: number): Promise<unknown[]>;
  send(frame: unknown[]): void;
}

async function connect(
  Ctor: WebSocketConstructorLike,
  url: string,
  protocols: string[] = ['wamp.2.json'],
): Promise<Peer> {
  const ws = new Ctor(url, protocols);
  const frames: unknown[][] = [];
  const events: string[] = [];
  ws.addEventListener('open', () => events.push('open'));
  ws.addEventListener('error', () => events.push('error'));
  ws.addEventListener('close', (e) => events.push(`close:${String(e.code)}`));
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as unknown[]));
  for (let i = 0; i < 200 && events.length === 0; i++) await delay(5);
  return {
    ws,
    frames,
    events,
    send: (frame) => {
      ws.send(JSON.stringify(frame));
    },
    next: async (type, ms = 2000) => {
      for (let waited = 0; waited < ms; waited += 5) {
        const i = frames.findIndex((f) => f[0] === type);
        if (i >= 0) return frames.splice(i, 1)[0]!;
        await delay(5);
      }
      throw new Error(`no frame of type ${String(type)} (got ${JSON.stringify(frames)}, events ${events.join(',')})`);
    },
  };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 5) await delay(5);
}

const ROLES = { caller: {}, callee: {}, publisher: {}, subscriber: {} };

describe.each(clients)('$name client', ({ Ctor }) => {
  test('HELLO → WELCOME, a CALL to a scripted procedure, the router’s GOODBYE and the reply, the router closes', async () => {
    server = await startReferenceServer({ strict: true });
    server.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
    const p = await connect(Ctor, server.url);
    expect([p.events, p.ws.protocol]).toEqual([['open'], 'wamp.2.json']);
    p.send([1, 'realm1', { roles: ROLES }]);
    const welcome = await p.next(2);
    expect(welcome[2]).toEqual(expect.objectContaining({ authmethod: 'anonymous' }));
    p.send([48, 1, {}, 'com.example.add', [2, 3]]);
    expect(await p.next(50)).toEqual([50, 1, {}, [5]]);
    server.router.goodbye('wamp.close.system_shutdown');
    expect(await p.next(6)).toEqual([6, {}, 'wamp.close.system_shutdown']);
    p.send([6, {}, 'wamp.close.goodbye_and_out']);
    await until(() => p.events.includes('close:1000'));
    expect(p.events).toEqual(['open', 'close:1000']);
    expect(server.router.violations).toEqual([]);
    expect(server.router.unscripted).toEqual([]);
    await until(() => server?.connections === 0);
    expect(server.connections).toBe(0);
  });

  test('a client close ends the session; the oracle sees the client’s frames', async () => {
    server = await startReferenceServer();
    const p = await connect(Ctor, server.url);
    p.send([48, 1, {}, 'com.x']); // before HELLO
    p.send([1, 'realm1', { roles: ROLES }]);
    await p.next(2);
    expect(server.router.sessions.length).toBe(1);
    p.ws.close(1000);
    await until(() => server?.router.sessions.length === 0);
    expect(server.router.sessions).toEqual([]);
    expect(server.router.violations.map((v) => v.code)).toEqual(['before-hello']);
  });

  test('a dialect: Thruway PHP’s GOODBYE reply and close; a fake-end drop resets the real socket (1006)', async () => {
    server = await startReferenceServer({ dialect: 'thruway-php' });
    const p = await connect(Ctor, server.url);
    p.send([1, 'realm1', { roles: ROLES }]);
    expect((await p.next(2))[2]).toEqual({ roles: server.router.quirks.roles });
    p.send([6, {}, 'wamp.close.close_realm']);
    expect(await p.next(6)).toEqual([6, {}, 'wamp.error.goodbye_and_out']);
    await until(() => p.events.length > 1);
    expect(p.events).toEqual(['open', 'close:1000']);
    const q = await connect(Ctor, server.url);
    q.send([1, 'realm1', { roles: ROLES }]);
    await q.next(2);
    server.router.connections.at(-1)!.controls.drop();
    await until(() => q.events.some((e) => e.startsWith('close')));
    expect(q.events.at(-1)).toBe('close:1006');
  });

  test('subprotocols: one the dialect does not accept fails the upgrade', async () => {
    server = await startReferenceServer();
    const p = await connect(Ctor, server.url, ['wamp.2.msgpack']);
    await until(() => p.events.some((e) => e.startsWith('close')));
    expect(p.events).not.toContain('open');
  });

  test("a router close (1005 for Bondy's GOODBYE) reaches the client as a close frame without a code", async () => {
    server = await startReferenceServer({ dialect: 'bondy' });
    const p = await connect(Ctor, server.url);
    p.send([1, 'realm1', { roles: ROLES }]);
    await p.next(2);
    p.send([6, {}, 'wamp.close.close_realm']);
    await p.next(6);
    await until(() => p.events.length > 1);
    expect(p.events).toEqual(['open', 'close:1005']);
  });
});

test('binary frames are forwarded as binary; a frozen fake end makes the real socket half-open', async () => {
  server = await startReferenceServer();
  const ws = new WsWebSocket(server.url, ['wamp.2.json']);
  const frames: unknown[] = [];
  ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8'))));
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(Buffer.from(JSON.stringify([1, 'realm1', { roles: ROLES }])));
  await until(() => frames.length > 0);
  expect((frames[0] as unknown[])[0]).toBe(2);
  server.router.connections[0]!.controls.freeze('drop');
  ws.send(JSON.stringify([48, 1, {}, 'com.x']));
  await delay(100);
  expect(frames.length).toBe(1);
  ws.terminate();
});

test('setAvailable("throw") resets the connection; close() closes every connection and stops listening', async () => {
  server = await startReferenceServer();
  server.router.setAvailable('throw');
  const p = await connect(globalThis.WebSocket, server.url);
  await until(() => p.events.some((e) => e.startsWith('close')));
  expect(p.events.at(-1)).toBe('close:1006');
  server.router.setAvailable('ok');
  const q = await connect(globalThis.WebSocket, server.url);
  q.send([1, 'realm1', { roles: ROLES }]);
  await q.next(2);
  const s = server;
  server = undefined;
  await s.close();
  await until(() => q.events.some((e) => e.startsWith('close')));
  expect(q.events.at(-1)).toMatch(/^close:100[16]$/);
  const late = await connect(globalThis.WebSocket, s.url);
  await until(() => late.events.some((e) => e.startsWith('close')));
  expect(late.events).not.toContain('open');
});
