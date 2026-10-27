// The error and Yield brands survive two copies of the package (the dual-package hazard):
// - ESM + CJS: src is compiled with TypeScript 7 through the shipping tsconfigs (tsconfig.build.json and
//   tsconfig.build.cjs.json, exactly what `npm run build` runs) into a private directory, and a child Node process —
//   no test runner in between — imports the ESM copy and requires the CJS copy;
// - separate realms: the CJS copy runs in two fresh vm contexts (their own Error, Object, Symbol constructors).
// In both cases `instanceof` fails across copies, which is why the guards check the Symbol.for brand.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, test } from 'vitest';
import * as local from '../../src/errors.js';
import { isYield, Yield } from '../../src/yield.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = fileURLToPath(new URL('../../node_modules/.cache/thruway-error-copies/', import.meta.url));
const esmDir = `${out}esm/`;
const cjsDir = `${out}cjs/`;

function tsc(project: string, outDir: string): void {
  const result = spawnSync(process.execPath, ['node_modules/typescript7/bin/tsc', '-p', project, '--outDir', outDir], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`tsc -p ${project} failed:\n${result.stdout}${result.stderr}`);
}

beforeAll(() => {
  rmSync(new URL('../../node_modules/.cache/thruway-error-copies/', import.meta.url), { recursive: true, force: true });
  tsc('tsconfig.build.json', esmDir);
  tsc('tsconfig.build.cjs.json', cjsDir);
  writeFileSync(`${esmDir}package.json`, '{"type":"module"}\n');
  writeFileSync(`${cjsDir}package.json`, '{"type":"commonjs"}\n');
});

/** Constructor arguments per class (the same in every copy). */
const BUILD = `
const build = {
  WampError: (m) => new m.WampError('wamp.error.not_authorized', ['denied'], { a: 1 }),
  ConnectionLostError: (m) => new m.ConnectionLostError({ reason: 'wamp.close.close_realm' }),
  ConnectionClosedError: (m) => new m.ConnectionClosedError({ gaveUp: true }),
  TimeoutError: (m) => new m.TimeoutError({ timer: 'connect', timeout: 10 }),
  AbortError: (m) => new m.AbortError({ reason: 'wamp.error.no_such_realm' }),
  ProtocolError: (m) => new m.ProtocolError({ message: 'bad frame' }),
  CanceledError: (m) => new m.CanceledError(),
  AuthenticationError: (m) => new m.AuthenticationError({ message: 'no handler' }),
};`;
const CLASSES = [
  'WampError',
  'ConnectionLostError',
  'ConnectionClosedError',
  'TimeoutError',
  'AbortError',
  'ProtocolError',
  'CanceledError',
  'AuthenticationError',
] as const;

interface Verdict {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly isThruwayError: boolean;
  readonly isWampError: boolean;
  readonly instanceofOther: boolean;
}

describe('ESM + CJS copies (native Node loading)', () => {
  const script = `
import { createRequire } from 'node:module';
${BUILD}
const [esmErrors, esmYield, cjsErrors, cjsYield] = process.argv.slice(1);
const esm = await import(esmErrors);
const esmY = await import(esmYield);
const require = createRequire(import.meta.url);
const cjs = require(cjsErrors);
const cjsY = require(cjsYield);
const verdict = (error, guards, Other) => ({
  name: error.name, code: error.code, message: error.message,
  isThruwayError: guards.isThruwayError(error), isWampError: guards.isWampError(error),
  instanceofOther: error instanceof Other,
});
const result = { distinct: esm.WampError !== cjs.WampError, esmByCjs: {}, cjsByEsm: {} };
for (const name of Object.keys(build)) {
  result.esmByCjs[name] = verdict(build[name](esm), cjs, cjs[name]);
  result.cjsByEsm[name] = verdict(build[name](cjs), esm, esm[name]);
}
result.yield = {
  distinct: esmY.Yield !== cjsY.Yield,
  esmByCjs: cjsY.isYield(new esmY.Yield([1])),
  cjsByEsm: esmY.isYield(new cjsY.Yield([1])),
  instanceofOther: new esmY.Yield() instanceof cjsY.Yield,
};
process.stdout.write(JSON.stringify(result));
`;

  test('errors and Yields of each copy are recognised by the other copy, instanceof is not', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        pathToFileURL(`${esmDir}errors.js`).href,
        pathToFileURL(`${esmDir}yield.js`).href,
        `${cjsDir}errors.js`,
        `${cjsDir}yield.js`,
      ],
      { encoding: 'utf8' },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout) as {
      distinct: boolean;
      esmByCjs: Record<string, Verdict>;
      cjsByEsm: Record<string, Verdict>;
      yield: { distinct: boolean; esmByCjs: boolean; cjsByEsm: boolean; instanceofOther: boolean };
    };
    expect(result.distinct).toBe(true);
    for (const direction of [result.esmByCjs, result.cjsByEsm]) {
      expect(Object.keys(direction)).toEqual([...CLASSES]);
      for (const name of CLASSES) {
        const verdict = direction[name]!;
        expect(verdict.name).toBe(name);
        expect(verdict.isThruwayError).toBe(true);
        expect(verdict.isWampError).toBe(name === 'WampError');
        expect(verdict.instanceofOther).toBe(false);
      }
      expect(direction['WampError']!.message).toBe('wamp.error.not_authorized');
    }
    expect(result.yield).toEqual({ distinct: true, esmByCjs: true, cjsByEsm: true, instanceofOther: false });
  });

  test('the CJS copy is a real CommonJS module and the ESM copy a real ES module', () => {
    expect(readFileSync(`${cjsDir}errors.js`, 'utf8')).toMatch(/exports\.WampError = WampError/);
    expect(readFileSync(`${esmDir}errors.js`, 'utf8')).toMatch(/^export class WampError extends Error/m);
  });
});

describe('copies in separate realms (vm contexts)', () => {
  type ErrorsModule = typeof local;
  interface Realm {
    readonly errors: ErrorsModule;
    readonly yields: { readonly Yield: typeof Yield; readonly isYield: typeof isYield };
    readonly context: vm.Context;
  }

  function load(context: vm.Context, file: string): unknown {
    const module = { exports: {} };
    const wrapper = vm.runInContext(
      `(function (exports, require, module) {${readFileSync(file, 'utf8')}\n})`,
      context,
      {
        filename: file,
      },
    ) as (exports: unknown, require: (id: string) => never, module: { exports: unknown }) => void;
    wrapper(
      module.exports,
      (id) => {
        throw new Error(`unexpected require(${id})`);
      },
      module,
    );
    return module.exports;
  }

  function realm(): Realm {
    const context = vm.createContext({});
    return {
      context,
      errors: load(context, `${cjsDir}errors.js`) as ErrorsModule,
      yields: load(context, `${cjsDir}yield.js`) as Realm['yields'],
    };
  }

  const samples = (m: ErrorsModule): readonly local.ThruwayError[] => [
    new m.WampError('wamp.error.no_such_procedure', ['x']),
    new m.ConnectionLostError({ closeCode: 1006 }),
    new m.ConnectionClosedError({}),
    new m.TimeoutError({ timer: 'handshake', timeout: 5 }),
    new m.AbortError({ reason: 'thruway.error.authentication_failure' }),
    new m.ProtocolError({ message: 'm', frame: '[99]' }),
    new m.CanceledError({ message: 'superseded' }),
    new m.AuthenticationError({ message: 'm', authMethod: 'ticket' }),
  ];

  test('two realms and this one recognise each other’s errors; instanceof Error does not cross realms', () => {
    const a = realm();
    const b = realm();
    expect(a.errors.WampError).not.toBe(b.errors.WampError);
    expect(vm.runInContext('Error', a.context)).not.toBe(Error);
    const copies: readonly ErrorsModule[] = [local, a.errors, b.errors];
    for (const producer of copies) {
      for (const error of samples(producer)) {
        for (const guard of copies) {
          expect(guard.isThruwayError(error)).toBe(true);
          expect(guard.isWampError(error)).toBe(error.code === 'wamp_error');
        }
      }
    }
    const foreign = samples(a.errors);
    expect(foreign.some((e) => e instanceof Error)).toBe(false);
    expect(foreign.map((e) => e.name)).toEqual([...CLASSES]);
    expect(foreign[0]!.message).toBe('wamp.error.no_such_procedure');
    expect(Object.getOwnPropertyDescriptor(foreign[0], Symbol.for('thruway.js.error'))?.value).toBe('wamp_error');
  });

  test('Yield brands cross realms too', () => {
    const a = realm();
    const b = realm();
    for (const producer of [Yield, a.yields.Yield, b.yields.Yield]) {
      const y = new producer([1], { k: 2 });
      for (const check of [isYield, a.yields.isYield, b.yields.isYield]) expect(check(y)).toBe(true);
    }
    expect(new a.yields.Yield() instanceof Yield).toBe(false);
    expect(a.yields.isYield({ args: [], kwargs: {} })).toBe(false);
  });
});
