// Packed-tarball smoke: the tarball of this run (test/package/global-setup.ts) lists exactly files.snapshot.txt and
// carries no debug strings; installed into a directory, every entry point loads through `import` and `require` with the
// same names, deep paths are closed by `exports`, a real Client (ESM and CJS) does a handshake, call, registration and
// topic against the reference server over Node's global WebSocket, and the UMD bundles evaluated in a bare `vm` context
// expose the global `thruway` (with `thruway.auth`) and define `Symbol.observable` at load.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { startReferenceServer, type ReferenceServer } from '../helpers/ws-reference-server.js';
import { installTarball, jsonLines, REPO, runNode, scratch, writeFiles } from './helpers.js';

const tarball = inject('tarball');
let dir: string;
let pkg: string;
let server: ReferenceServer;

beforeAll(async () => {
  dir = scratch('smoke');
  pkg = installTarball(tarball, dir);
  writeFiles(dir, { 'package.json': JSON.stringify({ name: 'consumer', private: true }) });
  server = await startReferenceServer();
  server.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
});
afterAll(async () => {
  await server.close();
});

const ENTRIES = ['thruway.js', 'thruway.js/auth', 'thruway.js/testing', 'thruway.js/rxjs'];
const ROOT_EXPORTS = [
  'AbortError',
  'AuthenticationError',
  'CanceledError',
  'Client',
  'ConnectionClosedError',
  'ConnectionLostError',
  'ProtocolError',
  'TimeoutError',
  'WampError',
  'Yield',
  'isThruwayError',
  'isWampError',
  'jsonSerializer',
];

describe('the tarball', () => {
  test('lists exactly test/package/files.snapshot.txt', () => {
    const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line !== '' && !line.endsWith('/'))
      .map((line) => line.replace(/^package\//, ''))
      .sort();
    const snapshot = readFileSync(path.join(REPO, 'test/package/files.snapshot.txt'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .sort();
    expect(listed).toEqual(snapshot);
    expect(listed).toEqual(expect.arrayContaining(['package.json', 'LICENSE', 'dist/cjs/package.json']));
    expect(listed.filter((f) => /^(test|scripts|node_modules)\/|\.tgz$|tsconfig/.test(f))).toEqual([]);
  });

  test('no shipped code holds a debug string: console.log, outbound msg, debugger, .only(, inline source maps', () => {
    const offenders: string[] = [];
    const listed = readFileSync(path.join(REPO, 'test/package/files.snapshot.txt'), 'utf8').split('\n');
    for (const file of listed.filter((f) => /\.(?:[cm]?js|ts|map)$/.test(f))) {
      const text = readFileSync(path.join(pkg, file), 'utf8');
      for (const marker of ['console.log', 'outbound msg', 'debugger', '.only(', 'sourceMappingURL=data:']) {
        if (text.includes(marker)) offenders.push(`${file}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('package.json: dual entry points, no dependencies, Node >= 22, the ponyfill as the only side effect', () => {
    const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['type']).toBe('module');
    expect(manifest['engines']).toEqual({ node: '>=22' });
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['sideEffects']).toEqual([
      './dist/esm/observable/symbol-observable.js',
      './dist/cjs/observable/symbol-observable.js',
    ]);
    expect(Object.keys(manifest['exports'] as object)).toEqual([
      '.',
      './auth',
      './rxjs',
      './testing',
      './package.json',
    ]);
    expect(JSON.parse(readFileSync(path.join(pkg, 'dist/cjs/package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
    expect(JSON.parse(readFileSync(path.join(pkg, 'dist/browser/package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
  });
});

describe('installed', () => {
  test('every entry point loads with import and require, with the same names; deep paths are not exported', async () => {
    writeFiles(dir, {
      'entries.mjs': `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const out = {};
        for (const e of ${JSON.stringify(ENTRIES)}) out[e] = { esm: Object.keys(await import(e)).sort(), cjs: Object.keys(require(e)).sort() };
        const deep = [];
        for (const p of ['thruway.js/dist/esm/index.js', 'thruway.js/src/index.ts', 'thruway.js/dist/cjs/client.js']) {
          try { await import(p); deep.push(p + ': loaded'); } catch (e) { deep.push(e.code); }
        }
        const manifest = require('thruway.js/package.json');
        console.log(JSON.stringify({ out, deep, version: manifest.version }));
      `,
    });
    const r = await runNode(['entries.mjs'], { cwd: dir });
    expect(r.status, r.stderr).toBe(0);
    const [result] = jsonLines(r.stdout) as [{ out: Record<string, { esm: string[]; cjs: string[] }>; deep: string[] }];
    for (const entry of ENTRIES) expect(result.out[entry]?.esm, entry).toEqual(result.out[entry]?.cjs);
    expect(result.out['thruway.js']?.esm).toEqual(ROOT_EXPORTS);
    expect(result.out['thruway.js/auth']?.esm).toEqual(['cryptosign', 'ticket', 'wampcra']);
    expect(result.out['thruway.js/testing']?.esm).toEqual(['createTestRouter', 'createVirtualClock']);
    expect(result.out['thruway.js/rxjs']?.esm).toEqual(['rxClient']);
    expect(result.deep).toEqual([
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    ]);
  });

  const LIVE = (load: string) => `
    ${load}
    const first = (o) => new Promise((resolve, reject) => { const s = o.subscribe({ next: (v) => { resolve(v); queueMicrotask(() => s.unsubscribe()); }, error: reject }); });
    const client = new Client(process.env.URL, 'realm1');
    const events = [];
    client.register('com.smoke.double', (inv) => inv.args[0] * 2).subscribe({ error: () => {} });
    client.topic('com.smoke.topic').subscribe({ next: (e) => events.push(e.args[0]), error: () => {} });
    (async () => {
      const session = await first(client.onOpen);
      const added = await first(client.call('com.example.add', [2, 3]));
      const doubled = await first(client.call('com.smoke.double', [21]));
      await first(client.publish('com.smoke.topic', ['hi'], {}, { acknowledge: true, exclude_me: false }));
      for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      await client.close();
      console.log(JSON.stringify({ session: typeof session.id, added: added.args, doubled: doubled.args, events }));
    })().catch((e) => { console.error(e); process.exitCode = 1; });
  `;

  test.for([
    ['ESM', 'live.mjs', LIVE(`import { Client } from 'thruway.js';`)],
    ['CJS', 'live.cjs', LIVE(`const { Client } = require('thruway.js');`)],
  ] as const)(
    '%s: a real Client does a handshake, call, registration and topic, and the process exits',
    async ([, file, code]) => {
      writeFiles(dir, { [file]: code });
      const r = await runNode([file], { cwd: dir, env: { ...process.env, URL: server.url }, timeout: 15_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(jsonLines(r.stdout)).toEqual([{ session: 'number', added: [5], doubled: [42], events: ['hi'] }]);
    },
  );

  test.for(['thruway.min.js', 'thruway.js'])(
    'dist/browser/%s in a bare vm context: global thruway with every root export and thruway.auth; Symbol.observable defined at load',
    (file) => {
      const context = vm.createContext({});
      expect(vm.runInContext('typeof Symbol.observable', context)).toBe('undefined');
      vm.runInContext(readFileSync(path.join(pkg, 'dist/browser', file), 'utf8'), context, { filename: file });
      const keys = vm.runInContext('Object.keys(thruway).sort()', context) as string[];
      expect(keys).toEqual([...ROOT_EXPORTS, 'auth'].sort());
      expect(vm.runInContext('Object.keys(thruway.auth).sort()', context)).toEqual(['cryptosign', 'ticket', 'wampcra']);
      expect(vm.runInContext('typeof Symbol.observable', context)).toBe('symbol');
      expect(
        vm.runInContext("Symbol.observable === Symbol.for('https://github.com/benlesh/symbol-observable')", context),
      ).toBe(true);
      expect(
        vm.runInContext(
          "new thruway.WampError('a.b').name + ' ' + thruway.isWampError(new thruway.WampError('a.b'))",
          context,
        ),
      ).toBe('WampError true');
    },
  );

  test('dist/browser/thruway.mjs imports in Node with the root exports and auth', async () => {
    writeFiles(dir, {
      'bundle.mjs': `
        const m = await import(${JSON.stringify(path.join(pkg, 'dist/browser/thruway.mjs'))});
        console.log(JSON.stringify({ keys: Object.keys(m).sort(), auth: Object.keys(m.auth).sort(), symbol: typeof Symbol.observable }));
      `,
    });
    const r = await runNode(['bundle.mjs'], { cwd: dir });
    expect(r.status, r.stderr).toBe(0);
    expect(jsonLines(r.stdout)).toEqual([
      { keys: [...ROOT_EXPORTS, 'auth'].sort(), auth: ['cryptosign', 'ticket', 'wampcra'], symbol: 'symbol' },
    ]);
  });
});
