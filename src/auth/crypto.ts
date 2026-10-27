/**
 * WebCrypto access for the auth helpers: PBKDF2, HMAC-SHA256, Ed25519 via PKCS#8
 * (`302e020100300506032b657004220420 ‖ seed`; the derived JWK `x` is compared with the given public key), hex, base64
 * and UTF-8. The WebCrypto types are structural (src has no DOM library); nothing here uses `Buffer`, `TextEncoder` or
 * `btoa`, so the module runs wherever `globalThis.crypto.subtle` exists.
 *
 * Error kinds: `subtle()` throws `AuthenticationError` when WebCrypto is absent, and a WebCrypto operation
 * that fails (for example an engine without Ed25519) rejects with `AuthenticationError` whose `cause` is the platform
 * error; malformed input and a public key that does not belong to the seed are `TypeError`s. Messages never contain
 * key material.
 *
 * @module
 */
import { AuthenticationError } from '../errors.js';

/** The PKCS#8 prefix of a raw 32-byte Ed25519 seed (WAMP-Cryptosign). */
export const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';

/** The slice of a WebCrypto `CryptoKey` the helpers touch. */
export interface CryptoKeyLike {
  readonly type: string;
}

/** The slice of `SubtleCrypto` the helpers use. */
export interface SubtleCryptoLike {
  importKey(
    format: string,
    keyData: Uint8Array | Readonly<Record<string, unknown>>,
    algorithm: string | Readonly<Record<string, unknown>>,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  exportKey(format: 'jwk', key: CryptoKeyLike): Promise<{ readonly x?: string }>;
  sign(
    algorithm: string | Readonly<Record<string, unknown>>,
    key: CryptoKeyLike,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: Readonly<Record<string, unknown>>,
    baseKey: CryptoKeyLike,
    length: number,
  ): Promise<ArrayBuffer>;
}

const ED25519 = { name: 'Ed25519' } as const;
const HMAC_SHA256 = { name: 'HMAC', hash: 'SHA-256' } as const;

/** `globalThis.crypto.subtle`, or throws `AuthenticationError` when WebCrypto is absent (React Native/Hermes). */
export function subtle(): SubtleCryptoLike {
  let found: unknown;
  try {
    found = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
  } catch (error) {
    throw new AuthenticationError({ message: 'WebCrypto is not available (globalThis.crypto threw)', cause: error });
  }
  if (typeof found !== 'object' || found === null) {
    throw new AuthenticationError({ message: 'WebCrypto is not available (globalThis.crypto.subtle is missing)' });
  }
  return found as SubtleCryptoLike;
}

/** Runs one WebCrypto operation; whatever it throws or rejects with becomes the cause of an `AuthenticationError`. */
async function webCrypto<T>(what: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new AuthenticationError({ message: `WebCrypto ${what} failed`, cause: error });
  }
}

/** PBKDF2-HMAC-SHA256(password, salt as UTF-8, iterations, keylen) as base64 text (the salted WAMP-CRA key).
 *  `iterations` and `keylen` (bytes) are positive integers; the caller validates them (auth/index.ts). */
export async function pbkdf2Base64(
  password: string,
  salt: string,
  iterations: number,
  keylen: number,
): Promise<string> {
  const s = subtle();
  const bits = await webCrypto('PBKDF2', async () => {
    const key = await s.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveBits']);
    return s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8Encode(salt), iterations }, key, keylen * 8);
  });
  return bytesToBase64(new Uint8Array(bits));
}

/** base64(HMAC-SHA256(key as UTF-8, message as UTF-8)) — the WAMP-CRA signature. */
export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const s = subtle();
  // WebCrypto refuses a zero-length HMAC key. HMAC zero-pads every key shorter than the block (64 bytes), so the
  // empty key and the one-byte key 0x00 give the same MAC (RFC 2104, section 2).
  const raw = key === '' ? new Uint8Array(1) : utf8Encode(key);
  const mac = await webCrypto('HMAC-SHA256', async () => {
    const hmacKey = await s.importKey('raw', raw, HMAC_SHA256, false, ['sign']);
    return s.sign(HMAC_SHA256, hmacKey, utf8Encode(message));
  });
  return bytesToBase64(new Uint8Array(mac));
}

/** Ed25519 signing with a 32-byte seed: imports the seed once as PKCS#8 and resolves to the
 *  signing function; rejects (TypeError) when the seed's public key (the derived JWK `x`) is not `publicKeyHex`. */
export async function ed25519Sign(
  seed: Uint8Array,
  publicKeyHex: string,
): Promise<(message: Uint8Array) => Promise<Uint8Array>> {
  const publicKey = hexToBytes(publicKeyHex);
  if (seed.length !== 32) throw new TypeError('The Ed25519 private key must be a 32-byte seed');
  if (publicKey.length !== 32) throw new TypeError('The Ed25519 public key must be 32 bytes');
  const s = subtle();
  const der = new Uint8Array(48);
  der.set(hexToBytes(ED25519_PKCS8_PREFIX));
  der.set(seed, 16);
  // Extractable only so that the public half can be read back as the JWK `x`; the key never leaves this closure.
  const key = await webCrypto('Ed25519 key import', () => s.importKey('pkcs8', der, ED25519, true, ['sign']));
  const { x } = await webCrypto('Ed25519 key export', () => s.exportKey('jwk', key));
  if (typeof x !== 'string') {
    throw new AuthenticationError({ message: 'WebCrypto did not export the Ed25519 public key' });
  }
  if (x.replace(/=+$/, '') !== bytesToBase64(publicKey, true)) {
    throw new TypeError('The Ed25519 public key does not belong to the private key');
  }
  return (message) => webCrypto('Ed25519 signing', async () => new Uint8Array(await s.sign(ED25519, key, message)));
}

/** Case-insensitive hex → bytes; throws TypeError on odd length or a non-hex digit. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    // The text is never quoted: it may be a private key.
    throw new TypeError('Expected an even number of hexadecimal digits');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/** Lower-case hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += (byte < 16 ? '0' : '') + byte.toString(16);
  return hex;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 base64 with padding, or base64url without padding (`url`, the JWK encoding). */
export function bytesToBase64(bytes: Uint8Array, url = false): string {
  const alphabet = url ? BASE64URL : BASE64;
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    let chunk = 0;
    for (let j = i; j < i + 3; j++) chunk = (chunk << 8) | (bytes[j] ?? 0);
    const chars = Math.min(bytes.length - i, 3) + 1; // 2, 3 or 4 characters carry 1, 2 or 3 bytes
    for (let c = 0; c < chars; c++) text += alphabet.charAt((chunk >> (18 - 6 * c)) & 63);
    if (!url) text += '='.repeat(4 - chars);
  }
  return text;
}

/** UTF-8 bytes of `text`, like `TextEncoder`: a lone surrogate becomes U+FFFD. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN past the end
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}
