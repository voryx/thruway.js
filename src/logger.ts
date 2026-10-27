/**
 * Logging.
 *
 * - `safeLog` is the only way the client calls a logger (default or custom). It catches a throwing logger, falls back
 *   to one `console.error('thruway.js: logger threw', e)` per client (itself guarded, skipped when `console.error` is
 *   not a function) and swallows every later throw. It never re-logs, never rethrows, never returns a failure.
 * - `safeLogLazy` (`Effects.log`) builds an entry only when a custom logger is set, so frame entries and other debug
 *   detail cost nothing by default. An entry that must reach the default logger too (level `error`, e.g. an
 *   `unhandled` report from a participant) is passed already built, wrapped with `eager(entry)`.
 * - `defaultLogger` prints only `level: 'error'` entries, with `console.error`.
 * - Frame entries hold the byte length and a redacted preview of at most 512 characters, never the frame object.
 * - Redaction: the AUTHENTICATE signature; HELLO, CHALLENGE and WELCOME `authextra` values (CHALLENGE: its extra
 *   dict) except `pubkey`; WELCOME `details.transport.{headers,cookies,query_params}` values; URL query strings,
 *   fragments and user info (`redactUrl`, for `attempt.start`).
 *
 * @module
 */
import { truncateText } from './errors.js';
import { MessageType } from './protocol/codes.js';
import type { LogEntry } from './types.js';

export type Logger = (entry: LogEntry) => void;

/** Longest redacted frame preview in a frame entry. */
export const FRAME_PREVIEW_LIMIT = 512;

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** One client's logging state: its logger (custom or default) and whether the console fallback was used. */
export interface LogTarget {
  readonly logger: Logger;
  /** A custom logger was given: lazy entries (frames) are built. */
  readonly custom: boolean;
  fallbackUsed: boolean;
}

export function createLogTarget(logger: Logger | undefined): LogTarget {
  const custom = typeof logger === 'function';
  return { logger: custom ? logger : defaultLogger, custom, fallbackUsed: false };
}

/** `console.error(...args)` when there is one; never throws. */
function consoleError(...args: unknown[]): void {
  try {
    const host = (globalThis as { console?: unknown }).console;
    if (typeof host !== 'object' || host === null) return;
    const error = (host as { error?: unknown }).error;
    if (typeof error === 'function') (error as (this: unknown, ...a: unknown[]) => void).apply(host, args);
  } catch {
    // nowhere left to report to
  }
}

/** Call the logger; never throws, never re-logs. */
export function safeLog(target: LogTarget, entry: LogEntry): void {
  const log = target.logger; // called without `this`: the target is not the logger's business
  try {
    log(entry);
  } catch (error) {
    if (target.fallbackUsed) return;
    target.fallbackUsed = true;
    consoleError('thruway.js: logger threw', error);
  }
}

const PREBUILT = new WeakSet<() => LogEntry>();

/** A builder for an entry that is already built: `safeLogLazy` logs it with the default logger as well. */
export function eager(entry: LogEntry): () => LogEntry {
  const build = (): LogEntry => entry;
  PREBUILT.add(build);
  return build;
}

/** `Effects.log`: build the entry only when a custom logger is set (or it was built already, `eager`), then
 *  `safeLog`. A builder that throws (a client bug) is reported as an `internal` entry instead. */
export function safeLogLazy(target: LogTarget, build: () => LogEntry): void {
  if (!target.custom && !PREBUILT.has(build)) return;
  let entry: LogEntry;
  try {
    entry = build();
  } catch (error) {
    entry = { level: 'error', event: 'internal', message: 'a log entry could not be built', data: { error } };
  }
  safeLog(target, entry);
}

/** Prints only `level: 'error'` entries with `console.error` (skipped when it is not a function). */
export function defaultLogger(entry: LogEntry): void {
  if (entry.level !== 'error') return;
  const data = entry.data;
  const detail = data === undefined ? [] : data['error'] !== undefined ? [data['error']] : [data];
  consoleError(`thruway.js: ${entry.message}`, ...detail);
}

/** `name: message` of an error-like value, or `String(value)`; never throws (throwing getters, null prototypes). */
export function describeError(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const { name, message } = error as { name?: unknown; message?: unknown };
      if (typeof message === 'string') return typeof name === 'string' && name !== '' ? `${name}: ${message}` : message;
    }
    return String(error);
  } catch {
    return '[unprintable value]';
  }
}

/** `{level: 'error', event: 'unhandled'}` for an app callback that threw or an error nobody handled. Never throws, even
 *  for an error whose `message` getter throws. */
export function unhandledEntry(error: unknown, context: string): LogEntry {
  const text = truncateText(describeError(error), FRAME_PREVIEW_LIMIT);
  return {
    level: 'error',
    event: 'unhandled',
    message: `unhandled error in ${context}: ${text}`,
    data: { error, context },
  };
}

/** The message type name of a type code (`'#99'` for an unknown one). */
function typeName(type: unknown): string {
  for (const name of Object.keys(MessageType) as (keyof typeof MessageType)[]) {
    if (MessageType[name] === type) return name;
  }
  return typeof type === 'number' ? `#${String(type)}` : 'frame';
}

/** `frame.in` / `frame.out` entry: byte length and a redacted preview, never the frame object. */
export function frameEntry(direction: 'in' | 'out', frame: unknown, byteLength: number): LogEntry {
  const view = structured(frame);
  return {
    level: 'debug',
    event: direction === 'in' ? 'frame.in' : 'frame.out',
    message: `${direction === 'in' ? 'received' : 'sent'} ${typeName(view.type)} (${String(byteLength)} bytes)`,
    data: { bytes: byteLength, preview: view.preview },
  };
}

/** The redacted preview (≤ 512 characters) of a frame: an array as (de)serialized, its text or binary data. */
export function framePreview(frame: unknown): string {
  return structured(frame).preview;
}

function structured(frame: unknown): { readonly type: unknown; readonly preview: string } {
  try {
    let value = frame;
    if (typeof frame === 'string') {
      // A text frame is previewed as its JSON array when it parses, so its secrets are redacted like any frame's.
      if (!/^\s*\[/.test(frame)) return { type: undefined, preview: truncateText(frame, FRAME_PREVIEW_LIMIT) };
      try {
        value = JSON.parse(frame) as unknown;
      } catch {
        return { type: undefined, preview: truncateText(frame, FRAME_PREVIEW_LIMIT) };
      }
    }
    if (Array.isArray(value)) {
      const type: unknown = value[0];
      return { type, preview: render(redactFrame(value), FRAME_PREVIEW_LIMIT) };
    }
    if (isBinary(value)) return { type: undefined, preview: binaryText(value) };
    return { type: undefined, preview: `[${value === null ? 'null' : typeof value}]` };
  } catch {
    return { type: undefined, preview: '[unreadable frame]' };
  }
}

function isDict(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function binaryText(value: ArrayBuffer | ArrayBufferView): string {
  return `[binary ${String(value.byteLength)} bytes]`;
}

/** Every value replaced (keys kept, except `keep`'s value); a non-dict value is replaced as a whole. */
function redactValues(value: unknown, keep?: string): unknown {
  if (value === undefined) return undefined;
  if (!isDict(value)) return REDACTED;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) out[key] = key === keep ? value[key] : REDACTED;
  return out;
}

function redactAuthextra(details: unknown): unknown {
  if (!isDict(details) || details['authextra'] === undefined) return details;
  return { ...details, authextra: redactValues(details['authextra'], 'pubkey') };
}

function redactWelcome(details: unknown): unknown {
  const out = redactAuthextra(details);
  const original = isDict(out) ? out['transport'] : undefined;
  if (!isDict(out) || !isDict(original)) return out;
  const transport: Record<string, unknown> = { ...original };
  for (const key of ['headers', 'cookies', 'query_params']) {
    if (transport[key] !== undefined) transport[key] = redactValues(transport[key]);
  }
  return { ...out, transport };
}

/** A copy of `frame` with secrets replaced (see the module doc). */
export function redactFrame(frame: readonly unknown[]): readonly unknown[] {
  const copy = frame.slice();
  const at = (index: number, redact: (value: unknown) => unknown): void => {
    if (index < copy.length) copy[index] = redact(copy[index]);
  };
  switch (frame[0]) {
    case MessageType.HELLO: // [1, Realm, Details]
      at(2, redactAuthextra);
      break;
    case MessageType.WELCOME: // [2, Session, Details]
      at(2, redactWelcome);
      break;
    case MessageType.CHALLENGE: // [4, AuthMethod, Extra]
      at(2, (extra) => redactValues(extra, 'pubkey'));
      break;
    case MessageType.AUTHENTICATE: // [5, Signature, Extra]
      at(1, () => REDACTED);
      break;
    default:
      break;
  }
  return copy;
}

/** JSON-like text of `value`, at most `limit` characters; stops walking once the budget is spent, so the cost does not
 *  depend on the frame's size. Cycles print as `[circular]`, binary data as its length. */
function render(value: unknown, limit: number): string {
  const parts: string[] = [];
  let size = 0;
  const ancestors: object[] = [];
  const put = (text: string): boolean => {
    parts.push(text);
    size += text.length;
    return size <= limit;
  };
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return put(JSON.stringify(v.length > limit ? v.slice(0, limit) : v));
    if (typeof v === 'bigint') return put(`${v.toString()}n`);
    if (typeof v === 'function') return put('[function]');
    if (typeof v !== 'object' || v === null) return put(String(v));
    if (isBinary(v)) return put(binaryText(v));
    if (ancestors.includes(v)) return put('[circular]');
    ancestors.push(v);
    const array = Array.isArray(v);
    let ok = put(array ? '[' : '{');
    if (array) {
      const items = v as readonly unknown[];
      for (let i = 0; ok && i < items.length; i++) ok = (i === 0 || put(',')) && walk(items[i]);
    } else {
      const dict = v as Readonly<Record<string, unknown>>;
      let first = true;
      for (const key of Object.keys(dict)) {
        if (!ok) break;
        ok = (first || put(',')) && put(`${JSON.stringify(key)}:`) && walk(dict[key]);
        first = false;
      }
    }
    ok = ok && put(array ? ']' : '}');
    ancestors.pop();
    return ok;
  };
  walk(value);
  return truncateText(parts.join(''), limit);
}

/** `url` with its query string replaced by `?…`; a fragment by `#…` and user info by `…@` as well. */
export function redactUrl(url: string): string {
  const query = url.indexOf('?');
  const hash = url.indexOf('#');
  const hasQuery = query !== -1 && (hash === -1 || query < hash);
  const cut = hasQuery ? query : hash === -1 ? url.length : hash;
  const base = url.slice(0, cut).replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1…@');
  return `${base}${hasQuery ? '?…' : ''}${hash === -1 ? '' : '#…'}`;
}
