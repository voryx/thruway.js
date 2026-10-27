// Live probes that re-derive the deterministic capability flags of a router, so that a router change fails the
// integration job as drift instead of silently invalidating the recorded flags. Each probe uses raw peers
// (harness/raw-peer) so the client's own behaviour cannot hide a router change, and answers 'always' or 'never'; probes
// of behaviour that is known to vary run several times and answer 'sometimes' when the outcomes differ. Keys without a
// probe (a mechanism, a size, a property only a fault can show) are listed in UNPROBED with the reason.
import { RawPeer, MSG, NO_ANSWER, type Frame, sleep } from './raw-peer.js';
import { endpoint, type CapabilityKey, type Router, type Tri } from './routers.js';
import { unique } from './recorder.js';

export const UNPROBED: Readonly<Partial<Record<CapabilityKey, string>>> = {
  router_goodbye_trigger: 'a test mechanism, not a router behaviour',
  max_message_bytes: 'a size; probing it would push tens of MiB per router and run (payload.test.ts covers it)',
  ghost_registrations: 'needs a half-open link (chaos proxy); ghost.test.ts covers it',
};

type Outcome = 'always' | 'never';
type Probe = (r: Router) => Promise<Outcome>;

const WAIT = 1500;

function base(): string {
  return `com.thruwayjs.probe.${unique()}`;
}

async function join(r: Router, options: { cancel?: boolean } = {}): Promise<RawPeer> {
  return RawPeer.join(r.url, r.realm, options);
}

async function closeAll(...peers: (RawPeer | undefined)[]): Promise<void> {
  for (const p of peers) p?.close();
  await sleep(20);
}

/** A raw callee of a fresh procedure that never answers; resolves its INVOCATION. */
async function pendingCall(
  r: Router,
  options: { cancel?: boolean; callOptions?: Record<string, unknown> } = {},
): Promise<{
  callee: RawPeer;
  caller: RawPeer;
  id: number;
  invocation: Frame | undefined;
  answer: Promise<Frame | undefined>;
}> {
  const procedure = base();
  const callee = await join(r, { cancel: options.cancel ?? true });
  await callee.register(procedure);
  const caller = await join(r);
  const call = caller.call(procedure, [], {}, options.callOptions ?? {}, 4000);
  const invocation = await callee.next((f) => f[0] === MSG.INVOCATION, WAIT);
  return { callee, caller, id: call.id, invocation, answer: call.answer };
}

const yes = (b: boolean): Outcome => (b ? 'always' : 'never');

async function cancelProbe(
  r: Router,
  options: Record<string, unknown>,
): Promise<{ interrupted: boolean; replied: boolean }> {
  const p = await pendingCall(r);
  try {
    p.caller.send([MSG.CANCEL, p.id, options]);
    const interrupt = await p.callee.next((f) => f[0] === MSG.INTERRUPT, WAIT);
    const reply = await p.caller.next((f) => f[0] === MSG.ERROR && (f[1] === 48 || f[1] === 49) && f[2] === p.id, WAIT);
    return {
      interrupted: interrupt !== undefined,
      replied: reply !== undefined || (await p.answer)?.[0] === MSG.ERROR,
    };
  } finally {
    await closeAll(p.callee, p.caller);
  }
}

export const PROBES: Readonly<Partial<Record<CapabilityKey, Probe>>> = {
  cancel_interrupts_callee: async (r) => yes((await cancelProbe(r, { mode: 'killnowait' })).interrupted),
  cancel_reply: async (r) => yes((await cancelProbe(r, { mode: 'killnowait' })).replied),
  cancel_without_mode_interrupts: async (r) => yes((await cancelProbe(r, {})).interrupted),
  progressive_results: async (r) => {
    const procedure = base();
    const callee = await join(r);
    await callee.register(procedure);
    callee.serve((inv) => {
      callee.send([MSG.YIELD, inv[1], { progress: true }, ['partial']]);
      callee.send([MSG.YIELD, inv[1], {}, ['final']]);
      return NO_ANSWER;
    });
    const caller = await join(r);
    const call = caller.call(procedure, [], {}, { receive_progress: true });
    const progress = await caller.next(
      (f) => f[0] === MSG.RESULT && f[1] === call.id && (f[2] as { progress?: unknown }).progress === true,
      WAIT,
    );
    await closeAll(callee, caller);
    return yes(progress !== undefined);
  },
  invocation_receive_progress: async (r) => {
    const p = await pendingCall(r, { callOptions: { receive_progress: true } });
    await closeAll(p.callee, p.caller);
    return yes((p.invocation?.[3] as { receive_progress?: unknown } | undefined)?.receive_progress === true);
  },
  progressive_final_payload: async (r) => {
    const procedure = base();
    const callee = await join(r);
    await callee.register(procedure);
    callee.serve((inv) => {
      callee.send([MSG.YIELD, inv[1], {}, ['final']]);
      return NO_ANSWER;
    });
    const caller = await join(r);
    // the final answer: a progress RESULT carrying it would also do
    const call = caller.call(procedure, [], {}, { receive_progress: true }, WAIT);
    const final = await call.answer;
    const carried = [...caller.received, ...(final === undefined ? [] : [final])].some(
      (f) => f[0] === MSG.RESULT && f[1] === call.id && JSON.stringify(f[3]) === '["final"]',
    );
    await closeAll(callee, caller);
    return yes(carried);
  },
  wildcard_subscribe_answered: async (r) => {
    const p = await join(r);
    const answer = await p.subscribe(`${base()}..end`, { match: 'wildcard' }, WAIT);
    await closeAll(p);
    return yes(answer.frame !== undefined);
  },
  subscribe_match: async (r) => {
    const topic = base();
    const sub = await join(r);
    await sub.subscribe(topic, { match: 'prefix' });
    const pub = await join(r);
    pub.publish(`${topic}.leaf`, ['x'], {}, { acknowledge: true });
    const event = await sub.next((f) => f[0] === MSG.EVENT, WAIT);
    await closeAll(sub, pub);
    return yes(event !== undefined);
  },
  register_match: async (r) => {
    const procedure = base();
    const callee = await join(r);
    const reg = await callee.register(procedure, { match: 'prefix' });
    const caller = await join(r);
    caller.call(`${procedure}.leaf`);
    const invocation = reg.id === undefined ? undefined : await callee.next((f) => f[0] === MSG.INVOCATION, WAIT);
    await closeAll(callee, caller);
    return yes(invocation !== undefined);
  },
  goodbye_reply_delivered: async (r) => {
    const p = await join(r);
    const reply = await p.goodbye(WAIT);
    return yes(reply !== undefined);
  },
  abort_delivered: async (r) => {
    const a = r.auth;
    const p = await RawPeer.open(
      a === null ? r.url : endpoint(r, a.endpoint),
      a === null ? `com.thruwayjs.nosuch.${unique()}` : a.realm,
    );
    if (p === undefined) throw new Error('no socket');
    const credential = a?.ticket ?? null;
    const hello = await p.hello(
      a === null || credential === null
        ? { roles: { caller: {} } }
        : { roles: { caller: {} }, authmethods: [credential.method], authid: credential.authid },
      WAIT,
    );
    let abort = hello?.[0] === MSG.ABORT;
    if (hello?.[0] === MSG.CHALLENGE) {
      p.send([MSG.AUTHENTICATE, 'certainly-wrong', {}]);
      abort = (await p.next((f) => f[0] === MSG.ABORT, WAIT)) !== undefined;
    }
    await closeAll(p);
    return yes(abort);
  },
  router_closes_after_goodbye: async (r) => {
    const p = await join(r);
    p.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await p.next((f) => f[0] === MSG.GOODBYE, WAIT);
    const closed = await p.waitClosed(WAIT);
    await closeAll(p);
    return yes(closed !== undefined);
  },
  exclude_me: async (r) => {
    const topic = base();
    const p = await join(r);
    await p.subscribe(topic);
    p.publish(topic, ['default'], {}, { acknowledge: true });
    const own = await p.next((f) => f[0] === MSG.EVENT, 500);
    p.publish(topic, ['included'], {}, { acknowledge: true, exclude_me: false });
    const included = await p.next((f) => f[0] === MSG.EVENT, WAIT);
    await closeAll(p);
    return yes(own === undefined && included !== undefined);
  },
  blackwhite_listing: async (r) => {
    const topic = base();
    const a = await join(r);
    const b = await join(r);
    await a.subscribe(topic);
    await b.subscribe(topic);
    const pub = await join(r);
    pub.publish(topic, ['only b'], {}, { acknowledge: true, eligible: [b.sessionId] });
    const toB = await b.next((f) => f[0] === MSG.EVENT, WAIT);
    const toA = await a.next((f) => f[0] === MSG.EVENT, 300);
    await closeAll(a, b, pub);
    return yes(toB !== undefined && toA === undefined);
  },
  publisher_always_disclosed: async (r) => {
    const topic = base();
    const sub = await join(r);
    await sub.subscribe(topic);
    const pub = await join(r);
    pub.publish(topic, ['x'], {}, { acknowledge: true });
    const event = await sub.next((f) => f[0] === MSG.EVENT, WAIT);
    await closeAll(sub, pub);
    return yes((event?.[3] as { publisher?: unknown } | undefined)?.publisher !== undefined);
  },
  meta_kill: async (r) => {
    const victim = await join(r);
    const killer = await join(r);
    killer.call('wamp.session.kill', [victim.sessionId], { reason: 'wamp.close.killed', message: 'probe' });
    const closed = (await victim.next((f) => f[0] === MSG.GOODBYE, WAIT)) ?? (await victim.waitClosed(500));
    await closeAll(victim, killer);
    return yes(closed !== undefined);
  },
  strict_ids: async (r) => {
    if (r.strictRealm === null) return 'never';
    const p = await RawPeer.join(r.url, r.strictRealm);
    const call = p.call('com.thruwayjs.probe.strict', [], {}, {}, WAIT);
    p.send([MSG.CALL, 4242, {}, 'com.thruwayjs.probe.strict', []]); // not the next sequential id
    await call.answer;
    const closed = await p.waitClosed(WAIT);
    await closeAll(p);
    return yes(closed !== undefined);
  },
  callee_leave_answer: async (r) => {
    const p = await pendingCall(r);
    p.callee.close();
    const answer = await Promise.race([p.answer, sleep(WAIT).then(() => undefined)]);
    await closeAll(p.caller);
    return yes(answer?.[0] === MSG.ERROR);
  },
  caller_leave_interrupts: async (r) => {
    const p = await pendingCall(r);
    p.caller.close();
    const interrupt = await p.callee.next((f) => f[0] === MSG.INTERRUPT, WAIT);
    await closeAll(p.callee);
    return yes(interrupt !== undefined);
  },
  callee_error_forwarded: async (r) => {
    const p = await pendingCall(r);
    p.callee.send([
      MSG.ERROR,
      MSG.INVOCATION,
      p.invocation?.[1],
      { why: 1 },
      'com.thruwayjs.probe.err',
      ['a'],
      { k: 1 },
    ]);
    const answer = await p.answer;
    await closeAll(p.callee, p.caller);
    return yes(
      answer?.[0] === MSG.ERROR &&
        answer[4] === 'com.thruwayjs.probe.err' &&
        JSON.stringify(answer[5]) === '["a"]' &&
        JSON.stringify(answer[6]) === '{"k":1}',
    );
  },
  duplicate_register_rejected: async (r) => {
    const procedure = base();
    const a = await join(r);
    const b = await join(r);
    await a.register(procedure);
    const second = await b.register(procedure);
    await closeAll(a, b);
    return yes(second.frame?.[0] === MSG.ERROR && second.frame[4] === 'wamp.error.procedure_already_exists');
  },
  args_nested_array_preserved: async (r) => {
    const procedure = base();
    const callee = await join(r);
    await callee.register(procedure);
    const caller = await join(r);
    caller.call(procedure, [['x']]);
    const invocation = await callee.next((f) => f[0] === MSG.INVOCATION, WAIT);
    await closeAll(callee, caller);
    return yes(JSON.stringify(invocation?.[4]) === '[["x"]]');
  },
  event_details_topic: async (r) => {
    const topic = base();
    const sub = await join(r);
    await sub.subscribe(topic, { match: 'prefix' });
    const pub = await join(r);
    pub.publish(`${topic}.leaf`, ['x'], {}, { acknowledge: true });
    const event = await sub.next((f) => f[0] === MSG.EVENT, WAIT);
    await closeAll(sub, pub);
    return yes((event?.[3] as { topic?: unknown } | undefined)?.topic === `${topic}.leaf`);
  },
  wildcard_match: async (r) => {
    const topic = base();
    const sub = await join(r);
    const subscribed = await sub.subscribe(`${topic}..end`, { match: 'wildcard' }, WAIT);
    const pub = await join(r);
    pub.publish(`${topic}.middle.end`, ['x'], {}, { acknowledge: true });
    const event = subscribed.id === undefined ? undefined : await sub.next((f) => f[0] === MSG.EVENT, WAIT);
    await closeAll(sub, pub);
    return yes(event !== undefined);
  },
  invalid_realm_reply: async (r) => {
    const realm = r.id === 'fox-wamp' ? `nosuch_${unique()}` : `com.thruwayjs.nosuch.${unique()}`;
    const p = await RawPeer.open(r.url, realm);
    if (p === undefined) throw new Error('no socket');
    const hello = await p.hello({ roles: { caller: {} } }, WAIT);
    await closeAll(p);
    return yes(hello?.[0] === MSG.ABORT);
  },
  self_publish_order: async (r) => {
    const topic = base();
    const p = await join(r);
    await p.subscribe(topic);
    const id = p.publish(topic, ['self'], {}, { acknowledge: true, exclude_me: false });
    const first = await p.next((f) => (f[0] === MSG.PUBLISHED && f[1] === id) || f[0] === MSG.EVENT, WAIT);
    const second = await p.next((f) => (f[0] === MSG.PUBLISHED && f[1] === id) || f[0] === MSG.EVENT, WAIT);
    await closeAll(p);
    if (first === undefined || second === undefined) return 'never';
    return yes(first[0] === MSG.PUBLISHED);
  },
  subprotocol_echo: async (r) => {
    const p = await RawPeer.open(r.url, r.realm);
    const protocol = p?.ws.protocol;
    await closeAll(p);
    return yes(protocol === 'wamp.2.json');
  },
  shared_subscription_ids: async (r) => {
    const topic = base();
    const p = await join(r);
    const one = await p.subscribe(topic);
    const two = await p.subscribe(topic);
    await closeAll(p);
    return yes(one.id !== undefined && one.id === two.id);
  },
  multi_method_challenge: async (r) => {
    const a = r.auth;
    if (a?.dual == null) return 'never';
    const p = await RawPeer.open(endpoint(r, a.endpoint), a.realm);
    if (p === undefined) throw new Error('no socket');
    p.send([MSG.HELLO, a.realm, { roles: { caller: {} }, authmethods: ['ticket', 'wampcra'], authid: a.dual.authid }]);
    await sleep(500);
    const challenges = p.received.filter((f) => f[0] === MSG.CHALLENGE).length;
    await closeAll(p);
    return yes(challenges > 1);
  },
  anonymous_welcome_without_provider: async (r) => {
    // a HELLO that offers only a non-anonymous method (and no authid) on a realm nothing provides, and on the
    // authenticated endpoint's realm: any WELCOME without a CHALLENGE is an anonymous one
    const unprovided = r.id === 'fox-wamp' ? `unprovided_${unique()}` : `com.thruwayjs.unprovided.${unique()}`;
    const a = r.auth;
    const targets: [string, string, string][] = [[r.url, unprovided, 'ticket']];
    if (a !== null) targets.push([endpoint(r, a.endpoint), a.realm, a.ticket?.method ?? 'ticket']);
    let anonymous = false;
    for (const [url, realm, method] of targets) {
      const p = await RawPeer.open(url, realm);
      if (p === undefined) throw new Error('no socket');
      const hello = await p.hello({ roles: { caller: {} }, authmethods: [method] }, WAIT);
      anonymous ||= hello?.[0] === MSG.WELCOME;
      await closeAll(p);
    }
    return yes(anonymous);
  },
  probe_answered: async (r) => {
    const p = await join(r);
    const answer = await p.call('thruway.js.ping', [], {}, {}, WAIT).answer;
    await closeAll(p);
    return yes(answer !== undefined);
  },
  publisher_order_kept: async (r) => {
    const topic = base();
    const sub = await join(r);
    await sub.subscribe(topic);
    const pub = await join(r);
    let ordered = true;
    for (let round = 0; round < 10 && ordered; round++) {
      for (let i = 0; i < 10; i++) pub.publish(topic, [i], {}, { acknowledge: true });
      const got: unknown[] = [];
      for (let i = 0; i < 10; i++) got.push((await sub.next((f) => f[0] === MSG.EVENT, WAIT))?.[4]);
      ordered = JSON.stringify(got) === JSON.stringify(Array.from({ length: 10 }, (_, i) => [i]));
    }
    await closeAll(sub, pub);
    return yes(ordered);
  },
};

/** Keys whose behaviour varies between runs on some router: probed this many times (mixed ⇒ 'sometimes'). */
export const REPEAT: Readonly<Partial<Record<CapabilityKey, number>>> = {
  goodbye_reply_delivered: 3,
  invalid_realm_reply: 3,
  abort_delivered: 3,
  self_publish_order: 3,
  publisher_order_kept: 2,
  meta_kill: 2,
};

/** Run every probe against `r`; a probe that throws is reported with its error. */
export async function deriveCapabilities(r: Router): Promise<Map<CapabilityKey, Tri | Error>> {
  const out = new Map<CapabilityKey, Tri | Error>();
  for (const [key, probe] of Object.entries(PROBES) as [CapabilityKey, Probe][]) {
    const outcomes = new Set<Outcome>();
    try {
      for (let i = 0; i < (REPEAT[key] ?? 1); i++) outcomes.add(await probe(r));
      out.set(key, outcomes.size > 1 ? 'sometimes' : ([...outcomes][0] ?? 'never'));
    } catch (error) {
      out.set(key, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return out;
}
