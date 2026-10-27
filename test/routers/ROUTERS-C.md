# Routers group C: Thruway (PHP), fox-wamp, wamp-server

Every behaviour listed here was observed on the wire on 2026-10-25, using Node v26.3.0 with its native global
WebSocket, and podman 6.1.3 with a libkrun arm64 machine. The probe outputs are recorded in `test/fixtures/probes/`.

## Files

| path           | what                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thruway-php/` | Dockerfile, composer.json/.lock, router.php, config.json, start.sh/stop.sh and README.md. Image `localhost/thruwayjs-router-thruway-php:0.6.1`, container `thruwayjs-thruway-php`.                                                                                                                                                                                                                              |
| `fox-wamp/`    | package.json/lock (fox-wamp 0.7.28), router.cjs, config.json, start.sh/stop.sh and README.md. Installed into `tmp-routers-c/fox-wamp`.                                                                                                                                                                                                                                                                          |
| `wamp-server/` | package.json/lock (wamp-server 0.0.9), router.cjs, start.sh/stop.sh and README.md. Hostile-router use only.                                                                                                                                                                                                                                                                                                     |
| `smoke-c.mjs`  | `node smoke-c.mjs <url> <realm> [authid secret] [--ticket] [--authmethods=..] [--strict] [--quiet]`. Opens 2 sessions and runs HELLO→(CHALLENGE→AUTHENTICATE)→WELCOME, REGISTER, CALL/INVOCATION/YIELD/RESULT, SUBSCRIBE, PUBLISH{acknowledge}→PUBLISHED+EVENT, UNSUBSCRIBE, UNREGISTER and GOODBYE, printing every frame. Exit 0 means ok.                                                                     |
| `probe-c.mjs`  | Router-agnostic prober (anonymous realm): `node probe-c.mjs <url> <realm> [--only=a,b] [--json=f] [--verbose]`. Its 62 probes cover the handshake, protocol violations, request-id validation, URIs, payload fidelity, cancel modes, timeouts, shared and pattern registrations, pattern and retained subscriptions, meta API and events, and auth edge cases. It also works against the other groups' routers. |

## Endpoints and credentials

All endpoints are bound to 127.0.0.1 and use the `wamp.2.json` subprotocol.

| router                 | url                   | realms                                                                                                      |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Thruway auth           | ws://127.0.0.1:18280/ | `realm1` (anonymous, wampcra, ticket), `realm-auth` (wampcra or ticket required), any other realm anonymous |
| Thruway noauth (stock) | ws://127.0.0.1:18281/ | any realm, anonymous; WELCOME echoes the HELLO details                                                      |
| fox-wamp               | ws://127.0.0.1:18290/ | `realm1` (anonymous, wampcra, ticket), `realm_auth` (auth required); names must match `^[a-z0-9_]+$`        |
| wamp-server            | ws://127.0.0.1:18295/ | `realm1` only, anonymous                                                                                    |

The credentials are the same everywhere:

- WAMP-CRA `joe` / `secret2`.
- WAMP-CRA `peter` / `secret1`, salted with `salt123`, 1000 iterations, keylen 32. The key is
  base64(PBKDF2-SHA256), and that base64 string is the HMAC key.
- Ticket `ticketuser` / `ticketsecret`.

Thruway 0.6.1 has no ticket provider of its own. `router.php` adds a minimal one built on
`AbstractAuthProviderClient`, and `LenientAuthenticationManager` allows anonymous logins on `realm1`.

## Versions

| router      | version                                                      | notes                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thruway     | voryx/thruway **0.6.1** (= dev-master, last release 2022-02) | Runs on PHP 8.3.35, with thruway/ratchet-transport 0.5.0, cboden/ratchet 0.4.4, ratchet/rfc6455 0.3.1, react/event-loop 1.6.0, thruway/client 0.5.8 and voryx/thruway-common 1.0.6. `guzzlehttp/psr7` 1.9.1 is pinned with its advisories ignored (test only). |
| fox-wamp    | **0.7.28** (2025-08)                                         | Runs with ws 8.22.0 and qlobber 3.1.0. Installed with `--ignore-scripts`, because the sqlite3 native module is not needed.                                                                                                                                     |
| wamp-server | **0.0.9** (2018)                                             | Runs with ws 6.0.0                                                                                                                                                                                                                                             |

### Other npm routers considered

None of these were installed. Judging from registry metadata, they are obsolete:

- wamp.rt 0.2.0 (2016, ws 0.8.0)
- wamp-router 0.1.5 (2015)
- nodewamp 0.1.8 (2016)
- linejs 0.1.1 (2014)
- wamp-server-fix (a fork)
- fastify-wamp-router 0.4.0 (2019; a fastify plugin)

"kalmyk" is the author of fox-wamp and has no separate package; "wamprt" does not exist on npm. **fox-wamp is
the only maintained Node.js router.**

## WELCOME roles and features

| router      | WELCOME.details                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thruway     | `broker:{subscriber_blackwhite_listing, publisher_exclusion, subscriber_metaevents}` and `dealer:{caller_identification, progressive_call_results}`. Anonymous sessions on the auth router get `{roles}` only. Authenticated sessions also get `authid`, `authrole` ("user"), `authroles` (an array), `authmethod` and `authprovider`. The stock noauth router echoes the client's HELLO details, including any spoofed authid or authrole, plus a `transport` object with all HTTP headers. |
| fox-wamp    | `realm`, `authmethod`, and `roles:{broker:{session_meta_api, publisher_exclusion}, dealer:{session_meta_api, progressive_call_results}}`. After auth it adds `authid`. There is **never an authrole or authprovider**.                                                                                                                                                                                                                                                                       |
| wamp-server | `roles:{broker:{}, dealer:{}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Feature matrix (observed)

|                         | Thruway                                                                    | fox-wamp                                                                                           | wamp-server                                                             |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| progressive results     | yes; unrequested progress is dropped                                       | yes; unrequested progress is forwarded                                                             | no; the first progress YIELD becomes the final RESULT                   |
| cancel                  | partial; see quirks T1–T3                                                  | **ignored (hang)**                                                                                 | the CANCEL kills the session (GOODBYE + close 1005)                     |
| call timeout option     | no                                                                         | no                                                                                                 | no; it is only forwarded in INVOCATION.details                          |
| shared registration     | `invoke`: single, roundrobin, random, first, last                          | implicit: duplicates always accepted, `invoke` ignored, first available wins, option `concurrency` | no (`procedure_already_exists`)                                         |
| pattern registration    | no; prefix is silently treated as exact                                    | no; ignored                                                                                        | no; ignored                                                             |
| pattern subscription    | prefix only (character-based, `details.topic`); **wildcard gets NO reply** | `match` ignored; `*` and `#` work inside the URI                                                   | no                                                                      |
| retained events         | no                                                                         | custom `retain` / `retained`; a retained subscription gets no live events                          | no                                                                      |
| exclude_me              | yes                                                                        | yes                                                                                                | the publisher is always excluded (`exclude_me:false` ignored)           |
| eligible / exclude      | yes                                                                        | no                                                                                                 | no                                                                      |
| publisher disclosure    | never                                                                      | always (`details.publisher`)                                                                       | never                                                                   |
| caller disclosure       | only with REGISTER `{disclose_caller:true}`                                | no                                                                                                 | no; CALL options are copied verbatim into INVOCATION.details            |
| callee ERROR forwarding | faithful (uri, args, kwargs, details)                                      | rewritten to `wamp.error.callee_failure`, with args `[origUri]`                                    | not forwarded (hang)                                                    |
| callee leaves mid-call  | caller gets `wamp.error.canceled`                                          | **caller hangs**                                                                                   | **caller hangs**                                                        |
| caller leaves mid-call  | callee gets INTERRUPT                                                      | nothing                                                                                            | nothing                                                                 |
| meta API / events       | none / `wamp.metaevent.session.on_join` and `on_leave`                     | `wamp.session.count`, `list` and `get` / `wamp.session.on_join` and `on_leave`                     | none                                                                    |
| request-id validation   | none (0, negative, float, string and 2^53 accepted)                        | none, but **id 0 gets no reply**                                                                   | none                                                                    |
| URI validation          | strict lowercase regex; procedures lowercased; PUBLISH not checked         | none                                                                                               | none                                                                    |
| duplicate SUBSCRIBE     | new id each time, duplicate EVENTs                                         | the same                                                                                           | new id each time, but both EVENT copies carry the first subscription id |
| GOODBYE reply           | `wamp.error.goodbye_and_out`, then the router closes                       | the same, then close 1000                                                                          | the same                                                                |
| protocol violation      | silently ignored                                                           | close 1002 or 1003                                                                                 | GOODBYE + close 1005                                                    |
| auth ABORT reasons      | `thruway.error.authentication_failure`, `wamp.error.not_authorized`        | `wamp.error.authentication_failed`, `wamp.error.no_auth_method`                                    | n/a                                                                     |
| max frame               | 16 MiB ok; 32 MiB gets close 1009                                          | not tested (ws default 100 MiB)                                                                    | not tested                                                              |
| CALL/s (100 in flight)  | about 30k                                                                  | about 37k                                                                                          | not measured                                                            |

### Thruway-specific quirks (they matter most, since Thruway is the "home" router)

- **T1: request-id collisions across sessions.** The dealer's CALL index is realm-global and keyed only by the
  caller's request id. If two sessions have the same CALL id in flight, only the most recent caller can
  CANCEL; the other's CANCEL is silently dropped, so that caller hangs. The automatic cancel when a caller
  leaves is skipped for that call too. Per-session sequential ids (the spec's SHOULD) trigger this all the
  time. Random ids, which v2 uses, avoid it.
- **T2: ERROR type 49 replies.** ERRORs answering a CANCEL use request type **49** (CANCEL), not 48. This
  covers `not_supported` (and then the call keeps running), `no_such_call`, the `killnowait` `canceled`, and
  INTERRUPT errors.
  - `skip` is treated as `kill`.
  - After `killnowait`, Thruway sends the callee a bogus `[8,8,invId,{},"wamp.error.no_such_procedure"]`.
  - The callee must announce `call_canceling`, or the cancel is refused.
- **T3: progressive-call cancel bug.** CANCEL (`kill`) on a `receive_progress` call means the caller never
  receives a final message.
- **T4: wildcard SUBSCRIBE.** It is silently dropped with no reply.
- **T5: unauthenticated sessions are already in the realm.** During CHALLENGE, before AUTHENTICATE, the
  session can PUBLISH (and gets PUBLISHED) and CALL.
- **T6: two CHALLENGEs.** A HELLO with two matching authmethods gets two CHALLENGE messages.
- **T7: procedure URIs are case-insensitive** (they are lowercased).
- **T8: UNREGISTER with an unknown id** gets `no_such_procedure`.

## Implications for the thruway.js v3 client

1. **Keep random 53-bit request ids,** or at least make the id strategy pluggable with random as the
   default. Sequential per-session ids hit Thruway T1 whenever more than one client session exists.
2. **Settle a pending call on `ERROR` with request type 48 or 49** that carries its request id. Silently
   ignore ERROR, RESULT and EVENT frames with unknown or odd ids or types (Thruway sends `[8,8,...]`).
   Never throw on them.
3. **Every request needs its own timeout and cleanup** inside the client. Routers can stay silent forever:
   - Thruway: wildcard SUBSCRIBE, and progressive cancel.
   - fox-wamp: CANCEL, callee leaving, request id 0, and an invalid realm.
   - wamp-server: several cases.

   HELLO→WELCOME needs a timeout too. **Implement call timeout on the client side,** because no router here
   honours `CALL.Options.timeout`.

4. **Make cancel client-authoritative.** On CANCEL, send it and then reject locally, as `killnowait` would,
   or after a short grace timer. Do not require `dealer.features.call_canceling` before sending a CANCEL:
   Thruway supports cancel without announcing it. A RESULT that arrives after a cancel must be dropped.
5. **Normalise payloads.** Accept `null` or missing Arguments and ArgumentsKw (fox-wamp, wamp-server) and
   map them to `[]` and `{}`. fox-wamp unwraps `[[x]]` to `[x]`, which tests must not assert against.
6. **Treat GOODBYE replies loosely.** Accept any reason, including `wamp.error.goodbye_and_out`, and expect
   the router to close the socket right after. A socket close after our own GOODBYE is not an error and must
   not trigger a reconnect.
7. **Handle auth broadly:**
   - WAMP-CRA must support salted keys (PBKDF2-SHA256, using `iterations` and `keylen` from the extra).
   - Answer only the first CHALLENGE and ignore later ones (Thruway T6).
   - Treat every ABORT during the handshake as terminal (no tight reconnect loop): `thruway.error.*`,
     `wamp.error.authentication_failed`, `no_auth_method` and `not_authorized`.
   - Do not rely on WELCOME `authid` or `authrole` being present (Thruway anonymous, fox-wamp), and do not
     trust them (stock Thruway echoes client values).
8. **Deduplicate subscriptions and registrations locally.** These routers hand out a new subscription id for
   every SUBSCRIBE (Crossbar reuses ids), so v3 should keep one router subscription per (topic, options),
   share it among local observers with reference counting, and route EVENTs by subscription id.
9. **Expose router differences instead of hiding them:**
   - Pass `match`, `invoke` and unknown options through untouched.
   - Expose `details.topic` and `details.publisher`.
   - Keep client-side URI validation loose, or make it optional. Thruway lowercases procedures; fox-wamp
     accepts anything.
10. **Close codes:**
    - 1002 and 1003 (fox-wamp protocol violation) and 1005 (wamp-server) should surface as connection
      errors with reconnect.
    - 1009 (Thruway frame larger than 16 MiB) should surface as a clear "payload too large" error.

## Notes for the fuzz and integration harness

- **URIs:** use `[a-z0-9_.]` only, so the same suite runs on Thruway (whose regex is strict, with procedures
  lowercased).
- **Realm names:** use `[a-z0-9_]` only, so they are valid on fox-wamp (`realm_auth`, not `realm-auth`).
- **Gate features with the router capabilities (`test/integration/capabilities.json`):**
  - Skip cancel on fox-wamp.
  - Skip wildcard subscriptions and progressive cancel on Thruway, or keep them as "client must time out"
    tests.
  - Thruway T1 is a good regression test that the client uses random ids.
- **Hostile-router suite:** run wamp-server against the client. The client must not crash, must not leak
  pending requests, and must time out everything.
- **Thruway logs:** PHP warnings and "Exception occurred during onMessage" lines are expected noise. Collect
  them with `podman logs thruwayjs-thruway-php`.
- **Port allocation in 18200–18299:** 18280/18281 (Thruway), 18290 (fox-wamp), 18291 (temporary stock
  fox-wamp crash check, not left running), 18295 (wamp-server).
