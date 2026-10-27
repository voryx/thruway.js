// The chaos WebSocket proxy: sits between clients and a router, forwards every frame (text stays text, binary stays
// binary, the router's subprotocol choice is passed through), records every frame, and injects faults — per connection
// or for all of them:
//
//   kill()                        destroy both TCP sockets (the client sees 1006)
//   close(code, reason)           close the client side with a code (and the router side)
//   latency(ms, jitter)           delay every frame (order kept per direction)
//   fragment(n)                   send each frame to the client as n WebSocket fragments
//   freeze() / thaw()             stop forwarding both ways (a half-open link); thaw() delivers what was held
//   blackhole('up' | 'down')      drop frames one way (up = client → router); blackhole(undefined) ends it
//   throttle(bytesPerSecond)      pace frames to the client by size (undefined: off)
//   corrupt(p, mode, direction, except)   replace a frame's text with p probability ('json': a mutated JSON value;
//                                 'bytes'), frames of one direction or [both], never frames of the `except` types
//   duplicate(p)                  send a frame twice with p probability
//   inject(frame, direction)      send a frame of our own ('down': to the client)
//   refuse(ms)                    answer upgrades with HTTP 503 for ms
//   listen(false | true)          stop / start accepting TCP (ECONNREFUSED)
//   stallUpgrade(ms | Infinity)   accept TCP but answer the upgrade only after ms (the real path to timer.connect)
//   on(direction, predicate, action, {count})   frame-triggered faults: kill, close(code), drop, delay(ms), hold,
//                                 duplicate, corrupt, inject(frame)
//
// Router-level faults (restart, pause, SIGTERM) are in harness/routers.ts. Ports come from PROXY_PORTS
// (default 18340-18379): one port per proxy, released by `stop()`.
import http from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

export type Direction = 'up' | 'down';

export interface ProxyFrame {
  readonly connection: number;
  readonly direction: Direction;
  readonly at: number;
  /** The text (truncated to 1024 characters), undefined for binary frames. */
  readonly text: string | undefined;
  readonly bytes: number;
  /** What the proxy did with it. */
  readonly fate: 'forwarded' | 'dropped' | 'held' | 'injected' | 'corrupted' | 'duplicated';
}

export type FrameAction =
  | { readonly kind: 'kill' }
  | { readonly kind: 'close'; readonly code: number; readonly reason?: string }
  | { readonly kind: 'drop' }
  | { readonly kind: 'delay'; readonly ms: number }
  | { readonly kind: 'hold' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'inject'; readonly frame: readonly unknown[] | string; readonly direction?: Direction };

export interface FrameTrigger {
  readonly direction: Direction;
  readonly predicate: (frame: readonly unknown[] | undefined, text: string | undefined) => boolean;
  readonly action: FrameAction;
  remaining: number;
}

interface Pending {
  readonly data: RawData;
  readonly binary: boolean;
}

/** One proxied connection: the client's socket and the router's. */
export class ProxyConnection {
  readonly opened = performance.now();
  closed = false;
  private readonly held: Record<Direction, Pending[]> = { up: [], down: [] };
  private lastDue: Record<Direction, number> = { up: 0, down: 0 };
  frozen = false;
  private readonly onThaw: (() => void)[] = [];

  constructor(
    readonly id: number,
    readonly client: WebSocket,
    readonly upstream: WebSocket,
    private readonly proxy: ChaosProxy,
  ) {}

  /** The proxy-wide faults (for the ping handling). */
  faults(): ProxyFaults {
    return this.proxy.faults;
  }

  /** Destroy both TCP sockets: no close frame either way. */
  kill(): void {
    this.closed = true;
    this.client.terminate();
    this.upstream.terminate();
  }

  close(code = 1000, reason = ''): void {
    this.closed = true;
    try {
      this.client.close(code, reason);
    } catch {
      this.client.terminate();
    }
    this.upstream.close(1000);
  }

  freeze(): void {
    this.frozen = true;
  }

  /** Run `fn` now, or when the connection is thawed (a frozen link delays closes too). */
  whenThawed(fn: () => void): void {
    if (this.frozen) this.onThaw.push(fn);
    else fn();
  }

  thaw(): void {
    this.frozen = false;
    for (const fn of this.onThaw.splice(0)) fn();
    for (const direction of ['up', 'down'] as const) {
      for (const p of this.held[direction].splice(0)) this.deliver(direction, p.data, p.binary);
    }
  }

  /** Send a frame of our own to the client ('down') or the router ('up'). */
  inject(frame: readonly unknown[] | string, direction: Direction = 'down'): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.proxy.record(this.id, direction, text, Buffer.byteLength(text), 'injected');
    (direction === 'down' ? this.client : this.upstream).send(text);
  }

  /** A frame arrived from one side (`up`: from the client). */
  receive(direction: Direction, data: RawData, binary: boolean): void {
    const buffer = toBuffer(data);
    const text = binary ? undefined : buffer.toString('utf8');
    const bytes = buffer.length;
    const parsed = parse(text);
    const trigger = this.proxy.triggerFor(direction, parsed, text);
    if (trigger !== undefined) {
      const a = trigger.action;
      switch (a.kind) {
        case 'kill':
          this.proxy.record(this.id, direction, text, bytes, 'dropped');
          this.kill();
          return;
        case 'close':
          this.proxy.record(this.id, direction, text, bytes, 'dropped');
          this.close(a.code, a.reason);
          return;
        case 'drop':
          this.proxy.record(this.id, direction, text, bytes, 'dropped');
          return;
        case 'hold':
          this.proxy.record(this.id, direction, text, bytes, 'held');
          this.held[direction].push({ data, binary });
          this.frozen = true;
          return;
        case 'delay':
          this.proxy.record(this.id, direction, text, bytes, 'forwarded');
          setTimeout(() => {
            this.deliver(direction, data, binary);
          }, a.ms);
          return;
        case 'duplicate':
          this.proxy.record(this.id, direction, text, bytes, 'duplicated');
          this.forward(direction, data, binary);
          this.forward(direction, data, binary);
          return;
        case 'corrupt':
          this.proxy.record(this.id, direction, text, bytes, 'corrupted');
          this.deliver(direction, Buffer.from(corruptText(text ?? '', 'json', this.proxy.random)), false);
          return;
        case 'inject':
          this.inject(a.frame, a.direction ?? direction);
          break;
      }
    }
    const faults = this.proxy.faults;
    if (faults.blackhole === direction) {
      this.proxy.record(this.id, direction, text, bytes, 'dropped');
      return;
    }
    if (
      faults.corrupt > 0 &&
      (faults.corruptDirection === undefined || faults.corruptDirection === direction) &&
      !faults.corruptExcept.has(parsed?.[0]) &&
      this.proxy.random() < faults.corrupt
    ) {
      this.proxy.record(this.id, direction, text, bytes, 'corrupted');
      this.forward(direction, Buffer.from(corruptText(text ?? '', faults.corruptMode, this.proxy.random)), false);
      return;
    }
    const twice = faults.duplicate > 0 && this.proxy.random() < faults.duplicate;
    this.proxy.record(this.id, direction, text, bytes, twice ? 'duplicated' : 'forwarded');
    this.forward(direction, data, binary);
    if (twice) this.forward(direction, data, binary);
  }

  /** Apply latency and throttling (per direction, order kept), then deliver. */
  private forward(direction: Direction, data: RawData, binary: boolean): void {
    const faults = this.proxy.faults;
    let delay = 0;
    if (faults.latency > 0 || faults.jitter > 0) delay = faults.latency + this.proxy.random() * faults.jitter;
    if (direction === 'down' && faults.throttle !== undefined) {
      const bytes = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).length;
      delay += (bytes / faults.throttle) * 1000;
    }
    if (delay <= 0 && this.lastDue[direction] <= performance.now()) {
      this.deliver(direction, data, binary);
      return;
    }
    const due = Math.max(performance.now() + delay, this.lastDue[direction]);
    this.lastDue = { ...this.lastDue, [direction]: due };
    setTimeout(
      () => {
        this.deliver(direction, data, binary);
      },
      Math.max(0, due - performance.now()),
    );
  }

  private deliver(direction: Direction, data: RawData, binary: boolean): void {
    if (this.frozen) {
      this.held[direction].push({ data, binary });
      return;
    }
    const target = direction === 'up' ? this.upstream : this.client;
    if (target.readyState !== WebSocket.OPEN) return;
    const fragments = direction === 'down' ? this.proxy.faults.fragments : 1;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (fragments <= 1 || buffer.length < fragments) {
      target.send(buffer, { binary });
      return;
    }
    // n fragments of one message: split on UTF-8 boundaries is not needed — a fragmented text message is reassembled
    // before decoding by the receiver
    const size = Math.ceil(buffer.length / fragments);
    for (let i = 0; i < fragments; i++) {
      target.send(buffer.subarray(i * size, Math.min(buffer.length, (i + 1) * size)), {
        binary,
        fin: i === fragments - 1,
      });
    }
  }
}

export interface ProxyFaults {
  latency: number;
  jitter: number;
  fragments: number;
  blackhole: Direction | undefined;
  throttle: number | undefined;
  corrupt: number;
  corruptMode: 'json' | 'bytes';
  /** Only frames of this direction are corrupted [both]. */
  corruptDirection: Direction | undefined;
  /** Frames of these message types are never corrupted [none]. */
  corruptExcept: ReadonlySet<unknown>;
  duplicate: number;
}

const PORTS = (process.env['PROXY_PORTS'] ?? '18340-18379').split('-').map(Number) as [number, number];
const usedPorts = new Set<number>();
/** A port of PROXY_PORTS for another local test server (marked used; give it back with `releasePort`). */
export function reservePort(): number {
  for (let port = PORTS[1]; port >= PORTS[0]; port--) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('no free port in PROXY_PORTS');
}

export function releasePort(port: number): void {
  usedPorts.delete(port);
}

/** The proxy keeps at most this many recorded frames (oldest dropped first). */
const MAX_RECORDED = 4000;

export interface ChaosProxyOptions {
  /** The router URL every connection is forwarded to. */
  readonly target: string;
  /** PRNG for jitter/corruption/duplication (seeded runs); [Math.random] */
  readonly random?: () => number;
}

export class ChaosProxy {
  readonly frames: ProxyFrame[] = [];
  readonly connections: ProxyConnection[] = [];
  readonly faults: ProxyFaults = {
    latency: 0,
    jitter: 0,
    fragments: 1,
    blackhole: undefined,
    throttle: undefined,
    corrupt: 0,
    corruptMode: 'json',
    corruptDirection: undefined,
    corruptExcept: new Set(),
    duplicate: 0,
  };
  readonly random: () => number;
  private readonly triggers: FrameTrigger[] = [];
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();
  private readonly chosen = new WeakMap<http.IncomingMessage, string>();
  private refuseUntil = 0;
  private stallMs = 0;
  private listening = false;
  private next = 0;
  readonly started = performance.now();
  port = 0;

  private constructor(
    readonly target: string,
    options: ChaosProxyOptions,
  ) {
    this.random = options.random ?? Math.random;
    // the client is answered with the subprotocol the router chose for this upgrade (or none)
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      handleProtocols: (_protocols, request) => this.chosen.get(request) ?? false,
    });
    this.server = http.createServer((_req, res) => {
      res.writeHead(426).end();
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.upgrade(req, socket, head);
    });
  }

  /** Start a proxy for `target` on a free port of PROXY_PORTS. */
  static async start(options: ChaosProxyOptions): Promise<ChaosProxy> {
    const proxy = new ChaosProxy(options.target, options);
    for (let port = PORTS[0]; port <= PORTS[1]; port++) {
      if (usedPorts.has(port)) continue;
      if (await proxy.bind(port)) {
        usedPorts.add(port);
        proxy.port = port;
        return proxy;
      }
    }
    throw new Error(`chaos proxy: no free port in ${String(PORTS[0])}-${String(PORTS[1])}`);
  }

  /** The URL clients connect to (the target's path kept). */
  get url(): string {
    const target = new URL(this.target);
    return `ws://127.0.0.1:${String(this.port)}${target.pathname}${target.search}`;
  }

  private bind(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onError = (): void => {
        this.server.off('listening', onListening);
        resolve(false);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        this.listening = true;
        resolve(true);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, '127.0.0.1');
    });
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (performance.now() < this.refuseUntil) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const go = (): void => {
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const target = new URL(this.target);
      // autoPong off: the proxy answers the router's pings for the client, except while frozen — a frozen link must
      // look dead to a router that pings (Thruway's replace_orphaned_session, Crossbar's auto-ping)
      const upstream = new WebSocket(`${target.origin}${req.url ?? '/'}`, offered, {
        perMessageDeflate: false,
        autoPong: false,
      });
      const early: { data: RawData; binary: boolean }[] = [];
      const collect = (data: RawData, binary: boolean): void => {
        early.push({ data, binary });
      };
      upstream.on('message', collect);
      upstream.once('open', () => {
        if (upstream.protocol !== '') this.chosen.set(req, upstream.protocol);
        this.wss.handleUpgrade(req, socket, head, (client) => {
          const conn = new ProxyConnection(++this.next, client, upstream, this);
          this.connections.push(conn);
          // bounded: closed connections that nothing waits for (no close held back by a freeze) are dropped
          if (this.connections.length > 64) {
            const keep = this.connections.filter((c) => !c.closed || c.frozen);
            this.connections.splice(0, this.connections.length, ...keep);
          }
          upstream.off('message', collect);
          client.on('message', (data, binary) => {
            conn.receive('up', data, binary);
          });
          upstream.on('message', (data, binary) => {
            conn.receive('down', data, binary);
          });
          upstream.on('ping', (data) => {
            if (!conn.frozen && conn.faults().blackhole !== 'up') upstream.pong(data);
          });
          for (const e of early) conn.receive('down', e.data, e.binary);
          // a frozen link passes no close either: the other side keeps its (now ghost) connection until kill(),
          // thaw() or stop()
          client.on('close', (code, reason) => {
            conn.closed = true;
            conn.whenThawed(() => {
              if (upstream.readyState === WebSocket.OPEN)
                upstream.close(code === 1005 || code === 1006 ? 1000 : code, reason);
              else upstream.terminate();
            });
          });
          upstream.on('close', (code, reason) => {
            conn.closed = true;
            conn.whenThawed(() => {
              if (client.readyState === WebSocket.OPEN) {
                if (code === 1006 || code === 1005) client.terminate();
                else client.close(code, reason);
              }
            });
          });
          client.on('error', () => {
            upstream.terminate();
          });
          upstream.on('error', () => {
            client.terminate();
          });
        });
      });
      upstream.once('unexpected-response', (_request, response) => {
        socket.end(
          `HTTP/1.1 ${String(response.statusCode ?? 502)} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      upstream.once('error', () => {
        if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
    };
    if (this.stallMs === 0) {
      go();
      return;
    }
    // a stalled upgrade: read the socket (nothing comes before a 101) so that the FIN of a client that gave up is seen,
    // and free it then — a paused socket never sees it, and every stalled attempt kept one TCP socket in the proxy
    const drop = (): void => {
      socket.destroy();
    };
    socket.on('end', drop);
    socket.resume();
    if (this.stallMs === Infinity) return; // never answered: the client's connect timer fires
    setTimeout(() => {
      socket.off('end', drop);
      socket.pause();
      if (!socket.destroyed) go();
    }, this.stallMs);
  }

  record(
    connection: number,
    direction: Direction,
    text: string | undefined,
    bytes: number,
    fate: ProxyFrame['fate'],
  ): void {
    const kept = text !== undefined && text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
    this.frames.push({ connection, direction, at: performance.now() - this.started, text: kept, bytes, fate });
    // bounded (a soak forwards millions of frames): the most recent ones are what a failure needs
    if (this.frames.length > MAX_RECORDED) this.frames.splice(0, this.frames.length - MAX_RECORDED / 2);
  }

  triggerFor(
    direction: Direction,
    frame: readonly unknown[] | undefined,
    text: string | undefined,
  ): FrameTrigger | undefined {
    const t = this.triggers.find((x) => x.direction === direction && x.remaining > 0 && x.predicate(frame, text));
    if (t !== undefined) t.remaining--;
    return t;
  }

  // --- faults (all connections) --------------------------------------------------------------------------------

  /** The connections that are still open. */
  get open(): readonly ProxyConnection[] {
    return this.connections.filter((c) => !c.closed);
  }

  kill(): void {
    for (const c of this.open) c.kill();
  }
  close(code = 1000, reason = ''): void {
    for (const c of this.open) c.close(code, reason);
  }
  freeze(): void {
    for (const c of this.open) c.freeze();
  }
  thaw(): void {
    for (const c of this.connections) c.thaw();
  }
  latency(ms: number, jitter = 0): void {
    this.faults.latency = ms;
    this.faults.jitter = jitter;
  }
  fragment(n: number): void {
    this.faults.fragments = n;
  }
  blackhole(direction: Direction | undefined): void {
    this.faults.blackhole = direction;
  }
  throttle(bytesPerSecond: number | undefined): void {
    this.faults.throttle = bytesPerSecond;
  }
  corrupt(p: number, mode: 'json' | 'bytes' = 'json', direction?: Direction, except: readonly number[] = []): void {
    this.faults.corrupt = p;
    this.faults.corruptMode = mode;
    this.faults.corruptDirection = direction;
    this.faults.corruptExcept = new Set(except);
  }
  duplicate(p: number): void {
    this.faults.duplicate = p;
  }
  inject(frame: readonly unknown[] | string, direction: Direction = 'down'): void {
    for (const c of this.open) c.inject(frame, direction);
  }
  refuse(ms: number): void {
    this.refuseUntil = performance.now() + ms;
  }
  stallUpgrade(ms: number): void {
    this.stallMs = ms;
  }
  async listen(on: boolean): Promise<void> {
    if (on === this.listening) return;
    if (!on) {
      this.listening = false;
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          resolve();
        });
        // keep established connections: only new TCP connections are refused
      });
      return;
    }
    if (!(await this.bind(this.port))) throw new Error(`chaos proxy: port ${String(this.port)} could not be re-bound`);
  }
  /** A frame-triggered fault: the first `count` frames of `direction` that match `predicate` get `action`. */
  on(
    direction: Direction,
    predicate: FrameTrigger['predicate'],
    action: FrameAction,
    options: { readonly count?: number } = {},
  ): FrameTrigger {
    const trigger: FrameTrigger = { direction, predicate, action, remaining: options.count ?? 1 };
    this.triggers.push(trigger);
    return trigger;
  }
  /** Back to a clean link: no latency, fragmentation, blackhole, throttle, corruption, duplication, trigger or stall;
   *  thaw everything; accept again. */
  async heal(): Promise<void> {
    Object.assign(this.faults, {
      latency: 0,
      jitter: 0,
      fragments: 1,
      blackhole: undefined,
      throttle: undefined,
      corrupt: 0,
      corruptDirection: undefined,
      corruptExcept: new Set(),
      duplicate: 0,
    } satisfies Partial<ProxyFaults>);
    this.triggers.length = 0;
    this.stallMs = 0;
    this.refuseUntil = 0;
    this.thaw();
    await this.listen(true);
  }

  /** Close every connection and the listener; release the port. */
  async stop(): Promise<void> {
    for (const c of this.connections) c.kill();
    for (const s of this.sockets) s.destroy();
    this.wss.close();
    if (this.listening) {
      this.listening = false;
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          resolve();
        });
      });
    }
    usedPorts.delete(this.port);
  }
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function parse(text: string | undefined): readonly unknown[] | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
  } catch {
    return undefined;
  }
}

/** A corrupted frame: 'json' mutates one value of the decoded frame (type, id, a field), 'bytes' flips a byte. */
export function corruptText(text: string, mode: 'json' | 'bytes', random: () => number): string {
  const frame = parse(text);
  if (mode === 'bytes' || frame === undefined || frame.length === 0) {
    if (text.length === 0) return '\u0000';
    const at = Math.floor(random() * text.length);
    return `${text.slice(0, at)}${String.fromCharCode((text.charCodeAt(at) ^ 0x5a) & 0x7f)}${text.slice(at + 1)}`;
  }
  const copy = [...frame];
  const at = Math.floor(random() * copy.length);
  const choices: unknown[] = [null, -1, 1.5, 'x', {}, [], 2 ** 53 + 2, 1023];
  copy[at] = choices[Math.floor(random() * choices.length)];
  return JSON.stringify(copy);
}
