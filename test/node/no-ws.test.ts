// No `ws` anywhere: the packed tarball is installed into a temporary directory OUTSIDE this repository (so Node's
// lookup cannot reach the repo's dev `ws`), where neither `ws` nor `rxjs` is resolvable; there every entry point loads
// (ESM and CJS) and a real Client does a handshake and a call over Node's global WebSocket against the reference
// server, then exits. No emitted file imports `ws`.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { startReferenceServer, type ReferenceServer } from '../helpers/ws-reference-server.js';
import { installTarball, jsonLines, REPO, runNode, writeFiles } from '../package/helpers.js';

let dir: string;
let server: ReferenceServer;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'thruway-no-ws-'));
  installTarball(inject('tarball'), dir);
  server = await startReferenceServer();
  server.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
});
afterAll(async () => {
  await server.close(); // the directory stays in the OS temp dir (never a recursive delete of a computed path)
});

const ESM = `
const missing = [];
for (const name of ['ws', 'rxjs']) {
  try { await import(name); } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') missing.push(name); }
}
const root = await import('thruway.js');
const entries = {};
for (const sub of ['thruway.js', 'thruway.js/auth', 'thruway.js/testing', 'thruway.js/rxjs']) entries[sub] = Object.keys(await import(sub)).sort();
const client = new root.Client(process.env.URL, 'realm1');
const result = await new Promise((resolve, reject) => client.call('com.example.add', [2, 3]).subscribe({ next: resolve, error: reject }));
await client.close();
console.log(JSON.stringify({ missing, entries, args: result.args, ws: typeof globalThis.WebSocket }));
`;

const CJS = `
const missing = [];
for (const name of ['ws', 'rxjs']) {
  try { require(name); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') missing.push(name); }
}
const root = require('thruway.js');
const entries = {};
for (const sub of ['thruway.js', 'thruway.js/auth', 'thruway.js/testing', 'thruway.js/rxjs']) entries[sub] = Object.keys(require(sub)).sort();
const client = new root.Client(process.env.URL, 'realm1');
client.call('com.example.add', [2, 3]).subscribe({
  next: async (result) => {
    await client.close();
    console.log(JSON.stringify({ missing, entries, args: result.args, ws: typeof globalThis.WebSocket }));
  },
  error: (e) => { console.error(e); process.exitCode = 1; },
});
`;

describe('no ws installed', () => {
  test.for([
    ['ESM', 'no-ws.mjs', ESM],
    ['CJS', 'no-ws.cjs', CJS],
  ] as const)(
    '%s: every entry point loads, and a client connects with the global WebSocket',
    async ([, file, code]) => {
      writeFiles(dir, { [file]: code });
      const r = await runNode([file], { cwd: dir, env: { ...process.env, URL: server.url }, timeout: 20_000 });
      expect(r.status, r.stderr).toBe(0);
      const [out] = jsonLines(r.stdout);
      expect(out?.['missing']).toEqual(['ws', 'rxjs']);
      expect(out?.['args']).toEqual([5]);
      expect(out?.['ws']).toBe('function');
      const entries = out?.['entries'] as Record<string, string[]>;
      expect(entries['thruway.js']).toContain('Client');
      expect(entries['thruway.js/auth']).toEqual(['cryptosign', 'ticket', 'wampcra']);
      expect(entries['thruway.js/testing']).toEqual(['createTestRouter', 'createVirtualClock']);
      expect(entries['thruway.js/rxjs']).toEqual(['rxClient']);
      expect(r.ms).toBeLessThan(10_000);
    },
  );

  test('no emitted file imports or requires ws', () => {
    const offenders: string[] = [];
    const distDir = path.join(REPO, 'dist');
    for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:m?js|cjs|d\.ts)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (/(?:from\s*|require\(\s*|import\(\s*)['"]ws['"]/.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
