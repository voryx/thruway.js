/**
 * Internal: the reference in-memory WAMP router of the testing kit, speaking `wamp.2.json` to the fake WebSocket of
 * socket.ts.
 *
 * - Realms (auto-created unless `realms` lists them), sessions, HELLO/WELCOME/ABORT/GOODBYE both ways; authentication
 *   by an `authenticate` hook (multi-round) or by auth `providers` (with Thruway PHP's one CHALLENGE per matching
 *   method, its anonymous and echo WELCOMEs and its stale/silent provider switches);
 * - broker: SUBSCRIBE/UNSUBSCRIBE, PUBLISH with `acknowledge`, `exclude_me`, `eligible`/`exclude` (+ `_authid`,
 *   `_authrole`), publisher disclosure, exact/prefix/wildcard matching, router-side `publish`, revocation;
 * - dealer: scripted procedures (`procedure()`), REGISTER/UNREGISTER with pattern and shared
 *   registrations, INVOCATION/YIELD/ERROR between sessions, progressive results, CANCEL with INTERRUPT, call timeouts,
 *   callers and callees leaving mid-call, router-side calls into client callees (`invoke`), revocation;
 * - the dialects of dialects.ts: every decision that differs between the routers of test/routers/ reads a `QuirkFlags`
 *   value (`dialect`, `quirks`), the spec dialect being version 1's behaviour;
 * - an authorization model (`deny`), id policies (`routerIds`, `subscriptionIds`), delivery modes (`clock`,
 *   `microtask`, `sync`, `manual` + `flush`), per-direction latency, connection availability, `ignore()` predicates;
 * - the oracle of oracle.ts: every client frame that breaks the client's side of the protocol is recorded in
 *   `violations` (judged when written, whatever the dialect); in strict mode unscripted CALLs and undeclared topics are
 *   recorded in `unscripted`; test code that throws lands in `errors`.
 * The router processes one task at a time: a frame, an API call, a timer or a handler result that arrives while it is
 * busy runs right after the current task.
 *
 * @module
 */
import { isWampError } from '../errors.js';
import type { UnhandledReporter } from '../observable/observable.js';
import { subscribeInput } from '../observable/input.js';
import { MessageType as T, Uri } from '../protocol/codes.js';
import type { Dict } from '../protocol/messages.js';
import { isPlainObject, outboundPayload } from '../protocol/payload.js';
import { isValidUri } from '../protocol/uri.js';
import type { Input, Subscription, WebSocketConstructorLike } from '../types.js';
import { type DialectName, quirksOf, type QuirkFlags, type RequestKind, type ViolationKind } from './dialects.js';
import type { AuthDecision, FrameRecord, TestRouter, VirtualClock } from './index.js';
import { answerId, type ClientView, createClientView, isId, judgeWrite, observeReceived } from './oracle.js';
import type { ViolationCode } from './oracle.js';
import {
  authInfoOf,
  type AuthInfo,
  byteLength,
  decodeFrame,
  forwardPayload,
  interruptOptions,
  matches,
  messageOf,
  optionTypesOk,
  read,
  requestIdVerdict,
  routerErrorPayload,
  thruwayAuthDetails,
  thruwayEligible,
  uriAllowed,
  yieldPayload,
} from './rules.js';
import {
  createFakeWebSocket,
  type FakeLink,
  type FakeNetwork,
  type FakeSocket,
  type FakeSocketControls,
  type LinkHandlers,
  type Scheduler,
} from './socket.js';
import { simClockOf } from './virtual-clock.js';

export interface SimRouterOptions {
  /** Frames are delivered through this clock (a SimClock or one of its scopes orders them against timers). */
  readonly clock?: VirtualClock | undefined;
  /** The router to imitate (dialects.ts) ['spec']. */
  readonly dialect?: DialectName | undefined;
  /** Flags that override the dialect's. */
  readonly quirks?: Partial<QuirkFlags> | undefined;
  /** Decide each HELLO (takes precedence over `providers`). */
  readonly authenticate?: ((hello: { realm: string; details: Record<string, unknown> }) => AuthDecision) | undefined;
  /** Auth methods the router offers, in registration order, one provider per method (see `SimAuthProvider`). */
  readonly providers?: readonly SimAuthProvider[] | undefined;
  /** Thruway PHP's AuthenticationManager: attached; none (every HELLO gets an echo WELCOME); registered after
   *  the router started (every HELLO is ABORTed `thruway.authenticator.not_ready`) ['ok']. */
  readonly authManager?: AuthManagerState | undefined;
  /** Milliseconds between the CHALLENGEs of a `multi_method_challenge` router (Thruway PHP T6) [0]. */
  readonly challengeGap?: number | undefined;
  /** The realms that exist (others get the dialect's `unknown_realm` answer) [every realm, created on first use]. */
  readonly realms?: readonly string[] | undefined;
  /** Router id policy: one counter for every kind of id (`unique` = `sequential`); subscription,
   *  registration and invocation ids from 1 per session (`per-session`: stale-id bugs hit live objects); 53-bit random
   *  ids ['unique']. */
  readonly routerIds?: 'unique' | 'sequential' | 'per-session' | 'random' | undefined;
  /** Subscription ids (overrides the dialect's `subscription_ids`: Crossbar `shared`, Thruway PHP `per-subscribe`). */
  readonly subscriptionIds?: QuirkFlags['subscription_ids'] | undefined;
  /** ['clock' with a clock, else 'microtask'] */
  readonly delivery?: 'clock' | 'microtask' | 'sync' | 'manual' | undefined;
  /** Per-direction latency in ms (`clock` delivery): `in` = client → router, `out` = router → client [0]. */
  readonly latency?: { readonly in?: number; readonly out?: number } | undefined;
  /** Record unscripted traffic in `unscripted` [false; createSimRouter: true]. */
  readonly strict?: boolean | undefined;
  /** Sockets have the `ws` package's `terminate()` [false]. */
  readonly terminate?: boolean | undefined;
  /** Events of the client's own close()/terminate() before open: 'async' (browsers) or 'sync' (undici) ['async']. */
  readonly closeEvents?: 'async' | 'sync' | undefined;
  /** Also called for every entry added to `errors`. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** HELLO as the router saw it. */
export interface SimHello {
  readonly realm: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * An auth method of the router (a Thruway PHP auth provider, a Crossbar authenticator, a static principal table).
 * `verify` answers an AUTHENTICATE after the CHALLENGE (`extra` is what the CHALLENGE carried); `welcome` admits a HELLO
 * without CHALLENGE (Thruway's NOCHALLENGE). Each returns the auth details of the WELCOME (`authid`, `authrole`, …) or
 * `false` (rejected: the dialect's `auth_failure_abort`). A provider whose method is `anonymous` admits with the
 * dialect's anonymous WELCOME (its functions are not used). Test code: a throw is recorded in `errors` and ABORTs the
 * handshake with `wamp.error.authorization_failed`.
 */
export interface SimAuthProvider {
  readonly method: string;
  /** Realms it covers ['*' = every realm]. */
  readonly realms?: readonly string[] | undefined;
  /** CHALLENGE.Extra for a HELLO [{}]; `false` rejects the HELLO without a CHALLENGE (Thruway PHP's onhello FAILURE,
   *  e.g. an unknown authid: the dialect's `auth_failure_abort`). */
  readonly extra?: ((hello: SimHello) => Record<string, unknown> | false) | undefined;
  readonly verify?:
    | ((
        signature: string,
        hello: SimHello,
        extra: Readonly<Record<string, unknown>>,
      ) => Record<string, unknown> | false)
    | undefined;
  readonly welcome?: ((hello: SimHello) => Record<string, unknown> | false) | undefined;
}

/** A provider's state: registered; not registered (yet, or any more after a clean stop); `stale` (it died
 *  while the router kept its entry: Thruway PHP ABORTs `thruway.error.unknown`); `silent` (half-open: no answer). */
export type ProviderState = 'registered' | 'absent' | 'stale' | 'silent';
export type AuthManagerState = 'ok' | 'none' | 'not_ready';

/** How new connections are treated (`setAvailable`): accepted; refused before open (`error` + `close` 1006);
 *  refused like Node 22's undici (`error` only); never answered (drives the connect timeout); the constructor throws. */
export type Availability = 'ok' | 'refuse' | 'error-only' | 'hang' | 'throw';

export interface Violation {
  readonly frame: FrameRecord;
  readonly code: ViolationCode;
  readonly rule: string;
}

/** A live view of one session on the router. */
export interface SimSession {
  readonly id: number;
  readonly realm: string;
  readonly connection: number;
  /** HELLO.Details as received. */
  readonly hello: Readonly<Record<string, unknown>>;
  /** WELCOME.Details as sent (`{}` while a pre-WELCOME session of `pre_auth_frames: 'route'` is challenged). */
  readonly welcome: Readonly<Record<string, unknown>>;
  readonly subscriptions: readonly { readonly id: number; readonly topic: string; readonly match: string }[];
  readonly registrations: readonly { readonly id: number; readonly procedure: string; readonly match: string }[];
  /** Calls this session made that are still running. */
  readonly calls: number;
  /** Invocations this session (as callee) has not answered yet. */
  readonly invocations: number;
  readonly alive: boolean;
}

/** A live view of one connection. */
export interface SimConnection {
  readonly number: number;
  readonly owner: unknown;
  readonly url: string;
  readonly protocols: readonly string[];
  readonly socket: FakeSocket;
  readonly controls: FakeSocketControls;
  /** The router end of the transport. */
  readonly state: 'connecting' | 'open' | 'closed';
  /** The WAMP phase on the router end. */
  readonly phase: Phase;
  readonly session: SimSession | undefined;
  /** Write a raw frame to this connection (nothing once the router end is closed). */
  sendRaw(data: string): void;
}
export type Phase = 'hello' | 'challenge' | 'established' | 'goodbye' | 'closed';

/** A request the authorization rules (`deny`) see. */
export interface SimRequest {
  readonly type: RequestKind;
  readonly uri: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly session: SimSession;
}

/** A call the router itself makes into a client callee (`invoke`, the model's RouterInvoke/RouterInterrupt). */
export interface SimRouterCall {
  readonly procedure: string;
  /** The INVOCATION it was sent as (undefined: no callee yet, or none: `error` says why). */
  readonly invocation: { readonly connection: number; readonly id: number } | undefined;
  /** Progress results received (receive_progress). */
  readonly progress: readonly { readonly args: readonly unknown[]; readonly kwargs: Dict }[];
  /** The final RESULT. */
  readonly result: { readonly args: readonly unknown[]; readonly kwargs: Dict; readonly details: Dict } | undefined;
  /** The final ERROR (from the callee, a timeout, an interrupt killnowait, a callee that left, no such procedure). */
  readonly error:
    | { readonly uri: string; readonly args: readonly unknown[]; readonly kwargs: Dict; readonly details: Dict }
    | undefined;
  readonly done: boolean;
  /** INTERRUPT the callee (the dialect's INTERRUPT options); `killnowait` also ends the call with ERROR canceled. */
  interrupt(mode?: 'kill' | 'killnowait'): void;
}

export interface SimRouter extends TestRouter {
  readonly dialect: DialectName;
  /** The flags in effect (the dialect's, with `quirks` applied). */
  readonly quirks: QuirkFlags;
  /** Client frames that broke the client's side of the protocol (asserted empty after each test). */
  readonly violations: readonly Violation[];
  /** Unscripted traffic in strict mode (asserted empty unless a test opts out). */
  readonly unscripted: readonly FrameRecord[];
  /** Test code that threw (authenticate, verify, providers, procedure handlers and their teardowns, rules) and client
   *  listeners that threw. */
  readonly errors: readonly unknown[];
  readonly connections: readonly SimConnection[];
  /** Established sessions that are still alive. */
  readonly sessions: readonly SimSession[];
  /** Declare a topic in strict mode. */
  declareTopic(topic: string): void;
  /**
   * Leave the client frames matching `predicate` unanswered: they are recorded (`frames`, the oracle) but never
   * processed — a HELLO nobody answers (the handshake timeout), a SUBSCRIBE/REGISTER without reply (a request
   * timeout), a liveness probe a router drops, a GOODBYE without reply. Returns the function that removes the
   * predicate (the model's healing clears them). A predicate that throws is recorded in `errors` and ignores
   * nothing.
   */
  ignore(predicate: (frame: readonly unknown[], connection: SimConnection) => boolean): () => void;
  /**
   * Authorization: a CALL, REGISTER, SUBSCRIBE or PUBLISH for which `rule` returns true is answered ERROR
   * `wamp.error.not_authorized` (a string: that URI instead); an unacknowledged PUBLISH is dropped. Returns the
   * remover. A rule that throws is recorded in `errors` and denies nothing.
   */
  deny(rule: (request: SimRequest) => boolean | string | undefined): () => void;
  /** Deliver up to `n` queued items in `manual` delivery mode; returns how many ran. */
  flush(n?: number): number;
  /** Items waiting for `flush` (manual delivery). */
  readonly pending: number;
  /** Write a raw frame to every open connection, or to connection number `connection` only. */
  sendRaw(data: string, connection?: number): void;
  /** GOODBYE to one session (Crossbar's `wamp.session.kill`, Thruway's `shutdown_session`) [wamp.close.killed]. */
  kill(sessionId: number, reason?: string, details?: Record<string, unknown>): void;
  /** Call a procedure a client registered (realm: the first that has it, or `options.realm`). */
  invoke(
    procedure: string,
    call?: {
      readonly args?: readonly unknown[];
      readonly kwargs?: Readonly<Record<string, unknown>>;
      readonly options?: Readonly<Record<string, unknown>>;
      readonly realm?: string;
    },
  ): SimRouterCall;
  revokeSubscription(topic: string, reason?: string): void;
  revokeRegistration(procedure: string, reason?: string): void;
  setAvailable(mode: Availability): void;
  /** Change a provider's state (`providers`): e.g. `absent` until it registers late, `stale` once it died. */
  setProvider(method: string, state: ProviderState): void;
  setAuthManager(state: AuthManagerState): void;
  /** Change flags while the router runs (`quirks` then shows them): lift a dialect silence, say. */
  setQuirks(overrides: Partial<QuirkFlags>): void;
  /**
   * The model's healing: every `ignore()` predicate and `deny()` rule removed, connections accepted
   * again (`setAvailable('ok')`), every provider registered, the AuthenticationManager as configured (`authManager`),
   * every link thawed.
   * The dialect's own silences stay (a Thruway wildcard SUBSCRIBE is still never answered): `setQuirks` lifts them.
   */
  heal(): void;
  /** A WebSocket class bound to this router whose connections carry `owner` (one class per client in a harness). */
  webSocketFor(owner: unknown): WebSocketConstructorLike;
  /** Every frame record as it is added to `frames`, with the data as it travels (`record.frame` is decoded, so it
   *  may not be the same text). Returns the unsubscribe function. */
  observeFrames(
    listener: (record: FrameRecord, connection: SimConnection, data: string | Uint8Array) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------------------------------------------

type Frame = readonly unknown[];
type Handler = (args: unknown[], kwargs: Record<string, unknown>, details: Record<string, unknown>) => Input<unknown>;

const CANCEL_MODES: ReadonlySet<unknown> = new Set(['skip', 'kill', 'killnowait']);
const INTERRUPT_MODES: ReadonlySet<unknown> = new Set(['kill', 'killnowait']);
const SPEC_INVOKE: ReadonlySet<unknown> = new Set(['single', 'roundrobin', 'random', 'first', 'last']);
const REQUEST_TYPES: ReadonlySet<unknown> = new Set([
  T.SUBSCRIBE,
  T.UNSUBSCRIBE,
  T.PUBLISH,
  T.REGISTER,
  T.UNREGISTER,
  T.CALL,
]);
const AVAILABILITY: readonly string[] = ['ok', 'refuse', 'error-only', 'hang', 'throw'];
/** The request id of the router's own calls (`invoke`): no frame can carry it, so it is in no request-id index. */
const ROUTER_REQUEST: unique symbol = Symbol('router call');
const PROVIDER_STATES: readonly string[] = ['registered', 'absent', 'stale', 'silent'];
const AUTH_MANAGER: readonly string[] = ['ok', 'none', 'not_ready'];

interface Realm {
  readonly name: string;
  readonly sessions: Set<Session>;
  readonly registrations: Registration[];
  /** Thruway PHP T1: the latest CALL per request id, realm-wide (`realm_call_index`). */
  readonly callIndex: Map<unknown, Call>;
  /** `subscription_ids: 'shared'`: the subscription id of each match + topic. */
  readonly shared: Map<string, number>;
}

interface Sub {
  readonly id: number;
  readonly topic: string;
  readonly match: string;
  /** The id its EVENTs carry (`per-subscribe-first`: the first subscription of this topic + match). */
  readonly eventId: number;
  /** SUBSCRIBE `disclose_publisher: true` (`publisher_disclosure: 'subscriber'`). */
  readonly disclose: boolean;
}

interface Registration {
  readonly id: number;
  readonly realm: Realm;
  readonly procedure: string;
  readonly match: string;
  readonly invoke: string;
  readonly discloseCaller: boolean;
  readonly callees: Callee[];
  /** `_thruway` calls waiting for an idle callee. */
  readonly queue: Call[];
  next: number;
}

interface Callee {
  readonly session: Session;
  readonly registration: Registration;
  readonly localId: number;
  readonly discloseCaller: boolean;
}

/** The caller of a call: a session, or the router itself (`invoke`). */
interface Caller {
  /** Session id (disclosure); undefined for the router. */
  readonly id: number | undefined;
  readonly auth: AuthInfo;
  /** The latest call per request id. */
  readonly calls: Map<unknown, Call>;
  /** Every call still running. */
  readonly active: Set<Call>;
  /** Send a frame to the caller (false: it cannot be serialized). */
  deliver(frame: Frame): boolean;
}

interface Call {
  readonly caller: Caller;
  readonly realm: Realm;
  readonly requestId: unknown;
  readonly progress: boolean;
  readonly options: Dict;
  /** The CALL frame (payload source). */
  readonly frame: Frame;
  done: boolean;
  /** Scripted procedure: the handler result's subscription; last value of a non-progressive Observable. */
  subscription?: Subscription;
  last?: { readonly value: unknown };
  /** The INVOCATION of a registered callee. */
  invocation?: Invocation;
  /** Waiting in a `_thruway` queue. */
  queuedOn?: Registration | undefined;
  /** The caller was answered (or will never be); the callee's answers are discarded. */
  answered?: boolean;
  /** A CANCEL kill is pending (a second CANCEL is ignored). */
  killing?: boolean;
  cancelTimer?: () => void;
}

interface Invocation {
  readonly call: Call;
  readonly callee: Session;
  readonly registration: Registration;
  readonly id: number;
  /** Progress YIELDs are forwarded as progress RESULTs. */
  readonly progress: boolean;
}

class Session implements Caller {
  alive = true;
  established = false;
  welcome: Dict = {};
  auth: AuthInfo = authInfoOf({});
  readonly subs = new Map<number, Sub>();
  readonly regs = new Map<number, Callee>();
  readonly calls = new Map<unknown, Call>();
  readonly active = new Set<Call>();
  readonly invocations = new Map<number, Invocation>();
  readonly counters = { subscription: 0, registration: 0, invocation: 0 };
  /** `strict_ids`: the next request id this session must use. */
  nextRequest = 1;

  constructor(
    readonly id: number,
    readonly realm: Realm,
    readonly conn: Conn,
    readonly hello: Dict,
    private readonly sender: (conn: Conn, frame: Frame) => boolean,
  ) {}

  /** `authmethod`: the provider's method that authenticated the session, whatever the WELCOME says (Thruway PHP sets
   *  it at the HELLO; the provider's details never change it). */
  establish(welcome: Dict, authmethod?: string): void {
    this.welcome = welcome;
    this.auth = authInfoOf(authmethod === undefined ? welcome : { ...welcome, authmethod });
    this.established = true;
  }

  /** Send an answer to this session; nothing goes to a session that ended (its socket may still be open: after a
   *  router GOODBYE, or hosting a new session). False when the frame cannot be serialized. */
  deliver(frame: Frame): boolean {
    return !this.alive || this.sender(this.conn, frame);
  }

  feature(role: string, feature: string): boolean {
    const roles = read(this.hello, 'roles');
    return read(read(read(roles, role), 'features'), feature) === true;
  }
}

/** The router end's WAMP state of one connection. */
type ConnState =
  | { readonly phase: 'hello' }
  | {
      readonly phase: 'challenge';
      readonly hello: SimHello;
      readonly check: (signature: string) => void;
      /** `pre_auth_frames: 'route'`: the session is already in the realm. */
      readonly session: Session | undefined;
    }
  | { readonly phase: 'established'; readonly session: Session }
  | { readonly phase: 'goodbye' }
  | { readonly phase: 'closed' };

const CLOSED: ConnState = { phase: 'closed' };
const HELLO: ConnState = { phase: 'hello' };

interface Conn {
  readonly link: FakeLink;
  state: ConnState;
  /** The session of this connection (kept after it ended, for the views). */
  session: Session | undefined;
  /** What the client has sent and received on this link so far (the oracle). */
  readonly view: ClientView;
  /** CHALLENGEs not sent yet (`challengeGap`). */
  readonly challenges: { readonly frame: Frame; readonly cancel: () => void }[];
}

type IdKind = 'subscription' | 'registration' | 'invocation';

interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

let routerNumbers = 0;

/** A call the router makes (`invoke`): its record is the caller. */
class RouterCall implements Caller, SimRouterCall {
  readonly id = undefined;
  readonly auth: AuthInfo = authInfoOf({ authid: 'router', authrole: 'router' });
  readonly calls = new Map<unknown, Call>();
  readonly active = new Set<Call>();
  readonly progress: { readonly args: readonly unknown[]; readonly kwargs: Dict }[] = [];
  result: SimRouterCall['result'];
  error: SimRouterCall['error'];
  call: Call | undefined;

  constructor(
    readonly procedure: string,
    private readonly onInterrupt: (record: RouterCall, mode: 'kill' | 'killnowait') => void,
  ) {}

  get invocation(): SimRouterCall['invocation'] {
    const inv = this.call?.invocation;
    return inv === undefined ? undefined : { connection: inv.callee.conn.link.number, id: inv.id };
  }

  get done(): boolean {
    return this.result !== undefined || this.error !== undefined;
  }

  interrupt(mode: 'kill' | 'killnowait' = 'kill'): void {
    if (!INTERRUPT_MODES.has(mode)) throw new TypeError("interrupt(mode): 'kill' or 'killnowait'");
    this.onInterrupt(this, mode);
  }

  deliver(frame: Frame): boolean {
    const payload = (at: number): { args: readonly unknown[]; kwargs: Dict } => ({
      args: Array.isArray(frame[at]) ? (frame[at] as readonly unknown[]) : [],
      kwargs: isPlainObject(frame[at + 1]) ? (frame[at + 1] as Dict) : {},
    });
    if (frame[0] === T.RESULT && read(frame[2], 'progress') === true) this.progress.push(payload(3));
    else if (frame[0] === T.RESULT) this.result = { ...payload(3), details: frame[2] as Dict };
    else this.error = { uri: frame[4] as string, ...payload(5), details: frame[3] as Dict };
    return true;
  }
}

class Router implements SimRouter {
  readonly url: string;
  readonly WebSocket: WebSocketConstructorLike;
  readonly dialect: DialectName;
  readonly frames: FrameRecord[] = [];
  readonly violations: Violation[] = [];
  readonly unscripted: FrameRecord[] = [];
  readonly errors: unknown[] = [];
  private q: QuirkFlags;
  private readonly conns: Conn[] = [];
  private readonly views = new Map<Conn, SimConnection>();
  private readonly realms = new Map<string, Realm>();
  private readonly procedures = new Map<string, Handler>();
  private readonly declared = new Set<string>();
  private readonly ignored = new Set<(frame: readonly unknown[], connection: SimConnection) => boolean>();
  private readonly rules = new Set<(request: SimRequest) => boolean | string | undefined>();
  private readonly frameListeners = new Set<
    (record: FrameRecord, connection: SimConnection, data: string | Uint8Array) => void
  >();
  private readonly manual: (() => void)[] = [];
  private readonly tasks: (() => void)[] = [];
  private readonly providerStates = new Map<string, ProviderState>();
  private busy = false;
  private availability: Availability = 'ok';
  private authManager: AuthManagerState;
  private links = 0;
  private idCounter = 0;
  private readonly usedRandomIds = new Set<number>();
  private readonly random: () => number;
  private readonly network: FakeNetwork;
  private readonly strict: boolean;
  private readonly ids: 'unique' | 'per-session' | 'random';
  private readonly reporter: UnhandledReporter;
  private readonly started = Date.now();

  constructor(private readonly options: SimRouterOptions) {
    this.dialect = options.dialect ?? 'spec';
    const subscriptionIds = options.subscriptionIds;
    this.q = Object.freeze({
      ...quirksOf(this.dialect, options.quirks),
      ...(subscriptionIds === undefined ? {} : { subscription_ids: subscriptionIds }),
    });
    this.url = `memory://router/${String(++routerNumbers)}`;
    this.strict = options.strict === true;
    this.ids = options.routerIds === 'sequential' ? 'unique' : (options.routerIds ?? 'unique');
    this.authManager = checked(options.authManager ?? 'ok', AUTH_MANAGER, 'authManager');
    for (const { method } of options.providers ?? []) {
      if (this.providerStates.has(method)) throw new TypeError(`testing router: two providers for '${method}'`);
      this.providerStates.set(method, 'registered');
    }
    const clock = options.clock;
    // Its own stream on a SimClock (router ids never shift the client's draws); else the clock's, else Math's.
    this.random = simClockOf(clock)?.fork('router') ?? (clock === undefined ? Math.random : () => clock.random());
    this.reporter = (error) => {
      this.fail(error);
    };
    this.network = {
      scheduler: this.scheduler(),
      terminate: options.terminate,
      closeEvents: options.closeEvents,
      nextLinkNumber: () => ++this.links,
      connect: (link) => this.connect(link),
      attached: (link) => {
        this.attached(link);
      },
      listenerError: (error) => {
        this.fail(error);
      },
    };
    this.WebSocket = createFakeWebSocket(this.network);
  }

  // --- public API ----------------------------------------------------------------------------------------------

  get connections(): readonly SimConnection[] {
    return this.conns.map((conn) => this.view(conn));
  }

  get sessions(): readonly SimSession[] {
    const out: SimSession[] = [];
    for (const realm of this.realms.values()) {
      for (const s of realm.sessions) if (s.established) out.push(sessionView(s));
    }
    return out;
  }

  get pending(): number {
    return this.manual.length;
  }

  procedure(uri: string, fn: Handler): void {
    if (typeof fn !== 'function') throw new TypeError('procedure(uri, fn): fn must be a function');
    this.procedures.set(uri, fn);
  }

  declareTopic(topic: string): void {
    this.declared.add(topic);
  }

  ignore(predicate: (frame: readonly unknown[], connection: SimConnection) => boolean): () => void {
    if (typeof predicate !== 'function') throw new TypeError('ignore(predicate): predicate must be a function');
    const wrapped = (frame: readonly unknown[], connection: SimConnection): boolean => predicate(frame, connection);
    this.ignored.add(wrapped);
    return () => {
      this.ignored.delete(wrapped);
    };
  }

  deny(rule: (request: SimRequest) => boolean | string | undefined): () => void {
    if (typeof rule !== 'function') throw new TypeError('deny(rule): rule must be a function');
    const wrapped = (request: SimRequest): boolean | string | undefined => rule(request);
    this.rules.add(wrapped);
    return () => {
      this.rules.delete(wrapped);
    };
  }

  publish(topic: string, args?: unknown[], kwargs?: Record<string, unknown>): void {
    this.declared.add(topic);
    this.run(() => {
      const publication = this.nextId();
      const frame: Frame = [T.PUBLISH, 0, {}, topic, ...outboundPayload(args, kwargs)];
      for (const realm of this.realms.values()) {
        for (const [s, event] of this.events(realm, undefined, topic, {}, publication, frame)) this.send(s.conn, event);
      }
    });
  }

  drop(code = 1006): void {
    this.run(() => {
      for (const conn of this.conns) conn.link.drop(code);
    });
  }

  goodbye(reason: string = Uri.SYSTEM_SHUTDOWN, details: Record<string, unknown> = {}): void {
    this.run(() => {
      for (const conn of this.conns) if (conn.state.phase === 'established') this.goodbyeConn(conn, reason, details);
    });
  }

  kill(sessionId: number, reason: string = Uri.KILLED, details: Record<string, unknown> = {}): void {
    this.run(() => {
      for (const conn of this.conns) {
        if (conn.state.phase === 'established' && conn.state.session.id === sessionId) {
          this.goodbyeConn(conn, reason, details);
        }
      }
    });
  }

  abort(reason: string = Uri.SYSTEM_SHUTDOWN, details: Record<string, unknown> = {}): void {
    this.run(() => {
      for (const conn of this.conns) {
        if (conn.link.state === 'open') this.abortConn(conn, reason, details); // an open transport is never 'closed'
      }
    });
  }

  close(): void {
    this.availability = 'refuse';
    this.run(() => {
      for (const conn of this.conns) conn.link.close(1001, '');
    });
  }

  sendRaw(data: string, connection?: number): void {
    this.run(() => {
      for (const conn of this.conns)
        if (connection === undefined || conn.link.number === connection) conn.link.send(data);
    });
  }

  revokeSubscription(topic: string, reason?: string): void {
    this.run(() => {
      for (const realm of this.realms.values()) {
        for (const s of realm.sessions) {
          for (const sub of [...s.subs.values()]) {
            if (sub.topic !== topic) continue;
            this.removeSub(s, sub);
            if (s.feature('subscriber', 'subscription_revocation')) {
              this.send(s.conn, [T.UNSUBSCRIBED, 0, revocation('subscription', sub.id, reason)]);
            }
          }
        }
      }
    });
  }

  revokeRegistration(procedure: string, reason?: string): void {
    this.run(() => {
      for (const realm of this.realms.values()) {
        for (const reg of realm.registrations.filter((r) => r.procedure === procedure)) {
          for (const callee of [...reg.callees]) {
            this.removeCallee(callee);
            if (callee.session.feature('callee', 'registration_revocation')) {
              this.send(callee.session.conn, [T.UNREGISTERED, 0, revocation('registration', callee.localId, reason)]);
            }
          }
        }
      }
    });
  }

  setAvailable(mode: Availability): void {
    this.availability = checked(mode, AVAILABILITY, 'availability');
  }

  setProvider(method: string, state: ProviderState): void {
    if (!this.providerStates.has(method)) throw new TypeError(`setProvider: no provider for '${method}'`);
    this.providerStates.set(method, checked(state, PROVIDER_STATES, 'provider state'));
  }

  get quirks(): QuirkFlags {
    return this.q;
  }

  setQuirks(overrides: Partial<QuirkFlags>): void {
    this.q = Object.freeze({ ...this.q, ...overrides });
  }

  heal(): void {
    this.ignored.clear();
    this.rules.clear();
    this.availability = 'ok';
    this.authManager = this.options.authManager ?? 'ok'; // the configured manager (a noauth router stays one)
    for (const method of this.providerStates.keys()) this.providerStates.set(method, 'registered');
    for (const conn of this.conns) conn.link.controls.thaw();
  }

  setAuthManager(state: AuthManagerState): void {
    this.authManager = checked(state, AUTH_MANAGER, 'authManager');
  }

  webSocketFor(owner: unknown): WebSocketConstructorLike {
    return createFakeWebSocket(this.network, owner);
  }

  observeFrames(
    listener: (record: FrameRecord, connection: SimConnection, data: string | Uint8Array) => void,
  ): () => void {
    const wrapped = (record: FrameRecord, connection: SimConnection, data: string | Uint8Array): void => {
      listener(record, connection, data);
    };
    this.frameListeners.add(wrapped);
    return () => {
      this.frameListeners.delete(wrapped);
    };
  }

  flush(n = Infinity): number {
    let ran = 0;
    for (; ran < n; ran++) {
      const next = this.manual.shift();
      if (next === undefined) break;
      next();
    }
    return ran;
  }

  invoke(
    procedure: string,
    call: {
      readonly args?: readonly unknown[];
      readonly kwargs?: Readonly<Record<string, unknown>>;
      readonly options?: Readonly<Record<string, unknown>>;
      readonly realm?: string;
    } = {},
  ): SimRouterCall {
    const record = new RouterCall(procedure, (r, mode) => {
      this.run(() => {
        this.routerInterrupt(r, mode);
      });
    });
    this.run(() => {
      const realms = call.realm === undefined ? [...this.realms.values()] : [this.realms.get(call.realm)];
      const realm = realms.find((r) => r !== undefined && this.lookup(r, procedure) !== undefined);
      if (realm === undefined) {
        record.deliver([T.ERROR, T.CALL, 0, {}, Uri.NO_SUCH_PROCEDURE]);
        return;
      }
      const options = { ...call.options };
      const frame: Frame = [T.CALL, 0, options, procedure, ...outboundPayload(call.args, call.kwargs)];
      const c = this.newCall(record, realm, ROUTER_REQUEST, options, frame);
      record.call = c; // in no index: no client's CANCEL reaches it, its end unsets no client's entry
      this.invokeOn(c, known(this.lookup(realm, procedure)), procedure);
    });
    return record;
  }

  // --- plumbing --------------------------------------------------------------------------------------------------

  private scheduler(): Scheduler {
    const clock = this.options.clock;
    const mode: string = this.options.delivery ?? (clock === undefined ? 'microtask' : 'clock'); // JS callers: any string
    if (mode === 'sync') {
      const now = (_x: unknown, fn: () => void): void => {
        fn();
      };
      return { schedule: now, after: now };
    }
    if (mode === 'microtask') {
      const later = (_x: unknown, fn: () => void): void => {
        void Promise.resolve().then(fn);
      };
      return { schedule: later, after: later };
    }
    if (mode === 'manual') {
      const queue = (_x: unknown, fn: () => void): void => {
        this.manual.push(fn);
      };
      return { schedule: queue, after: queue };
    }
    if (mode !== 'clock') throw new TypeError(`unknown delivery mode '${mode}'`);
    if (clock === undefined) throw new TypeError("delivery 'clock' needs a clock");
    const sim = simClockOf(clock);
    const at = (ms: number, fn: () => void): void => {
      if (sim !== undefined) sim.deliverAt(ms, fn);
      else clock.setTimeout(fn, ms);
    };
    const latencyIn = this.options.latency?.in ?? 0;
    const latencyOut = this.options.latency?.out ?? 0;
    return {
      schedule: (d, fn) => {
        at(d === 'up' ? latencyIn : latencyOut, fn);
      },
      after: at,
    };
  }

  /** Run `task` now, or after the current task if the router is busy (never re-entrant). */
  private run(task: () => void): void {
    this.tasks.push(task);
    if (this.busy) return;
    this.busy = true;
    try {
      for (let next = this.tasks.shift(); next !== undefined; next = this.tasks.shift()) {
        try {
          next();
        } catch (error) {
          this.fail(error);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** A router timer (call timeouts, CHALLENGE gaps, orphan pings) on the router's clock, else a host timer. */
  private timer(ms: number, fn: () => void): () => void {
    const host: TimerHost = this.options.clock ?? (globalThis as unknown as TimerHost);
    const handle = host.setTimeout(() => {
      this.run(fn);
    }, ms);
    return () => {
      host.clearTimeout(handle);
    };
  }

  private fail(error: unknown): void {
    this.errors.push(error);
    this.options.onError?.(error);
  }

  /** Run test code: a throw is recorded in `errors`, `fallback` is returned. */
  private guard<R>(fn: () => R, fallback: R): R {
    try {
      return fn();
    } catch (error) {
      this.fail(error);
      return fallback;
    }
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now() - this.started;
  }

  private record(conn: Conn, direction: 'in' | 'out', data: string | Uint8Array): FrameRecord {
    const record: FrameRecord = Object.freeze({
      connection: conn.link.number,
      direction,
      frame: decodeFrame(data),
      at: this.now(),
    });
    this.frames.push(record);
    if (direction === 'in') {
      for (const { code, rule } of judgeWrite(conn.view, record.frame, byteLength(data)))
        this.violations.push({ frame: record, code, rule });
    } else {
      observeReceived(conn.view, record.frame);
    }
    const view = this.view(conn);
    for (const listener of [...this.frameListeners]) {
      try {
        listener(record, view, data);
      } catch (error) {
        this.fail(error);
      }
    }
    return record;
  }

  private send(conn: Conn, frame: Frame): boolean {
    let text: string;
    try {
      text = JSON.stringify(frame);
    } catch {
      return false;
    }
    conn.link.send(text);
    return true;
  }

  private nextId(): number {
    if (this.ids !== 'random') return ++this.idCounter;
    for (;;) {
      const id = Math.floor(this.random() * 2 ** 53) + 1;
      if (!this.usedRandomIds.has(id)) {
        this.usedRandomIds.add(id);
        return id;
      }
    }
  }

  private scopedId(session: Session, kind: IdKind): number {
    return this.ids === 'per-session' ? ++session.counters[kind] : this.nextId();
  }

  private view(conn: Conn): SimConnection {
    let view = this.views.get(conn);
    if (view === undefined) {
      const link = conn.link;
      view = {
        number: link.number,
        owner: link.owner,
        url: link.url,
        protocols: link.protocols,
        socket: link.socket,
        controls: link.controls,
        get state() {
          return link.state;
        },
        get phase() {
          return conn.state.phase;
        },
        get session() {
          return conn.session === undefined ? undefined : sessionView(conn.session);
        },
        sendRaw: (data: string) => {
          this.run(() => {
            link.send(data);
          });
        },
      };
      this.views.set(conn, view);
    }
    return view;
  }

  private realm(name: string): Realm {
    let realm = this.realms.get(name);
    if (realm === undefined) {
      realm = { name, sessions: new Set(), registrations: [], callIndex: new Map(), shared: new Map() };
      this.realms.set(name, realm);
    }
    return realm;
  }

  // --- connections -----------------------------------------------------------------------------------------------

  private connect(link: FakeLink): LinkHandlers {
    if (this.availability === 'throw')
      throw new Error('testing router: connections are refused (setAvailable("throw"))');
    const conn: Conn = { link, state: HELLO, session: undefined, view: createClientView(), challenges: [] };
    this.conns.push(conn);
    return {
      sent: (data) => this.record(conn, 'in', data),
      message: (data, tag) => {
        this.run(() => {
          this.arrive(conn, data, tag as FrameRecord);
        });
      },
      received: (data) => {
        this.record(conn, 'out', data);
      },
      closed: () => {
        this.run(() => {
          this.cancelChallenges(conn);
          conn.state = CLOSED;
          this.endSession(conn);
        });
      },
    };
  }

  /** Answer a new connection by the availability ('throw' never gets here: `connect` threw). */
  private attached(link: FakeLink): void {
    const mode = this.availability;
    if (mode === 'refuse') link.fail();
    else if (mode === 'error-only') link.fail(true);
    else if (mode === 'ok') {
      const protocol = this.negotiate(link.protocols);
      if (protocol === undefined) link.fail(false, 'Server sent no subprotocol');
      else link.accept(protocol);
    }
    // 'hang': never answered
  }

  private negotiate(offered: readonly string[]): string | undefined {
    const accepted = this.q.subprotocols;
    const pick =
      this.q.subprotocol_order === 'client'
        ? offered.find((p) => accepted.includes(p))
        : accepted.find((p) => offered.includes(p));
    return pick ?? (this.q.no_subprotocol === 'accept' ? '' : undefined);
  }

  /** The router end dies (1006: Nexus's lost closing frames, `'drop'` reactions). */
  private lose(conn: Conn): void {
    this.cancelChallenges(conn);
    conn.state = CLOSED;
    conn.link.drop(1006);
  }

  private closeLink(conn: Conn, code: number, reason: string): void {
    this.cancelChallenges(conn);
    conn.state = CLOSED;
    conn.link.close(code, reason);
  }

  // --- inbound frames --------------------------------------------------------------------------------------------

  /** A client frame reached the router (the oracle judged it when it was written). */
  private arrive(conn: Conn, data: string | Uint8Array, record: FrameRecord): void {
    const max = this.q.max_message_bytes;
    if (max !== undefined && byteLength(data) > max) {
      this.closeLink(conn, 1009, '');
      return;
    }
    if (typeof data !== 'string' && this.q.violations.binary !== 'ignore') {
      this.react(conn, 'binary', undefined);
      return;
    }
    const frame = record.frame;
    if (typeof frame === 'string' || !Number.isInteger(frame[0])) {
      this.react(conn, 'invalid-json', undefined);
      return;
    }
    if (this.isIgnored(conn, frame)) return;
    this.process(conn, frame, record);
  }

  /** A test's `ignore()` predicate matches the frame (test code: a throw is recorded and matches nothing). */
  private isIgnored(conn: Conn, frame: Frame): boolean {
    for (const predicate of [...this.ignored])
      if (this.guard(() => predicate(frame, this.view(conn)), false)) return true;
    return false;
  }

  /** The dialect's reaction to a violation; false when it is `'ignore'`/`'discard'` (the caller carries on). */
  private react(conn: Conn, kind: ViolationKind, frame: Frame | undefined): boolean {
    const reaction = this.q.violations[kind];
    if (reaction === 'ignore' || reaction === 'discard') return false;
    if (reaction === 'welcome') {
      const s = known(conn.session); // a second HELLO: only in a session
      this.send(conn, [T.WELCOME, this.nextId(), s.welcome]);
    } else if (reaction === 'drop') {
      this.lose(conn);
    } else if ('close' in reaction) {
      this.closeLink(conn, reaction.close, reaction.reason ?? '');
    } else if ('abort' in reaction) {
      this.abortConn(conn, reaction.abort, {});
    } else if ('goodbye' in reaction) {
      this.send(conn, [T.GOODBYE, {}, reaction.goodbye]);
      this.endSession(conn);
      this.closeAfter(conn, this.q.router_closes_after_goodbye);
    } else if (frame !== undefined && REQUEST_TYPES.has(frame[0])) {
      this.send(conn, [T.ERROR, frame[0], frame[1], {}, reaction.error, ...routerErrorPayload(this.q, undefined)]);
    }
    return true;
  }

  /** Route a client frame by the router's phase. */
  private process(conn: Conn, frame: Frame, record: FrameRecord): void {
    const type = frame[0] as number;
    // No 'closed' case: a closed phase means the transport is closed too, so nothing arrives any more.
    const state = conn.state;
    if (state.phase === 'hello') {
      if (type === T.HELLO) this.hello(conn, frame);
      else if (type === T.AUTHENTICATE && this.q.authenticate_before_challenge === 'abort')
        this.abortConn(conn, this.q.auth_failure_abort, { message: 'no pending authentication' });
      else this.react(conn, 'before-hello', frame);
    } else if (state.phase === 'challenge') {
      if (type === T.AUTHENTICATE) {
        if (typeof frame[1] === 'string') {
          this.flushChallenges(conn);
          state.check(frame[1]);
        }
      } else if (type === T.ABORT) {
        this.clientLeft(conn, 'abort');
      } else if (this.q.pre_auth_frames === 'route' && state.session !== undefined) {
        this.established(conn, state.session, frame, record);
      } else if (this.q.pre_auth_frames === 'not_authorized' && REQUEST_TYPES.has(type)) {
        this.send(conn, [T.ERROR, type, frame[1], {}, Uri.NOT_AUTHORIZED, ...routerErrorPayload(this.q, undefined)]);
      }
    } else if (state.phase === 'established') {
      this.established(conn, state.session, frame, record);
    } else if (type === T.GOODBYE || type === T.ABORT) {
      // phase 'goodbye': the reply (or an ABORT) ends it; Thruway PHP answers the reply like any GOODBYE
      if (type === T.GOODBYE && this.q.goodbye_reply_answered)
        this.send(conn, [T.GOODBYE, this.q.goodbye_reply_details, this.q.goodbye_reply_reason]);
      this.clientLeft(conn, 'goodbye');
    }
  }

  // --- handshake -------------------------------------------------------------------------------------------------

  private hello(conn: Conn, frame: Frame): void {
    const [, realm, details] = frame;
    if (typeof realm !== 'string' || !isPlainObject(details)) {
      if (!this.react(conn, 'malformed-hello', frame))
        this.abortConn(conn, Uri.PROTOCOL_VIOLATION, { message: 'malformed HELLO' });
      return;
    }
    const roles = details['roles'];
    const hasRoles = isPlainObject(roles) && Object.keys(roles).length > 0;
    if (!hasRoles && this.q.hello_without_roles === 'violation' && this.react(conn, 'malformed', frame)) return;
    const rule = this.q.realm_rule;
    if (
      (this.options.realms !== undefined && !this.options.realms.includes(realm)) ||
      (rule !== undefined && !new RegExp(rule).test(realm))
    ) {
      if (this.q.unknown_realm === 'abort') this.abortConn(conn, Uri.NO_SUCH_REALM, {});
      return;
    }
    const hello: SimHello = { realm, details };
    if (this.authManager === 'not_ready') {
      this.abortConn(conn, 'thruway.authenticator.not_ready', {});
    } else if (this.authManager === 'none') {
      // Thruway's AnonymousAuthenticator: the HELLO details come back (client roles replaced by the router's)
      const echo: Record<string, unknown> = { ...details };
      delete echo['roles'];
      this.welcome(conn, hello, { ...echo, transport: { type: 'testing', url: conn.link.url } }, false);
    } else if (this.options.authenticate !== undefined) {
      const authenticate = this.options.authenticate;
      this.decide(conn, hello, () => authenticate({ realm, details: { ...details } }));
    } else if (this.options.providers !== undefined && this.options.providers.length > 0) {
      this.providerHello(conn, hello, this.options.providers);
    } else {
      this.welcome(conn, hello, {}, true);
    }
  }

  /** Run the app's authentication decision (test code: a throw is recorded and ABORTs the handshake). */
  private decide(conn: Conn, hello: SimHello, decision: () => AuthDecision): void {
    let d: unknown;
    try {
      d = decision();
    } catch (error) {
      this.fail(error);
      this.abortConn(conn, Uri.AUTHORIZATION_FAILED, { message: 'the authenticate hook threw' });
      return;
    }
    const welcome = read(d, 'welcome');
    const challenge = read(d, 'challenge');
    const verify = read(d, 'verify');
    const abort = read(d, 'abort');
    const method = read(challenge, 'method');
    const extra = read(challenge, 'extra');
    const details = read(d, 'details');
    if (isPlainObject(welcome)) {
      this.welcome(conn, hello, welcome, false);
    } else if (
      typeof method === 'string' &&
      typeof verify === 'function' &&
      (extra === undefined || isPlainObject(extra))
    ) {
      const check = (signature: string): void => {
        this.decide(conn, hello, () => (verify as (signature: string) => AuthDecision)(signature));
      };
      this.challenged(conn, hello, check);
      this.send(conn, [T.CHALLENGE, method, extra ?? {}]);
    } else if (typeof abort === 'string' && (details === undefined || isPlainObject(details))) {
      this.abortConn(conn, abort, details ?? {});
    } else {
      this.fail(new TypeError('testing router: authenticate returned no welcome, challenge or abort decision'));
      this.abortConn(conn, Uri.AUTHORIZATION_FAILED, { message: 'invalid authenticate decision' });
    }
  }

  /** Enter (or stay in) the challenge phase; `pre_auth_frames: 'route'` (Thruway PHP T5) puts the session in the
   *  realm now. */
  private challenged(conn: Conn, hello: SimHello, check: (signature: string) => void): void {
    let session = conn.state.phase === 'challenge' ? conn.state.session : undefined;
    if (session === undefined && this.q.pre_auth_frames === 'route') {
      const realm = this.realm(hello.realm);
      session = new Session(this.nextId(), realm, conn, hello.details, (c, f) => this.send(c, f));
      conn.session = session;
      realm.sessions.add(session);
    }
    conn.state = { phase: 'challenge', hello, check, session };
  }

  /**
   * Auth providers (dialects.ts `multi_method_challenge`, `anonymous_welcome_without_provider`, the provider switches).
   * A provider covers a realm when it is not `absent` and lists the realm (or '*').
   */
  private providerHello(conn: Conn, hello: SimHello, providers: readonly SimAuthProvider[]): void {
    if (this.q.anonymous_without_authid && read(hello.details, 'authid') === undefined) {
      this.welcome(conn, hello, {}, true); // Bondy: no authid, whatever is offered
      return;
    }
    const offered = read(hello.details, 'authmethods');
    const listed = Array.isArray(offered) ? offered.filter((m): m is string => typeof m === 'string') : [];
    const methods = listed.length === 0 ? ['anonymous'] : listed; // no authmethods: anonymous
    const covering = providers.filter(
      (p) =>
        this.providerStates.get(p.method) !== 'absent' &&
        (p.realms === undefined || p.realms.includes('*') || p.realms.includes(hello.realm)),
    );
    const offeredBy = (p: SimAuthProvider): boolean => methods.includes(p.method);
    const firstOffered = methods.find((m) => covering.some((c) => c.method === m));
    // With one CHALLENGE per matching method an `anonymous` method only admits a HELLO no other method matches
    // (router.php's LenientAuthenticationManager); otherwise it is a method like any other, in the dialect's order.
    const challengers = covering.filter((p) => offeredBy(p) && p.method !== 'anonymous');
    const matching = this.q.multi_method_challenge
      ? challengers.length > 0
        ? challengers
        : covering.filter(offeredBy)
      : this.q.auth_method_order === 'router'
        ? covering.filter(offeredBy).slice(0, 1)
        : covering.filter((p) => p.method === firstOffered).slice(0, 1);
    if (matching.length === 0) {
      const anonymous = this.q.anonymous_welcome_without_provider || methods.includes('anonymous');
      if (covering.length === 0 && anonymous) this.welcome(conn, hello, {}, true);
      else this.abortConn(conn, this.q.no_auth_method_abort, {});
      return;
    }
    // One onhello per matching provider, in provider order; the session's method is the last one's (Thruway PHP T6).
    const verifier = known(matching[matching.length - 1]);
    const frames: Frame[] = [];
    let verifierExtra: Dict = {};
    for (const p of matching) {
      const state = this.providerStates.get(p.method);
      if (state === 'stale') {
        this.abortConn(conn, this.q.provider_failure_abort, {});
        return;
      }
      if (state === 'silent') continue;
      if (p.method === 'anonymous') {
        this.welcome(conn, hello, {}, true); // an anonymous method admits with the dialect's anonymous WELCOME
        return;
      }
      const admit = p.welcome;
      if (admit !== undefined) {
        this.providerWelcome(conn, hello, p, () => admit(hello));
        return;
      }
      const extra = this.guard(() => p.extra?.(hello) ?? {}, undefined);
      if (extra === false) {
        this.abortConn(conn, this.q.auth_failure_abort, {});
        return;
      }
      if (!isPlainObject(extra)) {
        this.abortConn(conn, Uri.AUTHORIZATION_FAILED, { message: 'the provider failed' });
        return;
      }
      if (p === verifier) verifierExtra = extra;
      frames.push([T.CHALLENGE, p.method, extra]);
    }
    this.challenged(conn, hello, (signature) => {
      this.providerAuthenticate(conn, hello, verifier, verifierExtra, signature);
    });
    const gap = this.options.challengeGap ?? 0;
    frames.forEach((f, k) => {
      if (k === 0 || gap <= 0) {
        this.send(conn, f);
        return;
      }
      const entry = {
        frame: f,
        cancel: this.timer(k * gap, () => {
          conn.challenges.splice(conn.challenges.indexOf(entry), 1);
          this.send(conn, f);
        }),
      };
      conn.challenges.push(entry);
    });
  }

  /** CHALLENGEs still waiting for their gap go out now, in order (an AUTHENTICATE arrived). */
  private flushChallenges(conn: Conn): void {
    for (const { frame, cancel } of conn.challenges.splice(0)) {
      cancel();
      this.send(conn, frame);
    }
  }

  private cancelChallenges(conn: Conn): void {
    for (const { cancel } of conn.challenges.splice(0)) cancel();
  }

  private providerWelcome(
    conn: Conn,
    hello: SimHello,
    provider: SimAuthProvider,
    decide: () => Record<string, unknown> | false,
  ): void {
    const details: unknown = this.guard(decide, undefined);
    if (details === false) {
      this.abortConn(conn, this.q.auth_failure_abort, {});
    } else if (!isPlainObject(details)) {
      this.abortConn(conn, Uri.AUTHORIZATION_FAILED, { message: 'the provider failed' });
    } else {
      const method = provider.verify === undefined ? provider.method : undefined; // NOCHALLENGE forces authmethod
      const welcome = this.q.thruway_auth_details ? thruwayAuthDetails(details, method) : details;
      // the session's own auth details name the method, whatever the WELCOME says (Thruway PHP sets it at the HELLO)
      this.welcome(conn, hello, welcome, false, provider.method);
    }
  }

  private providerAuthenticate(
    conn: Conn,
    hello: SimHello,
    provider: SimAuthProvider,
    extra: Dict,
    signature: string,
  ): void {
    const state = this.providerStates.get(provider.method);
    if (state === 'stale') {
      this.abortConn(conn, this.q.provider_failure_abort, {});
      return;
    }
    if (state !== 'registered') return; // silent, or gone: Thruway finds no handler and never answers
    const verify = provider.verify;
    this.providerWelcome(conn, hello, provider, () => (verify === undefined ? false : verify(signature, hello, extra)));
  }

  private welcome(conn: Conn, hello: SimHello, details: Dict, anonymous: boolean, authmethod?: string): void {
    // (no CHALLENGE is still waiting for its gap: an AUTHENTICATE sends them before any verdict)
    const pending = conn.state.phase === 'challenge' ? conn.state.session : undefined;
    const realm = this.realm(hello.realm);
    const session = pending ?? new Session(this.nextId(), realm, conn, hello.details, (c, f) => this.send(c, f));
    const anon: Record<string, unknown> = {};
    if (anonymous) {
      const values = {
        realm: hello.realm,
        authid: `anonymous-${String(session.id)}`,
        authrole: 'anonymous',
        authmethod: 'anonymous',
        authprovider: this.q.authprovider,
      };
      for (const key of this.q.anonymous_welcome) anon[key] = values[key];
    }
    const welcome: Dict = { ...this.q.welcome_extra, ...anon, roles: this.q.roles, ...details };
    session.establish(welcome, authmethod);
    conn.session = session;
    conn.state = { phase: 'established', session };
    realm.sessions.add(session);
    this.send(conn, [T.WELCOME, session.id, welcome]);
  }

  /** ABORT (lost on `closing_frames_delivered: false`), then the dialect's `abort_close`. */
  private abortConn(conn: Conn, reason: string, details: Dict): void {
    if (!this.q.closing_frames_delivered) {
      this.lose(conn);
      return;
    }
    // (CHALLENGEs still waiting for their gap are cancelled by closeAfter)
    // wamp-server writes `[3, reason, {roles}]`: its WELCOME details where the reason belongs
    this.send(
      conn,
      this.q.abort_fields_swapped ? [T.ABORT, reason, { roles: this.q.roles }] : [T.ABORT, details, reason],
    );
    this.endSession(conn);
    this.closeAfter(conn, this.q.abort_close);
  }

  /** The client ended it (its ABORT, or the GOODBYE handshake is complete). */
  private clientLeft(conn: Conn, how: 'abort' | 'goodbye'): void {
    this.endSession(conn);
    this.closeAfter(conn, how === 'abort' ? this.q.abort_close : this.q.router_closes_after_goodbye);
  }

  /** Close as the dialect does after a closing handshake, or keep the socket open for a new HELLO. */
  private closeAfter(conn: Conn, close: QuirkFlags['abort_close']): void {
    if (close === undefined) {
      this.cancelChallenges(conn);
      conn.state = HELLO;
    } else {
      this.closeLink(conn, close.code, close.reason);
    }
  }

  /** The router's GOODBYE: the session leaves routing at once; the reply completes the handshake. */
  private goodbyeConn(conn: Conn, reason: string, details: Dict): void {
    if (!this.q.closing_frames_delivered) {
      this.lose(conn);
      return;
    }
    this.send(conn, [T.GOODBYE, details, reason]);
    conn.state = { phase: 'goodbye' };
    this.endSession(conn);
  }

  // --- in a session ----------------------------------------------------------------------------------------------

  private established(conn: Conn, s: Session, frame: Frame, record: FrameRecord): void {
    const type = frame[0] as number;
    switch (type) {
      case T.SUBSCRIBE:
        this.subscribe(s, frame, record);
        return;
      case T.UNSUBSCRIBE:
        this.unsubscribe(s, frame);
        return;
      case T.PUBLISH:
        this.publishFrom(s, frame, record);
        return;
      case T.REGISTER:
        this.register(s, frame);
        return;
      case T.UNREGISTER:
        this.unregister(s, frame);
        return;
      case T.CALL:
        this.call(s, frame, record);
        return;
      case T.CANCEL:
        this.cancel(s, frame);
        return;
      case T.YIELD:
      case T.ERROR:
        this.answer(s, frame);
        return;
      case T.GOODBYE:
        if (!(isPlainObject(frame[1]) && typeof frame[2] === 'string') && this.react(conn, 'malformed', frame)) return;
        if (!this.q.closing_frames_delivered) {
          this.lose(conn);
          return;
        }
        this.send(conn, [T.GOODBYE, this.q.goodbye_reply_details, this.q.goodbye_reply_reason]);
        this.clientLeft(conn, 'goodbye');
        return;
      case T.ABORT:
        this.clientLeft(conn, 'abort');
        return;
      case T.HELLO:
        this.react(conn, 'second-hello', frame);
        return;
      case T.AUTHENTICATE:
        return;
      default:
        this.react(conn, 'unknown-type', frame);
    }
  }

  /** The common checks of a request (id rule, shape, Crossbar's option types, Nexus's strict ids); false when the
   *  frame was dropped or reacted to. */
  private accept(s: Session, frame: Frame, shape: boolean): boolean {
    const verdict = requestIdVerdict(this.q.request_id_validation, frame[1]);
    if (verdict === 'ignore') return false;
    const options = frame[2];
    const typed = !this.q.option_types || !isPlainObject(options) || optionTypesOk(frame[0] as number, options);
    if (verdict === 'malformed' || !shape || !typed) {
      this.react(s.conn, 'malformed', frame);
      return false;
    }
    // Nexus: a CALL with the id of a call in flight is a progressive continuation, not a new request
    if (this.q.strict_ids && !(frame[0] === T.CALL && s.calls.has(frame[1]))) {
      if (frame[1] !== s.nextRequest) {
        this.lose(s.conn);
        return false;
      }
      s.nextRequest++;
    }
    return true;
  }

  private errorReply(s: Caller, type: number, request: unknown, uri: string, message?: string): void {
    s.deliver([T.ERROR, type, request, {}, uri, ...routerErrorPayload(this.q, message)]);
  }

  /** The URI and authorization checks of a request; false when it was answered (or the connection closed). */
  private permitted(s: Session, kind: RequestKind, frame: Frame, uri: string, match: string, reply: boolean): boolean {
    const valid = uriAllowed(this.q.uri_check[kind], uri, match);
    if (!valid && this.q.invalid_uri_kills.includes(kind)) {
      this.closeLink(s.conn, 1011, 'WAMP Internal Error');
      return false;
    }
    if (!valid || (this.q.reserved_wamp.includes(kind) && uri.startsWith('wamp.'))) {
      if (reply) this.errorReply(s, frame[0] as number, frame[1], Uri.INVALID_URI);
      return false;
    }
    const denied = this.denied(s, kind, uri, frame[2] as Dict);
    if (denied !== undefined) {
      if (reply) this.errorReply(s, frame[0] as number, frame[1], denied);
      return false;
    }
    return true;
  }

  /** The error URI of the first `deny` rule that matches (test code: a throw denies nothing). */
  private denied(s: Session, type: RequestKind, uri: string, options: Dict): string | undefined {
    const request: SimRequest = { type, uri, options, session: sessionView(s) };
    for (const rule of [...this.rules]) {
      const verdict = this.guard(() => rule(request), undefined);
      if (verdict === true) return Uri.NOT_AUTHORIZED;
      if (typeof verdict === 'string') return verdict;
    }
    return undefined;
  }

  private checkStrict(record: FrameRecord, topic: string): void {
    if (this.strict && !this.declared.has(topic)) this.unscripted.push(record);
  }

  // --- broker ----------------------------------------------------------------------------------------------------

  private subscribe(s: Session, frame: Frame, record: FrameRecord): void {
    const [, request, options, topic] = frame;
    if (!this.accept(s, frame, isPlainObject(options) && typeof topic === 'string')) return;
    const t = topic as string;
    let match = policy(options);
    if (match !== 'exact') {
      const support = this.q.subscribe_match[match === 'prefix' ? 'prefix' : 'wildcard'];
      if (support === 'no-reply') return;
      if (support === 'exact') match = 'exact';
    }
    if (!this.permitted(s, 'subscribe', frame, t, match, true)) return;
    this.checkStrict(record, t);
    const sameKey = (x: Sub): boolean => x.topic === t && x.match === match;
    const mode = this.q.subscription_ids;
    const key = `${match}\u0000${t}`;
    const disclose = read(options, 'disclose_publisher') === true;
    let sub = mode === 'per-session' ? [...s.subs.values()].find(sameKey) : undefined;
    if (mode === 'shared') {
      const id = s.realm.shared.get(key) ?? this.nextId();
      sub = s.subs.get(id) ?? { id, topic: t, match, eventId: id, disclose };
    } else if (sub === undefined) {
      const id = this.scopedId(s, 'subscription');
      const first = mode === 'per-subscribe-first' ? [...s.subs.values()].find(sameKey) : undefined;
      sub = { id, topic: t, match, eventId: first?.eventId ?? id, disclose };
    }
    s.subs.set(sub.id, sub);
    // the realm's first subscription id of this topic + match (Crossbar's shared id, wamp-server's EVENT publication)
    if (!s.realm.shared.has(key)) s.realm.shared.set(key, sub.id);
    this.send(s.conn, [T.SUBSCRIBED, request, sub.id]);
  }

  private removeSub(s: Session, sub: Sub): void {
    s.subs.delete(sub.id);
    const same = (x: Sub): boolean => x.topic === sub.topic && x.match === sub.match;
    if (![s, ...s.realm.sessions].some((x) => [...x.subs.values()].some(same))) {
      s.realm.shared.delete(`${sub.match}\u0000${sub.topic}`);
    }
  }

  private unsubscribe(s: Session, frame: Frame): void {
    const [, request, id] = frame;
    if (!this.accept(s, frame, isId(id))) return;
    const sub = s.subs.get(id as number);
    if (sub !== undefined) {
      this.removeSub(s, sub);
      this.send(s.conn, [T.UNSUBSCRIBED, request]);
      return;
    }
    const unknown = this.q.unsubscribe_unknown;
    if (unknown === 'error') this.errorReply(s, T.UNSUBSCRIBE, request, Uri.NO_SUCH_SUBSCRIPTION);
    else if (unknown === 'close-1011') this.closeLink(s.conn, 1011, '');
  }

  private publishFrom(s: Session, frame: Frame, record: FrameRecord): void {
    const [, request, options, topic] = frame;
    if (!this.accept(s, frame, isPlainObject(options) && typeof topic === 'string' && validTail(frame, 4))) return;
    const opts = options as Dict;
    const ack = opts['acknowledge'] === true;
    if (!this.permitted(s, 'publish', frame, topic as string, 'exact', ack)) return;
    this.checkStrict(record, topic as string);
    const publication = this.nextId();
    const events = this.events(s.realm, s, topic as string, opts, publication, frame);
    const published = ack && (this.q.ack_without_subscribers || events.length > 0);
    if (published && this.q.self_publish_order === 'published-first')
      this.send(s.conn, [T.PUBLISHED, request, publication]);
    for (const [to, event] of events) this.send(to.conn, event);
    if (published && this.q.self_publish_order === 'event-first')
      this.send(s.conn, [T.PUBLISHED, request, publication]);
  }

  /** The EVENTs of a publication (`publisher` undefined: the router's own `publish`), payload from `frame[4]`. */
  private events(
    realm: Realm,
    publisher: Session | undefined,
    topic: string,
    options: Dict,
    publication: number,
    frame: Frame,
  ): (readonly [Session, Frame])[] {
    const out: (readonly [Session, Frame])[] = [];
    const payload = forwardPayload(this.q.payload, 'event', frame, 4);
    for (const s of [...realm.sessions]) {
      if (publisher !== undefined && !this.eligible(s, publisher, options)) continue;
      for (const sub of s.subs.values()) {
        if (!matches(sub.topic, sub.match, topic, this.q.mqtt_wildcards && sub.match === 'exact')) continue;
        const details: Record<string, unknown> = {};
        const topicDetail = this.q.event_details_topic;
        if (topicDetail === 'always' || (topicDetail === 'pattern' && sub.match !== 'exact')) details['topic'] = topic;
        if (publisher !== undefined) this.disclosePublisher(details, publisher, options, sub.disclose, topic);
        const pubId =
          this.q.event_publication_id === 'subscription'
            ? known(realm.shared.get(`${sub.match}\u0000${sub.topic}`)) // set while any subscription has the key
            : publication;
        out.push([s, [T.EVENT, sub.eventId, pubId, details, ...payload]]);
      }
    }
    return out;
  }

  private disclosePublisher(
    details: Record<string, unknown>,
    publisher: Session,
    options: Dict,
    subscriberAsked: boolean,
    topic: string,
  ): void {
    const mode = this.q.publisher_disclosure;
    if (mode === 'subscriber') {
      if (!subscriberAsked) return;
      const { authid, authrole, authroles, authmethod } = publisher.auth;
      details['publisher'] = publisher.id;
      details['topic'] = topic;
      Object.assign(details, { authid, authrole, publisher_authid: authid, publisher_authrole: authrole });
      Object.assign(details, { authroles, authmethod });
      return;
    }
    if (mode === 'never' || (mode === 'request' && options['disclose_me'] !== true)) return;
    details['publisher'] = publisher.id;
    if (mode === 'always-auth') {
      details['publisher_authid'] = publisher.auth.authid;
      details['publisher_authrole'] = publisher.auth.authrole;
    }
  }

  /** Publisher exclusion and black/white-listing (of the WAMP spec's Advanced Profile) in the dialect's way. */
  private eligible(s: Session, publisher: Session, options: Dict): boolean {
    const self = s === publisher;
    const exclusion = this.q.exclude_me;
    if (self && (exclusion === 'always' || (exclusion === 'spec' && options['exclude_me'] !== false))) return false;
    const listing = this.q.blackwhite_listing;
    if (listing === 'ignored') return true;
    if (listing === 'bondy') return !Array.isArray(options['eligible']);
    if (listing === 'thruway') return thruwayEligible(s.id, s.auth, options);
    const lists: readonly [string, readonly unknown[]][] = [
      ['', [s.id]],
      ['_authid', [s.auth.authid]],
      ['_authrole', s.auth.authroles],
    ];
    for (const [suffix, values] of lists) {
      const only = options[`eligible${suffix}`];
      const not = options[`exclude${suffix}`];
      if (Array.isArray(only) && !values.some((v) => only.includes(v))) return false;
      if (Array.isArray(not) && values.some((v) => not.includes(v))) return false;
    }
    return true;
  }

  // --- dealer ----------------------------------------------------------------------------------------------------

  private procedureOf(uri: unknown): string {
    return this.q.lowercase_procedures ? (uri as string).toLowerCase() : (uri as string);
  }

  private register(s: Session, frame: Frame): void {
    const [, request, options, procedureRaw] = frame;
    if (!this.accept(s, frame, isPlainObject(options) && typeof procedureRaw === 'string')) return;
    const opts = options as Dict;
    const procedure = this.procedureOf(procedureRaw);
    let match = policy(opts);
    if (match !== 'exact') {
      const support = this.q.register_match[match === 'prefix' ? 'prefix' : 'wildcard'];
      if (support === 'invalid_uri') {
        this.errorReply(s, T.REGISTER, request, Uri.INVALID_URI);
        return;
      }
      if (support === 'exact') match = 'exact';
    }
    if (!this.permitted(s, 'register', frame, procedure, match, true)) return;
    const invoke = this.invokePolicy(opts);
    const disclose = opts['disclose_caller'] === true;
    const existing = s.realm.registrations.find((r) => r.procedure === procedure && r.match === match);
    const refuse = (uri: string): void => {
      this.errorReply(s, T.REGISTER, request, uri);
    };
    if (match === 'exact' && this.procedures.has(procedure)) {
      refuse(Uri.PROCEDURE_ALREADY_EXISTS);
    } else if (existing === undefined || this.q.shared_registration === 'implicit') {
      this.addCallee(s, existing, request, procedure, match, invoke, disclose);
    } else if (this.q.shared_registration === 'none' || existing.invoke === 'single') {
      const orphan = opts['replace_orphaned_session'];
      if (this.q.replace_orphaned_session && (orphan === 'yes' || orphan === true)) {
        this.replaceOrphan(s, existing, request, procedure, match, invoke, disclose);
      } else {
        refuse(Uri.PROCEDURE_ALREADY_EXISTS);
      }
    } else if (existing.invoke !== invoke) {
      refuse(this.q.invoke_mismatch_error);
    } else if (this.q.invocation_details === 'thruway' && existing.discloseCaller !== disclose) {
      refuse(Uri.UNKNOWN); // Thruway: "Registration and procedure must agree on disclose caller"
    } else if (existing.callees.some((c) => c.session === s)) {
      refuse(Uri.PROCEDURE_ALREADY_EXISTS);
    } else {
      this.addCallee(s, existing, request, procedure, match, invoke, disclose);
    }
  }

  /** The `invoke` policy of a REGISTER: spec values (anything else is `single`); Thruway PHP's `_thruway` (also
   *  `thruway_multiregister`); fox-wamp's implicit sharing is `first`. */
  private invokePolicy(options: Dict): string {
    if (this.q.shared_registration === 'implicit') return 'first';
    const invoke = options['invoke'];
    if (this.q.thruway_invoke) {
      if (invoke === undefined) return options['thruway_multiregister'] === true ? '_thruway' : 'single';
      const lower = typeof invoke === 'string' ? invoke.toLowerCase() : invoke;
      return SPEC_INVOKE.has(lower) || lower === '_thruway' ? (lower as string) : 'single';
    }
    return SPEC_INVOKE.has(invoke) ? (invoke as string) : 'single';
  }

  private addCallee(
    s: Session,
    existing: Registration | undefined,
    request: unknown,
    procedure: string,
    match: string,
    invoke: string,
    discloseCaller: boolean,
  ): void {
    let reg = existing;
    if (reg === undefined) {
      reg = {
        id: this.nextId(),
        realm: s.realm,
        procedure,
        match,
        invoke,
        discloseCaller,
        callees: [],
        queue: [],
        next: 0,
      };
      s.realm.registrations.push(reg);
    }
    const localId =
      this.q.shared_registration_ids === 'distinct' && existing !== undefined
        ? this.nextId()
        : this.ids === 'per-session'
          ? this.scopedId(s, 'registration')
          : reg.id;
    const callee: Callee = { session: s, registration: reg, localId, discloseCaller };
    reg.callees.push(callee);
    s.regs.set(localId, callee);
    this.send(s.conn, [T.REGISTERED, request, localId]);
    this.drainQueue(reg);
  }

  /** Thruway PHP's `replace_orphaned_session`: the old callee is pinged; one that does not answer within 5 s (its link
   *  is frozen, or vanished) is shut down and the new REGISTER succeeds. */
  private replaceOrphan(
    s: Session,
    existing: Registration,
    request: unknown,
    procedure: string,
    match: string,
    invoke: string,
    discloseCaller: boolean,
  ): void {
    const old = known(existing.callees[0]).session;
    if (old === s || !old.conn.link.unresponsive) {
      this.errorReply(s, T.REGISTER, request, Uri.PROCEDURE_ALREADY_EXISTS);
      return;
    }
    this.timer(5000, () => {
      if (!s.alive) return;
      if (old.alive && !old.conn.link.unresponsive) {
        this.errorReply(s, T.REGISTER, request, Uri.PROCEDURE_ALREADY_EXISTS);
        return;
      }
      if (old.alive) {
        this.endSession(old.conn);
        this.lose(old.conn);
      }
      // another REGISTER may have taken the procedure meanwhile (a second orphan replacement, say)
      if (s.realm.registrations.some((r) => r.procedure === procedure && r.match === match)) {
        this.errorReply(s, T.REGISTER, request, Uri.PROCEDURE_ALREADY_EXISTS);
        return;
      }
      this.addCallee(s, undefined, request, procedure, match, invoke, discloseCaller);
    });
  }

  private unregister(s: Session, frame: Frame): void {
    const [, request, id] = frame;
    if (!this.accept(s, frame, isId(id))) return;
    const callee = s.regs.get(id as number);
    if (callee !== undefined) {
      this.removeCallee(callee);
      this.send(s.conn, [T.UNREGISTERED, request]);
      return;
    }
    const foreign = s.realm.registrations.some((r) => r.callees.some((c) => c.localId === id));
    const uri = foreign ? Uri.NO_SUCH_REGISTRATION : this.q.unregister_unknown_error;
    if (uri !== undefined) this.errorReply(s, T.UNREGISTER, request, uri);
  }

  private removeCallee(callee: Callee): void {
    const reg = callee.registration;
    callee.session.regs.delete(callee.localId);
    reg.callees.splice(reg.callees.indexOf(callee), 1);
    if (reg.callees.length > 0) return;
    reg.realm.registrations.splice(reg.realm.registrations.indexOf(reg), 1);
    for (const call of [...reg.queue]) this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.NO_SUCH_PROCEDURE]);
  }

  /** Exact first, then the longest matching prefix, then the wildcard with the most literal components. */
  private lookup(realm: Realm, uri: string): Registration | undefined {
    let best: Registration | undefined;
    let bestScore = -1;
    for (const reg of realm.registrations) {
      if (!matches(reg.procedure, reg.match, uri)) continue;
      const score =
        reg.match === 'exact'
          ? Infinity
          : reg.match === 'prefix'
            ? 2 ** 20 + reg.procedure.length
            : reg.procedure.split('.').filter((part) => part !== '').length;
      if (score > bestScore) {
        best = reg;
        bestScore = score;
      }
    }
    return best;
  }

  private newCall(caller: Caller, realm: Realm, requestId: unknown, options: Dict, frame: Frame): Call {
    return { caller, realm, requestId, progress: options['receive_progress'] === true, options, frame, done: false };
  }

  /** The call is reachable for CANCEL (the caller's index; the realm's, read with `realm_call_index`) and running. */
  private index(call: Call): void {
    call.caller.calls.set(call.requestId, call);
    call.caller.active.add(call);
    call.realm.callIndex.set(call.requestId, call);
  }

  private unindex(call: Call): void {
    const { caller, requestId, realm } = call;
    caller.active.delete(call);
    if (caller.calls.get(requestId) === call) caller.calls.delete(requestId);
    // Thruway PHP's removeCall unsets the realm index entry of that request id, whoever's CALL it holds now
    realm.callIndex.delete(requestId);
  }

  private call(s: Session, frame: Frame, record: FrameRecord): void {
    const [, request, options, procedureRaw] = frame;
    const shape = isPlainObject(options) && typeof procedureRaw === 'string' && validTail(frame, 4);
    if (!this.accept(s, frame, shape)) return;
    const procedure = this.procedureOf(procedureRaw);
    if (!this.permitted(s, 'call', frame, procedure, 'exact', true)) return;
    const opts = options as Dict;
    const existing = s.calls.get(request);
    if (existing !== undefined && this.q.duplicate_call !== 'served') {
      // 'drop': flagged by the oracle; 'continuation' (Nexus): invoked again (while the registration has a callee),
      // answered once
      const reg = existing.invocation?.registration;
      if (this.q.duplicate_call === 'continuation' && reg !== undefined && reg.callees.length > 0) {
        this.sendInvocation(existing, reg, procedure, frame);
      }
      return;
    }
    const handler = this.procedures.get(procedure);
    const reg = this.lookup(s.realm, procedure); // a scripted procedure wins
    if (handler === undefined && reg === undefined) {
      if (procedure !== Uri.PING_PROCEDURE && this.strict) this.unscripted.push(record);
      const message = this.q.no_such_procedure_message
        ? `no callee registered for procedure <${procedure}>`
        : undefined;
      this.errorReply(s, T.CALL, request, Uri.NO_SUCH_PROCEDURE, message);
      return;
    }
    const call = this.newCall(s, s.realm, request, opts, frame);
    this.index(call);
    this.armTimeout(call);
    if (handler !== undefined) this.runHandler(call, handler);
    else this.invokeOn(call, known(reg), procedure);
  }

  /** `CALL.Options.timeout` in the dialect's way (`call_timeout`). */
  private armTimeout(call: Call): void {
    const timeout = call.options['timeout'];
    const mode = this.q.call_timeout;
    if (mode === 'ignored' || typeof timeout !== 'number' || !(timeout > 0)) return;
    const ms =
      mode === 'seconds' ? timeout * 1000 : mode === 'coarse' ? Math.ceil(timeout / 1000) * 1000 + 200 : timeout;
    // (a settled call cleared this timer: `forget`)
    call.cancelTimer = this.timer(ms, () => {
      const inv = call.invocation;
      // (an invocation that is over, answered after Crossbar's hang or its callee gone, gets no INTERRUPT)
      if (inv?.callee.invocations.delete(inv.id) === true) {
        this.invocationFinished(inv);
        if (mode !== 'coarse') {
          const options = interruptOptions(this.q.interrupt_options, 'killnowait', Uri.TIMEOUT);
          inv.callee.deliver([T.INTERRUPT, inv.id, options]);
        }
      }
      const answer = mode === 'seconds' ? [Uri.CANCELED, ['timeout reached']] : [Uri.TIMEOUT];
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, ...answer]);
    });
  }

  /** The `procedure()` contract. */
  private runHandler(call: Call, handler: Handler): void {
    const frame = call.frame;
    const args = Array.isArray(frame[4]) ? [...(frame[4] as unknown[])] : [];
    const kwargs = isPlainObject(frame[5]) ? { ...frame[5] } : {};
    let input: Input<unknown>;
    try {
      input = handler(args, kwargs, { ...call.options });
    } catch (error) {
      this.callError(call, error);
      return;
    }
    // Every callback defers to `run`: the result is sent after this CALL's task, never inside it.
    call.subscription = subscribeInput(
      input,
      {
        next: (value) => {
          this.run(() => {
            this.handlerNext(call, value);
          });
        },
        value: (value) => {
          this.run(() => {
            this.callResult(call, yieldPayload(value));
          });
        },
        complete: () => {
          this.run(() => {
            this.callResult(call, call.progress || call.last === undefined ? [] : yieldPayload(call.last.value));
          });
        },
        error: (error) => {
          this.run(() => {
            this.callError(call, error);
          });
        },
      },
      this.reporter,
    );
  }

  private handlerNext(call: Call, value: unknown): void {
    if (call.done) return;
    if (!call.progress) {
      call.last = { value };
      return;
    }
    const payload = yieldPayload(value);
    if (payload === undefined) {
      this.callResult(call, undefined);
      return;
    }
    if (!call.caller.deliver([T.RESULT, call.requestId, { progress: true }, ...payload])) {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, ['result could not be serialized']]);
    }
  }

  /** The final RESULT (`undefined`: an invalid Yield payload ⇒ runtime_error). */
  private callResult(call: Call, payload: readonly unknown[] | undefined): void {
    if (call.done) return;
    if (payload === undefined) {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, ['invalid result payload']]);
      return;
    }
    this.settle(call, [T.RESULT, call.requestId, {}, ...payload]);
  }

  /** A thrown/rejected/errored handler result. */
  private callError(call: Call, error: unknown): void {
    if (call.done) return;
    if (!isWampError(error)) {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, [messageOf(error)]]);
      return;
    }
    const uri = read(error, 'uri');
    const args = read(error, 'args');
    const kwargs = read(error, 'kwargs');
    const details = read(error, 'details');
    if (!isValidUri(uri as string)) {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, [String(uri)]]);
      return;
    }
    if (!Array.isArray(args) || !isPlainObject(kwargs)) {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, ['invalid result payload']]);
      return;
    }
    this.settle(call, [
      T.ERROR,
      T.CALL,
      call.requestId,
      isPlainObject(details) ? details : {},
      uri,
      ...outboundPayload(args, kwargs),
    ]);
  }

  /** Send the final answer of a call and forget it. */
  private settle(call: Call, frame: Frame): void {
    this.forget(call);
    if (!call.caller.deliver(frame)) {
      call.caller.deliver([T.ERROR, T.CALL, call.requestId, {}, Uri.RUNTIME_ERROR, ['result could not be serialized']]);
    }
  }

  /** The call is over for the router (no answer is sent); a call still in a `_thruway` queue leaves it. */
  private forget(call: Call): void {
    call.done = true;
    this.unindex(call);
    const queued = call.queuedOn;
    if (queued !== undefined) {
      queued.queue.splice(queued.queue.indexOf(call), 1);
      call.queuedOn = undefined;
    }
    call.subscription?.unsubscribe();
    call.cancelTimer?.();
  }

  /** Invoke a callee of `reg` now, or queue the call (`_thruway` while every callee is busy). */
  private invokeOn(call: Call, reg: Registration, procedure: string): void {
    if (reg.invoke === '_thruway' && reg.callees.every((c) => c.session.invocations.size > 0)) {
      call.queuedOn = reg;
      reg.queue.push(call);
      return;
    }
    this.sendInvocation(call, reg, procedure, call.frame);
  }

  /** Queued `_thruway` calls go to callees that became idle. */
  private drainQueue(reg: Registration): void {
    while (reg.queue.length > 0 && reg.callees.some((c) => c.session.invocations.size === 0)) {
      const call = known(reg.queue.shift());
      call.queuedOn = undefined;
      this.sendInvocation(call, reg, reg.procedure, call.frame);
    }
  }

  /** A callee is free again: `_thruway` calls waiting for one go (other registrations never queue). */
  private invocationFinished(inv: Invocation): void {
    this.drainQueue(inv.registration);
  }

  private sendInvocation(call: Call, reg: Registration, procedure: string, frame: Frame): void {
    const callee = this.pick(reg);
    const session = callee.session;
    const id = this.scopedId(session, 'invocation');
    const q = this.q;
    const progress =
      call.progress &&
      q.progressive_results &&
      (!q.progress_needs_callee_feature || session.feature('callee', 'progressive_call_results'));
    const details = this.invocationDetails(call, callee, reg, procedure, progress);
    const invocation: Invocation = { call, callee: session, registration: reg, id, progress };
    call.invocation = invocation;
    session.invocations.set(id, invocation);
    this.send(session.conn, [
      T.INVOCATION,
      id,
      callee.localId,
      details,
      ...forwardPayload(q.payload, 'invocation', frame, 4),
    ]);
  }

  private invocationDetails(call: Call, callee: Callee, reg: Registration, procedure: string, progress: boolean): Dict {
    const mode = this.q.invocation_details;
    if (mode === 'options') return { ...call.options };
    const caller = call.caller;
    const details: Record<string, unknown> = {};
    if (mode === 'thruway') {
      if (reg.discloseCaller && caller.id !== undefined) {
        details['caller'] = caller.id;
        details['authid'] = caller.auth.authid;
        details['authrole'] = caller.auth.authrole;
        details['authroles'] = caller.auth.authroles;
        details['authmethod'] = caller.auth.authmethod;
      }
      if (call.progress) details['receive_progress'] = true;
      return details;
    }
    if (mode === 'none') {
      if (call.progress) details['receive_progress'] = true;
      return details;
    }
    if (reg.match !== 'exact') details['procedure'] = procedure;
    if (progress) details['receive_progress'] = true;
    if (
      caller.id !== undefined &&
      (mode === 'always-auth' || callee.discloseCaller || call.options['disclose_me'] === true)
    ) {
      details['caller'] = caller.id;
      if (mode === 'always-auth') {
        details['caller_authid'] = caller.auth.authid;
        details['caller_authrole'] = caller.auth.authrole;
      }
    }
    if (this.q.call_timeout === 'seconds' && call.options['timeout'] !== undefined)
      details['timeout'] = call.options['timeout'];
    return details;
  }

  /** The callee of the next INVOCATION by the `invoke` policy (a registration always has one callee at least). */
  private pick(reg: Registration): Callee {
    const callees = reg.callees;
    const n = callees.length;
    if (reg.invoke === 'roundrobin') return nth(callees, reg.next++ % n);
    if (reg.invoke === 'random') return nth(callees, Math.floor(this.random() * n));
    if (reg.invoke === '_thruway') return known(callees.find((c) => c.session.invocations.size === 0));
    return nth(callees, reg.invoke === 'last' ? n - 1 : 0); // single, first
  }

  /** INTERRUPT to the callee (nothing to one whose session ended: its socket may still be open, after the router's
   *  GOODBYE or hosting a new session). */
  private interrupt(inv: Invocation, mode: 'kill' | 'killnowait'): void {
    inv.callee.deliver([T.INTERRUPT, inv.id, interruptOptions(this.q.interrupt_options, mode, Uri.CANCELED)]);
  }

  private cancel(s: Session, frame: Frame): void {
    const [, request, options] = frame;
    const verdict = requestIdVerdict(this.q.request_id_validation, request);
    if (verdict === 'ignore') return;
    const typed = !this.q.option_types || !isPlainObject(options) || optionTypesOk(T.CANCEL, options);
    if (verdict === 'malformed' || !isPlainObject(options) || !typed) {
      this.react(s.conn, 'malformed', frame);
      return;
    }
    const call = this.q.realm_call_index ? s.realm.callIndex.get(request) : s.calls.get(request);
    if (call === undefined) {
      const unknown = this.q.cancel_unknown;
      if (unknown === 'no_such_call') this.errorReply(s, T.CANCEL, request, 'wamp.error.no_such_call');
      else if (unknown === 'goodbye') this.cancelGoodbye(s);
      return;
    }
    if (call.caller !== s || call.killing === true) return; // T1: another session's CALL; a kill already pending
    this.cancelCall(call, options['mode']);
  }

  /** The router's own answer to a CANCEL (`cancel_error_type`). */
  private cancelAnswer(call: Call, uri: string, args?: readonly unknown[]): Frame {
    return [T.ERROR, this.q.cancel_error_type, call.requestId, {}, uri, ...(args === undefined ? [] : [args])];
  }

  private cancelCall(call: Call, mode: unknown): void {
    const q = this.q;
    const action0 =
      mode === undefined
        ? q.cancel_modes.none
        : CANCEL_MODES.has(mode)
          ? q.cancel_modes[mode as 'kill']
          : q.cancel_modes.unknown;
    const caller = call.caller as Session;
    if (action0 === 'invalid_argument') {
      this.errorReply(caller, T.CANCEL, call.requestId, Uri.INVALID_ARGUMENT);
      return;
    }
    if (call.queuedOn !== undefined) {
      // Thruway: a call still in a queue is removed from it (`forget`) and answered at once
      this.forget(call);
      caller.deliver([T.ERROR, T.CANCEL, call.requestId, { _thruway_removed_from_queue: true }, Uri.CANCELED]);
      return;
    }
    const inv = call.invocation;
    const forgetProgressive = !q.progressive_cancel_final && call.progress;
    let action = action0;
    if (inv !== undefined && !inv.callee.feature('callee', 'call_canceling')) {
      if (q.cancel_without_callee_feature === 'not_supported') {
        caller.deliver(this.cancelAnswer(call, Uri.NOT_SUPPORTED));
        // Thruway PHP's Dealer::processCancel removes a progressive call after any CANCEL that reached it, a refused
        // one too: the callee works on, its answers meet no call ([8,70,…]), the caller never gets a final message
        if (forgetProgressive) this.forgetInvocation(call, inv);
        return;
      }
      if (q.cancel_without_callee_feature === 'skip') action = q.cancel_modes.skip;
    }
    switch (action) {
      case 'ignore':
        return;
      case 'refuse':
        caller.deliver(this.cancelAnswer(call, q.cancel_refusal_uri));
        return;
      case 'goodbye':
        this.cancelGoodbye(caller);
        return;
      case 'hang':
        if (inv === undefined) this.forget(call);
        else call.answered = true; // the callee's answers are discarded
        return;
      case 'skip':
        this.settle(call, this.cancelAnswer(call, Uri.CANCELED, mode === undefined ? q.cancel_error_args : undefined));
        return;
      case 'kill':
        if (inv === undefined) {
          // a scripted procedure is a callee that answers an INTERRUPT with ERROR canceled at once
          if (forgetProgressive) this.forget(call);
          else this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.CANCELED]);
          return;
        }
        call.killing = true;
        this.interrupt(inv, 'kill');
        // Thruway PHP T3: the call is forgotten at the CANCEL; the callee's answer meets no call ([8,8,…])
        if (forgetProgressive) this.forgetInvocation(call, inv);
        return;
      case 'killnowait':
        if (inv !== undefined) {
          inv.callee.invocations.delete(inv.id);
          this.invocationFinished(inv);
          this.interrupt(inv, 'killnowait');
        }
        this.settle(call, this.cancelAnswer(call, Uri.CANCELED));
        return;
    }
  }

  /** Thruway PHP's removeCall of a call whose callee is still working: no answer goes anywhere any more. */
  private forgetInvocation(call: Call, inv: Invocation): void {
    inv.callee.invocations.delete(inv.id);
    this.forget(call);
  }

  /** wamp-server answers every CANCEL with GOODBYE and closes the connection. */
  private cancelGoodbye(s: Session): void {
    this.send(s.conn, [T.GOODBYE, {}, Uri.GOODBYE_AND_OUT_LEGACY]);
    this.endSession(s.conn);
    this.closeAfter(s.conn, this.q.router_closes_after_goodbye);
  }

  /** `invoke().interrupt(mode)`. */
  private routerInterrupt(record: RouterCall, mode: 'kill' | 'killnowait'): void {
    const call = record.call;
    const inv = call?.invocation;
    if (call === undefined || call.done || inv === undefined) return;
    this.interrupt(inv, mode);
    if (mode === 'killnowait') {
      inv.callee.invocations.delete(inv.id);
      this.invocationFinished(inv);
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.CANCELED]);
    }
  }

  /** YIELD or ERROR(68) from a callee. */
  private answer(s: Session, frame: Frame): void {
    const isError = frame[0] === T.ERROR;
    if (isError && frame[1] !== T.INVOCATION) return; // flagged by the oracle; routers ignore it
    const id = answerId(frame);
    if (id === undefined) {
      this.react(s.conn, 'malformed', frame);
      return;
    }
    const inv = s.invocations.get(id);
    if (inv === undefined) {
      if (this.q.foreign_answer === 'close-1002' && [...s.realm.sessions].some((x) => x.invocations.has(id))) {
        this.closeLink(s.conn, 1002, 'WAMP Protocol Error');
        return;
      }
      // Unknown: never sent, finished, interrupted with killnowait, the caller left, a cancelled progressive call.
      if (this.q.answer_unknown_invocation === 'error') {
        this.send(
          s.conn,
          isError ? [T.ERROR, T.ERROR, id, {}, Uri.NO_SUCH_PROCEDURE] : [T.ERROR, T.YIELD, id, {}, Uri.UNKNOWN],
        );
      }
      return;
    }
    const call = inv.call;
    const progress = !isError && read(frame[2], 'progress') === true;
    if (progress && this.q.progressive_results) {
      if ((inv.progress || this.q.unrequested_progress === 'forward') && call.answered !== true && !call.done) {
        call.caller.deliver([
          T.RESULT,
          call.requestId,
          this.resultDetails(inv, true),
          ...forwardPayload(this.q.payload, 'result', frame, 3),
        ]);
      }
      return;
    }
    if (isError && this.q.invalid_error_uri_kills && !isValidUri(frame[4] as string)) {
      this.closeLink(s.conn, 1011, 'WAMP Internal Error'); // the callee leaves: its caller is answered for that
      return;
    }
    // A final answer (or, without progressive results, the first progress YIELD: it becomes the final RESULT)
    s.invocations.delete(inv.id);
    this.invocationFinished(inv);
    if (call.answered === true || call.done) return;
    if (call.killing === true && this.q.cancel_kill_answer === 'canceled') {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.CANCELED]);
    } else if (!isError) {
      this.settle(call, [
        T.RESULT,
        call.requestId,
        this.resultDetails(inv, false),
        ...forwardPayload(this.q.payload, 'result', frame, 3),
      ]);
    } else if (this.q.callee_error_forwarded === 'yes' || this.q.callee_error_forwarded === 'no-details') {
      this.settle(call, [
        T.ERROR,
        T.CALL,
        call.requestId,
        this.q.callee_error_forwarded === 'yes' ? frame[3] : {},
        frame[4],
        ...forwardPayload(this.q.payload, 'error', frame, 5),
      ]);
    } else if (this.q.callee_error_forwarded === 'rewritten') {
      this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.CALLEE_FAILURE, [frame[4]]]);
    }
  }

  private resultDetails(inv: Invocation, progress: boolean): Dict {
    const details: Record<string, unknown> = progress ? { progress: true } : {};
    if (this.q.result_callee) {
      details['callee'] = inv.callee.id;
      details['callee_authid'] = inv.callee.auth.authid;
      details['callee_authrole'] = inv.callee.auth.authrole;
    }
    return details;
  }

  // --- session end -----------------------------------------------------------------------------------------------

  /** Remove the session from routing (idempotent): its subscriptions and registrations go, the calls it made end,
   *  its callers are answered as the dialect does (`caller_leave_interrupts`, `callee_leave_answer`). */
  private endSession(conn: Conn): void {
    const s = conn.session;
    if (s?.alive !== true) return;
    s.alive = false;
    s.realm.sessions.delete(s);
    for (const sub of [...s.subs.values()]) this.removeSub(s, sub);
    for (const callee of [...s.regs.values()]) this.removeCallee(callee);
    for (const call of [...s.active]) this.callerLeft(s, call);
    // A call settles before it leaves its callee's map, except after a CANCEL skip (settled) or hang (`answered`).
    for (const inv of [...s.invocations.values()]) this.calleeLeft(inv);
    s.invocations.clear();
  }

  private callerLeft(s: Session, call: Call): void {
    const inv = call.invocation;
    const mode = this.q.caller_leave_interrupts;
    if (inv === undefined || mode === 'none') {
      this.forget(call); // (a call still in a `_thruway` queue has no invocation yet: out of the queue too)
      return;
    }
    if (mode === 'cancel') {
      // Thruway PHP: a CANCEL without mode on the caller's behalf, through the realm index (T1: skipped when another
      // session's CALL holds that id). The call stays until its callee answers (to a session that is gone).
      const reachable = !this.q.realm_call_index || call.realm.callIndex.get(call.requestId) === call;
      if (reachable && inv.callee !== s) this.cancelCall(call, undefined);
      return;
    }
    this.forget(call);
    if (inv.callee.invocations.delete(inv.id)) {
      this.invocationFinished(inv);
      // Nothing goes to the ending session itself (a call to its own registration): after a router GOODBYE its
      // socket is still open, and the GOODBYE must be the router's last frame there.
      if (inv.callee !== s && inv.callee.feature('callee', 'call_canceling')) this.interrupt(inv, 'killnowait');
    }
  }

  private calleeLeft(inv: Invocation): void {
    const call = inv.call;
    if (call.answered === true || call.done) return;
    switch (this.q.callee_leave_answer) {
      case 'canceled':
        this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.CANCELED]);
        return;
      case 'canceled-message':
        this.settle(call, [
          T.ERROR,
          T.CALL,
          call.requestId,
          {},
          Uri.CANCELED,
          ['callee disconnected from in-flight request'],
        ]);
        return;
      case 'no_eligible_callee':
        this.settle(call, [T.ERROR, T.CALL, call.requestId, {}, Uri.NO_ELIGIBLE_CALLEE]);
        return;
      case 'hang': // the caller waits forever
        return;
    }
  }
}

/** The `match` policy of SUBSCRIBE/REGISTER options. */
function policy(options: unknown): string {
  const match = read(options, 'match');
  return typeof match === 'string' ? match : 'exact';
}

/** A payload tail `args?, kwargs?`: absent/null or an array, absent/null or a dict. */
function validTail(frame: Frame, at: number): boolean {
  const args = frame[at];
  const kwargs = frame[at + 1];
  return (
    (args === undefined || args === null || Array.isArray(args)) &&
    (kwargs === undefined || kwargs === null || isPlainObject(kwargs))
  );
}

function checked<T extends string>(value: T, allowed: readonly string[], what: string): T {
  if (!allowed.includes(value)) throw new TypeError(`unknown ${what} '${value}'`);
  return value;
}

/** `{subscription|registration: id, reason?}` (an undefined reason is dropped by JSON). */
function revocation(key: 'subscription' | 'registration', id: number, reason: string | undefined): Dict {
  return { [key]: id, reason };
}

/** `items[index]` for an index the caller knows to be in range (noUncheckedIndexedAccess). */
function nth<T>(items: readonly T[], index: number): T {
  return items[index] as T;
}

/** A value the caller knows to be there (a lookup that just succeeded, a non-empty list). */
function known<T>(value: T | undefined): T {
  return value as T;
}

function sessionView(s: Session): SimSession {
  return {
    id: s.id,
    realm: s.realm.name,
    connection: s.conn.link.number,
    hello: s.hello,
    welcome: s.welcome,
    subscriptions: [...s.subs.values()].map(({ id, topic, match }) => ({ id, topic, match })),
    registrations: [...s.regs.values()].map((c) => ({
      id: c.localId,
      procedure: c.registration.procedure,
      match: c.registration.match,
    })),
    calls: s.active.size,
    invocations: s.invocations.size,
    alive: s.alive,
  };
}

export function createRouter(options: SimRouterOptions = {}): SimRouter {
  return new Router(options);
}
