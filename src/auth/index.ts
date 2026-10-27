/**
 * Public entry "thruway.js/auth": `ticket`, `wampcra`, `cryptosign`. Each offers exactly one method (what works best on
 * Thruway PHP, which sends one CHALLENGE per matching method) and answers only CHALLENGEs for that method. `wampcra`
 * and the seed form of `cryptosign` need WebCrypto; without it they fail the handshake with `AuthenticationError` (then
 * backoff).
 *
 * Failure kinds: invalid helper arguments throw `TypeError` at creation; at handshake time the returned
 * `onChallenge` rejects with `TypeError` for a malformed CHALLENGE (or a signer result that is not a signature), with
 * `AuthenticationError` for a CHALLENGE of another method, an unsupported channel binding or missing WebCrypto, and
 * with the app's own error when its secret/ticket function or signer fails. The core turns each into
 * `AuthenticationError{cause}` in `CloseInfo`. No message contains a secret.
 *
 * @module
 */
import { AuthenticationError } from '../errors.js';
import { firstValue } from '../observable/input.js';
import type { UnhandledReporter } from '../observable/observable.js';
import { REPORTER } from '../ops/challenge.js';
import type { ChallengeMessage, ClientOptions, Input } from '../types.js';
import { bytesToHex, ed25519Sign, hexToBytes, hmacSha256Base64, pbkdf2Base64, subtle } from './crypto.js';

export type AuthOptions = Required<Pick<ClientOptions, 'authmethods' | 'onChallenge'>> &
  Pick<ClientOptions, 'authid' | 'authextra'>;

/** Upper bounds for the router-chosen PBKDF2 cost (Thruway, Crossbar, Nexus: 1000 × 32; Bondy: 4096 × 32), so a
 *  hostile CHALLENGE cannot pin a CPU core: the handshake timer does not run while `onChallenge` is pending. */
const MAX_ITERATIONS = 10000000;
const MAX_KEYLEN = 256;

/** authmethods ['ticket']; answers the ticket verbatim (function form re-reads it per handshake). */
export function ticket(authid: string, ticket: string | (() => Input<string>)): AuthOptions {
  checkCredential('ticket', authid, ticket, 'ticket');
  return options('ticket', authid, undefined, ({ authMethod }) => {
    expectMethod('ticket', authMethod);
    return typeof ticket === 'function' ? ticket() : ticket;
  });
}

/** authmethods ['wampcra']; signs the exact challenge string; salted keys when extra.salt is present
 *  (PBKDF2-HMAC-SHA256, salt as UTF-8 text, iterations ?? 1000, keylen ?? 32 (0 also means the default),
 *  base64 text = HMAC key). WebCrypto. */
export function wampcra(authid: string, secret: string | (() => Input<string>)): AuthOptions {
  checkCredential('wampcra', authid, secret, 'secret');
  return options('wampcra', authid, undefined, async (message) => {
    const { authMethod, extra } = message;
    expectMethod('wampcra', authMethod);
    const challenge = extra['challenge'];
    if (typeof challenge !== 'string') throw new TypeError('wampcra: the CHALLENGE has no challenge string');
    const salted = saltOf(extra); // validated before the secret is read
    subtle(); // and WebCrypto checked: never ask the app for a secret that cannot be used
    const password: unknown =
      typeof secret === 'function' ? await first(secret, message, 'wampcra: the secret') : secret;
    if (typeof password !== 'string') throw new TypeError('wampcra: the secret must be a string');
    const key =
      salted === undefined ? password : await pbkdf2Base64(password, salted.salt, salted.iterations, salted.keylen);
    return hmacSha256Base64(key, challenge);
  });
}

/** authmethods ['cryptosign'], authextra {pubkey}; answers hex(signature64 ‖ challenge32) (192 hex chars).
 *  Challenge hex decoded case-insensitively (Bondy sends uppercase) and must be 32 bytes. channel_binding
 *  unsupported (null). Throws TypeError at creation for a malformed key. Seed form: the check that `publicKey`
 *  belongs to `privateKey` starts at creation, but WebCrypto is asynchronous, so a mismatch fails each handshake with
 *  that TypeError (the `cause` of the AuthenticationError in CloseInfo) instead of throwing here. */
export function cryptosign(
  key:
    | { readonly authid?: string | undefined; readonly publicKey: string; readonly privateKey: string } // hex, 32-byte seed
    | {
        readonly authid?: string | undefined;
        readonly publicKey: string;
        sign(message: Uint8Array): Input<Uint8Array>;
      },
): AuthOptions {
  const raw: unknown = key; // JavaScript callers: check everything
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('cryptosign: expected {publicKey, privateKey} or {publicKey, sign}');
  }
  const { authid, publicKey, privateKey, sign } = raw as Readonly<Record<string, unknown>>;
  if (authid !== undefined && typeof authid !== 'string') throw new TypeError('cryptosign: authid must be a string');
  const pubkey = bytesToHex(hex32(publicKey, 'cryptosign: publicKey'));
  if ((privateKey === undefined) === (sign === undefined)) {
    throw new TypeError('cryptosign: pass exactly one of privateKey and sign');
  }
  let signer: Signer;
  if (sign === undefined) signer = seedSigner(hex32(privateKey, 'cryptosign: privateKey'), pubkey);
  else if (typeof sign === 'function') signer = appSigner(raw, sign as (message: Uint8Array) => Input<Uint8Array>);
  else throw new TypeError('cryptosign: sign must be a function');
  return options('cryptosign', authid, { pubkey }, async (message) => {
    const { authMethod, extra } = message;
    expectMethod('cryptosign', authMethod);
    const binding = extra['channel_binding'];
    if (binding !== undefined && binding !== null) {
      throw new AuthenticationError({ message: 'cryptosign: channel binding is not supported', authMethod });
    }
    const challenge = hex32(extra['challenge'], 'cryptosign: the CHALLENGE challenge');
    const tail = bytesToHex(challenge);
    return bytesToHex(await signer(challenge, message)) + tail;
  });
}

type Signer = (challenge: Uint8Array, message: ChallengeMessage) => Promise<Uint8Array>;
type Sign = (message: Uint8Array) => Promise<Uint8Array>;

/** Imports the seed (and compares the public key) once, starting now; a failed import (WebCrypto missing, key
 *  mismatch) is retried by the next handshake. The rejection is always handled here, so a helper that never sees a
 *  CHALLENGE cannot cause an unhandled rejection. */
function seedSigner(seed: Uint8Array, publicKeyHex: string): Signer {
  let loading: Promise<Sign> | undefined;
  const load = (): Promise<Sign> => {
    if (loading === undefined) {
      const attempt = ed25519Sign(seed, publicKeyHex);
      loading = attempt;
      attempt.then(undefined, () => {
        loading = undefined;
      });
    }
    return loading;
  };
  void load();
  return async (challenge) => (await load())(challenge);
}

/** The app's signer (React Native, hardware keys): called with `this` = the key object; must give 64 bytes. */
function appSigner(key: object, sign: (message: Uint8Array) => Input<Uint8Array>): Signer {
  return async (challenge, message) => {
    const bytes = bytesOf(await first(() => sign.call(key, challenge), message, 'cryptosign: sign()'));
    if (bytes?.length !== 64) {
      throw new TypeError('cryptosign: sign() must give the 64-byte (detached) Ed25519 signature as a Uint8Array');
    }
    return bytes;
  };
}

/** The bytes of a typed array or an ArrayBuffer (`crypto.subtle.sign` gives one) of any realm (jsdom, iframes). */
function bytesOf(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value as ArrayBuffer);
  return undefined;
}

/** The first value of the Input that `read` returns, as a Promise. When the handshake is abandoned (the message's
 *  `signal`), the Input is unsubscribed (a login dialog behind it can close) and the Promise rejects with the signal's
 *  reason. What goes wrong in the Input after that (a throwing teardown, say) goes to the client's reporter. */
function first<T>(read: () => Input<T>, message: ChallengeMessage, what: string): Promise<T> {
  const signal = message.signal as ChallengeMessage['signal'] | undefined; // JavaScript callers may omit it
  const reporter = reporterOf(message);
  return new Promise<T>((resolve, reject) => {
    let cancel = (): void => undefined;
    const fail = (error: unknown): void => {
      signal?.removeEventListener('abort', onAbort);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- app errors pass through unchanged
      reject(error);
    };
    const onAbort = (): void => {
      fail(signal?.reason);
      try {
        cancel();
      } catch {
        // The app's teardown threw. This runs inside the signal's dispatch, where a throw would be an uncaught
        // exception (Node's EventTarget rethrows listener errors), and the handshake is over: nothing to report to.
      }
    };
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) {
      fail(signal?.reason);
      return;
    }
    const input = read(); // a throw rejects
    if (aborted()) {
      fail(signal?.reason); // `read` itself aborted the signal: the listener would never fire; never subscribed
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    cancel = firstValue(
      input,
      (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      fail,
      () => {
        fail(new TypeError(`${what} completed without a value`));
      },
      reporter,
    );
    if (aborted()) cancel(); // aborted while subscribing, before `cancel` existed
  });
}

/** The client's reporter, which the challenge runner puts on each ChallengeMessage; undefined for a
 *  message the app made itself (then `firstValue` reports to `console.error`, like any client-less conversion). */
function reporterOf(message: ChallengeMessage): UnhandledReporter | undefined {
  try {
    const reporter = (message as unknown as Readonly<Record<symbol, unknown>>)[REPORTER];
    return typeof reporter === 'function' ? (reporter as UnhandledReporter) : undefined;
  } catch {
    return undefined; // a hostile message object (a Proxy) from an app's own onChallenge wrapper
  }
}

function options(
  method: string,
  authid: string | undefined,
  authextra: Readonly<Record<string, unknown>> | undefined,
  onChallenge: (challenge: ChallengeMessage) => Input<string>,
): AuthOptions {
  return Object.freeze({
    authmethods: Object.freeze([method]),
    onChallenge,
    ...(authid === undefined ? {} : { authid }),
    ...(authextra === undefined ? {} : { authextra: Object.freeze(authextra) }),
  });
}

function checkCredential(helper: string, authid: unknown, credential: unknown, name: string): void {
  if (typeof authid !== 'string') throw new TypeError(`${helper}: authid must be a string`);
  if (typeof credential !== 'string' && typeof credential !== 'function') {
    throw new TypeError(`${helper}: ${name} must be a string or a function`);
  }
}

/** A helper answers only its own method, so a spread-and-extended `authmethods` cannot send a credential (a ticket
 *  in clear text, say) in answer to a CHALLENGE for another method. */
function expectMethod(method: string, authMethod: string): void {
  if (authMethod !== method) {
    throw new AuthenticationError({ message: `The ${method} helper cannot answer this CHALLENGE`, authMethod });
  }
}

/** 64 hex digits (any case) → 32 bytes; TypeError otherwise (the value is never quoted: it may be a private key). */
function hex32(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]*$/i.test(value)) {
    throw new TypeError(`${what} must be 64 hexadecimal digits (32 bytes)`);
  }
  return hexToBytes(value);
}

/** The salt, iterations and keylen of a salted WAMP-CRA CHALLENGE; undefined when unsalted (salt absent or null). */
function saltOf(
  extra: Readonly<Record<string, unknown>>,
): { readonly salt: string; readonly iterations: number; readonly keylen: number } | undefined {
  const salt = extra['salt'];
  if (salt === undefined || salt === null) return undefined;
  if (typeof salt !== 'string') throw new TypeError('wampcra: the CHALLENGE salt must be a string');
  return {
    salt,
    iterations: count(extra['iterations'], 1000, MAX_ITERATIONS, 'iterations'),
    keylen: count(extra['keylen'], 32, MAX_KEYLEN, 'keylen'),
  };
}

/** `iterations`/`keylen`: absent, `null` or 0 means the default, as in autobahn-js (`|| 1000`) and the Nexus client;
 *  0 could never work, and a Nexus keystore that leaves them unset sends 0. */
function count(value: unknown, fallback: number, max: number, name: string): number {
  const n = value === undefined || value === null || value === 0 ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError(`wampcra: the CHALLENGE ${name} must be an integer from 1 to ${String(max)}`);
  }
  return n;
}
