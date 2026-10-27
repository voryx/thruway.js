// The router smoke scripts (test/routers/probes/smoke.mjs, smoke-b.mjs, smoke-c.mjs) ported to the testing kit: the
// same frame sequences and checks, driven through the fake socket against the reference router. Each scenario runs
// under every delivery profile (virtual clock with and without latency and both tie orders, microtasks, synchronous,
// manual flushing) and with the auth variants the scripts accept (anonymous, ticket, WAMP-CRA plain and salted,
// WAMP-Cryptosign), the credentials of routers/ROUTERS-C.md (joe/secret2, peter/secret1 + salt123,
// ticketuser/ticketsecret) verified by an `authenticate` hook written like the routers' providers.
import { createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { AuthDecision } from '../../src/testing/index.js';
import { createRouter, type SimRouter, type SimRouterOptions } from '../../src/testing/router.js';
import { createSimClock, drainMicrotasks } from '../../src/testing/sim.js';
import { MSG, WampPeer, type Frame } from '../helpers/wamp-peer.js';

// --- delivery profiles ----------------------------------------------------------------------------------------------

interface Profile {
  readonly name: string;
  make(options: Omit<SimRouterOptions, 'clock' | 'delivery'>): { router: SimRouter; settle: () => Promise<void> };
}

const profiles: readonly Profile[] = [
  {
    name: 'virtual clock, latency in 3 ms / out 7 ms',
    make: (options) => {
      const clock = createSimClock({ seed: 11 });
      const router = createRouter({ ...options, clock: clock.scope('router'), latency: { in: 3, out: 7 } });
      return { router, settle: () => clock.runUntilIdle() };
    },
  },
  {
    name: 'virtual clock, no latency, timers first',
    make: (options) => {
      const clock = createSimClock({ seed: 12, tieOrder: 'timers-first' });
      const router = createRouter({ ...options, clock });
      return { router, settle: () => clock.runUntilIdle() };
    },
  },
  {
    name: 'microtasks (no clock)',
    make: (options) => ({ router: createRouter(options), settle: () => drainMicrotasks() }),
  },
  {
    name: 'synchronous',
    make: (options) => ({ router: createRouter({ ...options, delivery: 'sync' }), settle: () => drainMicrotasks() }),
  },
  {
    name: 'manual flushing',
    make: (options) => {
      const router = createRouter({ ...options, delivery: 'manual' });
      return {
        router,
        settle: async () => {
          do await drainMicrotasks();
          while (router.flush() > 0);
        },
      };
    },
  },
];

// --- auth: providers like the routers' (verification by the router, signing by the client like the scripts) ---------

const SALTED = { salt: 'salt123', keylen: 32, iterations: 1000 };
const USERS: Readonly<Record<string, { readonly method: string; readonly secret: string; readonly salted?: boolean }>> =
  {
    joe: { method: 'wampcra', secret: 'secret2' },
    peter: { method: 'wampcra', secret: 'secret1', salted: true },
    ticketuser: { method: 'ticket', secret: 'ticketsecret' },
  };
const SEED = randomBytes(32);
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PRIVATE_KEY = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, SEED]), format: 'der', type: 'pkcs8' });
const PUBKEY = createPublicKey(PRIVATE_KEY).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function craKey(secret: string, extra: Record<string, unknown>): string {
  if (extra['salt'] === undefined) return secret;
  return pbkdf2Sync(
    secret,
    extra['salt'] as string,
    Number(extra['iterations'] ?? 1000),
    Number(extra['keylen'] ?? 32),
    'sha256',
  ).toString('base64');
}

/** The router side: WAMP-CRA (challenge string like Thruway's), ticket, cryptosign (96-byte signature || challenge). */
function authenticate(hello: { realm: string; details: Record<string, unknown> }): AuthDecision {
  const methods = (hello.details['authmethods'] ?? []) as string[];
  const authid = hello.details['authid'] as string | undefined;
  const welcome = (method: string, id: string): AuthDecision => ({
    welcome: { authid: id, authrole: 'user', authmethod: method, authprovider: 'static' },
  });
  const fail: AuthDecision = { abort: 'thruway.error.authentication_failure', details: { message: 'bad credentials' } };
  if (methods.includes('cryptosign')) {
    const pubkey = (hello.details['authextra'] as Record<string, unknown> | undefined)?.['pubkey'];
    const challenge = randomBytes(32);
    return {
      challenge: { method: 'cryptosign', extra: { challenge: challenge.toString('hex'), channel_binding: null } },
      verify: (signature) => {
        const bytes = Buffer.from(signature, 'hex');
        const key = createPublicKey({
          key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(String(pubkey), 'hex')]),
          format: 'der',
          type: 'spki',
        });
        const ok =
          bytes.length === 96 &&
          bytes.subarray(64).equals(challenge) &&
          verify(null, challenge, key, bytes.subarray(0, 64));
        return ok ? welcome('cryptosign', authid ?? 'csuser') : fail;
      },
    };
  }
  if (methods.length === 0 || methods.includes('anonymous'))
    return { welcome: { authid: 'anonymous', authrole: 'anonymous', authmethod: 'anonymous' } };
  const user = authid === undefined ? undefined : USERS[authid];
  if (user === undefined || !methods.includes(user.method)) return { abort: 'wamp.error.not_authorized' };
  if (user.method === 'ticket') {
    return {
      challenge: { method: 'ticket', extra: { challenge: {}, challenge_method: 'ticket' } },
      verify: (t) => (t === user.secret ? welcome('ticket', authid!) : fail),
    };
  }
  const challenge = JSON.stringify({
    authid,
    authrole: 'user',
    authmethod: 'wampcra',
    authprovider: 'static',
    nonce: randomBytes(16).toString('hex'),
    timestamp: '2026-10-25T20:20:41.511Z',
  });
  const extra: Record<string, unknown> = { challenge, ...(user.salted === true ? SALTED : {}) };
  return {
    challenge: { method: 'wampcra', extra },
    verify: (sig) =>
      sig === createHmac('sha256', craKey(user.secret, extra)).update(challenge).digest('base64')
        ? welcome('wampcra', authid!)
        : fail,
  };
}

interface Credentials {
  readonly name: string;
  readonly details: Record<string, unknown>;
  readonly answer: ((method: string, extra: Record<string, unknown>) => string) | undefined;
  readonly authmethod: string;
}

/** The client side, as the scripts sign. */
const credentials: readonly Credentials[] = [
  { name: 'anonymous', details: { authmethods: ['anonymous'] }, answer: undefined, authmethod: 'anonymous' },
  {
    name: 'ticket ticketuser',
    details: { authmethods: ['ticket'], authid: 'ticketuser' },
    answer: () => 'ticketsecret',
    authmethod: 'ticket',
  },
  {
    name: 'wampcra joe',
    details: { authmethods: ['wampcra'], authid: 'joe' },
    answer: (_m, extra) =>
      createHmac('sha256', craKey('secret2', extra)).update(String(extra['challenge'])).digest('base64'),
    authmethod: 'wampcra',
  },
  {
    name: 'wampcra peter (salted)',
    details: { authmethods: ['wampcra'], authid: 'peter' },
    answer: (_m, extra) =>
      createHmac('sha256', craKey('secret1', extra)).update(String(extra['challenge'])).digest('base64'),
    authmethod: 'wampcra',
  },
  {
    name: 'cryptosign csuser',
    details: { authmethods: ['cryptosign'], authid: 'csuser', authextra: { pubkey: PUBKEY } },
    answer: (_m, extra) => {
      const challenge = Buffer.from(String(extra['challenge']), 'hex');
      return Buffer.concat([sign(null, challenge, PRIVATE_KEY), challenge]).toString('hex');
    },
    authmethod: 'cryptosign',
  },
];

/** routers/smoke.mjs: one session — REGISTER + CALL of its own procedure, SUBSCRIBE + PUBLISH to itself, GOODBYE. */
async function smoke(router: SimRouter, settle: () => Promise<void>, creds: Credentials): Promise<void> {
  const peer = new WampPeer(router.WebSocket, router.url, settle);
  await settle();
  expect(peer.ws.protocol).toBe('wamp.2.json');
  const welcome = await peer.join('realm1', creds.details, creds.answer);
  expect(welcome[0]).toBe(MSG.WELCOME);
  const sessionId = welcome[1] as number;
  expect((welcome[2] as Record<string, unknown>)['authmethod']).toBe(creds.authmethod);

  // 2. REGISTER + CALL, answering the INVOCATION with YIELD
  const proc = `com.thruway.smoke.add.${String(sessionId)}`;
  const regId = await peer.register(proc);
  const callReq = peer.id();
  peer.send([MSG.CALL, callReq, {}, proc, [2, 3], { greet: 'hi' }]);
  const inv = await peer.next((x) => x[0] === MSG.INVOCATION && x[2] === regId, 'INVOCATION');
  const invReq = inv[1] as number;
  const invArgs = (inv[4] ?? []) as number[];
  const invKw = (inv[5] ?? {}) as Record<string, unknown>;
  peer.send([MSG.YIELD, invReq, {}, [invArgs[0]! + invArgs[1]!], { echo: invKw['greet'] }]);
  const result = await peer.next((x) => x[0] === MSG.RESULT && x[1] === callReq, 'RESULT');
  expect([(result[3] as unknown[])[0], (result[4] as Record<string, unknown>)['echo']]).toEqual([5, 'hi']);

  // 3. SUBSCRIBE + PUBLISH(acknowledge, exclude_me: false): PUBLISHED and EVENT, same publication id
  const topic = `com.thruway.smoke.topic.${String(sessionId)}`;
  const subId = await peer.subscribe(topic);
  const pubReq = peer.id();
  peer.send([MSG.PUBLISH, pubReq, { acknowledge: true, exclude_me: false }, topic, ['hello'], { n: 1 }]);
  const published = await peer.next((x) => x[0] === MSG.PUBLISHED && x[1] === pubReq, 'PUBLISHED');
  const event = await peer.next((x) => x[0] === MSG.EVENT && x[1] === subId, 'EVENT');
  expect(event[2]).toBe(published[2]);
  expect(event.slice(4)).toEqual([['hello'], { n: 1 }]);

  // 4. GOODBYE
  expect(await peer.goodbye()).toEqual([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
  peer.ws.close(1000);
  await settle();
  expect(peer.pending).toEqual([]); // no leftovers
  expect(peer.closed?.code).toBe(1000);
}

describe.each(profiles)('routers/smoke.mjs over the fake socket — $name', (profile) => {
  test.each(credentials)('$name', async (creds) => {
    const { router, settle } = profile.make({ authenticate });
    await smoke(router, settle, creds);
    expect(router.violations).toEqual([]);
    expect(router.errors).toEqual([]);
  });

  test('wrong credentials are refused like Thruway (ABORT thruway.error.authentication_failure / not_authorized)', async () => {
    const { router, settle } = profile.make({ authenticate });
    const bad = new WampPeer(router.WebSocket, router.url, settle);
    expect(await bad.join('realm1', { authmethods: ['wampcra'], authid: 'joe' }, () => 'wrong')).toEqual([
      MSG.ABORT,
      { message: 'bad credentials' },
      'thruway.error.authentication_failure',
    ]);
    const unknown = new WampPeer(router.WebSocket, router.url, settle);
    expect(await unknown.join('realm1', { authmethods: ['ticket'], authid: 'nobody' })).toEqual([
      MSG.ABORT,
      {},
      'wamp.error.not_authorized',
    ]);
  });
});

/** routers/smoke-b.mjs: the core flow plus its observations (duplicate REGISTER, progressive results, unknown
 *  procedure, PUBLISHED/EVENT order, default exclude_me, UNSUBSCRIBE/UNREGISTER, the GOODBYE close). */
async function smokeB(
  router: SimRouter,
  settle: () => Promise<void>,
  randomIds: boolean,
): Promise<Record<string, unknown>> {
  const obs: Record<string, unknown> = {};
  const s = new WampPeer(router.WebSocket, router.url, settle);
  let next = 1;
  const id = (): number => (randomIds ? 1 + Math.floor(Math.random() * (2 ** 53 - 1)) : next++);
  const welcome = await s.join('realm1');
  expect(welcome[0]).toBe(MSG.WELCOME);
  const request = async (msg: Frame, okType: number): Promise<Frame> => {
    s.send(msg);
    return s.reply(msg[0] as number, msg[1] as number, okType);
  };
  const proc = 'com.thruway.smoke.add';
  const topic = 'com.thruway.smoke.topic';
  const registration: { id: unknown } = { id: undefined };
  let progressOffered = false;
  s.onFrame = (m) => {
    if (m[0] !== MSG.INVOCATION || m[2] !== registration.id) return false;
    const invId = m[1] as number;
    const det = (m[3] ?? {}) as Record<string, unknown>;
    const args = (m[4] ?? []) as number[];
    const kwargs = (m[5] ?? {}) as Record<string, unknown>;
    if (det['receive_progress'] === true) {
      progressOffered = true;
      s.send([MSG.YIELD, invId, { progress: true }, ['partial']]);
    }
    const sum = args.reduce((a, b) => a + b, 0);
    s.send([MSG.YIELD, invId, {}, [sum], kwargs['echo'] !== undefined ? { echo: kwargs['echo'] } : {}]);
    return true;
  };

  let m = await request([MSG.REGISTER, id(), {}, proc], MSG.REGISTERED);
  expect(m[0]).toBe(MSG.REGISTERED);
  registration.id = m[2];
  m = await request([MSG.REGISTER, id(), {}, proc], MSG.REGISTERED);
  obs['duplicateRegister'] = m[0] === MSG.ERROR ? m[4] : 'accepted';
  m = await request([MSG.CALL, id(), {}, proc, [2, 3], { echo: 'x' }], MSG.RESULT);
  expect([m[0], m[3], m[4]]).toEqual([MSG.RESULT, [5], { echo: 'x' }]);

  const pid = id();
  s.send([MSG.CALL, pid, { receive_progress: true }, proc, [1, 1]]);
  const prog: string[] = [];
  for (;;) {
    const r = await s.next(
      (x) => (x[0] === MSG.RESULT && x[1] === pid) || (x[0] === MSG.ERROR && x[2] === pid),
      'progressive RESULT',
    );
    if (r[0] === MSG.ERROR) {
      prog.push(`ERROR ${String(r[4])}`);
      break;
    }
    prog.push((r[2] as Record<string, unknown>)['progress'] === true ? 'progress' : 'final');
    if ((r[2] as Record<string, unknown>)['progress'] !== true) break;
  }
  obs['progressiveResults'] = { invocationHadReceiveProgress: progressOffered, sequence: prog };

  m = await request([MSG.CALL, id(), {}, 'com.thruway.smoke.nope', []], MSG.RESULT);
  obs['unknownProcedure'] = m[4];

  m = await request([MSG.SUBSCRIBE, id(), {}, topic], MSG.SUBSCRIBED);
  expect(m[0]).toBe(MSG.SUBSCRIBED);
  const subId = m[2];
  const pubReq = id();
  const before = s.received.length;
  s.send([MSG.PUBLISH, pubReq, { acknowledge: true, exclude_me: false }, topic, ['hello'], { n: 1 }]);
  const pa = await s.next(
    (x) => (x[0] === MSG.PUBLISHED && x[1] === pubReq) || (x[0] === MSG.ERROR && x[2] === pubReq),
    'PUBLISHED',
  );
  const ev = await s.next((x) => x[0] === MSG.EVENT && x[1] === subId, 'EVENT');
  expect([pa[0], ev[4]]).toEqual([MSG.PUBLISHED, ['hello']]);
  obs['samePublicationId'] = pa[2] === ev[2];
  obs['publishOrder'] = s.received
    .slice(before)
    .map((f) => (f[0] === MSG.PUBLISHED ? 'PUBLISHED' : f[0] === MSG.EVENT ? 'EVENT' : ''))
    .filter(Boolean)
    .join('>');

  const pub2 = id();
  s.send([MSG.PUBLISH, pub2, { acknowledge: true }, topic, ['self']]);
  await s.next((x) => x[0] === MSG.PUBLISHED && x[1] === pub2, 'PUBLISHED 2');
  obs['defaultExcludeMe'] =
    s.take((x) => x[0] === MSG.EVENT && x[1] === subId) === undefined ? 'no self EVENT (spec default)' : 'self EVENT';

  m = await request([MSG.UNSUBSCRIBE, id(), subId], MSG.UNSUBSCRIBED);
  obs['unsubscribe'] = m[0] === MSG.UNSUBSCRIBED ? 'ok' : `ERROR ${String(m[4])}`;
  m = await request([MSG.UNREGISTER, id(), registration.id], MSG.UNREGISTERED);
  obs['unregister'] = m[0] === MSG.UNREGISTERED ? 'ok' : `ERROR ${String(m[4])}`;

  s.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
  const g = await s.nextOf(MSG.GOODBYE);
  obs['goodbyeReply'] = g[2];
  await settle();
  obs['routerClosedSocket'] = s.closed;
  obs['queuedUnhandled'] = s.pending.map((x) => x[0]);
  return obs;
}

describe.each(profiles)('routers/smoke-b.mjs over the fake socket — $name', (profile) => {
  test.each([false, true])('request ids random: %s', async (randomIds) => {
    const { router, settle } = profile.make({});
    expect(await smokeB(router, settle, randomIds)).toEqual({
      duplicateRegister: 'wamp.error.procedure_already_exists',
      progressiveResults: { invocationHadReceiveProgress: true, sequence: ['progress', 'final'] },
      unknownProcedure: 'wamp.error.no_such_procedure',
      samePublicationId: true,
      publishOrder: 'EVENT>PUBLISHED',
      defaultExcludeMe: 'no self EVENT (spec default)',
      unsubscribe: 'ok',
      unregister: 'ok',
      goodbyeReply: 'wamp.close.goodbye_and_out',
      routerClosedSocket: { code: 1000, reason: '', wasClean: true },
      queuedUnhandled: [],
    });
    expect(router.violations).toEqual([]);
  });
});

/** routers/smoke-c.mjs: two sessions — A callee + subscriber, B caller + publisher. */
async function smokeC(router: SimRouter, settle: () => Promise<void>, creds: Credentials): Promise<string[]> {
  const steps: string[] = [];
  const A = new WampPeer(router.WebSocket, router.url, settle);
  const B = new WampPeer(router.WebSocket, router.url, settle);
  for (const [label, peer] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const w = await peer.join('realm1', creds.details, creds.answer);
    expect(w[0]).toBe(MSG.WELCOME);
    steps.push(`${label} HELLO->WELCOME`);
  }
  A.onFrame = (m) => {
    if (m[0] !== MSG.INVOCATION) return false;
    A.send([MSG.YIELD, m[1], {}, [(m[4] as number[]).reduce((x, y) => x + y, 0)]]);
    return true;
  };
  const PROC = 'smoke.c.add_test';
  const TOPIC = 'smoke.c.topic_test';
  const regId = await A.register(PROC);
  steps.push('A REGISTER');
  const callId = B.id();
  B.send([MSG.CALL, callId, {}, PROC, [2, 3]]);
  const r = await B.reply(MSG.CALL, callId, MSG.RESULT);
  expect(r[3]).toEqual([5]);
  steps.push('B CALL->RESULT');
  const subId = await A.subscribe(TOPIC);
  steps.push('A SUBSCRIBE');
  const pubId = B.id();
  B.send([MSG.PUBLISH, pubId, { acknowledge: true }, TOPIC, ['hello'], { n: 1 }]);
  const pub = await B.reply(MSG.PUBLISH, pubId, MSG.PUBLISHED);
  const ev = await A.next((m) => m[0] === MSG.EVENT && m[1] === subId, 'EVENT');
  expect(ev[2]).toBe(pub[2]);
  expect(ev.slice(4)).toEqual([['hello'], { n: 1 }]);
  steps.push('B PUBLISH{acknowledge}->PUBLISHED + A EVENT');
  const u = A.id();
  A.send([MSG.UNSUBSCRIBE, u, subId]);
  expect((await A.reply(MSG.UNSUBSCRIBE, u, MSG.UNSUBSCRIBED))[0]).toBe(MSG.UNSUBSCRIBED);
  steps.push('A UNSUBSCRIBE');
  const ur = A.id();
  A.send([MSG.UNREGISTER, ur, regId]);
  expect((await A.reply(MSG.UNREGISTER, ur, MSG.UNREGISTERED))[0]).toBe(MSG.UNREGISTERED);
  steps.push('A UNREGISTER');
  for (const [label, peer] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const reply = await peer.goodbye();
    peer.ws.close(1000);
    steps.push(`${label} GOODBYE->GOODBYE ${String(reply[2])}`);
  }
  await settle();
  return steps;
}

describe.each(profiles)('routers/smoke-c.mjs over the fake socket — $name', (profile) => {
  test.each(credentials.filter((c) => c.name !== 'cryptosign csuser'))('$name', async (creds) => {
    const { router, settle } = profile.make({ authenticate });
    expect(await smokeC(router, settle, creds)).toEqual([
      'A HELLO->WELCOME',
      'B HELLO->WELCOME',
      'A REGISTER',
      'B CALL->RESULT',
      'A SUBSCRIBE',
      'B PUBLISH{acknowledge}->PUBLISHED + A EVENT',
      'A UNSUBSCRIBE',
      'A UNREGISTER',
      'A GOODBYE->GOODBYE wamp.close.goodbye_and_out',
      'B GOODBYE->GOODBYE wamp.close.goodbye_and_out',
    ]);
    expect(router.violations).toEqual([]);
    expect(router.sessions).toEqual([]);
  });
});
