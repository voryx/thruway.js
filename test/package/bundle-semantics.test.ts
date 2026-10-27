// Bundle semantics: rspack + swc must give the browser bundles exactly the semantics of the tsc builds (class fields
// with `useDefineForClassFields: false`, minifier-safe names, the side-effect module).
// - The unit tests of the error classes, the Observable and Yield (test/unit/{errors,observable,yield}.test.ts) run
//   unchanged against an rspack build of those modules with the bundles' own module rules, unminified and minified
//   (a nested vitest run, test/package/bundle-semantics.vitest.config.ts); a deliberately corrupted build makes that
//   run fail, so it really runs against the bundle.
// - The shipped dist/browser/thruway.mjs and the UMD thruway.min.js: the same sim scenario (testing kit router,
//   virtual clock: handshake, register, topic, calls, a router drop and the reconnect, close) gives frame for frame
//   and notification for notification what the src client gives; their error classes and Yield have the tsc
//   shapes; their Observables speak the interop protocols.
// - The Symbol.observable ponyfill is pinned as a side effect: a bundle whose entry only imports the module for its
//   side effect defines Symbol.observable (and does not without the rule).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import vm from 'node:vm';
import { rspack, type RspackOptions, type Stats } from '@rspack/core';
import { beforeAll, describe, expect, test } from 'vitest';
import * as srcErrors from '../../src/errors.js';
import * as srcIndex from '../../src/index.js';
import { createTestRouter, createVirtualClock } from '../../src/testing/index.js';
import { minimizer, moduleRules, resolve } from '../../rspack.config.js';
import { REPO, runNode, scratch, writeFiles } from './helpers.js';

async function build(options: RspackOptions): Promise<void> {
  await new Promise<void>((done, fail) => {
    const callback = (error: Error | null, stats?: Stats): void => {
      if (error) fail(error);
      else if (stats?.hasErrors()) fail(new Error(stats.toString({ all: false, errors: true })));
      else done();
    };
    rspack({ context: REPO, mode: 'production', target: ['web', 'es2020'], resolve, ...options }, callback);
  });
}

/** The modules the nested unit run imports, built as one ESM file each with the bundles' rules. */
async function semanticsBundle(minify: boolean): Promise<string> {
  const out = scratch(minify ? 'semantics-min' : 'semantics');
  await build({
    entry: {
      errors: './src/errors.ts',
      yield: './src/yield.ts',
      observable: './src/observable/observable.ts',
      'symbol-observable': './src/observable/symbol-observable.ts',
    },
    module: { rules: moduleRules },
    output: { path: out, filename: '[name].mjs', module: true, library: { type: 'modern-module' } },
    optimization: minify ? minimizer() : { minimize: false },
  });
  return out;
}

async function nestedUnitRun(dir: string) {
  // Without colour: vitest colours its summary on CI runners, and the codes would break the match on it below.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', THRUWAY_SEMANTICS_DIR: dir, FC_NUM_RUNS: '50' };
  delete env['FORCE_COLOR'];
  const r = await runNode(
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'test/package/bundle-semantics.vitest.config.ts'],
    { env, timeout: 120_000 },
  );
  return { ...r, output: stripVTControlCharacters(r.stdout + r.stderr) };
}

describe('the unit tests of errors, Observable and Yield against rspack builds of those modules', () => {
  test.for([false, true])('minified: %s', async (minify) => {
    const r = await nestedUnitRun(await semanticsBundle(minify));
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/Test Files {2}3 passed \(3\)/);
  });

  test('a corrupted build fails that run (the nested run really imports the bundle)', async () => {
    const dir = await semanticsBundle(false);
    const file = path.join(dir, 'errors.mjs');
    const code = readFileSync(file, 'utf8');
    expect(code).toContain("'ConnectionLostError'");
    writeFileSync(file, code.replaceAll("'ConnectionLostError'", "'ConnectionLostErr0r'"));
    const r = await nestedUnitRun(dir);
    expect(r.status).toBe(1);
    expect(r.output).toContain('ConnectionLostErr0r');
  });

  // every alias of the nested config, not only errors: a bundle file that throws when it is evaluated fails the run
  test.for(['errors.mjs', 'yield.mjs', 'observable.mjs', 'symbol-observable.mjs'])(
    'every aliased module comes from the build: %s',
    async (file) => {
      const dir = await semanticsBundle(false);
      const code = readFileSync(path.join(dir, file), 'utf8');
      writeFileSync(path.join(dir, file), `${code}\nthrow new Error('evaluated ${file} of the build');\n`);
      const r = await nestedUnitRun(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain(`evaluated ${file} of the build`);
    },
  );
});

type Lib = typeof srcIndex;
let mjs: Lib;
let umd: Lib;
beforeAll(async () => {
  mjs = (await import(pathToFileURL(path.join(REPO, 'dist/browser/thruway.mjs')).href)) as Lib;
  // the UMD as a CommonJS consumer loads it, in this realm (the testing kit and the virtual clock come from src)
  const module = { exports: {} as unknown };
  const load = vm.compileFunction(readFileSync(path.join(REPO, 'dist/browser/thruway.min.js'), 'utf8'), [
    'module',
    'exports',
  ]) as (module: object, exports: unknown) => void;
  load(module, module.exports);
  umd = module.exports as Lib;
});

/** A JSON-able view of a notification value (errors of any copy by brand fields). */
function plain(value: unknown): unknown {
  if (srcErrors.isThruwayError(value)) {
    const e = value as unknown as Record<string, unknown>;
    return { error: e['name'], code: e['code'], message: e['message'], uri: e['uri'], reason: e['reason'] };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'signal')
        .map(([k, v]) => [k, plain(v)]),
    );
  }
  return typeof value === 'function' ? 'function' : value;
}

/** One deterministic sim scenario with a given copy of the root entry. */
async function scenario(lib: Lib) {
  const clock = createVirtualClock({ seed: 7 });
  const router = createTestRouter({ clock });
  router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
  const client = new lib.Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
  const log: unknown[] = [];
  const record = (tag: string) => ({
    next: (v: unknown) => log.push([tag, 'next', plain(v)]),
    error: (e: unknown) => log.push([tag, 'error', plain(e)]),
    complete: () => log.push([tag, 'complete']),
  });
  client.status.subscribe(record('status'));
  client.onOpen.subscribe(record('open'));
  client.onClose.subscribe(record('close'));
  client.register('com.sim.echo', (inv) => new lib.Yield(inv.args, { echoed: true })).subscribe(record('register'));
  client.topic('com.sim.topic').subscribe(record('topic'));
  await clock.advance(10);
  client.call('com.example.add', [2, 3]).subscribe(record('add'));
  client.call('com.sim.echo', ['x']).subscribe(record('echo'));
  client.call('com.sim.missing').subscribe(record('missing'));
  client.publish('com.sim.topic', [1], {}, { acknowledge: true, exclude_me: false }).subscribe(record('publish'));
  await clock.advance(100);
  router.drop();
  await clock.advance(10_000);
  client.call('com.example.add', [5, 5]).subscribe(record('add-again'));
  await clock.advance(100);
  const closed = client.close();
  await clock.runUntilIdle();
  await closed;
  log.push(['pendingTimers', clock.pendingTimers]);
  return { log, frames: router.frames.map((f) => [f.connection, f.direction, f.frame, f.at]) };
}

describe('the shipped bundles behave like the src build', () => {
  test.for(['thruway.mjs', 'thruway.min.js'] as const)(
    '%s: the sim scenario gives the same frames and notifications as src',
    async (name) => {
      const expected = await scenario(srcIndex);
      expect(expected.log).toContainEqual(['add', 'next', expect.objectContaining({ args: [5] })]);
      expect(expected.log).toContainEqual(['add-again', 'next', expect.objectContaining({ args: [10] })]);
      expect(expected.log.filter((l) => (l as unknown[])[0] === 'open')).toHaveLength(2); // reconnected
      expect(expected.log.at(-1)).toEqual(['pendingTimers', 0]);
      expect(await scenario(name === 'thruway.mjs' ? mjs : umd)).toEqual(expected);
    },
  );

  test.for(['thruway.mjs', 'thruway.min.js'] as const)(
    '%s: error classes and Yield have the tsc build’s shape, name, code and brand',
    (name) => {
      const lib = name === 'thruway.mjs' ? mjs : umd;
      const build = (m: Lib) => [
        new m.WampError('wamp.error.not_authorized', ['denied'], { a: 1 }, { d: 2 }),
        new m.ConnectionLostError({ reason: 'wamp.close.close_realm', closeCode: 1006, sessionId: 5 }),
        new m.ConnectionClosedError({ gaveUp: true }),
        new m.TimeoutError({ timer: 'connect', timeout: 10 }),
        new m.AbortError({ reason: 'wamp.error.no_such_realm', details: { message: 'm' } }),
        new m.ProtocolError({ message: 'bad', frame: 'x'.repeat(300) }),
        new m.CanceledError(),
        new m.AuthenticationError({ message: 'no answer', authMethod: 'ticket' }),
        new m.Yield([1], { k: 2 }),
      ];
      const shape = (value: object) => ({
        own: Object.getOwnPropertyNames(value)
          .filter((key) => key !== 'stack')
          .sort()
          .map((key) => [key, (value as Record<string, unknown>)[key]]),
        symbols: Object.getOwnPropertySymbols(value).map((s) => [s.description, (value as Record<symbol, unknown>)[s]]),
        name: (value as { name?: unknown }).name,
        protoName: (Object.getPrototypeOf(value) as { constructor: { name: string } }).constructor.name,
      });
      const ours = build(lib);
      expect(ours.map(shape)).toEqual(build(srcIndex).map(shape));
      for (const error of ours.slice(0, -1)) expect(srcErrors.isThruwayError(error)).toBe(true);
      expect(srcIndex.isWampError(ours[0])).toBe(true);
      expect(lib.isWampError(new srcIndex.WampError('a.b'))).toBe(true);
    },
  );

  test.for(['thruway.mjs', 'thruway.min.js'] as const)(
    "%s: Observables speak Symbol.observable, '@@observable' and the async iterator",
    async (name) => {
      const lib = name === 'thruway.mjs' ? mjs : umd;
      const client = new lib.Client('ws://127.0.0.1:9/', 'realm1', { autoOpen: false });
      const status = client.status as unknown as Record<PropertyKey, () => unknown> & AsyncIterable<unknown>;
      expect(typeof Symbol.observable).toBe('symbol');
      expect(status[Symbol.observable]?.()).toBe(status);
      expect(status['@@observable']?.()).toBe(status);
      const iterator = status[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: { state: 'closed' } });
      await iterator.return?.();
      const seen: unknown[] = [];
      const sub = client.status.subscribe((s) => seen.push(s));
      sub.unsubscribe();
      sub.unsubscribe();
      expect([seen, sub.closed]).toEqual([[{ state: 'closed' }], true]);
      await client.close();
    },
  );
});

describe("the bundles' swc rule has tsc's class-field semantics (useDefineForClassFields: false)", () => {
  // Two places where define semantics differ observably: a field the subclass only declares is reset to undefined
  // after a base constructor set it, and a declared-only field becomes an own property. The fixture lives outside
  // src/, so the rule's `include` is pointed at it; the loader and its options are the bundles' own.
  const FIXTURE = `
    class Base { constructor() { this.init(); } init(): void {} }
    export class Derived extends Base { value!: string; override init(): void { this.value = 'set by the base'; } }
    export class Plain { declared?: string; }
  `;
  test.for([false, true])('minified: %s', async (minify) => {
    const out = scratch('class-fields');
    writeFiles(out, { 'fixture.ts': FIXTURE });
    const rules = moduleRules.map((rule) => ({ ...rule, include: [out] }));
    await build({
      entry: { fixture: path.join(out, 'fixture.ts') },
      module: { rules },
      output: { path: out, filename: 'fixture.mjs', module: true, library: { type: 'modern-module' } },
      optimization: minify ? minimizer() : { minimize: false },
    });
    const { Derived, Plain } = (await import(pathToFileURL(path.join(out, 'fixture.mjs')).href)) as {
      Derived: new () => { value: unknown };
      Plain: new () => object;
    };
    expect([new Derived().value, 'declared' in new Plain()]).toEqual(['set by the base', false]);
  });
});

describe('the Symbol.observable ponyfill is a pinned side effect of the bundles', () => {
  async function sideEffectOnly(rules: NonNullable<RspackOptions['module']>): Promise<string> {
    const out = scratch('ponyfill-entry');
    writeFiles(out, {
      'entry.mjs': `import ${JSON.stringify(path.join(REPO, 'src/observable/symbol-observable.js'))};\n`,
    });
    await build({
      entry: { entry: path.join(out, 'entry.mjs') },
      module: rules,
      output: { path: out, filename: 'bundle.js', library: { type: 'umd', name: 'probe' }, globalObject: 'globalThis' },
      optimization: minimizer(),
    });
    const context = vm.createContext({});
    vm.runInContext(readFileSync(path.join(out, 'bundle.js'), 'utf8'), context);
    return vm.runInContext('typeof Symbol.observable', context) as string;
  }

  test('an entry that only imports the module for its side effect defines Symbol.observable', async () => {
    expect(await sideEffectOnly({ rules: moduleRules })).toBe('symbol');
  });

  test('control: without the sideEffects rule rspack drops that import (why the rule exists)', async () => {
    const withoutRule = moduleRules.filter((rule) => !('sideEffects' in rule));
    expect(withoutRule).toHaveLength(moduleRules.length - 1);
    expect(await sideEffectOnly({ rules: withoutRule })).toBe('undefined');
  });
});
