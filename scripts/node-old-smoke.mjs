#!/usr/bin/env node
// Runtime floor smoke: `engines: >=22` executed, not just claimed. The packed tarball is unpacked into
// node_modules/.cache/thruway-node-old, and plain Node 22.0.0 and 22.4.0 (no test runner) load every entry point
// through `import` and `require`, run a client against a real WebSocket server (the public testing kit's router behind
// `ws`, run by the current Node) with Node's global WebSocket — handshake, call, registration, topic, close, natural
// exit — and a testing-kit scenario on the virtual clock (drop + reconnect). Node 22.0–22.3 print undici's "WebSockets
// are experimental" warning once (Node's, cosmetic, documented); 22.4 must print nothing.
//
//   node scripts/node-old-smoke.mjs <thruway.js-x.y.z.tgz>
//
// The binaries come from NODE_22_0_0 and NODE_22_4_0 (paths to `node`; the package workflow installs them with
// actions/setup-node). Without them the step is SKIPPED (exit 3; a failure with CI=true).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unavailable } from './package-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);

const tarball = process.argv[2];
if (tarball === undefined || !existsSync(tarball)) {
  console.error('usage: node scripts/node-old-smoke.mjs <packed thruway.js tarball>');
  process.exit(2);
}
const TARGETS = [
  { version: '22.0.0', env: 'NODE_22_0_0', warns: true },
  { version: '22.4.0', env: 'NODE_22_4_0', warns: false },
];
const missing = TARGETS.filter((t) => {
  const bin = process.env[t.env];
  return bin === undefined || !existsSync(bin);
});
if (missing.length > 0) {
  unavailable(
    `node-old-smoke: no Node ${missing.map((t) => t.version).join('/')} binary (set ${missing.map((t) => `${t.env}=/path/to/node`).join(' ')})`,
  );
}

rmSync('node_modules/.cache/thruway-node-old', { recursive: true, force: true });
const dir = path.join(ROOT, 'node_modules/.cache/thruway-node-old');
mkdirSync(path.join(dir, 'node_modules/thruway.js'), { recursive: true });
if (
  spawnSync('tar', ['-xzf', tarball, '-C', path.join(dir, 'node_modules/thruway.js'), '--strip-components', '1'])
    .status !== 0
) {
  console.error('node-old-smoke: could not unpack the tarball');
  process.exit(1);
}
writeFileSync(path.join(dir, 'package.json'), '{ "name": "node-old-smoke", "private": true }\n');

const ROUTER = `
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('ws');
const { createTestRouter } = await import('thruway.js/testing');
const router = createTestRouter();
router.procedure('com.example.add', (args) => args[0] + args[1]);
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
wss.on('listening', () => console.log(JSON.stringify({ port: wss.address().port })));
`;

/** The smoke, as ESM (`load` imports) or CJS (`load` requires). @param {string} load */
const SMOKE = (load) => `
${load}
const first = (o) => new Promise((resolve, reject) => { const s = o.subscribe({ next: (v) => { resolve(v); Promise.resolve().then(() => s.unsubscribe()); }, error: reject }); });
(async () => {
  const out = { node: process.version, entries: Object.keys(root).length + Object.keys(auth).length + Object.keys(testing).length + Object.keys(rx).length };
  // a real socket: Node's global WebSocket against the ws server
  const client = new root.Client(process.env.URL, 'realm1');
  const events = [];
  client.register('com.old.double', (inv) => inv.args[0] * 2).subscribe({ error: () => {} });
  client.topic('com.old.topic').subscribe({ next: (e) => events.push(e.args[0]), error: () => {} });
  out.added = (await first(client.call('com.example.add', [2, 3]))).args;
  out.doubled = (await first(client.call('com.old.double', [21]))).args;
  await first(client.publish('com.old.topic', ['hi'], {}, { acknowledge: true, exclude_me: false }));
  for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  out.events = events;
  await client.close();
  // the testing kit on the virtual clock: a router drop and the reconnect
  const clock = testing.createVirtualClock({ seed: 2 });
  const router = testing.createTestRouter({ clock });
  router.procedure('com.example.add', (args) => args[0] + args[1]);
  const sim = new root.Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
  const opens = [];
  sim.onOpen.subscribe((s) => opens.push(s.id));
  await clock.advance(10);
  router.drop();
  await clock.advance(10000);
  const again = first(sim.call('com.example.add', [1, 1]));
  await clock.advance(10);
  out.reconnected = [opens.length, (await again).args];
  const closed = sim.close();
  await clock.runUntilIdle();
  await closed;
  out.pending = clock.pendingTimers;
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exitCode = 1; });
`;
writeFileSync(path.join(dir, 'router.mjs'), ROUTER);
writeFileSync(
  path.join(dir, 'smoke.mjs'),
  SMOKE(
    "import * as root from 'thruway.js'; import * as auth from 'thruway.js/auth'; import * as testing from 'thruway.js/testing'; import * as rx from 'thruway.js/rxjs';",
  ),
);
writeFileSync(
  path.join(dir, 'smoke.cjs'),
  SMOKE(
    "const root = require('thruway.js'); const auth = require('thruway.js/auth'); const testing = require('thruway.js/testing'); const rx = require('thruway.js/rxjs');",
  ),
);

const router = spawn(process.execPath, ['router.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
/** @param {string} text @returns {unknown} */
function parseJson(text) {
  return JSON.parse(text);
}
/** @returns {Promise<number>} the router's port, from its first stdout line */
function routerPort() {
  return new Promise((resolve, reject) => {
    router.stdout.setEncoding('utf8').once('data', (line) => {
      const message = parseJson(String(line));
      resolve(typeof message === 'object' && message !== null && 'port' in message ? Number(message.port) : NaN);
    });
    router.once('exit', () => {
      reject(new Error('node-old-smoke: the router exited'));
    });
  });
}
const port = await routerPort();

let failed = false;
try {
  for (const target of TARGETS) {
    const bin = /** @type {string} */ (process.env[target.env]);
    for (const file of ['smoke.mjs', 'smoke.cjs']) {
      const result = spawnSync(bin, [file], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, URL: `ws://127.0.0.1:${String(port)}/` },
      });
      const line = result.stdout.split('\n').find((l) => l.startsWith('{')) ?? '{}';
      const out = parseJson(line);
      const expected = {
        node: `v${target.version}`,
        entries: 13 + 3 + 2 + 1,
        added: [5],
        doubled: [42],
        events: ['hi'],
        reconnected: [2, [2]],
        pending: 0,
      };
      const stderr = result.stderr.trim();
      const warned = stderr.includes('WebSockets are experimental');
      const problems = [];
      if (result.status !== 0) problems.push(`exit ${String(result.status ?? result.signal)}`);
      if (JSON.stringify(out) !== JSON.stringify(expected)) {
        problems.push(`got ${JSON.stringify(out)}, expected ${JSON.stringify(expected)}`);
      }
      if (target.warns && !warned)
        problems.push("no undici 'WebSockets are experimental' warning (documented for 22.0–22.3)");
      const otherOutput = stderr
        .split('\n')
        .filter((l) => l !== '' && !/WebSockets are experimental|--trace-warnings/.test(l));
      if (otherOutput.length > 0) problems.push(`unexpected stderr:\n${otherOutput.join('\n')}`);
      console.log(
        `node-old-smoke: Node ${target.version} ${file}: ${problems.length === 0 ? `OK${warned ? ' (undici experimental warning, as documented)' : ''}` : `FAILED\n  ${problems.join('\n  ')}`}`,
      );
      if (problems.length > 0) failed = true;
    }
  }
} finally {
  router.kill();
}
if (failed) {
  console.error('node-old-smoke: FAILED');
  process.exit(1);
}
console.log('node-old-smoke: passed');
