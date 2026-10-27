// Shared helpers of the package tests: scratch directories under node_modules/.cache, the packed tarball unpacked as an
// installed `thruway.js`, and child Node processes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const CACHE = path.join(REPO, 'node_modules', '.cache', 'thruway-package');

/** A fresh, empty directory under node_modules/.cache/thruway-package/tmp (unique; the node project's globalSetup
 *  empties tmp/ at the start of every run). */
export function scratch(name: string): string {
  mkdirSync(path.join(CACHE, 'tmp'), { recursive: true });
  return mkdtempSync(path.join(CACHE, 'tmp', `${name}-`));
}

/** Unpack the tarball as `<dir>/node_modules/thruway.js`, exactly what `npm install <tgz>` puts there (the package
 *  has no dependencies). `links` adds `<dir>/node_modules/<name>` symlinks to repo packages (e.g. rxjs: 'rxjs5'). */
export function installTarball(tarball: string, dir: string, links: Readonly<Record<string, string>> = {}): string {
  const target = path.join(dir, 'node_modules', 'thruway.js');
  mkdirSync(target, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarball, '-C', target, '--strip-components', '1'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  for (const [name, repoPackage] of Object.entries(links)) {
    const link = path.join(dir, 'node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(REPO, 'node_modules', repoPackage), link, 'dir');
  }
  return target;
}

export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Milliseconds from spawn to exit. */
  readonly ms: number;
}

/** Run a child process to its end (killed after `timeout` ms). */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, ms: performance.now() - started });
    });
    child.stdin.end(options.input ?? '');
  });
}

/** `node <args>` with this process's Node (or `node`). */
export function runNode(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; node?: string } = {},
): Promise<RunResult> {
  return run(options.node ?? process.execPath, args, options);
}

/** Every line of a child's stdout that is a JSON object, parsed. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
