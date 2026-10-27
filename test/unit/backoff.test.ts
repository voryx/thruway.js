// Backoff: the full-jitter formula and its bounds, the 100 ms floor (also for a custom retryDelay), `null` ⇒ give-up,
// fallbacks for a throwing/unusable strategy or jitter source, the adaptive deadlines — as unit properties of
// src/core/backoff.ts — and, through the real Client in the simulation, the 60 s stable reset, exactly N+1 attempts
// with `maxRetries: N`, the 1 s floor of app-driven attempts and the doubling connect/handshake deadlines.
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { adaptiveDeadline, Backoff, DEADLINE_CAP, RETRY_FLOOR, type BackoffOptions } from '../../src/core/backoff.js';
import { MAX_TIMER_DELAY } from '../../src/core/clock.js';
import { isThruwayError } from '../../src/errors.js';
import type { CloseInfo, RetryOptions } from '../../src/types.js';
import { createHarness, INTERNAL_OPTIONS_KEY, type Harness, type HarnessOptions } from '../helpers/harness.js';
import { replayParameters } from '../setup-fast-check.js';

const INFO: CloseInfo = Object.freeze({
  initiator: 'connection',
  reason: undefined,
  details: {},
  closeCode: 1006,
  wasClean: false,
  sessionId: undefined,
  error: undefined,
  willRetry: true,
  delay: 0,
  attempt: 1,
});

function backoff(options: Partial<BackoffOptions> = {}): { b: Backoff; fallbacks: unknown[][] } {
  const fallbacks: unknown[][] = [];
  const b = new Backoff({
    initialRetryDelay: 1500,
    retryDelayGrowth: 1.5,
    maxRetryDelay: 60000,
    retryDelay: undefined,
    random: () => 0.5,
    onFallback: (...args) => fallbacks.push(args),
    ...options,
  });
  return { b, fallbacks };
}

const unit = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

describe('the built-in full-jitter delay', () => {
  test('random() × min(max, initial × growth^(n−1)), floored, never under 100 or over the cap (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.double({ min: 1, max: 10, noNaN: true }),
        fc.integer({ min: 100, max: MAX_TIMER_DELAY }),
        fc.integer({ min: 1, max: 2000 }),
        unit,
        (initial, growth, max, n, r) => {
          const { b, fallbacks } = backoff({
            initialRetryDelay: initial,
            retryDelayGrowth: growth,
            maxRetryDelay: max,
            random: () => r,
          });
          const d = b.defaultDelay(n);
          let base = initial * growth ** (n - 1);
          if (!Number.isFinite(base) || base > max) base = max;
          expect(d).toBe(Math.floor(Math.min(Math.max(r * base, RETRY_FLOOR), max)));
          expect(Number.isInteger(d)).toBe(true);
          expect(d).toBeGreaterThanOrEqual(RETRY_FLOOR);
          expect(d).toBeLessThanOrEqual(Math.min(max, MAX_TIMER_DELAY));
          expect(fallbacks).toEqual([]);
        },
      ),
      replayParameters(),
    );
  });

  test('defaults 1500 / 1.5 / 60 000: the first retry within 0.1–1.5 s, the cap reached around attempt 11', () => {
    const lo = backoff({ random: () => 0 }).b;
    const hi = backoff({ random: () => 0.999999 }).b;
    expect(lo.defaultDelay(1)).toBe(100);
    expect(hi.defaultDelay(1)).toBe(1499);
    expect(hi.defaultDelay(10)).toBeLessThan(60000 * 0.999999);
    expect(hi.defaultDelay(11)).toBe(Math.floor(60000 * 0.999999));
    expect(hi.defaultDelay(1000)).toBe(Math.floor(60000 * 0.999999)); // growth^999 is Infinity: the cap
  });

  test('a jitter source that throws or leaves [0, 1) falls back to Math.random and is reported', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      for (const random of [
        () => {
          throw new Error('broken');
        },
        () => 1,
        () => -0.5,
        () => Number.NaN,
      ]) {
        const { b, fallbacks } = backoff({ initialRetryDelay: 4000, random });
        expect(b.defaultDelay(1)).toBe(1000);
        expect(fallbacks).toHaveLength(1);
        expect(fallbacks[0]?.[1]).toBe('random');
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a custom retryDelay', () => {
  test('receives (attempt, the provisional CloseInfo built with the default, the default) once per call', () => {
    const custom = vi.fn((_n: number, _c: CloseInfo, d: number) => d + 1);
    const { b } = backoff({ retryDelay: custom, random: () => 0.5 });
    const info = vi.fn((d: number) => ({ ...INFO, delay: d }));
    expect(b.delay(1, info)).toBe(751);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(750);
    expect(custom).toHaveBeenCalledWith(1, { ...INFO, delay: 750 }, 750);
  });

  test('its result is clamped to [100, 2^31−1] and floored; null gives up (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constant(null)),
        fc.integer({ min: 1, max: 50 }),
        (value, n) => {
          const { b, fallbacks } = backoff({ retryDelay: () => value });
          const d = b.delay(n, () => INFO);
          if (value === null) expect(d).toBeNull();
          else expect(d).toBe(Math.floor(Math.min(Math.max(value, RETRY_FLOOR), MAX_TIMER_DELAY)));
          expect(fallbacks).toEqual([]);
        },
      ),
      replayParameters(),
    );
  });

  test('a throw, a non-finite number or a non-number falls back to the default and is reported', () => {
    const results: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, '500', undefined, {}];
    for (const value of results) {
      const { b, fallbacks } = backoff({ retryDelay: (() => value) as RetryOptions['retryDelay'] });
      expect(b.delay(1, () => INFO)).toBe(750);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.[1]).toBe('retryDelay');
    }
    const error = new Error('strategy bug');
    const { b, fallbacks } = backoff({
      retryDelay: () => {
        throw error;
      },
    });
    expect(b.delay(1, () => INFO)).toBe(750);
    expect(fallbacks).toEqual([[error, 'retryDelay']]);
  });

  test('without a custom strategy delay() is the default and builds no CloseInfo', () => {
    const { b } = backoff();
    const info = vi.fn(() => INFO);
    expect(b.delay(2, info)).toBe(1125);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('the consecutive-failure counter', () => {
  test('fail() counts, reset() and markStable() go back to 0', () => {
    const { b } = backoff();
    expect(b.attempts).toBe(0);
    expect([b.fail(), b.fail(), b.fail()]).toEqual([1, 2, 3]);
    expect(b.attempts).toBe(3);
    b.markStable();
    expect(b.attempts).toBe(0);
    b.fail();
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.fail()).toBe(1);
  });
});

describe('adaptive deadlines', () => {
  test('min(base × 2^k, max(base, 60 000)): doubling, capped, never below the base (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_TIMER_DELAY }), fc.integer({ min: 0, max: 80 }), (base, k) => {
        const d = adaptiveDeadline(base, k);
        expect(d).toBe(Math.min(base * 2 ** k, Math.max(base, DEADLINE_CAP), MAX_TIMER_DELAY));
        expect(d).toBeGreaterThanOrEqual(base);
        expect(d).toBeLessThanOrEqual(Math.max(base, DEADLINE_CAP));
        expect(adaptiveDeadline(base, k + 1)).toBeGreaterThanOrEqual(d);
      }),
      replayParameters(),
    );
    expect([0, 1, 2, 3, 4].map((k) => adaptiveDeadline(10000, k))).toEqual([10000, 20000, 40000, 60000, 60000]);
    expect(adaptiveDeadline(90000, 3)).toBe(90000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the real client (deterministic simulation)
// ---------------------------------------------------------------------------------------------------------------------

/** A client against the sim router (`setup` runs before the client is built, so availability applies to its first
 *  attempt); `idle: 0` keeps liveness out of these runs. */
function sim(
  options: Record<string | symbol, unknown> = {},
  setup: (h: Harness) => void = () => undefined,
  seed = 1,
  router: HarnessOptions['router'] = {},
) {
  const h = createHarness({ seed, router });
  setup(h);
  const c = h.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
  const attemptsStarted = () => c.trace().logs.filter((l) => l.entry.event === 'attempt.start');
  return { h, c, attemptsStarted };
}

const refuse = (h: Harness): void => {
  h.router.setAvailable('refuse');
};

function closes(c: { onClose: { values: readonly CloseInfo[] } | undefined }): readonly CloseInfo[] {
  return c.onClose?.values ?? [];
}

describe('maxRetries: exactly N+1 attempts, then give-up', () => {
  test('property over N and the failure kind', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom('refuse', 'error-only', 'abort'),
        fc.integer({ min: 1, max: 1000 }),
        async (n, failure, seed) => {
          const { h, c, attemptsStarted } = sim(
            { retryOptions: { maxRetries: n } },
            (harness) => {
              if (failure !== 'abort') harness.router.setAvailable(failure);
            },
            seed,
            failure === 'abort' ? { authenticate: () => ({ abort: 'wamp.error.no_such_realm' }) } : {},
          );
          const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
          await h.clock.runUntilIdle();
          expect(attemptsStarted()).toHaveLength(n + 1);
          const infos = closes(c);
          expect(infos.map((i) => i.attempt)).toEqual(Array.from({ length: n + 1 }, (_, i) => i + 1));
          expect(infos.map((i) => i.willRetry)).toEqual([...Array<boolean>(n).fill(true), false]);
          expect(call.errored).toBe(true);
          expect(isThruwayError(call.error) && call.error.code).toBe('connection_closed');
          expect((call.error as { gaveUp: boolean }).gaveUp).toBe(true);
          await h.finish();
        },
      ),
      { ...replayParameters(), numRuns: 30 },
    );
  });

  test('maxRetries 0 fails fast: one attempt, then the stop error for waiting work', async () => {
    const { h, c } = sim({ retryOptions: { maxRetries: 0 } }, refuse);
    const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await h.clock.runUntilIdle();
    expect(closes(c).map((i) => [i.attempt, i.willRetry, i.delay])).toEqual([[1, false, undefined]]);
    expect(call.errored).toBe(true);
    await h.finish();
  });

  test('a custom retryDelay that returns null gives up at once (recipe 9), whatever maxRetries says', async () => {
    const { h, c } = sim({ retryOptions: { retryDelay: (n: number) => (n >= 3 ? null : 100) } }, refuse);
    await h.clock.runUntilIdle();
    expect(closes(c).map((i) => [i.attempt, i.willRetry, i.delay])).toEqual([
      [1, true, 100],
      [2, true, 100],
      [3, false, undefined],
    ]);
    await h.finish();
  });

  test('every default-strategy delay is in [100, maxRetryDelay] and the next attempt starts after it', async () => {
    const { h, c } = sim({ retryOptions: { maxRetries: 12, maxRetryDelay: 5000 } }, refuse);
    await h.clock.runUntilIdle();
    const infos = closes(c);
    expect(infos).toHaveLength(13);
    const starts = c
      .trace()
      .logs.filter((l) => l.entry.event === 'attempt.start')
      .map((l) => l.at);
    for (const [i, info] of infos.slice(0, -1).entries()) {
      expect(info.delay).toBeGreaterThanOrEqual(100);
      expect(info.delay).toBeLessThanOrEqual(5000);
      const ended = c.trace().closeInfos[i]!.at;
      expect(starts[i + 1]).toBe(ended + info.delay!);
    }
    await h.finish();
  });
});

describe('the counter resets only once a session stayed up for 60 s', () => {
  test('sessions shorter than the stable window keep backing off; a long one resets to 1', async () => {
    const { h, c } = sim();
    await h.clock.advance(50000);
    for (let i = 0; i < 3; i++) {
      h.router.drop(); // each session lasted less than 60 s
      await h.clock.advance(50000); // the retry fires (≤ 3.4 s), WELCOME, then most of a minute
    }
    expect(closes(c).map((i) => i.attempt)).toEqual([1, 2, 3]);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
    await h.clock.advance(15000); // this session reaches the stable window
    h.router.drop();
    await h.clock.advance(10);
    expect(closes(c).map((i) => i.attempt)).toEqual([1, 2, 3, 1]);
    await h.finish();
  });

  test('a socket that opens but fails the handshake never resets the counter', async () => {
    const { h, c } = sim({ timeouts: { idle: 0, handshake: 1000 } }, (harness) => {
      harness.router.ignore((frame) => frame[0] === 1); // HELLO never answered
    });
    await h.clock.advance(30000);
    const attempts = closes(c).map((i) => i.attempt);
    expect(attempts.length).toBeGreaterThan(3);
    expect(attempts).toEqual(attempts.map((_, i) => i + 1));
    await h.finish();
  });

  test('a shorter internal stable window is honoured (fast profile)', async () => {
    const { h, c } = sim({ [INTERNAL_OPTIONS_KEY]: { stable: 500 } });
    await h.clock.advance(10);
    h.router.drop();
    await h.clock.advance(5000);
    await h.clock.advance(600);
    h.router.drop();
    await h.clock.advance(10);
    expect(closes(c).map((i) => i.attempt)).toEqual([1, 1]);
    await h.finish();
  });
});

describe('the 1 s floor of app-driven attempts', () => {
  test('open(), reconnect() and close() storms never start two attempts within 1 s (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            wait: fc.integer({ min: 0, max: 700 }),
            call: fc.constantFrom('open', 'reconnect', 'close'),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        fc.boolean(),
        async (storm, refusing) => {
          const { h, c } = sim({}, (harness) => {
            if (refusing) harness.router.setAvailable('refuse');
          });
          for (const step of storm) {
            await h.clock.advance(step.wait);
            if (step.call === 'open') c.open();
            else if (step.call === 'reconnect') c.reconnect();
            else void c.close();
          }
          await h.clock.advance(2000);
          const trace = c.trace();
          const starts = trace.logs.filter((l) => l.entry.event === 'attempt.start').map((l) => l.at);
          for (let i = 1; i < starts.length; i++) {
            const start = starts[i]!;
            const previous = starts[i - 1]!;
            // an attempt within 1 s of the previous one's start can only be the retry an end scheduled (backoff)
            const scheduled = trace.closeInfos.some(
              (e) => e.at >= previous && e.at <= start && e.info.willRetry && e.at + (e.info.delay ?? 0) === start,
            );
            if (!scheduled) expect(start - previous).toBeGreaterThanOrEqual(1000);
          }
          expect(trace.api.filter((a) => !a.resolved)).toHaveLength(storm.length);
          await h.finish();
        },
      ),
      { ...replayParameters(), numRuns: 40 },
    );
  });

  test('reconnect() right after an attempt started waits for the rest of the floor', async () => {
    const { h, c } = sim();
    await h.clock.advance(300);
    c.reconnect();
    const starts = () =>
      c
        .trace()
        .logs.filter((l) => l.entry.event === 'attempt.start')
        .map((l) => l.at);
    expect(starts()).toEqual([0]);
    await h.clock.advance(699);
    expect(starts()).toEqual([0]);
    await h.clock.advance(1);
    expect(starts()).toEqual([0, 1000]);
    c.reconnect();
    c.reconnect();
    await h.clock.advance(999);
    expect(starts()).toEqual([0, 1000]);
    await h.clock.advance(1);
    expect(starts()).toEqual([0, 1000, 2000]);
    await h.finish();
  });

  test('open() while waiting never postpones a retry that is due before the floor ends (it cuts, never lengthens)', async () => {
    const { h, c, attemptsStarted } = sim({ autoOpen: false, retryOptions: { retryDelay: () => 200 } }, refuse);
    c.open();
    await h.clock.advance(10);
    expect(closes(c).map((i) => i.delay)).toEqual([200]); // the retry is due at 200 ms
    c.open(); // 990 ms of the floor are left: the sooner retry stays
    c.reconnect();
    await h.clock.advance(199);
    expect(attemptsStarted().map((l) => l.at)).toEqual([0, 200]);
    h.router.setAvailable('ok');
    await h.finish();
  });

  test('close() + open() cycles (a render loop) never start two attempts within 1 s', async () => {
    const { h, c, attemptsStarted } = sim();
    for (let i = 0; i < 25; i++) {
      await h.clock.advance(40);
      void c.close();
      c.open();
    }
    await h.clock.advance(2000);
    const starts = attemptsStarted().map((l) => l.at);
    expect(starts).toEqual([0, 1000, 2000]);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
    await h.finish();
  });

  test('open() while waiting cuts the backoff wait (counter kept), never earlier than the floor', async () => {
    const { h, c } = sim({ retryOptions: { retryDelay: () => 100000 } });
    await h.clock.advance(500);
    h.router.drop();
    await h.clock.advance(10);
    expect(closes(c).at(-1)?.delay).toBe(100000);
    c.open(); // 510 ms after the attempt started: the rest of the floor first
    await h.clock.advance(489);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'closed' });
    await h.clock.advance(1);
    // the counter was kept: this is attempt 2
    expect(c.status?.values.slice(-2)).toMatchObject([{ state: 'connecting', attempt: 2 }, { state: 'open' }]);
    await h.finish();
  });
});

describe('adaptive connect and handshake deadlines in the client', () => {
  test('consecutive connect timeouts double the deadline up to 60 s; a socket open resets it', async () => {
    const { h, c } = sim({ retryOptions: { initialRetryDelay: 0, maxRetryDelay: 100 } }, (harness) => {
      harness.router.setAvailable('hang');
    });
    await h.clock.advance(10000 + 100 + 20000 + 100 + 40000 + 100 + 60000 + 100 + 60000);
    const timeouts = closes(c).map((i) => (i.error as { timeout?: number }).timeout);
    expect(timeouts).toEqual([10000, 20000, 40000, 60000, 60000]);
    h.router.setAvailable('ok');
    await h.clock.advance(60200);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
    h.router.setAvailable('hang');
    h.router.drop();
    await h.clock.advance(10200);
    expect((closes(c).at(-1)?.error as { timeout?: number }).timeout).toBe(10000);
    await h.finish();
  });

  test('consecutive handshake timeouts double too; a WELCOME resets them', async () => {
    let heal = (): void => undefined;
    const { h, c } = sim(
      { timeouts: { idle: 0, handshake: 1000 }, retryOptions: { initialRetryDelay: 0, maxRetryDelay: 100 } },
      (harness) => {
        heal = harness.router.ignore((frame) => frame[0] === 1);
      },
    );
    await h.clock.advance(1000 + 100 + 2000 + 100 + 4000 + 50);
    expect(closes(c).map((i) => (i.error as { timeout?: number }).timeout)).toEqual([1000, 2000, 4000]);
    heal();
    await h.clock.advance(8200);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
    const stop = h.router.ignore((frame) => frame[0] === 1);
    h.router.drop();
    await h.clock.advance(1200);
    stop();
    expect((closes(c).at(-1)?.error as { timeout?: number }).timeout).toBe(1000);
    await h.finish();
  });
});
