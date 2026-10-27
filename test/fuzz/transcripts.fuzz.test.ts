// Transcript replays: recorded router transcripts, replayed into a fresh client in lockstep, with JSON-aware mutations
// of their router frames (ids, types, fields, dicts; duplicated, dropped, delayed and stale frames) kept separate from
// byte flips (which mostly hit the fatal path).
//
// The seed corpus is recorded here, at test time and deterministically: the smoke script below (open, two
// registrations, a subscription, an acknowledged publish, calls answered by the client itself, by the router, by
// nobody, a progressive call, router-side invocations, a cancelled call, a router publish, an unsubscribe, a router
// kill with the reconnect and remount it causes, a call in the new session, close()) run against the reference router's
// Thruway PHP dialect, without and with ticket authentication (random testing runs on the first-class router only). The
// fixed seed makes the client's request ids and backoff jitter reproducible: an unmutated replay writes exactly the
// recorded client frames (the first test).
//
// Replay. The router is told to ignore every client frame (it answers nothing); the recorded router frames are written
// to the connection of the same rank, each at its recorded time and once the client has written as many frames on that
// connection as it had when the router sent it (bounded: a mutated frame can make the client write less), and the
// socket closes of the recording are replayed from the router end where that end is still open. App actions run at
// their recorded times.
//
// Properties of every replay: nothing escapes to the host (process uncaughtException/unhandledRejection, logger
// `internal` entries = 0); every op settles after close(); every INV-* checker holds (INV-CL01/INV-CL02 among them:
// what the client writes is well-formed and answers only what it has); the harness checks (router oracle) are clean. A
// full run of the JSON-aware property must reach every class: an ABORT protocol_violation, a payload-invalid
// settlement, other writes than the recording's, and the recording's writes unchanged.
// Files under test/fixtures/transcripts/ (recorded by the integration suite with RECORD_TRANSCRIPTS=1) are replayed
// router-frames-only, like our corpus in the last test: their app actions are not known, so their frames reach a
// client that has only opened. Only the Thruway PHP ones (a file name containing `thruway-php`) are replayed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fc } from '@fast-check/vitest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { Observable } from '../../src/observable/observable.js';
import { DIALECTS, type DialectName, type FakeSocket, type SimAuthProvider } from '../../src/testing/sim.js';
import type { ClientOptions } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { checkInvariants, formatViolations, topicKey, type OpInfo } from '../helpers/invariants.js';
import type { Recorded } from '../helpers/trace.js';
import type { FrameRecord, Trace } from '../helpers/trace-types.js';
import { replayParameters } from '../setup-fast-check.js';

vi.setConfig({ testTimeout: Math.max(60000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 100) });

// --- nothing escapes to the host ----------------------------------------------------------------------------------

const escaped: unknown[] = [];
const onEscape = (error: unknown): void => {
  escaped.push(error);
};
beforeAll(() => {
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
});
afterAll(() => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
});

// --- the smoke script -----------------------------------------------------------------------------------------------

const SEED = 7;
const TIMEOUTS = { idle: 0, request: 600000 } as const;

/** One run of the smoke script: the client, what it observes, and the op kinds for the invariant checkers. */
class Workload {
  readonly ops = new Map<number, OpInfo>();
  readonly recorded: Recorded<unknown>[] = [];
  slow: Recorded<unknown> | undefined;
  topic: Recorded<unknown> | undefined;

  constructor(
    readonly h: Harness,
    readonly c: SimClient<Client>,
  ) {}

  keep(
    stream: 'call' | 'publish' | 'topic' | 'register',
    uri: string,
    source: unknown,
    info: OpInfo,
  ): Recorded<unknown> {
    const r = this.c.observe(stream, uri, source as Parameters<typeof this.c.observe>[2]);
    this.ops.set(r.id, info);
    this.recorded.push(r);
    return r;
  }
}

interface Step {
  readonly name: string;
  /** App actions (replayed). */
  readonly app?: (w: Workload) => void;
  /** Router-side actions (only while recording: a replay gets their frames from the transcript). */
  readonly router?: (w: Workload) => void;
  /** Virtual ms to run after the step. */
  readonly wait: number;
}

const STEPS: readonly Step[] = [
  {
    name: 'open',
    app: (w) => {
      w.c.open();
    },
    wait: 20,
  },
  {
    name: 'register',
    app: (w) => {
      w.keep(
        'register',
        'tr.echo',
        w.c.client.register('tr.echo', (inv) => inv.args[0]),
        { kind: 'register' },
      );
      w.keep(
        'register',
        'tr.stream',
        w.c.client.register(
          'tr.stream',
          () =>
            new Observable<string>((s) => {
              s.next('s1');
              s.next('s2');
              s.complete();
            }),
        ),
        { kind: 'register' },
      );
    },
    wait: 20,
  },
  {
    name: 'subscribe',
    app: (w) => {
      w.topic = w.keep('topic', 'tr.t', w.c.client.topic('tr.t'), { kind: 'topic', key: topicKey('tr.t', {}) });
    },
    wait: 20,
  },
  {
    name: 'publish',
    app: (w) =>
      w.keep('publish', 'tr.t', w.c.client.publish('tr.t', ['p1'], {}, { acknowledge: true, exclude_me: false }), {
        kind: 'publish',
        ack: true,
      }),
    wait: 20,
  },
  {
    name: 'calls',
    app: (w) => {
      w.keep('call', 'tr.echo', w.c.client.call('tr.echo', ['c1']), { kind: 'call', tag: 'c1' });
      w.keep('call', 'tr.router', w.c.client.call('tr.router', ['c2']), { kind: 'call', tag: 'c2' });
      w.keep('call', 'tr.missing', w.c.client.call('tr.missing', ['c3']), { kind: 'call', tag: 'c3' });
      w.keep('call', 'tr.progress', w.c.client.progressiveCall('tr.progress', ['c4']), { kind: 'call', tag: 'c4' });
    },
    wait: 20,
  },
  {
    name: 'router invocations',
    router: (w) => {
      w.h.router.invoke('tr.echo', { args: ['r1'] });
      w.h.router.invoke('tr.stream', { args: ['r2'], options: { receive_progress: true } });
    },
    wait: 20,
  },
  {
    name: 'slow call',
    app: (w) => {
      w.slow = w.keep('call', 'tr.slow', w.c.client.call('tr.slow', ['c5']), { kind: 'call', tag: 'c5' });
    },
    wait: 20,
  },
  {
    name: 'cancel',
    app: (w) => {
      w.slow?.unsubscribe();
    },
    wait: 20,
  },
  {
    name: 'router publish',
    router: (w) => {
      w.h.router.publish('tr.t', ['e1'], { k: 1 });
    },
    wait: 20,
  },
  {
    name: 'unsubscribe',
    app: (w) => {
      w.topic?.unsubscribe();
    },
    wait: 20,
  },
  {
    name: 'kill',
    router: (w) => {
      const session = w.h.router.sessions[0];
      if (session !== undefined) w.h.router.kill(session.id);
    },
    wait: 6000,
  },
  {
    name: 'call in the new session',
    app: (w) => w.keep('call', 'tr.echo', w.c.client.call('tr.echo', ['c6']), { kind: 'call', tag: 'c6' }),
    wait: 20,
  },
  { name: 'close', app: (w) => void w.c.close(), wait: 3000 },
];

interface Variant {
  readonly name: string;
  readonly dialect: DialectName;
  readonly auth: boolean;
}

/** Thruway PHP only, without and with ticket authentication. */
const VARIANTS: readonly Variant[] = [
  { name: 'thruway-php', dialect: 'thruway-php', auth: false },
  { name: 'thruway-php+ticket', dialect: 'thruway-php', auth: true },
];

const PROVIDERS: readonly SimAuthProvider[] = [
  { method: 'ticket', verify: (signature) => (signature === 'secret' ? { authid: 'joe', authrole: 'user' } : false) },
];

function clientOptions(variant: Variant): ClientOptions {
  return {
    autoOpen: false,
    timeouts: TIMEOUTS,
    ...(variant.auth ? { authmethods: ['ticket'], authid: 'joe', onChallenge: () => 'secret' } : {}),
  };
}

function harnessFor(variant: Variant, seed: number): Harness {
  const h = createHarness({
    seed,
    router: {
      dialect: variant.dialect,
      routerIds: 'unique',
      ...(variant.auth ? { providers: PROVIDERS } : {}),
    },
    checks: { unscripted: false },
  });
  h.router.declareTopic('tr.t');
  h.router.procedure('tr.router', (args) => args[0]);
  h.router.procedure(
    'tr.progress',
    () =>
      new Observable<string>((s) => {
        s.next('p1');
        s.next('p2');
        s.complete();
      }),
  );
  h.router.procedure('tr.slow', () => new Promise(() => undefined));
  return h;
}

// --- recording ------------------------------------------------------------------------------------------------------

/** A router frame or a router-side transport close of a transcript, positioned for the lockstep replay. */
interface Event {
  readonly kind: 'frame' | 'close';
  readonly step: number;
  /** Rank of the connection among the client's connections (0-based). */
  readonly conn: number;
  /** Client frames written on that connection before it. */
  readonly before: number;
  readonly at: number;
  /** The frame's text; for a close, `code reason wasClean`. */
  readonly text: string;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

interface Transcript {
  readonly variant: Variant;
  readonly starts: readonly number[];
  readonly end: number;
  readonly events: readonly Event[];
  /** The client's frames per connection rank. */
  readonly written: readonly (readonly string[])[];
}

const textOf = (frame: FrameRecord['frame']): string => (typeof frame === 'string' ? frame : JSON.stringify(frame));

function ranksOf(c: SimClient<Client>): Map<number, number> {
  return new Map(c.connections.map((conn, i) => [conn.number, i]));
}

function writtenBy(trace: Trace, ranks: Map<number, number>): string[][] {
  const out: string[][] = [];
  for (const f of trace.frames) {
    if (f.direction !== 'in') continue;
    (out[ranks.get(f.connection) ?? -1] ??= []).push(textOf(f.frame));
  }
  return out;
}

interface CloseSeen {
  readonly socket: FakeSocket;
  readonly position: number;
  readonly step: number;
  readonly at: number;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

async function record(variant: Variant): Promise<Transcript> {
  const h = harnessFor(variant, SEED);
  // the socket closes, as the client saw them (a replay applies one from the router end when that end is still open
  // there: the close the client starts itself happens in the replay too)
  const seen: CloseSeen[] = [];
  let step = 0;
  let frames = (): number => 0;
  const Base = h.router.webSocketFor(1);
  const Tapped = new Proxy(Base, {
    construct(target, args: [string, string[]]) {
      const socket = new target(...args) as unknown as FakeSocket;
      const onClose = (ev: unknown): void => {
        socket.removeEventListener('close', onClose);
        const e = ev as { code: number; reason: string; wasClean: boolean };
        seen.push({ socket, position: frames(), step, at: h.clock.now(), ...e });
      };
      socket.addEventListener('close', onClose);
      return socket;
    },
  });
  const c = h.makeClient(Client, { options: { ...clientOptions(variant), WebSocket: Tapped } });
  frames = () => c.trace().frames.length;
  const w = new Workload(h, c);
  const starts: number[] = [];
  const stepOfFrame: number[] = [];
  for (const [i, s] of STEPS.entries()) {
    step = i;
    starts.push(h.clock.now());
    s.app?.(w);
    s.router?.(w);
    await h.clock.advance(s.wait);
    const count = frames();
    while (stepOfFrame.length < count) stepOfFrame.push(i);
  }
  const end = h.clock.now();
  await h.closeAndSettle();
  expect(h.problems(), `${variant.name}: the recording's harness checks`).toEqual([]);
  const trace = c.trace();
  const ranks = ranksOf(c);
  const counts = new Map<number, number>();
  const events: Event[] = [];
  const closesAt = (position: number): void => {
    for (const s of seen.filter((x) => x.position === position)) {
      const rank = c.connections.findIndex((conn) => conn.socket === s.socket);
      events.push({
        kind: 'close',
        step: s.step,
        conn: rank,
        before: counts.get(rank) ?? 0,
        at: s.at,
        text: `${String(s.code)} ${s.reason} ${String(s.wasClean)}`,
        code: s.code,
        reason: s.reason,
        wasClean: s.wasClean,
      });
    }
  };
  trace.frames.forEach((f, i) => {
    closesAt(i);
    const rank = ranks.get(f.connection) ?? -1;
    if (f.direction === 'in') counts.set(rank, (counts.get(rank) ?? 0) + 1);
    else
      events.push({
        kind: 'frame',
        step: stepOfFrame[i] ?? STEPS.length - 1,
        conn: rank,
        before: counts.get(rank) ?? 0,
        at: f.at,
        text: textOf(f.frame),
      });
  });
  closesAt(trace.frames.length);
  return { variant, starts, end, events, written: writtenBy(trace, ranks) };
}

// --- replay ---------------------------------------------------------------------------------------------------------

/** What to send for router frame `index` of the transcript's events (zero texts drop it, two duplicate it). */
type Rewrite = (index: number, text: string) => readonly string[];

interface Replayed {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly w: Workload;
  readonly trace: Trace;
  /** INVOCATION ids the replay sent more than once on one connection. */
  readonly reused: ReadonlySet<unknown>;
  /** A router frame it sent had a 0 element. */
  readonly zero: boolean;
}

async function replay(t: Transcript, rewrite: Rewrite, seed = SEED): Promise<Replayed> {
  const h = harnessFor(t.variant, seed);
  h.router.ignore(() => true);
  const c = h.makeClient(Client, { options: clientOptions(t.variant) });
  const w = new Workload(h, c);
  const advanceTo = async (at: number): Promise<void> => {
    await h.clock.advance(Math.max(0, at - h.clock.now()));
  };
  const writtenOn = (rank: number): number => {
    const conn = c.connections[rank];
    if (conn === undefined) return -1;
    return c.trace().frames.filter((f) => f.direction === 'in' && f.connection === conn.number).length;
  };
  const invocations = new Set<string>();
  const reused = new Set<unknown>();
  let zero = false;
  const noteInvocation = (rank: number, text: string): void => {
    try {
      const frame = JSON.parse(text) as unknown;
      if (!Array.isArray(frame)) return;
      if (frame.slice(1).includes(0)) zero = true;
      if (frame[0] !== 68) return;
      const key = `${String(rank)} ${JSON.stringify(frame[1])}`;
      if (invocations.has(key)) reused.add(frame[1]);
      invocations.add(key);
    } catch {
      // not JSON
    }
  };
  let k = 0;
  // a frames-only transcript runs the open step alone
  for (const [i, s] of STEPS.slice(0, t.starts.length).entries()) {
    await advanceTo(t.starts[i] ?? 0);
    s.app?.(w);
    for (; k < t.events.length && t.events[k]!.step <= i; k++) {
      const e = t.events[k]!;
      await advanceTo(e.at);
      // lockstep, bounded: a mutated frame can make the client write less (or end the connection early)
      for (let n = 0; n < 20 && writtenOn(e.conn) < e.before; n++) await h.clock.advance(5);
      const conn = c.connections[e.conn];
      if (conn === undefined) continue;
      if (e.kind === 'frame')
        for (const text of rewrite(k, e.text)) {
          noteInvocation(e.conn, text);
          conn.sendRaw(text);
        }
      else if (conn.state !== 'open') continue;
      else if (e.wasClean === true) conn.controls.close(e.code, e.reason);
      else conn.controls.drop(e.code, false);
      await h.clock.advance(0);
    }
  }
  await advanceTo(t.end);
  await h.closeAndSettle();
  return { h, c, w, trace: c.trace(), reused, zero };
}

// --- mutations --------------------------------------------------------------------------------------------------------

/** JSON-aware mutations of one router frame (`at` picks the frame, `pos` the element, both taken modulo). */
type Mutation =
  | { readonly op: 'id'; readonly at: number; readonly pos: number; readonly literal: string }
  | { readonly op: 'known-id'; readonly at: number; readonly pos: number; readonly pick: number }
  | { readonly op: 'type'; readonly at: number; readonly type: number }
  | { readonly op: 'field'; readonly at: number; readonly pos: number; readonly value: unknown }
  | { readonly op: 'remove'; readonly at: number; readonly pos: number }
  | { readonly op: 'append'; readonly at: number; readonly value: unknown }
  | { readonly op: 'swap'; readonly at: number; readonly pos: number; readonly with: number }
  | { readonly op: 'dict'; readonly at: number; readonly pos: number; readonly key: string; readonly value: unknown }
  | { readonly op: 'duplicate' | 'drop' | 'later'; readonly at: number }
  | { readonly op: 'stale'; readonly at: number; readonly from: number };

/** Byte-level damage of one router frame's text. */
interface Flip {
  readonly at: number;
  readonly pos: number;
  readonly kind: 'replace' | 'insert' | 'delete' | 'truncate';
  readonly char: string;
}

/** Ids as JSON literals: 0, negative, fractional, beyond 2^53, strings, null, exponent notation. */
const ID_LITERALS = ['0', '-1', '1.5', '9007199254740992', '9007199254740993', '1e3', '"1"', 'null', '[]', '{}'];
/** Message types: every inbound one, the client-only ones, unknown ones. */
const TYPES = [2, 3, 4, 6, 8, 33, 34, 36, 50, 65, 67, 68, 69, 70, 1, 5, 16, 32, 48, 49, 64, 66, 0, 7, 99, 1023, -1];
const VALUES: readonly unknown[] = [
  null,
  [],
  {},
  '',
  'x',
  'wamp.error.canceled',
  true,
  0,
  -1,
  1.5,
  1e300,
  { progress: true },
  { a: [1, { b: null }] },
  [[[[[]]]]],
];
const KEYS = ['progress', 'authmethod', 'reason', 'message', 'mode', 'topic', 'procedure', 'caller', '__proto__'];

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant('id' as const), at: fc.nat(), pos: fc.nat(), literal: fc.constantFrom(...ID_LITERALS) }),
  fc.record({ op: fc.constant('known-id' as const), at: fc.nat(), pos: fc.nat(), pick: fc.nat() }),
  fc.record({ op: fc.constant('type' as const), at: fc.nat(), type: fc.constantFrom(...TYPES) }),
  fc.record({ op: fc.constant('field' as const), at: fc.nat(), pos: fc.nat(), value: fc.constantFrom(...VALUES) }),
  fc.record({ op: fc.constant('remove' as const), at: fc.nat(), pos: fc.nat() }),
  fc.record({ op: fc.constant('append' as const), at: fc.nat(), value: fc.constantFrom(...VALUES) }),
  fc.record({ op: fc.constant('swap' as const), at: fc.nat(), pos: fc.nat(), with: fc.nat() }),
  fc.record({
    op: fc.constant('dict' as const),
    at: fc.nat(),
    pos: fc.nat(),
    key: fc.constantFrom(...KEYS),
    value: fc.constantFrom(...VALUES),
  }),
  fc.record({ op: fc.constantFrom('duplicate' as const, 'drop' as const, 'later' as const), at: fc.nat() }),
  fc.record({ op: fc.constant('stale' as const), at: fc.nat(), from: fc.nat() }),
);

const flipArb: fc.Arbitrary<Flip> = fc.record({
  at: fc.nat(),
  pos: fc.nat(),
  kind: fc.constantFrom('replace' as const, 'insert' as const, 'delete' as const, 'truncate' as const),
  char: fc.constantFrom('[', ']', '{', '}', ',', '"', ':', '0', '9', '-', '.', 'e', 'x', ' ', '\\', '\u0000', '\uD800'),
});

/** The indices of a transcript's router frames (closes are never mutated). */
function frameIndices(t: Transcript): number[] {
  return t.events.flatMap((e, i) => (e.kind === 'frame' ? [i] : []));
}

/** Every positive integer the router frames carry (ids a mutation can swap in). */
function knownIds(t: Transcript): number[] {
  const ids = new Set<number>();
  for (const e of t.events) {
    if (e.kind !== 'frame') continue;
    try {
      const frame = JSON.parse(e.text) as unknown;
      if (Array.isArray(frame))
        for (const v of frame) if (Number.isSafeInteger(v) && (v as number) > 0) ids.add(v as number);
    } catch {
      // raw text: no ids
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** A mutated frame as text (a placeholder carries a literal JSON cannot produce from a value, like 2^53 + 1). */
function mutateFrame(text: string, m: Mutation, t: Transcript): string {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(frame) || frame.length === 0) return text;
  const copy: unknown[] = [...(frame as unknown[])];
  const pos = (n: number): number => 1 + (n % Math.max(1, copy.length - 1));
  const PLACEHOLDER = '"\u0001literal\u0001"';
  switch (m.op) {
    case 'id': {
      const ints = copy.flatMap((v, i) => (i > 0 && typeof v === 'number' ? [i] : []));
      const at = ints.length > 0 ? ints[m.pos % ints.length]! : pos(m.pos);
      copy[at] = '\u0001literal\u0001';
      return JSON.stringify(copy).replace(PLACEHOLDER, m.literal);
    }
    case 'known-id': {
      const ids = knownIds(t);
      const ints = copy.flatMap((v, i) => (i > 0 && typeof v === 'number' ? [i] : []));
      if (ids.length === 0 || ints.length === 0) return text;
      copy[ints[m.pos % ints.length]!] = ids[m.pick % ids.length];
      return JSON.stringify(copy);
    }
    case 'type':
      copy[0] = m.type;
      return JSON.stringify(copy);
    case 'field':
      copy[pos(m.pos)] = m.value;
      return JSON.stringify(copy);
    case 'remove':
      copy.splice(pos(m.pos), 1);
      return JSON.stringify(copy);
    case 'append':
      copy.push(m.value);
      return JSON.stringify(copy);
    case 'swap': {
      const a = pos(m.pos);
      const b = pos(m.with);
      [copy[a], copy[b]] = [copy[b], copy[a]];
      return JSON.stringify(copy);
    }
    case 'dict': {
      const dicts = copy.flatMap((v, i) =>
        i > 0 && typeof v === 'object' && v !== null && !Array.isArray(v) ? [i] : [],
      );
      if (dicts.length === 0) return text;
      const at = dicts[m.pos % dicts.length]!;
      // JSON.parse makes `__proto__` an own key, as a router's frame would
      const dict = JSON.parse(JSON.stringify(copy[at])) as Record<string, unknown>;
      Object.defineProperty(dict, m.key, { value: m.value, enumerable: true, configurable: true, writable: true });
      copy[at] = dict;
      return JSON.stringify(copy);
    }
    case 'duplicate':
    case 'drop':
    case 'later':
    case 'stale':
      return text; // applied to the frame list (mutations below)
  }
}

function flip(text: string, f: Flip): string {
  const p = f.pos % (text.length + 1);
  switch (f.kind) {
    case 'replace':
      return text.slice(0, p) + f.char + text.slice(p + 1);
    case 'insert':
      return text.slice(0, p) + f.char + text.slice(p);
    case 'delete':
      return text.slice(0, p) + text.slice(p + 1);
    case 'truncate':
      return text.slice(0, p);
  }
}

/** The rewrite of a transcript for a list of mutations (several may hit one frame; they apply in order). */
function mutations(t: Transcript, list: readonly Mutation[]): Rewrite {
  const frames = frameIndices(t);
  const byEvent = new Map<number, Mutation[]>();
  for (const m of list) {
    const at = frames[m.at % frames.length]!;
    byEvent.set(at, [...(byEvent.get(at) ?? []), m]);
  }
  let held: string[] = [];
  return (index, text) => {
    const before = held;
    held = [];
    let texts = [text];
    for (const m of byEvent.get(index) ?? []) {
      if (m.op === 'drop') texts = [];
      else if (m.op === 'duplicate') texts = [...texts, ...texts];
      else if (m.op === 'later') {
        held = texts;
        texts = [];
      } else if (m.op === 'stale') texts = texts.map(() => t.events[frames[m.from % frames.length]!]!.text);
      else texts = texts.map((x) => mutateFrame(x, m, t));
    }
    return [...texts, ...before];
  };
}

function flips(t: Transcript, list: readonly Flip[]): Rewrite {
  const frames = frameIndices(t);
  const byEvent = new Map<number, Flip[]>();
  for (const f of list) {
    const at = frames[f.at % frames.length]!;
    byEvent.set(at, [...(byEvent.get(at) ?? []), f]);
  }
  return (index, text) => [(byEvent.get(index) ?? []).reduce(flip, text)];
}

// --- the properties ---------------------------------------------------------------------------------------------------

const RUNS = Number(process.env['FC_NUM_RUNS'] ?? 100);

const OUTCOMES = ['fatal', 'payload-invalid', 'handled', 'same'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** What a mutated replay did, by class: an ABORT protocol_violation; an op settled with ProtocolError or
 *  an INVOCATION answered invalid_argument; other writes than the recording's (handled out-of-state frames); the
 *  recording's writes exactly (dropped frames). */
function outcomes(r: Replayed, t: Transcript): Outcome[] {
  const found: Outcome[] = [];
  const written = r.trace.frames
    .filter((f) => f.direction === 'in' && Array.isArray(f.frame))
    .map((f) => f.frame as unknown[]);
  if (written.some((f) => f[0] === 3 && f[2] === 'wamp.error.protocol_violation')) found.push('fatal');
  if (
    r.w.recorded.some((op) => op.errored && (op.error as { code?: unknown } | undefined)?.code === 'protocol') ||
    written.some((f) => f[0] === 8 && f[4] === 'wamp.error.invalid_argument')
  )
    found.push('payload-invalid');
  const same = JSON.stringify(writtenBy(r.trace, ranksOf(r.c))) === JSON.stringify(t.written);
  found.push(same ? 'same' : 'handled');
  return found;
}

/** The robustness properties of one replay. */
function expectRobust(r: Replayed, what: string): void {
  expect(escaped, `${what}: nothing escapes to the host`).toEqual([]);
  expect(
    r.trace.logs.filter((l) => l.entry.event === 'internal').map((l) => l.entry.message),
    `${what}: internal log entries`,
  ).toEqual([]);
  for (const op of r.w.recorded) expect(op.closed, `${what}: every op settles after close()`).toBe(true);
  // Two reports of the router's oracle that judge the router's frame, not the client's answer: it keeps an INVOCATION
  // id answered for the rest of the session (so the answer to a second INVOCATION with that id, a router reusing it, is
  // "after its final answer"), and its ids start at 1 while the decoder accepts 0 (a router-assigned id 0 — an
  // INVOCATION's, a subscription's, a registration's — comes back in the client's answer: "malformed")
  const problems = r.h.problems().filter((p) => {
    const reuse = /for INVOCATION (\S+) after its final answer/.exec(p);
    if (reuse !== null) return ![...r.reused].some((id) => JSON.stringify(id) === reuse[1]);
    const malformed = /malformed [A-Z]+ (\[.*\])$/.exec(p);
    if (malformed === null || !r.zero) return true;
    const frame = JSON.parse(malformed[1]!) as unknown[];
    return !frame.slice(1, 3).includes(0);
  });
  expect(problems, `${what}: the harness checks`).toEqual([]);
  const found = checkInvariants(r.trace, { ops: r.w.ops, timings: TIMEOUTS, final: true });
  expect(found, `${what}\n${formatViolations(found, r.trace)}`).toEqual([]);
}

/** A transcript without its app actions (a foreign transcript, or one of ours replayed router-frames-only). */
function framesOnly(t: Transcript): Transcript {
  return { ...t, starts: [0], events: t.events.map((e) => ({ ...e, step: 0 })) };
}

/** Parse a recorded FrameRecord JSONL file of test/fixtures/transcripts/ into a frames-only transcript. */
function fromJsonl(name: string, text: string): Transcript {
  const records = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FrameRecord);
  const dialect = (Object.keys(DIALECTS) as DialectName[]).find((d) => name.includes(d)) ?? 'spec';
  const variant: Variant = { name, dialect, auth: false };
  const first = records[0]?.at ?? 0;
  const ranks = new Map<number, number>();
  const counts = new Map<number, number>();
  const events: Event[] = [];
  const written: string[][] = [];
  for (const r of records) {
    if (!ranks.has(r.connection)) ranks.set(r.connection, ranks.size);
    const rank = ranks.get(r.connection)!;
    if (r.direction === 'in') {
      counts.set(rank, (counts.get(rank) ?? 0) + 1);
      (written[rank] ??= []).push(textOf(r.frame));
    } else
      events.push({
        kind: 'frame',
        step: 0,
        conn: rank,
        before: counts.get(rank) ?? 0,
        at: r.at - first,
        text: textOf(r.frame),
      });
  }
  const end = Math.max(0, ...events.map((e) => e.at)) + 1000;
  return { variant, starts: [0], end, events, written };
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'transcripts');
const foreign: Transcript[] = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => fromJsonl(f, readFileSync(join(FIXTURES, f), 'utf8')))
      .filter((t) => t.variant.dialect === 'thruway-php')
  : [];

const pick = (n: number, list: readonly Transcript[]): Transcript => list[n % list.length]!;

let recorded: Promise<Transcript[]> | undefined;
/** The seed corpus, recorded once, on first use — inside a test, not a hook, so that a mutation run attributes the
 *  client code the recordings run to a test (code run in hooks counts as static there). */
function corpusOf(): Promise<Transcript[]> {
  recorded ??= (async () => {
    const out: Transcript[] = [];
    for (const variant of VARIANTS) out.push(await record(variant));
    return out;
  })();
  return recorded;
}

describe('transcript replays', () => {
  test('the seed corpus: every recording replays exactly (the client writes the recorded frames)', async () => {
    const corpus = await corpusOf();
    expect(corpus.map((t) => t.variant.name)).toEqual(VARIANTS.map((v) => v.name));
    for (const t of corpus) {
      expect(t.events.length, t.variant.name).toBeGreaterThan(10);
      const r = await replay(t, (_i, text) => [text]);
      expect(writtenBy(r.trace, ranksOf(r.c)), t.variant.name).toEqual(t.written);
      expectRobust(r, t.variant.name);
    }
  });

  test('JSON-aware mutations (ids, types, fields, dicts; duplicated, dropped, delayed and stale frames)', async () => {
    const seen = new Map<Outcome, number>();
    const corpus = await corpusOf();
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.array(mutationArb, { minLength: 1, maxLength: 4 }), async (n, list) => {
        const t = pick(n, corpus);
        const r = await replay(t, mutations(t, list));
        expectRobust(r, `${t.variant.name} ${JSON.stringify(list)}`);
        for (const o of outcomes(r, t)) seen.set(o, (seen.get(o) ?? 0) + 1);
      }),
      { ...replayParameters() },
    );
    // the mutations reach every class (a full run; a replay of one counterexample sees one run)
    if (RUNS >= 100) expect([...seen.keys()].sort()).toEqual([...OUTCOMES].sort());
  });

  test('byte flips (kept apart: they mostly hit the fatal path)', async () => {
    const corpus = await corpusOf();
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.array(flipArb, { minLength: 1, maxLength: 3 }), async (n, list) => {
        const t = pick(n, corpus);
        const r = await replay(t, flips(t, list));
        expectRobust(r, `${t.variant.name} ${JSON.stringify(list)}`);
      }),
      { ...replayParameters() },
    );
  });

  test('router frames only (no app actions): our corpus and test/fixtures/transcripts/*.jsonl', async () => {
    const corpus = await corpusOf();
    const all = [...corpus.map(framesOnly), ...foreign];
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.array(mutationArb, { maxLength: 3 }), async (n, list) => {
        const t = pick(n, all);
        const r = await replay(t, mutations(t, list));
        expectRobust(r, `${t.variant.name} ${JSON.stringify(list)}`);
      }),
      { ...replayParameters() },
    );
  });
});
