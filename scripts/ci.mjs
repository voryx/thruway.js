#!/usr/bin/env node
// Local CI: runs, in the same order as CI, every step of every gating CI job — lint/typecheck, unit (current Node),
// interop, package, browser, integration (Thruway PHP), audit — through the same npm scripts the workflows call, so CI
// and local runs cannot drift. Stages that need playwright or podman can be skipped; a skipped stage, or a step whose
// script or tests are missing, is printed as SKIPPED and the run reports itself as INCOMPLETE, never as a full pass.
//
//   node scripts/ci.mjs [--skip browser,integration] [--keep-going] [--list]
//
// Exit status: 0 when nothing failed (complete or incomplete), 1 when a step failed, 2 on a usage error.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCheckSteps } from './package-check.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * @typedef {{ name: string, command: string[], env?: Record<string, string>, skipStatus?: number }} RunStep
 * @typedef {{ name: string, skip: string }} SkipStep
 * @typedef {RunStep | SkipStep} Step
 * @typedef {{ name: string, workflow: string, steps: () => Step[] }} Stage
 */

/** @param {string} dir @param {RegExp} pattern @returns {boolean} */
function hasFiles(dir, pattern) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).some(
    (entry) => entry.isFile() && pattern.test(entry.name),
  );
}

const MISSING = 'not in this checkout';
const TESTS = /\.test\.ts$/;

/** @param {string} name @param {string} script @param {string[]} [extra] @returns {Step} */
function npmScriptIfPresent(name, script, extra = []) {
  return existsSync(script) ? { name, command: [NPM, 'run', ...extra] } : { name, skip: `${MISSING}: ${script}` };
}

/** @type {Stage[]} */
const STAGES = [
  {
    name: 'lint',
    workflow: '.github/workflows/lint.yml',
    steps: () => [
      { name: 'prettier + eslint (npm run lint)', command: [NPM, 'run', 'lint'] },
      { name: 'TS 7 + TS 6 typecheck, canary (npm run typecheck)', command: [NPM, 'run', 'typecheck'] },
    ],
  },
  {
    name: 'unit',
    workflow: '.github/workflows/unit.yml',
    steps: () => [
      {
        name: 'unit project with coverage (npm run test:unit -- --coverage, FC_NUM_RUNS=200)',
        command: [NPM, 'run', 'test:unit', '--', '--coverage'],
        env: { FC_NUM_RUNS: '200' },
      },
      { name: 'build (npm run build)', command: [NPM, 'run', 'build'] },
      { name: 'node project (npm run test:node)', command: [NPM, 'run', 'test:node'] },
    ],
  },
  {
    name: 'interop',
    workflow: '.github/workflows/interop.yml',
    steps: () =>
      hasFiles('test/interop', TESTS)
        ? [
            { name: 'build (npm run build)', command: [NPM, 'run', 'build'] },
            { name: 'interop project (npm run test:interop)', command: [NPM, 'run', 'test:interop'] },
          ]
        : [{ name: 'interop project', skip: `${MISSING}: test/interop/*.test.ts` }],
  },
  {
    name: 'package',
    workflow: '.github/workflows/package.yml',
    // The steps of scripts/package-check.mjs one by one (a step whose tooling is missing exits 3 = SKIPPED), then the
    // package tests of the node project and the release guard on this checkout.
    steps: () => [
      { name: 'build (npm run build)', command: [NPM, 'run', 'build'] },
      {
        name: 'declaration gate on dist (every .d.ts, TS 7, skipLibCheck false)',
        command: [process.execPath, 'scripts/dts-check.mjs'],
      },
      ...packageCheckSteps().map((step) =>
        'skip' in step
          ? { name: step.name, skip: step.skip }
          : {
              name: step.name,
              command: step.command,
              ...(step.skipStatus === undefined ? {} : { skipStatus: step.skipStatus }),
            },
      ),
      {
        name: 'package smoke, hazard, bundle-semantics, release-guard and audit-gate tests',
        command: [NPM, 'run', 'test:node', '--', 'test/package'],
      },
      { name: 'release guard on this checkout', command: [process.execPath, 'scripts/prepublish-guard.mjs'] },
    ],
  },
  {
    name: 'browser',
    workflow: '.github/workflows/browser.yml',
    // Chromium + webkit against the reference server and, through the proxy, Thruway PHP under podman
    // (test/browser/routers.ts starts it through scripts/routers.mjs; BROWSER_ROUTER=thruway-php,crossbar adds
    // Crossbar); REQUIRE_ROUTERS=1 as in CI. Then the plain-playwright bundle smoke.
    steps: () => [
      { name: 'build (npm run build)', command: [NPM, 'run', 'build'] },
      {
        name: 'browser project, chromium + webkit (npm run test:browser)',
        command: [NPM, 'run', 'test:browser'],
        env: {
          BROWSER_ROUTER: process.env['BROWSER_ROUTER'] ?? 'thruway-php',
          REQUIRE_ROUTERS: process.env['REQUIRE_ROUTERS'] ?? '1',
        },
      },
      {
        name: 'UMD and ESM bundles in chromium + webkit (scripts/smoke-browser-bundles.mjs)',
        command: [process.execPath, 'scripts/smoke-browser-bundles.mjs'],
      },
    ],
  },
  {
    name: 'integration',
    workflow: '.github/workflows/integration.yml',
    steps: () =>
      existsSync('scripts/routers.mjs') && hasFiles('test/integration', TESTS)
        ? [
            { name: 'build (npm run build)', command: [NPM, 'run', 'build'] },
            {
              // ROUTERS from the environment, unset: Thruway PHP only (ROUTERS=all node scripts/ci.mjs: every router)
              name: `integration project, ${(process.env['ROUTERS'] ?? '') === '' ? 'Thruway PHP' : String(process.env['ROUTERS'])} (npm run test:integration)`,
              command: [NPM, 'run', 'test:integration'],
              env: { REQUIRE_ROUTERS: '1' },
            },
          ]
        : [{ name: 'integration project', skip: `${MISSING}: scripts/routers.mjs, test/integration/*.test.ts` }],
  },
  {
    name: 'audit',
    workflow: '.github/workflows/audit.yml',
    steps: () => [
      npmScriptIfPresent('audit gate, whole tree (npm run audit:gate)', 'scripts/audit-gate.mjs', ['audit:gate']),
      {
        name: 'no runtime dependencies with advisories (npm audit --omit=dev --audit-level=low)',
        command: [NPM, 'audit', '--omit=dev', '--audit-level=low'],
      },
    ],
  },
];

// --- arguments ----------------------------------------------------------------------------------------------------
const names = STAGES.map((stage) => stage.name);
/** @type {Set<string>} */
const skip = new Set();
let keepGoing = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? '';
  if (arg === '--keep-going') keepGoing = true;
  else if (arg === '--list') {
    for (const stage of STAGES) console.log(`${stage.name.padEnd(12)} ${stage.workflow}`);
    process.exit(0);
  } else if (arg === '--skip' || arg.startsWith('--skip=')) {
    const value = arg === '--skip' ? argv[++i] : arg.slice('--skip='.length);
    if (value === undefined || value === '') usage('--skip needs a comma-separated list of stages');
    for (const name of value.split(',')) {
      if (!names.includes(name)) usage(`unknown stage "${name}" (stages: ${names.join(', ')})`);
      skip.add(name);
    }
  } else usage(`unknown argument ${arg}`);
}

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`ci: ${message}\nusage: node scripts/ci.mjs [--skip ${names.join(',')}] [--keep-going] [--list]`);
  process.exit(2);
}

// --- run ----------------------------------------------------------------------------------------------------------
/** @typedef {{ stage: string, status: 'PASSED' | 'FAILED' | 'SKIPPED', detail: string }} Outcome */
/** @type {Outcome[]} */
const outcomes = [];
const started = performance.now();
let failed = false;

for (const stage of STAGES) {
  if (failed && !keepGoing) {
    outcomes.push({ stage: stage.name, status: 'SKIPPED', detail: 'not run (an earlier stage failed)' });
    continue;
  }
  console.log(`\n== ci: ${stage.name} (${stage.workflow})`);
  if (skip.has(stage.name)) {
    console.log(`   SKIPPED (--skip ${stage.name})`);
    outcomes.push({ stage: stage.name, status: 'SKIPPED', detail: '--skip' });
    continue;
  }
  const stageStart = performance.now();
  /** @type {string[]} */
  const skippedSteps = [];
  let ran = 0;
  let stageFailed = false;
  for (const step of stage.steps()) {
    if ('skip' in step) {
      console.log(`-- ${step.name}: SKIPPED (${step.skip})`);
      skippedSteps.push(step.skip);
      continue;
    }
    console.log(`-- ${step.name}`);
    const [command = '', ...rest] = step.command;
    // stdin is not passed on: no step reads it, and vitest's browser mode can spin at exit on an inherited
    // non-TTY stdin.
    const result = spawnSync(command, rest, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...step.env },
    });
    ran++;
    if (step.skipStatus !== undefined && result.status === step.skipStatus) {
      // the step said its tooling is unavailable here (scripts/package-check.mjs UNAVAILABLE)
      console.log(`-- ${step.name}: SKIPPED (tooling unavailable, see above)`);
      skippedSteps.push(`${step.name}: tooling unavailable`);
      continue;
    }
    if (result.status !== 0) {
      console.log(`-- FAILED: ${step.name} (${result.error?.message ?? `exit ${String(result.status)}`})`);
      stageFailed = true;
      break;
    }
  }
  const seconds = ((performance.now() - stageStart) / 1000).toFixed(1);
  if (stageFailed) {
    failed = true;
    outcomes.push({ stage: stage.name, status: 'FAILED', detail: `${seconds} s` });
  } else if (ran === 0) {
    outcomes.push({ stage: stage.name, status: 'SKIPPED', detail: skippedSteps.join('; ') });
  } else {
    const partial =
      skippedSteps.length > 0 ? `, ${String(skippedSteps.length)} step(s) SKIPPED (${skippedSteps.join('; ')})` : '';
    outcomes.push({ stage: stage.name, status: 'PASSED', detail: `${seconds} s${partial}` });
  }
}

// --- summary ------------------------------------------------------------------------------------------------------
console.log(
  `\n== ci summary (${((performance.now() - started) / 1000).toFixed(1)} s, ${path.basename(process.execPath)} ${process.version})`,
);
for (const { stage, status, detail } of outcomes) console.log(`   ${stage.padEnd(12)} ${status.padEnd(8)} ${detail}`);
const incomplete = outcomes.filter((o) => o.status === 'SKIPPED' || o.detail.includes('SKIPPED'));
if (failed) {
  console.log('ci: FAILED');
  process.exit(1);
}
if (incomplete.length > 0) {
  console.log(
    `ci: INCOMPLETE — no failures, but ${String(incomplete.length)} stage(s) skipped or partial: ${incomplete.map((o) => o.stage).join(', ')}. This is not a full CI pass.`,
  );
} else {
  console.log('ci: PASSED (complete: every stage of every gating CI job ran)');
}
