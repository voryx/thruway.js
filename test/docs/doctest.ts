// Shared parts of the doc tests: the environment the README recipes and the MIGRATION.md snippets run in, and the check
// that keeps the docs and the tests the same code.
//
// A doc code block preceded by `<!-- doctest: <id> -->` is a doctest. Its code (import statements removed, a leading
// `export` dropped) must equal, ignoring whitespace and trailing commas, the region of a test/docs file between the
// lines `// doctest: <id>` and `// doctest-end`. The test files are type-checked by TypeScript 7 and 6
// (`npm run typecheck`, test/tsconfig.json) and run by the unit project, so a doctest block type-checks and runs. The
// import statements of a block are checked separately (`checkImport`): every name exists in the module it names.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { Client } from '../../src/client.js';
import type { Observable as Rx5Observable } from 'rxjs5/Observable.js';
import { rxClient } from '../../src/rxjs/index.js';
import { createSimRouter, type SimRouter, type SimRouterOptions } from '../../src/testing/sim.js';
import type { AuthDecision } from '../../src/testing/index.js';
import type {
  CallOptions,
  CloseInfo,
  EventMessage,
  InvocationHandler,
  PublishOptions,
  RegisteredMessage,
  RegisterOptions,
  ResultMessage,
  Session,
  Status,
  TopicOptions,
} from '../../src/types.js';

export const ROOT = join(import.meta.dirname, '..', '..');

// --- the environment ---------------------------------------------------------------------------------------------

/**
 * How the doc routers authenticate: a HELLO that offers methods gets one CHALLENGE for the first (extra
 * `{challenge}`, which `wampcra` signs); a signature starting with `jwt` (a token), or any `wampcra` signature, is
 * welcomed as joe; anything else is ABORTed `wamp.error.authentication_failed`. A HELLO without methods is welcomed
 * anonymously.
 */
export function authenticate(hello: { realm: string; details: Record<string, unknown> }): AuthDecision {
  const methods = hello.details['authmethods'];
  if (!Array.isArray(methods) || methods.length === 0) return { welcome: { authrole: 'anonymous' } };
  const method = String(methods[0]);
  return {
    challenge: { method, extra: { challenge: '{"nonce":"doc"}' } },
    verify: (signature) =>
      signature.startsWith('jwt') || method === 'wampcra'
        ? { welcome: { authid: 'joe', authrole: 'user', authroles: ['user'], authmethod: method } }
        : { abort: 'wamp.error.authentication_failed', details: { message: 'invalid token' } },
  };
}

export interface DocEnv {
  readonly router: SimRouter;
  /** Advance the fake timers (client, router and Rx timers share them); frames travel on the microtask queue. */
  advance(ms: number): Promise<void>;
  /** Frames the clients wrote, oldest first; only those of message type `type` when given. */
  written(type?: number): unknown[][];
  /** A client made by doc code: closed after the test. */
  track<C extends Client>(client: C): C;
}

/**
 * Before each test: vitest's fake timers (so the client's timers and clock, the router's and every Rx scheduler share
 * one time), a reference router (`dialect` and other options as given) and `globalThis.WebSocket` replaced by the
 * router's socket class, so doc code that writes `new Client(url, realm)` connects to it. After each test: every
 * tracked client closed, then no timer left, no violation of the client's side of the protocol, no test-code error
 * recorded by the router.
 */
export function useDocEnv(options: Omit<SimRouterOptions, 'clock'> = {}): { readonly current: DocEnv } {
  let current: DocEnv | undefined;
  let clients: Client[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    const router = createSimRouter({ strict: false, authenticate, ...options });
    vi.stubGlobal('WebSocket', router.WebSocket);
    clients = [];
    current = {
      router,
      advance: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
      written: (type) =>
        router.frames
          .filter((f) => f.direction === 'in' && Array.isArray(f.frame) && (type === undefined || f.frame[0] === type))
          .map((f) => f.frame as unknown[]),
      track: (client) => {
        clients.push(client);
        return client;
      },
    };
  });
  afterEach(async () => {
    const env = current;
    current = undefined;
    if (env === undefined) return;
    try {
      const closing = Promise.all(clients.map((client) => client.close()));
      await vi.advanceTimersByTimeAsync(10000); // GOODBYE replies, lingering sockets
      await closing;
      expect(vi.getTimerCount(), 'timers left after close()').toBe(0);
      expect(env.router.violations, 'router violations').toEqual([]);
      expect(env.router.errors, 'test-code errors').toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  return {
    get current(): DocEnv {
      if (current === undefined) throw new Error('useDocEnv: only inside a test');
      return current;
    },
  };
}

/** WAMP message types the tests look for. */
export const T = {
  HELLO: 1,
  ABORT: 3,
  AUTHENTICATE: 5,
  GOODBYE: 6,
  ERROR: 8,
  PUBLISH: 16,
  SUBSCRIBE: 32,
  UNSUBSCRIBE: 34,
  CALL: 48,
  CANCEL: 49,
  REGISTER: 64,
  UNREGISTER: 66,
  YIELD: 70,
} as const;

/** A Promise that never settles (a call that is never answered). */
export const never = (): Promise<never> => new Promise<never>(() => undefined);

// --- RxJS 5 -----------------------------------------------------------------------------------------------------

/**
 * `rxClient` as an RxJS 5 project sees it. thruway.js/rxjs declares its streams as `import('rxjs').Observable`: in an
 * RxJS 5 project that is RxJS 5's Observable, with the operators the app patched on. This repository's `rxjs` is
 * RxJS 7, so the MIGRATION tests use this re-typed copy of the same function (the runtime is the real adapter).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the same generic defaults as RxClient's public declaration */
export interface Rx5Client {
  readonly client: Client;
  call<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Rx5Observable<ResultMessage<A, K>>;
  progressiveCall<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Rx5Observable<ResultMessage<A, K>>;
  register(procedure: string, handler: InvocationHandler, options?: RegisterOptions): Rx5Observable<RegisteredMessage>;
  topic<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    topic: string,
    options?: TopicOptions,
  ): Rx5Observable<EventMessage<A, K>>;
  publish(
    topic: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: PublishOptions,
  ): Rx5Observable<void>;
  readonly status: Rx5Observable<Status>;
  readonly onOpen: Rx5Observable<Session>;
  readonly onClose: Rx5Observable<CloseInfo>;
}
export const rxClient5 = rxClient as unknown as (client: Client, from: (input: any) => unknown) => Rx5Client;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** RxJS 5 captures `Date.now` when it loads (`Scheduler.now`): point its async scheduler at the current `Date.now`,
 *  the one vitest's fake timers replace (RxJS 7 reads it at each call). */
export function fakeTimersForRx5(): void {
  const require = createRequire(import.meta.url);
  const { async } = require('rxjs5/scheduler/async') as { async: { now: () => number } };
  async.now = () => Date.now();
}

// --- the docs and the tests are the same code ---------------------------------------------------------------------

export interface DocBlock {
  readonly file: string;
  readonly line: number;
  readonly id: string;
  /** `rxjs5`: the block's `rxjs` imports mean RxJS 5. */
  readonly flags: readonly string[];
  readonly code: string;
}

/** The doctest blocks of a Markdown file. */
export function docBlocks(file: string): DocBlock[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const blocks: DocBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = /^<!-- doctest: ([\w-]+)((?: [\w-]+)*) -->$/.exec(lines[i] ?? '');
    if (marker === null) continue;
    let start = i + 1;
    while (lines[start] === '') start++;
    if (!/^```(ts|js)$/.test(lines[start] ?? '')) throw new Error(`${file}:${String(i + 1)}: no code block after it`);
    let end = start + 1;
    while (end < lines.length && lines[end] !== '```') end++;
    blocks.push({
      file,
      line: i + 1,
      id: marker[1] ?? '',
      flags: (marker[2] ?? '').split(' ').filter(Boolean),
      code: lines.slice(start + 1, end).join('\n'),
    });
  }
  return blocks;
}

/** The doctest regions of the test/docs files. */
export function testRegions(): Map<string, { readonly file: string; readonly code: string }> {
  const regions = new Map<string, { file: string; code: string }>();
  const dir = join(ROOT, 'test', 'docs');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const marker = /^\s*\/\/ doctest: ([\w-]+)$/.exec(lines[i] ?? '');
      if (marker === null) continue;
      let end = i + 1;
      while (end < lines.length && !/^\s*\/\/ doctest-end$/.test(lines[end] ?? '')) end++;
      const id = marker[1] ?? '';
      if (regions.has(id)) throw new Error(`doctest region ${id} twice (test/docs/${name})`);
      regions.set(id, { file: `test/docs/${name}`, code: lines.slice(i + 1, end).join('\n') });
    }
  }
  return regions;
}

/** Import statements of a block (prettier ends each with a semicolon). */
export function importsOf(code: string): string[] {
  return code.match(/^import\b[^;]*;/gm) ?? [];
}

/** What a block and a region are compared by: no imports, no leading `export` (or `export default`), no whitespace, no trailing commas. */
export function normalize(code: string): string {
  return code
    .replace(/^import\b[^;]*;/gm, '')
    .replace(/^(\s*)export\s+(?:default\s+)?/gm, '$1')
    .replace(/\s+/g, '')
    .replace(/,([)\]}])/g, '$1');
}

/** Where a doc import is found in this repository (RxJS 5 blocks: `rxjs` is the rxjs5 package). */
function resolveSpecifier(specifier: string, rxjs5: boolean): { readonly module: string; readonly source?: string } {
  const own: Record<string, string> = {
    'thruway.js': 'src/index.ts',
    'thruway.js/rxjs': 'src/rxjs/index.ts',
    'thruway.js/auth': 'src/auth/index.ts',
    'thruway.js/testing': 'src/testing/index.ts',
  };
  const file = own[specifier];
  if (file !== undefined) return { module: join(ROOT, file.replace(/\.ts$/, '.js')), source: join(ROOT, file) };
  if (rxjs5 && (specifier === 'rxjs' || specifier.startsWith('rxjs/'))) {
    return { module: `rxjs5${specifier.slice('rxjs'.length).replace(/\.js$/, '')}` };
  }
  return { module: specifier };
}

/**
 * Check one import statement of a doc block: the module exists here, and every name it imports is exported by it
 * (values at runtime; type-only names in the source of this package's own entry points). Relative imports are the
 * app's own modules: skipped. Returns the problems found.
 */
export async function checkImport(statement: string, rxjs5: boolean): Promise<string[]> {
  const parsed = /^import\s+(type\s+)?([\s\S]*?)\s*(?:from\s+)?'([^']+)';$/.exec(statement.trim());
  if (parsed === null) return [`unparsable import: ${statement}`];
  const [, typeOnly, clause = '', specifier = ''] = parsed;
  if (specifier.startsWith('.')) return [];
  const { module, source } = resolveSpecifier(specifier, rxjs5);
  const require = createRequire(import.meta.url);
  if (clause === '') {
    try {
      require.resolve(module);
      return [];
    } catch {
      return [`${specifier}: no such module (${module})`];
    }
  }
  if (source !== undefined && !existsSync(source)) return [`${specifier}: no such entry point (${source})`];
  const exports = (await import(source ?? module)) as Record<string, unknown>;
  const text = source === undefined ? '' : readFileSync(source, 'utf8');
  const problems: string[] = [];
  const named = /\{([\s\S]*)\}/.exec(clause)?.[1];
  const names = (named ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const defaultName = named === undefined ? clause.trim() : /^(\w+)\s*,/.exec(clause)?.[1];
  if (defaultName !== undefined && defaultName !== '' && !('default' in exports) && !defaultName.startsWith('*')) {
    problems.push(`${specifier}: no default export`);
  }
  for (const entry of names) {
    const isType = typeOnly !== undefined || entry.startsWith('type ');
    const name = entry.replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '';
    if (name in exports) continue;
    if (isType && (source === undefined || new RegExp(`\\b${name}\\b`).test(text))) continue; // a type (or a lib's)
    problems.push(`${specifier}: no export ${name}`);
  }
  return problems;
}
