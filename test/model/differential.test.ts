// The differential properties of the model suite:
// - INV-R3: one environment (router, socket and time commands, lifecycle calls) run twice from the same seed, once
//   with app-stream noise interleaved — subscriptions, calls, publishes, registrations, unsubscribes, bad arguments,
//   app answers that complete or error, throwing observers — and once without: the per-end sequence (initiator,
//   reason, willRetry, attempt, delay, error) is the same, and no end has an app-stream cause. Run with `idle: 0`
//   (probes would follow the traffic) and `requestIds: 'sequential'`; jitter comes from the client's own PRNG stream,
//   which no app stream draws from.
// - INV-R8: the same command list run twice, the second time with observers that throw (op and interest observers,
//   and in half the runs the first of two observers of each lifecycle stream): every other observer sees
//   exactly the same notifications.
// Left out of these runs (the main model covers them): the wamp-server dialect, which answers a CANCEL with GOODBYE (an
// app stream does end its session there, by design of that router); a closing window, during which an app write is
// refused and the connection ends at once by design ("Write refused" in test/sim/matrix.test.ts) — app traffic decides
// when a dying socket's end is noticed, not whether; injected internal faults and re-entrant lifecycle calls, which
// depend on what the app does; and the environment commands whose effect is relative to what is pending —
// AdvanceToNextTimer (an app stream's request timer is the next timer), Flush(n) under manual delivery (app frames are
// queued too) and Freeze(buffer, …) in INV-R3 (a held frame is dropped by a later drop freeze only if another frame —
// app traffic — arrives before the thaw).
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { CallParticipant } from '../../src/ops/call.js';
import { compareR3, compareR8, checkR3, endSequence } from '../helpers/invariants.js';
import type { Trace } from '../helpers/trace-types.js';
import { replayParameters } from '../setup-fast-check.js';
import { commandArb, type ModelCommand } from './commands.js';
import { configArb, World, type ModelConfig } from './model.js';

const RUNS = Number(process.env['FC_NUM_RUNS'] ?? 100);
const TIMEOUT = Math.max(120000, RUNS * 600);

const NOISE = [
  'Call(',
  'Topic(',
  'Publish(',
  'Register(',
  'Unsubscribe(',
  'Resubscribe(',
  'BadArgument(',
  'ThrowingObserver(',
  'Resolve(',
  'Reject(',
  'Next(',
  'Complete(',
  'Lifecycle',
];
const LEFT_OUT = [
  'InjectFault(',
  'Reentrant(',
  'Peer',
  'SecondClient',
  'ClosingWindow(',
  // relative to what is pending: an app stream's own timer (a request timeout) or frame (manual delivery) moves them
  'AdvanceToNextTimer',
  'Flush(',
];
/** Left out of INV-R3 only (throwing observers change no traffic, so INV-R8 keeps them). */
const R3_OUT = ['Freeze(buffer'];

function kindOf(command: ModelCommand): 'noise' | 'base' | 'out' {
  const label = command.toString();
  if (LEFT_OUT.some((p) => label.startsWith(p))) return 'out';
  return NOISE.some((p) => label.startsWith(p)) ? 'noise' : 'base';
}

const config = configArb()
  .filter((cfg) => cfg.dialect !== 'wamp-server')
  .map((cfg): ModelConfig => ({
    ...cfg,
    requestIds: 'sequential',
    timeouts: { ...cfg.timeouts, idle: 0 },
    peer: false,
    traffic: false,
    strict: false,
    // the url resolver and onChallenge are connection hooks, not app streams: their answers end attempts by design,
    // so the noise's app answers are handler results only
    url: 'string',
    auth: 'none',
  }));

/** Run `commands` on a fresh world of `cfg`; app answers are released after every command (no interleaving here). */
async function run(
  cfg: ModelConfig,
  commands: readonly ModelCommand[],
  prelude?: (world: World) => void,
): Promise<Trace> {
  const s = fc.sample(fc.scheduler(), { numRuns: 1, seed: cfg.seed })[0]!;
  const world = new World(cfg, s);
  try {
    await world.warmUp();
    prelude?.(world);
    for (const command of commands) {
      if (!command.check(world)) continue;
      await command.run(world, world);
      await s.waitIdle();
    }
    await world.finish();
    return world.c.trace();
  } finally {
    world.dispose();
  }
}

/** INV-R3 as a property: the ends with the noise interleaved equal the ends without it. */
function r3Property(): fc.IAsyncPropertyWithHooks<[[ModelConfig, ModelCommand[], [number, ModelCommand][]]]> {
  return fc.asyncProperty(
    config.chain((cfg) => {
      const any = commandArb(cfg);
      return fc.tuple(
        fc.constant(cfg),
        fc.array(
          any.filter((c) => kindOf(c) === 'base' && !R3_OUT.some((p) => c.toString().startsWith(p))),
          { maxLength: 30, size: 'max' },
        ),
        fc.array(
          fc.tuple(
            fc.nat(30),
            any.filter((c) => kindOf(c) === 'noise'),
          ),
          { maxLength: 30, size: 'max' },
        ),
      );
    }),
    async ([cfg, base, noise]) => {
      const quiet = await run(cfg, base);
      const mixed: ModelCommand[] = [];
      base.forEach((command, i) => {
        for (const [at, extra] of noise) if (at % (base.length + 1) === i) mixed.push(extra);
        mixed.push(command);
      });
      for (const [at, extra] of noise) if (at % (base.length + 1) === base.length) mixed.push(extra);
      const noisy = await run(cfg, mixed);
      const found = [...compareR3(noisy, quiet), ...checkR3(noisy, {})];
      expect(found, `${JSON.stringify(endSequence(quiet))}\nvs\n${JSON.stringify(endSequence(noisy))}`).toEqual([]);
    },
  );
}

describe('differential (INV-R3, INV-R8)', () => {
  test(
    'INV-R3: app-stream noise never changes the ends',
    async () => {
      await fc.assert(r3Property(), { ...replayParameters() });
    },
    TIMEOUT,
  );

  test(
    'INV-R3 catches a client whose unsubscribe of a call can reset it (CallParticipant.stop throws)',
    async () => {
      const stop = Object.getOwnPropertyDescriptor(CallParticipant.prototype, 'stop');
      Object.defineProperty(CallParticipant.prototype, 'stop', {
        configurable: true,
        value() {
          throw new Error('broken stop');
        },
      });
      try {
        const result = await fc.check(r3Property(), { numRuns: 200, seed: 1 });
        expect(result.failed, 'not caught').toBe(true);
      } finally {
        if (stop !== undefined) Object.defineProperty(CallParticipant.prototype, 'stop', stop);
      }
    },
    TIMEOUT,
  );

  test(
    'INV-R8: throwing observers change no other observer’s notifications',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          config.chain((cfg) => {
            const any = commandArb(cfg);
            return fc.tuple(
              fc.constant(cfg),
              fc.array(
                any.filter((c) => kindOf(c) !== 'out' && !c.toString().startsWith('ThrowingObserver(')),
                { maxLength: 40, size: 'max' },
              ),
              fc.uniqueArray(fc.nat(6), { maxLength: 3 }),
              fc.boolean(),
            );
          }),
          async ([cfg, commands, throwing, lifecycleThrows]) => {
            const plain = await run(cfg, commands, pairs);
            // the same run, with observers of the first handles throwing from their first notification on
            const s = fc.sample(fc.scheduler(), { numRuns: 1, seed: cfg.seed })[0]!;
            const world = new World(cfg, s);
            const names = new Set<string>();
            try {
              await world.warmUp();
              pairs(world);
              // lifecycle observers too: one subject delivers to all of its observers; the first of each pair
              // throws, the second must still see everything
              world.lifecycles.forEach((l, i) => {
                if (!lifecycleThrows || i % 2 !== 0) return;
                world.throwingLifecycles.add(i);
                names.add(`${l.stream}:undefined#${String(nth(world, l.stream, undefined, l.rec.id))}`);
              });
              for (const command of commands) {
                if (!command.check(world)) continue;
                const before = world.handles.length;
                await command.run(world, world);
                for (const handle of world.handles.slice(before)) {
                  if (!throwing.includes(handle.n)) continue;
                  world.throwing.add(handle.n);
                  for (const sub of handle.subs)
                    names.add(
                      `${handle.stream}:${handle.uri}#${String(nth(world, handle.stream, handle.uri, sub.id))}`,
                    );
                }
                await s.waitIdle();
              }
              await world.finish();
            } finally {
              world.dispose();
            }
            // a re-subscription of a throwing handle throws too
            for (const handle of world.handles) {
              if (!world.throwing.has(handle.n)) continue;
              for (const sub of handle.subs)
                names.add(`${handle.stream}:${handle.uri}#${String(nth(world, handle.stream, handle.uri, sub.id))}`);
            }
            expect(compareR8(world.c.trace(), plain, names)).toEqual([]);
          },
        ),
        { ...replayParameters() },
      );
    },
    TIMEOUT,
  );
});

/** Two observers of each lifecycle stream, subscribed right after the warm-up (INV-R8). */
function pairs(world: World): void {
  for (const stream of ['status', 'onOpen', 'onClose'] as const) {
    world.lifecycle(world.c, stream);
    world.lifecycle(world.c, stream);
  }
}

/** The position of observer `id` among the observers of its stream and uri (compareR8 names them `stream:uri#n`). */
function nth(world: World, stream: string, uri: string | undefined, id: number): number {
  const observers = world.c
    .trace()
    .observers.filter((o) => o.action === 'subscribe' && o.stream === stream && o.uri === uri);
  return observers.findIndex((o) => o.observer === id) + 1;
}
