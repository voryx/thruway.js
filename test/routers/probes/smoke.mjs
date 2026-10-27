#!/usr/bin/env node
// WAMP v2 router smoke test. Zero dependencies: Node 22+ (global WebSocket,
// node:crypto). Speaks the 'wamp.2.json' subprotocol.
//
// Flow: HELLO -> (CHALLENGE -> AUTHENTICATE) -> WELCOME, REGISTER, CALL it
// (answering the INVOCATION with YIELD), SUBSCRIBE + PUBLISH(acknowledge,
// exclude_me:false) and wait for both PUBLISHED and EVENT, then GOODBYE.
// Every router message is printed as '<-'; every client message as '->'.
//
// Usage:
//   node smoke.mjs <url> <realm> [ticket] [authid]
//   node smoke.mjs <url> <realm> [--authid ID] [--ticket T] [--wampcra SECRET]
//                  [--cryptosign SEED_HEX] [--authmethods a,b] [--timeout MS] [--quiet]
//
// Examples:
//   node smoke.mjs ws://127.0.0.1:18080/ws realm1
//   node smoke.mjs ws://127.0.0.1:18080/auth realm1 ticket-secret ticketuser
//   node smoke.mjs ws://127.0.0.1:18080/auth realm1 --authid crauser --wampcra cra-secret
//   node smoke.mjs ws://127.0.0.1:18080/auth realm1 --authid csuser --cryptosign <64 hex chars>
//
// Exit code 0 on success, 1 on any failure (ABORT, ERROR, timeout, socket close).

import crypto from 'node:crypto';

const T = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  CHALLENGE: 4,
  AUTHENTICATE: 5,
  GOODBYE: 6,
  ERROR: 8,
  PUBLISH: 16,
  PUBLISHED: 17,
  SUBSCRIBE: 32,
  SUBSCRIBED: 33,
  UNSUBSCRIBE: 34,
  UNSUBSCRIBED: 35,
  EVENT: 36,
  CALL: 48,
  CANCEL: 49,
  RESULT: 50,
  REGISTER: 64,
  REGISTERED: 65,
  UNREGISTER: 66,
  UNREGISTERED: 67,
  INVOCATION: 68,
  INTERRUPT: 69,
  YIELD: 70,
};
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

function parseArgs(argv) {
  const pos = [];
  const o = { timeout: 10000, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === 'quiet') {
      o.quiet = true;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) throw new Error(`missing value for ${a}`);
    o[key] = key === 'timeout' ? Number(val) : val;
  }
  if (pos.length < 2) {
    console.error(
      'usage: node smoke.mjs <url> <realm> [ticket] [authid] [--authid ID] [--ticket T] ' +
        '[--wampcra SECRET] [--cryptosign SEED_HEX] [--authmethods a,b] [--timeout MS] [--quiet]',
    );
    process.exit(2);
  }
  o.url = pos[0];
  o.realm = pos[1];
  if (pos[2] !== undefined && o.ticket === undefined) o.ticket = pos[2];
  if (pos[3] !== undefined && o.authid === undefined) o.authid = pos[3];
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const t0 = performance.now();
const ms = () => `${(performance.now() - t0).toFixed(1).padStart(7)}ms`;
const show = (dir, msg) => {
  if (opts.quiet) return;
  const name = NAME[msg[0]] ?? `?${msg[0]}`;
  console.log(`${ms()} ${dir} ${name.padEnd(12)} ${JSON.stringify(msg)}`);
};

// ---- auth helpers ----------------------------------------------------------
function ed25519FromSeed(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) throw new Error('cryptosign seed must be 32 bytes (64 hex chars)');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, pubkeyHex: pub.toString('hex') };
}

function wampcraSignature(secret, extra) {
  let key = secret;
  if (extra.salt !== undefined) {
    // autobahn derive_key: base64(PBKDF2-HMAC-SHA256(secret, salt, iterations, keylen)); the
    // base64 *text* (not the raw bytes) is then used as the HMAC key.
    key = crypto
      .pbkdf2Sync(secret, extra.salt, extra.iterations ?? 1000, extra.keylen ?? 32, 'sha256')
      .toString('base64');
  }
  return crypto.createHmac('sha256', key).update(extra.challenge).digest('base64');
}

let authmethods = opts.authmethods ? opts.authmethods.split(',') : [];
let cs = null;
if (!opts.authmethods) {
  if (opts.ticket !== undefined) authmethods.push('ticket');
  if (opts.wampcra !== undefined) authmethods.push('wampcra');
  if (opts.cryptosign !== undefined) authmethods.push('cryptosign');
  if (authmethods.length === 0) authmethods.push('anonymous');
}
if (opts.cryptosign !== undefined) cs = ed25519FromSeed(opts.cryptosign);

// ---- transport -------------------------------------------------------------
const inbox = [];
let waiter = null;
let closed = null;

const ws = new WebSocket(opts.url, ['wamp.2.json']);
const send = (msg) => {
  show('->', msg);
  ws.send(JSON.stringify(msg));
};

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
  } catch (e) {
    console.error(`${ms()} <- unparseable frame: ${String(ev.data).slice(0, 200)}`);
    return;
  }
  show('<-', msg);
  inbox.push(msg);
  if (waiter) waiter();
});
ws.addEventListener('close', (ev) => {
  closed = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
  if (!opts.quiet) console.log(`${ms()} -- socket closed code=${ev.code} reason=${JSON.stringify(ev.reason)}`);
  if (waiter) waiter();
});
ws.addEventListener('error', (ev) => {
  if (!opts.quiet) console.log(`${ms()} -- socket error ${ev.message ?? ev.error?.message ?? ''}`);
});

/** Wait for (and remove) the first inbox message matching pred. Fails on ABORT/ERROR/close/timeout. */
function expect(pred, what, timeout = opts.timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiter = null;
      reject(new Error(`timeout waiting for ${what}`));
    }, timeout);
    const check = () => {
      const i = inbox.findIndex(pred);
      if (i >= 0) {
        const [m] = inbox.splice(i, 1);
        clearTimeout(timer);
        waiter = null;
        resolve(m);
        return;
      }
      const bad = inbox.find((m) => m[0] === T.ABORT || m[0] === T.ERROR || (m[0] === T.GOODBYE && what !== 'GOODBYE'));
      if (bad) {
        clearTimeout(timer);
        waiter = null;
        reject(new Error(`router sent ${NAME[bad[0]]} while waiting for ${what}: ${JSON.stringify(bad)}`));
        return;
      }
      if (closed) {
        clearTimeout(timer);
        waiter = null;
        reject(new Error(`socket closed (${closed.code}) while waiting for ${what}`));
      }
    };
    waiter = check;
    check();
  });
}

let nextId = 1;
const id = () => nextId++;

async function main() {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('close', () => reject(new Error(`socket closed before open (code ${closed?.code})`)), {
      once: true,
    });
  });
  if (!opts.quiet) console.log(`${ms()} -- open ${opts.url} subprotocol=${JSON.stringify(ws.protocol)}`);
  if (ws.protocol !== 'wamp.2.json')
    throw new Error(`router did not select wamp.2.json (got ${JSON.stringify(ws.protocol)})`);

  // 1. HELLO
  const details = {
    agent: 'thruway-smoke/3.0',
    roles: {
      caller: {
        features: {
          progressive_call_results: true,
          call_canceling: true,
          call_timeout: true,
          caller_identification: true,
        },
      },
      callee: {
        features: {
          progressive_call_results: true,
          progressive_call_invocations: true,
          call_canceling: true,
          call_timeout: true,
          caller_identification: true,
          shared_registration: true,
          pattern_based_registration: true,
        },
      },
      publisher: {
        features: { publisher_exclusion: true, publisher_identification: true, subscriber_blackwhite_listing: true },
      },
      subscriber: { features: { pattern_based_subscription: true, publisher_identification: true } },
    },
    authmethods,
  };
  if (opts.authid !== undefined) details.authid = opts.authid;
  if (cs) details.authextra = { pubkey: cs.pubkeyHex };
  send([T.HELLO, opts.realm, details]);

  let m = await expect((x) => x[0] === T.WELCOME || x[0] === T.CHALLENGE, 'WELCOME/CHALLENGE');
  if (m[0] === T.CHALLENGE) {
    const [, method, extra] = m;
    let signature;
    if (method === 'ticket') {
      if (opts.ticket === undefined) throw new Error('router asked for ticket but no --ticket given');
      signature = opts.ticket;
    } else if (method === 'wampcra') {
      if (opts.wampcra === undefined) throw new Error('router asked for wampcra but no --wampcra given');
      signature = wampcraSignature(opts.wampcra, extra);
    } else if (method === 'cryptosign') {
      if (!cs) throw new Error('router asked for cryptosign but no --cryptosign given');
      const challenge = Buffer.from(extra.challenge, 'hex');
      const sig = crypto.sign(null, challenge, cs.privateKey);
      signature = Buffer.concat([sig, challenge]).toString('hex'); // autobahn format: sig(64) || challenge(32)
    } else {
      throw new Error(`unsupported challenge method ${method}`);
    }
    send([T.AUTHENTICATE, signature, {}]);
    m = await expect((x) => x[0] === T.WELCOME, 'WELCOME');
  }
  const [, sessionId, welcome] = m;
  console.log(
    `${ms()} OK WELCOME session=${sessionId} authid=${welcome.authid} authrole=${welcome.authrole} authmethod=${welcome.authmethod} authprovider=${welcome.authprovider}`,
  );

  // 2. REGISTER + CALL
  const proc = `com.thruway.smoke.add.${sessionId}`;
  let req = id();
  send([T.REGISTER, req, {}, proc]);
  m = await expect((x) => x[0] === T.REGISTERED && x[1] === req, 'REGISTERED');
  const regId = m[2];

  const callReq = id();
  send([T.CALL, callReq, {}, proc, [2, 3], { greet: 'hi' }]);
  m = await expect((x) => x[0] === T.INVOCATION && x[2] === regId, 'INVOCATION');
  const [, invReq, , , invArgs = [], invKw = {}] = m;
  send([T.YIELD, invReq, {}, [invArgs[0] + invArgs[1]], { echo: invKw.greet }]);
  m = await expect((x) => x[0] === T.RESULT && x[1] === callReq, 'RESULT');
  if (m[3]?.[0] !== 5 || m[4]?.echo !== 'hi') throw new Error(`unexpected RESULT payload ${JSON.stringify(m)}`);
  console.log(`${ms()} OK RPC round trip ${JSON.stringify(m.slice(3))}`);

  // 3. SUBSCRIBE + PUBLISH(acknowledge, exclude_me:false)
  const topic = `com.thruway.smoke.topic.${sessionId}`;
  req = id();
  send([T.SUBSCRIBE, req, {}, topic]);
  m = await expect((x) => x[0] === T.SUBSCRIBED && x[1] === req, 'SUBSCRIBED');
  const subId = m[2];

  const pubReq = id();
  send([T.PUBLISH, pubReq, { acknowledge: true, exclude_me: false }, topic, ['hello'], { n: 1 }]);
  const published = await expect((x) => x[0] === T.PUBLISHED && x[1] === pubReq, 'PUBLISHED');
  const event = await expect((x) => x[0] === T.EVENT && x[1] === subId, 'EVENT');
  if (event[2] !== published[2]) throw new Error(`EVENT publication id ${event[2]} != PUBLISHED ${published[2]}`);
  console.log(`${ms()} OK PubSub publication=${published[2]} event=${JSON.stringify(event.slice(4))}`);

  // 4. GOODBYE
  send([T.GOODBYE, {}, 'wamp.close.close_realm']);
  m = await expect((x) => x[0] === T.GOODBYE, 'GOODBYE');
  console.log(`${ms()} OK GOODBYE reason=${m[2]}`);
  ws.close(1000);
  const leftovers = inbox.filter((x) => x[0] !== T.GOODBYE);
  if (leftovers.length) console.log(`${ms()} NOTE unconsumed messages: ${JSON.stringify(leftovers)}`);
  console.log(`${ms()} SMOKE PASS ${opts.url} realm=${opts.realm} authmethods=${authmethods.join(',')}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`${ms()} SMOKE FAIL ${err.message}`);
    try {
      ws.close();
    } catch {}
    process.exit(1);
  },
);
