/**
 * Per-op argument validation and snapshots, run by the facade inside `subscribe` (app context): URI rule by `match`;
 * `args` an array or absent, `kwargs`/`options` plain objects or absent (shallow-copied, options without `undefined`
 * values); spec-typed keys; rejected keys (`progress` in CALL options, any `ppt_*`, REGISTER `forward_timeout`);
 * topic/registration keys via the cycle-safe `canonicalJson`. Throws `TypeError`, or
 * `WampError('wamp.error.invalid_uri', [uri])` for URIs — the facade turns either into that subscription's error.
 *
 * Rules:
 * - `null` counts as absent for `args`, `kwargs` and `options` (`publish(uri, null)`), like `undefined`.
 * - App objects are read once each, here: getters, Proxies and cycles can only fail this subscription; a throw out of
 *   app code (a getter, a Proxy trap, `toJSON`) propagates unchanged. The snapshots are frozen copies (`args` and
 *   `kwargs` shallow; `options` shallow except that the spec-typed arrays are copied too, so what was validated is
 *   what is sent); the app's objects are never mutated.
 * - Options must be JSON-serializable (cycles, BigInt ⇒ TypeError), checked with `canonicalJson` for every op.
 * - Spec-typed keys are validated for every op whatever its kind (a key that means nothing to an op still has the
 *   spec's type); so are the router-specific keys that make Crossbar close the connection when mistyped
 *   (`concurrency`, `caller`, `caller_authid`, `caller_authrole`, `transaction_hash`, `forward_for`,
 *   with the types autobahn's message parser checks); other keys pass through untouched (router-specific options).
 * - `snapshotProgressiveCall` is `progressiveCall`'s: `receive_progress: true` replaces whatever the app passed.
 *
 * @module
 */
import type {
  CallSnapshot,
  OptionsSnapshot,
  PublishSnapshot,
  RegisterSnapshot,
  TopicSnapshot,
} from './core/contracts.js';
import { WampError, withContext } from './errors.js';
import { Uri } from './protocol/codes.js';
import { isId } from './protocol/decode.js';
import { canonicalJson, isPlainObject, normalizeKeyOptions, SPEC_BOOLEAN_KEYS } from './protocol/payload.js';
import { IMPLEMENTATION_SPECIFIC_POLICY, isValidUri } from './protocol/uri.js';

type Op = 'call' | 'publish' | 'topic' | 'register';

const MATCH_POLICIES: ReadonlySet<unknown> = new Set(['exact', 'prefix', 'wildcard']);
const INVOKE_POLICIES: ReadonlySet<unknown> = new Set(['single', 'roundrobin', 'random', 'first', 'last']);
const ID_ARRAY_KEYS: ReadonlySet<string> = new Set(['exclude', 'eligible']);
const STRING_ARRAY_KEYS: ReadonlySet<string> = new Set([
  'exclude_authid',
  'exclude_authrole',
  'eligible_authid',
  'eligible_authrole',
]);
/** Router-specific keys Crossbar (autobahn 26.10 `message.py`) requires to be strings: CALL `caller_authid`,
 *  `caller_authrole`; CALL and PUBLISH `transaction_hash`. */
const STRING_KEYS: ReadonlySet<string> = new Set(['caller_authid', 'caller_authrole', 'transaction_hash']);
const EMPTY_OPTIONS: OptionsSnapshot = Object.freeze({});
const PROGRESS_OPTIONS: OptionsSnapshot = Object.freeze({ receive_progress: true });

export function snapshotCall(procedure: unknown, args: unknown, kwargs: unknown, options: unknown): CallSnapshot {
  return callSnapshot(procedure, args, kwargs, options, false);
}

/** `progressiveCall`: `snapshotCall` with `receive_progress: true` whatever `options` says — the app's
 *  `receive_progress` is ignored (not even read); everything else is validated and copied exactly as for `call`. */
export function snapshotProgressiveCall(
  procedure: unknown,
  args: unknown,
  kwargs: unknown,
  options: unknown,
): CallSnapshot {
  return callSnapshot(procedure, args, kwargs, options, true);
}

function callSnapshot(
  procedure: unknown,
  args: unknown,
  kwargs: unknown,
  options: unknown,
  forceProgress: boolean,
): CallSnapshot {
  const uri = uriString('call', procedure, 'procedure');
  const opts = snapshotOptions('call', options, forceProgress);
  if (!isValidUri(uri)) throw invalidUri(uri, { procedure: uri });
  const snapshot: CallSnapshot = {
    procedure: uri,
    args: snapshotArgs('call', args),
    kwargs: snapshotKwargs('call', kwargs),
    options: opts,
    progressive: opts['receive_progress'] === true,
  };
  canonicalJson(opts); // JSON-serializable: a cycle or BigInt throws TypeError
  return Object.freeze(snapshot);
}

export function snapshotPublish(topic: unknown, args: unknown, kwargs: unknown, options: unknown): PublishSnapshot {
  const uri = uriString('publish', topic, 'topic');
  const opts = snapshotOptions('publish', options);
  if (!isValidUri(uri)) throw invalidUri(uri, { topic: uri });
  const snapshot: PublishSnapshot = {
    topic: uri,
    args: snapshotArgs('publish', args),
    kwargs: snapshotKwargs('publish', kwargs),
    options: opts,
    ack: opts['acknowledge'] === true,
  };
  canonicalJson(opts);
  return Object.freeze(snapshot);
}

export function snapshotTopic(topic: unknown, options: unknown): TopicSnapshot {
  const uri = uriString('topic', topic, 'topic');
  const opts = snapshotOptions('topic', options);
  const match = matchOf(opts);
  if (!isValidUri(uri, match)) throw invalidUri(uri, { topic: uri });
  return Object.freeze({
    topic: uri,
    options: opts,
    key: `${uri} ${canonicalJson(normalizeKeyOptions(opts, 'topic'))}`,
    group: `${uri} ${match ?? 'exact'}`,
  });
}

export function snapshotRegister(procedure: unknown, handler: unknown, options: unknown): RegisterSnapshot {
  const uri = uriString('register', procedure, 'procedure');
  if (typeof handler !== 'function') throw new TypeError('register: handler must be a function');
  const opts = snapshotOptions('register', options);
  // the empty prefix and the empty wildcard are SUBSCRIBE things: an empty procedure is never registered
  if (uri === '' || !isValidUri(uri, matchOf(opts))) throw invalidUri(uri, { procedure: uri });
  return Object.freeze({
    procedure: uri,
    options: opts,
    key: `${uri} ${canonicalJson(normalizeKeyOptions(opts, 'register'))}`,
    handler: handler as RegisterSnapshot['handler'],
  });
}

// ---------------------------------------------------------------------------------------------------------------

function uriString(op: Op, uri: unknown, what: 'procedure' | 'topic'): string {
  if (typeof uri !== 'string') throw new TypeError(`${op}: ${what} must be a string`);
  return uri;
}

/** `WampError('wamp.error.invalid_uri', [uri])` with the op's context. */
function invalidUri(uri: string, context: { readonly procedure: string } | { readonly topic: string }): WampError {
  return withContext(new WampError(Uri.INVALID_URI, [uri]), context);
}

/** The validated `match` (a string policy, or absent). */
function matchOf(options: OptionsSnapshot): string | undefined {
  return options['match'] as string | undefined;
}

function snapshotArgs(op: Op, args: unknown): readonly unknown[] | undefined {
  if (args === undefined || args === null) return undefined;
  if (!Array.isArray(args)) throw new TypeError(`${op}: args must be an array`);
  const source: readonly unknown[] = args;
  const copy: unknown[] = [];
  for (let i = 0, length = source.length; i < length; i++) copy.push(source[i]);
  return Object.freeze(copy);
}

function snapshotKwargs(op: Op, kwargs: unknown): Readonly<Record<string, unknown>> | undefined {
  if (kwargs === undefined || kwargs === null) return undefined;
  if (!isPlainObject(kwargs)) throw new TypeError(`${op}: kwargs must be a plain object`);
  return copyDict(kwargs);
}

/** A frozen copy of a plain object without its `undefined` values (JSON would drop them); each value is read once. */
function copyDict(dict: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const kept: [string, unknown][] = [];
  for (const key of Object.keys(dict)) {
    const value = dict[key];
    if (value !== undefined) kept.push([key, value]);
  }
  return Object.freeze(Object.fromEntries(kept)); // fromEntries defines `__proto__` as an own key
}

/** `forceProgress` (progressiveCall): `receive_progress: true` replaces whatever the app passed. */
function snapshotOptions(op: Op, options: unknown, forceProgress = false): OptionsSnapshot {
  if (forceProgress && (options === undefined || options === null)) return PROGRESS_OPTIONS;
  if (options === undefined || options === null) return EMPTY_OPTIONS;
  if (!isPlainObject(options)) throw new TypeError(`${op}: options must be a plain object`);
  const kept: [string, unknown][] = forceProgress ? [['receive_progress', true]] : [];
  for (const key of Object.keys(options)) {
    if (forceProgress && key === 'receive_progress') continue;
    const value = options[key];
    if (value === undefined) continue;
    const refusal = refusedKey(op, key);
    if (refusal !== undefined) throw new TypeError(`${op}: options.${key} is not supported (${refusal})`);
    kept.push([key, specValue(op, key, value)]);
  }
  return Object.freeze(Object.fromEntries(kept)); // fromEntries defines `__proto__` as an own key
}

/** Keys of features v3 does not announce (the WAMP spec's Payload Passthru Mode, Progressive Call Invocations and
 *  Call Timeout). */
function refusedKey(op: Op, key: string): string | undefined {
  if (key.startsWith('ppt_')) return 'payload passthru mode is not announced';
  if (op === 'call' && key === 'progress') return 'progressive call invocations are not announced';
  if (op === 'register' && key === 'forward_timeout') {
    return 'a callee registered with it must time out invocations itself, which thruway.js does not do';
  }
  return undefined;
}

/** `value` checked against the type of `key`, a spec-typed or Crossbar-checked one (a typed array is returned as a
 *  frozen copy). */
function specValue(op: Op, key: string, value: unknown): unknown {
  const wrong = (expected: string): TypeError => new TypeError(`${op}: options.${key} must be ${expected}`);
  if (SPEC_BOOLEAN_KEYS.has(key)) {
    if (typeof value !== 'boolean') throw wrong('a boolean');
    return value;
  }
  if (key === 'timeout') {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw wrong('a non-negative safe integer (milliseconds)');
    }
    return value;
  }
  if (key === 'match' || key === 'invoke') {
    const allowed = key === 'match' ? MATCH_POLICIES : INVOKE_POLICIES;
    if (!allowed.has(value) && !(typeof value === 'string' && IMPLEMENTATION_SPECIFIC_POLICY.test(value))) {
      throw wrong(`one of ${[...allowed].join(', ')} or an implementation-specific value matching ^_[a-z0-9_]{3,}$`);
    }
    return value;
  }
  if (ID_ARRAY_KEYS.has(key)) return arrayOf(value, isId, () => wrong('an array of ids'));
  if (STRING_ARRAY_KEYS.has(key)) return arrayOf(value, isString, () => wrong('an array of strings'));
  // Crossbar-checked router-specific keys: a mistake there closes the connection (1002, or 1011 for a
  // bad forward_for principal), so it is caught here and fails only this op.
  if (key === 'concurrency') {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw wrong('a positive safe integer');
    return value;
  }
  if (key === 'caller') {
    if (!isId(value)) throw wrong('an id');
    return value;
  }
  if (STRING_KEYS.has(key)) {
    if (!isString(value)) throw wrong('a string');
    return value;
  }
  if (key === 'forward_for') {
    return arrayOf(
      value,
      isPrincipal,
      () => wrong('an array of {session: id, authid: string, authrole: string}'),
      copyItem,
    );
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A `forward_for` principal (checked on its copy, so each app property is read once); other keys may come along. */
function isPrincipal(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  return isId(item['session']) && isString(item['authid']) && isString(item['authrole']);
}

/** Plain objects in a spec-typed array are copied too (frozen, without `undefined` values): what was validated is
 *  what is sent. */
function copyItem(item: unknown): unknown {
  return isPlainObject(item) ? copyDict(item) : item;
}

/** A frozen copy of an array whose items (`copy` of each element, read once) all pass `check`; `wrong()` otherwise. */
function arrayOf(
  value: unknown,
  check: (item: unknown) => boolean,
  wrong: () => TypeError,
  copy: (item: unknown) => unknown = (item) => item,
): readonly unknown[] {
  if (!Array.isArray(value)) throw wrong();
  const source: readonly unknown[] = value;
  const items: unknown[] = [];
  for (let i = 0, length = source.length; i < length; i++) {
    const item = copy(source[i]);
    if (!check(item)) throw wrong();
    items.push(item);
  }
  return Object.freeze(items);
}
