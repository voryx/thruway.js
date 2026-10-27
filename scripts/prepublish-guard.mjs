#!/usr/bin/env node
// Release guard: `prepublishOnly` runs this, and the `package` CI job runs it before it uploads the tarball. It refuses
// to continue unless
//   1. `git status --porcelain` is empty (no modified, staged or untracked file) and — for a publish (`npm_command`
//      is `publish`) or with --release — HEAD is the commit the tag v<version> points at;
//   2. a fresh build succeeds: dist is deleted here (a literal path) and `npm run build` runs, so no stale output of
//      the working tree can ship; the build must leave the tree clean;
//   3. `npm pack --dry-run --json` lists exactly test/package/files.snapshot.txt (the diff is printed);
//   4. no packed file contains a debug marker (`console.log`, `outbound msg`, `debugger`, `.only(`,
//      `sourceMappingURL=data:`). Markdown files may show `console.log` in examples.
//
//   node scripts/prepublish-guard.mjs [--release]
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SNAPSHOT = 'test/package/files.snapshot.txt';
export const MARKERS = ['console.log', 'outbound msg', 'debugger', '.only(', 'sourceMappingURL=data:'];

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== '--release') {
    console.error(`prepublish-guard: unknown argument ${arg} (usage: node scripts/prepublish-guard.mjs [--release])`);
    process.exit(2);
  }
}
const release = args.includes('--release') || process.env['npm_command'] === 'publish';

/** @param {string} reason @returns {never} */
function refuse(reason) {
  console.error(`prepublish-guard: REFUSED: ${reason}`);
  process.exit(1);
}

/** @param {string} command @param {string[]} commandArgs */
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined) refuse(`could not run ${command} ${commandArgs.join(' ')}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function field(value, key) {
  return typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
}

/** @param {string} when */
function requireCleanTree(when) {
  const status = run('git', ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) refuse(`git status failed (${status.stderr.trim()}); the guard needs a git checkout`);
  if (status.stdout.trim() !== '') {
    refuse(`the working tree is not clean ${when}:\n${status.stdout.trimEnd()}\n(commit or remove these files)`);
  }
}

// 1. clean tree, and the tagged commit for a release
requireCleanTree('');
const manifest = /** @type {unknown} */ (JSON.parse(readFileSync('package.json', 'utf8')));
const version = String(field(manifest, 'version'));
if (release) {
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const tag = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`]);
  if (tag.status !== 0) refuse(`a release needs the tag v${version} on HEAD, and there is no such tag`);
  if (tag.stdout.trim() !== head) refuse(`the tag v${version} points at ${tag.stdout.trim()}, not at HEAD ${head}`);
}

// 2. a fresh build
rmSync('dist', { recursive: true, force: true });
const build = spawnSync(NPM, ['run', 'build'], { stdio: 'inherit' });
if (build.status !== 0)
  refuse(`the fresh build failed (exit ${String(build.status)}); nothing may ship from an old dist`);
requireCleanTree('after the build');

// 3. the packed file list
const pack = run(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts']);
if (pack.status !== 0) refuse(`npm pack --dry-run failed: ${pack.stderr.trim()}`);
/** @type {unknown} */
let listing;
try {
  listing = JSON.parse(pack.stdout);
} catch (error) {
  refuse(`npm pack --dry-run --json printed no JSON (${error instanceof Error ? error.message : String(error)})`);
}
const files = field(Array.isArray(listing) ? /** @type {unknown[]} */ (listing)[0] : undefined, 'files');
const packed = (Array.isArray(files) ? /** @type {unknown[]} */ (files) : [])
  .map((file) => field(file, 'path'))
  .filter((file) => typeof file === 'string')
  .sort();
if (packed.length === 0) refuse('npm pack --dry-run --json listed no files');
const expected = readFileSync(SNAPSHOT, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .sort();
const added = packed.filter((file) => !expected.includes(file));
const missing = expected.filter((file) => !packed.includes(file));
if (added.length > 0 || missing.length > 0) {
  const diff = [...added.map((file) => `+ ${file}`), ...missing.map((file) => `- ${file}`)].join('\n');
  refuse(`the packed files differ from ${SNAPSHOT} (+ packed but not listed, - listed but not packed):\n${diff}`);
}

// 4. debug markers
/** @type {string[]} */
const found = [];
for (const file of packed) {
  const text = readFileSync(file, 'utf8');
  for (const marker of MARKERS) {
    if (marker === 'console.log' && file.endsWith('.md')) continue;
    if (text.includes(marker)) found.push(`${file}: ${marker}`);
  }
}
if (found.length > 0) refuse(`debug markers in packed files:\n${found.join('\n')}`);

console.log(
  `prepublish-guard: passed (${release ? `release v${version} on HEAD, ` : ''}clean tree, fresh build, ${String(packed.length)} files as in ${SNAPSHOT}, no debug markers)`,
);
