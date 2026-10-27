/**
 * Error classes, brand and guards.
 *
 * Every error the client creates is one of the eight classes below. Each instance carries:
 * - `name` — the class name, defined on the prototype as a literal (minifier-safe; also right in a stack captured by
 *   `super()`);
 * - `code` — an own enumerable property (stable);
 * - the brand `Symbol.for('thruway.js.error')` — an own non-enumerable, read-only property whose value is `code`. The
 *   guards check the brand, never `instanceof`, so errors from another copy of the package (ESM + CJS, two bundles,
 *   another realm) are recognised;
 * - the context fields given to its constructor (`sessionId`, `requestId`, `procedure`, `topic`, `attempt`), set only
 *   when defined, and `cause`, non-enumerable like the ES2022 `Error` option (which ES2020 code cannot use).
 *
 * Instances are not frozen (frameworks annotate errors). Fields are `declare`d (no emit, no `override` needed) —
 * `cause` in particular must stay a `declare` field: under lib ≥ es2022 `Error` already has `cause`, and a plain field
 * would need `override` there but must not have it under the es2020 library of src.
 *
 * @module
 */
import type { ErrorCode } from './types.js';

/** The brand every thruway.js error carries (non-enumerable own property, value = `code`). Dual-package safe. */
export const ERROR_BRAND: symbol = Symbol.for('thruway.js.error');

/** Constructor keys accept `undefined`: an undefined value is the same as a missing key. */
interface ErrorContext {
  readonly sessionId?: number | undefined;
  readonly requestId?: number | undefined;
  readonly procedure?: string | undefined; // call/register errors
  readonly topic?: string | undefined; // topic/publish errors
  readonly attempt?: number | undefined; // connection-level errors
  readonly cause?: unknown;
}

const CONTEXT_KEYS = ['sessionId', 'requestId', 'procedure', 'topic', 'attempt'] as const;

const CODES: Readonly<Record<ErrorCode, true>> = {
  wamp_error: true,
  connection_lost: true,
  connection_closed: true,
  timeout: true,
  abort: true,
  protocol: true,
  canceled: true,
  authentication: true,
};

type Writable = Record<string, unknown>;
type Init = Readonly<Record<string, unknown>>;

/** A missing init (JavaScript callers) behaves like `{}`. */
function initOf<T extends object>(init: T | undefined): Partial<T> {
  return init ?? {};
}

/** Brand, `code`, the given own fields and the defined context fields; `cause` when defined (non-enumerable). */
function setUp(error: Error, code: ErrorCode, fields: Init, init: Init): void {
  Object.defineProperty(error, ERROR_BRAND, { value: code });
  const target = error as unknown as Writable;
  target['code'] = code;
  for (const key of Object.keys(fields)) if (fields[key] !== undefined) target[key] = fields[key];
  for (const key of CONTEXT_KEYS) if (init[key] !== undefined) target[key] = init[key];
  if (init['cause'] !== undefined) {
    Object.defineProperty(error, 'cause', { value: init['cause'], writable: true, configurable: true });
  }
}

/**
 * `text` cut to at most `limit` characters; a cut text ends with '…' and never with half a surrogate pair.
 * @internal
 */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 1) return '';
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

export class WampError extends Error {
  // message === uri (v2 code compares e.message to an error URI)
  constructor(
    uri: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    details?: Readonly<Record<string, unknown>>,
  ) {
    const raw: unknown = uri;
    const text = typeof raw === 'string' ? raw : String(raw);
    super(text);
    // null/undefined mean "absent"; anything else is kept as given, so a handler's malformed payload is detected
    // where it is sent instead of being silently replaced.
    setUp(
      this,
      'wamp_error',
      { uri: text, errorUri: text, args: args ?? [], kwargs: kwargs ?? {}, details: details ?? {} },
      {},
    );
  }
  declare readonly name: 'WampError';
  declare readonly code: 'wamp_error';
  declare readonly uri: string;
  /** Same as uri. Kept because v2 code tests `e.errorUri`. */
  declare readonly errorUri: string;
  declare readonly args: readonly any[]; // args[0] untouched: the server sentence
  declare readonly kwargs: Readonly<Record<string, any>>;
  declare readonly details: Readonly<Record<string, unknown>>;
  declare readonly sessionId?: number;
  declare readonly requestId?: number;
  declare readonly procedure?: string;
  declare readonly topic?: string;
}

export class ConnectionLostError extends Error {
  constructor(
    init: {
      message?: string | undefined;
      reason?: string | undefined;
      closeCode?: number | undefined;
      cause?: unknown;
    } & ErrorContext,
  ) {
    const o = initOf(init);
    super(o.message ?? 'The connection was lost');
    setUp(this, 'connection_lost', { reason: o.reason, closeCode: o.closeCode }, o);
  }
  declare readonly name: 'ConnectionLostError';
  declare readonly code: 'connection_lost';
  /** WAMP URI when the session ended with GOODBYE/ABORT (received or sent, incl. 'wamp.close.close_realm' for
   *  reconnect()); undefined for socket-level losses (their close text is in `message`). */
  declare readonly reason?: string;
  declare readonly closeCode?: number;
  declare readonly cause?: unknown; // AbortError / TimeoutError / ProtocolError behind the loss, or a thrown value
  declare readonly sessionId?: number;
  declare readonly requestId?: number;
  declare readonly procedure?: string;
  declare readonly topic?: string;
}

export class ConnectionClosedError extends Error {
  constructor(init: { message?: string | undefined; gaveUp?: boolean | undefined; cause?: unknown } & ErrorContext) {
    const o = initOf(init);
    const gaveUp = o.gaveUp === true;
    super(o.message ?? (gaveUp ? 'The client gave up reconnecting' : 'The client was closed'));
    setUp(this, 'connection_closed', { gaveUp }, o);
  }
  declare readonly name: 'ConnectionClosedError';
  declare readonly code: 'connection_closed';
  declare readonly gaveUp: boolean; // false: close() was called; true: maxRetries exhausted or retryDelay returned null
  /** For an op that was in flight at the final loss: the ConnectionLostError (outcome unknown, README recipe 3).
   *  Otherwise the last attempt's error when gaveUp. */
  declare readonly cause?: unknown;
  declare readonly sessionId?: number;
  declare readonly requestId?: number;
  declare readonly procedure?: string;
  declare readonly topic?: string;
}

export class TimeoutError extends Error {
  constructor(
    init: {
      timer: 'connect' | 'handshake' | 'request' | 'liveness' | 'call';
      timeout: number;
      message?: string | undefined;
    } & ErrorContext,
  ) {
    const o = initOf(init);
    super(o.message ?? `The ${String(o.timer)} timeout of ${String(o.timeout)} ms expired`);
    setUp(this, 'timeout', { timer: o.timer, timeout: o.timeout }, o);
  }
  declare readonly name: 'TimeoutError';
  declare readonly code: 'timeout';
  /** 'request' = SUBSCRIBE/REGISTER only (UN* timeouts are logged). 'call' is never raised by the client: it is what
   *  README recipe 19 builds from the app's Rx timeout() so that every timeout classifies the same way. */
  declare readonly timer: 'connect' | 'handshake' | 'request' | 'liveness' | 'call';
  declare readonly timeout: number;
  declare readonly attempt?: number;
  declare readonly sessionId?: number; // 'request' timeouts carry it; so does recipe 19's 'call'
  declare readonly requestId?: number;
  declare readonly procedure?: string;
  declare readonly topic?: string;
}

export class AbortError extends Error {
  constructor(
    init: {
      reason: string;
      details?: Readonly<Record<string, unknown>> | undefined;
      message?: string | undefined;
    } & ErrorContext,
  ) {
    const o = initOf(init);
    const details = o.details ?? {};
    const text = details['message'];
    // message = details.message ?? reason (a router's human text when it sent one)
    super(o.message ?? (typeof text === 'string' && text !== '' ? text : String(o.reason)));
    setUp(this, 'abort', { reason: o.reason, details }, o);
  }
  declare readonly name: 'AbortError';
  declare readonly code: 'abort';
  declare readonly reason: string; // e.g. 'thruway.error.authentication_failure'
  declare readonly details: Readonly<Record<string, unknown>>; // message = details.message ?? reason
  declare readonly attempt?: number;
  declare readonly sessionId?: number;
}

/** Longest `ProtocolError.frame`. */
export const PROTOCOL_FRAME_LIMIT = 256;

export class ProtocolError extends Error {
  constructor(init: { message: string; frame?: string | undefined } & ErrorContext) {
    const o = initOf(init);
    super(o.message ?? 'Protocol violation');
    const frame = typeof o.frame === 'string' ? truncateText(o.frame, PROTOCOL_FRAME_LIMIT) : undefined;
    setUp(this, 'protocol', { frame }, o);
  }
  declare readonly name: 'ProtocolError';
  declare readonly code: 'protocol';
  declare readonly frame?: string; // offending inbound frame, truncated to 256 chars
  declare readonly attempt?: number;
  declare readonly sessionId?: number;
  declare readonly requestId?: number;
  declare readonly procedure?: string;
  declare readonly topic?: string;
}

export class CanceledError extends Error {
  constructor(init?: { message?: string | undefined } & ErrorContext) {
    const o = initOf(init);
    super(o.message ?? 'The operation was canceled');
    setUp(this, 'canceled', {}, o);
  }
  declare readonly name: 'CanceledError';
  declare readonly code: 'canceled';
  declare readonly requestId?: number;
  declare readonly procedure?: string;
}

export class AuthenticationError extends Error {
  // what the challenge handler threw/rejected
  constructor(init: { message: string; authMethod?: string | undefined } & ErrorContext) {
    const o = initOf(init);
    super(o.message ?? 'Authentication failed');
    setUp(this, 'authentication', { authMethod: o.authMethod }, o);
  }
  declare readonly name: 'AuthenticationError';
  declare readonly code: 'authentication';
  declare readonly authMethod?: string;
  declare readonly attempt?: number;
  declare readonly cause?: unknown;
}

// `name` lives on the prototype, spelled out (class names do not survive minification).
const NAMES: readonly (readonly [{ readonly prototype: Error }, string])[] = [
  [WampError, 'WampError'],
  [ConnectionLostError, 'ConnectionLostError'],
  [ConnectionClosedError, 'ConnectionClosedError'],
  [TimeoutError, 'TimeoutError'],
  [AbortError, 'AbortError'],
  [ProtocolError, 'ProtocolError'],
  [CanceledError, 'CanceledError'],
  [AuthenticationError, 'AuthenticationError'],
];
for (const [ctor, name] of NAMES) {
  Object.defineProperty(ctor.prototype, 'name', { value: name, writable: true, configurable: true });
}

export type ThruwayError =
  | WampError
  | ConnectionLostError
  | ConnectionClosedError
  | TimeoutError
  | AbortError
  | ProtocolError
  | CanceledError
  | AuthenticationError;

/**
 * Set the context fields of an error the client built (the `WampError` constructor takes none): defined values
 * only, the same error returned.
 * @internal
 */
export function withContext<E extends ThruwayError>(
  error: E,
  context: { readonly [K in (typeof CONTEXT_KEYS)[number]]?: ErrorContext[K] },
): E {
  const target = error as unknown as Writable;
  for (const key of CONTEXT_KEYS) if (context[key] !== undefined) target[key] = context[key];
  return error;
}

/** Reads `key` without ever throwing (hostile Proxies, throwing getters). */
function read(value: unknown, key: string | symbol): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    return (value as Record<string | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Brand checks (Symbol.for brand): safe across duplicate copies and the ESM/CJS dual package. */
export function isThruwayError(value: unknown): value is ThruwayError {
  const brand = read(value, ERROR_BRAND);
  return typeof brand === 'string' && Object.prototype.hasOwnProperty.call(CODES, brand);
}
export function isWampError(value: unknown): value is WampError {
  return read(value, ERROR_BRAND) === 'wamp_error' && read(value, 'code') === 'wamp_error';
}
