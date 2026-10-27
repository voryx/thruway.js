#!/usr/bin/env node
// Declaration gate: type-check every emitted dist/**/*.d.ts with TypeScript 7 and `skipLibCheck: false`, so a stripped
// declaration that another declaration still needs — e.g. a file comment carrying the stripInternal tag, which removes
// that file's first statement — fails the build checks instead of shipping a broken .d.ts. The public entries' consumer
// view (TS 5.0–7, no DOM, no @types/node) is the consumer matrix's job (scripts/consumer-matrix.sh); this gate covers
// every file, internal ones included. Node types are loaded only for third-party declarations (rxjs 7's d.ts references
// `setTimeout`).
//
//   node scripts/dts-check.mjs [dir]     default: dist
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const dir = process.argv[2] ?? 'dist';
if (!existsSync(dir)) {
  console.error(`dts-check: ${dir} does not exist (run npm run build first)`);
  process.exit(1);
}
const files = readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort();
if (files.length === 0) {
  console.error(`dts-check: no .d.ts files under ${dir}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    'node_modules/typescript7/bin/tsc',
    '--ignoreConfig',
    '--noEmit',
    '--pretty',
    'false',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'es2022',
    '--lib',
    'es2022',
    '--types',
    'node',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    ...files,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stdout.write(`${result.stdout}${result.stderr}`);
  console.error(`dts-check: FAILED (${String(files.length)} declaration files)`);
  process.exit(1);
}
console.log(`dts-check: ${String(files.length)} declaration files type-check (TypeScript 7, skipLibCheck false)`);
