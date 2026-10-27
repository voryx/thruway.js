/**
 * `jsonSerializer`: `wamp.2.json`; binary frames decoded as UTF-8 (`TextDecoder` when present, else the local decoder);
 * a failed `JSON.parse` is retried once with bare NaN/Infinity/-Infinity tokens revived; `{binary: true}` enables the
 * `"\u0000" + base64` convention in args/kwargs (local base64, no `Buffer`/`atob`).
 *
 * Binary convention (the WAMP spec's binary support for JSON): applied to payload values only — the elements from
 * Arguments on of ABORT, ERROR, PUBLISH, EVENT, CALL, RESULT, INVOCATION and YIELD, recursively; object keys, URIs,
 * options and details are untouched. Outbound, every `Uint8Array` (also a Node `Buffer`) and `ArrayBuffer` becomes
 * `"\u0000" + base64` (RFC 4648, standard alphabet, padded); inbound, every string starting with U+0000 whose rest is
 * valid base64 becomes a `Uint8Array` (any other string is left as it is).
 *
 * @module
 */
import { MessageType } from '../protocol/codes.js';
import type { Serializer } from '../types.js';

const PROTOCOL = 'wamp.2.json';
const NUL = '\u0000';

/** JSON (wamp.2.json). `binary: true` enables the WAMP "\u0000"+base64 convention for Uint8Array/ArrayBuffer
 *  values in args/kwargs (both directions). [binary: false]. Bare NaN/Infinity/-Infinity tokens (Python peers via
 *  Crossbar) are accepted as the JS numbers. */
export function jsonSerializer(options?: { readonly binary?: boolean | undefined }): Serializer {
  const binary = options?.binary;
  if (binary !== undefined && typeof binary !== 'boolean') {
    throw new TypeError('jsonSerializer: options.binary must be a boolean');
  }
  const convert = binary === true;
  return Object.freeze({
    protocol: PROTOCOL,
    binary: false, // text frames; `options.binary` is the payload convention, not the frame type
    serialize: (message: readonly unknown[]): string => serialize(message, convert),
    deserialize: (data: string | ArrayBuffer | Uint8Array): unknown => deserialize(data, convert),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// serialize / deserialize
// ---------------------------------------------------------------------------------------------------------------

/** Index of the first payload element (Arguments) of a message type, in either direction. */
function payloadStart(type: unknown): number | undefined {
  switch (type) {
    case MessageType.ABORT:
    case MessageType.RESULT:
    case MessageType.YIELD:
      return 3;
    case MessageType.PUBLISH:
    case MessageType.EVENT:
    case MessageType.CALL:
    case MessageType.INVOCATION:
      return 4;
    case MessageType.ERROR:
      return 5;
    default:
      return undefined;
  }
}

function serialize(message: readonly unknown[], convert: boolean): string {
  const start = convert ? payloadStart(message[0]) : undefined;
  let text: string | undefined;
  if (start === undefined || message.length <= start) {
    text = JSON.stringify(message);
  } else {
    // Header and payload are stringified separately, so the replacer only ever sees payload values.
    const head = JSON.stringify(message.slice(0, start));
    const tail = JSON.stringify(message.slice(start), binaryReplacer);
    text = `${head.slice(0, -1)},${tail.slice(1)}`;
  }
  if (typeof text !== 'string') throw new TypeError('the message cannot be serialized as JSON');
  return text;
}

/** Looks at the original value in its holder: a Node Buffer reaches the replacer already turned into
 *  `{type: 'Buffer', data}` by its own toJSON. Primitives are never binary. */
function binaryReplacer(this: unknown, key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const bytes = binaryBytes((this as Readonly<Record<string, unknown>>)[key]);
  return bytes === undefined ? value : NUL + base64Encode(bytes);
}

function deserialize(data: string | ArrayBuffer | Uint8Array, convert: boolean): unknown {
  const raw: unknown = data;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    const bytes = frameBytes(raw);
    if (bytes === undefined) throw new TypeError('unsupported frame data: expected a string or binary data');
    text = utf8(bytes);
  }
  const value = parse(text);
  if (convert && Array.isArray(value)) reviveBinary(value, payloadStart(value[0]) ?? value.length);
  return value;
}

/** The bytes of a binary WebSocket message: ArrayBuffer or any ArrayBufferView (Uint8Array, Buffer, DataView). */
function frameBytes(data: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return isArrayBuffer(data) ? new Uint8Array(data) : undefined;
}

const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength');

/** A real ArrayBuffer from any realm: its byteLength getter accepts only objects with an [[ArrayBufferData]] slot. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (Object.prototype.toString.call(value) !== '[object ArrayBuffer]') return false;
  try {
    ARRAY_BUFFER_BYTE_LENGTH?.get?.call(value);
    return true;
  } catch {
    return false;
  }
}

/** A payload value sent as binary: a Uint8Array (also a Node Buffer) or an ArrayBuffer, from any realm. */
function binaryBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]') {
    return value as Uint8Array;
  }
  return isArrayBuffer(value) ? new Uint8Array(value) : undefined;
}

/** Every string starting with U+0000 inside `frame[start…]` (arrays and objects, any depth) that holds valid base64
 *  becomes its bytes. Iterative: parsed JSON can be nested deeper than the call stack allows. */
function reviveBinary(frame: unknown[], start: number): void {
  const stack: Record<string, unknown>[] = [];
  const visit = (holder: Record<string, unknown>, key: string): void => {
    const value = holder[key];
    if (typeof value === 'string') {
      const bytes = value.charCodeAt(0) === 0 ? base64Decode(value, 1) : undefined;
      if (bytes !== undefined) holder[key] = bytes;
    } else if (typeof value === 'object' && value !== null) {
      stack.push(value as Record<string, unknown>); // parsed JSON: arrays and plain objects only
    }
  };
  const top = frame as unknown as Record<string, unknown>;
  for (let i = start; i < frame.length; i++) visit(top, String(i));
  for (let holder = stack.pop(); holder !== undefined; holder = stack.pop()) {
    for (const key of Object.keys(holder)) visit(holder, key);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lenient JSON: bare NaN / Infinity / -Infinity (Python peers forwarded by Crossbar)
// ---------------------------------------------------------------------------------------------------------------

/** Stands in for a bare `NaN` while the rewritten text is parsed. A frame that also contains this very string is not
 *  guessed at: it stays undecodable (the reviver counts its hits). */
const NAN_SENTINEL = '\u0000thruway.js:NaN';
const NAN_SENTINEL_JSON = JSON.stringify(NAN_SENTINEL);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const lenient = parseLenient(text);
    if (lenient === undefined) throw error;
    return lenient.value;
  }
}

/** What may stand before a bare value token (`-` for `-Infinity`) and after it, so that only whole tokens are
 *  rewritten: `1Infinity` or `Infinity1` must stay invalid instead of becoming the number `11e999`/`1e9991`. */
const BEFORE_TOKEN = /[\s[,:-]/;
const AFTER_TOKEN = /[\s,\]}]/;

function bareToken(text: string, i: number, token: string): boolean {
  if (!text.startsWith(token, i)) return false;
  const end = i + token.length;
  return (
    (i === 0 || BEFORE_TOKEN.test(text.charAt(i - 1))) && (end === text.length || AFTER_TOKEN.test(text.charAt(end)))
  );
}

/** Rewrites bare `NaN` and `Infinity` tokens outside strings (`Infinity` ⇒ `1e999`, which JSON.parse reads as
 *  Infinity, so `-Infinity` follows; `NaN` ⇒ the sentinel string, revived) and parses again; undefined on failure. */
function parseLenient(text: string): { readonly value: unknown } | undefined {
  const parts: string[] = [];
  let last = 0;
  let nan = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) {
        i++; // a backslash: skip the escaped character
      } else if (c === 0x22) {
        inString = false;
      }
    } else if (c === 0x22) {
      inString = true;
    } else if (bareToken(text, i, 'NaN')) {
      parts.push(text.slice(last, i), NAN_SENTINEL_JSON);
      last = i + 3;
      i += 2;
      nan++;
    } else if (bareToken(text, i, 'Infinity')) {
      parts.push(text.slice(last, i), '1e999');
      last = i + 8;
      i += 7;
    }
  }
  parts.push(text.slice(last));
  let seen = 0;
  try {
    const value: unknown = JSON.parse(parts.join(''), (_key: string, item: unknown): unknown => {
      if (item !== NAN_SENTINEL) return item;
      seen++;
      return NaN;
    });
    return seen === nan ? { value } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// UTF-8 and base64 (no TextDecoder on Hermes; no Buffer/atob)
// ---------------------------------------------------------------------------------------------------------------

interface TextDecoderLike {
  decode(input: Uint8Array): string;
}
type TextDecoderConstructor = new (label: string, options: { readonly fatal: boolean }) => TextDecoderLike;

/** The platform's fatal UTF-8 decoder when there is a usable one, else the local decoder (same results). */
function utf8(bytes: Uint8Array): string {
  const ctor = (globalThis as { TextDecoder?: unknown }).TextDecoder;
  let decoder: TextDecoderLike | undefined;
  try {
    decoder = new (ctor as TextDecoderConstructor)('utf-8', { fatal: true });
  } catch {
    // no TextDecoder (Hermes), or an unusable one
  }
  return decoder === undefined ? decodeUtf8(bytes) : decoder.decode(bytes);
}

/** Collects UTF-16 code units and turns them into a string in chunks (bounded `fromCharCode` argument lists). */
class TextBuilder {
  private readonly parts: string[] = [];
  private units: number[] = [];
  push(unit: number): void {
    this.units.push(unit);
    if (this.units.length >= 8192) this.flush();
  }
  toString(): string {
    this.flush();
    return this.parts.join('');
  }
  private flush(): void {
    this.parts.push(String.fromCharCode.apply(null, this.units));
    this.units = [];
  }
}

/** @internal UTF-8 → string without `TextDecoder` (Hermes); throws on invalid UTF-8 (the frame is then fatal).
 *  Behaves like `new TextDecoder('utf-8', {fatal: true}).decode(bytes)` (the WHATWG UTF-8 decoder): a leading BOM is
 *  removed; overlong forms, surrogates, code points above U+10FFFF, stray continuation bytes and truncated sequences
 *  throw `TypeError`. */
export function decodeUtf8(bytes: Uint8Array): string {
  const out = new TextBuilder();
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let needed = 0; // continuation bytes still to come
  let code = 0;
  let lower = 0x80; // the range the next continuation byte must be in
  let upper = 0xbf;
  for (const byte of bom ? bytes.subarray(3) : bytes) {
    if (needed === 0) {
      if (byte < 0x80) {
        out.push(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        code = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        needed = 2;
        code = byte & 0x0f;
        if (byte === 0xe0) lower = 0xa0; // no overlong forms
        if (byte === 0xed) upper = 0x9f; // no surrogates
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        needed = 3;
        code = byte & 0x07;
        if (byte === 0xf0) lower = 0x90; // no overlong forms
        if (byte === 0xf4) upper = 0x8f; // nothing above U+10FFFF
      } else {
        throw new TypeError('invalid UTF-8 data');
      }
      continue;
    }
    if (byte < lower || byte > upper) throw new TypeError('invalid UTF-8 data');
    lower = 0x80;
    upper = 0xbf;
    code = (code << 6) | (byte & 0x3f);
    needed--;
    if (needed > 0) continue;
    if (code < 0x10000) {
      out.push(code);
    } else {
      out.push(0xd800 | ((code - 0x10000) >> 10));
      out.push(0xdc00 | (code & 0x3ff));
    }
  }
  if (needed > 0) throw new TypeError('invalid UTF-8 data: truncated sequence');
  return out.toString();
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** @internal RFC 4648 base64, standard alphabet, with padding. */
export function base64Encode(bytes: Uint8Array): string {
  const out = new TextBuilder();
  let bits = 0;
  let count = 0; // bits in `bits` not yet written
  for (const byte of bytes) {
    bits = ((bits << 8) | byte) & 0xffff;
    count += 8;
    while (count >= 6) {
      count -= 6;
      out.push(ALPHABET.charCodeAt((bits >> count) & 0x3f));
    }
  }
  if (count > 0) out.push(ALPHABET.charCodeAt((bits << (6 - count)) & 0x3f));
  for (let pad = (3 - (bytes.length % 3)) % 3; pad > 0; pad--) out.push(0x3d);
  return out.toString();
}

/** @internal The bytes of the base64 text `text.slice(start)`, or undefined when it is not valid base64 (standard
 *  alphabet; padding optional, but when present it must complete the last group). */
export function base64Decode(text: string, start = 0): Uint8Array | undefined {
  const end = text.length - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  const length = end - start;
  if (length % 4 === 1) return undefined;
  if (end < text.length && (text.length - start) % 4 !== 0) return undefined;
  const out = new Uint8Array((length >> 2) * 3 + (length % 4 === 0 ? 0 : (length % 4) - 1));
  let bits = 0;
  let count = 0;
  let o = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    const d = DIGITS[c] ?? -1;
    if (d < 0) return undefined;
    bits = ((bits << 6) | d) & 0xffffff;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[o++] = (bits >> count) & 0xff;
    }
  }
  return out;
}
