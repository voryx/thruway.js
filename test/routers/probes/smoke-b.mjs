#!/usr/bin/env node
// WAMP v2 router smoke test (routers group B: Bondy, Nexus, xconn/nxt).
// Zero dependencies: Node 22+ (global WebSocket, node:crypto). Subprotocol 'wamp.2.json'.
//
// Core flow (any failure => exit 1):
//   HELLO -> (CHALLENGE -> AUTHENTICATE) -> WELCOME
//   REGISTER -> REGISTERED; CALL it -> INVOCATION (we YIELD) -> RESULT (checked)
//   SUBSCRIBE -> SUBSCRIBED; PUBLISH{acknowledge,exclude_me:false} -> PUBLISHED + EVENT
//   GOODBYE -> GOODBYE reply (+ how/when the router closes the socket)
// Observations (never fatal, reported as "obs"): ERROR uri for an unknown procedure,
// duplicate REGISTER, default exclude_me, progressive call results, UNSUBSCRIBE/UNREGISTER,
// EVENT vs PUBLISHED ordering, close code after GOODBYE.
//
// Every router message is printed as '<-', every client message as '->'.
//
// Usage (CLI shape mirrors routers/smoke.mjs):
//   node smoke-b.mjs <url> <realm> [ticket] [authid] [options]
// Options:
//   --authid ID          authid for HELLO
//   --ticket T           authmethod 'ticket' (static ticket; Nexus/nxt)
//   --password P         authmethod 'password' (Bondy's cleartext-password method; same wire shape as ticket)
//   --wampcra SECRET     authmethod 'wampcra' (salted PBKDF2 if the CHALLENGE carries salt/iterations/keylen)
//   --cryptosign SEED    authmethod 'cryptosign', SEED = 32-byte ed25519 private seed (64 hex chars)
//   --authmethods a,b    override the HELLO authmethods list
//   --bondy-ticket       after the first session, call bondy.ticket.issue and re-join with authmethod 'ticket'
//   --random-ids         use random request IDs instead of sequential 1,2,3.. (probes router strictness)
//   --probe              only HELLO/WELCOME/GOODBYE (used by start.sh readiness loops)
//   --strict-goodbye     fail if the router closes the socket without a GOODBYE reply (default: WARN)
//   --timeout MS         per-step timeout (default 10000)
//   --quiet              do not print each message
//   --json               print a JSON summary line at the end (prefixed 'SUMMARY ')
//
// Examples:
//   node smoke-b.mjs ws://127.0.0.1:18100/ws realm1
//   node smoke-b.mjs ws://127.0.0.1:18110/ realm1 ticketsecret ticketuser
//   node smoke-b.mjs ws://127.0.0.1:18120/ws realm1 --authid crauser --wampcra crasecret
//   node smoke-b.mjs ws://127.0.0.1:18100/ws realm1 --authid csuser \
//        --cryptosign 93a276a0b622ce7c6dd077120550cd3524ec1eed5ebf8692c4a828da9fc15dd2

import crypto from 'node:crypto';

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
const FLAGS = new Set(['quiet', 'json', 'probe', 'random-ids', 'bondy-ticket', 'strict-goodbye']);

function usage(code) {
  console.error(
    'usage: node smoke-b.mjs <url> <realm> [ticket] [authid] [--authid ID] [--ticket T] ' +
      '[--password P] [--wampcra SECRET] [--cryptosign SEED_HEX] [--authmethods a,b] [--bondy-ticket] ' +
      '[--random-ids] [--probe] [--strict-goodbye] [--timeout MS] [--quiet] [--json]',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const pos = [];
  const o = { timeout: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (FLAGS.has(key)) {
      o[key] = true;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) throw new Error(`missing value for ${a}`);
    o[key] = key === 'timeout' ? Number(val) : val;
  }
  if (pos.length < 2) usage(2);
  [o.url, o.realm] = pos;
  if (pos[2] !== undefined && o.ticket === undefined) o.ticket = pos[2];
  if (pos[3] !== undefined && o.authid === undefined) o.authid = pos[3];
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const t0 = performance.now();
const now = () => performance.now() - t0;
const stamp = () => `${now().toFixed(1).padStart(8)}ms`;
const trunc = (s, n = 600) => (s.length > n ? `${s.slice(0, n)}...(${s.length}b)` : s);
const log = (...a) => {
  if (!opts.quiet) console.log(...a);
};
const FULL = new Set([T.WELCOME, T.ABORT, T.CHALLENGE, T.GOODBYE, T.ERROR]);
const show = (dir, msg) => {
  const s = JSON.stringify(msg);
  log(`${stamp()} ${dir} ${(NAME[msg[0]] ?? '?').padEnd(12)} ${FULL.has(msg[0]) ? s : trunc(s)}`);
};

const summary = { url: opts.url, realm: opts.realm, ok: false, steps: {}, obs: {}, warnings: [], welcome: null };
const warn = (w) => {
  summary.warnings.push(w);
  console.log(`${stamp()} WARN ${w}`);
};

// ---------------------------------------------------------------- auth helpers
function authConfig(o) {
  if (o.cryptosign) {
    const seed = Buffer.from(o.cryptosign, 'hex');
    if (seed.length !== 32) throw new Error('--cryptosign needs a 32-byte (64 hex chars) ed25519 seed');
    const key = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
      method: 'cryptosign',
      authextra: { pubkey: pub },
      respond: (extra) => {
        const challenge = Buffer.from(extra.challenge, 'hex');
        const sig = crypto.sign(null, challenge, key);
        // signature || challenge (96 bytes). Nexus and nxt REQUIRE 96 bytes; Bondy accepts 64 or 96.
        return Buffer.concat([sig, challenge]).toString('hex');
      },
    };
  }
  if (o.wampcra !== undefined) {
    return {
      method: 'wampcra',
      respond: (extra) => {
        let key = o.wampcra;
        if (extra.salt !== undefined && extra.salt !== null && extra.salt !== '') {
          key = crypto
            .pbkdf2Sync(o.wampcra, String(extra.salt), extra.iterations ?? 1000, extra.keylen ?? 32, 'sha256')
            .toString('base64');
        }
        return crypto.createHmac('sha256', key).update(String(extra.challenge)).digest('base64');
      },
    };
  }
  if (o.password !== undefined) return { method: 'password', respond: () => o.password };
  if (o.ticket !== undefined) return { method: 'ticket', respond: () => o.ticket };
  return { method: 'anonymous', respond: null };
}

// ---------------------------------------------------------------- session
class Session {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.queue = [];
    this.waiters = [];
    this.handlers = [];
    this.closed = null;
    this.nextId = 1;
    this.order = [];
  }

  id() {
    if (opts['random-ids']) return 1 + Math.floor(Math.random() * (2 ** 53 - 1));
    return this.nextId++;
  }

  open(timeout) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, ['wamp.2.json']);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`websocket open timeout after ${timeout}ms`)), timeout);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws.protocol);
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`websocket error: ${e.message ?? e.type}`));
      };
      ws.onclose = (e) => {
        this.closed = { code: e.code, reason: e.reason, wasClean: e.wasClean, at: now() };
        log(`${stamp()} ** socket closed code=${e.code} reason=${JSON.stringify(e.reason)} clean=${e.wasClean}`);
        for (const w of this.waiters.splice(0))
          w.reject(new Error(`socket closed (code ${e.code}) while waiting for ${w.what}`));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        } catch (err) {
          log(`${stamp()} <- UNPARSEABLE ${trunc(String(ev.data))}`);
          return;
        }
        show('<-', msg);
        this.order.push(NAME[msg[0]] ?? String(msg[0]));
        for (const h of this.handlers) if (h(msg)) return;
        const i = this.waiters.findIndex((w) => w.pred(msg));
        if (i >= 0) {
          const [w] = this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
        this.queue.push(msg);
      };
    });
  }

  send(msg) {
    show('->', msg);
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred, what, timeout = opts.timeout) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    if (this.closed)
      return Promise.reject(new Error(`socket already closed (code ${this.closed.code}) before ${what}`));
    return new Promise((resolve, reject) => {
      const w = { pred, what, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout after ${timeout}ms waiting for ${what}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  // resolves with msg or null on timeout (for observations)
  maybe(pred, what, timeout) {
    return this.waitFor(pred, what, timeout).catch(() => null);
  }

  // request/response: resolves with reply (expected type) or the ERROR for that request
  async request(msg, okType, what) {
    this.send(msg);
    const [type, reqId] = msg;
    return this.waitFor(
      (m) => (m[0] === okType && m[1] === reqId) || (m[0] === T.ERROR && m[1] === type && m[2] === reqId),
      what,
    );
  }
}

const fail = (step, why) => {
  const e = new Error(`${step}: ${why}`);
  e.step = step;
  throw e;
};
const errText = (m) => `${NAME[m[0]]} ${JSON.stringify(m.slice(1))}`;

async function join(s, auth, authid) {
  const t = now();
  const proto = await s.open(opts.timeout);
  summary.steps.open = { ms: +(now() - t).toFixed(1), protocol: proto };
  if (proto !== 'wamp.2.json') fail('open', `router selected subprotocol ${JSON.stringify(proto)}`);
  const details = {
    agent: 'thruway.js-v3-smoke-b',
    roles: {
      caller: {
        features: {
          progressive_call_results: true,
          call_canceling: true,
          caller_identification: true,
          call_timeout: true,
        },
      },
      callee: {
        features: {
          progressive_call_results: true,
          call_canceling: true,
          caller_identification: true,
          pattern_based_registration: true,
          shared_registration: true,
          call_timeout: true,
        },
      },
      publisher: {
        features: { publisher_exclusion: true, publisher_identification: true, subscriber_blackwhite_listing: true },
      },
      subscriber: { features: { pattern_based_subscription: true, publisher_identification: true } },
    },
  };
  const methods = opts.authmethods ? opts.authmethods.split(',') : [auth.method];
  if (auth.method !== 'anonymous' || opts.authmethods) details.authmethods = methods;
  if (authid !== undefined) details.authid = authid;
  if (auth.authextra) details.authextra = auth.authextra;
  const th = now();
  s.send([T.HELLO, opts.realm, details]);
  let m = await s.waitFor((x) => [T.WELCOME, T.ABORT, T.CHALLENGE].includes(x[0]), 'WELCOME/ABORT/CHALLENGE');
  if (m[0] === T.CHALLENGE) {
    summary.steps.challenge = { authmethod: m[1], extraKeys: Object.keys(m[2] ?? {}) };
    if (!auth.respond) fail('auth', `router sent CHALLENGE ${m[1]} but no credentials were given`);
    s.send([T.AUTHENTICATE, auth.respond(m[2] ?? {}, m[1]), {}]);
    m = await s.waitFor((x) => [T.WELCOME, T.ABORT].includes(x[0]), 'WELCOME/ABORT after AUTHENTICATE');
  }
  if (m[0] === T.ABORT) fail('hello', `ABORT ${JSON.stringify(m.slice(1))}`);
  summary.steps.hello = { ms: +(now() - th).toFixed(1), session: m[1] };
  return m;
}

async function goodbye(s) {
  const tg = now();
  s.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
  const g = await s.maybe((x) => x[0] === T.GOODBYE, 'GOODBYE reply', opts.timeout);
  const r = { reply: g ? [g[1], g[2]] : null, replyMs: g ? +(now() - tg).toFixed(1) : null };
  // Give the router a moment to close the socket itself (spec: the peer that sent the first
  // GOODBYE closes the transport, but many routers close it anyway).
  const deadline = now() + 1500;
  while (!s.closed && now() < deadline) await new Promise((res) => setTimeout(res, 20));
  r.routerClosedSocket = !!s.closed;
  if (s.closed) r.close = { code: s.closed.code, reason: s.closed.reason, afterMs: +(s.closed.at - tg).toFixed(1) };
  else s.ws.close(1000);
  if (!g) {
    if (opts['strict-goodbye'] || !s.closed) fail('goodbye', 'no GOODBYE reply');
    // Router dropped the transport instead of answering: the session is over either way.
    warn(`GOODBYE: router closed the socket (code ${s.closed.code}) without a GOODBYE reply`);
  }
  return r;
}

async function main() {
  const auth = authConfig(opts);
  summary.authmethod = auth.method;
  const s = new Session(opts.url, 'main');
  const welcome = await join(s, auth, opts.authid);
  const wd = welcome[2] ?? {};
  summary.welcome = {
    session: welcome[1],
    authid: wd.authid,
    authrole: wd.authrole,
    authmethod: wd.authmethod,
    authprovider: wd.authprovider,
    agent: wd.agent ?? wd.router ?? null,
    roles: Object.fromEntries(
      Object.entries(wd.roles ?? {}).map(([r, v]) => [r, Object.keys(v?.features ?? {}).filter((f) => v.features[f])]),
    ),
    otherKeys: Object.keys(wd).filter(
      (k) => !['authid', 'authrole', 'authmethod', 'authprovider', 'agent', 'roles'].includes(k),
    ),
    raw: wd,
  };

  if (!opts.probe) {
    const proc = 'com.thruway.smoke.add';
    const topic = 'com.thruway.smoke.topic';

    // auto-callee: answer INVOCATIONs for our registration
    let regId = null;
    let progressOffered = null;
    s.handlers.push((m) => {
      if (m[0] !== T.INVOCATION || m[2] !== regId) return false;
      const [, invId, , det = {}, args = [], kwargs = {}] = m;
      if (det.receive_progress) {
        progressOffered = true;
        s.send([T.YIELD, invId, { progress: true }, ['partial']]);
      }
      const sum = args.reduce((a, b) => a + b, 0);
      s.send([T.YIELD, invId, {}, [sum], kwargs.echo !== undefined ? { echo: kwargs.echo } : {}]);
      return true;
    });

    // REGISTER
    let m = await s.request([T.REGISTER, s.id(), {}, proc], T.REGISTERED, 'REGISTERED');
    if (m[0] !== T.REGISTERED) fail('register', errText(m));
    regId = m[2];
    summary.steps.register = { registration: regId };

    // duplicate REGISTER (observation)
    m = await s
      .request([T.REGISTER, s.id(), {}, proc], T.REGISTERED, 'dup REGISTER reply')
      .catch((e) => ({ err: e.message }));
    summary.obs.duplicateRegister = m.err ?? (m[0] === T.ERROR ? m[4] : `unexpected ${NAME[m[0]]}`);

    // CALL (checked)
    m = await s.request([T.CALL, s.id(), {}, proc, [2, 3], { echo: 'x' }], T.RESULT, 'RESULT');
    if (m[0] !== T.RESULT) fail('call', errText(m));
    if (JSON.stringify(m[3]) !== '[5]') fail('call', `unexpected result args ${JSON.stringify(m[3])}`);
    summary.steps.call = { result: m[3], kwargs: m[4] ?? null };

    // progressive call results (observation)
    const pid = s.id();
    s.send([T.CALL, pid, { receive_progress: true }, proc, [1, 1]]);
    const prog = [];
    for (;;) {
      const r = await s.maybe(
        (x) => (x[0] === T.RESULT || x[0] === T.ERROR) && (x[1] === pid || x[2] === pid),
        'progressive RESULT',
        3000,
      );
      if (!r) {
        prog.push('timeout');
        break;
      }
      if (r[0] === T.ERROR) {
        prog.push(`ERROR ${r[4]}`);
        break;
      }
      prog.push(r[2]?.progress ? 'progress' : 'final');
      if (!r[2]?.progress) break;
    }
    summary.obs.progressiveResults = { invocationHadReceiveProgress: !!progressOffered, sequence: prog };

    // CALL unknown procedure (observation)
    m = await s
      .request([T.CALL, s.id(), {}, 'com.thruway.smoke.nope', []], T.RESULT, 'ERROR for unknown proc')
      .catch((e) => ({ err: e.message }));
    summary.obs.unknownProcedure = m.err ?? (m[0] === T.ERROR ? m[4] : `unexpected ${NAME[m[0]]}`);

    // SUBSCRIBE
    m = await s.request([T.SUBSCRIBE, s.id(), {}, topic], T.SUBSCRIBED, 'SUBSCRIBED');
    if (m[0] !== T.SUBSCRIBED) fail('subscribe', errText(m));
    const subId = m[2];
    summary.steps.subscribe = { subscription: subId };

    // PUBLISH acknowledge + exclude_me:false => PUBLISHED + EVENT
    const pubReq = s.id();
    const before = s.order.length;
    s.send([T.PUBLISH, pubReq, { acknowledge: true, exclude_me: false }, topic, ['hello'], { n: 1 }]);
    const pubAck = s.waitFor(
      (x) => (x[0] === T.PUBLISHED && x[1] === pubReq) || (x[0] === T.ERROR && x[2] === pubReq),
      'PUBLISHED',
    );
    const evt = s.waitFor((x) => x[0] === T.EVENT && x[1] === subId, 'EVENT');
    const [pa, ev] = await Promise.all([pubAck, evt]);
    if (pa[0] !== T.PUBLISHED) fail('publish', errText(pa));
    if (JSON.stringify(ev[4]) !== '["hello"]') fail('publish', `unexpected EVENT args ${JSON.stringify(ev[4])}`);
    summary.steps.publish = {
      publication: pa[2],
      eventPublication: ev[2],
      eventDetails: ev[3] ?? {},
      samePublicationId: pa[2] === ev[2],
    };
    summary.obs.publishOrder = s.order
      .slice(before)
      .filter((n) => n === 'PUBLISHED' || n === 'EVENT')
      .join('>');

    // default exclude_me (observation): spec default is exclude_me=true => no EVENT expected
    const pub2 = s.id();
    s.send([T.PUBLISH, pub2, { acknowledge: true }, topic, ['self']]);
    await s.maybe((x) => x[0] === T.PUBLISHED && x[1] === pub2, 'PUBLISHED 2', 3000);
    const selfEvt = await s.maybe((x) => x[0] === T.EVENT && x[1] === subId, 'self EVENT', 400);
    summary.obs.defaultExcludeMe = selfEvt
      ? 'EVENT delivered to publisher (exclude_me default false?)'
      : 'no self EVENT (spec default)';

    // UNSUBSCRIBE / UNREGISTER (observations)
    m = await s
      .request([T.UNSUBSCRIBE, s.id(), subId], T.UNSUBSCRIBED, 'UNSUBSCRIBED')
      .catch((e) => ({ err: e.message }));
    summary.obs.unsubscribe = m.err ?? (m[0] === T.UNSUBSCRIBED ? 'ok' : `ERROR ${m[4]}`);
    m = await s
      .request([T.UNREGISTER, s.id(), regId], T.UNREGISTERED, 'UNREGISTERED')
      .catch((e) => ({ err: e.message }));
    summary.obs.unregister = m.err ?? (m[0] === T.UNREGISTERED ? 'ok' : `ERROR ${m[4]}`);

    // Bondy: issue a ticket in this session, then re-join with it (WAMP 'ticket' = Bondy-issued JWT)
    if (opts['bondy-ticket']) {
      m = await s.request([T.CALL, s.id(), {}, 'bondy.ticket.issue', [], {}], T.RESULT, 'bondy.ticket.issue RESULT');
      if (m[0] !== T.RESULT) fail('bondy-ticket', errText(m));
      const res = m[3]?.[0] ?? {};
      summary.obs.bondyTicketIssue = { keys: Object.keys(res), expires_at: res.expires_at, scope: res.scope };
      opts.issuedTicket = res.ticket;
    }
  }

  summary.steps.goodbye = await goodbye(s);
  summary.obs.queuedUnhandled = s.queue.map((x) => NAME[x[0]] ?? x[0]);

  if (opts.issuedTicket) {
    log(`${stamp()} ** re-joining with the Bondy-issued ticket`);
    const s2 = new Session(opts.url, 'ticket');
    const w2 = await join(
      s2,
      { method: 'ticket', respond: () => opts.issuedTicket },
      opts.authid ?? summary.welcome.authid,
    );
    summary.obs.bondyTicketRejoin = { authmethod: w2[2]?.authmethod, authid: w2[2]?.authid, authrole: w2[2]?.authrole };
    await goodbye(s2);
  }
  summary.ok = true;
}

main()
  .catch((e) => {
    summary.error = e.message;
    console.error(`${stamp()} FAIL ${e.message}`);
  })
  .finally(() => {
    summary.totalMs = +now().toFixed(1);
    if (!opts.quiet || !summary.ok) {
      console.log(`${stamp()} welcome: ${JSON.stringify(summary.welcome)}`);
      console.log(`${stamp()} obs: ${JSON.stringify(summary.obs)}`);
    }
    if (opts.json) console.log(`SUMMARY ${JSON.stringify(summary)}`);
    console.log(
      summary.ok
        ? `SMOKE OK${summary.warnings.length ? ` (${summary.warnings.length} warning(s))` : ''}`
        : 'SMOKE FAILED',
    );
    process.exit(summary.ok ? 0 : 1);
  });
