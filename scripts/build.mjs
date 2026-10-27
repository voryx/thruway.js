#!/usr/bin/env node
// Build: dist/esm (TS 7, tsconfig.build.json), dist/cjs (TS 7, tsconfig.build.cjs.json) + the nested
// dist/cjs/package.json {"type":"commonjs"}, and — when rspack.config.ts exists — the browser bundles (rspack 2) +
// dist/browser/package.json {"type":"commonjs"}. TypeScript 7 is called by explicit path: node_modules/.bin/tsc may be
// TS 6's (both packages ship a `tsc` bin).
//
//   node scripts/build.mjs [--no-bundles]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const TSC7 = 'node_modules/typescript7/bin/tsc';
const RSPACK = 'node_modules/@rspack/cli/bin/rspack.js';
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--no-bundles') {
    console.error(`build: unknown argument ${arg} (usage: node scripts/build.mjs [--no-bundles])`);
    process.exit(2);
  }
}

/**
 * Run `node <script> ...args`, inheriting stdio; exit on failure.
 * @param {string} label
 * @param {string[]} command
 */
function node(label, command) {
  const started = performance.now();
  const result = spawnSync(process.execPath, command, { stdio: 'inherit' });
  const ms = Math.round(performance.now() - started);
  if (result.status !== 0) {
    console.error(`build: ${label} failed (${result.error?.message ?? `exit ${String(result.status)}`})`);
    process.exit(1);
  }
  console.log(`build: ${label} (${String(ms)} ms)`);
}

/** @param {string} file */
function commonjsMarker(file) {
  writeFileSync(file, `${JSON.stringify({ type: 'commonjs' })}\n`);
}

rmSync('dist', { recursive: true, force: true });

node('dist/esm (TypeScript 7)', [TSC7, '-p', 'tsconfig.build.json']);
node('dist/cjs (TypeScript 7)', [TSC7, '-p', 'tsconfig.build.cjs.json']);
commonjsMarker('dist/cjs/package.json');

if (args.has('--no-bundles')) {
  console.log('build: browser bundles skipped (--no-bundles)');
} else if (existsSync('rspack.config.ts')) {
  node('dist/browser (rspack)', [RSPACK, 'build', '--config', 'rspack.config.ts']);
  mkdirSync('dist/browser', { recursive: true });
  commonjsMarker('dist/browser/package.json');
} else {
  console.log('build: no rspack.config.ts, browser bundles skipped');
}
