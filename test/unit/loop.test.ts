// The event loop: its delivery rules (a step never runs app code; inputs submitted during a step run right after it;
// every queued input runs before the next delivery, and deliveries run FIFO, one at a time, never nested; an input
// submitted outside a step is processed before submit returns; a throwing delivery is reported and the next one runs;
// lifecycle observers are snapshotted at emit), the panic → lastResort chain that never escapes, the throwing logger
// case (a logger that throws on every entry: nothing escapes submit(), a WebSocket listener or a timer callback, every
// delivery still runs, the logger is called exactly once per entry and never for its own failure, console.error at most
// once per client), and the trace sink. The rules are proven on the loop itself (a scripted host) and again through the
// real client, where "app code" is every observer, onChallenge, invocation handler, url resolver and the subscribe /
// unsubscribe of every Observable the app supplied.
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import type { CoreInput } from '../../src/core/contracts.js';
import { EventLoop, type LoopHost, type TraceSink } from '../../src/core/loop.js';
import { Observable } from '../../src/observable/observable.js';
import { createSimClock, createSimRouter } from '../../src/testing/sim.js';
import type { LogEntry } from '../../src/types.js';
import { closeAndSettle, createHarness, INTERNAL_OPTIONS_KEY } from '../helpers/harness.js';

const OPEN: CoreInput = { kind: 'open' };
const RECONNECT: CoreInput = { kind: 'reconnect' };

/** A host whose step runs a script per input. */
function host(script: (input: CoreInput, loop: EventLoop, log: string[]) => void = () => undefined) {
  const log: string[] = [];
  const h: LoopHost & { loop: EventLoop } = {
    loop: undefined as unknown as EventLoop,
    step: (input) => {
      log.push(`step ${input.kind}`);
      script(input, h.loop, log);
    },
    panic: (e) => log.push(`panic ${String(e)}`),
    lastResort: (e) => log.push(`lastResort ${String(e)}`),
    reportUnhandled: (e) => log.push(`unhandled ${String(e)}`),
  };
  h.loop = new EventLoop(h);
  return { loop: h.loop, log, host: h };
}

describe('inputs submitted during a step are queued and processed right after it', () => {
  test('FIFO, after the current step finishes', () => {
    const { loop, log } = host((input, l, out) => {
      if (input.kind === 'open') {
        l.submit(RECONNECT);
        l.submit({ kind: 'close', resolve: () => undefined });
        out.push('open done');
      }
    });
    loop.submit(OPEN);
    expect(log).toEqual(['step open', 'open done', 'step reconnect', 'step close']);
  });
});

describe('every queued input before the next delivery; deliveries FIFO, one at a time, never nested', () => {
  test('a delivery that submits runs that input to completion before the next delivery', () => {
    const { loop, log } = host((input, l, out) => {
      if (input.kind === 'open') {
        l.deliver(() => {
          out.push('d1 start');
          l.submit(RECONNECT); // a submit from a delivery (no step runs): processed now, its deliveries queued behind d2
          out.push('d1 end');
        });
        l.deliver(() => out.push('d2'));
      }
      if (input.kind === 'reconnect') l.deliver(() => out.push('d3'));
    });
    loop.submit(OPEN);
    expect(log).toEqual(['step open', 'd1 start', 'step reconnect', 'd1 end', 'd2', 'd3']);
  });

  test('a long burst of deliveries runs in order (the queue compacts as it goes)', () => {
    const seen: number[] = [];
    const { loop } = host((input, l) => {
      if (input.kind === 'open') for (let i = 0; i < 5000; i++) l.deliver(() => seen.push(i));
    });
    loop.submit(OPEN);
    expect(seen).toHaveLength(5000);
    expect(seen.every((v, i) => v === i)).toBe(true);
    expect(loop.sizes()).toEqual({ inputs: 0, deliveries: 0 });
  });

  test('sizes() reports what is queued while a step runs; inStep tells whether one is on the stack', () => {
    let during: unknown;
    let inStep = false;
    const { loop } = host((input, l) => {
      if (input.kind !== 'open') return;
      l.submit(RECONNECT);
      l.deliver(() => undefined);
      during = l.sizes();
      inStep = l.inStep;
    });
    expect(loop.inStep).toBe(false);
    loop.submit(OPEN);
    expect(during).toEqual({ inputs: 1, deliveries: 1 });
    expect(inStep).toBe(true);
  });
});

describe('an input submitted while no step runs is processed before submit returns', () => {
  test('with its deliveries, from outside the loop', () => {
    const { loop, log } = host((input, l, out) => {
      l.deliver(() => out.push(`delivered ${input.kind}`));
    });
    loop.submit(OPEN);
    log.push('returned');
    expect(log).toEqual(['step open', 'delivered open', 'returned']);
  });
});

describe('a delivery that throws is reported; the next one runs', () => {
  test('reportUnhandled gets the error, and even a throwing reportUnhandled escapes nothing', () => {
    const {
      loop,
      log,
      host: h,
    } = host((input, l) => {
      l.deliver(() => {
        throw new Error('observer bug');
      });
      l.deliver(() => log.push('second'));
    });
    loop.submit(OPEN);
    expect(log).toEqual(['step open', 'unhandled Error: observer bug', 'second']);
    h.reportUnhandled = () => {
      throw new Error('report bug');
    };
    expect(() => {
      loop.submit(OPEN);
    }).not.toThrow();
    expect(log.at(-1)).toBe('second');
  });
});

describe('a throw out of a step never escapes', () => {
  test('step throws ⇒ panic; panic throws ⇒ lastResort; lastResort throws ⇒ swallowed; the loop keeps draining', () => {
    const {
      loop,
      log,
      host: h,
    } = host((input) => {
      if (input.kind === 'open') throw new Error('bug');
    });
    loop.submit(OPEN);
    expect(log).toEqual(['step open', 'panic Error: bug']);
    h.panic = () => {
      throw new Error('panic bug');
    };
    loop.submit(OPEN);
    expect(log.slice(2)).toEqual(['step open', 'lastResort Error: panic bug']);
    h.lastResort = () => {
      throw new Error('last bug');
    };
    loop.submit(OPEN);
    loop.submit(RECONNECT);
    expect(log.slice(4)).toEqual(['step open', 'step reconnect']);
  });

  test('a step that throws after queueing inputs: those inputs still run', () => {
    const { loop, log } = host((input, l) => {
      if (input.kind === 'open') {
        l.submit(RECONNECT);
        throw new Error('bug');
      }
    });
    loop.submit(OPEN);
    expect(log).toEqual(['step open', 'panic Error: bug', 'step reconnect']);
  });
});

describe('the trace sink (test/helpers/trace.ts)', () => {
  test('steps and deliveries are reported with ids; a throwing sink changes nothing', () => {
    const events: string[] = [];
    const sink: TraceSink = {
      stepStart: (id, input) => events.push(`start ${String(id)} ${input.kind}`),
      stepEnd: (id) => events.push(`end ${String(id)}`),
      deliveryQueued: (id, step) => events.push(`queued ${String(id)} by ${String(step)}`),
      deliveryStart: (id) => events.push(`run ${String(id)}`),
      deliveryEnd: (id) => events.push(`done ${String(id)}`),
    };
    const h: LoopHost = {
      step: () => {
        loop.deliver(() => undefined);
      },
      panic: () => undefined,
      lastResort: () => undefined,
      reportUnhandled: () => undefined,
    };
    const loop = new EventLoop(h, sink);
    loop.submit(OPEN);
    expect(events).toEqual(['start 1 open', 'queued 1 by 1', 'end 1', 'run 1', 'done 1']);
    const throwing = new EventLoop(h, {
      stepStart: () => {
        throw new Error('sink');
      },
      stepEnd: () => {
        throw new Error('sink');
      },
      deliveryQueued: () => {
        throw new Error('sink');
      },
      deliveryStart: () => {
        throw new Error('sink');
      },
      deliveryEnd: () => {
        throw new Error('sink');
      },
    });
    expect(() => {
      throwing.submit(OPEN);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the real client
// ---------------------------------------------------------------------------------------------------------------------

describe('through the client: a step never runs app code', () => {
  test('observers, onChallenge, handlers, the url resolver and app Observables run only in deliveries', async () => {
    let stepping = 0;
    const steps: TraceSink = {
      stepStart: () => {
        stepping++;
      },
      stepEnd: () => {
        stepping--;
      },
      deliveryQueued: () => undefined,
      deliveryStart: () => undefined,
      deliveryEnd: () => undefined,
    };
    const violations: string[] = [];
    const app = (what: string): void => {
      if (stepping > 0) violations.push(what);
    };
    const clock = createSimClock({ seed: 4 });
    const router = createSimRouter({
      clock: clock.scope('router'),
      authenticate: () => ({
        challenge: { method: 'ticket' },
        verify: () => ({ welcome: { authid: 'joe', authmethod: 'ticket' } }),
      }),
    });
    router.procedure('com.example.p', () => 1);
    router.procedure('com.example.q', () => 1);
    router.declareTopic('com.example.t');
    const appObservable = <T>(value: T, name: string) =>
      new Observable<T>((subscriber) => {
        app(`${name} subscribe`);
        subscriber.next(value);
        subscriber.complete();
        return () => {
          app(`${name} teardown`);
        };
      });
    const client = new Client(
      () => {
        app('url resolver');
        return appObservable(router.url, 'url');
      },
      'realm1',
      {
        WebSocket: router.WebSocket,
        clock: clock.scope('client'),
        timeouts: { idle: 0 },
        authmethods: ['ticket'],
        onChallenge: () => {
          app('onChallenge');
          return appObservable('secret', 'challenge answer');
        },
        logger: () => undefined,
        [INTERNAL_OPTIONS_KEY]: { trace: steps },
      },
    );
    const c = { client };
    const observer = (name: string) => ({
      next: () => {
        app(`${name} next`);
      },
      error: () => {
        app(`${name} error`);
      },
      complete: () => {
        app(`${name} complete`);
      },
    });
    c.client.status.subscribe(observer('status'));
    c.client.onOpen.subscribe(observer('onOpen'));
    c.client.onClose.subscribe(observer('onClose'));
    c.client.call('com.example.p').subscribe(observer('call'));
    c.client.topic('com.example.t').subscribe(observer('topic'));
    c.client
      .register('com.example.r', () => {
        app('handler');
        return appObservable(2, 'handler result');
      })
      .subscribe(observer('register'));
    await clock.advance(20);
    // the client calls itself, so its own handler runs
    c.client.call('com.example.r').subscribe(observer('own call'));
    router.publish('com.example.t', [1]);
    await clock.advance(20);
    router.drop();
    await clock.advance(5000);
    expect(violations).toEqual([]);
    expect(stepping).toBe(0);
    await closeAndSettle(client, clock);
  });
});

describe('through the client: a submit outside a step is processed before it returns', () => {
  test('subscribe() inside a callback writes its CALL before it returns', async () => {
    const h = createHarness({ seed: 4 });
    h.router.procedure('com.example.p', () => 1);
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    let written = -1;
    c.client.onOpen.subscribe(() => {
      c.client.call('com.example.p').subscribe(() => undefined);
      written = h.router.frames.filter((f) => f.direction === 'in' && (f.frame as unknown[])[0] === 48).length;
    });
    await h.clock.advance(10);
    expect(written).toBe(1);
    await h.finish();
  });

  test('close() from an onClose observer is a plain idempotent call; the session getter tracks the state at once', async () => {
    const h = createHarness({ seed: 4 });
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const sessions: unknown[] = [];
    c.client.onClose.subscribe(() => {
      void c.client.close();
      sessions.push(c.client.session);
    });
    await h.clock.advance(10);
    expect(c.client.session).toBeDefined();
    h.router.drop();
    await h.clock.advance(10);
    expect(sessions).toEqual([undefined, undefined]); // the drop's onClose, then close()'s own
    expect(c.status?.values.at(-1)).toMatchObject({ state: 'closed', closed: { initiator: 'app' } });
    await h.finish();
  });
});

describe('through the client: a logger that throws on every entry (InjectFault(logger, always))', () => {
  test('nothing escapes, every delivery runs, one entry = one logger call, one console.error per client', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const h = createHarness({ seed: 6, checks: { internalLogs: false } });
      h.router.procedure('com.example.p', () => 7);
      let calls = 0;
      const entries: LogEntry[] = [];
      const c = h.makeClient(Client, {
        options: {
          timeouts: { idle: 500 },
          logger: (entry) => {
            calls++;
            entries.push(entry);
            throw new Error('logger down');
          },
        },
      });
      const call = c.observe('call', 'com.example.p', c.client.call('com.example.p'), {
        next: () => {
          throw new Error('observer bug'); // reported through the throwing logger: swallowed
        },
      });
      await h.clock.advance(2000); // frames, a probe, an unhandled report
      h.router.drop(); // a WebSocket listener path
      await h.clock.advance(5000); // timer paths
      expect(call.completed).toBe(true);
      expect(c.status?.values.at(-1)).toMatchObject({ state: 'open' });
      expect(calls).toBe(entries.length);
      expect(entries.some((e) => e.event === 'unhandled')).toBe(true);
      expect(entries.some((e) => e.message.includes('logger'))).toBe(false); // never logged about itself
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.[0]).toBe('thruway.js: logger threw');
      await h.finish();
      const second = h.makeClient(Client, {
        options: {
          logger: () => {
            throw new Error('also down');
          },
        },
      });
      await h.clock.advance(10);
      expect(consoleError).toHaveBeenCalledTimes(2); // once per client
      await second.settle();
    } finally {
      consoleError.mockRestore();
    }
  });

  test('the faults hook: logger faults are swallowed by safeLog and cause no hardReset', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const h = createHarness({ seed: 6 });
      const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
      (c.faults as { inject(t: string, m: string): void }).inject('logger', 'always');
      await h.clock.advance(10);
      h.router.drop();
      await h.clock.advance(5000);
      expect(c.status?.values.map((s) => s.state)).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
      (c.faults as { clear(): void }).clear();
      await h.finish(); // no internal entry: no hardReset happened
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('through the client: lifecycle observers are snapshotted when an event is emitted', () => {
  test('a late subscriber gets only the replay; one removed before its delivery gets nothing; each event once', async () => {
    const h = createHarness({ seed: 4 });
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } }, lifecycle: false });
    const first: string[] = [];
    const late: string[] = [];
    const removed: string[] = [];
    const subscriptionHolder: { unsubscribe?: () => void } = {};
    c.client.status.subscribe((s) => {
      first.push(s.state);
      if (s.state === 'open' && late.length === 0) {
        // inside a delivery: a new subscriber gets the replay (open) synchronously, then only later events
        c.client.status.subscribe((x) => late.push(x.state));
        subscriptionHolder.unsubscribe?.();
      }
    });
    const sub = c.client.status.subscribe((s) => removed.push(s.state));
    subscriptionHolder.unsubscribe = () => {
      sub.unsubscribe();
    };
    await h.clock.advance(10);
    h.router.drop();
    await h.clock.advance(5000);
    expect(first).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
    expect(late).toEqual(['open', 'closed', 'connecting', 'open']);
    expect(removed).toEqual(['connecting']); // removed (by the first observer) before the 'open' reached it
    await h.finish();
  });
});
