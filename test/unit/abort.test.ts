// AbortSignalLike factory: the platform AbortController when present (so apps can hand the signal to fetch), a React
// Native style polyfill without `reason` gets one, broken controllers fall back, and the fallback dispatches to a
// snapshot of listeners, each isolated in its own try/catch.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { createAbort } from '../../src/observable/abort.js';
import type { UnhandledReporter } from '../../src/observable/observable.js';
import { replayParameters } from '../setup-fast-check.js';

function recorder(): { reporter: UnhandledReporter; reports: unknown[][] } {
  const reports: unknown[][] = [];
  return { reports, reporter: (error, kind) => reports.push([error, kind]) };
}

let consoleError: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('platform AbortController', () => {
  test('is used when present: a real AbortSignal (fetch accepts it)', () => {
    const handle = createAbort();
    const { signal } = handle;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    const listener = vi.fn();
    signal.addEventListener('abort', listener);
    const reason = new Error('superseded');
    handle.abort(reason);
    handle.abort(new Error('second'));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(AbortSignal.any([signal as AbortSignal]).aborted).toBe(true);
    expect(() => new Request('http://127.0.0.1/', { signal: signal as AbortSignal })).not.toThrow();
  });

  test('abort(undefined) gives the platform AbortError reason; a platform signal is never modified', () => {
    for (const reason of [undefined, 'why']) {
      const handle = createAbort();
      handle.abort(reason);
      expect(Object.getOwnPropertyNames(handle.signal)).toEqual([]);
      if (reason === undefined) expect(handle.signal.reason).toBeInstanceOf(DOMException);
      else expect(handle.signal.reason).toBe(reason);
    }
    expect((createAbort().signal.reason as Error | undefined)?.name).toBeUndefined();
  });

  test('a polyfill without reason (React Native abort-controller) gets the reason before its listeners run', () => {
    const seen: unknown[] = [];
    class PolyfillSignal {
      aborted = false;
      private readonly listeners: (() => void)[] = [];
      addEventListener(_type: string, listener: () => void) {
        this.listeners.push(listener);
      }
      removeEventListener() {
        // not needed here
      }
      fire() {
        if (this.aborted) return;
        this.aborted = true;
        for (const l of this.listeners) l();
      }
    }
    class PolyfillController {
      readonly signal = new PolyfillSignal();
      abort() {
        this.signal.fire();
      }
    }
    vi.stubGlobal('AbortController', PolyfillController);
    const handle = createAbort();
    expect(handle.signal).toBeInstanceOf(PolyfillSignal);
    handle.signal.addEventListener('abort', () => seen.push(handle.signal.reason));
    const reason = new Error('lost');
    handle.abort(reason);
    handle.abort(new Error('ignored'));
    expect(seen).toEqual([reason]);
    expect(handle.signal.reason).toBe(reason);

    const other = createAbort();
    other.abort(undefined);
    expect((other.signal.reason as Error).name).toBe('AbortError');
  });

  test('a non-extensible polyfill signal still aborts', () => {
    const aborts = vi.fn();
    class FrozenController {
      readonly signal = Object.freeze({
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      });
      readonly abort = aborts;
    }
    vi.stubGlobal('AbortController', FrozenController);
    const handle = createAbort();
    expect(() => {
      handle.abort('why');
    }).not.toThrow();
    expect(aborts).toHaveBeenCalledTimes(1);
    expect('reason' in handle.signal).toBe(false);
  });

  test('a throwing abort() of a broken polyfill is reported, never thrown', () => {
    const boom = new Error('polyfill bug');
    vi.stubGlobal(
      'AbortController',
      class {
        readonly signal = {
          aborted: false,
          reason: undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        };
        abort() {
          throw boom;
        }
      },
    );
    const { reporter, reports } = recorder();
    const handle = createAbort(reporter);
    expect(() => {
      handle.abort('x');
    }).not.toThrow();
    expect(reports).toEqual([[boom, 'unhandled']]);
  });

  test.each([
    [
      'throws on construction',
      function Throwing() {
        throw new Error('no');
      },
    ],
    ['has no signal', Object],
    [
      'has no abort()',
      class {
        readonly signal = {};
      },
    ],
    [
      'has a null signal',
      class {
        readonly signal = null;
        readonly abort = () => undefined;
      },
    ],
    [
      'has abort() but no signal',
      class {
        readonly abort = () => undefined;
      },
    ],
    [
      'has a throwing signal getter',
      class {
        get signal(): never {
          throw new Error('broken polyfill');
        }
        abort() {
          return undefined;
        }
      },
    ],
    [
      'has a throwing abort getter',
      class {
        readonly signal = {};
        get abort(): never {
          throw new Error('broken polyfill');
        }
      },
    ],
    ['is not a function', { prototype: {} }],
    ['is missing', undefined],
  ])('falls back when the global AbortController %s', (_, value) => {
    vi.stubGlobal('AbortController', value);
    const handle = createAbort();
    const { signal } = handle;
    expect(signal).not.toBeInstanceOf(AbortSignal);
    const listener = vi.fn();
    signal.addEventListener('abort', listener);
    handle.abort('why');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('why');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a constructor returning a function is not a controller', () => {
    vi.stubGlobal('AbortController', function Weird() {
      return Object.assign(() => undefined, { signal: {}, abort: () => undefined });
    });
    expect(createAbort().signal).not.toBeInstanceOf(AbortSignal);
    expect(Object.keys(createAbort().signal)).toEqual(['aborted', 'reason', 'addEventListener', 'removeEventListener']);
  });
});

describe('fallback (no AbortController, e.g. old Hermes)', () => {
  beforeEach(() => {
    vi.stubGlobal('AbortController', undefined);
  });

  test('initial state, abort sets aborted and reason once', () => {
    const handle = createAbort();
    const { signal } = handle;
    expect(signal.aborted).toBe(false);
    expect(signal.reason).toBeUndefined();
    handle.abort('first');
    handle.abort('second');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('first');
  });

  test('abort(undefined) sets an AbortError reason like the platform', () => {
    const handle = createAbort();
    const { signal } = handle;
    handle.abort(undefined);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).name).toBe('AbortError');
    expect((signal.reason as Error).message).toBe('This operation was aborted');
  });

  test('listeners get the signal as this and an abort event', () => {
    const handle = createAbort();
    const { signal } = handle;
    const calls: unknown[] = [];
    signal.addEventListener('abort', function (this: unknown, ...args: unknown[]) {
      calls.push(this, args);
    });
    handle.abort('r');
    expect(calls).toEqual([signal, [{ type: 'abort', target: signal, currentTarget: signal }]]);
  });

  test('a throwing listener is reported and the others still run', () => {
    const { reporter, reports } = recorder();
    const handle = createAbort(reporter);
    const { signal } = handle;
    const order: string[] = [];
    const boom = new Error('app listener');
    signal.addEventListener('abort', () => order.push('a'));
    signal.addEventListener('abort', () => {
      order.push('b');
      throw boom;
    });
    signal.addEventListener('abort', () => order.push('c'));
    expect(() => {
      handle.abort('r');
    }).not.toThrow();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(reports).toEqual([[boom, 'unhandled']]);
  });

  test('without a reporter a throwing listener goes to console.error', () => {
    const handle = createAbort();
    const { signal } = handle;
    signal.addEventListener('abort', () => {
      throw new Error('x');
    });
    handle.abort('r');
    expect(consoleError).toHaveBeenCalledWith('thruway.js: unhandled error in an Observable: Error: x', new Error('x'));
  });

  test('EventTarget rules: duplicates once, removed before or during dispatch skipped, added late never', () => {
    const handle = createAbort();
    const { signal } = handle;
    const order: string[] = [];
    const twice = () => order.push('twice');
    const removedEarly = () => order.push('removed early');
    const removedDuring = () => order.push('removed during');
    const addedDuring = () => order.push('added during');
    signal.addEventListener('abort', twice);
    signal.addEventListener('abort', twice, { once: true });
    signal.addEventListener('abort', removedEarly);
    signal.removeEventListener('abort', removedEarly);
    signal.addEventListener('abort', () => {
      order.push('remover');
      signal.removeEventListener('abort', removedDuring);
      signal.addEventListener('abort', addedDuring);
    });
    signal.addEventListener('abort', removedDuring);
    handle.abort('r');
    signal.addEventListener('abort', () => order.push('added after'));
    handle.abort('again');
    expect(order).toEqual(['twice', 'remover']);
  });

  test('other event types, null, undefined and primitive listeners are ignored without a report', () => {
    const { reporter, reports } = recorder();
    const handle = createAbort(reporter);
    const { signal } = handle;
    const listener = vi.fn();
    const loose = signal as unknown as {
      addEventListener(type: string, l: unknown): void;
      removeEventListener(type: string, l: unknown): void;
    };
    loose.addEventListener('other', listener);
    loose.addEventListener('abort', null);
    loose.addEventListener('abort', undefined);
    loose.addEventListener('abort', 42);
    loose.removeEventListener('other', listener);
    handle.abort('r');
    expect(listener).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  test('removing a listener that was never added keeps the others', () => {
    const handle = createAbort();
    const first = vi.fn();
    const last = vi.fn();
    handle.signal.addEventListener('abort', first);
    handle.signal.addEventListener('abort', last);
    handle.signal.removeEventListener('abort', () => undefined);
    handle.abort('r');
    expect(first).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
  });

  test('a listener that removes an earlier one does not make the dispatch skip the next one', () => {
    const handle = createAbort();
    const order: string[] = [];
    const a = () => order.push('a');
    handle.signal.addEventListener('abort', a);
    handle.signal.addEventListener('abort', () => {
      order.push('remover');
      handle.signal.removeEventListener('abort', a);
    });
    handle.signal.addEventListener('abort', () => order.push('c'));
    handle.abort('r');
    expect(order).toEqual(['a', 'remover', 'c']);
  });

  test('removeEventListener of another type keeps the abort listener', () => {
    const handle = createAbort();
    const { signal } = handle;
    const listener = vi.fn();
    signal.addEventListener('abort', listener);
    (signal as unknown as { removeEventListener(t: string, l: unknown): void }).removeEventListener('other', listener);
    handle.abort('r');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('objects with handleEvent are called as methods; objects without one are skipped', () => {
    const handle = createAbort();
    const { signal } = handle;
    const seen: unknown[] = [];
    const handler = {
      name: 'handler',
      handleEvent(this: { name: string }, event: { type: string }) {
        seen.push([this.name, event.type]);
      },
    };
    const loose = signal as unknown as { addEventListener(type: string, l: unknown): void };
    loose.addEventListener('abort', handler);
    loose.addEventListener('abort', { handleEvent: 'not a function' });
    handle.abort('r');
    expect(seen).toEqual([['handler', 'abort']]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('property: every listener not removed runs exactly once, whatever the others throw', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ throws: fc.boolean(), removedBefore: fc.boolean(), value: fc.anything() }), {
          maxLength: 12,
        }),
        (specs) => {
          const { reporter, reports } = recorder();
          const handle = createAbort(reporter);
          const { signal } = handle;
          const calls = specs.map(() => 0);
          const listeners = specs.map((spec, i) => () => {
            calls[i]!++;
            if (spec.throws) throw spec.value;
          });
          listeners.forEach((l) => {
            signal.addEventListener('abort', l);
          });
          specs.forEach((spec, i) => {
            if (spec.removedBefore) signal.removeEventListener('abort', listeners[i]!);
          });
          handle.abort('r');
          handle.abort('r');
          expect(calls).toEqual(specs.map((s) => (s.removedBefore ? 0 : 1)));
          const thrown = specs.filter((s) => s.throws && !s.removedBefore).map((s) => [s.value, 'unhandled']);
          expect(reports).toEqual(thrown);
        },
      ),
      replayParameters(),
    );
  });
});
