// Completeness of the transition table: every machine state × every input kind × {the current connection, a lingering
// one, a stale connection, a stale generation} is processed by the real Core, and each cell either moves the state as
// its transition says or hits the catch-all (dropped with a debug `frame.dropped` entry, the state unchanged) — and no
// cell throws (no `internal` entry: no hardReset).
import { describe, expect, test } from 'vitest';
import type { AnyOp, CoreInput } from '../../src/core/contracts.js';
import { Core, type MachineState } from '../../src/core/machine.js';
import { opFactories } from '../../src/core/registry.js';
import { normalizeOptions } from '../../src/options.js';
import { createSimClock, createSimRouter, type SimClock, type SimRouter } from '../../src/testing/sim.js';
import type { ClientOptions, LogEntry } from '../../src/types.js';
import { snapshotCall, snapshotTopic } from '../../src/validate.js';

type Fixture = 'CLOSED never opened' | 'CLOSED stopped' | Exclude<MachineState, 'CLOSED'> | 'CHALLENGED (settling)';
type Variant = 'current' | 'lingering' | 'stale connection' | 'stale generation';

interface World {
  readonly core: Core;
  readonly clock: SimClock;
  readonly router: SimRouter;
  readonly logs: LogEntry[];
  /** The id of the current (or, without one, the last) connection; of a lingering one. */
  readonly current: number;
  readonly lingering: number;
  readonly round: number;
}

const STALE_GEN = 987654321;
const STALE_CONN = 4242;

/** A Core with one lingering connection (a reconnect() whose GOODBYE is never answered) in the given state. */
async function world(state: Fixture): Promise<World> {
  const clock = createSimClock({ seed: 77 });
  let hellos = 0;
  const router = createSimRouter({
    clock: clock.scope('router'),
    strict: false,
    authenticate:
      state === 'CHALLENGED' || state === 'CHALLENGED (settling)'
        ? () =>
            hellos++ === 0
              ? { welcome: { authid: 'x', authmethod: 'ticket' } }
              : { challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'x' } }) }
        : undefined,
  });
  router.ignore((f) => f[0] === 6); // client GOODBYEs are never answered: the connection lingers
  const logs: LogEntry[] = [];
  let resolve = false;
  const options: ClientOptions = {
    WebSocket: router.WebSocket,
    clock: clock.scope('client'),
    timeouts: { idle: 0 },
    retryOptions: { retryDelay: () => 1000000 },
    logger: (e) => logs.push(e),
    autoOpen: false,
    ...(state === 'CHALLENGED' || state === 'CHALLENGED (settling)'
      ? {
          authmethods: state === 'CHALLENGED' ? ['ticket'] : ['ticket', 'wampcra'],
          onChallenge: () => new Promise<string>(() => undefined),
        }
      : {}),
  };
  const core = new Core(
    normalizeOptions(() => (resolve ? new Promise<string>(() => undefined) : router.url), 'realm1', options),
  );
  const advance = (ms: number): Promise<void> => clock.advance(ms);
  if (state === 'CLOSED never opened') {
    return { core, clock, router, logs, current: STALE_CONN + 1, lingering: STALE_CONN + 2, round: 0 };
  }
  core.submit({ kind: 'open' });
  await advance(1500);
  const first = core.debug().currentConnection ?? 0;
  if (state === 'RESOLVING') resolve = true;
  if (state === 'CONNECTING') router.setAvailable('hang');
  if (state === 'HELLO_SENT') router.ignore((f) => f[0] === 1);
  if (state === 'WAITING') router.setAvailable('refuse');
  core.submit({ kind: 'reconnect' }); // connection 1 lingers (its GOODBYE is never answered)
  if (state === 'CLOSED stopped') {
    await advance(1);
    core.submit({ kind: 'close', resolve: () => undefined });
    // CLOSED has no current connection: the "current" cell is a connection id that is neither current nor lingering
    return { core, clock, router, logs, current: STALE_CONN + 1, lingering: first, round: 0 };
  }
  await advance(1);
  const current = core.debug().currentConnection ?? first + 1;
  expect(core.state).toBe(state.startsWith('CHALLENGED') ? 'CHALLENGED' : state);
  return { core, clock, router, logs, current, lingering: first, round: 1 };
}

const callOp = (): AnyOp =>
  opFactories.newCallOp(1000, snapshotCall('com.example.p', [], {}, {}), {
    next: () => undefined,
    error: () => undefined,
    complete: () => undefined,
    closed: false,
  });
const topicOp = (): AnyOp =>
  opFactories.newTopicOp(1001, snapshotTopic('com.example.t', {}), {
    next: () => undefined,
    error: () => undefined,
    complete: () => undefined,
    closed: false,
  });

const KINDS = [
  'open',
  'reconnect',
  'close',
  'op.start',
  'op.stop',
  'url.ok',
  'url.fail',
  'challenge.ok',
  'challenge.fail',
  'handler.next',
  'handler.complete',
  'handler.error',
  'ws.open',
  'ws.message',
  'ws.closed',
  'timer.retry',
  'timer.connect',
  'timer.handshake',
  'timer.challenge',
  'timer.stable',
  'timer.idle',
  'timer.ping',
  'timer.goodbye',
  'timer.op',
] as const satisfies readonly CoreInput['kind'][];
type Kind = (typeof KINDS)[number];

/** The input of `kind` for `conn` (generation `gen`). Connection-less kinds ignore both. */
function input(kind: Kind, conn: number, gen: number, round: number): CoreInput {
  switch (kind) {
    case 'open':
    case 'reconnect':
      return { kind };
    case 'close':
      return { kind, resolve: () => undefined };
    case 'op.start':
      return { kind, op: callOp() };
    case 'op.stop':
      return { kind, op: topicOp() };
    case 'url.ok':
      return { kind, conn, url: 'memory://router/none' };
    case 'url.fail':
      return { kind, conn, error: new Error('x') };
    case 'challenge.ok':
      return { kind, conn, round, signature: 'sig' };
    case 'challenge.fail':
      return { kind, conn, round, error: new Error('x') };
    case 'handler.next':
      return { kind, conn, invocation: {}, value: 1 };
    case 'handler.complete':
      return { kind, conn, invocation: {}, hasValue: false };
    case 'handler.error':
      return { kind, conn, invocation: {}, error: new Error('x') };
    case 'ws.open':
      return { kind, conn, protocol: 'wamp.2.json' };
    case 'ws.message':
      return { kind, conn, data: JSON.stringify([36, 123456, 1, {}]) }; // an EVENT nobody subscribed to
    case 'ws.closed':
      return { kind, conn, code: 1006, reason: '', wasClean: false };
    case 'timer.retry':
      return { kind, conn: 0, gen };
    case 'timer.op':
      return { kind, conn, gen, owner: 'topic', key: 1 };
    case 'timer.connect':
    case 'timer.handshake':
    case 'timer.challenge':
    case 'timer.stable':
    case 'timer.idle':
    case 'timer.ping':
    case 'timer.goodbye':
      return { kind, conn, gen };
  }
}

const CONNECTING_STATES: readonly MachineState[] = ['RESOLVING', 'CONNECTING', 'HELLO_SENT', 'CHALLENGED'];
const STARTED: readonly MachineState[] = ['RESOLVING', 'CONNECTING'];
const ANY: readonly MachineState[] = ['CLOSED', 'WAITING', ...CONNECTING_STATES, 'ESTABLISHED'];

/** The states a cell may end in, per its transition; `undefined` = the catch-all (unchanged, logged). */
function expected(state: Fixture, kind: Kind, given: Variant): readonly MachineState[] | undefined {
  // a generation only exists for timers: for every other input the stale-generation cell is the current one
  const variant = given === 'stale generation' && !kind.startsWith('timer.') ? 'current' : given;
  const s: MachineState = state.startsWith('CLOSED')
    ? 'CLOSED'
    : state.startsWith('CHALLENGED')
      ? 'CHALLENGED'
      : (state as MachineState);
  const connecting = CONNECTING_STATES.includes(s);
  switch (kind) {
    case 'open': // the url is a resolver in these fixtures: an attempt starts in RESOLVING (or waits for the floor)
      return s === 'CLOSED' || s === 'WAITING' ? ['WAITING', ...STARTED] : [s];
    case 'reconnect':
      return ['WAITING', ...STARTED];
    case 'close':
      return ['CLOSED'];
    case 'op.start':
    case 'op.stop':
      return [s];
    case 'url.ok':
    case 'url.fail':
    case 'challenge.ok':
    case 'challenge.fail':
    case 'handler.next':
    case 'handler.complete':
    case 'handler.error':
    case 'ws.open':
    case 'ws.message':
    case 'ws.closed':
    case 'timer.retry':
    case 'timer.connect':
    case 'timer.handshake':
    case 'timer.challenge':
    case 'timer.stable':
    case 'timer.idle':
    case 'timer.ping':
    case 'timer.goodbye':
    case 'timer.op':
      break;
  }
  if (kind === 'challenge.ok' && s === 'WAITING') return ['WAITING', ...STARTED]; // a late answer: startSoon
  if (variant === 'lingering') {
    // a lingering record finishes on its socket's close (any ws.closed); everything else is dropped
    return kind === 'ws.closed' ? [s] : undefined;
  }
  if (variant !== 'current' || kind === 'timer.retry') return undefined;
  switch (kind) {
    case 'url.ok': // a socket to a router that does not exist may fail at once
      return s === 'RESOLVING' ? ['CONNECTING', 'WAITING'] : undefined;
    case 'url.fail':
      return s === 'RESOLVING' ? ['WAITING'] : undefined;
    case 'challenge.ok':
      return state === 'CHALLENGED' ? ['HELLO_SENT'] : undefined;
    case 'challenge.fail':
      return state === 'CHALLENGED' ? ['WAITING'] : undefined;
    case 'handler.next':
    case 'handler.complete':
    case 'handler.error':
      return s === 'ESTABLISHED' ? ['ESTABLISHED'] : undefined;
    case 'ws.open': // a forged open: the HELLO write is refused by the socket that is not open, a loss
      return s === 'CONNECTING' ? ['HELLO_SENT', 'WAITING'] : undefined;
    case 'ws.message':
      return s === 'HELLO_SENT' || s === 'CHALLENGED' || s === 'ESTABLISHED' ? [s] : undefined;
    case 'ws.closed':
      return connecting && s !== 'RESOLVING' ? ['WAITING'] : s === 'ESTABLISHED' ? ['WAITING'] : undefined;
    case 'timer.connect':
    case 'timer.handshake':
    case 'timer.challenge':
    case 'timer.stable':
    case 'timer.idle':
    case 'timer.ping':
    case 'timer.goodbye':
    case 'timer.op':
      return undefined; // a timer whose generation is not armed: catch-all
  }
}

const FIXTURES: readonly Fixture[] = [
  'CLOSED never opened',
  'CLOSED stopped',
  'WAITING',
  'RESOLVING',
  'CONNECTING',
  'HELLO_SENT',
  'CHALLENGED',
  'CHALLENGED (settling)',
  'ESTABLISHED',
];
const VARIANTS: readonly Variant[] = ['current', 'lingering', 'stale connection', 'stale generation'];

describe('every (state, input kind, connection/generation) cell of the table', () => {
  describe.each(FIXTURES)('%s', (state) => {
    test.each(KINDS)('%s', async (kind) => {
      for (const variant of VARIANTS) {
        const w = await world(state);
        const conn = variant === 'lingering' ? w.lingering : variant === 'stale connection' ? STALE_CONN : w.current;
        const gen = STALE_GEN;
        const before = w.core.state;
        const dropped = w.logs.filter((l) => l.event === 'frame.dropped').length;
        expect(() => {
          w.core.submit(input(kind, conn, gen, w.round));
        }, `${state} × ${kind} × ${variant}`).not.toThrow();
        const label = `${state} × ${kind} × ${variant}`;
        expect(
          w.logs.filter((l) => l.event === 'internal'),
          label,
        ).toEqual([]);
        const allowed = expected(state, kind, variant);
        if (allowed === undefined) {
          expect(w.core.state, `${label}: catch-all keeps the state`).toBe(before);
          expect(w.logs.filter((l) => l.event === 'frame.dropped').length, `${label}: logged`).toBeGreaterThan(dropped);
        } else {
          expect(allowed, label).toContain(w.core.state);
        }
        // whatever happened, the client can still be closed cleanly and leaves nothing armed
        w.core.submit({ kind: 'close', resolve: () => undefined });
        await w.clock.runUntilIdle();
        expect(w.clock.scope('client').pendingTimers, label).toBe(0);
        expect(ANY).toContain(w.core.state);
      }
    });
  });
});

describe('single cells, checked in detail', () => {
  test('a second ws.open, ws.message in CONNECTING, timer.challenge after the end, stale url/challenge/handler', async () => {
    const w = await world('ESTABLISHED');
    for (const i of [
      input('ws.open', w.current, 0, 1),
      input('timer.challenge', w.current, 1, 1),
      input('url.ok', w.current, 0, 1),
      input('challenge.ok', w.current, 0, 7),
      input('handler.complete', STALE_CONN, 0, 1),
    ]) {
      w.core.submit(i);
    }
    expect(w.core.state).toBe('ESTABLISHED');
    expect(w.logs.filter((l) => l.event === 'frame.dropped').length).toBeGreaterThanOrEqual(5);
    const c = await world('CONNECTING');
    c.core.submit(input('ws.message', c.current, 0, 1));
    expect(c.core.state).toBe('CONNECTING');
    expect(c.logs.at(-1)?.message).toMatch(/before open/);
  });

  test('ws.closed in RESOLVING is dropped (no socket yet)', async () => {
    const w = await world('RESOLVING');
    w.core.submit(input('ws.closed', w.current, 0, 1));
    expect(w.core.state).toBe('RESOLVING');
  });

  test('the debug probe reports the machine', async () => {
    const w = await world('ESTABLISHED');
    const d = w.core.debug();
    expect(d).toMatchObject({ state: 'ESTABLISHED', stopped: false, currentConnection: w.current, lingering: 1 });
    expect(d.participants).toHaveProperty('topic');
    expect(d.timers).toBeGreaterThanOrEqual(1); // the stable timer
    w.core.submit({ kind: 'close', resolve: () => undefined });
    await w.clock.runUntilIdle();
    expect(w.core.debug()).toMatchObject({ state: 'CLOSED', stopped: true, lingering: 0, timers: 0 });
  });
});
