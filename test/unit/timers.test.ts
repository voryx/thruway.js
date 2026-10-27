// TimerScope and the core's timers: generations (a re-arm or a cancel makes a fired-but-unprocessed timer stale, a
// stale handle never cancels a newer timer), the late-fire grace of deadlines (one re-arm of min(duration, 3000) ms
// when a deadline fires more than max(1000, duration / 2) ms late, measured on now() and, for the system clock, on
// Date.now()), and clamping under clock skew: no delay outside [0, 2^31−1] is ever armed, and computed remainders stay
// within [0, their duration] whatever the clock does.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import { clockAccess, MAX_TIMER_DELAY, TimerScope, type ClockAccess } from '../../src/core/clock.js';
import { createSimClock, type SimClock } from '../../src/testing/sim.js';
import { createHarness, INTERNAL_OPTIONS_KEY as INTERNAL } from '../helpers/harness.js';
import { replayParameters } from '../setup-fast-check.js';

function scope(clock: SimClock = createSimClock(), wallNow?: () => number) {
  const s = clock.scope('client');
  const base = clockAccess(s, () => undefined);
  const access: ClockAccess = { ...base, now: () => base.now(), wallNow };
  const timers = new TimerScope(access);
  const fired: [string, number][] = [];
  const arm = (key: string, ms: number, deadline = false): number =>
    timers.arm(key, ms, (gen) => fired.push([key, gen]), deadline);
  return { clock, s, timers, fired, arm };
}

describe('generations', () => {
  test('arm returns increasing generations; re-arming a key replaces it (the old one never fires)', () => {
    const { clock, timers, fired, arm } = scope();
    const g1 = arm('connect', 100);
    const g2 = arm('connect', 200);
    expect(g2).toBeGreaterThan(g1);
    expect(timers.size).toBe(1);
    expect(timers.isCurrent('connect', g1)).toBe(false);
    expect(timers.isCurrent('connect', g2)).toBe(true);
    clock.advanceSync(150);
    expect(fired).toEqual([]);
    clock.advanceSync(50);
    expect(fired).toEqual([['connect', g2]]);
  });

  test('a fired timer stays known until it is claimed, once; size counts only armed timers', () => {
    const { clock, timers, fired, arm } = scope();
    const g = arm('handshake', 10);
    clock.advanceSync(10);
    expect(fired).toEqual([['handshake', g]]);
    expect(timers.size).toBe(0);
    expect(timers.isCurrent('handshake', g)).toBe(true);
    expect(timers.claim('handshake', g + 1)).toBe(false);
    expect(timers.claim('handshake', g)).toBe(true);
    expect(timers.claim('handshake', g)).toBe(false);
    expect(timers.isCurrent('handshake', g)).toBe(false);
  });

  test('an armed (not yet fired) timer cannot be claimed: its input would be a forgery', () => {
    const { timers, arm } = scope();
    const g = arm('stable', 1000);
    expect(timers.claim('stable', g)).toBe(false);
    expect(timers.size).toBe(1);
  });

  test('a re-arm or a cancel between the firing and the processing makes the fired input stale', () => {
    const { clock, timers, fired, arm } = scope();
    const g = arm('ping', 5);
    clock.advanceSync(5);
    expect(fired).toHaveLength(1);
    const g2 = arm('ping', 5); // the step that ran first re-armed it
    expect(timers.claim('ping', g)).toBe(false);
    clock.advanceSync(5);
    timers.cancel('ping'); // … or cancelled it
    expect(timers.claim('ping', g2)).toBe(false);
  });

  test('cancel(key, gen) with a stale generation leaves the newer timer armed; cancel of unknown keys is a no-op', () => {
    const { clock, timers, fired, arm } = scope();
    const old = arm('op:topic:7', 100);
    const fresh = arm('op:topic:7', 100);
    timers.cancel('op:topic:7', old);
    expect(timers.size).toBe(1);
    timers.cancel('nothing');
    timers.cancel('nothing', 3);
    clock.advanceSync(100);
    expect(fired).toEqual([['op:topic:7', fresh]]);
    timers.cancel('op:topic:7', fresh); // after it fired: forgets it
    expect(timers.claim('op:topic:7', fresh)).toBe(false);
  });

  test('clearAll disarms everything and forgets fired timers', () => {
    const { clock, s, timers, fired, arm } = scope();
    arm('a', 10);
    arm('b', 20);
    const c = arm('c', 1);
    clock.advanceSync(1);
    timers.clearAll();
    expect(timers.size).toBe(0);
    expect(s.pendingTimers).toBe(0);
    expect(timers.claim('c', c)).toBe(false);
    clock.advanceSync(100);
    expect(fired).toEqual([['c', c]]);
  });

  test('model: an input is claimed iff it is the last firing of its key and nothing re-armed or cancelled it (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant('arm' as const),
              key: fc.constantFrom('a', 'b'),
              ms: fc.integer({ min: 0, max: 30 }),
            }),
            fc.record({ op: fc.constant('cancel' as const), key: fc.constantFrom('a', 'b') }),
            fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 20 }) }),
            fc.record({ op: fc.constant('claim' as const), pick: fc.nat() }),
          ),
          { maxLength: 60 },
        ),
        (script) => {
          const { clock, timers, fired, arm } = scope();
          const model = new Map<string, { gen: number; fired: boolean }>();
          let delivered = 0;
          for (const step of script) {
            if (step.op === 'arm') model.set(step.key, { gen: arm(step.key, step.ms), fired: false });
            else if (step.op === 'cancel') {
              timers.cancel(step.key);
              model.delete(step.key);
            } else if (step.op === 'advance') clock.advanceSync(step.ms);
            else if (fired.length > 0) {
              const [key, gen] = fired[step.pick % fired.length]!;
              const m = model.get(key);
              const expected = m?.gen === gen && m.fired;
              expect(timers.claim(key, gen)).toBe(expected);
              if (expected) model.delete(key);
            }
            for (const [key, gen] of fired.slice(delivered)) {
              const m = model.get(key);
              expect(m?.gen).toBe(gen); // only the current generation ever fires
              if (m !== undefined) m.fired = true;
            }
            delivered = fired.length;
            expect(timers.size).toBe([...model.values()].filter((m) => !m.fired).length);
          }
        },
      ),
      replayParameters(),
    );
  });
});

describe('late-fire grace for deadlines', () => {
  test('a deadline that fires more than max(1000, d/2) late re-arms once for min(d, 3000); the second firing fails', () => {
    const { clock, fired, arm } = scope();
    arm('connect', 10000, true);
    clock.skew(6000); // now() jumped (a stall): the timer fires on schedule but 6 s "late"
    clock.advanceSync(10000);
    expect(fired).toEqual([]);
    clock.advanceSync(2999);
    expect(fired).toEqual([]);
    clock.advanceSync(1);
    expect(fired).toHaveLength(1);
  });

  test('lateness at or below the allowance fires at once; non-deadlines never get the grace', () => {
    const { clock, fired, arm } = scope();
    arm('handshake', 10000, true);
    clock.skew(5000); // exactly d/2 late: allowed
    clock.advanceSync(10000);
    expect(fired).toHaveLength(1);
    arm('idle', 100);
    clock.skew(60000);
    clock.advanceSync(100);
    expect(fired).toHaveLength(2);
  });

  test('short deadlines use the 1000 ms allowance and re-arm for their own duration', () => {
    const { clock, fired, arm } = scope();
    arm('ping', 200, true);
    clock.skew(1001);
    clock.advanceSync(200);
    expect(fired).toEqual([]);
    clock.advanceSync(200);
    expect(fired).toHaveLength(1);
  });

  test('a clock that went back is never "late": the deadline fires on schedule', () => {
    const { clock, fired, arm } = scope();
    arm('connect', 1000, true);
    clock.skew(-3600000);
    clock.advanceSync(1000);
    expect(fired).toHaveLength(1);
  });

  test('wall-clock lateness alone (device sleep stops the monotonic clock) also grants the grace', () => {
    let wall = 0;
    const { clock, fired, arm } = scope(createSimClock(), () => wall);
    arm('ping', 20000, true);
    wall = 20000 + 10001; // the wall clock says the device slept 10 s past the deadline; now() did not move
    clock.advanceSync(20000);
    expect(fired).toEqual([]);
    clock.advanceSync(3000);
    expect(fired).toHaveLength(1);
  });

  test('a deadline cancelled during its grace never fires', () => {
    const { clock, timers, fired, arm } = scope();
    arm('handshake', 1000, true);
    clock.skew(5000);
    clock.advanceSync(1000);
    timers.cancel('handshake'); // a frame arrived during the grace and won
    clock.advanceSync(5000);
    expect(fired).toEqual([]);
  });
});

// Which of the core's timers are deadlines: connect, handshake, ping and the request timers get the late-fire
// grace; idle (a probe trigger), stable, the settle window, retry and goodbye do not. Each case makes the timer fire
// 5 s "late" (the clock jumped while it ran: a stall or a suspend) and checks what happens at its due time.
describe('the core arms connect, handshake, ping and request timers as deadlines; idle is not one', () => {
  const LATE = 5000;
  const raw = (h: ReturnType<typeof createHarness>, frame: unknown[]): void => {
    h.router.sendRaw(JSON.stringify(frame));
  };

  test('connect: a late first firing re-arms for min(d, 3000); only the second fails', async () => {
    const h = createHarness({ seed: 31 });
    h.router.setAvailable('hang');
    const c = h.makeClient(Client, {
      options: { timeouts: { idle: 0, connect: 2000 }, retryOptions: { maxRetries: 0 } },
    });
    h.clock.skew(LATE);
    await h.clock.advance(2000);
    expect(c.onClose?.values).toEqual([]); // the grace: an open event that is already buffered would still win
    await h.clock.advance(2000);
    expect(c.onClose?.values.at(-1)?.error).toMatchObject({ timer: 'connect', timeout: 2000 });
    await h.finish();
  });

  test('handshake: a WELCOME that arrives during the grace wins', async () => {
    const h = createHarness({ seed: 32 });
    h.router.ignore((f) => f[0] === 1);
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0, handshake: 2000 } } });
    await h.clock.advance(1);
    h.clock.skew(LATE);
    await h.clock.advance(2000);
    expect(c.onClose?.values).toEqual([]);
    raw(h, [2, 7, { authid: 'a', roles: { dealer: {} } }]);
    await h.clock.advance(5000);
    expect(c.onClose?.values).toEqual([]);
    expect(c.client.session?.id).toBe(7);
    await h.finish();
  });

  test('ping: an unanswered probe fails only at the second firing', async () => {
    const h = createHarness({ seed: 33 });
    h.router.ignore((f) => f[0] === 48 && f[3] === 'thruway.js.ping');
    const c = h.makeClient(Client, {
      options: { timeouts: { idle: 1000 }, retryOptions: { maxRetries: 0 }, [INTERNAL]: { ping: 2000 } },
    });
    await h.clock.advance(1000); // the calibration probe is written
    h.clock.skew(LATE);
    await h.clock.advance(2000);
    expect(c.onClose?.values).toEqual([]);
    await h.clock.advance(2000);
    expect(c.onClose?.values.at(-1)?.error).toMatchObject({ timer: 'liveness' });
    await h.finish();
  });

  test('request: a SUBSCRIBED that arrives during the grace wins; the topic never errors', async () => {
    const h = createHarness({ seed: 34 });
    h.router.declareTopic('com.example.t');
    h.router.ignore((f) => f[0] === 32);
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0, request: 2000 } } });
    const topic = c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
    await h.clock.advance(1);
    const subscribe = c.trace().frames.find((f) => f.direction === 'in' && (f.frame as unknown[])[0] === 32);
    h.clock.skew(LATE);
    await h.clock.advance(2000);
    expect(topic.errored).toBe(false);
    raw(h, [33, (subscribe?.frame as unknown[])[1], 4242]);
    await h.clock.advance(5000);
    expect(topic.errored).toBe(false);
    expect(topic.closed).toBe(false);
    await h.finish();
  });

  test('idle is a probe trigger, not a deadline: a late idle timer probes at once', async () => {
    const h = createHarness({ seed: 35 });
    const c = h.makeClient(Client, { options: { timeouts: { idle: 1000 } } });
    await h.clock.advance(1);
    h.clock.skew(LATE);
    await h.clock.advance(999); // the calibration delay (1000 ms after WELCOME) is due now
    const probes = c
      .trace()
      .frames.filter((f) => f.direction === 'in' && (f.frame as unknown[])[3] === 'thruway.js.ping');
    expect(probes).toHaveLength(1);
    await h.finish();
  });
});

describe('clamping', () => {
  test('no delay outside [0, 2^31−1] reaches the clock', () => {
    const { s, timers } = scope();
    const delays: number[] = [];
    const access = clockAccess(
      {
        now: () => 0,
        setTimeout: (fn, ms) => {
          delays.push(ms);
          return s.setTimeout(fn, ms);
        },
        clearTimeout: (h) => {
          s.clearTimeout(h);
        },
      },
      () => undefined,
    );
    const t = new TimerScope(access);
    for (const ms of [Number.NaN, -1, 0, 5, MAX_TIMER_DELAY, MAX_TIMER_DELAY + 1, Number.POSITIVE_INFINITY]) {
      t.arm(String(ms), ms, () => undefined);
    }
    expect(delays).toEqual([0, 0, 0, 5, MAX_TIMER_DELAY, MAX_TIMER_DELAY, MAX_TIMER_DELAY]);
    t.clearAll();
    timers.clearAll();
  });

  test('under any skew the client arms only delays in [0, 2^31−1], and app-driven attempts never wait over 1 s (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('skew' as const), ms: fc.integer({ min: -3600000, max: 3600000 }) }),
            fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 3000 }) }),
            fc.record({ op: fc.constantFrom('open' as const, 'reconnect' as const, 'drop' as const) }),
          ),
          { maxLength: 30 },
        ),
        async (script) => {
          const h = createHarness({ seed: 9 });
          const c = h.makeClient(Client, { options: { timeouts: { idle: 2000 } } });
          for (const step of script) {
            if (step.op === 'skew') h.clock.skew(step.ms);
            else if (step.op === 'advance') await h.clock.advance(step.ms);
            else if (step.op === 'drop') h.router.drop();
            else if (step.op === 'open') c.open();
            else c.reconnect();
          }
          await h.clock.advance(70000);
          for (const t of c.trace().timers) {
            if (t.scope !== 'client' || t.action !== 'arm') continue;
            expect(t.delay).toBeGreaterThanOrEqual(0);
            expect(t.delay).toBeLessThanOrEqual(MAX_TIMER_DELAY);
          }
          expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' }); // it always gets back
          await h.finish();
        },
      ),
      { ...replayParameters(), numRuns: 40 },
    );
  });

  test('a clock that jumped back makes startSoon wait one floor, not the jump', async () => {
    const h = createHarness({ seed: 2 });
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0 }, retryOptions: { retryDelay: () => 50000 } } });
    await h.clock.advance(10);
    h.router.drop();
    await h.clock.advance(10);
    h.clock.skew(-3600000); // now() an hour before the attempt's start
    c.open();
    const retry = c
      .trace()
      .timers.filter((t) => t.scope === 'client' && t.action === 'arm')
      .at(-1);
    expect(retry?.delay).toBe(1000);
    await h.clock.advance(1000);
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
    await h.finish();
  });
});

describe('a clock whose clearTimeout does not clear', () => {
  test('a cancelled or replaced timer whose platform callback still fires is ignored', () => {
    const pending: (() => void)[] = [];
    const access = clockAccess(
      {
        now: () => 0,
        setTimeout: (fn) => {
          pending.push(fn);
          return pending.length;
        },
        clearTimeout: () => undefined, // broken: nothing is cleared
      },
      () => undefined,
    );
    const timers = new TimerScope(access);
    const fired: number[] = [];
    timers.arm('connect', 10, (gen) => fired.push(gen));
    const second = timers.arm('connect', 10, (gen) => fired.push(gen)); // replaces the first
    timers.arm('idle', 10, (gen) => fired.push(gen));
    timers.cancel('idle');
    for (const fn of pending) fn(); // all three platform callbacks fire anyway
    expect(fired).toEqual([second]);
  });
});
