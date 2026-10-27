# nxt (xconnio/xconn-go router) test router

`nxt` is the standalone router CLI in `github.com/xconnio/xconn-go/cmd/nxt`. Its config is YAML and it supports anonymous, ticket, wampcra and cryptosign.

The published `docker.io/xconnio/nxt:latest` is a single-platform manifest with no version tags, so this directory **builds nxt from source** instead. The default ref is `683389304fa4`, xconn-go main from 2026-10-23, which resolves to `v0.1.1-0.20261023141601-683389304fa4`. The only git tag is v0.1.0, and the CLI prints "0.1.0". It depends on wampproto-go `ecb54c6` (2026-06-23).

| | |
|---|---|
| Image | `localhost/thruway-nxt:683389304fa4`. It builds in about 20 s on golang:1.27.3-alpine and runs on alpine:3.22. |
| WAMP WebSocket | `ws://127.0.0.1:18120/ws`. **Any path** is accepted. json, cbor and msgpack are listed, and the code also has protobuf and capnproto. |
| WAMP RawSocket | `tcp://127.0.0.1:18121`. The handshake returns max length 2^24 and json. |
| Realm | `realm1`, with roles `anonymous` and `user`. Both are allowed call, register, publish and subscribe on the `""` prefix. |
| Startup | About **0.5 s** from `podman run` to the first WELCOME. |
| Stop | STOPSIGNAL SIGINT, which is the only signal nxt handles. Clients see close **1006** and no GOODBYE. |

```sh
./start.sh                 # builds on first use, then blocks until WELCOME
./start.sh <xconn-go ref>  # any `go install ...@ref`
./stop.sh
node ../smoke-b.mjs ws://127.0.0.1:18120/ws realm1 --authid crauser --wampcra crasecret
```

The config is in `config/.nxt/config.yaml`, mounted at `/nxt/.nxt/config.yaml`. nxt reads `<-c dir>/.nxt/config.yaml`, and the YAML is decoded with `KnownFields(true)`, so a typo is a fatal error.

## Credentials (test only)

| authid | authmethods | secret | notes |
|---|---|---|---|
| (none) | – | – | anonymous. The authid is random 12-hex, and the role is `anonymous`. |
| `ticketuser` | ticket | `ticketsecret` | |
| `crauser` | wampcra | `crasecret` | unsalted |
| `crasalted` | wampcra | `crasecret` | The CHALLENGE has salt `thruwaysalt`, iterations 1000 and keylen 32. **This needs a router-bug workaround.** wampproto-go `acceptor.go` verifies the HMAC with the raw configured `secret` instead of the PBKDF2-derived key. So the config stores the derived key `A1d06z…T10=` as `secret`, and the client still signs with `crasecret`. With the plain password in the config, a spec-compliant client ABORTs with `wamp.error.authentication_failed`. |
| `csuser` | cryptosign | ed25519 seed `93a276a0…5dd2` | **`authextra.pubkey` is required**, and the user is matched on authid plus pubkey. A **96-byte** signature‖challenge is required. |

## WELCOME

`details` holds authid, authmethod, authrole and `realm`. There is no `agent` and no `authprovider`. nxt advertises far less than it implements:

- **broker:** publisher_exclusion (which is not actually implemented, see below)
- **dealer:** call_canceling, progressive_call_invocations. progressive_call_results works but is not advertised.

## Quirks found

The raw output is in `test/fixtures/probes/quirks-b.nxt.txt`.

1. **Publisher exclusion is not implemented**, although it is advertised. The publisher always gets its own EVENT, with the default, `exclude_me:true`, or `false`. The `eligible` and `exclude` lists are ignored. There is no `exclude_me` handling anywhere in the xconn-go or wampproto-go router code.
2. **Calls can hang forever.** If the callee disconnects mid-call, the caller gets **nothing**. The `timeout` call option is ignored: there is no ERROR and no INTERRUPT. The client needs its own call timeout.
3. **UNSUBSCRIBE of an unknown subscription id gets no reply at all.** The client needs its own request timeouts.
4. Patterns: a `prefix` subscription works, but its EVENT has **no `details.topic`**, so the client cannot tell which topic matched. A `wildcard` subscription `com.thruway..wc` did not match `com.thruway.x.wc`.
5. There is no URI validation. `REGISTER "bad uri with spaces"` and `SUBSCRIBE "a..b"` both succeed.
6. GOODBYE: the router replies `[6,{},"wamp.close.goodbye_and_out"]` and then drops TCP without a close frame, so the client sees **1006**.
7. Session establishment:
   - An unknown realm gets ABORT `wamp.error.no_such_realm`, but **the socket stays open**.
   - A HELLO with `{}` details gets **no reply** (it hangs).
   - A message before HELLO, or a second HELLO, is ignored.
   - Invalid JSON or an unknown message type drops the connection (1006, no ABORT).
   - A binary frame on json is parsed.
8. Auth failures get a proper ABORT with a message, for example `["invalid ticket"]`. For wampcra, an unknown authid ABORTs **before** the CHALLENGE (`["invalid realm"]`), which leaks whether a user exists. There is no fallback to the next method in `authmethods`.
9. Registration, subscription **and publication** IDs are small sequential integers (1, 2, 3 and so on). The spec says publication IDs are random and global-scope. INVOCATION details are `{}`, with no `procedure`. EVENT details are `{}`. The self-EVENT arrives before PUBLISHED.
10. Request IDs: anything is accepted (random, 0, 2^53). Reused in-flight CALL IDs give two INVOCATIONs and two RESULTs with the same id.
11. CANCEL works. With `kill`, the callee gets INTERRUPT `{mode, reason}` and the caller gets `ERROR(CALL, wamp.error.canceled)`. With `skip`, a late YIELD is dropped. Progressive results work, and `receive_progress` is forwarded.
12. There is no session meta API: the config cannot enable it (`RealmConfig{}` has Meta false), so `wamp.session.kill` returns `no_such_procedure`. A router-initiated GOODBYE cannot be triggered.
13. Subprotocol: the router follows the client's preference order. An empty subprotocol is accepted (`protocol=""`). `wamp.2.json.batched` is rejected. Payloads of 32 MiB and more are accepted.
