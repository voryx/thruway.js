/**
 * `AbortSignalLike` factory: `globalThis.AbortController` when it is a function (and builds a controller with a signal
 * and abort()), else a fallback that dispatches to a snapshot of listeners, each in its own try/catch (Hermes without
 * AbortController).
 *
 * The platform signal is preferred because apps hand it on (`fetch(url, {signal})` in an `onChallenge`); its listener
 * errors are handled the platform's way. The fallback follows EventTarget where it matters: a listener added twice is
 * called once, one removed during the dispatch is skipped, one added after the abort is never called, listeners are
 * called with the signal as `this` and an `{type: 'abort'}` event, and objects with `handleEvent` work. A throwing
 * listener is reported and the others still run.
 *
 * @module
 */
import type { AbortSignalLike } from '../types.js';
import { defaultReporter, report, type UnhandledReporter } from './observable.js';

export interface AbortHandle {
  readonly signal: AbortSignalLike;
  /** Idempotent: the first call sets `signal.reason` and notifies listeners; later calls do nothing. */
  abort(reason: unknown): void;
}

interface ControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

/**
 * @param reporter where the fallback reports a throwing listener, and where a throwing platform `abort()` (a broken
 *                 polyfill) goes; the client passes its own (default: console.error, like the default logger).
 */
export function createAbort(reporter: UnhandledReporter = defaultReporter): AbortHandle {
  try {
    const Controller = (globalThis as { readonly AbortController?: unknown }).AbortController;
    const controller = new (Controller as new () => { readonly signal?: unknown; readonly abort?: unknown })();
    const { signal, abort } = controller; // each read once, inside the try (a polyfill's getters may throw)
    // not a controller: a constructor that returned a function, no object signal, no abort()
    if (
      typeof controller === 'object' &&
      typeof signal === 'object' &&
      signal !== null &&
      typeof abort === 'function'
    ) {
      return platform(controller as ControllerLike, signal as AbortSignalLike, reporter);
    }
  } catch {
    // missing (not a constructor: old Hermes) or a broken polyfill: the fallback
  }
  return fallback(reporter);
}

function platform(controller: ControllerLike, signal: AbortSignalLike, reporter: UnhandledReporter): AbortHandle {
  return {
    signal,
    abort(reason) {
      // React Native's `abort-controller` polyfill has no `reason`: give its signal one, so listeners can tell why.
      // Real platform signals have it on the prototype and are left alone.
      try {
        if (!('reason' in signal)) {
          Object.defineProperty(signal, 'reason', { value: reason === undefined ? abortError() : reason });
        }
      } catch {
        // a non-extensible signal: the reason stays unavailable, the abort still happens
      }
      try {
        controller.abort(reason);
      } catch (error) {
        report(reporter, error, 'unhandled');
      }
    },
  };
}

/** The reason of `abort(undefined)`, like the platform's `AbortError` DOMException. */
function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function fallback(reporter: UnhandledReporter): AbortHandle {
  const listeners = new Set<unknown>(); // insertion order = dispatch order; a duplicate add is a no-op
  let aborted = false;
  let reason: unknown = undefined;

  const signal: AbortSignalLike = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    addEventListener(type: string, listener: unknown) {
      if (type === 'abort' && !aborted && listener !== null && listener !== undefined) listeners.add(listener);
    },
    removeEventListener(type: string, listener: unknown) {
      if (type === 'abort') listeners.delete(listener);
    },
  };

  return {
    signal,
    abort(given) {
      if (aborted) return;
      aborted = true;
      reason = given === undefined ? abortError() : given;
      const event = { type: 'abort', target: signal, currentTarget: signal };
      for (const listener of Array.from(listeners)) {
        if (!listeners.has(listener)) continue; // removed by an earlier listener
        try {
          if (typeof listener === 'function') {
            (listener as (this: unknown, ev: unknown) => void).call(signal, event);
          } else {
            const handleEvent = (listener as { readonly handleEvent?: unknown }).handleEvent;
            if (typeof handleEvent === 'function')
              (handleEvent as (this: unknown, ev: unknown) => void).call(listener, event);
          }
        } catch (error) {
          report(reporter, error, 'unhandled');
        }
      }
      // Stryker disable next-line all: equivalent mutant; it releases the listeners, observable only with a GC
      listeners.clear();
    },
  };
}
