# Contributing to thruway.js

## Node versions

- **Runtime floor: Node ≥ 22** (`engines` in `package.json`). The published package runs on 22.0 and later; CI smokes
  the packed tarball on 22.0.0 and 22.4.0.
- **Development floor: Node ≥ 22.13.0** (`devEngines` in `package.json`, `onFail: error`, so `npm ci` refuses an older
  Node). Some dev tools (RxJS 9 beta, the test runner) need it.
- **`.nvmrc`** pins the version the workflows use for single-version jobs (24). The unit job runs on 22.13.0, 22.x,
  24.x and 26.x; the interop job on 22.13.0, 24.x and 26.x.

## Setup and the main commands

```sh
npm ci                 # install exactly what package-lock.json says
npm test               # typecheck (TS 7 and 6), lint (prettier + eslint), the unit project, the node project
npm run ci             # every gating CI stage, in CI order (see below)
```

Other scripts:

| Script                     | What it runs                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | TypeScript 7 and 6 over `tsconfig.src.json`, `test/tsconfig.json`, `tsconfig.tools.json` and `test/types/node-only`, then the canary, which must fail |
| `npm run lint`             | `prettier --check .` and `eslint --max-warnings 0 .`                                                                                                  |
| `npm run test:unit`        | unit, sim, model, fuzz, helper and doc tests, plus the type tests (vitest, fake or virtual time)                                                      |
| `npm run test:node`        | real sockets, child processes, Node exit, the packed tarball's smoke, hazard and bundle tests (builds and packs first)                                |
| `npm run test:interop`     | RxJS 5.4.3, 5.5.12, 6, 7, 9, Rx 4 and the load orders (builds dist when it is older than src)                                                         |
| `npm run test:browser`     | chromium and webkit against the reference server and real routers (playwright)                                                                        |
| `npm run test:integration` | the real-router matrix (podman); Thruway PHP by default                                                                                               |
| `npm run package:check`    | the consumer matrix (TS 5.0–7 × module modes), Jest 29, Node 22.0/22.4 smoke, Hermes smoke, publint, attw, size                                       |
| `npm run build`            | `dist/esm`, `dist/cjs`, `dist/browser`                                                                                                                |
| `npm run soak`             | `node scripts/soak.mjs` (below)                                                                                                                       |
| `npm run test:mutation`    | Stryker                                                                                                                                               |

`npm run ci` (`scripts/ci.mjs [--skip browser,integration] [--keep-going] [--list]`) runs the stages lint, unit,
interop, package, browser, integration and audit. A stage whose tooling is missing is reported SKIPPED, and the run
then says INCOMPLETE, never a full pass. Its package stage runs the release guard on the checkout, so a local
`npm run ci` passes only on a clean, committed tree. The audit stage runs `npm audit`, which sends the dependency tree
to the npm registry; skip it with `--skip audit` if that is not allowed where you run it.

## Tests

- The unit project (`test/projects/unit.ts`) runs `test/unit`, `test/sim`, `test/model`, `test/fuzz`,
  `test/helpers` and `test/docs`. `FC_NUM_RUNS` sets the property-test runs (CI uses 200; raise it, e.g. to 20000, for a deeper local run).
- `test/docs/` are the doctests: every code block of README.md and MIGRATION.md marked `<!-- doctest: <id> -->` is the
  code between `// doctest: <id>` and `// doctest-end` in a `test/docs/*.test.ts` file (compared without whitespace,
  imports, `export` and trailing commas), and every import of such a block must exist. Change both together.
- Any change to the packed files (`dist`, `src`, README.md, MIGRATION.md, CHANGELOG.md, LICENSE) must update
  `test/package/files.snapshot.txt` in the same commit: `npm run build && npm pack --dry-run --json --ignore-scripts`
  lists them (sorted `files[].path`), or run `node scripts/prepublish-guard.mjs` and apply the diff it prints.

## Real routers (podman)

The router setups are vendored in `test/routers/` (see its README) and run only through `scripts/routers.mjs`:

```sh
node scripts/routers.mjs list
node scripts/routers.mjs start thruway-php crossbar
npm run test:integration                        # Thruway PHP (thruway-php + thruway-php-anon), started and stopped by the run
ROUTERS=all npm run test:integration            # every router; or a comma list, e.g. ROUTERS=thruway-php,crossbar
node scripts/routers.mjs stop all
```

Environment of the integration and chaos runs: `ROUTERS`, `REQUIRE_ROUTERS=1`, `ROUTERS_EXTERNAL=1` (use routers
that are already running), `KEEP_ROUTERS=1`, `ROUTER_PREFIX` (container names, default `thruwayjs-it`),
`ROUTER_PORT_BASE` (default 18300), `ROUTER_BIND`, `ROUTER_PODMAN` (e.g. `sudo podman`), `ROUTER_NODE_IMAGE`,
`REBUILD=1`, `PROXY_PORTS` (chaos proxies, default 18340-18379), `CHAOS_SCHEDULES`, `CHAOS_SECONDS`, `CHAOS_SEED`,
`RECORD_TRANSCRIPTS=1`, `INTEGRATION_TRACES=<dir>`.

Soak and herd:

```sh
node scripts/soak.mjs --router thruway-php --minutes 60 [--clients 20] [--seed n] [--out soak-results]
node scripts/soak.mjs --router thruway-php --herd --clients 200
```

Note: Node 22.13's WebSocket ends a refused upgrade with `error` only (no `close`); the client handles both.

## Browsers, packages, Hermes

- Browser runs need playwright's browsers: `PLAYWRIGHT_BROWSERS_PATH` if they are not in the default place.
  `BROWSER_ROUTER` (default `thruway-php,crossbar` in `npm run ci`) and `REQUIRE_ROUTERS` choose the routers.
- `npm run package:check` installs offline by default; `THRUWAY_ALLOW_NETWORK=1` lets the consumer installs download.
  `PACKAGE_CHECK_SKIP=<ids>` leaves steps out. The Node 22.0.0/22.4.0 smoke needs `NODE_22_0_0` and `NODE_22_4_0`
  (paths to those Node binaries); without them the step is SKIPPED locally (and fails under `CI=true`). The Hermes
  smoke uses `HERMES_IOS_TARBALL` or React Native's local cache.

## Code rules

- `src/` is ES2020 (checked by ESLint and by `scripts/es2020-check.mjs` on the build), has no runtime dependencies,
  and its public `.d.ts` needs neither the DOM library nor `@types/node`.
- The public API is the one in the README API reference; propose a change to it in an issue first.
- Prettier formats everything (`printWidth` 120); ESLint runs with type information over src, test, configs and
  scripts.
- Commits: one logical change each, with a message that says what changed and why.

Releases are made by the maintainer.
