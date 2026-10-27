# Crossbar.io test router for thruway.js v3

This directory runs a local **Crossbar.io 26.10.1** router in podman so we can run integration tests and fuzz
tests against it. Everything here was run and checked on 2026-10-25 on the podman machine
`podman-machine-default` (libkrun, linux/arm64, podman 6.0.2 server, 6.1.3 client) with Node v26.3.0.

```sh
./start.sh                              # builds the image the first time (~1.5-2 min), then starts the router (~3.7 s)
node ../smoke.mjs ws://127.0.0.1:18080/ws realm1
node probe.mjs                          # ~75 s: advanced-feature, error-semantics and protocol-violation probe
./stop.sh                               # saves the container log to ./logs/, removes the container, keeps the image
```

| File | Purpose |
|---|---|
| `Containerfile` | Multi-arch image built from PyPI (`crossbar==26.10.1`, Python 3.12-slim-bookworm, `numpy<2`) |
| `config.json` | Node config: realms `realm1`/`realm2`, 4 roles, 3 transports, every auth method we test |
| `start.sh` / `stop.sh` | Lifecycle scripts (env knobs are listed at the top of `start.sh`) |
| `probe.mjs` | Zero-dependency probe that records how the router behaves for about 150 cases in 27 groups. It records what the router does; it does not assert an expected answer |
| `probe-results.json` / `.txt` | Output of the last full probe run against this image |
| `../smoke.mjs` | Router-agnostic smoke test (HELLO, auth, REGISTER/CALL, SUBSCRIBE/PUBLISH, GOODBYE) |

## Image

The official Docker Hub images are stale. The newest arm64 tag is `crossbario/crossbar:cpy-slim-arm64v8-22.7.1.dev1`
(2022-07), the newest amd64 tag is `cpy-slim-amd64-23.1.2` (2023-02), and `crossbario/crossbar-aarch64:latest`
is older still. The manifest for `crossbario/crossbar:latest` has no multi-arch list. PyPI is current, so we build
our own image:

| Component | Version |
|---|---|
| Crossbar.io | 26.10.1 ("Poke The Bear", 20261021-bd5784f; released 4 days before this test) |
| Autobahn / txaio / Twisted | 26.10.2 / 26.6.1 / 26.4.0 (EPollReactor) |
| Python | 3.12.15 CPython (`python:3.12-slim-bookworm`) |
| Codecs | JSON stdlib, msgpack 1.2.3, cbor2 6.1.5, UBJSON bjdata 0.6.6, FlatBuffers |
| Image | `localhost/thruway-crossbar:26.10.1`, linux/arm64, 497 MB, built in 75-130 s |

We pin `numpy<2` because without it every worker start prints a non-fatal `ImportError` traceback (the bjdata
wheel was compiled against NumPy 1.x). Use `CROSSBAR_VERSION=26.7.1 REBUILD=1 ./start.sh` to test another release.
Crossbar 26.x needs Python 3.11 or newer.

## Endpoints

All ports are published on 127.0.0.1 only and stay inside the 18000-18099 range.

| URL | Realms | Auth | Notes |
|---|---|---|---|
| `ws://127.0.0.1:18080/ws` | realm1, realm2 | anonymous | default endpoint; json/msgpack/cbor; 16 MiB max message |
| `ws://127.0.0.1:18080/auth` | realm1 | ticket, wampcra (plain and salted), cryptosign | no anonymous |
| `ws://127.0.0.1:18080/any` | realm1 | anonymous, ticket, wampcra, cryptosign | for authmethod negotiation tests |
| `ws://127.0.0.1:18080/ws-deflate` | realm1, realm2 | anonymous | permessage-deflate (Node's WebSocket negotiates `permessage-deflate; client_max_window_bits=13`) |
| `ws://127.0.0.1:18080/ws-ping` | realm1, realm2 | anonymous | router auto-ping every 1 s, 3 s timeout, **64 KiB max message and frame** |
| `ws://127.0.0.1:18081/<any path>` | realm1 | cryptosign, ticket | separate plain WebSocket transport (second port) |
| `tcp://127.0.0.1:18082` | realm1, realm2 | anonymous, ticket | WAMP RawSocket (json/msgpack/cbor). Verified: handshake `7f f1 00 00` gets the same bytes back |
| `http://127.0.0.1:18080/info` | | | nodeinfo HTML page; the readiness probe |

### Test credentials (test-only, committed on purpose)

| Method | authid | Secret | Role |
|---|---|---|---|
| ticket | `ticketuser` | `ticket-secret` | authenticated |
| ticket | `limited` | `limited-secret` | restricted (may only call and subscribe under `com.thruway.public.`) |
| ticket | `quiet` | `quiet-secret` | undisclosed (permissive, but the router never discloses caller or publisher) |
| wampcra | `crauser` | `cra-secret` | authenticated |
| wampcra (salted) | `crasalted` | password `salted-secret`, salt `thruway-salt`, iterations 1000, keylen 32 | authenticated |
| cryptosign | `csuser` (optional: the pubkey alone is enough) | seed `7468727577617921746573742d6b65792d666f722d63726f73736261722d3031`, pubkey `f41bb129ab45887291e77ea03eb5a0ed5318e87231fc12d46b54e2b2a66347f0` | authenticated |

### Realms and roles

- **realm1** uses `uri_check: loose`, so camelCase URIs are accepted. The session, registration and subscription
  meta API is enabled. It has an in-memory store with event history for the prefix subscription
  `com.thruway.history.` (limit 50). Roles:
  - `anonymous` and `authenticated`: allow everything, and disclose caller and publisher.
  - `undisclosed`: allow everything, disclose nothing.
  - `restricted`: may only call and subscribe under `com.thruway.public.`.
- **realm2** uses `uri_check: strict`, which only accepts `[0-9a-z_]` components. It has an `anonymous` role that
  allows everything and discloses nothing, and it has no store.

## Measured

- **Startup:** about 3.6-3.9 s from `podman run` until all three ports are listening and `/info` answers (the
  first runs, before the numpy pin, took 5.3-5.6 s). `./start.sh` takes about 5.6 s in total, including about 2 s
  for `crossbar check`; set `SKIP_CHECK=1` to skip that step. `podman restart` takes about 5.0 s until the router
  is ready again.
- **Resources and throughput:** about 220 MB RSS after the probe. One router worker handled about 6-8k pipelined
  calls per second (100 callers x 100 calls, or 500 callers x 20 calls), and 500 sessions joined in 0.8-0.9 s.
  The log level made no measurable difference to throughput.
- **Log volume:** `info` writes about 1-3 MB for one probe run, because it logs every session attach with full
  details. `warn` writes almost nothing. `trace` logs every WAMP message.

## Smoke test results (`../smoke.mjs`)

All of these passed (exit code 0). The last two cases are negative tests and failed as they should:

```
ws://127.0.0.1:18080/ws realm1 | realm2                          anonymous            PASS
ws://127.0.0.1:18080/auth realm1 ticket-secret ticketuser       ticket               PASS
ws://127.0.0.1:18080/auth realm1 --authid crauser --wampcra cra-secret         PASS
ws://127.0.0.1:18080/auth realm1 --authid crasalted --wampcra salted-secret    PASS (salted)
ws://127.0.0.1:18080/auth realm1 --authid csuser --cryptosign <seed>           PASS
ws://127.0.0.1:18080/any  realm1 (anonymous) and (crasalted wampcra)          PASS
ws://127.0.0.1:18081/     realm1 --cryptosign <seed> (no authid) | ticket      PASS
ws://127.0.0.1:18080/ws-ping realm1, /ws-deflate realm1                        PASS
/auth wrong ticket   -> ABORT wamp.error.not_authorized "ticket in static WAMP-Ticket authentication is invalid"
/auth wrong wampcra  -> ABORT wamp.error.not_authorized "WAMP-CRA client signature is invalid"
```

A full anonymous run takes about 20 ms from socket open to GOODBYE. The router messages from that run:

```
<- WELCOME      [2,80293504287503,{ ...see below... }]
<- REGISTERED   [65,1,8725667797024525]
<- INVOCATION   [68,1,8725667797024525,{"caller":80293504287503,"caller_authid":"QKU9-…","caller_authrole":"anonymous"},[2,3],{"greet":"hi"}]
<- RESULT       [50,2,{"callee":80293504287503,"callee_authid":"QKU9-…","callee_authrole":"anonymous"},[5],{"echo":"hi"}]
<- SUBSCRIBED   [33,3,1445354224256232]
<- PUBLISHED    [17,4,3722669165554914]
<- EVENT        [36,1445354224256232,3722669165554914,{"publisher":80293504287503,"publisher_authid":"QKU9-…","publisher_authrole":"anonymous"},["hello"],{"n":1}]
<- GOODBYE      [6,{},"wamp.close.normal"]
```

The authentication challenges look like this:

- ticket: `[4,"ticket",{}]`
- wampcra: `[4,"wampcra",{"challenge":"{\"authid\": \"crauser\", \"authrole\": \"authenticated\", \"authmethod\": \"wampcra\", \"authprovider\": \"static\", \"session\": 7544558030644604, \"nonce\": \"…\", \"timestamp\": \"2026-10-25T20:01:34.604Z\"}"}]`.
  Salted users also get `"salt":"thruway-salt","iterations":1000,"keylen":32` in the extra.
- cryptosign: `[4,"cryptosign",{"challenge":"<64 hex>","channel_binding":null}]`

## WELCOME (verbatim, realm1 anonymous)

```json
[2, 80293504287503, {
  "x_cb_node": "thruway_test_node", "x_cb_worker": "worker001", "x_cb_peer": "tcp4:192.168.127.1:19999", "x_cb_pid": 12,
  "realm": "realm1", "authid": "QKU9-M55G-4HE5-XURG-JRX5-X94R", "authrole": "anonymous",
  "authmethod": "anonymous", "authprovider": "static",
  "authextra": {"x_cb_node": "thruway_test_node", "x_cb_worker": "worker001", "x_cb_peer": "tcp4:192.168.127.1:19999", "x_cb_pid": 12},
  "roles": {
    "broker": {"features": {"publisher_identification": true, "pattern_based_subscription": true, "session_meta_api": true,
      "subscription_meta_api": true, "subscriber_blackwhite_listing": true, "publisher_exclusion": true,
      "subscription_revocation": true, "payload_transparency": true, "payload_encryption_cryptobox": true, "event_retention": true}},
    "dealer": {"features": {"caller_identification": true, "pattern_based_registration": true, "session_meta_api": true,
      "registration_meta_api": true, "shared_registration": true, "call_canceling": true, "progressive_call_results": true,
      "registration_revocation": true, "payload_transparency": true, "testament_meta_api": true, "payload_encryption_cryptobox": true}}
  }
}]
```

The router does **not** send an `agent` field. It does **not** advertise `call_timeout`,
`progressive_call_invocations`, `call_trustlevels` or `sharded_registration`, even though it implements call
timeouts in its own way (see quirk 6). It adds `x_cb_*` keys at the top level of the details and copies them into
`authextra`. Because of podman's gvproxy, `x_cb_peer` is the podman gateway address, not the client's address.

## Feature results (probe.mjs; full output in probe-results.txt)

| Feature | Result on Crossbar 26.10.1 |
|---|---|
| Progressive call results | Works. Progress RESULTs have `details.progress: true`; the final RESULT has no `progress` key. `INVOCATION.details.receive_progress: true` is forwarded to the callee. |
| Progressive call **invocations** | **Not supported** (see quirk 5). |
| Call canceling `kill` | The callee gets `INTERRUPT {mode:"kill"}`. The caller gets `ERROR wamp.error.canceled` (no args) only after the callee answers with ERROR. |
| Call canceling `killnowait` | `INTERRUPT {mode:"killnowait"}` and `ERROR wamp.error.canceled` are sent at the same moment (about 1 ms). |
| Call canceling `skip` | **Broken: nothing is sent at all** (see quirk 7). |
| A YIELD that arrives after a cancel | Dropped; it never reaches the caller. |
| Call timeout | Works only with its own semantics (see quirk 6). |
| Shared registrations | `roundrobin` gave ABABAB, `first` AAAAAA, `last` BBBBBB, `random` worked. Both callees get the same registration id. Mixing policies gives `wamp.error.procedure_exists_with_different_invocation_policy`. A second `single` registration of the same URI gives `wamp.error.procedure_already_exists`, also when it comes from the same session. |
| Pattern-based registration | `prefix` and `wildcard` work. Precedence is exact, then longest prefix, then wildcard. `INVOCATION.details.procedure` is present only when a pattern matched. |
| Pattern-based subscription | `prefix` and `wildcard` work, and `EVENT.details.topic` is set. One publish delivers one EVENT per matching subscription. |
| Event retention | `PUBLISH {retain:true}` followed by `SUBSCRIBE {get_retained:true}` delivers the latest event with `details.retained: true`. Without `get_retained` nothing is delivered. |
| Publisher exclusion / black and white listing | `exclude_me` defaults to true. `exclude`, `eligible`, `exclude_authid` and `eligible_authrole` all work. |
| Caller and publisher disclosure | Decided only by the role's `disclose` setting. `disclose_me: true` is silently ignored. When disclosure is on, the router also adds `callee`, `callee_authid` and `callee_authrole` to RESULT details. |
| Session meta API | `wamp.session.count`, `list`, `get`, `kill`, `kill_by_authid` and the events `on_join` / `on_leave` work. `count` and `list` leave out router-internal sessions. `on_leave` args are `[session_id]`. |
| Registration and subscription meta API | `list`, `lookup`, `match`, `get`, `list_callees`/`list_subscribers` and `count_*` work. Looking up an unknown URI returns `[null]`; getting an unknown id returns `wamp.error.no_such_registration`. |
| Testament | `wamp.session.add_testament(topic, args, kwargs)` fires on an abrupt close **and on a clean GOODBYE**. `flush_testaments` works. The testament EVENT has no `publisher` session id, only `publisher_authid` and `publisher_authrole`. |
| Event history | `wamp.subscription.get_events(subId, limit)` works, but only for a subscription whose URI and match policy are exactly the configured `event-history` entry. Every other subscription gets `wamp.error.history_unavailable`. Results are newest first, shaped as `{time_ns, realm, session_id, authid, authrole, publication, topic, args, kwargs}`. |
| Subprotocols | `wamp.2.json`, `wamp.2.msgpack`, `wamp.2.cbor` and the **batched variants** (`wamp.2.json.batched`, `wamp.2.msgpack.batched`) are accepted. `wamp.2.ubjson` is rejected because it is not in this config's serializer list. The router picks the first entry in the client's list (`['wamp.2.msgpack','wamp.2.json']` gives msgpack, `['wamp.2.json','wamp.2.cbor']` gives json). With no subprotocol or an unknown one, the handshake is rejected (the client sees close 1006). |
| Router keepalive | The router pings every 1 s on `/ws-ping`. Node's native WebSocket answers pings automatically, and the session was still up after 4.5 s. Crossbar requires `auto_ping_size` to be between 12 and 125. |
| permessage-deflate | Works with Node 26's native WebSocket (`/ws-deflate`). |
| RawSocket | Works (port 18082). |

## Quirks and bugs that matter for the v3 client

Numbers 6, 7, 8, 9 and 10 are Crossbar bugs or spec deviations that would make a naive client hang or lose its
session.

1. **GOODBYE.** The router answers a client GOODBYE with `wamp.close.normal`, not `wamp.close.goodbye_and_out`,
   and then **leaves the WebSocket open**. The client must close it. The same applies to a router-initiated GOODBYE
   from `wamp.session.kill`: it sends `[6,{"message":"…"},"<reason>"]`, the default reason is `wamp.close.normal`,
   and `kill_by_authid` uses `wamp.close.killed`. After the client replies with GOODBYE, the socket still stays
   open. After a GOODBYE the same socket accepts a new HELLO and gets a new WELCOME; any other message is silently
   ignored.
2. **ABORT does not close the transport.** A HELLO on the same socket after an ABORT gets a WELCOME. HELLO
   failures: an unknown realm gives `wamp.error.no_such_realm`, and a missing authmethod gives
   `wamp.error.no_auth_method`. A bad ticket, unknown authid, bad CRA signature or bad cryptosign signature all
   give `wamp.error.not_authorized`; the router never uses `authentication_failed`. The reason text is in
   `details.message`. A HELLO without `authmethods` is treated as anonymous. The router picks the first method in
   the client's `authmethods` list that the transport offers.
3. **Protocol violations close the socket without an ABORT.** The router closes with code 1002 and a reason of
   `"WAMP Protocol Error (…)"`. It never sends `ABORT wamp.error.protocol_violation`. Triggers we saw:
   - an unknown message type, or a router-only message sent by the client
   - wrong arity, or the wrong type for `args`, `kwargs` or `options`
   - a non-bool `receive_progress` or `acknowledge`
   - a float `timeout`
   - an unknown `match`, `invoke` or cancel `mode`
   - a negative request id
   - malformed JSON, a top-level value that is not an array, or a binary frame on `wamp.2.json`
   - `roles: {}` in HELLO
   - a YIELD for an invocation that belongs to another session

   A HELLO whose realm is not a string closes with 1011. A message larger than `max_message_size` closes with 1009.
4. **Some violations are silently ignored:**
   - a second HELLO inside an established session
   - CALL or GOODBYE before HELLO
   - YIELD or ERROR for an unknown invocation id
   - CANCEL for an unknown call
   - unknown options (for example `x_foo`)

   Request ids `0` and `2^53` are accepted, although the spec range is 1 to 2^53. Duplicate in-flight CALL request
   ids are accepted and the caller gets two RESULTs with the same id. The v3 client must never reuse a request id.
   AUTHENTICATE without a CHALLENGE gets `ABORT wamp.error.not_authorized "no pending authentication"`.
5. **No progressive call invocations.** Each `CALL {progress:true}` that reuses a request id becomes a separate
   invocation: the callee sees different invocation ids and no progress flag, and the caller gets one RESULT per
   CALL. v3 must turn this feature on only when `dealer.features.progressive_call_invocations` is advertised.
   The router also passes on progressive YIELDs to a caller that did not ask for `receive_progress`, so the client
   must tolerate unexpected progress RESULTs.
6. **The call timeout is in seconds, not milliseconds, and is not advertised.** The router reads
   `CALL.options.timeout` as **seconds** and only accepts an integer (a float closes the connection with 1002). It
   fires with about 1 s granularity: `timeout:1` fired after about 0.7 s and `timeout:2` after about 1.8 s, so
   `timeout:1500` means 25 minutes. When it fires, the caller gets `ERROR wamp.error.canceled ["timeout reached"]`
   (not `wamp.error.timeout`) and the callee gets `INTERRUPT {mode:"killnowait"}`. The value is also passed on in
   `INVOCATION.details.timeout`. v3 should keep its timeouts on the client side and only send `options.timeout`
   when the router advertises `call_timeout`. Crossbar does not, so v3 should never send it there.
7. **The `skip` cancel mode hangs forever.** For `skip` the dealer marks the call as canceled and sends nothing:
   no ERROR to the caller and no INTERRUPT to the callee. A later YIELD is dropped. If the callee did not announce
   `callee.features.call_canceling`, Crossbar turns every cancel into `skip`, so that cancel hangs too. v3 should
   reject `skip` cancels locally right away, and should default to `killnowait` or `kill`.
8. **Invalid URIs kill the whole connection.** CALL, PUBLISH or REGISTER with an invalid URI (for example
   `com..bad`, `com.bad uri`, `com.bad#x`, an empty URI, or `com..x` with exact match) closes the WebSocket with
   **1011 "WAMP Internal Error"**. The router does not reply with `ERROR wamp.error.invalid_uri`. Only SUBSCRIBE
   returns `ERROR invalid_uri`. The same thing happens when a callee answers an INVOCATION with an invalid error
   URI: the callee's connection closes with 1011 and the caller gets `wamp.error.canceled "callee disconnected
   from in-flight request"`. v3 must check URIs locally before sending. The loose rule is
   `^([^\s\.#]+\.)*([^\s\.#]+)$`; empty components are allowed only with `match: wildcard`. The strict rule (realm2)
   is `[0-9a-z_]` per component. Strict-mode errors and the reserved `wamp.` prefix (REGISTER or PUBLISH) give a
   normal `ERROR wamp.error.invalid_uri`. Subscribing to `wamp.session.on_join` is allowed.
9. **Registrations can leak and become ghosts.** If the caller and the callee of an in-flight call disconnect at
   nearly the same time (in either order), `dealer.detach()` tries to send ERROR or INTERRUPT to the peer that has
   already gone. It raises `autobahn.exception.Disconnected` and stops halfway (the log says `Failed to detach
   session … Attempt to send on a closed protocol`, dealer.py:225 and :261). The registration stays behind with
   callee `null`. After that, **CALLs to it get no answer at all**, and REGISTER returns
   `procedure_already_exists` until the router restarts. The probe group `registration_leak_race` reproduced this
   in 3 of 6 attempts. For the fuzz suite this means:
   - use a unique URI for every test
   - give every call a client-side timeout
   - when a test kills sessions, restart the router between suites
   - do not blame the client for these hangs
10. **Lone surrogates and non-finite numbers.** A payload that contains a lone surrogate (`"\ud800"`, which
    `JSON.stringify` happily emits) makes Crossbar fail to serialize the INVOCATION. It logs `Unhandled error in
    Deferred` and **drops the call silently**, so the caller hangs. Python's json also accepts `1e400` and `NaN`
    and sends them on as `Infinity` and `NaN`, which are not valid JSON, so `JSON.parse` in the receiving client
    throws. v3 must survive frames it cannot parse (close with a protocol error, do not crash). Integers keep
    their exact value (`18446744073709551615` and `-9223372036854775808` round-trip unchanged), which JS cannot
    represent beyond 2^53. Duplicate object keys: the last one wins. `1.0` stays `1.0`.
11. **Empty payload elements are removed.** YIELD `[70,id,{},[],{}]` arrives as `[50,id,{details}]`, with no args
    element at all. When there are only kwargs, the router keeps the `[]` placeholder.
12. **A dropped callee or caller.** If the callee disconnects during a call, the caller gets
    `ERROR wamp.error.canceled ["callee disconnected from in-flight request"]`. If the caller disconnects, the
    callee gets `INTERRUPT {mode:"killnowait"}`.
13. **Router shutdown.** Both `podman stop` (SIGTERM) and SIGKILL drop clients with **close 1006** and no
    `GOODBYE wamp.close.system_shutdown`. Reconnect logic has to treat 1006 as the normal "router went away" case.
14. **Meta API bugs that come with a realm store.** With a memory store configured (realm1), calling
    `wamp.session.get(<unknown id>)` returns `wamp.error.runtime_error "'RealmStoreMemory' object has no attribute
    'get_session_by_session_id'"`. Without a store (realm2) it correctly returns `wamp.error.no_such_session`.
    Calling `wamp.subscription.list_subscribers` on the history observation also gives `runtime_error`. Meta
    procedure RESULTs show the callee as the router service session (`callee_authrole: "trusted"`).
15. **Authentication details:**
    - WAMP-CRA: the challenge is a JSON string written with Python's separators (`", "` and `": "`), so sign the
      exact string you received. For salted users the router config holds the plain password, and `salt`,
      `iterations` and `keylen` must all be set. The HMAC key is the **base64 text** of
      PBKDF2-HMAC-SHA256(password, salt, iterations, keylen).
    - cryptosign: AUTHENTICATE must be `hex(signature64 ‖ challenge32)`, that is 192 hex characters. A bare 64-byte
      signature is rejected with `"signed message has invalid length (was 64, but should have been 96)"`. The
      `HELLO.authextra.pubkey` field is required; `authid` is optional. Node 22+ can sign without libraries:
      `crypto.sign(null, challenge, ed25519Key)`. See `../smoke.mjs`.
16. **Config pitfalls** (these only matter if you edit config.json):
    - The controller `id` must match `^[a-z][a-z0-9_]{2,63}$`.
    - A `nodeinfo` service at a web transport's `/` path takes over **all** child paths, so `/ws` returns HTML.
      That is why `/` is a `json` service here; it returns 404 for `/` itself, which is harmless.
    - Realm options are limited to `uri_check`, `enable_meta_api`, `bridge_meta_api` and
      `event_dispatching_chunk_size`. `uri_check` defaults to **strict**.

## Tips for fuzzing and integration tests

- **Unresponsive router:** `podman pause thruway-crossbar` freezes the router while TCP stays established.
  Traffic is buffered and delivered after `podman unpause`. Use this to test heartbeats, client-side call timeouts
  and stalled-socket handling.
- **Router loss:** `podman kill -s KILL thruway-crossbar` or `podman stop`, then `podman start thruway-crossbar`.
  Clients see close 1006, and the router is ready again about 4-5 s later.
- **Clean slate:** run `./stop.sh && SKIP_CHECK=1 ./start.sh` (about 4 s) between suites, because of the leaked
  registrations from quirk 9 and leftover retained-event subscriptions.
- **Error paths:** use `/ws-ping` for oversize-frame tests (64 KiB limit, close 1009). Use realm2 for strict-URI
  `invalid_uri` errors that do not kill the session. Use the `limited` ticket user for
  `wamp.error.not_authorized`. An unacknowledged PUBLISH that is not authorized is dropped silently.
- **Debugging:** `LOGLEVEL=trace ./start.sh` logs every WAMP message on the router side. `./stop.sh` always saves
  the container log to `./logs/crossbar-<timestamp>.log` (set `KEEP_LOGS=0` to skip that).
- **Router-agnostic probe:** `probe.mjs --base ws://127.0.0.1:<port> --realm realm1 [--only a,b] [--json out.json]
  [--verbose]` is not tied to Crossbar. It expects the same paths and credentials: `/ws` anonymous, and `/auth`
  with the ticket users above.
