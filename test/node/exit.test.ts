// In Node the process can exit after close(). A child process runs the built package (dist/esm) against a router in
// another child process (the public testing kit's router behind a real `ws` server), uses calls, a topic and a
// registration, then `await client.close()` and is left alone; this process watches how long it lives and what keeps it
// alive (`process.getActiveResourcesInfo()` from inside the child):
// - a healthy peer: the child exits within 500 ms of close() resolving, with no client Timeout left; also for a
//   client that was never opened;
// - a frozen peer — close() during a proxy freeze() (test/browser/tcp-proxy.ts stops reading both sockets) and during
//   routerPause (the router process is SIGSTOPped, like `podman pause`) — one expectation per transport, measured
//   on Node 22.13, 22.23, 24.22 and 26.3:
//   * `WebSocket: ws`: the process exits within goodbye (2 s) + 500 ms of close(): the lingering record terminate()s;
//   * the default (undici) WebSocket: close() resolves within goodbye + 500 ms, no client Timeout and none of the
//     client's listeners remain (only the adapter's permanent error guard), exactly one
//     TCPSocketWrap remains and the process stays alive while the peer is frozen (undici has no closing-handshake
//     timeout and no terminate()); after the thaw it exits within 500 ms.
// Either expectation failing is a drift of the platform (a Node release that adds a closing timeout to undici turns the
// undici behaviour off visibly; the README is then updated).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { resetSocket, startTcpProxy, type TcpProxy } from '../browser/tcp-proxy.js';
import { REPO, scratch, writeFiles } from '../package/helpers.js';

/** The lingering GOODBYE wait (a constant). */
const GOODBYE = 2000;
const SLACK = 500;
/** How long a frozen undici socket must keep the process alive after close() resolved (drift check). */
const HOLD = 2500;

/** Per Node major: does the default (undici) WebSocket keep the process alive against a frozen peer after close()?
 *  Measured true on 22, 24 and 26; an unmeasured major is expected to behave like the last one. */
const UNDICI_HOLDS_FROZEN_SOCKET: Readonly<Record<number, boolean>> = { 22: true, 24: true, 26: true };
const major = Number(process.versions.node.split('.')[0]);
const undiciHolds = UNDICI_HOLDS_FROZEN_SOCKET[major] ?? true;

const dist = (file: string): string => pathToFileURL(path.join(REPO, 'dist/esm', file)).href;

const ROUTER = `
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(${JSON.stringify(path.join(REPO, 'package.json'))})('ws');
const { createTestRouter } = await import(${JSON.stringify(dist('testing/index.js'))});
const router = createTestRouter();
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (p) => (p.has('wamp.2.json') ? 'wamp.2.json' : false) });
wss.on('connection', (real) => {
  const fake = new router.WebSocket(router.url, ['wamp.2.json']);
  const waiting = [];
  let open = false;
  fake.addEventListener('open', () => { open = true; for (const d of waiting.splice(0)) fake.send(d); });
  fake.addEventListener('message', (ev) => real.send(ev.data));
  fake.addEventListener('close', (ev) => real.close(ev.code === 1000 || (ev.code >= 3000 && ev.code <= 4999) ? ev.code : 1000));
  real.on('message', (data, binary) => { const d = binary ? new Uint8Array(data) : data.toString('utf8'); if (open) fake.send(d); else waiting.push(d); });
  real.on('close', () => { try { fake.close(1000); } catch {} });
  real.on('error', () => {});
});
wss.on('listening', () => process.stdout.write(JSON.stringify({ event: 'listening', port: wss.address().port }) + '\\n'));
`;

const CLIENT = `
import { createRequire } from 'node:module';
const { Client } = await import(${JSON.stringify(dist('index.js'))});
const { socketErrorGuard } = await import(${JSON.stringify(dist('transport/websocket.js'))});
const require = createRequire(${JSON.stringify(path.join(REPO, 'package.json'))});
const Base = process.env.TRANSPORT === 'undici' ? globalThis.WebSocket : require('ws').WebSocket;
const sockets = [];
class Tracked extends Base {
  constructor(url, protocols) {
    super(url, protocols);
    this.tracked = { open: new Set(), message: new Set(), error: new Set(), close: new Set() };
    // ws-without-terminate: the control case of a transport the lingering record cannot terminate()
    if (process.env.TRANSPORT === 'ws-without-terminate') this.terminate = undefined;
    sockets.push(this);
  }
  addEventListener(type, listener, options) { this.tracked[type]?.add(listener); return super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { this.tracked[type]?.delete(listener); return super.removeEventListener(type, listener, options); }
}
const print = (o) => process.stdout.write(JSON.stringify({ ...o, at: Date.now() }) + '\\n');
const handles = () => process.getActiveResourcesInfo().filter((r) => /TCP|Timeout/.test(r));
const listeners = (ws) => ws === undefined ? undefined : {
  open: ws.tracked.open.size, message: ws.tracked.message.size, close: ws.tracked.close.size, error: ws.tracked.error.size,
  onlyGuard: [...ws.tracked.error].every((l) => l === socketErrorGuard),
};
const first = (observable) => new Promise((resolve, reject) => {
  const sub = observable.subscribe({ next: (v) => { resolve(v); queueMicrotask(() => sub.unsubscribe()); }, error: reject });
});
const failed = [];
const client = new Client(process.env.URL, 'realm1', { WebSocket: Tracked, autoOpen: process.env.MODE !== 'never-opened' });
if (process.env.MODE !== 'never-opened') {
  const events = [];
  client.register('com.exit.echo', (inv) => inv.args[0]).subscribe({ error: (e) => failed.push(e.name) });
  client.topic('com.exit.topic').subscribe({ next: (e) => events.push(e.args[0]), error: (e) => failed.push(e.name) });
  await first(client.onOpen);
  await new Promise((r) => setTimeout(r, 50));
  const result = await first(client.call('com.exit.echo', [42]));
  await first(client.publish('com.exit.topic', [7], {}, { acknowledge: true, exclude_me: false }));
  for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  print({ event: 'ready', result: result.args, events });
  await new Promise((resolve) => process.stdin.once('data', resolve));
}
process.stdin.destroy();
const calledAt = Date.now();
await client.close();
// the ws package arms its own 30 s close timer in ws.close() and clears it when the TCP socket closes
const ws = sockets.at(-1);
const wsTimers = ws?._closeTimer && !ws._closeTimer._destroyed ? 1 : 0;
print({ event: 'closed', calledAt, closeMs: Date.now() - calledAt, handles: handles(), wsTimers, sockets: sockets.length,
        listeners: listeners(ws), failed });
for (const ms of [1000, 2000]) setTimeout(() => print({ event: 'sample', handles: handles() }), ms).unref();
`;

interface Line {
  readonly event: string;
  readonly at: number;
  readonly [key: string]: unknown;
}

class Child {
  readonly lines: Line[] = [];
  exitAt: number | undefined;
  stderr = '';
  private readonly waiters: (() => void)[] = [];
  constructor(readonly process: ChildProcessWithoutNullStreams) {
    let buffer = '';
    process.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) this.lines.push(JSON.parse(line) as Line);
        this.wake();
      }
    });
    process.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
    process.on('exit', () => {
      this.exitAt = Date.now();
      this.wake();
    });
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  get exited(): boolean {
    return this.exitAt !== undefined;
  }
  async line(event: string, ms = 10_000): Promise<Line> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.lines.find((l) => l.event === event);
      if (found !== undefined) return found;
      if (this.exited || Date.now() > deadline) {
        throw new Error(`no "${event}" line (exited: ${String(this.exited)}); stderr:\n${this.stderr}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  async exit(ms: number): Promise<number | undefined> {
    const deadline = Date.now() + ms;
    while (!this.exited && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    return this.exitAt;
  }
}

const children: Child[] = [];
const proxies: TcpProxy[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.process.kill('SIGCONT');
    child.process.kill('SIGKILL');
  }
  for (const proxy of proxies.splice(0)) await proxy.close();
});

function spawnScript(name: string, source: string, env: Record<string, string> = {}): Child {
  const dir = scratch(`exit-${name}`);
  writeFiles(dir, { [`${name}.mjs`]: source });
  const child = new Child(
    spawn(process.execPath, [path.join(dir, `${name}.mjs`)], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  children.push(child);
  return child;
}

async function startRouter(): Promise<{ child: Child; port: number }> {
  const child = spawnScript('router', ROUTER);
  const port = (await child.line('listening'))['port'] as number;
  return { child, port };
}

type Freeze = 'proxy' | 'routerPause';

/** Connect a client child, use it, then close() it — with the peer frozen first when `freeze` is given. */
async function closeScenario(transport: 'undici' | 'ws' | 'ws-without-terminate', freeze?: Freeze) {
  const router = await startRouter();
  let port = router.port;
  let proxy: TcpProxy | undefined;
  if (freeze === 'proxy') {
    proxy = await startTcpProxy({ host: '127.0.0.1', port: router.port });
    proxies.push(proxy);
    port = proxy.port;
  }
  const client = spawnScript('client', CLIENT, { TRANSPORT: transport, URL: `ws://127.0.0.1:${String(port)}/` });
  const ready = await client.line('ready');
  expect(ready['result']).toEqual([42]);
  expect(ready['events']).toEqual([7]);
  if (freeze === 'proxy') proxy?.freeze();
  if (freeze === 'routerPause') router.child.process.kill('SIGSTOP');
  client.process.stdin.write('close\n');
  const closed = await client.line('closed', 3 * GOODBYE);
  const thaw = (): void => {
    if (freeze === 'proxy') proxy?.thaw();
    if (freeze === 'routerPause') router.child.process.kill('SIGCONT');
  };
  return { client, closed, thaw };
}

const handlesOf = (line: Line): string[] => line['handles'] as string[];
const count = (handles: string[], pattern: RegExp): number => handles.filter((h) => pattern.test(h)).length;
/** Timers left in the child that are not the `ws` package's own close timer: the client's (must be 0). */
const clientTimers = (line: Line): number => count(handlesOf(line), /Timeout/) - (line['wsTimers'] as number);

describe.each(['undici', 'ws'] as const)('%s transport', (transport) => {
  test('a healthy peer: the process exits within 500 ms of close(), with no client Timeout left', async () => {
    const { client, closed } = await closeScenario(transport);
    expect(closed['closeMs'] as number).toBeLessThan(SLACK);
    expect(clientTimers(closed), JSON.stringify(closed)).toBe(0);
    expect(closed['failed']).toEqual(['ConnectionClosedError', 'ConnectionClosedError']);
    const exitAt = await client.exit(SLACK + 1000);
    expect(exitAt, client.stderr).toBeDefined();
    expect(exitAt! - closed.at).toBeLessThan(SLACK);
    expect(client.process.exitCode).toBe(0);
  });

  test('a client that was never opened: close() and exit within 500 ms, no socket ever created', async () => {
    const client = spawnScript('client', CLIENT, {
      TRANSPORT: transport,
      URL: 'ws://127.0.0.1:9/',
      MODE: 'never-opened',
    });
    const closed = await client.line('closed');
    expect(closed['sockets']).toBe(0);
    expect(handlesOf(closed)).toEqual([]);
    const exitAt = await client.exit(SLACK + 1000);
    expect(exitAt).toBeDefined();
    expect(exitAt! - closed.at).toBeLessThan(SLACK);
  });

  describe.each(['proxy', 'routerPause'] as const)('close() while the peer is frozen (%s)', (freeze) => {
    if (transport === 'ws') {
      test('ws: the process exits within goodbye + 500 ms (the lingering record terminate()s the socket)', async () => {
        const { client, closed, thaw } = await closeScenario(transport, freeze);
        try {
          expect(closed['closeMs'] as number).toBeGreaterThanOrEqual(GOODBYE - 50);
          expect(closed['closeMs'] as number).toBeLessThan(GOODBYE + SLACK);
          expect(clientTimers(closed), JSON.stringify(closed)).toBe(0);
          const exitAt = await client.exit(GOODBYE + SLACK);
          expect(exitAt, `drift: the ws process did not exit against a frozen peer\n${client.stderr}`).toBeDefined();
          expect(exitAt! - (closed['calledAt'] as number)).toBeLessThan(GOODBYE + SLACK);
        } finally {
          thaw();
        }
      });
    } else {
      test('undici: close() resolves within goodbye + 500 ms with no client handle; one TCPSocketWrap holds the process until the thaw', async () => {
        const { client, closed, thaw } = await closeScenario(transport, freeze);
        try {
          expect(closed['closeMs'] as number).toBeGreaterThanOrEqual(GOODBYE - 50);
          expect(closed['closeMs'] as number).toBeLessThan(GOODBYE + SLACK);
          expect(clientTimers(closed), JSON.stringify(closed)).toBe(0);
          expect(closed['listeners']).toEqual({ open: 0, message: 0, close: 0, error: 1, onlyGuard: true });
          if (!undiciHolds) {
            const exitAt = await client.exit(GOODBYE + SLACK);
            expect(exitAt, 'drift: expected Node to close the frozen undici socket itself').toBeDefined();
            return;
          }
          expect(count(handlesOf(closed), /TCP/), JSON.stringify(closed)).toBe(1);
          await client.exit(HOLD);
          expect(
            client.exited,
            'drift: the undici process exited against a frozen peer — Node now closes the socket itself; update README and UNDICI_HOLDS_FROZEN_SOCKET',
          ).toBe(false);
          const samples = client.lines.filter((l) => l.event === 'sample');
          expect(samples.length).toBeGreaterThanOrEqual(2);
          for (const sample of samples) expect(handlesOf(sample)).toEqual(['TCPSocketWrap']);
          thaw();
          const thawedAt = Date.now();
          const exitAt = await client.exit(SLACK + 1000);
          expect(exitAt, client.stderr).toBeDefined();
          expect(exitAt! - thawedAt).toBeLessThan(SLACK);
        } finally {
          thaw();
        }
      });
    }
  });
});

test('control: a ws socket that cannot be terminate()d keeps the process alive past goodbye + 500 ms (the ws expectation depends on the lingering record calling terminate())', async () => {
  const { client, closed, thaw } = await closeScenario('ws-without-terminate', 'proxy');
  try {
    expect(closed['closeMs'] as number).toBeLessThan(GOODBYE + SLACK);
    await client.exit(GOODBYE + SLACK);
    expect(client.exited).toBe(false); // ws's own close timer is 30 s
    thaw();
    expect(await client.exit(SLACK + 1000)).toBeDefined();
  } finally {
    thaw();
  }
});

describe('the fault proxy of these runs (test/browser/tcp-proxy.ts)', () => {
  test('resetting a socket whose end() is in flight closes it: resetAndDestroy() would fail with EINVAL, leak the handle and spin the process at exit', async () => {
    const server = net.createServer((s) => s.on('error', () => undefined).resume());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    const errors: unknown[] = [];
    socket.on('error', (error: NodeJS.ErrnoException) => errors.push(error.code));
    const closed = new Promise<boolean>((resolve) => {
      socket.once('close', () => {
        resolve(true);
      });
      setTimeout(() => {
        resolve(false);
      }, 1000).unref();
    });
    socket.end(); // what pipe() does when the other side ends; its shutdown request runs from the next tick
    process.nextTick(() => {
      process.nextTick(() => {
        resetSocket(socket);
      });
    });
    expect([await closed, errors]).toEqual([true, []]);
    await new Promise((resolve) => server.close(resolve));
  });
});
