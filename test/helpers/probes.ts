// The router probes of test/routers/ (probes/probe-c.mjs, probes/quirks-b.mjs and the Crossbar groups of
// crossbar/probe.mjs), ported to an injected WebSocket class and an injected clock. Each probe does what the original
// script did and reports in the same shape, so its output can be diffed with the recorded results
// (test/fixtures/probes/, `dialect-fidelity.test.ts`) — against the reference router's dialects with the virtual clock,
// or against a real router with `globalThis.WebSocket` and real timers.
//
//   const env = { WebSocket, url, realm: 'realm1', sleep: (ms) => clock.advance(ms), now: () => clock.now(),
//                 random: () => clock.random() };
//   const report = await runProbeC(env);            // { welcome: {...}, hello_no_roles: {...}, … }
//
// Differences from the scripts, none of which changes what is sent or what is recorded:
// - every wait polls (`sleep(step)` + check) instead of awaiting an event, so a virtual clock can drive it, and the
//   scripts' per-probe time limits are left out (every wait is bounded, and a concurrent limit would advance the
//   clock twice);
// - unique names come from `env.random` (the scripts used Date.now()/Math.random()), shaped like theirs;
// - the crossbar groups run on one endpoint (`env.url`; the script used /ws and /ws-ping, and skipped auth paths here).
import type { WebSocketConstructorLike, WebSocketLike } from '../../src/types.js';

export interface ProbeEnv {
  readonly WebSocket: WebSocketConstructorLike;
  readonly url: string;
  readonly realm: string;
  /** Let `ms` pass (virtual time: advance the clock). Never called concurrently. */
  sleep(ms: number): Promise<void>;
  /** Run `fn` after `ms` (a timer; the probes' delayed answers). */
  setTimeout(fn: () => void, ms: number): void;
  now(): number;
  /** [0, 1): unique URIs and names. */
  random(): number;
}

export type Frame = readonly unknown[];
type Json = Record<string, unknown>;

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
} as const;
const NAME: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

/** The polling step of every wait (ms). */
const STEP = 10;

function nameOf(type: unknown): string {
  return NAME[type as number] ?? `#${String(type)}`;
}

function isFrame(m: unknown): m is Frame {
  return Array.isArray(m);
}

/** probe-c's `short()`. */
function short(m: unknown): string {
  if (!isFrame(m)) return `NON-ARRAY ${JSON.stringify(m)}`.slice(0, 200);
  const s = JSON.stringify(m);
  return `${nameOf(m[0])} ${s.length > 260 ? `${s.slice(0, 260)}...` : s}`;
}

function base36(n: number): string {
  return Math.floor(n).toString(36);
}

/** probe-c's `uniq()`: two base-36 parts joined by `_` (the first with a digit, like Date.now() in base 36). */
function uniqueName(env: ProbeEnv): string {
  return `t${String(Math.floor(env.random() * 1e6)).padStart(6, '0')}_${base36(env.random() * 1e9)}`;
}

/** Poll `check` every STEP ms until it returns a value other than undefined or `ms` passed (then `timeout`). */
async function poll<T>(env: ProbeEnv, ms: number, check: () => T | undefined, timeout: T): Promise<T> {
  for (let waited = 0; ; waited += STEP) {
    const value = check();
    if (value !== undefined) return value;
    if (waited >= ms) return timeout;
    await env.sleep(Math.min(STEP, ms - waited));
  }
}

function details(frame: Frame | null | undefined, at: number): Json | undefined {
  const value = frame?.[at];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

// =====================================================================================================================
// probe-c.mjs
// =====================================================================================================================

const C_ROLES = {
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
  subscriber: {
    features: { pattern_based_subscription: true, publisher_identification: true, event_retention: true },
  },
};

/** probe-c's `Peer`. */
class CPeer {
  ws: WebSocketLike | undefined;
  readonly frames: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  session: unknown;
  onMessage: ((m: Frame) => void) | undefined;
  private nextId = 1;

  constructor(
    private readonly env: ProbeEnv,
    readonly realm: string,
  ) {}

  id(): number {
    return this.nextId++;
  }

  /** Resolves with the negotiated protocol; rejects like the script ('open timeout', 'ws error'). */
  async open(protocols: string[] = ['wamp.2.json']): Promise<string> {
    const ws = new this.env.WebSocket(this.env.url, protocols);
    this.ws = ws;
    let state: 'open' | 'error' | undefined;
    ws.addEventListener('open', () => {
      state ??= 'open';
    });
    ws.addEventListener('error', () => {
      state ??= 'error';
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
    ws.addEventListener('message', (ev) => {
      let m: unknown;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        m = { unparseable: String(ev.data).slice(0, 200) };
      }
      this.frames.push(m);
      if (isFrame(m)) this.onMessage?.(m);
    });
    if (ws.readyState === 1) state = 'open';
    const outcome = await poll(this.env, 5000, () => state, 'timeout');
    if (outcome === 'open') return ws.protocol;
    throw new Error(outcome === 'timeout' ? 'open timeout' : 'ws error ');
  }

  send(m: unknown): void {
    this.ws?.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  /** The first frame (already received or future) matching `pred` from `from` on; null on timeout or close. */
  wait(pred: (m: Frame) => boolean, ms = 1500, from = 0): Promise<Frame | null> {
    return poll(
      this.env,
      ms,
      () => {
        const hit = this.frames.slice(from).find((m) => isFrame(m) && pred(m));
        if (hit !== undefined) return hit as Frame;
        return this.closed === null ? undefined : null;
      },
      null,
    );
  }

  since(i: number): unknown[] {
    return this.frames.slice(i);
  }

  async join(more: Json = {}): Promise<Frame> {
    await this.open();
    this.send([MSG.HELLO, this.realm, { agent: 'probe-c', roles: C_ROLES, ...more }]);
    const m = await this.wait((x) => x[0] === MSG.WELCOME || x[0] === MSG.ABORT || x[0] === MSG.CHALLENGE, 3000);
    if (m?.[0] !== MSG.WELCOME) throw new Error(`join failed: ${m ? short(m) : 'timeout'}`);
    this.session = m[1];
    return m;
  }

  close(): void {
    try {
      this.ws?.close(1000);
    } catch {
      // as the script
    }
  }

  reply(type: number, id: number, okType: number, ms = 1500): Promise<Frame | null> {
    return this.wait(
      (m) =>
        (m[0] === okType && m[1] === id) ||
        (m[0] === MSG.ERROR && m[1] === type && m[2] === id) ||
        (m[0] === MSG.ERROR && m[2] === id),
      ms,
    );
  }

  register(uri: string, opts: Json = {}): Promise<Frame | null> {
    const id = this.id();
    this.send([MSG.REGISTER, id, opts, uri]);
    return this.reply(MSG.REGISTER, id, MSG.REGISTERED);
  }

  subscribe(topic: string, opts: Json = {}): Promise<Frame | null> {
    const id = this.id();
    this.send([MSG.SUBSCRIBE, id, opts, topic]);
    return this.reply(MSG.SUBSCRIBE, id, MSG.SUBSCRIBED);
  }
}

type CProbe = (ctx: CContext) => Promise<Json>;

interface CContext {
  readonly env: ProbeEnv;
  readonly realm: string;
  mk(label: string): CPeer;
  callee(uri: string, fn: (inv: Frame, me: CPeer) => void, regOpts?: Json): Promise<{ p: CPeer; reg: Frame | null }>;
  uniq(): string;
  sleep(ms: number): Promise<void>;
  readonly WAIT: number;
}

const frameList = (frames: readonly unknown[]): string[] => frames.map(short);
const ofType =
  (...types: number[]) =>
  (m: unknown): boolean =>
    isFrame(m) && types.includes(m[0] as number);

function probeC(): [string, CProbe][] {
  const list: [string, CProbe][] = [];
  const probe = (name: string, fn: CProbe): void => {
    list.push([name, fn]);
  };

  probe('welcome', async (c) => {
    const w = await c.mk('a').join();
    return { welcome: w[2] };
  });
  probe('hello_no_roles', async (c) => {
    const p = c.mk('a');
    await p.open();
    p.send([MSG.HELLO, c.realm, {}]);
    const m = await p.wait((x) => x[0] === MSG.WELCOME || x[0] === MSG.ABORT);
    return { reply: m ? short(m) : 'none', closed: p.closed };
  });
  probe('invalid_realm', async (c) => {
    const p = c.mk('a');
    await p.open();
    p.send([MSG.HELLO, 'Bad Realm!', { roles: C_ROLES }]);
    const m = await p.wait((x) => x[0] === MSG.WELCOME || x[0] === MSG.ABORT);
    await c.sleep(200);
    return { reply: m ? short(m) : 'none (no ABORT, no close)', closed: p.closed };
  });
  probe('subprotocol_none', async (c) => {
    const p = c.mk('a');
    try {
      const proto = await p.open(['wamp.2.msgpack']);
      await c.sleep(300);
      return { opened: true, negotiated: proto, closed: p.closed };
    } catch (e) {
      return { opened: false, error: (e as Error).message };
    }
  });
  probe('msg_before_hello', async (c) => {
    const p = c.mk('a');
    await p.open();
    p.send([MSG.SUBSCRIBE, 1, {}, 'probe.c.before_hello']);
    await c.sleep(c.WAIT);
    return { frames: frameList(p.frames), closed: p.closed };
  });
  const after = (name: string, send: (p: CPeer) => void): void => {
    probe(name, async (c) => {
      const p = c.mk('a');
      await p.join();
      const i = p.frames.length;
      send(p);
      await c.sleep(c.WAIT);
      return { frames: frameList(p.since(i)), closed: p.closed };
    });
  };
  after('second_hello', (p) => {
    p.send([MSG.HELLO, p.realm, { roles: C_ROLES }]);
  });
  after('invalid_json', (p) => {
    p.send('not json{');
  });
  after('unknown_type', (p) => {
    p.send([999, 1, {}]);
  });
  after('client_sends_welcome', (p) => {
    p.send([MSG.WELCOME, 123, {}]);
  });
  probe('goodbye', async (c) => {
    const p = c.mk('a');
    await p.join();
    p.send([MSG.GOODBYE, { message: 'bye' }, 'wamp.close.system_shutdown']);
    const g = await p.wait((m) => m[0] === MSG.GOODBYE);
    await c.sleep(500);
    return { reply: g ? short(g) : 'none', closed_by_router: p.closed };
  });
  for (const [name, rid] of [
    ['rid_zero', 0],
    ['rid_2pow53', 2 ** 53],
    ['rid_negative', -5],
    ['rid_string', 'abc'],
    ['rid_float', 1.5],
  ] as const) {
    probe(name, async (c) => {
      const p = c.mk('a');
      await p.join();
      const i = p.frames.length;
      p.send([MSG.CALL, rid, {}, `probe.c.nope_${c.uniq()}`]);
      await c.sleep(c.WAIT);
      return { frames: frameList(p.since(i)), closed: p.closed };
    });
  }
  probe('rid_nonsequential', async (c) => {
    const p = c.mk('a');
    await p.join();
    const i = p.frames.length;
    p.send([MSG.REGISTER, 1000, {}, `probe.c.ns_${c.uniq()}`]);
    await c.sleep(200);
    p.send([MSG.SUBSCRIBE, 5, {}, `probe.c.ns_${c.uniq()}`]);
    await c.sleep(c.WAIT);
    return { frames: frameList(p.since(i)), closed: p.closed };
  });
  probe('rid_duplicate_inflight', async (c) => {
    const uri = `probe.c.dup_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, (inv, me) => {
      c.env.setTimeout(() => {
        me.send([MSG.YIELD, inv[1], {}, [(inv[4] as unknown[] | undefined)?.[0]]]);
      }, 300);
    });
    const p = c.mk('caller');
    await p.join();
    const i = p.frames.length;
    p.send([MSG.CALL, 7, {}, uri, ['first']]);
    p.send([MSG.CALL, 7, {}, uri, ['second']]);
    await c.sleep(c.WAIT);
    return {
      caller_frames: frameList(p.since(i)),
      invocations: callee.frames.filter(ofType(MSG.INVOCATION)).length,
    };
  });
  for (const who of ['second', 'first'] as const) {
    probe(`rid_same_across_sessions_cancel_${who}`, async (c) => {
      const uri = `probe.c.xs_${c.uniq()}`;
      const { p: callee } = await c.callee(uri, () => undefined);
      callee.onMessage = (m) => {
        if (m[0] === MSG.INTERRUPT) callee.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']);
      };
      const a = c.mk('caller1');
      const b = c.mk('caller2');
      await a.join();
      await b.join();
      const ia = a.frames.length;
      const ib = b.frames.length;
      a.send([MSG.CALL, 1, {}, uri, ['a']]);
      await c.sleep(100);
      b.send([MSG.CALL, 1, {}, uri, ['b']]);
      await c.sleep(200);
      (who === 'second' ? b : a).send([MSG.CANCEL, 1, { mode: 'kill' }]);
      await c.sleep(c.WAIT);
      const invs = callee.frames
        .filter(ofType(MSG.INVOCATION))
        .map((m) => [(m as Frame)[1], ((m as Frame)[4] as unknown[] | undefined)?.[0]]);
      const ints = callee.frames.filter(ofType(MSG.INTERRUPT)).map((m) => (m as Frame)[1]);
      return {
        caller1_frames: frameList(a.since(ia)),
        caller2_frames: frameList(b.since(ib)),
        callee_interrupted_calls: ints.map((id) => invs.find((x) => x[0] === id)?.[1] ?? `unknown inv ${String(id)}`),
      };
    });
  }
  for (const [name, uri] of [
    ['uri_uppercase', 'probe.C.Upper'],
    ['uri_hyphen', 'probe.c.with-hyphen'],
    ['uri_empty_component', 'probe..c'],
    ['uri_wamp_reserved', 'wamp.probe_c'],
  ] as const) {
    probe(name, async (c) => {
      const p = c.mk('a');
      await p.join();
      const r = await p.register(uri);
      return { reply: r ? short(r) : 'none' };
    });
  }
  probe('uri_publish_invalid', async (c) => {
    const p = c.mk('a');
    await p.join();
    const id = p.id();
    p.send([MSG.PUBLISH, id, { acknowledge: true }, 'probe.C.Bad-Topic', []]);
    const r = await p.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
    return { reply: r ? short(r) : 'none' };
  });
  probe('rpc_errors', async (c) => {
    const p = c.mk('a');
    await p.join();
    const id1 = p.id();
    p.send([MSG.CALL, id1, {}, `probe.c.unknown_${c.uniq()}`, []]);
    const r1 = await p.reply(MSG.CALL, id1, MSG.RESULT);
    const id2 = p.id();
    p.send([MSG.UNREGISTER, id2, 123456789]);
    const r2 = await p.reply(MSG.UNREGISTER, id2, MSG.UNREGISTERED);
    const uri = `probe.c.err_${c.uniq()}`;
    await c.callee(uri, (inv, me) => {
      me.send([MSG.ERROR, MSG.INVOCATION, inv[1], { x: 1 }, 'app.error.custom', ['a1'], { k: 'v' }]);
    });
    const id3 = p.id();
    p.send([MSG.CALL, id3, {}, uri, []]);
    const r3 = await p.reply(MSG.CALL, id3, MSG.RESULT);
    return { call_unknown: r1 && short(r1), unregister_unknown: r2 && short(r2), callee_error: r3 && short(r3) };
  });
  probe('payload_fidelity', async (c) => {
    const uri = `probe.c.echo_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, (inv, me) => {
      const out: unknown[] = [MSG.YIELD, inv[1], {}];
      if (inv.length > 4) out.push(inv[4]);
      if (inv.length > 5) out.push(inv[5]);
      me.send(out);
    });
    const p = c.mk('caller');
    await p.join();
    const cases: [string, unknown[]][] = [
      ['no args', []],
      ['args []', [[]]],
      ['args [[1,2]]', [[[1, 2]]]],
      ['args [null]', [[null]]],
      ['args [1,2,3]', [[1, 2, 3]]],
      ['args [] kwargs {}', [[], {}]],
      ['args [] kwargs {a:1}', [[], { a: 1 }]],
      ['unicode', [['héllo \u{1F600} / \\ "q"']]],
      ['int 2^53-1', [[9007199254740991]]],
      ['nested', [[{ a: [1, { b: null }] }], { deep: { x: [] } }]],
    ];
    const out: Json = {};
    for (const [label, tail] of cases) {
      const id = p.id();
      const ii = callee.frames.length;
      p.send([MSG.CALL, id, {}, uri, ...tail]);
      const r = await p.reply(MSG.CALL, id, MSG.RESULT);
      const inv = callee.since(ii).find(ofType(MSG.INVOCATION)) as Frame | undefined;
      out[label] = {
        sent: JSON.stringify(tail),
        invocation_tail: inv ? JSON.stringify(inv.slice(4)) : 'none',
        result_tail: r ? JSON.stringify(r.slice(3)) : 'none',
      };
    }
    return out;
  });
  probe('large_payload', async (c) => {
    const uri = `probe.c.big_${c.uniq()}`;
    await c.callee(uri, (inv, me) => {
      me.send([MSG.YIELD, inv[1], {}, inv[4]]);
    });
    const p = c.mk('caller');
    await p.join();
    const big = 'x'.repeat(1024 * 1024);
    const id = p.id();
    const t = c.env.now();
    p.send([MSG.CALL, id, {}, uri, [big]]);
    const r = await p.reply(MSG.CALL, id, MSG.RESULT, 10000);
    const echoed = (r?.[3] as unknown[] | undefined)?.[0];
    return {
      ok: r?.[0] === MSG.RESULT && typeof echoed === 'string' && echoed.length === big.length,
      ms: c.env.now() - t,
      reply: r ? short(r).slice(0, 80) : 'none',
      closed: p.closed,
    };
  });
  probe('caller_identification', async (c) => {
    const uri = `probe.c.ci_${c.uniq()}`;
    const { p: callee, reg } = await c.callee(
      uri,
      (inv, me) => {
        me.send([MSG.YIELD, inv[1], {}, []]);
      },
      { disclose_caller: true },
    );
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    p.send([MSG.CALL, id, { disclose_me: true }, uri, []]);
    await p.reply(MSG.CALL, id, MSG.RESULT);
    const inv = callee.frames.find(ofType(MSG.INVOCATION)) as Frame | undefined;
    return { register: reg && short(reg), invocation_details: inv?.[3], caller_session: p.session };
  });
  probe('progressive_results', async (c) => {
    const uri = `probe.c.prog_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, (inv, me) => {
      me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
      me.send([MSG.YIELD, inv[1], { progress: true }, ['p2']]);
      me.send([MSG.YIELD, inv[1], {}, ['final']]);
    });
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, { receive_progress: true }, uri, []]);
    await p.wait((m) => m[0] === MSG.RESULT && m[1] === id && details(m, 2)?.['progress'] !== true);
    await c.sleep(100);
    const inv = callee.frames.find(ofType(MSG.INVOCATION)) as Frame | undefined;
    return { invocation_details: inv?.[3], caller_frames: frameList(p.since(i)) };
  });
  probe('progressive_unrequested', async (c) => {
    const uri = `probe.c.progu_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, (inv, me) => {
      me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
      me.send([MSG.YIELD, inv[1], {}, ['final']]);
    });
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, {}, uri, []]);
    await c.sleep(c.WAIT);
    return {
      caller_frames: frameList(p.since(i)),
      callee_frames_after: frameList(
        callee.frames.filter((m) => isFrame(m) && ![MSG.WELCOME, MSG.REGISTERED, MSG.INVOCATION].includes(m[0] as 2)),
      ),
    };
  });
  for (const mode of ['skip', 'kill', 'killnowait'] as const) {
    probe(`cancel_${mode}`, async (c) => {
      const uri = `probe.c.cancel_${mode}_${c.uniq()}`;
      const { p: callee } = await c.callee(uri, () => undefined);
      callee.onMessage = (m) => {
        if (m[0] === MSG.INTERRUPT) {
          c.env.setTimeout(() => {
            callee.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']);
          }, 50);
        }
      };
      const p = c.mk('caller');
      await p.join();
      const id = p.id();
      const i = p.frames.length;
      p.send([MSG.CALL, id, {}, uri, []]);
      await callee.wait((m) => m[0] === MSG.INVOCATION);
      p.send([MSG.CANCEL, id, { mode }]);
      await c.sleep(c.WAIT);
      return {
        caller_frames: frameList(p.since(i)),
        callee_frames: frameList(callee.frames.filter(ofType(MSG.INVOCATION, MSG.INTERRUPT, MSG.ERROR))),
      };
    });
  }
  probe('cancel_callee_no_cancel_feature', async (c) => {
    const uri = `probe.c.cancelnf_${c.uniq()}`;
    const callee = c.mk('callee');
    await callee.open();
    callee.send([MSG.HELLO, c.realm, { roles: { callee: {} } }]);
    await callee.wait((m) => m[0] === MSG.WELCOME, 3000);
    await callee.register(uri);
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, {}, uri, []]);
    await callee.wait((m) => m[0] === MSG.INVOCATION);
    p.send([MSG.CANCEL, id, { mode: 'kill' }]);
    await c.sleep(c.WAIT);
    return {
      caller_frames: frameList(p.since(i)),
      callee_frames: frameList(callee.frames.filter(ofType(MSG.INVOCATION, MSG.INTERRUPT))),
    };
  });
  probe('cancel_progressive_kill', async (c) => {
    const uri = `probe.c.cancelp_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, (inv, me) => {
      me.send([MSG.YIELD, inv[1], { progress: true }, ['p1']]);
    });
    callee.onMessage = (m) => {
      if (m[0] === MSG.INVOCATION) callee.send([MSG.YIELD, m[1], { progress: true }, ['p1']]);
      if (m[0] === MSG.INTERRUPT) {
        c.env.setTimeout(() => {
          callee.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'wamp.error.canceled']);
        }, 50);
      }
    };
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, { receive_progress: true }, uri, []]);
    await p.wait((m) => m[0] === MSG.RESULT && m[1] === id);
    p.send([MSG.CANCEL, id, { mode: 'kill' }]);
    await c.sleep(c.WAIT);
    return {
      caller_frames: frameList(p.since(i)),
      callee_frames: frameList(callee.frames.filter(ofType(MSG.INVOCATION, MSG.INTERRUPT))),
    };
  });
  probe('cancel_unknown', async (c) => {
    const p = c.mk('a');
    await p.join();
    const i = p.frames.length;
    p.send([MSG.CANCEL, 424242, {}]);
    await c.sleep(c.WAIT);
    return { frames: frameList(p.since(i)), closed: p.closed };
  });
  probe('call_timeout', async (c) => {
    const uri = `probe.c.timeout_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, () => undefined);
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    const t = c.env.now();
    p.send([MSG.CALL, id, { timeout: 300 }, uri, []]);
    const r = await p.wait((m) => ((m[0] === MSG.ERROR || m[0] === MSG.RESULT) && m[2] === id) || m[1] === id, 2000);
    return {
      caller_reply: r ? short(r) : 'none within 2s',
      after_ms: r ? c.env.now() - t : null,
      invocation_details: (callee.frames.find(ofType(MSG.INVOCATION)) as Frame | undefined)?.[3],
      callee_interrupt: frameList(callee.frames.filter(ofType(MSG.INTERRUPT))),
      caller_frames: frameList(p.since(i)),
    };
  });
  probe('callee_leaves', async (c) => {
    const uri = `probe.c.leave_${c.uniq()}`;
    await c.callee(uri, (_inv, me) => {
      c.env.setTimeout(() => {
        me.ws?.close(1000);
      }, 100);
    });
    const p = c.mk('caller');
    await p.join();
    const id = p.id();
    const i = p.frames.length;
    p.send([MSG.CALL, id, {}, uri, []]);
    const r = await p.wait((m) => m[2] === id || m[1] === id, 2500);
    return { caller_reply: r ? short(r) : 'none within 2.5s', caller_frames: frameList(p.since(i)) };
  });
  probe('caller_leaves', async (c) => {
    const uri = `probe.c.cleave_${c.uniq()}`;
    const { p: callee } = await c.callee(uri, () => undefined);
    const p = c.mk('caller');
    await p.join();
    p.send([MSG.CALL, p.id(), {}, uri, []]);
    await callee.wait((m) => m[0] === MSG.INVOCATION);
    p.ws?.close(1000);
    await c.sleep(c.WAIT);
    return { callee_frames: frameList(callee.frames.filter(ofType(MSG.INVOCATION, MSG.INTERRUPT))) };
  });
  probe('registration_duplicate', async (c) => {
    const uri = `probe.c.dupreg_${c.uniq()}`;
    const a = c.mk('a');
    const b = c.mk('b');
    await a.join();
    await b.join();
    const r1 = await a.register(uri);
    const r2 = await b.register(uri);
    return { first: r1 && short(r1), second: r2 && short(r2) };
  });
  for (const policy of ['roundrobin', 'random', 'first', 'last'] as const) {
    probe(`shared_${policy}`, async (c) => {
      const uri = `probe.c.shared_${policy}_${c.uniq()}`;
      const counts = { a: 0, b: 0 };
      const mkC = async (label: 'a' | 'b'): Promise<Frame | null> => {
        const p = c.mk(label);
        await p.join();
        p.onMessage = (m) => {
          if (m[0] === MSG.INVOCATION) {
            counts[label]++;
            p.send([MSG.YIELD, m[1], {}, [label]]);
          }
        };
        return p.register(uri, { invoke: policy });
      };
      const ra = await mkC('a');
      const rb = await mkC('b');
      const caller = c.mk('caller');
      await caller.join();
      const results: unknown[] = [];
      for (let k = 0; k < 6; k++) {
        const id = caller.id();
        caller.send([MSG.CALL, id, {}, uri, []]);
        const r = await caller.reply(MSG.CALL, id, MSG.RESULT);
        results.push(r ? (r[0] === MSG.RESULT ? (r[3] as unknown[] | undefined)?.[0] : short(r)) : 'none');
      }
      return { register_a: ra && short(ra), register_b: rb && short(rb), results, counts };
    });
  }
  probe('shared_mismatch', async (c) => {
    const uri = `probe.c.sharedmm_${c.uniq()}`;
    const a = c.mk('a');
    const b = c.mk('b');
    await a.join();
    await b.join();
    const r1 = await a.register(uri, { invoke: 'roundrobin' });
    const r2 = await b.register(uri, { invoke: 'random' });
    return { first: r1 && short(r1), second: r2 && short(r2) };
  });
  for (const [match, regUri, callUri] of [
    ['prefix', 'probe.c.rp', 'probe.c.rp.x.y'],
    ['wildcard', 'probe..rw', 'probe.c.rw'],
  ] as const) {
    probe(`register_${match}`, async (c) => {
      const suffix = c.uniq();
      const regU = regUri.replace('probe', `probe_${suffix}`);
      const callU = callUri.replace('probe', `probe_${suffix}`);
      const { p: callee, reg } = await c.callee(
        regU,
        (inv, me) => {
          me.send([MSG.YIELD, inv[1], {}, ['ok']]);
        },
        { match },
      );
      const p = c.mk('caller');
      await p.join();
      const id = p.id();
      p.send([MSG.CALL, id, {}, callU, []]);
      const r = await p.reply(MSG.CALL, id, MSG.RESULT);
      return {
        register: reg ? short(reg) : 'none',
        call: r ? short(r) : 'none',
        invocation_details: (callee.frames.find(ofType(MSG.INVOCATION)) as Frame | undefined)?.[3],
      };
    });
  }
  probe('meta_api', async (c) => {
    const p = c.mk('a');
    await p.join();
    const out: Json = {};
    for (const proc of [
      'wamp.session.count',
      'wamp.session.list',
      'wamp.registration.list',
      'wamp.subscription.list',
    ]) {
      const id = p.id();
      p.send([MSG.CALL, id, {}, proc, []]);
      const r = await p.reply(MSG.CALL, id, MSG.RESULT);
      out[proc] = r ? short(r) : 'none';
    }
    return out;
  });
  probe('pubsub_basics', async (c) => {
    const topic = `probe.c.pub_${c.uniq()}`;
    const p = c.mk('pubsub');
    await p.join();
    const s = await p.subscribe(topic);
    const sub = c.mk('other');
    await sub.join();
    await sub.subscribe(topic);
    const i = p.frames.length;
    const j = sub.frames.length;
    p.send([MSG.PUBLISH, p.id(), {}, topic, ['default']]);
    p.send([MSG.PUBLISH, p.id(), { exclude_me: false }, topic, ['exclude_me_false']]);
    p.send([MSG.PUBLISH, p.id(), { disclose_me: true }, topic, ['disclose_me']]);
    await c.sleep(c.WAIT);
    return {
      subscribed: s && short(s),
      publisher_frames: frameList(p.since(i)),
      other_subscriber_frames: frameList(sub.since(j)),
    };
  });
  probe('pubsub_blackwhite', async (c) => {
    const topic = `probe.c.bw_${c.uniq()}`;
    const a = c.mk('A');
    const b = c.mk('B');
    const pub = c.mk('pub');
    await a.join();
    await b.join();
    await pub.join();
    await a.subscribe(topic);
    await b.subscribe(topic);
    const ia = a.frames.length;
    const ib = b.frames.length;
    pub.send([MSG.PUBLISH, pub.id(), { eligible: [b.session] }, topic, ['eligible_B']]);
    pub.send([MSG.PUBLISH, pub.id(), { exclude: [b.session] }, topic, ['exclude_B']]);
    await c.sleep(c.WAIT);
    const got = (p: CPeer, i: number): unknown[] =>
      p
        .since(i)
        .filter(ofType(MSG.EVENT))
        .map((m) => ((m as Frame)[4] as unknown[] | undefined)?.[0]);
    return { A_got: got(a, ia), B_got: got(b, ib) };
  });
  probe('meta_events', async (c) => {
    const topics = [
      'wamp.session.on_join',
      'wamp.session.on_leave',
      'wamp.metaevent.session.on_join',
      'wamp.metaevent.session.on_leave',
    ];
    const p = c.mk('watcher');
    await p.join();
    const subs: Json = {};
    for (const t of topics) {
      const s = await p.subscribe(t);
      subs[t] = s ? nameOf(s[0]) + (s[0] === MSG.ERROR ? ` ${String(s[4])}` : '') : 'none';
    }
    const i = p.frames.length;
    const q = c.mk('joiner');
    await q.join();
    await c.sleep(200);
    q.close();
    await c.sleep(c.WAIT);
    const bySub: Json = Object.fromEntries(
      p.frames.filter(ofType(MSG.SUBSCRIBED)).map((m) => [String((m as Frame)[2]), (m as Frame)[1]]),
    );
    return {
      subscribe_replies: subs,
      events: frameList(p.since(i).filter(ofType(MSG.EVENT))),
      joiner_session: q.session,
      sub_ids: bySub,
    };
  });
  probe('subscribe_duplicate', async (c) => {
    const topic = `probe.c.dupsub_${c.uniq()}`;
    const p = c.mk('a');
    await p.join();
    const s1 = await p.subscribe(topic);
    const s2 = await p.subscribe(topic);
    const pub = c.mk('pub');
    await pub.join();
    const i = p.frames.length;
    pub.send([MSG.PUBLISH, pub.id(), {}, topic, ['x']]);
    await c.sleep(c.WAIT);
    return { first: s1 && short(s1), second: s2 && short(s2), events: frameList(p.since(i)) };
  });
  probe('subscribe_two_sessions_ids', async (c) => {
    const topic = `probe.c.twosub_${c.uniq()}`;
    const a = c.mk('a');
    const b = c.mk('b');
    await a.join();
    await b.join();
    const s1 = await a.subscribe(topic);
    const s2 = await b.subscribe(topic);
    return { a: s1 && short(s1), b: s2 && short(s2) };
  });
  probe('unsubscribe_unknown', async (c) => {
    const p = c.mk('a');
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
  ] as const) {
    probe(name, async (c) => {
      const pre = `probe_${c.uniq()}`;
      const fix = (t: string): string => t.replace(/^probe/, pre);
      const p = c.mk('sub');
      await p.join();
      const s = await p.subscribe(fix(subTopic), opts);
      const pub = c.mk('pub');
      await pub.join();
      const i = p.frames.length;
      const acks: string[] = [];
      for (const t of pubTopics) {
        const id = pub.id();
        pub.send([MSG.PUBLISH, id, { acknowledge: true }, fix(t), [t]]);
        const r = await pub.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
        acks.push(r ? nameOf(r[0]) + (r[0] === MSG.ERROR ? ` ${String(r[4])}` : '') : 'none');
      }
      await c.sleep(300);
      const evs = p.since(i).filter(ofType(MSG.EVENT)) as Frame[];
      return {
        subscribed: s ? short(s) : 'none (no reply!)',
        publish_acks: acks,
        delivered: evs.map((e) => (e[4] as unknown[] | undefined)?.[0]),
        event_details: evs.map((e) => e[3]),
      };
    });
  }
  for (const [name, pubOpts, subOpts] of [
    ['retained_spec', { retain: true, acknowledge: true }, { get_retained: true }],
    ['retained_fox', { retain: true, acknowledge: true }, { retained: true }],
  ] as const) {
    probe(name, async (c) => {
      const topic = `probe.c.ret_${c.uniq()}`;
      const pub = c.mk('pub');
      await pub.join();
      const id = pub.id();
      pub.send([MSG.PUBLISH, id, pubOpts, topic, ['retained-value']]);
      const ack = await pub.reply(MSG.PUBLISH, id, MSG.PUBLISHED);
      await c.sleep(100);
      const p = c.mk('late');
      await p.join();
      const i = p.frames.length;
      const s = await p.subscribe(topic, subOpts);
      await c.sleep(300);
      pub.send([MSG.PUBLISH, pub.id(), {}, topic, ['live-value']]);
      await c.sleep(500);
      return {
        publish_ack: ack && short(ack),
        subscribed: s && short(s),
        late_subscriber_frames: frameList(p.since(i)),
      };
    });
  }
  probe('auth_during_challenge', async (c) => {
    const p = c.mk('a');
    await p.open();
    p.send([MSG.HELLO, c.realm, { roles: C_ROLES, authmethods: ['wampcra'], authid: 'joe' }]);
    const ch = await p.wait((m) => m[0] === MSG.CHALLENGE || m[0] === MSG.WELCOME || m[0] === MSG.ABORT);
    const i = p.frames.length;
    p.send([MSG.PUBLISH, 77, { acknowledge: true }, `probe.c.unauth_${c.uniq()}`, []]);
    p.send([MSG.CALL, 78, {}, 'wamp.session.count', []]);
    await c.sleep(c.WAIT);
    return { first_reply: ch ? short(ch) : 'none', after: frameList(p.since(i)), closed: p.closed };
  });
  probe('auth_two_methods', async (c) => {
    const p = c.mk('a');
    await p.open();
    p.send([MSG.HELLO, c.realm, { roles: C_ROLES, authmethods: ['ticket', 'wampcra'], authid: 'joe' }]);
    await c.sleep(c.WAIT);
    return { frames: frameList(p.frames), closed: p.closed };
  });
  return list;
}

/** The names of probe-c's probes, in its order. */
export const PROBE_C_NAMES: readonly string[] = probeC().map(([name]) => name);

/** Run probe-c.mjs's probes (all, or `only`) as the script did: one after the other, the peers of a probe closed after
 *  it, 100 ms between probes. */
export async function runProbeC(env: ProbeEnv, options: { readonly only?: readonly string[] } = {}): Promise<Json> {
  const report: Json = {};
  const WAIT = 1500;
  for (const [name, fn] of probeC()) {
    if (options.only !== undefined && !options.only.includes(name)) continue;
    const peers: CPeer[] = [];
    const ctx: CContext = {
      env,
      realm: env.realm,
      WAIT,
      mk: () => {
        const p = new CPeer(env, env.realm);
        peers.push(p);
        return p;
      },
      callee: async (uri, fn, regOpts = {}) => {
        const p = new CPeer(env, env.realm);
        peers.push(p);
        await p.join();
        p.onMessage = (m) => {
          if (m[0] === MSG.INVOCATION) fn(m, p);
        };
        return { p, reg: await p.register(uri, regOpts) };
      },
      uniq: () => uniqueName(env),
      sleep: (ms) => env.sleep(ms),
    };
    let result: Json;
    try {
      result = await fn(ctx);
    } catch (e) {
      result = { error: (e as Error).message };
    }
    for (const p of peers.splice(0)) p.close();
    report[name] = result;
    await env.sleep(100);
  }
  return report;
}

// =====================================================================================================================
// quirks-b.mjs
// =====================================================================================================================

const B_HELLO = {
  agent: 'thruway.js-v3-quirks-b',
  roles: {
    caller: { features: { progressive_call_results: true, call_canceling: true, call_timeout: true } },
    callee: { features: { progressive_call_results: true, call_canceling: true, call_timeout: true } },
    publisher: { features: { publisher_exclusion: true } },
    subscriber: { features: { pattern_based_subscription: true } },
  },
};

/** quirks-b's `brief()`. */
function brief(m: unknown): string {
  if (!isFrame(m)) return String(m);
  const n = NAME[m[0] as number] ?? String(m[0]);
  if (m[0] === MSG.ABORT || m[0] === MSG.GOODBYE) return `${n}(${String(m[2])})`;
  if (m[0] === MSG.ERROR) return `ERROR(${NAME[m[1] as number] ?? String(m[1])},${String(m[4])})`;
  return n;
}

/** quirks-b's `Conn`. */
class BConn {
  ws: WebSocketLike | undefined;
  msgs: unknown[] = [];
  readonly all: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  session: unknown;
  sendError: string | undefined;

  constructor(private readonly env: ProbeEnv) {}

  async open(): Promise<void> {
    const ws = new this.env.WebSocket(this.env.url, ['wamp.2.json']);
    this.ws = ws;
    let opened = ws.readyState === 1;
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
    ws.addEventListener('message', (e) => {
      let m: unknown;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        m = `unparseable:${String(e.data).slice(0, 80)}`;
      }
      this.msgs.push(m);
      this.all.push(m);
    });
    await poll(this.env, 5000, () => (opened || this.closed !== null ? true : undefined), false);
  }

  sendRaw(s: string | Uint8Array): void {
    try {
      this.ws?.send(s as string);
    } catch (e) {
      this.sendError = (e as Error).message;
    }
  }

  send(m: unknown): void {
    this.sendRaw(JSON.stringify(m));
  }

  wait(pred: (m: Frame) => boolean, ms = 3000): Promise<Frame | null> {
    return poll(
      this.env,
      ms,
      () => {
        const i = this.msgs.findIndex((m) => isFrame(m) && pred(m));
        if (i >= 0) return this.msgs.splice(i, 1)[0] as Frame;
        return this.closed === null ? undefined : null;
      },
      null,
    );
  }

  async settle(ms = 600): Promise<void> {
    await poll(this.env, ms, () => (this.closed === null ? undefined : true), false);
  }

  drain(): unknown[] {
    return this.msgs.splice(0);
  }

  async join(): Promise<Frame> {
    await this.open();
    this.send([MSG.HELLO, this.env.realm, B_HELLO]);
    const w = await this.wait((m) => m[0] === MSG.WELCOME || m[0] === MSG.ABORT);
    if (w?.[0] !== MSG.WELCOME) throw new Error(`join failed: ${w ? brief(w) : 'no reply'}`);
    this.session = w[1];
    return w;
  }

  outcome(): string {
    this.drain();
    const msgs = this.all.filter((m) => !(isFrame(m) && m[0] === MSG.WELCOME)).map(brief);
    const parts: string[] = [];
    if (msgs.length > 0) parts.push(msgs.join(' '));
    parts.push(
      this.closed ? `closed(${String(this.closed.code)}${this.closed.reason ? `:${this.closed.reason}` : ''})` : 'open',
    );
    if (this.sendError !== undefined) parts.push(`sendError(${this.sendError})`);
    return parts.join(' ');
  }

  end(): void {
    try {
      if (!this.closed) this.ws?.close(1000);
    } catch {
      // as the script
    }
  }
}

type BScenario = (env: ProbeEnv, sleep: (ms: number) => Promise<void>) => Promise<string>;

function quirksB(): [string, BScenario][] {
  const T = MSG;
  const newConn = (env: ProbeEnv): BConn => new BConn(env);
  const scenarios: [string, BScenario][] = [
    [
      'no-such-realm',
      async (env) => {
        const c = newConn(env);
        await c.open();
        c.send([T.HELLO, 'com.thruway.no.such.realm', B_HELLO]);
        await c.wait((m) => m[0] === T.ABORT);
        await c.settle();
        return c.outcome();
      },
    ],
    [
      'hello-empty-details',
      async (env) => {
        const c = newConn(env);
        await c.open();
        c.send([T.HELLO, env.realm, {}]);
        await c.wait((m) => m[0] === T.WELCOME || m[0] === T.ABORT);
        await c.settle(300);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'call-before-hello',
      async (env) => {
        const c = newConn(env);
        await c.open();
        c.send([T.CALL, 1, {}, 'com.thruway.x', []]);
        await c.settle(1500);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
  ];
  const inSession = (name: string, act: (c: BConn, env: ProbeEnv) => void): void => {
    scenarios.push([
      name,
      async (env) => {
        const c = newConn(env);
        await c.join();
        act(c, env);
        await c.settle(1500);
        const r = c.outcome();
        c.end();
        return r;
      },
    ]);
  };
  inSession('double-hello', (c, env) => {
    c.send([T.HELLO, env.realm, B_HELLO]);
  });
  inSession('invalid-json', (c) => {
    c.sendRaw('{not json');
  });
  inSession('unknown-message-type', (c) => {
    c.send([999, 1, {}]);
  });
  inSession('binary-frame-on-json', (c) => {
    c.sendRaw(new TextEncoder().encode(JSON.stringify([T.CALL, 1, {}, 'x.y', []])));
  });
  for (const [name, id] of [
    ['request-id-0', 0],
    ['request-id-2^53', 2 ** 53],
  ] as const) {
    scenarios.push([
      name,
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.CALL, id, {}, 'com.thruway.nope', []]);
        await c.wait((m) => m[0] === T.ERROR);
        await c.settle(800);
        const r = c.outcome();
        c.end();
        return r;
      },
    ]);
  }
  scenarios.push(
    [
      'request-id-non-sequential',
      async (env) => {
        const c = newConn(env);
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
    ],
    [
      'request-id-reuse-inflight',
      async (env, sleep) => {
        const c = newConn(env);
        await c.join();
        c.send([T.REGISTER, 1, {}, 'com.thruway.q.slow']);
        const reg = await c.wait((m) => m[0] === T.REGISTERED);
        c.send([T.CALL, 2, {}, 'com.thruway.q.slow', ['a']]);
        c.send([T.CALL, 2, {}, 'com.thruway.q.slow', ['b']]);
        await sleep(500);
        const invs = c.msgs.filter((m) => isFrame(m) && m[0] === T.INVOCATION) as Frame[];
        for (const inv of invs) c.send([T.YIELD, inv[1], {}, inv[4]]);
        await c.settle(800);
        const r = `${String(invs.length)} INVOCATION(s); then ${c.outcome()}`;
        c.end();
        return reg ? r : `register failed; ${r}`;
      },
    ],
    [
      'invalid-uri',
      async (env) => {
        const c = newConn(env);
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
    ],
    [
      'subscribe-same-topic-twice',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.SUBSCRIBE, 1, {}, 'com.thruway.q.dup']);
        const a = await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
        c.send([T.SUBSCRIBE, 2, {}, 'com.thruway.q.dup']);
        const b = await c.wait((m) => m[0] === T.SUBSCRIBED || m[0] === T.ERROR);
        const same =
          a?.[0] === T.SUBSCRIBED && b?.[0] === T.SUBSCRIBED
            ? a[2] === b[2]
              ? 'same subscription id'
              : 'DIFFERENT subscription ids'
            : `${String(a && brief(a))} / ${String(b && brief(b))}`;
        await c.settle(300);
        const r = `${same}; ${c.outcome()}`;
        c.end();
        return r;
      },
    ],
    [
      'unsubscribe-unknown',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.UNSUBSCRIBE, 1, 123456789]);
        await c.wait((m) => m[0] === T.ERROR || m[0] === T.UNSUBSCRIBED);
        await c.settle(300);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'yield-unknown-invocation',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.YIELD, 987654321, {}, []]);
        await c.settle(1200);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'call-timeout-option',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.REGISTER, 1, {}, 'com.thruway.q.never']);
        await c.wait((m) => m[0] === T.REGISTERED);
        const t0 = env.now();
        c.send([T.CALL, 2, { timeout: 500 }, 'com.thruway.q.never', []]);
        const e = await c.wait((m) => (m[0] === T.ERROR || m[0] === T.RESULT) && m[2] === 2, 3000);
        const took = env.now() - t0;
        await c.settle(300);
        const r = `${e ? `${brief(e)} after ${String(took)}ms` : 'no reply in 3s'}; rest: ${c.outcome()}`;
        c.end();
        return r;
      },
    ],
    [
      'cancel-kill',
      async (env) => {
        const c = newConn(env);
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
    ],
    [
      'cancel-skip',
      async (env) => {
        const c = newConn(env);
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
    ],
    [
      'callee-error-uri',
      async (env) => {
        const c = newConn(env);
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
    ],
    [
      'callee-leaves-mid-call',
      async (env) => {
        const a = newConn(env);
        const b = newConn(env);
        await a.join();
        await b.join();
        b.send([T.REGISTER, 1, {}, 'com.thruway.q.leaver']);
        await b.wait((m) => m[0] === T.REGISTERED);
        a.send([T.CALL, 1, {}, 'com.thruway.q.leaver', []]);
        await b.wait((m) => m[0] === T.INVOCATION);
        b.ws?.close(1000);
        const e = await a.wait((m) => m[0] === T.ERROR && m[2] === 1, 3000);
        await a.settle(300);
        const r = `caller got ${e ? brief(e) : 'nothing in 3s'}; ${a.outcome()}`;
        a.end();
        return r;
      },
    ],
    [
      'publish-no-subscribers-ack',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.q.nobody', []]);
        await c.wait((m) => m[0] === T.PUBLISHED || m[0] === T.ERROR);
        await c.settle(300);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'publish-exclude-me-default',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.SUBSCRIBE, 1, {}, 'com.thruway.q.self']);
        await c.wait((m) => m[0] === T.SUBSCRIBED);
        c.send([T.PUBLISH, 2, { acknowledge: true }, 'com.thruway.q.self', []]);
        await c.wait((m) => m[0] === T.PUBLISHED);
        await c.settle(400);
        const ev = c.msgs.filter((m) => isFrame(m) && m[0] === T.EVENT).length;
        const r = `${String(ev)} self EVENT(s) (spec: 0); ${c.outcome()}`;
        c.end();
        return r;
      },
    ],
    [
      'publish-eligible-exclude',
      async (env, sleep) => {
        const a = newConn(env);
        const b = newConn(env);
        const d = newConn(env);
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
        const evs = (s: BConn): unknown[] =>
          s.msgs
            .filter((m) => isFrame(m) && m[0] === T.EVENT)
            .map((m) => ((m as Frame)[4] as unknown[] | undefined)?.[0]);
        const evB = evs(b);
        const evD = evs(d);
        for (const s of [a, b, d]) s.end();
        return `B got ${JSON.stringify(evB)} (expect ["eligible-b"]), D got ${JSON.stringify(evD)} (expect ["exclude-b"])`;
      },
    ],
    [
      'pattern-subscription',
      async (env, sleep) => {
        const a = newConn(env);
        const b = newConn(env);
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
        const ev = b.msgs
          .filter((m) => isFrame(m) && m[0] === T.EVENT)
          .map((m) => {
            const f = m as Frame;
            const topic = details(f, 3)?.['topic'];
            return `${String((f[4] as unknown[] | undefined)?.[0])}:${typeof topic === 'string' ? topic : 'no-topic-detail'}`;
          });
        a.end();
        b.end();
        return `prefix:${String(s1 && brief(s1))} wildcard:${String(s2 && brief(s2))} events:${JSON.stringify(ev)}`;
      },
    ],
    [
      'shared-registration-roundrobin',
      async (env) => {
        const a = newConn(env);
        const b = newConn(env);
        const d = newConn(env);
        await a.join();
        await b.join();
        await d.join();
        const res: (Frame | null)[] = [];
        for (const s of [b, d]) {
          s.send([T.REGISTER, 1, { invoke: 'roundrobin' }, 'com.thruway.q.rr']);
          res.push(await s.wait((m) => m[0] === T.REGISTERED || m[0] === T.ERROR));
        }
        const who: string[] = [];
        const answer = (s: BConn, tag: string): void => {
          for (const m of s.msgs.splice(0)) {
            if (isFrame(m) && m[0] === T.INVOCATION) {
              who.push(tag);
              s.send([T.YIELD, m[1], {}, [tag]]);
            }
          }
        };
        for (let i = 1; i <= 4; i++) {
          a.send([T.CALL, i, {}, 'com.thruway.q.rr', []]);
          await poll(
            env,
            2000,
            () => {
              answer(b, 'c1');
              answer(d, 'c2');
              const k = a.msgs.findIndex(
                (m) => isFrame(m) && (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined,
              );
              return k >= 0 ? a.msgs.splice(k, 1) : undefined;
            },
            [],
          );
        }
        for (const s of [a, b, d]) s.end();
        return `register: ${res.map((m) => (m ? brief(m) : String(m))).join(',')}; invocations: ${who.join(',')}`;
      },
    ],
    [
      'progressive-call-results',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.REGISTER, 1, {}, 'com.thruway.q.prog']);
        await c.wait((m) => m[0] === T.REGISTERED);
        c.send([T.CALL, 2, { receive_progress: true }, 'com.thruway.q.prog', []]);
        const inv = await c.wait((m) => m[0] === T.INVOCATION);
        const rp = details(inv, 3)?.['receive_progress'] === true;
        if (inv) {
          c.send([T.YIELD, inv[1], { progress: true }, ['p1']]);
          c.send([T.YIELD, inv[1], { progress: true }, ['p2']]);
          c.send([T.YIELD, inv[1], {}, ['done']]);
        }
        await c.settle(800);
        const res = c.msgs
          .filter((m) => isFrame(m) && m[0] === T.RESULT)
          .map((m) => {
            const f = m as Frame;
            return `${String((f[3] as unknown[] | undefined)?.[0])}${details(f, 2)?.['progress'] === true ? '(progress)' : ''}`;
          });
        const r = `INVOCATION.receive_progress=${String(rp)}; RESULTs: ${res.join(',')}; ${c.outcome()}`;
        c.end();
        return r;
      },
    ],
    [
      'payload-1MiB',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.REGISTER, 1, {}, 'com.thruway.q.echo']);
        await c.wait((m) => m[0] === T.REGISTERED);
        const big = 'x'.repeat(1024 * 1024);
        c.send([T.CALL, 2, {}, 'com.thruway.q.echo', [big]]);
        const inv = await c.wait((m) => m[0] === T.INVOCATION, 5000);
        if (inv) c.send([T.YIELD, inv[1], {}, inv[4]]);
        const res = await c.wait((m) => (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined, 5000);
        await c.settle(300);
        const len = (res?.[3] as string[] | undefined)?.[0]?.length;
        const r = `${res ? (res[0] === T.RESULT ? `RESULT len=${String(len)}` : brief(res)) : 'no result'}; ${c.outcome()}`;
        c.end();
        return r;
      },
    ],
    [
      'payload-20MiB',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.PUBLISH, 1, { acknowledge: true }, 'com.thruway.q.big', ['y'.repeat(20 * 1024 * 1024)]]);
        await c.wait((m) => m[0] === T.PUBLISHED || m[0] === T.ERROR, 8000);
        await c.settle(1000);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'router-goodbye-via-kill',
      async (env) => {
        const a = newConn(env);
        const b = newConn(env);
        await a.join();
        await b.join();
        a.send([T.CALL, 1, {}, 'wamp.session.kill', [b.session], { reason: 'com.thruway.test.kill', message: 'bye' }]);
        const r1 = await a.wait((m) => (m[0] === T.RESULT || m[0] === T.ERROR) && m[1] !== undefined, 3000);
        const g = await b.wait((m) => m[0] === T.GOODBYE || m[0] === T.ABORT, 3000);
        let reply = '';
        if (g?.[0] === T.GOODBYE) {
          b.send([T.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
          reply = ' (we replied GOODBYE)';
        }
        await b.settle(1500);
        const r = `kill call: ${r1 ? brief(r1) : 'no reply'}; victim got ${g ? JSON.stringify(g) : 'nothing'}${reply}; victim: ${b.outcome()}`;
        a.end();
        b.end();
        return r;
      },
    ],
    [
      'goodbye-close-code',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.GOODBYE, {}, 'wamp.close.system_shutdown']);
        await c.wait((m) => m[0] === T.GOODBYE);
        await c.settle(1500);
        return c.outcome();
      },
    ],
    [
      'message-after-goodbye',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
        await c.wait((m) => m[0] === T.GOODBYE, 1500);
        c.send([T.CALL, 9, {}, 'com.thruway.q.after', []]);
        await c.settle(1000);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
    [
      'rejoin-after-goodbye-same-socket',
      async (env) => {
        const c = newConn(env);
        await c.join();
        c.send([T.GOODBYE, {}, 'wamp.close.close_realm']);
        await c.wait((m) => m[0] === T.GOODBYE, 1500);
        if (c.closed) return `router closed socket after GOODBYE (${String(c.closed.code)}); cannot re-HELLO`;
        c.send([T.HELLO, env.realm, B_HELLO]);
        await c.wait((m) => m[0] === T.WELCOME || m[0] === T.ABORT, 2000);
        await c.settle(300);
        const r = c.outcome();
        c.end();
        return r;
      },
    ],
  );
  return scenarios;
}

/** The names of quirks-b's scenarios, in its order. */
export const QUIRKS_B_NAMES: readonly string[] = quirksB().map(([name]) => name);

/** Run quirks-b.mjs's scenarios (all, or `only`), one after the other. */
export async function runQuirksB(
  env: ProbeEnv,
  options: { readonly only?: readonly string[] } = {},
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const [name, fn] of quirksB()) {
    if (options.only !== undefined && !options.only.includes(name)) continue;
    try {
      results[name] = await fn(env, (ms) => env.sleep(ms));
    } catch (e) {
      results[name] = `EXCEPTION ${(e as Error).message}`;
    }
  }
  return results;
}

/** quirks-b's text output: `name  NNms  result` per line ⇒ name → result. */
export function parseQuirksB(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+\d+ms {2}(.*)$/.exec(line);
    if (m !== null) out[m[1]!] = m[2]!;
  }
  return out;
}

// =====================================================================================================================
// crossbar/probe.mjs (the groups that need neither its auth paths nor its meta API)
// =====================================================================================================================

const X_ROLES = {
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

/** crossbar/probe.mjs's `short()` and `desc()`. */
function xshort(m: unknown): string {
  const s = JSON.stringify(m);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
function desc(m: Frame | null): string {
  return m === null ? 'null (timeout or socket closed)' : `${nameOf(m[0])} ${xshort(m)}`;
}

/** crossbar/probe.mjs's `Peer`. */
class XPeer {
  readonly ws: WebSocketLike;
  inbox: Frame[] = [];
  closeInfo: { code: number; reason: string; wasClean: boolean } | null = null;
  onInvocation: ((m: Frame) => void) | undefined;
  session: unknown;
  private reqId = 1;
  private opened: boolean;

  constructor(
    private readonly env: ProbeEnv,
    protocols: string[] = ['wamp.2.json'],
  ) {
    this.ws = new env.WebSocket(env.url, protocols);
    this.opened = this.ws.readyState === 1;
    this.ws.addEventListener('open', () => {
      this.opened = true;
    });
    this.ws.addEventListener('close', (e) => {
      this.closeInfo = { code: e.code, reason: e.reason, wasClean: e.wasClean ?? false };
    });
    this.ws.addEventListener('message', (e) => {
      let m: Frame;
      if (typeof e.data !== 'string') {
        m = ['<binary>'];
      } else {
        try {
          const v: unknown = JSON.parse(e.data);
          m = isFrame(v) ? v : ['<unparseable>', e.data];
        } catch {
          m = ['<unparseable>', e.data];
        }
      }
      if (m[0] === MSG.INVOCATION && this.onInvocation !== undefined) {
        this.onInvocation(m);
        return;
      }
      this.inbox.push(m);
    });
  }

  /** True once open; false when it closed first. */
  open(): Promise<boolean> {
    return poll(this.env, 5000, () => (this.opened ? true : this.closeInfo === null ? undefined : false), false);
  }

  id(): number {
    return this.reqId++;
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  sendRaw(x: string | Uint8Array): void {
    this.ws.send(x as string);
  }

  next(pred: (m: Frame) => boolean, timeout = 3000): Promise<Frame | null> {
    return poll(
      this.env,
      timeout,
      () => {
        const i = this.inbox.findIndex(pred);
        if (i >= 0) return this.inbox.splice(i, 1)[0]!;
        return this.closeInfo === null ? undefined : null;
      },
      null,
    );
  }

  async collect(pred: (m: Frame) => boolean, ms: number): Promise<Frame[]> {
    await this.env.sleep(ms);
    const out = this.inbox.filter(pred);
    this.inbox = this.inbox.filter((m) => !pred(m));
    return out;
  }

  /** The close info once the socket closed within `ms`, else null. */
  closed(ms: number): Promise<{ code: number; reason: string } | null> {
    return poll(this.env, ms, () => this.closeInfo ?? undefined, null);
  }

  async hello(realm: string, more: Json = {}): Promise<Frame | null> {
    await this.open();
    this.send([MSG.HELLO, realm, { roles: X_ROLES, ...more }]);
    const m = await this.next((x) => x[0] === MSG.WELCOME || x[0] === MSG.ABORT || x[0] === MSG.CHALLENGE);
    if (m?.[0] === MSG.WELCOME) this.session = m[1];
    return m;
  }

  register(uri: string, options: Json = {}): Promise<Frame | null> {
    const r = this.id();
    this.send([MSG.REGISTER, r, options, uri]);
    return this.next(
      (x) =>
        (x[0] === MSG.REGISTERED || (x[0] === MSG.ERROR && x[1] === MSG.REGISTER)) &&
        x[x[0] === MSG.ERROR ? 2 : 1] === r,
    );
  }

  subscribe(uri: string, options: Json = {}): Promise<Frame | null> {
    const r = this.id();
    this.send([MSG.SUBSCRIBE, r, options, uri]);
    return this.next(
      (x) =>
        (x[0] === MSG.SUBSCRIBED || (x[0] === MSG.ERROR && x[1] === MSG.SUBSCRIBE)) &&
        x[x[0] === MSG.ERROR ? 2 : 1] === r,
    );
  }

  callNoWait(uri: string, args?: unknown[], kwargs?: Json, options: Json = {}): number {
    const r = this.id();
    const m: unknown[] = [MSG.CALL, r, options, uri];
    if (args !== undefined || kwargs !== undefined) m.push(args ?? []);
    if (kwargs !== undefined) m.push(kwargs);
    this.send(m);
    return r;
  }

  callResult(r: number, timeout = 3000): Promise<Frame | null> {
    return this.next(
      (x) => (x[0] === MSG.RESULT && x[1] === r) || (x[0] === MSG.ERROR && x[1] === MSG.CALL && x[2] === r),
      timeout,
    );
  }

  call(uri: string, args?: unknown[], kwargs?: Json, options: Json = {}, timeout = 3000): Promise<Frame | null> {
    return this.callResult(this.callNoWait(uri, args, kwargs, options), timeout);
  }

  publish(uri: string, args?: unknown[], kwargs?: Json, options: Json = {}): Promise<Frame | null> {
    const r = this.id();
    const m: unknown[] = [MSG.PUBLISH, r, { acknowledge: true, ...options }, uri];
    if (args !== undefined || kwargs !== undefined) m.push(args ?? []);
    if (kwargs !== undefined) m.push(kwargs);
    this.send(m);
    if (options['acknowledge'] === false) return Promise.resolve(null);
    return this.next(
      (x) => (x[0] === MSG.PUBLISHED && x[1] === r) || (x[0] === MSG.ERROR && x[1] === MSG.PUBLISH && x[2] === r),
    );
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // as the script
    }
  }
}

type XProbe = (r: Json, x: XContext) => Promise<void>;

interface XContext {
  readonly env: ProbeEnv;
  anon(label?: string): Promise<XPeer>;
  peer(protocols?: string[]): XPeer;
  uniq(s: string): string;
  sleep(ms: number): Promise<void>;
}

function crossbarProbes(): [string, XProbe][] {
  const list: [string, XProbe][] = [];
  const probe = (name: string, fn: XProbe): void => {
    list.push([name, fn]);
  };

  probe('progressive_call_results', async (r, x) => {
    const callee = await x.anon('callee');
    const caller = await x.anon('caller');
    const uri = x.uniq('prog');
    await callee.register(uri);
    callee.onInvocation = (inv) => {
      r['invocationDetails'] = inv[3];
      for (let i = 1; i <= 3; i++) callee.send([MSG.YIELD, inv[1], { progress: true }, [i]]);
      callee.send([MSG.YIELD, inv[1], {}, ['done']]);
    };
    const id = caller.callNoWait(uri, [], undefined, { receive_progress: true });
    const msgs: (Frame | null)[] = [];
    for (;;) {
      const m = await caller.callResult(id);
      msgs.push(m);
      if (m === null || details(m, 2)?.['progress'] !== true) break;
    }
    r['results'] = msgs.map((m) => m && [nameOf(m[0]), m[2], m[3]]);
    r['ok'] = msgs.length === 4 && (msgs[3]?.[3] as unknown[] | undefined)?.[0] === 'done';
    const uri2 = x.uniq('prog2');
    await callee.register(uri2);
    callee.onInvocation = (inv) => {
      callee.send([MSG.YIELD, inv[1], { progress: true }, ['p']]);
      callee.send([MSG.YIELD, inv[1], {}, ['final']]);
    };
    const id2 = caller.callNoWait(uri2, []);
    const m1 = await caller.callResult(id2);
    const m2 = await caller.callResult(id2, 700);
    r['progressWithoutReceiveProgress'] = [desc(m1), desc(m2)];
    caller.close();
    callee.close();
  });
  for (const mode of ['skip', 'kill', 'killnowait'] as const) {
    probe(`call_canceling_${mode}`, async (r, x) => {
      const callee = await x.anon('callee');
      const caller = await x.anon('caller');
      const uri = x.uniq('cancel');
      await callee.register(uri);
      let inv: Frame | null = null;
      callee.onInvocation = (m) => {
        inv = m;
      };
      const id = caller.callNoWait(uri, []);
      await x.sleep(200);
      caller.send([MSG.CANCEL, id, { mode }]);
      const t0 = x.env.now();
      const interrupt = await callee.next((m) => m[0] === MSG.INTERRUPT, 1000);
      r['calleeGotInterrupt'] = desc(interrupt);
      const invocation = inv as Frame | null;
      if (interrupt && mode === 'kill' && invocation !== null) {
        await x.sleep(300);
        callee.send([MSG.ERROR, MSG.INVOCATION, invocation[1], {}, 'wamp.error.canceled', ['callee says canceled']]);
      }
      const res = await caller.callResult(id, 2000);
      r['callerGot'] = desc(res);
      r['callerLatencyMs'] = Math.round(x.env.now() - t0);
      if (invocation !== null) callee.send([MSG.YIELD, invocation[1], {}, ['late']]);
      const late = await caller.collect((m) => m[0] === MSG.RESULT, 400);
      r['lateYieldLeaked'] = late.length > 0;
      r['calleeStillUp'] = callee.closeInfo === null;
      r['ok'] = res?.[0] === MSG.ERROR && res[4] === 'wamp.error.canceled';
      caller.close();
      callee.close();
    });
  }
  probe('call_timeout', async (r, x) => {
    const callee = await x.anon('callee');
    const caller = await x.anon('caller');
    const uri = x.uniq('timeout');
    await callee.register(uri);
    const invocationDetails: unknown[] = [];
    callee.onInvocation = (m) => {
      invocationDetails.push(m[3]);
      r['invocationDetails'] = invocationDetails;
    };
    for (const timeout of [1, 2, 1500]) {
      const t0 = x.env.now();
      const id = caller.callNoWait(uri, [], undefined, { timeout });
      const res = await caller.callResult(id, 3000);
      const intr = await callee.next((m) => m[0] === MSG.INTERRUPT, 200);
      r[`timeout_${String(timeout)}`] = {
        callerGot: desc(res),
        afterMs: Math.round(x.env.now() - t0),
        calleeInterrupt: desc(intr),
      };
      if (!res) caller.send([MSG.CANCEL, id, { mode: 'killnowait' }]);
      await caller.collect(() => true, 200);
    }
    const id = caller.callNoWait(uri, [], undefined, { timeout: 1.5 });
    const res = await caller.callResult(id, 2500);
    r['timeout_float'] = {
      callerGot: desc(res),
      closed: caller.closeInfo,
      abort: desc(caller.inbox.find((m) => m[0] === MSG.ABORT) ?? null),
    };
    r['ok'] = (r['timeout_1'] as { callerGot: string }).callerGot.startsWith('ERROR');
    caller.close();
    callee.close();
  });
  probe('shared_registration', async (r, x) => {
    const a = await x.anon('calleeA');
    const b = await x.anon('calleeB');
    const caller = await x.anon('caller');
    for (const invoke of ['roundrobin', 'first', 'last', 'random']) {
      const uri = x.uniq(`shared_${invoke}`);
      const ra = await a.register(uri, { invoke });
      const rb = await b.register(uri, { invoke });
      const hits: string[] = [];
      a.onInvocation = (m) => {
        hits.push('A');
        a.send([MSG.YIELD, m[1], {}, ['A']]);
      };
      b.onInvocation = (m) => {
        hits.push('B');
        b.send([MSG.YIELD, m[1], {}, ['B']]);
      };
      for (let i = 0; i < 6; i++) await caller.call(uri, []);
      r[invoke] = { regIdsEqual: ra?.[2] === rb?.[2], hits: hits.join('') };
    }
    const uri = x.uniq('shared_mismatch');
    await a.register(uri, { invoke: 'roundrobin' });
    r['mismatchedPolicy'] = desc(await b.register(uri, { invoke: 'random' }));
    const uri2 = x.uniq('single');
    await a.register(uri2);
    r['secondSingleRegistration'] = desc(await b.register(uri2));
    r['sameSessionTwice'] = desc(await a.register(uri2));
    r['ok'] = (r['roundrobin'] as { hits: string }).hits === 'ABABAB';
    a.close();
    b.close();
    caller.close();
  });
  probe('pattern_based_registration', async (r, x) => {
    const callee = await x.anon('callee');
    const caller = await x.anon('caller');
    const base = x.uniq('pat');
    const regs: Record<string, unknown> = {};
    const name = (id: unknown): unknown => Object.keys(regs).find((k) => regs[k] === id) ?? id;
    regs['prefix'] = (await callee.register(`${base}.p`, { match: 'prefix' }))?.[2];
    regs['prefix_longer'] = (await callee.register(`${base}.p.q`, { match: 'prefix' }))?.[2];
    regs['wildcard'] = (await callee.register(`${base}..w`, { match: 'wildcard' }))?.[2];
    regs['wildcard_overlap'] = (await callee.register(`${base}.p..z`, { match: 'wildcard' }))?.[2];
    regs['exact'] = (await callee.register(`${base}.p.x`))?.[2];
    const seen: Json[] = [];
    callee.onInvocation = (m) => {
      seen.push({ reg: name(m[2]), procedure: details(m, 3)?.['procedure'] ?? '(absent: exact)' });
      callee.send([MSG.YIELD, m[1], {}, []]);
    };
    const calls: Json = {};
    for (const target of [`${base}.p.foo.bar`, `${base}.p.q.r`, `${base}.y.w`, `${base}.p.x`, `${base}.p.k.z`]) {
      const before = seen.length;
      const res = await caller.call(target, []);
      calls[target.slice(base.length)] = seen.length > before ? seen[before] : desc(res);
    }
    r['calls'] = calls;
    const reg = (target: string): unknown => (calls[target] as Json | undefined)?.['reg'];
    r['ok'] =
      reg('.p.foo.bar') === 'prefix' &&
      reg('.p.q.r') === 'prefix_longer' &&
      reg('.y.w') === 'wildcard' &&
      reg('.p.x') === 'exact';
    r['note'] = 'precedence: exact > longest prefix > wildcard (".p.k.z" matches prefix ".p" and wildcard ".p..z")';
    caller.close();
    callee.close();
  });
  probe('pattern_based_subscription', async (r, x) => {
    const sub = await x.anon('sub');
    const pub = await x.anon('pub');
    const base = x.uniq('pats');
    const sp = await sub.subscribe(base, { match: 'prefix' });
    const sw = await sub.subscribe(`${base}..end`, { match: 'wildcard' });
    await pub.publish(`${base}.a.end`, ['x']);
    const evs = await sub.collect((m) => m[0] === MSG.EVENT, 300);
    r['events'] = evs.map((e) => ({
      sub: e[1] === sp?.[2] ? 'prefix' : e[1] === sw?.[2] ? 'wildcard' : e[1],
      details: e[3],
    }));
    r['ok'] = evs.length === 2 && evs.every((e) => details(e, 3)?.['topic'] === `${base}.a.end`);
    sub.close();
    pub.close();
  });
  probe('error_semantics', async (r, x) => {
    const one = async (label: string, fn: (p: XPeer) => Promise<Frame | null>): Promise<void> => {
      const p = await x.anon(label);
      const m = await fn(p);
      const ci = await p.closed(300);
      r[label] =
        `${desc(m)}${ci ? ` | socket closed ${String(ci.code)} ${JSON.stringify(ci.reason.slice(0, 120))}` : ''}`;
      p.close();
    };
    const sendAndNext = (p: XPeer, m: Frame, pred: (f: Frame) => boolean, ms = 3000): Promise<Frame | null> => {
      p.send(m);
      return p.next(pred, ms);
    };
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
    await one('register_camelCase_loose_realm1', (p) => p.register(x.uniq('camelCaseOk')));
    await one('register_wildcard_with_exact_match', (p) => p.register('com..x'));
    await one('register_bad_match_policy', (p) => p.register('com.x', { match: 'regex' }));
    await one('register_bad_invoke_policy', (p) => p.register('com.x', { invoke: 'sometimes' }));
    await one('no_such_subscription', (p) => {
      const id = p.id();
      return sendAndNext(
        p,
        [MSG.UNSUBSCRIBE, id, 999],
        (f) => (f[0] === MSG.ERROR && f[2] === id) || (f[0] === MSG.UNSUBSCRIBED && f[1] === id),
      );
    });
    await one('no_such_registration', (p) => {
      const id = p.id();
      return sendAndNext(
        p,
        [MSG.UNREGISTER, id, 999],
        (f) => (f[0] === MSG.ERROR && f[2] === id) || (f[0] === MSG.UNREGISTERED && f[1] === id),
      );
    });
    await one('yield_unknown_invocation', (p) => sendAndNext(p, [MSG.YIELD, 987654321, {}, []], () => true, 500));
    await one('error_for_unknown_invocation', (p) =>
      sendAndNext(p, [MSG.ERROR, MSG.INVOCATION, 987654321, {}, 'com.x.err'], () => true, 500),
    );
    await one('cancel_unknown_call', (p) => sendAndNext(p, [MSG.CANCEL, 424242, { mode: 'kill' }], () => true, 500));
    await one('cancel_bad_mode', (p) => sendAndNext(p, [MSG.CANCEL, 424242, { mode: 'nuke' }], () => true, 500));
    const a = await x.anon('A');
    const b = await x.anon('B');
    const uri = x.uniq('apperr');
    await a.register(uri);
    a.onInvocation = (m) => {
      a.send([
        MSG.ERROR,
        MSG.INVOCATION,
        m[1],
        { extra: 1 },
        'com.thruway.error.custom',
        ['bad', 1],
        { why: 'because' },
      ]);
    };
    r['application_error'] = desc(await b.call(uri, []));
    const uri2 = x.uniq('apperr2');
    await a.register(uri2);
    a.onInvocation = (m) => {
      a.send([MSG.ERROR, MSG.INVOCATION, m[1], {}, 'not a uri!']);
    };
    r['application_error_invalid_error_uri'] = desc(await b.call(uri2, []));
    r['calleeAfterInvalidErrorUri'] = a.closeInfo
      ? `closed ${String(a.closeInfo.code)} ${a.closeInfo.reason.slice(0, 120)}`
      : 'open';
    const c = await x.anon('C');
    const owner = await x.anon('owner');
    const uri3 = x.uniq('steal');
    await owner.register(uri3);
    let stolen: unknown = null;
    owner.onInvocation = (m) => {
      stolen = m[1];
    };
    const id3 = b.callNoWait(uri3, []);
    await x.sleep(200);
    if (stolen !== null) c.send([MSG.YIELD, stolen, {}, ['stolen']]);
    await x.sleep(300);
    r['yield_for_foreign_invocation'] = {
      thief: c.closeInfo ? `closed ${String(c.closeInfo.code)} ${c.closeInfo.reason.slice(0, 120)}` : 'open',
      callerGot: desc(await b.callResult(id3, 300)),
    };
    r['ok'] = true;
    a.close();
    b.close();
    c.close();
    owner.close();
  });
  probe('callee_or_caller_vanishes', async (r, x) => {
    const callee = await x.anon('callee');
    const caller = await x.anon('caller');
    const uri = x.uniq('vanish');
    await callee.register(uri);
    callee.onInvocation = () => undefined;
    const id = caller.callNoWait(uri, []);
    await x.sleep(200);
    callee.ws.close(4000);
    r['callerAfterCalleeLost'] = desc(await caller.callResult(id, 2000));
    const callee2 = await x.anon('callee2');
    const uri2 = x.uniq('vanish2');
    await callee2.register(uri2);
    callee2.onInvocation = () => undefined;
    const caller2 = await x.anon('caller2');
    caller2.callNoWait(uri2, []);
    await x.sleep(200);
    caller2.ws.close(4000);
    r['calleeAfterCallerLost'] = desc(await callee2.next((m) => m[0] === MSG.INTERRUPT, 1500));
    r['ok'] = (r['callerAfterCalleeLost'] as string).startsWith('ERROR');
    caller.close();
    callee2.close();
  });
  probe('protocol_violations', async (r, x) => {
    const run = async (label: string, fn: (p: XPeer) => void): Promise<void> => {
      const p = await x.anon(label);
      fn(p);
      const m = await p.next(() => true, 1500);
      const ci = await p.closed(1500);
      r[label] = `${desc(m)} | socket: ${ci ? `closed ${String(ci.code)} ${JSON.stringify(ci.reason)}` : 'still open'}`;
      p.close();
    };
    await run('second_hello', (p) => {
      p.send([MSG.HELLO, x.env.realm, { roles: X_ROLES }]);
    });
    await run('unknown_message_type_999', (p) => {
      p.send([999, 1, {}]);
    });
    await run('router_only_message_WELCOME_from_client', (p) => {
      p.send([MSG.WELCOME, 1, {}]);
    });
    await run('malformed_json', (p) => {
      p.sendRaw('[48, 1, {}, "x"');
    });
    await run('json_not_array', (p) => {
      p.sendRaw('{"a":1}');
    });
    await run('binary_frame_on_json', (p) => {
      p.sendRaw(new Uint8Array([0x93, 0x30, 0x01, 0x80]));
    });
    await run('call_wrong_arity', (p) => {
      p.send([MSG.CALL, 1]);
    });
    await run('call_args_not_list', (p) => {
      p.send([MSG.CALL, 1, {}, 'com.x', { a: 1 }]);
    });
    await run('call_options_not_dict', (p) => {
      p.send([MSG.CALL, 1, [], 'com.x']);
    });
    await run('call_request_id_zero', (p) => {
      p.send([MSG.CALL, 0, {}, 'com.thruway.nope']);
    });
    await run('call_request_id_2pow53', (p) => {
      p.send([MSG.CALL, 2 ** 53, {}, 'com.thruway.nope']);
    });
    await run('call_request_id_negative', (p) => {
      p.send([MSG.CALL, -5, {}, 'com.thruway.nope']);
    });
    await run('receive_progress_not_bool', (p) => {
      p.send([MSG.CALL, 1, { receive_progress: 'yes' }, 'com.thruway.nope']);
    });
    await run('publish_acknowledge_not_bool', (p) => {
      p.send([MSG.PUBLISH, 1, { acknowledge: 1 }, 'com.thruway.x']);
    });
    await run('unknown_option_ignored', (p) => {
      p.send([MSG.CALL, 1, { x_thruway_unknown: 1 }, 'com.thruway.nope']);
    });
    await run('goodbye_without_reason', (p) => {
      p.send([MSG.GOODBYE, {}]);
    });
    r['ok'] = true;
  });
  probe('pre_session_violations', async (r, x) => {
    const run = async (label: string, msg: Frame): Promise<void> => {
      const p = x.peer();
      await p.open();
      p.send(msg);
      const m = await p.next(() => true, 1500);
      const ci = await p.closed(1500);
      r[label] = `${desc(m)} | socket: ${ci ? `closed ${String(ci.code)}` : 'still open'}`;
      p.close();
    };
    await run('call_before_hello', [MSG.CALL, 1, {}, 'com.x']);
    await run('goodbye_before_hello', [MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await run('authenticate_without_challenge', [MSG.AUTHENTICATE, 'x', {}]);
    await run('hello_realm_not_string', [MSG.HELLO, 5, { roles: X_ROLES }]);
    r['ok'] = true;
  });
  probe('subprotocol_negotiation', async (r, x) => {
    const tryOpen = async (protocols: string[]): Promise<string> => {
      const p = x.peer(protocols);
      const opened = await p.open();
      if (opened) {
        p.close();
        return `open protocol=${JSON.stringify(p.ws.protocol)}`;
      }
      return p.closeInfo ? `rejected close=${String(p.closeInfo.code)}` : 'timeout';
    };
    r['json'] = await tryOpen(['wamp.2.json']);
    r['msgpack_then_json'] = await tryOpen(['wamp.2.msgpack', 'wamp.2.json']);
    r['json_batched'] = await tryOpen(['wamp.2.json.batched']);
    r['none'] = await tryOpen([]);
    r['unknown'] = await tryOpen(['wamp.2.thruway']);
    r['ok'] = (r['json'] as string).startsWith('open');
  });
  probe('goodbye_handshake', async (r, x) => {
    const p = await x.anon('p');
    const t0 = x.env.now();
    p.send([MSG.GOODBYE, { message: 'see ya' }, 'wamp.close.system_shutdown']);
    r['reply'] = desc(await p.next((m) => m[0] === MSG.GOODBYE, 1500));
    const ci = await p.closed(2500);
    r['routerClosesSocketAfterGoodbye'] = ci
      ? { code: ci.code, afterMs: Math.round(x.env.now() - t0) }
      : 'no (client must close)';
    p.close();
    const q = await x.anon('q');
    q.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await q.next((m) => m[0] === MSG.GOODBYE, 1000);
    q.send([MSG.CALL, 1, {}, 'wamp.session.count']);
    r['callAfterGoodbye'] = desc(await q.next(() => true, 1000));
    r['rehelloAfterGoodbye'] = desc(await q.hello(x.env.realm, { authmethods: ['anonymous'] }));
    q.close();
    r['ok'] = true;
  });
  probe('request_id_reuse', async (r, x) => {
    const callee = await x.anon('callee');
    const caller = await x.anon('caller');
    const uri = x.uniq('reuse');
    await callee.register(uri);
    const invs: Frame[] = [];
    callee.onInvocation = (m) => {
      invs.push(m);
    };
    caller.send([MSG.CALL, 77, {}, uri, [1]]);
    caller.send([MSG.CALL, 77, {}, uri, [2]]);
    await x.sleep(300);
    for (const m of invs) callee.send([MSG.YIELD, m[1], {}, m[4]]);
    r['callerGot'] = (await caller.collect(() => true, 500)).map(desc);
    r['invocations'] = invs.length;
    r['callerClosed'] = caller.closeInfo;
    r['ok'] = true;
    callee.close();
    caller.close();
  });
  return list;
}

/** The names of the ported crossbar/probe.mjs groups, in its order. */
export const CROSSBAR_PROBE_NAMES: readonly string[] = crossbarProbes().map(([name]) => name);

/** Run the ported crossbar/probe.mjs groups (all, or `only`), one after the other. */
export async function runCrossbarProbes(
  env: ProbeEnv,
  options: { readonly only?: readonly string[] } = {},
): Promise<Json> {
  const out: Json = {};
  const ctx: XContext = {
    env,
    anon: async () => {
      const p = new XPeer(env);
      const w = await p.hello(env.realm, { authmethods: ['anonymous'] });
      if (w?.[0] !== MSG.WELCOME) throw new Error(`join failed: ${desc(w)}`);
      return p;
    },
    peer: (protocols) => new XPeer(env, protocols),
    uniq: (s) => `com.thruway.probe.${s}.${base36(env.random() * 36 ** 6).padStart(6, '0')}`,
    sleep: (ms) => env.sleep(ms),
  };
  for (const [name, fn] of crossbarProbes()) {
    if (options.only !== undefined && !options.only.includes(name)) continue;
    const r: Json = { ok: false };
    try {
      await fn(r, ctx);
    } catch (e) {
      r['error'] = (e as Error).message;
    }
    out[name] = r;
  }
  return out;
}
