// globalSetup of the `node` project: a fresh `npm run build` (dist/esm, dist/cjs, dist/browser), then `npm pack` of
// that build, so the package tests (smoke, hazard, bundle-semantics, Jest 29 and the old-Node smoke) and
// test/node/{exit,no-ws}.test.ts run against exactly what would be published. The tarball's path is provided as
// `inject('tarball')`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { CACHE, REPO } from './helpers.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path of the packed thruway.js tarball of this run. */
    tarball: string;
  }
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

export default function setup(project: TestProject): void {
  rmSync(new URL('../../node_modules/.cache/thruway-package/', import.meta.url), { recursive: true, force: true });
  run(process.execPath, ['scripts/build.mjs']);
  const out = path.join(CACHE, 'pack');
  mkdirSync(out, { recursive: true });
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--pack-destination', out]);
  const tarball = readdirSync(out).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error(`npm pack wrote no tarball into ${out}`);
  project.provide('tarball', path.join(out, tarball));
}
