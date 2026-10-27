/**
 * Payload rules and the cycle-safe canonical JSON used for topic and registration keys.
 *
 * - Outbound (CALL/PUBLISH/YIELD/ERROR): empty args and kwargs are omitted; `[]` is sent before non-empty kwargs.
 * - Inbound: `null`/missing args ⇒ `[]`, `null`/missing kwargs ⇒ `{}`; kwargs sent as `[]` (PHP's
 *   `json_encode([])`) ⇒ `{}`; anything else that is not an array / plain object is payload-invalid.
 * - `canonicalJson`: JSON with object keys sorted, used only to key topics and registrations.
 *
 * @module
 */
import type { Dict, OutboundPayload, PayloadInvalid } from './messages.js';

/**
 * A plain object: `{…}` or `Object.create(null)`, from any realm (its prototype is null or has a null prototype).
 * Arrays, class instances, Maps, Dates, typed arrays and boxed primitives are not. Throws only what a Proxy trap throws.
 */
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** `[]`: what PHP's `json_encode` makes of an empty dict. */
export function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** Outbound (CALL/PUBLISH/YIELD/ERROR): both empty or undefined ⇒ omit both; kwargs non-empty ⇒ `args ?? []` then
 *  kwargs; args non-empty and kwargs empty ⇒ args only. Values are passed through untouched. */
export function outboundPayload(
  args: readonly unknown[] | undefined,
  kwargs: Readonly<Record<string, unknown>> | undefined,
): OutboundPayload {
  if (kwargs !== undefined && Object.keys(kwargs).length > 0) return [args ?? [], kwargs];
  if (args !== undefined && args.length > 0) return [args];
  return [];
}

/** Inbound: `null`/missing ⇒ `[]` / `{}` (fresh objects, so an app that mutates one changes nothing else);
 *  kwargs sent as `[]` ⇒ `{}`; anything else that is not an array / plain object ⇒ payload-invalid. Received payloads
 *  are not copied. */
export function inboundPayload(
  args: unknown,
  kwargs: unknown,
): { readonly args: readonly unknown[]; readonly kwargs: Dict } | { readonly invalid: Omit<PayloadInvalid, 'frame'> } {
  if (args !== undefined && args !== null && !Array.isArray(args)) {
    return { invalid: { reason: 'args is not an array' } };
  }
  if (kwargs !== undefined && kwargs !== null && !isEmptyArray(kwargs) && !isPlainObject(kwargs)) {
    return { invalid: { reason: 'kwargs is not a dict' } };
  }
  return { args: Array.isArray(args) ? args : [], kwargs: isPlainObject(kwargs) ? kwargs : {} };
}

/**
 * JSON with object keys sorted recursively (plain objects only; arrays keep their order), otherwise exactly
 * `JSON.stringify` — `toJSON`, boxed primitives, omitted `undefined`/functions/symbols. A cycle or a BigInt throws
 * `TypeError` (the facade turns it into the subscription's error); a throwing getter or `toJSON` throws its own
 * error. A top-level value that JSON omits gives `'null'`.
 *
 * Cycle safety: every plain object is replaced by one sorted copy (the same copy each time it is met), so
 * `JSON.stringify`'s own cycle check sees the copies and throws `TypeError` instead of recursing forever.
 */
export function canonicalJson(value: unknown): string {
  const copies = new Map<object, Record<string, unknown>>();
  const text = JSON.stringify(value, (_key: string, item: unknown): unknown => {
    if (!isPlainObject(item)) return item;
    let copy = copies.get(item);
    if (copy === undefined) {
      copy = Object.create(null) as Record<string, unknown>;
      copies.set(item, copy);
      for (const key of Object.keys(item).sort()) copy[key] = item[key];
    }
    return copy;
  }) as string | undefined;
  return text ?? 'null';
}

/** The spec-typed boolean option keys. Their WAMP default is `false` (or they are meaningless for the op), so a
 *  `false` value is left out of topic and registration keys. */
export const SPEC_BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'receive_progress',
  'acknowledge',
  'disclose_me',
  'disclose_caller',
  'exclude_me',
  'retain',
  'get_retained',
  'force_reregister',
]);

/** Normalised options for a key: drops `undefined` values, `match: 'exact'`, `invoke: 'single'`
 *  (register) and spec booleans that are `false`. Never mutates `options`; the result is a new frozen object. */
export function normalizeKeyOptions(options: Dict, kind: 'topic' | 'register'): Dict {
  const kept: [string, unknown][] = [];
  for (const key of Object.keys(options)) {
    const value = options[key];
    if (value === undefined) continue;
    if (key === 'match' && value === 'exact') continue;
    if (kind === 'register' && key === 'invoke' && value === 'single') continue;
    if (value === false && SPEC_BOOLEAN_KEYS.has(key)) continue;
    kept.push([key, value]);
  }
  return Object.freeze(Object.fromEntries(kept)); // fromEntries defines `__proto__` as an own key, never the prototype
}
