/**
 * WAMP message type codes, URI constants and the WebSocket close codes the client uses.
 *
 * @module
 */

/** Every WAMP v2 message type code (HEARTBEAT 7 is obsolete and only recognised to be dropped). */
export const MessageType = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  CHALLENGE: 4,
  AUTHENTICATE: 5,
  GOODBYE: 6,
  HEARTBEAT: 7,
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
export type MessageTypeName = keyof typeof MessageType;
export type MessageTypeCode = (typeof MessageType)[MessageTypeName];

/** Types a router sends to a client (handled or deliberately dropped per state). */
export const ROUTER_TO_CLIENT_TYPES: ReadonlySet<number> = new Set<number>([
  MessageType.WELCOME,
  MessageType.ABORT,
  MessageType.CHALLENGE,
  MessageType.GOODBYE,
  MessageType.ERROR,
  MessageType.PUBLISHED,
  MessageType.SUBSCRIBED,
  MessageType.UNSUBSCRIBED,
  MessageType.EVENT,
  MessageType.RESULT,
  MessageType.REGISTERED,
  MessageType.UNREGISTERED,
  MessageType.INVOCATION,
  MessageType.INTERRUPT,
]);

/** Types only clients send; received from a router they are dropped (`warn`): nothing pending can be lost. */
export const CLIENT_ONLY_TYPES: ReadonlySet<number> = new Set<number>([
  MessageType.HELLO,
  MessageType.AUTHENTICATE,
  MessageType.PUBLISH,
  MessageType.SUBSCRIBE,
  MessageType.UNSUBSCRIBE,
  MessageType.CALL,
  MessageType.CANCEL,
  MessageType.REGISTER,
  MessageType.UNREGISTER,
  MessageType.YIELD,
]);

/** The WAMP spec's implementation-specific message type range: dropped (`warn`). */
export const IMPLEMENTATION_SPECIFIC_TYPES = { min: 256, max: 1023 } as const;

/** Request types an ERROR can answer, as the core routes them (49 = Thruway PHP's and Bondy's cancel replies; 8 =
 *  Thruway's `[8,8,…]` after killnowait, dropped). */
export const ErrorRequestType = {
  PUBLISH: MessageType.PUBLISH,
  SUBSCRIBE: MessageType.SUBSCRIBE,
  UNSUBSCRIBE: MessageType.UNSUBSCRIBE,
  CALL: MessageType.CALL,
  CANCEL: MessageType.CANCEL,
  REGISTER: MessageType.REGISTER,
  UNREGISTER: MessageType.UNREGISTER,
  INVOCATION: MessageType.INVOCATION,
} as const;

/** URIs the client sends, receives, raises or recognises. */
export const Uri = {
  // --- GOODBYE / ABORT reasons ---
  /** The reason of the client's own GOODBYE (`close()`, `reconnect()`, the anonymous-WELCOME rejection). */
  CLOSE_REALM: 'wamp.close.close_realm',
  /** The reason of the client's reply to every router GOODBYE. */
  GOODBYE_AND_OUT: 'wamp.close.goodbye_and_out',
  /** The legacy spelling Thruway PHP and fox-wamp send as their GOODBYE reply (accepted in lingering). */
  GOODBYE_AND_OUT_LEGACY: 'wamp.error.goodbye_and_out',
  /** Crossbar's GOODBYE reply reason. */
  CLOSE_NORMAL: 'wamp.close.normal',
  /** Router shutting down (spec). */
  SYSTEM_SHUTDOWN: 'wamp.close.system_shutdown',
  /** Session killed by the router (spec, meta API). */
  KILLED: 'wamp.close.killed',
  /** The reason the client ABORTs with on a header-fatal frame. */
  PROTOCOL_VIOLATION: 'wamp.error.protocol_violation',
  /** The reason the client ABORTs with when it cannot answer a CHALLENGE. */
  CANNOT_AUTHENTICATE: 'wamp.error.cannot_authenticate',
  NO_SUCH_REALM: 'wamp.error.no_such_realm',
  NO_SUCH_ROLE: 'wamp.error.no_such_role',
  AUTHENTICATION_FAILED: 'wamp.error.authentication_failed',
  AUTHORIZATION_FAILED: 'wamp.error.authorization_failed',
  /** Thruway PHP's ABORT reason for a rejected AUTHENTICATE. */
  THRUWAY_AUTHENTICATION_FAILURE: 'thruway.error.authentication_failure',
  /** The reason used when an ABORT/GOODBYE carries no string reason. */
  UNKNOWN: 'wamp.error.unknown',

  // --- ERROR URIs ---
  INVALID_URI: 'wamp.error.invalid_uri',
  NO_SUCH_PROCEDURE: 'wamp.error.no_such_procedure',
  PROCEDURE_ALREADY_EXISTS: 'wamp.error.procedure_already_exists',
  NO_SUCH_REGISTRATION: 'wamp.error.no_such_registration',
  NO_SUCH_SUBSCRIPTION: 'wamp.error.no_such_subscription',
  INVALID_ARGUMENT: 'wamp.error.invalid_argument',
  RUNTIME_ERROR: 'wamp.error.runtime_error',
  /** The WAMP spec spells this both ways; the client sends `canceled` and classifies both. */
  CANCELED: 'wamp.error.canceled',
  CANCELLED: 'wamp.error.cancelled',
  NOT_SUPPORTED: 'wamp.error.not_supported',
  NOT_AUTHORIZED: 'wamp.error.not_authorized',
  NO_ELIGIBLE_CALLEE: 'wamp.error.no_eligible_callee',
  CALLEE_FAILURE: 'wamp.error.callee_failure',
  TIMEOUT: 'wamp.error.timeout',
  OPTION_NOT_ALLOWED: 'wamp.error.option_not_allowed',
  /** A frame over 16 MiB: the op errors with it, or the callee answers it. */
  PAYLOAD_SIZE_EXCEEDED: 'wamp.error.payload_size_exceeded',
  /** Revocations (`[35|67, 0, {…}]`) surface as these WampErrors. */
  SUBSCRIPTION_REVOKED: 'thruway.error.subscription_revoked',
  REGISTRATION_REVOKED: 'thruway.error.registration_revoked',

  // --- client-internal names ---
  /** The liveness probe: a CALL to a procedure that does not exist. */
  PING_PROCEDURE: 'thruway.js.ping',
} as const;
export type KnownUri = (typeof Uri)[keyof typeof Uri];

/** The two GOODBYE reasons the client ever writes. */
export type ClientGoodbyeReason = typeof Uri.CLOSE_REALM | typeof Uri.GOODBYE_AND_OUT;
/** The two ABORT reasons the client ever writes. */
export type ClientAbortReason = typeof Uri.CANNOT_AUTHENTICATE | typeof Uri.PROTOCOL_VIOLATION;
/** Every spelling of a GOODBYE reply a lingering connection accepts (any reason is accepted there). */
export const GOODBYE_REPLY_REASONS: ReadonlySet<string> = new Set<string>([
  Uri.GOODBYE_AND_OUT,
  Uri.GOODBYE_AND_OUT_LEGACY,
  Uri.CLOSE_NORMAL,
]);

/** WebSocket close codes the client uses. */
export const CloseCode = {
  /** close(), after GOODBYE/ABORT, after a GOODBYE reply. */
  NORMAL: 1000,
  /** The client detected a protocol violation. */
  PROTOCOL_VIOLATION: 4000,
  /** Client timeout: connect, handshake, liveness. */
  CLIENT_TIMEOUT: 4001,
  /** Client internal error (`hardReset`). */
  INTERNAL_ERROR: 4002,
} as const;

/** WebSocket close codes the client reports (received). Not exhaustive: any code is surfaced. */
export const ReceivedCloseCode = {
  ABNORMAL: 1006,
  NO_STATUS: 1005,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
} as const;
