#!/usr/bin/env node
// ES2020 gate: parse every emitted .js/.mjs/.cjs file with acorn `ecmaVersion: 2020` and fail on any later syntax
// (Hermes and untranspiled consumers). `.js` files are parsed as modules or scripts by the nearest package.json "type"
// (dist/cjs and dist/browser carry {"type":"commonjs"}).
//
//   node scripts/es2020-check.mjs [dir|file ...]     default: dist
//   node scripts/es2020-check.mjs --self-test        TS 7 lowers test/fixtures/es2020-sample at es2020 (gate passes)
//                                                    and keeps ES2022 syntax at es2022 (gate fails)
import { parse } from 'acorn';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** @param {string} file @returns {unknown} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file @returns {'module' | 'script'} */
function sourceType(file) {
  if (file.endsWith('.mjs')) return 'module';
  if (file.endsWith('.cjs')) return 'script';
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = readJson(manifest);
      const type = typeof json === 'object' && json !== null && 'type' in json ? json.type : undefined;
      return type === 'module' ? 'module' : 'script';
    }
    if (path.dirname(dir) === dir) return 'script';
  }
}

/**
 * @param {readonly string[]} targets
 * @returns {{ files: number, failures: { file: string, message: string }[] }}
 */
export function check(targets) {
  /** @type {{ file: string, message: string }[]} */
  const failures = [];
  let files = 0;
  for (const target of targets) {
    for (const file of jsFiles(target)) {
      files++;
      try {
        parse(readFileSync(file, 'utf8'), { ecmaVersion: 2020, sourceType: sourceType(file), allowHashBang: true });
      } catch (error) {
        failures.push({ file, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { files, failures };
}

/** @param {string} target @param {string} outDir */
function compileSample(target, outDir) {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript7/bin/tsc',
      '--ignoreConfig',
      'test/fixtures/es2020-sample/sample.ts',
      '--target',
      target,
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--useDefineForClassFields',
      target === 'es2020' ? 'false' : 'true',
      '--strict',
      '--types',
      '',
      '--outDir',
      outDir,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`es2020-check: TypeScript 7 failed to compile the sample at ${target}`);
  }
}

function selfTest() {
  rmSync('node_modules/.cache/es2020-check', { recursive: true, force: true });
  const lowered = 'node_modules/.cache/es2020-check/es2020';
  const modern = 'node_modules/.cache/es2020-check/es2022';
  compileSample('es2020', lowered);
  compileSample('es2022', modern);
  const pass = check([lowered]);
  const fail = check([modern]);
  rmSync('node_modules/.cache/es2020-check', { recursive: true, force: true });
  const ok = pass.files === 1 && pass.failures.length === 0 && fail.files === 1 && fail.failures.length === 1;
  console.log(`es2020-check self-test: TS 7 at es2020 → ${pass.failures.length === 0 ? 'accepted' : 'REJECTED'}`);
  console.log(
    `es2020-check self-test: TS 7 at es2022 → ${fail.failures.length === 1 ? `rejected (${fail.failures[0]?.message ?? ''})` : 'ACCEPTED'}`,
  );
  if (!ok) {
    console.error('es2020-check self-test FAILED');
    process.exit(1);
  }
  console.log('es2020-check self-test passed');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const targets = args.length > 0 ? args : ['dist'];
  for (const target of targets) {
    if (!existsSync(target)) {
      console.error(`es2020-check: ${target} does not exist (run npm run build first)`);
      process.exit(1);
    }
  }
  const { files, failures } = check(targets);
  for (const { file, message } of failures) console.error(`es2020-check: ${file}: ${message}`);
  if (failures.length > 0 || files === 0) {
    console.error(`es2020-check: FAILED (${String(failures.length)} of ${String(files)} files are not ES2020)`);
    process.exit(1);
  }
  console.log(`es2020-check: ${String(files)} files are ES2020`);
}
