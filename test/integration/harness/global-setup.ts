// Global setup of the integration project: starts the routers named by ROUTERS (unset or empty: the default set,
// Thruway PHP only; `all` for every router) through scripts/routers.mjs (the same script CI uses), provides their
// endpoints and readiness to the tests, and removes the containers it started at the end. ROUTERS_EXTERNAL=1 uses
// routers that are already running (nothing is started or stopped); KEEP_ROUTERS=1 leaves started routers running for
// the next run.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { AUXILIARY, DEFAULT_ROUTERS, HOSTILE, MATRIX, type Described, type RoutersContext } from './routers.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/routers.mjs', import.meta.url));

function script(args: readonly string[], inherit = false): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout };
}

export function selection(value: string | undefined): readonly string[] {
  const all = [...MATRIX, ...HOSTILE];
  const names = (value === undefined || value.trim() === '' ? DEFAULT_ROUTERS.join(',') : value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const chosen = names.includes('all') ? all : names.filter((n) => all.includes(n as (typeof all)[number]));
  return [...new Set(chosen.flatMap((id) => [id, ...(AUXILIARY[id] ?? [])]))];
}

export default function setup(project: TestProject): (() => void) | undefined {
  const selected = selection(process.env['ROUTERS']);
  const external = process.env['ROUTERS_EXTERNAL'] === '1';
  if (selected.length > 0 && !external) {
    console.log(`integration: starting ${selected.join(', ')} (scripts/routers.mjs start)`);
    script(['start', ...selected], true);
  }
  const described = JSON.parse(script(['describe', ...(selected.length > 0 ? selected : ['all'])]).stdout) as Record<
    string,
    Described
  >;
  const status =
    selected.length > 0
      ? (JSON.parse(script(['status', ...selected, '--json']).stdout) as { id: string; ready: boolean }[])
      : [];
  const ready = status.filter((s) => s.ready).map((s) => s.id);
  for (const id of selected) {
    const d = described[id];
    console.log(`integration: ${id.padEnd(17)} ${ready.includes(id) ? 'ready' : 'NOT AVAILABLE'}  ${d?.version ?? ''}`);
  }
  const context: RoutersContext = {
    selected,
    ready,
    described,
    require: process.env['REQUIRE_ROUTERS'] === '1',
  };
  project.provide('routers', context);
  if (external || process.env['KEEP_ROUTERS'] === '1' || selected.length === 0) return undefined;
  return () => {
    script(['stop', ...selected], true);
  };
}
