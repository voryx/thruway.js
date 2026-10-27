#!/usr/bin/env node
// WAMP v2 router smoke test (routers group C). Node >= 22, no dependencies: uses the native global
// WebSocket (undici) with subprotocol "wamp.2.json".
//
//   node smoke-c.mjs <url> <realm> [authid] [secret] [--ticket] [--authmethods=a,b] [--quiet] [--timeout=ms] [--strict]
//
//   node smoke-c.mjs ws://127.0.0.1:18280/ realm1                     # anonymous
//   node smoke-c.mjs ws://127.0.0.1:18280/ realm1 joe secret2         # WAMP-CRA (default when authid+secret)
//   node smoke-c.mjs ws://127.0.0.1:18280/ realm1 peter secret1       # WAMP-CRA with salted secret
//   node smoke-c.mjs ws://127.0.0.1:18280/ realm1 ticketuser ticketsecret --ticket
//
// Two sessions are opened (A = callee + subscriber, B = caller + publisher) so routing is exercised across
// sessions without relying on exclude_me support. Steps: HELLO->WELCOME (incl. CHALLENGE/AUTHENTICATE),
// REGISTER, CALL->INVOCATION->YIELD->RESULT, SUBSCRIBE, PUBLISH{acknowledge}->PUBLISHED + EVENT,
// UNSUBSCRIBE, UNREGISTER, GOODBYE->GOODBYE. Every frame sent/received is printed. Exit code 0 = all ok.
// Non-fatal protocol deviations (e.g. EVENT publication id != PUBLISHED id) print WARN; --strict makes them fatal.

import { createHmac, pbkdf2Sync } from 'node:crypto';

const MSG = {
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
const NAME = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    }),
);
const [url, realm, authid, secret] = argv.filter((a) => !a.startsWith('--'));
if (!url || !realm) {
  console.error(
    'usage: node smoke-c.mjs <url> <realm> [authid] [secret] [--ticket] [--authmethods=a,b] [--quiet] [--timeout=ms] [--strict]',
  );
  process.exit(2);
}
const TIMEOUT = Number(flags.timeout ?? 5000);
const QUIET = !!flags.quiet;
if (typeof WebSocket !== 'function') {
  console.error(`no global WebSocket in Node ${process.version} (need Node >= 22)`);
  process.exit(2);
}

const authmethods = flags.authmethods
  ? String(flags.authmethods).split(',')
  : authid && secret
    ? [flags.ticket ? 'ticket' : 'wampcra']
    : undefined;

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;
const show = (v) => {
  const s = JSON.stringify(v);
  return s.length > 700 ? s.slice(0, 700) + '...' : s;
};

class Peer {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.inbox = [];
    this.waiters = [];
    this.closed = null;
  }
  id() {
    return this.nextId++;
  }
  log(dir, msg) {
    if (QUIET && dir === '->') return;
    const n = Array.isArray(msg) ? (NAME[msg[0]] ?? `#${msg[0]}`) : 'NON-ARRAY';
    console.log(`${ts()} [${this.label}] ${dir} ${n.padEnd(12)} ${show(msg)}`);
  }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['wamp.2.json']);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`[${this.label}] websocket open timeout`)), TIMEOUT);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        console.log(
          `${ts()} [${this.label}] websocket open, negotiated subprotocol=${JSON.stringify(ws.protocol)} extensions=${JSON.stringify(ws.extensions)}`,
        );
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`[${this.label}] websocket error: ${e?.message ?? e?.error?.message ?? 'unknown'}`));
      });
      ws.addEventListener('close', (e) => {
        this.closed = { code: e.code, reason: e.reason, wasClean: e.wasClean };
        console.log(
          `${ts()} [${this.label}] websocket closed code=${e.code} reason=${JSON.stringify(e.reason)} clean=${e.wasClean}`,
        );
        for (const w of this.waiters.splice(0))
          w.reject(new Error(`[${this.label}] socket closed while waiting for ${w.desc}`));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch {
          console.log(`${ts()} [${this.label}] <- UNPARSEABLE ${String(ev.data).slice(0, 300)}`);
          return;
        }
        this.log('<-', msg);
        this.onMessage?.(msg);
        const i = this.waiters.findIndex((w) => w.pred(msg));
        if (i >= 0) {
          const [w] = this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        } else this.inbox.push(msg);
      });
    });
  }
  send(msg) {
    this.log('->', msg);
    this.ws.send(JSON.stringify(msg));
  }
  waitFor(pred, desc, timeout = TIMEOUT) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(new Error(`[${this.label}] socket already closed, cannot wait for ${desc}`));
    return new Promise((resolve, reject) => {
      const w = { pred, desc, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`[${this.label}] timeout (${timeout}ms) waiting for ${desc}`));
      }, timeout);
      this.waiters.push(w);
    });
  }
  // Wait for the reply to a request: success type or ERROR for that request type/id.
  async reply(reqType, reqId, okType, desc) {
    const m = await this.waitFor(
      (m) => (m[0] === okType && m[1] === reqId) || (m[0] === MSG.ERROR && m[2] === reqId),
      `${desc} reply`,
    );
    if (m[0] === MSG.ERROR) throw new Error(`[${this.label}] ${desc} failed: ERROR ${show(m)}`);
    return m;
  }
}

const HELLO_ROLES = {
  caller: {
    features: { progressive_call_results: true, call_canceling: true, call_timeout: true, caller_identification: true },
  },
  callee: {
    features: {
      progressive_call_results: true,
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
  subscriber: { features: { pattern_based_subscription: true, publisher_identification: true } },
};

function signWampCra(extra) {
  let key = secret;
  if (extra.salt) {
    key = pbkdf2Sync(secret, extra.salt, extra.iterations ?? 1000, extra.keylen ?? 32, 'sha256').toString('base64');
  }
  return createHmac('sha256', key).update(extra.challenge).digest('base64');
}

async function join(peer) {
  await peer.open();
  const details = { agent: 'thruway.js-v3-smoke-c', roles: HELLO_ROLES };
  if (authmethods) details.authmethods = authmethods;
  if (authid) details.authid = authid;
  peer.send([MSG.HELLO, realm, details]);
  for (;;) {
    const m = await peer.waitFor(
      (m) => [MSG.WELCOME, MSG.ABORT, MSG.CHALLENGE].includes(m[0]),
      'WELCOME/CHALLENGE/ABORT',
    );
    if (m[0] === MSG.ABORT) throw new Error(`[${peer.label}] ABORT ${show(m)}`);
    if (m[0] === MSG.WELCOME) {
      peer.session = m[1];
      peer.welcome = m[2];
      return m;
    }
    const [, method, extra] = m;
    if (method === 'wampcra') peer.send([MSG.AUTHENTICATE, signWampCra(extra), {}]);
    else if (method === 'ticket') peer.send([MSG.AUTHENTICATE, secret, {}]);
    else throw new Error(`[${peer.label}] unsupported CHALLENGE method ${method}`);
  }
}

async function goodbye(peer) {
  if (peer.closed) return { skipped: true };
  peer.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
  let reply = null;
  try {
    reply = await peer.waitFor((m) => m[0] === MSG.GOODBYE, 'GOODBYE reply');
  } catch (e) {
    console.log(`${ts()} [${peer.label}] ${e.message}`);
  }
  peer.ws.close(1000);
  return reply;
}

const results = [];
const warnings = [];
// Protocol deviations that do not break the basic flow; --strict turns them into failures.
const warn = (msg) => {
  if (flags.strict) throw new Error(msg);
  warnings.push(msg);
  console.log(`${ts()} WARN ${msg}`);
};
const step = async (name, fn) => {
  try {
    const r = await fn();
    results.push([name, 'ok', r ?? '']);
    return r;
  } catch (e) {
    results.push([name, 'FAIL', e.message]);
    throw e;
  }
};

const A = new Peer('A');
const B = new Peer('B');
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PROC = `smoke.c.add_${uniq}`; // lowercase/underscore only: Thruway's strict URI regex
const TOPIC = `smoke.c.topic_${uniq}`;
let exitCode = 0;

try {
  console.log(
    `${ts()} smoke-c: node ${process.version} url=${url} realm=${realm} authid=${authid ?? '-'} authmethods=${JSON.stringify(authmethods ?? null)}`,
  );
  await step('A HELLO->WELCOME', async () => {
    const w = await join(A);
    return `session=${w[1]}`;
  });
  await step('B HELLO->WELCOME', async () => {
    const w = await join(B);
    return `session=${w[1]}`;
  });

  const welcome = A.welcome ?? {};
  console.log(
    `${ts()} WELCOME.details summary: authid=${welcome.authid} authrole=${JSON.stringify(welcome.authrole)} authmethod=${welcome.authmethod} authprovider=${welcome.authprovider} agent=${welcome.agent}`,
  );
  console.log(`${ts()} WELCOME.details.roles: ${JSON.stringify(welcome.roles)}`);

  // invocation handler on A
  A.onMessage = (m) => {
    if (m[0] === MSG.INVOCATION) {
      const [, reqId, , , args = []] = m;
      A.send([MSG.YIELD, reqId, {}, [args.reduce((s, x) => s + x, 0)]]);
    }
  };

  const regId = await step('A REGISTER', async () => {
    const id = A.id();
    A.send([MSG.REGISTER, id, {}, PROC]);
    return (await A.reply(MSG.REGISTER, id, MSG.REGISTERED, 'REGISTER'))[2];
  });

  await step('B CALL->RESULT', async () => {
    const id = B.id();
    B.send([MSG.CALL, id, {}, PROC, [2, 3]]);
    const r = await B.reply(MSG.CALL, id, MSG.RESULT, 'CALL');
    if (r[3]?.[0] !== 5) throw new Error(`unexpected RESULT ${show(r)}`);
    return `args=${show(r[3])}`;
  });

  const subId = await step('A SUBSCRIBE', async () => {
    const id = A.id();
    A.send([MSG.SUBSCRIBE, id, {}, TOPIC]);
    return (await A.reply(MSG.SUBSCRIBE, id, MSG.SUBSCRIBED, 'SUBSCRIBE'))[2];
  });

  await step('B PUBLISH{acknowledge}->PUBLISHED + A EVENT', async () => {
    const id = B.id();
    const evP = A.waitFor((m) => m[0] === MSG.EVENT && m[1] === subId, 'EVENT');
    B.send([MSG.PUBLISH, id, { acknowledge: true }, TOPIC, ['hello'], { n: 1 }]);
    const pub = await B.reply(MSG.PUBLISH, id, MSG.PUBLISHED, 'PUBLISH');
    const ev = await evP;
    if (ev[2] !== pub[2]) warn(`EVENT publication id ${ev[2]} != PUBLISHED publication id ${pub[2]} (router bug)`);
    if (ev[4]?.[0] !== 'hello' || ev[5]?.n !== 1) throw new Error(`EVENT payload mismatch ${show(ev)}`);
    return `publication=${pub[2]}`;
  });

  await step('A UNSUBSCRIBE', async () => {
    const id = A.id();
    A.send([MSG.UNSUBSCRIBE, id, subId]);
    await A.reply(MSG.UNSUBSCRIBE, id, MSG.UNSUBSCRIBED, 'UNSUBSCRIBE');
  });

  await step('A UNREGISTER', async () => {
    const id = A.id();
    A.send([MSG.UNREGISTER, id, regId]);
    await A.reply(MSG.UNREGISTER, id, MSG.UNREGISTERED, 'UNREGISTER');
  });

  await step('A GOODBYE->GOODBYE', async () => {
    const r = await goodbye(A);
    if (!r) throw new Error('no GOODBYE reply');
    return `reason=${r[2]}`;
  });
  await step('B GOODBYE->GOODBYE', async () => {
    const r = await goodbye(B);
    if (!r) throw new Error('no GOODBYE reply');
    return `reason=${r[2]}`;
  });
  await new Promise((r) => setTimeout(r, 200)); // let close frames arrive
} catch (e) {
  console.error(`${ts()} FAILED: ${e.message}`);
  exitCode = 1;
} finally {
  for (const p of [A, B]) {
    try {
      if (p.ws && p.ws.readyState <= 1) p.ws.close(1000);
    } catch {}
  }
}

console.log('\n==== smoke-c summary ====');
for (const [name, status, info] of results) console.log(`${status.padEnd(4)} ${name}${info ? `  (${info})` : ''}`);
for (const w of warnings) console.log(`WARN ${w}`);
console.log(exitCode === 0 ? 'ALL OK' : 'FAILED');
process.exit(exitCode);
