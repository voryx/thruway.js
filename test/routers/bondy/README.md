# Bondy (leapsight/bondy) test router

Image `docker.io/leapsight/bondy:1.0.0-rc.65`. It is the newest tag, multi-arch (amd64 and arm64), and was built on 2026-07-13. Its WELCOME `agent` is `LEAPSIGHT-BONDY-1.0.0-rc.65`. Bondy has no non-rc release yet.

| | |
|---|---|
| WAMP WebSocket | `ws://127.0.0.1:18100/ws`. **Only `/ws` works.** Any other path fails the upgrade. |
| Admin REST | `http://127.0.0.1:18101`. `GET /ping` returns 204, and `GET /realms/realm1` returns the realm JSON. |
| WAMP RawSocket | `tcp://127.0.0.1:18102`. The handshake returns max length 2^24 and json. |
| Realm | `realm1`. `security_enabled`, with permissive grants on the `""` prefix for every role and for `anonymous`. |
| Startup | About **15–16 s** from `podman run` to the first WELCOME. Erlang boot and cuttlefish config generation take most of it. |
| Stop | `podman stop` (SIGTERM) sends `GOODBYE wamp.close.system_shutdown` ("Router is shutting down") to every client about 1 s later. The VM then takes more than 10 s to exit, so `stop.sh` uses `rm -f -t 5`. |

```sh
./start.sh        # pulls the image if needed, then blocks until HELLO->WELCOME works and prints the startup time
./stop.sh         # removes container v3b-bondy (the image is kept)
BONDY_IMAGE=docker.io/leapsight/bondy:1.0.0-rc.62 ./start.sh   # run another version
node ../smoke-b.mjs ws://127.0.0.1:18100/ws realm1
```

Config is in `etc/bondy.conf` and `etc/security_config.json`. They are mounted read-only at `/cfg` and copied into `/bondy/etc` at boot, because cuttlefish has to write `etc/generated/*` as uid 1000.

## Credentials (test only)

| authid | HELLO authmethods | secret | notes |
|---|---|---|---|
| (none) | – | – | anonymous. The authid is a random UUID and the authrole is `anonymous`. |
| `ticketuser` | `["password"]` | `ticketsecret` | Bondy's cleartext method. The wire shape is the same as a static ticket: CHALLENGE `password` {} then AUTHENTICATE with the secret. |
| `ticketuser` | `["ticket"]` | JWT from `bondy.ticket.issue` | **Bondy "ticket" is not a static ticket.** It is a Bondy-issued JWT. First authenticate another way, call `bondy.ticket.issue`, then re-join with `["ticket"]` and the JWT as the signature (`smoke-b.mjs --bondy-ticket`). A static `ticket` ABORTs with `wamp.error.authentication_failed` "The signature did not match." |
| `crauser` | `["wampcra"]` | `crasecret` | **Always salted.** The CHALLENGE extra is {challenge, salt (base64 string, used as-is as bytes), iterations:4096, keylen:32}. |
| `csuser` | `["cryptosign"]` + `authextra.pubkey` | ed25519 seed `93a276a0…5dd2` | The challenge hex is **UPPERCASE**, and the extra carries `channel_binding: null`. Bondy accepts a 64-byte signature or a 96-byte signature‖challenge. |

`security.password.pbkdf2.iterations` must be between 4096 and 65536, or the config fails to load (`value should be an integer in the range 4096..65536`).

## WELCOME (anonymous)

`details` has `realm`, `authid`, `authrole`, `authmethod`, `authprovider` (`com.leapsight.bondy`), `agent`, and `authextra` {node, session_guid}. The roles and their feature flags:

- **broker ON:** event_retention, pattern_based_subscription, publisher_exclusion, publisher_identification, reflection, session_meta_api, subscriber_blackwhite_listing
- **broker OFF:** acknowledge_event_received, acknowledge_subscriber_received, event_history, payload_passthru_mode, publication_trustlevels, sharded_subscription, subscription_meta_api, subscription_revocation
- **dealer ON:** call_canceling, call_reroute, call_timeout, caller_identification, pattern_based_registration, registration_meta_api, session_meta_api, shared_registration
- **dealer OFF:** call_trustlevels, payload_passthru_mode, **progressive_call_results**, **progressive_calls**, reflection, registration_revocation, sharded_registration, testament_meta_api. These are "disabled until implemented" in the schema and cannot be switched on.

## Quirks and bugs found

All of these were checked on rc.65, and the same results show on rc.62, so they are long-standing. The raw output is in `test/fixtures/probes/quirks-b.bondy.txt`.

1. **`exclude_me` is ignored.** The publisher always gets its own EVENT, with the default, with `exclude_me:true`, and with `false`. The `eligible` and `exclude` session lists are ignored as well: an `eligible:[B]` publish reaches nobody, and an `exclude:[B]` publish reaches B. Client tests that assert "the publisher does not receive its own event" must xfail on Bondy.
2. **CANCEL:** with no `mode`, the caller gets `[ERROR, **49 (CANCEL)**, reqId, {}, wamp.error.canceled, ["call_cancelled"], {...}]`. The type field is CANCEL, not CALL. A client that matches errors by (CALL, requestId) never settles the canceled call. With any explicit `mode` (`skip`, `kill` or `killnowait`), the caller gets `bondy.error.internal_error` and the callee gets no INTERRUPT. That case is a function_clause in `bondy_dealer:handle_cancel`.
3. **UNSUBSCRIBE of an unknown subscription id crashes the connection.** A badarg while formatting the error message gives a WebSocket close **1011** and no ERROR. A stale unsubscribe, such as one raced with a reconnect, kills the whole session.
4. **Progressive results are not supported.** `receive_progress` is not forwarded to the callee. A callee that YIELDs `{progress:true}` anyway has that first YIELD delivered as the **final** RESULT, without the progress flag, and later YIELDs are dropped.
5. INVOCATION details always disclose `caller`, `caller_authid` and `caller_authrole`. EVENT details always include `publisher`, `publisher_authid`, `publisher_authrole` and `x_publisher_guid`, even without `disclose_me`.
6. EVENT is sent **before** PUBLISHED to a publisher that is subscribed.
7. A HELLO with `authmethods:["password"]` and **no authid** silently gets an **anonymous** WELCOME. Clients should check `WELCOME.details.authmethod`.
8. GOODBYE gets the reply `[6, {"message":"Session closed by client."}, "wamp.close.goodbye_and_out"]`, then the router closes the socket with code **1005** (no status code). Sending anything after GOODBYE means the socket is already closed.
9. A HELLO with `{}` details (no roles), a message before HELLO, a second HELLO, or an unknown message type each get ABORT `wamp.error.protocol_violation`. Invalid JSON gets ABORT `bondy.error.internal_error`. All of them are followed by close 1005. An unknown realm gets ABORT `wamp.error.no_such_realm`.
10. A binary frame on `wamp.2.json`, and a YIELD for an unknown invocation, are both ignored silently.
11. Two in-flight CALLs that reuse the same request ID are both routed, and two RESULTs come back with the same id. Request IDs of 0 and 2^53 are accepted. Random, non-sequential IDs are fine.
12. The `call` option `timeout:500` gives `wamp.error.timeout` after about 1.2–1.3 s (a coarse timer), and the callee gets no INTERRUPT. A callee that leaves mid-call makes the caller get `wamp.error.no_eligible_callee`.
13. The max WebSocket message is **4 MB** by default (`wamp.websocket.max_frame_size`). An 8 MB message gets close **1009**. A 1 MiB CALL/RESULT round-trip works.
14. Subprotocol: the router follows the client's preference order. It supports json, msgpack, cbor and `wamp.2.json.batched`. Offering no subprotocol is rejected.
15. There is no `wamp.session.kill` (`no_such_procedure`). To trigger a router-initiated GOODBYE, use `podman kill -s TERM v3b-bondy` and the client gets `wamp.close.system_shutdown`.
16. Error ERRORs carry a human message as `args[0]` and as `kwargs.message`. Internal errors include a `trace_id`.
