#!/usr/bin/env node
// Soak runs: the chaos workload for an hour against one router, or the herd variant (many clients through a router
// restart). A launcher for test/integration/soak.test.ts, which does the work with the integration harness (routers
// started by its global setup, chaos proxies, online checks) and writes the JSON report.
//
//   node scripts/soak.mjs --router thruway-php [--minutes 60] [--clients 20] [--seed n] [--out soak-results]
//   node scripts/soak.mjs --router thruway-php --herd [--clients 200]
//
// Environment passed through: ROUTER_PREFIX, ROUTER_PORT_BASE, PROXY_PORTS (run two soaks side by side with different
// values), ROUTERS_EXTERNAL=1 (use routers that are already running), KEEP_ROUTERS=1.
// Exit status: the vitest run's (0 = the soak passed).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(
    `soak: ${message}\nusage: node scripts/soak.mjs --router <id> [--minutes 60] [--clients 20] [--seed n] [--herd] [--out dir]`,
  );
  process.exit(2);
}

/** @type {Record<string, string>} */
const options = { minutes: '60', out: 'soak-results' };
let herd = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? '';
  if (arg === '--herd') herd = true;
  else if (['--router', '--minutes', '--clients', '--seed', '--out'].includes(arg)) {
    const value = argv[++i];
    if (value === undefined || value === '') usage(`${arg} needs a value`);
    options[arg.slice(2)] = value;
  } else usage(`unknown argument ${arg}`);
}
const router = options['router'] ?? usage('--router is required');
for (const key of ['minutes', 'clients', 'seed']) {
  const value = options[key];
  if (value !== undefined && !/^\d+$/.test(value)) usage(`--${key} must be a non-negative integer`);
}

/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  ROUTERS: router,
  REQUIRE_ROUTERS: '1',
  SOAK: '1',
  SOAK_MODE: herd ? 'herd' : 'soak',
  SOAK_MINUTES: options['minutes'] ?? '60',
  SOAK_OUT: path.resolve(options['out'] ?? 'soak-results'),
  NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --expose-gc`.trim(),
};
if (options['clients'] !== undefined) env['SOAK_CLIENTS'] = options['clients'];
if (options['seed'] !== undefined) env['SOAK_SEED'] = options['seed'];

console.log(
  `soak: ${herd ? 'herd' : `${String(env['SOAK_MINUTES'])} min`} against ${router}; report in ${String(env['SOAK_OUT'])}`,
);
const result = spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--project',
    'integration',
    'test/integration/soak.test.ts',
  ],
  { cwd: ROOT, env, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
