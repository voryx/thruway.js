/**
 * WAMP messages as the client sees them.
 *
 * - `InboundMessage`: every router→client message after `decode()` has validated and normalised it — what the core
 *   routes and participants, liveness and the handshake consume. Ids are integers in [0, 2^53].
 * - `DecodeResult`: decode()'s classification of one deserialized frame.
 * - `OutboundFrame`: every frame the client can write, as readonly tuples, and one builder per frame. The tuple types
 *   encode the allowed shapes themselves (e.g. a GOODBYE carries `{}` and one of the two client reasons; a CANCEL
 *   always `{mode: 'killnowait'}`), so a participant cannot build a frame the client must never send.
 *
 * Payload normalisation (omit empty args/kwargs, `args ?? []` before non-empty kwargs) is `protocol/payload.ts`'s
 * job; the builders take its result, an `OutboundPayload`, and append it unchanged.
 *
 * @module
 */
import { MessageType, Uri, type ClientAbortReason, type ClientGoodbyeReason } from './codes.js';

/** A WAMP dictionary as delivered (frozen by the decoder) or as snapshotted for writing. */
export type Dict = Readonly<Record<string, unknown>>;
/** The empty dictionary `{}` of frames whose dict the client always sends empty. */
export type EmptyDict = Readonly<Record<string, never>>;

/** No frame larger than 16 MiB (UTF-8 bytes of the serialized text, or the binary length) is ever written. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Inbound (router → client), after decode()
// ---------------------------------------------------------------------------------------------------------------

/**
 * Set on a payload-bearing message whose routing fields are valid but whose payload is not ("payload-invalid":
 * `args` neither array nor null, `kwargs` neither plain object nor null, or a details/options dict that is neither
 * object, null nor `[]`). `args`/`kwargs`/`details` are then `[]`/`{}` and must not be delivered: the owning record
 * settles with `ProtocolError{frame}` (RESULT/ERROR), the INVOCATION is answered `wamp.error.invalid_argument`, an
 * EVENT is dropped (`warn`). The session continues.
 */
export interface PayloadInvalid {
  /** What was wrong, e.g. 'args is not an array'. */
  readonly reason: string;
  /** The offending frame as text, truncated to 256 chars (`ProtocolError.frame`). */
  readonly frame: string;
}

/** `[2, Session|id, Details|dict]` */
export interface InboundWelcome {
  readonly type: typeof MessageType.WELCOME;
  readonly sessionId: number;
  readonly details: Dict;
}
/** `[3, Details|dict, Reason|uri]` — reason/details taken from elements 1–2 in either order (wamp-server swaps them);
 *  no string ⇒ `wamp.error.unknown`. Never fatal. */
export interface InboundAbort {
  readonly type: typeof MessageType.ABORT;
  readonly details: Dict;
  readonly reason: string;
}
/** `[4, AuthMethod|string, Extra|dict]` */
export interface InboundChallenge {
  readonly type: typeof MessageType.CHALLENGE;
  readonly authMethod: string;
  readonly extra: Dict;
}
/** `[6, Details|dict, Reason|uri]` — normalised like ABORT. */
export interface InboundGoodbye {
  readonly type: typeof MessageType.GOODBYE;
  readonly details: Dict;
  readonly reason: string;
}
/** `[8, REQUEST.Type|int, REQUEST.Request|id, Details|dict, Error|uri, Arguments|list?, ArgumentsKw|dict?]`.
 *  `requestType` is kept as received (49 is routed like 48; unknown types are dropped by routing). */
export interface InboundError {
  readonly type: typeof MessageType.ERROR;
  readonly requestType: number;
  readonly requestId: number;
  readonly details: Dict;
  readonly error: string;
  readonly args: readonly unknown[];
  readonly kwargs: Dict;
  readonly invalid?: PayloadInvalid;
}
/** `[17, PUBLISH.Request|id, Publication|id]` */
export interface InboundPublished {
  readonly type: typeof MessageType.PUBLISHED;
  readonly requestId: number;
  readonly publicationId: number;
}
/** `[33, SUBSCRIBE.Request|id, Subscription|id]` */
export interface InboundSubscribed {
  readonly type: typeof MessageType.SUBSCRIBED;
  readonly requestId: number;
  readonly subscriptionId: number;
}
/** `[35, UNSUBSCRIBE.Request|id]` */
export interface InboundUnsubscribed {
  readonly type: typeof MessageType.UNSUBSCRIBED;
  readonly revocation: false;
  readonly requestId: number;
}
/** `[35, 0, Details|dict]` with `details.subscription` an id: router-initiated revocation. */
export interface InboundSubscriptionRevoked {
  readonly type: typeof MessageType.UNSUBSCRIBED;
  readonly revocation: true;
  readonly requestId: 0;
  readonly subscriptionId: number;
  /** `details.reason` when it is a string. */
  readonly reason: string | undefined;
  readonly details: Dict;
}
/** `[36, SUBSCRIBED.Subscription|id, PUBLISHED.Publication|id, Details|dict, Arguments|list?, ArgumentsKw|dict?]` */
export interface InboundEvent {
  readonly type: typeof MessageType.EVENT;
  readonly subscriptionId: number;
  readonly publicationId: number;
  readonly details: Dict;
  readonly args: readonly unknown[];
  readonly kwargs: Dict;
  readonly invalid?: PayloadInvalid;
}
/** `[50, CALL.Request|id, Details|dict, YIELD.Arguments|list?, YIELD.ArgumentsKw|dict?]` */
export interface InboundResult {
  readonly type: typeof MessageType.RESULT;
  readonly requestId: number;
  readonly details: Dict;
  readonly args: readonly unknown[];
  readonly kwargs: Dict;
  readonly invalid?: PayloadInvalid;
}
/** `[65, REGISTER.Request|id, Registration|id]` */
export interface InboundRegistered {
  readonly type: typeof MessageType.REGISTERED;
  readonly requestId: number;
  readonly registrationId: number;
}
/** `[67, UNREGISTER.Request|id]` */
export interface InboundUnregistered {
  readonly type: typeof MessageType.UNREGISTERED;
  readonly revocation: false;
  readonly requestId: number;
}
/** `[67, 0, Details|dict]` with `details.registration` an id: router-initiated revocation. */
export interface InboundRegistrationRevoked {
  readonly type: typeof MessageType.UNREGISTERED;
  readonly revocation: true;
  readonly requestId: 0;
  readonly registrationId: number;
  readonly reason: string | undefined;
  readonly details: Dict;
}
/** `[68, Request|id, REGISTERED.Registration|id, Details|dict, CALL.Arguments|list?, CALL.ArgumentsKw|dict?]` */
export interface InboundInvocation {
  readonly type: typeof MessageType.INVOCATION;
  readonly requestId: number;
  readonly registrationId: number;
  readonly details: Dict;
  readonly args: readonly unknown[];
  readonly kwargs: Dict;
  readonly invalid?: PayloadInvalid;
}
/** `[69, INVOCATION.Request|id, Options|dict]` (Thruway PHP sends `{}`; `mode` may be absent). */
export interface InboundInterrupt {
  readonly type: typeof MessageType.INTERRUPT;
  readonly requestId: number;
  readonly options: Dict;
}

/** Every router→client message the client handles. */
export type InboundMessage =
  | InboundWelcome
  | InboundAbort
  | InboundChallenge
  | InboundGoodbye
  | InboundError
  | InboundPublished
  | InboundSubscribed
  | InboundUnsubscribed
  | InboundSubscriptionRevoked
  | InboundEvent
  | InboundResult
  | InboundRegistered
  | InboundUnregistered
  | InboundRegistrationRevoked
  | InboundInvocation
  | InboundInterrupt;

/**
 * decode()'s verdict on one deserialized frame. `frame` is the frame as text, truncated to 256 chars.
 * - `message`: valid or normalised (possibly payload-invalid, see `PayloadInvalid`); `warnings` lists the
 *   normalisations that are logged at `warn` (e.g. a WELCOME details dict replaced by `{}`).
 * - `fatal`: header-fatal — the client ABORTs `wamp.error.protocol_violation`, closes 4000 and reconnects.
 * - `dropped`: irrelevant or unknown (unknown types, client-only types, revocations of non-ids, …).
 */
export type DecodeResult =
  | { readonly kind: 'message'; readonly message: InboundMessage; readonly warnings: readonly string[] }
  | { readonly kind: 'fatal'; readonly reason: string; readonly frame: string }
  | { readonly kind: 'dropped'; readonly reason: string; readonly level: 'debug' | 'warn'; readonly frame: string };

// ---------------------------------------------------------------------------------------------------------------
// Outbound (client → router): every frame the client writes
// ---------------------------------------------------------------------------------------------------------------

/** The normalised payload tail of CALL/PUBLISH/YIELD/ERROR (produced by protocol/payload.ts). */
export type OutboundPayload =
  readonly [] | readonly [args: readonly unknown[]] | readonly [args: readonly unknown[], kwargs: Dict];

/** `[1, realm, details]` HELLO — socket open; gate `hello`. */
export type HelloFrame = readonly [type: typeof MessageType.HELLO, realm: string, details: Dict];
/** `[5, signature, {}]` AUTHENTICATE — latest CHALLENGE answered for the current round; gate `hello`. */
export type AuthenticateFrame = readonly [type: typeof MessageType.AUTHENTICATE, signature: string, extra: EmptyDict];
/** `[3, {message}, reason]` ABORT — `cannot_authenticate` (gate `hello`) or `protocol_violation` (`hello`/`open`). */
export type AbortFrame = readonly [
  type: typeof MessageType.ABORT,
  details: { readonly message: string },
  reason: ClientAbortReason,
];
/** `[6, {}, reason]` GOODBYE — `goodbye_and_out` replies to a router GOODBYE in ESTABLISHED; `close_realm` for
 *  `close()`/`reconnect()` and the unrequested-anonymous WELCOME rejection. Nothing is written after it. */
export type GoodbyeFrame = readonly [type: typeof MessageType.GOODBYE, details: EmptyDict, reason: ClientGoodbyeReason];
/** `[48, id, options, procedure, args?, kwargs?]` CALL (also the liveness probe) — gate `open`. */
export type CallFrame = readonly [
  type: typeof MessageType.CALL,
  requestId: number,
  options: Dict,
  procedure: string,
  ...payload: OutboundPayload,
];
/** `[49, id, {mode: "killnowait"}]` CANCEL — unsubscribe of an in-flight call; gate `open`. */
export type CancelFrame = readonly [
  type: typeof MessageType.CANCEL,
  requestId: number,
  options: { readonly mode: 'killnowait' },
];
/** `[16, id, options, topic, args?, kwargs?]` PUBLISH — gate `open`. */
export type PublishFrame = readonly [
  type: typeof MessageType.PUBLISH,
  requestId: number,
  options: Dict,
  topic: string,
  ...payload: OutboundPayload,
];
/** `[32, id, options, topic]` SUBSCRIBE — gate `open`. */
export type SubscribeFrame = readonly [
  type: typeof MessageType.SUBSCRIBE,
  requestId: number,
  options: Dict,
  topic: string,
];
/** `[34, id, subscriptionId]` UNSUBSCRIBE — only for an id received in the current session; gate `open`. */
export type UnsubscribeFrame = readonly [
  type: typeof MessageType.UNSUBSCRIBE,
  requestId: number,
  subscriptionId: number,
];
/** `[64, id, options, procedure]` REGISTER — gate `open`. */
export type RegisterFrame = readonly [
  type: typeof MessageType.REGISTER,
  requestId: number,
  options: Dict,
  procedure: string,
];
/** `[66, id, registrationId]` UNREGISTER — gate `open`. */
export type UnregisterFrame = readonly [type: typeof MessageType.UNREGISTER, requestId: number, registrationId: number];
/** YIELD options: `{}` for a final answer, `{progress: true}` for a progress YIELD (only when the caller asked). */
export type YieldOptions = EmptyDict | { readonly progress: true };
/** `[70, invId, options, args?, kwargs?]` YIELD — handler result; gate `open`. */
export type YieldFrame = readonly [
  type: typeof MessageType.YIELD,
  invocationId: number,
  options: YieldOptions,
  ...payload: OutboundPayload,
];
/** `[8, 68, invId, details, uri, args?, kwargs?]` ERROR — the only ERROR a client writes (answering an INVOCATION). */
export type InvocationErrorFrame = readonly [
  type: typeof MessageType.ERROR,
  requestType: typeof MessageType.INVOCATION,
  invocationId: number,
  details: Dict,
  error: string,
  ...payload: OutboundPayload,
];

/** Every frame the client can write. */
export type OutboundFrame =
  | HelloFrame
  | AuthenticateFrame
  | AbortFrame
  | GoodbyeFrame
  | CallFrame
  | CancelFrame
  | PublishFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | RegisterFrame
  | UnregisterFrame
  | YieldFrame
  | InvocationErrorFrame;

export function helloFrame(realm: string, details: Dict): HelloFrame {
  return [MessageType.HELLO, realm, details];
}

export function authenticateFrame(signature: string): AuthenticateFrame {
  return [MessageType.AUTHENTICATE, signature, {}];
}

export function abortFrame(reason: ClientAbortReason, message: string): AbortFrame {
  return [MessageType.ABORT, { message }, reason];
}

export function goodbyeFrame(reason: ClientGoodbyeReason): GoodbyeFrame {
  return [MessageType.GOODBYE, {}, reason];
}

export function callFrame(
  requestId: number,
  options: Dict,
  procedure: string,
  payload: OutboundPayload = [],
): CallFrame {
  return [MessageType.CALL, requestId, options, procedure, ...payload];
}

/** The liveness probe `[48, id, {}, "thruway.js.ping"]`. */
export function probeFrame(requestId: number): CallFrame {
  return [MessageType.CALL, requestId, {}, Uri.PING_PROCEDURE];
}

export function cancelFrame(requestId: number): CancelFrame {
  return [MessageType.CANCEL, requestId, { mode: 'killnowait' }];
}

export function publishFrame(
  requestId: number,
  options: Dict,
  topic: string,
  payload: OutboundPayload = [],
): PublishFrame {
  return [MessageType.PUBLISH, requestId, options, topic, ...payload];
}

export function subscribeFrame(requestId: number, options: Dict, topic: string): SubscribeFrame {
  return [MessageType.SUBSCRIBE, requestId, options, topic];
}

export function unsubscribeFrame(requestId: number, subscriptionId: number): UnsubscribeFrame {
  return [MessageType.UNSUBSCRIBE, requestId, subscriptionId];
}

export function registerFrame(requestId: number, options: Dict, procedure: string): RegisterFrame {
  return [MessageType.REGISTER, requestId, options, procedure];
}

export function unregisterFrame(requestId: number, registrationId: number): UnregisterFrame {
  return [MessageType.UNREGISTER, requestId, registrationId];
}

/** A final (`progress` false) or progress YIELD. */
export function yieldFrame(invocationId: number, progress: boolean, payload: OutboundPayload = []): YieldFrame {
  const options: YieldOptions = progress ? { progress: true } : {};
  return [MessageType.YIELD, invocationId, options, ...payload];
}

export function invocationErrorFrame(
  invocationId: number,
  details: Dict,
  error: string,
  payload: OutboundPayload = [],
): InvocationErrorFrame {
  return [MessageType.ERROR, MessageType.INVOCATION, invocationId, details, error, ...payload];
}
