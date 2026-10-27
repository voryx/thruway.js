// Dialect fidelity: the router probes (test/helpers/probes.ts)
// run against each dialect of the reference router on the virtual clock, and every probe's result is compared with
// what the real router answered (test/fixtures/probes/, vendored unchanged but for whitespace). Before comparing,
// both sides are normalised to their deterministic fields:
// - router-made ids (session, subscription, registration, publication, invocation ids, and the `caller`, `publisher`,
//   `callee`, `session` details) are renamed `#1`, `#2`, … in order of appearance within the probe, so "the same id"
//   and "another id" survive while the values do not;
// - the probes' unique URI suffixes, random authids, CHALLENGE strings (nonces, timestamps), timings (`ms`,
//   `afterMs`, "after 512ms"), close reasons (Python error texts) and Crossbar's English router error messages
//   (`wamp.error.*` ERROR args; `canceled` keeps its args) are masked;
// - a frame summary truncated by the probe ("…" / "...") is compared by message type only.
// Probes that need what the simulation does not model (meta APIs, meta events, event retention, …) are listed under
// `notModelled` with the reason, and random outcomes (`invoke: 'random'`) under `random`: nothing is skipped silently.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createRouter,
  createSimClock,
  type DialectName,
  type QuirkFlags,
  type SimAuthProvider,
  type SimRouterOptions,
} from '../../src/testing/sim.js';
import {
  CROSSBAR_PROBE_NAMES,
  parseQuirksB,
  PROBE_C_NAMES,
  type ProbeEnv,
  QUIRKS_B_NAMES,
  runCrossbarProbes,
  runProbeC,
  runQuirksB,
} from '../helpers/probes.js';

type Json = Record<string, unknown>;

const FIXTURES = new URL('../fixtures/probes/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

// --- normalisation ----------------------------------------------------------------------------------------------

const NAMES: Readonly<Record<string, number>> = {
  WELCOME: 2,
  ABORT: 3,
  CHALLENGE: 4,
  GOODBYE: 6,
  ERROR: 8,
  PUBLISHED: 17,
  SUBSCRIBED: 33,
  UNSUBSCRIBED: 35,
  EVENT: 36,
  RESULT: 50,
  REGISTERED: 65,
  UNREGISTERED: 67,
  INVOCATION: 68,
  INTERRUPT: 69,
};
/** Router-made ids per message type (element positions). */
const ID_AT: Readonly<Record<number, readonly number[]>> = {
  2: [1],
  17: [2],
  33: [2],
  36: [1, 2],
  65: [2],
  68: [1, 2],
  69: [1],
};
/** Where the details dict is, per message type. */
const DETAILS_AT: Readonly<Record<number, number>> = { 2: 2, 8: 3, 36: 3, 50: 2, 68: 3 };
const ID_KEYS: ReadonlySet<string> = new Set(['caller', 'publisher', 'callee', 'session']);
const RANDOM_KEYS: ReadonlySet<string> = new Set([
  'caller_authid',
  'publisher_authid',
  'callee_authid',
  'x_cb_peer',
  'x_cb_pid',
  'authextra',
  'transport',
]);
const TIMING_KEYS: ReadonlySet<string> = new Set(['desc', 'ms', 'after_ms', 'afterMs', 'callerLatencyMs', 'at']);
const ID_FIELDS: ReadonlySet<string> = new Set(['caller_session', 'joiner_session']);

/** probe-c's unique names (`mvo9x5i4_3g19up`, ours `t000123_abc12`) and crossbar's (`com.thruway.probe.x.b8kd9r`). */
function deUnique(text: string): string {
  return text
    .replace(/_(?=[0-9a-z]*\d)[0-9a-z]{6,9}_[0-9a-z]{1,7}(?![0-9a-z])/g, '_<uniq>')
    .replace(/(com\.thruway\.probe\.[A-Za-z0-9_]+)\.[0-9a-z]{6}(?![0-9a-z])/g, '$1.<uniq>');
}

class Ids {
  private readonly names = new Map<unknown, string>();
  name(value: unknown): unknown {
    if (typeof value !== 'number') return value;
    let name = this.names.get(value);
    if (name === undefined) {
      name = `#${String(this.names.size + 1)}`;
      this.names.set(value, name);
    }
    return name;
  }
}

interface Style {
  /** Drop the args of router ERRORs (`wamp.error.*` but `canceled`): Crossbar's English messages. */
  readonly routerErrorArgs?: boolean;
}

function isDict(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maskDetails(details: Json, ids: Ids, welcome: boolean): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(details)) {
    if (RANDOM_KEYS.has(key) || (welcome && key === 'authid')) out[key] = '#';
    else if (ID_KEYS.has(key)) out[key] = ids.name(value);
    else out[key] = value;
  }
  return out;
}

function maskFrame(frame: unknown[], ids: Ids, style: Style): unknown[] {
  const type = frame[0] as number;
  const out = [...frame];
  for (const at of ID_AT[type] ?? []) out[at] = ids.name(out[at]);
  if (type === 8 && (frame[1] === 68 || frame[1] === 8)) out[2] = ids.name(out[2]);
  if (type === 4 && isDict(out[2]) && 'challenge' in out[2] && typeof out[2]['challenge'] === 'string')
    out[2] = { ...out[2], challenge: '#challenge' };
  const at = DETAILS_AT[type];
  if (at !== undefined && isDict(out[at])) out[at] = maskDetails(out[at], ids, type === 2);
  if (
    style.routerErrorArgs === true &&
    type === 8 &&
    typeof out[4] === 'string' &&
    out[4].startsWith('wamp.error.') &&
    out[4] !== 'wamp.error.canceled'
  ) {
    out.length = 5;
  }
  return out.map((v) => clean(v, ids, style));
}

/** A frame summary "NAME [json]" (probe-c, crossbar) as a structure; a truncated one by its type only. */
function frameSummary(text: string, ids: Ids, style: Style): unknown {
  const m = /^([A-Z]+) (\[.*)$/s.exec(text);
  if (m === null) return undefined;
  const [, name, json] = m as unknown as [string, string, string];
  if (!(name in NAMES)) return undefined;
  try {
    const frame: unknown = JSON.parse(json);
    return { [name]: maskFrame(frame as unknown[], ids, style) };
  } catch {
    return { [name]: 'truncated' };
  }
}

function cleanString(text: string, ids: Ids, style: Style): unknown {
  // crossbar: "desc | socket closed 1011 "reason"" and "| socket: closed 1002 "reason""
  const parts = text.split(' | ');
  if (parts.length > 1) return parts.map((p) => cleanString(p, ids, style));
  const closed = /^(socket:? closed \d+)/.exec(text);
  if (closed !== null) return closed[1];
  if (/^closed \d+ /.test(text)) return text.slice(0, text.indexOf(' ', 7));
  const summary = frameSummary(text, ids, style);
  if (summary !== undefined) return summary;
  return deUnique(text)
    .replace(/after \d+ms/g, 'after #ms')
    .replace(/INTERRUPT:(\{[^}]*\})/g, (_all, json: string) => `INTERRUPT:${canonical(JSON.parse(json))}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isDict(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function clean(value: unknown, ids: Ids, style: Style, key?: string): unknown {
  if (typeof value === 'string') return cleanString(value, ids, style);
  if (Array.isArray(value)) return value.map((v) => clean(v, ids, style));
  if (!isDict(value)) return key !== undefined && ID_FIELDS.has(key) ? ids.name(value) : value;
  if (key === 'closed' || key === 'closed_by_router' || key === 'callerClosed') {
    return { code: value['code'] }; // close reasons: Python/PHP texts
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (TIMING_KEYS.has(k)) continue;
    if (key === 'sub_ids') out[String(ids.name(Number(k)))] = v;
    else if (key === 'regs') out[k] = '#';
    else if (ID_KEYS.has(k) || ID_FIELDS.has(k)) out[k] = ids.name(v);
    else if (RANDOM_KEYS.has(k)) out[k] = '#';
    else out[deUnique(k)] = clean(v, ids, style, k);
  }
  return out;
}

/** Where the recorded side was truncated by the probe, compare the simulated side by message type only too. */
function alignTruncation(actual: unknown, expected: unknown): unknown {
  if (isDict(expected) && isDict(actual)) {
    const [name] = Object.keys(expected);
    if (name !== undefined && expected[name] === 'truncated' && Object.keys(actual).length === 1 && name in actual) {
      return { [name]: 'truncated' };
    }
    return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, alignTruncation(v, expected[k])]));
  }
  if (Array.isArray(expected) && Array.isArray(actual)) return actual.map((v, i) => alignTruncation(v, expected[i]));
  return actual;
}

function normalize(probe: unknown, style: Style, mask: readonly string[] = []): unknown {
  const value: unknown = isDict(probe)
    ? Object.fromEntries(Object.entries(probe).filter(([k]) => !mask.includes(k)))
    : probe;
  return clean(value, new Ids(), style);
}

// --- the cases --------------------------------------------------------------------------------------------------

interface Case {
  readonly title: string;
  readonly dialect: DialectName;
  readonly set: 'probe-c' | 'quirks-b' | 'crossbar';
  readonly fixture: string;
  readonly realm?: string;
  readonly router?: Omit<SimRouterOptions, 'clock' | 'dialect'>;
  readonly quirks?: Partial<QuirkFlags>;
  readonly style?: Style;
  /** Probe (or `probe.field`) ⇒ why the simulation does not model it. */
  readonly notModelled?: Readonly<Record<string, string>>;
  /** Probe ⇒ fields that are random on the real router (masked on both sides). */
  readonly random?: Readonly<Record<string, readonly string[]>>;
  /** Probe ⇒ every outcome the real router was seen to give (it is not deterministic there): the recording and the
   *  simulation must each be one of them. */
  readonly alternatives?: Readonly<Record<string, readonly string[]>>;
}

/** The providers of routers/thruway-php/router.php: WAMP-CRA, then ticket, on realm1 and realm-auth; realm1 also lets
 *  anonymous HELLOs in (its LenientAuthenticationManager). */
const THRUWAY_PROVIDERS: readonly SimAuthProvider[] = [
  {
    method: 'wampcra',
    realms: ['realm1', 'realm-auth'],
    extra: (hello) => ({
      challenge: JSON.stringify({ authid: hello.details['authid'], authrole: 'user', nonce: 'n', timestamp: 't' }),
      challenge_method: 'wampcra',
    }),
    verify: () => false,
  },
  {
    method: 'ticket',
    realms: ['realm1', 'realm-auth'],
    extra: () => ({ challenge: {}, challenge_method: 'ticket' }),
    verify: () => false,
  },
  { method: 'anonymous', realms: ['realm1'] },
];

/** fox-wamp's router.cjs: wampcra and ticket (static users), anonymous HELLOs on realm1. */
const FOX_PROVIDERS: readonly SimAuthProvider[] = [
  {
    method: 'wampcra',
    extra: (hello) => ({ challenge: JSON.stringify({ authid: hello.details['authid'], nonce: 'n' }) }),
    verify: () => false,
  },
  { method: 'ticket', verify: () => false },
  { method: 'anonymous', realms: ['realm1'] },
];

const PROBE_C_THRUWAY_UNMODELLED = {
  meta_events: "Thruway's legacy session meta events (wamp.metaevent.session.on_join/on_leave) are not modelled",
};

/** Nexus main loses its closing frames most of the time, not always: what 12 live runs on realm1 and 6 on realm1.strict
 *  (2026-10-26, test/helpers/probes.ts against nexus main 0ddca09) answered besides the recording. */
const NEXUS_ABORT_OR_LOST = ['closed(1006)', 'ABORT(wamp.error.protocol_violation) closed(1000:goodbye)'];
const NEXUS_GOODBYE_OR_LOST = ['closed(1006)', 'GOODBYE(wamp.close.goodbye_and_out) closed(1000:goodbye)'];

const CASES: readonly Case[] = [
  {
    title: 'Thruway PHP 0.6.1, auth router, realm1',
    dialect: 'thruway-php',
    set: 'probe-c',
    fixture: 'probe-c.thruway-php.realm1.json',
    router: { providers: THRUWAY_PROVIDERS },
    notModelled: PROBE_C_THRUWAY_UNMODELLED,
    random: { shared_random: ['results', 'counts'] },
  },
  {
    title: 'Thruway PHP 0.6.1, noauth router (no AuthenticationManager)',
    dialect: 'thruway-php',
    set: 'probe-c',
    fixture: 'probe-c.thruway-php.noauth.json',
    router: { authManager: 'none' },
  },
  {
    title: 'fox-wamp 0.7.28, realm1',
    dialect: 'fox-wamp',
    set: 'probe-c',
    fixture: 'probe-c.fox-wamp.realm1.json',
    router: { providers: FOX_PROVIDERS },
    notModelled: {
      meta_api: "fox-wamp's session meta API (wamp.session.count/list) is not modelled",
      meta_events: "fox-wamp's session meta events are not modelled",
      retained_fox: "fox-wamp's custom event retention (PUBLISH retain + SUBSCRIBE retained) is not modelled",
    },
    random: { shared_random: ['results', 'counts'] },
  },
  {
    title: 'wamp-server 0.0.9, realm1',
    dialect: 'wamp-server',
    set: 'probe-c',
    fixture: 'probe-c.wamp-server.realm1.json',
    router: { realms: ['realm1'] },
  },
  {
    title: 'Bondy 1.0.0-rc.65, realm1',
    dialect: 'bondy',
    set: 'quirks-b',
    fixture: 'quirks-b.bondy.txt',
    router: { realms: ['realm1'] },
    notModelled: {
      'payload-20MiB':
        'Bondy closes an 8 MB frame with 1009 but dropped the 20 MiB one with 1006: the simulation closes every frame over its limit with 1009',
    },
  },
  {
    title: 'Nexus main, realm1',
    dialect: 'nexus',
    set: 'quirks-b',
    fixture: 'quirks-b.nexus-main.txt',
    router: { realms: ['realm1'] },
    notModelled: { 'router-goodbye-via-kill': "Nexus's session meta API (wamp.session.kill) is not modelled" },
    alternatives: { 'call-before-hello': NEXUS_ABORT_OR_LOST, 'goodbye-close-code': NEXUS_GOODBYE_OR_LOST },
  },
  {
    title: 'Nexus main, realm1.strict (strict_request_ids)',
    dialect: 'nexus',
    set: 'quirks-b',
    fixture: 'quirks-b.nexus-main.realm1-strict.txt',
    realm: 'realm1.strict',
    router: { realms: ['realm1.strict'] },
    quirks: { strict_ids: true },
    notModelled: { 'router-goodbye-via-kill': "Nexus's session meta API (wamp.session.kill) is not modelled" },
    alternatives: {
      'double-hello': NEXUS_ABORT_OR_LOST,
      'request-id-0': NEXUS_ABORT_OR_LOST,
      'request-id-non-sequential': NEXUS_ABORT_OR_LOST,
      'goodbye-close-code': NEXUS_GOODBYE_OR_LOST,
      'message-after-goodbye': NEXUS_GOODBYE_OR_LOST,
    },
  },
  {
    title: 'Nexus 3.3.1, realm1 (ignores invalid JSON and unknown types)',
    dialect: 'nexus',
    set: 'quirks-b',
    fixture: 'quirks-b.nexus-3.3.1.txt',
    router: { realms: ['realm1'] },
    quirks: {
      violations: {
        'before-hello': 'drop',
        'second-hello': 'drop',
        'malformed-hello': 'drop',
        'invalid-json': 'ignore',
        'unknown-type': 'ignore',
        malformed: 'drop',
        binary: 'ignore',
      },
    },
    notModelled: { 'router-goodbye-via-kill': "Nexus's session meta API (wamp.session.kill) is not modelled" },
  },
  {
    title: 'Crossbar 26.10.1, realm1 on /ws',
    dialect: 'crossbar',
    set: 'crossbar',
    fixture: 'crossbar.probe-results.json',
    router: { realms: ['realm1'] },
    style: { routerErrorArgs: true },
    random: { shared_registration: ['random'] },
    notModelled: {
      progressive_call_invocations: 'progressive call invocations (CALL with progress) are not modelled',
      event_retention: 'event retention (PUBLISH retain, SUBSCRIBE get_retained) is not modelled',
      publisher_exclusion_and_bw_listing: "needs Crossbar's /auth ticket principals and their roles",
      disclosure: "needs Crossbar's role-based disclosure settings",
      session_meta_api: "Crossbar's session meta API is not modelled",
      registration_and_subscription_meta_api: "Crossbar's registration/subscription meta API is not modelled",
      testament: "Crossbar's testament meta API is not modelled",
      event_history: "Crossbar's event history is not modelled",
      registration_leak_race:
        "a Crossbar bug (registrations leaking when caller and callee leave together): the ghost is modelled by the fake socket's freeze/vanish instead",
      session_establishment_errors: "needs Crossbar's /auth and /any endpoints and its principals",
      auto_ping_keepalive: "router WebSocket pings (/ws-ping) are below the fake socket's level",
      payload_fidelity: "Python's arbitrary-precision integers and NaN tokens are not modelled",
      'error_semantics.not_authorized_register': "Crossbar's role-based authorization of the 'limited' ticket user",
      'error_semantics.not_authorized_publish': "Crossbar's role-based authorization of the 'limited' ticket user",
      'error_semantics.not_authorized_publish_unacknowledged':
        "Crossbar's role-based authorization of the 'limited' ticket user",
      'error_semantics.not_authorized_call_outside_prefix':
        "Crossbar's role-based authorization of the 'limited' ticket user",
      'error_semantics.authorized_subscribe_in_prefix':
        "Crossbar's role-based authorization of the 'limited' ticket user",
      'error_semantics.register_camelCase_strict_realm2': "realm2's strict URI check (uri_check: strict)",
      'protocol_violations.oversize_message_ws_ping': "the 64 KiB limit of Crossbar's /ws-ping endpoint",
    },
  },
];

function ported(c: Case): readonly string[] {
  return c.set === 'probe-c' ? PROBE_C_NAMES : c.set === 'quirks-b' ? QUIRKS_B_NAMES : CROSSBAR_PROBE_NAMES;
}

/** The probes of a set that the fixture recorded, minus the ones not modelled. */
function names(c: Case, recorded: Json): string[] {
  return ported(c).filter((n) => n in recorded && !(n in (c.notModelled ?? {})));
}

/** The fields of `probe` that are not modelled. */
function unmodelledFields(c: Case, probe: string): string[] {
  return Object.keys(c.notModelled ?? {})
    .filter((k) => k.startsWith(`${probe}.`))
    .map((k) => k.slice(probe.length + 1));
}

function recordedOf(c: Case): Json {
  if (c.set === 'quirks-b') return parseQuirksB(fixture(c.fixture));
  const parsed = JSON.parse(fixture(c.fixture)) as Json;
  return (c.set === 'probe-c' ? parsed['probes'] : parsed) as Json;
}

async function simulate(c: Case, only: readonly string[]): Promise<Json> {
  const clock = createSimClock({ seed: 5 });
  const router = createRouter({ ...c.router, dialect: c.dialect, quirks: c.quirks, clock: clock.scope('router') });
  const timers = clock.scope('probe');
  const env: ProbeEnv = {
    WebSocket: router.WebSocket,
    url: router.url,
    realm: c.realm ?? 'realm1',
    sleep: (ms) => clock.advance(ms),
    setTimeout: (fn, ms) => {
      timers.setTimeout(fn, ms);
    },
    now: () => clock.now(),
    random: clock.fork('probe-names'),
  };
  const options = { only };
  const run = c.set === 'probe-c' ? runProbeC : c.set === 'quirks-b' ? runQuirksB : runCrossbarProbes;
  const result = await run(env, options);
  expect(router.errors).toEqual([]); // the router never failed internally
  return result;
}

for (const c of CASES) {
  describe(`${c.title} — ${c.dialect} dialect vs ${c.fixture}`, () => {
    const recorded = recordedOf(c);
    const probes = names(c, recorded);
    let simulated: Json = {};
    beforeAll(async () => {
      simulated = await simulate(c, probes);
    }, 120000);

    test('every recorded probe (and field) is compared or listed as not modelled', () => {
      const whole = Object.keys(c.notModelled ?? {}).filter((k) => !k.includes('.'));
      for (const n of whole) expect(Object.keys(recorded)).toContain(n);
      expect(new Set([...probes, ...whole])).toEqual(new Set(Object.keys(recorded)));
      for (const k of Object.keys(c.notModelled ?? {}).filter((x) => x.includes('.'))) {
        const [probe, field] = k.split('.') as [string, string];
        expect(probes).toContain(probe);
        expect(Object.keys(recorded[probe] as Json)).toContain(field);
      }
    });

    test.each(probes)('%s', (probe) => {
      const style = c.style ?? {};
      const mask = [...(c.random?.[probe] ?? []), ...unmodelledFields(c, probe)];
      const actual = normalize(simulated[probe], style, mask);
      const alternatives = c.alternatives?.[probe];
      const expected = normalize(recorded[probe], style, mask);
      if (alternatives !== undefined) {
        const known = alternatives.map((a) => normalize(a, style));
        expect(known).toContainEqual(expected); // a re-recording outside the known outcomes is drift
        expect(known).toContainEqual(actual);
        return;
      }
      expect(alignTruncation(actual, expected)).toEqual(expected);
    });
  });
}
