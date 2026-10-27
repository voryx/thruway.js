# Router probe results (vendored)

What the real routers answered to the router probes (`test/routers/probes/probe-c.mjs`, `quirks-b.mjs` and
`test/routers/crossbar/probe.mjs`) on 2026-10-25 (Node v26.3.0, native WebSocket, podman 6.1.3 on arm64).
`test/unit/dialect-fidelity.test.ts` replays the same probes (`test/helpers/probes.ts`) against the reference router's
dialects and compares the deterministic fields with these files.
The JSON files are the probes' JSON output re-indented by Prettier (the content is unchanged); the `.txt` files are
byte-identical copies of `quirks-b.mjs`'s text output (one `name  NNms  result` line per scenario).

| File | Router | Probe |
|---|---|---|
| `probe-c.thruway-php.realm1.json` | Thruway PHP 0.6.1, auth router (`router.php`: WAMP-CRA + ticket providers, anonymous on realm1) | `probe-c.mjs ws://127.0.0.1:18280/ realm1` |
| `probe-c.thruway-php.noauth.json` | Thruway PHP 0.6.1, stock router without AuthenticationManager | `probe-c.mjs ws://127.0.0.1:18281/ realm1 --only=welcome,hello_no_roles,invalid_realm,caller_identification,auth_during_challenge` |
| `probe-c.fox-wamp.realm1.json` | fox-wamp 0.7.28 (`router.cjs`) | `probe-c.mjs ws://127.0.0.1:18290/ realm1` |
| `probe-c.wamp-server.realm1.json` | wamp-server 0.0.9 | `probe-c.mjs ws://127.0.0.1:18295/ realm1` |
| `crossbar.probe-results.json` | Crossbar 26.10.1, realm1 | `crossbar/probe.mjs` (the groups that need no auth path or meta API are ported) |
| `quirks-b.bondy.txt` | Bondy 1.0.0-rc.65 | `quirks-b.mjs ws://127.0.0.1:18100/ws realm1` |
| `quirks-b.nexus-3.3.1.txt` | Nexus v3.3.1 | `quirks-b.mjs ws://127.0.0.1:18110/ realm1` |
| `quirks-b.nexus-main.txt` | Nexus main 0ddca09 | `quirks-b.mjs ws://127.0.0.1:18110/ realm1` |
| `quirks-b.nexus-main.realm1-strict.txt` | Nexus main 0ddca09, `strict_request_ids` realm | `quirks-b.mjs ws://127.0.0.1:18110/ realm1.strict` |
| `quirks-b.nxt.txt` | xconn nxt 683389304fa4 (no dialect; kept for the capability derivation) | `quirks-b.mjs ws://127.0.0.1:18120/ws realm1` |

SHA-256 of the files as copied (before Prettier re-indented the JSON ones):

```
6850f2ed1c6d26971476806952376d68bae38f92036195b2b85ab0b10862c87a  crossbar.probe-results.json
7ba265a6e7856f8c88adccd4c4387b5c122ee2d99ca6d8a76d888d5e6d7a8893  probe-c.fox-wamp.realm1.json
b3496e22575bf36163db7821b093ba37b5c16c30dd107df9904152aa22e8fedf  probe-c.thruway-php.noauth.json
a3bd78ff9cd0019c3379a8be686ffbcc903cc5e8c3cf37464cf2498f1248c1d4  probe-c.thruway-php.realm1.json
7a7a1b82d34b84584f1deaa7de5a83fdface9e6044da8fba308e351e3c286f10  probe-c.wamp-server.realm1.json
b119171a9ac418454e55748ceb38bfc0f5d1d3c3cdf1fcbf6f805eab2f8479cb  quirks-b.bondy.txt
f3c60dae5c158c5948208d0a4c9f46aadbfe795e40e1c901b85335c2e3d8c37c  quirks-b.nexus-3.3.1.txt
a41fdb871bc6adcd7bd580929416a3cea4ad193c7645fe0a48603331f31987a0  quirks-b.nexus-main.realm1-strict.txt
1bc89b15a161387a3763163a91cfb91acf749664fccca331812a750dc1fbdea3  quirks-b.nexus-main.txt
6981c1bd4a57425bbe90d07c9061e6f561a6788e99ff047ab6e6cfad6c07d583  quirks-b.nxt.txt
```

To refresh them, start the routers with `scripts/routers.mjs`, re-run the probes against them (the scripts above, or
`test/helpers/probes.ts`) and replace the files; the fidelity test then shows every probe whose answer changed.
