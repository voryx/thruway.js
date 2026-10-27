// Unit tests of src/ops/liveness.ts. Liveness is driven through a small fake core (`Core` below) that implements the
// frozen `LivenessHost` the way the real core uses it: `timer.idle`/`timer.ping` with generations (arming replaces),
// cleared at the session end before `sessionEnded`; `later()` callbacks run after the step and are dropped once their
// session ended; `onPing` → 'dead' ends the session (release 4001 + end); `endpoint(url)` before `start` at each
// WELCOME when a URL is set. The session ctx is fake-ctx's, whose `request()` reports every accepted write to
// `liveness.wrote` as the real ctx does — also the probe's own write — and whose `send()` reports every accepted write
// to `liveness.sent`. Timers run on real (virtual) time; `skew` moves only the clock the client reads.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { LivenessHost, SessionCtx } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { callFrame, yieldFrame, type InboundMessage, type OutboundFrame } from '../../src/protocol/messages.js';
import {
  CALIBRATION_DELAY,
  CHECK_SILENCE,
  DRAIN_RECHECK,
  ENDPOINT_MEMORY,
  Liveness,
  PING_BUDGET_CAP,
  REARM_SLACK,
} from '../../src/ops/liveness.js';
import { FakeSessionCtx, inbound } from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

const IDLE = 30000;
const BUDGET = 20000;
const HOUR = 3600000;
const MAX_DELAY = 2 ** 31 - 1;
const DEALER: Readonly<Record<string, unknown>> = Object.freeze({
  broker: Object.freeze({}),
  dealer: Object.freeze({}),
});

/** The fake ctx, reporting each accepted request (from inside `request`, as the core's ctx does) and each accepted
 *  `send` (the core reports it to `liveness.sent`). */
class CoreCtx extends FakeSessionCtx {
  onWritten: ((id: number, frame: OutboundFrame, expectsReply: boolean) => void) | undefined;
  onSent: (() => void) | undefined;

  override send(frame: OutboundFrame): boolean {
    const sent = super.send(frame);
    if (sent) this.onSent?.();
    return sent;
  }

  override request(build: (requestId: number) => OutboundFrame, expectsReply = true): number | undefined {
    const id = super.request(build, expectsReply);
    const last = this.written[this.written.length - 1];
    if (id !== undefined && last !== undefined) this.onWritten?.(id, last.frame, expectsReply);
    return id;
  }
}

function isProbe(frame: OutboundFrame): boolean {
  return frame[0] === MessageType.CALL && frame[3] === Uri.PING_PROCEDURE;
}

function answersProbe(msg: InboundMessage, id: number): boolean {
  return (
    (msg.type === MessageType.RESULT ||
      (msg.type === MessageType.ERROR && (msg.requestType === 48 || msg.requestType === 49))) &&
    msg.requestId === id
  );
}

interface HostTimer {
  readonly kind: 'idle' | 'ping';
  readonly conn: number;
  readonly ms: number;
  /** Real time when armed / due. */
  readonly at: number;
  readonly due: number;
  readonly seq: number;
  state: 'armed' | 'fired' | 'replaced' | 'cancelled' | 'cleared';
}

interface ProbeWrite {
  readonly conn: number;
  readonly id: number;
  readonly real: number;
  answered: boolean;
  /** Liveness gave it up unanswered and the session lives on (saved on proof of activity, or probing turned off). */
  dropped: boolean;
  /** Saved on proof of activity: liveness consumes its late answer (once). */
  forgiven: boolean;
}

class Core implements LivenessHost {
  readonly idle: number;
  readonly pingBudget: number;
  readonly liveness: Liveness;
  /** Virtual real time (timers) and the skew of the clock the client reads (`ctx.now = real + skew`). */
  real = 0;
  skew = 0;
  /** Replaces `real + skew` as the client's clock (NaN, frozen). */
  clock: number | undefined;
  buffered = 0;
  roles: Readonly<Record<string, unknown>> = DEALER;
  /** The URL each new connection resolves to: reported with `endpoint()` before `start` (undefined: never called). */
  url: string | undefined;
  /** Start a new session at once after a liveness death (property runs). */
  autoReconnect = false;
  /** Called at each WELCOME, before liveness hears of it (property runs). */
  onWelcome: ((ctx: CoreCtx) => void) | undefined;
  /** Called when liveness keeps a session although its probe went unanswered (proof of activity). */
  onSave: (() => void) | undefined;
  readonly timers: HostTimer[] = [];
  readonly probes: ProbeWrite[] = [];
  readonly ctxs: CoreCtx[] = [];
  readonly welcomedAt = new Map<number, number>();
  readonly ended = new Set<number>();
  readonly deaths: number[] = [];
  /** Real time of each death. */
  readonly deathTimes: number[] = [];
  /** Real time of each probe that went unanswered and was forgiven. */
  readonly saves: number[] = [];
  /** Contract breaches seen by the host (asserted empty). */
  readonly failures: string[] = [];
  ctx: CoreCtx | undefined;
  inStep = false;
  /** The probe whose ping timer is being decided: only it may be replaced by a new probe (a save). */
  private pinging: ProbeWrite | undefined;
  private readonly laterQueue: { readonly conn: number; readonly fn: () => void }[] = [];
  private seq = 0;
  private nextConn = 1;

  constructor(options: { readonly idle?: number; readonly pingBudget?: number } = {}) {
    this.idle = options.idle ?? IDLE;
    this.pingBudget = options.pingBudget ?? BUDGET;
    this.liveness = new Liveness(this);
  }

  get now(): number {
    return this.clock ?? this.real + this.skew;
  }

  // ------------------------------------------------------------------------------------------------ LivenessHost

  armIdle(ctx: SessionCtx, ms: number): void {
    this.arm('idle', ctx, ms);
  }

  armPing(ctx: SessionCtx, ms: number): void {
    this.arm('ping', ctx, ms);
  }

  cancelPing(ctx: SessionCtx): void {
    this.expectCurrent(ctx, 'cancelPing');
    for (const t of this.timers) {
      if (t.kind === 'ping' && t.conn === ctx.connId && t.state === 'armed') t.state = 'cancelled';
    }
  }

  bufferedAmount(ctx: SessionCtx): number {
    this.expectCurrent(ctx, 'bufferedAmount');
    return this.buffered;
  }

  later(ctx: SessionCtx, fn: () => void): void {
    this.expectCurrent(ctx, 'later');
    if (!this.inStep) this.failures.push('later() outside a step');
    this.laterQueue.push({ conn: ctx.connId, fn });
  }

  // ------------------------------------------------------------------------------------------------ driving

  /** WELCOME: a new session (and connection id) with `liveness.start`. */
  welcome(roles: Readonly<Record<string, unknown>> = this.roles): CoreCtx {
    const ctx = new CoreCtx({ connId: this.nextConn, now: this.now, session: { id: this.nextConn } });
    this.nextConn++;
    ctx.onWritten = (id, frame, expectsReply) => {
      if (isProbe(frame)) {
        const inFlight = this.pendingProbe(ctx.connId);
        if (inFlight !== undefined) {
          // only a probe given up in its own ping step (saved and probed again at once) may be replaced
          if (this.pinging !== inFlight) this.failures.push(`a second probe in flight on conn ${String(ctx.connId)}`);
          inFlight.dropped = true;
        }
        this.probes.push({ conn: ctx.connId, id, real: this.real, answered: false, dropped: false, forgiven: false });
      }
      this.liveness.wrote(expectsReply, ctx);
    };
    ctx.onSent = () => {
      this.liveness.sent(ctx);
    };
    this.ctxs.push(ctx);
    this.ctx = ctx;
    this.welcomedAt.set(ctx.connId, this.real);
    this.onWelcome?.(ctx);
    this.step(() => {
      if (this.url !== undefined) this.liveness.endpoint(this.url);
      this.liveness.start(ctx, roles);
    });
    return ctx;
  }

  /** The session ends: release clears its timers, then `sessionEnded`. */
  end(byLiveness = false): void {
    const ctx = this.current;
    this.ended.add(ctx.connId);
    for (const t of this.timers) if (t.conn === ctx.connId && t.state === 'armed') t.state = 'cleared';
    ctx.endSession();
    this.ctx = undefined;
    this.liveness.sessionEnded(byLiveness);
  }

  /** One core step: liveness runs with the current clock; `later()` callbacks run after it. */
  step<T>(fn: () => T): T {
    this.sync();
    this.inStep = true;
    let result: T;
    try {
      result = fn();
    } finally {
      this.inStep = false;
    }
    for (let item = this.laterQueue.shift(); item !== undefined; item = this.laterQueue.shift()) {
      if (!this.ended.has(item.conn)) item.fn(); // dropped once that session ended (the host contract)
    }
    return result;
  }

  receive(msg: InboundMessage, ctx: CoreCtx = this.current): boolean {
    // The answer ends the probe's flight before liveness acts on it (it may write the next probe at once).
    const probe = this.pendingProbe(ctx.connId);
    const answer = probe !== undefined && answersProbe(msg, probe.id);
    if (answer) probe.answered = true;
    const forgiven = this.forgivenProbe(ctx.connId);
    const late = forgiven !== undefined && answersProbe(msg, forgiven.id);
    if (late) forgiven.forgiven = false;
    const consumed = this.step(() => this.liveness.inbound(msg, ctx));
    if (consumed && !answer && !late) this.failures.push('consumed a frame that is no answer');
    if (late && !consumed && !this.ended.has(ctx.connId)) this.failures.push('the late answer was not consumed');
    if (answer && !consumed && !this.ended.has(ctx.connId) && this.logged('liveness.unsupported') === 0) {
      this.failures.push('the probe answer was not consumed');
    }
    return consumed;
  }

  /** A request written by a participant (`ctx.request`). */
  request(expectsReply = true): number | undefined {
    return this.step(() =>
      this.current.request((requestId) => callFrame(requestId, {}, 'com.example.op'), expectsReply),
    );
  }

  /** A write that expects no reply (`ctx.send`: a YIELD here), reported to `liveness.sent`. */
  send(): boolean {
    return this.step(() => this.current.send(yieldFrame(77, false)));
  }

  /** The core reports the URL of a connection (normally just before `start`). */
  endpoint(url: string): void {
    this.step(() => {
      this.liveness.endpoint(url);
    });
  }

  verify(since: number, onTimeout: () => void, ctx: CoreCtx = this.current): void {
    this.step(() => {
      this.liveness.verifyAlive(since, onTimeout, ctx);
    });
  }

  open(ctx: CoreCtx = this.current): void {
    this.step(() => {
      this.liveness.check(ctx);
    });
  }

  /** Advance real time by `ms`, firing due timers in (due, arming) order, each in its own step. */
  advance(ms: number): void {
    const end = this.real + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.state === 'armed' && t.due <= end)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (next === undefined) break;
      this.real = Math.max(this.real, next.due);
      this.fire(next);
    }
    this.real = end;
    this.sync();
  }

  /** A frame every `every` ms (EVENTs by default) until `ms` have passed. */
  flow(ms: number, every = 1000, frame: () => InboundMessage = () => inbound.event(1, 1)): void {
    for (let left = ms; left > 0; left -= every) {
      this.advance(Math.min(every, left));
      if (this.ctx !== undefined) this.receive(frame());
    }
  }

  /** Answer the pending probe (by default with no_such_procedure, as every router in routers/ does). */
  answer(msg: (id: number) => InboundMessage = (id) => inbound.error(48, id, Uri.NO_SUCH_PROCEDURE)): boolean {
    const probe = this.pendingProbe();
    if (probe === undefined) throw new Error('no probe pending');
    return this.receive(msg(probe.id));
  }

  pendingProbe(conn: number | undefined = this.ctx?.connId): ProbeWrite | undefined {
    return this.probes.find((p) => p.conn === conn && !p.answered && !p.dropped);
  }

  /** The last probe of a session that liveness forgave and whose late answer has not arrived. */
  forgivenProbe(conn: number | undefined = this.ctx?.connId): ProbeWrite | undefined {
    return this.probes.find((p) => p.conn === conn && p.forgiven);
  }

  /** The late answer of the forgiven probe. */
  late(msg: (id: number) => InboundMessage = (id) => inbound.error(48, id, Uri.NO_SUCH_PROCEDURE)): boolean {
    const probe = this.forgivenProbe();
    if (probe === undefined) throw new Error('no probe forgiven');
    return this.receive(msg(probe.id));
  }

  /** Real write times of the probes of a session (default: the latest, also after it ended). */
  probeTimes(conn: number | undefined = this.ctxs[this.ctxs.length - 1]?.connId): number[] {
    return this.probes.filter((p) => p.conn === conn).map((p) => p.real);
  }

  armed(kind?: 'idle' | 'ping', conn: number | undefined = this.ctx?.connId): HostTimer[] {
    return this.timers.filter((t) => t.state === 'armed' && t.conn === conn && (kind === undefined || t.kind === kind));
  }

  /** The armed idle/ping timer of the current session as `{ms, due}` (undefined when none). */
  timer(kind: 'idle' | 'ping'): { ms: number; due: number } | undefined {
    const t = this.armed(kind)[0];
    return t === undefined ? undefined : { ms: t.ms, due: t.due };
  }

  get current(): CoreCtx {
    if (this.ctx === undefined) throw new Error('no session');
    return this.ctx;
  }

  logged(event: string): number {
    return this.ctxs.reduce((n, ctx) => n + ctx.logged(event).length, 0);
  }

  private fire(t: HostTimer): void {
    t.state = 'fired';
    const ctx = this.ctx;
    if (ctx?.connId !== t.conn) {
      this.failures.push(`a timer of conn ${String(t.conn)} fired after its session`);
      return;
    }
    if (t.kind === 'idle') {
      this.step(() => {
        this.liveness.onIdle(ctx);
      });
      return;
    }
    const probe = this.pendingProbe(ctx.connId);
    const offBefore = ctx.logged('liveness.unsupported').length;
    const probesBefore = this.probes.length;
    this.pinging = probe;
    const dead = this.step(() => {
      const verdict: unknown = this.liveness.onPing(ctx); // checked: exactly 'alive' or 'dead'
      if (verdict !== 'alive' && verdict !== 'dead') this.failures.push(`onPing returned ${String(verdict)}`);
      if (verdict !== 'dead') return false;
      this.deaths.push(ctx.connId);
      this.deathTimes.push(this.real);
      this.end(true); // release(4001); end(connection, TimeoutError{liveness})
      return true;
    });
    this.pinging = undefined;
    // given up unanswered while the session lives on (probing turned off, or saved on proof of activity): probed again
    // at once, or no ping timer left (a backlog still draining re-arms it for the same probe)
    const givenUp = this.probes.length > probesBefore || this.armed('ping', ctx.connId).length === 0;
    if (!dead && probe !== undefined && !probe.answered && givenUp) {
      probe.dropped = true;
      if (ctx.logged('liveness.unsupported').length === offBefore) {
        for (const p of this.probes) if (p.conn === ctx.connId) p.forgiven = false; // only the last one is remembered
        probe.forgiven = true;
        this.saves.push(this.real);
        this.onSave?.();
      }
    }
    if (dead && this.autoReconnect) this.welcome();
  }

  private arm(kind: 'idle' | 'ping', ctx: SessionCtx, ms: number): void {
    this.expectCurrent(ctx, `arm ${kind}`);
    if (!(Number.isFinite(ms) && ms >= 0 && ms <= MAX_DELAY)) this.failures.push(`arm ${kind} for ${String(ms)} ms`);
    for (const t of this.timers) {
      if (t.kind === kind && t.conn === ctx.connId && t.state === 'armed') t.state = 'replaced';
    }
    this.timers.push({
      kind,
      conn: ctx.connId,
      ms,
      at: this.real,
      due: this.real + ms,
      seq: ++this.seq,
      state: 'armed',
    });
  }

  private expectCurrent(ctx: SessionCtx, what: string): void {
    if (ctx !== this.ctx || this.ended.has(ctx.connId)) this.failures.push(`${what} for a session that is not current`);
  }

  private sync(): void {
    for (const ctx of this.ctxs) ctx.now = this.now;
  }
}

/** A client whose router has answered the calibration probe (capability 'yes'); time is then 1 000. */
function calibrated(options?: { readonly idle?: number; readonly pingBudget?: number }): Core {
  const core = new Core(options);
  core.welcome();
  core.advance(Math.min(CALIBRATION_DELAY, core.idle));
  expect(core.answer()).toBe(true);
  return core;
}

function settle(core: Core): void {
  expect(core.failures).toEqual([]);
}

// =====================================================================================================================

describe('start (WELCOME)', () => {
  test('arms the calibration idle timer (1 s) while the probe capability is unknown, `idle` once it is known', () => {
    const core = new Core();
    core.welcome();
    expect(core.armed()).toHaveLength(1);
    expect(core.timer('idle')).toEqual({ ms: CALIBRATION_DELAY, due: CALIBRATION_DELAY });
    core.advance(CALIBRATION_DELAY);
    core.answer();
    core.end();
    core.welcome();
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: core.real + IDLE });
    settle(core);
  });

  test('the calibration delay never exceeds `idle`', () => {
    const core = new Core({ idle: 400 });
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(400);
    settle(core);
  });

  test('the calibration probe is written at 1 s, whatever arrives meanwhile', () => {
    const core = new Core();
    core.welcome();
    core.flow(CALIBRATION_DELAY - 100, 100); // frames do not move the calibration timer
    core.advance(100);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY]);
    expect(core.current.frames(MessageType.CALL)).toEqual([[48, 1, {}, 'thruway.js.ping']]);
    expect(core.timer('ping')).toEqual({ ms: BUDGET, due: CALIBRATION_DELAY + BUDGET });
    settle(core);
  });

  test.each([
    ['frames past the re-arm slack (idle 5 s: slack 500 ms)', 5000, 0],
    ['a clock that went back', IDLE, -HOUR],
  ])('neither %s nor replies move the calibration timer', (_name, idle, skew) => {
    const core = new Core({ idle });
    core.welcome();
    core.advance(600);
    core.skew = skew;
    core.receive(inbound.event(1, 1));
    const id = core.request()!;
    core.advance(200);
    core.receive(inbound.result(id));
    core.advance(CALIBRATION_DELAY - 800);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY]);
    settle(core);
  });

  test.each([
    ['with a dealer', DEALER, true],
    ['without roles (the core passes {})', {}, true],
    ['with roles but no dealer', { broker: {} }, false],
    ['with a dealer that is not a dict', { dealer: true }, true],
  ])('WELCOME %s: probe %s', (_name, roles, probes) => {
    const core = new Core();
    core.welcome(roles);
    core.advance(10 * IDLE);
    expect(core.probes.length > 0).toBe(probes);
    expect(core.logged('option.fallback')).toBe(probes ? 0 : 1);
    settle(core);
  });

  test('no dealer: nothing is armed, verdicts run at once, and the warning says why', () => {
    const core = new Core();
    core.welcome({ broker: {}, subscriber: {} });
    expect(core.armed()).toEqual([]);
    expect(core.current.logged('option.fallback')).toEqual([
      {
        level: 'warn',
        event: 'option.fallback',
        message: 'the router announced no dealer role: the liveness probe (a CALL) is off for this session',
      },
    ]);
    let ran = 0;
    core.flow(5000);
    core.request();
    core.verify(core.now, () => ran++);
    core.flow(5000);
    core.open();
    core.advance(10 * IDLE);
    core.open();
    expect(ran).toBe(1);
    expect(core.probes).toEqual([]);
    expect(core.timers).toEqual([]);
    settle(core);
  });

  test('roles that cannot be read count as having a dealer (no throw out of the step)', () => {
    const core = new Core();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile');
        },
      },
    );
    core.welcome(hostile);
    core.advance(CALIBRATION_DELAY);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY]);
    settle(core);
  });
});

describe('timeouts.idle: 0 disables liveness', () => {
  test('nothing is armed or written, whatever happens; verdicts run at once; option.fallback is not logged', () => {
    const core = new Core({ idle: 0 });
    core.welcome({ broker: {} });
    expect(core.armed()).toEqual([]);
    core.flow(5000);
    core.request();
    core.flow(5000);
    core.open();
    core.advance(HOUR);
    core.open();
    const ran: number[] = [];
    core.verify(0, () => ran.push(1));
    core.verify(core.now, () => ran.push(2));
    expect(ran).toEqual([1, 2]);
    // stray timer callbacks are harmless
    core.step(() => {
      core.liveness.onIdle(core.current);
      expect(core.liveness.onPing(core.current)).toBe('alive');
    });
    expect(core.probes).toEqual([]);
    expect(core.timers).toEqual([]);
    expect(core.logged('option.fallback')).toBe(0);
    settle(core);
  });
});

describe('idle timer', () => {
  test('a probe on silence: exactly `idle` after the last inbound frame', () => {
    const core = calibrated();
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: CALIBRATION_DELAY + IDLE });
    core.advance(IDLE - 1);
    expect(core.probeTimes()).toHaveLength(1);
    core.advance(1);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE]);
    settle(core);
  });

  test('frames move the deadline: re-armed for `idle`, at most once per second (a probe at most 1 s early)', () => {
    const core = calibrated(); // idle armed at 1 000
    core.advance(10000);
    core.receive(inbound.event(1, 1)); // 11 000: re-armed
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: 41000 });
    core.advance(REARM_SLACK - 1);
    core.receive(inbound.event(1, 2)); // 11 999: coalesced
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: 41000 });
    core.advance(1);
    core.receive(inbound.event(1, 3)); // 12 000: re-armed
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: 42000 });
    core.advance(500);
    core.receive(inbound.event(1, 4)); // 12 500: coalesced
    core.advance(IDLE - 501);
    expect(core.probeTimes()).toHaveLength(1);
    core.advance(1);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 42000]); // 29.5 s after the last frame
    for (const t of core.timers) expect([CALIBRATION_DELAY, IDLE, BUDGET]).toContain(t.ms);
    settle(core);
  });

  test('a small `idle` coalesces less: at most a tenth of `idle`', () => {
    const core = calibrated({ idle: 500, pingBudget: 300 });
    core.flow(10000, 100); // a frame every 100 ms re-arms each time (slack 50 ms)
    expect(core.probeTimes()).toEqual([500]);
    core.flow(10000, 40); // every 40 ms: re-armed every other frame; never silent for 500 ms
    expect(core.probeTimes()).toEqual([500]);
    settle(core);
  });

  test.each([
    ['back an hour', -HOUR],
    ['back 30 days', -30 * 24 * HOUR],
    ['back 999 ms', -999],
    ['back 1 ms', -1],
    ['forward an hour', HOUR],
    ['forward 30 days', 30 * 24 * HOUR],
  ])('a clock that jumps %s neither postpones nor disables the probe', (_name, jump) => {
    const core = calibrated();
    core.advance(5000);
    core.receive(inbound.event(1, 1));
    core.skew += jump;
    core.advance(1000);
    core.receive(inbound.event(1, 2));
    const lastFrame = core.real;
    core.skew += jump;
    core.advance(IDLE);
    const second = core.probeTimes()[1]!; // at most the slack early, never late
    expect(second).toBeLessThanOrEqual(lastFrame + IDLE);
    expect(second).toBeGreaterThanOrEqual(lastFrame + IDLE - REARM_SLACK);
    core.advance(10);
    core.answer();
    const answered = core.real;
    core.skew -= 3 * jump;
    core.advance(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, second, answered + IDLE]);
    for (const t of core.timers) expect([CALIBRATION_DELAY, IDLE, BUDGET]).toContain(t.ms);
    settle(core);
  });

  test('a clock that jumps forward and back between frames cannot postpone the probe', () => {
    const core = calibrated();
    core.advance(1000);
    core.receive(inbound.event(1, 1)); // 2 000
    core.skew += HOUR;
    core.advance(1000);
    core.receive(inbound.event(1, 2)); // 3 000, read as an hour later
    core.skew -= HOUR;
    core.advance(500);
    core.receive(inbound.event(1, 3)); // 3 500, read as an hour earlier than the last: re-armed
    core.advance(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 3500 + IDLE]);
    settle(core);
  });

  test('a frozen clock: frames cannot move the deadline, so the probe comes every `idle` (early, never late)', () => {
    const core = calibrated();
    core.clock = core.now; // frozen when the idle timer was armed
    core.flow(IDLE, 100);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE]);
    settle(core);
  });

  test('a clock that returns NaN: every frame re-arms, probes come on silence, every delay stays finite', () => {
    const core = calibrated();
    core.clock = Number.NaN;
    core.flow(5000);
    core.advance(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 6000 + IDLE]);
    core.advance(100);
    core.answer();
    core.advance(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 6000 + IDLE, 6000 + 2 * IDLE + 100]);
    settle(core);
  });

  test('an idle timer that fires while a probe is pending does nothing; the answer re-arms it', () => {
    const core = calibrated();
    core.advance(IDLE - 100);
    core.open(); // nothing for 29.9 s ⇒ probe now
    expect(core.probeTimes()).toHaveLength(2);
    core.advance(100); // the idle timer fires with the probe pending
    expect(core.probeTimes()).toHaveLength(2);
    expect(core.armed().map((t) => t.kind)).toEqual(['ping']);
    core.flow(3000); // frames do not re-arm it while the probe is pending
    expect(core.armed().map((t) => t.kind)).toEqual(['ping']);
    core.answer();
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: core.real + IDLE });
    settle(core);
  });
});

describe('outstanding requests: one-way half-open links', () => {
  test('a request without any reply is probed `idle` after it was written although EVENTs keep arriving', () => {
    const core = calibrated();
    core.flow(5000);
    const written = core.real;
    core.request();
    core.flow(IDLE - 1000);
    expect(core.probeTimes()).toHaveLength(1);
    core.flow(1000);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, written + IDLE]);
    settle(core);
  });

  test('...measured from the last frame before the request, so never later than `idle` after it', () => {
    const core = calibrated();
    core.advance(20000);
    core.request(); // 21 000; the last frame was the answer at 1 000
    core.flow(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE]);
    settle(core);
  });

  test('without an outstanding request, EVENTs alone never cause a probe', () => {
    const core = calibrated();
    core.flow(10 * IDLE);
    expect(core.probeTimes()).toHaveLength(1);
    settle(core);
  });

  test('the probe itself is not an outstanding request', () => {
    const core = calibrated(); // the calibration probe was written and answered
    core.flow(10 * IDLE);
    core.open(); // check() needs 2 s of silence: frames arrive every second
    expect(core.probeTimes()).toHaveLength(1);
    settle(core);
  });

  test('an unacknowledged PUBLISH (expectsReply false) is proven only by a probe: no reply ever settles it', () => {
    const core = calibrated(); // the deadline: 31 000
    core.advance(10000);
    core.request(false); // 11 000
    core.flow(IDLE - 10000, 1000, () => inbound.result(99)); // even replies do not move the deadline
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE]);
    core.answer(); // written after the PUBLISH: proves it
    core.flow(10 * IDLE);
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test('a reply restarts the wait while requests remain outstanding; the last one ends it', () => {
    const core = calibrated();
    const a = core.request()!;
    const b = core.request()!;
    core.flow(20000);
    core.receive(inbound.result(a));
    const replied = core.real;
    core.flow(IDLE - 1000);
    expect(core.probeTimes()).toHaveLength(1);
    core.flow(1000);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, replied + IDLE]);
    core.advance(10);
    core.answer();
    core.receive(inbound.result(b));
    core.flow(10 * IDLE);
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test('a request written while a probe is pending is probed `idle` after its write, not `idle` after the answer', () => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 written at 31 000; the uplink dies right after it
    core.advance(100);
    const written = core.real;
    core.request(); // 31 100: into the dead uplink
    core.flow(9000, 1000);
    core.request(); // 40 100: a second one keeps the first one's deadline
    core.flow(6000, 1000);
    expect(core.answer()).toBe(true); // 46 100: probe 2 had left before the uplink died
    core.flow(IDLE, 1000); // EVENTs keep arriving
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE, written + IDLE]);
    core.flow(BUDGET, 1000);
    expect(core.deathTimes).toEqual([written + IDLE + BUDGET]); // INV-LIVE: within idle + budget of the request
    settle(core);
  });

  test('...and when that deadline passes while the probe is pending, its answer probes again at once', () => {
    const core = calibrated({ idle: 5000, pingBudget: BUDGET }); // probe 1 at 1 000, answered
    core.advance(5000); // probe 2 at 6 000
    core.advance(100);
    core.request(); // 6 100: deadline 11 100
    core.advance(5900);
    expect(core.probeTimes()).toEqual([1000, 6000]); // probe 2 is still pending at 11 100
    core.answer(); // 12 000
    expect(core.probeTimes()).toEqual([1000, 6000, 12000]);
    core.advance(10);
    core.answer(); // probe 3 was written after the request: its answer restarts the wait
    core.advance(4999);
    expect(core.probeTimes()).toHaveLength(3);
    core.advance(1);
    expect(core.probeTimes()).toEqual([1000, 6000, 12000, 17010]);
    settle(core);
  });

  test('an idle timer that fired during the probe before that request was written is not its deadline', () => {
    const core = calibrated(); // idle armed for 31 000
    core.advance(25000);
    core.open(); // 26 000: probe 2 (the idle timer keeps running)
    core.advance(5000); // 31 000: it fires with probe 2 pending
    core.advance(100);
    const written = core.real;
    core.request(); // 31 100
    core.advance(1000);
    core.answer(); // 32 100, before the request's deadline: no probe now
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 26000]);
    core.advance(written + IDLE - core.real);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 26000, written + IDLE]);
    settle(core);
  });

  test.each([
    ["answered before the probe's answer", false],
    ["answered before the probe's answer, its deadline passed meanwhile", true],
  ])('a request written after the probe that waits for nothing (%s) does not hold the deadline', (_name, overdue) => {
    const core = calibrated({ idle: 5000, pingBudget: BUDGET });
    core.advance(5000); // probe 2 at 6 000
    core.advance(100);
    const id = core.request()!;
    core.advance(100);
    core.receive(inbound.result(id)); // 6 200: nothing outstanding any more
    core.advance(overdue ? 5800 : 800); // the answer at 12 000 or 7 000
    core.answer();
    const answered = core.real;
    core.advance(4999);
    expect(core.probeTimes()).toEqual([1000, 6000]);
    core.advance(1);
    expect(core.probeTimes()).toEqual([1000, 6000, answered + 5000]);
    settle(core);
  });

  test('a request that is never answered is probed once per `idle`, not continuously', () => {
    const core = calibrated();
    core.request(); // a long call
    core.flow(IDLE);
    expect(core.probeTimes()).toHaveLength(2);
    core.advance(100);
    core.answer();
    const answered = core.real;
    core.flow(IDLE - 1000);
    expect(core.probeTimes()).toHaveLength(2);
    core.flow(1000);
    expect(core.probeTimes().slice(2)).toEqual([answered + IDLE]);
    settle(core);
  });

  const r = 7; // the outstanding request's id (sequential ids: 1 = calibration probe, then requests)
  test.each<[string, (id: number) => InboundMessage, 'settles' | 'restarts' | 'ignored']>([
    ['RESULT', (id) => inbound.result(id), 'settles'],
    ['progress RESULT', (id) => inbound.result(id, [], {}, { progress: true }), 'restarts'],
    ['RESULT whose progress is not true', (id) => inbound.result(id, [], {}, { progress: 1 }), 'settles'],
    ['ERROR(CALL)', (id) => inbound.error(48, id, Uri.CANCELED), 'settles'],
    ['ERROR(CANCEL), Thruway T2', (id) => inbound.error(49, id, Uri.CANCELED), 'restarts'],
    ['ERROR(PUBLISH)', (id) => inbound.error(16, id, Uri.NOT_AUTHORIZED), 'settles'],
    ['ERROR(SUBSCRIBE)', (id) => inbound.error(32, id, Uri.NOT_AUTHORIZED), 'settles'],
    ['ERROR(UNSUBSCRIBE)', (id) => inbound.error(34, id, Uri.NO_SUCH_SUBSCRIPTION), 'settles'],
    ['ERROR(REGISTER)', (id) => inbound.error(64, id, Uri.PROCEDURE_ALREADY_EXISTS), 'settles'],
    ['ERROR(UNREGISTER)', (id) => inbound.error(66, id, Uri.NO_SUCH_REGISTRATION), 'settles'],
    ['ERROR(ERROR), Thruway T2', (id) => inbound.error(8, id, Uri.NO_SUCH_PROCEDURE), 'restarts'],
    ['PUBLISHED', (id) => inbound.published(id, 5), 'settles'],
    ['SUBSCRIBED', (id) => inbound.subscribed(id, 5), 'settles'],
    ['UNSUBSCRIBED', (id) => inbound.unsubscribed(id), 'settles'],
    ['REGISTERED', (id) => inbound.registered(id, 5), 'settles'],
    ['UNREGISTERED', (id) => inbound.unregistered(id), 'settles'],
    ['a subscription revocation', () => inbound.subscriptionRevoked(5, 'gone'), 'ignored'],
    ['a registration revocation', () => inbound.registrationRevoked(5), 'ignored'],
    ['EVENT', () => inbound.event(1, 9), 'ignored'],
    ['INVOCATION', () => inbound.invocation(77, 5), 'ignored'],
    ['INTERRUPT', () => inbound.interrupt(77), 'ignored'],
    ['WELCOME', () => inbound.welcome(3), 'ignored'],
    ['CHALLENGE', () => inbound.challenge('ticket'), 'ignored'],
  ])('%s: %s the wait', (_name, reply, effect) => {
    const core = calibrated();
    for (let i = 0; i < 5; i++) core.request(); // ids 2…6, answered at once
    for (let id = 2; id < r; id++) core.receive(inbound.result(id));
    expect(core.request()).toBe(r);
    const written = core.real;
    core.flow(10000);
    expect(core.receive(reply(r))).toBe(false);
    const replied = core.real;
    core.flow(5 * IDLE);
    const probes = core.probeTimes().slice(1);
    if (effect === 'settles') expect(probes).toEqual([]);
    else expect(probes[0]).toBe(effect === 'restarts' ? replied + IDLE : written + IDLE);
    settle(core);
  });

  test('a late or duplicate reply with nothing outstanding changes nothing (no negative count)', () => {
    const core = calibrated();
    core.receive(inbound.result(99));
    core.receive(inbound.subscribed(98, 1));
    core.flow(5 * IDLE); // EVENTs alone keep the connection quiet
    expect(core.probeTimes()).toHaveLength(1);
    const written = core.real;
    core.request();
    core.flow(IDLE);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, written + IDLE]);
    settle(core);
  });

  test('ABORT and GOODBYE only count as inbound frames (the core ends the session itself)', () => {
    const core = calibrated();
    core.advance(10000);
    expect(core.receive(inbound.abort(Uri.NOT_AUTHORIZED))).toBe(false);
    core.advance(10000);
    expect(core.receive(inbound.goodbye(Uri.SYSTEM_SHUTDOWN))).toBe(false);
    const last = core.real;
    core.advance(IDLE);
    expect(core.probeTimes().slice(1)).toEqual([last + IDLE]);
    settle(core);
  });
});

describe('ping timer: only the probe answer clears it', () => {
  test('no other frame clears `ping` or is consumed; the answer is consumed and cancels it', () => {
    const core = calibrated();
    core.advance(IDLE);
    const probe = core.pendingProbe()!;
    const other = core.request()!;
    for (const msg of [
      inbound.event(1, 1),
      inbound.result(other),
      inbound.error(48, other, Uri.NO_SUCH_PROCEDURE),
      inbound.error(32, probe.id, Uri.NOT_AUTHORIZED), // the probe's id, but not a CALL answer
      inbound.error(16, probe.id, Uri.NOT_AUTHORIZED),
      inbound.error(8, probe.id, Uri.NO_SUCH_PROCEDURE),
      inbound.published(probe.id, 1),
      inbound.subscribed(probe.id, 1),
      inbound.registered(probe.id, 1),
      inbound.invocation(probe.id, 1),
      inbound.interrupt(probe.id),
      inbound.unsubscribed(probe.id),
      inbound.unregistered(probe.id),
    ]) {
      expect(core.receive(msg)).toBe(false);
      expect(core.armed('ping')).toHaveLength(1);
    }
    expect(core.answer()).toBe(true);
    expect(core.armed('ping')).toEqual([]);
    expect(core.timers.filter((t) => t.kind === 'ping').map((t) => t.state)).toEqual(['cancelled', 'cancelled']);
    settle(core);
  });

  test.each<[string, (id: number) => InboundMessage]>([
    ['ERROR no_such_procedure (every router in routers/)', (id) => inbound.error(48, id, Uri.NO_SUCH_PROCEDURE)],
    ['ERROR not_authorized (a default-deny router)', (id) => inbound.error(48, id, Uri.NOT_AUTHORIZED)],
    ['an ERROR typed 49 (Thruway T2 style)', (id) => inbound.error(49, id, Uri.CANCELED)],
    ['a RESULT', (id) => inbound.result(id, ['pong'])],
    ['a progress RESULT', (id) => inbound.result(id, [], {}, { progress: true })],
    ['a payload-invalid ERROR', (id) => inbound.invalid(inbound.error(48, id, Uri.NO_SUCH_PROCEDURE))],
  ])('%s answers the probe', (_name, answer) => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    expect(core.answer(answer)).toBe(true);
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    core.advance(IDLE);
    core.answer(); // capability 'yes': the next probe after `idle`
    settle(core);
  });

  test('an unanswered probe is dead after the budget: the session ends by liveness', () => {
    const core = calibrated();
    core.advance(IDLE);
    expect(core.deaths).toEqual([]);
    core.advance(BUDGET - 1);
    expect(core.deaths).toEqual([]);
    core.advance(1);
    expect(core.deaths).toEqual([1]);
    expect(core.ctx).toBeUndefined();
    settle(core);
  });
});

describe('adaptive ping budget', () => {
  test('doubles after every session ended by liveness, up to 120 s', () => {
    // A slow router: it answers each calibration probe 25 s after it was written (later than the 20 s base, so the
    // budget is never reset), and the next probe goes unanswered. Each session answered a probe, so none of these
    // ends counts towards turning probing off; each sends the router back to calibration.
    const core = new Core();
    const budgets: number[] = [];
    core.welcome();
    core.advance(CALIBRATION_DELAY + BUDGET); // the first calibration: unanswered, dead
    for (let i = 0; i < 5; i++) {
      core.welcome();
      core.advance(CALIBRATION_DELAY);
      budgets.push(core.timer('ping')!.ms);
      core.advance(25000);
      expect(core.answer()).toBe(true);
      core.advance(IDLE + PING_BUDGET_CAP); // the next probe is never answered
    }
    expect(budgets).toEqual([40000, 80000, 120000, 120000, 120000]);
    expect(core.deaths).toEqual([1, 2, 3, 4, 5, 6]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test('without any answered probe, the second liveness end in a row turns probing off', () => {
    const core = new Core();
    const budgets: number[] = [];
    for (let i = 0; i < 2; i++) {
      core.welcome();
      core.advance(CALIBRATION_DELAY); // the calibration probe; nothing else arrives
      budgets.push(core.timer('ping')!.ms);
      core.advance(PING_BUDGET_CAP);
    }
    expect(budgets).toEqual([20000, 40000]);
    expect(core.deaths).toEqual([1, 2]);
    core.welcome();
    expect(core.armed()).toEqual([]);
    settle(core);
  });

  test('back to the base once a probe is answered within the base, kept when answered later', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY + BUDGET); // dead
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(40000);
    core.advance(25000);
    core.answer(); // within 40 s, but not within the 20 s base
    core.advance(IDLE);
    expect(core.timer('ping')?.ms).toBe(40000);
    core.advance(BUDGET);
    core.answer(); // exactly the base
    core.advance(IDLE);
    expect(core.timer('ping')?.ms).toBe(20000);
    settle(core);
  });

  test('a base above the cap is never lowered by doubling', () => {
    const core = new Core({ pingBudget: 150000 });
    core.welcome();
    core.advance(CALIBRATION_DELAY + 150000);
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(150000);
    settle(core);
  });

  test('only the end of a tracked session doubles it: a second call, or an end without a session, does not', () => {
    const core = new Core();
    core.liveness.sessionEnded(true); // a failed handshake
    core.welcome();
    core.advance(CALIBRATION_DELAY + BUDGET); // dead: the core's end() reported it
    core.liveness.sessionEnded(true); // reported again for the same end
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(2 * BUDGET);
    settle(core);
  });

  test('sessions that end otherwise keep the budget', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY + BUDGET); // dead: 40 s
    core.welcome();
    core.end(false); // a socket drop
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(40000);
    settle(core);
  });
});

describe('draining outbound backlog', () => {
  test('a shrinking backlog re-arms `ping` every 5 s; once drained, one full budget more; then dead', () => {
    const core = calibrated();
    core.buffered = 3000000; // a large upload is in front of the probe
    core.advance(IDLE);
    const writtenAt = core.real;
    core.buffered = 2000000;
    core.advance(BUDGET);
    expect(core.deaths).toEqual([]);
    expect(core.timer('ping')).toEqual({ ms: DRAIN_RECHECK, due: writtenAt + BUDGET + DRAIN_RECHECK });
    core.buffered = 1000;
    core.advance(DRAIN_RECHECK);
    expect(core.timer('ping')?.ms).toBe(DRAIN_RECHECK);
    core.buffered = 0; // drained: the probe has just left
    core.advance(DRAIN_RECHECK);
    expect(core.timer('ping')).toEqual({ ms: BUDGET, due: core.real + BUDGET });
    core.advance(BUDGET - 1);
    expect(core.deaths).toEqual([]);
    core.advance(1);
    expect(core.deaths).toEqual([1]);
    settle(core);
  });

  test('an answer after the backlog drained keeps the session', () => {
    const core = calibrated();
    core.buffered = 50000;
    core.advance(IDLE);
    core.buffered = 10000;
    core.advance(BUDGET);
    core.buffered = 0;
    core.advance(DRAIN_RECHECK);
    core.advance(3000);
    expect(core.answer()).toBe(true);
    expect(core.deaths).toEqual([]);
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    settle(core);
  });

  test.each([
    ['a backlog that does not shrink', 5000, 5000],
    ['a backlog that grows', 5000, 9000],
    ['the probe alone, long gone (no backlog seen draining)', 40, 0],
    ['no backlog at all', 0, 0],
  ])('%s: dead at the first check', (_name, atWrite, atCheck) => {
    const core = calibrated();
    core.buffered = atWrite;
    core.advance(IDLE);
    core.buffered = atCheck;
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    settle(core);
  });

  test('a backlog that stalls after draining for a while is dead', () => {
    const core = calibrated();
    core.buffered = 5000;
    core.advance(IDLE);
    core.buffered = 4000;
    core.advance(BUDGET);
    core.advance(DRAIN_RECHECK); // still 4000
    expect(core.deaths).toEqual([1]);
    settle(core);
  });

  test('the re-check interval never exceeds the budget', () => {
    const core = calibrated({ pingBudget: 3000 });
    core.buffered = 5000;
    core.advance(IDLE);
    core.buffered = 4000;
    core.advance(3000);
    expect(core.timer('ping')?.ms).toBe(3000);
    settle(core);
  });
});

describe('calibration: does this router answer the probe?', () => {
  test('answered ⇒ capability yes: later sessions start with `idle`, not the calibration delay', () => {
    const core = calibrated();
    core.end();
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(IDLE);
    settle(core);
  });

  test('never answered, but a request written after it was ⇒ probing is off for this client, the session stays', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.advance(500);
    const id = core.request()!;
    core.advance(500);
    core.receive(inbound.result(id)); // the router processes what was written after the probe
    const verdicts: string[] = [];
    core.verify(core.now, () => verdicts.push('queued')); // waits for the probe
    core.advance(BUDGET - 1000);
    expect(core.deaths).toEqual([]);
    expect(core.ctx).toBeDefined();
    expect(verdicts).toEqual(['queued']);
    expect(core.current.logged('liveness.unsupported')).toEqual([
      {
        level: 'warn',
        event: 'liveness.unsupported',
        message: 'the router does not answer the liveness probe (CALL thruway.js.ping): liveness is off',
      },
    ]);
    // only the idle timer armed for the request written after the probe is left; it fires and does nothing
    expect(core.armed().map((t) => [t.kind, t.due])).toEqual([['idle', 1500 + IDLE]]);
    // nothing probes again, in this session or the next; verdicts run at once
    core.request();
    core.open();
    core.flow(3000);
    core.advance(10 * IDLE);
    core.open();
    core.verify(core.now, () => verdicts.push('now'));
    expect(verdicts).toEqual(['queued', 'now']);
    core.end();
    core.welcome();
    expect(core.armed()).toEqual([]);
    core.advance(10 * IDLE);
    expect(core.probes).toHaveLength(1);
    expect(core.logged('option.fallback')).toBe(0);
    settle(core);
  });

  test('frames without proof (EVENTs only): dead the first time, probing off the second time', () => {
    const core = new Core();
    core.welcome();
    core.flow(CALIBRATION_DELAY + BUDGET, 1000); // EVENTs keep arriving; the probe is never answered
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    core.welcome();
    core.flow(CALIBRATION_DELAY + 2 * BUDGET, 1000);
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    expect(core.ctx?.connId).toBe(2);
    settle(core);
  });

  test('replies only to requests written before the probe are no proof (a stalled router answers in order)', () => {
    const core = new Core();
    core.welcome();
    const a = core.request()!;
    const b = core.request()!;
    core.advance(CALIBRATION_DELAY); // the probe is written behind a and b
    core.advance(1000);
    core.receive(inbound.subscribed(a, 1));
    core.advance(1000);
    core.receive(inbound.registered(b, 2));
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    settle(core);
  });

  test('a stray final reply before any request written after the probe is no proof: a strike, not "off"', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.receive(inbound.subscribed(99, 1)); // nothing was waiting for it
    core.request(); // never answered
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test('one request ahead of the probe, one after it and a single reply: no proof (it may answer the earlier one)', () => {
    const core = new Core();
    core.welcome();
    const early = core.request()!;
    core.advance(CALIBRATION_DELAY);
    core.request();
    core.receive(inbound.registered(early, 1));
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test('a progress RESULT for a request written after the probe is no proof', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    const id = core.request()!;
    core.advance(1000);
    core.receive(inbound.result(id, [], {}, { progress: true }));
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    settle(core);
  });

  test('silence (no frame at all) is no calibration strike, but two liveness ends in a row turn probing off', () => {
    // a quiet client on a router that drops the probe: without that rule, a liveness reconnect every 122 s, forever
    const core = new Core();
    core.welcome();
    core.advance(PING_BUDGET_CAP + CALIBRATION_DELAY);
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY); // calibrates again: no strike was counted
    core.advance(PING_BUDGET_CAP + CALIBRATION_DELAY);
    expect(core.deaths).toEqual([1, 2]);
    expect(core.ctxs[1]!.logged('liveness.unsupported')).toEqual([
      {
        level: 'warn',
        event: 'liveness.unsupported',
        message: 'the router answered no liveness probe in 2 sessions in a row: liveness is off',
      },
    ]);
    for (let i = 0; i < 10; i++) {
      core.welcome();
      expect(core.armed()).toEqual([]);
      core.advance(HOUR);
      core.end();
    }
    expect(core.deaths).toEqual([1, 2]);
    expect(core.probes).toHaveLength(2);
    settle(core);
  });

  test('a calibration answered in between clears the strike', () => {
    const core = new Core();
    core.welcome();
    core.flow(CALIBRATION_DELAY + BUDGET, 1000); // strike
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.answer(); // capability yes, strike cleared
    core.flow(IDLE, 1000);
    core.request();
    core.flow(IDLE + 40000, 1000); // probe for the request, never answered, frames keep coming
    expect(core.deaths).toEqual([1, 2]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    // that end sends the router back to calibration, where a failure is a first strike again, not "off"
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    core.flow(CALIBRATION_DELAY + PING_BUDGET_CAP, 1000);
    expect(core.deaths).toEqual([1, 2, 3]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test('once the router has answered a probe, an unanswered one is dead without proof of activity', () => {
    const core = calibrated();
    core.advance(IDLE);
    core.flow(BUDGET, 1000); // EVENTs only
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });
});

describe('request verdicts (verifyAlive)', () => {
  test('alive ⇒ timeout: proven alive since `since` ⇒ onTimeout runs after the step, without a probe', () => {
    const core = calibrated(); // probe written at 1 000, answered
    const ran: boolean[] = [];
    core.verify(CALIBRATION_DELAY, () => ran.push(core.inStep));
    expect(ran).toEqual([false]); // in a later step, not inside verifyAlive
    expect(core.probeTimes()).toHaveLength(1);
    settle(core);
  });

  test('no proof since `since` ⇒ probe now; its answer runs onTimeout', () => {
    const core = calibrated();
    core.advance(5000);
    const since = core.now;
    core.request();
    core.advance(10000);
    const ran: string[] = [];
    core.verify(since, () => ran.push(core.inStep ? 'inside the step' : 'timeout'));
    expect(ran).toEqual([]);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, core.real]);
    core.advance(200);
    expect(core.answer()).toBe(true);
    expect(ran).toEqual(['timeout']);
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    settle(core);
  });

  test('dead ⇒ session end: onTimeout never runs (the record goes dormant instead)', () => {
    const core = calibrated();
    core.advance(5000);
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('timeout'));
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    core.welcome();
    core.advance(IDLE);
    core.answer();
    core.advance(10 * IDLE);
    expect(ran).toEqual([]);
    settle(core);
  });

  test('a verdict for a request written after the pending probe needs a second probe; one probe at a time', () => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 pending, written at 31 000
    core.advance(1000);
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('late')); // written after probe 2
    core.verify(core.now - 5000, () => ran.push('early')); // before probe 2
    expect(core.probeTimes()).toHaveLength(2);
    core.advance(500);
    core.answer();
    expect(ran).toEqual(['early']);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE, core.real]);
    expect(core.armed().map((t) => t.kind)).toEqual(['ping']);
    core.advance(500);
    core.answer();
    expect(ran).toEqual(['early', 'late']);
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    settle(core);
  });

  test('a probe pending since exactly `since` covers it, also when answered in the same instant', () => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 written at 31 000
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('at the write')); // the request went out with the probe
    core.verify(core.now - 1, () => ran.push('before'));
    core.answer(); // no time has passed
    expect(ran).toEqual(['at the write', 'before']);
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test('queued verdicts run in order when the probe that covers them is answered', () => {
    const core = calibrated();
    core.advance(5000);
    const ran: number[] = [];
    for (let i = 0; i < 4; i++) core.verify(core.now - i, () => ran.push(i));
    expect(core.probeTimes()).toHaveLength(2);
    core.advance(10);
    core.answer();
    expect(ran).toEqual([0, 1, 2, 3]);
    settle(core);
  });

  test.each([
    ['in the future', HOUR],
    ['not a number', Number.NaN],
    ['-Infinity', -Infinity],
  ])('a `since` %s proves nothing: only a probe written after the verdict decides', (_name, since) => {
    const core = calibrated();
    core.advance(5000);
    const ran: string[] = [];
    core.verify(Number.isNaN(since) || since === -Infinity ? since : core.now + since, () => ran.push('timeout'));
    expect(ran).toEqual([]);
    core.advance(10);
    core.answer();
    expect(ran).toEqual(['timeout']);
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test.each([
    ['NaN', Number.NaN],
    ['-Infinity', -Infinity],
  ])('a verdict queued with `since` %s while a probe is pending waits for the next probe', (_name, since) => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 pending
    core.advance(100);
    const ran: string[] = [];
    core.verify(since, () => ran.push('timeout'));
    core.advance(100);
    core.answer();
    expect(ran).toEqual([]);
    expect(core.probeTimes()).toHaveLength(3);
    core.advance(100);
    core.answer();
    expect(ran).toEqual(['timeout']);
    settle(core);
  });

  test('a request written after the clock went back cannot be "proven" by an older, answered probe', () => {
    const core = calibrated(); // probe answered, written at 1 000
    core.advance(5000);
    core.skew -= HOUR; // the clock goes back an hour
    const since = core.now; // the request's write time, an hour "before" the answered probe
    core.advance(1000);
    const ran: string[] = [];
    core.verify(since, () => ran.push('timeout'));
    expect(ran).toEqual([]); // aliveSince (1 000) lies ahead of now: no proof
    core.advance(10);
    core.answer();
    expect(ran).toEqual(['timeout']);
    settle(core);
  });

  test('a probe answered after the clock went back proves nothing by time, only by order', () => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 written at 31 000 (client clock)
    const ran: string[] = [];
    core.verify(core.now - 100, () => ran.push('before')); // queued while probe 2 is pending
    core.skew -= HOUR;
    core.advance(10);
    core.answer(); // written "in the future" now: its time cannot be compared
    expect(ran).toEqual([]);
    expect(core.probeTimes()).toHaveLength(3);
    core.advance(10);
    core.answer();
    expect(ran).toEqual(['before']);
    settle(core);
  });

  test('a probe that could not be written (gate closed, refused) is retried by the idle timer', () => {
    const core = calibrated();
    core.advance(5000);
    core.current.refuseWrites = true;
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('timeout'));
    expect(core.probeTimes()).toHaveLength(1);
    expect(core.current.refused.map((w) => w.frame[3])).toEqual(['thruway.js.ping']);
    expect(core.armed().map((t) => [t.kind, t.ms])).toEqual([['idle', IDLE]]);
    const retry = core.timer('idle')!.due;
    core.current.refuseWrites = false;
    core.flow(IDLE, 1000); // frames keep arriving, but they do not postpone a waiting verdict
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, retry]);
    core.advance(10);
    core.answer();
    expect(ran).toEqual(['timeout']);
    settle(core);
  });

  test('a closed gate: nothing is written and nothing breaks', () => {
    const core = calibrated();
    core.current.closeGate();
    core.advance(IDLE);
    expect(core.current.refused.map((w) => w.reason)).toEqual(['gate-closed']);
    expect(core.armed().map((t) => [t.kind, t.ms])).toEqual([['idle', IDLE]]);
    settle(core);
  });

  test('a probe the serializer refuses turns liveness off for this session only; queued verdicts run', () => {
    const core = calibrated();
    core.advance(5000);
    const boom = new TypeError('cannot serialize');
    core.current.failNextWrite(boom, isProbe);
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('timeout'));
    expect(ran).toEqual(['timeout']);
    expect(core.current.logged('liveness.unsupported')).toEqual([
      {
        level: 'warn',
        event: 'liveness.unsupported',
        message: 'the liveness probe could not be written: liveness is off for this session',
        data: { error: boom },
      },
    ]);
    core.flow(3000);
    core.advance(10 * IDLE);
    core.verify(core.now, () => ran.push('off'));
    expect(ran).toEqual(['timeout', 'off']);
    expect(core.probeTimes()).toHaveLength(1);
    core.end();
    core.welcome();
    core.flow(5000);
    const written = core.real;
    core.request(); // requests count again: a request without a reply is probed while EVENTs flow
    core.flow(IDLE);
    expect(core.probeTimes()).toEqual([written + IDLE]); // the next session probes again
    settle(core);
  });

  test('liveness off (capability no) runs every queued verdict', () => {
    const core = new Core();
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    const ran: number[] = [];
    core.verify(core.now, () => ran.push(1));
    core.advance(100);
    core.verify(core.now, () => ran.push(2)); // after the probe: would need a second one
    const id = core.request()!;
    core.receive(inbound.result(id));
    core.advance(BUDGET);
    expect(ran).toEqual([1, 2]);
    settle(core);
  });

  test('verdicts only for the current connection: a stale ctx is ignored, a new session drops old verdicts', () => {
    const core = calibrated();
    const old = core.current;
    core.advance(5000);
    const ran: string[] = [];
    core.verify(core.now, () => ran.push('old'));
    core.end();
    core.welcome();
    core.verify(core.now, () => ran.push('stale ctx'), old);
    core.advance(IDLE);
    core.answer();
    core.verify(0, () => ran.push('new'));
    expect(ran).toEqual(['new']);
    settle(core);
  });
});

describe('check() on open()', () => {
  test('probes after 2 s of silence, not before; never a second probe', () => {
    const core = calibrated();
    core.advance(CHECK_SILENCE - 1);
    core.open();
    expect(core.probeTimes()).toHaveLength(1);
    core.advance(1);
    core.open();
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, core.real]);
    core.advance(CHECK_SILENCE);
    core.open();
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test('a dead socket is detected within 2 s + budget of a wake-up', () => {
    const core = calibrated();
    core.advance(10000); // backgrounded for 10 s, the network changed: half-open
    core.open(); // foreground
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    settle(core);
  });
});

describe('session end and stale callers', () => {
  test('after the session ended, calls with its ctx do nothing', () => {
    const core = calibrated();
    core.advance(IDLE); // a probe is pending
    const old = core.current;
    const probeId = core.pendingProbe()!.id;
    core.end();
    const ran: string[] = [];
    core.step(() => {
      expect(core.liveness.inbound(inbound.error(48, probeId, Uri.CANCELED), old)).toBe(false);
      core.liveness.wrote(true, old);
      core.liveness.wrote(false, old);
      core.liveness.sent(old);
      core.liveness.onIdle(old);
      expect(core.liveness.onPing(old)).toBe('alive');
      core.liveness.check(old);
      core.liveness.verifyAlive(0, () => ran.push('x'), old);
    });
    expect(ran).toEqual([]);
    expect(old.written.filter((w) => isProbe(w.frame))).toHaveLength(2);
    expect(core.timers.filter((t) => t.state === 'armed')).toEqual([]);
    expect([...core.liveness.pendingIds()]).toEqual([]);
    settle(core);
  });

  test('a late answer to the previous session’s probe is not consumed in the next one', () => {
    const core = calibrated();
    core.advance(IDLE);
    const oldProbe = core.pendingProbe()!;
    core.end();
    core.welcome();
    expect(core.receive(inbound.error(48, oldProbe.id, Uri.NO_SUCH_PROCEDURE))).toBe(false);
    settle(core);
  });

  test('onPing without a pending probe (a stray timer) is alive', () => {
    const core = calibrated();
    core.step(() => {
      expect(core.liveness.onPing(core.current)).toBe('alive');
    });
    settle(core);
  });

  test('a second start without sessionEnded replaces the session', () => {
    const core = calibrated();
    core.advance(IDLE);
    const first = core.current;
    const second = core.welcome();
    core.step(() => {
      expect(core.liveness.onPing(first)).toBe('alive');
      expect(core.liveness.inbound(inbound.event(1, 1), first)).toBe(false);
    });
    expect(core.timer('idle')?.ms).toBe(IDLE);
    expect(second.connId).toBe(2);
    expect(core.failures).toEqual([]);
  });

  test('sessionEnded without a session (a failed handshake) is harmless', () => {
    const core = new Core();
    core.liveness.sessionEnded(false);
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    settle(core);
  });

  test('pendingIds reports the pending probe only', () => {
    const core = calibrated();
    expect([...core.liveness.pendingIds()]).toEqual([]);
    core.advance(IDLE);
    expect([...core.liveness.pendingIds()]).toEqual([core.pendingProbe()!.id]);
    core.answer();
    expect([...core.liveness.pendingIds()]).toEqual([]);
    settle(core);
  });

  test('sessions are independent: a request outstanding at the end is forgotten', () => {
    const core = calibrated();
    core.request();
    core.end();
    core.welcome();
    core.flow(10 * IDLE);
    expect(core.probeTimes()).toEqual([]);
    settle(core);
  });
});

describe('per-endpoint capability, strike and budget', () => {
  /** What happens in a session, relative to its WELCOME: probes written, the session's death, the ping budget. */
  function session(core: Core, run: () => void): { probes: number[]; death: number | undefined; budgets: number[] } {
    if (core.ctx !== undefined) core.end();
    const start = core.real;
    const conn = core.welcome().connId;
    const pings = (): HostTimer[] => core.timers.filter((t) => t.kind === 'ping' && t.conn === conn);
    run();
    return {
      probes: core.probeTimes(conn).map((t) => t - start),
      death: core.deaths.includes(conn) ? core.deathTimes[core.deaths.indexOf(conn)]! - start : undefined,
      budgets: pings().map((t) => t.ms),
    };
  }
  // the router drops the probe and sends EVENTs: a strike, then probing off
  const dropsProbe = (core: Core) => (): void => {
    core.flow(CALIBRATION_DELAY + PING_BUDGET_CAP, 1000);
  };

  test('a different URL starts exactly like a fresh instance: calibration, no strike, the base budget', () => {
    const fresh = new Core();
    fresh.url = 'ws://b/';
    const expected = [session(fresh, dropsProbe(fresh)), session(fresh, dropsProbe(fresh))];
    expect(expected.map((s) => s.death)).toEqual([CALIBRATION_DELAY + BUDGET, undefined]); // strike, then off
    expect(expected.map((s) => s.budgets)).toEqual([[BUDGET], [2 * BUDGET]]);

    for (const learn of ['yes', 'strike', 'no'] as const) {
      const core = new Core();
      core.url = 'ws://a/';
      if (learn === 'yes') {
        session(core, () => {
          core.advance(CALIBRATION_DELAY);
          core.answer();
        });
        session(core, dropsProbe(core)); // capability yes: dead, so A's budget doubles
      } else {
        session(core, dropsProbe(core)); // strike, budget 40 s
        if (learn === 'no') session(core, dropsProbe(core)); // probing off on A
      }
      core.url = 'ws://b/';
      expect([session(core, dropsProbe(core)), session(core, dropsProbe(core))]).toEqual(expected);
      settle(core);
    }
  });

  test('the same URL changes nothing: the strike and the doubled budget carry over, then probing stays off', () => {
    const core = new Core();
    core.url = 'ws://a/';
    const first = session(core, dropsProbe(core));
    const second = session(core, dropsProbe(core));
    expect([first.death, second.death]).toEqual([CALIBRATION_DELAY + BUDGET, undefined]);
    expect(second.budgets).toEqual([2 * BUDGET]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    core.end();
    core.welcome();
    expect(core.armed()).toEqual([]); // capability no, on this router
    settle(core);
  });

  test('capability no, then a new URL: probing resumes there; back on the first one, what was learned there holds', () => {
    const core = new Core();
    core.url = 'ws://a/';
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    const id = core.request()!;
    core.receive(inbound.result(id)); // proof: probing is turned off on A
    core.advance(BUDGET);
    expect(core.logged('liveness.unsupported')).toBe(1);
    core.end();
    core.url = 'ws://b/';
    core.welcome();
    const start = core.real;
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    core.advance(CALIBRATION_DELAY);
    expect(core.answer()).toBe(true); // B answers: half-open detection is back
    core.request();
    core.flow(IDLE, 1000);
    expect(core.probeTimes()).toEqual([start + CALIBRATION_DELAY, start + CALIBRATION_DELAY + IDLE]);
    core.answer();
    core.end();
    core.url = 'ws://a/'; // back on A: probing stays off there
    core.welcome();
    expect(core.armed()).toEqual([]);
    core.end();
    core.url = 'ws://b/'; // and B is known to answer: no calibration
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(IDLE);
    settle(core);
  });

  test('capability yes, then a URL whose router drops the probe: no liveness reconnect after the second failure', () => {
    const core = new Core();
    core.url = 'ws://a/';
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.answer();
    core.end();
    core.url = 'ws://b/'; // B drops the probe; with one state for all URLs, each session there died after idle + budget
    for (let i = 0; i < 4; i++) {
      core.welcome();
      core.flow(CALIBRATION_DELAY + 3 * PING_BUDGET_CAP, 1000);
      if (core.ctx !== undefined) core.end();
    }
    expect(core.deaths).toEqual([2]); // the calibration strike only
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('the first URL reported after something was learned starts from scratch (it was learned on an unknown one)', () => {
    const core = calibrated(); // no URL reported: capability yes
    core.end();
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(IDLE);
    core.end();
    core.url = 'ws://a/';
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    settle(core);
  });

  test('reported during a session: that session keeps its router and what it learns; the next one starts afresh', () => {
    const core = new Core();
    core.url = 'ws://a/';
    core.welcome();
    core.endpoint('ws://a/'); // the same URL: nothing changes
    core.endpoint('ws://b/'); // the next connection goes to B
    core.advance(CALIBRATION_DELAY);
    core.answer(); // A answers: this session now knows the capability
    core.advance(4000);
    core.receive(inbound.event(1, 1)); // 5 000: frames move its deadline (capability yes, unlike a calibration)
    expect(core.timer('idle')).toEqual({ ms: IDLE, due: 5000 + IDLE });
    core.advance(IDLE + BUDGET); // the probe at 35 000 is never answered: dead
    expect(core.deathTimes).toEqual([5000 + IDLE + BUDGET]);
    core.url = 'ws://b/';
    core.welcome(); // B: what A learned (capability, the doubled budget) went with A
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(BUDGET);
    settle(core);
  });

  test('a session whose URL changed mid-session keeps using and adapting its own router’s budget', () => {
    const core = new Core();
    core.url = 'ws://a/';
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.answer();
    core.advance(IDLE + BUDGET); // dead: A's budget is 40 s, and A calibrates again
    core.welcome();
    core.endpoint('ws://b/'); // B starts with the base budget
    core.advance(CALIBRATION_DELAY);
    expect(core.timer('ping')?.ms).toBe(2 * BUDGET); // this session still talks to A
    core.answer(); // within the base: A's budget is back to it
    core.advance(IDLE);
    expect(core.timer('ping')?.ms).toBe(BUDGET);
    settle(core);
  });

  test('a strike or probing off learned after the URL changed mid-session stays with that session’s router', () => {
    const core = new Core();
    core.url = 'ws://a/';
    core.welcome();
    core.endpoint('ws://b/');
    core.flow(CALIBRATION_DELAY + BUDGET, 1000); // A's strike
    core.url = 'ws://b/';
    core.welcome();
    core.flow(CALIBRATION_DELAY + BUDGET, 1000); // B's first failure is a strike, not "off"
    expect(core.deaths).toEqual([1, 2]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    core.url = 'ws://a/';
    core.welcome();
    core.flow(CALIBRATION_DELAY + 2 * BUDGET, 1000); // A's second failure (its budget doubled): off on A
    expect(core.deaths).toEqual([1, 2]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('a resolver that alternates between two routers that drop the probe converges: one strike each, then off', () => {
    const core = new Core();
    for (let i = 0; i < 8; i++) {
      core.url = i % 2 === 0 ? 'ws://a/' : 'ws://b/';
      core.welcome();
      core.flow(CALIBRATION_DELAY + 3 * PING_BUDGET_CAP, 1000);
      if (core.ctx !== undefined) core.end();
    }
    expect(core.deaths).toEqual([1, 2]); // without the memory per endpoint: every session, forever
    expect(core.logged('liveness.unsupported')).toBe(2);
    settle(core);
  });

  test.each([
    ['a fresh ticket in the query string', (i: number) => `wss://r.example/ws?ticket=${String(i)}`],
    ['a fragment', (i: number) => `wss://r.example/ws#${String(i)}`],
    ['a query and a fragment', (i: number) => `wss://r.example/ws?t=${String(i)}#f${String(i)}`],
  ])('%s at every attempt is the same endpoint: the strike carries over, then probing is off', (_name, url) => {
    const core = new Core();
    for (let i = 0; i < 6; i++) {
      core.url = url(i);
      core.welcome();
      core.flow(CALIBRATION_DELAY + 3 * PING_BUDGET_CAP, 1000);
      if (core.ctx !== undefined) core.end();
    }
    expect(core.deaths).toEqual([1]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('a path, a port or a host is another endpoint', () => {
    for (const other of ['wss://r.example/ws2', 'wss://r.example:8443/ws', 'wss://s.example/ws']) {
      const core = new Core();
      core.url = 'wss://r.example/ws?ticket=1';
      core.welcome();
      core.advance(CALIBRATION_DELAY);
      core.answer();
      core.end();
      core.url = other;
      core.welcome();
      expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
      settle(core);
    }
  });

  test('a slow link behind alternating URLs: each endpoint keeps its doubled budget, so it converges', () => {
    const core = new Core();
    for (const url of ['ws://a/', 'ws://b/']) {
      core.url = url;
      core.welcome();
      core.advance(CALIBRATION_DELAY);
      core.answer();
      core.end();
    }
    // Both routers answer every probe 30 s after it was written: too late for the 20 s base, in time for 40 s
    const answerLate = (): void => {
      for (let t = 0; t < 4 * IDLE && core.ctx !== undefined; t += 1000) {
        core.advance(1000);
        const probe = core.pendingProbe();
        if (probe !== undefined && core.real - probe.real >= 30000) core.answer();
      }
    };
    const budgets: number[] = [];
    for (let i = 0; i < 6; i++) {
      core.url = i % 2 === 0 ? 'ws://a/' : 'ws://b/';
      core.welcome();
      const conn = core.current.connId;
      answerLate();
      budgets.push(...core.timers.filter((t) => t.kind === 'ping' && t.conn === conn).map((t) => t.ms));
      if (core.ctx !== undefined) core.end();
    }
    // A1, B1 die (20 s); A2, B2 calibrate with 40 s and keep their sessions, and so does every later one
    expect(core.deaths).toEqual([3, 4]);
    expect(budgets.slice(0, 2)).toEqual([BUDGET, BUDGET]);
    expect(budgets.slice(2).every((ms) => ms === 2 * BUDGET)).toBe(true);
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test(`at most ${String(ENDPOINT_MEMORY)} endpoints are remembered: the least recently used is forgotten first`, () => {
    const core = new Core();
    /** A session on `url`; it answers a calibration probe. True when it calibrated (the endpoint was not known). */
    const visit = (url: string): boolean => {
      if (core.ctx !== undefined) core.end();
      core.url = url;
      core.welcome();
      const calibrating = core.timer('idle')?.ms === CALIBRATION_DELAY;
      if (calibrating) {
        core.advance(CALIBRATION_DELAY);
        core.answer();
      }
      return calibrating;
    };
    const url = (i: number): string => `ws://r${String(i)}/`;
    for (let i = 0; i < ENDPOINT_MEMORY; i++) expect(visit(url(i))).toBe(true);
    expect(visit(url(0))).toBe(false); // known, and now the most recent one
    expect(visit(url(ENDPOINT_MEMORY))).toBe(true); // one too many: r1, the least recently used, is forgotten
    expect(visit(url(0))).toBe(false);
    expect(visit(url(2))).toBe(false);
    expect(visit(url(1))).toBe(true); // forgotten; remembered again, it makes r3 the one forgotten
    for (let i = 4; i <= ENDPOINT_MEMORY; i++) expect(visit(url(i))).toBe(false);
    expect(visit(url(0))).toBe(false);
    expect(visit(url(3))).toBe(true);
    settle(core);
  });
});

describe('proof of activity keeps a session in every capability state', () => {
  /** Capability yes; probe 2 is written at 31 000 and never answered; a request written after it is answered at
   *  33 000 (the request at 32 000 re-armed the idle timer for 62 000). Time is then 33 000. */
  function proven(options?: { readonly idle?: number; readonly pingBudget?: number }): Core {
    const core = calibrated(options);
    core.advance(core.idle); // probe 2
    core.advance(1000);
    const id = core.request()!;
    core.advance(1000);
    core.receive(inbound.result(id));
    return core;
  }

  test('an unanswered probe is alive when a request written after it was answered; the next probe follows idle', () => {
    const core = proven();
    core.advance(BUDGET - 2000); // 51 000: the budget expires
    expect(core.deaths).toEqual([]);
    expect(core.saves).toEqual([51000]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    expect([...core.liveness.pendingIds()]).toEqual([core.probes[1]!.id]); // its late answer may still come
    // nothing armed but the idle timer of the request written after the probe: 32 000 + idle
    expect(core.armed().map((t) => [t.kind, t.due])).toEqual([['idle', 62000]]);
    core.advance(62000 - 51000 - 1);
    expect(core.probeTimes()).toHaveLength(2);
    core.advance(1);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 62000]);
    expect(core.timer('ping')?.ms).toBe(BUDGET); // the budget is untouched
    core.answer();
    core.flow(5 * IDLE, 1000);
    expect(core.probeTimes()).toHaveLength(3);
    settle(core);
  });

  test('forgiven once in a row: the next unanswered probe is dead even with proof, unless one was answered between', () => {
    for (const answeredBetween of [false, true]) {
      const core = proven();
      core.advance(BUDGET - 2000); // saved at 51 000
      core.advance(11000); // probe 3 at 62 000
      if (answeredBetween) {
        core.answer();
        core.advance(IDLE); // probe 4 at 92 000
      }
      const id = core.request()!;
      core.receive(inbound.result(id));
      core.advance(BUDGET);
      expect(core.deaths).toEqual(answeredBetween ? [] : [1]);
      expect(core.saves).toEqual(answeredBetween ? [51000, 112000] : [51000]);
      settle(core);
    }
  });

  test('a new session may forgive one probe again', () => {
    const core = proven();
    core.advance(BUDGET - 2000); // saved
    core.end();
    core.welcome(); // capability yes: idle armed for 51 000 + idle
    core.advance(IDLE);
    const id = core.request()!;
    core.receive(inbound.result(id));
    core.advance(BUDGET);
    expect(core.deaths).toEqual([]);
    expect(core.saves).toEqual([51000, 51000 + IDLE + BUDGET]);
    settle(core);
  });

  test.each<[string, (core: Core, early: number) => void]>([
    [
      'EVENTs and INVOCATIONs only',
      (core) => {
        core.flow(5000, 1000, () => inbound.invocation(5, 1));
      },
    ],
    ['replies only to requests written before the probe', (core, early) => core.receive(inbound.result(early))],
    [
      'one request ahead of it, one after it and a single reply (it may answer the earlier one)',
      (core, early) => {
        core.request();
        core.receive(inbound.result(early));
      },
    ],
    [
      'a stray final reply before the request written after it, which gets none',
      (core) => {
        core.receive(inbound.subscribed(99, 1));
        core.request();
      },
    ],
    [
      'a progress RESULT for a request written after it',
      (core) => core.receive(inbound.result(core.request()!, [], {}, { progress: true })),
    ],
    ['an ERROR(CANCEL) for it', (core) => core.receive(inbound.error(49, core.request()!, Uri.CANCELED))],
    [
      'a write that expects no reply after it (no reply can prove one)',
      (core) => {
        core.send();
        core.request(false);
        core.receive(inbound.result(99));
      },
    ],
  ])('no proof, capability yes: %s ⇒ dead', (_name, after) => {
    const core = calibrated();
    core.advance(IDLE - 100);
    const early = core.request()!;
    core.advance(100); // probe 2 at 31 000, one request ahead of it
    after(core, early);
    core.advance(BUDGET);
    expect(core.deaths).toEqual([1]);
    expect(core.saves).toEqual([]);
    settle(core);
  });

  test('stray replies cannot hide a one-way half-open link: forgiven once, the later requests are found in time', () => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 at 31 000; the uplink dies right after it
    core.advance(1000);
    const written = core.real;
    core.request(); // 32 000: into the dead uplink
    core.request();
    core.receive(inbound.unsubscribed(98)); // a stray duplicate passes for proof (one request still counted)
    core.flow(written + IDLE - core.real, 1000); // EVENTs keep arriving
    expect(core.saves).toEqual([51000]);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, written + IDLE]);
    core.request();
    core.request();
    core.receive(inbound.published(97, 1)); // another stray during probe 3: not forgiven twice in a row
    core.flow(BUDGET, 1000);
    expect(core.deathTimes).toEqual([written + IDLE + BUDGET]); // within idle + budget of the first request
    settle(core);
  });

  test('a verdict waiting for the probe: probed again at once; the answer runs it, no answer ends the session', () => {
    for (const answer of [true, false]) {
      const core = proven();
      const ran: string[] = [];
      core.verify(core.now, () => ran.push('timeout')); // 33 000: queued behind probe 2
      core.advance(BUDGET - 2000); // 51 000: saved, and probed again at once for the verdict
      expect(core.saves).toEqual([51000]);
      expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 51000]);
      expect(ran).toEqual([]);
      if (answer) core.answer();
      else core.advance(BUDGET);
      expect(ran).toEqual(answer ? ['timeout'] : []);
      expect(core.deaths).toEqual(answer ? [] : [1]);
      settle(core);
    }
  });

  test('writes that expect no reply, unproven when the probe was written: probed again at once', () => {
    const core = calibrated();
    core.advance(10000);
    core.send(); // 11 000: its deadline is 31 000
    core.advance(20000); // probe 2 at 31 000
    core.advance(1000);
    const id = core.request()!;
    core.receive(inbound.result(id));
    core.advance(BUDGET - 1000); // 51 000: saved, but the YIELD is still unproven
    expect(core.saves).toEqual([51000]);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 51000]);
    core.answer(); // proves it
    core.flow(5 * IDLE, 1000);
    expect(core.probeTimes()).toHaveLength(3);
    settle(core);
  });

  test('the deadline of a write after the probe passed meanwhile (idle below the budget): probed again at once', () => {
    const core = calibrated({ idle: 5000, pingBudget: BUDGET });
    core.advance(5000); // probe 2 at 6 000
    core.advance(100);
    const id = core.request()!; // 6 100: its deadline is 11 100
    core.receive(inbound.result(id));
    core.advance(BUDGET - 100); // 26 000: saved
    expect(core.saves).toEqual([26000]);
    expect(core.probeTimes()).toEqual([1000, 6000, 26000]);
    settle(core);
  });

  test('a save proves nothing about earlier requests: a verdict for one still needs an answered probe', () => {
    const core = proven();
    core.advance(BUDGET - 2000); // saved at 51 000; the last answered probe was written at 1 000
    const ran: string[] = [];
    core.verify(20000, () => ran.push('timeout'));
    expect(ran).toEqual([]);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 51000]);
    core.answer();
    expect(ran).toEqual(['timeout']);
    settle(core);
  });

  test('a backlog still draining is checked first; the proof decides when the budget is spent', () => {
    const core = calibrated();
    core.buffered = 50000;
    core.advance(IDLE); // probe 2 at 31 000 behind a large upload
    const id = core.request()!;
    core.receive(inbound.result(id));
    core.buffered = 10000;
    core.advance(BUDGET); // 51 000: draining, re-checked every 5 s
    expect(core.saves).toEqual([]);
    core.buffered = 0;
    core.advance(DRAIN_RECHECK); // drained: one more budget
    core.advance(BUDGET);
    expect(core.saves).toEqual([51000 + DRAIN_RECHECK + BUDGET]);
    expect(core.deaths).toEqual([]);
    settle(core);
  });

  describe('the late answer of a forgiven probe', () => {
    test.each<[string, (id: number) => InboundMessage]>([
      ['ERROR(CALL)', (id) => inbound.error(48, id, Uri.NO_SUCH_PROCEDURE)],
      ['ERROR(CANCEL)', (id) => inbound.error(49, id, Uri.CANCELED)],
      ['RESULT', (id) => inbound.result(id)],
    ])('(%s) is consumed and settles no request: a request into a dead uplink is still found', (_name, msg) => {
      const core = proven();
      core.advance(BUDGET - 2000); // 51 000: saved
      const forgiven = core.forgivenProbe()!.id;
      core.advance(1000);
      core.request(); // 52 000: into an uplink that dies now
      core.advance(1000);
      expect(core.late(msg)).toBe(true); // 53 000: not routed to `call`
      expect([...core.liveness.pendingIds()]).toEqual([]);
      core.flow(10 * IDLE, 1000); // EVENTs keep coming
      // taken for the request's reply, it would let the EVENTs move the deadline for ever (no probe, no death)
      expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 62000]);
      expect(core.deathTimes).toEqual([62000 + BUDGET]);
      expect(forgiven).toBe(core.probes[1]!.id);
      settle(core);
    });

    test('only its first copy is consumed; another frame for that id is routed on', () => {
      const core = proven();
      core.advance(BUDGET - 2000);
      expect(core.late()).toBe(true);
      expect(core.receive(inbound.error(48, core.probes[1]!.id, Uri.NO_SUCH_PROCEDURE))).toBe(false);
      settle(core);
    });

    test('while the next probe is pending, it is not that probe’s answer', () => {
      const core = proven();
      const ran: string[] = [];
      core.verify(core.now, () => ran.push('timeout'));
      core.advance(BUDGET - 2000); // 51 000: saved, and probed again at once for the verdict
      const next = core.pendingProbe()!.id;
      expect([...core.liveness.pendingIds()]).toEqual([next, core.probes[1]!.id]);
      expect(core.late()).toBe(true);
      expect([...core.liveness.pendingIds()]).toEqual([next]);
      expect(core.timer('ping')).toEqual({ ms: BUDGET, due: 51000 + BUDGET });
      expect(ran).toEqual([]); // a late answer settles no verdict either
      core.answer();
      expect(ran).toEqual(['timeout']);
      settle(core);
    });

    test('only the last forgiven probe is remembered, and only in its session', () => {
      const core = proven();
      core.advance(BUDGET - 2000); // probe 2 saved at 51 000
      core.advance(11000); // probe 3 at 62 000
      core.answer();
      core.advance(IDLE); // probe 4 at 92 000
      const id = core.request()!;
      core.receive(inbound.result(id));
      core.advance(BUDGET); // probe 4 saved at 112 000: it replaces probe 2
      expect(core.saves).toEqual([51000, 112000]);
      expect([...core.liveness.pendingIds()]).toEqual([core.probes[3]!.id]);
      expect(core.receive(inbound.error(48, core.probes[1]!.id, Uri.NO_SUCH_PROCEDURE))).toBe(false);
      const old = core.current;
      core.end();
      expect([...core.liveness.pendingIds()]).toEqual([]);
      core.welcome();
      expect([...core.liveness.pendingIds()]).toEqual([]);
      expect(core.receive(inbound.error(48, core.probes[3]!.id, Uri.NO_SUCH_PROCEDURE))).toBe(false);
      expect(core.step(() => core.liveness.inbound(inbound.result(core.probes[3]!.id), old))).toBe(false);
      settle(core);
    });
  });
});

describe('writes that expect no reply hold the deadline', () => {
  const invocation = (): InboundMessage => inbound.invocation(5, 1);

  test('a callee whose uplink dies while INVOCATIONs keep arriving is found within idle + budget of its YIELD', () => {
    const core = calibrated();
    core.flow(5000, 1000, invocation);
    const written = core.real;
    core.send(); // 6 000: the YIELD goes into a dead uplink
    core.flow(IDLE + BUDGET, 1000, invocation);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, written + IDLE]);
    expect(core.deathTimes).toEqual([written + IDLE + BUDGET]);
    settle(core);
  });

  test.each<[string, () => InboundMessage]>([
    ['INVOCATIONs', invocation],
    ['replies (they prove requests, not this write)', () => inbound.result(99)],
    ['progress RESULTs', () => inbound.result(99, [], {}, { progress: true })],
    ['revocations', () => inbound.registrationRevoked(5)],
  ])('%s do not move its deadline; the answer of a probe written after it does', (_name, frame) => {
    const core = calibrated(); // deadline 31 000
    core.advance(10000);
    core.send(); // 11 000: does not postpone the deadline either
    core.flow(IDLE - 10000, 1000, frame);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, CALIBRATION_DELAY + IDLE]);
    core.advance(100);
    core.answer();
    core.flow(5 * IDLE, 1000, invocation);
    expect(core.probeTimes()).toHaveLength(2);
    settle(core);
  });

  test.each<[string, (core: Core) => void]>([
    ['a YIELD (ctx.send)', (core) => core.send()],
    ['an unacknowledged PUBLISH', (core) => core.request(false)],
  ])('%s written while a probe is pending keeps its own deadline: the answer does not prove it', (_name, write) => {
    const core = calibrated();
    core.advance(IDLE); // probe 2 at 31 000
    core.advance(100);
    write(core); // 31 100
    write(core); // a second one keeps the first one's deadline
    core.flow(5000, 1000, invocation);
    core.answer(); // 36 100: the writes stay unproven
    core.flow(IDLE, 1000, invocation);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, 31000, 31100 + IDLE]);
    core.answer(); // written after them: proves them
    core.flow(5 * IDLE, 1000, invocation);
    expect(core.probeTimes()).toHaveLength(3);
    settle(core);
  });

  test('...and when that deadline passes while the probe is pending, its answer probes again at once', () => {
    const core = calibrated({ idle: 5000, pingBudget: BUDGET });
    core.advance(5000); // probe 2 at 6 000
    core.advance(100);
    core.send(); // 6 100: deadline 11 100
    core.advance(5900);
    expect(core.probeTimes()).toEqual([1000, 6000]);
    core.answer(); // 12 000
    expect(core.probeTimes()).toEqual([1000, 6000, 12000]);
    core.advance(10);
    core.answer();
    core.flow(10 * 5000, 1000, invocation);
    expect(core.probeTimes()).toHaveLength(3);
    settle(core);
  });

  test.each([
    ['before the calibration probe: proven by its answer', 500, []],
    ['after the calibration probe: idle after its write', 1100, [1100 + IDLE]],
  ])('written during calibration, %s', (_name, at, later) => {
    const core = new Core();
    core.welcome();
    core.advance(at);
    core.send();
    core.flow(3000 - at, 100, invocation); // the calibration probe at 1 000
    core.answer(); // 3 000
    core.flow(2 * IDLE, 1000, invocation);
    expect(core.probeTimes()).toEqual([CALIBRATION_DELAY, ...later]);
    settle(core);
  });

  test('cost: a callee that answers INVOCATIONs all the time gets one probe per idle', () => {
    const core = calibrated();
    for (let t = 0; t < 10 * IDLE; t += 100) {
      core.advance(100);
      if (core.pendingProbe() !== undefined) core.answer();
      core.receive(invocation());
      core.send();
    }
    const probes = core.probeTimes();
    expect(probes).toHaveLength(11);
    for (let i = 2; i < probes.length; i++) {
      expect(probes[i]! - probes[i - 1]!).toBeGreaterThanOrEqual(IDLE);
      expect(probes[i]! - probes[i - 1]!).toBeLessThanOrEqual(IDLE + 200);
    }
    expect(core.deaths).toEqual([]);
    settle(core);
  });

  test('liveness off: writes that expect no reply change nothing', () => {
    for (const core of [new Core({ idle: 0 }), new Core()]) {
      core.welcome(core.idle === 0 ? DEALER : { broker: {} });
      core.send();
      core.request(false);
      core.flow(3 * IDLE, 1000, invocation);
      expect(core.probes).toEqual([]);
      expect(core.timers).toEqual([]);
      settle(core);
    }
  });

  test('a stale ctx: a write reported for an ended session changes nothing in the next one', () => {
    const core = calibrated();
    const old = core.current;
    core.end();
    core.welcome();
    core.step(() => {
      core.liveness.sent(old);
      core.liveness.wrote(false, old);
    });
    core.flow(5 * IDLE, 1000, invocation);
    expect(core.probeTimes()).toEqual([]);
    expect(core.armed().map((t) => t.kind)).toEqual(['idle']);
    settle(core);
  });

  test('a session end forgets unproven writes', () => {
    const core = calibrated();
    core.send();
    core.end();
    core.welcome();
    core.flow(5 * IDLE, 1000, invocation);
    expect(core.probeTimes()).toEqual([]);
    settle(core);
  });
});

describe('liveness can never loop on one endpoint', () => {
  const quietDeath = (core: Core): void => {
    core.welcome();
    core.advance(CALIBRATION_DELAY + PING_BUDGET_CAP); // a calibration probe, never answered, nothing else arrives
  };

  test("a liveness end on a 'yes' endpoint sends it back to calibration; the next healthy session makes it 'yes' again", () => {
    const core = calibrated();
    core.advance(IDLE + BUDGET); // the probe at 31 000 is never answered: dead
    expect(core.deaths).toEqual([1]);
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY); // calibrates instead of trusting the old 'yes'
    core.advance(CALIBRATION_DELAY);
    expect(core.answer()).toBe(true);
    core.end();
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(IDLE); // answered again: 'yes'
    expect(core.logged('liveness.unsupported')).toBe(0);
    settle(core);
  });

  test("a 'yes' endpoint that stops answering costs one more session before it calibrates: three ends at most", () => {
    // without this bound, a liveness reconnect about every idle + budget for as long as the URL stayed the same
    const core = calibrated();
    core.advance(IDLE + BUDGET); // the session in which it stopped answering
    for (let i = 0; i < 6; i++) quietDeath(core);
    expect(core.deaths).toEqual([1, 2, 3]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('a session that answered a probe and then ended by liveness does not count (a real half-open link)', () => {
    const core = new Core();
    quietDeath(core); // 1 in a row
    core.welcome();
    core.advance(CALIBRATION_DELAY);
    core.answer();
    core.advance(IDLE + BUDGET); // answered, then half-open: the run of unanswered sessions starts again
    quietDeath(core); // 1 in a row
    expect(core.deaths).toEqual([1, 2, 3]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    quietDeath(core); // 2 in a row: off
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test("what counts is a probe answered in the session, not the router's capability: a 'yes' session that answered none counts", () => {
    // Two half-open links in a row on a router that answers probes, the second before the next session's calibration
    // was answered: by the rule, probing goes off on that router
    const core = calibrated();
    core.end(); // a drop: 'yes' stays, the run is 0
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(IDLE); // 'yes': no calibration, no probe answered in this session yet
    core.advance(IDLE + BUDGET); // half-open: its first probe is never answered
    expect(core.deaths).toEqual([2]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    quietDeath(core); // the next link dies before its calibration probe is answered: 2 in a row
    expect(core.deaths).toEqual([2, 3]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    core.welcome();
    expect(core.armed()).toEqual([]);
    settle(core);
  });

  test("any probe answered in the session resets the run, not only a calibration: a 'yes' session's later answer too", () => {
    const core = calibrated();
    core.end(); // a drop: 'yes' stays, the run is 0
    core.welcome();
    core.advance(IDLE); // its first probe (silence), on a 'yes' router: no calibration
    expect(core.answer()).toBe(true);
    core.advance(IDLE + BUDGET); // then half-open: the next probe is never answered
    expect(core.deaths).toEqual([2]);
    quietDeath(core); // 1 in a row, not 2
    expect(core.deaths).toEqual([2, 3]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    quietDeath(core); // 2 in a row: off
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('a session that ends otherwise in between restarts the count: each such end allows one more liveness end', () => {
    // "two consecutive sessions on one endpoint": a session cut by something else (a drop, close(), reconnect()) is
    // one of them and ended otherwise
    const core = new Core();
    quietDeath(core);
    core.welcome();
    core.advance(500);
    core.end(false); // a socket drop before its calibration probe was due
    quietDeath(core);
    expect(core.deaths).toEqual([1, 3]);
    expect(core.logged('liveness.unsupported')).toBe(0);
    quietDeath(core);
    expect(core.deaths).toEqual([1, 3, 4]);
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('the count is per endpoint: A, B, A — A is off after its second end in a row, B still probes', () => {
    const core = new Core();
    for (const url of ['ws://a/', 'ws://b/', 'ws://a/?ticket=2']) {
      core.url = url;
      quietDeath(core);
    }
    expect(core.deaths).toEqual([1, 2, 3]);
    expect(core.ctxs.map((c) => c.logged('liveness.unsupported').length)).toEqual([0, 0, 1]);
    core.url = 'ws://a/';
    core.welcome();
    expect(core.armed()).toEqual([]);
    core.end();
    core.url = 'ws://b/';
    core.welcome();
    expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
    settle(core);
  });

  test('a callee whose INVOCATIONs keep arriving on a router that drops probes: bounded the same way', () => {
    const core = new Core();
    const alive = (): boolean => core.ctx !== undefined; // read after each step (advance() may end the session)
    for (let i = 0; i < 5; i++) {
      core.welcome();
      for (let t = 0; t < 4 * PING_BUDGET_CAP && alive(); t += 1000) {
        core.advance(1000);
        if (!alive()) break;
        core.receive(inbound.invocation(9, 1));
        core.send(); // its YIELD
      }
      if (core.ctx !== undefined) core.end();
    }
    expect(core.deaths.length).toBeLessThanOrEqual(2);
    expect(core.logged('liveness.unsupported')).toBe(1);
    settle(core);
  });

  test('budget(ctx): the budget in force in that session (doubled after liveness ends); the base for another ctx', () => {
    const core = new Core();
    const first = core.welcome();
    expect(core.liveness.budget(first)).toBe(BUDGET);
    core.advance(CALIBRATION_DELAY + BUDGET); // dead: the budget doubles
    expect(core.liveness.budget(first)).toBe(BUDGET); // an ended session's ctx
    const second = core.welcome();
    expect(core.liveness.budget(second)).toBe(2 * BUDGET);
    core.endpoint('ws://other/'); // reported mid-session: this session keeps its router's budget
    expect(core.liveness.budget(second)).toBe(2 * BUDGET);
    settle(core);
  });
});

// =====================================================================================================================
// Properties over random interleavings (fake timers)
// =====================================================================================================================

type ReplyKind =
  'result' | 'progress' | 'error48' | 'error49' | 'error8' | 'subscribed' | 'published' | 'unsubscribed' | 'revoked';

/** URLs of the model's routers: a fresh ticket in the query string or a fragment is still the same endpoint. */
type Url = 'ws://a/' | 'ws://a/?ticket=1' | 'ws://a/?ticket=2#x' | 'ws://b/' | 'ws://b/#y' | 'ws://c/';
const URLS: readonly Url[] = ['ws://a/', 'ws://a/?ticket=1', 'ws://a/?ticket=2#x', 'ws://b/', 'ws://b/#y', 'ws://c/'];

type Command =
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'event' }
  | { readonly kind: 'request'; readonly expectsReply: boolean }
  | { readonly kind: 'send' }
  | { readonly kind: 'reply'; readonly frame: ReplyKind }
  | { readonly kind: 'answer'; readonly how: 'error' | 'result' | 'cancel' }
  | { readonly kind: 'skew'; readonly ms: number }
  | { readonly kind: 'buffered'; readonly n: number }
  | { readonly kind: 'open' }
  | { readonly kind: 'verify'; readonly back: number }
  | { readonly kind: 'drop'; readonly roles: 'dealer' | 'none' | 'broker'; readonly url: Url | undefined }
  | { readonly kind: 'endpoint'; readonly url: Url }
  | { readonly kind: 'late' }
  | { readonly kind: 'stale' };

const REPLY_KINDS: readonly ReplyKind[] = [
  'result',
  'progress',
  'error48',
  'error49',
  'error8',
  'subscribed',
  'published',
  'unsubscribed',
  'revoked',
];
const FINAL: ReadonlySet<ReplyKind> = new Set<ReplyKind>([
  'result',
  'error48',
  'subscribed',
  'published',
  'unsubscribed',
]);

function replyFrame(kind: ReplyKind, id: number): InboundMessage {
  switch (kind) {
    case 'result':
      return inbound.result(id);
    case 'progress':
      return inbound.result(id, [], {}, { progress: true });
    case 'error48':
      return inbound.error(48, id, Uri.CANCELED);
    case 'error49':
      return inbound.error(49, id, Uri.CANCELED);
    case 'error8':
      return inbound.error(8, id, Uri.NO_SUCH_PROCEDURE);
    case 'subscribed':
      return inbound.subscribed(id, 3);
    case 'published':
      return inbound.published(id, 3);
    case 'unsubscribed':
      return inbound.unsubscribed(id);
    case 'revoked':
      return inbound.subscriptionRevoked(3);
  }
}

/** `dropsProbes`: the router answers probes rarely and requests often, so probes expire with proof of activity. */
function commands(withSkew: boolean, dropsProbes = false): fc.Arbitrary<Command[]> {
  const options: fc.WeightedArbitrary<Command>[] = [
    {
      weight: 6,
      arbitrary: fc.record({
        kind: fc.constant('advance' as const),
        ms: fc.oneof(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 0, max: 70000 })),
      }),
    },
    { weight: 3, arbitrary: fc.constant({ kind: 'event' as const }) },
    {
      weight: dropsProbes ? 4 : 2,
      arbitrary: fc.record({ kind: fc.constant('request' as const), expectsReply: fc.boolean() }),
    },
    { weight: 2, arbitrary: fc.constant({ kind: 'send' as const }) },
    {
      weight: dropsProbes ? 5 : 3,
      arbitrary: fc.record({ kind: fc.constant('reply' as const), frame: fc.constantFrom(...REPLY_KINDS) }),
    },
    {
      weight: dropsProbes ? 1 : 3,
      arbitrary: fc.record({
        kind: fc.constant('answer' as const),
        how: fc.constantFrom('error' as const, 'result' as const, 'cancel' as const),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('buffered' as const), n: fc.oneof(fc.constant(0), fc.nat(100000)) }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'open' as const }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('verify' as const), back: fc.nat(70000) }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('drop' as const),
        roles: fc.constantFrom('dealer' as const, 'dealer' as const, 'none' as const, 'broker' as const),
        url: fc.constantFrom<Url | undefined>(...URLS, undefined),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('endpoint' as const),
        url: fc.constantFrom(...URLS),
      }),
    },
    { weight: dropsProbes ? 2 : 1, arbitrary: fc.constant({ kind: 'late' as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'stale' as const }) },
  ];
  if (withSkew) {
    options.push({
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('skew' as const),
        ms: fc.oneof(fc.integer({ min: -HOUR, max: HOUR }), fc.constantFrom(-30 * 24 * HOUR, 30 * 24 * HOUR)),
      }),
    });
  }
  return fc.array(fc.oneof(...options), { maxLength: 150, size: 'max' });
}

const ROLES = { dealer: DEALER, none: {}, broker: { broker: {} } } as const;

/** What the model knows about one router: an endpoint seen for the first time starts from scratch. */
interface ModelEndpoint {
  /** Capability yes: a probe was answered on it, and no session on it has ended by liveness since. */
  yes: boolean;
  /** Probing was turned off on it. */
  no: boolean;
  /** The latest sessions on it, in a row, that ended by liveness with no probe answered in them. */
  deadSessions: number;
}

/** Exact model of the liveness deadlines for the current session, in real time. */
interface Model {
  lastInbound: number;
  /** Since when a request has waited for any reply-class frame (awaitingSince). */
  awaiting: number | undefined;
  /** Requests waiting for their final reply (ids, oldest first). */
  outstanding: number[];
  /** Write time of the first request expecting a reply written while the pending probe was in flight: the probe's
   *  answer does not vouch for it, so its wait is not restarted by that answer. */
  afterProbe: number | undefined;
  /** Write time of the oldest write that expects no reply (send, unacknowledged PUBLISH) not yet proven by the answer
   *  of a probe written after it: no other frame restarts its wait. */
  unproven: number | undefined;
  /** Write time of the first such write while the pending probe was in flight: unproven after that answer. */
  sentAfterProbe: number | undefined;
  /** A request expecting a reply was written while the pending probe was in flight, and then a final reply arrived:
   *  without both, nothing proves that the router processed something written after the probe. */
  askedAfterProbe: boolean;
  repliedAfterAsk: boolean;
  /** The last probe went unanswered and was forgiven: the next one must be answered. */
  saved: boolean;
  /** The id of the last forgiven probe whose late answer has not arrived: still in flight. */
  forgiven: number | undefined;
  /** Arrival of the last reply-class frame (not the probe's answer). */
  lastReply: number;
  /** Liveness is on for the current session (idle > 0, a dealer, probing not turned off on its router). */
  enabled: boolean;
  skewed: boolean;
}

/** Run `cmds` against a fresh client and check every invariant after each command. */
function runModel(cmds: readonly Command[], options: { readonly idle: number; readonly pingBudget: number }): void {
  const core = new Core(options);
  core.autoReconnect = true;
  const m: Model = {
    lastInbound: 0,
    awaiting: undefined,
    outstanding: [],
    afterProbe: undefined,
    unproven: undefined,
    sentAfterProbe: undefined,
    askedAfterProbe: false,
    repliedAfterAsk: false,
    saved: false,
    forgiven: undefined,
    lastReply: -Infinity,
    enabled: true,
    skewed: false,
  };
  let stale: CoreCtx | undefined;
  // what was learned per endpoint (the URL up to `?` or `#`), and the one the next session talks to
  const endpoints = new Map<string, ModelEndpoint>();
  let endpoint: ModelEndpoint = { yes: false, no: false, deadSessions: 0 };
  const endpointOf = new Map<number, ModelEndpoint>();
  const report = (url: string): void => {
    const key = url.split(/[?#]/)[0]!;
    const known = endpoints.get(key) ?? { yes: false, no: false, deadSessions: 0 };
    endpoints.set(key, known);
    endpoint = known;
  };
  core.onWelcome = (ctx) => {
    if (core.url !== undefined) report(core.url);
    endpointOf.set(ctx.connId, endpoint);
  };
  const sessionEndpoint = (): ModelEndpoint => endpointOf.get(core.current.connId)!;
  const probeGone = (): void => {
    m.afterProbe = undefined;
    m.sentAfterProbe = undefined;
    m.askedAfterProbe = false;
    m.repliedAfterAsk = false;
  };
  core.onSave = () => {
    // a probe is forgiven only on its router's proven capability, with a request written after it answered, and
    // never twice in a row
    expect(sessionEndpoint().yes).toBe(true);
    expect(m.askedAfterProbe && m.repliedAfterAsk).toBe(true);
    expect(m.saved).toBe(false);
    m.saved = true;
    m.forgiven = core.forgivenProbe()!.id;
    probeGone();
  };

  const reset = (): void => {
    m.lastInbound = core.welcomedAt.get(core.current.connId)!;
    m.awaiting = undefined;
    m.outstanding = [];
    m.unproven = undefined;
    m.saved = false;
    m.forgiven = undefined;
    probeGone();
    m.lastReply = -Infinity;
    m.enabled = options.idle > 0 && (core.roles === ROLES.dealer || core.roles === ROLES.none) && !sessionEndpoint().no;
  };
  const replied = (final: boolean): void => {
    if (final) m.outstanding.shift();
    m.awaiting = m.outstanding.length > 0 ? core.real : undefined;
    m.lastReply = core.real;
  };
  const noReply = (probing: boolean): void => {
    m.unproven ??= core.real;
    if (probing) m.sentAfterProbe ??= core.real;
  };

  core.welcome(ROLES.dealer);
  reset();
  for (const cmd of cmds) {
    const conn = core.current.connId;
    const deaths = core.deaths.length;
    const wasEnabled = m.enabled;
    const probing = m.enabled && core.pendingProbe() !== undefined;
    switch (cmd.kind) {
      case 'advance':
        core.advance(cmd.ms);
        break;
      case 'event':
        expect(core.receive(inbound.event(1, 1))).toBe(false);
        m.lastInbound = core.real;
        break;
      case 'request': {
        const id = core.request(cmd.expectsReply)!;
        if (cmd.expectsReply) {
          if (m.outstanding.length === 0) m.awaiting = core.real;
          m.outstanding.push(id);
          if (probing) {
            m.afterProbe ??= core.real;
            m.askedAfterProbe = true;
          }
        } else {
          noReply(probing);
        }
        break;
      }
      case 'send':
        expect(core.send()).toBe(true);
        noReply(probing);
        break;
      case 'reply': {
        const id = m.outstanding[0] ?? 999999999;
        expect(core.receive(replyFrame(cmd.frame, id))).toBe(false);
        m.lastInbound = core.real;
        if (cmd.frame !== 'revoked') replied(FINAL.has(cmd.frame) && m.outstanding.length > 0);
        if (FINAL.has(cmd.frame) && m.askedAfterProbe) m.repliedAfterAsk = true;
        break;
      }
      case 'answer': {
        const probe = core.pendingProbe();
        if (probe === undefined || !m.enabled) break;
        const msg =
          cmd.how === 'error'
            ? inbound.error(48, probe.id, Uri.NO_SUCH_PROCEDURE)
            : cmd.how === 'result'
              ? inbound.result(probe.id)
              : inbound.error(49, probe.id, Uri.CANCELED);
        expect(core.receive(msg)).toBe(true);
        sessionEndpoint().yes = true;
        m.saved = false;
        m.lastInbound = core.real;
        // the answer proves that the router received everything written before the probe: their wait restarts;
        // a request written after it keeps waiting since its write (or since a reply after it), and a write after it
        // that expects no reply stays unproven
        if (m.outstanding.length === 0) m.awaiting = undefined;
        else m.awaiting = m.afterProbe === undefined ? core.real : Math.max(m.afterProbe, m.lastReply);
        m.unproven = m.sentAfterProbe;
        probeGone();
        break;
      }
      case 'skew':
        core.skew += cmd.ms;
        m.skewed = true;
        break;
      case 'buffered':
        core.buffered = cmd.n;
        break;
      case 'open':
        core.open();
        break;
      case 'verify': {
        const record = { conn, since: core.real - cmd.back, ran: 0 };
        core.verify(core.now - cmd.back, () => {
          record.ran++;
          expect(core.inStep).toBe(false); // in a later step
          // verdicts only for the current connection, at most once
          expect(core.ctx?.connId).toBe(record.conn);
          expect(record.ran).toBe(1);
          if (!m.skewed && m.enabled) {
            // alive ⇒ timeout only with proof: a probe written at or after `since` was answered on that connection
            const proof = core.probes.some((p) => p.conn === record.conn && p.answered && p.real >= record.since);
            expect(proof || core.current.logged('liveness.unsupported').length > 0).toBe(true);
          }
        });
        break;
      }
      case 'drop': {
        stale = core.current;
        const ended = sessionEndpoint();
        core.end(false);
        ended.deadSessions = 0; // a session that ends otherwise breaks a run of liveness ends
        core.roles = ROLES[cmd.roles];
        core.url = cmd.url;
        core.welcome();
        const next = endpointOf.get(core.current.connId)!;
        const on = options.idle > 0 && core.roles !== ROLES.broker && !next.no;
        // a session on a router not known to answer calibrates first (also after a liveness end there)
        expect(core.timer('idle')?.ms).toBe(
          on ? (next.yes ? options.idle : Math.min(CALIBRATION_DELAY, options.idle)) : undefined,
        );
        break;
      }
      case 'endpoint':
        // reported during a session: the running session keeps its router; the next one uses the reported endpoint's
        core.endpoint(cmd.url);
        report(cmd.url);
        break;
      case 'late':
        // the late answer of the forgiven probe: consumed once, and no reply (it settles no request)
        if (m.forgiven === undefined) break;
        expect(core.late()).toBe(true);
        m.forgiven = undefined;
        m.lastInbound = core.real;
        break;
      case 'stale': {
        const old = stale;
        if (old === undefined) break;
        core.step(() => {
          expect(core.liveness.inbound(inbound.error(48, 1, Uri.CANCELED), old)).toBe(false);
          core.liveness.wrote(true, old);
          core.liveness.wrote(false, old);
          core.liveness.sent(old);
          core.liveness.onIdle(old);
          expect(core.liveness.onPing(old)).toBe('alive');
          core.liveness.check(old);
          core.liveness.verifyAlive(
            0,
            () => {
              throw new Error('a verdict of an ended session ran');
            },
            old,
          );
        });
        break;
      }
    }
    if (core.deaths.length > deaths) expect(wasEnabled).toBe(true); // only liveness that is on can end a session
    for (const dead of core.deaths.slice(deaths)) {
      // the router calibrates again; the second session in a row that ends by liveness with no probe answered
      // in it turns probing off on its router (warn liveness.unsupported in that session), and nothing else does here
      const ep = endpointOf.get(dead)!;
      const answered = core.probes.some((p) => p.conn === dead && p.answered);
      ep.yes = false;
      ep.deadSessions = answered ? 0 : ep.deadSessions + 1;
      const ctx = core.ctxs.find((c) => c.connId === dead)!;
      const off = ctx.logged('liveness.unsupported');
      if (ep.deadSessions >= 2) {
        expect(off.map((e) => e.message)).toEqual([
          `the router answered no liveness probe in ${String(ep.deadSessions)} sessions in a row: liveness is off`,
        ]);
        ep.no = true;
      } else {
        expect(off).toEqual([]);
      }
    }
    for (const ctx of core.ctxs) {
      if (ctx.logged('liveness.unsupported').length > 0) endpointOf.get(ctx.connId)!.no = true;
    }
    if (core.current.connId !== conn) {
      if (cmd.kind !== 'drop') stale = core.ctxs.find((c) => c.connId === conn);
      reset();
    }
    if (core.current.logged('liveness.unsupported').length > 0) m.enabled = false;

    // never two probes in flight, host contract breaches (timers/later for other sessions, bad delays)
    expect(core.failures).toEqual([]);
    // no timer left armed for a session that ended
    expect(core.timers.filter((t) => t.state === 'armed' && core.ended.has(t.conn))).toEqual([]);
    // the pending probe is the one liveness reports
    const pending = m.enabled ? core.pendingProbe() : undefined;
    expect([...core.liveness.pendingIds()]).toEqual(
      [pending?.id, m.forgiven].filter((id): id is number => id !== undefined),
    );
    if (m.enabled) {
      // INV-LIVE (real time, whatever the skew): a probe is pending, or nothing has been silent for `idle`, no
      // request has waited `idle` for a reply, and no write that expects none has waited `idle` for a probe's answer
      if (pending === undefined) {
        expect(core.real - m.lastInbound).toBeLessThan(options.idle);
        if (m.awaiting !== undefined) expect(core.real - m.awaiting).toBeLessThan(options.idle);
        if (m.unproven !== undefined) expect(core.real - m.unproven).toBeLessThan(options.idle);
      }
    } else {
      // liveness off: nothing that could kill the session, nothing written
      expect(core.armed('ping')).toEqual([]);
    }
  }
  // ending the session leaves nothing armed
  core.end();
  expect(core.timers.filter((t) => t.state === 'armed')).toEqual([]);
  expect(core.failures).toEqual([]);
}

/** The test timeout scales with FC_NUM_RUNS: about 1.2 ms per run measured (slowest property), 5 ms allowed. */
const PROPERTY_TIMEOUT = Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 5);

describe('properties (fake timers)', () => {
  const profiles = fc.constantFrom(
    { idle: IDLE, pingBudget: BUDGET },
    { idle: 500, pingBudget: 3000 },
    { idle: 30000, pingBudget: 4000 },
    { idle: 0, pingBudget: BUDGET },
  );

  test(
    'invariants hold over random interleavings, with clock jumps',
    () => {
      fc.assert(
        fc.property(commands(true), profiles, (cmds, profile) => {
          runModel(cmds, profile);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'verdicts are sound and only for the current connection (no clock jumps)',
    () => {
      fc.assert(
        fc.property(commands(false), profiles, (cmds, profile) => {
          runModel(cmds, profile);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'invariants hold when the router drops probes but answers requests (proof of activity)',
    () => {
      fc.assert(
        fc.property(commands(false, true), profiles, (cmds, profile) => {
          // the calibration probe is answered (capability yes), later ones mostly not
          runModel([{ kind: 'advance', ms: CALIBRATION_DELAY }, { kind: 'answer', how: 'error' }, ...cmds], profile);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'no false alarm while the router answers; a dead uplink is found within idle + budget of a write into it',
    () => {
      const phase = fc.record({
        gap: fc.integer({ min: 0, max: 45000 }),
        event: fc.boolean(),
        request: fc.boolean(),
        reply: fc.boolean(),
        send: fc.boolean(),
      });
      fc.assert(
        fc.property(
          fc.array(phase, { maxLength: 30, size: 'max' }),
          fc.integer({ min: 0, max: 90000 }),
          fc.boolean(),
          fc.constantFrom('request' as const, 'publish' as const, 'send' as const),
          (alive, delay, framesAfter, write) => {
            const core = calibrated();
            // The link works: the router answers every probe within 300 ms (requests only when `reply`)
            const live = (ms: number): void => {
              for (let left = ms; left > 0; left -= 300) {
                core.advance(Math.min(300, left));
                if (core.pendingProbe() !== undefined) core.answer();
              }
            };
            for (const step of alive) {
              live(step.gap);
              if (step.event) core.receive(inbound.event(1, 1));
              if (step.send) core.send();
              if (step.request) {
                const id = core.request()!;
                if (step.reply) core.receive(inbound.result(id));
              }
            }
            expect(core.deaths).toEqual([]);
            // The uplink dies: nothing the client writes arrives any more; EVENTs (INVOCATIONs for a callee) may keep
            // coming
            const frame = (): InboundMessage => (write === 'send' ? inbound.invocation(5, 1) : inbound.event(1, 1));
            const flow = (ms: number): void => {
              if (framesAfter) core.flow(ms, 1000, frame);
              else core.advance(ms);
            };
            flow(delay);
            if (core.ctx === undefined) {
              expect(core.deaths).toEqual([1]); // already found (an earlier write or silence)
              return;
            }
            const written = core.real;
            if (write === 'send') core.send();
            else core.request(write === 'request');
            flow(IDLE + BUDGET);
            expect(core.deaths).toEqual([1]);
            expect(core.deathTimes[0]).toBeLessThanOrEqual(written + IDLE + BUDGET);
            settle(core);
          },
        ),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'a router that drops every probe ends at most one session per endpoint by liveness, whatever the resolver does',
    () => {
      const session = fc.record({
        url: fc.constantFrom(...URLS),
        length: fc.integer({ min: 0, max: 60000 }),
        proof: fc.boolean(),
      });
      fc.assert(
        fc.property(fc.array(session, { maxLength: 20 }), profiles, (sessions, profile) => {
          const core = new Core(profile);
          for (const s of sessions) {
            core.url = s.url;
            core.welcome();
            if (s.proof) {
              // a request written after the calibration probe is answered: probing goes off at once
              core.advance(Math.min(CALIBRATION_DELAY, core.idle));
              core.receive(inbound.result(core.request()!));
            }
            core.flow(s.length, 2000); // EVENTs flow; the router never answers a probe
            if (core.ctx !== undefined) core.end();
          }
          const endpoints = new Set(sessions.map((s) => s.url.split(/[?#]/)[0]));
          expect(core.deaths.length).toBeLessThanOrEqual(endpoints.size);
          settle(core);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  /** One step of a session's traffic (repeated until the session ends): a gap, then a write and a frame. */
  const trafficStep = fc.record({
    gap: fc.integer({ min: 100, max: 10000 }),
    write: fc.constantFrom('none' as const, 'request' as const, 'publish' as const, 'send' as const),
    frame: fc.constantFrom('none' as const, 'event' as const, 'invocation' as const, 'reply' as const),
  });
  /** The traffic patterns: quiet, callee-only (INVOCATIONs in, YIELDs out), request-heavy, and any mix. */
  const traffic = fc.oneof(
    fc.constant([{ gap: 1000, write: 'none' as const, frame: 'none' as const }]),
    fc.constant([{ gap: 1000, write: 'send' as const, frame: 'invocation' as const }]),
    fc.constant([{ gap: 500, write: 'request' as const, frame: 'reply' as const }]),
    fc.array(trafficStep, { minLength: 1, maxLength: 8 }),
  );
  const probing = fc.constantFrom(
    { idle: IDLE, pingBudget: BUDGET },
    { idle: 500, pingBudget: 3000 },
    { idle: 30000, pingBudget: 4000 },
  );

  /**
   * One session on `url` whose router drops every probe (`answerFirst`: but answers this session's first probe) and
   * answers every request at once; `steps` repeat until the session ends by liveness, or until liveness has no timer
   * left in it (probing is off) or 3 × (idle + the largest budget) have passed; then it is ended. Returns whether
   * liveness ended it.
   */
  function droppingSession(
    core: Core,
    url: string,
    steps: readonly { gap: number; write: string; frame: string }[],
    answerFirst: boolean,
  ): boolean {
    core.url = url;
    const conn = core.welcome().connId;
    const limit = core.real + 3 * (core.idle + Math.max(PING_BUDGET_CAP, core.pingBudget));
    const outstanding: number[] = [];
    let answered = !answerFirst;
    const alive = (): boolean => core.ctx?.connId === conn; // read after each step (advance() may end the session)
    for (let i = 0; alive() && core.real < limit && core.armed().length > 0; i++) {
      const step = steps[i % steps.length]!;
      core.advance(step.gap);
      if (!alive()) break;
      if (!answered && core.pendingProbe() !== undefined) answered = core.answer();
      if (step.write === 'send') core.send();
      else if (step.write !== 'none') {
        const id = core.request(step.write === 'request')!;
        if (step.write === 'request') outstanding.push(id);
      }
      if (step.frame === 'event') core.receive(inbound.event(1, 1));
      else if (step.frame === 'invocation') core.receive(inbound.invocation(9, 1));
      else if (step.frame === 'reply' && outstanding.length > 0) core.receive(inbound.result(outstanding.shift()!));
    }
    const died = core.deaths.includes(conn);
    if (!died) {
      expect(core.armed('ping')).toEqual([]); // alive this long only with probing off
      core.end();
    }
    return died;
  }

  test(
    'a router that drops every probe costs at most two liveness reconnects per endpoint, for every traffic pattern',
    () => {
      const session = fc.record({ url: fc.constantFrom(...URLS), steps: traffic });
      fc.assert(
        fc.property(fc.array(session, { minLength: 1, maxLength: 8 }), probing, (sessions, profile) => {
          const core = new Core(profile);
          const deaths = new Map<string, number>();
          for (const { url, steps } of sessions) {
            const key = url.split(/[?#]/)[0]!;
            if (droppingSession(core, url, steps, false)) deaths.set(key, (deaths.get(key) ?? 0) + 1);
          }
          for (const n of deaths.values()) expect(n).toBeLessThanOrEqual(2);
          settle(core);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'a router that answered a probe and then drops every one: at most three liveness reconnects per endpoint',
    () => {
      const session = fc.record({ url: fc.constantFrom(...URLS), steps: traffic });
      fc.assert(
        fc.property(fc.array(session, { minLength: 1, maxLength: 8 }), probing, (sessions, profile) => {
          const core = new Core(profile);
          const seen = new Set<string>();
          const deaths = new Map<string, number>();
          for (const { url, steps } of sessions) {
            const key = url.split(/[?#]/)[0]!;
            // the first session on each endpoint answers its first probe: capability yes, then nothing is answered
            const died = droppingSession(core, url, steps, !seen.has(key));
            seen.add(key);
            if (died) deaths.set(key, (deaths.get(key) ?? 0) + 1);
          }
          for (const n of deaths.values()) expect(n).toBeLessThanOrEqual(3);
          settle(core);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    "a one-way half-open link on a 'yes' endpoint is found within idle + budget; the next healthy session calibrates, and finds the next one",
    () => {
      const phase = fc.record({
        gap: fc.integer({ min: 0, max: 45000 }),
        event: fc.boolean(),
        request: fc.boolean(),
        reply: fc.boolean(),
        send: fc.boolean(),
      });
      const breakdown = fc.record({
        healthy: fc.array(phase, { maxLength: 15 }),
        delay: fc.integer({ min: 0, max: 90000 }),
        framesAfter: fc.boolean(),
        write: fc.constantFrom('request' as const, 'publish' as const, 'send' as const),
      });
      fc.assert(
        fc.property(breakdown, breakdown, (first, second) => {
          const core = calibrated();
          // The link works: the router answers every probe within 300 ms (requests only when `reply`)
          const live = (ms: number): void => {
            for (let left = ms; left > 0; left -= 300) {
              core.advance(Math.min(300, left));
              if (core.pendingProbe() !== undefined) core.answer();
            }
          };
          /** A healthy phase, then the uplink dies; returns once liveness ended the session. */
          const run = (b: typeof first, deathsBefore: number): void => {
            for (const step of b.healthy) {
              live(step.gap);
              if (step.event) core.receive(inbound.event(1, 1));
              if (step.send) core.send();
              if (step.request) {
                const id = core.request()!;
                if (step.reply) core.receive(inbound.result(id));
              }
            }
            expect(core.deaths).toHaveLength(deathsBefore);
            const frame = (): InboundMessage => (b.write === 'send' ? inbound.invocation(5, 1) : inbound.event(1, 1));
            const flow = (ms: number): void => {
              if (b.framesAfter) core.flow(ms, 1000, frame);
              else core.advance(ms);
            };
            flow(b.delay);
            if (core.ctx === undefined) return; // already found (an earlier write or silence)
            const written = core.real;
            if (b.write === 'send') core.send();
            else core.request(b.write === 'request');
            flow(IDLE + BUDGET);
            expect(core.deaths).toHaveLength(deathsBefore + 1);
            expect(core.deathTimes[deathsBefore]).toBeLessThanOrEqual(written + IDLE + BUDGET);
          };
          run(first, 0);
          expect(core.deaths).toHaveLength(1);
          // the next session talks to a healthy router again: it calibrates, the answer makes the router 'yes' again
          core.welcome();
          expect(core.timer('idle')?.ms).toBe(CALIBRATION_DELAY);
          live(CALIBRATION_DELAY + 300);
          expect(core.timer('idle')?.ms).toBe(IDLE);
          expect(core.timer('ping')).toBeUndefined();
          run(second, 1);
          expect(core.deaths).toHaveLength(2);
          expect(core.logged('liveness.unsupported')).toBe(0);
          settle(core);
        }),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    'cost: however the client writes, probes are at least `idle` apart while the router answers them',
    () => {
      const step = fc.record({
        gap: fc.integer({ min: 0, max: 8000 }),
        write: fc.constantFrom('none' as const, 'request' as const, 'publish' as const, 'send' as const),
        frame: fc.constantFrom('none' as const, 'event' as const, 'invocation' as const, 'reply' as const),
      });
      fc.assert(
        fc.property(
          fc.array(step, { maxLength: 120, size: 'max' }),
          fc.integer({ min: 0, max: BUDGET - 200 }),
          (steps, latency) => {
            const core = calibrated();
            const outstanding: number[] = [];
            // The router answers every probe `latency` ms after it was written (checked every 100 ms)
            const live = (ms: number): void => {
              for (let left = ms; left > 0; left -= 100) {
                core.advance(Math.min(100, left));
                const probe = core.pendingProbe();
                if (probe !== undefined && core.real - probe.real >= latency) core.answer();
              }
            };
            for (const s of steps) {
              live(s.gap);
              if (s.write === 'send') core.send();
              else if (s.write !== 'none') {
                const id = core.request(s.write === 'request')!;
                if (s.write === 'request') outstanding.push(id);
              }
              if (s.frame === 'event') core.receive(inbound.event(1, 1));
              else if (s.frame === 'invocation') core.receive(inbound.invocation(9, 1));
              else if (s.frame === 'reply' && outstanding.length > 0)
                core.receive(inbound.result(outstanding.shift()!));
            }
            live(BUDGET);
            expect(core.deaths).toEqual([]);
            const times = core.probeTimes();
            for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(IDLE);
            settle(core);
          },
        ),
        replayParameters(),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
