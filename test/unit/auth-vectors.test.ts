// Published test vectors for the auth helpers (the WAMP-CRA and WAMP-Cryptosign sections of the WAMP spec), run through
// the real WebCrypto of the running Node (22.13+ and 26): WAMP-CRA unsalted, the salted derived key and the salted
// signature; WAMP-Cryptosign with the spec's seeds through the PKCS#8 import, and the router test credentials
// (routers/README-B). The generated cases (node:crypto as the reference) are in auth-helpers.test.ts.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cryptosign, wampcra } from '../../src/auth/index.js';
import {
  bytesToHex,
  ED25519_PKCS8_PREFIX,
  ed25519Sign,
  hexToBytes,
  hmacSha256Base64,
  pbkdf2Base64,
} from '../../src/auth/crypto.js';
import { AuthenticationError } from '../../src/errors.js';
import type { ChallengeMessage } from '../../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function challengeMessage(authMethod: string, extra: Record<string, unknown>): ChallengeMessage {
  return { authMethod, extra, signal: new AbortController().signal };
}

function answer(options: { onChallenge: ((c: ChallengeMessage) => unknown) | undefined }, c: ChallengeMessage) {
  return Promise.resolve(options.onChallenge!(c));
}

// ---------------------------------------------------------------------------------------------------- WAMP-CRA
// autobahn's published vector, also given in the WAMP spec's WAMP-CRA section.
const CRA_SECRET = 'L3L1YUE8Txlw';
const CRA_CHALLENGE =
  '{"authid":"peter","authrole":"user","authmethod":"wampcra","authprovider":"userdb","nonce":"LHRTC9zeOIrt_9U3",' +
  '"timestamp":"2014-06-22T16:36:25.448Z","session":3251278072152162}';
const CRA_UNSALTED = 'PBOOq9+QzkvX5XaRPEd5/AkZikJep4wP3ZAKTxESkBM=';
const CRA_DERIVED_KEY = 'qzcdsr9uu/L5hnss3kjNTRe490ETgA70ZBaB5rvnJ5Y=';
const CRA_SALTED = 'P7/PELpQF2EaD16FFKEvqZ9auItbiaGs9ZkuQb6kFY0=';

describe('WAMP-CRA vectors', () => {
  test('unsalted signature = base64(HMAC-SHA256(secret, challenge))', async () => {
    await expect(hmacSha256Base64(CRA_SECRET, CRA_CHALLENGE)).resolves.toBe(CRA_UNSALTED);
  });

  test('derived key = base64(PBKDF2-HMAC-SHA256(secret, "salt123", 1000, 32))', async () => {
    await expect(pbkdf2Base64(CRA_SECRET, 'salt123', 1000, 32)).resolves.toBe(CRA_DERIVED_KEY);
  });

  test('salted signature: the base64 text of the derived key is the HMAC key', async () => {
    await expect(hmacSha256Base64(CRA_DERIVED_KEY, CRA_CHALLENGE)).resolves.toBe(CRA_SALTED);
  });

  test('wampcra(): unsalted CHALLENGE', async () => {
    const c = challengeMessage('wampcra', { challenge: CRA_CHALLENGE });
    await expect(answer(wampcra('peter', CRA_SECRET), c)).resolves.toBe(CRA_UNSALTED);
  });

  test.each([
    ['salt, keylen and iterations given', { salt: 'salt123', keylen: 32, iterations: 1000 }],
    [
      'Thruway PHP extra (challenge_method)',
      { challenge_method: 'wampcra', salt: 'salt123', keylen: 32, iterations: 1000 },
    ],
    ['iterations and keylen absent (defaults 1000, 32)', { salt: 'salt123' }],
    ['iterations and keylen null (defaults)', { salt: 'salt123', keylen: null, iterations: null }],
    [
      'iterations and keylen 0 (defaults, as in autobahn-js and the Nexus client)',
      { salt: 'salt123', keylen: 0, iterations: 0 },
    ],
  ])('wampcra(): salted CHALLENGE, %s', async (_name, extra) => {
    const c = challengeMessage('wampcra', { challenge: CRA_CHALLENGE, ...extra });
    await expect(answer(wampcra('peter', CRA_SECRET), c)).resolves.toBe(CRA_SALTED);
  });

  test('wampcra(): the exact challenge string is signed (Crossbar sends Python separators)', async () => {
    // Re-serialising the parsed JSON would drop the spaces and change the signature.
    const spaced = CRA_CHALLENGE.replace(/,"/g, ', "').replace(/":/g, '": ');
    expect(JSON.stringify(JSON.parse(spaced))).toBe(CRA_CHALLENGE);
    const c = challengeMessage('wampcra', { challenge: spaced });
    const signature = await answer(wampcra('peter', CRA_SECRET), c);
    expect(signature).toBe(await hmacSha256Base64(CRA_SECRET, spaced));
    expect(signature).not.toBe(CRA_UNSALTED);
  });
});

// ----------------------------------------------------------------------------------------------- WAMP-Cryptosign
// rfc/text/advanced/authentication_cryptosign.md § Test Vectors, the three without a channel_id. The spec gives the
// public key of the first seed; the other two were derived with node:crypto and are checked below.
const CS_VECTORS = [
  {
    seed: '4d57d97a68f555696620a6d849c0ce582568518d729eb753dc7c732de2804510',
    publicKey: '1adfc8bfe1d35616e64dffbd900096f23b066f914c8c2ffbb66f6075b96e116d',
    challenge: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    signature:
      'b32675b221f08593213737bef8240e7c15228b07028e19595294678c90d11c0cae80a357331bfc5cc9fb71081464e6e75013517c2cf067' +
      'ad566a6b7b728e5d03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  },
  {
    seed: 'd511fe78e23934b3dadb52fcd022974b80bd92bccc7c5cf404e46cc0a8a2f5cd',
    publicKey: '6ed32739ff04a6074044ff0b0e3bfc7c856bc9d5f1d25efc57363bda0af3a8b0',
    challenge: 'b26c1f87c13fc1da14997f1b5a71995dff8fbe0a62fae8473c7bdbd05bfb607d',
    signature:
      'd4209ad10d5aff6bfbc009d7e924795de138a63515efc7afc6b01b7fe5201372190374886a70207b042294af5bd64ce725cd8dceb344e6' +
      'd11c09d1aaaf4d660fb26c1f87c13fc1da14997f1b5a71995dff8fbe0a62fae8473c7bdbd05bfb607d',
  },
  {
    seed: '6e1fde9cf9e2359a87420b65a87dc0c66136e66945196ba2475990d8a0c3a25b',
    publicKey: '28e11f427b82b9a625ee7ac89a7d29326b505f2dc11dd88c1245f83b6da79a85',
    challenge: 'b05e6b8ad4d69abf74aa3be3c0ee40ae07d66e1895b9ab09285a2f1192d562d2',
    signature:
      '7beb282184baadd08f166f16dd683b39cab53816ed81e6955def951cb2ddad1ec184e206746fd82bda075af03711d3d5658fc84a76196b' +
      '0fa8d1ebc92ef9f30bb05e6b8ad4d69abf74aa3be3c0ee40ae07d66e1895b9ab09285a2f1192d562d2',
  },
] as const;

/** The `csuser` credentials of the router test setups (routers/README-B.md: Bondy, Nexus, nxt, Crossbar). */
const ROUTER_SEED = '93a276a0b622ce7c6dd077120550cd3524ec1eed5ebf8692c4a828da9fc15dd2';
const ROUTER_PUBLIC_KEY = '682a35e8c87f7004cbb10679617a29154f9906b7e29a64af3f6d3e8e10934701';

function nodePublicKey(seedHex: string): string {
  const key = createPrivateKey({
    key: Buffer.from(ED25519_PKCS8_PREFIX + seedHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(x!, 'base64url').toString('hex');
}

describe('WAMP-Cryptosign vectors', () => {
  test.each(CS_VECTORS.map((v) => [v.seed.slice(0, 8), v] as const))(
    'seed %s…: the public key is the one listed',
    (_name, v) => {
      expect(nodePublicKey(v.seed)).toBe(v.publicKey);
    },
  );

  test('the router credentials: seed 93a276a0… belongs to public key 682a35e8…', async () => {
    expect(nodePublicKey(ROUTER_SEED)).toBe(ROUTER_PUBLIC_KEY);
    await expect(ed25519Sign(hexToBytes(ROUTER_SEED), ROUTER_PUBLIC_KEY)).resolves.toBeTypeOf('function');
  });

  test.each(CS_VECTORS.map((v) => [v.seed.slice(0, 8), v] as const))(
    'seed %s…: ed25519Sign signs through the PKCS#8 import',
    async (_name, v) => {
      const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
      const sign = await ed25519Sign(hexToBytes(v.seed), v.publicKey);
      expect(importKey).toHaveBeenCalledTimes(1);
      const [format, der, algorithm, , usages] = importKey.mock.calls[0]!;
      expect(format).toBe('pkcs8');
      expect(bytesToHex(der as Uint8Array)).toBe(ED25519_PKCS8_PREFIX + v.seed);
      expect(algorithm).toEqual({ name: 'Ed25519' });
      expect(usages).toEqual(['sign']);
      expect(bytesToHex(await sign(hexToBytes(v.challenge)))).toBe(v.signature.slice(0, 128));
    },
  );

  test.each(CS_VECTORS.map((v) => [v.seed.slice(0, 8), v] as const))(
    'seed %s…: cryptosign() answers hex(signature ‖ challenge), 192 hex digits',
    async (_name, v) => {
      const options = cryptosign({ authid: 'csuser', publicKey: v.publicKey, privateKey: v.seed });
      expect(options.authextra).toEqual({ pubkey: v.publicKey });
      const signature = await answer(options, challengeMessage('cryptosign', { challenge: v.challenge }));
      expect(signature).toBe(v.signature);
      expect(signature).toHaveLength(192);
    },
  );

  test.each(CS_VECTORS.map((v) => [v.seed.slice(0, 8), v] as const))(
    'seed %s…: an UPPERCASE challenge (Bondy) gives the same answer, with the challenge in lower case',
    async (_name, v) => {
      const options = cryptosign({ publicKey: v.publicKey.toUpperCase(), privateKey: v.seed.toUpperCase() });
      expect(options.authextra).toEqual({ pubkey: v.publicKey });
      const c = challengeMessage('cryptosign', { challenge: v.challenge.toUpperCase(), channel_binding: null });
      await expect(answer(options, c)).resolves.toBe(v.signature);
    },
  );

  test('a public key that does not belong to the seed: TypeError from the import', async () => {
    const [a, b] = CS_VECTORS;
    const error = await ed25519Sign(hexToBytes(a.seed), b.publicKey).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(a.seed);
    const options = cryptosign({ publicKey: b.publicKey, privateKey: a.seed });
    await expect(answer(options, challengeMessage('cryptosign', { challenge: a.challenge }))).rejects.toThrow(
      TypeError,
    );
  });

  test('channel binding is not supported: the channel-bound vectors are refused, not mis-signed', async () => {
    const v = CS_VECTORS[0];
    const options = cryptosign({ publicKey: v.publicKey, privateKey: v.seed });
    const c = challengeMessage('cryptosign', { challenge: v.challenge, channel_binding: 'tls-unique' });
    await expect(answer(options, c)).rejects.toThrow(AuthenticationError);
  });
});
