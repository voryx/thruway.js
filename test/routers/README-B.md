# WAMP routers, group B: Bondy, Nexus and xconn nxt

This is a local, podman-only setup for thruway.js v3 integration and fuzz tests. It was verified on an arm64 podman machine (libkrun, podman 6.1.3) with Node 26.3.0 on 2026-10-25. Everything binds to `127.0.0.1:18100-18199` and the containers are named `v3b-*`.

| router             | version                                                                              | image                                                                                                        | WebSocket URL (`wamp.2.json`)          | RawSocket | ready in     | auth in realm1                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| **Bondy** (Erlang) | 1.0.0-rc.65 (2026-07-13), the latest tag                                             | `docker.io/leapsight/bondy:1.0.0-rc.65` (official, multi-arch)                                               | `ws://127.0.0.1:18100/ws` (only `/ws`) | 18102     | **15–16 s**  | anonymous, password (= static secret), wampcra (always salted), cryptosign, ticket (Bondy-issued JWT) |
| **Nexus** (Go)     | v3.3.1 (2026-10-14), the latest release; main 0ddca09 (2026-10-25) is also buildable | `localhost/thruway-nexus:{v3.3.1,main}`, built from `nexus/Containerfile` (nexus lib plus a static keystore) | `ws://127.0.0.1:18110/` (any path)     | 18111     | 0.45–0.55 s  | anonymous, ticket, wampcra (plain and salted), cryptosign. Also realm `realm1.strict`.                |
| Nexus stock        | nexusd v3.3.1                                                                        | `ghcr.io/gammazero/nexusd:v3.3.1` (official, multi-arch)                                                     | `ws://127.0.0.1:18115/`                | 18116     | about 0.35 s | anonymous only (nexusd's JSON config cannot do more)                                                  |
| **xconn nxt** (Go) | xconn-go 683389304fa4 (2026-10-23) = v0.1.1-0.20261023141601                         | `localhost/thruway-nxt:683389304fa4`, built from source                                                      | `ws://127.0.0.1:18120/ws` (any path)   | 18121     | about 0.5 s  | anonymous, ticket, wampcra (plain, and salted with a workaround), cryptosign                          |

The ready time is measured from `podman run` to the first WELCOME, with the images already local. Image builds take about 30 s for Nexus and about 20 s for nxt, on golang:1.27.3-alpine.

## Files

```
routers/
  smoke-b.mjs        zero-dep Node 22+ smoke test (global WebSocket, node:crypto)
  quirks-b.mjs       33-scenario edge-case probe, documents behaviour, never pass/fail
  bondy/             start.sh stop.sh etc/bondy.conf etc/security_config.json README.md
  nexus/             start.sh [v3.3.1|main|<ref>] start-stock.sh stop.sh main.go Containerfile
                     nexus-test.json nexusd.json README.md
  xconn-nxt/         start.sh [<xconn-go ref>] stop.sh Containerfile config/.nxt/config.yaml README.md
```

Each `start.sh` pulls or builds on first use, replaces any old container with the same name, and blocks until `smoke-b.mjs --probe` gets a WELCOME. It prints the version and the ready time in ms. Each `stop.sh` removes the container and keeps the image.

## Shared test credentials (realm `realm1`)

These are the same on every router, so a single test matrix works everywhere.

| authid       | method                                                            | secret                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| –            | anonymous                                                         | –                                                                                                                                                          |
| `ticketuser` | `ticket`, or `password` on Bondy                                  | `ticketsecret`                                                                                                                                             |
| `crauser`    | `wampcra`                                                         | `crasecret` (Bondy salts it itself)                                                                                                                        |
| `crasalted`  | `wampcra` salted (salt `thruwaysalt`, 1000 iterations, keylen 32) | `crasecret` (Nexus and nxt)                                                                                                                                |
| `csuser`     | `cryptosign`                                                      | ed25519 seed `93a276a0b622ce7c6dd077120550cd3524ec1eed5ebf8692c4a828da9fc15dd2`, pubkey `682a35e8c87f7004cbb10679617a29154f9906b7e29a64af3f6d3e8e10934701` |

## smoke-b.mjs

```
node smoke-b.mjs <url> <realm> [ticket] [authid] [--authid ID] [--ticket T] [--password P]
     [--wampcra SECRET] [--cryptosign SEED_HEX] [--authmethods a,b] [--bondy-ticket]
     [--random-ids] [--probe] [--strict-goodbye] [--timeout MS] [--quiet] [--json]
```

The script runs these steps:

1. HELLO, then CHALLENGE and AUTHENTICATE if the router asks, then WELCOME.
2. REGISTER, then a duplicate REGISTER.
3. CALL with `[2,3]`. The script answers its own INVOCATION with YIELD, and checks that the RESULT is `[5]`.
4. A progressive CALL.
5. A CALL to an unknown procedure.
6. SUBSCRIBE, then PUBLISH `{acknowledge, exclude_me:false}`. It waits for both PUBLISHED and EVENT.
7. PUBLISH with the default `exclude_me`.
8. UNSUBSCRIBE and UNREGISTER.
9. GOODBYE.

It prints every message (`->` and `<-`), a `welcome:` and `obs:` line, and `SUMMARY {json}` with `--json`. It exits non-zero on failure. If a GOODBYE reply is missing but the socket was closed, the run passes with a WARN. Pass `--strict-goodbye` to make that a failure.

**Result: 21 of 21 cases pass.** Nexus logs a GOODBYE WARN on almost every run. `realm1.strict --random-ids` is _expected_ to fail on `nexus/start.sh main`, and passes on v3.3.1, which has no strict mode.

## Cross-router behaviour (from quirks-b.mjs; details are in each README)

| behaviour                                          | Bondy rc.65                                                                  | Nexus v3.3.1 / main                                                            | nxt 6833893                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| GOODBYE reply                                      | yes, then close **1005**                                                     | **usually lost**, close **1006** (the queue is discarded on close)             | yes, then close **1006**                                               |
| ABORT delivered (auth failure, protocol violation) | yes, then 1005                                                               | **usually lost**, 1006                                                         | yes. After `no_such_realm` the socket stays **open**.                  |
| router-initiated GOODBYE that can be triggered     | `podman kill -s TERM` gives `wamp.close.system_shutdown`                     | `wamp.session.kill` works, but the victim only sees 1006                       | none (no meta API, shutdown gives 1006)                                |
| strict sequential request IDs                      | no                                                                           | opt-in `strict_request_ids`, **main only**                                     | no                                                                     |
| exclude_me (spec default true)                     | **ignored, always delivered**                                                | correct                                                                        | **ignored, always delivered**                                          |
| eligible / exclude lists                           | **broken**                                                                   | correct                                                                        | **ignored**                                                            |
| CANCEL                                             | default mode: ERROR typed **CANCEL(49)**. Explicit mode: **internal_error**. | correct (INTERRUPT with mode and reason, then `ERROR(CALL, canceled)`)         | correct                                                                |
| `timeout` call option                              | `wamp.error.timeout` after about 1.2 s for 500 ms, no INTERRUPT              | about 510 ms plus INTERRUPT                                                    | **ignored**                                                            |
| callee leaves mid-call                             | `no_eligible_callee`                                                         | `canceled`                                                                     | **caller hangs forever**                                               |
| progressive call results                           | **not supported** (the first progress YIELD becomes the final RESULT)        | yes                                                                            | yes (not advertised)                                                   |
| UNSUBSCRIBE of an unknown id                       | **connection crash, close 1011**                                             | `no_such_subscription`                                                         | **no reply**                                                           |
| URI validation                                     | `invalid_uri`                                                                | `invalid_uri`                                                                  | none                                                                   |
| pattern subscriptions                              | prefix and wildcard, with `details.topic`                                    | prefix and wildcard, with `details.topic`                                      | prefix works but **no `details.topic`**; wildcard did not match        |
| order on self-publish                              | EVENT before PUBLISHED                                                       | PUBLISHED before EVENT                                                         | EVENT before PUBLISHED                                                 |
| caller/publisher disclosure without `disclose_me`  | **always disclosed**                                                         | no                                                                             | no                                                                     |
| max WebSocket message                              | **4 MB** (close 1009)                                                        | 32 MiB or more OK                                                              | 32 MiB or more OK                                                      |
| subprotocol choice                                 | client order; json.batched too; none offered = reject                        | v3.3.1 **always json**; main uses client order; none offered = accepted        | client order; none offered = accepted                                  |
| WS path                                            | `/ws` only                                                                   | any                                                                            | any                                                                    |
| WELCOME `agent`                                    | `LEAPSIGHT-BONDY-1.0.0-rc.65`                                                | absent                                                                         | absent                                                                 |
| ID shapes                                          | random 53-bit                                                                | registration and subscription IDs small and sequential; publication IDs random | **all** small and sequential, including publication IDs                |
| cryptosign signature                               | 64 or 96 bytes; the challenge hex is UPPERCASE                               | **96 bytes required**; key looked up by authid                                 | **96 bytes required**; `authextra.pubkey` required                     |
| salted wampcra                                     | always (4096 iterations minimum)                                             | works                                                                          | **router bug** (verifies with the raw secret); worked around in config |
| static "ticket"                                    | **no**: use `password`. `ticket` means a Bondy-issued JWT.                   | yes                                                                            | yes                                                                    |

## What this means for the thruway.js v3 client and tests

- **Allocate request IDs sequentially per session, starting at 1, on one counter shared by PUBLISH, SUBSCRIBE, UNSUBSCRIBE, REGISTER, UNREGISTER and CALL.** v2 uses random IDs (`Utils.uniqueId`, which is `Math.random()*2^53` and can even return 0). The Nexus main strict realm kills such a session with no visible ABORT.
- Treat any transport close after the client sent GOODBYE as a successful leave. Use a short timeout for the GOODBYE reply, and do not reconnect. Handle close codes 1000, 1005 and 1006 the same way there.
- On Nexus, a router GOODBYE or ABORT usually arrives as a bare 1006, so the client cannot tell "kicked" from "network loss". Reconnect policy must not depend on seeing the GOODBYE. Use Bondy (`podman kill -s TERM`) or the group-A routers to test router-initiated GOODBYE handling deterministically.
- Every request needs a client-side timeout or cancellation path. On nxt, UNSUBSCRIBE of an unknown id gets no reply, a call hangs when its callee dies, and the `timeout` option is ignored.
- Match a caller's ERROR on `(CALL or CANCEL type, requestId)`, because Bondy replies to CANCEL with an ERROR typed 49.
- Cryptosign: send the 96-byte signature‖challenge, include `authextra.pubkey`, and decode hex case-insensitively.
- WAMP-CRA: if the CHALLENGE extra has a salt, derive the key with PBKDF2-SHA256(secret, salt as UTF-8 string, iterations or 1000, keylen or 32), base64-encode it, and use that base64 string as the HMAC key. All three routers match this.
- Never assume exclude_me works. Bondy and nxt deliver the publisher's own EVENTs, so local dispatch must tolerate them, or the client should filter on `details.publisher` when it is disclosed.
- Check `ws.protocol` after the upgrade, because Nexus v3.3.1 ignores the client's serializer order. Check `WELCOME.details.authmethod`, because Bondy can silently fall back to anonymous when `authid` is missing.
- Do not send UNSUBSCRIBE for a subscription id the client is unsure about (for example after a reconnect), because Bondy kills the connection with 1011.
- Keep fuzz payloads below 4 MB for Bondy, or raise `wamp.websocket.max_frame_size` in `bondy/etc/bondy.conf`.
