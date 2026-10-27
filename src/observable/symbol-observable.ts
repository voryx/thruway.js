/**
 * The `Symbol.observable` ponyfill. This is the only module with a side effect, and it is listed in `sideEffects`.
 *
 * It behaves exactly like the `symbol-observable` package (4.0.0, the version every current Rx library and polyfill
 * agrees with): when `Symbol.observable` is already set it is reused (RxJS 5 or another copy of thruway.js loaded
 * first); otherwise it is set to `Symbol.for('https://github.com/benlesh/symbol-observable')` (a plain `Symbol(…)` when
 * `Symbol.for` is missing) by plain assignment, and a frozen `Symbol` is tolerated. Libraries loaded later (RxJS 5's
 * own copy of the ponyfill, RxJS 6/7, which read `Symbol.observable` once at load) then pick up the same key. Without
 * `Symbol` the key is the string `'@@observable'`.
 *
 * @module
 */

/** The description `symbol-observable` registers its symbol under. */
export const SYMBOL_OBSERVABLE_KEY = 'https://github.com/benlesh/symbol-observable';

/** What the ponyfill reads from the global object (loosely typed: hosts differ). */
interface PonyfillRoot {
  readonly Symbol?: unknown;
}

interface SymbolLike {
  (description: string): symbol;
  readonly for?: unknown;
  observable?: unknown;
}

/**
 * `symbol-observable`'s `ponyfill(root)`, step for step: reuse a truthy `root.Symbol.observable`; else create the
 * symbol (`Symbol.for` when it is a function) and assign it, ignoring a throw (frozen `Symbol`); `'@@observable'` when
 * `root.Symbol` is not a function. Exported for tests (fake roots); the module applies it to `globalThis` once.
 */
export function symbolObservablePonyfill(root: PonyfillRoot): typeof Symbol.observable {
  const host = root.Symbol as SymbolLike | undefined;
  if (typeof host !== 'function') return '@@observable' as unknown as typeof Symbol.observable;
  if (host.observable) return host.observable as typeof Symbol.observable;
  const result =
    typeof host.for === 'function'
      ? (host as { for(key: string): symbol }).for(SYMBOL_OBSERVABLE_KEY)
      : host(SYMBOL_OBSERVABLE_KEY);
  try {
    host.observable = result;
  } catch {
    // A frozen Symbol: the key is still returned, so our Observables carry it (as symbol-observable does).
  }
  return result as typeof Symbol.observable;
}

/** The key our Observables are reachable under (a symbol, or the string '@@observable' without Symbol). Internal, but
 *  carries no stripInternal tag: observable.ts's declarations use it as a computed member name. */
export const symbolObservable: typeof Symbol.observable = symbolObservablePonyfill(globalThis);
