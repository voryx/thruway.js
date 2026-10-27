// The Symbol.observable ponyfill and load order: defined exactly like the `symbol-observable` package when missing,
// reused when present, and interop works whichever of RxJS 5, 6, 7 and thruway.js loads first. The real module file
// runs in pristine vm realms; the in-process cases re-evaluate it with a fresh module registry.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fc from 'fast-check';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SYMBOL_OBSERVABLE_KEY,
  symbolObservable,
  symbolObservablePonyfill,
} from '../../src/observable/symbol-observable.js';
import { replayParameters } from '../setup-fast-check.js';

/**
 * Oracle: `symbol-observable@4.0.0` `es/ponyfill.js`, verbatim (MIT, Ben Lesh), so the comparison does not depend on
 * an installed copy (the repo only has 1.0.1 transitively, through RxJS 5).
 */
const REFERENCE_PONYFILL_SOURCE = `
function symbolObservablePonyfill(root) {
	var result;
	var Symbol = root.Symbol;

	if (typeof Symbol === 'function') {
		if (Symbol.observable) {
			result = Symbol.observable;
		} else {

			if (typeof Symbol.for === 'function') {
				result = Symbol.for('https://github.com/benlesh/symbol-observable');
			} else {
				result = Symbol('https://github.com/benlesh/symbol-observable');
			}
			try {
				Symbol.observable = result;
			} catch (err) {
				// Do nothing.
			}
		}
	} else {
		result = '@@observable';
	}

	return result;
};`;
const referencePonyfill = vm.runInThisContext(
  `(function () { 'use strict'; ${REFERENCE_PONYFILL_SOURCE}; return symbolObservablePonyfill; })()`,
) as (root: object) => unknown;

const require = createRequire(import.meta.url);

/** Our module compiled to CommonJS, to run in fresh realms. */
const MODULE_SOURCE = ts.transpileModule(
  readFileSync(new URL('../../src/observable/symbol-observable.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

function realm(): { context: vm.Context; global: { Symbol: SymbolConstructor & { observable?: symbol } } } {
  const context = vm.createContext({});
  return { context, global: vm.runInContext('globalThis', context) as never };
}
/** Load our module into a realm; returns its exports. */
function loadOurs(context: vm.Context): { symbolObservable: unknown } {
  const exports = {};
  const run = vm.runInContext(`(function (exports) { ${MODULE_SOURCE}\n})`, context) as (e: object) => void;
  run(exports);
  return exports as { symbolObservable: unknown };
}
function loadReference(context: vm.Context): unknown {
  const run = vm.runInContext(
    `(function () { 'use strict'; ${REFERENCE_PONYFILL_SOURCE}; return symbolObservablePonyfill(globalThis); })`,
    context,
  ) as () => unknown;
  return run();
}
/** RxJS 5.5's real `getSymbolObservable(root)` (rxjs/symbol/observable.js), applied to a realm's global. */
const rx5SymbolModule = require('rxjs5/symbol/observable.js') as { getSymbolObservable(root: object): unknown };
const rx5Symbol = (root: object): unknown => rx5SymbolModule.getSymbolObservable(root);

const descriptorOf = (target: object) => Object.getOwnPropertyDescriptor(target, 'observable');

// ---------------------------------------------------------------------------------------------------------------------

interface FakeRoot {
  Symbol?: unknown;
}
interface RootSpec {
  readonly kind: 'none' | 'object' | 'function';
  readonly observable: 'absent' | 'symbol' | 'string' | 'falsy0' | 'falsyEmpty' | 'null';
  readonly hasFor: 'function' | 'absent' | 'notFunction';
  readonly lock: 'none' | 'frozen' | 'throwingSetter';
}

/** Two identical roots built from one spec (fresh objects, a shared pre-existing value). */
function roots(spec: RootSpec): [FakeRoot, FakeRoot] {
  const existing = Symbol('pre-existing');
  const build = (): FakeRoot => {
    if (spec.kind === 'none') return {};
    const host: Record<string, unknown> =
      spec.kind === 'object'
        ? {}
        : (Object.assign((description: string) => Symbol(description), {}) as unknown as Record<string, unknown>);
    if (spec.hasFor === 'function') host['for'] = (key: string) => Symbol.for(key);
    else if (spec.hasFor === 'notFunction') host['for'] = 'nope';
    const values = { symbol: existing, string: 'custom-key', falsy0: 0, falsyEmpty: '', null: null } as const;
    if (spec.observable !== 'absent') host['observable'] = values[spec.observable];
    if (spec.lock === 'frozen') Object.freeze(host);
    if (spec.lock === 'throwingSetter') {
      Object.defineProperty(host, 'observable', {
        get: () => undefined,
        set: () => {
          throw new Error('setter');
        },
      });
    }
    return { Symbol: host };
  };
  return [build(), build()];
}

/** A comparable view of a ponyfill result and of what it left on the root. */
function outcome(result: unknown, root: FakeRoot) {
  const host = root.Symbol;
  const descriptor =
    host !== null && (typeof host === 'function' || typeof host === 'object') ? descriptorOf(host) : undefined;
  const view = (v: unknown) =>
    typeof v === 'symbol' ? { symbol: v.description, registered: Symbol.keyFor(v) !== undefined } : v;
  return {
    result: view(result),
    descriptor:
      descriptor === undefined
        ? undefined
        : 'value' in descriptor
          ? { ...descriptor, value: view(descriptor.value) }
          : { accessor: true },
  };
}

const rootSpec: fc.Arbitrary<RootSpec> = fc.record({
  kind: fc.constantFrom('none', 'object', 'function'),
  observable: fc.constantFrom('absent', 'symbol', 'string', 'falsy0', 'falsyEmpty', 'null'),
  hasFor: fc.constantFrom('function', 'absent', 'notFunction'),
  lock: fc.constantFrom('none', 'frozen', 'throwingSetter'),
});

describe('symbolObservablePonyfill behaves exactly like symbol-observable 4.0.0', () => {
  test('property: same result and same property left on Symbol, for any host shape', () => {
    fc.assert(
      fc.property(rootSpec, (spec) => {
        const [ours, theirs] = roots(spec);
        const a = outcome(symbolObservablePonyfill(ours), ours);
        const b = outcome(referencePonyfill(theirs), theirs);
        expect(a).toEqual(b);
      }),
      replayParameters(),
    );
  });

  test.each<[string, RootSpec, unknown]>([
    ['no Symbol', { kind: 'none', observable: 'absent', hasFor: 'absent', lock: 'none' }, '@@observable'],
    [
      'Symbol not a function',
      { kind: 'object', observable: 'absent', hasFor: 'function', lock: 'none' },
      '@@observable',
    ],
    [
      'missing: Symbol.for(key), assigned',
      { kind: 'function', observable: 'absent', hasFor: 'function', lock: 'none' },
      Symbol.for(SYMBOL_OBSERVABLE_KEY),
    ],
    [
      'falsy: replaced',
      { kind: 'function', observable: 'falsy0', hasFor: 'function', lock: 'none' },
      Symbol.for(SYMBOL_OBSERVABLE_KEY),
    ],
    [
      'frozen Symbol: returned, not assigned',
      { kind: 'function', observable: 'absent', hasFor: 'function', lock: 'frozen' },
      Symbol.for(SYMBOL_OBSERVABLE_KEY),
    ],
    [
      'throwing setter: returned',
      { kind: 'function', observable: 'absent', hasFor: 'function', lock: 'throwingSetter' },
      Symbol.for(SYMBOL_OBSERVABLE_KEY),
    ],
  ])('%s', (_, spec, expected) => {
    const [root] = roots(spec);
    expect(symbolObservablePonyfill(root)).toBe(expected);
  });

  test('present: reused as is (symbol or any truthy value); without Symbol.for a unique symbol', () => {
    const [withSymbol] = roots({ kind: 'function', observable: 'symbol', hasFor: 'function', lock: 'none' });
    const existing = (withSymbol.Symbol as { observable: symbol }).observable;
    expect(symbolObservablePonyfill(withSymbol)).toBe(existing);
    const [withString] = roots({ kind: 'function', observable: 'string', hasFor: 'function', lock: 'none' });
    expect(symbolObservablePonyfill(withString)).toBe('custom-key');
    const [noFor] = roots({ kind: 'function', observable: 'absent', hasFor: 'absent', lock: 'none' });
    const created = symbolObservablePonyfill(noFor);
    expect(typeof created).toBe('symbol');
    expect(created.description).toBe(SYMBOL_OBSERVABLE_KEY);
    expect(Symbol.keyFor(created)).toBeUndefined();
    expect((noFor.Symbol as { observable: symbol }).observable).toBe(created);
  });

  test('the module key is the global Symbol.observable', () => {
    expect(symbolObservable).toBe(Symbol.observable);
    expect(typeof symbolObservable).toBe('symbol');
  });
});

describe('the module in a pristine realm', () => {
  test('missing: defines Symbol.observable exactly like the package (same symbol, same descriptor)', () => {
    const ours = realm();
    const theirs = realm();
    expect(ours.global.Symbol.observable).toBeUndefined();
    const { symbolObservable: key } = loadOurs(ours.context);
    const reference = loadReference(theirs.context);
    expect(key).toBe(Symbol.for(SYMBOL_OBSERVABLE_KEY));
    expect(key).toBe(reference);
    expect(descriptorOf(ours.global.Symbol)).toEqual(descriptorOf(theirs.global.Symbol));
    expect(descriptorOf(ours.global.Symbol)).toEqual({
      value: key,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  test('loaded twice (two package copies): the second reuses the first', () => {
    const { context, global } = realm();
    const first = loadOurs(context).symbolObservable;
    const second = loadOurs(context).symbolObservable;
    expect(second).toBe(first);
    expect(global.Symbol.observable).toBe(first);
  });

  test('RxJS 5 first: its Symbol("observable") is reused', () => {
    const { context, global } = realm();
    const rx5 = rx5Symbol(global);
    expect(typeof rx5).toBe('symbol');
    expect((rx5 as symbol).description).toBe('observable');
    expect(loadOurs(context).symbolObservable).toBe(rx5);
  });

  test('thruway.js first: RxJS 5 and symbol-observable 4 reuse ours', () => {
    const { context, global } = realm();
    const ours = loadOurs(context).symbolObservable;
    expect(rx5Symbol(global)).toBe(ours);
    expect(loadReference(context)).toBe(ours);
  });

  test('a frozen Symbol: loads without throwing and uses Symbol.for(key)', () => {
    const { context, global } = realm();
    vm.runInContext('Object.freeze(Symbol)', context);
    expect(loadOurs(context).symbolObservable).toBe(Symbol.for(SYMBOL_OBSERVABLE_KEY));
    expect(global.Symbol.observable).toBeUndefined();
  });

  test('no Symbol at all: the string key', () => {
    const { context } = realm();
    vm.runInContext('globalThis.Symbol = undefined', context);
    expect(loadOurs(context).symbolObservable).toBe('@@observable');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// In-process load orders: the module registry is reset and Symbol.observable removed, then RxJS and thruway.js load in
// a chosen order; in every order each library consumes our Observables.
// ---------------------------------------------------------------------------------------------------------------------

type Saved = PropertyDescriptor | undefined;
let saved: Saved;
const symbolHost = Symbol as unknown as { observable?: symbol };

function removeSymbolObservable(): void {
  const descriptor = descriptorOf(Symbol);
  if (descriptor !== undefined && descriptor.configurable !== true) throw new Error('cannot remove Symbol.observable');
  delete symbolHost.observable;
}
/** require() a package again (its CommonJS modules re-evaluated). */
function freshRequire(id: string, packageDir: string): unknown {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`/node_modules/${packageDir}/`)) Reflect.deleteProperty(require.cache, key);
  }
  return require(id);
}
async function freshOurs() {
  vi.resetModules();
  const kit = await import('../../src/observable/observable.js');
  return kit;
}
function sourceOf(kit: Awaited<ReturnType<typeof freshOurs>>) {
  let teardowns = 0;
  const observable = new kit.Observable<number>((s) => {
    s.next(1);
    s.next(2);
    return () => {
      teardowns++;
    };
  });
  return { observable, teardowns: () => teardowns };
}

interface Rx5 {
  Observable: { from(x: unknown): { subscribe(next: (v: number) => void): { unsubscribe(): void } } };
}
interface Rx7Like {
  from(x: unknown): { subscribe(next: (v: number) => void): { unsubscribe(): void } };
}

function consume(rx: Rx7Like | Rx5['Observable'], observable: unknown, teardowns: () => number): void {
  const seen: number[] = [];
  const subscription = rx.from(observable).subscribe((v) => seen.push(v));
  expect(seen).toEqual([1, 2]);
  subscription.unsubscribe();
  expect(teardowns()).toBe(1);
}

describe('load order (in process)', () => {
  beforeEach(() => {
    saved = descriptorOf(Symbol);
  });
  afterEach(() => {
    if (saved === undefined) delete symbolHost.observable;
    else Object.defineProperty(Symbol, 'observable', saved);
    vi.resetModules();
  });

  test('missing at load: the module defines it; present: the module reuses it', async () => {
    removeSymbolObservable();
    vi.resetModules();
    const fresh = await import('../../src/observable/symbol-observable.js');
    expect(fresh.symbolObservable).toBe(Symbol.for(SYMBOL_OBSERVABLE_KEY));
    expect(Symbol.observable).toBe(fresh.symbolObservable);

    const preexisting = Symbol('preexisting');
    symbolHost.observable = preexisting;
    const kit = await freshOurs();
    const { symbolObservable: key } = await import('../../src/observable/symbol-observable.js');
    expect(key).toBe(preexisting);
    const observable = new kit.Observable<number>(() => undefined) as unknown as Record<symbol, () => unknown>;
    expect(observable[preexisting]?.()).toBe(observable);
  });

  test('RxJS 5 then thruway.js: Observable.from(ours)', async () => {
    removeSymbolObservable();
    const rx5 = freshRequire('rxjs5/Rx.js', 'rxjs5') as Rx5;
    expect(Symbol.observable.description).toBe('observable');
    const { observable, teardowns } = sourceOf(await freshOurs());
    consume(rx5.Observable, observable, teardowns);
  });

  test('thruway.js then RxJS 5 (and RxJS 5.4.3): Observable.from(ours)', async () => {
    removeSymbolObservable();
    const kit = await freshOurs();
    expect(Symbol.observable).toBe(Symbol.for(SYMBOL_OBSERVABLE_KEY));
    for (const [id, dir] of [
      ['rxjs5/Rx.js', 'rxjs5'],
      ['rxjs543/Rx.js', 'rxjs543'],
    ] as const) {
      const { observable, teardowns } = sourceOf(kit);
      consume((freshRequire(id, dir) as Rx5).Observable, observable, teardowns);
    }
  });

  test("RxJS 7 (and 6) first capture '@@observable': from(ours) uses that key", async () => {
    removeSymbolObservable();
    const rx7 = freshRequire('rxjs', 'rxjs') as Rx7Like;
    const rx6 = freshRequire('rxjs6', 'rxjs6') as Rx7Like;
    const kit = await freshOurs();
    expect(typeof Symbol.observable).toBe('symbol');
    const stringKey = vi.spyOn(kit.Observable.prototype, '@@observable');
    for (const rx of [rx7, rx6]) {
      const { observable, teardowns } = sourceOf(kit);
      consume(rx, observable, teardowns);
    }
    expect(stringKey).toHaveBeenCalledTimes(2);
  });

  test('thruway.js then RxJS 7 and 6: from(ours) uses Symbol.observable', async () => {
    removeSymbolObservable();
    const kit = await freshOurs();
    const rx7 = freshRequire('rxjs', 'rxjs') as Rx7Like;
    const rx6 = freshRequire('rxjs6', 'rxjs6') as Rx7Like;
    const stringKey = vi.spyOn(kit.Observable.prototype, '@@observable');
    for (const rx of [rx7, rx6]) {
      const { observable, teardowns } = sourceOf(kit);
      consume(rx, observable, teardowns);
    }
    expect(stringKey).not.toHaveBeenCalled();
  });
});
