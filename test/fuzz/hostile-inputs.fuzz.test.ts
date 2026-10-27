// Hostile app inputs: Proxies that throw on get/has/ownKeys, revoked Proxies, cyclic options and args, BigInt and
// Symbol values, throwing toJSON, thenables whose `then` getter throws, objects whose `subscribe` returns undefined or
// throws, throwing getters — as call/publish/topic/register arguments, handler results, challenge answers and URL
// results. Properties: no `internal` log entry (nothing reached the core as a client bug), nothing reached the host,
// the connection is never ended by an op-level input (only the record that received it errors, or its caller gets an
// ERROR), a registration whose handler returned one keeps serving, and a hostile challenge or URL answer ends exactly
// that attempt (cannot_authenticate / url resolution failed), after which the client reconnects normally. Every INV-*
// checker holds over the run.
// The router is the reference router's Thruway PHP dialect (random testing runs on the first-class router only).
import { fc } from '@fast-check/vitest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { checkInvariants, formatViolations, registerKey, topicKey, type OpInfo } from '../helpers/invariants.js';
import type { ObserverId } from '../helpers/trace-types.js';
import { replayParameters } from '../setup-fast-check.js';

vi.setConfig({ testTimeout: Math.max(30000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 60) });

const escaped: unknown[] = [];
const onEscape = (error: unknown): void => {
  escaped.push(error);
};
beforeAll(() => {
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
});
afterAll(() => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
});

// --- hostile values -----------------------------------------------------------------------------------------------

const boom = (): never => {
  throw new Error('hostile');
};

/** Fresh hostile values (built per use: revoked Proxies, cycles and stateful thenables must not be shared). */
const HOSTILE: Readonly<Record<string, () => unknown>> = {
  'throwing Proxy': () =>
    new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom }),
  'throwing array Proxy': () => new Proxy([1, 2], { get: boom, has: boom, ownKeys: boom }),
  'revoked Proxy': () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  },
  'cyclic object': () => {
    const o: Record<string, unknown> = { a: 1 };
    o['self'] = o;
    return o;
  },
  'cyclic array': () => {
    const a: unknown[] = [1];
    a.push(a);
    return a;
  },
  BigInt: () => 10n,
  'BigInt inside': () => [1, { n: 2n }],
  Symbol: () => Symbol('x'),
  'Symbol key': () => ({ [Symbol('k')]: 1, ok: 2 }),
  'throwing toJSON': () => ({ toJSON: boom }),
  'throwing getter': () =>
    Object.defineProperty({}, 'x', {
      enumerable: true,
      get: boom,
    }),
  'array with a throwing getter': () => {
    const a: unknown[] = [];
    Object.defineProperty(a, 0, { enumerable: true, get: boom });
    return a;
  },
  'thenable whose then getter throws': () => Object.defineProperty({}, 'then', { get: boom }),
  'thenable whose then throws': () => ({ then: boom }),
  'thenable that never settles': () => ({ then: () => undefined }),
  'subscribe returning undefined': () => ({ subscribe: () => undefined }),
  'subscribe throwing': () => ({ subscribe: boom }),
  'subscribe emitting then throwing teardown': () => ({
    subscribe(o: { next(v: unknown): void; complete(): void }) {
      o.next('v');
      o.complete();
      return { unsubscribe: boom };
    },
  }),
  'interop key throwing': () => ({ [Symbol.observable]: boom, '@@observable': boom }),
  function: () => () => 1,
  Date: () => new Date(0),
  Map: () => new Map([[1, 2]]),
  'typed array': () => new Uint8Array([1, 2]),
  NaN: () => Number.NaN,
  null: () => null,
  'deep nesting': () => {
    let v: unknown = 1;
    for (let i = 0; i < 2000; i++) v = [v];
    return v;
  },
};
const NAMES = Object.keys(HOSTILE);
/** Inputs that never settle: an answer the app never gives (the handshake waits for it by design). */
const NEVER_SETTLES = new Set(['thenable that never settles', 'subscribe returning undefined']);
/** What a hostile value may throw at the client (a serializer's TypeError on a cycle or a BigInt, a getter's throw):
 *  delivered to the record that received it, a deliberate invalid input for INV-R6. */
const deliberate = (e: unknown): boolean =>
  e instanceof TypeError || e instanceof RangeError || (e instanceof Error && e.message === 'hostile');
const hostile = fc.constantFrom(...NAMES);
const make = (name: string): unknown => (HOSTILE[name] as () => unknown)();

type Place =
  | 'call procedure'
  | 'call args'
  | 'call kwargs'
  | 'call options'
  | 'publish topic'
  | 'publish args'
  | 'publish kwargs'
  | 'publish options'
  | 'topic name'
  | 'topic options'
  | 'register procedure'
  | 'register options'
  | 'handler result'
  | 'handler throws';

const PLACES: readonly Place[] = [
  'call procedure',
  'call args',
  'call kwargs',
  'call options',
  'publish topic',
  'publish args',
  'publish kwargs',
  'publish options',
  'topic name',
  'topic options',
  'register procedure',
  'register options',
  'handler result',
  'handler throws',
];

// --- the runs -----------------------------------------------------------------------------------------------------

interface Run {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly peer: SimClient<Client>;
  /** The key of an interest whose options are the hostile value (the checkers cannot read it from the trace). */
  readonly ops: Map<ObserverId, OpInfo>;
}

async function start(seed: number): Promise<Run> {
  const h = createHarness({ seed, router: { dialect: 'thruway-php' }, checks: { unscripted: false } });
  h.router.declareTopic('hi.t');
  h.router.procedure('hi.ok', (args) => args[0] ?? 'ok');
  const c = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 } } });
  const peer = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 } } });
  c.open();
  peer.open();
  await h.clock.advance(0);
  return { h, c, peer, ops: new Map() };
}

/** The connection works and nothing ended: a sentinel topic gets an EVENT, a sentinel call is answered. */
async function sentinel(run: Run, ends: number): Promise<void> {
  const { h, c } = run;
  expect(c.trace().closeInfos.length, 'an op-level input never ends the connection').toBe(ends);
  const t = c.observe('topic', 'hi.t', c.client.topic('hi.t'));
  await h.clock.advance(0);
  h.router.publish('hi.t', ['ping']);
  const call = c.observe('call', 'hi.ok', c.client.call('hi.ok', ['x']));
  await h.clock.advance(5);
  expect(t.values, 'the sentinel topic still gets events').toHaveLength(1);
  expect(call.values, 'a sentinel call is still answered').toHaveLength(1);
  t.unsubscribe();
}

async function finish(run: Run): Promise<void> {
  await run.h.closeAndSettle();
  for (const client of [run.c, run.peer]) {
    const trace = client.trace();
    const found = checkInvariants(trace, {
      timings: { idle: 0 },
      final: true,
      exempt: deliberate,
      ...(client === run.c ? { ops: run.ops } : {}),
    });
    expect(found, formatViolations(found, trace)).toEqual([]);
    expect(
      trace.logs.filter((l) => l.entry.event === 'internal').map((l) => l.entry.message),
      'internal',
    ).toEqual([]);
  }
  expect(
    run.h.problems().filter((p) => !p.startsWith('unscripted')),
    'the harness checks',
  ).toEqual([]);
  expect(escaped).toEqual([]);
}

describe('hostile app inputs', () => {
  test('as op and interest arguments and as handler results: only that record is affected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.constantFrom(...PLACES),
        hostile,
        async (seed, place, name) => {
          const run = await start(seed);
          const { h, c, peer } = run;
          const ends = c.trace().closeInfos.length;
          const value = make(name);
          const cc = c.client;
          switch (place) {
            case 'call procedure':
              c.observe('call', 'x', cc.call(value as never));
              break;
            case 'call args':
              c.observe('call', 'hi.ok', cc.call('hi.ok', value as never));
              break;
            case 'call kwargs':
              c.observe('call', 'hi.ok', cc.call('hi.ok', [], value as never));
              break;
            case 'call options':
              c.observe('call', 'hi.ok', cc.call('hi.ok', [], {}, value as never));
              break;
            case 'publish topic':
              c.observe('publish', 'x', cc.publish(value as never, []));
              break;
            case 'publish args':
              c.observe('publish', 'hi.t', cc.publish('hi.t', value as never));
              break;
            case 'publish kwargs':
              c.observe('publish', 'hi.t', cc.publish('hi.t', [], value as never));
              break;
            case 'publish options':
              c.observe('publish', 'hi.t', cc.publish('hi.t', [], {}, value as never));
              break;
            case 'topic name':
              c.observe('topic', 'x', cc.topic(value as never));
              break;
            case 'topic options': {
              const o = c.observe('topic', 'hi.t', cc.topic('hi.t', value as never));
              run.ops.set(o.id, { kind: 'topic', key: topicKey('hi.t', make(name)) });
              break;
            }
            case 'register procedure':
              c.observe(
                'register',
                'x',
                cc.register(value as never, () => 1),
              );
              break;
            case 'register options': {
              const o = c.observe(
                'register',
                'hi.r',
                cc.register('hi.r', () => 1, value as never),
              );
              run.ops.set(o.id, { kind: 'register', key: registerKey('hi.r', make(name)) });
              break;
            }
            case 'handler result':
            case 'handler throws': {
              const reg = c.observe(
                'register',
                'hi.r',
                cc.register('hi.r', () => {
                  if (place === 'handler throws') throw make(name);
                  return make(name);
                }),
              );
              await h.clock.advance(0);
              const first = peer.observe('call', 'hi.r', peer.client.call('hi.r'));
              await h.clock.advance(10);
              const second = peer.observe('call', 'hi.r', peer.client.call('hi.r'));
              await h.clock.advance(10);
              // the caller gets an answer or keeps waiting (a never-settling thenable): the callee is never hurt
              for (const call of [first, second]) {
                if (call.errored)
                  expect((call.error as { code?: unknown }).code, String(call.error)).toBe('wamp_error');
              }
              expect(reg.closed, 'the registration keeps serving').toBe(false);
              break;
            }
          }
          await h.clock.advance(10);
          // the record that received the value may have errored (a TypeError of the facade, the client's own WampError,
          // what the value threw: INV-R6 below); nothing else may notice: the connection and every stream keep working
          await sentinel(run, ends);
          await finish(run);
        },
      ),
      { ...replayParameters() },
    );
  });

  test('as challenge answers and URL results: exactly that attempt ends, then the client opens normally', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.constantFrom('challenge' as const, 'url' as const),
        hostile,
        async (seed, where, name) => {
          let bad = true;
          const h = createHarness({
            seed,
            checks: { unscripted: false },
            router:
              where === 'challenge'
                ? {
                    dialect: 'thruway-php',
                    providers: [
                      {
                        method: 'ticket',
                        verify: (sig: string) => (sig === 'ok' ? { authid: 'joe', authrole: 'u' } : false),
                      },
                    ],
                  }
                : { dialect: 'thruway-php' },
          });
          const c = h.makeClient(Client, {
            ...(where === 'url' ? { url: () => (bad ? make(name) : h.router.url) as never } : {}),
            options: {
              autoOpen: false,
              timeouts: { idle: 0, handshake: 1000, connect: 1000 },
              retryOptions: { maxRetryDelay: 200 },
              ...(where === 'challenge'
                ? { authmethods: ['ticket'], authid: 'joe', onChallenge: () => (bad ? make(name) : 'ok') as never }
                : {}),
            },
          });
          c.open();
          await h.clock.advance(50);
          bad = false;
          await h.clock.advance(3000);
          if (NEVER_SETTLES.has(name) && c.status?.values.at(-1)?.state === 'connecting') {
            // the attempt waits for an answer the app never gives: the app moves on with reconnect() (recipe 18)
            c.reconnect();
            await h.clock.advance(3000);
          }
          expect(c.status?.values.at(-1)?.state, 'open once the answers are good').toBe('open');
          const ends = c.onClose?.values ?? [];
          for (const info of ends) {
            expect(info.willRetry).toBe(true);
            if (info.initiator === 'app') continue; // the reconnect() after an answer that never came
            // the handler failed (cannot_authenticate), the url failed, a wrong answer was rejected (ABORT), a timeout
            expect(['authentication', 'connection_lost', 'abort', 'timeout']).toContain(info.error?.code);
          }
          await h.closeAndSettle();
          const trace = c.trace();
          const found = checkInvariants(trace, {
            timings: { idle: 0, handshake: 1000, connect: 1000, maxRetryDelay: 200 },
            final: true,
            exempt: deliberate,
          });
          expect(found, formatViolations(found, trace)).toEqual([]);
          expect(trace.logs.filter((l) => l.entry.event === 'internal').map((l) => l.entry.message)).toEqual([]);
          expect(h.problems().filter((p) => !p.startsWith('unscripted'))).toEqual([]);
          expect(escaped).toEqual([]);
        },
      ),
      { ...replayParameters() },
    );
  });
});
