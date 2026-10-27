#!/usr/bin/env node
'use strict';
// fox-wamp 0.7.28 (Node.js WAMP v2 router, github.com/kalmyk/fox-wamp) for thruway.js integration/fuzz tests.
//
//   node router.cjs [config.json]        (env: FOX_WAMP_HOME = dir containing node_modules/fox-wamp,
//                                          FOX_WAMP_PORT, FOX_WAMP_TRACE=1 logs every frame)
//
// fox-wamp can only do "all sessions authenticate" or "nobody authenticates" per listener. This script builds
// the WAMP gate itself and overrides gate.isAuthRequired() so that, on one port:
//   - realms in config.anonymous_realms (default realm1): HELLO without a supported authmethod -> anonymous
//   - realms in config.strict_realms   (default realm_auth): must authenticate (else ABORT wamp.error.no_auth_method)
//   - any other valid realm name: anonymous (fox-wamp auto-creates realms; names must match /^[a-z0-9_]+$/)
// Auth methods: wampcra (static users, optional PBKDF2 salt) and ticket (static tickets).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const configFile = process.argv[2] || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const home = process.env.FOX_WAMP_HOME || config.fox_wamp_home || __dirname;
const req = createRequire(path.join(path.resolve(home), 'package.json'));

const FoxRouter = req('fox-wamp');
const { WampGate } = req('fox-wamp/lib/wamp/gate');
const WampServer = req('fox-wamp/lib/wamp/transport');
const foxVersion = req('fox-wamp/package.json').version;

const host = process.env.FOX_WAMP_HOST || config.host || '127.0.0.1';
const port = Number(process.env.FOX_WAMP_PORT || config.port || 18290);
const anonymousRealms = new Set(config.anonymous_realms || ['realm1']);
const strictRealms = new Set(config.strict_realms || ['realm_auth']);
const wampcraUsers = config.wampcra || {};
const tickets = config.ticket || {};

function deriveKey(secret, salt, iterations, keylen) {
  return crypto.pbkdf2Sync(secret, salt, iterations, keylen, 'sha256').toString('base64');
}

// fox-wamp auth handler contract: getAuthMethods(), <method>_extra(realm, helloDetails, cb(err, challengeExtra)),
// <method>_auth(realm, helloDetails, signature, authenticateExtra, cb(err, userDetails)).
// helloDetails is the per-session HELLO.details object, so the pending CRA challenge is kept in a WeakMap on it.
const pendingChallenge = new WeakMap();
const authHandler = {
  getAuthMethods() {
    return ['wampcra', 'ticket'];
  },

  wampcra_extra(realmName, details, cb) {
    const user = wampcraUsers[details.authid];
    if (!user) return cb(new Error('no such user')); // fox-wamp -> ABORT wamp.error.no_auth_method
    const challenge = JSON.stringify({
      authid: details.authid,
      authrole: 'user',
      authmethod: 'wampcra',
      authprovider: 'static',
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: new Date().toISOString(),
    });
    const key = user.salt ? deriveKey(user.secret, user.salt, 1000, 32) : user.secret;
    pendingChallenge.set(details, { challenge, key });
    const extra = { challenge };
    if (user.salt) Object.assign(extra, { salt: user.salt, keylen: 32, iterations: 1000 });
    cb(undefined, extra);
  },

  wampcra_auth(realmName, details, signature, extra, cb) {
    const p = pendingChallenge.get(details);
    pendingChallenge.delete(details);
    if (!p || typeof signature !== 'string') return cb(new Error('authentication_failed'));
    const expected = crypto.createHmac('sha256', p.key).update(p.challenge).digest('base64');
    const ok =
      expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    ok ? cb(undefined, { role: 'user', authid: details.authid }) : cb(new Error('authentication_failed'));
  },

  ticket_auth(realmName, details, ticket, extra, cb) {
    const expected = tickets[details.authid];
    if (typeof expected === 'string' && typeof ticket === 'string' && expected === ticket) {
      return cb(undefined, { role: 'user', authid: details.authid });
    }
    cb(new Error('authentication_failed'));
  },
};

const router = new FoxRouter();
router.setLogTrace(process.env.FOX_WAMP_TRACE === '1' || config.trace === true);

const gate = new WampGate(router);
gate.setAuthHandler(authHandler);
const stockIsAuthRequired = gate.isAuthRequired.bind(gate);
gate.isAuthRequired = function (session) {
  const realm = session.realmName;
  const methods =
    session.secureDetails && Array.isArray(session.secureDetails.authmethods) ? session.secureDetails.authmethods : [];
  if (strictRealms.has(realm)) return stockIsAuthRequired(session); // always true: auth handler is set
  // anonymous_realms and every other (auto-created) realm: authenticate only if the client asked for a method
  // we support, otherwise welcome anonymously (HELLO without authmethods, or authmethods: ["anonymous"])
  return authHandler.getAuthMethods().some((m) => methods.includes(m));
};

const server = new WampServer(gate, { host, port });
server.on('listening', () => {
  console.error(
    `fox-wamp ${foxVersion} on node ${process.version}: ws://${host}:${port}/ ` +
      `(anonymous realms: ${[...anonymousRealms]}; strict realms: ${[...strictRealms]}; other valid realms anonymous)`,
  );
});

// fox-wamp throws asynchronously for e.g. invalid realm names; keep the test router alive and log it.
process.on('unhandledRejection', (e) => console.error('fox-wamp unhandledRejection:', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => console.error('fox-wamp uncaughtException:', e && e.stack ? e.stack : e));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
