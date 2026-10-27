// The dual-package hazard: the installed package's ESM copy (`import`) and CJS copy (`require`) loaded in ONE plain
// Node process — two copies of every class — and objects crossing them: a client of one copy whose handlers return a
// `Yield`, throw a `WampError` or return an Observable made by the other copy, and whose `onChallenge` answers with an
// Observable of the other copy; the Symbol.observable ponyfill evaluated twice. Each must behave exactly as with one
// copy (brand checks and the interop symbol, never `instanceof`).
import { beforeAll, expect, inject, test } from 'vitest';
import { installTarball, jsonLines, runNode, scratch, writeFiles } from './helpers.js';

let dir: string;
beforeAll(() => {
  dir = scratch('hazard');
  installTarball(inject('tarball'), dir);
});

const HAZARD = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const symbolBefore = typeof Symbol.observable;
const esm = await import('thruway.js');
const symbolAfterEsm = Symbol.observable;
const cjs = require('thruway.js');
const symbolAfterCjs = Symbol.observable;
const cjsTesting = require('thruway.js/testing');
// each copy's internal Observable class (the same module instances the copies use)
const pkg = require.resolve('thruway.js/package.json').replace(/package\\.json$/, '');
const { Observable: EsmObservable } = await import(pathToFileURL(pkg + 'dist/esm/observable/observable.js').href);
const { Observable: CjsObservable } = require(pkg + 'dist/cjs/observable/observable.js');
const copies = { esm: { lib: esm, Observable: EsmObservable }, cjs: { lib: cjs, Observable: CjsObservable } };

const out = {
  symbol: { before: symbolBefore, sameAfterBoth: symbolAfterEsm === symbolAfterCjs && typeof symbolAfterCjs === 'symbol' },
  distinct: esm.Client !== cjs.Client && esm.WampError !== cjs.WampError && EsmObservable !== CjsObservable,
  instanceofAcross: new esm.WampError('a.b') instanceof cjs.WampError,
  guardsAcross: cjs.isWampError(new esm.WampError('a.b')) && esm.isThruwayError(new cjs.ConnectionLostError()),
  runs: {},
};

const first = (o) => new Promise((resolve, reject) => { const s = o.subscribe({ next: (v) => { resolve(v); queueMicrotask(() => s.unsubscribe()); }, error: reject }); });
const all = (o) => new Promise((resolve, reject) => { const values = []; o.subscribe({ next: (v) => values.push(v), error: reject, complete: () => resolve(values) }); });
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: { name: e.name, uri: e.uri, args: e.args, isWamp: esm.isWampError(e) } }));

// callee: a client of copy B (with copy B's router), using objects of copy A; caller: a client of copy A
for (const [a, b] of [['esm', 'cjs'], ['cjs', 'esm']]) {
  const A = copies[a], B = copies[b];
  const router = cjsTesting.createTestRouter({
    authenticate: ({ details }) => (details.authid === 'callee'
      ? { challenge: { method: 'ticket' }, verify: (signature) => (signature === 'secret-from-' + a ? { welcome: { authid: 'callee' } } : { abort: 'wamp.error.not_authorized' }) }
      : { welcome: {} }),
  });
  const options = { WebSocket: router.WebSocket };
  const callee = new B.lib.Client(router.url, 'realm1', {
    ...options,
    authid: 'callee',
    authmethods: ['ticket'],
    // an Observable of copy A as the challenge answer of a client of copy B
    onChallenge: () => new A.Observable((s) => { s.next('secret-from-' + a); s.complete(); }),
  });
  const caller = new A.lib.Client(router.url, 'realm1', options);
  const registered = [
    callee.register('com.hazard.yield', () => new A.lib.Yield([1, 2], { k: 'v' })),
    callee.register('com.hazard.throw', () => { throw new A.lib.WampError('com.hazard.custom', ['x'], { y: 1 }); }),
    callee.register('com.hazard.reject', () => Promise.reject(new A.lib.WampError('com.hazard.rejected'))),
    callee.register('com.hazard.observable', () => new A.Observable((s) => { s.next('p1'); s.next('p2'); s.complete(); })),
  ].map((o) => new Promise((resolve, reject) => o.subscribe({ next: resolve, error: reject }))); // stay registered
  const session = await first(callee.onOpen);
  await Promise.all(registered);
  const result = {
    authid: session.details.authid,
    yield: await settle(first(caller.call('com.hazard.yield')).then((r) => ({ args: r.args, kwargs: r.kwargs }))),
    thrown: await settle(first(caller.call('com.hazard.throw'))),
    rejected: await settle(first(caller.call('com.hazard.reject'))),
    progressive: await settle(all(caller.progressiveCall('com.hazard.observable')).then((rs) => rs.map((r) => [r.args, r.details.progress === true]))),
  };
  await Promise.all([callee.close(), caller.close()]);
  out.runs[a + ' objects in a ' + b + ' client'] = result;
}
console.log(JSON.stringify(out));
`;

test('ESM and CJS copies in one process: Yield, WampError and Observables cross copies; the ponyfill runs twice', async () => {
  writeFiles(dir, { 'hazard.mjs': HAZARD });
  const r = await runNode(['hazard.mjs'], { cwd: dir, timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  const [out] = jsonLines(r.stdout);
  expect(out?.['symbol']).toEqual({ before: 'undefined', sameAfterBoth: true });
  expect(out?.['distinct']).toBe(true);
  expect(out?.['instanceofAcross']).toBe(false); // why the guards use brands
  expect(out?.['guardsAcross']).toBe(true);
  const expected = {
    authid: 'callee',
    yield: { ok: { args: [1, 2], kwargs: { k: 'v' } } },
    thrown: { error: { name: 'WampError', uri: 'com.hazard.custom', args: ['x'], isWamp: true } },
    rejected: { error: { name: 'WampError', uri: 'com.hazard.rejected', args: [], isWamp: true } },
    // the empty final RESULT is not emitted
    progressive: {
      ok: [
        [['p1'], true],
        [['p2'], true],
      ],
    },
  };
  expect(out?.['runs']).toEqual({
    'esm objects in a cjs client': expected,
    'cjs objects in a esm client': expected,
  });
});
