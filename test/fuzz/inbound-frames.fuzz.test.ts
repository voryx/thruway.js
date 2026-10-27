// Inbound frame fuzzing into a live Client: fuzzed router frames — valid messages of every inbound type with field
// mutations, valid-but-out-of-state messages, unknown and client-only types, arbitrary JSON and garbage text — are
// injected into a client in a known state: an established session with an in-flight call, a cancelled call, a SUBSCRIBE
// the router never answers, an active subscription and registration and a running invocation; or a handshake (HELLO
// sent, not answered); or a lingering connection after close().
// The router is the reference router's Thruway PHP dialect (random testing runs on the first-class router only).
//
// Each frame carries its expected class by construction: the decode class from test/helpers/inbound-frames.ts (an
// oracle written from the decoding rules independently of src/protocol/decode.ts), then how an established client
// routes it, given the ids it targets. Per frame, the writes of the step that processed it must be exactly the expected
// ones:
// - header-fatal ⇒ ABORT wamp.error.protocol_violation, the session ends, exactly one reconnect follows;
// - payload-invalid ⇒ the owning record settles with ProtocolError, or the INVOCATION gets ERROR invalid_argument;
// - handled ⇒ only the listed writes (INVOCATION for an unknown registration ⇒ ERROR no_such_registration, INTERRUPT
//   kill ⇒ ERROR canceled, GOODBYE ⇒ the single reply); a REGISTERED/SUBSCRIBED for no pending request whose id no
//   record/key holds, and an INVOCATION of a registration no record holds, withdraw that id once: UNREGISTER, or
//   UNSUBSCRIBE (deferred while the never-answered SUBSCRIBE is pending; written when it settles);
// - dropped ⇒ nothing written, no end, nothing delivered.
// At the end every op settles after close(), nothing reached the host (uncaughtException / unhandledRejection), no
// `internal` entry was logged, and every INV-* checker holds.
import { fc } from '@fast-check/vitest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import {
  CLIENT_ONLY,
  CLOSING_TYPES,
  expectedClosing,
  expectedFor,
  FRAME_SPECS,
  MUTATIONS,
  type Expected,
  type FrameSpec,
} from '../helpers/inbound-frames.js';
import { checkInvariants, formatViolations, topicKey, type OpInfo } from '../helpers/invariants.js';
import type { Recorded } from '../helpers/trace.js';
import type { FrameEvent } from '../helpers/trace-types.js';
import { replayParameters } from '../setup-fast-check.js';

vi.setConfig({ testTimeout: Math.max(30000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 60) });

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

// --- the client under fuzz ----------------------------------------------------------------------------------------

/** The live ids of the established setup (what fuzzed frames can target). */
interface Ids {
  readonly call: number;
  readonly cancelled: number;
  readonly pendingSubscribe: number;
  readonly subscription: number;
  readonly registration: number;
  readonly invocation: number;
}

/** What the oracle knows about the client's records while frames arrive. */
interface State {
  callInFlight: boolean;
  invocationRunning: boolean;
  subscriptionActive: boolean;
  registrationActive: boolean;
  pendingSubscribe: boolean;
  /** The subscription id a fuzzed SUBSCRIBED gave the pending key (live from then on). */
  granted: unknown;
  /** Registration ids the client withdrew (UNREGISTER written): never withdrawn again in this session. */
  readonly retired: Set<unknown>;
  /** Subscription ids withdrawn while the pending SUBSCRIBE is outstanding, in order: their UNSUBSCRIBEs wait for it. */
  deferred: unknown[];
  ended: boolean;
}

interface Setup {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  readonly ids: Ids;
  readonly state: State;
  readonly ops: Map<number, OpInfo>;
  readonly recorded: Recorded<unknown>[];
}

function inFrames(c: SimClient<Client>, type: number): FrameEvent[] {
  return c.trace().frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === type);
}

async function established(seed: number): Promise<Setup> {
  const h = createHarness({
    seed,
    router: { dialect: 'thruway-php', routerIds: 'unique' },
    checks: { unscripted: false },
  });
  h.router.declareTopic('fz.t');
  h.router.declareTopic('fz.pending');
  h.router.procedure('fz.never', () => new Promise(() => undefined));
  const c = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0, request: 600000 } } });
  c.open();
  await h.clock.advance(0);
  const ops = new Map<number, OpInfo>();
  const recorded: Recorded<unknown>[] = [];
  const keep = <T>(
    stream: Parameters<typeof c.observe>[0],
    uri: string,
    source: Parameters<typeof c.observe<T>>[2],
    info: OpInfo,
  ): Recorded<T> => {
    const r = c.observe(stream, uri, source);
    ops.set(r.id, info);
    recorded.push(r);
    return r;
  };
  keep('topic', 'fz.t', c.client.topic('fz.t'), { kind: 'topic', key: topicKey('fz.t', {}) });
  keep(
    'register',
    'fz.r',
    c.client.register('fz.r', (inv) => inv.args[0]),
    { kind: 'register' },
  );
  keep(
    'register',
    'fz.slow',
    c.client.register('fz.slow', () => new Promise(() => undefined)),
    { kind: 'register' },
  );
  keep('call', 'fz.never', c.client.call('fz.never', ['c1']), { kind: 'call', tag: 'c1' });
  const cancelled = keep('call', 'fz.never', c.client.call('fz.never', ['c2']), { kind: 'call', tag: 'c2' });
  h.router.ignore((f) => f[0] === 32 && f[3] === 'fz.pending'); // that SUBSCRIBE stays unanswered for the whole run
  keep('topic', 'fz.pending', c.client.topic('fz.pending'), { kind: 'topic', key: topicKey('fz.pending', {}) });
  await h.clock.advance(0);
  cancelled.unsubscribe();
  h.router.invoke('fz.slow');
  await h.clock.advance(0);
  const trace = c.trace();
  const out = (type: number): FrameEvent[] =>
    trace.frames.filter((f) => f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === type);
  const calls = inFrames(c, 48);
  const subscribes = inFrames(c, 32);
  const registered = out(65);
  const ids: Ids = {
    call: (calls[0]?.frame as number[])[1]!,
    cancelled: (calls[1]?.frame as number[])[1]!,
    pendingSubscribe: (subscribes.find((f) => (f.frame as unknown[])[3] === 'fz.pending')?.frame as number[])[1]!,
    subscription: (out(33)[0]?.frame as number[])[2]!,
    registration: (registered[0]?.frame as number[])[2]!,
    invocation: (out(68)[0]?.frame as number[])[1]!,
  };
  expect(
    Object.values(ids).every((v) => typeof v === 'number'),
    JSON.stringify(ids),
  ).toBe(true);
  expect(inFrames(c, 49)).toHaveLength(1);
  const state: State = {
    callInFlight: true,
    invocationRunning: true,
    subscriptionActive: true,
    registrationActive: true,
    pendingSubscribe: true,
    granted: undefined,
    retired: new Set(),
    deferred: [],
    ended: false,
  };
  return { h, c, ids, state, ops, recorded };
}

// --- frames and their expected effects ----------------------------------------------------------------------------

type Target = keyof Ids | 'unknown';

interface Fuzzed {
  readonly frame: unknown;
  /** The text sent (a frame serialized, or garbage). */
  readonly text: string;
  readonly label: string;
}

/** What processing a frame must do in an established session, given what it targets. */
interface Effect {
  /** Message types (and for ERROR/GOODBYE, URIs) the client writes in that step, in order. */
  readonly writes: readonly string[];
  readonly ends: boolean;
  /** Something is delivered to the app in that step (a settled op, an event, a revocation). */
  readonly delivers: boolean;
  readonly update?: (s: State) => void;
}

const ids = (t: Target, x: Ids): number => (t === 'unknown' ? 987654321 : x[t]);

const idArb = (x: Ids): fc.Arbitrary<unknown> =>
  fc.oneof(
    {
      weight: 12,
      arbitrary: fc
        .constantFrom<Target>(
          'call',
          'cancelled',
          'pendingSubscribe',
          'subscription',
          'registration',
          'invocation',
          'unknown',
        )
        .map((t) => ids(t, x)),
    },
    { weight: 1, arbitrary: fc.constantFrom(...MUTATIONS.id) },
  );

/** A frame of `spec` whose id fields aim at live ids, with field mutations, cut-offs and extra elements. */
function specFrame(spec: FrameSpec, x: Ids): fc.Arbitrary<unknown[]> {
  return fc
    .record({
      values: fc.tuple(
        ...spec.fields.map((f) =>
          f.kind === 'id'
            ? idArb(x)
            : fc.oneof(
                { weight: 4, arbitrary: fc.constant(structuredClone(f.valid)) },
                { weight: 1, arbitrary: fc.constantFrom(...MUTATIONS[f.kind]) },
              ),
        ),
      ),
      cut: fc.oneof({ weight: 12, arbitrary: fc.constant(-1) }, { weight: 1, arbitrary: fc.nat(spec.fields.length) }),
      extra: fc.oneof(
        { weight: 6, arbitrary: fc.constant<unknown[]>([]) },
        { weight: 1, arbitrary: fc.array(fc.jsonValue(), { maxLength: 2 }) },
      ),
    })
    .map(({ values, cut, extra }) => {
      const frame = [spec.type, ...values, ...extra];
      return cut >= 0 ? frame.slice(0, cut + 1) : frame;
    });
}

function fuzzedArb(x: Ids): fc.Arbitrary<Fuzzed> {
  const specs = FRAME_SPECS.map((spec) => specFrame(spec, x).map((f) => ({ frame: f, label: spec.name })));
  const errors = fc
    .record({
      requestType: fc.constantFrom(48, 49, 32, 64, 16, 34, 66, 8, 68, 70),
      target: fc.constantFrom<Target>('call', 'cancelled', 'pendingSubscribe', 'unknown'),
      uri: fc.constantFrom(
        'wamp.error.canceled',
        'wamp.error.not_authorized',
        'wamp.error.no_such_procedure',
        'com.err.x',
      ),
      payload: fc.constantFrom<unknown[]>([], [['why']], [['why'], { k: 1 }], ['not args'], [[], 'not kwargs']),
    })
    .map(({ requestType, target, uri, payload }) => ({
      frame: [8, requestType, ids(target, x), {}, uri, ...payload],
      label: `ERROR(${String(requestType)}) ${target}`,
    }));
  const closing = fc
    .record({
      type: fc.constantFrom(...CLOSING_TYPES.map((t) => t.type)),
      a: fc.oneof(fc.constant<unknown>({}), fc.constant<unknown>('wamp.close.killed'), fc.jsonValue()),
      b: fc.oneof(fc.constant<unknown>('wamp.close.system_shutdown'), fc.constant<unknown>({}), fc.jsonValue()),
    })
    .map(({ type, a, b }) => ({ frame: [type, a, b], label: type === 3 ? 'ABORT' : 'GOODBYE' }));
  const outOfState = fc.constantFrom(
    { frame: [2, 1, {}], label: 'WELCOME in session' },
    { frame: [4, 'ticket', {}], label: 'CHALLENGE in session' },
    { frame: [35, 0, { subscription: x.subscription }], label: 'revocation (live)' },
    { frame: [35, 0, { subscription: 987654321 }], label: 'revocation (unknown)' },
    { frame: [67, 0, { registration: x.registration }], label: 'registration revocation (live)' },
    { frame: [67, 0, { registration: 987654321 }], label: 'registration revocation (unknown)' },
    { frame: [69, x.invocation, { mode: 'killnowait' }], label: 'INTERRUPT killnowait (live)' },
    { frame: [69, x.invocation, {}], label: 'INTERRUPT {} (live)' },
    { frame: [68, x.invocation, x.registration, {}, [1]], label: 'INVOCATION duplicate id' },
    { frame: [33, x.pendingSubscribe, 5555], label: 'SUBSCRIBED (pending)' },
    { frame: [50, x.cancelled, {}, ['late']], label: 'RESULT for a cancelled call' },
  );
  const types = fc
    .oneof(fc.integer({ min: 0, max: 1023 }), fc.constantFrom(...CLIENT_ONLY), fc.constantFrom(7, 256, 1023))
    .map((t) => ({ frame: [t, 1, {}], label: `type ${String(t)}` }));
  const json = fc.jsonValue().map((v) => ({ frame: v, label: 'any JSON' }));
  const structured = fc
    .oneof(
      { weight: 10, arbitrary: fc.oneof(...specs) },
      { weight: 5, arbitrary: errors },
      { weight: 1, arbitrary: closing },
      { weight: 4, arbitrary: outOfState },
      { weight: 2, arbitrary: types },
      { weight: 1, arbitrary: json },
    )
    .map(({ frame, label }) => ({ frame, label, text: JSON.stringify(frame) }));
  const garbage = fc
    .oneof(fc.string(), fc.constantFrom('[', '{}', 'null', '"x"', '[1,', 'NaN', '[NaN]', '\u0000'))
    .map((text) => ({ frame: undefined, label: 'garbage', text }));
  return fc.oneof({ weight: 19, arbitrary: structured }, { weight: 1, arbitrary: garbage });
}

/** The decode class of the text as the client's JSON serializer reads it (NaN tokens are revived). */
function decodeClass(f: Fuzzed): Expected {
  let value: unknown;
  try {
    value = JSON.parse(f.text);
  } catch {
    return { kind: 'fatal' }; // not JSON: the serializer throws (header-fatal)
  }
  if (!Array.isArray(value) || value.length === 0 || !Number.isInteger(value[0])) return { kind: 'fatal' };
  const frame = value as unknown[];
  const type = frame[0] as number;
  if (type === 3 || type === 6) return expectedClosing(type, frame);
  const spec = FRAME_SPECS.find((s) => s.type === type);
  if (spec === undefined) return { kind: 'dropped' }; // unknown, client-only, HEARTBEAT, 256–1023
  return expectedFor(spec, frame);
}

const NOTHING: Effect = { writes: [], ends: false, delivers: false };

/** What an established client does with a decoded message, given its records. */
function effectOf(f: Fuzzed, x: Ids, s: State): Effect {
  const cls = decodeClass(f);
  if (cls.kind === 'fatal') return { writes: ['3:wamp.error.protocol_violation'], ends: true, delivers: true };
  if (cls.kind === 'dropped') return NOTHING;
  const m = cls.fields as Record<string, unknown>;
  const invalid = cls.invalid;
  switch (m['type']) {
    case 2:
    case 4:
      return NOTHING;
    case 3:
      return { writes: [], ends: true, delivers: true };
    case 6:
      return { writes: ['6:wamp.close.goodbye_and_out'], ends: true, delivers: true };
    case 8: {
      const rt = m['requestType'];
      const rid = m['requestId'];
      if ((rt === 48 || rt === 49) && rid === x.call && s.callInFlight) {
        return { writes: [], ends: false, delivers: true, update: (st) => void (st.callInFlight = false) };
      }
      if (rt === 32 && rid === x.pendingSubscribe && s.pendingSubscribe) {
        return {
          writes: s.deferred.map(() => '34'), // no SUBSCRIBE pending any more: the deferred withdrawals
          ends: false,
          delivers: true,
          update: (st) => {
            st.pendingSubscribe = false;
            st.deferred = [];
          },
        };
      }
      return NOTHING;
    }
    case 50: {
      const rid = m['requestId'];
      if (rid !== x.call || !s.callInFlight) return NOTHING;
      const progress = (m['details'] as Record<string, unknown>)['progress'] === true;
      if (progress && !invalid) return NOTHING; // unrequested progress: ignored
      return { writes: [], ends: false, delivers: true, update: (st) => void (st.callInFlight = false) };
    }
    case 33: {
      const sub = m['subscriptionId'];
      if (m['requestId'] !== x.pendingSubscribe || !s.pendingSubscribe) {
        // no SUBSCRIBE of this session is pending for it: withdrawn, unless a key holds the id (a duplicate),
        // it is withdrawn already, or it is 0 (no id an UNSUBSCRIBE may name)
        const held = (sub === x.subscription && s.subscriptionActive) || (s.granted !== undefined && sub === s.granted);
        if (sub === 0 || held || s.deferred.includes(sub)) return NOTHING;
        if (s.pendingSubscribe) return { ...NOTHING, update: (st) => void st.deferred.push(sub) }; // Crossbar may reuse it
        return { writes: ['34'], ends: false, delivers: false };
      }
      // the key has its local: active with that id (nothing written for it); the other deferred ids are withdrawn now
      return {
        writes: s.deferred.filter((d) => d !== sub).map(() => '34'),
        ends: false,
        delivers: false,
        update: (st) => {
          st.pendingSubscribe = false;
          st.granted = sub;
          st.deferred = [];
        },
      };
    }
    case 65: {
      // no REGISTER is pending in this setup: withdrawn, unless a record holds the id (a duplicate), it was
      // withdrawn already, or it is 0
      const reg = m['registrationId'];
      if (reg === 0 || (reg === x.registration && s.registrationActive) || s.retired.has(reg)) return NOTHING;
      return { writes: ['66'], ends: false, delivers: false, update: (st) => void st.retired.add(reg) };
    }
    case 35:
      if (m['revocation'] === true) {
        const id = m['subscriptionId'];
        const active = (id === x.subscription && s.subscriptionActive) || (s.granted !== undefined && id === s.granted);
        // the router dropped a deferred one itself: never UNSUBSCRIBEd
        if (!active) return { ...NOTHING, update: (st) => void (st.deferred = st.deferred.filter((d) => d !== id)) };
        return {
          writes: [],
          ends: false,
          delivers: true,
          update: (st) => {
            if (id === x.subscription) st.subscriptionActive = false;
            if (id === st.granted) st.granted = undefined;
          },
        };
      }
      return NOTHING;
    case 67:
      if (m['revocation'] === true) {
        if (m['registrationId'] !== x.registration || !s.registrationActive) return NOTHING;
        return { writes: [], ends: false, delivers: true, update: (st) => void (st.registrationActive = false) };
      }
      return NOTHING;
    case 36: {
      const id = m['subscriptionId'];
      const active = (id === x.subscription && s.subscriptionActive) || (s.granted !== undefined && id === s.granted);
      if (!active) return NOTHING;
      return { writes: [], ends: false, delivers: !invalid };
    }
    case 68: {
      const rid = m['requestId'];
      const reg = m['registrationId'];
      if (rid === x.invocation && s.invocationRunning) return NOTHING; // a duplicate of a running invocation
      if (reg !== x.registration || !s.registrationActive) {
        // no record holds it: answered, and withdrawn once (not id 0)
        if (reg === 0 || s.retired.has(reg))
          return { writes: ['8:wamp.error.no_such_registration'], ends: false, delivers: false };
        return {
          writes: ['8:wamp.error.no_such_registration', '66'],
          ends: false,
          delivers: false,
          update: (st) => void st.retired.add(reg),
        };
      }
      if (invalid) return { writes: ['8:wamp.error.invalid_argument'], ends: false, delivers: false };
      return { writes: [], ends: false, delivers: true }; // the handler runs in a delivery; its YIELD comes later
    }
    case 69: {
      if (m['requestId'] !== x.invocation || !s.invocationRunning) return NOTHING;
      const kill = (m['options'] as Record<string, unknown>)['mode'] === 'killnowait';
      return {
        writes: kill ? [] : ['8:wamp.error.canceled'],
        ends: false,
        delivers: true,
        update: (st) => void (st.invocationRunning = false),
      };
    }
    default:
      return NOTHING; // PUBLISHED, UNSUBSCRIBED, UNREGISTERED for ids with nothing pending
  }
}

function describeWrite(frame: readonly unknown[]): string {
  if (frame[0] === 8) return `8:${String(frame[4])}`;
  if (frame[0] === 3 || frame[0] === 6) return `${String(frame[0])}:${String(frame[2])}`;
  return String(frame[0]);
}

// --- the properties -----------------------------------------------------------------------------------------------

describe('inbound frames into a live client', () => {
  test('established session: every frame has exactly its expected effect; nothing escapes; invariants hold', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 30 }), fc.nat(), async (seed, pick) => {
        const setup = await established(seed);
        const { h, c, ids: x, state, ops } = setup;
        const frames =
          fc.sample(fc.array(fuzzedArb(x), { minLength: 1, maxLength: 20 }), { numRuns: 1, seed: seed ^ pick })[0] ??
          [];
        const invocationIds = new Set<unknown>([x.invocation]);
        for (const f of frames) {
          if (state.ended) break;
          if (Array.isArray(f.frame) && f.frame[0] === 68) {
            const id: unknown = f.frame[1];
            // a router that reuses an INVOCATION id is not what this tests, and the decoder accepts id 0 (revocations
            // use it), so an INVOCATION 0 is answered with id 0 — both of which the router's oracle flags; the
            // live running one (a duplicate) is still sent
            if (id === 0 || (invocationIds.has(id) && !(id === x.invocation && state.invocationRunning))) continue;
            invocationIds.add(id);
          }
          const effect = effectOf(f, x, state);
          const before = c.trace();
          const lastStep = before.inputs.at(-1)?.stepId ?? 0;
          c.connection.sendRaw(f.text);
          await h.clock.advance(0);
          const after = c.trace();
          const step = after.inputs.find((i) => i.stepId > lastStep && i.input === 'ws.message');
          expect(step, `${f.label} ${f.text.slice(0, 120)}: never processed`).toBeDefined();
          const writes = after.frames
            .filter((e) => e.direction === 'in' && e.stepId === step?.stepId && Array.isArray(e.frame))
            .map((e) => describeWrite(e.frame as unknown[]));
          const where = `${f.label}: ${f.text.slice(0, 160)}`;
          expect(writes, where).toEqual(effect.writes);
          const ended = after.closeInfos.length > before.closeInfos.length;
          expect(ended, `${where}: end`).toBe(effect.ends);
          if (!effect.delivers) {
            const delivered = after.notifications.filter((n) => n.stepId === step?.stepId);
            expect(
              delivered.map((n) => `${n.stream} ${n.notification}`),
              `${where}: deliveries`,
            ).toEqual([]);
          }
          effect.update?.(state);
          if (effect.ends) state.ended = true;
        }
        if (state.ended) {
          // exactly one reconnect after the end
          await h.clock.advance(5000);
          const statuses = (c.status?.values ?? []).map((s) => s.state);
          const last = statuses.lastIndexOf('closed');
          expect(statuses.slice(last + 1, last + 2)).toEqual(['connecting']);
        }
        await h.closeAndSettle();
        expect(h.problems(), 'the harness checks').toEqual([]);
        for (const r of setup.recorded) expect(r.closed, 'every op and interest settles after close()').toBe(true);
        const trace = c.trace();
        const found = checkInvariants(trace, { ops, timings: { idle: 0, request: 600000 }, final: true });
        expect(found, formatViolations(found, trace)).toEqual([]);
        expect(trace.logs.filter((l) => l.entry.event === 'internal').map((l) => l.entry.message)).toEqual([]);
        expect(escaped).toEqual([]);
      }),
      { ...replayParameters() },
    );
  });

  test('handshake (HELLO sent, unanswered): nothing but ABORT is ever written for a fuzzed frame before WELCOME', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fuzzedArb({ call: 1, cancelled: 2, pendingSubscribe: 3, subscription: 4, registration: 5, invocation: 6 }),
        async (seed, f) => {
          const h = createHarness({ seed, router: { dialect: 'thruway-php' }, checks: { unscripted: false } });
          const silent = h.router.ignore((frame) => frame[0] === 1);
          const c = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0, handshake: 60000 } } });
          c.open();
          await h.clock.advance(0);
          c.connection.sendRaw(f.text);
          await h.clock.advance(0);
          const writes = c
            .trace()
            .frames.filter((e) => e.direction === 'in' && Array.isArray(e.frame))
            .map((e) => (e.frame as unknown[])[0]);
          const cls = decodeClass(f);
          const type = cls.kind === 'message' ? (cls.fields as Record<string, unknown>)['type'] : undefined;
          if (cls.kind === 'fatal')
            expect(writes).toEqual([1, 3]); // HELLO, ABORT protocol_violation
          else if (type === 2)
            expect(writes.slice(0, 1)).toEqual([1]); // a WELCOME: the session starts
          else if (type === 4)
            expect(writes).toEqual([1, 3]); // a CHALLENGE without onChallenge: ABORT cannot_authenticate
          else expect(writes).toEqual([1]); // everything else: dropped (or the attempt ends without a reply)
          silent();
          await h.closeAndSettle();
          expect(h.problems(), 'the harness checks').toEqual([]);
          const trace = c.trace();
          const found = checkInvariants(trace, { timings: { idle: 0 }, final: true }, [
            'INV-CL01',
            'INV-CL02',
            'INV-AUTH',
            'INV-R7',
            'INV-R6',
          ]);
          expect(found, formatViolations(found, trace)).toEqual([]);
          expect(trace.logs.filter((l) => l.entry.event === 'internal')).toEqual([]);
          expect(escaped).toEqual([]);
        },
      ),
      { ...replayParameters() },
    );
  });

  test('lingering after close(): fuzzed frames never make the client write anything', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.array(
          fuzzedArb({ call: 1, cancelled: 2, pendingSubscribe: 3, subscription: 4, registration: 5, invocation: 6 }),
          { minLength: 1, maxLength: 6 },
        ),
        async (seed, frames) => {
          const h = createHarness({ seed, router: { dialect: 'thruway-php' }, checks: { unscripted: false } });
          const c = h.makeClient(Client, { options: { autoOpen: false, timeouts: { idle: 0 } } });
          c.open();
          await h.clock.advance(0);
          const quiet = h.router.ignore((frame) => frame[0] === 6); // the GOODBYE is never answered: the socket lingers
          const closing = c.close();
          const written = c.trace().frames.filter((e) => e.direction === 'in').length;
          for (const f of frames) c.connection.sendRaw(f.text);
          await h.clock.advance(0);
          expect(c.trace().frames.filter((e) => e.direction === 'in').length).toBe(written);
          await h.clock.advance(3000);
          await closing;
          quiet();
          await h.closeAndSettle();
          expect(h.problems(), 'the harness checks').toEqual([]);
          const trace = c.trace();
          const found = checkInvariants(trace, { timings: { idle: 0 }, final: true });
          expect(found, formatViolations(found, trace)).toEqual([]);
          expect(escaped).toEqual([]);
        },
      ),
      { ...replayParameters() },
    );
  });
});
