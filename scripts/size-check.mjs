#!/usr/bin/env node
// Size budget of the browser bundles: gzip (level 9) of dist/browser/thruway.min.js must stay within BUDGET bytes. The
// other bundles are reported, not budgeted.
//
// The client (state machine, four participants, liveness, challenge runner, auth helpers) minifies to ~114 kB, ~34.2 kB
// gzip. The budget below is the measured size plus ~6 % headroom, so growth is noticed.
//
//   node scripts/size-check.mjs [--budget <bytes>] [dir]     default dir: dist/browser
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

/** gzip level 9 bytes of dist/browser/thruway.min.js (measured 34 175 for 3.0, class names kept). */
export const BUDGET = 36_000;
const BUDGETED = 'thruway.min.js';
const FILES = ['thruway.js', BUDGETED, 'thruway.mjs'];

const args = process.argv.slice(2);
let budget = BUDGET;
let dir = 'dist/browser';
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? '';
  if (arg === '--budget') budget = Number(args[++i]);
  else if (!arg.startsWith('--')) dir = arg;
  else {
    console.error(`size-check: unknown argument ${arg} (usage: node scripts/size-check.mjs [--budget <bytes>] [dir])`);
    process.exit(2);
  }
}
if (!Number.isInteger(budget) || budget <= 0) {
  console.error('size-check: --budget needs a positive integer (bytes)');
  process.exit(2);
}

let failed = false;
for (const name of FILES) {
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    console.error(`size-check: ${file} does not exist (run npm run build first)`);
    process.exit(1);
  }
  const bytes = readFileSync(file);
  const gzip = gzipSync(bytes, { level: 9 }).length;
  const brotli = brotliCompressSync(bytes).length;
  const over = name === BUDGETED && gzip > budget;
  if (over) failed = true;
  const verdict =
    name === BUDGETED ? (over ? `OVER the ${String(budget)} B budget` : `within ${String(budget)} B`) : '';
  console.log(
    `size-check: ${name.padEnd(15)} ${String(bytes.length).padStart(7)} B, gzip ${String(gzip).padStart(6)} B, brotli ${String(brotli).padStart(6)} B ${verdict}`,
  );
}
if (failed) {
  console.error('size-check: FAILED');
  process.exit(1);
}
