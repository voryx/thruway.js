# Thruway (PHP) test router

Thruway is the PHP WAMP v2 router from the same org as thruway.js (github.com/voryx/Thruway). This directory
runs it in podman for thruway.js v3 integration and fuzz tests. Nothing is needed on the host except podman.

| | |
|---|---|
| Router | `voryx/thruway` **0.6.1**. That is also `dev-master`; the last release was 2022-02-18 and the project is effectively unmaintained. |
| Transport | `thruway/ratchet-transport` 0.5.0 on `cboden/ratchet` 0.4.4, `ratchet/rfc6455` 0.3.1 and `react/event-loop` 1.6.0 |
| Other locked deps | `thruway/client` 0.5.8, `voryx/thruway-common` 1.0.6 and `guzzlehttp/psr7` 1.9.1. The full set is in `composer.lock`. |
| Runtime | `docker.io/library/php:8.3-cli-bookworm` (PHP 8.3.35, arm64) with composer 2.10.3 |
| Image | `localhost/thruwayjs-router-thruway-php:0.6.1` (about 591 MB). The container is `thruwayjs-thruway-php`. |
| Endpoints | **auth router** `ws://127.0.0.1:18280/` (container :8080) and **noauth router** `ws://127.0.0.1:18281/` (container :8081). Both serve the `wamp.2.json` subprotocol only. |

## Usage

```sh
./start.sh                       # builds the image if it is missing, (re)creates the container, waits for HTTP
THRUWAY_LOG_LEVEL=debug ./start.sh && podman logs -f thruwayjs-thruway-php   # logs every inbound frame
REBUILD=1 ./start.sh             # rebuild after editing router.php / composer.*
./stop.sh                        # removes the container (the image is kept)
node ../smoke-c.mjs ws://127.0.0.1:18280/ realm1 joe secret2
node ../probe-c.mjs ws://127.0.0.1:18280/ realm1            # feature / quirk probes
```

`config.json` is bind-mounted read-only, so editing it only needs `./start.sh` again, not a rebuild. Host
ports can be overridden with `THRUWAY_PHP_PORT` and `THRUWAY_PHP_NOAUTH_PORT`.

**Regenerating `composer.lock`:**

```sh
podman run --rm -v "$PWD":/app:Z -w /app docker.io/library/composer:2 \
  composer update --no-install --no-dev
```

Composer 2.10 blocks `guzzlehttp/psr7` 1.x because of security advisories, and `thruway/ratchet-transport`
requires `^1.4`. `composer.json` ignores those advisories through `config.policy.advisories.ignore`. This is
acceptable only because this is a localhost-bound test router.

## Realms and credentials (`config.json`)

The auth router uses the stock `AuthenticationManager`, the stock `WampCraAuthProvider` and a small
`TicketAuthProvider`. Thruway 0.6.1 has no built-in ticket provider; the one in `router.php` uses the stock
provider plumbing.

| realm | anonymous | wampcra | ticket |
|---|---|---|---|
| `realm1` | yes: no `authmethods`, or `["anonymous"]` (`LenientAuthenticationManager` in router.php) | yes | yes |
| `realm-auth` | no: ABORT `wamp.error.not_authorized` (stock behaviour) | yes | yes |
| any other name | yes: auto-created; the stock manager treats realms without providers as anonymous | no | no |

WAMP-CRA users are `joe` / `secret2` (unsalted) and `peter` / `secret1` (salt `salt123`). For `peter` the
CHALLENGE extra carries `salt`, `keylen: 32` and `iterations: 1000`. The key is
`base64(PBKDF2-SHA256(secret, salt, 1000, 32))`, and that base64 string is used as the HMAC key. The ticket
user is `ticketuser` / `ticketsecret`.

The noauth router on 18281 is completely stock, like `Examples/SimpleWsRouter.php`. It auto-creates any
realm, and its `AnonymousAuthenticator` echoes the HELLO details back.

## WELCOME

These are the roles and features the router announces (identical on both routers):

```json
{"broker":{"features":{"subscriber_blackwhite_listing":true,"publisher_exclusion":true,"subscriber_metaevents":true}},
 "dealer":{"features":{"caller_identification":true,"progressive_call_results":true}}}
```

The details depend on how the session was admitted:

* **Anonymous on the auth router:** `{roles}` only. There is no authid, authrole, authmethod, realm or agent.
* **WAMP-CRA:** `{authmethod:"wampcra", authrole:"user", authid, authprovider:"userdb", authroles:["user","authenticated_user"], roles}`.
* **Ticket:** the same, with `authmethod:"ticket"` and `authprovider:"static"`.
* **noauth router:** the HELLO details echoed back, minus the client `roles` and plus
  `transport:{type:"ratchet", transport_address, headers:{...all HTTP request headers...}, url, query_params, cookies}`.
  A client-supplied `authid` or `authrole` is echoed verbatim, so it can be spoofed (internally the session is
  still anonymous).

## Feature support (verified with probe-c.mjs; recorded output in test/fixtures/probes/probe-c.thruway-php.*.json)

| feature | result |
|---|---|
| progressive call results | **yes**. Progressive YIELDs to a caller that did not ask for `receive_progress` are silently dropped; the final result is still delivered. |
| call canceling | **partly**. Implemented but not announced in WELCOME, and the callee must announce `roles.callee.features.call_canceling`. Many quirks, listed below. |
| call timeout (`CALL.Options.timeout`) | **no**. The option is ignored, not forwarded to the INVOCATION, and nothing interrupts the call. |
| shared registration | **yes**, via the REGISTER option `invoke`: `single` (default), `roundrobin`, `random`, `first` and `last` were all verified. Thruway also has `_thruway` (least busy) and the legacy `thruway_multiregister:true`. Not announced in WELCOME. |
| pattern-based registration | **no**. `{match:"prefix"}` is silently ignored and registers as exact. `{match:"wildcard"}` gives `wamp.error.invalid_uri`. |
| pattern-based subscription | **prefix only**, and not announced. Matching is by characters, not segments: `a.pfx` matches `a.pfxzzz`, and the prefix `""` or `"."` matches everything. EVENT.details.topic is set. **`wildcard` gets NO reply at all** (SUBSCRIBE is silently dropped), so the client hangs. |
| retained events / event history | **no**. `retain` and `get_retained` are ignored. |
| publisher exclusion, black/white listing | **yes**. `exclude_me` defaults to true and `false` is honoured; `eligible` and `exclude` (session ids) work. |
| publisher identification (`disclose_me`) | **no**. EVENT.details stays `{}`. |
| caller identification | **yes**, but only with REGISTER `{disclose_caller:true}`. INVOCATION.details is then `{caller, authid, authrole, authroles, authmethod}`. The caller's `disclose_me` is ignored. |
| session meta API (`wamp.session.count` and so on) | **no** (`wamp.error.no_such_procedure`) |
| session meta events | **legacy names only**. `wamp.metaevent.session.on_join` and `on_leave` carry `args[0] = {realm, authid, authrole, authroles, authmethod, authprovider, session, role_features, ...}`. `wamp.session.on_join` is never published. |
| request-id validation | **none**. `0`, `2^53`, `-5`, `"abc"` and `1.5` are all accepted and echoed back. Non-sequential ids are fine, and two in-flight CALLs with the same id are both served. |
| max message | 16 MiB was published fine. 32 MiB got WebSocket close **1009** "Maximum frame size exceeded". |
| throughput | about 30k CALL/s (5,000 calls, 100 in flight, podman on Apple silicon; indicative only) |

## Quirks that matter for thruway.js v3

1. **The dealer's CALL index is realm-global, keyed only by the caller's request id**
   (`Dealer::$callRequestIndex[$msg->getRequestId()]`). When two sessions have a CALL with the same request id
   in flight, only the most recent caller can CANCEL it. The other caller's CANCEL is silently dropped: the
   log says "Attempt to cancel call by non-owner" and no ERROR is sent, so that caller hangs. The automatic
   cancel when a caller leaves is skipped for that call too. Per-session sequential ids (the spec's SHOULD)
   make these collisions routine. Random 53-bit ids, which v2 uses, avoid them.
2. **ERRORs about a cancel use request type 49 (CANCEL), not 48.** They have the form `[8,49,callReqId,{},uri]`
   and cover `not_supported`, `no_such_call`, the `killnowait` `canceled`, and the forwarded callee ERROR for
   an INTERRUPT error. The client must settle the pending call on `ERROR[48|49, id]`.
3. The cancel modes behave as follows:
   * `skip` behaves like `kill`, and the INTERRUPT carries `{}` options (no mode).
   * `kill` waits for the callee's ERROR, then forwards it as `[8,48,...]`.
   * `killnowait` answers the caller immediately with `[8,49,id,{},"wamp.error.canceled"]`. When the callee's
     ERROR(INVOCATION) arrives later, Thruway sends **`[8,8,invId,{},"wamp.error.no_such_procedure"]`** to
     the callee: an ERROR whose request type is ERROR. A client callee must ignore such stray frames.
   * If the callee did not announce `call_canceling`, the caller gets `[8,49,id,{},"wamp.error.not_supported"]`
     **and the call keeps running**. A RESULT can still arrive later.
   * **Bug:** CANCEL (`kill`) on a `receive_progress` call removes the call before the callee's ERROR arrives,
     so the caller never gets a final ERROR or RESULT and hangs. Client-side cancel must complete the call
     locally, or at least run a timer.
4. **Protocol violations are silently ignored**, with no ABORT and no close. This covers messages before HELLO,
   a second HELLO, invalid JSON, unknown message types, and client-sent router-only messages. They show up
   only in the router log.
5. GOODBYE gets the reply `[6,{},"wamp.error.goodbye_and_out"]`. That is a legacy URI; the spec has
   `wamp.close.goodbye_and_out`. The router then closes the WebSocket (code 1000) immediately.
6. Auth outcomes:
   * Bad signature, bad ticket or unknown authid: `ABORT {} "thruway.error.authentication_failure"`
     (non-standard). An unknown authid gets it immediately, with no CHALLENGE.
   * A realm that requires auth, with no matching method: `ABORT {} "wamp.error.not_authorized"`.
   * HELLO with several matching authmethods gets **one CHALLENGE per method**, in provider-registration
     order rather than the client's order.
   * **Security:** while a CHALLENGE is outstanding, the session is already in the realm, and PUBLISH and
     CALL are processed (PUBLISHED comes back) before AUTHENTICATE.
7. URIs:
   * REGISTER and CALL procedures are **lowercased** before checking, so procedure URIs are
     case-insensitive (`a.B` and `a.b` are the same).
   * SUBSCRIBE is not lowercased.
   * Both are then checked strictly against `^([0-9a-z_]+\.)*([0-9a-z_]+)$`. Hyphens, uppercase topics and
     empty components give `wamp.error.invalid_uri`.
   * PUBLISH topics are **not validated at all**.
   * The `wamp.` prefix is not reserved.
   * Realm names are not validated: `"Bad Realm!"` is welcomed, and any realm is auto-created.
8. Every SUBSCRIBE creates a new subscription id, even for a duplicate SUBSCRIBE from the same session, and
   each one gets its own EVENT copy. Different sessions on the same topic also get different ids.
9. UNREGISTER with an unknown id gets `wamp.error.no_such_procedure` (the spec says `no_such_registration`).
   Mismatched `invoke` policies give `wamp.error.unknown`. An unknown `invoke` value silently means `single`.
10. Payloads pass through faithfully. Callee ERRORs keep their details, uri, args and kwargs. Empty `[]` args
    and `{}` kwargs are dropped from the forwarded message, and PHP JSON keeps 2^53-1 exactly.
11. HELLO without `roles` is accepted. Only `wamp.2.json` is offered; a client offering only `wamp.2.msgpack`
    fails the handshake.
12. The log also shows PHP warnings (`Undefined array key ... Dealer.php line 401`) when a callee answers an
    INTERRUPT for a call that was already removed.
