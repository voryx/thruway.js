Recorded-shape fixtures for `scripts/audit-gate.mjs` (test/package/audit-gate.test.ts). The `npm audit --json` files
follow npm 11's `auditReportVersion: 2` format (the shape of a real run on this repo, 2026-10-26: `qs` moderate
advisories through `typed-rest-client`); the high/critical advisories are made up for the tests. `prod-*.json` are
`npm ls --omit=dev --all --json` outputs.
