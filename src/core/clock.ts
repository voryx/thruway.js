/**
 * The default clock and `TimerScope`: grouped timers with generations, `clearAll()`, a count for
 * tests, the late-fire grace of deadlines (a deadline more than `max(1000, duration / 2)` ms late — on `now()` and,
 * for the system clock, also on `Date.now()` — re-arms once for `min(duration, 3000)` ms), every delay clamped to
 * [0, 2^31−1].
 *
 * The clock is app code of the "pure hook" kind: every call goes through {@link clockAccess}, which never
 * throws. A `now()` that throws or returns a non-finite number reads as the last good value; a `setTimeout` that throws
 * falls back to the platform timer, so no timer can be lost; a `clearTimeout` that throws is ignored.
 *
 * @module
 */
import type { Clock } from '../types.js';

/** The largest delay ever armed (setTimeout's limit). */
export const MAX_TIMER_DELAY = 2 ** 31 - 1;
/** A deadline that fires later than `max(GRACE_LATENESS, duration / 2)` ms is re-armed once. */
export const GRACE_LATENESS = 1000;
/** … for `min(duration, GRACE_REARM)` ms. */
export const GRACE_REARM = 3000;

/** What the system clock reads from its host (`globalThis`), so tests can run it over a fake root. */
export interface ClockRoot {
  readonly performance?: unknown;
  readonly crypto?: unknown;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** `now` = `performance.now()` when present, else `Date.now`; the host's timers; `random` from
 *  `crypto.getRandomValues` (53 bits), else `Math.random`. Each is looked up when called. */
export function createSystemClock(root: ClockRoot): Required<Clock> {
  return {
    now(): number {
      const perf = root.performance as { now?: unknown } | undefined;
      return typeof perf?.now === 'function' ? (perf.now as () => number).call(perf) : Date.now();
    },
    setTimeout(fn: () => void, ms: number): unknown {
      return root.setTimeout(fn, ms);
    },
    clearTimeout(handle: unknown): void {
      root.clearTimeout(handle);
    },
    random(): number {
      const words = randomWords(root);
      if (words === undefined) return Math.random();
      // 53 bits: 27 from the first word, 26 from the second (Math.random's precision)
      return ((words[0] >>> 5) * 2 ** 26 + (words[1] >>> 6)) / 2 ** 53;
    },
  };
}

/** Two random 32-bit words from `crypto.getRandomValues`, or undefined when there is no usable WebCrypto (Hermes, a
 *  polyfill that throws). */
export function randomWords(root: { readonly crypto?: unknown }): readonly [number, number] | undefined {
  try {
    const crypto = root.crypto as { getRandomValues?: unknown } | undefined;
    if (typeof crypto?.getRandomValues !== 'function') return undefined;
    const words = new Uint32Array(2);
    (crypto.getRandomValues as (array: Uint32Array) => unknown).call(crypto, words);
    const view = new DataView(words.buffer);
    return [view.getUint32(0, true), view.getUint32(4, true)];
  } catch {
    return undefined;
  }
}

export const systemClock: Required<Clock> = createSystemClock(globalThis as unknown as ClockRoot);

/** Clamp a delay to [0, max] (max defaults to 2^31−1); NaN ⇒ 0. */
export function clampDelay(ms: number, max: number = MAX_TIMER_DELAY): number {
  if (!(ms > 0)) return 0; // NaN, negatives, -0
  return ms > max ? max : ms;
}

/** The core's never-throwing view of the app's clock. */
export interface ClockAccess {
  now(): number;
  /** `Date.now` when the clock is the system clock (suspend detection), else undefined. */
  readonly wallNow: (() => number) | undefined;
  /** Arm `fn` after `ms` (clamped); falls back to the platform timer when the clock's `setTimeout` throws. */
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** A handle of the platform fallback timer (the app's `clock.setTimeout` threw). */
interface FallbackHandle {
  readonly fallback: unknown;
}

/** The platform timers used when the app's clock fails (also by `lastResort`). */
export const platformTimers: Pick<ClockRoot, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => (globalThis as unknown as ClockRoot).setTimeout(fn, ms),
  clearTimeout: (handle) => {
    (globalThis as unknown as ClockRoot).clearTimeout(handle);
  },
};

/** `onError(error, what)` is told about every clock call that threw (the core logs `option.fallback`). */
export function clockAccess(clock: Clock, onError: (error: unknown, what: string) => void): ClockAccess {
  let last = 0;
  const fallbacks = new WeakSet();
  return {
    now(): number {
      try {
        const value = clock.now();
        if (Number.isFinite(value)) {
          last = value;
          return value;
        }
        onError(new TypeError(`clock.now() returned ${String(value)}`), 'now');
      } catch (error) {
        onError(error, 'now');
      }
      return last;
    },
    wallNow: clock === systemClock ? Date.now : undefined,
    set(fn: () => void, ms: number): unknown {
      const delay = clampDelay(ms);
      try {
        return clock.setTimeout(fn, delay);
      } catch (error) {
        onError(error, 'setTimeout');
      }
      const handle: FallbackHandle = { fallback: platformTimers.setTimeout(fn, delay) };
      fallbacks.add(handle);
      return handle;
    },
    clear(handle: unknown): void {
      if (typeof handle === 'object' && handle !== null && fallbacks.has(handle)) {
        platformTimers.clearTimeout((handle as FallbackHandle).fallback);
        return;
      }
      try {
        clock.clearTimeout(handle);
      } catch (error) {
        onError(error, 'clearTimeout');
      }
    },
  };
}

interface Entry {
  readonly gen: number;
  /** The platform handle while armed; undefined once it fired (until the core claims it). */
  handle: unknown;
  armed: boolean;
}

/**
 * Timers of one connection, lingering record or the core itself. Keys name timers ('connect', 'handshake', 'idle',
 * 'op:topic:7', …); arming a key again replaces it with a new generation. A timer that fires stays known (not armed)
 * until the core {@link claim}s it in the step that processes its input, so an input that was queued behind a re-arm
 * or a cancel of its key is recognised as stale and dropped.
 */
export class TimerScope {
  private readonly entries = new Map<string, Entry>();
  private gens = 0;

  constructor(private readonly clock: ClockAccess) {}

  /** Arm `key` for `ms` (clamped to [0, 2^31−1]); `fire(gen)` runs when it is due — for a deadline, after the late-fire
   *  grace. Returns the generation, which the timer's core input carries. */
  arm(key: string, ms: number, fire: (gen: number) => void, deadline = false): number {
    this.cancel(key);
    const gen = ++this.gens;
    const duration = clampDelay(ms);
    const entry: Entry = { gen, handle: undefined, armed: true };
    this.entries.set(key, entry);
    const clock = this.clock;
    const start = clock.now();
    const wallStart = clock.wallNow?.();
    let graced = !deadline;
    const due = (): void => {
      if (this.entries.get(key) !== entry || !entry.armed) return;
      if (!graced) {
        graced = true;
        const allowed = Math.max(GRACE_LATENESS, duration / 2);
        const late = clock.now() - start - duration > allowed;
        const wallLate = wallStart !== undefined && (clock.wallNow as () => number)() - wallStart - duration > allowed;
        if (late || wallLate) {
          // a suspend or a long stall: buffered frames and events get a chance to win before the deadline fails
          entry.handle = clock.set(due, Math.min(duration, GRACE_REARM));
          return;
        }
      }
      entry.armed = false;
      entry.handle = undefined;
      fire(gen);
    };
    entry.handle = clock.set(due, duration);
    return gen;
  }

  /** Disarm `key` (only generation `gen` when given: a stale handle never cancels a newer timer). */
  cancel(key: string, gen?: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined || (gen !== undefined && entry.gen !== gen)) return;
    this.entries.delete(key);
    if (entry.armed) this.clock.clear(entry.handle);
  }

  /** True while `gen` is the generation armed for `key`, or the one that fired and has not been claimed. */
  isCurrent(key: string, gen: number): boolean {
    return this.entries.get(key)?.gen === gen;
  }

  /** True while `key` is armed (it has not fired, been cancelled or been cleared). */
  isArmed(key: string): boolean {
    return this.entries.get(key)?.armed === true;
  }

  /** The input of timer `key`/`gen` is being processed: true (and forgotten) when it is the timer that fired, false
   *  when it is stale (re-armed, cancelled, cleared). */
  claim(key: string, gen: number): boolean {
    const entry = this.entries.get(key);
    if (entry?.gen !== gen || entry.armed) return false;
    this.entries.delete(key);
    return true;
  }

  clearAll(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) if (entry.armed) this.clock.clear(entry.handle);
  }

  /** Timers currently armed in this scope (tests assert 0 after close, INV-R9). */
  get size(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.armed) n++;
    return n;
  }
}
