# fox-wamp (Node.js) test router

fox-wamp is a maintained Node.js WAMP and MQTT router (github.com/kalmyk/fox-wamp). This directory runs it from
npm with no container, for thruway.js v3 integration and fuzz tests.

| | |
|---|---|
| Router | `fox-wamp` **0.7.28** (npm, 2025-08-01), with `ws` 8.22.0 and `qlobber` 3.1.0 |
| Runtime | Node **v26.3.0** on the host. It works with `--ignore-scripts`: the `sqlite3` and `esbuild` install steps are skipped, which is fine because the in-memory engine used here needs neither. |
| Install location | `FOX_WAMP_HOME`, default `../../tmp-routers-c/fox-wamp`. On first start, `start.sh` runs `npm ci --ignore-scripts` there from the pinned `package.json` and `package-lock.json`. |
| Endpoint | `ws://127.0.0.1:18290/` (`wamp.2.json` only). Set `FOX_WAMP_PORT` to override. |
| Process | Runs in the background. The pid is in `run/fox-wamp.pid` and the log in `run/fox-wamp.log`; set `FOX_WAMP_TRACE=1` to log every frame. |

## Usage

```sh
./start.sh            # install if needed, start in the background, wait until it is listening
./stop.sh
node ../smoke-c.mjs ws://127.0.0.1:18290/ realm1 joe secret2
node ../probe-c.mjs ws://127.0.0.1:18290/ realm1
```

## Realms and credentials (`config.json`, read at start)

Stock fox-wamp can only say "everybody authenticates" or "nobody authenticates" for a listener. `router.cjs`
builds the WAMP gate itself and overrides `gate.isAuthRequired()`:

| realm | anonymous | wampcra | ticket |
|---|---|---|---|
| `realm1` (`anonymous_realms`) | yes: HELLO without a supported authmethod | yes | yes |
| `realm_auth` (`strict_realms`) | no: ABORT `wamp.error.no_auth_method` | yes | yes |
| any other valid name | yes (auto-created) | yes, if requested | yes, if requested |

Realm names must match `^[a-z0-9_]+$`. **`realm-auth` is not a valid fox-wamp realm**, so this setup uses
`realm_auth`.

The users are the same as for the Thruway router: WAMP-CRA `joe` / `secret2` and `peter` / `secret1` (salt
`salt123`, 1000 iterations, keylen 32), and ticket `ticketuser` / `ticketsecret`. The CRA challenge string is
`{authid, authrole:"user", authmethod:"wampcra", authprovider:"static", nonce, timestamp}`, without `session`.

## WELCOME

* **Anonymous:**
  ```json
  {"realm":"realm1","roles":{"broker":{"features":{"session_meta_api":true,"publisher_exclusion":true}},
   "dealer":{"features":{"session_meta_api":true,"progressive_call_results":true}}},"authmethod":"anonymous"}
  ```
* **After auth:** the same, plus `authid` (taken from the HELLO) and `authmethod`. There is **no `authrole`
  and no `authprovider`.**

## Feature support (verified with probe-c.mjs; recorded output in test/fixtures/probes/probe-c.fox-wamp.realm1.json)

| feature | result |
|---|---|
| progressive call results | **yes**. Progressive YIELDs are forwarded even when the caller did not ask for `receive_progress`. |
| call canceling | **no**. CANCEL is silently ignored: no INTERRUPT and no ERROR, so the caller hangs. |
| call timeout | **no** |
| caller identification | **no** (`disclose_caller` is ignored) |
| shared registration | **implicit**. Every REGISTER of the same URI succeeds, so `procedure_already_exists` never happens. `invoke` is ignored: calls go to the first registered callee that has capacity. That callee's capacity is unlimited by default; the REGISTER option `concurrency:N` limits it and queues the rest. In practice this is `first`. |
| pattern-based registration | **no**. `match` is ignored and the URI registers as exact. |
| pattern-based subscription | `options.match` (prefix or wildcard) is **ignored**, so the subscription is exact. MQTT-style wildcards in the URI itself work instead: `*` matches one segment and `#` many (`a.#` also matches `a`). |
| retained events | **fox-specific**. PUBLISH `{retain:true}` plus SUBSCRIBE `{retained:true}` delivers the stored EVENT with `details.retained:true`, **but that subscription then gets no live events**. The spec's `get_retained` is ignored. There are also `when`, `watch` and `will` publish options for mutex-like use. |
| publisher exclusion | **yes**. `exclude_me` defaults to true, and `false` is honoured. |
| black/white listing | **no** (`eligible` and `exclude` are ignored) |
| publisher identification | EVENT.details is **always** `{topic, publisher}`, so the publisher is disclosed unconditionally. |
| session meta API | `wamp.session.count`, `wamp.session.list` and `wamp.session.get`. There is no registration or subscription meta API. |
| session meta events | `wamp.session.on_join` (args `null`, kwargs `{session, authmethod, transport:{protocol}}`) and `wamp.session.on_leave` (args `[sessionId]`) |
| request-id validation | **none**. **A request id of `0` gets no reply at all**, because the router checks `if (requestId)`. Negative, float, string and 2^53 ids are echoed back. |
| URI validation | **none**: uppercase, hyphens, empty components and `wamp.*` are all accepted. |
| throughput | about 37k CALL/s (same rig as Thruway) |

## Quirks that matter for thruway.js v3

1. **Arguments are normalised in a lossy way.** fox-wamp stores a one-element args list as its element:
   * args `[]`, `[null]`, or no args at all arrive as **`null`** in the Arguments slot.
   * **args `[[1,2]]` arrive as `[1,2]`**, which is silent data corruption.
   * RESULT and EVENT always carry an ArgumentsKw slot, which is `null` when there were none.
   * INVOCATION kwargs default to `{}`.
   * ERROR always carries an args list (`[""]` or `[message]`).

   The client must accept `null` for Arguments and ArgumentsKw.
2. **A callee ERROR is rewritten** to `[8,48,id,{},"wamp.error.callee_failure",["<original error uri>"]]`.
   The callee's details, args and kwargs are lost.
3. **If the callee disconnects while an invocation is pending, the caller never gets an answer.** If the
   caller disconnects, the callee is not interrupted.
4. **An invalid realm name gets no ABORT, so the client hangs. Stock fox-wamp also crashes the whole process**
   with an unhandled promise rejection from `Router.getRealm`. `router.cjs` installs
   `unhandledRejection`/`uncaughtException` handlers so the test router survives, and logs the event.
5. Protocol violations close the socket without an ABORT:
   * a second HELLO closes it with **1002** "protocol violation";
   * invalid JSON, an unknown message type, or a router-only message closes it with **1003** "protocol violation";
   * a message before HELLO gets `ERROR ... "wamp.error.not_authorized",[""]`.
6. GOODBYE gets the reply `[6,{},"wamp.error.goodbye_and_out"]`, followed by close 1000 "Server closed WAMP
   session". An auth ABORT is also followed by close 1000.
7. Auth failures and edge cases:
   * Unknown method or unknown user: `ABORT {} "wamp.error.no_auth_method"`.
   * Bad signature or ticket: `ABORT {} "wamp.error.authentication_failed"`.
   * When several authmethods are offered, only one CHALLENGE is sent, for the first of the router's
     methods (wampcra, then ticket) that the client listed.
   * Unauthenticated sessions are correctly refused (`ERROR not_authorized`).
8. Publication ids come from a **small global sequential counter** (1, 2, 3, ...). Session, registration and
   subscription ids are random 48-bit values. Every SUBSCRIBE, even a duplicate, gets a new subscription id and
   its own EVENT copy.
9. A stock `listenWAMP()` binds every interface unless a host is given. `router.cjs` binds `127.0.0.1`.
