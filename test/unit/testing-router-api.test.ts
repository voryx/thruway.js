// The reference router's API (router.ts): the authorization model (`deny`), router-side calls into client callees
// (`invoke`: the model's RouterInvoke/RouterInterrupt), `kill`, per-connection `sendRaw`, auth providers on the spec
// dialect (the Thruway PHP specifics are in testing-dialects.test.ts), and the fake socket's per-direction freeze and
// `vanish()`.
import { afterEach, describe, expect, test } from 'vitest';
import {
  createRouter,
  createSimClock,
  type SimAuthProvider,
  type SimRequest,
  type SimRouter,
  type SimRouterOptions,
} from '../../src/testing/sim.js';
import { callFrame, MSG, PEER_ROLES, WampPeer, type Frame } from '../helpers/wamp-peer.js';

interface Setup {
  readonly clock: ReturnType<typeof createSimClock>;
  readonly router: SimRouter;
  open(): Promise<WampPeer>;
  join(details?: Record<string, unknown>, realm?: string): Promise<WampPeer>;
  settle(): Promise<void>;
}

/** Routers of the running test: none may have failed internally (only the errors a test throws on purpose, named
 *  `… bug`, may land in `router.errors`). */
const routers: SimRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) {
    expect(r.errors.filter((e) => !(e instanceof Error && e.message.endsWith(' bug')))).toEqual([]);
  }
});

function setup(options: Omit<SimRouterOptions, 'clock'> = {}): Setup {
  const clock = createSimClock();
  const router = createRouter({ clock, ...options });
  routers.push(router);
  const settle = (): Promise<void> => clock.runUntilIdle();
  const open = async (): Promise<WampPeer> => {
    // the peer's waits pass no time (timers stay exact), except under latency
    const p = new WampPeer(
      router.WebSocket,
      router.url,
      options.latency === undefined ? () => clock.advance(0) : settle,
    );
    await settle();
    return p;
  };
  return {
    clock,
    router,
    settle,
    open,
    join: async (details = {}, realm = 'realm1') => {
      const p = await open();
      const welcome = await p.join(realm, details);
      if (welcome[0] !== MSG.WELCOME) throw new Error(`join failed: ${JSON.stringify(welcome)}`);
      return p;
    },
  };
}

function sessionId(p: WampPeer): number {
  return p.received[0]![1] as number;
}

describe('deny(): the authorization model', () => {
  test('CALL, REGISTER, SUBSCRIBE and acknowledged PUBLISH ⇒ ERROR not_authorized (or the rule’s URI); an unacknowledged PUBLISH is dropped', async () => {
    const s = setup();
    s.router.procedure('com.secret', () => 'no');
    const sub = await s.join();
    await sub.subscribe('com.secret.t');
    const seen: SimRequest[] = [];
    const remove = s.router.deny((r) => {
      seen.push(r);
      if (r.uri === 'com.custom') return 'com.error.forbidden';
      return r.uri.startsWith('com.secret');
    });
    const p = await s.join({ authid: 'x' });
    const frames: Frame[] = [
      callFrame(1, 'com.secret'),
      [MSG.REGISTER, 2, {}, 'com.secret.p'],
      [MSG.SUBSCRIBE, 3, { match: 'prefix' }, 'com.secret'],
      [MSG.PUBLISH, 4, { acknowledge: true }, 'com.secret.t'],
      [MSG.PUBLISH, 5, {}, 'com.secret.t'],
      callFrame(6, 'com.custom'),
      [MSG.SUBSCRIBE, 7, {}, 'com.public'],
    ];
    for (const f of frames) p.send(f);
    await s.settle();
    expect(p.pending.map((f) => (f[0] === MSG.ERROR ? [f[1], f[2], f[4]] : [f[0], f[1]]))).toEqual([
      [MSG.CALL, 1, 'wamp.error.not_authorized'],
      [MSG.REGISTER, 2, 'wamp.error.not_authorized'],
      [MSG.SUBSCRIBE, 3, 'wamp.error.not_authorized'],
      [MSG.PUBLISH, 4, 'wamp.error.not_authorized'],
      [MSG.CALL, 6, 'com.error.forbidden'],
      [MSG.SUBSCRIBED, 7],
    ]);
    expect(sub.pending).toEqual([]);
    expect(seen.map((r) => [r.type, r.uri, r.options, r.session.id])).toEqual([
      ['call', 'com.secret', {}, sessionId(p)],
      ['register', 'com.secret.p', {}, sessionId(p)],
      ['subscribe', 'com.secret', { match: 'prefix' }, sessionId(p)],
      ['publish', 'com.secret.t', { acknowledge: true }, sessionId(p)],
      ['publish', 'com.secret.t', {}, sessionId(p)],
      ['call', 'com.custom', {}, sessionId(p)],
      ['subscribe', 'com.public', {}, sessionId(p)],
    ]);
    expect(seen[0]!.session.welcome['authid']).toBe(`anonymous-${String(sessionId(p))}`);
    remove();
    while (p.take(() => true) !== undefined);
    expect(await p.call('com.secret')).toEqual([MSG.RESULT, 1, {}, ['no']]);
  });

  test('the first rule that denies decides; false/undefined allow; a throwing rule is recorded and denies nothing; it must be a function', async () => {
    const s = setup();
    s.router.procedure('com.p', () => 'ok');
    const boom = new Error('rule bug');
    s.router.deny(() => undefined);
    s.router.deny(() => false);
    s.router.deny(() => {
      throw boom;
    });
    const p = await s.join();
    expect(await p.call('com.p')).toEqual([MSG.RESULT, 1, {}, ['ok']]);
    expect(s.router.errors).toEqual([boom]);
    s.router.deny(() => 'first');
    s.router.deny(() => 'second');
    expect((await p.call('com.p'))[4]).toBe('first');
    expect(() => s.router.deny('no' as never)).toThrow(new TypeError('deny(rule): rule must be a function'));
  });

  test('a denied request writes nothing to anybody else and is no violation', async () => {
    const s = setup({ strict: true });
    s.router.deny(() => true);
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.undeclared']);
    await s.settle();
    expect(s.router.violations).toEqual([]);
    expect(s.router.unscripted).toEqual([]); // denied before the strict check
  });
});

describe('invoke(): router-side calls into client callees (RouterInvoke / RouterInterrupt)', () => {
  async function calleeOf(
    s: Setup,
    features: Record<string, boolean> = {},
    options: Record<string, unknown> = {},
  ): Promise<{ callee: WampPeer; reg: number }> {
    const callee = await s.open();
    await callee.join('realm1', {
      roles: { ...PEER_ROLES, callee: { features: { ...PEER_ROLES.callee.features, ...features } } },
    });
    return { callee, reg: await callee.register('com.p', options) };
  }

  test('an INVOCATION without caller disclosure; the YIELD settles it with args, kwargs and details', async () => {
    const s = setup();
    const { callee, reg } = await calleeOf(s, {}, { disclose_caller: true });
    const call = s.router.invoke('com.p', { args: [1], kwargs: { k: 2 } });
    expect([call.procedure, call.done]).toEqual(['com.p', false]);
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv).toEqual([MSG.INVOCATION, inv[1], reg, {}, [1], { k: 2 }]);
    expect(call.invocation).toEqual({ connection: callee.ws.controls.number, id: inv[1] });
    callee.send([MSG.YIELD, inv[1], {}, ['r'], { x: 1 }]);
    await s.settle();
    expect([call.done, call.result, call.error, call.progress]).toEqual([
      true,
      { args: ['r'], kwargs: { x: 1 }, details: {} },
      undefined,
      [],
    ]);
  });

  test('receive_progress reaches a callee that announced it; progress YIELDs are recorded; the callee’s ERROR ends it', async () => {
    const s = setup();
    const { callee } = await calleeOf(s);
    const call = s.router.invoke('com.p', { options: { receive_progress: true } });
    const inv = await callee.nextOf(MSG.INVOCATION);
    expect(inv[3]).toEqual({ receive_progress: true });
    callee.send([MSG.YIELD, inv[1], { progress: true }, [1]]);
    callee.send([MSG.YIELD, inv[1], { progress: true }]);
    callee.send([MSG.ERROR, MSG.INVOCATION, inv[1], { d: 1 }, 'com.error', ['e'], { k: 1 }]);
    await s.settle();
    expect(call.progress).toEqual([
      { args: [1], kwargs: {} },
      { args: [], kwargs: {} },
    ]);
    expect(call.error).toEqual({ uri: 'com.error', args: ['e'], kwargs: { k: 1 }, details: { d: 1 } });
    expect(call.done).toBe(true);
  });

  test('interrupt(kill) waits for the callee’s answer; interrupt(killnowait) ends it at once and the late answer is dropped', async () => {
    const s = setup();
    const { callee } = await calleeOf(s);
    const kill = s.router.invoke('com.p');
    const nowait = s.router.invoke('com.p');
    const [a, b] = [await callee.nextOf(MSG.INVOCATION), await callee.nextOf(MSG.INVOCATION)];
    kill.interrupt();
    nowait.interrupt('killnowait');
    await s.settle();
    expect(callee.pending).toEqual([
      [MSG.INTERRUPT, a[1], { mode: 'kill' }],
      [MSG.INTERRUPT, b[1], { mode: 'killnowait' }],
    ]);
    expect([kill.done, nowait.error?.uri]).toEqual([false, 'wamp.error.canceled']);
    callee.send([MSG.ERROR, MSG.INVOCATION, a[1], {}, 'wamp.error.canceled']);
    await s.settle();
    expect(kill.error?.uri).toBe('wamp.error.canceled');
    nowait.interrupt(); // done: nothing
    await s.settle();
    expect(callee.pending.length).toBe(2);
    expect(() => {
      kill.interrupt('skip' as 'kill');
    }).toThrow(new TypeError("interrupt(mode): 'kill' or 'killnowait'"));
  });

  test('no registration (or no such realm) ⇒ no_such_procedure at once; the callee leaving ⇒ canceled', async () => {
    const s = setup();
    const none = s.router.invoke('com.p');
    await s.settle();
    expect([none.done, none.error?.uri, none.invocation]).toEqual([true, 'wamp.error.no_such_procedure', undefined]);
    none.interrupt();
    const { callee } = await calleeOf(s);
    expect(s.router.invoke('com.p', { realm: 'other' }).error?.uri).toBe('wamp.error.no_such_procedure');
    const call = s.router.invoke('com.p', { realm: 'realm1' });
    await callee.nextOf(MSG.INVOCATION);
    callee.ws.close(1000);
    await s.settle();
    expect(call.error?.uri).toBe('wamp.error.canceled');
  });
});

describe('invoke(): realms, queues and cleanup', () => {
  test('without a realm, the first realm that has the procedure (not merely the first realm)', async () => {
    const s = setup();
    await s.join(); // realm1 exists first
    const callee = await s.join({}, 'realm2');
    await callee.register('com.p');
    s.router.invoke('com.p');
    expect((await callee.nextOf(MSG.INVOCATION))[0]).toBe(MSG.INVOCATION);
  });

  test("Thruway's _thruway queue: a router call waits for a free callee; interrupting it queued does nothing", async () => {
    const s = setup({ dialect: 'thruway-php' });
    const callee = await s.join();
    await callee.register('com.q', { invoke: '_thruway' });
    const caller = await s.join();
    caller.send(callFrame(1, 'com.q', ['client']));
    const first = await callee.nextOf(MSG.INVOCATION);
    const queued = s.router.invoke('com.q', { args: ['router'] });
    queued.interrupt('killnowait');
    await s.settle();
    expect([queued.done, callee.pending]).toEqual([false, []]);
    callee.send([MSG.YIELD, first[1], {}, []]);
    await s.settle();
    const inv = callee.take(() => true)!;
    expect(inv[4]).toEqual(['router']);
    // interrupt(killnowait) frees the callee at once: the next queued call goes
    caller.send(callFrame(2, 'com.q', ['next']));
    await s.settle();
    queued.interrupt('killnowait');
    await s.settle();
    expect(callee.pending.map((f) => (f[0] === MSG.INVOCATION ? f[4] : f[0]))).toEqual([MSG.INTERRUPT, ['next']]);
    expect(s.router.sessions.find((x) => x.connection === callee.ws.controls.number)?.invocations).toBe(1);
  });
});

describe('kill() and per-connection sendRaw', () => {
  test('kill(session) sends GOODBYE to that session only [wamp.close.killed]; unknown ids and handshaking connections are untouched', async () => {
    const s = setup({
      authenticate: (h) =>
        h.realm === 'auth' ? { challenge: { method: 't' }, verify: () => ({ welcome: {} }) } : { welcome: {} },
    });
    const a = await s.join();
    const b = await s.join();
    const c = await s.open();
    c.send([MSG.HELLO, 'auth', { roles: PEER_ROLES }]);
    await s.settle();
    s.router.kill(sessionId(a));
    s.router.kill(424242);
    await s.settle();
    expect(a.pending).toEqual([[MSG.GOODBYE, {}, 'wamp.close.killed']]);
    expect(b.pending).toEqual([]);
    s.router.kill(sessionId(b), 'com.kicked', { message: 'bye' });
    await s.settle();
    expect(b.pending).toEqual([[MSG.GOODBYE, { message: 'bye' }, 'com.kicked']]);
    expect(c.pending.map((f) => f[0])).toEqual([MSG.CHALLENGE]);
  });

  test('sendRaw(data, connection) and connection.sendRaw(data) write to one connection', async () => {
    const s = setup();
    const a = await s.join();
    const b = await s.join();
    s.router.sendRaw('[36,1,2,{}]', b.ws.controls.number);
    s.router.connections[0]!.sendRaw('[36,3,4,{}]');
    await s.settle();
    expect([a.pending, b.pending]).toEqual([[[36, 3, 4, {}]], [[36, 1, 2, {}]]]);
  });
});

describe('auth providers on the spec dialect', () => {
  const ticket: SimAuthProvider = {
    method: 'ticket',
    realms: ['realm1'],
    verify: (sig, hello, extra) => (sig === 'ok' ? { authid: hello.details['authid'], extra } : false),
  };
  const cra: SimAuthProvider = {
    method: 'wampcra',
    extra: () => ({ challenge: 'c' }),
    verify: () => ({ authid: 'c' }),
  };

  async function hello(s: Setup, details: Record<string, unknown>, realm = 'realm1'): Promise<WampPeer> {
    const p = await s.open();
    p.send([MSG.HELLO, realm, { roles: PEER_ROLES, ...details }]);
    await s.settle();
    return p;
  }

  test('one CHALLENGE, for the first offered method a provider covers; the WELCOME carries the provider’s details', async () => {
    const s = setup({ providers: [cra, ticket] });
    const p = await hello(s, { authmethods: ['nope', 'ticket', 'wampcra'], authid: 'u' });
    expect(p.pending).toEqual([[MSG.CHALLENGE, 'ticket', {}]]);
    p.send([MSG.AUTHENTICATE, 'ok', {}]);
    await s.settle();
    expect(p.pending.at(-1)).toEqual([
      MSG.WELCOME,
      expect.any(Number),
      { roles: s.router.quirks.roles, authid: 'u', extra: {} },
    ]);
    const q = await hello(s, { authmethods: ['ticket'] });
    q.send([MSG.AUTHENTICATE, 'bad', {}]);
    await s.settle();
    expect(q.pending.at(-1)).toEqual([MSG.ABORT, {}, 'wamp.error.authentication_failed']);
  });

  test('anonymous: allowed where no provider covers the realm, or by an anonymous provider; otherwise no_auth_method', async () => {
    const s = setup({ providers: [ticket, { method: 'anonymous', realms: ['open'] }] });
    for (const [realm, details, first] of [
      ['other', {}, MSG.WELCOME],
      ['other', { authmethods: ['anonymous'] }, MSG.WELCOME],
      ['other', { authmethods: ['ticket'] }, MSG.ABORT],
      ['realm1', {}, MSG.ABORT],
      ['open', {}, MSG.WELCOME],
    ] as const) {
      const p = await hello(s, details, realm);
      expect([realm, details, p.pending[0]![0]]).toEqual([realm, details, first]);
      if (first === MSG.ABORT) expect(p.pending[0]![2]).toBe('wamp.error.no_auth_method');
      else expect(p.pending[0]![2]).toEqual(expect.objectContaining({ authmethod: 'anonymous' }));
    }
  });

  test('a welcome provider admits without CHALLENGE (details as returned); stale ⇒ authorization_failed; silent ⇒ no answer', async () => {
    const s = setup({ providers: [{ method: 'trusted', welcome: () => ({ authid: 'svc' }) }, ticket] });
    expect((await hello(s, { authmethods: ['trusted'] })).pending).toEqual([
      [MSG.WELCOME, expect.any(Number), { roles: s.router.quirks.roles, authid: 'svc' }],
    ]);
    s.router.setProvider('ticket', 'stale');
    expect((await hello(s, { authmethods: ['ticket'] })).pending).toEqual([
      [MSG.ABORT, {}, 'wamp.error.authorization_failed'],
    ]);
    s.router.setProvider('ticket', 'silent');
    const silent = await hello(s, { authmethods: ['ticket'] });
    await s.clock.advance(60_000);
    expect(silent.pending).toEqual([]);
  });

  test('the authenticate hook takes precedence over providers; a challengeGap changes nothing with one CHALLENGE', async () => {
    const s = setup({ providers: [ticket], challengeGap: 100, authenticate: () => ({ welcome: { authid: 'hook' } }) });
    expect((await hello(s, { authmethods: ['ticket'] })).pending[0]![2]).toEqual(
      expect.objectContaining({ authid: 'hook' }),
    );
    const t = setup({ providers: [ticket], challengeGap: 100 });
    const p = await hello(t, { authmethods: ['ticket'] });
    expect(p.pending).toEqual([[MSG.CHALLENGE, 'ticket', {}]]);
    expect(t.clock.scope('router').pendingTimers).toBe(0);
  });

  test("router.php's realm list: realms '*' or listed; a provider without realms covers every realm", async () => {
    const s = setup({ providers: [{ ...ticket, realms: ['*'] }] });
    expect((await hello(s, { authmethods: ['ticket'] }, 'any')).pending[0]![0]).toBe(MSG.CHALLENGE);
    const t = setup({ providers: [{ method: 'ticket', verify: () => false }] });
    expect((await hello(t, { authmethods: ['ticket'] }, 'any')).pending[0]![0]).toBe(MSG.CHALLENGE);
  });

  test('a session challenged by a provider is not in the realm on the spec dialect', async () => {
    const s = setup({ providers: [ticket] });
    await hello(s, { authmethods: ['ticket'] });
    expect(s.router.connections[0]!.session).toBeUndefined();
    expect(s.router.sessions).toEqual([]);
  });
});

describe('the fake socket: per-direction freeze and vanish()', () => {
  test("freeze('drop', 'up') is a black hole for the client's frames only; 'down' for the router's; thaw per direction", async () => {
    const s = setup();
    s.router.procedure('com.p', () => 'ok');
    const p = await s.join();
    const controls = p.ws.controls;
    controls.freeze('drop', 'up');
    expect([controls.frozen, controls.frozenDirections]).toEqual(['drop', { up: 'drop', down: undefined }]);
    p.send(callFrame(1, 'com.p'));
    s.router.publish('com.t');
    await s.settle();
    expect(p.pending).toEqual([]); // the CALL never arrived
    s.router.sendRaw('[36,1,2,{}]');
    await s.settle();
    expect(p.pending).toEqual([[36, 1, 2, {}]]); // the router's frames still do
    controls.thaw('up');
    controls.freeze('buffer', 'down');
    expect(controls.frozenDirections).toEqual({ up: undefined, down: 'buffer' });
    p.send(callFrame(2, 'com.p'));
    await s.settle();
    expect(p.pending.length).toBe(1);
    controls.thaw('down');
    await s.settle();
    expect(p.pending.at(-1)).toEqual([MSG.RESULT, 2, {}, ['ok']]);
    expect(controls.frozen).toBeUndefined();
    // thawing one direction leaves the other frozen
    controls.freeze('buffer');
    controls.thaw('down');
    expect(controls.frozenDirections).toEqual({ up: 'buffer', down: undefined });
    controls.freeze('drop', 'down');
    controls.thaw('up');
    expect(controls.frozenDirections).toEqual({ up: undefined, down: 'drop' });
    controls.thaw();
    expect(() => {
      controls.freeze('drop', 'sideways' as 'up');
    }).toThrow(new TypeError("direction must be 'up', 'down' or 'both'"));
    expect(() => {
      controls.thaw('left' as 'up');
    }).toThrow(TypeError);
  });

  test('vanish(): the client sees 1006 (error, close); the router end stays open and never learns until it drops the link', async () => {
    const s = setup();
    const callee = await s.join();
    await callee.register('com.p');
    const caller = await s.join();
    callee.ws.controls.vanish();
    caller.send(callFrame(1, 'com.p'));
    await s.settle();
    expect(callee.events.slice(-2)).toEqual(['error', 'close:1006']);
    expect([callee.ws.controls.vanished, s.router.connections[0]!.state]).toEqual([true, 'open']);
    expect(s.router.sessions.length).toBe(2); // a ghost
    expect(caller.pending).toEqual([]); // the INVOCATION went nowhere
    callee.ws.controls.vanish(); // again: nothing
    s.router.connections[0]!.controls.drop();
    await s.settle();
    expect(caller.pending).toEqual([[MSG.ERROR, MSG.CALL, 1, {}, 'wamp.error.canceled']]);
    expect(s.router.sessions.length).toBe(1);
    caller.ws.close(1000);
    await s.settle();
    caller.ws.controls.vanish(); // closed: nothing
    expect(caller.ws.controls.vanished).toBe(false);
  });

  test('a vanished link drops what the client wrote before it learnt, and what was on the wire', async () => {
    const s = setup({ latency: { in: 5, out: 5 } });
    const p = await s.join();
    s.router.sendRaw('[36,1,2,{}]'); // on the wire for 5 ms
    p.send([MSG.SUBSCRIBE, 1, {}, 'com.t']);
    await s.clock.advance(1);
    p.ws.controls.vanish();
    p.send([MSG.SUBSCRIBE, 2, {}, 'com.t']); // still OPEN on the client: written, never arrives
    await s.settle();
    expect(p.pending).toEqual([]);
    expect(p.events.slice(-2)).toEqual(['error', 'close:1006']);
    expect(s.router.sessions[0]!.subscriptions).toEqual([]);
  });
});

describe('heal() and setQuirks(): the model’s healing', () => {
  test('heal() removes ignore predicates and deny rules, accepts connections, registers providers, attaches the manager, thaws links', async () => {
    const s = setup({
      dialect: 'thruway-php',
      providers: [{ method: 'ticket', realms: ['auth'], extra: () => ({}), verify: () => ({ authid: 't' }) }],
    });
    s.router.procedure('com.p', () => 'ok');
    const p = await s.join();
    s.router.ignore((f) => f[0] === MSG.CALL);
    s.router.deny(() => true);
    s.router.setProvider('ticket', 'silent');
    s.router.setAuthManager('not_ready');
    p.ws.controls.freeze('buffer', 'down');
    p.send(callFrame(1, 'com.p'));
    await s.settle();
    s.router.setAvailable('refuse');
    s.router.heal();
    await s.settle();
    expect(p.ws.controls.frozen).toBeUndefined();
    p.send(callFrame(2, 'com.p'));
    expect(await p.nextOf(MSG.RESULT, 2)).toEqual([MSG.RESULT, 2, {}, ['ok']]);
    const q = await s.open();
    q.send([MSG.HELLO, 'auth', { roles: PEER_ROLES, authmethods: ['ticket'] }]);
    expect((await q.nextOf(MSG.CHALLENGE))[1]).toBe('ticket');
  });

  test('heal() restores the configured AuthenticationManager: a noauth router keeps its echo WELCOME', async () => {
    const s = setup({ dialect: 'thruway-php', authManager: 'none' });
    s.router.setAuthManager('not_ready');
    s.router.heal();
    const q = await s.open();
    q.send([MSG.HELLO, 'realm1', { roles: PEER_ROLES, authmethods: ['ticket'], authid: 'joe' }]);
    const welcome = await q.nextOf(MSG.WELCOME);
    expect(welcome[2]).toEqual(expect.objectContaining({ authid: 'joe', authmethods: ['ticket'] }));
  });

  test('setQuirks lifts a dialect silence while running; quirks shows the flags in effect, frozen', async () => {
    const s = setup({ dialect: 'thruway-php' });
    const p = await s.join();
    p.send([MSG.SUBSCRIBE, 1, { match: 'wildcard' }, 'com..x']);
    await s.settle();
    expect(p.pending).toEqual([]);
    s.router.setQuirks({
      subscribe_match: { prefix: 'yes', wildcard: 'yes' },
      uri_check: { ...s.router.quirks.uri_check, subscribe: 'loose' },
    });
    expect(s.router.quirks.subscribe_match.wildcard).toBe('yes');
    expect(s.router.quirks.cancel_error_type).toBe(49);
    expect(Object.isFrozen(s.router.quirks)).toBe(true);
    p.send([MSG.SUBSCRIBE, 2, { match: 'wildcard' }, 'com..x']);
    expect((await p.nextOf(MSG.SUBSCRIBED, 2))[0]).toBe(MSG.SUBSCRIBED);
  });
});
