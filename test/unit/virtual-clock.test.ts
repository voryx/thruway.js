// The virtual clock: ordering (due, insertion) and the frame/timer tie order, sync and async advancing, microtask
// draining, scopes with shared time and separate counts, skew, suspend, seeded xorshift128+ streams, and the public
// facade.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createVirtualClock } from '../../src/testing/index.js';
import {
  createSimClock,
  drainMicrotasks,
  pickDrainForTest,
  simClockOf,
  xorshift128plus,
  type ClockEvent,
} from '../../src/testing/virtual-clock.js';
import { replayParameters } from '../setup-fast-check.js';

describe('timers', () => {
  test('fire in (due, insertion) order and the clock ends at the target', async () => {
    const clock = createSimClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b@20'), 20);
    clock.setTimeout(() => fired.push('a@10'), 10);
    clock.setTimeout(() => fired.push('c@20'), 20);
    clock.setTimeout(() => fired.push('d@30'), 30);
    await clock.advance(25);
    expect(fired).toEqual(['a@10', 'b@20', 'c@20']);
    expect(clock.now()).toBe(25);
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(5);
    expect(fired).toEqual(['a@10', 'b@20', 'c@20', 'd@30']);
    expect(clock.pendingTimers).toBe(0);
  });

  test('timers armed by timers run in the same advance when due, at their own time', async () => {
    const clock = createSimClock({ start: 1000 });
    const fired: [string, number][] = [];
    clock.setTimeout(() => {
      fired.push(['outer', clock.now()]);
      clock.setTimeout(() => fired.push(['zero', clock.now()]), 0);
      clock.setTimeout(() => fired.push(['inner', clock.now()]), 5);
      clock.setTimeout(() => fired.push(['late', clock.now()]), 50);
    }, 10);
    await clock.advance(20);
    expect(fired).toEqual([
      ['outer', 1010],
      ['zero', 1010],
      ['inner', 1015],
    ]);
    expect(clock.pendingTimers).toBe(1);
  });

  test('advance(0) runs what is due now; nothing later', async () => {
    const clock = createSimClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(0), 0);
    clock.setTimeout(() => fired.push(1), 1);
    await clock.advance(0);
    expect(fired).toEqual([0]);
  });

  test('clearTimeout cancels; unknown, fired, foreign and non-number handles are ignored', async () => {
    const clock = createSimClock();
    const other = clock.scope('other');
    const fired: string[] = [];
    const a = clock.setTimeout(() => fired.push('a'), 10);
    const b = clock.setTimeout(() => fired.push('b'), 10);
    const c = other.setTimeout(() => fired.push('c'), 10);
    clock.clearTimeout(a);
    clock.clearTimeout(a);
    clock.clearTimeout(c); // another scope's timer: not this scope's to clear
    clock.clearTimeout('x');
    clock.clearTimeout(undefined);
    clock.clearTimeout(12345);
    await clock.advance(10);
    clock.clearTimeout(b); // already fired
    expect(fired).toEqual(['b', 'c']);
  });

  test('delays follow Node and fake-timers: NaN/negative ⇒ 0, above 2^31−1 ⇒ 1 ms, fractions kept', () => {
    const clock = createSimClock();
    const at: Record<string, number> = {};
    const arm = (name: string, ms: unknown): void => {
      clock.setTimeout(() => {
        at[name] = clock.now();
      }, ms as number);
    };
    arm('nan', NaN);
    arm('negative', -5);
    arm('undefined', undefined);
    arm('string', '7');
    arm('huge', 2 ** 31);
    arm('infinity', Infinity);
    arm('max', 2 ** 31 - 1);
    arm('fraction', 2.5);
    clock.advanceSync(3);
    expect(at).toEqual({ nan: 0, negative: 0, undefined: 0, huge: 1, infinity: 1, fraction: 2.5 });
    clock.advanceSync(5);
    expect(at['string']).toBe(7);
    clock.advanceSync(2 ** 31);
    expect(at['max']).toBe(2 ** 31 - 1);
  });

  test('a cancelled timer leaves the queue: idle at once, the clock does not move to its due time', async () => {
    const clock = createSimClock();
    const handle = clock.setTimeout(() => undefined, 1000);
    clock.clearTimeout(handle);
    await clock.runUntilIdle();
    expect(clock.now()).toBe(0);
    const scope = clock.scope('s');
    scope.clearTimeout(scope.setTimeout(() => undefined, 500));
    clock.advanceToNextTimer();
    expect(clock.now()).toBe(0);
  });

  test('a non-function callback throws TypeError (like Node)', () => {
    const clock = createSimClock();
    expect(() => clock.setTimeout('code' as unknown as () => void, 1)).toThrow(
      new TypeError('setTimeout: the callback must be a function'),
    );
    expect(() => {
      clock.deliverAt(1, 'code' as unknown as () => void);
    }).toThrow(new TypeError('deliverAt: the callback must be a function'));
    expect(clock.pendingTimers).toBe(0);
    expect(clock.pendingDeliveries).toBe(0);
  });

  test('handles are distinct numbers', () => {
    const clock = createSimClock();
    const handles = new Set([
      clock.setTimeout(() => 0, 1),
      clock.setTimeout(() => 0, 1),
      clock.scope('x').setTimeout(() => 0, 1),
    ]);
    expect(handles.size).toBe(3);
    for (const h of handles) expect(typeof h).toBe('number');
  });
});

/** A program of clock operations, run against the clock and against a naive model of its contract. */
type Op =
  | { readonly kind: 'arm'; readonly delay: number; readonly child: number | undefined }
  | { readonly kind: 'cancel'; readonly index: number }
  | { readonly kind: 'deliver'; readonly delay: number }
  | { readonly kind: 'advance'; readonly ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('arm' as const),
    delay: fc.integer({ min: 0, max: 50 }),
    child: fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
  }),
  fc.record({ kind: fc.constant('cancel' as const), index: fc.nat(40) }),
  fc.record({ kind: fc.constant('deliver' as const), delay: fc.integer({ min: 0, max: 50 }) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 40 }) }),
);

interface ModelEntry {
  readonly name: string;
  readonly due: number;
  readonly frame: boolean;
  readonly seq: number;
  readonly child: number | undefined;
}

/** The contract, written naively: repeatedly run the minimum (due, frames-first tie, seq) entry due by the target. */
function model(ops: readonly Op[], tieOrder: 'frames-first' | 'timers-first'): string[] {
  const fired: string[] = [];
  let now = 0;
  let seq = 0;
  const live: ModelEntry[] = [];
  const timers: (ModelEntry | undefined)[] = [];
  const rank = (e: ModelEntry): number => (e.frame === (tieOrder === 'frames-first') ? 0 : 1);
  for (const op of ops) {
    if (op.kind === 'arm') {
      const e = { name: `t${String(timers.length)}`, due: now + op.delay, frame: false, seq: ++seq, child: op.child };
      timers.push(e);
      live.push(e);
    } else if (op.kind === 'deliver') {
      live.push({ name: 'd', due: now + op.delay, frame: true, seq: ++seq, child: undefined });
    } else if (op.kind === 'cancel') {
      const e = timers[op.index];
      const i = e === undefined ? -1 : live.indexOf(e);
      if (i >= 0) live.splice(i, 1);
    } else {
      const target = now + op.ms;
      for (;;) {
        let best: ModelEntry | undefined;
        for (const e of live) {
          if (e.due > target) continue;
          if (
            best === undefined ||
            e.due < best.due ||
            (e.due === best.due && (rank(e) < rank(best) || (rank(e) === rank(best) && e.seq < best.seq)))
          )
            best = e;
        }
        if (best === undefined) break;
        live.splice(live.indexOf(best), 1);
        now = Math.max(now, best.due);
        fired.push(`${best.name}@${String(now)}`);
        if (best.child !== undefined)
          live.push({ name: `${best.name}.child`, due: now + best.child, frame: false, seq: ++seq, child: undefined });
      }
      now = target;
    }
  }
  return fired;
}

async function runOnClock(
  ops: readonly Op[],
  tieOrder: 'frames-first' | 'timers-first',
  sync: boolean,
): Promise<string[]> {
  const clock = createSimClock({ tieOrder });
  const fired: string[] = [];
  const handles: number[] = [];
  for (const op of ops) {
    if (op.kind === 'arm') {
      const name = `t${String(handles.length)}`;
      handles.push(
        clock.setTimeout(() => {
          fired.push(`${name}@${String(clock.now())}`);
          if (op.child !== undefined) {
            clock.setTimeout(() => fired.push(`${name}.child@${String(clock.now())}`), op.child);
          }
        }, op.delay) as number,
      );
    } else if (op.kind === 'deliver') {
      clock.deliverAt(op.delay, () => fired.push(`d@${String(clock.now())}`));
    } else if (op.kind === 'cancel') {
      if (handles[op.index] !== undefined) clock.clearTimeout(handles[op.index]);
    } else if (sync) {
      clock.advanceSync(op.ms);
    } else {
      await clock.advance(op.ms);
    }
  }
  return fired;
}

describe('ordering properties', () => {
  const tieOrders = fc.constantFrom('frames-first' as const, 'timers-first' as const);

  test('advanceSync runs exactly the model: (due, tie, insertion) order, children included, cancelled never', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), tieOrders, async (ops, tieOrder) => {
        expect(await runOnClock(ops, tieOrder, true)).toEqual(model(ops, tieOrder));
      }),
      replayParameters(),
    );
  });

  test('async advance runs the same entries in the same order as advanceSync', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 25 }), tieOrders, async (ops, tieOrder) => {
        expect(await runOnClock(ops, tieOrder, false)).toEqual(await runOnClock(ops, tieOrder, true));
      }),
      { ...replayParameters(), numRuns: 50 },
    );
  });

  test('pendingTimers counts exactly the timers not yet due', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 30 }),
        fc.integer({ min: 0, max: 120 }),
        (delays, ms) => {
          const clock = createSimClock();
          for (const d of delays) clock.setTimeout(() => undefined, d);
          clock.advanceSync(ms);
          expect(clock.pendingTimers).toBe(delays.filter((d) => d > ms).length);
        },
      ),
      replayParameters(),
    );
  });
});

describe('tie order', () => {
  test('frames-first (default): a delivery due at t runs before a timer due at t, whatever was scheduled first', () => {
    const clock = createSimClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('timer'), 5);
    clock.deliverAt(5, () => order.push('frame'));
    clock.advanceSync(5);
    expect(order).toEqual(['frame', 'timer']);
  });

  test('timers-first: the timer runs first', () => {
    const clock = createSimClock({ tieOrder: 'timers-first' });
    const order: string[] = [];
    clock.deliverAt(5, () => order.push('frame'));
    clock.setTimeout(() => order.push('timer'), 5);
    clock.advanceSync(5);
    expect(order).toEqual(['timer', 'frame']);
  });

  test('deliveries are not timers: not in pendingTimers, counted in pendingDeliveries; odd delays mean 0', () => {
    const clock = createSimClock();
    const at: number[] = [];
    clock.deliverAt(NaN, () => at.push(clock.now()));
    clock.deliverAt(-3, () => at.push(clock.now()));
    clock.deliverAt(Infinity, () => at.push(clock.now()));
    clock.deliverAt(2, () => at.push(clock.now()));
    expect(clock.pendingTimers).toBe(0);
    expect(clock.pendingDeliveries).toBe(4);
    clock.advanceSync(2);
    expect(at).toEqual([0, 0, 0, 2]);
    expect(clock.pendingDeliveries).toBe(0);
  });
});

describe('async advance drains microtasks', () => {
  test('a Promise chain started by a timer settles before the next timer runs', async () => {
    const clock = createSimClock();
    const log: string[] = [];
    clock.setTimeout(() => {
      log.push('t1');
      let p: Promise<void> = Promise.resolve();
      for (let i = 0; i < 300; i++) p = p.then(() => undefined);
      void p.then(() => log.push('chain settled'));
    }, 10);
    clock.setTimeout(() => log.push('t2'), 10);
    await clock.advance(10);
    expect(log).toEqual(['t1', 'chain settled', 't2']);
  });

  test('microtasks queued before advance() run before the first timer, and async functions get to arm timers', async () => {
    const clock = createSimClock();
    const log: string[] = [];
    void (async () => {
      await Promise.resolve();
      await Promise.resolve();
      log.push('app');
      clock.setTimeout(() => log.push('armed by app'), 5);
    })();
    clock.setTimeout(() => log.push('t@5'), 5);
    await clock.advance(5);
    expect(log).toEqual(['app', 't@5', 'armed by app']);
  });

  test('sync advance does not drain: a chain started by a timer is still pending afterwards', async () => {
    const clock = createSimClock();
    const log: string[] = [];
    clock.setTimeout(() => {
      void Promise.resolve().then(() => log.push('micro'));
    }, 1);
    clock.setTimeout(() => log.push('t2'), 1);
    clock.advanceSync(1);
    expect(log).toEqual(['t2']);
    await Promise.resolve();
    expect(log).toEqual(['t2', 'micro']);
  });

  test('drainMicrotasks waits for an arbitrarily deep chain', async () => {
    let settled = false;
    let p: Promise<void> = Promise.resolve();
    for (let i = 0; i < 2000; i++) p = p.then(() => undefined);
    void p.then(() => {
      settled = true;
    });
    await drainMicrotasks();
    expect(settled).toBe(true);
  });

  describe('the drain strategy follows the host', () => {
    const chain = (depth: number, done: () => void): void => {
      let p: Promise<void> = Promise.resolve();
      for (let i = 0; i < depth; i++) p = p.then(() => undefined);
      void p.then(done);
    };

    test('MessageChannel when present (its port is ref’d only while a drain waits)', async () => {
      const refs: string[] = [];
      class Channel {
        readonly port1 = {
          onmessage: undefined as unknown,
          postMessage: () => undefined,
          ref: () => refs.push('ref'),
          unref: () => refs.push('unref'),
        };
        readonly port2 = {
          onmessage: undefined,
          postMessage: () => {
            setImmediate(() => {
              (this.port1.onmessage as () => void)();
            });
          },
        };
      }
      const drain = pickDrainForTest({ MessageChannel: Channel });
      let done = false;
      chain(100, () => {
        done = true;
      });
      await drain();
      expect(done).toBe(true);
      expect(refs).toEqual(['unref', 'ref', 'unref']);
    });

    test('a MessageChannel without ref/unref (browsers) works the same', async () => {
      let posted = 0;
      class Channel {
        readonly port1 = { onmessage: undefined as unknown, postMessage: () => undefined };
        readonly port2 = {
          onmessage: undefined,
          postMessage: () => {
            posted++;
            setImmediate(() => {
              (this.port1.onmessage as () => void)();
            });
          },
        };
      }
      const drain = pickDrainForTest({ MessageChannel: Channel });
      let done = false;
      chain(10, () => {
        done = true;
      });
      await Promise.all([drain(), drain()]);
      expect([done, posted]).toEqual([true, 2]); // the channel was used, not a fallback
    });

    test('a MessageChannel that cannot be built ⇒ setImmediate', async () => {
      const calls: string[] = [];
      const drain = pickDrainForTest({
        MessageChannel: function broken() {
          throw new Error('no ports');
        },
        setImmediate: (fn: () => void) => {
          calls.push('immediate');
          setImmediate(fn);
        },
      });
      await drain();
      expect(calls).toEqual(['immediate']);
    });

    test('faked setImmediate (fake-timers `.clock`) ⇒ setTimeout', async () => {
      const calls: string[] = [];
      const fakeImmediate = Object.assign(() => calls.push('fake immediate'), { clock: {} });
      const drain = pickDrainForTest({
        setImmediate: fakeImmediate,
        setTimeout: (fn: () => void) => {
          calls.push('timeout');
          setImmediate(fn);
        },
      });
      await drain();
      expect(calls).toEqual(['timeout']);
    });

    test('no setImmediate (browsers) ⇒ setTimeout', async () => {
      const calls: string[] = [];
      const drain = pickDrainForTest({
        setTimeout: (fn: () => void, ms: number) => {
          calls.push(`timeout ${String(ms)}`);
          setImmediate(fn);
        },
      });
      await drain();
      expect(calls).toEqual(['timeout 0']);
    });

    test('two drains waiting at once each resolve; the port is unref’d only when none waits', async () => {
      const refs: string[] = [];
      const posted: (() => void)[] = [];
      class Channel {
        readonly port1 = {
          onmessage: undefined as unknown,
          postMessage: () => undefined,
          ref: () => refs.push('ref'),
          unref: () => refs.push('unref'),
        };
        readonly port2 = {
          onmessage: undefined,
          postMessage: () => {
            posted.push(() => {
              (this.port1.onmessage as () => void)();
            });
          },
        };
      }
      const drain = pickDrainForTest({ MessageChannel: Channel });
      const both = Promise.all([drain(), drain()]);
      expect(refs).toEqual(['unref', 'ref', 'ref']);
      posted[0]!();
      expect(refs).toEqual(['unref', 'ref', 'ref']);
      posted[1]!();
      await both;
      expect(refs).toEqual(['unref', 'ref', 'ref', 'unref']);
    });

    test('every host timer faked (Jest legacy `_isMockFunction` too) ⇒ 64 Promise ticks', async () => {
      const drain = pickDrainForTest({
        setImmediate: Object.assign(() => undefined, { clock: {} }),
        setTimeout: Object.assign(() => undefined, { _isMockFunction: true }),
      });
      let shallow = false;
      let deep = false;
      chain(30, () => {
        shallow = true;
      });
      chain(500, () => {
        deep = true;
      });
      await drain();
      expect(shallow).toBe(true);
      expect(deep).toBe(false);
    });
  });
});

describe('advance: arguments, serialisation, errors, loops', () => {
  test('invalid durations reject with RangeError (async) or throw (sync)', async () => {
    const clock = createSimClock();
    for (const bad of [-1, NaN, Infinity, '5', undefined]) {
      await expect(clock.advance(bad as number)).rejects.toThrow(
        new RangeError('advance(ms) must be a finite number ≥ 0'),
      );
      await expect(clock.runUntilIdle(bad === undefined ? -1 : (bad as number))).rejects.toThrow(
        new RangeError('runUntilIdle(limitMs) must be a finite number ≥ 0'),
      );
      await expect(clock.suspend(bad as number)).rejects.toThrow(
        new RangeError('suspend(ms) must be a finite number ≥ 0'),
      );
      expect(() => {
        clock.advanceSync(bad as number);
      }).toThrow(new RangeError('advanceSync(ms) must be a finite number ≥ 0'));
    }
    expect(clock.now()).toBe(0);
  });

  test('concurrent advances run one after another: two advance(10) end at 20, in call order', async () => {
    const clock = createSimClock();
    const fired: number[] = [];
    for (const t of [5, 15]) clock.setTimeout(() => fired.push(clock.now()), t);
    const a = clock.advance(10);
    const b = clock.advance(10);
    await Promise.all([a, b]);
    expect(clock.now()).toBe(20);
    expect(fired).toEqual([5, 15]);
  });

  test('a throwing timer does not stop the others; the advance rejects with the first error', async () => {
    const clock = createSimClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      throw new Error('first');
    }, 1);
    clock.setTimeout(() => {
      throw new Error('second');
    }, 2);
    clock.setTimeout(() => fired.push('third'), 3);
    await expect(clock.advance(5)).rejects.toThrow('first');
    expect(fired).toEqual(['third']);
    expect(clock.now()).toBe(5);
    // the chain survives a rejected operation
    clock.setTimeout(() => fired.push('later'), 1);
    await clock.advance(1);
    expect(fired).toEqual(['third', 'later']);
  });

  test('advanceSync rethrows the first error after running every due timer', () => {
    const clock = createSimClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      throw new Error('boom');
    }, 1);
    clock.setTimeout(() => {
      throw new Error('second');
    }, 1);
    clock.setTimeout(() => fired.push('ran'), 1);
    expect(() => {
      clock.advanceSync(1);
    }).toThrow('boom');
    expect(fired).toEqual(['ran']);
  });

  test('advanceSync from inside a timer callback throws (no nesting)', () => {
    const clock = createSimClock();
    const errors: unknown[] = [];
    clock.setTimeout(() => {
      try {
        clock.advanceSync(1);
      } catch (error) {
        errors.push(error);
      }
    }, 1);
    clock.advanceSync(1);
    expect(String(errors[0])).toMatch(/inside a timer callback/);
  });

  test('a timer re-arming itself with 0 delay is stopped after 100 000 runs at one instant', async () => {
    const clock = createSimClock();
    clock.skew(7); // the message reports now()
    let runs = 0;
    const loop = (): void => {
      runs++;
      clock.setTimeout(loop, 0);
    };
    clock.setTimeout(loop, 0);
    expect(() => {
      clock.advanceSync(0);
    }).toThrow('virtual clock: more than 100000 timers ran at t=7 (a loop?)');
    expect(runs).toBe(100000);
    // 100 000 drains (each about a microsecond) for the async variant
    await expect(clock.advance(0)).rejects.toThrow(/a loop\?/);
  });

  test('a loop that advances time is not a loop: 200 000 timers 1 ms apart all run', () => {
    const clock = createSimClock();
    let runs = 0;
    const tick = (): void => {
      if (++runs < 200000) clock.setTimeout(tick, 1);
    };
    clock.setTimeout(tick, 1);
    clock.advanceSync(200000);
    expect(runs).toBe(200000);
  });
});

describe('runUntilIdle, advanceToNextTimer', () => {
  test('runUntilIdle runs every entry, timers and deliveries, and leaves the clock at the last one', async () => {
    const clock = createSimClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      clock.deliverAt(30, () => fired.push(clock.now()));
    }, 100);
    await clock.runUntilIdle();
    expect(fired).toEqual([130]);
    expect(clock.now()).toBe(130);
    expect(clock.pendingTimers + clock.pendingDeliveries).toBe(0);
  });

  test('a periodic timer stops at the limit [10 min virtual], or at the given one', async () => {
    const clock = createSimClock();
    let ticks = 0;
    const tick = (): void => {
      ticks++;
      clock.setTimeout(tick, 1000);
    };
    clock.setTimeout(tick, 1000);
    await clock.runUntilIdle();
    expect(clock.now()).toBe(600000);
    expect(ticks).toBe(600);
    await clock.runUntilIdle(2500);
    expect(clock.now()).toBe(602500);
    expect(ticks).toBe(602);
  });

  test("a scope's runUntilIdle stops once that scope is idle and no delivery is pending", async () => {
    const clock = createSimClock();
    const client = clock.scope('client');
    const router = clock.scope('router');
    const log: string[] = [];
    router.setTimeout(() => log.push('router@5'), 5);
    router.setTimeout(() => log.push('router@500'), 500);
    client.setTimeout(() => {
      log.push('client@10');
      clock.deliverAt(20, () => log.push('frame@30'));
    }, 10);
    await client.runUntilIdle();
    expect(log).toEqual(['router@5', 'client@10', 'frame@30']);
    expect(clock.now()).toBe(30);
    expect(router.pendingTimers).toBe(1);
    await client.runUntilIdle();
    expect(clock.now()).toBe(30); // already idle: nothing moves
  });

  test('advanceToNextTimer jumps to the earliest entry and runs everything due then', () => {
    const clock = createSimClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('a'), 40);
    clock.setTimeout(() => fired.push('b'), 40);
    clock.deliverAt(70, () => fired.push('frame'));
    clock.advanceToNextTimer();
    expect(fired).toEqual(['a', 'b']);
    expect(clock.now()).toBe(40);
    clock.advanceToNextTimer();
    expect(fired).toEqual(['a', 'b', 'frame']);
    expect(clock.now()).toBe(70);
    clock.advanceToNextTimer(); // nothing pending: no-op
    expect(clock.now()).toBe(70);
  });
});

describe('scopes', () => {
  test('share time, count their own timers; the root counts every scope', async () => {
    const clock = createSimClock();
    const client = clock.scope('client');
    const router = clock.scope('router');
    expect(clock.scope('client')).toBe(client);
    expect(client.name).toBe('client');
    expect(client.root).toBe(clock);
    client.setTimeout(() => undefined, 10);
    client.setTimeout(() => undefined, 20);
    router.setTimeout(() => undefined, 10);
    clock.setTimeout(() => undefined, 10);
    expect([client.pendingTimers, router.pendingTimers, clock.pendingTimers]).toEqual([2, 1, 4]);
    await client.advance(15);
    expect(router.now()).toBe(15);
    expect(clock.now()).toBe(15);
    expect([client.pendingTimers, router.pendingTimers, clock.pendingTimers]).toEqual([1, 0, 1]);
  });

  test('scope names must be non-empty and not the root scope', () => {
    const clock = createSimClock();
    expect(() => clock.scope('')).toThrow(new TypeError("scope name must be a non-empty string other than 'default'"));
    expect(() => clock.scope('default')).toThrow(TypeError);
    expect(() => clock.scope(3 as unknown as string)).toThrow(TypeError);
  });

  test('every scope and the root lead back to the SimClock; other values do not', () => {
    const clock = createSimClock();
    expect(simClockOf(clock)).toBe(clock);
    expect(simClockOf(clock.scope('a'))).toBe(clock);
    expect(simClockOf({ deliverAt: 1 })).toBeUndefined();
    expect(simClockOf(undefined)).toBeUndefined();
    expect(simClockOf('clock')).toBeUndefined();
  });
});

describe('observe: the arm/cancel/fire log per scope', () => {
  test('records scope, timer id, the requested delay, due and time; unsubscribe stops it', () => {
    const clock = createSimClock({ start: 100 });
    const events: ClockEvent[] = [];
    const stop = clock.observe((e) => events.push(e));
    const client = clock.scope('client');
    const a = client.setTimeout(() => undefined, 2 ** 31);
    const b = clock.setTimeout(() => undefined, 5);
    client.clearTimeout(a);
    clock.advanceSync(5);
    stop();
    clock.setTimeout(() => undefined, 1);
    expect(events).toEqual([
      { scope: 'client', action: 'arm', timerId: a, delay: 2 ** 31, due: 101, at: 100 },
      { scope: 'default', action: 'arm', timerId: b, delay: 5, due: 105, at: 100 },
      { scope: 'client', action: 'cancel', timerId: a, delay: undefined, due: undefined, at: 100 },
      { scope: 'default', action: 'fire', timerId: b, delay: undefined, due: 105, at: 105 },
    ]);
  });

  test('due and at are in now() terms, also after a skew', () => {
    const clock = createSimClock();
    clock.skew(1000);
    const events: ClockEvent[] = [];
    clock.observe((e) => events.push(e));
    clock.setTimeout(() => undefined, 5);
    clock.advanceSync(5);
    expect(events.map((e) => [e.action, e.due, e.at])).toEqual([
      ['arm', 1005, 1000],
      ['fire', 1005, 1005],
    ]);
  });

  test('a throwing listener is recorded in errors and never reaches the caller; other listeners still run', () => {
    const clock = createSimClock();
    const seen: string[] = [];
    clock.observe(() => {
      throw new Error('listener');
    });
    clock.observe((e) => seen.push(e.action));
    expect(() => clock.setTimeout(() => undefined, 1)).not.toThrow();
    expect(seen).toEqual(['arm']);
    expect(clock.errors.map(String)).toEqual(['Error: listener']);
  });
});

describe('skew and suspend', () => {
  test('skew moves now() only: timers keep their schedule', async () => {
    const clock = createSimClock();
    const at: number[] = [];
    clock.setTimeout(() => at.push(clock.now()), 100);
    clock.skew(1000);
    expect(clock.now()).toBe(1000);
    await clock.advance(99);
    expect(at).toEqual([]);
    await clock.advance(1);
    expect(at).toEqual([1100]);
    clock.skew(-5000);
    expect(clock.now()).toBe(-3900);
    expect(() => {
      clock.skew(NaN);
    }).toThrow(new TypeError('skew(ms) must be a finite number'));
  });

  test('suspend fires the overdue timers before the overdue deliveries, then the rest as usual', async () => {
    const clock = createSimClock();
    const log: string[] = [];
    clock.deliverAt(10, () => log.push(`frame@${String(clock.now())}`));
    clock.setTimeout(() => log.push(`timer@${String(clock.now())}`), 20);
    clock.setTimeout(() => {
      log.push('timer2');
      void Promise.resolve().then(() => log.push('micro'));
      clock.setTimeout(() => log.push('armed while waking'), 0);
    }, 30);
    clock.setTimeout(() => log.push('future'), 5000);
    await clock.suspend(1000);
    expect(log).toEqual(['timer@1000', 'timer2', 'micro', 'frame@1000', 'armed while waking']);
    expect(clock.now()).toBe(1000);
    expect(clock.pendingTimers).toBe(1);
  });

  test('suspend: entries due exactly at the wake-up time count as overdue (timers before frames)', async () => {
    const clock = createSimClock(); // frames-first normally
    const log: string[] = [];
    clock.deliverAt(1000, () => log.push('frame'));
    clock.setTimeout(() => log.push('timer'), 1000);
    await clock.suspend(1000);
    expect(log).toEqual(['timer', 'frame']);
  });

  test('a timer cancelled by an earlier overdue timer does not fire; errors reject after the batch', async () => {
    const clock = createSimClock();
    const log: string[] = [];
    clock.setTimeout(() => {
      clock.clearTimeout(victim);
      throw new Error('waking failed');
    }, 10);
    const victim = clock.setTimeout(() => log.push('victim'), 20);
    clock.setTimeout(() => {
      throw new Error('second failure');
    }, 25);
    clock.setTimeout(() => log.push('survivor'), 30);
    clock.setTimeout(() => log.push('later'), 5000); // not overdue: cancelling `victim` must not touch it
    await expect(clock.suspend(100)).rejects.toThrow('waking failed');
    expect(log).toEqual(['survivor']);
    await clock.runUntilIdle();
    expect(log).toEqual(['survivor', 'later']);
  });
});

describe('random: seeded xorshift128+ streams', () => {
  /** The textbook 64-bit xorshift128+ on BigInt, seeded like the clock (splitmix32 words hi/lo/hi/lo). */
  function reference(seed: number): () => number {
    let a = seed | 0;
    const mix = (): bigint => {
      a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      return BigInt((t ^ (t >>> 15)) >>> 0);
    };
    const M = (1n << 64n) - 1n;
    let s0 = (mix() << 32n) | mix();
    let s1 = (mix() << 32n) | mix();
    return () => {
      let x = s0;
      const y = s1;
      s0 = y;
      x ^= (x << 23n) & M;
      x ^= x >> 17n;
      x ^= y ^ (y >> 26n);
      s1 = x;
      return Number(((s0 + s1) & M) >> 11n) / 2 ** 53;
    };
  }

  test('matches a 64-bit BigInt reference implementation', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 32 - 1 }), (seed) => {
        const ours = xorshift128plus(seed);
        const theirs = reference(seed);
        for (let i = 0; i < 50; i++) expect(ours()).toBe(theirs());
      }),
      replayParameters(),
    );
  });

  test('values are in [0, 1) and spread evenly', () => {
    const random = xorshift128plus(42);
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < 100000; i++) {
      const v = random();
      expect(v >= 0 && v < 1).toBe(true);
      sum += v;
      buckets[Math.floor(v * 10)]!++;
    }
    expect(sum / 100000).toBeCloseTo(0.5, 2);
    for (const b of buckets) expect(Math.abs(b - 10000)).toBeLessThan(500);
  });

  test('the same seed gives the same sequence; another seed another one', () => {
    const draw = (seed: number): number[] => {
      const c = createSimClock({ seed });
      return [c.random(), c.random(), c.random()];
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    expect(createSimClock().seed).toBe(1);
    expect(createSimClock({ seed: 2 ** 32 + 5 }).seed).toBe(5);
  });

  test('golden values: a seed means the same numbers in every version (replayable runs)', () => {
    const clock = createSimClock({ seed: 1 });
    expect([clock.random(), clock.random()]).toEqual([0.028203569965470132, 0.3092113088730928]);
    expect(createSimClock({ seed: 1 }).fork('ids')()).toBe(0.7553943420739718);
    expect(createSimClock({ seed: 1 }).scope('client').random()).toBe(0.6919371249116462);
    expect(createSimClock({ seed: 1 }).scope('client').random()).toBe(
      createSimClock({ seed: 1 }).fork('scope:client')(),
    );
    expect([xorshift128plus(0)(), xorshift128plus(42)()]).toEqual([0.5055970408698621, 0.3245137202537617]);
  });

  test('fork(name) and scopes are independent streams: consuming one never shifts another', () => {
    const a = createSimClock({ seed: 3 });
    const b = createSimClock({ seed: 3 });
    for (let i = 0; i < 100; i++) a.random(); // the root stream moves, the others must not
    a.scope('client').random();
    expect(a.fork('ids')()).toBe(b.fork('ids')());
    expect(a.scope('router').random()).toBe(b.scope('router').random());
    expect(a.fork('ids')()).not.toBe(a.fork('jitter')());
    expect(a.scope('client').random()).not.toBe(b.scope('client').random()); // a's client stream moved once
  });
});

describe('construction', () => {
  test('options are validated', () => {
    expect(() => createSimClock({ start: NaN })).toThrow(new TypeError('start must be a finite number'));
    expect(() => createSimClock({ seed: Infinity })).toThrow(new TypeError('seed must be a finite number'));
    expect(() => createSimClock({ tieOrder: 'random' as 'frames-first' })).toThrow(
      new TypeError("tieOrder must be 'frames-first' or 'timers-first'"),
    );
    expect(createSimClock({ start: -50 }).now()).toBe(-50);
  });
});

describe('public facade createVirtualClock', () => {
  test('exactly the VirtualClock members, frozen, working detached', async () => {
    const clock = createVirtualClock({ start: 5, seed: 9 });
    expect(Object.keys(clock).sort()).toEqual([
      'advance',
      'clearTimeout',
      'now',
      'pendingTimers',
      'random',
      'runUntilIdle',
      'setTimeout',
    ]);
    expect(Object.isFrozen(clock)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point: the facade's methods work detached
    const { now, setTimeout, clearTimeout, advance, runUntilIdle } = clock;
    const fired: number[] = [];
    setTimeout(() => fired.push(now()), 10);
    const cancelled = setTimeout(() => fired.push(-1), 10);
    clearTimeout(cancelled);
    expect(clock.pendingTimers).toBe(1);
    await advance(10);
    expect(fired).toEqual([15]);
    expect(clock.pendingTimers).toBe(0);
    setTimeout(() => fired.push(now()), 100);
    await runUntilIdle();
    expect(fired).toEqual([15, 115]);
    expect(simClockOf(clock)?.now()).toBe(115);
  });

  test('random is seeded (default seed 1) and defaults start at 0', () => {
    expect(createVirtualClock().now()).toBe(0);
    expect(createVirtualClock().random()).toBe(createSimClock({ seed: 1 }).random());
    expect(createVirtualClock({ seed: 4 }).random()).toBe(createSimClock({ seed: 4 }).random());
  });
});

// =====================================================================================================================
// skew, suspend and fork: properties
// =====================================================================================================================

/** A random schedule: timers (some arming a child), socket deliveries, cancellations. */
type Entry =
  | { readonly kind: 'timer'; readonly delay: number; readonly child: number | undefined }
  | { readonly kind: 'delivery'; readonly delay: number }
  | { readonly kind: 'cancel'; readonly index: number };

const entryArb: fc.Arbitrary<Entry> = fc.oneof(
  fc.record({
    kind: fc.constant('timer' as const),
    delay: fc.integer({ min: 0, max: 60 }),
    child: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
  }),
  fc.record({ kind: fc.constant('delivery' as const), delay: fc.integer({ min: 0, max: 60 }) }),
  fc.record({ kind: fc.constant('cancel' as const), index: fc.nat(30) }),
);

interface Run {
  readonly clock: ReturnType<typeof createSimClock>;
  /** [name, schedule time when it ran, now() when it ran] */
  readonly ran: [string, number, number][];
}

/** Schedule `entries` on a fresh clock; every callback logs its name, the schedule time (now() − skew so far) and now(). */
function schedule(
  entries: readonly Entry[],
  skewOf: () => number = () => 0,
  tieOrder: 'frames-first' | 'timers-first' = 'frames-first',
): Run {
  const clock = createSimClock({ tieOrder });
  const ran: [string, number, number][] = [];
  const log = (name: string): void => {
    ran.push([name, clock.now() - skewOf(), clock.now()]);
  };
  const handles: number[] = [];
  entries.forEach((e, i) => {
    if (e.kind === 'timer') {
      handles.push(
        clock.setTimeout(() => {
          log(`t${String(i)}`);
          if (e.child !== undefined)
            clock.setTimeout(() => {
              log(`t${String(i)}.child`);
            }, e.child);
        }, e.delay) as number,
      );
    } else if (e.kind === 'delivery') {
      clock.deliverAt(e.delay, () => {
        log(`d${String(i)}`);
      });
    } else if (handles.length > 0) {
      clock.clearTimeout(handles[e.index % handles.length]);
    }
  });
  return { clock, ran };
}

describe('skew: properties', () => {
  test('now() is the schedule time plus every skew so far; the timers run exactly as without skew', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { maxLength: 25 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: -5000, max: 5000 })), { maxLength: 6 }),
        async (entries, steps) => {
          let skewed = 0;
          const plain = schedule(entries);
          const skewedRun = schedule(entries, () => skewed);
          for (const [ms, jump] of steps) {
            await plain.clock.advance(ms);
            await skewedRun.clock.advance(ms);
            skewedRun.clock.skew(jump);
            skewed += jump;
            expect(skewedRun.clock.now()).toBe(plain.clock.now() + skewed);
          }
          await plain.clock.runUntilIdle();
          await skewedRun.clock.runUntilIdle();
          // same entries, same order, same schedule times; now() differs by the skew in force when each ran
          expect(skewedRun.ran.map(([n, t]) => [n, t])).toEqual(plain.ran.map(([n, t]) => [n, t]));
          expect(plain.clock.pendingTimers + skewedRun.clock.pendingTimers).toBe(0);
        },
      ),
      replayParameters(),
    );
  });

  test('the observe log reports due and at in now() terms, whatever the skew', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (jump, delay, wait) => {
          const clock = createSimClock();
          const events: ClockEvent[] = [];
          clock.observe((e) => events.push(e));
          clock.skew(jump);
          clock.setTimeout(() => undefined, delay);
          clock.advanceSync(Math.max(delay, wait));
          expect(events.map((e) => [e.action, e.due, e.at])).toEqual([
            ['arm', jump + delay, jump],
            ['fire', jump + delay, jump + delay],
          ]);
        },
      ),
      replayParameters(),
    );
  });
});

describe('suspend: properties', () => {
  test('runs every entry due by the wake-up time, overdue timers first, then overdue deliveries, each in queue order; children are due from the wake-up', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { maxLength: 25 }),
        fc.integer({ min: 0, max: 80 }),
        fc.constantFrom('frames-first' as const, 'timers-first' as const),
        async (entries, ms, tieOrder) => {
          const advanced = schedule(entries, undefined, tieOrder);
          const suspended = schedule(entries, undefined, tieOrder);
          await advanced.clock.advance(ms);
          await suspended.clock.suspend(ms);
          expect(suspended.clock.now()).toBe(ms);
          // the entries scheduled before: exactly the ones advance(ms) runs
          const names = (r: Run): string[] =>
            r.ran
              .map(([n]) => n)
              .filter((n) => !n.includes('.'))
              .sort();
          expect(names(suspended)).toEqual(names(advanced));
          // a child armed while waking up is due `child` ms after the wake-up (the device was asleep)
          const children = suspended.ran.filter(([n]) => n.includes('.')).map(([n]) => n);
          const expectedChildren = suspended.ran
            .filter(([n]) => !n.includes('.') && n.startsWith('t'))
            .flatMap(([n, , at]) => {
              const child = (entries[Number(n.slice(1))] as { child: number | undefined }).child;
              return child !== undefined && at + child <= ms ? [`${n}.child`] : [];
            });
          expect(children.sort()).toEqual(expectedChildren.sort());
          // the overdue batch: entries scheduled to be due ≤ ms before the suspend (children are not in it)
          const overdue = entries.flatMap((e, i) =>
            e.kind === 'cancel' || e.delay > ms ? [] : [`${e.kind === 'timer' ? 't' : 'd'}${String(i)}`],
          );
          const batch = suspended.ran.map(([n]) => n).filter((n) => overdue.includes(n));
          const firstDelivery = batch.findIndex((n) => n.startsWith('d'));
          if (firstDelivery >= 0) expect(batch.slice(firstDelivery).every((n) => n.startsWith('d'))).toBe(true);
          // within each group: by due time, then insertion
          const order = (prefix: string): string[] => batch.filter((n) => n.startsWith(prefix) && !n.includes('.'));
          for (const prefix of ['t', 'd']) {
            const due = order(prefix).map((n) => {
              const i = Number(n.slice(1));
              return [(entries[i] as { delay: number }).delay, i];
            });
            expect(due).toEqual([...due].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
          }
          // every callback of the batch saw the wake-up time
          for (const [n, , now] of suspended.ran) if (overdue.includes(n)) expect(now).toBe(ms);
        },
      ),
      replayParameters(),
    );
  });

  test('suspend(ms) after a skew still moves the schedule by exactly ms', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: 1000 }), async (jump, ms) => {
        const clock = createSimClock({ start: 50 });
        clock.skew(jump);
        let fired = 0;
        clock.setTimeout(() => fired++, ms);
        await clock.suspend(ms);
        expect([clock.now(), fired]).toEqual([50 + jump + ms, 1]);
      }),
      replayParameters(),
    );
  });
});

describe('fork: properties', () => {
  test('the same seed and name give the same stream; draws from other streams never shift it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.string({ maxLength: 12 }),
        fc.array(fc.tuple(fc.constantFrom('root', 'other', 'scope'), fc.nat(3)), { maxLength: 12 }),
        (seed, name, noise) => {
          const quiet = createSimClock({ seed }).fork(name);
          const busyClock = createSimClock({ seed });
          const busy = busyClock.fork(name);
          const other = busyClock.fork(`${name}!`);
          const scope = busyClock.scope('client');
          const expected = Array.from({ length: 8 }, () => quiet());
          const got: number[] = [];
          for (const [source, n] of noise) {
            for (let i = 0; i < n; i++) {
              if (source === 'root') busyClock.random();
              else if (source === 'other') other();
              else scope.random();
            }
            got.push(busy());
          }
          while (got.length < 8) got.push(busy());
          expect(got.slice(0, 8)).toEqual(expected);
          for (const v of expected) expect(v >= 0 && v < 1).toBe(true);
        },
      ),
      replayParameters(),
    );
  });

  test('different names (and the same name under another seed) give different streams', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.uniqueArray(fc.string({ maxLength: 8 }), { minLength: 2, maxLength: 6 }),
        (seed, names) => {
          const clock = createSimClock({ seed });
          const firsts = names.map((n) => {
            const f = clock.fork(n);
            return [f(), f(), f()].join();
          });
          expect(new Set(firsts).size).toBe(names.length);
          const again = createSimClock({ seed: (seed + 1) % 2 ** 32 }).fork(names[0]!);
          expect([again(), again(), again()].join()).not.toBe(firsts[0]);
        },
      ),
      replayParameters(),
    );
  });

  test('every scope draws from its own stream, the same per name across clocks of one seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
        const a = createSimClock({ seed });
        const b = createSimClock({ seed });
        b.scope('router').random();
        b.random();
        expect([a.scope('client').random(), a.scope('client').random()]).toEqual([
          b.scope('client').random(),
          b.scope('client').random(),
        ]);
        expect(a.scope('router').random()).not.toBe(a.scope('client').random());
      }),
      replayParameters(),
    );
  });
});
