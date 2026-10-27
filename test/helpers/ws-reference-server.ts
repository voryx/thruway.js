// The reference router behind a real `ws` WebSocket server: node tests (and, with a launcher, the browser runs) reach
// the simulation's router — any dialect, its faults, its oracle — over a real TCP socket, so the real Client runs
// against it with Node's global WebSocket (undici) or the `ws` package.
//
//   const server = await startReferenceServer({ dialect: 'thruway-php' });
//   const client = new Client(server.url, 'realm1');
//   server.router.procedure('com.example.add', (args) => …);   // the router API as usual
//   await server.close();
//
// Each real connection is bridged to one connection of the router's fake network: the subprotocol is chosen during
// the HTTP upgrade by the dialect's rules (its `subprotocols`, `subprotocol_order`, `no_subprotocol`), frames are
// copied both ways as they arrive, and a close on either side closes the other (a router close 1005 or 1006 becomes a
// close frame without a code, or a TCP reset). The router runs in real time (microtask delivery, host timers), so
// fault controls apply to the fake end: `server.router.connections[i].controls.freeze('drop')` makes the real socket
// half-open, `drop()` resets it.
import type { AddressInfo } from 'node:net';
import { type WebSocket as WsSocket, WebSocketServer } from 'ws';
import { createRouter, type FakeSocket, type SimRouter, type SimRouterOptions } from '../../src/testing/sim.js';

export interface ReferenceServer {
  /** `ws://127.0.0.1:<port>/` */
  readonly url: string;
  readonly port: number;
  readonly router: SimRouter;
  /** Real connections currently bridged. */
  readonly connections: number;
  /** Close every connection (1001) and stop listening. */
  close(): Promise<void>;
}

export interface ReferenceServerOptions extends Omit<SimRouterOptions, 'clock' | 'delivery' | 'latency'> {
  /** Listen on this port [0: any free one]. */
  readonly port?: number;
  readonly host?: string;
}

/** The subprotocol the dialect picks among `offered`, `''` for none accepted, or false (the upgrade fails). */
export function pickSubprotocol(router: SimRouter, offered: readonly string[]): string | false {
  const q = router.quirks;
  const pick =
    q.subprotocol_order === 'client'
      ? offered.find((p) => q.subprotocols.includes(p))
      : q.subprotocols.find((p) => offered.includes(p));
  if (pick !== undefined) return pick;
  return q.no_subprotocol === 'accept' ? '' : false;
}

/** A close code a WebSocket close frame may carry (1005/1006 cannot be sent). */
function sendable(code: number): number | undefined {
  return code === 1000 ||
    (code >= 3000 && code <= 4999) ||
    (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)
    ? code
    : undefined;
}

export async function startReferenceServer(options: ReferenceServerOptions = {}): Promise<ReferenceServer> {
  const { port = 0, host = '127.0.0.1', ...routerOptions } = options;
  const router = createRouter({ ...routerOptions, delivery: 'microtask' });
  const open = new Set<WsSocket>();
  const wss = new WebSocketServer({
    host,
    port,
    handleProtocols: (offered) => {
      const pick = pickSubprotocol(router, [...offered]);
      return pick === '' ? false : pick;
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const address = wss.address() as AddressInfo;
  const url = `ws://${host}:${String(address.port)}/`;

  wss.on('connection', (real, request) => {
    open.add(real);
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const protocol = pickSubprotocol(router, offered);
    let fake: FakeSocket;
    try {
      fake = new router.WebSocket(url, protocol === false || protocol === '' ? [] : [protocol]) as FakeSocket;
    } catch {
      real.terminate(); // setAvailable('throw')
      return;
    }
    let closed = false;
    const pendingIn: (string | Buffer)[] = [];
    const finish = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      const c = sendable(code);
      if (code === 1006) real.terminate();
      else if (c === undefined) real.close();
      else real.close(c, reason);
    };
    fake.addEventListener('open', () => {
      for (const data of pendingIn.splice(0)) fake.send(typeof data === 'string' ? data : new Uint8Array(data));
    });
    fake.addEventListener('message', (ev) => {
      real.send(ev.data as string);
    });
    fake.addEventListener('close', (ev) => {
      finish(ev.code, ev.reason);
    });
    real.on('message', (data, isBinary) => {
      const frame = isBinary ? Buffer.concat([data as Buffer]) : (data as Buffer).toString('utf8');
      if (fake.readyState === 0) pendingIn.push(frame);
      else fake.send(typeof frame === 'string' ? frame : new Uint8Array(frame));
    });
    real.on('close', (code) => {
      open.delete(real);
      closed = true;
      try {
        fake.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
      } catch {
        // already closed
      }
    });
    real.on('error', () => undefined); // a reset by the client: the close event follows
  });

  return {
    url,
    port: address.port,
    router,
    get connections() {
      return open.size;
    },
    close: async () => {
      router.close();
      for (const real of open) real.close(1001);
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
        for (const real of open) real.terminate();
      });
    },
  };
}
