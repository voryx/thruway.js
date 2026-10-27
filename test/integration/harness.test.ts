// Self-tests of the integration harness (no router needed): the client-side trace checks catch what they claim to
// (a check that never fires would make every integration test pass for the wrong reason), and the chaos proxy's
// faults really happen on the wire — against a local echo server standing in for a router.
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ChaosProxy, corruptText, releasePort, reservePort } from './harness/chaos-proxy.js';
import { StreamingChecks, type CheckedFrame } from './harness/checks.js';

function run(
  frames: readonly (readonly [number, 'in' | 'out', readonly unknown[]])[],
  requestIds: 'random' | 'sequential' = 'random',
): string[] {
  const checks = new StreamingChecks('c', requestIds);
  for (const [connection, direction, frame] of frames)
    checks.frame({ connection, direction, frame } satisfies CheckedFrame);
  return checks.problems;
}

const HELLO = [1, 'realm1', {}] as const;
const WELCOME = [2, 1, {}] as const;

describe('client-side trace checks', () => {
  test('a clean session passes', () => {
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'out', WELCOME],
        [1, 'in', [48, 7, {}, 'p', []]],
        [1, 'in', [49, 7, { mode: 'killnowait' }]],
        [1, 'out', [8, 49, 7, {}, 'wamp.error.canceled']],
        [1, 'in', [48, 7, {}, 'p', []]], // reuse after the answer: fine
        [1, 'in', [6, {}, 'wamp.close.close_realm']],
      ]),
    ).toEqual([]);
  });

  test('INV-CL01: a CALL before WELCOME, a frame after the client GOODBYE, two replies to a router GOODBYE', () => {
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'in', [48, 1, {}, 'p', []]],
      ]).join(),
    ).toContain('before WELCOME');
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'out', WELCOME],
        [1, 'in', [6, {}, 'x']],
        [1, 'in', [16, 2, {}, 't']],
      ]).join(),
    ).toContain("after the client's GOODBYE");
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'out', WELCOME],
        [1, 'out', [6, {}, 'x']],
        [1, 'in', [48, 3, {}, 'p']],
      ]).join(),
    ).toContain("after the router's GOODBYE");
  });

  test('INV-AUTH: HELLO first, and only once', () => {
    expect(run([[1, 'in', [5, 'sig', {}]]]).join()).toContain('first frame is not HELLO');
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'in', HELLO],
      ]).join(),
    ).toContain('more than one HELLO');
  });

  test('INV-CL02: an in-flight id reused, an invalid id, sequential ids out of order', () => {
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'out', WELCOME],
        [1, 'in', [48, 5, {}, 'p']],
        [1, 'in', [32, 5, {}, 't']],
      ]).join(),
    ).toContain('reused while in flight');
    expect(
      run([
        [1, 'in', HELLO],
        [1, 'out', WELCOME],
        [1, 'in', [48, 0, {}, 'p']],
      ]).join(),
    ).toContain('invalid request id');
    expect(
      run(
        [
          [1, 'in', HELLO],
          [1, 'out', WELCOME],
          [1, 'in', [48, 1, {}, 'p']],
          [1, 'in', [48, 3, {}, 'p']],
        ],
        'sequential',
      ).join(),
    ).toContain('sequential id 3, expected 2');
  });

  test('INV-CANCEL: killnowait only, once per call', () => {
    const base = [
      [1, 'in', HELLO],
      [1, 'out', WELCOME],
      [1, 'in', [48, 9, {}, 'p']],
    ] as const;
    expect(run([...base, [1, 'in', [49, 9, {}]]]).join()).toContain('without killnowait');
    expect(
      run([...base, [1, 'in', [49, 9, { mode: 'killnowait' }]], [1, 'in', [49, 9, { mode: 'killnowait' }]]]).join(),
    ).toContain('second CANCEL');
  });

  test('an internal log entry is a problem', () => {
    const checks = new StreamingChecks('c', 'random');
    checks.log({ level: 'error', event: 'internal', message: 'boom' });
    expect(checks.problems.join()).toContain('internal error logged');
  });
});

describe('chaos proxy (against a local echo server)', () => {
  let server: WebSocketServer;
  const port = reservePort();
  const target = `ws://127.0.0.1:${String(port)}/`;
  beforeAll(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port, handleProtocols: (p) => [...p][0] ?? false });
    server.on('connection', (ws) => {
      ws.on('message', (data, binary) => {
        ws.send(data, { binary });
      });
    });
    await new Promise((resolve) => server.once('listening', resolve));
  });
  afterAll(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });
    releasePort(port);
  });

  async function connect(proxy: ChaosProxy): Promise<{ ws: WebSocket; got: string[]; closed: Promise<number> }> {
    const ws = new WebSocket(proxy.url, ['wamp.2.json']);
    const got: string[] = [];
    ws.addEventListener('message', (e) => got.push(String(e.data)));
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (e) => {
        resolve(e.code);
      });
    });
    await new Promise((resolve) => {
      ws.addEventListener('open', resolve);
    });
    expect(ws.protocol).toBe('wamp.2.json');
    return { ws, got, closed };
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test('forwards both ways, records, and kill() is a 1006', async () => {
    const proxy = await ChaosProxy.start({ target });
    try {
      const c = await connect(proxy);
      c.ws.send('[1]');
      await wait(100);
      expect(c.got).toEqual(['[1]']);
      expect(proxy.frames.map((f) => [f.direction, f.text])).toEqual([
        ['up', '[1]'],
        ['down', '[1]'],
      ]);
      proxy.kill();
      expect(await c.closed).toBe(1006);
    } finally {
      await proxy.stop();
    }
  });

  test('freeze holds frames until thaw; blackhole drops them; latency delays them', async () => {
    const proxy = await ChaosProxy.start({ target });
    try {
      const c = await connect(proxy);
      proxy.freeze();
      c.ws.send('[2]');
      await wait(200);
      expect(c.got).toEqual([]);
      proxy.thaw();
      await wait(100);
      expect(c.got).toEqual(['[2]']);
      proxy.blackhole('up');
      c.ws.send('[3]');
      await wait(150);
      expect(c.got).toEqual(['[2]']);
      proxy.blackhole(undefined);
      proxy.latency(300);
      const sent = performance.now();
      c.ws.send('[4]');
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (c.got.includes('[4]')) resolve();
          else setTimeout(check, 10);
        };
        check();
      });
      expect(performance.now() - sent).toBeGreaterThan(500); // up and down, 300 ms each
    } finally {
      await proxy.stop();
    }
  });

  test('close(code) reaches the client; a frame trigger kills on the matching frame; refuse answers 503', async () => {
    const proxy = await ChaosProxy.start({ target });
    try {
      const a = await connect(proxy);
      proxy.close(4000, 'chaos');
      expect(await a.closed).toBe(4000);
      const b = await connect(proxy);
      proxy.on('down', (f) => f?.[0] === 50, { kind: 'kill' });
      b.ws.send('[49]');
      b.ws.send('[50]');
      expect(await b.closed).toBe(1006);
      expect(b.got).toEqual(['[49]']);
      proxy.refuse(5000);
      const refused = new WebSocket(proxy.url, ['wamp.2.json']);
      // Node 26 fires `error` then `close` 1006; Node 22.13's undici fires only `error` for a socket that never opens
      // (readyState stays CONNECTING) — the first of the two ends it, as in src/transport/websocket.ts
      const ended = await new Promise<string>((resolve) => {
        refused.addEventListener('error', () => {
          resolve('error');
        });
        refused.addEventListener('close', (e) => {
          resolve(`close ${String(e.code)}`);
        });
      });
      expect(['error', 'close 1006']).toContain(ended);
    } finally {
      await proxy.stop();
    }
  });

  test('a client that gives up on a stalled upgrade frees its socket in the proxy', async () => {
    const proxy = await ChaosProxy.start({ target });
    const tcp = (): number => process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;
    try {
      const before = tcp();
      proxy.stallUpgrade(Number.POSITIVE_INFINITY);
      const stalled = Array.from({ length: 3 }, () => new WebSocket(proxy.url, ['wamp.2.json']));
      for (const ws of stalled) ws.addEventListener('error', () => undefined);
      await wait(300);
      expect(tcp()).toBeGreaterThan(before);
      for (const ws of stalled) ws.close();
      // Node 22.13's undici lets go of its end within ~10 s; the proxy's end follows the client's FIN
      for (let i = 0; i < 150 && tcp() > before; i++) await wait(100);
      expect(tcp()).toBeLessThanOrEqual(before);
    } finally {
      await proxy.stop();
    }
  }, 30000);

  test('corruption produces a different frame', () => {
    const text = JSON.stringify([50, 1, {}, ['x']]);
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    expect(corruptText(text, 'json', random)).not.toBe(text);
    expect(corruptText(text, 'bytes', random)).not.toBe(text);
  });
});
