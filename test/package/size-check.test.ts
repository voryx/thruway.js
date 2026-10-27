// scripts/size-check.mjs (the size budget): the gzip size of thruway.min.js over the budget fails, at or under it
// passes, a missing bundle fails, and the shipped bundles of this run (the node project's fresh build) are within the
// committed budget.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { REPO, runNode, scratch, writeFiles } from './helpers.js';

/** A dist/browser look-alike whose thruway.min.js does not compress (random bytes). */
function bundles(minBytes: number): { dir: string; gzip: number } {
  const dir = scratch('size-check');
  const min = randomBytes(minBytes);
  writeFiles(dir, { 'thruway.js': 'var a = 1;\n', 'thruway.mjs': 'export {};\n' });
  writeFileSync(path.join(dir, 'thruway.min.js'), min);
  return { dir, gzip: gzipSync(min, { level: 9 }).length };
}

const sizeCheck = (args: string[]) => runNode(['scripts/size-check.mjs', ...args]);

describe('size-check', () => {
  test('over the budget fails; exactly at the budget passes', async () => {
    const { dir, gzip } = bundles(4000);
    const over = await sizeCheck(['--budget', String(gzip - 1), dir]);
    expect(over.status, over.stdout + over.stderr).toBe(1);
    expect(over.stdout).toContain(`OVER the ${String(gzip - 1)} B budget`);
    const at = await sizeCheck(['--budget', String(gzip), dir]);
    expect(at.status, at.stdout + at.stderr).toBe(0);
    expect(at.stdout).toMatch(new RegExp(`thruway\\.min\\.js .* gzip +${String(gzip)} B,.*within ${String(gzip)} B`));
  });

  test('only thruway.min.js is budgeted; a missing bundle fails; a bad budget is a usage error', async () => {
    const { dir } = bundles(100);
    writeFileSync(path.join(dir, 'thruway.js'), randomBytes(100_000)); // large, but not budgeted
    expect((await sizeCheck(['--budget', '1000', dir])).status).toBe(0);
    expect((await sizeCheck([path.join(dir, 'nowhere')])).status).toBe(1);
    expect((await sizeCheck(['--budget', '0', dir])).status).toBe(2);
    expect((await sizeCheck(['--budget', 'x', dir])).status).toBe(2);
    expect((await sizeCheck(['--bogus'])).status).toBe(2);
  });

  test('the bundles of this build are within the committed budget', async () => {
    const r = await sizeCheck([path.join(REPO, 'dist/browser')]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/thruway\.min\.js .* within \d+ B/);
  });
});
