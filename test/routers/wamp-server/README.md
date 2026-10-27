# wamp-server (Node.js): use only as a hostile router

wamp-server is an old Node.js router (`wamp-server` 0.0.9 on npm, 2018-09-30,
github.com/ivaylopivanov/wamp-server). It implements the Basic Profile only, has no auth, and depends on
`ws` 6.0.0 and `debug` 4.0.1. It runs on Node v26.3.0.

**Do not use it as a conformance target.** It is kept as a deliberately buggy router for client robustness
tests: the client must time out, clean up, and never crash or leak against it.

| | |
|---|---|
| Endpoint | `ws://127.0.0.1:18295/`. Realms are pre-declared with `WAMP_SERVER_REALMS` (default `realm1`); `DEBUG=wamp:*` logs frames. |
| Install | `WAMP_SERVER_HOME`, default `../../tmp-routers-c/wamp-server`. `start.sh` runs `npm ci --ignore-scripts` there. |
| Run | `./start.sh` and `./stop.sh`. The pid is in `run/wamp-server.pid` and the log in `run/wamp-server.log`. |

The package's own `Server` class binds every interface and takes no host option. `router.cjs` therefore wires
the package's `SessionManager` to a `ws` server bound to 127.0.0.1. It also catches `uncaughtException`, because
the stock process crashes; see the UNREGISTER bug below.

## Observed behaviour (probe-c.mjs; recorded output in test/fixtures/probes/probe-c.wamp-server.realm1.json)

* **WELCOME:** `{"roles":{"broker":{},"dealer":{}}}`. No features are announced.
* **Unknown realm:** ABORT with its **fields swapped**: `[3,"wamp.error.no_such_realm",{details}]`. A message
  sent before HELLO gets the same frame.
* **Subprotocol:** it negotiates `wamp.2.msgpack` when that is the only thing offered, then speaks JSON anyway.
* **Second HELLO:** answered with a second WELCOME.
* **Invalid input:** invalid JSON, unknown message types, router-only messages and **CANCEL** all get
  `GOODBYE wamp.error.goodbye_and_out`, and the socket is closed with code **1005**. In effect a CANCEL kills
  the session.
* **EVENT publication id:** it equals the **subscription id**, not the publication id returned in PUBLISHED.
  smoke-c reports this as a WARN.
* **PUBLISH `{acknowledge:true}` to a topic with no subscribers:** no PUBLISHED is ever sent.
* **UNREGISTER:**
  * An unknown id gets no reply.
  * **Any UNREGISTER after an earlier UNREGISTER in the same realm throws a TypeError, which crashes the
    stock process.** The removed procedure is left as `undefined` in its map.
* **UNSUBSCRIBE with an unknown id:** no reply.
* **Callee ERROR:** never forwarded, so the caller hangs.
* **Callee disconnects while an invocation is pending:** the caller hangs.
* **Progressive results:** unsupported. The first progressive YIELD becomes the final RESULT, without
  `progress`.
* **Payloads:** INVOCATION kwargs are `null`, and RESULT drops kwargs.
* **Duplicate REGISTER:** `procedure_already_exists`; `invoke` is ignored.
* **PubSub:** the publisher is always excluded (`exclude_me:false` is ignored), and `eligible` and `exclude` are
  ignored. A duplicate SUBSCRIBE gets a new id, but both EVENT copies carry the first subscription id. CALL options
  are copied verbatim into INVOCATION.details.
* **Ids:** no validation. INVOCATION request ids are a small counter.
