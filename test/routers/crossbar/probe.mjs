#!/usr/bin/env node
// WAMP router behaviour probe (advanced profile features, error semantics, protocol-violation handling).
// Zero dependencies; Node 22+ (global WebSocket). Written against Crossbar.io but router-agnostic: every
// probe *records what the router did* instead of asserting one expected answer, so the output doubles as a
// "router quirks" table for the thruway.js v3 test suite.
//
//   node probe.mjs [--base ws://127.0.0.1:18080] [--realm realm1] [--only name,name] [--json out.json]
//
// Endpoints assumed (see config.json): <base>/ws anonymous, <base>/auth ticket principals
// ticketuser/ticket-secret, limited/limited-secret (role "restricted"), quiet/quiet-secret (role
// "undisclosed"), <base>/ws-ping (64 KiB max message, 1 s auto-ping).

import fs from 'node:fs';

const T = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  CHALLENGE: 4,
  AUTHENTICATE: 5,
  GOODBYE: 6,
  ERROR: 8,
  PUBLISH: 16,
  PUBLISHED: 17,
  SUBSCRIBE: 32,
  SUBSCRIBED: 33,
  UNSUBSCRIBE: 34,
  UNSUBSCRIBED: 35,
  EVENT: 36,
  CALL: 48,
  CANCEL: 49,
  RESULT: 50,
  REGISTER: 64,
  REGISTERED: 65,
  UNREGISTER: 66,
  UNREGISTERED: 67,
  INVOCATION: 68,
  INTERRUPT: 69,
  YIELD: 70,
};
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg('base', 'ws://127.0.0.1:18080');
const REALM = arg('realm', 'realm1');
const ONLY = arg('only', '') ? arg('only').split(',') : null;
const JSON_OUT = arg('json', null);
const VERBOSE = argv.includes('--verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (m) => {
  const s = JSON.stringify(m);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
};

const ROLES = {
  caller: {
    features: {
      progressive_call_results: true,
      progressive_call_invocations: true,
      call_canceling: true,
      call_timeout: true,
      caller_identification: true,
    },
  },
  callee: {
    features: {
      progressive_call_results: true,
      progressive_call_invocations: true,
      call_canceling: true,
      call_timeout: true,
      caller_identification: true,
      shared_registration: true,
      pattern_based_registration: true,
    },
  },
  publisher: {
    features: { publisher_exclusion: true, publisher_identification: true, subscriber_blackwhite_listing: true },
  },
  subscriber: { features: { pattern_based_subscription: true, publisher_identification: true, event_history: true } },
};

class Peer {
  constructor(url, protocols = ['wamp.2.json'], label = 'peer') {
    this.label = label;
    this.inbox = [];
    this.waiters = new Set();
    this.closeInfo = null;
    this.reqId = 1;
    this.onInvocation = null; // (msg) => void ; if set, INVOCATIONs bypass the inbox
    this.log = [];
    this.raw = [];
    this.ws = new WebSocket(url, protocols);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(this.ws.protocol), { once: true });
      this.ws.addEventListener('close', (e) => reject(new Error(`closed before open code=${e.code}`)), { once: true });
    });
    this.opened.catch(() => {});
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener('close', (e) => {
        this.closeInfo = { code: e.code, reason: e.reason, wasClean: e.wasClean, at: performance.now() };
        if (VERBOSE) console.log(`   [${this.label}] closed ${e.code} ${e.reason}`);
        resolve(this.closeInfo);
        this.wake();
      });
    });
    this.ws.addEventListener('message', (e) => {
      let m;
      if (typeof e.data === 'string') this.raw.push(e.data);
      if (typeof e.data !== 'string') {
        m = ['<binary>', e.data.byteLength];
      } else {
        try {
          m = JSON.parse(e.data);
        } catch {
          m = ['<unparseable>', e.data];
        }
      }
      if (VERBOSE) console.log(`   [${this.label}] <- ${short(m)}`);
      this.log.push(m);
      if (m[0] === T.INVOCATION && this.onInvocation) {
        this.onInvocation(m);
        return;
      }
      this.inbox.push(m);
      this.wake();
    });
  }
  wake() {
    for (const w of [...this.waiters]) w();
  }
  id() {
    return this.reqId++;
  }
  send(m) {
    if (VERBOSE) console.log(`   [${this.label}] -> ${short(m)}`);
    this.ws.send(JSON.stringify(m));
  }
  sendRaw(x) {
    this.ws.send(x);
  }
  /** resolves with first matching message (removed from inbox) or null on timeout/close */
  next(pred, timeout = 3000) {
    return new Promise((resolve) => {
      let timer;
      const check = () => {
        const i = this.inbox.findIndex(pred);
        if (i >= 0) {
          const [m] = this.inbox.splice(i, 1);
          done(m);
          return;
        }
        if (this.closeInfo) done(null);
      };
      const done = (v) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(v);
      };
      timer = setTimeout(() => done(null), timeout);
      this.waiters.add(check);
      check();
    });
  }
  /** all matching messages arriving within ms */
  async collect(pred, ms) {
    await sleep(ms);
    const out = this.inbox.filter(pred);
    this.inbox = this.inbox.filter((m) => !pred(m));
    return out;
  }
  async hello(realm = REALM, details = {}, authenticate = null) {
    await this.opened;
    this.send([T.HELLO, realm, { roles: ROLES, ...details }]);
    let m = await this.next((x) => [T.WELCOME, T.ABORT, T.CHALLENGE].includes(x[0]));
    if (m && m[0] === T.CHALLENGE && authenticate) {
      this.send([T.AUTHENTICATE, authenticate(m), {}]);
      m = await this.next((x) => [T.WELCOME, T.ABORT].includes(x[0]));
    }
    if (m && m[0] === T.WELCOME) this.session = m[1];
    return m;
  }
  async register(uri, options = {}) {
    const r = this.id();
    this.send([T.REGISTER, r, options, uri]);
    return this.next(
      (x) => (x[0] === T.REGISTERED || (x[0] === T.ERROR && x[1] === T.REGISTER)) && x[x[0] === T.ERROR ? 2 : 1] === r,
    );
  }
  async subscribe(uri, options = {}) {
    const r = this.id();
    this.send([T.SUBSCRIBE, r, options, uri]);
    return this.next(
      (x) => (x[0] === T.SUBSCRIBED || (x[0] === T.ERROR && x[1] === T.SUBSCRIBE)) && x[x[0] === T.ERROR ? 2 : 1] === r,
    );
  }
  callNoWait(uri, args, kwargs, options = {}) {
    const r = this.id();
    const m = [T.CALL, r, options, uri];
    if (args !== undefined || kwargs !== undefined) m.push(args ?? []);
    if (kwargs !== undefined) m.push(kwargs);
    this.send(m);
    return r;
  }
  callResult(r, timeout = 3000) {
    return this.next(
      (x) => (x[0] === T.RESULT && x[1] === r) || (x[0] === T.ERROR && x[1] === T.CALL && x[2] === r),
      timeout,
    );
  }
  async call(uri, args, kwargs, options = {}, timeout = 3000) {
    return this.callResult(this.callNoWait(uri, args, kwargs, options), timeout);
  }
  async publish(uri, args, kwargs, options = {}) {
    const r = this.id();
    const m = [T.PUBLISH, r, { acknowledge: true, ...options }, uri];
    if (args !== undefined || kwargs !== undefined) m.push(args ?? []);
    if (kwargs !== undefined) m.push(kwargs);
    this.send(m);
    if (options.acknowledge === false) return null;
    return this.next(
      (x) => (x[0] === T.PUBLISHED && x[1] === r) || (x[0] === T.ERROR && x[1] === T.PUBLISH && x[2] === r),
    );
  }
  async goodbye(reason = 'wamp.close.close_realm') {
    this.send([T.GOODBYE, {}, reason]);
    const m = await this.next((x) => x[0] === T.GOODBYE, 2000);
    return m;
  }
  close() {
    try {
      this.ws.close(1000);
    } catch {}
  }
}

const ticketAuth = (ticket) => () => ticket;
async function anon(label, url = `${BASE}/ws`, realm = REALM) {
  const p = new Peer(url, ['wamp.2.json'], label);
  const w = await p.hello(realm, { authmethods: ['anonymous'] });
  if (!w || w[0] !== T.WELCOME) throw new Error(`${label} join failed: ${short(w)}`);
  return p;
}
async function ticket(label, authid, secret) {
  const p = new Peer(`${BASE}/auth`, ['wamp.2.json'], label);
  const w = await p.hello(REALM, { authmethods: ['ticket'], authid }, ticketAuth(secret));
  if (!w || w[0] !== T.WELCOME) throw new Error(`${label} join failed: ${short(w)}`);
  return p;
}
const uniq = (s) => `com.thruway.probe.${s}.${Math.random().toString(36).slice(2, 8)}`;
const desc = (m) => (m === null ? 'null (timeout or socket closed)' : `${NAME[m[0]] ?? m[0]} ${short(m)}`);

// ---------------------------------------------------------------------------------------------------------
const probes = [];
const probe = (name, fn) => probes.push({ name, fn });

probe('progressive_call_results', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('prog');
  const reg = await callee.register(uri);
  callee.onInvocation = (inv) => {
    r.invocationDetails = inv[3];
    for (let i = 1; i <= 3; i++) callee.send([T.YIELD, inv[1], { progress: true }, [i]]);
    callee.send([T.YIELD, inv[1], {}, ['done']]);
  };
  const id = caller.callNoWait(uri, [], undefined, { receive_progress: true });
  const msgs = [];
  for (;;) {
    const m = await caller.callResult(id);
    msgs.push(m);
    if (!m || !m[2]?.progress) break;
  }
  r.results = msgs.map((m) => m && [NAME[m[0]], m[2], m[3]]);
  r.ok = msgs.length === 4 && msgs[3]?.[3]?.[0] === 'done';
  void reg;
  // progress YIELD when the caller did NOT ask for progress
  const uri2 = uniq('prog2');
  await callee.register(uri2);
  callee.onInvocation = (inv) => {
    callee.send([T.YIELD, inv[1], { progress: true }, ['p']]);
    callee.send([T.YIELD, inv[1], {}, ['final']]);
  };
  const id2 = caller.callNoWait(uri2, []);
  const m1 = await caller.callResult(id2);
  const m2 = await caller.callResult(id2, 700);
  r.progressWithoutReceiveProgress = [desc(m1), desc(m2)];
  caller.close();
  callee.close();
});

probe('progressive_call_invocations', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('pinv');
  await callee.register(uri);
  const invs = [];
  callee.onInvocation = (inv) => {
    invs.push(inv);
    if (!inv[3]?.progress) callee.send([T.YIELD, inv[1], {}, [invs.length]]);
  };
  const id = caller.id();
  caller.send([T.CALL, id, { progress: true }, uri, [1]]);
  caller.send([T.CALL, id, { progress: true }, uri, [2]]);
  caller.send([T.CALL, id, {}, uri, [3]]);
  const res = await caller.callResult(id, 1500);
  const more = await caller.collect(() => true, 500);
  r.invocationsSeenByCallee = invs.map((i) => ({ invId: i[1], details: i[3], args: i[4] }));
  r.callerGot = [desc(res), ...more.map(desc)];
  r.callerClosed = caller.closeInfo;
  r.ok = invs.length === 3 && invs[0][3]?.progress === true && invs.every((i) => i[1] === invs[0][1]);
  caller.close();
  callee.close();
});

for (const mode of ['skip', 'kill', 'killnowait']) {
  probe(`call_canceling_${mode}`, async (r) => {
    const callee = await anon('callee');
    const caller = await anon('caller');
    const uri = uniq('cancel');
    await callee.register(uri);
    let inv = null;
    callee.onInvocation = (m) => {
      inv = m;
    };
    const id = caller.callNoWait(uri, []);
    await sleep(200);
    caller.send([T.CANCEL, id, { mode }]);
    const t0 = performance.now();
    const interrupt = await callee.next((x) => x[0] === T.INTERRUPT, 1000);
    r.calleeGotInterrupt = desc(interrupt);
    if (interrupt && mode === 'kill') {
      await sleep(300);
      callee.send([T.ERROR, T.INVOCATION, inv[1], {}, 'wamp.error.canceled', ['callee says canceled']]);
    }
    const res = await caller.callResult(id, 2000);
    r.callerGot = desc(res);
    r.callerLatencyMs = Math.round(performance.now() - t0);
    // late YIELD after cancel must not reach the caller
    if (inv) callee.send([T.YIELD, inv[1], {}, ['late']]);
    const late = await caller.collect((x) => x[0] === T.RESULT, 400);
    r.lateYieldLeaked = late.length > 0;
    r.calleeStillUp = !callee.closeInfo;
    r.ok = res?.[0] === T.ERROR && res[4] === 'wamp.error.canceled';
    caller.close();
    callee.close();
  });
}

probe('call_timeout', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('timeout');
  await callee.register(uri);
  callee.onInvocation = (m) => {
    (r.invocationDetails ??= []).push(m[3]);
  };
  for (const timeout of [1, 2, 1500]) {
    const t0 = performance.now();
    const id = caller.callNoWait(uri, [], undefined, { timeout });
    const res = await caller.callResult(id, 3000);
    const intr = await callee.next((x) => x[0] === T.INTERRUPT, 200);
    r[`timeout_${timeout}`] = {
      callerGot: desc(res),
      afterMs: Math.round(performance.now() - t0),
      calleeInterrupt: desc(intr),
    };
    if (!res) caller.send([T.CANCEL, id, { mode: 'killnowait' }]);
    await caller.collect(() => true, 200);
  }
  // non-integer timeout
  const id = caller.callNoWait(uri, [], undefined, { timeout: 1.5 });
  const res = await caller.callResult(id, 2500);
  r.timeout_float = {
    callerGot: desc(res),
    closed: caller.closeInfo,
    abort: desc(caller.inbox.find((x) => x[0] === T.ABORT) ?? null),
  };
  r.ok = r.timeout_1.callerGot.startsWith('ERROR');
  caller.close();
  callee.close();
});

probe('shared_registration', async (r) => {
  const a = await anon('calleeA');
  const b = await anon('calleeB');
  const caller = await anon('caller');
  for (const invoke of ['roundrobin', 'first', 'last', 'random']) {
    const uri = uniq(`shared_${invoke}`);
    const ra = await a.register(uri, { invoke });
    const rb = await b.register(uri, { invoke });
    const hits = [];
    a.onInvocation = (m) => {
      hits.push('A');
      a.send([T.YIELD, m[1], {}, ['A']]);
    };
    b.onInvocation = (m) => {
      hits.push('B');
      b.send([T.YIELD, m[1], {}, ['B']]);
    };
    for (let i = 0; i < 6; i++) await caller.call(uri, []);
    r[invoke] = { regIdsEqual: ra?.[2] === rb?.[2], hits: hits.join('') };
  }
  const uri = uniq('shared_mismatch');
  await a.register(uri, { invoke: 'roundrobin' });
  r.mismatchedPolicy = desc(await b.register(uri, { invoke: 'random' }));
  const uri2 = uniq('single');
  await a.register(uri2);
  r.secondSingleRegistration = desc(await b.register(uri2));
  r.sameSessionTwice = desc(await a.register(uri2));
  r.ok = r.roundrobin.hits === 'ABABAB';
  a.close();
  b.close();
  caller.close();
});

probe('pattern_based_registration', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const base = uniq('pat');
  const regs = {};
  const name = (id) => Object.keys(regs).find((k) => regs[k] === id) ?? id;
  regs.prefix = (await callee.register(`${base}.p`, { match: 'prefix' }))[2];
  regs.prefix_longer = (await callee.register(`${base}.p.q`, { match: 'prefix' }))[2];
  regs.wildcard = (await callee.register(`${base}..w`, { match: 'wildcard' }))[2];
  regs.wildcard_overlap = (await callee.register(`${base}.p..z`, { match: 'wildcard' }))[2];
  regs.exact = (await callee.register(`${base}.p.x`))[2];
  const seen = [];
  callee.onInvocation = (m) => {
    seen.push({ reg: name(m[2]), procedure: m[3].procedure ?? '(absent: exact)' });
    callee.send([T.YIELD, m[1], {}, []]);
  };
  r.calls = {};
  for (const target of [`${base}.p.foo.bar`, `${base}.p.q.r`, `${base}.y.w`, `${base}.p.x`, `${base}.p.k.z`]) {
    const before = seen.length;
    const res = await caller.call(target, []);
    r.calls[target.slice(base.length)] = seen.length > before ? seen[before] : desc(res);
  }
  const c = r.calls;
  r.ok =
    c['.p.foo.bar']?.reg === 'prefix' &&
    c['.p.q.r']?.reg === 'prefix_longer' &&
    c['.y.w']?.reg === 'wildcard' &&
    c['.p.x']?.reg === 'exact';
  r.note = 'precedence: exact > longest prefix > wildcard (".p.k.z" matches prefix ".p" and wildcard ".p..z")';
  caller.close();
  callee.close();
});

probe('pattern_based_subscription', async (r) => {
  const sub = await anon('sub');
  const pub = await anon('pub');
  const base = uniq('pats');
  const sp = await sub.subscribe(base, { match: 'prefix' });
  const sw = await sub.subscribe(`${base}..end`, { match: 'wildcard' });
  await pub.publish(`${base}.a.end`, ['x']);
  const evs = await sub.collect((x) => x[0] === T.EVENT, 300);
  r.events = evs.map((e) => ({ sub: e[1] === sp[2] ? 'prefix' : e[1] === sw[2] ? 'wildcard' : e[1], details: e[3] }));
  r.ok = evs.length === 2 && evs.every((e) => e[3].topic === `${base}.a.end`);
  sub.close();
  pub.close();
});

probe('event_retention', async (r) => {
  const pub = await anon('pub');
  const topic = uniq('retain');
  await pub.publish(topic, ['first'], undefined, { retain: true });
  await pub.publish(topic, ['second'], { k: 1 }, { retain: true });
  const sub = await anon('sub');
  const s = await sub.subscribe(topic, { get_retained: true });
  const ev = await sub.next((x) => x[0] === T.EVENT, 1000);
  r.retainedEvent = desc(ev);
  const sub2 = await anon('sub2');
  await sub2.subscribe(topic);
  r.withoutGetRetained = desc(await sub2.next((x) => x[0] === T.EVENT, 500));
  r.ok = ev?.[1] === s[2] && ev?.[3]?.retained === true && ev?.[4]?.[0] === 'second';
  pub.close();
  sub.close();
  sub2.close();
});

probe('publisher_exclusion_and_bw_listing', async (r) => {
  const a = await anon('A');
  const b = await anon('B');
  const c = await ticket('C', 'ticketuser', 'ticket-secret');
  const topic = uniq('bw');
  for (const p of [a, b, c]) await p.subscribe(topic);
  const run = async (label, opts) => {
    await a.publish(topic, [label], undefined, opts);
    const got = [];
    for (const [n, p] of [
      ['A', a],
      ['B', b],
      ['C', c],
    ])
      if ((await p.collect((x) => x[0] === T.EVENT, 150)).length) got.push(n);
    r[label] = got.join(',');
  };
  await run('default', {});
  await run('exclude_me_false', { exclude_me: false });
  await run('exclude_B', { exclude_me: false, exclude: [b.session] });
  await run('eligible_B', { exclude_me: false, eligible: [b.session] });
  await run('eligible_authrole_authenticated', { exclude_me: false, eligible_authrole: ['authenticated'] });
  await run('exclude_authid_ticketuser', { exclude_me: false, exclude_authid: ['ticketuser'] });
  r.ok =
    r.default === 'B,C' &&
    r.exclude_me_false === 'A,B,C' &&
    r.exclude_B === 'A,C' &&
    r.eligible_B === 'B' &&
    r.eligible_authrole_authenticated === 'C' &&
    r.exclude_authid_ticketuser === 'A,B';
  a.close();
  b.close();
  c.close();
});

probe('disclosure', async (r) => {
  // role "undisclosed" has disclose.caller/publisher = false; try disclose_me on top
  const q = await ticket('quiet', 'quiet', 'quiet-secret');
  const callee = await anon('callee');
  const uri = uniq('disc');
  await callee.register(uri);
  const inv = [];
  callee.onInvocation = (m) => {
    inv.push(m[3]);
    callee.send([T.YIELD, m[1], {}, []]);
  };
  await q.call(uri, []);
  await q.call(uri, [], undefined, { disclose_me: true });
  r.invocationDetails_plain = inv[0];
  r.invocationDetails_disclose_me = inv[1];
  const topic = uniq('discp');
  await callee.subscribe(topic);
  await q.publish(topic, [], undefined, { disclose_me: true });
  r.eventDetails_disclose_me = (await callee.next((x) => x[0] === T.EVENT, 500))?.[3];
  r.ok = true;
  q.close();
  callee.close();
});

probe('session_meta_api', async (r) => {
  const a = await anon('A');
  const watcher = await anon('watcher');
  const sj = await watcher.subscribe('wamp.session.on_join');
  const sl = await watcher.subscribe('wamp.session.on_leave');
  r.count = desc(await a.call('wamp.session.count', []));
  r.list = desc(await a.call('wamp.session.list', []));
  r.get_self = desc(await a.call('wamp.session.get', [a.session]));
  r.get_unknown = desc(await a.call('wamp.session.get', [1]));
  const b = await anon('B');
  r.on_join = desc(await watcher.next((x) => x[0] === T.EVENT && x[1] === sj[2], 1000));
  await b.goodbye();
  b.close();
  r.on_leave = desc(await watcher.next((x) => x[0] === T.EVENT && x[1] === sl[2], 1000));
  // kill another session
  const v = await anon('victim');
  r.kill = desc(await a.call('wamp.session.kill', [v.session], { reason: 'com.thruway.kicked', message: 'bye now' }));
  const gb = await v.next((x) => x[0] === T.GOODBYE || x[0] === T.ABORT, 1500);
  r.victimGot = desc(gb);
  if (gb && gb[0] === T.GOODBYE) v.send([T.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
  const ci = await Promise.race([v.closed, sleep(2000).then(() => null)]);
  r.victimSocketClose = ci;
  r.kill_self = desc(await a.call('wamp.session.kill', [a.session]));
  r.kill_self_effect = desc(await a.next((x) => x[0] === T.GOODBYE, 500));
  r.kill_unknown = desc(await a.call('wamp.session.kill', [1]));
  const r2 = await anon('realm2', `${BASE}/ws`, 'realm2');
  r.get_unknown_realm2_no_store = desc(await r2.call('wamp.session.get', [1]));
  r2.close();
  const x = await anon('X');
  const y = await anon('Y');
  r.kill_by_authid = desc(
    await x.call(
      'wamp.session.kill_by_authid',
      [y.ws && (await x.call('wamp.session.get', [y.session]))?.[3]?.[0]?.authid],
      { reason: 'wamp.close.killed' },
    ),
  );
  r.kill_by_authid_victim = desc(await y.next((m) => m[0] === T.GOODBYE, 1000));
  x.close();
  y.close();
  r.ok = r.count.startsWith('RESULT') && r.on_join.startsWith('EVENT') && r.on_leave.startsWith('EVENT');
  a.close();
  watcher.close();
  v.close();
});

probe('registration_and_subscription_meta_api', async (r) => {
  const a = await anon('A');
  const uri = uniq('meta');
  const reg = await a.register(uri);
  const sub = await a.subscribe(uri);
  for (const [k, proc, args] of [
    ['reg_list', 'wamp.registration.list', []],
    ['reg_lookup', 'wamp.registration.lookup', [uri]],
    ['reg_match', 'wamp.registration.match', [uri]],
    ['reg_get', 'wamp.registration.get', [reg[2]]],
    ['reg_list_callees', 'wamp.registration.list_callees', [reg[2]]],
    ['reg_count_callees', 'wamp.registration.count_callees', [reg[2]]],
    ['sub_lookup', 'wamp.subscription.lookup', [uri]],
    ['sub_match', 'wamp.subscription.match', [uri]],
    ['sub_get', 'wamp.subscription.get', [sub[2]]],
    ['sub_list_subscribers', 'wamp.subscription.list_subscribers', [sub[2]]],
    ['sub_count_subscribers', 'wamp.subscription.count_subscribers', [sub[2]]],
    ['reg_lookup_unknown', 'wamp.registration.lookup', ['com.nope.nothing']],
    ['reg_get_unknown', 'wamp.registration.get', [12345]],
  ])
    r[k] = desc(await a.call(proc, args));
  r.ok = r.reg_lookup.includes(String(reg[2]));
  a.close();
});

probe('testament', async (r) => {
  const watcher = await anon('watcher');
  const topic = uniq('testament');
  const s = await watcher.subscribe(topic);
  // abrupt disconnect
  const a = await anon('A');
  r.add = desc(await a.call('wamp.session.add_testament', [topic, ['abrupt'], { who: 'A' }], {}));
  a.ws.close(4000, 'simulate crash'); // no GOODBYE
  r.onAbruptClose = desc(await watcher.next((x) => x[0] === T.EVENT && x[1] === s[2], 2000));
  // clean goodbye
  const b = await anon('B');
  await b.call('wamp.session.add_testament', [topic, ['clean'], {}], {});
  await b.goodbye();
  b.close();
  r.onCleanGoodbye = desc(await watcher.next((x) => x[0] === T.EVENT && x[1] === s[2], 1500));
  // flush
  const c = await anon('C');
  await c.call('wamp.session.add_testament', [topic, ['flushed'], {}], {});
  r.flush = desc(await c.call('wamp.session.flush_testaments', []));
  c.ws.close(4000);
  r.afterFlush = desc(await watcher.next((x) => x[0] === T.EVENT && x[1] === s[2], 1000));
  r.ok = r.onAbruptClose.startsWith('EVENT');
  watcher.close();
});

probe('event_history', async (r) => {
  const pub = await anon('pub');
  const topic = 'com.thruway.history.' + Math.random().toString(36).slice(2, 8);
  const subExact = await anon('subExact');
  const se = await subExact.subscribe(topic);
  const subPrefix = await anon('subPrefix');
  const sp = await subPrefix.subscribe('com.thruway.history.', { match: 'prefix' });
  for (let i = 0; i < 5; i++) await pub.publish(topic, [i]);
  const look = await pub.call('wamp.subscription.lookup', ['com.thruway.history.', { match: 'prefix' }]);
  r.lookup = desc(look);
  r.prefixSubIdEqualsLookup = look?.[3]?.[0] === sp?.[2];
  r.get_events_prefix_sub = desc(await pub.call('wamp.subscription.get_events', [sp[2], 3]));
  r.get_events_exact_sub = desc(await pub.call('wamp.subscription.get_events', [se[2], 3]));
  const noStore = await anon('nostore', `${BASE}/ws`, 'realm2');
  const s2 = await noStore.subscribe('com.thruway.x');
  r.get_events_realm_without_store = desc(await noStore.call('wamp.subscription.get_events', [s2[2], 3]));
  r.ok = r.get_events_prefix_sub.includes('"args":[4]');
  pub.close();
  subExact.close();
  subPrefix.close();
  noStore.close();
});

probe('error_semantics', async (r) => {
  // each case on a fresh session, because some "errors" are fatal on Crossbar
  const one = async (label, fn, who = () => anon(label)) => {
    const p = await who();
    const m = await fn(p);
    const ci = await Promise.race([p.closed, sleep(300).then(() => null)]);
    r[label] = `${desc(m)}${ci ? ` | socket closed ${ci.code} ${JSON.stringify(ci.reason.slice(0, 120))}` : ''}`;
    p.close();
  };
  const lim = () => ticket('limited', 'limited', 'limited-secret');
  await one('no_such_procedure', (p) => p.call('com.thruway.does.not.exist', []));
  await one('invalid_uri_call_empty_component', (p) => p.call('com..bad', []));
  await one('invalid_uri_call_space', (p) => p.call('com.bad uri', []));
  await one('invalid_uri_call_hash', (p) => p.call('com.bad#x', []));
  await one('invalid_uri_publish', (p) => p.publish('com..bad', []));
  await one('invalid_uri_subscribe', (p) => p.subscribe('com..bad'));
  await one('invalid_uri_register', (p) => p.register('com..bad'));
  await one('register_reserved_wamp', (p) => p.register('wamp.thruway.mine'));
  await one('publish_reserved_wamp', (p) => p.publish('wamp.thruway.mine', []));
  await one('subscribe_reserved_wamp_session_on_join', (p) => p.subscribe('wamp.session.on_join'));
  await one('register_empty_uri', (p) => p.register(''));
  await one('register_camelCase_loose_realm1', (p) => p.register(uniq('camelCaseOk')));
  await one(
    'register_camelCase_strict_realm2',
    (p) => p.register('com.thruway.camelCase'),
    () => anon('strict', `${BASE}/ws`, 'realm2'),
  );
  await one('register_wildcard_with_exact_match', (p) => p.register('com..x'));
  await one('register_bad_match_policy', (p) => p.register('com.x', { match: 'regex' }));
  await one('register_bad_invoke_policy', (p) => p.register('com.x', { invoke: 'sometimes' }));
  await one('not_authorized_register', (p) => p.register('com.thruway.public.x'), lim);
  await one('not_authorized_publish', (p) => p.publish('com.thruway.public.x', []), lim);
  await one(
    'not_authorized_publish_unacknowledged',
    async (p) => {
      await p.publish('com.thruway.public.x', [], undefined, { acknowledge: false });
      return p.next(() => true, 300);
    },
    lim,
  );
  await one('not_authorized_call_outside_prefix', (p) => p.call('com.thruway.private.x', []), lim);
  await one('authorized_subscribe_in_prefix', (p) => p.subscribe('com.thruway.public.y'), lim);
  await one('no_such_subscription', (p) => {
    const id = p.id();
    p.send([T.UNSUBSCRIBE, id, 999]);
    return p.next((x) => (x[0] === T.ERROR && x[2] === id) || (x[0] === T.UNSUBSCRIBED && x[1] === id));
  });
  await one('no_such_registration', (p) => {
    const id = p.id();
    p.send([T.UNREGISTER, id, 999]);
    return p.next((x) => (x[0] === T.ERROR && x[2] === id) || (x[0] === T.UNREGISTERED && x[1] === id));
  });
  await one('yield_unknown_invocation', (p) => {
    p.send([T.YIELD, 987654321, {}, []]);
    return p.next(() => true, 500);
  });
  await one('error_for_unknown_invocation', (p) => {
    p.send([T.ERROR, T.INVOCATION, 987654321, {}, 'com.x.err']);
    return p.next(() => true, 500);
  });
  await one('cancel_unknown_call', (p) => {
    p.send([T.CANCEL, 424242, { mode: 'kill' }]);
    return p.next(() => true, 500);
  });
  await one('cancel_bad_mode', (p) => {
    p.send([T.CANCEL, 424242, { mode: 'nuke' }]);
    return p.next(() => true, 500);
  });
  // application error passthrough (args/kwargs/details)
  const a = await anon('A');
  const b = await anon('B');
  const uri = uniq('apperr');
  await a.register(uri);
  a.onInvocation = (m) =>
    a.send([T.ERROR, T.INVOCATION, m[1], { extra: 1 }, 'com.thruway.error.custom', ['bad', 1], { why: 'because' }]);
  r.application_error = desc(await b.call(uri, []));
  const uri2 = uniq('apperr2');
  await a.register(uri2);
  a.onInvocation = (m) => a.send([T.ERROR, T.INVOCATION, m[1], {}, 'not a uri!']);
  r.application_error_invalid_error_uri = desc(await b.call(uri2, []));
  r.calleeAfterInvalidErrorUri = a.closeInfo
    ? `closed ${a.closeInfo.code} ${a.closeInfo.reason.slice(0, 120)}`
    : 'open';
  // YIELD for another session's invocation
  const c = await anon('C');
  const owner = await anon('owner');
  const uri3 = uniq('steal');
  await owner.register(uri3);
  let stolen = null;
  owner.onInvocation = (m) => {
    stolen = m[1];
  };
  const id3 = b.callNoWait(uri3, []);
  await sleep(200);
  if (stolen !== null) c.send([T.YIELD, stolen, {}, ['stolen']]);
  await sleep(300);
  r.yield_for_foreign_invocation = {
    thief: c.closeInfo ? `closed ${c.closeInfo.code} ${c.closeInfo.reason.slice(0, 120)}` : 'open',
    callerGot: desc(await b.callResult(id3, 300)),
  };
  r.ok = true;
  a.close();
  b.close();
  c.close();
  owner.close();
});

probe('callee_or_caller_vanishes', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('vanish');
  await callee.register(uri);
  callee.onInvocation = () => {};
  const id = caller.callNoWait(uri, []);
  await sleep(200);
  callee.ws.close(4000);
  r.callerAfterCalleeLost = desc(await caller.callResult(id, 2000));
  const callee2 = await anon('callee2');
  const uri2 = uniq('vanish2');
  await callee2.register(uri2);
  callee2.onInvocation = () => {};
  const caller2 = await anon('caller2');
  caller2.callNoWait(uri2, []);
  await sleep(200);
  caller2.ws.close(4000);
  r.calleeAfterCallerLost = desc(await callee2.next((x) => x[0] === T.INTERRUPT, 1500));
  r.ok = r.callerAfterCalleeLost.startsWith('ERROR');
  caller.close();
  callee2.close();
});

probe('registration_leak_race', async (r) => {
  // Crossbar 26.10.1 bug: dealer.detach() sends ERROR/INTERRUPT to the *other* side of an in-flight call; if that
  // side's transport is already closed it raises Disconnected and aborts the detach -> the registration leaks
  // (CALLs to it hang forever, REGISTER returns procedure_already_exists) until the router restarts.
  let leaks = 0;
  const tries = 6;
  for (let i = 0; i < tries; i++) {
    const callee = await anon('callee');
    const caller = await anon('caller');
    const uri = uniq('leak');
    await callee.register(uri);
    callee.onInvocation = () => {};
    caller.callNoWait(uri, []);
    await sleep(100);
    if (i % 2) {
      callee.ws.close();
      caller.ws.close();
    } else {
      caller.ws.close();
      callee.ws.close();
    }
    await sleep(400);
    const w = await anon('watch');
    const look = await w.call('wamp.registration.lookup', [uri]);
    if (look?.[3]?.[0]) leaks++;
    w.close();
  }
  r.leakedRegistrations = `${leaks}/${tries}`;
  r.ok = leaks === 0;
});

probe('session_establishment_errors', async (r) => {
  const tryHello = async (path, realm, details, auth) => {
    const p = new Peer(`${BASE}${path}`, ['wamp.2.json']);
    try {
      await p.opened;
    } catch (e) {
      return `open failed: ${e.message}`;
    }
    const m = await p.hello(realm, details, auth);
    const ci = await Promise.race([p.closed, sleep(1000).then(() => null)]);
    p.close();
    return `${desc(m)} | socket: ${ci ? `closed ${ci.code}` : 'still open after 1s'}`;
  };
  r.no_such_realm = await tryHello('/ws', 'nope', { authmethods: ['anonymous'] });
  r.anonymous_on_auth_path = await tryHello('/auth', REALM, { authmethods: ['anonymous'] });
  r.ticket_on_anon_path = await tryHello(
    '/ws',
    REALM,
    { authmethods: ['ticket'], authid: 'ticketuser' },
    () => 'ticket-secret',
  );
  r.bad_ticket = await tryHello('/auth', REALM, { authmethods: ['ticket'], authid: 'ticketuser' }, () => 'wrong');
  r.unknown_authid = await tryHello('/auth', REALM, { authmethods: ['ticket'], authid: 'nobody' }, () => 'x');
  r.wampcra_bad_signature = await tryHello(
    '/auth',
    REALM,
    { authmethods: ['wampcra'], authid: 'crauser' },
    () => 'AAAA',
  );
  r.cryptosign_64byte_sig = await tryHello(
    '/auth',
    REALM,
    {
      authmethods: ['cryptosign'],
      authid: 'csuser',
      authextra: { pubkey: 'f41bb129ab45887291e77ea03eb5a0ed5318e87231fc12d46b54e2b2a66347f0' },
    },
    () => '00'.repeat(64),
  );
  r.no_authmethods_field = await tryHello('/ws', REALM, {});
  r.empty_roles = await tryHello('/ws', REALM, { roles: {}, authmethods: ['anonymous'] });
  {
    const p = new Peer(`${BASE}/ws`, ['wamp.2.json']);
    const first = await p.hello('nope', { authmethods: ['anonymous'] });
    const second = await p.hello(REALM, { authmethods: ['anonymous'] });
    r.hello_again_after_abort_same_socket = `${desc(first)} THEN ${desc(second)}`;
    p.close();
  }
  r.method_order_ticket_then_anonymous_on_any = await tryHello(
    '/any',
    REALM,
    { authmethods: ['ticket', 'anonymous'], authid: 'ticketuser' },
    () => 'ticket-secret',
  );
  r.method_order_anonymous_then_ticket_on_any = await tryHello(
    '/any',
    REALM,
    { authmethods: ['anonymous', 'ticket'], authid: 'ticketuser' },
    () => 'ticket-secret',
  );
  r.ok = true;
});

probe('protocol_violations', async (r) => {
  const run = async (label, fn, path = '/ws') => {
    const p = await anon(label, `${BASE}${path}`);
    await fn(p);
    const m = await p.next(() => true, 1500);
    const ci = await Promise.race([p.closed, sleep(1500).then(() => null)]);
    r[label] = `${desc(m)} | socket: ${ci ? `closed ${ci.code} ${JSON.stringify(ci.reason)}` : 'still open'}`;
    p.close();
  };
  await run('second_hello', (p) => p.send([T.HELLO, REALM, { roles: ROLES }]));
  await run('unknown_message_type_999', (p) => p.send([999, 1, {}]));
  await run('router_only_message_WELCOME_from_client', (p) => p.send([T.WELCOME, 1, {}]));
  await run('malformed_json', (p) => p.sendRaw('[48, 1, {}, "x"'));
  await run('json_not_array', (p) => p.sendRaw('{"a":1}'));
  await run('binary_frame_on_json', (p) => p.sendRaw(new Uint8Array([0x93, 0x30, 0x01, 0x80])));
  await run('call_wrong_arity', (p) => p.send([T.CALL, 1]));
  await run('call_args_not_list', (p) => p.send([T.CALL, 1, {}, 'com.x', { a: 1 }]));
  await run('call_options_not_dict', (p) => p.send([T.CALL, 1, [], 'com.x']));
  await run('call_request_id_zero', (p) => p.send([T.CALL, 0, {}, 'com.thruway.nope']));
  await run('call_request_id_2pow53', (p) => p.send([T.CALL, 2 ** 53, {}, 'com.thruway.nope']));
  await run('call_request_id_negative', (p) => p.send([T.CALL, -5, {}, 'com.thruway.nope']));
  await run('receive_progress_not_bool', (p) => p.send([T.CALL, 1, { receive_progress: 'yes' }, 'com.thruway.nope']));
  await run('publish_acknowledge_not_bool', (p) => p.send([T.PUBLISH, 1, { acknowledge: 1 }, 'com.thruway.x']));
  await run('unknown_option_ignored', (p) => p.send([T.CALL, 1, { x_thruway_unknown: 1 }, 'com.thruway.nope']));
  await run(
    'oversize_message_ws_ping',
    (p) => p.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.big', ['x'.repeat(70000)]]),
    '/ws-ping',
  );
  await run('goodbye_without_reason', (p) => p.send([T.GOODBYE, {}]));
  r.ok = true;
});

probe('pre_session_violations', async (r) => {
  const run = async (label, msg) => {
    const p = new Peer(`${BASE}/ws`, ['wamp.2.json']);
    await p.opened;
    p.send(msg);
    const m = await p.next(() => true, 1500);
    const ci = await Promise.race([p.closed, sleep(1500).then(() => null)]);
    r[label] = `${desc(m)} | socket: ${ci ? `closed ${ci.code}` : 'still open'}`;
    p.close();
  };
  await run('call_before_hello', [T.CALL, 1, {}, 'com.x']);
  await run('goodbye_before_hello', [T.GOODBYE, {}, 'wamp.close.close_realm']);
  await run('authenticate_without_challenge', [T.AUTHENTICATE, 'x', {}]);
  await run('hello_realm_not_string', [T.HELLO, 5, { roles: ROLES }]);
  r.ok = true;
});

probe('subprotocol_negotiation', async (r) => {
  const tryOpen = async (protocols) => {
    const ws = new WebSocket(`${BASE}/ws`, protocols);
    return await new Promise((res) => {
      ws.addEventListener('open', () => {
        res(`open protocol=${JSON.stringify(ws.protocol)}`);
        ws.close();
      });
      ws.addEventListener('close', (e) => res(`rejected close=${e.code}`));
      setTimeout(() => res('timeout'), 3000);
    });
  };
  r.json = await tryOpen(['wamp.2.json']);
  r.msgpack_then_json = await tryOpen(['wamp.2.msgpack', 'wamp.2.json']);
  r.json_batched = await tryOpen(['wamp.2.json.batched']);
  r.none = await tryOpen([]);
  r.unknown = await tryOpen(['wamp.2.thruway']);
  r.ok = r.json.startsWith('open');
});

probe('goodbye_handshake', async (r) => {
  const p = await anon('p');
  const t0 = performance.now();
  p.send([T.GOODBYE, { message: 'see ya' }, 'wamp.close.system_shutdown']);
  r.reply = desc(await p.next((x) => x[0] === T.GOODBYE, 1500));
  const ci = await Promise.race([p.closed, sleep(2500).then(() => null)]);
  r.routerClosesSocketAfterGoodbye = ci ? { code: ci.code, afterMs: Math.round(ci.at - t0) } : 'no (client must close)';
  p.close();
  // message after GOODBYE
  const q = await anon('q');
  q.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
  await q.next((x) => x[0] === T.GOODBYE, 1000);
  q.send([T.CALL, 1, {}, 'wamp.session.count']);
  r.callAfterGoodbye = desc(await q.next(() => true, 1000));
  r.rehelloAfterGoodbye = desc(await q.hello(REALM, { authmethods: ['anonymous'] }));
  q.close();
  r.ok = true;
});

probe('auto_ping_keepalive', async (r) => {
  const p = await anon('pinger', `${BASE}/ws-ping`);
  await sleep(4500); // > auto_ping_timeout (3s): node's WebSocket must answer pings automatically
  r.stillOpen = !p.closeInfo;
  r.countWorks = desc(await p.call('wamp.session.count', []));
  r.ok = r.stillOpen;
  p.close();
});

probe('payload_fidelity', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('echo');
  await callee.register(uri);
  callee.onInvocation = (m) => callee.send([T.YIELD, m[1], {}, m[4] ?? [], m[5] ?? {}]);
  const args = [-0, 1e308, 'üñí©ødé ☃ 😀', '\u0000ctrl', null, true, [], {}, { nested: [1, { a: [2] }] }];
  const res = await caller.call(uri, args, { k: 'v' });
  r.args_roundtrip = res?.[3];
  const bigId = caller.id();
  caller.sendRaw(`[48,${bigId},{},"${uri}",[9007199254740993,18446744073709551615,-9223372036854775808,1.0]]`);
  await caller.next((x) => (x[0] === T.RESULT || x[0] === T.ERROR) && (x[1] === bigId || x[2] === bigId), 1000);
  // the JS callee re-serialises (losing precision), so look at the raw INVOCATION frame the router produced
  r.rawBigIntInvocationFrame =
    callee.raw.find((f) => f.startsWith('[68,') && f.includes('18446744073709551615')) ?? null;
  r.note =
    'router (Python) keeps arbitrary-precision ints and echoes 1e400 as the invalid JSON token Infinity, NaN as NaN';
  // no args/kwargs at all
  const r2 = await caller.call(uri);
  r.noArgsResult = desc(r2);
  // kwargs only (args must be [] placeholder)
  r.kwargsOnly = desc(await caller.call(uri, [], { only: 'kw' }));
  r.ok = Array.isArray(res?.[3]);
  callee.close();
  caller.close();
});

probe('request_id_reuse', async (r) => {
  const callee = await anon('callee');
  const caller = await anon('caller');
  const uri = uniq('reuse');
  await callee.register(uri);
  const invs = [];
  callee.onInvocation = (m) => {
    invs.push(m);
  };
  caller.send([T.CALL, 77, {}, uri, [1]]);
  caller.send([T.CALL, 77, {}, uri, [2]]);
  await sleep(300);
  for (const m of invs) callee.send([T.YIELD, m[1], {}, m[4]]);
  r.callerGot = (await caller.collect(() => true, 500)).map(desc);
  r.invocations = invs.length;
  r.callerClosed = caller.closeInfo;
  r.ok = true;
  callee.close();
  caller.close();
});

// ---------------------------------------------------------------------------------------------------------
const results = {};
for (const { name, fn } of probes) {
  if (ONLY && !ONLY.includes(name)) continue;
  const rec = { ok: false };
  const t0 = performance.now();
  try {
    await Promise.race([
      fn(rec),
      sleep(30000).then(() => {
        throw new Error('probe timeout');
      }),
    ]);
  } catch (e) {
    rec.ok = false;
    rec.exception = e.message;
  }
  rec.ms = Math.round(performance.now() - t0);
  results[name] = rec;
  console.log(`\n## ${name}  ${rec.ok ? 'OK' : 'NOT-OK'}  (${rec.ms} ms)`);
  for (const [k, v] of Object.entries(rec))
    if (!['ok', 'ms'].includes(k)) console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(0);
