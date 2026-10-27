/**
 * URI validation: the spec's loose rules, chosen by the `match` option. Crossbar kills the connection for invalid
 * CALL/PUBLISH/REGISTER URIs, so the client checks before writing.
 *
 * - exact (default): `^([^\s.#]+\.)*([^\s.#]+)$` (`\s`: see "whitespace" below)
 * - `match: 'prefix'`: `^([^\s.#]+\.)*([^\s.#]*)$` (trailing dot allowed; the empty prefix is allowed for SUBSCRIBE)
 * - `match: 'wildcard'`: `^(([^\s.#]+\.)|\.)*([^\s.#]+)?$`
 * - an implementation-specific `match` (`_…`): only "non-empty, no whitespace"
 *
 * "Whitespace" is what JavaScript's `\s` matches plus U+001C–U+001F and U+0085, which Python's `\s` (`str.isspace`)
 * also matches: Crossbar checks URIs with autobahn's Python patterns and kills the connection for a CALL/PUBLISH/REGISTER
 * URI they reject, so a URI must pass both definitions.
 *
 * The `wamp.` prefix is not rejected (routers decide; Thruway does not reserve it). Every pattern runs in linear time:
 * a component can never contain the `.` that ends it, so backtracking stays within one component.
 *
 * @module
 */

/* eslint-disable no-control-regex -- U+001C–U+001F are whitespace to Python's `\s` (Crossbar), see above */
const EXACT = /^(?:[^\s\x1c-\x1f\x85.#]+\.)*[^\s\x1c-\x1f\x85.#]+$/;
const PREFIX = /^(?:[^\s\x1c-\x1f\x85.#]+\.)*[^\s\x1c-\x1f\x85.#]*$/;
const WILDCARD = /^(?:[^\s\x1c-\x1f\x85.#]+\.|\.)*(?:[^\s\x1c-\x1f\x85.#]+)?$/;
const LOOSE = /^[^\s\x1c-\x1f\x85]+$/;
/* eslint-enable no-control-regex */

/** Implementation-specific `match`/`invoke` values (the WAMP spec's rule for implementation-specific keys): `_` + 3 or
 *  more of `[a-z0-9_]`, e.g. Thruway's `_thruway`, or `_mqtt` for fox-wamp's MQTT-style URIs. */
export const IMPLEMENTATION_SPECIFIC_POLICY = /^_[a-z0-9_]{3,}$/;

/** True when `uri` is valid under the rule selected by `match` (undefined or 'exact' ⇒ the exact rule). Also used for
 *  the realm (exact rule) and for error URIs raised by handlers (exact rule). A non-string is never valid;
 *  a `match` that is neither a spec policy nor implementation-specific selects the exact rule. */
export function isValidUri(uri: string, match?: string): boolean {
  if (typeof uri !== 'string') return false;
  if (match === 'prefix') return PREFIX.test(uri);
  if (match === 'wildcard') return WILDCARD.test(uri);
  if (typeof match === 'string' && IMPLEMENTATION_SPECIFIC_POLICY.test(match)) return LOOSE.test(uri);
  return EXACT.test(uri);
}
