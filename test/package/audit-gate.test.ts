// scripts/audit-gate.mjs against recorded `npm audit --json` / `npm ls --omit=dev --all --json` outputs: it fails on an
// unlisted high (and critical) advisory, on an expired allowlist entry and on an entry for a production package,
// accepts a reviewed dev-only entry, reports moderate advisories, and never passes when npm audit itself failed. The
// committed allowlist must be valid today.
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO, runNode, scratch, writeFiles } from './helpers.js';

const FIXTURES = path.join(REPO, 'test/package/fixtures/audit');
const fixture = (name: string): string => path.join(FIXTURES, name);

const HIGH = { id: 'GHSA-8cj5-5rvv-wf4v', package: 'tar-fs' };

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...HIGH,
    reason: 'dev-only: reached through a packaging tool, never at runtime',
    reviewedBy: 'David Dan',
    added: '2026-10-01',
    expires: '2026-12-01',
    ...overrides,
  };
}

interface GateOptions {
  readonly prod?: string;
  readonly entries?: unknown[];
  readonly today?: string;
  /** The whole allowlist file content (default: `{entries}`). */
  readonly allowlist?: unknown;
}

async function gate(audit: string, options: GateOptions = {}) {
  const { prod = 'prod-empty.json', entries = [], today = '2026-10-26' } = options;
  const allowlist = 'allowlist' in options ? options.allowlist : { entries };
  const dir = scratch('audit-gate');
  writeFiles(dir, { 'allowlist.json': JSON.stringify(allowlist) });
  const result = await runNode([
    'scripts/audit-gate.mjs',
    '--audit',
    fixture(audit),
    '--prod-tree',
    fixture(prod),
    '--allowlist',
    path.join(dir, 'allowlist.json'),
    '--today',
    today,
  ]);
  return { ...result, output: result.stdout + result.stderr };
}

describe('audit-gate', () => {
  test('a clean tree passes', async () => {
    const r = await gate('audit-clean.json');
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('audit-gate: passed');
  });

  test('moderate advisories are reported, not blocking (a transitive "via" string is attributed to its package)', async () => {
    const r = await gate('audit-moderate.json');
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/reported\s+moderate\s+GHSA-q8mj-m7cp-5q26 qs/);
    expect(r.output).toContain('1 advisories in the whole tree');
  });

  test('an unlisted high advisory fails', async () => {
    const r = await gate('audit-high.json');
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('unlisted high advisory: GHSA-8cj5-5rvv-wf4v in tar-fs');
    expect(r.output).toContain('audit-gate: FAILED');
  });

  test('an unlisted critical advisory fails', async () => {
    const r = await gate('audit-critical.json');
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('unlisted critical advisory: GHSA-fjxv-7rqg-78g4 in form-data');
  });

  test('a reviewed, unexpired entry for a dev-only package allows its high advisory', async () => {
    const r = await gate('audit-high.json', { entries: [entry()] });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/allowed\s+high\s+GHSA-8cj5-5rvv-wf4v tar-fs .*until 2026-12-01/);
  });

  test('an entry for another package or another advisory does not allow it', async () => {
    for (const other of [entry({ package: 'tar' }), entry({ id: 'GHSA-q8mj-m7cp-5q26' })]) {
      const r = await gate('audit-high.json', { entries: [other] });
      expect(r.status, r.output).toBe(1);
      expect(r.output).toContain('unlisted high advisory: GHSA-8cj5-5rvv-wf4v in tar-fs');
      expect(r.output).toContain('unused allowlist entry');
    }
  });

  test('an entry is valid through its expiry day and expired the day after', async () => {
    const last = await gate('audit-high.json', { entries: [entry()], today: '2026-12-01' });
    expect(last.status, last.output).toBe(0);
    const after = await gate('audit-high.json', { entries: [entry()], today: '2026-12-02' });
    expect(after.status, after.output).toBe(1);
  });

  test('an expired allowlist entry fails the gate, even though it matches', async () => {
    const r = await gate('audit-high.json', { entries: [entry()], today: '2026-12-02' });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('EXPIRED on 2026-12-01');
  });

  test('an expired entry fails even when its advisory is gone', async () => {
    const r = await gate('audit-clean.json', { entries: [entry()], today: '2027-01-01' });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('EXPIRED');
  });

  test('an entry for a package in the production tree is refused', async () => {
    const r = await gate('audit-high.json', { entries: [entry()], prod: 'prod-tar-fs.json' });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('tar-fs is in the production tree; only dev-only packages may be allowlisted');
  });

  test('an entry valid for more than 90 days, or with missing fields or a bad id, is refused', async () => {
    const long = await gate('audit-high.json', { entries: [entry({ added: '2026-10-01', expires: '2027-01-01' })] });
    expect(long.status, long.output).toBe(1);
    expect(long.output).toContain('expires must be at most 90 days after added');
    const ninety = await gate('audit-high.json', { entries: [entry({ added: '2026-10-01', expires: '2026-12-30' })] });
    expect(ninety.status, ninety.output).toBe(0);
    const ninetyOne = await gate('audit-high.json', {
      entries: [entry({ added: '2026-10-01', expires: '2026-12-31' })],
    });
    expect(ninetyOne.status, ninetyOne.output).toBe(1);
    expect(ninetyOne.output).toContain('expires must be at most 90 days after added');
    const backwards = await gate('audit-high.json', {
      entries: [entry({ added: '2026-10-02', expires: '2026-10-01' })],
    });
    expect(backwards.status, backwards.output).toBe(1);
    expect(backwards.output).toContain('expires must be at most 90 days after added');
    const missing = await gate('audit-high.json', { entries: [{ ...entry(), reviewedBy: '' }] });
    expect(missing.status, missing.output).toBe(1);
    expect(missing.output).toContain('missing or empty reviewedBy');
    const badId = await gate('audit-clean.json', { entries: [entry({ id: 'CVE-2026-0001' })] });
    expect(badId.status, badId.output).toBe(1);
    expect(badId.output).toContain('id is not a GHSA id');
    const badDate = await gate('audit-clean.json', { entries: [entry({ expires: '2026-02-30' })] });
    expect(badDate.status, badDate.output).toBe(1);
    expect(badDate.output).toContain('added/expires must be dates');
    const shape = await gate('audit-clean.json', { allowlist: [] });
    expect(shape.status, shape.output).toBe(1);
    expect(shape.output).toContain('expected an object with an "entries" array');
  });

  test('npm audit failing (no registry) fails the gate instead of passing it', async () => {
    const r = await gate('audit-error.json');
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('npm audit reported an error: request to https://registry.npmjs.org');
  });

  test('usage errors exit 2', async () => {
    expect((await runNode(['scripts/audit-gate.mjs', '--bogus'])).status).toBe(2);
    expect((await runNode(['scripts/audit-gate.mjs', '--today'])).status).toBe(2);
    const badDay = await runNode(['scripts/audit-gate.mjs', '--audit', fixture('audit-clean.json'), '--today', 'x']);
    expect(badDay.status).toBe(2);
  });

  test('the committed audit-allowlist.json is valid today against the real production tree', async () => {
    const r = await runNode(['scripts/audit-gate.mjs', '--audit', fixture('audit-clean.json')]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('0 production packages');
  });
});
