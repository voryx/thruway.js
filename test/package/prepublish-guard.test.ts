// scripts/prepublish-guard.mjs, the release guard (one negative test per check). Each case runs the real script in a
// throwaway git repository that holds a copy of everything the build and `npm pack` read (src, scripts, tsconfigs,
// rspack config, package.json, docs, the file-list snapshot; node_modules linked), so the guard deletes, rebuilds and
// packs for real.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO, runNode, scratch } from './helpers.js';

const COPIED = [
  'package.json',
  'LICENSE',
  'README.md',
  'MIGRATION.md',
  'CHANGELOG.md',
  'tsconfig.src.json',
  'tsconfig.build.json',
  'tsconfig.build.cjs.json',
  'rspack.config.ts',
  'scripts/build.mjs',
  'scripts/prepublish-guard.mjs',
  'test/package/files.snapshot.txt',
  'src',
];

function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function fixtureRepo(): string {
  const dir = scratch('guard');
  for (const entry of COPIED) {
    if (existsSync(path.join(REPO, entry))) cpSync(path.join(REPO, entry), path.join(dir, entry), { recursive: true });
  }
  writeFileSync(path.join(dir, '.gitignore'), `${readFileSync(path.join(REPO, '.gitignore'), 'utf8')}node_modules\n`);
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

function commit(dir: string, change: () => void): void {
  change();
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
}

async function guard(dir: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ...env };
  if (env['npm_command'] === undefined) delete childEnv['npm_command'];
  const result = await runNode(['scripts/prepublish-guard.mjs', ...args], {
    cwd: dir,
    env: childEnv,
    timeout: 120_000,
  });
  return { ...result, output: result.stdout + result.stderr };
}

const MARKERS = ['console.log', 'outbound msg', 'debugger', '.only(', 'sourceMappingURL=data:'];

describe.concurrent('prepublish-guard', () => {
  test('passes on a clean, committed tree; a stale dist left in the checkout is deleted, never packed', async () => {
    const dir = fixtureRepo();
    mkdirSync(path.join(dir, 'dist/esm'), { recursive: true });
    writeFileSync(path.join(dir, 'dist/esm/stale-leftover.js'), 'export const stale = 1;\n'); // dist is ignored
    const r = await guard(dir);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/prepublish-guard: passed \(clean tree, fresh build, \d+ files as in/);
    expect(existsSync(path.join(dir, 'dist/esm/stale-leftover.js'))).toBe(false);
    expect(existsSync(path.join(dir, 'dist/browser/thruway.min.js'))).toBe(true);
  });

  test('refuses a dirty tree: an untracked file, a modified file, a staged change', async () => {
    const dir = fixtureRepo();
    writeFileSync(path.join(dir, 'notes.txt'), 'scratch\n');
    let r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('REFUSED: the working tree is not clean');
    expect(r.output).toContain('?? notes.txt');
    rmSync(path.join(dir, 'notes.txt'));
    appendFileSync(path.join(dir, 'src/yield.ts'), '\n');
    r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(' M src/yield.ts');
    git(dir, 'add', 'src/yield.ts');
    r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('M  src/yield.ts');
  });

  test('refuses a stale dist: when the fresh build fails, the old dist is not shipped', async () => {
    const dir = fixtureRepo();
    mkdirSync(path.join(dir, 'dist/esm'), { recursive: true });
    writeFileSync(path.join(dir, 'dist/esm/index.js'), '// stale\n'); // an old build
    commit(dir, () => {
      appendFileSync(path.join(dir, 'src/yield.ts'), "\nexport const broken: number = 'not a number';\n");
    });
    const r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('REFUSED: the fresh build failed');
    expect(readFileSync(path.join(dir, 'dist/esm/index.js'), 'utf8')).not.toContain('// stale'); // deleted first
  });

  test('deletes dist itself before the build (it does not rely on scripts/build.mjs cleaning it)', async () => {
    const dir = fixtureRepo();
    commit(dir, () => {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      manifest.scripts['build'] =
        `node -e "process.exit(require('node:fs').existsSync('dist') ? 7 : 0)" && node scripts/build.mjs`;
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    });
    mkdirSync(path.join(dir, 'dist/esm'), { recursive: true });
    writeFileSync(path.join(dir, 'dist/esm/index.js'), '// stale\n');
    const r = await guard(dir);
    expect(r.status, r.output).toBe(0);
  });

  test('refuses a build that changes a tracked file (the tree must still be clean after the build)', async () => {
    const dir = fixtureRepo();
    commit(dir, () => {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      manifest.scripts['build'] =
        `node scripts/build.mjs && node -e "require('node:fs').appendFileSync('src/yield.ts', '// generated\\n')"`;
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    });
    const r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('REFUSED: the working tree is not clean after the build');
    expect(r.output).toContain(' M src/yield.ts');
  });

  test('refuses a file-list diff: a packed file the snapshot lacks, and a listed file that is not packed', async () => {
    const dir = fixtureRepo();
    commit(dir, () => {
      writeFileSync(path.join(dir, 'src/notes.txt'), 'shipped by accident\n');
      rmSync(path.join(dir, 'LICENSE'));
    });
    const r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('REFUSED: the packed files differ from test/package/files.snapshot.txt');
    expect(r.output).toContain('+ src/notes.txt');
    expect(r.output).toContain('- LICENSE');
  });

  test.for(MARKERS)('refuses the debug marker %s in a packed file', async (marker) => {
    const dir = fixtureRepo();
    commit(dir, () => {
      appendFileSync(path.join(dir, 'src/yield.ts'), `\n// left over: ${marker}\n`);
    });
    const r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('REFUSED: debug markers in packed files');
    expect(r.output).toContain(`src/yield.ts: ${marker}`);
  });

  test('Markdown may show console.log in examples, but no other marker', async () => {
    const dir = fixtureRepo();
    commit(dir, () => {
      appendFileSync(path.join(dir, 'README.md'), '\n```js\nclient.call("a").subscribe((r) => console.log(r));\n```\n');
    });
    expect((await guard(dir)).status).toBe(0);
    commit(dir, () => {
      appendFileSync(path.join(dir, 'README.md'), '\n```js\ndescribe.only("x", () => {});\n```\n');
    });
    const r = await guard(dir);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('README.md: .only(');
  });

  test('a release (--release, or npm_command=publish) refuses a HEAD without the tag v<version>', async () => {
    const dir = fixtureRepo();
    const version = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
    for (const r of [await guard(dir, ['--release']), await guard(dir, [], { npm_command: 'publish' })]) {
      expect(r.status, r.output).toBe(1);
      expect(r.output).toContain(`REFUSED: a release needs the tag v${version} on HEAD`);
    }
  });

  test('an unknown argument is a usage error', async () => {
    const r = await runNode(['scripts/prepublish-guard.mjs', '--force']);
    expect(r.status).toBe(2);
  });
});
