#!/usr/bin/env node
// Edge-case probe for WAMP routers (routers group B). Zero deps, Node 22+, 'wamp.2.json'.
// Each scenario runs on a fresh anonymous WebSocket session and records what the router
// actually does (messages, ABORT/ERROR URIs, socket close codes). Nothing here is pass/fail:
// the output documents router behaviour so the v3 client tests / fuzzers know what to expect.
//
// Usage: node quirks-b.mjs <url> <realm> [--only a,b] [--json] [--verbose]
//        [--kill-proc wamp.session.kill]  (procedure used by the 'router-goodbye' scenario)

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
const pos = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').match(/^--(only|kill-proc)$/));
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (pos.length < 2) {
  console.error('usage: node quirks-b.mjs <url> <realm> [--only a,b] [--json] [--verbose]');
  process.exit(2);
}
const [URL_, REALM] = pos;
const ONLY = val('only')?.split(',');
const KILL_PROC = val('kill-proc') ?? 'wamp.session.kill';
const VERBOSE = flag('verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (m) => {
  if (!Array.isArray(m)) return String(m);
  const n = NAME[m[0]] ?? m[0];
  if (m[0] === T.ABORT || m[0] === T.GOODBYE) return `${n}(${m[2]})`;
  if (m[0] === T.ERROR) return `ERROR(${NAME[m[1]] ?? m[1]},${m[4]})`;
  return n;
};
const HELLO_DETAILS = {
  agent: 'thruway.js-v3-quirks-b',
  roles: {
    caller: { features: { progressive_call_results: true, call_canceling: true, call_timeout: true } },
    callee: { features: { progressive_call_results: true, call_canceling: true, call_timeout: true } },
    publisher: { features: { publisher_exclusion: true } },
    subscriber: { features: { pattern_based_subscription: true } },
  },
};

class Conn {
  constructor(tag) {
    this.tag = tag;
    this.msgs = [];
    this.all = [];
    this.closed = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_, ['wamp.2.json']);
      const t = setTimeout(() => reject(new Error('open timeout')), 5000);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onerror = () => {};
      this.ws.onclose = (e) => {
        clearTimeout(t);
        this.closed = { code: e.code, reason: e.reason };
        resolve();
      };
      this.ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          m = `unparseable:${String(e.data).slice(0, 80)}`;
        }
        if (VERBOSE) console.log(`   [${this.tag}] <- ${JSON.stringify(m).slice(0, 300)}`);
        this.msgs.push(m);
        this.all.push(m);
      };
    });
  }
  sendRaw(s) {
    if (VERBOSE) console.log(`   [${this.tag}] -> ${String(s).slice(0, 300)}`);
    try {
      this.ws.send(s);
    } catch (e) {
      this.sendError = e.message;
    }
  }
  send(m) {
    this.sendRaw(JSON.stringify(m));
  }
  async wait(pred, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.msgs.findIndex((m) => Array.isArray(m) && pred(m));
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      if (this.closed || Date.now() > end) return null;
      await sleep(10);
    }
  }
  async settle(ms = 600) {
    const end = Date.now() + ms;
    while (!this.closed && Date.now() < end) await sleep(10);
  }
  drain() {
    return this.msgs.splice(0);
  }
  async join(details = HELLO_DETAILS, realm = REALM) {
    await this.open();
    this.send([T.HELLO, realm, details]);
    const w = await this.wait((m) => m[0] === T.WELCOME || m[0] === T.ABORT);
    if (!w || w[0] !== T.WELCOME) throw new Error(`join failed: ${w ? brief(w) : 'no reply'}`);
    this.session = w[1];
    return w;
  }
  // everything received on this connection after WELCOME (consumed by wait() or not)
  outcome() {
    this.drain();
    const msgs = this.all.filter((m) => !(Array.isArray(m) && m[0] === T.WELCOME)).map(brief);
    const parts = [];
    if (msgs.length) parts.push(msgs.join(' '));
    parts.push(
      this.closed ? `closed(${this.closed.code}${this.closed.reason ? `:${this.closed.reason}` : ''})` : 'open',
    );
    if (this.sendError) parts.push(`sendError(${this.sendError})`);
    return parts.join(' ');
  }
  end() {
    try {
      if (!this.closed) this.ws.close(1000);
    } catch {}
  }
}

const scenarios = {
  async 'no-such-realm'() {
    const c = new Conn('a');
    await c.open();
    c.send([T.HELLO, 'com.thruway.no.such.realm', HELLO_DETAILS]);
    await c.wait((m) => m[0] === T.ABORT);
    await c.settle();
    return c.outcome();
  },
  async 'hello-empty-details'() {
    const c = new Conn('a');
    await c.open();
    c.send([T.HELLO, REALM, {}]);
    await c.wait((m) => m[0] === T.WELCOME || m[0] === T.ABORT);
    await c.settle(300);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'call-before-hello'() {
    const c = new Conn('a');
    await c.open();
    c.send([T.CALL, 1, {}, 'com.thruway.x', []]);
    await c.settle(1500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'double-hello'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.HELLO, REALM, HELLO_DETAILS]);
    await c.settle(1500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'invalid-json'() {
    const c = new Conn('a');
    await c.join();
    c.sendRaw('{not json');
    await c.settle(1500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'unknown-message-type'() {
    const c = new Conn('a');
    await c.join();
    c.send([999, 1, {}]);
    await c.settle(1500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'binary-frame-on-json'() {
    const c = new Conn('a');
    await c.join();
    c.sendRaw(new TextEncoder().encode(JSON.stringify([T.CALL, 1, {}, 'x.y', []])));
    await c.settle(1500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'request-id-0'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.CALL, 0, {}, 'com.thruway.nope', []]);
    await c.wait((m) => m[0] === T.ERROR);
    await c.settle(800);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'request-id-2^53'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.CALL, 2 ** 53, {}, 'com.thruway.nope', []]);
    await c.wait((m) => m[0] === T.ERROR);
    await c.settle(800);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'request-id-non-sequential'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.SUBSCRIBE, 7, {}, 'com.thruway.q.t1']);
    await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    c.send([T.SUBSCRIBE, 3, {}, 'com.thruway.q.t2']);
    await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    await c.settle(500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'request-id-reuse-inflight'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.slow']);
    const reg = await c.wait((m) => m[0] === T.REGISTERED);
    c.send([T.CALL, 2, {}, 'com.thruway.q.slow', ['a']]);
    c.send([T.CALL, 2, {}, 'com.thruway.q.slow', ['b']]);
    await sleep(500);
    const invs = c.msgs.filter((m) => m[0] === T.INVOCATION);
    for (const inv of invs) c.send([T.YIELD, inv[1], {}, inv[4]]);
    await c.settle(800);
    const r = `${invs.length} INVOCATION(s); then ${c.outcome()}`;
    c.end();
    return reg ? r : `register failed; ${r}`;
  },
  async 'invalid-uri'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'bad uri with spaces']);
    await c.wait((m) => m[0] === T.REGISTERED || m[0] === T.ERROR);
    c.send([T.SUBSCRIBE, 2, {}, 'a..b']);
    await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    c.send([T.CALL, 3, {}, 'wamp.reserved.x', []]);
    await c.wait((m) => m[0] === T.RESULT || m[0] === T.ERROR);
    await c.settle(500);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'subscribe-same-topic-twice'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.SUBSCRIBE, 1, {}, 'com.thruway.q.dup']);
    const a = await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    c.send([T.SUBSCRIBE, 2, {}, 'com.thruway.q.dup']);
    const b = await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    const same =
      a && b && a[0] === T.SUBSCRIBED && b[0] === T.SUBSCRIBED
        ? a[2] === b[2]
          ? 'same subscription id'
          : 'DIFFERENT subscription ids'
        : `${a && brief(a)} / ${b && brief(b)}`;
    await c.settle(300);
    const r = `${same}; ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'unsubscribe-unknown'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.UNSUBSCRIBE, 1, 123456789]);
    await c.wait((m) => m[0] === T.ERROR || m[0] === T.UNSUBSCRIBED);
    await c.settle(300);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'yield-unknown-invocation'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.YIELD, 987654321, {}, []]);
    await c.settle(1200);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'call-timeout-option'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.never']);
    await c.wait((m) => m[0] === T.REGISTERED);
    const t0 = Date.now();
    c.send([T.CALL, 2, { timeout: 500 }, 'com.thruway.q.never', []]);
    const e = await c.wait((m) => (m[0] === T.ERROR || m[0] === T.RESULT) && m[2] === 2, 3000);
    const took = Date.now() - t0;
    await c.settle(300);
    const r = `${e ? `${brief(e)} after ${took}ms` : 'no reply in 3s'}; rest: ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'cancel-kill'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.cancelme']);
    await c.wait((m) => m[0] === T.REGISTERED);
    c.send([T.CALL, 2, {}, 'com.thruway.q.cancelme', []]);
    const inv = await c.wait((m) => m[0] === T.INVOCATION);
    c.send([T.CANCEL, 2, { mode: 'kill' }]);
    const intr = await c.wait((m) => m[0] === T.INTERRUPT, 1500);
    if (intr && inv) c.send([T.ERROR, T.INVOCATION, inv[1], {}, 'wamp.error.canceled']);
    const e = await c.wait((m) => m[0] === T.ERROR && m[2] === 2, 1500);
    await c.settle(300);
    const r = `INTERRUPT:${intr ? JSON.stringify(intr[2]) : 'none'} caller:${e ? brief(e) : 'none'}; rest: ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'cancel-skip'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.skipme']);
    await c.wait((m) => m[0] === T.REGISTERED);
    c.send([T.CALL, 2, {}, 'com.thruway.q.skipme', []]);
    const inv = await c.wait((m) => m[0] === T.INVOCATION);
    c.send([T.CANCEL, 2, { mode: 'skip' }]);
    const e = await c.wait((m) => m[0] === T.ERROR && m[2] === 2, 1500);
    if (inv) c.send([T.YIELD, inv[1], {}, ['late']]);
    await c.settle(500);
    const r = `caller:${e ? brief(e) : 'none'}; after late YIELD: ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'callee-error-uri'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.fails']);
    await c.wait((m) => m[0] === T.REGISTERED);
    c.send([T.CALL, 2, {}, 'com.thruway.q.fails', []]);
    const inv = await c.wait((m) => m[0] === T.INVOCATION);
    if (inv) c.send([T.ERROR, T.INVOCATION, inv[1], { x: 1 }, 'com.thruway.custom_error', ['a'], { k: 'v' }]);
    const e = await c.wait((m) => m[0] === T.ERROR && m[2] === 2);
    await c.settle(300);
    const r = `${e ? JSON.stringify(e) : 'none'}; ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'callee-leaves-mid-call'() {
    const a = new Conn('caller');
    const b = new Conn('callee');
    await a.join();
    await b.join();
    b.send([T.REGISTER, 1, {}, 'com.thruway.q.leaver']);
    await b.wait((m) => m[0] === T.REGISTERED);
    a.send([T.CALL, 1, {}, 'com.thruway.q.leaver', []]);
    await b.wait((m) => m[0] === T.INVOCATION);
    b.ws.close(1000);
    const e = await a.wait((m) => m[0] === T.ERROR && m[2] === 1, 3000);
    await a.settle(300);
    const r = `caller got ${e ? brief(e) : 'nothing in 3s'}; ${a.outcome()}`;
    a.end();
    return r;
  },
  async 'publish-no-subscribers-ack'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.q.nobody', []]);
    await c.wait((m) => m[0] === T.PUBLISHED || m[0] === T.ERROR);
    await c.settle(300);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'publish-exclude-me-default'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.SUBSCRIBE, 1, {}, 'com.thruway.q.self']);
    await c.wait((m) => m[0] === T.SUBSCRIBED);
    c.send([T.PUBLISH, 2, { acknowledge: true }, 'com.thruway.q.self', []]);
    await c.wait((m) => m[0] === T.PUBLISHED);
    await c.settle(400);
    const ev = c.msgs.filter((m) => m[0] === T.EVENT).length;
    const r = `${ev} self EVENT(s) (spec: 0); ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'publish-eligible-exclude'() {
    const a = new Conn('pub');
    const b = new Conn('subB');
    const d = new Conn('subD');
    await a.join();
    await b.join();
    await d.join();
    for (const s of [b, d]) {
      s.send([T.SUBSCRIBE, 1, {}, 'com.thruway.q.bw']);
      await s.wait((m) => m[0] === T.SUBSCRIBED);
    }
    a.send([T.PUBLISH, 1, { acknowledge: true, eligible: [b.session] }, 'com.thruway.q.bw', ['eligible-b']]);
    a.send([T.PUBLISH, 2, { acknowledge: true, exclude: [b.session] }, 'com.thruway.q.bw', ['exclude-b']]);
    await a.wait((m) => m[0] === T.PUBLISHED && m[1] === 2);
    await sleep(400);
    const evB = b.msgs.filter((m) => m[0] === T.EVENT).map((m) => m[4]?.[0]);
    const evD = d.msgs.filter((m) => m[0] === T.EVENT).map((m) => m[4]?.[0]);
    for (const s of [a, b, d]) s.end();
    return `B got ${JSON.stringify(evB)} (expect ["eligible-b"]), D got ${JSON.stringify(evD)} (expect ["exclude-b"])`;
  },
  async 'pattern-subscription'() {
    const a = new Conn('pub');
    const b = new Conn('sub');
    await a.join();
    await b.join();
    b.send([T.SUBSCRIBE, 1, { match: 'prefix' }, 'com.thruway.q.pfx']);
    const s1 = await b.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    b.send([T.SUBSCRIBE, 2, { match: 'wildcard' }, 'com.thruway..wc']);
    const s2 = await b.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
    a.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.q.pfx.deep.er', ['p']]);
    a.send([T.PUBLISH, 2, { acknowledge: true }, 'com.thruway.x.wc', ['w']]);
    await a.wait((m) => m[0] === T.PUBLISHED && m[1] === 2);
    await sleep(400);
    const ev = b.msgs.filter((m) => m[0] === T.EVENT).map((m) => `${m[4]?.[0]}:${m[3]?.topic ?? 'no-topic-detail'}`);
    a.end();
    b.end();
    return `prefix:${s1 && brief(s1)} wildcard:${s2 && brief(s2)} events:${JSON.stringify(ev)}`;
  },
  async 'shared-registration-roundrobin'() {
    const a = new Conn('caller');
    const b = new Conn('c1');
    const d = new Conn('c2');
    await a.join();
    await b.join();
    await d.join();
    const res = [];
    for (const s of [b, d]) {
      s.send([T.REGISTER, 1, { invoke: 'roundrobin' }, 'com.thruway.q.rr']);
      res.push(await s.wait((m) => m[0] === T.REGISTERED || m[0] === T.ERROR));
    }
    const who = [];
    const answer = (s, tag) =>
      setInterval(() => {
        for (const m of s.msgs.splice(0))
          if (m[0] === T.INVOCATION) {
            who.push(tag);
            s.send([T.YIELD, m[1], {}, [tag]]);
          }
      }, 5);
    const i1 = answer(b, 'c1');
    const i2 = answer(d, 'c2');
    for (let i = 1; i <= 4; i++) {
      a.send([T.CALL, i, {}, 'com.thruway.q.rr', []]);
      await a.wait((m) => (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined, 2000);
    }
    clearInterval(i1);
    clearInterval(i2);
    for (const s of [a, b, d]) s.end();
    return `register: ${res.map((m) => m && brief(m)).join(',')}; invocations: ${who.join(',')}`;
  },
  async 'progressive-call-results'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.prog']);
    await c.wait((m) => m[0] === T.REGISTERED);
    c.send([T.CALL, 2, { receive_progress: true }, 'com.thruway.q.prog', []]);
    const inv = await c.wait((m) => m[0] === T.INVOCATION);
    const rp = inv?.[3]?.receive_progress === true;
    if (inv) {
      c.send([T.YIELD, inv[1], { progress: true }, ['p1']]);
      c.send([T.YIELD, inv[1], { progress: true }, ['p2']]);
      c.send([T.YIELD, inv[1], {}, ['done']]);
    }
    await c.settle(800);
    const res = c.msgs.filter((m) => m[0] === T.RESULT).map((m) => `${m[3]?.[0]}${m[2]?.progress ? '(progress)' : ''}`);
    const r = `INVOCATION.receive_progress=${rp}; RESULTs: ${res.join(',')}; ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'payload-1MiB'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.REGISTER, 1, {}, 'com.thruway.q.echo']);
    await c.wait((m) => m[0] === T.REGISTERED);
    const big = 'x'.repeat(1024 * 1024);
    c.send([T.CALL, 2, {}, 'com.thruway.q.echo', [big]]);
    const inv = await c.wait((m) => m[0] === T.INVOCATION, 5000);
    if (inv) c.send([T.YIELD, inv[1], {}, inv[4]]);
    const res = await c.wait((m) => (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined, 5000);
    await c.settle(300);
    const r = `${res ? (res[0] === T.RESULT ? `RESULT len=${res[3]?.[0]?.length}` : brief(res)) : 'no result'}; ${c.outcome()}`;
    c.end();
    return r;
  },
  async 'payload-20MiB'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.q.big', ['y'.repeat(20 * 1024 * 1024)]]);
    await c.wait((m) => m[0] === T.PUBLISHED || m[0] === T.ERROR, 8000);
    await c.settle(1000);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'router-goodbye-via-kill'() {
    const a = new Conn('killer');
    const b = new Conn('victim');
    await a.join();
    await b.join();
    a.send([T.CALL, 1, {}, KILL_PROC, [b.session], { reason: 'com.thruway.test.kill', message: 'bye' }]);
    const r1 = await a.wait((m) => (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined, 3000);
    const g = await b.wait((m) => m[0] === T.GOODBYE || m[0] === T.ABORT, 3000);
    let reply = '';
    if (g && g[0] === T.GOODBYE) {
      b.send([T.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
      reply = ' (we replied GOODBYE)';
    }
    await b.settle(1500);
    const r = `kill call: ${r1 ? brief(r1) : 'no reply'}; victim got ${g ? JSON.stringify(g) : 'nothing'}${reply}; victim: ${b.outcome()}`;
    a.end();
    b.end();
    return r;
  },
  async 'goodbye-close-code'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.GOODBYE, {}, 'wamp.close.system_shutdown']);
    await c.wait((m) => m[0] === T.GOODBYE);
    await c.settle(1500);
    return c.outcome();
  },
  async 'message-after-goodbye'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
    await c.wait((m) => m[0] === T.GOODBYE, 1500);
    c.send([T.CALL, 9, {}, 'com.thruway.q.after', []]);
    await c.settle(1000);
    const r = c.outcome();
    c.end();
    return r;
  },
  async 'rejoin-after-goodbye-same-socket'() {
    const c = new Conn('a');
    await c.join();
    c.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
    await c.wait((m) => m[0] === T.GOODBYE, 1500);
    if (c.closed) return `router closed socket after GOODBYE (${c.closed.code}); cannot re-HELLO`;
    c.send([T.HELLO, REALM, HELLO_DETAILS]);
    await c.wait((m) => m[0] === T.WELCOME || m[0] === T.ABORT, 2000);
    await c.settle(300);
    const r = c.outcome();
    c.end();
    return r;
  },
};

const results = {};
for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const t0 = Date.now();
  try {
    results[name] = await Promise.race([fn(), sleep(15000).then(() => 'scenario timeout (15s)')]);
  } catch (e) {
    results[name] = `EXCEPTION ${e.message}`;
  }
  console.log(`${name.padEnd(32)} ${String(Date.now() - t0).padStart(5)}ms  ${results[name]}`);
}
if (flag('json')) console.log(`QUIRKS ${JSON.stringify({ url: URL_, realm: REALM, results })}`);
process.exit(0);
