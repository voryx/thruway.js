#!/usr/bin/env node
// Hermes smoke: React Native apps run thruway.js on Hermes (React Native 0.87.1). This compiles dist/browser/thruway.js
// and a small bundle of dist/cjs + the testing kit to Hermes bytecode with `hermesc`, and runs a smoke on the Hermes VM
// of the same release: for both builds a handshake, calls, a registration, a CANCEL that aborts the callee's signal
// (the AbortSignal fallback), the binary JSON serializer (the local UTF-8 coder), a router drop and the reconnect, and
// close() — on the virtual clock (no network, no real timers), in a runtime that has no `crypto` (the Math.random ids),
// no TextDecoder/TextEncoder and no AbortController.
//
// Hermes artifacts: React Native 0.87.1 pins Hermes 250829098.0.17 (`hermes-compiler`, sdks/.hermesv1version). Its
// release tarball for Apple platforms (Maven Central com.facebook.hermes:hermes-ios) holds `hermesc` and the
// `hermesvm.framework` for macOS; the Hermes CLI (`hermes`) is not published for it, so the VM runs in a 50-line JSI
// host compiled here with clang++. The tarball is taken from HERMES_IOS_TARBALL, else from React Native's own cache
// (~/Library/Caches/ReactNative, filled by `pod install`), else — only with THRUWAY_ALLOW_NETWORK=1 — downloaded from
// Maven Central; its SHA-256 is pinned. Needs macOS and Xcode's clang++; otherwise the step is SKIPPED (exit 3; a
// failure with CI=true — the package workflow runs it on a macOS runner).
//
//   node scripts/hermes-smoke.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unavailable } from './package-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);

export const HERMES_VERSION = '250829098.0.17';
const TARBALL_NAME = `hermes-ios-${HERMES_VERSION}-hermes-ios-release.tar.gz`;
const TARBALL_URL = `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/${HERMES_VERSION}/${TARBALL_NAME}`;
const TARBALL_SHA256 = '2967ee51b41bd433b3027dda875e96194354e2b4d715f9f186fd0c04ccef309d';
const WORK = path.join(ROOT, 'node_modules/.cache/thruway-hermes');

if (process.platform !== 'darwin') unavailable(`hermes-smoke: needs macOS (the hermes-ios ${HERMES_VERSION} VM)`);
if (!existsSync('dist/browser/thruway.js') || !existsSync('dist/cjs/index.js')) {
  console.error('hermes-smoke: dist is missing (run npm run build first)');
  process.exit(1);
}

/** @param {string} command @param {string[]} args @param {string} [cwd] */
function run(command, args, cwd = WORK) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

// --- the Hermes tarball ------------------------------------------------------------------------------------------
rmSync('node_modules/.cache/thruway-hermes', { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const cached = path.join(os.homedir(), 'Library/Caches/ReactNative', `hermes-ios-${HERMES_VERSION}-release.tar.gz`);
let tarball = process.env['HERMES_IOS_TARBALL'] ?? (existsSync(cached) ? cached : undefined);
if (tarball === undefined && process.env['THRUWAY_ALLOW_NETWORK'] === '1') {
  const response = await fetch(TARBALL_URL);
  if (!response.ok) {
    console.error(`hermes-smoke: ${TARBALL_URL}: HTTP ${String(response.status)}`);
    process.exit(1);
  }
  tarball = path.join(WORK, TARBALL_NAME);
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
}
if (tarball === undefined || !existsSync(tarball)) {
  unavailable(
    `hermes-smoke: no hermes-ios ${HERMES_VERSION} tarball (set HERMES_IOS_TARBALL, run pod install of a React Native 0.87.1 app, or THRUWAY_ALLOW_NETWORK=1 to download ${TARBALL_URL})`,
  );
}
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
if (sha256 !== TARBALL_SHA256) {
  console.error(`hermes-smoke: ${tarball} has SHA-256 ${sha256}, expected ${TARBALL_SHA256}`);
  process.exit(1);
}
if (run('tar', ['-xzf', tarball, '-C', WORK]).status !== 0) {
  console.error(`hermes-smoke: could not unpack ${tarball}`);
  process.exit(1);
}
const destroot = path.join(WORK, 'destroot');
const hermesc = path.join(destroot, 'bin/hermesc');
const frameworks = path.join(destroot, 'Library/Frameworks/macosx');

// --- the VM host -------------------------------------------------------------------------------------------------
// Evaluates each bytecode file in one runtime, drains the microtask queue after each, and exits with globalThis
// __exitCode (4 when the scripts never set it: something waited forever). HERMES_ES6_BLOCK_SCOPING=1 turns on the
// VM's ES6 block scoping (matching hermesc -Xes6-block-scoping).
const HOST = String.raw`#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <fstream>
#include <iostream>
#include <cstdlib>
#include <sstream>
#include <string>
using namespace facebook;
class FileBuffer : public jsi::Buffer {
 public:
  explicit FileBuffer(std::string d) : data_(std::move(d)) {}
  size_t size() const override { return data_.size(); }
  const uint8_t *data() const override { return reinterpret_cast<const uint8_t *>(data_.data()); }
 private:
  std::string data_;
};
int main(int argc, char **argv) {
  const char *scoping = std::getenv("HERMES_ES6_BLOCK_SCOPING");
  const bool blockScoping = scoping != nullptr && std::string(scoping) == "1";
  auto config = ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).withES6BlockScoping(blockScoping).build();
  auto rt = facebook::hermes::makeHermesRuntime(config);
  auto print = [](jsi::Runtime &r, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
    for (size_t i = 0; i < count; i++) std::cout << (i ? " " : "") << args[i].toString(r).utf8(r);
    std::cout << std::endl;
    return jsi::Value::undefined();
  };
  rt->global().setProperty(*rt, "print", jsi::Function::createFromHostFunction(*rt, jsi::PropNameID::forAscii(*rt, "print"), 1, print));
  try {
    for (int i = 1; i < argc; i++) {
      std::ifstream in(argv[i], std::ios::binary);
      std::stringstream source;
      source << in.rdbuf();
      rt->evaluateJavaScript(std::make_shared<FileBuffer>(source.str()), argv[i]);
      while (!rt->drainMicrotasks()) {
      }
    }
    jsi::Value code = rt->global().getProperty(*rt, "__exitCode");
    if (!code.isNumber()) {
      std::cerr << "hermes-host: the scripts did not finish (__exitCode unset)" << std::endl;
      return 4;
    }
    return static_cast<int>(code.getNumber());
  } catch (const jsi::JSError &e) {
    std::cerr << "hermes-host: " << e.getMessage() << "\n" << e.getStack() << std::endl;
    return 1;
  }
}
`;
writeFileSync(path.join(WORK, 'host.cpp'), HOST);
const clang = run('xcrun', ['--find', 'clang++']);
if (clang.status !== 0) unavailable('hermes-smoke: no clang++ (install the Xcode command line tools)');
const compile = run('xcrun', [
  'clang++',
  '-std=c++20',
  '-O1',
  `-I${path.join(destroot, 'include')}`,
  `-F${frameworks}`,
  '-framework',
  'hermesvm',
  `-Wl,-rpath,${frameworks}`,
  'host.cpp',
  '-o',
  'hermes-host',
]);
if (compile.status !== 0) {
  console.error(`hermes-smoke: could not build the JSI host\n${compile.stderr}`);
  process.exit(1);
}

// --- the scripts -------------------------------------------------------------------------------------------------
// dist/cjs + the testing kit as one script (rspack, no transpiling: the code runs exactly as tsc emitted it)
const { rspack } = await import('@rspack/core');
writeFileSync(
  path.join(WORK, 'kit-entry.cjs'),
  `globalThis.thruwayCjs = { lib: require(${JSON.stringify(path.join(ROOT, 'dist/cjs/index.js'))}), testing: require(${JSON.stringify(path.join(ROOT, 'dist/cjs/testing/index.js'))}) };\n`,
);
await new Promise((resolve, reject) => {
  rspack(
    {
      context: WORK,
      mode: 'production',
      target: ['web', 'es2020'],
      entry: { kit: './kit-entry.cjs' },
      devtool: false,
      optimization: { minimize: false },
      output: { path: WORK, filename: '[name].js', iife: true },
    },
    (error, stats) => {
      if (error) reject(error);
      else if (stats?.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve(undefined);
    },
  );
});

const PRELUDE = `
// a bare Hermes runtime: no console, crypto, TextDecoder/TextEncoder, AbortController, timers or performance
globalThis.console = { log: print, info: print, warn: (...a) => print('[warn]', ...a), error: (...a) => print('[error]', ...a), debug: () => {} };
for (const name of ['crypto', 'TextDecoder', 'TextEncoder', 'AbortController', 'AbortSignal']) delete globalThis[name];
globalThis.__exitCode = undefined;
`;
const SMOKE = `
(async function () {
  const { createTestRouter, createVirtualClock } = globalThis.thruwayCjs.testing;
  const results = [];
  for (const [name, lib] of [['dist/browser/thruway.js', globalThis.thruway], ['dist/cjs', globalThis.thruwayCjs.lib]]) {
    const clock = createVirtualClock({ seed: 9 });
    const router = createTestRouter({ clock });
    router.procedure('com.example.add', (args) => args[0] + args[1]);
    const client = new lib.Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });
    const call = async (procedure, args) => {
      let result, error;
      client.call(procedure, args).subscribe({ next: (r) => (result = r), error: (e) => (error = e) });
      await clock.advance(20);
      if (error !== undefined) throw error;
      return result;
    };
    const r = { name, platform: [typeof crypto, typeof TextDecoder, typeof AbortController, typeof setTimeout] };
    const opens = [];
    client.onOpen.subscribe((s) => opens.push(s.id));
    let signal;
    client.register('com.hermes.echo', (inv) => new lib.Yield(inv.args, { k: 'v' })).subscribe({ error: () => {} });
    client.register('com.hermes.slow', (inv) => { signal = inv.signal; return new Promise(() => {}); }).subscribe({ error: () => {} });
    await clock.advance(10);
    r.add = (await call('com.example.add', [2, 3])).args;
    const echoed = await call('com.hermes.echo', ['grüße']);
    r.echo = [echoed.args, echoed.kwargs];
    const slow = client.call('com.hermes.slow').subscribe({ error: () => {} });
    await clock.advance(20);
    const aborts = [];
    signal.addEventListener('abort', () => aborts.push(signal.reason && signal.reason.name));
    slow.unsubscribe(); // CANCEL -> INTERRUPT -> the callee's signal aborts
    await clock.advance(20);
    r.aborted = [signal.aborted, aborts];
    // a binary frame of JSON text through the local UTF-8 decoder, and the "\\u0000"+base64 convention (local base64)
    const utf8 = (text) => {
      const out = [];
      for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    };
    const serializer = lib.jsonSerializer({ binary: true });
    const decoded = serializer.deserialize(utf8('[36,1,2,{},["grüße 🎉",{"x":"é"}]]'));
    const text = serializer.serialize([16, 1, {}, 'a.b', [new Uint8Array([0, 1, 254, 255])]]);
    const back = serializer.deserialize(text)[4][0];
    r.serializer = [decoded, JSON.parse(text)[4][0] === '\u0000AAH+/w==', back instanceof Uint8Array ? Array.from(back) : back];
    router.drop();
    await clock.advance(10000);
    r.reconnected = [opens.length, (await call('com.example.add', [20, 22])).args];
    const closed = client.close();
    await clock.runUntilIdle();
    await closed;
    r.pending = clock.pendingTimers;
    results.push(r);
  }
  print(JSON.stringify(results));
  globalThis.__exitCode = 0;
})().catch((e) => {
  print('hermes-smoke: FAILED', String((e && e.stack) || e));
  globalThis.__exitCode = 1;
});
`;
writeFileSync(path.join(WORK, 'prelude.js'), PRELUDE);
writeFileSync(path.join(WORK, 'smoke.js'), SMOKE);

const inputs = [
  path.join(WORK, 'prelude.js'),
  path.join(ROOT, 'dist/browser/thruway.js'),
  path.join(WORK, 'kit.js'),
  path.join(WORK, 'smoke.js'),
];
const expected = (/** @type {string} */ name) => ({
  name,
  platform: ['undefined', 'undefined', 'undefined', 'undefined'],
  add: [5],
  echo: [['grüße'], { k: 'v' }],
  aborted: [true, ['CanceledError']],
  serializer: [[36, 1, 2, {}, ['grüße 🎉', { x: 'é' }]], true, [0, 1, 254, 255]],
  reconnected: [2, [42]],
  pending: 0,
});
const want = JSON.stringify([expected('dist/browser/thruway.js'), expected('dist/cjs')]);

// hermesc's default (what React Native's build runs over the Metro bundle) and with ES6 block scoping (spec
// semantics for the untranspiled let/const of the ES2020 output)
for (const mode of [
  { name: 'default', flags: [], env: '0' },
  { name: 'es6-block-scoping', flags: ['-Xes6-block-scoping'], env: '1' },
]) {
  /** @type {string[]} */
  const bytecode = [];
  for (const [i, input] of inputs.entries()) {
    const out = path.join(WORK, `${mode.name}-${String(i)}-${path.basename(input, '.js')}.hbc`);
    const result = run(hermesc, ['-emit-binary', '-O', ...mode.flags, '-out', out, input]);
    if (result.status !== 0) {
      console.error(`hermes-smoke: hermesc rejected ${path.relative(ROOT, input)}\n${result.stdout}${result.stderr}`);
      process.exit(1);
    }
    // the only warnings are hermesc's "Promise was not declared" notes (Promise is a global of every Hermes runtime)
    const warnings = `${result.stdout}${result.stderr}`
      .split('\n')
      .filter((l) => l.includes('warning:') && !l.includes('the variable "Promise" was not declared'));
    if (warnings.length > 0) console.log(warnings.join('\n'));
    bytecode.push(out);
  }
  const smoke = spawnSync(path.join(WORK, 'hermes-host'), bytecode, {
    cwd: WORK,
    encoding: 'utf8',
    env: { ...process.env, HERMES_ES6_BLOCK_SCOPING: mode.env },
    timeout: 60_000,
  });
  const line = smoke.stdout.split('\n').find((l) => l.startsWith('[')) ?? '[]';
  if (smoke.status !== 0 || line !== want) {
    process.stdout.write(smoke.stdout);
    process.stderr.write(smoke.stderr);
    console.error(
      `hermes-smoke: FAILED in ${mode.name} mode (exit ${String(smoke.status)})\n  got      ${line}\n  expected ${want}`,
    );
    process.exit(1);
  }
  console.log(`hermes-smoke: ${mode.name}: ${line}`);
}
console.log(`hermes-smoke: passed on Hermes ${HERMES_VERSION} (both builds, both compile modes)`);
