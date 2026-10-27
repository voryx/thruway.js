// Load order: one fresh Node process per order, because `Symbol.observable` and the interop key each Rx library
// captures at load are per process. Every case loads the built package by its name (`thruway.js`, `thruway.js/testing`,
// `thruway.js/rxjs`: the `exports` map, dist/esm or dist/cjs) and the Rx library in the given order, then wraps
// `client.topic(…)` with that library, receives an EVENT and unsubscribes, which must write UNSUBSCRIBE; `close()` must
// then let the process exit by itself.
//
// What each order must show (the ponyfill rules of src/observable/symbol-observable.ts):
// - thruway.js first: `Symbol.observable` becomes `Symbol.for('https://github.com/benlesh/symbol-observable')`; RxJS 5,
//   6 and 7 loaded later use that symbol.
// - RxJS 5 (or the symbol-observable 1.x ponyfill) first: they set `Symbol.observable = Symbol('observable')` and
//   thruway.js reuses it; both sides agree on that symbol.
// - RxJS 6 / 7 first: they capture `Symbol.observable || '@@observable'` while `Symbol.observable` is still undefined,
//   so they reach our Observable through its `'@@observable'` method.
// - RxJS 9, before or after: `Observable.from(ours)` goes through `Symbol.asyncIterator` (ESM only: its `require`
//   condition points at ESM).
//
// The package is built by the interop project's globalSetup when dist is missing or older than src.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);
const require = createRequire(import.meta.url);
/** symbol-observable as RxJS 5 resolves it (1.0.1, whether hoisted or nested). */
const SYMBOL_OBSERVABLE = createRequire(require.resolve('rxjs5/package.json')).resolve('symbol-observable');
const REGISTERED = 'https://github.com/benlesh/symbol-observable';

type Rx = 'rxjs5' | 'rxjs543' | 'rxjs6' | 'rxjs7' | 'rxjs9';
type Lib = 'thruway' | Rx | 'symbol-observable';
type Format = 'esm' | 'cjs';

interface Case {
  readonly order: readonly Lib[];
  readonly format: Format;
  /** Wrap through `rxClient(client, from)` instead of `from(client.topic(…))`. */
  readonly adapter?: boolean;
}

interface ChildResult {
  /** `Symbol.observable` right before each library was loaded. */
  readonly before: Record<string, string>;
  /** `Symbol.observable` at the end. */
  readonly symbol: string;
  /** Which interop member of our Observable the Rx library called. */
  readonly used: readonly string[];
  readonly got: readonly unknown[];
  readonly unsubscribed: boolean;
  readonly errors: readonly string[];
}

/** The code that loads one library in `format` (assigning `thruway`, `testing`, `adapter` or `rx`). */
function load(lib: Lib, format: Format): string {
  const get = (specifier: string): string =>
    format === 'esm' ? `(await import(${JSON.stringify(specifier)}))` : `require(${JSON.stringify(specifier)})`;
  switch (lib) {
    case 'thruway':
      return `thruway = ${get('thruway.js')}; testing = ${get('thruway.js/testing')}; adapter = ${get('thruway.js/rxjs')};`;
    case 'rxjs5':
    case 'rxjs543': {
      // RxJS 5 style: the Observable class, then the patch that adds Observable.from (passed unbound, as apps do)
      const ext = format === 'esm' ? '.js' : '';
      const observable = `((m) => m.Observable ?? m.default.Observable)(${get(`${lib}/Observable${ext}`)})`;
      return `{ const Observable = ${observable}; ${get(`${lib}/add/observable/from${ext}`)}; rx = { from: Observable.from }; }`;
    }
    case 'rxjs6':
    case 'rxjs7': {
      const m = get(lib === 'rxjs6' ? 'rxjs6' : 'rxjs');
      return `rx = ((m) => ({ from: m.from ?? m.default.from }))(${m});`;
    }
    case 'rxjs9':
      return `${get('rxjs9')}; rx = { from: (x) => globalThis.Observable.from(x), platform: true };`;
    case 'symbol-observable':
      return format === 'esm'
        ? `await import(${JSON.stringify(new URL(`file://${SYMBOL_OBSERVABLE}`).href)});`
        : `require(${JSON.stringify(SYMBOL_OBSERVABLE)});`;
  }
}

function script(c: Case): string {
  const loads = c.order
    .map((lib) => `before[${JSON.stringify(lib)}] = describe(Symbol.observable); ${load(lib, c.format)}`)
    .join('\n');
  const body = `
let thruway, testing, adapter, rx;
const before = {};
const describe = (s) => s === undefined ? 'undefined' : typeof s !== 'symbol' ? typeof s
  : Symbol.keyFor(s) !== undefined ? 'registered:' + Symbol.keyFor(s) : 'unregistered:' + s.description;
const guard = setTimeout(() => { console.error('child: no exit within 15 s'); process.exit(3); }, 15000);
guard.unref();
${loads}
const until = async (predicate, what) => {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 1)); }
  throw new Error('child: timed out waiting for ' + what);
};
const errors = [];
const router = testing.createTestRouter();
const client = new thruway.Client(router.url, 'realm1', {
  WebSocket: router.WebSocket,
  timeouts: { idle: 0 },
  logger: (entry) => { if (entry.level === 'error' || entry.level === 'warn') errors.push(entry.event + ': ' + entry.message); },
});
const proto = Object.getPrototypeOf(client.topic('com.example.probe'));
const used = [];
const spy = (key, label) => {
  const original = proto[key];
  proto[key] = function (...args) { used.push(label); return original.apply(this, args); };
};
spy(Symbol.observable, 'symbol');
spy('@@observable', '@@observable');
spy(Symbol.asyncIterator, 'asyncIterator');
const source = ${c.adapter === true ? `adapter.rxClient(client, rx.from).topic('com.example.t')` : `rx.from(client.topic('com.example.t'))`};
const got = [];
const controller = new AbortController();
const subscription = rx.platform
  ? source.subscribe((e) => got.push(e.args[0]), { signal: controller.signal })
  : source.subscribe((e) => got.push(e.args[0]));
const frames = (direction, type) => router.frames.filter((f) => f.direction === direction && Array.isArray(f.frame) && f.frame[0] === type);
await until(() => frames('out', 33).length === 1, 'SUBSCRIBED');
router.publish('com.example.t', [42]);
await until(() => got.length === 1, 'the EVENT');
if (rx.platform) controller.abort(); else subscription.unsubscribe();
await until(() => frames('in', 34).length === 1, 'UNSUBSCRIBE');
await client.close();
console.log(JSON.stringify({ before, symbol: describe(Symbol.observable), used, got, unsubscribed: true, errors }));
`;
  return c.format === 'esm' ? body : `(async () => {${body}})().catch((e) => { console.error(e); process.exit(2); });`;
}

async function child(c: Case): Promise<ChildResult> {
  const args = c.format === 'esm' ? ['--input-type=module', '-e', script(c)] : ['-e', script(c)];
  try {
    const { stdout } = await run(process.execPath, args, { cwd: ROOT, timeout: 30000 });
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ChildResult;
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string };
    throw new Error(`child ${c.order.join(' → ')} (${c.format}) failed:\n${stderr ?? ''}${stdout ?? ''}`, {
      cause: error,
    });
  }
}

const name = (c: Case): string => `${c.order.join(' → ')} (${c.format}${c.adapter === true ? ', rxClient' : ''})`;
const formats: readonly Format[] = ['esm', 'cjs'];

describe.concurrent('thruway.js and RxJS 5 / the symbol-observable ponyfill, in every order', () => {
  const cases: Case[] = [];
  for (const format of formats) {
    for (const rx of ['rxjs5', 'rxjs543'] as const) {
      cases.push({ order: ['thruway', rx], format }, { order: [rx, 'thruway'], format });
    }
    cases.push({ order: ['symbol-observable', 'thruway', 'rxjs5'], format });
    cases.push({ order: ['rxjs5', 'thruway'], format, adapter: true });
  }
  test.each(cases.map((c) => [name(c), c] as const))('%s', async (_, c) => {
    const result = await child(c);
    expect(result.got).toEqual([42]);
    expect(result.unsubscribed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.used).toEqual(['symbol']);
    const first = c.order[0];
    expect(result.before[first ?? '']).toBe('undefined'); // a pristine process
    // whoever loads first defines the symbol; everyone after reuses it
    expect(result.symbol).toBe(first === 'thruway' ? `registered:${REGISTERED}` : 'unregistered:observable');
  });
});

describe.concurrent('thruway.js and RxJS 6 / 7, before and after', () => {
  const cases: Case[] = [];
  for (const format of formats) {
    for (const rx of ['rxjs6', 'rxjs7'] as const) {
      cases.push({ order: ['thruway', rx], format }, { order: [rx, 'thruway'], format });
    }
    cases.push({ order: ['rxjs7', 'thruway'], format, adapter: true });
  }
  test.each(cases.map((c) => [name(c), c] as const))('%s', async (_, c) => {
    const result = await child(c);
    expect(result.got).toEqual([42]);
    expect(result.unsubscribed).toBe(true);
    expect(result.errors).toEqual([]);
    // RxJS 6/7 capture `Symbol.observable || '@@observable'` when they load
    expect(result.used).toEqual([c.order[0] === 'thruway' ? 'symbol' : '@@observable']);
    expect(result.symbol).toBe(`registered:${REGISTERED}`);
  });
});

describe.concurrent('thruway.js and RxJS 9, before and after (ESM)', () => {
  const cases: Case[] = [
    { order: ['thruway', 'rxjs9'], format: 'esm' },
    { order: ['rxjs9', 'thruway'], format: 'esm' },
    { order: ['rxjs9', 'thruway'], format: 'esm', adapter: true },
  ];
  test.each(cases.map((c) => [name(c), c] as const))('%s', async (_, c) => {
    const result = await child(c);
    expect(result.got).toEqual([42]);
    expect(result.unsubscribed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.used).toEqual(['asyncIterator']); // RxJS 9 accepts no Symbol.observable interop
    expect(result.symbol).toBe(`registered:${REGISTERED}`);
  });
});

test('the cases load the built package (dist), not the sources', () => {
  expect(require.resolve('thruway.js')).toBe(path.join(ROOT, 'dist/cjs/index.js'));
});
