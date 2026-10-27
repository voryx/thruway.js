// globalSetup of the interop project: load-order.test.ts runs the built package in child processes, so dist must exist
// and be newer than every source file. CI builds first (the `interop` stage of scripts/ci.mjs and
// .github/workflows/interop.yml); a local `npm run test:interop` gets a build here when needed.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRIES = ['esm/index.js', 'cjs/index.js', 'esm/testing/index.js', 'cjs/testing/index.js', 'esm/rxjs/index.js'];

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -Infinity;
  }
}

export default function setup(): void {
  const sources = readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => mtime(path.join(entry.parentPath, entry.name)));
  const built = Math.min(...ENTRIES.map((entry) => mtime(path.join(ROOT, 'dist', entry))));
  if (built >= Math.max(...sources)) return;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('interop globalSetup: npm run build failed');
}
