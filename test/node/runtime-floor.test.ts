// The Node floors hold for the Node running the node project: the runtime floor (`engines.node`, which the 22.0/22.4
// smoke executes on the packed tarball) and the dev toolchain floor (`devEngines.runtime.version`), and the global
// WebSocket the client defaults to exists.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface PackageJson {
  readonly engines: { readonly node: string };
  readonly devEngines: {
    readonly runtime: { readonly name: string; readonly version: string; readonly onFail: string };
  };
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageJson;

function parse(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new TypeError(`not a version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, floor: string): boolean {
  const a = parse(actual);
  const f = parse(floor);
  for (let i = 0; i < 3; i++) if (a[i] !== f[i]) return a[i]! > f[i]!;
  return true;
}

describe('Node floors', () => {
  test('package.json declares the Node floors', () => {
    expect(pkg.engines.node).toBe('>=22');
    expect(pkg.devEngines.runtime).toEqual({ name: 'node', version: '>=22.13.0', onFail: 'error' });
  });
  test('this Node satisfies the dev toolchain floor (and therefore the runtime floor)', () => {
    expect(atLeast(process.version, pkg.devEngines.runtime.version.slice(2))).toBe(true);
    expect(atLeast(process.version, '22.0.0')).toBe(true);
  });
  test('the global WebSocket (undici) is present', () => {
    expect(typeof globalThis.WebSocket).toBe('function');
    expect(globalThis.WebSocket.OPEN).toBe(1);
  });
});
