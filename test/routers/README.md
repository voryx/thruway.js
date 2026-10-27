# Router setups of the integration suite

Run only through `scripts/routers.mjs`, the same way in CI and locally. The per-router `start.sh`/`stop.sh` scripts
of the original setups are replaced by that script; the router READMEs here are kept for the facts they record
(versions, endpoints, credentials, quirks), and `README-B.md` / `ROUTERS-C.md` are the original cross-router notes.
The probe outputs they cite are recorded in `test/fixtures/probes/`.

| router | image | host port (base + offset) | notes |
|---|---|---|---|
| `thruway-php` | `localhost/thruwayjs-router-thruway-php:0.6.1` (`thruway-php/Containerfile`) | +0 auth, +1 noauth | `router.php` and `config.json` are bind-mounted: the test admin RPC (`thruway_test.shutdown_session`, `goodbye_session`, `count_callees`, `sessions`) and two thruway/client 0.5.8 PHP callees (`thruway_test.php.*` announces call_canceling, `thruway_test.php_legacy.*` does not) |
| `thruway-php-anon` | the same image, `thruway-php/anon/` mounted | +2 | a stock router whose realm `realm_late` has only an external provider (`provider-ext.php`, method `extauth`) that registers 10 s after joining; `provider.sh stop|start` kills / restarts it (the late-provider and stale-provider cases of `test/integration/anonymous-welcome.test.ts`) |
| `crossbar` | `localhost/thruway-crossbar:26.10.1` (`crossbar/Containerfile`, PyPI) | +3 | `/ws`, `/auth`, `/ws-ping` on one port |
| `bondy` | `docker.io/leapsight/bondy:1.0.0-rc.65` (pulled) | +4 | ready in ~15 s; SIGTERM sends GOODBYE `wamp.close.system_shutdown` |
| `nexus-3.3.1` | `localhost/thruway-nexus:v3.3.1` (`nexus/Containerfile`) | +5 | `realm1` |
| `nexus-main` | `localhost/thruway-nexus:main` (pinned build arg `NEXUS_VERSION=0ddca0973a75`) | +6 | also `realm1.strict` (`strict_request_ids`) |
| `nxt` | `localhost/thruway-nxt:683389304fa4` (`xconn-nxt/Containerfile`) | +7 | |
| `fox-wamp` | `localhost/thruwayjs-router-fox-wamp:0.7.28` (`fox-wamp/Containerfile`) | +8 | realm names `^[a-z0-9_]+$` |
| `wamp-server` | `localhost/thruwayjs-router-wamp-server:0.0.9` (`wamp-server/Containerfile`) | +9 | hostile suite only |

```sh
node scripts/routers.mjs list                     # containers, URLs, images
node scripts/routers.mjs start thruway-php crossbar
npm run test:integration                          # the default: Thruway PHP only (thruway-php + thruway-php-anon)
ROUTERS=all npm run test:integration              # every router; or a comma list. Starts the selected routers itself,
                                                  # stops them at the end
node scripts/routers.mjs stop all
```

Environment: `ROUTER_PREFIX` (container names `<prefix>-<router>`, default `thruwayjs-it`), `ROUTER_PORT_BASE`
(default 18300), `ROUTER_BIND`, `ROUTER_PODMAN` (e.g. `sudo podman`), `ROUTER_NODE_IMAGE` (base of the Node routers,
default `node:22-alpine`), `FOX_WAMP_NODE_MODULES` / `WAMP_SERVER_NODE_MODULES` (offline builds), `REBUILD=1`; the
chaos proxies use `PROXY_PORTS` (default 18340-18379).

Test credentials are committed on purpose (localhost-only routers). Every authid used by the suite is listed per
router in `test/integration/capabilities.json` (`auth`); `dual` (ticket `dualticket`, wampcra `dualsecret`) exists on
every router that has both methods, for the two-method HELLO (Thruway T6 in `ROUTERS-C.md`).

The JavaScript files here are plain Node scripts outside the TypeScript projects: `eslint.config.mjs` in this directory
lints them with the recommended JavaScript rules (ESLint 10 looks up the nearest config per file).
