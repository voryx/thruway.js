/**
 * Internal: the simulation clock: one ordered queue of timers and socket deliveries keyed `(due, tie)`, FIFO within
 * equal keys — `tie` puts socket deliveries due at t before (default) or after timers due at t; sync
 * `advanceSync`/`advanceToNextTimer`; async `advance`/`runUntilIdle` that drain microtasks before and after every
 * entry; scopes that share time but count their own timers; `skew` (moves `now()` only); `suspend` (device sleep:
 * overdue timers fire before pending deliveries); seeded xorshift128+ streams per consumer (`fork`). The public
 * `VirtualClock` (index.ts) is a facade over it.
 *
 * Timer delays follow Node and @sinonjs/fake-timers: NaN and negative delays are 0, a delay above 2^31−1 (Infinity
 * included) is 1 ms; the clock records the delay as requested, so a test can see that the client armed one.
 *
 * @module
 */
import type { VirtualClock } from './index.js';

export interface SimClockOptions {
  /** Initial `now()` [0]. */
  readonly start?: number;
  /** PRNG seed (taken modulo 2^32) [1]. */
  readonly seed?: number;
  /** Whether socket deliveries due at time t run before timers due at t (default) or after them. */
  readonly tieOrder?: 'frames-first' | 'timers-first';
}

/** One entry of the clock's arm/cancel/fire log (the trace's `TimerEvent`). */
export interface ClockEvent {
  readonly scope: string;
  readonly action: 'arm' | 'cancel' | 'fire';
  readonly timerId: number;
  /** `arm`: the delay as the caller requested it (before clamping). */
  readonly delay: number | undefined;
  /** `arm`, `fire`: the due time in `now()` terms. */
  readonly due: number | undefined;
  /** `now()` when it happened. */
  readonly at: number;
}

/** One consumer's view: shared time, its own timer count (`pendingTimers`) and its own PRNG stream. */
export interface SimClockScope extends VirtualClock {
  readonly name: string;
  readonly root: SimClock;
}

export interface SimClock extends VirtualClock {
  readonly seed: number;
  /** The scope called `name` (created on first use; the same object afterwards). */
  scope(name: 'client' | 'router' | (string & {})): SimClockScope;
  /** Advance without draining microtasks between entries. */
  advanceSync(ms: number): void;
  /** Jump to the earliest pending entry and run every entry due then (sync). No-op when nothing is pending. */
  advanceToNextTimer(): void;
  /** Move `now()` by `ms` without moving the timer schedule (a clock jump that timers do not see). */
  skew(ms: number): void;
  /** Jump `ms` ahead (time and `now()`), then fire the overdue timers before the overdue socket deliveries. */
  suspend(ms: number): Promise<void>;
  /** An independent seeded stream for one consumer (jitter, ids, router); the same name gives the same sequence. */
  fork(name: string): () => number;
  /** Schedule a socket delivery at `now() + delay` (ordered against timers by `tieOrder`; not a timer). */
  deliverAt(delay: number, fn: () => void): void;
  readonly pendingDeliveries: number;
  /** Subscribe to the arm/cancel/fire log of every scope. Returns the unsubscribe function. */
  observe(listener: (event: ClockEvent) => void): () => void;
  /** What `observe` listeners threw (never thrown into the timer's caller). */
  readonly errors: readonly unknown[];
}

/** The largest delay a platform timer accepts; larger ones fire after 1 ms (Node, fake-timers). */
const MAX_DELAY = 2 ** 31 - 1;
/** Entries run at one instant before the clock assumes an endless loop (like Jest's 100 000 timers). */
const LOOP_LIMIT = 100000;
/** Default `runUntilIdle` limit: 10 virtual minutes. */
const IDLE_LIMIT = 600000;

/** Name of the timers armed through the root clock itself (not through a scope). */
const ROOT_SCOPE = 'default';

const SIM: unique symbol = Symbol('thruway.js.testing.simClock');

/** The SimClock behind `clock` (a SimClock, one of its scopes, or the public facade), if any. */
export function simClockOf(clock: unknown): SimClock | undefined {
  // Only linkSimClock sets the (module-private) symbol, always to a SimClock.
  return (clock as { readonly [SIM]?: SimClock } | null | undefined)?.[SIM];
}

/** Mark `target` as backed by `sim` (non-enumerable, so facades stay narrow). */
export function linkSimClock(target: object, sim: SimClock): void {
  Object.defineProperty(target, SIM, { value: sim });
}

// ---------------------------------------------------------------------------------------------------------------
// PRNG: xorshift128+ on 32-bit halves, seeded through splitmix32
// ---------------------------------------------------------------------------------------------------------------

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** xorshift128+ (Vigna), uniform in [0, 1) with 53 bits; the 128-bit state comes from splitmix32(seed), which never
 *  yields the forbidden all-zero state (its output function is a bijection, so 0 comes from one counter value only). */
export function xorshift128plus(seed: number): () => number {
  const mix = splitmix32(seed);
  let s0h = mix();
  let s0l = mix();
  let s1h = mix();
  let s1l = mix();
  return () => {
    let xh = s0h;
    let xl = s0l;
    const yh = s1h;
    const yl = s1l;
    s0h = yh;
    s0l = yl;
    xh ^= (xh << 23) | (xl >>> 9); // x ^= x << 23
    xl ^= xl << 23;
    xl ^= (xl >>> 17) | (xh << 15); // x ^= x >>> 17
    xh ^= xh >>> 17;
    xl ^= yl ^ ((yl >>> 26) | (yh << 6)); // x ^= y ^ (y >>> 26)
    xh ^= yh ^ (yh >>> 26);
    s1h = xh;
    s1l = xl;
    const lo = (s0l >>> 0) + (s1l >>> 0); // s0 + s1, 64-bit
    const hi = ((s0h >>> 0) + (s1h >>> 0) + Math.floor(lo / 2 ** 32)) >>> 0;
    return (hi * 2 ** 21 + ((lo >>> 0) >>> 11)) / 2 ** 53;
  };
}

/** FNV-1a over the UTF-16 code units of `text`. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Draining microtasks between entries
// ---------------------------------------------------------------------------------------------------------------

type Globals = Readonly<Record<string, unknown>>;

/** Faked by @sinonjs/fake-timers (vitest, Jest modern: `.clock`) or Jest's legacy mocks (`_isMockFunction`). */
function usable(fn: unknown): fn is (...args: never[]) => unknown {
  if (typeof fn !== 'function') return false;
  const marks = fn as unknown as { clock?: unknown; _isMockFunction?: unknown };
  return marks.clock === undefined && marks._isMockFunction === undefined;
}

interface PortLike {
  onmessage: unknown;
  postMessage(message: unknown): void;
  ref?: () => void;
  unref?: () => void;
}

/**
 * A macrotask boundary: every microtask queued before it has run when it resolves (an app Promise chain of any depth
 * settles). Prefers a MessageChannel (about 1 µs in Node, never faked by fake-timer libraries; its port is ref'd only
 * while a drain is pending, so it never keeps a process alive), then `setImmediate`, then `setTimeout(0)`, and falls
 * back to 64 Promise ticks when every host timer is faked.
 */
function pickDrain(g: Globals): () => Promise<void> {
  try {
    const channel = new (g['MessageChannel'] as new () => { port1: PortLike; port2: PortLike })();
    const waiting: (() => void)[] = [];
    const port = channel.port1;
    port.onmessage = () => {
      // one message per waiting drain, in order; unref'd again once nobody waits (Node; browsers have no ref/unref)
      for (const resolve of waiting.splice(0, 1)) resolve();
      if (waiting.length === 0) port.unref?.();
    };
    port.unref?.();
    return () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        port.ref?.();
        channel.port2.postMessage(0);
      });
  } catch {
    // no MessageChannel, or an unusable polyfill: try the next host primitive
  }
  const immediate = g['setImmediate'];
  if (usable(immediate)) {
    return () =>
      new Promise<void>((resolve) => {
        (immediate as (fn: () => void) => unknown)(resolve);
      });
  }
  const timeout = g['setTimeout'];
  if (usable(timeout)) {
    return () =>
      new Promise<void>((resolve) => {
        (timeout as (fn: () => void, ms: number) => unknown)(resolve, 0);
      });
  }
  return async () => {
    for (let i = 0; i < 64; i++) await Promise.resolve();
  };
}

let drainImpl: (() => Promise<void>) | undefined;

/** Resolve after every microtask queued so far (and those they queue) has run. Exported for tests. */
export function drainMicrotasks(): Promise<void> {
  const drain = drainImpl ?? pickDrain(globalThis);
  drainImpl = drain;
  return drain();
}

/** Exported for tests: the drain strategy chosen for a given set of host globals. */
export const pickDrainForTest: (g: Globals) => () => Promise<void> = pickDrain;

// ---------------------------------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------------------------------

interface ScopeState {
  readonly name: string;
  readonly timers: Map<number, Entry>;
  readonly random: () => number;
}

interface Entry {
  readonly id: number;
  /** Due on the timer schedule (which `skew` does not move). */
  readonly due: number;
  readonly tie: number;
  readonly scope: ScopeState | undefined; // undefined: a socket delivery
  readonly fn: () => void;
}

/** Queue order `(due, tie)`. Entries with equal keys keep insertion order: a new entry goes after all of them. */
function before(a: Entry, b: Entry): boolean {
  return a.due < b.due || (a.due === b.due && a.tie < b.tie);
}

/** Like fake-timers: every entry runs, then the first failure is thrown. */
function rethrowFirst(errors: readonly unknown[]): void {
  if (errors.length > 0) throw errors[0];
}

function finiteNumber(value: unknown, what: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${what} must be a finite number`);
  return value as number;
}

/** `ms` when it is a finite number ≥ 0, else the RangeError to throw or reject with. */
function duration(ms: unknown, what: string): number | RangeError {
  return Number.isFinite(ms) && (ms as number) >= 0
    ? (ms as number)
    : new RangeError(`${what} must be a finite number ≥ 0`);
}

/** `duration` for synchronous callers. */
function durationOrThrow(ms: unknown, what: string): number {
  const d = duration(ms, what);
  if (d instanceof RangeError) throw d;
  return d;
}

/** What a platform timer does with `ms` (Node / fake-timers semantics). */
function timerDelay(ms: number): number {
  if (!(ms >= 0)) return 0; // NaN, negative
  return ms > MAX_DELAY ? 1 : ms;
}

class ClockCore {
  time: number; // the timer schedule
  offset = 0; // skew: now() = time + offset
  private idCounter = 0;
  private deliveries = 0;
  private readonly queue: Entry[] = [];
  readonly scopes = new Map<string, ScopeState>();
  private readonly listeners = new Set<(event: ClockEvent) => void>();
  readonly errors: unknown[] = [];
  /** An entry's callback is on the stack (advanceSync must not nest). */
  private firing = false;
  /** Async operations (advance, runUntilIdle, suspend) run one after another. */
  private chain: Promise<void> = Promise.resolve();
  readonly frameTie: number;
  readonly timerTie: number;

  constructor(
    start: number,
    readonly seed: number,
    tieOrder: 'frames-first' | 'timers-first',
  ) {
    this.time = start;
    this.frameTie = tieOrder === 'frames-first' ? 0 : 1;
    this.timerTie = 1 - this.frameTie;
  }

  now(): number {
    return this.time + this.offset;
  }

  fork(name: string): () => number {
    return xorshift128plus(fnv1a(`${String(this.seed)}:${name}`));
  }

  /** A new scope's state (the root caches the scope objects). */
  scopeState(name: string): ScopeState {
    const state: ScopeState = { name, timers: new Map(), random: this.fork(`scope:${name}`) };
    this.scopes.set(name, state);
    return state;
  }

  observe(listener: (event: ClockEvent) => void): () => void {
    const wrapped = (event: ClockEvent): void => {
      listener(event);
    };
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }

  private emit(scope: ScopeState, action: ClockEvent['action'], entry: Entry, delay?: number): void {
    if (this.listeners.size === 0) return;
    const event: ClockEvent = {
      scope: scope.name,
      action,
      timerId: entry.id,
      delay,
      due: action === 'cancel' ? undefined : entry.due + this.offset,
      at: this.now(),
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.errors.push(error);
      }
    }
  }

  private insert(entry: Entry): void {
    const at = this.queue.findIndex((other) => before(entry, other));
    if (at < 0) this.queue.push(entry);
    else this.queue.splice(at, 0, entry);
  }

  private remove(entry: Entry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
  }

  setTimeout(scope: ScopeState, fn: unknown, ms: unknown): number {
    if (typeof fn !== 'function') throw new TypeError('setTimeout: the callback must be a function');
    const requested = Number(ms);
    const entry: Entry = {
      id: ++this.idCounter,
      due: this.time + timerDelay(requested),
      tie: this.timerTie,
      scope,
      fn: fn as () => void,
    };
    scope.timers.set(entry.id, entry);
    this.insert(entry);
    this.emit(scope, 'arm', entry, requested);
    return entry.id;
  }

  clearTimeout(scope: ScopeState, handle: unknown): void {
    const entry = scope.timers.get(handle as number);
    if (entry === undefined) return; // fired, cleared, unknown, or another scope's timer
    scope.timers.delete(entry.id);
    this.remove(entry);
    this.emit(scope, 'cancel', entry);
  }

  deliverAt(delay: unknown, fn: unknown): void {
    if (typeof fn !== 'function') throw new TypeError('deliverAt: the callback must be a function');
    const d = Number(delay);
    this.deliveries++;
    this.insert({
      id: ++this.idCounter,
      due: this.time + (d > 0 && d < Infinity ? d : 0),
      tie: this.frameTie,
      scope: undefined,
      fn: fn as () => void,
    });
  }

  pendingTimers(scope?: ScopeState): number {
    if (scope !== undefined) return scope.timers.size;
    let n = 0;
    for (const state of this.scopes.values()) n += state.timers.size;
    return n;
  }

  get pendingDeliveries(): number {
    return this.deliveries;
  }

  /** Run one entry (already removed from the queue) at its due time; a throw propagates to the caller. */
  private fire(entry: Entry): void {
    if (entry.scope !== undefined) {
      if (!entry.scope.timers.delete(entry.id)) return; // cancelled meanwhile (suspend's batch)
      this.emit(entry.scope, 'fire', entry);
    } else {
      this.deliveries--;
    }
    this.firing = true;
    try {
      entry.fn();
    } finally {
      this.firing = false;
    }
  }

  private fireCatching(entry: Entry, errors: unknown[]): void {
    try {
      this.fire(entry);
    } catch (error) {
      errors.push(error);
    }
  }

  /** The next entry to run before `target`, removed from the queue; undefined when there is none or `idle()`. */
  private next(target: number, idle: (() => boolean) | undefined, count: { n: number; at: number }): Entry | undefined {
    if (idle?.() === true) return undefined;
    const entry = this.queue[0];
    if (entry === undefined || entry.due > target) return undefined;
    const time = Math.max(this.time, entry.due);
    if (time !== count.at) {
      count.at = time;
      count.n = 0;
    }
    if (++count.n > LOOP_LIMIT) {
      throw new Error(
        `virtual clock: more than ${String(LOOP_LIMIT)} timers ran at t=${String(time + this.offset)} (a loop?)`,
      );
    }
    this.queue.shift();
    this.time = time;
    return entry;
  }

  runSync(target: number): void {
    if (this.firing) throw new Error('virtual clock: advanceSync() was called from inside a timer callback');
    const count = { n: 0, at: this.time };
    const errors: unknown[] = [];
    for (let entry = this.next(target, undefined, count); entry; entry = this.next(target, undefined, count)) {
      this.fireCatching(entry, errors);
    }
    this.time = Math.max(this.time, target);
    rethrowFirst(errors);
  }

  /** Advance to `target`, draining microtasks before and after every entry; stops early once `idle()` holds. */
  private async runAsync(target: number, idle?: () => boolean): Promise<void> {
    const count = { n: 0, at: this.time };
    const errors: unknown[] = [];
    await drainMicrotasks();
    for (let entry = this.next(target, idle, count); entry; entry = this.next(target, idle, count)) {
      this.fireCatching(entry, errors);
      await drainMicrotasks();
    }
    if (idle?.() !== true) this.time = Math.max(this.time, target);
    rethrowFirst(errors);
  }

  /** Queue an async operation behind the running one. */
  private serial(op: () => Promise<void>): Promise<void> {
    const run = this.chain.then(op);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  advance(ms: unknown): Promise<void> {
    const d = duration(ms, 'advance(ms)');
    if (d instanceof RangeError) return Promise.reject(d);
    return this.serial(() => this.runAsync(this.time + d));
  }

  runUntilIdle(limitMs: unknown, scope: ScopeState | undefined): Promise<void> {
    const limit = limitMs === undefined ? IDLE_LIMIT : duration(limitMs, 'runUntilIdle(limitMs)');
    if (limit instanceof RangeError) return Promise.reject(limit);
    const idle =
      scope === undefined ? () => this.queue.length === 0 : () => scope.timers.size === 0 && this.deliveries === 0;
    return this.serial(() => this.runAsync(this.time + limit, idle));
  }

  advanceToNextTimer(): void {
    const entry = this.queue[0];
    if (entry !== undefined) this.runSync(Math.max(entry.due, this.time));
  }

  suspend(ms: unknown): Promise<void> {
    const d = duration(ms, 'suspend(ms)');
    if (d instanceof RangeError) return Promise.reject(d);
    return this.serial(async () => {
      this.time += d;
      // The queue is sorted, so the overdue entries are its head. Timers first (the device wakes up and runs its
      // overdue callbacks), then the buffered socket events, each group in queue order.
      const head = this.queue.splice(0, this.queue.filter((entry) => entry.due <= this.time).length);
      const overdue = [...head.filter((e) => e.scope !== undefined), ...head.filter((e) => e.scope === undefined)];
      const errors: unknown[] = [];
      await drainMicrotasks();
      for (const entry of overdue) {
        this.fireCatching(entry, errors);
        await drainMicrotasks();
      }
      await this.runAsync(this.time);
      rethrowFirst(errors);
    });
  }
}

/** The `VirtualClock` methods of a scope or the root, bound to one `ScopeState` (`pendingTimers` is added by the
 *  caller: a spread would evaluate a getter once). */
function members(
  clock: ClockCore,
  state: ScopeState,
  idleScope: ScopeState | undefined,
): Omit<VirtualClock, 'pendingTimers'> {
  return {
    now: () => clock.now(),
    setTimeout: (fn: () => void, ms: number) => clock.setTimeout(state, fn, ms),
    clearTimeout: (handle: unknown) => {
      clock.clearTimeout(state, handle);
    },
    random: state.random,
    advance: (ms: number) => clock.advance(ms),
    runUntilIdle: (limitMs?: number) => clock.runUntilIdle(limitMs, idleScope),
  };
}

export function createSimClock(options: SimClockOptions = {}): SimClock {
  const start = options.start === undefined ? 0 : finiteNumber(options.start, 'start');
  const seed = options.seed === undefined ? 1 : finiteNumber(options.seed, 'seed');
  const tieOrder = options.tieOrder ?? 'frames-first';
  if (!(['frames-first', 'timers-first'] as readonly string[]).includes(tieOrder)) {
    throw new TypeError(`tieOrder must be 'frames-first' or 'timers-first'`);
  }
  const clock = new ClockCore(start, Math.trunc(seed) >>> 0, tieOrder);
  const rootState: ScopeState = { name: ROOT_SCOPE, timers: new Map(), random: xorshift128plus(clock.seed) };
  clock.scopes.set(ROOT_SCOPE, rootState);
  const scopes = new Map<string, SimClockScope>();

  const root: SimClock = {
    ...members(clock, rootState, undefined),
    get pendingTimers() {
      return clock.pendingTimers();
    },
    seed: clock.seed,
    scope(name: string): SimClockScope {
      if (typeof name !== 'string' || name === '' || name === ROOT_SCOPE) {
        throw new TypeError(`scope name must be a non-empty string other than '${ROOT_SCOPE}'`);
      }
      let scope = scopes.get(name);
      if (scope === undefined) {
        const state = clock.scopeState(name);
        scope = {
          ...members(clock, state, state),
          get pendingTimers() {
            return clock.pendingTimers(state);
          },
          name,
          root,
        };
        linkSimClock(scope, root);
        scopes.set(name, scope);
      }
      return scope;
    },
    advanceSync(ms: number): void {
      clock.runSync(clock.time + durationOrThrow(ms, 'advanceSync(ms)'));
    },
    advanceToNextTimer(): void {
      clock.advanceToNextTimer();
    },
    skew(ms: number): void {
      clock.offset += finiteNumber(ms, 'skew(ms)');
    },
    suspend: (ms: number) => clock.suspend(ms),
    fork: (name: string) => clock.fork(name),
    deliverAt(delay: number, fn: () => void): void {
      clock.deliverAt(delay, fn);
    },
    get pendingDeliveries() {
      return clock.pendingDeliveries;
    },
    observe: (listener: (event: ClockEvent) => void) => clock.observe(listener),
    errors: clock.errors,
  };
  linkSimClock(root, root);
  return root;
}
