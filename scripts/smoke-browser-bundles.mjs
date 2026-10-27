#!/usr/bin/env node
// Browser-bundle smoke without a test runner: a page served from loopback (Chromium blocks about:blank →
// ws://127.0.0.1) loads dist/browser/thruway.min.js as a classic script and dist/browser/thruway.mjs as a module; in
// Chromium and WebKit (playwright) each bundle does a handshake, a registration and calls against a real WebSocket
// server (the public testing kit's router behind `ws`, run by this Node), and the page checks the globals (`thruway`,
// `thruway.auth`, `Symbol.observable`).
//
//   node scripts/smoke-browser-bundles.mjs [chromium,webkit]       needs `npm run build` and playwright's browsers
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);
const browsers = (process.argv[2] ?? 'chromium,webkit').split(',');

const ROUTER = `
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('ws');
const { createTestRouter } = await import(${JSON.stringify(new URL('../dist/esm/testing/index.js', import.meta.url).href)});
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

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script src="/thruway.min.js"></script>
<script type="module">
  import * as esm from '/thruway.mjs';
  window.__smoke = async (url) => {
    const out = { globals: [typeof window.thruway, Object.keys(window.thruway.auth).sort().join(','), typeof Symbol.observable] };
    for (const [name, lib] of [['umd', window.thruway], ['esm', esm]]) {
      const client = new lib.Client(url, 'realm1');
      const procedure = 'com.smoke.' + name;
      await new Promise((resolve, reject) => client.register(procedure, (inv) => new lib.Yield(inv.args)).subscribe({ next: resolve, error: reject }));
      const call = (uri, args) => new Promise((resolve, reject) => client.call(uri, args).subscribe({ next: (r) => resolve(r.args), error: reject }));
      out[name] = [await call('com.example.add', [2, 3]), await call(procedure, ['hi'])];
      await client.close();
    }
    return out;
  };
  window.__ready = true;
</script>`;

/** @param {string} line @returns {unknown} */
function parseJson(line) {
  return JSON.parse(line);
}

/** Evaluate an expression in the page (Node's lib has no DOM types). @param {import('playwright').Page} page
 *  @param {string} expression @returns {Promise<unknown>} */
async function inPage(page, expression) {
  return page.evaluate(expression);
}

const router = spawn(process.execPath, ['--input-type=module', '-e', ROUTER], { stdio: ['ignore', 'pipe', 'inherit'] });
/** @returns {Promise<number>} */
function routerPort() {
  return new Promise((resolve, reject) => {
    router.stdout.setEncoding('utf8').once('data', (line) => {
      const message = parseJson(String(line));
      resolve(typeof message === 'object' && message !== null && 'port' in message ? Number(message.port) : NaN);
    });
    router.once('exit', () => {
      reject(new Error('smoke-browser-bundles: the router exited'));
    });
  });
}

/** @type {Record<string, [string, string]>} */
const FILES = {
  '/': [PAGE, 'text/html; charset=utf-8'],
  '/thruway.min.js': [readFileSync('dist/browser/thruway.min.js', 'utf8'), 'text/javascript'],
  '/thruway.mjs': [readFileSync('dist/browser/thruway.mjs', 'utf8'), 'text/javascript'],
};
const server = http.createServer((request, response) => {
  const file = FILES[request.url ?? ''];
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': file[1] }).end(file[0]);
});

let failed = false;
try {
  const port = await routerPort();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  const pagePort = typeof address === 'object' && address !== null ? address.port : 0;
  const playwright = await import('playwright');
  for (const name of browsers) {
    if (name !== 'chromium' && name !== 'webkit' && name !== 'firefox') throw new Error(`unknown browser ${name}`);
    const browser = await playwright[name].launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`http://127.0.0.1:${String(pagePort)}/`);
      await page.waitForFunction('window.__ready === true');
      const result = await inPage(page, `window.__smoke(${JSON.stringify(`ws://127.0.0.1:${String(port)}/`)})`);
      const expected = {
        globals: ['object', 'cryptosign,ticket,wampcra', 'symbol'],
        umd: [[5], ['hi']],
        esm: [[5], ['hi']],
      };
      const ok = JSON.stringify(result) === JSON.stringify(expected);
      console.log(
        `smoke-browser-bundles: ${name}: ${ok ? 'OK' : `FAILED\n  got      ${JSON.stringify(result)}\n  expected ${JSON.stringify(expected)}`}`,
      );
      if (!ok) failed = true;
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  console.error(`smoke-browser-bundles: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  router.kill();
  server.close();
}
if (failed) {
  console.error('smoke-browser-bundles: FAILED');
  process.exit(1);
}
console.log('smoke-browser-bundles: passed');
