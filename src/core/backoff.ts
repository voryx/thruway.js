/**
 * `Backoff`: full jitter `random() × min(max, initial × growth^(n−1))`, floor 100 ms (also for a custom
 * `retryDelay`), cap 2^31−1; `null` = give up; reset only by a 60 s stable session, `open()` from CLOSED,
 * `reconnect()`, `close()` and give-up. Adaptive connect/handshake deadlines.
 *
 * `retryDelay` and the jitter source are app code of the "pure hook" kind: a throw, a non-finite result or a
 * jitter value outside [0, 1) falls back to the built-in behaviour and is reported through `onFallback`.
 *
 * @module
 */
import type { CloseInfo, RetryOptions } from '../types.js';
import { MAX_TIMER_DELAY } from './clock.js';

/** The floor of every retry delay, default or custom. */
export const RETRY_FLOOR = 100;
/** The cap of an adaptive connect/handshake deadline. */
export const DEADLINE_CAP = 60000;

export interface BackoffOptions {
  readonly initialRetryDelay: number;
  readonly retryDelayGrowth: number;
  readonly maxRetryDelay: number;
  readonly retryDelay: RetryOptions['retryDelay'];
  /** The jitter source (`clock.random`, or the system default). */
  readonly random: () => number;
  /** A custom `retryDelay` or the jitter source threw or returned an unusable value: the default was used
   *  (`option.fallback`). */
  readonly onFallback: (error: unknown, what: 'retryDelay' | 'random') => void;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class Backoff {
  private failures = 0;

  constructor(private readonly options: BackoffOptions) {}

  /** Consecutive failed attempts. */
  get attempts(): number {
    return this.failures;
  }

  /** open()/reconnect() from CLOSED, reconnect(), close(), give-up. */
  reset(): void {
    this.failures = 0;
  }

  /** A session stayed established for 60 s. */
  markStable(): void {
    this.failures = 0;
  }

  /** Count one failure; returns the consecutive count including it. */
  fail(): number {
    return ++this.failures;
  }

  /** The built-in full-jitter delay for failure `n` (1-based): in [100, min(maxRetryDelay, 2^31−1)]. */
  defaultDelay(n: number): number {
    const { initialRetryDelay, retryDelayGrowth, maxRetryDelay } = this.options;
    let base = initialRetryDelay * retryDelayGrowth ** (n - 1);
    if (!Number.isFinite(base) || base > maxRetryDelay) base = maxRetryDelay;
    return Math.floor(clamp(this.jitter() * base, RETRY_FLOOR, Math.min(maxRetryDelay, MAX_TIMER_DELAY)));
  }

  /**
   * The delay before the next attempt after failure `n`, or null = give up. Called once per end: the default is drawn
   * once, `info(defaultDelay)` builds the provisional CloseInfo the custom strategy receives, and its result is clamped
   * to [100, 2^31−1].
   */
  delay(n: number, info: (defaultDelay: number) => CloseInfo): number | null {
    const d = this.defaultDelay(n);
    const custom = this.options.retryDelay;
    if (custom === undefined) return d;
    try {
      const c = custom(n, info(d), d);
      if (c === null) return null;
      if (typeof c === 'number' && Number.isFinite(c)) return Math.floor(clamp(c, RETRY_FLOOR, MAX_TIMER_DELAY));
      this.options.onFallback(
        new TypeError(`retryDelay returned ${typeof c === 'number' ? String(c) : typeof c}`),
        'retryDelay',
      );
    } catch (error) {
      this.options.onFallback(error, 'retryDelay');
    }
    return d;
  }

  /** A jitter draw in [0, 1); anything else from the app's `clock.random` falls back to Math.random. */
  private jitter(): number {
    try {
      const r = this.options.random();
      if (r >= 0 && r < 1) return r;
      this.options.onFallback(new RangeError(`clock.random() returned ${String(r)}`), 'random');
    } catch (error) {
      this.options.onFallback(error, 'random');
    }
    return Math.random();
  }
}

/** `min(base × 2^k, max(base, 60 000))` after `k` consecutive timeouts of that kind (never above 2^31−1). */
export function adaptiveDeadline(base: number, consecutiveTimeouts: number): number {
  return Math.min(base * 2 ** consecutiveTimeouts, Math.max(base, DEADLINE_CAP), MAX_TIMER_DELAY);
}
