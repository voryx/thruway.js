// The default clock and the core's view of the app's clock: the system clock over its host (performance.now or
// Date.now, the host timers, 53-bit WebCrypto randomness or Math.random), `clampDelay`, and `clockAccess`, which never
// throws: a failing now() reads as the last good value, a throwing setTimeout falls back to the platform timer (so no
// timer is lost), a throwing clearTimeout is ignored — each reported once per failure.
import { describe, expect, test, vi } from 'vitest';
import {
  clampDelay,
  clockAccess,
  createSystemClock,
  MAX_TIMER_DELAY,
  platformTimers,
  randomWords,
  systemClock,
  type ClockRoot,
} from '../../src/core/clock.js';
import type { Clock } from '../../src/types.js';

function root(overrides: Partial<ClockRoot> = {}): ClockRoot & { timers: unknown[][]; cleared: unknown[] } {
  const timers: unknown[][] = [];
  const cleared: unknown[] = [];
  return {
    timers,
    cleared,
    setTimeout: (fn, ms) => {
      timers.push([fn, ms]);
      return `handle-${String(timers.length)}`;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
    ...overrides,
  };
}

describe('the system clock', () => {
  test('now() is performance.now() when the host has it, Date.now() otherwise (looked up at each call)', () => {
    const perf = { now: vi.fn(() => 123.5) };
    const host = root({ performance: perf });
    const clock = createSystemClock(host);
    expect(clock.now()).toBe(123.5);
    expect(perf.now).toHaveBeenCalledTimes(1);
    const bare = createSystemClock(root());
    const spy = vi.spyOn(Date, 'now').mockReturnValue(42);
    try {
      expect(bare.now()).toBe(42);
      expect(createSystemClock(root({ performance: {} })).now()).toBe(42);
    } finally {
      spy.mockRestore();
    }
  });

  test('setTimeout and clearTimeout are the host timers', () => {
    const host = root();
    const clock = createSystemClock(host);
    const fn = (): void => undefined;
    expect(clock.setTimeout(fn, 25)).toBe('handle-1');
    clock.clearTimeout('handle-1');
    expect(host.timers).toEqual([[fn, 25]]);
    expect(host.cleared).toEqual(['handle-1']);
  });

  test('random() takes 53 bits from two WebCrypto words: (r0 >>> 5)·2^26 + (r1 >>> 6), over 2^53', () => {
    const values = [
      [0, 0],
      [0xffffffff, 0xffffffff],
      [0x80000000, 0x00000040],
    ];
    let i = 0;
    const host = root({
      crypto: {
        getRandomValues: (array: Uint32Array) => {
          const [a, b] = values[i++] as [number, number];
          array[0] = a;
          array[1] = b;
          return array;
        },
      },
    });
    const clock = createSystemClock(host);
    expect(clock.random()).toBe(0);
    expect(clock.random()).toBe((2 ** 53 - 1) / 2 ** 53);
    expect(clock.random()).toBe(((0x80000000 >>> 5) * 2 ** 26 + 1) / 2 ** 53);
  });

  test('random() is Math.random without a usable WebCrypto (Hermes)', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.75);
    try {
      expect(createSystemClock(root()).random()).toBe(0.75);
      expect(createSystemClock(root({ crypto: {} })).random()).toBe(0.75);
      const throwing = root({
        crypto: {
          getRandomValues: () => {
            throw new Error('QuotaExceededError');
          },
        },
      });
      expect(createSystemClock(throwing).random()).toBe(0.75);
    } finally {
      spy.mockRestore();
    }
  });

  test('randomWords: two 32-bit words, or undefined', () => {
    expect(randomWords({})).toBeUndefined();
    const words = randomWords(globalThis);
    expect(words).toHaveLength(2);
    for (const w of words ?? []) expect(Number.isInteger(w) && w >= 0 && w < 2 ** 32).toBe(true);
  });

  test('systemClock runs on globalThis: a real monotonic now, real timers, values in [0, 1)', async () => {
    const a = systemClock.now();
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(resolve, 5);
    });
    expect(systemClock.now()).toBeGreaterThanOrEqual(a);
    let fired = false;
    const handle = systemClock.setTimeout(() => {
      fired = true;
    }, 1);
    systemClock.clearTimeout(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).toBe(false);
    for (let i = 0; i < 100; i++) {
      const r = systemClock.random();
      expect(r >= 0 && r < 1).toBe(true);
    }
  });
});

describe('clampDelay', () => {
  test('[0, 2^31−1] by default; NaN and negatives are 0; a custom max', () => {
    expect(clampDelay(Number.NaN)).toBe(0);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(-0)).toBe(0);
    expect(clampDelay(0)).toBe(0);
    expect(clampDelay(10.5)).toBe(10.5);
    expect(clampDelay(MAX_TIMER_DELAY)).toBe(MAX_TIMER_DELAY);
    expect(clampDelay(MAX_TIMER_DELAY + 1)).toBe(MAX_TIMER_DELAY);
    expect(clampDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY);
    expect(clampDelay(1500, 1000)).toBe(1000);
  });
});

describe('clockAccess (the core never trusts the app clock to behave)', () => {
  function fake(overrides: Partial<Clock> = {}): Clock & { set: unknown[][]; cleared: unknown[] } {
    const set: unknown[][] = [];
    const cleared: unknown[] = [];
    return {
      set,
      cleared,
      now: () => 5,
      setTimeout: (fn, ms) => {
        set.push([fn, ms]);
        return set.length;
      },
      clearTimeout: (h) => {
        cleared.push(h);
      },
      ...overrides,
    };
  }

  test('now() passes finite readings through; a throw or a non-finite reading is the last good value', () => {
    const errors: unknown[][] = [];
    let reading: () => number = () => 10;
    const access = clockAccess(
      fake({
        now: () => reading(),
      }),
      (e, what) => errors.push([e, what]),
    );
    expect(access.now()).toBe(10);
    reading = () => Number.NaN;
    expect(access.now()).toBe(10);
    reading = () => {
      throw new Error('clock broken');
    };
    expect(access.now()).toBe(10);
    reading = () => 20;
    expect(access.now()).toBe(20);
    expect(errors.map((e) => e[1])).toEqual(['now', 'now']);
    expect(String(errors[0]?.[0])).toMatch(/returned NaN/);
  });

  test('before any good reading the fallback is 0', () => {
    const access = clockAccess(
      fake({
        now: () => Number.POSITIVE_INFINITY,
      }),
      () => undefined,
    );
    expect(access.now()).toBe(0);
  });

  test('set() clamps the delay and uses the clock; clear() clears with the clock', () => {
    const clock = fake();
    const access = clockAccess(clock, () => undefined);
    const fn = (): void => undefined;
    const handle = access.set(fn, MAX_TIMER_DELAY * 2);
    expect(clock.set).toEqual([[fn, MAX_TIMER_DELAY]]);
    access.set(fn, -3);
    expect(clock.set[1]?.[1]).toBe(0);
    access.clear(handle);
    expect(clock.cleared).toEqual([1]);
  });

  test('a throwing setTimeout falls back to the platform timer, which still fires; clear() clears it there', async () => {
    const errors: string[] = [];
    const clock = fake({
      setTimeout: () => {
        throw new Error('no timers here');
      },
    });
    const access = clockAccess(clock, (_e, what) => errors.push(what));
    const fired = new Promise<void>((resolve) => {
      access.set(resolve, 1);
    });
    await fired;
    expect(errors).toEqual(['setTimeout']);
    const spy = vi.spyOn(platformTimers, 'clearTimeout');
    try {
      let late = false;
      const handle = access.set(() => {
        late = true;
      }, 1);
      access.clear(handle);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(clock.cleared).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(late).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('a throwing clearTimeout is reported and ignored; an object handle of the clock is cleared by the clock', () => {
    const errors: string[] = [];
    const objectHandle = { id: 1 };
    const clock = fake({
      setTimeout: () => objectHandle,
      clearTimeout: () => {
        throw new Error('nope');
      },
    });
    const access = clockAccess(clock, (_e, what) => errors.push(what));
    const handle = access.set(() => undefined, 5);
    expect(handle).toBe(objectHandle);
    expect(() => {
      access.clear(handle);
    }).not.toThrow();
    expect(errors).toEqual(['clearTimeout']);
  });

  test('wallNow is Date.now for the system clock only (suspend detection)', () => {
    expect(clockAccess(systemClock, () => undefined).wallNow).toBe(Date.now);
    expect(clockAccess(fake(), () => undefined).wallNow).toBeUndefined();
  });

  test('platformTimers are the global timers', async () => {
    let fired = 0;
    const handle = platformTimers.setTimeout(() => {
      fired++;
    }, 1);
    platformTimers.clearTimeout(handle);
    await new Promise<void>((resolve) => {
      platformTimers.setTimeout(resolve, 2);
    });
    expect(fired).toBe(0);
  });
});
