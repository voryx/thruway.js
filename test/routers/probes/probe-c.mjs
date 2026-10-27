#!/usr/bin/env node
// WAMP router feature / quirk prober (routers group C). Node >= 22, no dependencies (native WebSocket).
//
//   node probe-c.mjs <url> <realm> [--only=a,b] [--json=out.json] [--wait=ms] [--verbose]
//
// Every probe opens fresh anonymous sessions, does one thing, and records what the router actually sent back
// (frames are summarised in the report). Probes never assert "spec correct"; they report observed behaviour.

import { writeFileSync } from 'node:fs';

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
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const [url, realm] = argv.filter((a) => !a.startsWith('--'));
if (!url || !realm) {
  console.error('usage: node probe-c.mjs <url> <realm> [--only=a,b] [--json=out.json] [--wait=ms] [--verbose]');
  process.exit(2);
}
const WAIT = Number(flags.wait ?? 1500);
const VERBOSE = !!flags.verbose;
const only = flags.only ? new Set(String(flags.only).split(',')) : null;

const short = (m) => {
  if (!Array.isArray(m)) return `NON-ARRAY ${JSON.stringify(m)}`.slice(0, 200);
  const s = JSON.stringify(m);
  return `${NAME[m[0]] ?? '#' + m[0]} ${s.length > 260 ? s.slice(0, 260) + '...' : s}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

const ROLES = {
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
  subscriber: { features: { pattern_based_subscription: true, publisher_identification: true, event_retention: true } },
};

class Peer {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
    this.onMessage = null;
  }
  id() {
    return this.nextId++;
  }
  open(protocols = ['wamp.2.json']) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols);
      this.ws = ws;
      const t = setTimeout(() => reject(new Error('open timeout')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(ws.protocol);
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(t);
        reject(new Error(`ws error ${e?.message ?? ''}`));
      });
      ws.addEventListener('close', (e) => {
        this.closed = { code: e.code, reason: e.reason };
        if (VERBOSE) console.log(`   [${this.label}] closed ${e.code} ${e.reason}`);
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
      });
      ws.addEventListener('message', (ev) => {
        let m;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          m = { unparseable: String(ev.data).slice(0, 200) };
        }
        if (VERBOSE) console.log(`   [${this.label}] <- ${short(m)}`);
        this.frames.push(m);
        try {
          this.onMessage?.(m);
        } catch (e) {
          console.error('handler error', e);
        }
        for (const w of [...this.waiters]) {
          if (w.pred(m)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(m);
          }
        }
      });
    });
  }
  send(m) {
    if (VERBOSE) console.log(`   [${this.label}] -> ${short(m)}`);
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  // resolves with the first (already received or future) frame matching pred, or null on timeout/close
  wait(pred, ms = WAIT, { fromIndex = 0 } = {}) {
    const hit = this.frames.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        resolve(null);
      }, ms);
      this.waiters.push(w);
    });
  }
  since(i) {
    return this.frames.slice(i);
  }
  async join(details = {}) {
    await this.open();
    this.send([MSG.HELLO, realm, { agent: 'probe-c', roles: ROLES, ...details }]);
    const m = await this.wait((m) => [MSG.WELCOME, MSG.ABORT, MSG.CHALLENGE].includes(m?.[0]), 3000);
    if (!m || m[0] !== MSG.WELCOME) throw new Error(`join failed: ${m ? short(m) : 'timeout'}`);
    this.session = m[1];
    return m;
  }
  close() {
    try {
      this.ws?.close(1000);
    } catch {}
  }
  async reply(type, id, okType, ms = WAIT) {
    return this.wait(
      (m) =>
        (m?.[0] === okType && m[1] === id) ||
        (m?.[0] === MSG.ERROR && m[1] === type && m[2] === id) ||
        (m?.[0] === MSG.ERROR && m[2] === id),
      ms,
    );
  }
  async register(uri, opts = {}) {
    const id = this.id();
    this.send([MSG.REGISTER, id, opts, uri]);
    const r = await this.reply(MSG.REGISTER, id, MSG.REGISTERED);
    return r;
  }
  async subscribe(topic, opts = {}) {
    const id = this.id();
    this.send([MSG.SUBSCRIBE, id, opts, topic]);
    return this.reply(MSG.SUBSCRIBE, id, MSG.SUBSCRIBED);
  }
}

// Make a callee whose invocation handler is `fn(inv, peer)`
async function callee(uri, fn, regOpts = {}, label = 'callee') {
  const p = new Peer(label);
  await p.join();
  p.onMessage = (m) => {
    if (m[0] === MSG.INVOCATION) fn(m, p);
  };
  const r = await p.register(uri, regOpts);
  return { p, reg: r };
}

const probes = [];
const probe = (name, desc, fn) => probes.push({ name, desc, fn });
const peers = [];
const mk = (label) => {
  const p = new Peer(label);
  peers.push(p);
  return p;
};

// ---------------------------------------------------------------------------------------------------- basics
probe('welcome', 'WELCOME details/roles for an anonymous HELLO', async () => {
  const p = mk('a');
  const w = await p.join();
  return { welcome: w[2] };
});

probe('hello_no_roles', 'HELLO with empty details (no roles) - spec requires roles', async () => {
  const p = mk('a');
  await p.open();
  p.send([MSG.HELLO, realm, {}]);
  const m = await p.wait((m) => [MSG.WELCOME, MSG.ABORT].includes(m?.[0]));
  return { reply: m ? short(m) : 'none', closed: p.closed };
});

probe('invalid_realm', 'HELLO for realm "Bad Realm!" (invalid chars)', async () => {
  const p = mk('a');
  await p.open();
  p.send([MSG.HELLO, 'Bad Realm!', { roles: ROLES }]);
  const m = await p.wait((m) => [MSG.WELCOME, MSG.ABORT].includes(m?.[0]));
  await sleep(200);
  return { reply: m ? short(m) : 'none (no ABORT, no close)', closed: p.closed };
});

probe('subprotocol_none', 'WebSocket offering only "wamp.2.msgpack" (no json)', async () => {
  const p = mk('a');
  try {
    const proto = await p.open(['wamp.2.msgpack']);
    await sleep(300);
    return { opened: true, negotiated: proto, closed: p.closed };
  } catch (e) {
    return { opened: false, error: e.message };
  }
});

probe('msg_before_hello', 'SUBSCRIBE sent before HELLO', async () => {
  const p = mk('a');
  await p.open();
  p.send([MSG.SUBSCRIBE, 1, {}, 'probe.c.before_hello']);
  await sleep(WAIT);
  return { frames: p.frames.map(short), closed: p.closed };
});

probe('second_hello', 'second HELLO after WELCOME', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send([MSG.HELLO, realm, { roles: ROLES }]);
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('invalid_json', 'send "not json{" after WELCOME', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send('not json{');
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('unknown_type', 'send [999, 1, {}] after WELCOME', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send([999, 1, {}]);
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('client_sends_welcome', 'send a router-only message (WELCOME) after WELCOME', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send([MSG.WELCOME, 123, {}]);
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('goodbye', 'GOODBYE wamp.close.system_shutdown -> reply + who closes the socket', async () => {
  const p = mk('a');
  await p.join();
  p.send([MSG.GOODBYE, { message: 'bye' }, 'wamp.close.system_shutdown']);
  const g = await p.wait((m) => m?.[0] === MSG.GOODBYE);
  await sleep(500);
  return { reply: g ? short(g) : 'none', closed_by_router: p.closed };
});

// ---------------------------------------------------------------------------------------------------- request ids
for (const [name, rid] of [
  ['rid_zero', 0],
  ['rid_2pow53', 2 ** 53],
  ['rid_negative', -5],
  ['rid_string', 'abc'],
  ['rid_float', 1.5],
]) {
  probe(name, `CALL with request id ${JSON.stringify(rid)} to an unknown procedure`, async () => {
    const p = mk('a');
    await p.join();
    const i = p.frames.length;
    p.send([MSG.CALL, rid, {}, `probe.c.nope_${uniq()}`]);
    await sleep(WAIT);
    return { frames: p.since(i).map(short), closed: p.closed };
  });
}

probe('rid_nonsequential', 'REGISTER with id 1000 then SUBSCRIBE with id 5 (non-sequential)', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send([MSG.REGISTER, 1000, {}, `probe.c.ns_${uniq()}`]);
  await sleep(200);
  p.send([MSG.SUBSCRIBE, 5, {}, `probe.c.ns_${uniq()}`]);
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('rid_duplicate_inflight', 'two CALLs in flight with the same request id', async () => {
  const uri = `probe.c.dup_${uniq()}`;
  const { p: c } = await callee(uri, (inv, me) =>
    setTimeout(() => me.send([MSG.YIELD, inv[1], {}, [inv[4]?.[0]]]), 300),
  );
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const i = p.frames.length;
  p.send([MSG.CALL, 7, {}, uri, ['first']]);
  p.send([MSG.CALL, 7, {}, uri, ['second']]);
  await sleep(WAIT);
  return { caller_frames: p.since(i).map(short), invocations: c.frames.filter((m) => m[0] === MSG.INVOCATION).length };
});

for (const who of ['second', 'first']) {
  probe(
    `rid_same_across_sessions_cancel_${who}`,
    `two callers both use CALL id 1, the ${who} caller cancels (kill)`,
    async () => {
      const uri = `probe.c.xs_${uniq()}`;
      const { p: c } = await callee(uri, () => {});
      peers.push(c);
      c.onMessage = (m) => {
        if (m[0] === MSG.INTERRUPT) c.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']);
      };
      const a = mk('caller1');
      const b = mk('caller2');
      await a.join();
      await b.join();
      const ia = a.frames.length,
        ib = b.frames.length;
      a.send([MSG.CALL, 1, {}, uri, ['a']]);
      await sleep(100);
      b.send([MSG.CALL, 1, {}, uri, ['b']]);
      await sleep(200);
      (who === 'second' ? b : a).send([MSG.CANCEL, 1, { mode: 'kill' }]);
      await sleep(WAIT);
      const invs = c.frames.filter((m) => m[0] === MSG.INVOCATION).map((m) => [m[1], m[4]?.[0]]);
      const ints = c.frames.filter((m) => m[0] === MSG.INTERRUPT).map((m) => m[1]);
      return {
        caller1_frames: a.since(ia).map(short),
        caller2_frames: b.since(ib).map(short),
        callee_interrupted_calls: ints.map((id) => invs.find((i) => i[0] === id)?.[1] ?? `unknown inv ${id}`),
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------------- URIs
for (const [name, uri] of [
  ['uri_uppercase', 'probe.C.Upper'],
  ['uri_hyphen', 'probe.c.with-hyphen'],
  ['uri_empty_component', 'probe..c'],
  ['uri_wamp_reserved', 'wamp.probe_c'],
]) {
  probe(name, `REGISTER ${JSON.stringify(uri)}`, async () => {
    const p = mk('a');
    await p.join();
    const r = await p.register(uri);
    return { reply: r ? short(r) : 'none' };
  });
}

probe('uri_publish_invalid', 'PUBLISH{acknowledge} to "probe.C.Bad-Topic"', async () => {
  const p = mk('a');
  await p.join();
  const id = p.id();
  p.send([MSG.PUBLISH, id, { acknowledge: true }, 'probe.C.Bad-Topic', []]);
  const r = await p.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
  return { reply: r ? short(r) : 'none' };
});

// ---------------------------------------------------------------------------------------------------- RPC
probe(
  'rpc_errors',
  'CALL unknown procedure; UNREGISTER unknown id; callee ERROR with custom uri/args/kwargs',
  async () => {
    const p = mk('a');
    await p.join();
    const id1 = p.id();
    p.send([MSG.CALL, id1, {}, `probe.c.unknown_${uniq()}`, []]);
    const r1 = await p.reply(MSG.CALL, id1, MSG.RESULT);
    const id2 = p.id();
    p.send([MSG.UNREGISTER, id2, 123456789]);
    const r2 = await p.reply(MSG.UNREGISTER, id2, MSG.UNREGISTERED);
    const uri = `probe.c.err_${uniq()}`;
    const { p: c } = await callee(uri, (inv, me) =>
      me.send([MSG.ERROR, MSG.INVOCATION, inv[1], { x: 1 }, 'app.error.custom', ['a1'], { k: 'v' }]),
    );
    peers.push(c);
    const id3 = p.id();
    p.send([MSG.CALL, id3, {}, uri, []]);
    const r3 = await p.reply(MSG.CALL, id3, MSG.RESULT);
    return { call_unknown: r1 && short(r1), unregister_unknown: r2 && short(r2), callee_error: r3 && short(r3) };
  },
);

probe('payload_fidelity', 'echo callee: args/kwargs edge cases survive the router unchanged?', async () => {
  const uri = `probe.c.echo_${uniq()}`;
  const { p: c } = await callee(uri, (inv, me) => {
    const out = [MSG.YIELD, inv[1], {}];
    if (inv.length > 4) out.push(inv[4]);
    if (inv.length > 5) out.push(inv[5]);
    me.send(out);
  });
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const cases = [
    { label: 'no args', msgTail: [] },
    { label: 'args []', msgTail: [[]] },
    { label: 'args [[1,2]]', msgTail: [[[1, 2]]] },
    { label: 'args [null]', msgTail: [[null]] },
    { label: 'args [1,2,3]', msgTail: [[1, 2, 3]] },
    { label: 'args [] kwargs {}', msgTail: [[], {}] },
    { label: 'args [] kwargs {a:1}', msgTail: [[], { a: 1 }] },
    { label: 'unicode', msgTail: [['héllo \u{1F600} / \\ "q"']] },
    { label: 'int 2^53-1', msgTail: [[9007199254740991]] },
    { label: 'nested', msgTail: [[{ a: [1, { b: null }] }], { deep: { x: [] } }] },
  ];
  const out = {};
  for (const cs of cases) {
    const id = p.id();
    const ii = c.frames.length;
    p.send([MSG.CALL, id, {}, uri, ...cs.msgTail]);
    const r = await p.reply(MSG.CALL, id, MSG.RESULT);
    const inv = c.since(ii).find((m) => m[0] === MSG.INVOCATION);
    out[cs.label] = {
      sent: JSON.stringify(cs.msgTail),
      invocation_tail: inv ? JSON.stringify(inv.slice(4)) : 'none',
      result_tail: r ? JSON.stringify(r.slice(3)) : 'none',
    };
  }
  return out;
});

probe('large_payload', 'echo a ~1 MiB string argument', async () => {
  const uri = `probe.c.big_${uniq()}`;
  const { p: c } = await callee(uri, (inv, me) => me.send([MSG.YIELD, inv[1], {}, inv[4]]));
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const big = 'x'.repeat(1024 * 1024);
  const id = p.id();
  const t = Date.now();
  p.send([MSG.CALL, id, {}, uri, [big]]);
  const r = await p.reply(MSG.CALL, id, MSG.RESULT, 10000);
  return {
    ok: !!(r && r[0] === MSG.RESULT && r[3]?.[0]?.length === big.length),
    ms: Date.now() - t,
    reply: r ? short(r).slice(0, 80) : 'none',
    closed: p.closed,
  };
});

probe('caller_identification', 'REGISTER{disclose_caller:true} -> INVOCATION.details.caller?', async () => {
  const uri = `probe.c.ci_${uniq()}`;
  const { p: c, reg } = await callee(uri, (inv, me) => me.send([MSG.YIELD, inv[1], {}, []]), { disclose_caller: true });
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const id = p.id();
  p.send([MSG.CALL, id, { disclose_me: true }, uri, []]);
  await p.reply(MSG.CALL, id, MSG.RESULT);
  const inv = c.frames.find((m) => m[0] === MSG.INVOCATION);
  return { register: reg && short(reg), invocation_details: inv?.[3], caller_session: p.session };
});

probe('progressive_results', 'CALL{receive_progress} + 2 progressive YIELDs + final', async () => {
  const uri = `probe.c.prog_${uniq()}`;
  const { p: c } = await callee(uri, (inv, me) => {
    me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
    me.send([MSG.YIELD, inv[1], { progress: true }, ['p2']]);
    me.send([MSG.YIELD, inv[1], {}, ['final']]);
  });
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const id = p.id();
  const i = p.frames.length;
  p.send([MSG.CALL, id, { receive_progress: true }, uri, []]);
  await p.wait((m) => m?.[0] === MSG.RESULT && m[1] === id && !m[2]?.progress);
  await sleep(100);
  const inv = c.frames.find((m) => m[0] === MSG.INVOCATION);
  return { invocation_details: inv?.[3], caller_frames: p.since(i).map(short) };
});

probe(
  'progressive_unrequested',
  'callee sends progressive YIELD although caller did not ask for progress',
  async () => {
    const uri = `probe.c.progu_${uniq()}`;
    const { p: c } = await callee(uri, (inv, me) => {
      me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
      me.send([MSG.YIELD, inv[1], {}, ['final']]);
    });
    peers.push(c);
    const p = mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, {}, uri, []]);
    await sleep(WAIT);
    return {
      caller_frames: p.since(i).map(short),
      callee_frames_after: c.frames
        .filter((m) => m[0] !== MSG.WELCOME && m[0] !== MSG.REGISTERED && m[0] !== MSG.INVOCATION)
        .map(short),
    };
  },
);

for (const mode of ['skip', 'kill', 'killnowait']) {
  probe(
    `cancel_${mode}`,
    `CANCEL{mode:${mode}} on a pending call (callee answers INTERRUPT with ERROR(INVOCATION) wamp.error.canceled)`,
    async () => {
      const uri = `probe.c.cancel_${mode}_${uniq()}`;
      const { p: c } = await callee(uri, () => {});
      peers.push(c);
      c.onMessage = (m) => {
        if (m[0] === MSG.INTERRUPT)
          setTimeout(() => c.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']), 50);
      };
      const p = mk('caller');
      await p.join();
      const id = p.id();
      const i = p.frames.length;
      p.send([MSG.CALL, id, {}, uri, []]);
      await c.wait((m) => m?.[0] === MSG.INVOCATION);
      p.send([MSG.CANCEL, id, { mode }]);
      await sleep(WAIT);
      return {
        caller_frames: p.since(i).map(short),
        callee_frames: c.frames.filter((m) => [MSG.INVOCATION, MSG.INTERRUPT, MSG.ERROR].includes(m[0])).map(short),
      };
    },
  );
}

probe('cancel_callee_no_cancel_feature', 'CANCEL{kill} when the callee did NOT announce call_canceling', async () => {
  const uri = `probe.c.cancelnf_${uniq()}`;
  const c = mk('callee');
  await c.open();
  c.send([MSG.HELLO, realm, { roles: { callee: {} } }]);
  await c.wait((m) => m?.[0] === MSG.WELCOME, 3000);
  await c.register(uri);
  const p = mk('caller');
  await p.join();
  const id = p.id();
  const i = p.frames.length;
  p.send([MSG.CALL, id, {}, uri, []]);
  await c.wait((m) => m?.[0] === MSG.INVOCATION);
  p.send([MSG.CANCEL, id, { mode: 'kill' }]);
  await sleep(WAIT);
  return {
    caller_frames: p.since(i).map(short),
    callee_frames: c.frames.filter((m) => [MSG.INVOCATION, MSG.INTERRUPT].includes(m[0])).map(short),
  };
});

probe(
  'cancel_progressive_kill',
  'CANCEL{kill} on a receive_progress call that already got one progressive result',
  async () => {
    const uri = `probe.c.cancelp_${uniq()}`;
    const { p: c } = await callee(uri, (inv, me) => me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]));
    peers.push(c);
    c.onMessage = (m) => {
      if (m[0] === MSG.INVOCATION) c.send([MSG.YIELD, m[1], { progress: true }, ['p1']]);
      if (m[0] === MSG.INTERRUPT)
        setTimeout(() => c.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']), 50);
    };
    const p = mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, { receive_progress: true }, uri, []]);
    await p.wait((m) => m?.[0] === MSG.RESULT && m[1] === id);
    p.send([MSG.CANCEL, id, { mode: 'kill' }]);
    await sleep(WAIT);
    return {
      caller_frames: p.since(i).map(short),
      callee_frames: c.frames.filter((m) => [MSG.INVOCATION, MSG.INTERRUPT].includes(m[0])).map(short),
    };
  },
);

probe('cancel_unknown', 'CANCEL for a request id that was never used', async () => {
  const p = mk('a');
  await p.join();
  const i = p.frames.length;
  p.send([MSG.CANCEL, 424242, {}]);
  await sleep(WAIT);
  return { frames: p.since(i).map(short), closed: p.closed };
});

probe('call_timeout', 'CALL{timeout:300} to a callee that never answers', async () => {
  const uri = `probe.c.timeout_${uniq()}`;
  const { p: c } = await callee(uri, () => {});
  peers.push(c);
  const p = mk('caller');
  await p.join();
  const id = p.id();
  const i = p.frames.length;
  const t = Date.now();
  p.send([MSG.CALL, id, { timeout: 300 }, uri, []]);
  const r = await p.wait(
    (m) => ((m?.[0] === MSG.ERROR || m?.[0] === MSG.RESULT) && m[2] === id) || m?.[1] === id,
    2000,
  );
  return {
    caller_reply: r ? short(r) : 'none within 2s',
    after_ms: r ? Date.now() - t : null,
    invocation_details: c.frames.find((m) => m[0] === MSG.INVOCATION)?.[3],
    callee_interrupt: c.frames.filter((m) => m[0] === MSG.INTERRUPT).map(short),
    caller_frames: p.since(i).map(short),
  };
});

probe('callee_leaves', 'callee disconnects while an invocation is pending', async () => {
  const uri = `probe.c.leave_${uniq()}`;
  const { p: _callee } = await callee(uri, (inv, me) => setTimeout(() => me.ws.close(1000), 100));
  const p = mk('caller');
  await p.join();
  const id = p.id();
  const i = p.frames.length;
  p.send([MSG.CALL, id, {}, uri, []]);
  const r = await p.wait((m) => m?.[2] === id || m?.[1] === id, 2500);
  return { caller_reply: r ? short(r) : 'none within 2.5s', caller_frames: p.since(i).map(short) };
});

probe('caller_leaves', 'caller disconnects while its call is pending: does the callee get INTERRUPT?', async () => {
  const uri = `probe.c.cleave_${uniq()}`;
  const { p: c } = await callee(uri, () => {});
  peers.push(c);
  const p = mk('caller');
  await p.join();
  p.send([MSG.CALL, p.id(), {}, uri, []]);
  await c.wait((m) => m?.[0] === MSG.INVOCATION);
  p.ws.close(1000);
  await sleep(WAIT);
  return { callee_frames: c.frames.filter((m) => [MSG.INVOCATION, MSG.INTERRUPT].includes(m[0])).map(short) };
});

probe('registration_duplicate', 'second session REGISTERs the same URI without options', async () => {
  const uri = `probe.c.dupreg_${uniq()}`;
  const a = mk('a');
  const b = mk('b');
  await a.join();
  await b.join();
  const r1 = await a.register(uri);
  const r2 = await b.register(uri);
  return { first: r1 && short(r1), second: r2 && short(r2) };
});

for (const policy of ['roundrobin', 'random', 'first', 'last']) {
  probe(`shared_${policy}`, `two sessions REGISTER {invoke:"${policy}"}; 6 calls - who gets them?`, async () => {
    const uri = `probe.c.shared_${policy}_${uniq()}`;
    const counts = { a: 0, b: 0 };
    const mkC = async (label) => {
      const p = mk(label);
      await p.join();
      p.onMessage = (m) => {
        if (m[0] === MSG.INVOCATION) {
          counts[label]++;
          p.send([MSG.YIELD, m[1], {}, [label]]);
        }
      };
      return [p, await p.register(uri, { invoke: policy })];
    };
    const [, ra] = await mkC('a');
    const [, rb] = await mkC('b');
    const caller = mk('caller');
    await caller.join();
    const results = [];
    for (let k = 0; k < 6; k++) {
      const id = caller.id();
      caller.send([MSG.CALL, id, {}, uri, []]);
      const r = await caller.reply(MSG.CALL, id, MSG.RESULT);
      results.push(r ? (r[0] === MSG.RESULT ? r[3]?.[0] : short(r)) : 'none');
    }
    return { register_a: ra && short(ra), register_b: rb && short(rb), results, counts };
  });
}

probe('shared_mismatch', 'REGISTER {invoke:"roundrobin"} then {invoke:"random"} on the same URI', async () => {
  const uri = `probe.c.sharedmm_${uniq()}`;
  const a = mk('a');
  const b = mk('b');
  await a.join();
  await b.join();
  const r1 = await a.register(uri, { invoke: 'roundrobin' });
  const r2 = await b.register(uri, { invoke: 'random' });
  return { first: r1 && short(r1), second: r2 && short(r2) };
});

for (const [match, regUri, callUri] of [
  ['prefix', 'probe.c.rp', 'probe.c.rp.x.y'],
  ['wildcard', 'probe..rw', 'probe.c.rw'],
]) {
  probe(`register_${match}`, `REGISTER {match:"${match}"} "${regUri}" then CALL "${callUri}"`, async () => {
    const suffix = uniq();
    const regU = regUri.replace('probe', `probe_${suffix}`);
    const callU = callUri.replace('probe', `probe_${suffix}`);
    const { p: c, reg } = await callee(regU, (inv, me) => me.send([MSG.YIELD, inv[1], {}, ['ok']]), { match });
    peers.push(c);
    const p = mk('caller');
    await p.join();
    const id = p.id();
    p.send([MSG.CALL, id, {}, callU, []]);
    const r = await p.reply(MSG.CALL, id, MSG.RESULT);
    return {
      register: reg ? short(reg) : 'none',
      call: r ? short(r) : 'none',
      invocation_details: c.frames.find((m) => m[0] === MSG.INVOCATION)?.[3],
    };
  });
}

probe('meta_api', 'CALL wamp.session.count / wamp.registration.list / wamp.subscription.list', async () => {
  const p = mk('a');
  await p.join();
  const out = {};
  for (const proc of ['wamp.session.count', 'wamp.session.list', 'wamp.registration.list', 'wamp.subscription.list']) {
    const id = p.id();
    p.send([MSG.CALL, id, {}, proc, []]);
    const r = await p.reply(MSG.CALL, id, MSG.RESULT);
    out[proc] = r ? short(r) : 'none';
  }
  return out;
});

// ---------------------------------------------------------------------------------------------------- PubSub
probe(
  'pubsub_basics',
  'PUBLISH without ack (no reply expected), exclude_me default and false, publisher disclosure',
  async () => {
    const topic = `probe.c.pub_${uniq()}`;
    const p = mk('pubsub');
    await p.join();
    const s = await p.subscribe(topic);
    const sub = new Peer('other');
    peers.push(sub);
    await sub.join();
    await sub.subscribe(topic);
    const i = p.frames.length,
      j = sub.frames.length;
    p.send([MSG.PUBLISH, p.id(), {}, topic, ['default']]);
    p.send([MSG.PUBLISH, p.id(), { exclude_me: false }, topic, ['exclude_me_false']]);
    p.send([MSG.PUBLISH, p.id(), { disclose_me: true }, topic, ['disclose_me']]);
    await sleep(WAIT);
    return {
      subscribed: s && short(s),
      publisher_frames: p.since(i).map(short),
      other_subscriber_frames: sub.since(j).map(short),
    };
  },
);

probe('pubsub_blackwhite', 'PUBLISH {eligible:[B]} and {exclude:[B]} with subscribers A and B', async () => {
  const topic = `probe.c.bw_${uniq()}`;
  const a = mk('A');
  const b = mk('B');
  const pub = mk('pub');
  await a.join();
  await b.join();
  await pub.join();
  await a.subscribe(topic);
  await b.subscribe(topic);
  const ia = a.frames.length,
    ib = b.frames.length;
  pub.send([MSG.PUBLISH, pub.id(), { eligible: [b.session] }, topic, ['eligible_B']]);
  pub.send([MSG.PUBLISH, pub.id(), { exclude: [b.session] }, topic, ['exclude_B']]);
  await sleep(WAIT);
  const got = (p, i) =>
    p
      .since(i)
      .filter((m) => m[0] === MSG.EVENT)
      .map((m) => m[4]?.[0]);
  return { A_got: got(a, ia), B_got: got(b, ib) };
});

probe(
  'meta_events',
  'subscribe to session meta topics (spec + Thruway-legacy names), then another session joins and leaves',
  async () => {
    const topics = [
      'wamp.session.on_join',
      'wamp.session.on_leave',
      'wamp.metaevent.session.on_join',
      'wamp.metaevent.session.on_leave',
    ];
    const p = mk('watcher');
    await p.join();
    const subs = {};
    for (const t of topics) {
      const s = await p.subscribe(t);
      subs[t] = s ? NAME[s[0]] + (s[0] === MSG.ERROR ? ' ' + s[4] : '') : 'none';
    }
    const i = p.frames.length;
    const q = mk('joiner');
    await q.join();
    await sleep(200);
    q.close();
    await sleep(WAIT);
    const bySub = Object.fromEntries(p.frames.filter((m) => m[0] === MSG.SUBSCRIBED).map((m) => [m[2], m[1]]));
    return {
      subscribe_replies: subs,
      events: p
        .since(i)
        .filter((m) => m[0] === MSG.EVENT)
        .map(short),
      joiner_session: q.session,
      sub_ids: bySub,
    };
  },
);

probe('subscribe_duplicate', 'same session SUBSCRIBEs twice to the same topic, then 1 PUBLISH', async () => {
  const topic = `probe.c.dupsub_${uniq()}`;
  const p = mk('a');
  await p.join();
  const s1 = await p.subscribe(topic);
  const s2 = await p.subscribe(topic);
  const pub = mk('pub');
  await pub.join();
  const i = p.frames.length;
  pub.send([MSG.PUBLISH, pub.id(), {}, topic, ['x']]);
  await sleep(WAIT);
  return { first: s1 && short(s1), second: s2 && short(s2), events: p.since(i).map(short) };
});

probe('subscribe_two_sessions_ids', 'two sessions subscribe to the same topic: same subscription id?', async () => {
  const topic = `probe.c.twosub_${uniq()}`;
  const a = mk('a');
  const b = mk('b');
  await a.join();
  await b.join();
  const s1 = await a.subscribe(topic);
  const s2 = await b.subscribe(topic);
  return { a: s1 && short(s1), b: s2 && short(s2) };
});

probe('unsubscribe_unknown', 'UNSUBSCRIBE an unknown subscription id', async () => {
  const p = mk('a');
  await p.join();
  const id = p.id();
  p.send([MSG.UNSUBSCRIBE, id, 987654321]);
  const r = await p.reply(MSG.UNSUBSCRIBE, id, MSG.UNSUBSCRIBED);
  return { reply: r ? short(r) : 'none' };
});

for (const [name, opts, subTopic, pubTopics] of [
  [
    'sub_prefix',
    { match: 'prefix' },
    'probe.c.pfx',
    ['probe.c.pfx', 'probe.c.pfx.a.b', 'probe.c.pfxzzz', 'probe.c.other'],
  ],
  ['sub_wildcard', { match: 'wildcard' }, 'probe.c..w', ['probe.c.x.w', 'probe.c.w', 'probe.c.x.y.w']],
  ['sub_hash_pattern', {}, 'probe.c.h.#', ['probe.c.h.a', 'probe.c.h.a.b', 'probe.c.h']],
  ['sub_star_pattern', {}, 'probe.c.*.s', ['probe.c.a.s', 'probe.c.a.b.s']],
]) {
  probe(name, `SUBSCRIBE ${JSON.stringify(opts)} "${subTopic}" then PUBLISH to ${pubTopics.join(', ')}`, async () => {
    const pre = `probe_${uniq()}`;
    const fix = (t) => t.replace(/^probe/, pre);
    const p = mk('sub');
    await p.join();
    const s = await p.subscribe(fix(subTopic), opts);
    const pub = mk('pub');
    await pub.join();
    const i = p.frames.length;
    const acks = [];
    for (const t of pubTopics) {
      const id = pub.id();
      pub.send([MSG.PUBLISH, id, { acknowledge: true }, fix(t), [t]]);
      const r = await pub.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
      acks.push(r ? NAME[r[0]] + (r[0] === MSG.ERROR ? ' ' + r[4] : '') : 'none');
    }
    await sleep(300);
    const evs = p.since(i).filter((m) => m[0] === MSG.EVENT);
    return {
      subscribed: s ? short(s) : 'none (no reply!)',
      publish_acks: acks,
      delivered: evs.map((e) => e[4]?.[0]),
      event_details: evs.map((e) => e[3]),
    };
  });
}

for (const [name, pubOpts, subOpts] of [
  ['retained_spec', { retain: true, acknowledge: true }, { get_retained: true }],
  ['retained_fox', { retain: true, acknowledge: true }, { retained: true }],
]) {
  probe(
    name,
    `PUBLISH ${JSON.stringify(pubOpts)} then late SUBSCRIBE ${JSON.stringify(subOpts)}; then a live PUBLISH`,
    async () => {
      const topic = `probe.c.ret_${uniq()}`;
      const pub = mk('pub');
      await pub.join();
      const id = pub.id();
      pub.send([MSG.PUBLISH, id, pubOpts, topic, ['retained-value']]);
      const ack = await pub.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
      await sleep(100);
      const p = mk('late');
      await p.join();
      const i = p.frames.length;
      const s = await p.subscribe(topic, subOpts);
      await sleep(300);
      pub.send([MSG.PUBLISH, pub.id(), {}, topic, ['live-value']]);
      await sleep(500);
      return {
        publish_ack: ack && short(ack),
        subscribed: s && short(s),
        late_subscriber_frames: p.since(i).map(short),
      };
    },
  );
}

probe(
  'auth_during_challenge',
  'HELLO authmethods [wampcra] authid joe, ignore CHALLENGE, send PUBLISH{acknowledge}',
  async () => {
    const p = mk('a');
    await p.open();
    p.send([MSG.HELLO, realm, { roles: ROLES, authmethods: ['wampcra'], authid: 'joe' }]);
    const ch = await p.wait((m) => [MSG.CHALLENGE, MSG.WELCOME, MSG.ABORT].includes(m?.[0]));
    const i = p.frames.length;
    p.send([MSG.PUBLISH, 77, { acknowledge: true }, `probe.c.unauth_${uniq()}`, []]);
    p.send([MSG.CALL, 78, {}, 'wamp.session.count', []]);
    await sleep(WAIT);
    return { first_reply: ch ? short(ch) : 'none', after: p.since(i).map(short), closed: p.closed };
  },
);

probe('auth_two_methods', 'HELLO authmethods ["ticket","wampcra"] authid joe: how many CHALLENGEs?', async () => {
  const p = mk('a');
  await p.open();
  p.send([MSG.HELLO, realm, { roles: ROLES, authmethods: ['ticket', 'wampcra'], authid: 'joe' }]);
  await sleep(WAIT);
  return { frames: p.frames.map(short), closed: p.closed };
});

// ---------------------------------------------------------------------------------------------------- runner
const report = { url, realm, node: process.version, at: new Date().toISOString(), probes: {} };
for (const pr of probes) {
  if (only && !only.has(pr.name)) continue;
  process.stdout.write(`== ${pr.name}: ${pr.desc}\n`);
  let res;
  try {
    res = await Promise.race([pr.fn(), sleep(20000).then(() => ({ error: 'probe timeout 20s' }))]);
  } catch (e) {
    res = { error: e.message };
  }
  for (const p of peers.splice(0)) p.close();
  report.probes[pr.name] = { desc: pr.desc, ...res };
  console.log(
    JSON.stringify(res, null, 1)
      .split('\n')
      .map((l) => '   ' + l)
      .join('\n'),
  );
  await sleep(100);
}
if (flags.json) writeFileSync(String(flags.json), JSON.stringify(report, null, 2));
process.exit(0);
