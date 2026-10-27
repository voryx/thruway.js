/**
 * Internal: router quirk profiles. Each dialect is one value of `QuirkFlags`, the complete list of decisions the
 * reference router (router.ts) takes differently per router. Where a decision has a `capabilities.json` key
 * (test/integration/capabilities.json) the flag carries that name (`multi_method_challenge`, `exclude_me`,
 * `callee_leave_answer`, …); its value is the concrete behaviour the simulation needs (a capability file says
 * 'always' / 'never' / 'sometimes', a simulation has to pick one).
 *
 * The values come from the recorded router behaviour under test/routers/: ROUTERS-C.md (Thruway PHP 0.6.1, fox-wamp
 * 0.7.28, wamp-server 0.0.9; its Thruway quirks T1–T8 are cited below), crossbar/README.md (Crossbar 26.10.1; its
 * numbered quirks are cited below) with test/fixtures/probes/crossbar.probe-results.json, README-B.md (Bondy
 * 1.0.0-rc.65, Nexus main) and the Thruway PHP sources. `test/unit/dialect-fidelity.test.ts` replays the probes behind
 * those recordings against every dialect. Behaviour that is random or timing-dependent on the real router is fixed here
 * (Nexus "usually" loses its closing frames: always lost).
 *
 * @module
 */
import type { Dict } from '../protocol/messages.js';

export type DialectName = 'spec' | 'thruway-php' | 'crossbar' | 'nexus' | 'bondy' | 'fox-wamp' | 'wamp-server';

/** Client frames a router may treat as protocol violations (the reaction is per dialect). */
export type ViolationKind =
  /** Anything but HELLO as the first frame. */
  | 'before-hello'
  /** HELLO in a session. */
  | 'second-hello'
  /** A HELLO whose realm is not a string or whose details are not a dict. */
  | 'malformed-hello'
  /** A text frame that is not JSON, or not an array. */
  | 'invalid-json'
  /** A message type a client never sends (unknown, or router-only). */
  | 'unknown-type'
  /** A frame of a known type with a wrong shape: arity, a non-dict options, non-array args, non-dict kwargs, an
   *  invalid request id (`request_id_validation`), a mistyped option (`option_types`). */
  | 'malformed'
  /** A binary frame on `wamp.2.json`. */
  | 'binary';

/**
 * What the router does about a violation:
 * - `'ignore'`: nothing (a malformed or undecodable frame is dropped; a binary frame is decoded as UTF-8 JSON);
 * - `'discard'`: the frame is dropped unread (Bondy's binary frames);
 * - `'welcome'`: (a second HELLO only) a second WELCOME (wamp-server);
 * - `'drop'`: the connection dies (1006): Nexus kills the session and its ABORT is lost;
 * - `{close}`: closes the WebSocket with that code, no WAMP message (Crossbar 1002, fox-wamp 1002/1003);
 * - `{abort}`: ABORT with that reason, then `abort_close` (Bondy);
 * - `{goodbye}`: GOODBYE with that reason, then `router_closes_after_goodbye` at once (wamp-server);
 * - `{error}`: a request is answered with that ERROR, anything else ignored (fox-wamp before HELLO).
 */
export type ViolationReaction =
  | 'ignore'
  | 'discard'
  | 'welcome'
  | 'drop'
  | { readonly close: number; readonly reason?: string }
  | { readonly abort: string }
  | { readonly goodbye: string }
  | { readonly error: string };

/**
 * What a CANCEL does to a call answered by a callee:
 * - `'skip'`: the caller gets ERROR canceled at once, the callee nothing; its later answers are discarded;
 * - `'kill'`: INTERRUPT to the callee; the caller waits for the callee's answer, which is forwarded;
 * - `'killnowait'`: INTERRUPT, and the caller gets ERROR canceled at once; the callee's later answers are discarded;
 * - `'hang'`: nothing is sent to anyone, the callee's answers are discarded (Crossbar's `skip`);
 * - `'ignore'`: the CANCEL has no effect at all, the call goes on (fox-wamp);
 * - `'refuse'`: the caller gets ERROR `cancel_refusal_uri`, the call goes on (Bondy with a mode);
 * - `'goodbye'`: the router ends the caller's session with GOODBYE + close (wamp-server).
 */
export type CancelAction = 'skip' | 'kill' | 'killnowait' | 'hang' | 'ignore' | 'refuse' | 'goodbye';

/** Payload of forwarded INVOCATION, RESULT, EVENT and ERROR frames:
 *  - `'keep'`: args/kwargs exactly as the sender put them on the wire;
 *  - `'strip-empty'`: an empty kwargs is dropped, then an empty args if no kwargs follows (Thruway PHP, Crossbar);
 *  - `'fox-wamp'`: args `[]`/`[null]`/absent become `null`, a single array argument is unwrapped (`[[x]]` ⇒ `[x]`), an
 *    absent kwargs becomes `{}` in INVOCATIONs and `null` in RESULTs and EVENTs;
 *  - `'wamp-server'`: INVOCATION and EVENT carry both elements (`null` when absent), a RESULT carries args only. */
export type PayloadStyle = 'keep' | 'strip-empty' | 'fox-wamp' | 'wamp-server';

/** How a SUBSCRIBE pattern policy is treated: supported; silently treated as exact; never answered (Thruway PHP has
 *  no matcher for it). An implementation-specific policy (`_…`) is treated like `wildcard` where that is not
 *  supported. (Crossbar's 1002 for an unknown policy is `option_types`.) */
export type SubscribeMatch = 'yes' | 'exact' | 'no-reply';
/** How a REGISTER pattern policy is treated: supported; silently treated as exact; rejected with `invalid_uri`. */
export type RegisterMatch = 'yes' | 'exact' | 'invalid_uri';

/** The URI rule a router applies: none; the client's loose rule (`isValidUri`); Thruway PHP's strict
 *  `^([0-9a-z_]+\.)*([0-9a-z_]+)$` (a prefix may also be empty or end with a dot). */
export type UriRule = 'none' | 'loose' | 'strict';

export type RequestKind = 'call' | 'register' | 'subscribe' | 'publish';

export interface CloseSpec {
  readonly code: number;
  readonly reason: string;
}

export interface QuirkFlags {
  // --- transport ------------------------------------------------------------------------------------------------
  /** Subprotocols the router accepts, in its order of preference (it always speaks JSON). */
  readonly subprotocols: readonly string[];
  /** Whose preference picks among several accepted subprotocols (Nexus 3.3.1: the router's). */
  readonly subprotocol_order: 'client' | 'router';
  /** A client that offers none of `subprotocols`: the upgrade fails, or completes with protocol `''` (Nexus). */
  readonly no_subprotocol: 'reject' | 'accept';
  /** Client frames longer than this (UTF-8 bytes) close the connection with 1009; undefined = no limit. */
  readonly max_message_bytes: number | undefined;

  // --- handshake ------------------------------------------------------------------------------------------------
  /** WELCOME.Details.roles. */
  readonly roles: Dict;
  /** The auth keys of an anonymous WELCOME: `realm`, `authid` (`anonymous-<session>`), `authrole` and `authmethod`
   *  ('anonymous'), `authprovider` (the flag below). Thruway PHP: none (`{roles}` only). */
  readonly anonymous_welcome: readonly ('realm' | 'authid' | 'authrole' | 'authmethod' | 'authprovider')[];
  readonly authprovider: string;
  /** More WELCOME.Details keys (Crossbar's `x_cb_*`, Bondy's `agent`). */
  readonly welcome_extra: Dict;
  /** A HELLO without roles: welcomed, or a `'malformed'` violation. */
  readonly hello_without_roles: 'welcome' | 'violation';
  /** A realm name must match this regular expression (fox-wamp: `^[a-z0-9_]+$`). */
  readonly realm_rule: string | undefined;
  /** A realm the router does not have (`realms` option, `realm_rule`): ABORT no_such_realm, or no answer (fox-wamp). */
  readonly unknown_realm: 'abort' | 'no-reply';
  /** Auth providers (`providers` option): one CHALLENGE per matching method, in provider order, and AUTHENTICATE is
   *  verified by the provider of the last one (Thruway PHP T6); otherwise one CHALLENGE, for the first method of the
   *  HELLO that a provider covers. */
  readonly multi_method_challenge: boolean;
  /** Without `multi_method_challenge`: the method is the HELLO's first that a provider covers (`client`), or the first
   *  provider (in provider order) whose method the HELLO offers (`router`: fox-wamp). */
  readonly auth_method_order: 'client' | 'router';
  /** AUTHENTICATE before any CHALLENGE: ignored, or ABORT `auth_failure_abort` "no pending authentication"
   *  (Crossbar). */
  readonly authenticate_before_challenge: 'ignore' | 'abort';
  /** No provider covers the realm: an anonymous WELCOME whatever the HELLO offers (Thruway PHP); otherwise only
   *  a HELLO offering `anonymous` (or no `authmethods`) is welcomed anonymously. */
  readonly anonymous_welcome_without_provider: boolean;
  /** Bondy: a HELLO without `authid` is welcomed anonymously whatever it offers. */
  readonly anonymous_without_authid: boolean;
  /** ABORT reason when providers cover the realm but none of the offered methods. */
  readonly no_auth_method_abort: string;
  /** ABORT reason for a rejected AUTHENTICATE (also an AUTHENTICATE without a CHALLENGE, Crossbar). */
  readonly auth_failure_abort: string;
  /** ABORT reason when the provider is gone (a `'stale'` provider: Thruway PHP `thruway.error.unknown`). */
  readonly provider_failure_abort: string;
  /** Authenticated WELCOMEs get Thruway PHP's `authid` default and `authrole`/`authroles` list. */
  readonly thruway_auth_details: boolean;
  /** Frames other than AUTHENTICATE/ABORT while a CHALLENGE is pending: ignored; routed as if in the session (Thruway
   *  PHP T5: the session is already in the realm); answered ERROR not_authorized (fox-wamp). */
  readonly pre_auth_frames: 'ignore' | 'route' | 'not_authorized';

  // --- closing --------------------------------------------------------------------------------------------------
  /** ABORT and GOODBYE (replies and the router's own) reach the client; false: they are lost and the connection
   *  drops with 1006 (Nexus). */
  readonly closing_frames_delivered: boolean;
  /** After an ABORT the router closes the WebSocket so; undefined: it stays open and accepts a new HELLO. */
  readonly abort_close: CloseSpec | undefined;
  /** ABORT is sent as `[3, reason, {roles}]` (wamp-server: its WELCOME details where the details belong). */
  readonly abort_fields_swapped: boolean;
  readonly goodbye_reply_reason: string;
  readonly goodbye_reply_details: Dict;
  /** The client's reply to the router's own GOODBYE is answered too, with the GOODBYE reply, before the close (Thruway
   *  PHP: Realm::processGoodbye answers every GOODBYE a session in the realm sends). */
  readonly goodbye_reply_answered: boolean;
  /** After the GOODBYE handshake (either side's) the router closes so; undefined: the socket stays open and a new
   *  HELLO starts a new session (Crossbar). */
  readonly router_closes_after_goodbye: CloseSpec | undefined;

  // --- violations ----------------------------------------------------------------------------------------------
  readonly violations: Readonly<Record<ViolationKind, ViolationReaction>>;
  /** Spec-typed options are checked (non-boolean `receive_progress`/`acknowledge`/`exclude_me`/`disclose_*`, a
   *  non-integer `timeout`, an unknown `match`, `invoke` or CANCEL `mode`): a mistyped one is `'malformed'` (Crossbar
   *  quirk 3). */
  readonly option_types: boolean;
  /** Which request ids are accepted: [1, 2^53] (`'spec'`); integers in [0, 2^53] (`'range'`); anything, answered with
   *  the same id (`'none'`, Thruway PHP); anything but 0, which gets no answer (`'none-but-zero'`, fox-wamp). */
  readonly request_id_validation: 'spec' | 'range' | 'none' | 'none-but-zero';
  /** Request ids must be 1, 2, 3, … per session across every request type (Nexus `strict_request_ids`); a session
   *  that breaks it is killed (its ABORT lost: 1006). */
  readonly strict_ids: boolean;
  /** The URI rule per request type. */
  readonly uri_check: Readonly<Record<RequestKind, UriRule>>;
  /** Request types whose invalid URI closes the connection with 1011 instead of ERROR invalid_uri (Crossbar 8). */
  readonly invalid_uri_kills: readonly RequestKind[];
  /** Request types for which `wamp.` URIs are reserved (Crossbar: REGISTER, PUBLISH ⇒ invalid_uri). */
  readonly reserved_wamp: readonly RequestKind[];
  /** REGISTER and CALL procedures are lowercased before anything else (Thruway PHP T7). */
  readonly lowercase_procedures: boolean;
  /** ERROR args added by the router: none; `null` (wamp-server); `[""]` (fox-wamp). */
  readonly router_error_args: 'none' | 'null' | 'empty-string';
  /** `no_such_procedure` carries `["no callee registered for procedure <uri>"]` (Crossbar, fox-wamp). */
  readonly no_such_procedure_message: boolean;

  // --- broker ---------------------------------------------------------------------------------------------------
  /** Subscription ids: one per session, topic and match (a repeated SUBSCRIBE gets the same id; spec SHOULD); one per
   *  realm, topic and match shared by every session (Crossbar); a new one for every SUBSCRIBE, each with its own EVENT
   *  copy (Thruway PHP, fox-wamp); a new one per SUBSCRIBE whose EVENT copies all carry the first (wamp-server). */
  readonly subscription_ids: 'per-session' | 'shared' | 'per-subscribe' | 'per-subscribe-first';
  readonly subscribe_match: Readonly<Record<'prefix' | 'wildcard', SubscribeMatch>>;
  /** `*` and `#` inside an exact topic match one / any number of components (fox-wamp's MQTT style). */
  readonly mqtt_wildcards: boolean;
  /** `EVENT.Details.topic`: for pattern subscriptions; always; never. */
  readonly event_details_topic: 'pattern' | 'always' | 'never';
  /** `exclude_me` (default true); ignored, the publisher gets its own EVENT (Bondy); always true (wamp-server). */
  readonly exclude_me: 'spec' | 'ignored' | 'always';
  /** `eligible`/`exclude`: honoured, with the spec's `_authid`/`_authrole` lists; Thruway PHP's (session ids, and its
   *  own `_thruway_eligible_authids`/`_thruway_eligible_authroles` lists instead of the spec's; one that is not an
   *  array admits nobody); ignored (fox-wamp); broken like Bondy (an `eligible` list reaches nobody, an `exclude` list
   *  is ignored). */
  readonly blackwhite_listing: 'yes' | 'thruway' | 'ignored' | 'bondy';
  /** The publisher in EVENT.Details: on `disclose_me`; always; never; always with authid/authrole (Crossbar, Bondy);
   *  when the subscription asked SUBSCRIBE `disclose_publisher: true`, with `topic` and the publisher's auth details
   *  (Thruway PHP: Subscription::isDisclosePublisher, EventMessage::disclosePublisher; `disclose_me` is not read). */
  readonly publisher_disclosure: 'request' | 'always' | 'never' | 'always-auth' | 'subscriber';
  readonly self_publish_order: 'event-first' | 'published-first';
  /** An acknowledged PUBLISH that reaches no subscriber is acknowledged (wamp-server: never). */
  readonly ack_without_subscribers: boolean;
  /** EVENT carries the publication id, or (wamp-server) the realm's first subscription id of the topic, kept while
   *  anyone subscribes to it (with `per-subscribe-first`, its subscription id is the subscriber's first). */
  readonly event_publication_id: 'publication' | 'subscription';
  /** UNSUBSCRIBE of an unknown id: ERROR no_such_subscription; close 1011 (Bondy); no answer (wamp-server). */
  readonly unsubscribe_unknown: 'error' | 'close-1011' | 'no-reply';

  // --- dealer ---------------------------------------------------------------------------------------------------
  readonly register_match: Readonly<Record<'prefix' | 'wildcard', RegisterMatch>>;
  /** Several REGISTERs of one procedure: `invoke` policies (spec); every REGISTER accepted, first callee wins
   *  (fox-wamp); never (wamp-server: procedure_already_exists). */
  readonly shared_registration: 'spec' | 'implicit' | 'none';
  /** The callees of a shared registration get one registration id, or each their own (Thruway PHP). */
  readonly shared_registration_ids: 'shared' | 'distinct';
  /** The ERROR for a REGISTER whose `invoke` differs from the existing registration's. */
  readonly invoke_mismatch_error: string;
  /** Thruway PHP's `invoke: '_thruway'` / `thruway_multiregister`: the first idle callee, calls queue while all are
   *  busy. */
  readonly thruway_invoke: boolean;
  /** Thruway PHP's REGISTER `replace_orphaned_session: 'yes' | true`: the old callee is pinged for 5 s and evicted if
   *  it does not answer (a dead or frozen link). */
  readonly replace_orphaned_session: boolean;
  /** UNREGISTER of an unknown id: this ERROR (Thruway PHP: no_such_procedure); undefined: no answer (wamp-server). */
  readonly unregister_unknown_error: string | undefined;
  /** `CALL.Options.timeout`: ignored; milliseconds, then ERROR timeout + INTERRUPT (Nexus); seconds, integers only,
   *  then ERROR canceled ["timeout reached"] + INTERRUPT killnowait (Crossbar); coarse ERROR timeout without INTERRUPT
   *  (Bondy). */
  readonly call_timeout: 'ignored' | 'ms' | 'seconds' | 'coarse';
  /** INVOCATION.Details: the spec's (`procedure`, `receive_progress`, `caller` on request); Thruway PHP's (`caller`
   *  and auth details only with REGISTER `disclose_caller`); always the caller with authid/authrole (Crossbar's
   *  disclosing roles, Bondy); nothing (fox-wamp); the CALL options verbatim (wamp-server). */
  readonly invocation_details: 'spec' | 'thruway' | 'always-auth' | 'none' | 'options';
  /** RESULT.Details name the callee (`callee`, `callee_authid`, `callee_authrole`: Crossbar's disclosing roles). */
  readonly result_callee: boolean;
  /** A second CALL with an id still in flight from the same session: dropped (spec); served as a second call
   *  (Thruway PHP, Crossbar, Bondy, fox-wamp); invoked again but answered once, a progressive continuation (Nexus). */
  readonly duplicate_call: 'drop' | 'served' | 'continuation';
  /** Thruway PHP T1: CALLs are indexed realm-wide by the caller's request id, so a CANCEL (and the cancel when a
   *  caller leaves) finds the latest CALL with that id from any session, and is dropped if it is not the caller's. */
  readonly realm_call_index: boolean;
  /** CANCEL per mode (`none`: no mode; `unknown`: any other value — Crossbar's 1002 for it is `option_types`). */
  readonly cancel_modes: Readonly<Record<'skip' | 'kill' | 'killnowait' | 'none', CancelAction>> & {
    readonly unknown: CancelAction | 'invalid_argument';
  };
  /** A CANCEL for a callee that did not announce `call_canceling`: as for any callee; as mode `skip` (spec, Crossbar);
   *  refused with ERROR not_supported, the call goes on (Thruway PHP). */
  readonly cancel_without_callee_feature: 'mode' | 'skip' | 'not_supported';
  /** The request type of the router's own answers to a CANCEL (canceled, not_supported, no_such_call, refusals). */
  readonly cancel_error_type: 48 | 49;
  /** The ERROR uri of a `'refuse'` cancel action. */
  readonly cancel_refusal_uri: string;
  /** Args of the router's ERROR canceled for a mode-less CANCEL (Bondy: `["call_cancelled"]`). */
  readonly cancel_error_args: readonly unknown[] | undefined;
  /** A CANCEL for an unknown call: ignored; answered ERROR no_such_call (Thruway PHP); GOODBYE + close, like any
   *  CANCEL (wamp-server). */
  readonly cancel_unknown: 'ignore' | 'no_such_call' | 'goodbye';
  /** What the caller gets after a `kill` once the callee answered: the callee's answer, or ERROR canceled without
   *  args whatever the callee said (Crossbar). */
  readonly cancel_kill_answer: 'forward' | 'canceled';
  /** INTERRUPT.Options: `{mode}`; `{mode, reason}` (Nexus); `{}` (Thruway PHP). */
  readonly interrupt_options: 'mode' | 'mode-reason' | 'empty';
  /** A cancelled progressive call is still answered (Thruway PHP T3: false, it is forgotten at the CANCEL, so after a
   *  `kill` the caller never gets a final message). */
  readonly progressive_cancel_final: boolean;
  /** YIELD/ERROR for an INVOCATION the router does not know: ignored; answered `[8,70,id,{},wamp.error.unknown]` /
   *  `[8,8,id,{},wamp.error.no_such_procedure]` (Thruway PHP, the "bogus" ERROR after killnowait). */
  readonly answer_unknown_invocation: 'ignore' | 'error';
  /** The caller when its callee leaves mid-call: ERROR canceled; ERROR canceled ["callee disconnected from in-flight
   *  request"] (Crossbar); ERROR no_eligible_callee (Bondy); nothing (fox-wamp, wamp-server). */
  readonly callee_leave_answer: 'canceled' | 'canceled-message' | 'no_eligible_callee' | 'hang';
  /** The callee when the caller leaves mid-call: INTERRUPT killnowait (to callees that cancel); a CANCEL without mode
   *  (Thruway PHP: INTERRUPT `{}`, subject to T1); nothing. */
  readonly caller_leave_interrupts: 'killnowait' | 'cancel' | 'none';
  /** Progressive results: supported; not (receive_progress is not forwarded, the first progress YIELD becomes the
   *  final RESULT, later ones are dropped: Bondy, wamp-server). */
  readonly progressive_results: boolean;
  /** `receive_progress` reaches only callees that announced `progressive_call_results` (spec). */
  readonly progress_needs_callee_feature: boolean;
  /** A progress YIELD the caller did not ask for: dropped, or forwarded as a progress RESULT (Crossbar, fox-wamp). */
  readonly unrequested_progress: 'drop' | 'forward';
  /** A callee's ERROR(68): forwarded; forwarded with empty details (Crossbar); rewritten to
   *  `wamp.error.callee_failure [uri]` (fox-wamp); not forwarded (wamp-server). */
  readonly callee_error_forwarded: 'yes' | 'no-details' | 'rewritten' | 'no';
  /** A callee ERROR with an invalid URI closes the callee's connection with 1011 (Crossbar quirk 8). */
  readonly invalid_error_uri_kills: boolean;
  /** YIELD/ERROR for another session's INVOCATION: ignored, or the connection is closed with 1002 (Crossbar). */
  readonly foreign_answer: 'ignore' | 'close-1002';
  readonly payload: PayloadStyle;
}

const NONE: readonly RequestKind[] = [];

const SPEC_ROLES: Dict = {
  broker: {
    features: {
      publisher_identification: true,
      publisher_exclusion: true,
      subscriber_blackwhite_listing: true,
      pattern_based_subscription: true,
      subscription_revocation: true,
    },
  },
  dealer: {
    features: {
      progressive_call_results: true,
      call_canceling: true,
      caller_identification: true,
      pattern_based_registration: true,
      shared_registration: true,
      registration_revocation: true,
    },
  },
};

/** The spec-conformant reference router (version 1's behaviour). */
const SPEC: QuirkFlags = {
  subprotocols: ['wamp.2.json'],
  subprotocol_order: 'client',
  no_subprotocol: 'reject',
  max_message_bytes: undefined,
  roles: SPEC_ROLES,
  anonymous_welcome: ['authid', 'authrole', 'authmethod', 'authprovider'],
  authprovider: 'static',
  welcome_extra: {},
  hello_without_roles: 'welcome',
  realm_rule: undefined,
  unknown_realm: 'abort',
  multi_method_challenge: false,
  auth_method_order: 'client',
  authenticate_before_challenge: 'ignore',
  anonymous_welcome_without_provider: false,
  anonymous_without_authid: false,
  no_auth_method_abort: 'wamp.error.no_auth_method',
  auth_failure_abort: 'wamp.error.authentication_failed',
  provider_failure_abort: 'wamp.error.authorization_failed',
  thruway_auth_details: false,
  pre_auth_frames: 'ignore',
  closing_frames_delivered: true,
  abort_close: { code: 1000, reason: '' },
  abort_fields_swapped: false,
  goodbye_reply_reason: 'wamp.close.goodbye_and_out',
  goodbye_reply_details: {},
  goodbye_reply_answered: false,
  router_closes_after_goodbye: { code: 1000, reason: '' },
  violations: {
    'before-hello': 'ignore',
    'second-hello': 'ignore',
    'malformed-hello': 'ignore',
    'invalid-json': 'ignore',
    'unknown-type': 'ignore',
    malformed: 'ignore',
    binary: 'ignore',
  },
  option_types: false,
  request_id_validation: 'spec',
  strict_ids: false,
  uri_check: { call: 'loose', register: 'loose', subscribe: 'loose', publish: 'loose' },
  invalid_uri_kills: NONE,
  reserved_wamp: NONE,
  lowercase_procedures: false,
  router_error_args: 'none',
  no_such_procedure_message: false,
  subscription_ids: 'per-session',
  subscribe_match: { prefix: 'yes', wildcard: 'yes' },
  mqtt_wildcards: false,
  event_details_topic: 'pattern',
  exclude_me: 'spec',
  blackwhite_listing: 'yes',
  publisher_disclosure: 'request',
  self_publish_order: 'event-first',
  ack_without_subscribers: true,
  event_publication_id: 'publication',
  unsubscribe_unknown: 'error',
  register_match: { prefix: 'yes', wildcard: 'yes' },
  shared_registration: 'spec',
  shared_registration_ids: 'shared',
  invoke_mismatch_error: 'wamp.error.procedure_already_exists',
  thruway_invoke: false,
  replace_orphaned_session: false,
  unregister_unknown_error: 'wamp.error.no_such_registration',
  call_timeout: 'ignored',
  invocation_details: 'spec',
  result_callee: false,
  duplicate_call: 'drop',
  realm_call_index: false,
  cancel_modes: {
    skip: 'skip',
    kill: 'kill',
    killnowait: 'killnowait',
    none: 'killnowait',
    unknown: 'invalid_argument',
  },
  cancel_without_callee_feature: 'skip',
  cancel_error_type: 48,
  cancel_refusal_uri: 'wamp.error.not_supported',
  cancel_error_args: undefined,
  cancel_unknown: 'ignore',
  cancel_kill_answer: 'forward',
  interrupt_options: 'mode',
  progressive_cancel_final: true,
  answer_unknown_invocation: 'ignore',
  callee_leave_answer: 'canceled',
  caller_leave_interrupts: 'killnowait',
  progressive_results: true,
  progress_needs_callee_feature: true,
  unrequested_progress: 'drop',
  callee_error_forwarded: 'yes',
  invalid_error_uri_kills: false,
  foreign_answer: 'ignore',
  payload: 'keep',
};

/** Thruway PHP 0.6.1 (test/routers/ROUTERS-C.md, the PHP sources). */
const THRUWAY_PHP: QuirkFlags = {
  ...SPEC,
  roles: {
    broker: {
      features: { subscriber_blackwhite_listing: true, publisher_exclusion: true, subscriber_metaevents: true },
    },
    dealer: { features: { caller_identification: true, progressive_call_results: true } },
  },
  anonymous_welcome: [],
  multi_method_challenge: true,
  anonymous_welcome_without_provider: true,
  no_auth_method_abort: 'wamp.error.not_authorized',
  auth_failure_abort: 'thruway.error.authentication_failure',
  provider_failure_abort: 'thruway.error.unknown',
  thruway_auth_details: true,
  pre_auth_frames: 'route',
  abort_close: { code: 1000, reason: '' },
  goodbye_reply_reason: 'wamp.error.goodbye_and_out',
  goodbye_reply_answered: true,
  max_message_bytes: 16 * 1024 * 1024,
  request_id_validation: 'none',
  uri_check: { call: 'strict', register: 'strict', subscribe: 'strict', publish: 'none' },
  lowercase_procedures: true,
  subscription_ids: 'per-subscribe',
  subscribe_match: { prefix: 'yes', wildcard: 'no-reply' },
  blackwhite_listing: 'thruway',
  publisher_disclosure: 'subscriber',
  register_match: { prefix: 'exact', wildcard: 'invalid_uri' },
  shared_registration_ids: 'distinct',
  invoke_mismatch_error: 'wamp.error.unknown',
  thruway_invoke: true,
  replace_orphaned_session: true,
  unregister_unknown_error: 'wamp.error.no_such_procedure',
  invocation_details: 'thruway',
  duplicate_call: 'served',
  realm_call_index: true,
  cancel_modes: { skip: 'kill', kill: 'kill', killnowait: 'killnowait', none: 'kill', unknown: 'kill' },
  cancel_without_callee_feature: 'not_supported',
  cancel_error_type: 49,
  cancel_unknown: 'no_such_call',
  interrupt_options: 'empty',
  progressive_cancel_final: false,
  answer_unknown_invocation: 'error',
  caller_leave_interrupts: 'cancel',
  progress_needs_callee_feature: false,
  payload: 'strip-empty',
};

/** Crossbar 26.10.1, realm1 on `/ws` (test/routers/crossbar/README.md). */
const CROSSBAR: QuirkFlags = {
  ...SPEC,
  subprotocols: ['wamp.2.json', 'wamp.2.msgpack', 'wamp.2.cbor', 'wamp.2.json.batched', 'wamp.2.msgpack.batched'],
  max_message_bytes: 16 * 1024 * 1024,
  roles: {
    broker: {
      features: {
        publisher_identification: true,
        pattern_based_subscription: true,
        session_meta_api: true,
        subscription_meta_api: true,
        subscriber_blackwhite_listing: true,
        publisher_exclusion: true,
        subscription_revocation: true,
        payload_transparency: true,
        payload_encryption_cryptobox: true,
        event_retention: true,
      },
    },
    dealer: {
      features: {
        caller_identification: true,
        pattern_based_registration: true,
        session_meta_api: true,
        registration_meta_api: true,
        shared_registration: true,
        call_canceling: true,
        progressive_call_results: true,
        registration_revocation: true,
        payload_transparency: true,
        testament_meta_api: true,
        payload_encryption_cryptobox: true,
      },
    },
  },
  anonymous_welcome: ['realm', 'authid', 'authrole', 'authmethod', 'authprovider'],
  welcome_extra: { x_cb_node: 'thruway_test_node', x_cb_worker: 'worker001' },
  hello_without_roles: 'violation',
  auth_failure_abort: 'wamp.error.not_authorized',
  authenticate_before_challenge: 'abort',
  abort_close: undefined,
  goodbye_reply_reason: 'wamp.close.normal',
  router_closes_after_goodbye: undefined,
  violations: {
    'before-hello': 'ignore',
    'second-hello': 'ignore',
    'malformed-hello': { close: 1011, reason: 'WAMP Internal Error' },
    'invalid-json': { close: 1002, reason: 'WAMP Protocol Error' },
    'unknown-type': { close: 1002, reason: 'WAMP Protocol Error' },
    malformed: { close: 1002, reason: 'WAMP Protocol Error' },
    binary: { close: 1002, reason: 'WAMP Protocol Error' },
  },
  option_types: true,
  request_id_validation: 'range',
  invalid_uri_kills: ['call', 'register', 'publish'],
  reserved_wamp: ['register', 'publish'],
  no_such_procedure_message: true,
  subscription_ids: 'shared',
  publisher_disclosure: 'always-auth',
  self_publish_order: 'published-first',
  invoke_mismatch_error: 'wamp.error.procedure_exists_with_different_invocation_policy',
  call_timeout: 'seconds',
  invocation_details: 'always-auth',
  result_callee: true,
  duplicate_call: 'served',
  cancel_modes: { skip: 'hang', kill: 'kill', killnowait: 'killnowait', none: 'kill', unknown: 'invalid_argument' },
  cancel_kill_answer: 'canceled',
  callee_leave_answer: 'canceled-message',
  progress_needs_callee_feature: false,
  unrequested_progress: 'forward',
  callee_error_forwarded: 'no-details',
  invalid_error_uri_kills: true,
  foreign_answer: 'close-1002',
  payload: 'strip-empty',
};

/** Nexus main, realm1 (test/routers/nexus/README.md). Version 3.3.1 differs:
 *  it ignores invalid JSON and unknown types (override `violations`); `strict_ids` is main's `realm1.strict`. */
const NEXUS: QuirkFlags = {
  ...SPEC,
  subprotocols: ['wamp.2.json', 'wamp.2.msgpack', 'wamp.2.cbor'],
  no_subprotocol: 'accept',
  roles: {
    broker: {
      features: {
        event_history: true,
        pattern_based_subscription: true,
        payload_passthru_mode: true,
        publisher_exclusion: true,
        publisher_identification: true,
        session_meta_api: true,
        subscriber_blackwhite_listing: true,
        subscription_meta_api: true,
      },
    },
    dealer: {
      features: {
        call_canceling: true,
        call_timeout: true,
        caller_identification: true,
        pattern_based_registration: true,
        payload_passthru_mode: true,
        progressive_call_invocations: true,
        progressive_call_results: true,
        registration_meta_api: true,
        session_meta_api: true,
        shared_registration: true,
        testament_meta_api: true,
      },
    },
  },
  hello_without_roles: 'violation',
  closing_frames_delivered: false,
  violations: {
    'before-hello': 'drop',
    'second-hello': 'drop',
    'malformed-hello': 'drop',
    'invalid-json': 'drop',
    'unknown-type': 'drop',
    malformed: 'drop',
    binary: 'ignore',
  },
  request_id_validation: 'range',
  self_publish_order: 'published-first',
  call_timeout: 'ms',
  duplicate_call: 'continuation',
  interrupt_options: 'mode-reason',
  progress_needs_callee_feature: false,
};

/** Bondy 1.0.0-rc.65 (test/routers/bondy/README.md). */
const BONDY: QuirkFlags = {
  ...SPEC,
  subprotocols: ['wamp.2.json', 'wamp.2.msgpack', 'wamp.2.cbor', 'wamp.2.json.batched'],
  max_message_bytes: 4 * 1024 * 1024,
  roles: {
    broker: {
      features: {
        event_retention: true,
        pattern_based_subscription: true,
        publisher_exclusion: true,
        publisher_identification: true,
        reflection: true,
        session_meta_api: true,
        subscriber_blackwhite_listing: true,
      },
    },
    dealer: {
      features: {
        call_canceling: true,
        call_reroute: true,
        call_timeout: true,
        caller_identification: true,
        pattern_based_registration: true,
        registration_meta_api: true,
        session_meta_api: true,
        shared_registration: true,
      },
    },
  },
  anonymous_welcome: ['realm', 'authid', 'authrole', 'authmethod', 'authprovider'],
  authprovider: 'com.leapsight.bondy',
  welcome_extra: { agent: 'LEAPSIGHT-BONDY-1.0.0-rc.65' },
  hello_without_roles: 'violation',
  anonymous_without_authid: true,
  abort_close: { code: 1005, reason: '' },
  goodbye_reply_details: { message: 'Session closed by client.' },
  router_closes_after_goodbye: { code: 1005, reason: '' },
  violations: {
    'before-hello': { abort: 'wamp.error.protocol_violation' },
    'second-hello': { abort: 'wamp.error.protocol_violation' },
    'malformed-hello': { abort: 'wamp.error.protocol_violation' },
    'invalid-json': { abort: 'bondy.error.internal_error' },
    'unknown-type': { abort: 'wamp.error.protocol_violation' },
    malformed: { abort: 'wamp.error.protocol_violation' },
    binary: 'discard',
  },
  request_id_validation: 'range',
  exclude_me: 'ignored',
  blackwhite_listing: 'bondy',
  publisher_disclosure: 'always-auth',
  unsubscribe_unknown: 'close-1011',
  call_timeout: 'coarse',
  invocation_details: 'always-auth',
  duplicate_call: 'served',
  cancel_modes: { skip: 'refuse', kill: 'refuse', killnowait: 'refuse', none: 'skip', unknown: 'refuse' },
  cancel_without_callee_feature: 'mode',
  cancel_error_type: 49,
  cancel_refusal_uri: 'bondy.error.internal_error',
  cancel_error_args: ['call_cancelled'],
  callee_leave_answer: 'no_eligible_callee',
  progressive_results: false,
  progress_needs_callee_feature: false,
};

/** fox-wamp 0.7.28 (test/routers/ROUTERS-C.md). */
const FOX_WAMP: QuirkFlags = {
  ...SPEC,
  roles: {
    broker: { features: { session_meta_api: true, publisher_exclusion: true } },
    dealer: { features: { session_meta_api: true, progressive_call_results: true } },
  },
  anonymous_welcome: ['realm', 'authmethod'],
  auth_method_order: 'router',
  auth_failure_abort: 'wamp.error.authentication_failed',
  realm_rule: '^[a-z0-9_]+$',
  unknown_realm: 'no-reply',
  pre_auth_frames: 'not_authorized',
  router_closes_after_goodbye: { code: 1000, reason: 'Server closed WAMP session' },
  goodbye_reply_reason: 'wamp.error.goodbye_and_out',
  violations: {
    'before-hello': { error: 'wamp.error.not_authorized' },
    'second-hello': { close: 1002, reason: 'protocol violation' },
    'malformed-hello': { close: 1002, reason: 'protocol violation' },
    'invalid-json': { close: 1003, reason: 'protocol violation' },
    'unknown-type': { close: 1003, reason: 'protocol violation' },
    malformed: { close: 1002, reason: 'protocol violation' },
    binary: 'ignore',
  },
  request_id_validation: 'none-but-zero',
  uri_check: { call: 'none', register: 'none', subscribe: 'none', publish: 'none' },
  router_error_args: 'empty-string',
  no_such_procedure_message: true,
  subscription_ids: 'per-subscribe',
  subscribe_match: { prefix: 'exact', wildcard: 'exact' },
  mqtt_wildcards: true,
  event_details_topic: 'always',
  blackwhite_listing: 'ignored',
  publisher_disclosure: 'always',
  register_match: { prefix: 'exact', wildcard: 'exact' },
  shared_registration: 'implicit',
  shared_registration_ids: 'distinct',
  invocation_details: 'none',
  duplicate_call: 'served',
  cancel_modes: { skip: 'ignore', kill: 'ignore', killnowait: 'ignore', none: 'ignore', unknown: 'ignore' },
  cancel_without_callee_feature: 'mode',
  callee_leave_answer: 'hang',
  caller_leave_interrupts: 'none',
  progress_needs_callee_feature: false,
  unrequested_progress: 'forward',
  callee_error_forwarded: 'rewritten',
  payload: 'fox-wamp',
};

/** wamp-server 0.0.9, a hostile router (test/routers/ROUTERS-C.md). */
const WAMP_SERVER: QuirkFlags = {
  ...SPEC,
  subprotocols: ['wamp.2.json', 'wamp.2.msgpack'],
  roles: { broker: {}, dealer: {} },
  anonymous_welcome: [],
  abort_close: undefined,
  abort_fields_swapped: true,
  goodbye_reply_reason: 'wamp.error.goodbye_and_out',
  router_closes_after_goodbye: { code: 1005, reason: '' },
  violations: {
    'before-hello': { abort: 'wamp.error.no_such_realm' },
    'second-hello': 'welcome',
    'malformed-hello': { goodbye: 'wamp.error.goodbye_and_out' },
    'invalid-json': { goodbye: 'wamp.error.goodbye_and_out' },
    'unknown-type': { goodbye: 'wamp.error.goodbye_and_out' },
    malformed: { goodbye: 'wamp.error.goodbye_and_out' },
    binary: 'ignore',
  },
  request_id_validation: 'none',
  uri_check: { call: 'none', register: 'none', subscribe: 'none', publish: 'none' },
  router_error_args: 'null',
  subscription_ids: 'per-subscribe-first',
  subscribe_match: { prefix: 'exact', wildcard: 'exact' },
  event_details_topic: 'always',
  exclude_me: 'always',
  blackwhite_listing: 'ignored',
  publisher_disclosure: 'never',
  ack_without_subscribers: false,
  event_publication_id: 'subscription',
  unsubscribe_unknown: 'no-reply',
  register_match: { prefix: 'exact', wildcard: 'exact' },
  shared_registration: 'none',
  unregister_unknown_error: undefined,
  invocation_details: 'options',
  duplicate_call: 'continuation',
  cancel_modes: { skip: 'goodbye', kill: 'goodbye', killnowait: 'goodbye', none: 'goodbye', unknown: 'goodbye' },
  cancel_without_callee_feature: 'mode',
  cancel_unknown: 'goodbye',
  callee_leave_answer: 'hang',
  caller_leave_interrupts: 'none',
  progressive_results: false,
  progress_needs_callee_feature: false,
  callee_error_forwarded: 'no',
  payload: 'wamp-server',
};

export interface Dialect {
  readonly name: DialectName;
  readonly flags: QuirkFlags;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Every dialect, frozen. */
export const DIALECTS: Readonly<Record<DialectName, Dialect>> = freezeDeep({
  spec: { name: 'spec', flags: SPEC },
  'thruway-php': { name: 'thruway-php', flags: THRUWAY_PHP },
  crossbar: { name: 'crossbar', flags: CROSSBAR },
  nexus: { name: 'nexus', flags: NEXUS },
  bondy: { name: 'bondy', flags: BONDY },
  'fox-wamp': { name: 'fox-wamp', flags: FOX_WAMP },
  'wamp-server': { name: 'wamp-server', flags: WAMP_SERVER },
});

/** The flags of `name` with `overrides` applied (a router's `quirks` option). Throws for an unknown dialect. */
export function quirksOf(name: string, overrides?: Partial<QuirkFlags>): QuirkFlags {
  const dialect = (DIALECTS as Readonly<Record<string, Dialect | undefined>>)[name];
  if (dialect === undefined) throw new TypeError(`testing router: unknown dialect '${name}'`);
  return overrides === undefined ? dialect.flags : { ...dialect.flags, ...overrides };
}
