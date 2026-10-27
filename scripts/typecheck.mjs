#!/usr/bin/env node
// Typecheck: TypeScript 7 *and* TypeScript 6 over every project — tsconfig.src.json (es2020 lib, no DOM, no node),
// test/tsconfig.json, tsconfig.tools.json, test/types/node-only — then the canary: the deliberately broken type test
// must fail, with exactly its marked errors, under both compilers and through vitest's typecheck (TS 7). Each compiler
// is called by explicit path: node_modules/.bin/tsc may be TS 6's (both packages ship a `tsc` bin).
//
//   node scripts/typecheck.mjs [--no-vitest-canary]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const COMPILERS = [
  { name: 'TypeScript 7', bin: 'node_modules/typescript7/bin/tsc' },
  { name: 'TypeScript 6', bin: 'node_modules/typescript/bin/tsc6' },
];
const PROJECTS = [
  'tsconfig.src.json',
  'test/tsconfig.json',
  'tsconfig.tools.json',
  'test/types/node-only/tsconfig.json',
];
const CANARY_PROJECT = 'test/types/tsconfig.canary.json';
const CANARY_FILE = 'test/types/canary-fail.test-d.ts';

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--no-vitest-canary') {
    console.error(`typecheck: unknown argument ${arg} (usage: node scripts/typecheck.mjs [--no-vitest-canary])`);
    process.exit(2);
  }
}

/**
 * @param {string[]} command
 * @param {Record<string, string>} [env]
 * @returns {{ status: number | null, output: string, ms: number }}
 */
function run(command, env = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, command, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}${result.error ? String(result.error) : ''}`,
    ms: Math.round(performance.now() - started),
  };
}

let failed = false;

for (const compiler of COMPILERS) {
  const version = run([compiler.bin, '--version']).output.trim();
  console.log(`typecheck: ${compiler.name} (${version})`);
  for (const project of PROJECTS) {
    const { status, output, ms } = run([compiler.bin, '-p', project, '--pretty', 'false']);
    if (status === 0) {
      console.log(`  ok    ${project} (${String(ms)} ms)`);
    } else {
      failed = true;
      console.log(`  FAIL  ${project} (exit ${String(status)})`);
      process.stdout.write(output.replace(/^/gm, '        '));
    }
  }
}

// --- the canary -----------------------------------------------------------------------------------------------
const canaryLines = readFileSync(CANARY_FILE, 'utf8')
  .split('\n')
  .flatMap((line, index) => (line.includes('// CANARY') ? [index + 1] : []));
if (canaryLines.length === 0) {
  console.log(`typecheck: FAIL — ${CANARY_FILE} has no "// CANARY" line`);
  process.exit(1);
}

for (const compiler of COMPILERS) {
  const { status, output } = run([compiler.bin, '-p', CANARY_PROJECT, '--pretty', 'false']);
  const errors = [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+):/gm)].map((m) => ({
    file: m[1] ?? '',
    line: Number(m[2]),
    code: m[3] ?? '',
  }));
  const expected =
    errors.length === canaryLines.length && errors.every((e) => e.file === CANARY_FILE && canaryLines.includes(e.line));
  if (status !== 0 && expected) {
    console.log(
      `typecheck: canary fails as required under ${compiler.name} (${errors.map((e) => `${e.code} line ${String(e.line)}`).join(', ')})`,
    );
  } else {
    failed = true;
    console.log(
      status === 0
        ? `typecheck: FAIL — the canary compiled cleanly under ${compiler.name}: type tests are not being checked`
        : `typecheck: FAIL — the canary failed under ${compiler.name}, but not (only) on its CANARY lines ${canaryLines.join(', ')}:`,
    );
    if (status !== 0) process.stdout.write(output.replace(/^/gm, '        '));
  }
}

if (!args.has('--no-vitest-canary')) {
  const { status, output } = run(['node_modules/vitest/vitest.mjs', 'run', '--project', 'unit'], {
    THRUWAY_TYPECHECK_CANARY: '1',
  });
  const reported = output.includes(CANARY_FILE) && output.includes('TypeCheckError') && /Tests\s+1 failed/.test(output);
  if (status !== 0 && reported) {
    console.log('typecheck: canary fails as required under vitest typecheck (TypeScript 7)');
  } else {
    failed = true;
    console.log('typecheck: FAIL — vitest typecheck did not report the canary as the only failing type test:');
    process.stdout.write(output.replace(/^/gm, '        '));
  }
}

if (failed) {
  console.log('typecheck: FAILED');
  process.exit(1);
}
console.log('typecheck: all projects clean under TypeScript 7 and 6; the canary fails');
