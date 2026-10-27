// A small TCP fault proxy (Node side): it forwards every byte between clients and a target (the reference server or a
// real router). Faults act on the connections open at that moment; later connections pass:
// - `freeze()` stops reading both sockets: the client's frames (its GOODBYE, its close frame, a liveness probe) wait in
//   the kernel buffers and nothing comes back — a paused router or a stalled link — until `thaw()`;
// - `drop()` resets every connection (TCP RST: the client sees 1006);
// - `closingWindow(ms)` sends the client a WebSocket close frame (1000) from the router's side, forwards nothing more
//   and keeps the TCP connection open for `ms`: the client's socket is CLOSING (its writes are refused) until the
//   connection is reset.
// Used by the browser runs (test/browser/global-setup.ts, commands.ts) and test/node/exit.test.ts. The full chaos proxy
// of the integration suite is test/integration/harness/chaos-proxy.ts; this one has only what these tests need.
import net from 'node:net';

export interface TcpProxy {
  readonly port: number;
  /** Connections currently open (client side). */
  readonly connections: number;
  /** Stop forwarding in both directions on the open connections (half-open from the client's view). */
  freeze(): void;
  /** Forward again on the frozen connections, including what waited. */
  thaw(): void;
  /** Reset every open connection (both sides). */
  drop(): void;
  /** A router close frame to every open client, then silence for `ms`, then a reset. */
  closingWindow(ms: number): void;
  /** Reset every connection and stop listening. */
  close(): Promise<void>;
}

type Pair = readonly [client: net.Socket, upstream: net.Socket];

/** An unmasked WebSocket close frame (server → client), code 1000, no reason (RFC 6455 §5.5.1). */
const CLOSE_FRAME = Buffer.from([0x88, 0x02, 0x03, 0xe8]);

/**
 * A TCP reset (RST) of `socket`, or a plain destroy() once its end() has run. pipe() ends a socket as soon as the other
 * side ends, and `resetAndDestroy()` while that shutdown is still in flight fails with EINVAL, never emits 'close'
 * and leaks the handle: the process then spins at 100 % CPU at exit, forever (Node 22.13, 24.22, 26.3; it hung the
 * browser run after its summary).
 */
export function resetSocket(socket: net.Socket): void {
  if (socket.writableEnded || socket.destroyed) socket.destroy();
  else socket.resetAndDestroy();
}

function stop([client, upstream]: Pair): void {
  // unpipe first: pipe() would resume a paused source on the next 'drain'
  client.unpipe(upstream);
  upstream.unpipe(client);
  client.pause();
  upstream.pause();
}

export async function startTcpProxy(target: { host: string; port: number }, port = 0): Promise<TcpProxy> {
  const pairs = new Set<Pair>();
  const frozen = new Set<Pair>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const pair: Pair = [client, upstream];
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (): void => {
      pairs.delete(pair);
      frozen.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const reset = (pair: Pair): void => {
    pairs.delete(pair);
    frozen.delete(pair);
    resetSocket(pair[0]);
    resetSocket(pair[1]);
  };
  return {
    port: (server.address() as net.AddressInfo).port,
    get connections() {
      return pairs.size;
    },
    freeze() {
      for (const pair of pairs) {
        stop(pair);
        frozen.add(pair);
      }
    },
    thaw() {
      for (const pair of frozen) {
        const [client, upstream] = pair;
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        upstream.resume();
      }
      frozen.clear();
    },
    drop() {
      for (const pair of [...pairs]) reset(pair);
    },
    closingWindow(ms: number) {
      for (const pair of [...pairs]) {
        stop(pair);
        pair[0].write(CLOSE_FRAME);
        pairs.delete(pair);
        setTimeout(() => {
          reset(pair);
        }, ms);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const pair of [...pairs]) reset(pair);
        server.close(() => {
          resolve();
        });
      }),
  };
}
