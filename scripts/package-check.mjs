#!/usr/bin/env node
// Package checks (`npm run package:check`): on a built dist (npm run build), in order
//   ES2020 gate (self-test, then dist) · publint --strict · attw --pack . · size budget · npm pack (the tarball the
//   remaining steps use) · TypeScript consumer matrix · Jest 29 consumer · Node 22.0.0/22.4.0 smoke · Hermes smoke.
// scripts/ci.mjs imports `packageCheckSteps()` and runs the same steps one by one in its package stage, so the
// workflow, `npm run ci` and `npm run package:check` cannot drift.
//
//   node scripts/package-check.mjs                 every step
//   node scripts/package-check.mjs --step <name>   one step (jest29 is implemented here)
//   node scripts/package-check.mjs --list
//
// A step whose external tooling is missing (no Jest/TypeScript in the npm cache while offline, no old Node binary, no
// Hermes) exits with status 3 = SKIPPED and says what is missing; with CI=true that is a failure instead. Downloads
// happen only with THRUWAY_ALLOW_NETWORK=1 (the CI workflows set it); locally every install is --offline.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** Exit status of a step whose tooling is unavailable (SKIPPED unless CI). */
export const UNAVAILABLE = 3;
export const PACK_DIR = 'node_modules/.cache/thruway-package-check';

/**
 * A step: `command` runs it; a `skipStatus` exit means its tooling is unavailable (SKIPPED); `skip` (from
 * PACKAGE_CHECK_SKIP) means it was skipped on purpose (the package workflow runs the Hermes smoke on macOS).
 * @typedef {{ id: string, name: string, command: string[], skipStatus?: number }} RunStep
 * @typedef {{ id: string, name: string, skip: string }} SkipStep
 * @typedef {RunStep | SkipStep} Step
 */

/** The tarball `npm pack` wrote into PACK_DIR (the `pack` step). */
export function packedTarball() {
  const found = existsSync(path.join(ROOT, PACK_DIR))
    ? readdirSync(path.join(ROOT, PACK_DIR)).find((name) => name.endsWith('.tgz'))
    : undefined;
  return found === undefined ? undefined : path.join(ROOT, PACK_DIR, found);
}

/** Every step, in order; PACKAGE_CHECK_SKIP=<id,...> marks steps as skipped. @returns {Step[]} */
export function packageCheckSteps() {
  const node = process.execPath;
  const self = 'scripts/package-check.mjs';
  /** @type {RunStep[]} */
  const steps = [
    {
      id: 'es2020-self-test',
      name: 'ES2020 gate self-test (TS 7 downlevel)',
      command: [node, 'scripts/es2020-check.mjs', '--self-test'],
    },
    { id: 'es2020', name: 'ES2020 gate on dist', command: [node, 'scripts/es2020-check.mjs', 'dist'] },
    { id: 'publint', name: 'publint --strict', command: [node, 'node_modules/publint/src/cli.js', '--strict'] },
    {
      id: 'attw',
      name: 'attw --pack .',
      command: [node, 'node_modules/@arethetypeswrong/cli/dist/index.js', '--pack', '.'],
    },
    { id: 'size', name: 'size budget (scripts/size-check.mjs)', command: [node, 'scripts/size-check.mjs'] },
    { id: 'pack', name: `npm pack into ${PACK_DIR}`, command: [node, self, '--step', 'pack'] },
    {
      id: 'consumer-matrix',
      name: 'TypeScript consumer matrix (scripts/consumer-matrix.sh)',
      command: [node, self, '--step', 'consumer-matrix'],
      skipStatus: UNAVAILABLE,
    },
    {
      id: 'jest29',
      name: 'Jest 29 consumer (test/consumers/jest29)',
      command: [node, self, '--step', 'jest29'],
      skipStatus: UNAVAILABLE,
    },
    {
      id: 'node-old',
      name: 'Node 22.0.0 / 22.4.0 smoke (scripts/node-old-smoke.mjs)',
      command: [node, self, '--step', 'node-old'],
      skipStatus: UNAVAILABLE,
    },
    {
      id: 'hermes',
      name: 'Hermes smoke (scripts/hermes-smoke.mjs)',
      command: [node, 'scripts/hermes-smoke.mjs'],
      skipStatus: UNAVAILABLE,
    },
  ];
  const skipped = new Set((process.env['PACKAGE_CHECK_SKIP'] ?? '').split(',').filter((id) => id !== ''));
  for (const id of skipped) {
    if (!steps.some((step) => step.id === id)) throw new Error(`PACKAGE_CHECK_SKIP: unknown step ${id}`);
  }
  return steps.map((step) =>
    skipped.has(step.id) ? { id: step.id, name: step.name, skip: 'PACKAGE_CHECK_SKIP' } : step,
  );
}

/** @param {string} reason @returns {never} */
export function unavailable(reason) {
  if (process.env['CI'] === 'true' || process.env['CI'] === '1') {
    console.error(`${reason}\n(CI: missing tooling is a failure)`);
    process.exit(1);
  }
  console.error(`SKIPPED: ${reason}`);
  process.exit(UNAVAILABLE);
}

/** @param {string} command @param {string[]} args @param {{ cwd?: string, quiet?: boolean, timeout?: number }} [options] */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.quiet === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...(options.timeout === undefined ? {} : { timeout: options.timeout, killSignal: 'SIGKILL' }),
  });
  if (result.error !== undefined) console.error(`package-check: ${command} ${args.join(' ')}: ${result.error.message}`);
  // stdout/stderr are null with stdio 'inherit'
  /** @type {(string | null)[]} */
  const streams = [result.stdout, result.stderr];
  return { status: result.status ?? 1, output: streams.map((s) => s ?? '').join('') };
}

const allowNetwork = process.env['THRUWAY_ALLOW_NETWORK'] === '1';

function pack() {
  rmSync('node_modules/.cache/thruway-package-check', { recursive: true, force: true });
  mkdirSync(PACK_DIR, { recursive: true });
  if (!existsSync(path.join(ROOT, 'dist/esm/index.js'))) {
    console.error('package-check: dist is missing (run npm run build first)');
    process.exit(1);
  }
  const result = run(NPM, ['pack', '--ignore-scripts', '--pack-destination', PACK_DIR], { quiet: true });
  const tarball = packedTarball();
  if (result.status !== 0 || tarball === undefined) {
    console.error(`package-check: npm pack failed\n${result.output}`);
    process.exit(1);
  }
  console.log(`package-check: packed ${path.relative(ROOT, tarball)}`);
}

/** @returns {string} */
function requireTarball() {
  const tarball = packedTarball();
  if (tarball === undefined) {
    console.error(
      'package-check: no packed tarball (run the pack step first: node scripts/package-check.mjs --step pack)',
    );
    process.exit(1);
  }
  return tarball;
}

function consumerMatrix() {
  const result = spawnSync('bash', ['scripts/consumer-matrix.sh', requireTarball()], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0 && !allowNetwork) {
    // the matrix prints its own reason; an install failure offline means missing tooling, not a failed cell
    const tools = path.join(ROOT, 'node_modules/.cache/thruway-consumers/tools/node_modules/ts7');
    if (!existsSync(tools))
      unavailable('consumer-matrix: TypeScript versions not in the npm cache (THRUWAY_ALLOW_NETWORK=1)');
  }
  process.exit(result.status ?? 1);
}

/** Install jest 29.7.0 into `dir` (npm; offline: npm --offline, then yarn --offline from the Yarn cache).
 *  @param {string} dir */
function installJest(dir) {
  const npmArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'];
  if (allowNetwork) return run(NPM, npmArgs, { cwd: dir, quiet: true }).status === 0;
  if (run(NPM, [...npmArgs, '--offline'], { cwd: dir, quiet: true }).status === 0) return true;
  const yarn = run('yarn', ['--version'], { cwd: dir, quiet: true });
  if (yarn.status !== 0) return false;
  const args = ['install', '--offline', '--ignore-scripts', '--non-interactive', '--no-progress', '--no-lockfile'];
  return run('yarn', args, { cwd: dir, quiet: true }).status === 0;
}

function jest29() {
  const tarball = requireTarball();
  rmSync('node_modules/.cache/thruway-jest29', { recursive: true, force: true });
  const dir = path.join(ROOT, 'node_modules/.cache/thruway-jest29');
  cpSync('test/consumers/jest29', dir, { recursive: true });
  if (!installJest(dir)) {
    unavailable('jest29: jest 29.7.0 could not be installed offline (npm or Yarn cache); set THRUWAY_ALLOW_NETWORK=1');
  }
  mkdirSync(path.join(dir, 'node_modules/thruway.js'), { recursive: true });
  const untar = run('tar', [
    '-xzf',
    tarball,
    '-C',
    path.join(dir, 'node_modules/thruway.js'),
    '--strip-components',
    '1',
  ]);
  if (untar.status !== 0) process.exit(1);
  symlinkSync(path.join(ROOT, 'node_modules/rxjs5'), path.join(dir, 'node_modules/rxjs'), 'dir');
  // bounded: a client left reconnecting on real timers keeps Jest from exiting (killed ⇒ status 1)
  const jest = run(process.execPath, ['node_modules/jest/bin/jest.js', '--ci', '--colors=false'], {
    cwd: dir,
    timeout: 300_000,
  });
  process.exit(jest.status);
}

function nodeOld() {
  const result = spawnSync(process.execPath, ['scripts/node-old-smoke.mjs', requireTarball()], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

/** @type {Record<string, () => void>} */
const STEPS = { pack, 'consumer-matrix': consumerMatrix, jest29, 'node-old': nodeOld };

function main() {
  process.chdir(ROOT);
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    for (const step of packageCheckSteps()) console.log(`${step.id.padEnd(17)} ${step.name}`);
    return;
  }
  if (args[0] === '--step') {
    const step = STEPS[args[1] ?? ''];
    if (step === undefined || args.length !== 2) {
      console.error(`package-check: --step needs one of ${Object.keys(STEPS).join(', ')}`);
      process.exit(2);
    }
    step();
    return;
  }
  if (args.length > 0) {
    console.error('usage: node scripts/package-check.mjs [--list | --step <name>]');
    process.exit(2);
  }
  /** @type {{ name: string, status: string }[]} */
  const outcomes = [];
  for (const step of packageCheckSteps()) {
    console.log(`\n-- package-check: ${step.name}`);
    if ('skip' in step) {
      console.log(`   SKIPPED on purpose (${step.skip})`);
      outcomes.push({ name: step.name, status: 'OMITTED' });
      continue;
    }
    const [command = '', ...rest] = step.command;
    const { status } = run(command, rest);
    const verdict = status === 0 ? 'PASSED' : step.skipStatus === status ? 'SKIPPED' : 'FAILED';
    outcomes.push({ name: step.name, status: verdict });
    if (verdict === 'FAILED') break;
  }
  console.log('\n== package-check summary');
  for (const { name, status } of outcomes) console.log(`   ${status.padEnd(8)} ${name}`);
  if (outcomes.some((o) => o.status === 'FAILED')) {
    console.log('package-check: FAILED');
    process.exit(1);
  }
  if (outcomes.some((o) => o.status === 'SKIPPED')) {
    console.log('package-check: INCOMPLETE (steps skipped for missing tooling; this is not a full pass)');
    process.exit(UNAVAILABLE);
  }
  const omitted = outcomes.filter((o) => o.status === 'OMITTED').map((o) => o.name);
  console.log(
    `package-check: passed${omitted.length > 0 ? ` (omitted by PACKAGE_CHECK_SKIP: ${omitted.join('; ')})` : ''}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
