/**
 * Internal: the pure decisions of the reference router (router.ts) that depend on a dialect's flags (dialects.ts):
 * payload styles, topic and procedure matching, URI rules, request-id rules, Crossbar's option types, INTERRUPT
 * options, ERROR args, Thruway PHP's auth details.
 *
 * @module
 */
import type { Dict } from '../protocol/messages.js';
import { isPlainObject, outboundPayload } from '../protocol/payload.js';
import { isValidUri } from '../protocol/uri.js';
import { decodeUtf8 } from '../transport/json.js';
import { isYield } from '../yield.js';
import type { PayloadStyle, QuirkFlags, UriRule } from './dialects.js';
import { isId } from './oracle.js';
import { utf8Length } from './socket.js';

type Frame = readonly unknown[];

/** Reads `value[key]`, never throwing (handler results and decisions are test code). */
export function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `String(e?.message ?? e)`, never throwing. */
export function messageOf(error: unknown): string {
  try {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return String(message ?? error);
  } catch {
    return 'unknown error';
  }
}

/** A frame as recorded: decoded when it is a JSON array (binary frames as UTF-8), the raw text otherwise. */
export function decodeFrame(data: string | Uint8Array): readonly unknown[] | string {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    try {
      text = decodeUtf8(data);
    } catch {
      return `[binary frame of ${String(data.length)} bytes, not UTF-8]`;
    }
  }
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : text;
  } catch {
    return text;
  }
}

/** The yieldPayload rule: undefined ⇒ nothing, a Yield ⇒ its args/kwargs, anything else ⇒ `[v]`; a Yield
 *  whose args is not an array or whose kwargs is not a dict is invalid. */
export function yieldPayload(value: unknown): readonly unknown[] | undefined {
  if (value === undefined) return [];
  if (!isYield(value)) return [[value]];
  const args = read(value, 'args');
  const kwargs = read(value, 'kwargs');
  if (!Array.isArray(args) || !isPlainObject(kwargs)) return undefined;
  return outboundPayload(args, kwargs);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) ? value.length === 0 : isPlainObject(value) && Object.keys(value).length === 0;
}

/** fox-wamp's args: absent, `[]` and `[null]` become `null`; a single array argument is unwrapped. */
function foxArgs(args: unknown): unknown {
  if (!Array.isArray(args) || args.length === 0) return null;
  if (args.length === 1 && (args[0] === null || Array.isArray(args[0]))) return args[0] ?? null;
  return args;
}

/**
 * The payload elements of a forwarded frame, from `frame[at]`/`frame[at + 1]` of the frame that carried them, in the
 * dialect's payload style (dialects.ts `PayloadStyle`). `kind` is the frame being built.
 */
export function forwardPayload(
  style: PayloadStyle,
  kind: 'invocation' | 'result' | 'event' | 'error',
  frame: Frame,
  at: number,
): unknown[] {
  const present = frame.slice(at, at + 2);
  const args = frame[at];
  const kwargs = frame[at + 1];
  switch (style) {
    case 'keep':
      return present;
    case 'strip-empty':
      if (!isEmpty(kwargs)) return [args ?? [], kwargs];
      return isEmpty(args) ? [] : [args];
    case 'fox-wamp':
      return [foxArgs(args), kwargs ?? (kind === 'invocation' ? {} : null)];
    case 'wamp-server':
      return kind === 'result' ? [args ?? null] : [args ?? null, kwargs ?? null];
  }
}

/**
 * Does a subscription or registration `pattern` with policy `match` cover `uri`? Exact: equality (a router that
 * treats a wildcard pattern as exact never matches its empty components); prefix: by characters; otherwise (wildcard,
 * an implementation-specific policy) component by component, an empty pattern component matching any one. `mqtt`
 * (exact only): `*` matches one component and `#` the rest, also none (fox-wamp).
 */
export function matches(pattern: string, match: string, uri: string, mqtt = false): boolean {
  if (match === 'prefix') return uri.startsWith(pattern);
  if (match === 'exact' && !mqtt) return pattern === uri;
  const p = pattern.split('.');
  const u = uri.split('.');
  if (mqtt) {
    const hash = p.indexOf('#');
    const fixed = hash < 0 ? p : p.slice(0, hash);
    if (hash < 0 ? u.length !== p.length : u.length < fixed.length) return false;
    return fixed.every((part, i) => part === '*' || part === u[i]);
  }
  return p.length === u.length && p.every((part, i) => part === '' || part === u[i]);
}

const STRICT_URI = /^(?:[0-9a-z_]+\.)*[0-9a-z_]+$/;

/** A URI passes the dialect's rule (`strict`: Thruway PHP's regex; a prefix may also be empty or end with a dot). */
export function uriAllowed(rule: UriRule, uri: string, match: string): boolean {
  if (rule === 'none') return true;
  if (rule === 'loose') return isValidUri(uri, match);
  const bare = match === 'prefix' && uri.endsWith('.') ? uri.slice(0, -1) : uri;
  return (match === 'prefix' && bare === '') || STRICT_URI.test(bare);
}

/** The request id rule (dialects.ts `request_id_validation`): accepted, rejected as malformed, or silently ignored
 *  (fox-wamp's id 0). */
export function requestIdVerdict(
  rule: QuirkFlags['request_id_validation'],
  id: unknown,
): 'ok' | 'malformed' | 'ignore' {
  switch (rule) {
    case 'spec':
      return isId(id) ? 'ok' : 'malformed';
    case 'range':
      return Number.isInteger(id) && (id as number) >= 0 && (id as number) <= 2 ** 53 ? 'ok' : 'malformed';
    case 'none':
      return 'ok';
    case 'none-but-zero':
      return id === 0 ? 'ignore' : 'ok';
  }
}

const BOOLEAN_OPTIONS: Readonly<Record<number, readonly string[]>> = {
  16: ['acknowledge', 'exclude_me', 'disclose_me', 'retain'],
  48: ['receive_progress', 'disclose_me'],
  64: ['disclose_caller'],
};
const MATCH_POLICIES: ReadonlySet<unknown> = new Set(['exact', 'prefix', 'wildcard']);
const CANCEL_MODES: ReadonlySet<unknown> = new Set(['skip', 'kill', 'killnowait']);
const INVOKE_POLICIES: ReadonlySet<unknown> = new Set(['single', 'roundrobin', 'random', 'first', 'last']);

/** Crossbar's typed options (quirk 3 of test/routers/crossbar/README.md): booleans, an integer `timeout`, known
 *  `match`/`invoke`/CANCEL `mode` values. */
export function optionTypesOk(type: number, options: Dict): boolean {
  if (type === 49) return options['mode'] === undefined || CANCEL_MODES.has(options['mode']);
  for (const key of BOOLEAN_OPTIONS[type] ?? []) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') return false;
  }
  if (type === 48 && options['timeout'] !== undefined && !Number.isInteger(options['timeout'])) return false;
  if ((type === 32 || type === 64) && options['match'] !== undefined && !MATCH_POLICIES.has(options['match']))
    return false;
  return !(type === 64 && options['invoke'] !== undefined && !INVOKE_POLICIES.has(options['invoke']));
}

/** INTERRUPT.Options in the dialect's style. */
export function interruptOptions(style: QuirkFlags['interrupt_options'], mode: string, reason: string): Dict {
  if (style === 'empty') return {};
  return style === 'mode' ? { mode } : { reason, mode };
}

/** The args/kwargs a router adds to its own ERRORs (dialects.ts `router_error_args`, `no_such_procedure_message`). */
export function routerErrorPayload(flags: QuirkFlags, message: string | undefined): unknown[] {
  if (flags.router_error_args === 'null') return [null];
  if (message !== undefined) return [[message]];
  return flags.router_error_args === 'empty-string' ? [['']] : [];
}

/** The auth details of a session as the router keeps them (disclosure, eligible/exclude lists). */
export interface AuthInfo {
  readonly authid: unknown;
  readonly authrole: unknown;
  readonly authroles: readonly unknown[];
  readonly authmethod: unknown;
}

/** From WELCOME.Details; a WELCOME without them is Thruway PHP's anonymous session (`createAnonymous()`). */
export function authInfoOf(welcome: Dict): AuthInfo {
  const authrole = welcome['authrole'] ?? 'anonymous';
  return {
    authid: welcome['authid'] ?? 'anonymous',
    authrole,
    authroles: Array.isArray(welcome['authroles']) ? welcome['authroles'] : [authrole],
    authmethod: welcome['authmethod'] ?? 'anonymous',
  };
}

/**
 * Thruway PHP's publication filter (SubscriptionGroup::sendEventMessage): `eligible`/`exclude` session ids, then its
 * own `_thruway_eligible_authroles` (any of the subscriber's roles) and `_thruway_eligible_authids` (absent or null:
 * everyone; present but not an array: nobody); the spec's `eligible_authid`/`exclude_authrole`/… are not read.
 */
export function thruwayEligible(session: number, auth: AuthInfo, options: Dict): boolean {
  const only = options['eligible'];
  const not = options['exclude'];
  if ((Array.isArray(only) && !only.includes(session)) || (Array.isArray(not) && not.includes(session))) return false;
  const roles = options['_thruway_eligible_authroles'];
  const ids = options['_thruway_eligible_authids'];
  const admits = (list: unknown, values: readonly unknown[]): boolean =>
    list === undefined || list === null || (Array.isArray(list) && values.some((v) => list.includes(v)));
  return admits(roles, auth.authroles) && admits(ids, [auth.authid]);
}

/**
 * Thruway PHP's authenticated WELCOME details (AuthenticationManager::sendWelcomeMessage): the provider's details,
 * `authid` defaulting to 'authenticated_user', and the role list built by `addAuthRole` (each addition goes in front):
 * 'authenticated_user', then the provider's `authroles`, then its `authrole`; `authrole` is the first of them.
 * `method` is forced as `authmethod` for a WELCOME without CHALLENGE (NOCHALLENGE).
 */
export function thruwayAuthDetails(details: Dict, method: string | undefined): Dict {
  let roles: unknown[] = ['authenticated_user'];
  const authroles = details['authroles'];
  if (Array.isArray(authroles)) roles = [...(authroles as unknown[]), ...roles];
  if (details['authrole'] !== undefined) roles = [details['authrole'], ...roles];
  return {
    ...details,
    ...(method === undefined ? {} : { authmethod: method }),
    authrole: roles[0],
    authroles: roles,
    authid: details['authid'] ?? 'authenticated_user',
  };
}

/** UTF-8 length of a frame as it travels. */
export function byteLength(data: string | Uint8Array): number {
  return typeof data === 'string' ? utf8Length(data) : data.length;
}
