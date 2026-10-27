// The reference router's dialects (dialects.ts): every quirk flag, one rule per test, driven by raw WAMP peers on the
// fake socket and the virtual clock. The recorded probes of the real routers are replayed in dialect-fidelity.test.ts;
// this file pins each rule by itself (including the ones no probe reaches: CHALLENGE gaps, the auth provider switches,
// `_thruway` queues, orphan replacement, strict ids, …).
import { afterEach, describe, expect, test } from 'vitest';
import {
  createRouter,
  createSimClock,
  DIALECTS,
  type DialectName,
  quirksOf,
  type SimAuthProvider,
  type SimRouter,
  type SimRouterOptions,
  type SimSession,
} from '../../src/testing/sim.js';
import { callFrame, MSG, PEER_ROLES, WampPeer, type Frame } from '../helpers/wamp-peer.js';

interface Setup {
  readonly clock: ReturnType<typeof createSimClock>;
  readonly router: SimRouter;
  peer(protocols?: string | string[]): WampPeer;
  join(details?: Record<string, unknown>, realm?: string): Promise<WampPeer>;
}

/** Routers of the running test: none may have failed internally (only the errors a test throws on purpose, named
 *  `… bug`, may land in `router.errors`). */
const routers: SimRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) {
    expect(r.errors.filter((e) => !(e instanceof Error && e.message.endsWith(' bug')))).toEqual([]);
  }
});

function setup(dialect: DialectName, options: Omit<SimRouterOptions, 'clock' | 'dialect'> = {}): Setup {
  const clock = createSimClock();
  const router = createRouter({ clock, dialect, ...options });
  routers.push(router);
  const peer = (protocols?: string | string[]): WampPeer =>
    new WampPeer(router.WebSocket, router.url, () => clock.advance(0), protocols); // waits pass no time: timers stay exact
  return {
    clock,
    router,
    peer,
    join: async (details = {}, realm = 'realm1') => {
      const p = peer();
      const welcome = await p.join(realm, details);
      if (welcome[0] !== MSG.WELCOME) throw new Error(`join failed: ${JSON.stringify(welcome)}`);
      return p;
    },
  };
}

/** A callee announcing every feature but `call_canceling` (`cancel: false`) or progressive results. */
function calleeRoles(features: Record<string, boolean>): Record<string, unknown> {
  return { roles: { ...PEER_ROLES, callee: { features: { ...PEER_ROLES.callee.features, ...features } } } };
}

async function opened(s: Setup, protocols?: string | string[]): Promise<WampPeer> {
  const p = s.peer(protocols);
  await s.clock.runUntilIdle();
  return p;
}

const settle = (s: Setup): Promise<void> => s.clock.runUntilIdle();

describe('dialect table', () => {
  test('every dialect is frozen and named; quirksOf applies overrides and rejects unknown names', () => {
    for (const [name, dialect] of Object.entries(DIALECTS)) {
      expect(dialect.name).toBe(name);
      expect(Object.isFrozen(dialect.flags)).toBe(true);
      expect(Object.isFrozen(dialect.flags.violations)).toBe(true);
    }
    expect(quirksOf('thruway-php')).toBe(DIALECTS['thruway-php'].flags);
    expect(quirksOf('nexus', { strict_ids: true }).strict_ids).toBe(true);
    expect(quirksOf('nexus', { strict_ids: true }).call_timeout).toBe('ms');
    expect(() => quirksOf('nope')).toThrow(new TypeError("testing router: unknown dialect 'nope'"));
  });

  test('a router exposes its dialect and the flags in effect; subscriptionIds and routerIds sequential', () => {
    const r = createRouter({ dialect: 'nexus', quirks: { strict_ids: true }, subscriptionIds: 'shared' });
    expect(r.dialect).toBe('nexus');
    expect(r.quirks.strict_ids).toBe(true);
    expect(r.quirks.subscription_ids).toBe('shared');
    expect(Object.isFrozen(r.quirks)).toBe(true);
    expect(createRouter().dialect).toBe('spec');
    expect(createRouter({ quirks: { exclude_me: 'always' } }).quirks.exclude_me).toBe('always');
  });

  test("routerIds 'sequential' is 'unique': one counter for every kind of id", async () => {
    const s = setup('spec', { routerIds: 'sequential' });
    const a = await s.join();
    const sub = await a.subscribe('com.example.t');
    const reg = await a.register('com.example.p');
    expect([a.received[0]![1], sub, reg]).toEqual([1, 2, 3]);
  });
});

// =====================================================================================================================
// Thruway PHP 0.6.1 (quirks T1–T8: test/routers/ROUTERS-C.md)
// =====================================================================================================================

describe('thruway-php: dealer (T1–T3, T8)', () => {
  async function dealer(): Promise<{ s: Setup; callee: WampPeer; a: WampPeer; b: WampPeer; invocations: Frame[] }> {
    const s = setup('thruway-php');
    const callee = await s.join();
    await callee.register('com.example.slow');
    const invocations: Frame[] = [];
    callee.onFrame = (f) => {
      if (f[0] === MSG.INVOCATION) invocations.push(f);
      return false;
    };
    return { s, callee, a: await s.join(), b: await s.join(), invocations };
  }

  test('T1: CALLs are indexed realm-wide by request id: only the latest CALL with an id can be cancelled', async () => {
    const { s, callee, a, b, invocations } = await dealer();
    a.send(callFrame(1, 'com.example.slow', ['a']));
    await settle(s);
    b.send(callFrame(1, 'com.example.slow', ['b']));
    await settle(s);
    a.send([MSG.CANCEL, 1, { mode: 'killnowait' }]); // the index holds b's CALL: dropped silently
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
    expect(a.pending).toEqual([]);
    b.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await settle(s);
    expect(callee.take((f) => f[0] === MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, invocations[1]![1], {}]);
    expect(b.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.canceled']);
    // a's CALL still runs; b's is gone from the index, so a CANCEL now finds nothing (Thruway's unset)
    a.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await settle(s);
    expect(a.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.no_such_call']);
    callee.send([MSG.YIELD, invocations[0]![1], {}, ['done']]);
    await settle(s);
    expect(a.take(() => true)).toEqual([MSG.RESULT, 1, {}, ['done']]);
  });

  test('T1: the older CALL finishing unsets the index entry the newer CALL with its id holds (removeCall): the newer one can no longer be cancelled', async () => {
    const { s, callee, a, b, invocations } = await dealer();
    a.send(callFrame(1, 'com.example.slow', ['a']));
    await settle(s);
    b.send(callFrame(1, 'com.example.slow', ['b']));
    await settle(s);
    callee.send([MSG.YIELD, invocations[0]![1], {}, ['a done']]);
    await settle(s);
    expect(a.take(() => true)).toEqual([MSG.RESULT, 1, {}, ['a done']]);
    b.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await settle(s);
    expect(b.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.no_such_call']);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
    callee.send([MSG.YIELD, invocations[1]![1], {}, ['b done']]); // b's call still runs
    expect(await b.nextOf(MSG.RESULT)).toEqual([MSG.RESULT, 1, {}, ['b done']]);
  });

  test('T1: when a caller leaves, the auto-cancel is skipped for a CALL whose id another session overwrote', async () => {
    const { s, callee, a, b } = await dealer();
    a.send(callFrame(5, 'com.example.slow'));
    await settle(s);
    b.send(callFrame(5, 'com.example.slow'));
    await settle(s);
    a.ws.close(1000);
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
    b.ws.close(1000);
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT).map((f) => f[2])).toEqual([{}]);
  });

  test('T2: skip ≡ kill: INTERRUPT {} and the callee’s answer reaches the caller as ERROR(48)', async () => {
    const { s, callee, a, invocations } = await dealer();
    for (const mode of ['skip', 'kill', undefined, 'nonsense']) {
      const id = a.id();
      a.send(callFrame(id, 'com.example.slow'));
      await settle(s);
      a.send([MSG.CANCEL, id, mode === undefined ? {} : { mode }]);
      await settle(s);
      const inv = invocations.at(-1)![1];
      expect(callee.take((f) => f[0] === MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, inv, {}]);
      expect(a.pending).toEqual([]); // kill waits for the callee
      a.send([MSG.CANCEL, id, { mode: 'kill' }]); // a second CANCEL while one is pending: ignored
      callee.send([MSG.ERROR, MSG.INVOCATION, inv, { why: 1 }, 'wamp.error.canceled', ['stopped']]);
      await settle(s);
      expect(a.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, id, { why: 1 }, 'wamp.error.canceled', ['stopped']]);
    }
  });

  test('T2: killnowait answers ERROR(49) at once; the callee’s late ERROR gets the bogus [8,8,…], a late YIELD [8,70,…]', async () => {
    const { s, callee, a, invocations } = await dealer();
    a.send(callFrame(1, 'com.example.slow'));
    a.send(callFrame(2, 'com.example.slow'));
    await settle(s);
    a.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    a.send([MSG.CANCEL, 2, { mode: 'killnowait' }]);
    await settle(s);
    expect(a.pending).toEqual([
      [MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.canceled'],
      [MSG.ERROR, MSG.CANCEL, 2, {}, 'wamp.error.canceled'],
    ]);
    const [one, two] = [invocations[0]![1], invocations[1]![1]];
    callee.send([MSG.ERROR, MSG.INVOCATION, one, {}, 'wamp.error.canceled']);
    callee.send([MSG.YIELD, two, {}, ['late']]);
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.ERROR)).toEqual([
      [MSG.ERROR, MSG.ERROR, one, {}, 'wamp.error.no_such_procedure'],
      [MSG.ERROR, MSG.YIELD, two, {}, 'wamp.error.unknown'],
    ]);
  });

  test('T2: CANCEL for a callee that did not announce call_canceling is refused (49 not_supported) and the call goes on', async () => {
    const s = setup('thruway-php');
    const callee = s.peer();
    await callee.join('realm1', calleeRoles({ call_canceling: false }));
    await callee.register('com.example.p');
    const caller = await s.join();
    caller.send(callFrame(9, 'com.example.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    caller.send([MSG.CANCEL, 9, { mode: 'killnowait' }]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 9, {}, 'wamp.error.not_supported']);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
    callee.send([MSG.YIELD, inv[1], {}, ['still done']]);
    expect(await caller.nextOf(MSG.RESULT, 9)).toEqual([MSG.RESULT, 9, {}, ['still done']]);
  });

  test('T2, T3: a refused CANCEL of a progressive call forgets it too (Dealer::processCancel removes every progressive call it reached): the callee works on, its YIELDs get [8,70,…], the caller nothing more', async () => {
    const s = setup('thruway-php');
    const callee = s.peer();
    await callee.join('realm1', calleeRoles({ call_canceling: false }));
    await callee.register('com.example.p');
    const caller = await s.join();
    const leaver = await s.join();
    const progress = { receive_progress: true };
    caller.send(callFrame(9, 'com.example.p', undefined, undefined, progress));
    const inv = await callee.nextOf(MSG.INVOCATION);
    leaver.send(callFrame(4, 'com.example.p', undefined, undefined, progress));
    const left = await callee.nextOf(MSG.INVOCATION);
    caller.send([MSG.CANCEL, 9, { mode: 'killnowait' }]);
    leaver.ws.close(1000); // Dealer::leave cancels its call the same way (refused: the call goes too)
    await settle(s);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 9, {}, 'wamp.error.not_supported']);
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
    callee.send([MSG.YIELD, inv[1], {}, ['done']]);
    callee.send([MSG.YIELD, left[1], {}, ['done']]);
    await settle(s);
    expect(caller.pending).toEqual([]);
    expect(callee.pending.filter((f) => f[0] === MSG.ERROR || f[0] === MSG.INTERRUPT)).toEqual([
      [MSG.ERROR, MSG.YIELD, inv[1], {}, 'wamp.error.unknown'],
      [MSG.ERROR, MSG.YIELD, inv[1], {}, 'wamp.error.unknown'],
      [MSG.ERROR, MSG.YIELD, left[1], {}, 'wamp.error.unknown'],
    ]);
    expect(s.router.sessions.find((x) => x.connection === caller.ws.controls.number)?.calls).toBe(0);
  });

  test('T3: a cancelled progressive call is forgotten: after kill the caller never gets a final message', async () => {
    const { s, callee, a, invocations } = await dealer();
    a.send(callFrame(3, 'com.example.slow', undefined, undefined, { receive_progress: true }));
    await settle(s);
    const inv = invocations[0]!;
    expect(inv[3]).toEqual({ receive_progress: true }); // forwarded whatever the callee announced
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
    await settle(s);
    expect(a.take(() => true)).toEqual([MSG.RESULT, 3, { progress: true }, ['p1']]);
    a.send([MSG.CANCEL, 3, { mode: 'kill' }]);
    await settle(s);
    expect(callee.take((f) => f[0] === MSG.INTERRUPT)).toEqual([MSG.INTERRUPT, inv[1], {}]);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'wamp.error.canceled']);
    await s.clock.advance(10_000);
    expect(a.pending).toEqual([]);
    expect(callee.take((f) => f[0] === MSG.ERROR)).toEqual([
      MSG.ERROR,
      MSG.ERROR,
      inv[1],
      {},
      'wamp.error.no_such_procedure',
    ]);
  });

  test('a cancelled progressive call to a scripted procedure is forgotten too (kill), answered at once (killnowait)', async () => {
    const s = setup('thruway-php');
    s.router.procedure('com.example.never', () => new Promise(() => undefined));
    const a = await s.join();
    a.send(callFrame(1, 'com.example.never', undefined, undefined, { receive_progress: true }));
    a.send(callFrame(2, 'com.example.never', undefined, undefined, { receive_progress: true }));
    a.send(callFrame(3, 'com.example.never'));
    await settle(s);
    a.send([MSG.CANCEL, 1, { mode: 'kill' }]);
    a.send([MSG.CANCEL, 2, { mode: 'killnowait' }]);
    a.send([MSG.CANCEL, 3, { mode: 'kill' }]);
    await settle(s);
    expect(a.pending).toEqual([
      [MSG.ERROR, MSG.CANCEL, 2, {}, 'wamp.error.canceled'],
      [MSG.ERROR, MSG.CALL, 3, {}, 'wamp.error.canceled'],
    ]);
  });

  test('T8: UNREGISTER of an unknown id ⇒ no_such_procedure; of another session’s ⇒ no_such_registration', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const b = await s.join();
    const reg = await a.register('com.example.p');
    b.send([MSG.UNREGISTER, 1, 424242]);
    b.send([MSG.UNREGISTER, 2, reg]);
    await settle(s);
    expect(b.pending).toEqual([
      [MSG.ERROR, MSG.UNREGISTER, 1, {}, 'wamp.error.no_such_procedure'],
      [MSG.ERROR, MSG.UNREGISTER, 2, {}, 'wamp.error.no_such_registration'],
    ]);
  });

  test('the callee leaving ⇒ caller ERROR canceled; the caller leaving ⇒ INTERRUPT {} (nothing for a callee without the feature)', async () => {
    const s = setup('thruway-php');
    const plain = s.peer();
    await plain.join('realm1', calleeRoles({ call_canceling: false }));
    await plain.register('com.example.plain');
    const callee = await s.join();
    await callee.register('com.example.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.example.p'));
    caller.send(callFrame(2, 'com.example.plain'));
    await settle(s);
    caller.ws.close(1000);
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT).map((f) => f[2])).toEqual([{}]);
    expect(plain.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
    const other = await s.join();
    other.send(callFrame(1, 'com.example.p'));
    await settle(s);
    callee.ws.close(1000);
    expect(await other.nextOf(MSG.ERROR)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled']);
  });

  test('request ids are not validated (0, negative, fractional, strings: answered with the same id); duplicate in-flight CALLs are served twice', async () => {
    const s = setup('thruway-php', { strict: false });
    const a = await s.join();
    for (const id of [0, -5, 1.5, 'abc']) a.send([MSG.CALL, id, {}, 'com.example.nothing']);
    await settle(s);
    expect(a.pending.map((f) => f[2])).toEqual([0, -5, 1.5, 'abc']);
    while (a.take(() => true) !== undefined);
    const callee = await s.join();
    await callee.register('com.example.echo');
    callee.autoCallee(callee.received.at(-1)![2] as number, (args) => args[0]);
    a.send(callFrame(7, 'com.example.echo', ['first']));
    a.send(callFrame(7, 'com.example.echo', ['second']));
    await settle(s);
    expect(a.pending.filter((f) => f[0] === MSG.RESULT)).toEqual([
      [MSG.RESULT, 7, {}, ['first']],
      [MSG.RESULT, 7, {}, ['second']],
    ]);
  });

  test('caller identification only through REGISTER disclose_caller, with the caller’s auth details', async () => {
    const s = setup('thruway-php');
    const callee = await s.join();
    await callee.register('com.example.d', { disclose_caller: true });
    await callee.register('com.example.q');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.example.d', undefined, undefined, { disclose_me: true }));
    caller.send(callFrame(2, 'com.example.q', undefined, undefined, { disclose_me: true }));
    await settle(s);
    expect(callee.pending.filter((f) => f[0] === MSG.INVOCATION).map((f) => f[3])).toEqual([
      {
        caller: caller.received[0]![1],
        authid: 'anonymous',
        authrole: 'anonymous',
        authroles: ['anonymous'],
        authmethod: 'anonymous',
      },
      {},
    ]);
    // a ticket session: its WELCOME has no authmethod (the provider returned none), its auth details do (T6's method)
    const auth = setup('thruway-php', { providers: [{ method: 'ticket', verify: () => ({ authid: 'tk' }) }] });
    const viaTicket = async (): Promise<[WampPeer, Frame]> => {
      const p = await opened(auth);
      p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket'] }]);
      await p.nextOf(MSG.CHALLENGE);
      p.send([MSG.AUTHENTICATE, 't', {}]);
      return [p, await p.nextOf(MSG.WELCOME)];
    };
    const [authCallee] = await viaTicket();
    await authCallee.register('com.example.d', { disclose_caller: true });
    const [authCaller, welcome] = await viaTicket();
    expect(welcome[2]).not.toHaveProperty('authmethod');
    authCaller.send(callFrame(1, 'com.example.d'));
    expect((await authCallee.nextOf(MSG.INVOCATION))[3]).toEqual({
      caller: welcome[1],
      authid: 'tk',
      authrole: 'authenticated_user',
      authroles: ['authenticated_user'],
      authmethod: 'ticket',
    });
  });
});

describe('thruway-php: shared registrations and orphan replacement', () => {
  test('invoke policies: distinct registration ids; a different invoke or disclose_caller ⇒ wamp.error.unknown; an unknown invoke is single', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const b = await s.join();
    const ra = await a.register('com.example.rr', { invoke: 'RoundRobin' });
    const rb = await b.register('com.example.rr', { invoke: 'roundrobin' });
    expect(ra).not.toBe(rb);
    for (const [options, uri] of [
      [{ invoke: 'random' }, 'wamp.error.unknown'],
      [{ invoke: 'roundrobin', disclose_caller: true }, 'wamp.error.unknown'],
      [{}, 'wamp.error.unknown'],
    ] as const) {
      const c = await s.join();
      const id = c.id();
      c.send([MSG.REGISTER, id, options, 'com.example.rr']);
      expect(await c.reply(MSG.REGISTER, id, MSG.REGISTERED)).toEqual([MSG.ERROR, MSG.REGISTER, id, {}, uri]);
    }
    await a.register('com.example.single', { invoke: 'sometimes' });
    const id = b.id();
    b.send([MSG.REGISTER, id, { invoke: 'roundrobin' }, 'com.example.single']);
    expect(await b.reply(MSG.REGISTER, id, MSG.REGISTERED)).toEqual([
      MSG.ERROR,
      MSG.REGISTER,
      id,
      {},
      'wamp.error.procedure_already_exists',
    ]);
  });

  test("'_thruway' (and thruway_multiregister): the first idle callee; calls queue while all are busy, a queued call cancels at once", async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const b = await s.join();
    await a.register('com.example.t', { invoke: '_thruway' });
    await b.register('com.example.t', { thruway_multiregister: true });
    const caller = await s.join();
    for (const id of [1, 2, 3, 4]) caller.send(callFrame(id, 'com.example.t', [id]));
    await settle(s);
    const invA = a.pending.filter((f) => f[0] === MSG.INVOCATION);
    const invB = b.pending.filter((f) => f[0] === MSG.INVOCATION);
    expect([invA.map((f) => f[4]), invB.map((f) => f[4])]).toEqual([[[1]], [[2]]]);
    caller.send([MSG.CANCEL, 4, { mode: 'kill' }]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([
      MSG.ERROR,
      MSG.CANCEL,
      4,
      { _thruway_removed_from_queue: true },
      'wamp.error.canceled',
    ]);
    b.send([MSG.YIELD, invB[0]![1], {}, ['b']]);
    await settle(s);
    expect(b.pending.filter((f) => f[0] === MSG.INVOCATION).map((f) => f[4])).toEqual([[2], [3]]);
    b.ws.close(1000);
    a.ws.close(1000);
    await settle(s);
    expect(caller.pending.map((f) => [f[0], f[2]])).toEqual([
      [MSG.RESULT, {}],
      [MSG.ERROR, 3],
      [MSG.ERROR, 1],
    ]);
  });

  test('queued calls of a registration that loses its last callee get no_such_procedure', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.example.t', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.example.t'));
    caller.send(callFrame(2, 'com.example.t'));
    await settle(s);
    const reg = a.received.find((f) => f[0] === MSG.REGISTERED)![2];
    a.send([MSG.UNREGISTER, a.id(), reg]);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.no_such_procedure']]);
  });

  test('a queued call that times out (a timeout dialect with _thruway queues) leaves the queue: never invoked later', async () => {
    const s = setup('thruway-php', { quirks: { call_timeout: 'ms' } });
    const a = await s.join();
    await a.register('com.example.t', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.example.t', ['busy']));
    caller.send(callFrame(2, 'com.example.t', ['queued'], undefined, { timeout: 100 }));
    caller.send(callFrame(3, 'com.example.t', ['next']));
    await s.clock.advance(100);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.timeout']]);
    const inv = a.pending.find((f) => f[0] === MSG.INVOCATION)!;
    a.send([MSG.YIELD, inv[1], {}, []]);
    await s.clock.advance(0);
    expect(a.pending.filter((f) => f[0] === MSG.INVOCATION).map((f) => f[4])).toEqual([['busy'], ['next']]);
  });

  test('a caller leaving with a queued call removes it from the queue', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.example.t', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.example.t', ['busy']));
    caller.send(callFrame(2, 'com.example.t', ['queued']));
    await settle(s);
    caller.ws.close(1000);
    await settle(s);
    const inv = a.pending.find((f) => f[0] === MSG.INVOCATION)!;
    a.send([MSG.YIELD, inv[1], {}, []]);
    await settle(s);
    expect(a.pending.filter((f) => f[0] === MSG.INVOCATION).map((f) => f[4])).toEqual([['busy']]);
  });

  test('replace_orphaned_session: a responsive old callee keeps it; a frozen or vanished one is evicted after 5 s', async () => {
    const s = setup('thruway-php');
    const old = await s.join();
    await old.register('com.example.p');
    const fresh = await s.join();
    for (const option of ['yes', true]) {
      const id = fresh.id();
      fresh.send([MSG.REGISTER, id, { replace_orphaned_session: option }, 'com.example.p']);
      expect(await fresh.reply(MSG.REGISTER, id, MSG.REGISTERED)).toEqual([
        MSG.ERROR,
        MSG.REGISTER,
        id,
        {},
        'wamp.error.procedure_already_exists',
      ]);
    }
    old.ws.controls.freeze('buffer');
    const id = fresh.id();
    fresh.send([MSG.REGISTER, id, { replace_orphaned_session: 'yes' }, 'com.example.p']);
    await s.clock.advance(4999);
    expect(fresh.pending).toEqual([]);
    await s.clock.advance(1);
    expect(fresh.take(() => true)).toEqual([MSG.REGISTERED, id, expect.any(Number)]);
    expect(s.router.sessions.map((x) => x.connection)).toEqual([2]);
    // thawed within the window: the ping came back
    const ghost = await s.join();
    await ghost.register('com.example.g');
    ghost.ws.controls.freeze('drop', 'up');
    const id2 = fresh.id();
    fresh.send([MSG.REGISTER, id2, { replace_orphaned_session: true }, 'com.example.g']);
    await s.clock.advance(1000);
    expect(fresh.pending).toEqual([]); // frozen up: unresponsive, so the 5 s check runs
    ghost.ws.controls.thaw();
    await s.clock.advance(5000);
    expect(fresh.take(() => true)).toEqual([MSG.ERROR, MSG.REGISTER, id2, {}, 'wamp.error.procedure_already_exists']);
    // only the router's frames lost (frozen down): the ping never reaches it, evicted
    const deaf = await s.join();
    await deaf.register('com.example.deaf');
    deaf.ws.controls.freeze('drop', 'down');
    const idDeaf = fresh.id();
    fresh.send([MSG.REGISTER, idDeaf, { replace_orphaned_session: 'yes' }, 'com.example.deaf']);
    await s.clock.advance(5000);
    expect(fresh.take(() => true)).toEqual([MSG.REGISTERED, idDeaf, expect.any(Number)]);
    // vanished (an unannounced drop: the router never learnt): evicted
    ghost.ws.controls.vanish();
    const id3 = fresh.id();
    fresh.send([MSG.REGISTER, id3, { replace_orphaned_session: 'yes' }, 'com.example.g']);
    await s.clock.advance(5000);
    expect(fresh.take(() => true)).toEqual([MSG.REGISTERED, id3, expect.any(Number)]);
    // the session asking left during the window: nothing happens
    const ghost2 = await s.join();
    await ghost2.register('com.example.h');
    ghost2.ws.controls.vanish();
    const leaver = await s.join();
    leaver.send([MSG.REGISTER, 1, { replace_orphaned_session: 'yes' }, 'com.example.h']);
    await s.clock.advance(1);
    leaver.ws.close(1000);
    await s.clock.advance(5000);
    expect(s.router.sessions.some((x) => x.registrations.some((r) => r.procedure === 'com.example.h'))).toBe(true);
    // the old callee left by itself meanwhile: the new REGISTER goes through
    const quitter = await s.join();
    await quitter.register('com.example.i');
    quitter.ws.controls.freeze('buffer');
    const id4 = fresh.id();
    fresh.send([MSG.REGISTER, id4, { replace_orphaned_session: 'yes' }, 'com.example.i']);
    await s.clock.advance(1);
    s.router.connections.find((c) => c.number === quitter.ws.controls.number)!.controls.drop();
    await s.clock.advance(5000);
    expect(fresh.take(() => true)).toEqual([MSG.REGISTERED, id4, expect.any(Number)]);
  });

  test('the same session’s own registration is never an orphan', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.example.p');
    a.ws.controls.freeze('buffer', 'down');
    const id = a.id();
    a.send([MSG.REGISTER, id, { replace_orphaned_session: 'yes' }, 'com.example.p']);
    await s.clock.advance(0); // the router reads it while the session's own link is unresponsive
    a.ws.controls.thaw('down');
    expect(await a.reply(MSG.REGISTER, id, MSG.REGISTERED)).toEqual([
      MSG.ERROR,
      MSG.REGISTER,
      id,
      {},
      'wamp.error.procedure_already_exists',
    ]);
  });
});

describe('thruway-php: URIs, broker, payloads (T4, T7)', () => {
  test('T7: REGISTER/CALL procedures are lowercased, then checked strictly; SUBSCRIBE strictly without lowercasing; PUBLISH unchecked', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('Com.Example.Upper');
    a.autoCallee(a.received.at(-1)![2] as number, () => 'ok');
    const b = await s.join();
    expect(await b.call('COM.EXAMPLE.UPPER')).toEqual([MSG.RESULT, 1, {}, ['ok']]);
    for (const [frame, type] of [
      [[MSG.REGISTER, 10, {}, 'com.example.with-hyphen'], MSG.REGISTER],
      [[MSG.CALL, 11, {}, 'com..x'], MSG.CALL],
      [[MSG.SUBSCRIBE, 12, {}, 'Com.Example.Upper'], MSG.SUBSCRIBE],
      [[MSG.REGISTER, 13, { match: 'wildcard' }, 'com..x'], MSG.REGISTER],
    ] as const) {
      b.send(frame);
      expect(await b.reply(type, frame[1], 0)).toEqual([MSG.ERROR, type, frame[1], {}, 'wamp.error.invalid_uri']);
    }
    b.send([MSG.PUBLISH, 14, { acknowledge: true }, 'Not A Topic!']);
    expect((await b.nextOf(MSG.PUBLISHED, 14))[0]).toBe(MSG.PUBLISHED);
    for (const topic of ['com.example.', '.', ''])
      expect(await b.subscribe(topic, { match: 'prefix' })).toEqual(expect.any(Number));
  });

  test('T4: SUBSCRIBE with match wildcard (or any policy without a matcher) is never answered; prefix is by characters', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    a.send([MSG.SUBSCRIBE, 1, { match: 'wildcard' }, 'com..x']);
    a.send([MSG.SUBSCRIBE, 2, { match: '_mqtt' }, 'com.x']);
    await s.clock.advance(60_000);
    expect(a.pending).toEqual([]);
    const sub = await a.subscribe('com.pfx', { match: 'prefix' });
    const pub = await s.join();
    pub.send([MSG.PUBLISH, 1, {}, 'com.pfxzzz', ['x']]);
    expect(await a.nextOf(MSG.EVENT)).toEqual([MSG.EVENT, sub, expect.any(Number), { topic: 'com.pfxzzz' }, ['x']]);
  });

  test('prefix REGISTER is silently exact', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const reg = await a.register('com.example', { match: 'prefix' });
    expect(s.router.sessions[0]!.registrations).toEqual([{ id: reg, procedure: 'com.example', match: 'exact' }]);
    const b = await s.join();
    expect((await b.call('com.example.sub'))[4]).toBe('wamp.error.no_such_procedure');
  });

  test('eligible/exclude by session id; its own _thruway_eligible_authids/_thruway_eligible_authroles instead of the spec lists', async () => {
    const s = setup('thruway-php', {
      authenticate: (hello) => ({
        welcome: { authid: hello.details['authid'], authrole: 'user', authroles: ['user'] },
      }),
    });
    const pub = await s.join({ authid: 'pub' });
    const subs: WampPeer[] = [];
    for (const authid of ['ann', 'bob', 'cy']) {
      const p = await s.join({ authid });
      await p.subscribe('com.t');
      subs.push(p);
    }
    const [ann, bob, cy] = subs as [WampPeer, WampPeer, WampPeer];
    const idOf = (p: WampPeer): number => s.router.sessions.find((x) => x.connection === p.ws.controls.number)!.id;
    const cases: [Record<string, unknown>, WampPeer[]][] = [
      [{ eligible: [idOf(ann), idOf(bob)], exclude: [idOf(bob)] }, [ann]],
      [{ _thruway_eligible_authids: ['bob', 'cy'] }, [bob, cy]],
      [{ _thruway_eligible_authroles: ['admin', 'user'] }, [ann, bob, cy]],
      [{ _thruway_eligible_authroles: ['admin'] }, []],
      [{ _thruway_eligible_authids: 'bob' }, []], // not an array: nobody
      [{ _thruway_eligible_authids: null, _thruway_eligible_authroles: null }, [ann, bob, cy]], // null: not set (isset)
      [{ eligible_authid: ['bob'], exclude_authid: ['ann'], exclude_authrole: ['user'] }, [ann, bob, cy]], // not read
    ];
    for (const [k, [options, expected]] of cases.entries()) {
      pub.send([MSG.PUBLISH, pub.id(), options, 'com.t', [k]]);
      await settle(s);
      const got = subs.filter((p) => p.take((f) => f[0] === MSG.EVENT) !== undefined);
      expect([k, got.map((p) => subs.indexOf(p))]).toEqual([k, expected.map((p) => subs.indexOf(p))]);
    }
  });

  test('8: every SUBSCRIBE gets a new subscription id and its own EVENT copy; no publisher disclosure', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const one = await a.subscribe('com.t');
    const two = await a.subscribe('com.t');
    expect(one).not.toBe(two);
    const pub = await s.join();
    pub.send([MSG.PUBLISH, 1, { disclose_me: true }, 'com.t', ['x']]);
    await settle(s);
    expect(a.pending.map((f) => [f[1], f[3]])).toEqual([
      [one, {}],
      [two, {}],
    ]);
    a.send([MSG.UNSUBSCRIBE, 9, one]);
    await settle(s);
    pub.send([MSG.PUBLISH, 2, {}, 'com.t', ['y']]);
    await settle(s);
    expect(a.pending.filter((f) => f[0] === MSG.EVENT).map((f) => f[1])).toEqual([one, two, two]);
  });

  test('the publisher is disclosed to a subscription that asked disclose_publisher, with its auth details and the topic', async () => {
    const s = setup('thruway-php', {
      providers: [
        { method: 'ticket', extra: () => ({}), verify: () => ({ authid: 'pat', authrole: 'pub', authmethod: 'x' }) },
        { method: 'anonymous' },
      ],
    });
    const sub = await s.join();
    const plain = await sub.subscribe('com.t');
    const asked = await sub.subscribe('com.t', { disclose_publisher: true });
    const pub = await opened(s);
    pub.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket'] }]);
    await pub.nextOf(MSG.CHALLENGE);
    pub.send([MSG.AUTHENTICATE, 'ok', {}]);
    const welcome = await pub.nextOf(MSG.WELCOME);
    expect((welcome[2] as Record<string, unknown>)['authmethod']).toBe('x'); // what the provider said
    pub.send([MSG.PUBLISH, 1, { disclose_me: false }, 'com.t', ['x']]);
    await settle(s);
    expect(sub.pending.map((f) => [f[1], f[3]])).toEqual([
      [plain, {}],
      [
        asked,
        {
          publisher: welcome[1],
          topic: 'com.t',
          authid: 'pat',
          authrole: 'pub',
          publisher_authid: 'pat',
          publisher_authrole: 'pub',
          authroles: ['pub', 'authenticated_user'],
          authmethod: 'ticket', // the session's auth details (set at the HELLO), not the WELCOME's
        },
      ],
    ]);
    s.router.publish('com.t'); // the router's own publication: no publisher
    await settle(s);
    expect(sub.pending.slice(2).map((f) => f[3])).toEqual([{}, {}]);
  });

  test('empty args/kwargs are stripped when forwarded; an empty progress YIELD is a keepalive RESULT', async () => {
    const s = setup('thruway-php');
    const callee = await s.join();
    await callee.register('com.example.p');
    const caller = await s.join();
    caller.send([MSG.CALL, 1, { receive_progress: true }, 'com.example.p', [], {}]);
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv.length).toBe(4);
    callee.send([MSG.YIELD, inv[1], { progress: true }, [], {}]);
    callee.send([MSG.YIELD, inv[1], {}, [], { k: 1 }]);
    await settle(s);
    expect(caller.pending).toEqual([
      [MSG.RESULT, 1, { progress: true }],
      [MSG.RESULT, 1, {}, [], { k: 1 }],
    ]);
  });

  test('a frame over 16 MiB closes the connection with 1009', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    a.send([MSG.PUBLISH, 1, {}, 'com.t', ['x'.repeat(16 * 1024 * 1024)]]);
    await settle(s);
    expect(a.closed).toEqual({ code: 1009, reason: '', wasClean: true });
  });
});

describe('thruway-php: handshake and authentication (T5, T6)', () => {
  const cra: SimAuthProvider = {
    method: 'wampcra',
    realms: ['realm1'],
    extra: () => ({ challenge: 'cra-challenge' }),
    verify: (signature) =>
      signature === 'cra-ok' ? { authid: 'joe', authrole: 'user', authmethod: 'wampcra' } : false,
  };
  const ticket: SimAuthProvider = {
    method: 'ticket',
    realms: ['*'],
    extra: () => ({ challenge: {}, challenge_method: 'ticket' }),
    verify: (signature) => (signature === 'ticket-ok' ? { authid: 'ticketuser', authroles: ['a', 'b'] } : false),
  };

  async function hello(s: Setup, details: Record<string, unknown>, realm = 'realm1'): Promise<WampPeer> {
    const p = await opened(s);
    p.send([MSG.HELLO, realm, { roles: PEER_ROLES, ...details }]);
    await settle(s);
    return p;
  }

  test('no method covers the realm ⇒ anonymous WELCOME {roles}, whatever the HELLO offers', async () => {
    const s = setup('thruway-php', { providers: [cra] });
    for (const realm of ['other.realm', 'Realm1']) {
      const p = await hello(s, { authmethods: ['extauth'], authid: 'spoof' }, realm);
      expect(p.take(() => true)).toEqual([
        MSG.WELCOME,
        expect.any(Number),
        { roles: DIALECTS['thruway-php'].flags.roles },
      ]);
    }
    const plain = setup('thruway-php');
    const p = await hello(plain, { authmethods: ['ticket'] });
    expect(p.take(() => true)![2]).toEqual({ roles: DIALECTS['thruway-php'].flags.roles });
  });

  test('a method covers the realm but none offered (none, anonymous, wrong case) ⇒ ABORT wamp.error.not_authorized', async () => {
    const s = setup('thruway-php', { providers: [cra] });
    for (const details of [{}, { authmethods: [] }, { authmethods: ['anonymous'] }, { authmethods: ['WAMPCRA'] }]) {
      const p = await hello(s, details);
      expect(p.take(() => true)).toEqual([MSG.ABORT, {}, 'wamp.error.not_authorized']);
      expect(p.closed?.code).toBe(1000);
    }
  });

  test('T6: one CHALLENGE per matching method in provider order; AUTHENTICATE is verified by the last one (authentication_failure)', async () => {
    const s = setup('thruway-php', { providers: [cra, ticket] });
    const p = await hello(s, { authmethods: ['ticket', 'wampcra'], authid: 'joe' });
    expect(p.pending).toEqual([
      [MSG.CHALLENGE, 'wampcra', { challenge: 'cra-challenge' }],
      [MSG.CHALLENGE, 'ticket', { challenge: {}, challenge_method: 'ticket' }],
    ]);
    p.send([MSG.AUTHENTICATE, 'cra-ok', {}]); // the right answer to the first CHALLENGE: verified by ticket
    await settle(s);
    expect(p.pending.at(-1)).toEqual([MSG.ABORT, {}, 'thruway.error.authentication_failure']);
    const q = await hello(s, { authmethods: ['wampcra', 'ticket'] });
    q.send([MSG.AUTHENTICATE, 'ticket-ok', {}]);
    await settle(s);
    expect(q.pending.at(-1)).toEqual([
      MSG.WELCOME,
      expect.any(Number),
      {
        roles: DIALECTS['thruway-php'].flags.roles,
        authid: 'ticketuser',
        authrole: 'a',
        authroles: ['a', 'b', 'authenticated_user'],
      },
    ]);
  });

  test('T6: with a CHALLENGE gap the later CHALLENGEs come after it, or at once when an AUTHENTICATE arrives first (challenge.mismatch)', async () => {
    const s = setup('thruway-php', { providers: [cra, ticket], challengeGap: 49 });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['wampcra', 'ticket'] }]);
    await s.clock.advance(48);
    expect(p.pending.map((f) => f[1])).toEqual(['wampcra']);
    await s.clock.advance(1);
    expect(p.pending.map((f) => f[1])).toEqual(['wampcra', 'ticket']);
    p.send([MSG.AUTHENTICATE, 'ticket-ok', {}]);
    await settle(s);
    expect(p.pending.at(-1)![0]).toBe(MSG.WELCOME);
    const slow = setup('thruway-php', { providers: [cra, ticket], challengeGap: 200 });
    const q = await opened(slow);
    q.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['wampcra', 'ticket'] }]);
    await slow.clock.advance(10);
    q.send([MSG.AUTHENTICATE, 'cra-ok', {}]); // answers the first one before the second is sent
    await slow.clock.advance(10);
    expect(q.pending.map((f) => [f[0], f[1]])).toEqual([
      [MSG.CHALLENGE, 'wampcra'],
      [MSG.CHALLENGE, 'ticket'],
      [MSG.ABORT, {}],
    ]);
    expect(slow.clock.pendingTimers).toBe(0);
  });

  test('a session that ends before its gap is over gets no further CHALLENGE', async () => {
    const s = setup('thruway-php', { providers: [cra, ticket], challengeGap: 100 });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['wampcra', 'ticket'] }]);
    await s.clock.advance(10);
    p.ws.close(1000);
    await s.clock.advance(1000);
    expect(p.received.filter((f) => f[0] === MSG.CHALLENGE).length).toBe(1);
    expect(s.clock.pendingTimers).toBe(0);
  });

  test('T5: while challenged the session is already in the realm: PUBLISH and CALL are executed', async () => {
    const s = setup('thruway-php', { providers: [cra], strict: false });
    const p = await hello(s, { authmethods: ['wampcra'] });
    p.take(() => true);
    p.send([MSG.PUBLISH, 77, { acknowledge: true }, 'com.unauth', []]);
    p.send([MSG.CALL, 78, {}, 'wamp.session.count', []]);
    p.send([MSG.HELLO, 'realm1', {}]); // a second HELLO meanwhile: ignored
    await settle(s);
    expect(p.pending).toEqual([
      [MSG.PUBLISHED, 77, expect.any(Number)],
      [MSG.ERROR, MSG.CALL, 78, {}, 'wamp.error.no_such_procedure'],
    ]);
    p.send([MSG.AUTHENTICATE, 'cra-ok', {}]);
    await settle(s);
    const welcome = p.pending.at(-1)!;
    expect(welcome[0]).toBe(MSG.WELCOME);
    expect(s.router.sessions.map((x) => x.id)).toEqual([welcome[1]]);
  });

  test('a session challenged by the authenticate hook is in the realm too, across rounds', async () => {
    const s = setup('thruway-php', {
      authenticate: () => ({
        challenge: { method: 'ticket' },
        verify: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: { authid: 'x' } }) }),
      }),
    });
    const p = await hello(s, {});
    expect(s.router.connections[0]!.session?.welcome).toEqual({});
    p.send([MSG.AUTHENTICATE, 'one', {}]);
    await settle(s);
    const id = s.router.connections[0]!.session?.id;
    p.send([MSG.AUTHENTICATE, 'two', {}]);
    await settle(s);
    expect(p.pending.at(-1)).toEqual([MSG.WELCOME, id, { roles: DIALECTS['thruway-php'].flags.roles, authid: 'x' }]);
  });

  test('a provider registering late flips the realm from anonymous to CHALLENGE; stale ⇒ thruway.error.unknown; silent ⇒ no reply', async () => {
    const s = setup('thruway-php', { providers: [cra] });
    s.router.setProvider('wampcra', 'absent');
    expect((await hello(s, { authmethods: ['wampcra'] })).pending[0]![0]).toBe(MSG.WELCOME);
    s.router.setProvider('wampcra', 'registered');
    expect((await hello(s, { authmethods: ['wampcra'] })).pending[0]![0]).toBe(MSG.CHALLENGE);
    s.router.setProvider('wampcra', 'stale');
    expect((await hello(s, { authmethods: ['wampcra'] })).pending).toEqual([[MSG.ABORT, {}, 'thruway.error.unknown']]);
    expect((await hello(s, {})).pending).toEqual([[MSG.ABORT, {}, 'wamp.error.not_authorized']]); // still covered
    s.router.setProvider('wampcra', 'silent');
    const silent = await hello(s, { authmethods: ['wampcra'] });
    await s.clock.advance(60_000);
    expect(silent.pending).toEqual([]);
    expect(() => {
      s.router.setProvider('ticket', 'registered');
    }).toThrow(new TypeError("setProvider: no provider for 'ticket'"));
    expect(() => {
      s.router.setProvider('wampcra', 'gone' as 'absent');
    }).toThrow(new TypeError("unknown provider state 'gone'"));
  });

  test('a provider that dies or goes silent after its CHALLENGE ⇒ unknown / no answer to the AUTHENTICATE', async () => {
    const s = setup('thruway-php', { providers: [cra] });
    const p = await hello(s, { authmethods: ['wampcra'] });
    const q = await hello(s, { authmethods: ['wampcra'] });
    s.router.setProvider('wampcra', 'stale');
    p.send([MSG.AUTHENTICATE, 'cra-ok', {}]);
    await settle(s);
    expect(p.pending.at(-1)).toEqual([MSG.ABORT, {}, 'thruway.error.unknown']);
    s.router.setProvider('wampcra', 'absent');
    q.send([MSG.AUTHENTICATE, 'cra-ok', {}]);
    await s.clock.advance(60_000);
    expect(q.pending.map((f) => f[0])).toEqual([MSG.CHALLENGE]);
  });

  test('not_ready ⇒ ABORT thruway.authenticator.not_ready; no AuthenticationManager ⇒ the HELLO details come back', async () => {
    const s = setup('thruway-php', { providers: [cra], authManager: 'not_ready' });
    expect((await hello(s, { authmethods: ['wampcra'] })).pending).toEqual([
      [MSG.ABORT, {}, 'thruway.authenticator.not_ready'],
    ]);
    s.router.setAuthManager('none');
    const p = await hello(s, { authmethods: ['extauth'], authid: 'spoofed', agent: 'me' });
    expect(p.pending).toEqual([
      [
        MSG.WELCOME,
        expect.any(Number),
        {
          roles: DIALECTS['thruway-php'].flags.roles,
          authmethods: ['extauth'],
          authid: 'spoofed',
          agent: 'me',
          transport: { type: 'testing', url: s.router.url },
        },
      ],
    ]);
    s.router.setAuthManager('ok');
    expect((await hello(s, { authmethods: ['wampcra'] })).pending[0]![0]).toBe(MSG.CHALLENGE);
    expect(() => {
      s.router.setAuthManager('later' as 'ok');
    }).toThrow(new TypeError("unknown authManager 'later'"));
  });

  test('a NOCHALLENGE provider WELCOMEs with its method forced and authid defaulted; an anonymous provider admits only the rest', async () => {
    const s = setup('thruway-php', {
      providers: [
        { method: 'trusted', welcome: () => ({ authrole: 'admin' }) },
        { method: 'deny', welcome: () => false },
        { method: 'anonymous', realms: ['realm1'] },
        cra,
      ],
    });
    expect((await hello(s, { authmethods: ['trusted'] })).pending[0]).toEqual([
      MSG.WELCOME,
      expect.any(Number),
      {
        roles: DIALECTS['thruway-php'].flags.roles,
        authmethod: 'trusted',
        authrole: 'admin',
        authroles: ['admin', 'authenticated_user'],
        authid: 'authenticated_user',
      },
    ]);
    expect((await hello(s, { authmethods: ['deny'] })).pending).toEqual([
      [MSG.ABORT, {}, 'thruway.error.authentication_failure'],
    ]);
    expect((await hello(s, {})).pending[0]).toEqual([
      MSG.WELCOME,
      expect.any(Number),
      { roles: DIALECTS['thruway-php'].flags.roles },
    ]);
    expect((await hello(s, { authmethods: ['anonymous', 'wampcra'] })).pending[0]![0]).toBe(MSG.CHALLENGE);
  });

  test('6: a provider that rejects the HELLO (onhello FAILURE: an unknown authid) ⇒ ABORT authentication_failure, no CHALLENGE', async () => {
    const known: SimAuthProvider = {
      method: 'wampcra',
      extra: (h) => (h.details['authid'] === 'joe' ? { challenge: 'c' } : false),
      verify: () => ({ authid: 'joe' }),
    };
    const s = setup('thruway-php', { providers: [known] });
    const nobody = await hello(s, { authmethods: ['wampcra'], authid: 'nobody' });
    expect(nobody.pending).toEqual([[MSG.ABORT, {}, 'thruway.error.authentication_failure']]);
    expect(nobody.closed?.code).toBe(1000);
    expect((await hello(s, { authmethods: ['wampcra'], authid: 'joe' })).pending).toEqual([
      [MSG.CHALLENGE, 'wampcra', { challenge: 'c' }],
    ]);
    const spec = setup('spec', { providers: [known] });
    expect((await hello(spec, { authmethods: ['wampcra'], authid: 'x' })).pending).toEqual([
      [MSG.ABORT, {}, 'wamp.error.authentication_failed'],
    ]);
  });

  test('a provider whose extra or verify throws ABORTs authorization_failed and lands in errors', async () => {
    const boom = new Error('provider bug');
    const s = setup('thruway-php', {
      providers: [
        {
          method: 'x',
          extra: () => {
            throw boom;
          },
        },
        {
          method: 'y',
          verify: () => {
            throw boom;
          },
        },
        { method: 'z', extra: () => 'not a dict' as unknown as Record<string, unknown> },
        { method: 'w', verify: () => 'not a dict' as unknown as Record<string, unknown> },
        { method: 'v' },
      ],
    });
    for (const method of ['x', 'z']) {
      expect((await hello(s, { authmethods: [method] })).pending).toEqual([
        [MSG.ABORT, { message: 'the provider failed' }, 'wamp.error.authorization_failed'],
      ]);
    }
    for (const [method, reply] of [
      ['y', [MSG.ABORT, { message: 'the provider failed' }, 'wamp.error.authorization_failed']],
      ['w', [MSG.ABORT, { message: 'the provider failed' }, 'wamp.error.authorization_failed']],
      ['v', [MSG.ABORT, {}, 'thruway.error.authentication_failure']],
    ] as const) {
      const p = await hello(s, { authmethods: [method] });
      expect(p.pending).toEqual([[MSG.CHALLENGE, method, {}]]);
      p.send([MSG.AUTHENTICATE, 'sig', {}]);
      await settle(s);
      expect(p.pending.at(-1)).toEqual(reply);
    }
    expect(s.router.errors).toEqual([boom, boom]);
  });

  test('5: GOODBYE ⇒ [6,{},"wamp.error.goodbye_and_out"], then the router closes with 1000', async () => {
    const s = setup('thruway-php');
    const p = await s.join();
    expect(await p.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']);
    await settle(s);
    expect(p.closed).toEqual({ code: 1000, reason: '', wasClean: true });
  });

  test("—: the client's reply to the router's own GOODBYE is answered too (Realm::processGoodbye answers every GOODBYE), then the router closes; other dialects only close", async () => {
    for (const dialect of ['thruway-php', 'spec'] as const) {
      const s = setup(dialect);
      const p = await s.join();
      s.router.kill(s.router.sessions[0]!.id, 'wamp.close.killed');
      expect(await p.nextOf(MSG.GOODBYE)).toEqual([MSG.GOODBYE, {}, 'wamp.close.killed']);
      p.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
      await settle(s);
      expect([dialect, p.pending, p.closed]).toEqual([
        dialect,
        dialect === 'spec' ? [] : [[MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']],
        { code: 1000, reason: '', wasClean: true },
      ]);
      expect(s.router.violations).toEqual([]);
    }
    const s = setup('thruway-php');
    const p = await s.join();
    s.router.goodbye();
    await p.nextOf(MSG.GOODBYE);
    p.send([MSG.ABORT, {}, 'wamp.error.x']); // an ABORT instead of the reply is not answered
    await settle(s);
    expect([p.pending, p.closed?.code]).toEqual([[], 1000]);
  });

  test('11: only wamp.2.json; an upgrade offering nothing else fails', async () => {
    const s = setup('thruway-php');
    const p = await opened(s, ['wamp.2.msgpack']);
    expect(p.events).toEqual(['error', 'close:1006']);
  });
});

// =====================================================================================================================
// Crossbar 26.10.1 (test/routers/crossbar/README.md)
// =====================================================================================================================

describe('crossbar', () => {
  test('1: GOODBYE ⇒ wamp.close.normal and the socket stays open: a new HELLO starts a new session', async () => {
    const s = setup('crossbar');
    const p = await s.join();
    expect(await p.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.close.normal']);
    await settle(s);
    expect(p.closed).toBeUndefined();
    p.send([MSG.CALL, 1, {}, 'com.x']); // between sessions: ignored
    const again = await p.join();
    expect(again[0]).toBe(MSG.WELCOME);
    expect(again[1]).not.toBe(p.received[0]![1]);
    s.router.kill(again[1] as number, 'wamp.close.killed', { message: 'bye' });
    expect(await p.nextOf(MSG.GOODBYE)).toEqual([MSG.GOODBYE, { message: 'bye' }, 'wamp.close.killed']);
    p.send([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
    await settle(s);
    expect(p.closed).toBeUndefined();
    expect(s.router.connections[0]!.phase).toBe('hello');
  });

  test('2: ABORT does not close the transport; auth failures are not_authorized; AUTHENTICATE without CHALLENGE ABORTs', async () => {
    const s = setup('crossbar', {
      realms: ['realm1'],
      providers: [{ method: 'ticket', verify: () => false }],
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'nope', { roles: PEER_ROLES }]);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['anonymous'] }]);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket'] }]);
    await settle(s);
    p.send([MSG.AUTHENTICATE, 'wrong', {}]);
    p.send([MSG.AUTHENTICATE, 'early', {}]);
    await settle(s);
    expect(p.pending).toEqual([
      [MSG.ABORT, {}, 'wamp.error.no_such_realm'],
      [MSG.ABORT, {}, 'wamp.error.no_auth_method'],
      [MSG.CHALLENGE, 'ticket', {}],
      [MSG.ABORT, {}, 'wamp.error.not_authorized'],
      [MSG.ABORT, { message: 'no pending authentication' }, 'wamp.error.not_authorized'],
    ]);
    expect(p.closed).toBeUndefined();
  });

  test('3: protocol violations close with 1002 (option types too), a HELLO with a non-string realm with 1011', async () => {
    const frames: Frame[] = [
      [999, 1],
      [MSG.WELCOME, 1, {}],
      [MSG.CALL, 1],
      [MSG.CALL, -5, {}, 'com.x'],
      [MSG.CALL, 1, { receive_progress: 'yes' }, 'com.x'],
      [MSG.CALL, 1, { timeout: 1.5 }, 'com.x'],
      [MSG.PUBLISH, 1, { acknowledge: 1 }, 'com.x'],
      [MSG.SUBSCRIBE, 1, { match: 'regex' }, 'com.x'],
      [MSG.REGISTER, 1, { invoke: 'sometimes' }, 'com.x'],
      [MSG.CANCEL, 1, { mode: 'nuke' }],
      [MSG.GOODBYE, {}],
    ];
    for (const frame of frames) {
      const s = setup('crossbar');
      const p = await s.join();
      p.send(frame);
      await settle(s);
      expect([frame, p.closed]).toEqual([frame, { code: 1002, reason: 'WAMP Protocol Error', wasClean: true }]);
    }
    for (const send of ['not json', '{"a":1}', new Uint8Array([0x93])] as const) {
      const s = setup('crossbar');
      const p = await s.join();
      p.ws.send(send);
      await settle(s);
      expect(p.closed?.code).toBe(1002);
    }
    const s = setup('crossbar');
    const p = await opened(s);
    p.send([MSG.HELLO, 5, { roles: PEER_ROLES }]);
    await settle(s);
    expect(p.closed?.code).toBe(1011);
    const q = await opened(s);
    q.send([MSG.HELLO, 'realm1', { roles: {} }]);
    await settle(s);
    expect(q.closed?.code).toBe(1002);
  });

  test('8: invalid CALL/PUBLISH/REGISTER URIs close with 1011; SUBSCRIBE gets invalid_uri; wamp. is reserved for REGISTER/PUBLISH', async () => {
    for (const frame of [
      [MSG.CALL, 1, {}, 'com..bad'],
      [MSG.PUBLISH, 1, {}, 'com.bad uri'],
      [MSG.REGISTER, 1, {}, ''],
    ] as const) {
      const s = setup('crossbar');
      const p = await s.join();
      p.send(frame);
      await settle(s);
      expect(p.closed).toEqual({ code: 1011, reason: 'WAMP Internal Error', wasClean: true });
    }
    const s = setup('crossbar');
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, {}, 'com..bad']);
    p.send([MSG.REGISTER, 2, {}, 'wamp.mine']);
    p.send([MSG.PUBLISH, 3, { acknowledge: true }, 'wamp.mine']);
    p.send([MSG.PUBLISH, 4, {}, 'wamp.mine']);
    p.send([MSG.SUBSCRIBE, 5, {}, 'wamp.session.on_join']);
    await settle(s);
    expect(p.pending).toEqual([
      [MSG.ERROR, MSG.SUBSCRIBE, 1, {}, 'wamp.error.invalid_uri'],
      [MSG.ERROR, MSG.REGISTER, 2, {}, 'wamp.error.invalid_uri'],
      [MSG.ERROR, MSG.PUBLISH, 3, {}, 'wamp.error.invalid_uri'],
      [MSG.SUBSCRIBED, 5, expect.any(Number)],
    ]);
  });

  test('7/12: skip hangs; kill answers canceled (no args) once the callee answered; INTERRUPT carries the mode', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(2, 'com.p'));
    const [one, two] = [await callee.nextOf(MSG.INVOCATION), await callee.nextOf(MSG.INVOCATION)];
    caller.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    caller.send([MSG.CANCEL, 2, {}]); // no mode: kill
    await settle(s);
    expect(callee.pending).toEqual([[MSG.INTERRUPT, two[1], { mode: 'kill' }]]);
    callee.send([MSG.YIELD, one[1], {}, ['late']]);
    callee.send([MSG.ERROR, MSG.INVOCATION, two[1], {}, 'wamp.error.canceled', ['callee says canceled']]);
    await s.clock.advance(10_000);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.canceled']]);
  });

  test('6: CALL timeout in seconds (forwarded to the callee) ⇒ canceled ["timeout reached"] and INTERRUPT killnowait', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, { timeout: 2 }));
    await s.clock.advance(0);
    const inv = callee.take((f) => f[0] === MSG.INVOCATION)!;
    expect(inv[3]).toEqual({
      timeout: 2,
      caller: caller.received[0]![1],
      caller_authid: `anonymous-${String(caller.received[0]![1])}`,
      caller_authrole: 'anonymous',
    });
    await s.clock.advance(1999);
    expect(caller.pending).toEqual([]);
    await s.clock.advance(1);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled', ['timeout reached']]]);
    expect(callee.pending).toEqual([[MSG.INTERRUPT, inv[1], { mode: 'killnowait' }]]);
    callee.send([MSG.YIELD, inv[1], {}, ['late']]);
    await settle(s);
    expect(caller.pending.length).toBe(1);
  });

  test('a call settled before its timeout leaves no timer behind', async () => {
    const s = setup('crossbar');
    s.router.procedure('com.fast', () => 'ok');
    const p = await s.join();
    expect(await p.call('com.fast', undefined, undefined, { timeout: 10 })).toEqual([MSG.RESULT, 1, {}, ['ok']]);
    expect(s.clock.scope('router').pendingTimers).toBe(0);
  });

  test('a timeout of a scripted procedure answers the caller and unsubscribes the handler', async () => {
    const s = setup('crossbar');
    let unsubscribed = 0;
    s.router.procedure('com.never', () => ({
      subscribe: () => ({
        unsubscribe: () => {
          unsubscribed++;
        },
      }),
    }));
    const p = await s.join();
    p.send(callFrame(1, 'com.never', undefined, undefined, { timeout: 1 }));
    await s.clock.advance(1000);
    expect(p.pending).toEqual([[MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled', ['timeout reached']]]);
    expect(unsubscribed).toBe(1);
  });

  test('—: one subscription id per topic+match for every session; one UNSUBSCRIBE removes only that session; a new id once all left', async () => {
    const s = setup('crossbar');
    const a = await s.join();
    const b = await s.join();
    const ida = await a.subscribe('com.t');
    expect(await a.subscribe('com.t')).toBe(ida);
    expect(await b.subscribe('com.t')).toBe(ida);
    expect(await b.subscribe('com.t', { match: 'prefix' })).not.toBe(ida);
    a.send([MSG.UNSUBSCRIBE, 9, ida]);
    await settle(s);
    const pub = await s.join();
    pub.send([MSG.PUBLISH, 1, {}, 'com.t', []]);
    await settle(s);
    expect(a.pending.filter((f) => f[0] === MSG.EVENT)).toEqual([]);
    expect(b.pending.filter((f) => f[0] === MSG.EVENT).map((f) => f[1])).toContain(ida);
    b.ws.close(1000);
    await settle(s);
    expect(await a.subscribe('com.t')).not.toBe(ida);
  });

  test('disclosure: caller and callee in INVOCATION/RESULT, publisher in EVENT, always with authid and authrole; PUBLISHED before the self EVENT', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    callee.autoCallee(callee.received.at(-1)![2] as number, () => 'r');
    const caller = await s.join();
    const result = await caller.call('com.p');
    const ids = [callee.received[0]![1], caller.received[0]![1]];
    expect(result).toEqual([
      MSG.RESULT,
      1,
      { callee: ids[0], callee_authid: `anonymous-${String(ids[0])}`, callee_authrole: 'anonymous' },
      ['r'],
    ]);
    await caller.subscribe('com.t');
    caller.send([MSG.PUBLISH, 5, { acknowledge: true, exclude_me: false }, 'com.t']);
    await settle(s);
    expect(caller.pending).toEqual([
      [MSG.PUBLISHED, 5, expect.any(Number)],
      [
        MSG.EVENT,
        expect.any(Number),
        expect.any(Number),
        { publisher: ids[1], publisher_authid: `anonymous-${String(ids[1])}`, publisher_authrole: 'anonymous' },
      ],
    ]);
  });

  test('12/8: a callee leaving ⇒ canceled ["callee disconnected from in-flight request"]; an invalid callee error URI closes the callee with 1011', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'not a uri!']);
    await settle(s);
    expect(callee.closed?.code).toBe(1011);
    expect(caller.pending).toEqual([
      [MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled', ['callee disconnected from in-flight request']],
    ]);
  });

  test('callee ERROR details are not forwarded; a YIELD for another session’s INVOCATION closes the connection with 1002', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(2, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    const inv2 = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], { extra: 1 }, 'com.error', ['bad'], { why: 'x' }]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'com.error', ['bad'], { why: 'x' }]);
    const thief = await s.join();
    thief.send([MSG.YIELD, inv2[1], {}, ['stolen']]);
    thief.send([MSG.YIELD, 424242, {}, []]); // not anyone's: ignored (the socket is already closing)
    await settle(s);
    expect(thief.closed?.code).toBe(1002);
    expect(caller.pending).toEqual([]);
  });

  test('5/subprotocols: unrequested progress is forwarded; the client’s subprotocol order wins, batched variants too, none ⇒ rejected', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p']]);
    await settle(s);
    expect(caller.pending[0]![2]).toEqual(expect.objectContaining({ progress: true }));
    for (const [protocols, events] of [
      [['wamp.2.msgpack', 'wamp.2.json'], ['open']],
      [['wamp.2.json.batched'], ['open']],
      [[], ['error', 'close:1006']],
      [['wamp.2.ubjson'], ['error', 'close:1006']],
    ] as const) {
      const p = await opened(s, [...protocols]);
      expect([protocols, p.events]).toEqual([protocols, events]);
      if (protocols.length > 0 && events.length === 1) expect(p.ws.protocol).toBe(protocols[0]);
    }
  });

  test('a mismatched invoke policy is procedure_exists_with_different_invocation_policy; shared callees share one id', async () => {
    const s = setup('crossbar');
    const a = await s.join();
    const b = await s.join();
    const id = await a.register('com.rr', { invoke: 'roundrobin' });
    expect(await b.register('com.rr', { invoke: 'roundrobin' })).toBe(id);
    const c = await s.join();
    c.send([MSG.REGISTER, 1, { invoke: 'random' }, 'com.rr']);
    expect(await c.nextOf(MSG.ERROR)).toEqual([
      MSG.ERROR,
      MSG.REGISTER,
      1,
      {},
      'wamp.error.procedure_exists_with_different_invocation_policy',
    ]);
  });
});

// =====================================================================================================================
// Nexus (test/routers/nexus/README.md)
// =====================================================================================================================

describe('nexus', () => {
  test('closing frames are lost: a GOODBYE reply, ABORTs and the router’s GOODBYE arrive as a bare 1006', async () => {
    const s = setup('nexus', { realms: ['realm1'] });
    const a = await s.join();
    a.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await settle(s);
    expect([a.pending, a.closed]).toEqual([[], { code: 1006, reason: '', wasClean: false }]);
    const b = await opened(s);
    b.send([MSG.HELLO, 'nope', { roles: PEER_ROLES }]);
    await settle(s);
    expect([b.pending, b.closed?.code]).toEqual([[], 1006]);
    const c = await s.join();
    s.router.goodbye();
    await settle(s);
    expect([c.pending, c.closed?.code]).toEqual([[], 1006]);
    expect(s.router.sessions).toEqual([]);
  });

  test('strict_ids: requests must be 1, 2, 3, … across types (a CALL continuing one in flight excepted); a break kills the session', async () => {
    const s = setup('nexus', { quirks: { strict_ids: true } });
    const a = await s.join();
    await a.subscribe('com.t'); // 1
    await a.register('com.p'); // 2
    a.send(callFrame(3, 'com.p'));
    a.send(callFrame(3, 'com.p')); // a continuation of 3
    await settle(s);
    expect(a.pending.filter((f) => f[0] === MSG.INVOCATION).length).toBe(2);
    a.send([MSG.CANCEL, 3, {}]); // not a request
    a.send([MSG.PUBLISH, 5, {}, 'com.t']); // 4 expected
    await settle(s);
    expect(a.closed?.code).toBe(1006);
    expect(s.router.sessions).toEqual([]);
  });

  test('a CALL with an id in flight is a progressive continuation: invoked again, answered once; INTERRUPT carries mode and reason', async () => {
    const s = setup('nexus');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(7, 'com.p', ['a']));
    caller.send(callFrame(7, 'com.p', ['b']));
    const [one, two] = [await callee.nextOf(MSG.INVOCATION), await callee.nextOf(MSG.INVOCATION)];
    callee.send([MSG.YIELD, two[1], {}, ['b']]);
    callee.send([MSG.YIELD, one[1], {}, ['a']]);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.RESULT, 7, {}, ['b']]]);
    caller.take(() => true);
    caller.send(callFrame(8, 'com.p'));
    const three = await callee.nextOf(MSG.INVOCATION);
    caller.send([MSG.CANCEL, 8, { mode: 'kill' }]);
    expect(await callee.nextOf(MSG.INTERRUPT)).toEqual([
      MSG.INTERRUPT,
      three[1],
      { reason: 'wamp.error.canceled', mode: 'kill' },
    ]);
  });

  test('a continuation of a call whose procedure was unregistered meanwhile invokes nothing (the router never fails)', async () => {
    const s = setup('nexus');
    const callee = await s.join();
    const reg = await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(7, 'com.p', ['a']));
    const one = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.UNREGISTER, callee.id(), reg]);
    await callee.nextOf(MSG.UNREGISTERED);
    caller.send(callFrame(7, 'com.p', ['b']));
    await settle(s);
    expect(callee.pending).toEqual([]);
    callee.send([MSG.YIELD, one[1], {}, ['a']]); // the invocation outlives its registration
    expect(await caller.nextOf(MSG.RESULT)).toEqual([MSG.RESULT, 7, {}, ['a']]);
  });

  test('a CALL timeout in milliseconds ⇒ INTERRUPT, then ERROR wamp.error.timeout', async () => {
    const s = setup('nexus');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, { timeout: 500 }));
    const inv = await callee.nextOf(MSG.INVOCATION);
    await s.clock.advance(500);
    expect(callee.pending).toEqual([[MSG.INTERRUPT, inv[1], { reason: 'wamp.error.timeout', mode: 'killnowait' }]]);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.timeout']]);
  });

  test('violations drop the connection (1006); a binary frame is read as JSON; no subprotocol is accepted with protocol ""', async () => {
    const s = setup('nexus');
    for (const act of [
      (p: WampPeer) => {
        p.send([MSG.HELLO, 'realm1', {}]);
      },
      (p: WampPeer) => {
        p.send([MSG.CALL, 1, {}, 'x']);
      },
    ]) {
      const p = await opened(s);
      act(p);
      await settle(s);
      expect(p.closed?.code).toBe(1006);
    }
    const a = await s.join();
    a.ws.send(new TextEncoder().encode(JSON.stringify([MSG.CALL, 1, {}, 'x.y', []])));
    expect((await a.nextOf(MSG.ERROR))[4]).toBe('wamp.error.no_such_procedure');
    const none = await opened(s, []);
    expect([none.events, none.ws.protocol]).toEqual([['open'], '']);
  });

  test("subprotocol order 'router' (3.3.1): the router's preference wins over the client's", async () => {
    const s = setup('nexus', { quirks: { subprotocol_order: 'router' } });
    const p = await opened(s, ['wamp.2.cbor', 'wamp.2.json']);
    expect(p.ws.protocol).toBe('wamp.2.json');
  });
});

// =====================================================================================================================
// Bondy (test/routers/bondy/README.md)
// =====================================================================================================================

describe('bondy', () => {
  test('CANCEL without mode ⇒ ERROR(49, canceled, ["call_cancelled"]) and no INTERRUPT; with a mode ⇒ internal_error, the call goes on', async () => {
    const s = setup('bondy');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(2, 'com.p'));
    const [, two] = [await callee.nextOf(MSG.INVOCATION), await callee.nextOf(MSG.INVOCATION)];
    caller.send([MSG.CANCEL, 1, {}]);
    caller.send([MSG.CANCEL, 2, { mode: 'killnowait' }]);
    await settle(s);
    expect(caller.pending).toEqual([
      [MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.canceled', ['call_cancelled']],
      [MSG.ERROR, MSG.CANCEL, 2, {}, 'bondy.error.internal_error'],
    ]);
    expect(callee.pending).toEqual([]);
    callee.send([MSG.YIELD, two[1], {}, ['late']]);
    expect(await caller.nextOf(MSG.RESULT)).toEqual([MSG.RESULT, 2, {}, ['late']]);
  });

  test('no progressive results: receive_progress is not forwarded; the first progress YIELD becomes the final RESULT', async () => {
    const s = setup('bondy');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, { receive_progress: true }));
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv[3]).toEqual({
      caller: caller.received[0]![1],
      caller_authid: `anonymous-${String(caller.received[0]![1])}`,
      caller_authrole: 'anonymous',
    });
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p2']]);
    callee.send([MSG.YIELD, inv[1], {}, ['done']]);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.RESULT, 1, {}, ['p1']]]);
  });

  test('UNSUBSCRIBE of an unknown id closes with 1011; violations ABORT (internal_error for bad JSON) then 1005; binary frames are dropped', async () => {
    const s = setup('bondy');
    const a = await s.join();
    a.send([MSG.UNSUBSCRIBE, 1, 424242]);
    await settle(s);
    expect(a.closed?.code).toBe(1011);
    const b = await s.join();
    b.ws.send(new TextEncoder().encode(JSON.stringify([MSG.CALL, 1, {}, 'x', []])));
    b.ws.send('{bad');
    await settle(s);
    expect([b.pending, b.closed?.code]).toEqual([[[MSG.ABORT, {}, 'bondy.error.internal_error']], 1005]);
    const c = await opened(s);
    c.send([MSG.HELLO, 'realm1', {}]);
    await settle(s);
    expect([c.pending, c.closed?.code]).toEqual([[[MSG.ABORT, {}, 'wamp.error.protocol_violation']], 1005]);
  });

  test('anonymous fallback: a HELLO without authid gets an anonymous WELCOME whatever it offers; WELCOME carries agent and Bondy’s authprovider', async () => {
    const s = setup('bondy', { providers: [{ method: 'password', verify: () => ({ authid: 'u' }) }] });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['password'] }]);
    await settle(s);
    const welcome = p.take(() => true)!;
    expect(welcome[2]).toEqual({
      agent: 'LEAPSIGHT-BONDY-1.0.0-rc.65',
      realm: 'realm1',
      authid: `anonymous-${String(welcome[1])}`,
      authrole: 'anonymous',
      authmethod: 'anonymous',
      authprovider: 'com.leapsight.bondy',
      roles: DIALECTS.bondy.flags.roles,
    });
    const q = await opened(s);
    q.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['password'], authid: 'u' }]);
    await settle(s);
    expect(q.pending).toEqual([[MSG.CHALLENGE, 'password', {}]]);
  });

  test('exclude_me ignored; an eligible list reaches nobody, an exclude list is ignored; EVENT before PUBLISHED', async () => {
    const s = setup('bondy');
    const a = await s.join();
    const b = await s.join();
    await a.subscribe('com.t');
    await b.subscribe('com.t');
    a.send([MSG.PUBLISH, 1, { acknowledge: true }, 'com.t', ['self']]);
    a.send([MSG.PUBLISH, 2, { eligible: [b.received[0]![1]] }, 'com.t', ['eligible']]);
    a.send([MSG.PUBLISH, 3, { exclude: [b.received[0]![1]] }, 'com.t', ['exclude']]);
    await settle(s);
    expect(a.pending.map((f) => (f[0] === MSG.EVENT ? f[4] : f[0]))).toEqual([['self'], MSG.PUBLISHED, ['exclude']]);
    expect(b.pending.map((f) => f[4])).toEqual([['self'], ['exclude']]);
    expect(a.pending[0]![3]).toEqual({
      publisher: a.received[0]![1],
      publisher_authid: `anonymous-${String(a.received[0]![1])}`,
      publisher_authrole: 'anonymous',
    });
  });

  test('GOODBYE reply with a message, then close 1005; a timeout is coarse and sends no INTERRUPT; a callee leaving ⇒ no_eligible_callee', async () => {
    const s = setup('bondy');
    const p = await s.join();
    expect(await p.goodbye()).toEqual([
      MSG.GOODBYE,
      { message: 'Session closed by client.' },
      'wamp.close.goodbye_and_out',
    ]);
    await settle(s);
    expect(p.closed?.code).toBe(1005);
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, { timeout: 500 }));
    caller.send(callFrame(2, 'com.p'));
    await s.clock.advance(0);
    const inv = callee.take((f) => f[0] === MSG.INVOCATION)!;
    await s.clock.advance(1199);
    expect(caller.pending).toEqual([]);
    await s.clock.advance(1);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.timeout']);
    callee.send([MSG.YIELD, inv[1], {}, []]); // late: dropped
    callee.ws.close(1000);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.no_eligible_callee']]);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT)).toEqual([]);
  });

  test('a message over 4 MB closes with 1009', async () => {
    const s = setup('bondy');
    const p = await s.join();
    p.send([MSG.PUBLISH, 1, {}, 'com.t', ['x'.repeat(4 * 1024 * 1024)]]);
    await settle(s);
    expect(p.closed?.code).toBe(1009);
  });
});

// =====================================================================================================================
// fox-wamp 0.7.28 (test/routers/fox-wamp/README.md)
// =====================================================================================================================

describe('fox-wamp', () => {
  test('a realm name outside [a-z0-9_]+ gets no answer; request id 0 neither', async () => {
    const s = setup('fox-wamp');
    const p = await opened(s);
    p.send([MSG.HELLO, 'Bad Realm!', { roles: PEER_ROLES }]);
    await s.clock.advance(60_000);
    expect([p.pending, p.closed]).toEqual([[], undefined]);
    const a = await s.join();
    a.send([MSG.CALL, 0, {}, 'com.x']);
    await settle(s);
    expect(a.pending).toEqual([]);
  });

  test('before HELLO and while challenged requests are answered ERROR not_authorized [""]; one CHALLENGE, for the router’s first method', async () => {
    const s = setup('fox-wamp', {
      providers: [
        { method: 'wampcra', extra: () => ({ challenge: 'c' }), verify: () => false },
        { method: 'ticket', verify: () => ({ authid: 't' }) },
      ],
    });
    const p = await opened(s);
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.t']);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket', 'wampcra'] }]);
    await settle(s);
    p.send([MSG.PUBLISH, 2, { acknowledge: true }, 'com.t']);
    p.send([MSG.GOODBYE, {}, 'x']); // not a request: ignored
    p.send([MSG.AUTHENTICATE, 'wrong', {}]);
    await settle(s);
    expect(p.pending).toEqual([
      [MSG.ERROR, MSG.SUBSCRIBE, 1, {}, 'wamp.error.not_authorized', ['']],
      [MSG.CHALLENGE, 'wampcra', { challenge: 'c' }],
      [MSG.ERROR, MSG.PUBLISH, 2, {}, 'wamp.error.not_authorized', ['']],
      [MSG.ABORT, {}, 'wamp.error.authentication_failed'],
    ]);
  });

  test('CANCEL is ignored; a callee leaving leaves the caller hanging; callee errors become callee_failure [uri]', async () => {
    const s = setup('fox-wamp');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(2, 'com.p'));
    const [one] = [await callee.nextOf(MSG.INVOCATION), await callee.nextOf(MSG.INVOCATION)];
    caller.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await settle(s);
    expect([callee.pending, caller.pending]).toEqual([[], []]);
    callee.send([MSG.ERROR, MSG.INVOCATION, one[1], { x: 1 }, 'app.error.custom', ['a1']]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([
      MSG.ERROR,
      MSG.CALL,
      1,
      {},
      'wamp.error.callee_failure',
      ['app.error.custom'],
    ]);
    callee.ws.close(1000);
    await s.clock.advance(60_000);
    expect(caller.pending).toEqual([]);
  });

  test('payloads: args [] / [null] / absent ⇒ null, [[x]] ⇒ [x], kwargs {} in INVOCATION and null in RESULT and EVENT', async () => {
    const s = setup('fox-wamp');
    const callee = await s.join();
    await callee.register('com.echo');
    const caller = await s.join();
    for (const tail of [[], [[null]], [[[1, 2]]], [[1], { k: 1 }]])
      caller.send([MSG.CALL, caller.id(), {}, 'com.echo', ...tail]);
    await settle(s);
    const invs = callee.pending.filter((f) => f[0] === MSG.INVOCATION);
    expect(invs.map((f) => f.slice(4))).toEqual([
      [null, {}],
      [null, {}],
      [[1, 2], {}],
      [[1], { k: 1 }],
    ]);
    callee.send([MSG.YIELD, invs[0]![1], {}, ['r']]);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.RESULT, 1, {}, ['r'], null]]);
  });

  test('every REGISTER is accepted, with its own id, and the first callee gets every call; match and invoke are ignored', async () => {
    const s = setup('fox-wamp');
    const a = await s.join();
    const b = await s.join();
    const ra = await a.register('com.p', { invoke: 'roundrobin' });
    const rb = await b.register('com.p', { match: 'prefix' });
    expect(ra).not.toBe(rb);
    a.autoCallee(ra, () => 'a');
    b.autoCallee(rb, () => 'b');
    const c = await s.join();
    for (let i = 0; i < 3; i++) expect((await c.call('com.p'))[3]).toEqual(['a']);
  });

  test('MQTT-style * and # in exact topics; details carry the topic and the publisher; eligible/exclude ignored', async () => {
    const s = setup('fox-wamp');
    const sub = await s.join();
    await sub.subscribe('com.*.s');
    await sub.subscribe('com.h.#');
    const pub = await s.join();
    for (const topic of ['com.a.s', 'com.a.b.s', 'com.h', 'com.h.x.y'])
      pub.send([MSG.PUBLISH, pub.id(), { exclude: [sub.received[0]![1]] }, topic, [topic]]);
    await settle(s);
    expect(sub.pending.filter((f) => f[0] === MSG.EVENT).map((f) => [f[3], f[4]])).toEqual([
      [{ topic: 'com.a.s', publisher: pub.received[0]![1] }, ['com.a.s']],
      [{ topic: 'com.h', publisher: pub.received[0]![1] }, ['com.h']],
      [{ topic: 'com.h.x.y', publisher: pub.received[0]![1] }, ['com.h.x.y']],
    ]);
  });

  test('violations close with 1002/1003; GOODBYE ⇒ legacy reply and close 1000 "Server closed WAMP session"', async () => {
    const s = setup('fox-wamp');
    for (const [send, code] of [
      [[MSG.HELLO, 'realm1', {}], 1002],
      [[999], 1003],
      ['nope', 1003],
    ] as const) {
      const p = await s.join();
      if (typeof send === 'string') p.ws.send(send);
      else p.send(send);
      await settle(s);
      expect(p.closed?.code).toBe(code);
    }
    const p = await s.join();
    expect(await p.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']);
    await settle(s);
    expect(p.closed).toEqual({ code: 1000, reason: 'Server closed WAMP session', wasClean: true });
  });
});

// =====================================================================================================================
// wamp-server 0.0.9, the hostile router (test/routers/wamp-server/README.md)
// =====================================================================================================================

describe('wamp-server', () => {
  test('any CANCEL, also for an unknown call, ends the caller’s session with GOODBYE + 1005', async () => {
    for (const known of [true, false]) {
      const s = setup('wamp-server');
      s.router.procedure('com.never', () => new Promise(() => undefined));
      const p = await s.join();
      if (known) p.send(callFrame(1, 'com.never'));
      p.send([MSG.CANCEL, 1, { mode: 'kill' }]);
      await settle(s);
      expect([p.pending, p.closed?.code]).toEqual([[[MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']], 1005]);
    }
  });

  test('an acknowledged PUBLISH that reaches nobody is never acknowledged; EVENTs carry the realm’s first subscription id as publication', async () => {
    const s = setup('wamp-server');
    const a = await s.join();
    a.send([MSG.PUBLISH, 1, { acknowledge: true }, 'com.t']);
    await settle(s);
    expect(a.pending).toEqual([]);
    const first = await a.subscribe('com.t');
    const b = await s.join();
    const mine = await b.subscribe('com.t');
    const again = await b.subscribe('com.t');
    b.send([MSG.PUBLISH, 2, { acknowledge: true, exclude_me: false }, 'com.t', ['x']]);
    await settle(s);
    expect(a.pending).toEqual([[MSG.EVENT, first, first, { topic: 'com.t' }, ['x'], null]]);
    expect(b.pending.filter((f) => f[0] === MSG.EVENT)).toEqual([]); // the publisher is always excluded
    expect(again).not.toBe(mine);
    a.ws.close(1000);
    await settle(s);
    const c = await s.join();
    c.send([MSG.PUBLISH, 3, {}, 'com.t', ['y']]);
    await settle(s);
    // the realm's first subscription id of the topic stays while anyone subscribes to it
    expect(b.pending.filter((f) => f[0] === MSG.EVENT)).toEqual([
      [MSG.EVENT, mine, first, { topic: 'com.t' }, ['y'], null],
      [MSG.EVENT, mine, first, { topic: 'com.t' }, ['y'], null],
    ]);
  });

  test('ABORT fields swapped with its roles as details, the socket kept open; a second HELLO gets a second WELCOME', async () => {
    const s = setup('wamp-server', { realms: ['realm1'] });
    const p = await opened(s);
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.t']);
    p.send([MSG.HELLO, 'Bad Realm!', { roles: PEER_ROLES }]);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await settle(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await settle(s);
    const roles = { roles: { broker: {}, dealer: {} } };
    expect(p.pending).toEqual([
      [MSG.ABORT, 'wamp.error.no_such_realm', roles],
      [MSG.ABORT, 'wamp.error.no_such_realm', roles],
      [MSG.WELCOME, expect.any(Number), roles],
      [MSG.WELCOME, expect.any(Number), roles],
    ]);
    expect(p.closed).toBeUndefined();
  });

  test('invalid input ⇒ GOODBYE + close 1005; UNREGISTER/UNSUBSCRIBE of unknown ids are never answered', async () => {
    const s = setup('wamp-server');
    const a = await s.join();
    a.send([MSG.UNREGISTER, 1, 424242]);
    a.send([MSG.UNSUBSCRIBE, 2, 424242]);
    await s.clock.advance(60_000);
    expect(a.pending).toEqual([]);
    a.send([999]);
    await settle(s);
    expect([a.pending, a.closed?.code]).toEqual([[[MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']], 1005]);
  });

  test('INVOCATION details are the CALL options; callee ERRORs are never forwarded; callees leaving leave callers hanging; no shared registration', async () => {
    const s = setup('wamp-server');
    const callee = await s.join();
    await callee.register('com.p');
    const other = await s.join();
    other.send([MSG.REGISTER, 1, { invoke: 'roundrobin' }, 'com.p']);
    expect(await other.nextOf(MSG.ERROR)).toEqual([
      MSG.ERROR,
      MSG.REGISTER,
      1,
      {},
      'wamp.error.procedure_already_exists',
      null,
    ]);
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, { disclose_me: true, receive_progress: true }));
    caller.send(callFrame(2, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv).toEqual([MSG.INVOCATION, inv[1], inv[2], { disclose_me: true, receive_progress: true }, null, null]);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'app.error']);
    callee.ws.close(1000);
    await s.clock.advance(60_000);
    expect(caller.pending).toEqual([]);
  });
});

// =====================================================================================================================
// Corner cases of the flags
// =====================================================================================================================

describe('corner cases', () => {
  test('strip-empty keeps the [] placeholder before kwargs when args are absent or null', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send([MSG.CALL, 1, {}, 'com.p', null, { k: 1 }]);
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv.slice(4)).toEqual([[], { k: 1 }]);
  });

  test('a session challenged before its WELCOME is not among the established sessions', async () => {
    const s = setup('thruway-php', {
      authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }),
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await settle(s);
    expect(s.router.connections[0]!.session?.alive).toBe(true);
    expect(s.router.sessions).toEqual([]);
  });

  test('without a clock, router timers (CHALLENGE gaps) run on the host timers', async () => {
    const router = createRouter({
      dialect: 'thruway-php',
      challengeGap: 5,
      providers: [
        { method: 'a', verify: () => false },
        { method: 'b', verify: () => false },
      ],
    });
    const peer = new WampPeer(router.WebSocket, router.url, () => new Promise((resolve) => setTimeout(resolve, 20)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    peer.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['a', 'b'] }]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(peer.pending.map((f) => f[1])).toEqual(['a']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.pending.map((f) => f[1])).toEqual(['a', 'b']);
  });

  test('reactions: a close without reason closes with ""; an error reaction answers requests only', async () => {
    const s = setup('fox-wamp', {
      quirks: {
        violations: {
          ...DIALECTS['fox-wamp'].flags.violations,
          'unknown-type': { close: 4000 },
          'invalid-json': { error: 'x' },
        },
      },
    });
    const a = await s.join();
    a.send([999]);
    await settle(s);
    expect(a.closed).toEqual({ code: 4000, reason: '', wasClean: true });
    const b = await opened(s);
    b.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']); // before HELLO, not a request: nothing
    b.ws.send('nope'); // an error reaction to a frame that is not even JSON: nothing
    await settle(s);
    expect([b.pending, b.closed]).toEqual([[], undefined]);
  });

  test('Thruway reads only string invoke values (others are single); fox-wamp ignores a CANCEL with id 0', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.p', { invoke: 5 });
    const b = await s.join();
    b.send([MSG.REGISTER, 1, { invoke: 5 }, 'com.p']);
    expect((await b.nextOf(MSG.ERROR))[4]).toBe('wamp.error.procedure_already_exists');
    const f = setup('fox-wamp');
    const p = await f.join();
    p.send([MSG.CANCEL, 0, {}]);
    await settle(f);
    expect([p.pending, f.router.violations.map((v) => v.code)]).toEqual([[], ['malformed']]);
  });

  test('two sessions replacing one orphan: the first gets it, the second procedure_already_exists', async () => {
    const s = setup('thruway-php');
    const old = await s.join();
    await old.register('com.p');
    old.ws.controls.vanish();
    const one = await s.join();
    const two = await s.join();
    one.send([MSG.REGISTER, 1, { replace_orphaned_session: 'yes' }, 'com.p']);
    two.send([MSG.REGISTER, 1, { replace_orphaned_session: 'yes' }, 'com.p']);
    await s.clock.advance(5000);
    expect(one.pending.map((f) => f[0])).toEqual([MSG.REGISTERED]);
    expect(two.pending).toEqual([[MSG.ERROR, MSG.REGISTER, 1, {}, 'wamp.error.procedure_already_exists']]);
  });

  test("Crossbar's skip on a scripted procedure: the caller is never answered", async () => {
    const s = setup('crossbar');
    s.router.procedure('com.slow', () => new Promise((resolve) => setTimeout(resolve, 0, 'late')));
    const p = await s.join();
    p.send(callFrame(1, 'com.slow'));
    p.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    await settle(s);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await settle(s);
    expect(p.pending).toEqual([]);
  });
});

/** The router's view of a peer's session (established, or pre-WELCOME under `pre_auth_frames: 'route'`). */
function sessionOf(s: Setup, p: WampPeer): SimSession | undefined {
  return s.router.connections.find((c) => c.number === p.ws.controls.number)?.session;
}

const INVOCATIONS = (p: WampPeer): Frame[] => p.pending.filter((f) => f[0] === MSG.INVOCATION);

describe('handshake details', () => {
  test('an AUTHENTICATE before HELLO is a before-hello violation (spec: ignored), not an authentication failure', async () => {
    const s = setup('spec');
    const p = await opened(s);
    p.send([MSG.AUTHENTICATE, 'early', {}]);
    await settle(s);
    expect(p.pending).toEqual([]);
    expect((await p.join())[0]).toBe(MSG.WELCOME);
  });

  test('during a CHALLENGE: a non-string signature and requests are ignored (spec), the next AUTHENTICATE decides', async () => {
    const signatures: unknown[] = [];
    const s = setup('spec', {
      authenticate: () => ({
        challenge: { method: 'ticket' },
        verify: (signature) => {
          signatures.push(signature);
          return { welcome: {} };
        },
      }),
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await p.nextOf(MSG.CHALLENGE);
    p.send([MSG.AUTHENTICATE, 42, {}]);
    p.send(callFrame(1, 'com.x'));
    await settle(s);
    expect(p.pending).toEqual([]);
    p.send([MSG.AUTHENTICATE, 'ok', {}]);
    expect((await p.nextOf(MSG.WELCOME))[0]).toBe(MSG.WELCOME);
    expect(signatures).toEqual(['ok']);
  });

  test("the client's ABORT during a CHALLENGE keeps the socket of a router without abort_close open (wamp-server)", async () => {
    const s = setup('wamp-server', {
      authenticate: () => ({ challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) }),
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await p.nextOf(MSG.CHALLENGE);
    p.send([MSG.ABORT, {}, 'wamp.close.close_realm']);
    await settle(s);
    expect(p.closed).toBeUndefined();
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    expect((await p.nextOf(MSG.CHALLENGE))[1]).toBe('ticket');
  });

  test('providers: [] is no provider at all: every HELLO is welcomed anonymously, whatever it offers', async () => {
    const s = setup('spec', { providers: [] });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket'] }]);
    expect((await p.nextOf(MSG.WELCOME))[2]).toEqual(expect.objectContaining({ authmethod: 'anonymous' }));
  });

  test('authmethods that are not strings are no offer: the HELLO offers anonymous', async () => {
    const s = setup('spec', { providers: [{ method: 'anonymous' }] });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: [5] }]);
    expect((await p.nextOf(MSG.WELCOME))[2]).toEqual(expect.objectContaining({ authmethod: 'anonymous' }));
  });

  test('two providers for one method are refused', () => {
    expect(() => createRouter({ providers: [{ method: 'ticket' }, { method: 'ticket' }] })).toThrow(
      new TypeError("testing router: two providers for 'ticket'"),
    );
  });

  test("pre_auth_frames 'route': the session joins the realm at the first CHALLENGE and stays the same through more rounds", async () => {
    const s = setup('thruway-php', {
      authenticate: (hello) =>
        hello.details['authid'] === 'joe'
          ? {
              challenge: { method: 'a' },
              verify: () => ({ challenge: { method: 'b' }, verify: () => ({ welcome: {} }) }),
            }
          : { welcome: {} },
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authid: 'joe' }]);
    await p.nextOf(MSG.CHALLENGE);
    const early = sessionOf(s, p)?.id;
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.t']);
    await p.nextOf(MSG.SUBSCRIBED);
    s.router.publish('com.t', ['during']);
    expect((await p.nextOf(MSG.EVENT))[4]).toEqual(['during']);
    p.send([MSG.AUTHENTICATE, 'x', {}]);
    expect((await p.nextOf(MSG.CHALLENGE))[1]).toBe('b');
    p.send([MSG.AUTHENTICATE, 'y', {}]);
    const welcome = await p.nextOf(MSG.WELCOME);
    expect([welcome[1], s.router.sessions.map((x) => x.id)]).toEqual([early, [early]]);
  });

  test('T6: the last provider verifies with the extra of its own CHALLENGE', async () => {
    const verified: unknown[] = [];
    const provider = (method: string, n: number): SimAuthProvider => ({
      method,
      extra: () => ({ n }),
      verify: (signature, _hello, extra) => {
        verified.push([method, signature, extra]);
        return { authid: 'u' };
      },
    });
    const s = setup('thruway-php', { providers: [provider('a', 1), provider('b', 2)] });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['a', 'b'] }]);
    await settle(s);
    expect(p.take(() => true)).toEqual([MSG.CHALLENGE, 'a', { n: 1 }]);
    expect(p.take(() => true)).toEqual([MSG.CHALLENGE, 'b', { n: 2 }]);
    p.send([MSG.AUTHENTICATE, 'sig', {}]);
    await p.nextOf(MSG.WELCOME);
    expect(verified).toEqual([['b', 'sig', { n: 2 }]]);
  });

  test('challengeGap 0: the CHALLENGEs go out back to back, in the same step (sync delivery)', async () => {
    const s = setup('thruway-php', {
      delivery: 'sync',
      providers: [
        { method: 'a', verify: () => false },
        { method: 'b', verify: () => false },
      ],
    });
    const p = s.peer();
    await s.clock.advance(0);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['a', 'b'] }]);
    expect(p.received.map((f) => f[1])).toEqual(['a', 'b']);
  });

  test('a CHALLENGE sent after its gap is not sent again when the AUTHENTICATE flushes the rest', async () => {
    const s = setup('thruway-php', {
      challengeGap: 10,
      providers: [
        { method: 'a', verify: () => false },
        { method: 'b', verify: () => false },
        { method: 'c', verify: () => false },
      ],
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['a', 'b', 'c'] }]);
    await s.clock.advance(10);
    p.send([MSG.AUTHENTICATE, 'sig', {}]);
    await settle(s);
    expect(p.received.map((f) => [f[0], f[1]])).toEqual([
      [MSG.CHALLENGE, 'a'],
      [MSG.CHALLENGE, 'b'],
      [MSG.CHALLENGE, 'c'],
      [MSG.ABORT, {}],
    ]);
  });

  test('an ABORT during the gap cancels the CHALLENGEs still waiting (the socket stays open without abort_close)', async () => {
    const s = setup('thruway-php', {
      quirks: { abort_close: undefined },
      challengeGap: 10,
      providers: [
        { method: 'a', verify: () => false },
        { method: 'b', verify: () => false },
      ],
    });
    const p = await opened(s);
    p.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['a', 'b'] }]);
    await s.clock.advance(0);
    p.send([MSG.ABORT, {}, 'wamp.close.close_realm']);
    await s.clock.advance(50);
    expect([p.received.map((f) => f[1]), p.closed, s.clock.pendingTimers]).toEqual([['a'], undefined, 0]);
  });
});

describe('closing details', () => {
  test("Crossbar keeps the socket after the router's ABORT and the client's GOODBYE: the session is gone all the same", async () => {
    const s = setup('crossbar');
    const a = await s.join();
    await a.subscribe('com.t');
    s.router.abort('wamp.close.system_shutdown');
    await settle(s);
    expect(a.take(() => true)?.[0]).toBe(MSG.ABORT);
    const b = await s.join();
    await b.subscribe('com.t');
    b.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await settle(s);
    expect(b.take(() => true)?.[0]).toBe(MSG.GOODBYE);
    s.router.publish('com.t');
    await settle(s);
    expect([a.pending, b.pending, a.closed, b.closed, s.router.sessions]).toEqual([[], [], undefined, undefined, []]);
    expect((await b.join())[0]).toBe(MSG.WELCOME);
  });

  test("wamp-server: the client's ABORT keeps the socket open (no abort_close), unlike its GOODBYE", async () => {
    const s = setup('wamp-server');
    const a = await s.join();
    a.send([MSG.ABORT, {}, 'wamp.close.close_realm']);
    await settle(s);
    expect([a.closed, s.router.sessions]).toEqual([undefined, []]);
    expect((await a.join())[0]).toBe(MSG.WELCOME);
  });

  test('an AUTHENTICATE in a session is ignored (Crossbar would close an unknown message type)', async () => {
    const s = setup('crossbar');
    s.router.procedure('com.p', () => 'ok');
    const a = await s.join();
    a.send([MSG.AUTHENTICATE, 'late', {}]);
    expect(await a.call('com.p')).toEqual([MSG.RESULT, 1, {}, ['ok']]);
  });

  test('Bondy: a frame whose type is not an integer is bad JSON to it (internal_error), not an unknown type', async () => {
    const s = setup('bondy');
    const a = await s.join();
    a.send(['48', 1, {}, 'com.x']);
    await settle(s);
    expect(a.pending).toEqual([[MSG.ABORT, {}, 'bondy.error.internal_error']]);
  });

  test('wamp-server without its close after GOODBYE: the CANCEL GOODBYE ends the session, the socket stays', async () => {
    const s = setup('wamp-server', { quirks: { router_closes_after_goodbye: undefined } });
    const a = await s.join();
    a.send([MSG.CANCEL, 1, {}]);
    await settle(s);
    expect([a.pending, a.closed, s.router.sessions]).toEqual([
      [[MSG.GOODBYE, {}, 'wamp.error.goodbye_and_out']],
      undefined,
      [],
    ]);
  });
});

describe('request details', () => {
  test('strict_ids: only a CALL continues a CALL in flight; another request with its id breaks the sequence', async () => {
    const s = setup('nexus', { quirks: { strict_ids: true } });
    const a = await s.join();
    await a.register('com.p'); // 1
    a.send(callFrame(2, 'com.p'));
    a.send([MSG.SUBSCRIBE, 2, {}, 'com.t']);
    await settle(s);
    expect(a.closed?.code).toBe(1006);
  });

  test('a request that ends the connection is not executed (strict ids, Crossbar invalid URIs): nothing is unscripted', async () => {
    const nexus = setup('nexus', { strict: true, quirks: { strict_ids: true } });
    const a = await nexus.join();
    a.send(callFrame(5, 'com.nobody'));
    await settle(nexus);
    const crossbar = setup('crossbar', { strict: true });
    const b = await crossbar.join();
    b.send(callFrame(1, 'com..bad'));
    await settle(crossbar);
    const c = await crossbar.join();
    c.send([MSG.PUBLISH, 1, {}, 'com..bad']);
    await settle(crossbar);
    expect([a.closed?.code, b.closed?.code, c.closed?.code]).toEqual([1006, 1011, 1011]);
    expect([nexus.router.unscripted, crossbar.router.unscripted]).toEqual([[], []]);
  });

  test("Crossbar's shared subscription id ends with the topic's last subscription (another topic's do not keep it)", async () => {
    const s = setup('crossbar');
    const a = await s.join();
    const first = await a.subscribe('com.a');
    await a.subscribe('com.b');
    a.send([MSG.UNSUBSCRIBE, a.id(), first]);
    await settle(s);
    expect(await a.subscribe('com.a')).not.toBe(first);
  });

  test('a PUBLISH of the wrong shape is malformed (Crossbar: 1002): topic, options, args', async () => {
    for (const frame of [
      [MSG.PUBLISH, 1, {}, 5],
      [MSG.PUBLISH, 1, 'options', 'com.t'],
      [MSG.PUBLISH, 1, {}, 'com.t', 'args'],
      [MSG.CALL, 1, {}, 'com.t', [], 'kwargs'],
    ]) {
      const s = setup('crossbar');
      s.router.procedure('com.t', () => 'ok');
      const p = await s.join();
      p.send(frame);
      await settle(s);
      expect([frame, p.pending, p.closed?.code]).toEqual([frame, [], 1002]);
    }
  });

  test('eligible_authrole/exclude_authrole match any of the subscriber’s roles', async () => {
    const s = setup('spec', {
      authenticate: (hello) => ({
        welcome: hello.details['authid'] === 'multi' ? { authrole: 'a', authroles: ['a', 'b'] } : {},
      }),
    });
    const sub = await s.join({ authid: 'multi' });
    await sub.subscribe('com.t');
    const pub = await s.join();
    pub.send([MSG.PUBLISH, 1, { eligible_authrole: ['a'] }, 'com.t', ['in']]);
    pub.send([MSG.PUBLISH, 2, { exclude_authrole: ['a'] }, 'com.t', ['out']]);
    await settle(s);
    expect(sub.pending.map((f) => f[4])).toEqual([['in']]);
  });

  test('Thruway: a wildcard REGISTER is invalid_uri whatever the URI; a prefix one is exact', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    a.send([MSG.REGISTER, 1, { match: 'wildcard' }, 'com.example.p']);
    expect(await a.reply(MSG.REGISTER, 1, MSG.REGISTERED)).toEqual([
      MSG.ERROR,
      MSG.REGISTER,
      1,
      {},
      'wamp.error.invalid_uri',
    ]);
    await a.register('com.example', { match: 'prefix' });
    const caller = await s.join();
    expect((await caller.call('com.example.q'))[4]).toBe('wamp.error.no_such_procedure');
  });

  test('fox-wamp shares implicitly: the same session may register a procedure twice', async () => {
    const s = setup('fox-wamp');
    const a = await s.join();
    const one = await a.register('com.p');
    expect(await a.register('com.p')).not.toBe(one);
  });

  test('Thruway: without replace_orphaned_session a frozen callee keeps its procedure, refused at once', async () => {
    const s = setup('thruway-php');
    const old = await s.join();
    await old.register('com.example.p');
    old.ws.controls.freeze('buffer');
    const fresh = await s.join();
    for (const options of [{}, { replace_orphaned_session: 'no' }]) {
      const id = fresh.id();
      fresh.send([MSG.REGISTER, id, options, 'com.example.p']);
      await s.clock.advance(0);
      expect(fresh.take(() => true)).toEqual([MSG.ERROR, MSG.REGISTER, id, {}, 'wamp.error.procedure_already_exists']);
    }
  });

  test('replace_orphaned_session: the evicted callee’s connection is dropped; an old session gone meanwhile is left alone', async () => {
    const s = setup('thruway-php');
    const old = await s.join();
    await old.register('com.example.p');
    old.ws.controls.freeze('buffer');
    const fresh = await s.join();
    fresh.send([MSG.REGISTER, fresh.id(), { replace_orphaned_session: 'yes' }, 'com.example.p']);
    await s.clock.advance(5000);
    expect(s.router.connections.find((c) => c.number === old.ws.controls.number)?.state).toBe('closed');
    // Crossbar (with the flag): the old session ends and its connection hosts a new one before the 5 s are over
    const c = setup('crossbar', { quirks: { replace_orphaned_session: true } });
    const a = await c.join();
    await a.register('com.p');
    a.ws.controls.freeze('drop', 'down');
    const b = await c.join();
    const id = b.id();
    b.send([MSG.REGISTER, id, { replace_orphaned_session: 'yes' }, 'com.p']);
    await c.clock.advance(1);
    a.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    a.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    await c.clock.advance(5000);
    expect(b.take((f) => f[0] === MSG.REGISTERED)?.[1]).toBe(id);
    expect(c.router.connections.find((x) => x.number === a.ws.controls.number)?.state).toBe('open');
    expect(c.router.sessions.length).toBe(2);
  });

  test('replace_orphaned_session: a prefix registration of the same URI meanwhile does not take the exact procedure', async () => {
    const s = setup('thruway-php', { quirks: { register_match: { prefix: 'yes', wildcard: 'invalid_uri' } } });
    const old = await s.join();
    await old.register('com.p');
    old.ws.controls.freeze('buffer');
    const fresh = await s.join();
    fresh.send([MSG.REGISTER, 1, { replace_orphaned_session: 'yes' }, 'com.p']);
    await s.clock.advance(1);
    const other = await s.join();
    await other.register('com.p', { match: 'prefix' });
    await s.clock.advance(5000);
    expect(fresh.pending.map((f) => f[0])).toEqual([MSG.REGISTERED]);
  });

  test('invoke is case-sensitive and thruway_multiregister unknown outside Thruway PHP', async () => {
    const s = setup('spec');
    const a = await s.join();
    const b = await s.join();
    await a.register('com.p', { invoke: 'RoundRobin' }); // single
    await a.register('com.q', { thruway_multiregister: true }); // single
    for (const [procedure, options] of [
      ['com.p', { invoke: 'roundrobin' }],
      ['com.q', { thruway_multiregister: true }],
    ] as const) {
      const id = b.id();
      b.send([MSG.REGISTER, id, options, procedure]);
      expect((await b.reply(MSG.REGISTER, id, MSG.REGISTERED))[4]).toBe('wamp.error.procedure_already_exists');
    }
  });

  test('Thruway: one id per REGISTER (no id is spent on a registration of one callee)', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const p = await a.register('com.p');
    expect(await a.register('com.q')).toBe(p + 1);
  });

  test('Thruway: an UNREGISTER of another session’s id in a shared registration is no_such_registration', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    const b = await s.join();
    const idA = await a.register('com.p', { invoke: 'roundrobin' });
    await b.register('com.p', { invoke: 'roundrobin' });
    const c = await s.join();
    c.send([MSG.UNREGISTER, 1, idA]);
    expect((await c.reply(MSG.UNREGISTER, 1, MSG.UNREGISTERED))[4]).toBe('wamp.error.no_such_registration');
  });
});

describe('broker details', () => {
  test("the router's own publication discloses no publisher, whatever the dialect discloses", async () => {
    for (const dialect of ['crossbar', 'bondy', 'fox-wamp'] as const) {
      const s = setup(dialect);
      const sub = await s.join();
      await sub.subscribe('com.t');
      s.router.publish('com.t', [1]);
      const event = await sub.nextOf(MSG.EVENT);
      expect([dialect, 'publisher' in (event[3] as object)]).toEqual([dialect, false]);
    }
  });

  test("event_details_topic 'never' (an override): no topic even for a pattern subscription", async () => {
    const s = setup('spec', { quirks: { event_details_topic: 'never' } });
    const sub = await s.join();
    await sub.subscribe('com', { match: 'prefix' });
    s.router.publish('com.t');
    expect((await sub.nextOf(MSG.EVENT))[3]).toEqual({});
  });
});

describe('dealer details', () => {
  test('a duplicate in-flight CALL served twice: the first one finishing leaves the second cancellable (Crossbar)', async () => {
    const s = setup('crossbar');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(1, 'com.p'));
    const one = await callee.nextOf(MSG.INVOCATION);
    const two = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.YIELD, one[1], {}, ['one']]);
    await settle(s);
    caller.send([MSG.CANCEL, 1, { mode: 'kill' }]);
    expect((await callee.nextOf(MSG.INTERRUPT))[1]).toBe(two[1]);
  });

  test("a duplicate in-flight CALL is dropped (spec); Nexus's continuation of a scripted call runs nothing again", async () => {
    const s = setup('spec');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    caller.send(callFrame(1, 'com.p'));
    await settle(s);
    expect(INVOCATIONS(callee).length).toBe(1);
    const n = setup('nexus');
    let runs = 0;
    n.router.procedure('com.h', () => {
      runs++;
      return new Promise(() => undefined);
    });
    const p = await n.join();
    p.send(callFrame(1, 'com.h'));
    p.send(callFrame(1, 'com.h'));
    await settle(n);
    expect([runs, p.pending]).toEqual([1, []]);
  });

  test('a CALL timeout must be a positive number; after a timeout the callee’s invocation is over', async () => {
    const s = setup('nexus');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    for (const timeout of ['500', 0, -1])
      caller.send(callFrame(caller.id(), 'com.p', undefined, undefined, { timeout }));
    await s.clock.advance(1000);
    expect([INVOCATIONS(callee).length, callee.pending.length, caller.pending]).toEqual([3, 3, []]);
    caller.send(callFrame(caller.id(), 'com.p', undefined, undefined, { timeout: 100 }));
    await s.clock.advance(100);
    expect(sessionOf(s, callee)?.invocations).toBe(3);
    expect(caller.pending.map((f) => f[4])).toEqual(['wamp.error.timeout']);
  });

  test('_thruway: a queued call goes to a callee that joins the registration, or that a timeout freed; one at a time', async () => {
    const s = setup('thruway-php', { quirks: { call_timeout: 'ms' } });
    const a = await s.join();
    await a.register('com.q', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.q', ['one'], undefined, { timeout: 100 }));
    caller.send(callFrame(2, 'com.q', ['two']));
    caller.send(callFrame(3, 'com.q', ['three']));
    caller.send(callFrame(4, 'com.q', ['four']));
    await s.clock.advance(0);
    expect(INVOCATIONS(a).map((f) => f[4])).toEqual([['one']]);
    await s.clock.advance(100); // the first call timed out: its callee is free
    expect(INVOCATIONS(a).map((f) => f[4])).toEqual([['one'], ['two']]);
    const b = await s.join();
    await b.register('com.q', { invoke: '_thruway' });
    expect(INVOCATIONS(b).map((f) => f[4])).toEqual([['three']]);
    const two = a.take((f) => f[0] === MSG.INVOCATION && f[4] !== undefined && (f[4] as unknown[])[0] === 'two')!;
    a.send([MSG.YIELD, two[1], {}, []]);
    await settle(s);
    expect([INVOCATIONS(a).map((f) => f[4]), INVOCATIONS(b).length]).toEqual([[['one'], ['four']], 1]);
  });

  test('a router call discloses no caller (Thruway disclose_caller, Crossbar always-auth); a CALL timeout reaches only Crossbar’s callee', async () => {
    for (const dialect of ['thruway-php', 'crossbar', 'spec'] as const) {
      const s = setup(dialect);
      const callee = await s.join();
      await callee.register('com.p', { disclose_caller: true });
      s.router.invoke('com.p');
      const caller = await s.join();
      caller.send(callFrame(1, 'com.p', undefined, undefined, { timeout: 500 }));
      await settle(s);
      const [routerInv, callInv] = INVOCATIONS(callee);
      expect([dialect, routerInv?.[3]]).toStrictEqual([dialect, {}]);
      expect([dialect, 'timeout' in (callInv?.[3] as object)]).toEqual([dialect, dialect === 'crossbar']);
    }
  });

  test('a router call is in no request-id index: Thruway’s realm-wide CALL 0 of a client is never overwritten nor unset by it', async () => {
    const s = setup('thruway-php');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(0, 'com.p')); // Thruway accepts any request id
    await settle(s);
    const call = s.router.invoke('com.p');
    await settle(s);
    const [clientInv, routerInv] = INVOCATIONS(callee);
    caller.send([MSG.CANCEL, 0, { mode: 'killnowait' }]); // reaches the client's own call, not the router's
    await settle(s);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 0, {}, 'wamp.error.canceled']);
    expect(call.done).toBe(false);
    caller.send(callFrame(0, 'com.p'));
    await settle(s);
    const third = INVOCATIONS(callee)[2]!;
    callee.send([MSG.YIELD, routerInv![1], {}, ['router']]); // the router call finishing unsets nothing
    await settle(s);
    expect(call.result?.args).toEqual(['router']);
    caller.send([MSG.CANCEL, 0, { mode: 'killnowait' }]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CANCEL, 0, {}, 'wamp.error.canceled']);
    expect(callee.pending.filter((f) => f[0] === MSG.INTERRUPT).map((f) => f[1])).toEqual([clientInv![1], third[1]]);
  });

  test('a callee’s ERROR for another request type is ignored; its YIELD still answers', async () => {
    const s = setup('spec');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    callee.send([MSG.ERROR, MSG.CALL, inv[1], {}, 'com.err']);
    callee.send([MSG.ERROR, MSG.INTERRUPT, inv[1], {}, 'wamp.error.canceled']); // an INTERRUPT answered by type 69
    callee.send([MSG.ERROR, MSG.ERROR, inv[1], {}, 'com.err']);
    await settle(s);
    expect(caller.pending).toEqual([]);
    callee.send([MSG.YIELD, inv[1], {}, ['ok']]);
    expect(await caller.nextOf(MSG.RESULT)).toEqual([MSG.RESULT, 1, {}, ['ok']]);
  });

  test('a malformed YIELD is malformed (Crossbar: 1002); another session’s answer is ignored on the spec dialect', async () => {
    for (const bad of [(id: unknown) => [MSG.YIELD, 'x', {}, [id]], (id: unknown) => [MSG.YIELD, id, 'options']]) {
      const s = setup('crossbar');
      const callee = await s.join();
      await callee.register('com.p');
      const caller = await s.join();
      caller.send(callFrame(1, 'com.p'));
      const inv = await callee.nextOf(MSG.INVOCATION);
      callee.send(bad(inv[1]));
      await settle(s);
      expect(callee.closed).toEqual({ code: 1002, reason: 'WAMP Protocol Error', wasClean: true });
    }
    const s = setup('spec');
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p'));
    const inv = await callee.nextOf(MSG.INVOCATION);
    const other = await s.join();
    other.send([MSG.YIELD, inv[1], {}, ['stolen']]);
    await settle(s);
    expect([other.closed, caller.pending]).toEqual([undefined, []]);
    callee.send([MSG.YIELD, inv[1], {}, ['mine']]);
    expect(await caller.nextOf(MSG.RESULT)).toEqual([MSG.RESULT, 1, {}, ['mine']]);
  });
});

describe('cancel and leave details', () => {
  /** A callee of `com.p` (with `features`) and a caller with CALL 1 invoked (options `options`). */
  async function invoked(
    s: Setup,
    options: Record<string, unknown> = {},
    features: Record<string, boolean> = {},
  ): Promise<{ callee: WampPeer; caller: WampPeer; inv: Frame }> {
    const callee = await s.join(calleeRoles(features));
    await callee.register('com.p');
    const caller = await s.join();
    caller.send(callFrame(1, 'com.p', undefined, undefined, options));
    return { callee, caller, inv: await callee.nextOf(MSG.INVOCATION) };
  }

  test('Thruway: a queued call cancelled once is gone (a second CANCEL finds no call); the others stay', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.q', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.q'));
    caller.send(callFrame(2, 'com.q'));
    await settle(s);
    caller.send([MSG.CANCEL, 2, {}]);
    await settle(s);
    expect(caller.take(() => true)).toEqual([
      MSG.ERROR,
      MSG.CANCEL,
      2,
      { _thruway_removed_from_queue: true },
      'wamp.error.canceled',
    ]);
    caller.send([MSG.CANCEL, 2, {}]);
    await settle(s);
    expect(caller.take(() => true)?.[4]).toBe('wamp.error.no_such_call');
    expect(sessionOf(s, caller)?.calls).toBe(1);
  });

  test('Bondy: a CANCEL without mode to a callee without call_canceling is a skip (with its args), not a refusal', async () => {
    const s = setup('bondy');
    const { caller } = await invoked(s, {}, { call_canceling: false });
    caller.send([MSG.CANCEL, 1, {}]);
    await settle(s);
    expect(caller.pending).toEqual([[MSG.ERROR, 49, 1, {}, 'wamp.error.canceled', ['call_cancelled']]]);
  });

  test('cancel_error_args go with a CANCEL without mode only', async () => {
    const s = setup('spec', {
      quirks: { cancel_error_args: ['x'], cancel_modes: { ...DIALECTS.spec.flags.cancel_modes, none: 'skip' } },
    });
    s.router.procedure('com.never', () => new Promise(() => undefined));
    const p = await s.join();
    p.send(callFrame(1, 'com.never'));
    p.send(callFrame(2, 'com.never'));
    p.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    p.send([MSG.CANCEL, 2, {}]);
    await settle(s);
    expect(p.pending).toEqual([
      [MSG.ERROR, 48, 1, {}, 'wamp.error.canceled'],
      [MSG.ERROR, 48, 2, {}, 'wamp.error.canceled', ['x']],
    ]);
  });

  test("Crossbar's hang: a scripted call is forgotten at once; a callee's call stays until its callee answers, which is discarded", async () => {
    const s = setup('crossbar');
    s.router.procedure('com.never', () => new Promise(() => undefined));
    const { callee, caller, inv } = await invoked(s, { receive_progress: true });
    caller.send(callFrame(2, 'com.never'));
    caller.send([MSG.CANCEL, 2, { mode: 'skip' }]);
    caller.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    await settle(s);
    expect(sessionOf(s, caller)?.calls).toBe(1);
    callee.send([MSG.YIELD, inv[1], { progress: true }, ['p']]);
    callee.send([MSG.YIELD, inv[1], {}, ['done']]);
    await settle(s);
    expect(caller.pending).toEqual([]);
  });

  test("Crossbar's hang, then the callee answers and the caller leaves: no INTERRUPT; or the callee leaves: no ERROR", async () => {
    const s = setup('crossbar');
    const { callee, caller, inv } = await invoked(s);
    caller.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    callee.send([MSG.YIELD, inv[1], {}, ['done']]);
    await settle(s);
    caller.ws.close(1000);
    await settle(s);
    expect(callee.pending).toEqual([]);
    const t = setup('crossbar');
    const two = await invoked(t);
    two.caller.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    await settle(t);
    two.callee.ws.close(1000);
    await settle(t);
    expect(two.caller.pending).toEqual([]);
  });

  test("Crossbar's hang with a CALL timeout: no INTERRUPT for an invocation the callee answered, nor into its socket after it left (a new session there)", async () => {
    const s = setup('crossbar');
    const { callee, caller, inv } = await invoked(s, { timeout: 1 });
    caller.send([MSG.CANCEL, 1, { mode: 'skip' }]);
    callee.send([MSG.YIELD, inv[1], {}, ['done']]); // discarded: the call hangs
    await s.clock.advance(500);
    caller.send(callFrame(2, 'com.p', undefined, undefined, { timeout: 1 }));
    const second = await callee.nextOf(MSG.INVOCATION);
    caller.send([MSG.CANCEL, 2, { mode: 'skip' }]);
    await s.clock.advance(500); // call 1's timeout: its invocation was answered already
    expect(callee.pending).toEqual([]);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled', ['timeout reached']]);
    expect(await callee.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.close.normal']); // Crossbar keeps the socket
    expect(await callee.join()).toEqual([MSG.WELCOME, expect.any(Number), expect.any(Object)]);
    await s.clock.advance(500); // call 2's timeout: its callee's session is gone, a new one uses the socket
    expect([callee.pending, callee.closed]).toEqual([[], undefined]);
    expect(caller.take(() => true)).toEqual([MSG.ERROR, MSG.CALL, 2, {}, 'wamp.error.canceled', ['timeout reached']]);
    expect(second[1]).not.toBe(inv[1]);
  });

  test("a router call whose callee left without an answer for its caller (fox-wamp) interrupts nobody: nothing after the router's GOODBYE; killnowait still ends it", async () => {
    const s = setup('fox-wamp');
    const callee = await s.join();
    await callee.register('com.p');
    const call = s.router.invoke('com.p');
    await callee.nextOf(MSG.INVOCATION);
    s.router.kill(s.router.sessions[0]!.id);
    await settle(s);
    expect(callee.take(() => true)).toEqual([MSG.GOODBYE, {}, 'wamp.close.killed']);
    call.interrupt('kill');
    call.interrupt('killnowait');
    await settle(s);
    expect([callee.pending, call.done, call.error?.uri]).toEqual([[], true, 'wamp.error.canceled']);
  });

  test('Thruway T3: a cancelled progressive call is forgotten at the CANCEL (scripted: its handler unsubscribed)', async () => {
    const s = setup('thruway-php');
    let observer: { next(v: unknown): void; complete(): void } | undefined;
    s.router.procedure('com.obs', () => ({
      subscribe: (o: { next(v: unknown): void; complete(): void }) => {
        observer = o;
        return {
          unsubscribe: () => {
            observer = undefined;
          },
        };
      },
    }));
    const { caller } = await invoked(s, { receive_progress: true });
    caller.send(callFrame(2, 'com.obs', undefined, undefined, { receive_progress: true }));
    await settle(s);
    observer?.next(1);
    await settle(s);
    caller.send([MSG.CANCEL, 1, { mode: 'kill' }]);
    caller.send([MSG.CANCEL, 2, { mode: 'kill' }]);
    await settle(s);
    expect([observer, sessionOf(s, caller)?.calls]).toEqual([undefined, 0]);
    expect(caller.pending).toEqual([[MSG.RESULT, 2, { progress: true }, [1]]]);
  });

  test('_thruway: a killnowait CANCEL frees the callee for the next queued call; a queued call whose caller left is dropped', async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.q', { invoke: '_thruway' });
    const caller = await s.join();
    const leaver = await s.join();
    caller.send(callFrame(1, 'com.q', ['one']));
    leaver.send(callFrame(7, 'com.q', ['left'])); // (not 1: T1's realm-wide index would make it the CANCEL's target)
    caller.send(callFrame(2, 'com.q', ['two']));
    await settle(s);
    leaver.ws.close(1000);
    await settle(s);
    caller.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await settle(s);
    expect(INVOCATIONS(a).map((f) => f[4])).toEqual([['one'], ['two']]);
  });

  test('_thruway with killnowait on caller leave (an override): the freed callee takes the next queued call', async () => {
    const s = setup('thruway-php', { quirks: { caller_leave_interrupts: 'killnowait' } });
    const a = await s.join();
    await a.register('com.q', { invoke: '_thruway' });
    const leaver = await s.join();
    const caller = await s.join();
    leaver.send(callFrame(1, 'com.q', ['left']));
    caller.send(callFrame(1, 'com.q', ['next']));
    await settle(s);
    leaver.ws.close(1000);
    await settle(s);
    expect(INVOCATIONS(a).map((f) => f[4])).toEqual([['left'], ['next']]);
  });

  test("Thruway: a session's call to its own registration is neither cancelled nor answered once the router's GOODBYE ended it", async () => {
    const s = setup('thruway-php');
    const a = await s.join();
    await a.register('com.p');
    a.send(callFrame(a.id(), 'com.p'));
    await a.nextOf(MSG.INVOCATION);
    s.router.goodbye();
    await settle(s);
    expect(a.received.at(-1)?.[0]).toBe(MSG.GOODBYE);
  });

  test('a caller leaving ends its call: the callee gets one INTERRUPT, the CALL timeout never fires', async () => {
    const s = setup('nexus');
    const { callee, caller } = await invoked(s, { timeout: 500 });
    await s.clock.advance(100);
    caller.ws.close(1000);
    await s.clock.advance(1000);
    expect(callee.pending.map((f) => f[0])).toEqual([MSG.INTERRUPT]);
  });

  test('Crossbar: the close reasons of a foreign answer (1002) and of an invalid callee error URI (1011)', async () => {
    const s = setup('crossbar');
    const { callee, inv } = await invoked(s);
    const thief = await s.join();
    thief.send([MSG.YIELD, inv[1], {}, []]);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'not a uri!']);
    await settle(s);
    expect([thief.closed, callee.closed]).toEqual([
      { code: 1002, reason: 'WAMP Protocol Error', wasClean: true },
      { code: 1011, reason: 'WAMP Internal Error', wasClean: true },
    ]);
  });
});
