# Nexus (gammazero/nexus, Go) test router

Stock `nexusd` can only configure **anonymous** auth from JSON. Authenticators are Go objects, so this directory builds a small router, `main.go`, that embeds the nexus library. It adds `ticket`, `wampcra` (plain and PBKDF2-salted) and `cryptosign`, backed by a static keystore.

Realms are decoded straight into `router.RealmConfig`, so any json option that the linked nexus version knows can be set in `nexus-test.json`. Options that version does not know are logged as `WARNING ... not supported by nexus <ver> (ignored)`.

| | |
|---|---|
| Versions | **v3.3.1**, the latest release (tag at b2672379, 2026-10-14). This is the default. **main**, at commit 0ddca09 (2026-10-25), resolves to `v3.3.2-0.20261025192937-0ddca0973a75`. main has a burst of fixes after v3.3.1 (#352 through #411), including opt-in `strict_request_ids`. |
| Images | `localhost/thruway-nexus:v3.3.1` and `localhost/thruway-nexus:main`. Both build from `Containerfile` in about 30 s on golang:1.27.3-alpine, and run on alpine:3.22. |
| WAMP WebSocket | `ws://127.0.0.1:18110/`. **Any path** is accepted. json, msgpack and cbor are supported. |
| WAMP RawSocket | `tcp://127.0.0.1:18111`. The handshake returns max length 2^24 and json. |
| Realms | `realm1` is permissive: anonymous, ticket, wampcra and cryptosign, with `enable_meta_kill` and `enable_meta_modify`, and event history on `com.thruway.history.`. `realm1.strict` has `strict_uri`, plus `strict_request_ids`, which **only takes effect on main**. |
| Startup | About **0.45–0.55 s** from `podman run` to the first WELCOME. |
| Stop | SIGTERM gives a clean exit, but clients see a **1006** close and no GOODBYE (see quirk 1). |

```sh
./start.sh            # v3.3.1 (the build is created on first use); blocks until WELCOME
./start.sh main       # nexus main branch (any go-get ref works: tag, branch or commit)
./start-stock.sh      # the PUBLISHED image ghcr.io/gammazero/nexusd:v3.3.1 (multi-arch), anonymous only,
                      #   ws://127.0.0.1:18115/  tcp 18116, config ./nexusd.json, ready in about 0.35 s
./stop.sh             # removes v3b-nexus and v3b-nexus-stock (the images are kept)
node ../smoke-b.mjs ws://127.0.0.1:18110/ realm1 ticketsecret ticketuser
```

## Credentials (test only), realm1 and realm1.strict

| authid | HELLO authmethods | secret | notes |
|---|---|---|---|
| (none) | – | – | anonymous. The authid is random hex, the authrole is `anonymous`, and the authprovider is `static`. |
| `ticketuser` | `["ticket"]` | `ticketsecret` | CHALLENGE `ticket` {} |
| `crauser` | `["wampcra"]` | `crasecret` | Unsalted. The challenge JSON contains spaces (`{ "nonce":... }`). Sign the exact string. |
| `crasalted` | `["wampcra"]` | `crasecret` | The CHALLENGE extra has salt `thruwaysalt`, keylen 32 and iterations 1000. The keystore holds the derived key. |
| `csuser` | `["cryptosign"]` | ed25519 seed `93a276a0…5dd2` | The key comes from the keystore by **authid**. `authextra.pubkey` is not needed. The router **requires a 96-byte** signature‖challenge, and a 64-byte signature alone is rejected. |

An authenticated WELCOME carries authrole `user` and authprovider `thruway-test-keystore`.

## WELCOME

`details` holds only authid, authrole, authmethod and authprovider. There is **no `agent`** and no `realm`. The features are the same on v3.3.1 and main:

- **broker:** event_history, pattern_based_subscription, payload_passthru_mode, publisher_exclusion, publisher_identification, session_meta_api, subscriber_blackwhite_listing, subscription_meta_api
- **dealer:** call_canceling, call_timeout, caller_identification, pattern_based_registration, payload_passthru_mode, progressive_call_invocations (a non-spec name), progressive_call_results, registration_meta_api, session_meta_api, shared_registration, testament_meta_api

## Quirks found

The raw output is in `test/fixtures/probes/`: `quirks-b.nexus-3.3.1.txt`, `quirks-b.nexus-main.txt` and
`quirks-b.nexus-main.realm1-strict.txt`.

1. **Closing messages are usually lost (both versions).** `transport/websocketpeer.go` `close()` *"discard[s] any queued messages"* and then closes the socket. A message queued just before the close is usually dropped, and the client usually sees close **1006** with no close frame. This covers:
   - the GOODBYE reply. About 11 of 12 runs lost it on v3.3.1, and it is the same on main. When it does arrive, the close is `1000 "goodbye"`. It reproduces from inside the podman network too, so it is not caused by port forwarding.
   - the ABORT for an auth failure (bad ticket, unknown user or missing authid).
   - ABORTs for protocol violations, `no_such_realm`, and strict request-ID violations.
   - the GOODBYE to a session killed with `wamp.session.kill`, which returns RESULT to the killer while the victim just sees 1006.
   - the shutdown GOODBYE.

   The client must treat "socket closed after I sent GOODBYE" as a clean leave, and must not wait for the reply. On Nexus a router-initiated GOODBYE or ABORT looks exactly like a network drop.
2. **Request IDs.** realm1 accepts anything: random IDs, 0, and 2^53. On **main**, `realm1.strict` aborts the session (`non-sequential session scope request ID: got X, want 1`, and the client sees a bare 1006) unless the requests start at 1 and increase by 1 across PUBLISH, SUBSCRIBE, UNSUBSCRIBE, REGISTER, UNREGISTER and CALL. **thruway.js v2 uses random IDs (`Utils.uniqueId`) and would be killed there.**
3. Reusing an in-flight CALL request ID is treated as a progressive-call continuation, and only one RESULT comes back.
4. On v3.3.1, invalid JSON and unknown message types are ignored silently. On main they close the connection (1006, with the ABORT lost). A binary frame on `wamp.2.json` is parsed as JSON on both.
5. Subprotocol: on **v3.3.1 the server's preference wins.** It always picks `wamp.2.json` if offered, even when the client lists cbor or msgpack first. **main** follows the client's order (#355). Both accept an upgrade with no subprotocol (`protocol=""`). Neither supports `wamp.2.json.batched`. The client must check `ws.protocol`.
6. The following work as the spec says: exclude_me (default true), eligible and exclude lists, prefix and wildcard subscriptions (with `details.topic`), shared registration with `invoke: roundrobin`, progressive results (`receive_progress` is forwarded), and CANCEL. For `kill`, the callee gets INTERRUPT `{mode, reason: wamp.error.canceled}` and the caller gets `ERROR(CALL, wamp.error.canceled)`. For `skip`, a late YIELD is dropped.
7. The `timeout` call option gives `wamp.error.timeout` after about 510 ms for 500 ms, and sends INTERRUPT to the callee. A callee that leaves mid-call makes the caller get `wamp.error.canceled`.
8. Registration and subscription IDs are small sequential integers. Publication IDs are random. INVOCATION details always include `"progress": false`. EVENT details are `{}` unless the publisher discloses itself. PUBLISHED arrives before the self-EVENT.
9. Error ERRORs have no args (for example `[8,64,2,{},"wamp.error.procedure_already_exists"]`). UNSUBSCRIBE of an unknown id gets `wamp.error.no_such_subscription`. An invalid URI gets `wamp.error.invalid_uri`, even with `strict_uri` off for spaces and empty components.
10. Large payloads are accepted over WebSocket: 20 MiB PUBLISH on v3.3.1, and 4, 8, 16 and 32 MiB on main.
11. `nexusd` (the stock image) exits with 143 on SIGTERM, which means it has no handler. The custom build handles SIGTERM.
