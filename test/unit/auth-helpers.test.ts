// The auth helpers and their crypto layer: hex/base64/UTF-8 and the three WebCrypto operations against node:crypto
// (property tests), the shape of each helper's AuthOptions, and every failure kind — invalid helper arguments
// (TypeError at creation), malformed CHALLENGEs (TypeError), CHALLENGEs for another method and unsupported channel
// binding (AuthenticationError), missing or failing WebCrypto (AuthenticationError with the platform error as cause),
// app secret/signer failures and throwing conversions (passed through unchanged), abandoned handshakes (the signal's
// reason). The published vectors are in auth-vectors.test.ts.
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  pbkdf2Sync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';
import vm from 'node:vm';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  bytesToBase64,
  bytesToHex,
  ED25519_PKCS8_PREFIX,
  ed25519Sign,
  hexToBytes,
  hmacSha256Base64,
  pbkdf2Base64,
  subtle,
  utf8Encode,
  type SubtleCryptoLike,
} from '../../src/auth/crypto.js';
import { cryptosign, ticket, wampcra, type AuthOptions } from '../../src/auth/index.js';
import { AuthenticationError, CanceledError, ConnectionLostError, isThruwayError } from '../../src/errors.js';
import { Client } from '../../src/client.js';
import type { ChallengeMessage, LogEntry } from '../../src/types.js';
import { createHarness } from '../helpers/harness.js';
import { replayParameters } from '../setup-fast-check.js';

const CRYPTO = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
const REAL_SUBTLE = globalThis.crypto.subtle;

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', CRYPTO);
  vi.restoreAllMocks();
});

/** Replaces `globalThis.crypto` until the end of the test. */
function setCrypto(descriptor: PropertyDescriptor): void {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, ...descriptor });
}

/** A WebCrypto whose operations are the real ones unless overridden (failure injection). */
function setSubtle(overrides: Partial<Record<keyof SubtleCryptoLike, (...args: never[]) => unknown>>): void {
  const real = REAL_SUBTLE as unknown as Record<string, (...args: unknown[]) => unknown>;
  const bound = (name: keyof SubtleCryptoLike) => overrides[name] ?? real[name]!.bind(REAL_SUBTLE);
  const fake = {
    importKey: bound('importKey'),
    exportKey: bound('exportKey'),
    sign: bound('sign'),
    deriveBits: bound('deriveBits'),
  };
  setCrypto({ value: { subtle: fake } });
}

function message(authMethod: string, extra: Record<string, unknown>, signal?: AbortSignal): ChallengeMessage {
  return { authMethod, extra, signal: signal ?? new AbortController().signal };
}

function challenge(options: AuthOptions, msg: ChallengeMessage): unknown {
  return options.onChallenge!(msg);
}

async function rejection(value: unknown): Promise<unknown> {
  expect(value).toBeInstanceOf(Promise);
  return (value as Promise<unknown>).then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

function expectAuthenticationError(error: unknown, authMethod?: string): void {
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(isThruwayError(error)).toBe(true);
  expect((error as { code: string }).code).toBe('authentication');
  if (authMethod !== undefined) expect((error as { authMethod?: string }).authMethod).toBe(authMethod);
}

/** Strings of arbitrary UTF-16 code units (lone surrogates included) and of arbitrary code points. */
const anyText = fc.oneof(
  fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 }).map((units) => String.fromCharCode(...units)),
  fc.string({ unit: 'binary', maxLength: 40 }),
);

const seedArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
/** WebCrypto properties take up to 0.3 ms a run (ed25519 at 20 000 runs: 5.4 s): their describes' timeout scales with
 *  FC_NUM_RUNS (1 ms a run, at least the default 5 s), so a deeper run of 20 000 does not time out. */
const CRYPTO_TIMEOUT = { timeout: Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100)) };

function nodeKeys(seed: Uint8Array): { key: KeyObject; publicKeyHex: string } {
  const der = Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  return { key, publicKeyHex: Buffer.from(x!, 'base64url').toString('hex') };
}

function nodeCra(secret: string, text: string, salt?: { salt: string; iterations: number; keylen: number }): string {
  const key =
    salt === undefined
      ? Buffer.from(secret, 'utf8')
      : Buffer.from(
          pbkdf2Sync(secret, Buffer.from(salt.salt, 'utf8'), salt.iterations, salt.keylen, 'sha256').toString('base64'),
        );
  return createHmac('sha256', key).update(Buffer.from(text, 'utf8')).digest('base64');
}

const SEED = '4d57d97a68f555696620a6d849c0ce582568518d729eb753dc7c732de2804510';
const PUBLIC_KEY = '1adfc8bfe1d35616e64dffbd900096f23b066f914c8c2ffbb66f6075b96e116d';
const OTHER_PUBLIC_KEY = '6ed32739ff04a6074044ff0b0e3bfc7c856bc9d5f1d25efc57363bda0af3a8b0';
const CHALLENGE_HEX = 'b26c1f87c13fc1da14997f1b5a71995dff8fbe0a62fae8473c7bdbd05bfb607d';
const CRA_CHALLENGE = '{"authid":"peter","nonce":"N","timestamp":"2026-10-25T20:20:38+0000","session":1}';

/** A subscribe-object Input (RxJS 9 / platform Observable shape) that records its subscriptions. */
function controllable<T>(): {
  input: { subscribe(observer: { next(v: T): void; error(e: unknown): void; complete(): void }): unknown };
  emit(value: T): void;
  unsubscribed: number;
  subscribed: number;
} {
  let observer: { next(v: T): void } | undefined;
  const state = {
    unsubscribed: 0,
    subscribed: 0,
    input: {
      subscribe(o: { next(v: T): void; error(e: unknown): void; complete(): void }) {
        state.subscribed++;
        observer = o;
        return {
          unsubscribe() {
            state.unsubscribed++;
          },
        };
      },
    },
    emit(value: T) {
      observer?.next(value);
    },
  };
  return state;
}

// ------------------------------------------------------------------------------------------------ hex / base64
describe('hex', () => {
  test('bytesToHex is lower-case hex and hexToBytes inverts it in any letter case (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), fc.array(fc.boolean(), { maxLength: 160 }), (bytes, upper) => {
        const hex = bytesToHex(bytes);
        expect(hex).toBe(Buffer.from(bytes).toString('hex'));
        const mixed = hex.replace(/[a-f]/g, (c, i: number) => (upper[i] === true ? c.toUpperCase() : c));
        expect(hexToBytes(mixed)).toEqual(bytes);
      }),
      replayParameters(),
    );
  });

  test.each(['', '00', 'ff', 'FF', 'aB09', '0123456789abcdefABCDEF00'])('accepts %j', (hex) => {
    expect(bytesToHex(hexToBytes(hex))).toBe(hex.toLowerCase());
  });

  test.each(['0', 'abc', 'zz', '0x12', ' 12', '12 ', '+1', '-1', '1g', 'gg', '١٢', '\u0000\u0000'])(
    'rejects %j with TypeError',
    (hex) => {
      expect(() => hexToBytes(hex)).toThrow(TypeError);
    },
  );

  test.each([undefined, null, 12, ['12'], { toString: () => '12' }])('rejects the non-string %j', (value) => {
    expect(() => hexToBytes(value as string)).toThrow(TypeError);
  });

  test('the error never quotes the text, which may be a private key (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.nat(63),
        fc.constantFrom('g', 'x', ' ', 'é', ''),
        (bytes, at, bad) => {
          const hex = bytesToHex(bytes);
          const broken = hex.slice(0, at) + bad + hex.slice(at + 1);
          let error: unknown;
          try {
            hexToBytes(broken);
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(TypeError);
          expect((error as Error).message).not.toContain(broken.slice(0, 16));
        },
      ),
      replayParameters(),
    );
  });
});

describe('base64', () => {
  test('bytesToBase64 matches RFC 4648 base64 and unpadded base64url (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
        expect(bytesToBase64(bytes, true)).toBe(Buffer.from(bytes).toString('base64url'));
      }),
      replayParameters(),
    );
  });

  test.each([
    [[], ''],
    [[0xff], '/w=='],
    [[0xff, 0xfe], '//4='],
    [[0xfb, 0xff, 0xbf], '+/+/'],
  ])('%j → %j', (bytes, text) => {
    expect(bytesToBase64(Uint8Array.from(bytes))).toBe(text);
  });
});

describe('utf8Encode', () => {
  test('matches TextEncoder and Buffer, lone surrogates included (property)', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(anyText, (text) => {
        const bytes = utf8Encode(text);
        expect(bytes).toEqual(encoder.encode(text));
        expect(Buffer.from(bytes).equals(Buffer.from(text, 'utf8'))).toBe(true);
      }),
      replayParameters(),
    );
  });

  test.each([
    ['', ''],
    ['a', '61'],
    ['é', 'c3a9'],
    ['€', 'e282ac'],
    ['\u{1f600}', 'f09f9880'],
    ['\ud800', 'efbfbd'],
    ['\udc00a', 'efbfbd61'],
    ['a\ud83d', '61efbfbd'],
    ['\ud83d😀', 'efbfbdf09f9880'],
  ])('%j → %s', (text, hex) => {
    expect(bytesToHex(utf8Encode(text))).toBe(hex);
  });
});

// ------------------------------------------------------------------------------------------------------ subtle()
describe('subtle()', () => {
  test('is globalThis.crypto.subtle', () => {
    expect(subtle()).toBe(globalThis.crypto.subtle);
  });

  test.each([
    ['crypto is undefined', { value: undefined }],
    ['crypto has no subtle', { value: {} }],
    ['subtle is null', { value: { subtle: null } }],
    ['subtle is not an object', { value: { subtle: 'subtle' } }],
  ])('AuthenticationError when %s (React Native, Hermes)', (_name, descriptor) => {
    setCrypto(descriptor);
    let error: unknown;
    try {
      subtle();
    } catch (e) {
      error = e;
    }
    expectAuthenticationError(error);
    expect((error as Error).message).toMatch(/WebCrypto/);
  });

  test('AuthenticationError with the cause when reading globalThis.crypto throws', () => {
    const boom = new Error('boom');
    setCrypto({
      get() {
        throw boom;
      },
    });
    let error: unknown;
    try {
      subtle();
    } catch (e) {
      error = e;
    }
    expectAuthenticationError(error);
    expect((error as { cause?: unknown }).cause).toBe(boom);
  });
});

// ------------------------------------------------------------------------------------- PBKDF2 and HMAC-SHA256
describe('pbkdf2Base64 and hmacSha256Base64', CRYPTO_TIMEOUT, () => {
  test('HMAC-SHA256 over UTF-8 key and message equals node:crypto, empty key included (property)', async () => {
    await fc.assert(
      fc.asyncProperty(anyText, anyText, async (key, text) => {
        const expected = createHmac('sha256', Buffer.from(key, 'utf8'))
          .update(Buffer.from(text, 'utf8'))
          .digest('base64');
        expect(await hmacSha256Base64(key, text)).toBe(expected);
      }),
      replayParameters(),
    );
  });

  test('the empty HMAC key (which WebCrypto refuses to import) gives the RFC 2104 result', async () => {
    await expect(hmacSha256Base64('', 'msg')).resolves.toBe(createHmac('sha256', '').update('msg').digest('base64'));
  });

  test('PBKDF2-HMAC-SHA256 with the salt as UTF-8 text equals node:crypto (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyText,
        anyText,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 96 }),
        async (password, salt, iterations, keylen) => {
          const expected = pbkdf2Sync(
            Buffer.from(password, 'utf8'),
            Buffer.from(salt, 'utf8'),
            iterations,
            keylen,
            'sha256',
          ).toString('base64');
          expect(await pbkdf2Base64(password, salt, iterations, keylen)).toBe(expected);
        },
      ),
      replayParameters(),
    );
  });

  test('without WebCrypto both reject (never throw) with AuthenticationError', async () => {
    setCrypto({ value: undefined });
    let pbkdf2: unknown;
    let hmac: unknown;
    expect(() => {
      pbkdf2 = pbkdf2Base64('a', 'b', 1, 32);
      hmac = hmacSha256Base64('a', 'b');
    }).not.toThrow();
    expectAuthenticationError(await rejection(pbkdf2));
    expectAuthenticationError(await rejection(hmac));
  });

  const operations = {
    pbkdf2: () => pbkdf2Base64('a', 'b', 1, 32),
    hmac: () => hmacSha256Base64('a', 'b'),
  };
  test.each([
    ['importKey rejects', { importKey: () => Promise.reject(new Error('platform')) }, ['pbkdf2', 'hmac']],
    ['deriveBits rejects', { deriveBits: () => Promise.reject(new Error('platform')) }, ['pbkdf2']],
    ['sign rejects', { sign: () => Promise.reject(new Error('platform')) }, ['hmac']],
    [
      'importKey throws synchronously',
      {
        importKey: () => {
          throw new Error('platform');
        },
      },
      ['pbkdf2', 'hmac'],
    ],
  ] as const)('%s: AuthenticationError whose cause is the platform error', async (_name, overrides, affected) => {
    setSubtle(overrides);
    for (const name of affected) {
      const error = await rejection(operations[name]());
      expectAuthenticationError(error);
      expect(((error as { cause?: unknown }).cause as Error).message).toBe('platform');
    }
  });
});

// -------------------------------------------------------------------------------------------------- ed25519Sign
describe('ed25519Sign', CRYPTO_TIMEOUT, () => {
  test('signs like node:crypto for any seed and message, and the signature verifies (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.array(fc.uint8Array({ maxLength: 64 }), { minLength: 1, maxLength: 3 }),
        async (s, ms) => {
          const { key, publicKeyHex } = nodeKeys(s);
          const sign = await ed25519Sign(s, publicKeyHex);
          for (const m of ms) {
            const signature = await sign(m);
            expect(signature).toBeInstanceOf(Uint8Array);
            expect(Buffer.from(signature).equals(nodeSign(null, m, key))).toBe(true);
            expect(nodeVerify(null, m, createPublicKey(key), signature)).toBe(true);
          }
        },
      ),
      replayParameters(),
    );
  });

  test('a public key of another seed: TypeError (property)', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, seedArb, async (a, b) => {
        fc.pre(Buffer.compare(a, b) !== 0);
        const error = await rejection(ed25519Sign(a, nodeKeys(b).publicKeyHex));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).not.toContain(bytesToHex(a));
      }),
      replayParameters(),
    );
  });

  test('the public key is compared case-insensitively', async () => {
    await expect(ed25519Sign(hexToBytes(SEED), PUBLIC_KEY.toUpperCase())).resolves.toBeTypeOf('function');
  });

  test.each([
    ['a 31-byte seed', new Uint8Array(31), PUBLIC_KEY],
    ['a 33-byte seed', new Uint8Array(33), PUBLIC_KEY],
    ['an empty seed', new Uint8Array(0), PUBLIC_KEY],
    ['a 31-byte public key', hexToBytes(SEED), PUBLIC_KEY.slice(2)],
    ['a 33-byte public key', hexToBytes(SEED), `${PUBLIC_KEY}00`],
    ['a public key with a non-hex digit', hexToBytes(SEED), `${PUBLIC_KEY.slice(1)}g`],
    ['an odd-length public key', hexToBytes(SEED), PUBLIC_KEY.slice(1)],
  ])('%s: rejects (never throws) with TypeError', async (_name, seed, publicKey) => {
    let pending: unknown;
    expect(() => (pending = ed25519Sign(seed, publicKey))).not.toThrow();
    expect(await rejection(pending)).toBeInstanceOf(TypeError);
  });

  test('without WebCrypto: AuthenticationError', async () => {
    setCrypto({ value: undefined });
    expectAuthenticationError(await rejection(ed25519Sign(hexToBytes(SEED), PUBLIC_KEY)));
  });

  test('an engine without Ed25519 (importKey NotSupportedError): AuthenticationError with the cause', async () => {
    const platform = new DOMException('Unrecognized algorithm name', 'NotSupportedError');
    setSubtle({ importKey: () => Promise.reject(platform) });
    const error = await rejection(ed25519Sign(hexToBytes(SEED), PUBLIC_KEY));
    expectAuthenticationError(error);
    expect((error as { cause?: unknown }).cause).toBe(platform);
  });

  test.each([
    ['exportKey rejects', { exportKey: () => Promise.reject(new Error('platform')) }],
    ['exportKey gives no x', { exportKey: () => Promise.resolve({ kty: 'OKP' }) }],
    ['exportKey gives a non-string x', { exportKey: () => Promise.resolve({ x: 42 }) }],
  ])('%s: AuthenticationError (not a key mismatch)', async (_name, o) => {
    setSubtle(o);
    expectAuthenticationError(await rejection(ed25519Sign(hexToBytes(SEED), PUBLIC_KEY)));
  });

  test('a padded JWK x is accepted', async () => {
    setSubtle({
      exportKey: async (format: string, key: CryptoKey) => {
        const jwk = await REAL_SUBTLE.exportKey(format as 'jwk', key);
        return { ...jwk, x: `${jwk.x!}=` };
      },
    });
    await expect(ed25519Sign(hexToBytes(SEED), PUBLIC_KEY)).resolves.toBeTypeOf('function');
  });

  test('a failing sign: AuthenticationError with the cause', async () => {
    const platform = new Error('platform');
    setSubtle({ sign: () => Promise.reject(platform) });
    const sign = await ed25519Sign(hexToBytes(SEED), PUBLIC_KEY);
    const error = await rejection(sign(new Uint8Array(32)));
    expectAuthenticationError(error);
    expect((error as { cause?: unknown }).cause).toBe(platform);
  });
});

// ------------------------------------------------------------------------------------------------------- ticket
describe('ticket()', () => {
  test('AuthOptions: one method, the authid, frozen', () => {
    const options = ticket('joe', 'secret!!!');
    expect(Object.keys(options).sort()).toEqual(['authid', 'authmethods', 'onChallenge']);
    expect(options.authmethods).toEqual(['ticket']);
    expect(options.authid).toBe('joe');
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.authmethods)).toBe(true);
  });

  test.each(['secret!!!', '', 'ünïcødé \u{1f600}'])('answers %j verbatim', (value) => {
    expect(challenge(ticket('joe', value), message('ticket', {}))).toBe(value);
  });

  test('Thruway PHP CHALLENGE extra ({challenge: {}, challenge_method}) is ignored', () => {
    const extra = { challenge: {}, challenge_method: 'ticket' };
    expect(challenge(ticket('ticketuser', 'ticketsecret'), message('ticket', extra))).toBe('ticketsecret');
  });

  test('function form: re-read on every CHALLENGE, its Input returned as is', () => {
    const results = ['t1', Promise.resolve('t2'), controllable<string>().input];
    let calls = 0;
    const options = ticket('joe', () => results[calls++]!);
    for (const expected of results) expect(challenge(options, message('ticket', {}))).toBe(expected);
    expect(calls).toBe(3);
  });

  test('a throwing ticket function: the same error is thrown to the runner', () => {
    const boom = new Error('token store unavailable');
    const options = ticket('joe', () => {
      throw boom;
    });
    expect(() => challenge(options, message('ticket', {}))).toThrow(boom);
  });

  test('a CHALLENGE for another method: AuthenticationError, the ticket is not read or quoted', () => {
    const read = vi.fn(() => 'secret!!!');
    const options = ticket('joe', read);
    let error: unknown;
    try {
      challenge(options, message('wampcra', { challenge: CRA_CHALLENGE }));
    } catch (e) {
      error = e;
    }
    expectAuthenticationError(error, 'wampcra');
    expect((error as Error).message).not.toContain('secret');
    expect(read).not.toHaveBeenCalled();
  });

  test('needs no WebCrypto', () => {
    setCrypto({ value: undefined });
    expect(challenge(ticket('joe', 'x'), message('ticket', {}))).toBe('x');
  });

  test.each([
    ['authid undefined', undefined, 'x'],
    ['authid null', null, 'x'],
    ['authid a number', 1, 'x'],
    ['ticket undefined', 'joe', undefined],
    ['ticket null', 'joe', null],
    ['ticket a number', 'joe', 1],
    ['ticket an object', 'joe', {}],
  ])('%s: TypeError at creation', (_name, authid, value) => {
    expect(() => ticket(authid as string, value as string)).toThrow(TypeError);
  });
});

// ------------------------------------------------------------------------------------------------------ wampcra
describe('wampcra()', CRYPTO_TIMEOUT, () => {
  test('AuthOptions: one method, the authid, frozen', () => {
    const options = wampcra('peter', 'secret1');
    expect(Object.keys(options).sort()).toEqual(['authid', 'authmethods', 'onChallenge']);
    expect(options.authmethods).toEqual(['wampcra']);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.authmethods)).toBe(true);
  });

  test('signs like the reference for any secret, challenge and salt (property)', async () => {
    const saltArb = fc.option(
      fc.record({
        salt: anyText,
        iterations: fc.integer({ min: 1, max: 30 }),
        keylen: fc.integer({ min: 1, max: 64 }),
      }),
      { nil: undefined },
    );
    await fc.assert(
      fc.asyncProperty(anyText, anyText, saltArb, async (secret, text, salt) => {
        const signature = await challenge(wampcra('peter', secret), message('wampcra', { challenge: text, ...salt }));
        expect(signature).toBe(nodeCra(secret, text, salt));
      }),
      replayParameters(),
    );
  });

  test('salt null means unsalted; the empty salt is a salt', async () => {
    const options = wampcra('peter', 'secret1');
    await expect(challenge(options, message('wampcra', { challenge: CRA_CHALLENGE, salt: null }))).resolves.toBe(
      nodeCra('secret1', CRA_CHALLENGE),
    );
    await expect(challenge(options, message('wampcra', { challenge: CRA_CHALLENGE, salt: '' }))).resolves.toBe(
      nodeCra('secret1', CRA_CHALLENGE, { salt: '', iterations: 1000, keylen: 32 }),
    );
  });

  test('Bondy: base64 salt used as text, 4096 iterations', async () => {
    const extra = { challenge: CRA_CHALLENGE, salt: 'c2FsdA==', iterations: 4096, keylen: 32 };
    await expect(challenge(wampcra('crauser', 'crasecret'), message('wampcra', extra))).resolves.toBe(
      nodeCra('crasecret', CRA_CHALLENGE, { salt: 'c2FsdA==', iterations: 4096, keylen: 32 }),
    );
  });

  test('the largest accepted keylen (256) is derived correctly', async () => {
    const extra = { challenge: 'c', salt: 's', iterations: 1, keylen: 256 };
    await expect(challenge(wampcra('peter', 'p'), message('wampcra', extra))).resolves.toBe(
      nodeCra('p', 'c', { salt: 's', iterations: 1, keylen: 256 }),
    );
  });

  test('the largest accepted cost (10,000,000 iterations, keylen 256) reaches PBKDF2 unchanged', async () => {
    const calls: { algorithm: Record<string, unknown>; length: number }[] = [];
    setSubtle({
      deriveBits: (algorithm: Record<string, unknown>, _key: unknown, length: number) => {
        calls.push({ algorithm, length });
        return Promise.resolve(new ArrayBuffer(length / 8)); // not computed: 10M rounds would take seconds
      },
    });
    const extra = { challenge: 'c', salt: 's', iterations: 10000000, keylen: 256 };
    await expect(challenge(wampcra('peter', 'p'), message('wampcra', extra))).resolves.toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.algorithm).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 10000000 });
    expect(bytesToHex(calls[0]!.algorithm['salt'] as Uint8Array)).toBe('73');
    expect(calls[0]!.length).toBe(2048);
  });

  test.each([
    ['iterations 0', { iterations: 0 }],
    ['keylen 0', { keylen: 0 }],
    ['iterations and keylen 0 (a Nexus keystore that leaves them unset)', { iterations: 0, keylen: 0 }],
  ])('%s means the default, as in autobahn-js and the Nexus client', async (_name, cost) => {
    const extra = { challenge: CRA_CHALLENGE, salt: 'salt123', ...cost };
    await expect(challenge(wampcra('peter', 'secret1'), message('wampcra', extra))).resolves.toBe(
      nodeCra('secret1', CRA_CHALLENGE, { salt: 'salt123', iterations: 1000, keylen: 32 }),
    );
  });

  test('the empty secret is signed correctly', async () => {
    await expect(challenge(wampcra('peter', ''), message('wampcra', { challenge: 'c' }))).resolves.toBe(
      nodeCra('', 'c'),
    );
  });

  test('unsalted: iterations and keylen are ignored', async () => {
    const extra = { challenge: CRA_CHALLENGE, iterations: 'junk', keylen: -1 };
    await expect(challenge(wampcra('peter', 's'), message('wampcra', extra))).resolves.toBe(
      nodeCra('s', CRA_CHALLENGE),
    );
  });

  const malformed: readonly (readonly [string, Record<string, unknown>])[] = [
    ['no challenge', {}],
    ['a numeric challenge', { challenge: 42 }],
    ['a null challenge', { challenge: null }],
    ['a parsed (object) challenge', { challenge: { nonce: 'n' } }],
    ['a numeric salt', { challenge: 'c', salt: 123 }],
    ['an object salt', { challenge: 'c', salt: {} }],
    ['a boolean salt', { challenge: 'c', salt: true }],
    ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', '', false, true, 10000001].map(
      (iterations) => [`iterations ${String(iterations)}`, { challenge: 'c', salt: 's', iterations }] as const,
    ),
    ...[-32, 31.5, '32', '', false, 257, Number.MAX_SAFE_INTEGER].map(
      (keylen) => [`keylen ${String(keylen)}`, { challenge: 'c', salt: 's', keylen }] as const,
    ),
  ];
  test.each(malformed)('%s: rejects with TypeError before the secret is read', async (_name, extra) => {
    const read = vi.fn(() => 'secret1');
    const error = await rejection(challenge(wampcra('peter', read), message('wampcra', extra)));
    expect(error).toBeInstanceOf(TypeError);
    expect(read).not.toHaveBeenCalled();
  });

  test('a CHALLENGE for another method: AuthenticationError, the secret is not read', async () => {
    const read = vi.fn(() => 'secret1');
    const error = await rejection(challenge(wampcra('peter', read), message('ticket', {})));
    expectAuthenticationError(error, 'ticket');
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    ['unsalted', {}],
    ['salted', { salt: 'salt123' }],
  ])('without WebCrypto (%s): AuthenticationError, and the secret is not asked for', async (_name, extra) => {
    setCrypto({ value: undefined });
    const read = vi.fn(() => 'secret1');
    const error = await rejection(challenge(wampcra('peter', read), message('wampcra', { challenge: 'c', ...extra })));
    expectAuthenticationError(error);
    expect(read).not.toHaveBeenCalled();
  });

  describe('function form', () => {
    const expected = nodeCra('secret1', CRA_CHALLENGE);
    const thenable = {
      then: (resolve: (v: string) => void) => {
        resolve('secret1');
      },
    };
    const sync = {
      subscribe: (o: { next(v: string): void }) => {
        o.next('secret1');
      },
    };
    test.each<readonly [string, () => unknown]>([
      ['a string', () => 'secret1'],
      ['a Promise', () => Promise.resolve('secret1')],
      ['a thenable', () => thenable],
      ['a synchronous subscribe-object', () => sync],
    ])('%s', async (_name, read) => {
      const options = wampcra('peter', read as () => string);
      await expect(challenge(options, message('wampcra', { challenge: CRA_CHALLENGE }))).resolves.toBe(expected);
    });

    test('an asynchronous Observable-like: its first value, then it is unsubscribed', async () => {
      const source = controllable<string>();
      const pending = challenge(
        wampcra('peter', () => source.input),
        message('wampcra', { challenge: CRA_CHALLENGE }),
      );
      await Promise.resolve();
      source.emit('secret1');
      source.emit('ignored');
      await expect(pending).resolves.toBe(expected);
      expect(source.unsubscribed).toBe(1);
    });

    test('re-read on every CHALLENGE', async () => {
      const read = vi.fn(() => 'secret1');
      const options = wampcra('peter', read);
      for (let i = 0; i < 3; i++) await challenge(options, message('wampcra', { challenge: CRA_CHALLENGE }));
      expect(read).toHaveBeenCalledTimes(3);
    });

    const boom = new Error('vault locked');
    test.each<readonly [string, () => unknown]>([
      [
        'the function throws',
        () => {
          throw boom;
        },
      ],
      ['its Promise rejects', () => Promise.reject(boom)],
      [
        'its then getter throws (a throwing conversion)',
        () => ({
          get then() {
            throw boom;
          },
        }),
      ],
      [
        'its subscribe throws (a throwing conversion)',
        () => ({
          subscribe() {
            throw boom;
          },
        }),
      ],
      [
        'its Observable errors',
        () => ({
          subscribe: (o: { error(e: unknown): void }) => {
            o.error(boom);
          },
        }),
      ],
    ])('%s: rejects with the same error', async (_name, read) => {
      const error = await rejection(
        challenge(wampcra('peter', read as () => string), message('wampcra', { challenge: CRA_CHALLENGE })),
      );
      expect(error).toBe(boom);
    });

    test.each<readonly [string, () => unknown]>([
      [
        'completes without a value',
        () => ({
          subscribe: (o: { complete(): void }) => {
            o.complete();
          },
        }),
      ],
      ['gives a number', () => 42],
      ['gives undefined', () => undefined],
      ['gives an object', () => Promise.resolve({ secret: 'secret1' })],
    ])('%s: TypeError', async (_name, read) => {
      const error = await rejection(
        challenge(wampcra('peter', read as () => string), message('wampcra', { challenge: CRA_CHALLENGE })),
      );
      expect(error).toBeInstanceOf(TypeError);
    });

    test('an Input that completes without a value: TypeError saying so', async () => {
      const empty = {
        subscribe: (o: { complete(): void }) => {
          o.complete();
        },
      };
      const cra = challenge(
        wampcra('peter', () => empty),
        message('wampcra', { challenge: CRA_CHALLENGE }),
      );
      expect(((await rejection(cra)) as Error).message).toBe('wampcra: the secret completed without a value');
      const cs = challenge(
        cryptosign({ publicKey: PUBLIC_KEY, sign: () => empty }),
        message('cryptosign', { challenge: CHALLENGE_HEX }),
      );
      expect(((await rejection(cs)) as Error).message).toBe('cryptosign: sign() completed without a value');
    });

    test('an abandoned handshake unsubscribes the pending secret and rejects with the signal reason', async () => {
      const source = controllable<string>();
      const controller = new AbortController();
      const pending = challenge(
        wampcra('peter', () => source.input),
        message('wampcra', { challenge: CRA_CHALLENGE }, controller.signal),
      );
      await Promise.resolve();
      expect(source.subscribed).toBe(1);
      const reason = new CanceledError();
      controller.abort(reason);
      expect(source.unsubscribed).toBe(1);
      source.emit('secret1'); // too late: ignored
      expect(await rejection(pending)).toBe(reason);
    });

    test('a handshake abandoned while the secret is being subscribed: unsubscribed all the same', async () => {
      const controller = new AbortController();
      const reason = new CanceledError();
      let unsubscribed = 0;
      const input = {
        subscribe() {
          controller.abort(reason);
          return {
            unsubscribe() {
              unsubscribed++;
            },
          };
        },
      };
      const pending = challenge(
        wampcra('peter', () => input),
        message('wampcra', { challenge: CRA_CHALLENGE }, controller.signal),
      );
      expect(await rejection(pending)).toBe(reason);
      expect(unsubscribed).toBe(1);
    });

    test('a secret function that abandons the handshake itself: rejects with the reason, never subscribed', async () => {
      const controller = new AbortController();
      const reason = new CanceledError();
      const source = controllable<string>();
      const pending = challenge(
        wampcra('peter', () => {
          controller.abort(reason); // an app composing the helper with its own controller, say
          return source.input;
        }),
        message('wampcra', { challenge: CRA_CHALLENGE }, controller.signal),
      );
      expect(await rejection(pending)).toBe(reason);
      expect(source.subscribed).toBe(0);
    });

    test('an unsubscribe that throws during the abort stays inside the helper; the reason still rejects', async () => {
      // A signal that dispatches without isolating its listeners: on a native AbortSignal a listener throw is an
      // uncaught exception (Node's EventTarget rethrows it on the next tick), so the helper's listener must not throw.
      const listeners = new Set<() => void>();
      const signal = {
        aborted: false,
        reason: undefined as unknown,
        addEventListener: (_type: 'abort', listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: 'abort', listener: () => void) => listeners.delete(listener),
      };
      const abort = (reason: unknown): void => {
        signal.aborted = true;
        signal.reason = reason;
        for (const listener of [...listeners]) listener();
      };
      const input = {
        subscribe: () => ({
          unsubscribe() {
            throw new Error('teardown failed');
          },
        }),
      };
      const pending = challenge(
        wampcra('peter', () => input),
        {
          authMethod: 'wampcra',
          extra: { challenge: CRA_CHALLENGE },
          signal,
        },
      );
      expect(listeners.size).toBe(1);
      const reason = new CanceledError();
      expect(() => {
        abort(reason);
      }).not.toThrow();
      expect(await rejection(pending)).toBe(reason);
      expect(listeners.size).toBe(0);
    });

    test.each<readonly [string, () => unknown]>([
      ['errors', () => Promise.reject(new Error('vault locked'))],
      [
        'completes without a value',
        () => ({
          subscribe: (o: { complete(): void }) => {
            o.complete();
          },
        }),
      ],
    ])('the abort listener is removed when the secret Input %s', async (_name, read) => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = challenge(
        wampcra('peter', read as () => string),
        message('wampcra', { challenge: CRA_CHALLENGE }, controller.signal),
      );
      await rejection(pending);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    });

    test('an already abandoned handshake does not read the secret', async () => {
      const read = vi.fn(() => 'secret1');
      const controller = new AbortController();
      const reason = new ConnectionLostError({});
      controller.abort(reason);
      const pending = challenge(wampcra('peter', read), message('wampcra', { challenge: 'c' }, controller.signal));
      expect(await rejection(pending)).toBe(reason);
      expect(read).not.toHaveBeenCalled();
    });

    test('the abort listener is removed once the secret has arrived', async () => {
      const source = controllable<string>();
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = challenge(
        wampcra('peter', () => source.input),
        message('wampcra', { challenge: CRA_CHALLENGE }, controller.signal),
      );
      await Promise.resolve();
      source.emit('secret1');
      await expect(pending).resolves.toBe(expected);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
      controller.abort(new CanceledError());
      expect(source.unsubscribed).toBe(1); // only the one after the first value
    });

    test('a message without a signal (an app composing helpers by hand) still works', async () => {
      const options = wampcra('peter', () => Promise.resolve('secret1'));
      const msg = { authMethod: 'wampcra', extra: { challenge: CRA_CHALLENGE } } as unknown as ChallengeMessage;
      await expect(challenge(options, msg)).resolves.toBe(expected);
    });

    test('a message without a signal: a credential that fails or completes empty rejects the answer (no TypeError)', async () => {
      const msg = { authMethod: 'wampcra', extra: { challenge: CRA_CHALLENGE } } as unknown as ChallengeMessage;
      const boom = new Error('no secret');
      await expect(
        challenge(
          wampcra('peter', () => Promise.reject(boom)),
          msg,
        ),
      ).rejects.toBe(boom);
      const empty = { subscribe: (o: { complete(): void }) => (o.complete(), { unsubscribe: () => undefined }) };
      await expect(
        challenge(
          wampcra('peter', () => empty as never),
          msg,
        ),
      ).rejects.toThrow('wampcra: the secret completed without a value');
    });
  });

  test.each([
    ['authid undefined', undefined, 'x'],
    ['authid a number', 1, 'x'],
    ['secret undefined', 'peter', undefined],
    ['secret null', 'peter', null],
    ['secret a number', 'peter', 1],
  ])('%s: TypeError at creation', (_name, authid, secret) => {
    expect(() => wampcra(authid as string, secret as string)).toThrow(TypeError);
  });
});

// --------------------------------------------------------------------------------------------------- cryptosign
describe('cryptosign()', () => {
  test('AuthOptions: one method, authextra {pubkey} in lower case, frozen; authid only when given', () => {
    const withId = cryptosign({ authid: 'csuser', publicKey: PUBLIC_KEY.toUpperCase(), privateKey: SEED });
    expect(Object.keys(withId).sort()).toEqual(['authextra', 'authid', 'authmethods', 'onChallenge']);
    expect(withId.authmethods).toEqual(['cryptosign']);
    expect(withId.authid).toBe('csuser');
    expect(withId.authextra).toEqual({ pubkey: PUBLIC_KEY });
    expect(Object.isFrozen(withId)).toBe(true);
    expect(Object.isFrozen(withId.authmethods)).toBe(true);
    expect(Object.isFrozen(withId.authextra)).toBe(true);
    const anonymous = cryptosign({ publicKey: PUBLIC_KEY, sign: () => new Uint8Array(64) });
    expect(Object.keys(anonymous).sort()).toEqual(['authextra', 'authmethods', 'onChallenge']);
    expect('authid' in cryptosign({ authid: undefined, publicKey: PUBLIC_KEY, privateKey: SEED })).toBe(false);
  });

  test('answers hex(signature ‖ challenge) that verifies, for any seed and challenge in any case (property)', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, seedArb, fc.array(fc.boolean(), { maxLength: 64 }), async (s, c, upper) => {
        const { key, publicKeyHex } = nodeKeys(s);
        const options = cryptosign({ publicKey: publicKeyHex, privateKey: bytesToHex(s) });
        const hex = bytesToHex(c).replace(/[a-f]/g, (ch, i: number) => (upper[i] === true ? ch.toUpperCase() : ch));
        const answer = (await challenge(options, message('cryptosign', { challenge: hex }))) as string;
        expect(answer).toMatch(/^[0-9a-f]{192}$/);
        expect(answer.slice(128)).toBe(bytesToHex(c));
        expect(nodeVerify(null, c, createPublicKey(key), Buffer.from(answer.slice(0, 128), 'hex'))).toBe(true);
      }),
      { ...replayParameters(), numRuns: 50 },
    );
  });

  test('the seed is imported once, starting at creation', async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    const options = cryptosign({ publicKey: PUBLIC_KEY, privateKey: SEED });
    expect(importKey).toHaveBeenCalledTimes(1); // before any CHALLENGE
    for (let i = 0; i < 3; i++) await challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }));
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  test('a public key of another seed: creation succeeds, every handshake rejects with that TypeError', async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    const options = cryptosign({ publicKey: OTHER_PUBLIC_KEY, privateKey: SEED });
    for (let i = 1; i <= 2; i++) {
      const error = await rejection(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX })));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/public key does not belong to the private key/);
      expect((error as Error).message).not.toContain(SEED);
    }
    expect(importKey).toHaveBeenCalledTimes(2); // creation (shared by the first handshake) + a retry by the second
  });

  test('a mismatched helper that never sees a CHALLENGE causes no unhandled rejection', async () => {
    const exportKey = vi.spyOn(globalThis.crypto.subtle, 'exportKey');
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      cryptosign({ publicKey: OTHER_PUBLIC_KEY, privateKey: SEED });
      await vi.waitFor(() => {
        expect(exportKey).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });

  test('WebCrypto missing at creation but present later: the next handshake imports again and succeeds', async () => {
    setCrypto({ value: undefined });
    const options = cryptosign({ publicKey: PUBLIC_KEY, privateKey: SEED });
    expectAuthenticationError(await rejection(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }))));
    Object.defineProperty(globalThis, 'crypto', CRYPTO);
    const answer = (await challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }))) as string;
    expect(answer.slice(128)).toBe(CHALLENGE_HEX);
  });

  const badChallenges: readonly (readonly [string, unknown])[] = [
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['bytes, not hex', new Uint8Array(32)],
    ['31 bytes', CHALLENGE_HEX.slice(2)],
    ['33 bytes', `${CHALLENGE_HEX}00`],
    ['an odd number of digits', CHALLENGE_HEX.slice(1)],
    ['a non-hex digit', `${CHALLENGE_HEX.slice(1)}g`],
    ['a 0x prefix', `0x${CHALLENGE_HEX.slice(2)}`],
    ['surrounding space', ` ${CHALLENGE_HEX.slice(1)}`],
    ['empty', ''],
  ];
  test.each(badChallenges)('challenge %s: TypeError, nothing is signed', async (_name, value) => {
    const sign = vi.fn(() => new Uint8Array(64));
    const options = cryptosign({ publicKey: PUBLIC_KEY, sign });
    const error = await rejection(challenge(options, message('cryptosign', { challenge: value })));
    expect(error).toBeInstanceOf(TypeError);
    expect(sign).not.toHaveBeenCalled();
  });

  test.each([null, undefined])('channel_binding %j is accepted (no binding)', async (binding) => {
    const options = cryptosign({ publicKey: PUBLIC_KEY, privateKey: SEED });
    const extra = { challenge: CHALLENGE_HEX, channel_binding: binding };
    await expect(challenge(options, message('cryptosign', extra))).resolves.toMatch(/^[0-9a-f]{192}$/);
  });

  test.each(['tls-unique', 'tls-exporter', '', false])(
    'channel_binding %j: AuthenticationError (unsupported), nothing is signed',
    async (binding) => {
      const sign = vi.fn(() => new Uint8Array(64));
      const options = cryptosign({ publicKey: PUBLIC_KEY, sign });
      const extra = { challenge: CHALLENGE_HEX, channel_binding: binding };
      expectAuthenticationError(await rejection(challenge(options, message('cryptosign', extra))), 'cryptosign');
      expect(sign).not.toHaveBeenCalled();
    },
  );

  test('a CHALLENGE for another method: AuthenticationError, nothing is signed', async () => {
    const sign = vi.fn(() => new Uint8Array(64));
    const options = cryptosign({ publicKey: PUBLIC_KEY, sign });
    expectAuthenticationError(await rejection(challenge(options, message('ticket', {}))), 'ticket');
    expect(sign).not.toHaveBeenCalled();
  });

  describe('app signer ({publicKey, sign})', () => {
    const { key } = nodeKeys(hexToBytes(SEED));
    const signature = nodeSign(null, hexToBytes(CHALLENGE_HEX), key);
    const answer = bytesToHex(signature) + CHALLENGE_HEX;
    const Foreign = vm.runInNewContext('Uint8Array') as Uint8ArrayConstructor;

    test('called with the challenge bytes and this = the key object; works without WebCrypto', async () => {
      setCrypto({ value: undefined });
      const keyObject = {
        publicKey: PUBLIC_KEY,
        sign(this: unknown, m: Uint8Array) {
          expect(this).toBe(keyObject);
          expect(bytesToHex(m)).toBe(CHALLENGE_HEX);
          return nodeSign(null, m, key);
        },
      };
      await expect(challenge(cryptosign(keyObject), message('cryptosign', { challenge: CHALLENGE_HEX }))).resolves.toBe(
        answer,
      );
    });

    test('the signer cannot change the challenge echoed in the answer', async () => {
      const options = cryptosign({
        publicKey: PUBLIC_KEY,
        sign: (m) => {
          const s = nodeSign(null, m, key);
          m.fill(0);
          return s;
        },
      });
      await expect(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }))).resolves.toBe(answer);
    });

    test.each<readonly [string, () => unknown]>([
      ['a Uint8Array', () => new Uint8Array(signature)],
      ['a Buffer', () => Buffer.from(signature)],
      ['a Uint8Array of another realm', () => Foreign.from(signature)],
      [
        'a view into a larger buffer',
        () => {
          const backing = new Uint8Array(70);
          backing.set(signature, 3);
          return backing.subarray(3, 67);
        },
      ],
      ['an ArrayBuffer (crypto.subtle.sign)', () => Uint8Array.from(signature).buffer],
      ['an ArrayBuffer of another realm', () => Foreign.from(signature).buffer],
      ['a Promise', () => Promise.resolve(new Uint8Array(signature))],
      [
        'an Observable-like',
        () => ({
          subscribe: (o: { next(v: Uint8Array): void }) => {
            o.next(signature);
          },
        }),
      ],
    ])('may give %s', async (_name, sign) => {
      const options = cryptosign({ publicKey: PUBLIC_KEY, sign: sign as () => Uint8Array });
      await expect(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }))).resolves.toBe(answer);
    });

    test.each<readonly [string, () => unknown]>([
      ['96 bytes (nacl.sign, signature ‖ message)', () => Buffer.concat([signature, hexToBytes(CHALLENGE_HEX)])],
      ['63 bytes', () => signature.subarray(1)],
      ['hex text', () => bytesToHex(signature)],
      ['a number array', () => Array.from(signature)],
      ['undefined', () => undefined],
      [
        'completes without a value',
        () => ({
          subscribe: (o: { complete(): void }) => {
            o.complete();
          },
        }),
      ],
    ])('giving %s: TypeError', async (_name, sign) => {
      const options = cryptosign({ publicKey: PUBLIC_KEY, sign: sign as () => Uint8Array });
      const error = await rejection(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX })));
      expect(error).toBeInstanceOf(TypeError);
    });

    const boom = new Error('secure enclave locked');
    test.each<readonly [string, () => unknown]>([
      [
        'throws',
        () => {
          throw boom;
        },
      ],
      ['rejects', () => Promise.reject(boom)],
      [
        'gives a thenable whose then getter throws',
        () => ({
          get then() {
            throw boom;
          },
        }),
      ],
    ])('a signer that %s: the same error', async (_name, sign) => {
      const options = cryptosign({ publicKey: PUBLIC_KEY, sign: sign as () => Uint8Array });
      expect(await rejection(challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX })))).toBe(boom);
    });

    test('an abandoned handshake unsubscribes the pending signer and rejects with the signal reason', async () => {
      const source = controllable<Uint8Array>();
      const controller = new AbortController();
      const options = cryptosign({ publicKey: PUBLIC_KEY, sign: () => source.input });
      const pending = challenge(options, message('cryptosign', { challenge: CHALLENGE_HEX }, controller.signal));
      await Promise.resolve();
      const reason = new ConnectionLostError({});
      controller.abort(reason);
      expect(source.unsubscribed).toBe(1);
      expect(await rejection(pending)).toBe(reason);
    });
  });

  const sign = (): Uint8Array => new Uint8Array(64);
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', SEED],
    ['no publicKey', { privateKey: SEED }],
    ['a 31-byte publicKey', { publicKey: PUBLIC_KEY.slice(2), privateKey: SEED }],
    ['a 33-byte publicKey', { publicKey: `${PUBLIC_KEY}00`, privateKey: SEED }],
    ['a non-hex publicKey', { publicKey: `${PUBLIC_KEY.slice(1)}g`, privateKey: SEED }],
    ['a numeric publicKey', { publicKey: 1, privateKey: SEED }],
    ['a 31-byte privateKey', { publicKey: PUBLIC_KEY, privateKey: SEED.slice(2) }],
    ['a 64-byte privateKey (nacl secretKey)', { publicKey: PUBLIC_KEY, privateKey: SEED + PUBLIC_KEY }],
    ['a non-hex privateKey', { publicKey: PUBLIC_KEY, privateKey: `${SEED.slice(1)}g` }],
    ['a Uint8Array privateKey', { publicKey: PUBLIC_KEY, privateKey: hexToBytes(SEED) }],
    ['both privateKey and sign', { publicKey: PUBLIC_KEY, privateKey: SEED, sign }],
    ['neither privateKey nor sign', { publicKey: PUBLIC_KEY }],
    ['a non-function sign', { publicKey: PUBLIC_KEY, sign: 'sign' }],
    ['a numeric authid', { authid: 1, publicKey: PUBLIC_KEY, privateKey: SEED }],
    ['a null authid', { authid: null, publicKey: PUBLIC_KEY, privateKey: SEED }],
  ])('%s: TypeError at creation, no key material in the message', (_name, key) => {
    let error: unknown;
    try {
      cryptosign(key as Parameters<typeof cryptosign>[0]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toMatch(/[0-9a-f]{16}/i);
  });

  test('the import does not start for an invalid key', () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    expect(() => cryptosign({ publicKey: PUBLIC_KEY, privateKey: SEED.slice(2) })).toThrow(TypeError);
    expect(importKey).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------- the client's reporter

describe("the client's reporter reaches the helpers' own conversions", () => {
  /** A credential Input that answers at once and whose teardown throws (an app bug after the value was taken). */
  function throwingTeardown<T>(value: T, boom: Error) {
    return {
      subscribe(observer: { next(v: T): void }) {
        observer.next(value);
        return {
          unsubscribe() {
            throw boom;
          },
        };
      },
    };
  }
  function withReporter(msg: ChallengeMessage, reporter: unknown): ChallengeMessage {
    Object.defineProperty(msg, Symbol.for('thruway.js.reporter'), { value: reporter });
    return msg;
  }
  const { key } = nodeKeys(hexToBytes(SEED));
  const signature = nodeSign(null, hexToBytes(CHALLENGE_HEX), key);

  test.each(['wampcra', 'cryptosign'] as const)(
    '%s: a credential teardown that throws goes to the message’s reporter, not console.error',
    async (method) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const boom = new Error('app teardown');
      const reports: unknown[][] = [];
      const options =
        method === 'wampcra'
          ? wampcra('peter', () => throwingTeardown('secret1', boom))
          : cryptosign({ publicKey: PUBLIC_KEY, sign: () => throwingTeardown(new Uint8Array(signature), boom) });
      const extra = method === 'wampcra' ? { challenge: CRA_CHALLENGE } : { challenge: CHALLENGE_HEX };
      const msg = withReporter(message(method, extra), (error: unknown, kind: string) => reports.push([error, kind]));
      const expected = method === 'wampcra' ? nodeCra('secret1', CRA_CHALLENGE) : bytesToHex(signature) + CHALLENGE_HEX;
      await expect(challenge(options, msg)).resolves.toBe(expected);
      expect(reports).toEqual([[boom, 'unhandled']]);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['no reporter (a message the app built)', (msg: ChallengeMessage) => msg],
    ['a reporter that is not a function', (msg: ChallengeMessage) => withReporter(msg, 'not a function')],
    [
      'a message whose reporter getter throws (an app Proxy)',
      (msg: ChallengeMessage) =>
        new Proxy(msg, {
          get(target, property, receiver) {
            if (property === Symbol.for('thruway.js.reporter')) throw new Error('hostile');
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    ],
  ])('%s: the default reporter (console.error), the answer is unchanged', async (_name, wrap) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('app teardown');
    const options = wampcra('peter', () => throwingTeardown('secret1', boom));
    await expect(challenge(options, wrap(message('wampcra', { challenge: CRA_CHALLENGE })))).resolves.toBe(
      nodeCra('secret1', CRA_CHALLENGE),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(boom);
  });

  test("through a real Client: the helper's unhandled error reaches the client's logger, never console.error", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('app teardown');
    const harness = createHarness({
      router: {
        providers: [
          {
            method: 'wampcra',
            extra: () => ({ challenge: CRA_CHALLENGE }),
            verify: (sig) =>
              sig === nodeCra('secret1', CRA_CHALLENGE) ? { authid: 'peter', authrole: 'user' } : false,
          },
        ],
      },
    });
    const entries: LogEntry[] = [];
    const c = harness.makeClient(Client, {
      options: {
        ...wampcra('peter', () => throwingTeardown('secret1', boom)),
        timeouts: { idle: 0 },
        logger: (entry) => entries.push(entry),
      },
    });
    // WebCrypto settles in real time: let it run between small steps of the virtual clock
    for (let i = 0; i < 200 && c.client.session === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await harness.clock.advance(1);
    }
    expect(c.client.session?.details.authid).toBe('peter');
    expect(entries.filter((entry) => entry.event === 'unhandled')).toMatchObject([
      { level: 'error', data: { error: boom } },
    ]);
    await harness.finish();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
