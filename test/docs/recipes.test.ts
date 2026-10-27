// The README's doctests: every recipe and the README examples, run against the testing kit's reference router under
// vitest's fake timers — recipes 1, 5 and 16 also against its Thruway PHP dialect (a callee registered 3 s after a
// restart, a SUBSCRIBE answered after 70 s, a ghost registration). Each `// doctest: <id>` region is the code of the
// README block marked `<!-- doctest: <id> -->` (doctest.ts); the first describe checks that, for README.md and
// MIGRATION.md (whose regions are in migration.test.ts), and that every import of a doc block exists. The regions
// type-check under TypeScript 7 and 6 with test/tsconfig.json.
/* eslint-disable @typescript-eslint/no-deprecated -- the docs pass RxJS's `from` as apps do (only its scheduler overload is deprecated) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  EMPTY,
  Subject,
  TimeoutError as RxTimeoutError,
  catchError,
  concatMap,
  config,
  defer,
  distinctUntilChanged,
  filter,
  finalize,
  first,
  firstValueFrom,
  from,
  lastValueFrom,
  map,
  merge,
  mergeMap,
  retry,
  share,
  shareReplay,
  switchMap,
  tap,
  throwError,
  timeout,
  timer,
  withLatestFrom,
  type Observable as RxObservable,
  type Subscription,
} from 'rxjs';
import { describe, expect, test, vi } from 'vitest';
import { wampcra } from '../../src/auth/index.js';
import {
  Client,
  TimeoutError,
  WampError,
  isThruwayError,
  isWampError,
  type CloseInfo,
  type ConnectionLostError,
  type InvocationMessage,
  type Status,
} from '../../src/index.js';
import { rxClient } from '../../src/rxjs/index.js';
import { createTestRouter, createVirtualClock } from '../../src/testing/index.js';
import type { DialectName } from '../../src/testing/sim.js';
import {
  ROOT,
  T,
  checkImport,
  docBlocks,
  importsOf,
  never,
  normalize,
  testRegions,
  useDocEnv,
  type DocBlock,
} from './doctest.js';

// --- the docs and the tests are the same code ---------------------------------------------------------------------

const DOCS = ['README.md', 'MIGRATION.md'] as const;

describe('README.md and MIGRATION.md doctests (the docs are this code)', () => {
  const blocks: DocBlock[] = DOCS.flatMap((file) => docBlocks(file));
  const regions = testRegions();

  test('both documents have doctest blocks, each id once', () => {
    expect(blocks.filter((b) => b.file === 'README.md').length).toBeGreaterThan(10);
    expect(blocks.filter((b) => b.file === 'MIGRATION.md').length).toBeGreaterThan(10);
    const ids = blocks.map((b) => b.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test('every doctest block is, but for whitespace, imports and `export`, a region of a test/docs file', () => {
    const mismatches: string[] = [];
    for (const block of blocks) {
      const code = normalize(block.code);
      if (code === '') continue; // imports only: checked below
      const region = regions.get(block.id);
      if (region === undefined) mismatches.push(`${block.file}:${String(block.line)} ${block.id}: no test region`);
      else if (normalize(region.code) !== code) {
        mismatches.push(`${block.file}:${String(block.line)} ${block.id} differs from ${region.file}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('every test region belongs to a doc block (no stale region)', () => {
    const ids = new Set(blocks.map((b) => b.id));
    expect([...regions.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });

  test('every import in a doc block exists (thruway.js entry points, rxjs, RxJS 5 paths, ws)', async () => {
    const problems: string[] = [];
    for (const block of blocks) {
      for (const statement of importsOf(block.code)) {
        for (const problem of await checkImport(statement, block.flags.includes('rxjs5'))) {
          problems.push(`${block.file}:${String(block.line)} ${block.id}: ${problem}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the README documents every public name of the four entry points', async () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const missing: string[] = [];
    let checked = 0;
    for (const entry of ['src/index.ts', 'src/rxjs/index.ts', 'src/auth/index.ts', 'src/testing/index.ts']) {
      const source = readFileSync(join(ROOT, entry), 'utf8');
      const values = Object.keys((await import(join(ROOT, entry))) as object);
      const typeLists = [...source.matchAll(/export type \{([^}]*)\}/g)].flatMap((m) => (m[1] ?? '').split(','));
      const declared = [...source.matchAll(/^export (?:interface|type|class|function|declare function) (\w+)/gm)];
      const names = [...values, ...typeLists, ...declared.map((m) => m[1] ?? '')]
        .map((n) => n.replace(/\/\/.*$/gm, '').trim())
        .filter((n) => n !== '');
      for (const name of new Set(names)) {
        checked++;
        if (!new RegExp(`\\b${name}\\b`).test(readme)) missing.push(`${entry}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(60); // 63 names in 3.0.0
  });

  test('MIGRATION.md has the migrate-errors doctest, and each block is a test region', () => {
    const migration = blocks.filter((b) => b.file === 'MIGRATION.md');
    expect(migration.length).toBeGreaterThan(0);
    expect(new Set(migration.map((b) => b.id)), 'migrate-errors').toContain('migrate-errors');
    const missing = migration.filter((b) => normalize(b.code) !== '' && !regions.has(b.id)).map((b) => b.id);
    expect(missing).toEqual([]);
  });
});

// --- stubs the doc blocks use (an app's own functions) ------------------------------------------------------------

const url = 'wss://router.example.com/ws';
const DASHBOARD_URL = 'wss://dashboard.example.com/ws';
interface Note {
  readonly text: string;
}
const note: Note = { text: 'hello' };
const buildReport = (id: unknown): string => `report ${String(id)}`;

// --- the README examples ------------------------------------------------------------------------------------------

describe('README examples', () => {
  const env = useDocEnv();

  test('quick start (browser): a call and a topic through rxClient', async () => {
    env.current.router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // doctest: quick-start-browser
      const client = new Client('wss://router.example.com/ws', 'realm1');
      const wamp = rxClient(client, from);

      wamp
        .call('com.example.add', [2, 3])
        .pipe(map((result) => result.args[0] as number))
        .subscribe((sum) => {
          console.log('2 + 3 =', sum);
        });

      wamp.topic('com.example.ticks').subscribe({
        next: (event) => {
          console.log('tick', event.args[0]);
        },
        error: (e: unknown) => {
          console.error('ticks ended', e); // close() ends every stream with ConnectionClosedError
        },
      });
      // doctest-end
      env.current.track(client);
      await env.current.advance(10);
      env.current.router.publish('com.example.ticks', [1]);
      await env.current.advance(10);
      expect(log.mock.calls).toEqual([
        ['2 + 3 =', 5],
        ['tick', 1],
      ]);
      await client.close();
      expect(errors.mock.calls).toEqual([['ticks ended', expect.objectContaining({ name: 'ConnectionClosedError' })]]);
    } finally {
      log.mockRestore();
      errors.mockRestore();
    }
  });

  test('quick start (Node): the `ws` WebSocket class is a valid transport (type-checked; not connected here)', () => {
    async function quickStartNode(): Promise<void> {
      // doctest: quick-start-node
      const client = new Client('ws://127.0.0.1:8080/ws', 'realm1', { WebSocket });
      // …
      await client.close();
      // doctest-end
    }
    expect(typeof quickStartNode).toBe('function');
  });

  test('errors: the guards classify a WampError and a lost connection', async () => {
    const { router } = env.current;
    router.procedure('com.example.report', () => {
      throw new WampError('com.example.error.not_found', ['No report 42']);
    });
    const client = env.current.track(new Client(url, 'realm1', { timeouts: { idle: 0 } }));
    const wamp = rxClient(client, from);
    const shown: unknown[] = [];
    const show = (value: unknown): void => {
      shown.push(value);
    };
    const showError = (text: string): void => {
      shown.push(`error: ${text}`);
    };
    // doctest: errors
    wamp.call('com.example.report', [42]).subscribe({
      next: (result) => {
        show(result.args[0]);
      },
      error: (e: unknown) => {
        if (isWampError(e))
          showError(String(e.args[0] ?? e.uri)); // the server's sentence
        else if (isThruwayError(e) && e.code === 'connection_lost') showError('Connection lost. Try again.');
        else if (isThruwayError(e) && e.code === 'connection_closed') showError('Disconnected.');
        else throw e;
      },
    });
    // doctest-end
    await env.current.advance(10);
    router.procedure('com.example.report', never);
    wamp.call('com.example.report', [42]).subscribe({
      error: (e: unknown) => {
        if (isThruwayError(e) && e.code === 'connection_lost') showError('Connection lost. Try again.');
      },
    });
    await env.current.advance(10);
    router.drop();
    await env.current.advance(10);
    expect(shown).toEqual(['error: No report 42', 'error: Connection lost. Try again.']);
  });

  test('auth helpers: wampcra answers the CHALLENGE (HMAC-SHA256 of the exact string)', async () => {
    // doctest: auth-helpers
    const client = new Client(url, 'realm1', {
      ...wampcra('peter', 'secret1'),
      retryOptions: { maxRetryDelay: 15000 },
    });
    // doctest-end
    env.current.track(client);
    await vi.waitFor(async () => {
      await env.current.advance(10); // WebCrypto settles outside the fake timers
      expect(client.session?.details.authmethod).toBe('wampcra');
    });
    const hello = env.current.written(T.HELLO)[0];
    expect(hello?.[2]).toMatchObject({ authmethods: ['wampcra'], authid: 'peter' });
    expect(env.current.written(T.AUTHENTICATE)[0]?.[1]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('README testing kit example (the public kit, its own virtual clock)', () => {
  test('call, drop, reconnect, close', async () => {
    // doctest: testing-kit
    const clock = createVirtualClock();
    const router = createTestRouter({ clock });
    router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
    const client = new Client(router.url, 'realm1', { WebSocket: router.WebSocket, clock });

    const results: unknown[] = [];
    client.call('com.example.add', [2, 3]).subscribe((result) => results.push(result.args[0]));
    await clock.advance(10); // results: [5]
    router.drop(); // the socket dies; the client reconnects with backoff
    await clock.advance(5000);
    const closing = client.close();
    await clock.runUntilIdle(); // the GOODBYE travels through the virtual clock too
    await closing;
    // doctest-end
    expect(results).toEqual([5]);
    expect(
      router.frames.filter((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 1),
    ).toHaveLength(2);
    expect(clock.pendingTimers).toBe(0);
  });
});

// --- the recipes --------------------------------------------------------------------------------------------------

// doctest: recipes-helpers
const isLost = (e: unknown): e is ConnectionLostError => isThruwayError(e) && e.code === 'connection_lost';
/** The WAMP spec also spells the Dealer's cancel URI `cancelled` (Basic Profile, callee leaving): accept both. */
const CANCELED = new Set(['wamp.error.canceled', 'wamp.error.cancelled']);
/** A write that was (or may have been) on the wire when its session ended, or whose callee left mid-call (Thruway
 *  PHP and Crossbar then answer `canceled`): the outcome is unknown. Your own unsubscribe never produces an error. */
const outcomeUnknown = (e: unknown): boolean =>
  isLost(e) ||
  (isThruwayError(e) && e.code === 'connection_closed' && isLost(e.cause)) ||
  (isWampError(e) && CANCELED.has(e.uri));
// doctest-end

/** Recipe 1's definitions, for the tests that build on them. */
function recipe1(wamp: ReturnType<typeof rxClient>) {
  // doctest: recipe-1
  const TRANSIENT = new Set(['wamp.error.no_such_procedure', ...CANCELED, 'wamp.error.no_eligible_callee']);
  const FRAME_REJECTED = new Set([1002, 1003, 1007, 1009, 1011]); // the router closed the socket over a frame
  const transient = (e: unknown): boolean =>
    (isLost(e) && !FRAME_REJECTED.has(e.closeCode ?? 0)) || (isWampError(e) && TRANSIENT.has(e.uri));
  const liveRead = <T>(src: RxObservable<T>): RxObservable<T> =>
    src.pipe(
      retry({
        delay: (e: unknown, n: number) => (transient(e) ? timer(Math.min(30_000, 500 * 2 ** n)) : throwError(() => e)),
        resetOnSuccess: true,
      }),
    );
  const feed$ = liveRead(wamp.progressiveCall('com.example.ticker'));
  // doctest-end
  return { transient, liveRead, feed$ };
}

const DIALECTS: readonly DialectName[] = ['spec', 'thruway-php'];

describe.each(DIALECTS)('recipes against the %s dialect', (dialect) => {
  const env = useDocEnv({ dialect });

  function setup(token = 'jwt-1') {
    // doctest: recipes-setup
    const client = new Client('wss://router.example.com/ws', 'realm1', {
      authmethods: ['ticket'],
      onChallenge: () => token,
    });
    const wamp = rxClient(client, from);
    // doctest-end
    return { client: env.current.track(client), wamp };
  }

  test('recipe 1: a live read feed survives a callee restart (registered again 3 s later) and a router restart', async () => {
    const { router } = env.current;
    const { wamp } = setup();
    const backend = env.current.track(
      new Client(url, 'realm1', {
        authmethods: ['ticket'],
        onChallenge: () => 'jwt-backend',
        timeouts: { idle: 0 },
      }),
    );
    let feed = new Subject<string>();
    const serve = (): Subscription =>
      from(backend.register('com.example.ticker', () => (feed = new Subject<string>()))).subscribe();
    let registration = serve();
    const { feed$ } = recipe1(wamp);
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = feed$.subscribe({ next: (r) => seen.push(r.args[0]), error: (e: unknown) => errors.push(e) });
    await env.current.advance(2000); // the first CALL may beat the backend's REGISTER: no_such_procedure, asked again
    feed.next('t1');
    await env.current.advance(10);
    // the backend restarts: its registration goes away (the running call is answered `canceled`), back 3 s later
    registration.unsubscribe();
    await env.current.advance(3000);
    registration = serve();
    await env.current.advance(5000);
    feed.next('t2');
    await env.current.advance(10);
    // the router restarts: every session is dropped; the backend registers again 3 s after the restart
    registration.unsubscribe();
    router.drop();
    await env.current.advance(3000);
    registration = serve();
    await env.current.advance(15000);
    feed.next('t3');
    await env.current.advance(10);
    expect(seen).toEqual(['t1', 't2', 't3']);
    expect(errors).toEqual([]);
    const calls = env.current.written(T.CALL).filter((f) => f[3] === 'com.example.ticker');
    expect(calls.length).toBeGreaterThanOrEqual(5); // re-issued: canceled, no_such_procedure (×n), connection_lost
    subscription.unsubscribe();
    registration.unsubscribe();
  });

  test('recipe 1: never retried — not_authorized, ConnectionClosedError', async () => {
    const { router } = env.current;
    router.deny((request) => request.uri === 'com.example.ticker');
    const { client, wamp } = setup();
    const { feed$, liveRead } = recipe1(wamp);
    const denied = lastValueFrom(feed$).catch((e: unknown) => e);
    await env.current.advance(60000);
    expect(await denied).toMatchObject({ name: 'WampError', uri: 'wamp.error.not_authorized' });
    router.procedure('com.example.never', never);
    const closed = lastValueFrom(liveRead(wamp.call('com.example.never'))).catch((e: unknown) => e);
    await env.current.advance(10);
    await client.close();
    expect(await closed).toMatchObject({ name: 'ConnectionClosedError', gaveUp: false });
    expect(env.current.written(T.CALL).filter((f) => f[3] === 'com.example.ticker')).toHaveLength(1);
  });

  test('recipe 5: a revoked, shared topic is subscribed again after 1 s; nobody sees an error', async () => {
    const { router } = env.current;
    const { wamp } = setup();
    // doctest: recipe-5
    const durable = (e: unknown): boolean =>
      isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked')));
    const status$ = wamp.topic('com.example.status').pipe(
      retry({
        delay: (e: unknown, n: number) => (durable(e) ? timer(Math.min(30_000, 1000 * 2 ** n)) : throwError(() => e)),
        resetOnSuccess: true,
      }),
      share(),
    );
    // doctest-end
    const a: unknown[] = [];
    const b: unknown[] = [];
    const errors: unknown[] = [];
    const sa = status$.subscribe({ next: (e) => a.push(e.args[0]), error: (e: unknown) => errors.push(e) });
    const sb = status$.subscribe({ next: (e) => b.push(e.args[0]), error: (e: unknown) => errors.push(e) });
    await env.current.advance(100);
    router.publish('com.example.status', ['up']);
    await env.current.advance(10);
    router.revokeSubscription('com.example.status');
    await env.current.advance(2100);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(2);
    router.publish('com.example.status', ['again']);
    await env.current.advance(10);
    expect([a, b]).toEqual([
      ['up', 'again'],
      ['up', 'again'],
    ]);
    expect(errors).toEqual([]);
    sa.unsubscribe();
    sb.unsubscribe();
  });

  test('recipe 5: a SUBSCRIBE answered after 70 s — the request timeout is retried and the late answer adopted', async () => {
    const { router } = env.current;
    const { wamp } = setup();
    router.ignore((frame) => frame[0] === T.SUBSCRIBE && frame[3] === 'com.example.status');
    const durable = (e: unknown): boolean =>
      isThruwayError(e) && (e.code === 'timeout' || (isWampError(e) && e.uri.endsWith('_revoked')));
    const timeouts: unknown[] = [];
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = wamp
      .topic('com.example.status')
      .pipe(
        tap({ error: (e: unknown) => timeouts.push(e) }),
        retry({
          delay: (e: unknown, n: number) => (durable(e) ? timer(Math.min(30_000, 1000 * 2 ** n)) : throwError(() => e)),
          resetOnSuccess: true,
        }),
        share(),
      )
      .subscribe({ next: (e) => seen.push(e.args[0]), error: (e: unknown) => errors.push(e) });
    await env.current.advance(70000);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ name: 'TimeoutError', timer: 'request', topic: 'com.example.status' });
    const [subscribe] = env.current.written(T.SUBSCRIBE);
    // the router's late answer (this router ignored the frame, so the answer and the event are written by hand)
    router.sendRaw(JSON.stringify([33, subscribe?.[1], 4242]));
    await env.current.advance(10);
    router.sendRaw(JSON.stringify([36, 4242, 1, {}, ['late but here']]));
    await env.current.advance(10);
    expect(seen).toEqual(['late but here']);
    expect(errors).toEqual([]);
    expect(env.current.written(T.SUBSCRIBE)).toHaveLength(1); // the retry adopted the unanswered SUBSCRIBE
    subscription.unsubscribe();
    await env.current.advance(10);
  });

  test('recipe 16: a long-lived callee rides out a ghost of its own session', async () => {
    const { router } = env.current;
    const { wamp } = setup();
    // doctest: recipe-16
    const registration$ = wamp
      .register('com.example.build_report', (inv: InvocationMessage) => buildReport(inv.args[0]), {
        replace_orphaned_session: 'yes',
      })
      .pipe(
        retry({
          delay: (e: unknown) =>
            isWampError(e) && e.uri === 'wamp.error.procedure_already_exists' ? timer(5000) : throwError(() => e),
        }),
      );
    // doctest-end
    const registered: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = registration$.subscribe({
      next: (r) => registered.push(r.procedure),
      error: (e: unknown) => errors.push(e),
    });
    await env.current.advance(100);
    expect(router.invoke('com.example.build_report', { args: [1] }).result).toBeUndefined(); // answered asynchronously
    await env.current.advance(10);
    if (dialect === 'thruway-php') {
      // the client's socket dies; the router does not notice (a ghost that still holds the procedure)
      router.connections.at(-1)?.controls.vanish();
    } else {
      router.drop();
    }
    await env.current.advance(15000); // reconnect; Thruway pings the ghost for 5 s and evicts it
    const call = router.invoke('com.example.build_report', { args: [7] });
    await env.current.advance(10);
    expect(call.result?.args).toEqual(['report 7']);
    expect(registered).toEqual(['com.example.build_report', 'com.example.build_report']);
    expect(errors).toEqual([]);
    subscription.unsubscribe();
  });
});

describe('recipes against the reference router', () => {
  const env = useDocEnv();

  function setup(token = 'jwt-1') {
    const client = new Client(url, 'realm1', { authmethods: ['ticket'], onChallenge: () => token });
    return { client: env.current.track(client), wamp: rxClient(client, from) };
  }

  test('recipe 2: timeout() cancels a call and bounds an acknowledged publish', async () => {
    const { router } = env.current;
    router.procedure('com.example.report', never);
    router.ignore((frame) => frame[0] === T.PUBLISH);
    const { wamp } = setup();
    // doctest: recipe-2
    const report$ = wamp.call('com.example.report', [42]).pipe(timeout(5000)); // expiry unsubscribes: CANCEL
    const sent$ = wamp.publish('com.example.status', ['up'], {}, { acknowledge: true }).pipe(timeout(5000));
    // doctest-end
    const report = lastValueFrom(report$).catch((e: unknown) => e);
    const sent = lastValueFrom(sent$, { defaultValue: 'none' }).catch((e: unknown) => e);
    await env.current.advance(5000);
    expect(await report).toBeInstanceOf(RxTimeoutError);
    expect(await sent).toBeInstanceOf(RxTimeoutError);
    expect(env.current.written(T.CANCEL)).toEqual([[49, expect.any(Number), { mode: 'killnowait' }]]);
  });

  test('recipe 3: a write is held (no CANCEL), its outcome unknown after 15 s or a drop; the key goes with every try', async () => {
    const { router } = env.current;
    let answer: ((value: string) => void) | undefined;
    router.procedure(
      'com.example.save_note',
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const { wamp } = setup();
    // doctest: recipe-3
    class OutcomeUnknown extends Error {
      constructor(readonly reason: unknown) {
        super('the outcome of this write is unknown');
      }
    }
    const call$ = wamp.call('com.example.save_note', [note]).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    call$.subscribe({ error: () => undefined }); // holds the CALL until RESULT or ERROR: no CANCEL, ever
    const outcome$ = call$.pipe(
      first(),
      timeout({ first: 15000 }),
      catchError((e: unknown) =>
        throwError(() => (outcomeUnknown(e) || e instanceof RxTimeoutError ? new OutcomeUnknown(e) : e)),
      ),
    );
    // doctest-end
    const late = lastValueFrom(outcome$).catch((e: unknown) => e);
    await env.current.advance(15000);
    const unknown = await late;
    expect(unknown).toBeInstanceOf(OutcomeUnknown);
    expect((unknown as OutcomeUnknown).reason).toBeInstanceOf(RxTimeoutError);
    answer?.('note 1001');
    await env.current.advance(10);
    expect((await lastValueFrom(call$)).args).toEqual(['note 1001']); // the late answer is still received
    // a drop while the write is in flight: outcome unknown as well
    const call2$ = wamp.call('com.example.save_note', [note]).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    call2$.subscribe({ error: () => undefined });
    const dropped = lastValueFrom(
      call2$.pipe(
        first(),
        catchError((e: unknown) => throwError(() => (outcomeUnknown(e) ? new OutcomeUnknown(e) : e))),
      ),
    ).catch((e: unknown) => e);
    await env.current.advance(10);
    router.drop();
    await env.current.advance(10);
    expect(await dropped).toBeInstanceOf(OutcomeUnknown);
    expect(env.current.written(T.CANCEL)).toEqual([]);
    // idempotency keys
    // doctest: recipe-3-key
    const saveNote = (note: Note, key: string = crypto.randomUUID()) =>
      wamp.call('com.example.save_note', [note], { request_key: key }); // the backend ignores a key it has applied
    // doctest-end
    router.procedure('com.example.save_note', () => 'note 1002');
    const key = 'f3b0c442-98fc-4c14-9a9f-8f3f5a7a3d11';
    await env.current.advance(5000);
    await lastValueFrom(saveNote(note, key));
    await lastValueFrom(saveNote(note, key));
    const keyed = env.current.written(T.CALL).filter((f) => f[3] === 'com.example.save_note' && f.length === 6);
    expect(keyed.map((f) => f[5])).toEqual([{ request_key: key }, { request_key: key }]);
  });

  test('recipe 4: fail fast while offline, call once a session exists', async () => {
    env.current.router.procedure('com.example.user_info', () => ({ id: 7 }));
    const { client, wamp } = setup();
    // doctest: recipe-4
    class Offline extends Error {}
    const userInfo$ = defer(() => {
      if (client.session === undefined) return throwError(() => new Offline());
      return wamp.call('com.example.user_info');
    });
    // doctest-end
    await expect(lastValueFrom(userInfo$)).rejects.toBeInstanceOf(Offline);
    await env.current.advance(50);
    const answered = lastValueFrom(userInfo$);
    await env.current.advance(10);
    expect((await answered).args).toEqual([{ id: 7 }]);
    expect(env.current.written(T.CALL)).toHaveLength(1);
  });

  test('recipe 6: wait for a session; once per session survives a drop during its call', async () => {
    const { router } = env.current;
    let answers = 0;
    router.procedure('com.example.user_info', () => (++answers === 1 ? never() : { id: 7 }));
    const { wamp } = setup();
    const perSessionValues: unknown[] = [];
    const errors: unknown[] = [];
    // doctest: recipe-6
    const session = await firstValueFrom(wamp.onOpen);
    const perSession$ = wamp.onOpen.pipe(
      switchMap(() =>
        wamp.call('com.example.user_info').pipe(catchError((e: unknown) => (isLost(e) ? EMPTY : throwError(() => e)))),
      ),
    );
    // doctest-end
    expect(session.details.authid).toBe('joe');
    const subscription = perSession$.subscribe({
      next: (r) => perSessionValues.push(r.args[0]),
      error: (e: unknown) => errors.push(e),
    });
    await env.current.advance(10);
    router.drop(); // the first call is in flight: lost, swallowed; the next session asks again
    await env.current.advance(5000);
    expect(perSessionValues).toEqual([{ id: 7 }]);
    expect(errors).toEqual([]);
    subscription.unsubscribe();
  });

  test('recipe 7: connected flag and outage banner from status (a deliberate stop hides the banner)', async () => {
    const { router } = env.current;
    const { client, wamp } = setup();
    const banner: string[] = [];
    const showOutage = (): void => {
      banner.push('show');
    };
    const hideOutage = (): void => {
      banner.push('hide');
    };
    // doctest: recipe-7
    const connected$ = wamp.status.pipe(
      map((s) => s.state === 'open'),
      distinctUntilChanged(),
    );
    const outage = (s: Status): boolean =>
      s.state === 'connecting' ? s.attempt > 1 : s.state === 'closed' && s.closed?.willRetry === true;
    wamp.status.pipe(map(outage), distinctUntilChanged()).subscribe((down) => {
      if (down) showOutage();
      else hideOutage();
    });
    // doctest-end
    const flags: boolean[] = [];
    const connected = connected$.subscribe((c) => flags.push(c));
    await env.current.advance(10);
    router.drop();
    await env.current.advance(5000);
    await client.close();
    expect(flags).toEqual([false, true, false, true, false]);
    expect(banner).toEqual(['hide', 'show', 'hide']);
    connected.unsubscribe();
  });

  test('recipe 8: promises', async () => {
    env.current.router.procedure('com.example.user_info', () => ({ id: 7 }));
    const { client, wamp } = setup();
    const run = async () => {
      // doctest: recipe-8
      const user = await lastValueFrom(wamp.call('com.example.user_info'));
      await lastValueFrom(wamp.publish('com.example.status', ['up']));
      const raw = await lastValueFrom(from(client.call('com.example.user_info'))); // without the adapter
      // doctest-end
      return [user.args, raw.args];
    };
    const done = run();
    await env.current.advance(50);
    expect(await done).toEqual([[{ id: 7 }], [{ id: 7 }]]);
    expect(env.current.written(T.PUBLISH)).toHaveLength(1);
  });

  test('recipe 9: a refused login stops the client: one end with willRetry false, streams end gaveUp', async () => {
    const readToken = (): string => 'expired';
    // doctest: recipe-9
    const client = new Client(url, 'realm1', {
      authmethods: ['ticket'],
      onChallenge: () => readToken(),
      retryOptions: {
        retryDelay: (attempt, closed, defaultDelay) =>
          closed.initiator === 'router' && closed.reason === 'wamp.error.authentication_failed' ? null : defaultDelay,
      },
    });
    // doctest-end
    env.current.track(client);
    const closes: CloseInfo[] = [];
    client.onClose.subscribe((c) => closes.push(c));
    const call = lastValueFrom(from(client.call('com.example.user_info'))).catch((e: unknown) => e);
    await env.current.advance(5000);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      initiator: 'router',
      reason: 'wamp.error.authentication_failed',
      willRetry: false,
    });
    expect(await call).toMatchObject({ name: 'ConnectionClosedError', gaveUp: true });
    expect(env.current.written(T.HELLO)).toHaveLength(1);
  });

  test('recipe 10: a wake-up cuts the backoff wait; a stopped client stays stopped', async () => {
    const { router } = env.current;
    const { client, wamp } = setup();
    const appActive$ = new Subject<void>();
    const networkChange$ = new Subject<void>();
    // doctest: recipe-10
    merge(appActive$, networkChange$)
      .pipe(withLatestFrom(wamp.status))
      .subscribe(([, s]) => {
        if (!(s.state === 'closed' && s.closed?.willRetry === false)) client.open();
      });
    // doctest-end
    await env.current.advance(10);
    router.setAvailable('refuse');
    router.drop();
    await env.current.advance(10000); // backoff waits grow while the router refuses
    router.setAvailable('ok');
    const hellos = env.current.written(T.HELLO).length;
    appActive$.next();
    await env.current.advance(1100); // never within 1 s of the previous attempt's start
    expect(env.current.written(T.HELLO).length).toBe(hellos + 1);
    expect(client.session).toBeDefined();
    await client.close();
    networkChange$.next();
    await env.current.advance(5000);
    expect(env.current.written(T.HELLO).length).toBe(hellos + 1);
  });

  test('recipe 11: reconnect() re-authenticates with the current token; the topic is re-established', async () => {
    let token = 'jwt-old';
    const newToken = 'jwt-new';
    const client = env.current.track(new Client(url, 'realm1', { authmethods: ['ticket'], onChallenge: () => token }));
    const events: unknown[] = [];
    const topic = client.topic('com.example.status').subscribe((e) => events.push(e.args[0]));
    await env.current.advance(10);
    // doctest: recipe-11
    token = newToken; // the next onChallenge reads it
    client.reconnect();
    // doctest-end
    await env.current.advance(1100);
    expect(env.current.written(T.AUTHENTICATE).map((f) => f[1])).toEqual(['jwt-old', 'jwt-new']);
    env.current.router.publish('com.example.status', ['after']);
    await env.current.advance(10);
    expect(events).toEqual(['after']);
    topic.unsubscribe();
  });

  test('recipe 12: retry no_such_procedure (8 × 1 s), nothing else', async () => {
    const { router } = env.current;
    const { wamp } = setup();
    // doctest: recipe-12
    const list$ = wamp.call('com.example.list', ['current']).pipe(
      retry({
        count: 8,
        delay: (e: unknown) =>
          isWampError(e) && e.uri === 'wamp.error.no_such_procedure' ? timer(1000) : throwError(() => e),
      }),
    );
    // doctest-end
    const list = lastValueFrom(list$);
    await env.current.advance(2500);
    router.procedure('com.example.list', (args) => [`list ${String(args[0])}`]);
    await env.current.advance(1000);
    expect((await list).args).toEqual([['list current']]);
    expect(env.current.written(T.CALL).filter((f) => f[3] === 'com.example.list')).toHaveLength(4);
  });

  test('recipe 13: acknowledged, drop while offline, bounded queue (exactly MAX written in order after WELCOME)', async () => {
    const { wamp, client } = setup();
    const source$ = new Subject<number>();
    // doctest: recipe-13
    const acked$ = source$.pipe(concatMap((v) => wamp.publish('com.example.status', [v], {}, { acknowledge: true })));

    // drop while offline
    const online$ = source$.pipe(
      filter(() => client.session !== undefined),
      concatMap((v) => wamp.publish('com.example.status', [v])),
    );

    // bounded offline queue, dropping the newest value when full
    const MAX = 100; // values allowed to wait for a session (or an acknowledgement)
    let outstanding = 0;
    const publishBounded$ = source$.pipe(
      filter(() => outstanding < MAX),
      mergeMap((v) =>
        defer(() => {
          outstanding++;
          return wamp.publish('com.example.status', [v]);
        }).pipe(
          finalize(() => {
            outstanding--;
          }),
          catchError(() => EMPTY), // one failed publish never ends the source
        ),
      ),
    );
    // doctest-end
    const subscriptions = [publishBounded$.subscribe(), online$.subscribe()];
    for (let v = 0; v < MAX + 5; v++) source$.next(v); // no session yet: the bounded ones wait, the others drop
    expect(outstanding).toBe(MAX);
    await env.current.advance(50);
    const values = env.current.written(T.PUBLISH).map((f) => (f[4] as unknown[])[0]);
    expect(values).toEqual(Array.from({ length: MAX }, (_, i) => i));
    expect(outstanding).toBe(0);
    for (const s of subscriptions) s.unsubscribe();
    const acked = acked$.subscribe();
    source$.next(1000);
    source$.next(1001);
    await env.current.advance(50);
    expect(env.current.written(T.PUBLISH).slice(MAX)).toEqual([
      [16, expect.any(Number), { acknowledge: true }, 'com.example.status', [1000]],
      [16, expect.any(Number), { acknowledge: true }, 'com.example.status', [1001]],
    ]);
    acked.unsubscribe();
  });

  test('recipe 13: drop the oldest instead (the newest MAX are written)', async () => {
    const { wamp } = setup();
    const source$ = new Subject<number>();
    const MAX = 100;
    // doctest: recipe-13-oldest
    const waiting: Subscription[] = [];
    source$.subscribe((v) => {
      const sub = wamp.publish('com.example.status', [v]).subscribe({ error: () => undefined });
      if (!sub.closed) waiting.push(sub);
      while (waiting.length > MAX || waiting[0]?.closed === true) waiting.shift()?.unsubscribe();
    });
    // doctest-end
    for (let v = 0; v < MAX + 5; v++) source$.next(v);
    await env.current.advance(50);
    const values = env.current.written(T.PUBLISH).map((f) => (f[4] as unknown[])[0]);
    expect(values).toEqual(Array.from({ length: MAX }, (_, i) => i + 5));
    source$.complete();
  });

  test('recipe 14: the lazy() wrapper opens for the first subscriber and closes after the last', async () => {
    const { router } = env.current;
    const feeds: Subject<string>[] = [];
    router.procedure('com.example.dashboard', () => {
      const feed = new Subject<string>();
      feeds.push(feed);
      return feed;
    });
    // doctest: recipe-14
    const lazy = (client: Client) => {
      let refs = 0;
      return <T>(src: RxObservable<T>): RxObservable<T> =>
        defer(() => {
          if (refs++ === 0) client.open(); // the first subscriber: open BEFORE subscribing
          return src;
        }).pipe(
          finalize(() => {
            if (--refs === 0) void client.close();
          }),
        );
    };
    const dashboard = new Client(DASHBOARD_URL, 'realm1', { autoOpen: false });
    const dash = rxClient(dashboard, from);
    const live = lazy(dashboard);
    const tiles$ = live(dash.call('com.example.dashboard', ['tiles'], {}, { receive_progress: true }));
    // doctest-end
    env.current.track(dashboard);
    await env.current.advance(1000);
    expect(env.current.written(T.HELLO)).toHaveLength(0); // nobody subscribed: no connection
    const errors: unknown[] = [];
    const a = tiles$.subscribe({ error: (e: unknown) => errors.push(e) });
    const b = tiles$.subscribe({ error: (e: unknown) => errors.push(e) });
    await env.current.advance(10);
    expect(env.current.written(T.HELLO)).toHaveLength(1);
    expect(env.current.written(T.CALL)).toHaveLength(2);
    a.unsubscribe();
    b.unsubscribe(); // the last one leaves: CANCEL, then GOODBYE
    await env.current.advance(3000);
    expect(
      env.current
        .written()
        .slice(-3)
        .map((f) => f[0]),
    ).toEqual([T.CANCEL, T.CANCEL, T.GOODBYE]);
    expect(vi.getTimerCount()).toBe(0); // the connection is gone with its timers
    // a third subscriber arrives in the same tick as the last one leaves
    const c = tiles$.subscribe({ error: (e: unknown) => errors.push(e) });
    c.unsubscribe();
    const d = tiles$.subscribe({ next: () => undefined, error: (e: unknown) => errors.push(e) });
    await env.current.advance(3000);
    expect(env.current.written(T.HELLO).length).toBeGreaterThanOrEqual(2);
    expect(dashboard.session).toBeDefined();
    feeds.at(-1)?.next('tile');
    await env.current.advance(10);
    expect(errors).toEqual([]);
    d.unsubscribe();
    // a wrapped stream that errors still releases its reference
    const failing = live(throwError(() => new Error('boom')));
    const failed = lastValueFrom(failing).catch((e: unknown) => e);
    await env.current.advance(3000);
    expect(await failed).toMatchObject({ message: 'boom' });
    expect(dashboard.session).toBeUndefined();
  });

  test('recipe 15: an unhandled RxJS 7 error is reported, not thrown from a timer', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // doctest: recipe-15
      config.onUnhandledError = (e: unknown) => {
        console.error(e);
      };
      // doctest-end
      throwError(() => new Error('nobody handles me')).subscribe();
      await env.current.advance(10);
      expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: 'nobody handles me' }));
    } finally {
      config.onUnhandledError = null;
      reported.mockRestore();
    }
  });

  test('recipe 17: the login is asked once per login; a router GOODBYE ends it, a restart keeps it', async () => {
    const { router } = env.current;
    let dialogs = 0;
    const showLoginDialog = (): Promise<string> => Promise.resolve(`jwt-dialog-${String(++dialogs)}`);
    let forgotten = 0;
    const forgetStoredToken = (): void => {
      forgotten++;
    };
    // doctest: recipe-17
    const KEEP = new Set([
      'wamp.close.system_shutdown', // router restart (Bondy SIGTERM, …)
      'com.example.login.unavailable', // app-specific outage reasons
    ]);
    const loginEnded = (c: CloseInfo): boolean =>
      c.initiator === 'router' && !KEEP.has(c.reason ?? '') && (c.error === undefined || c.error.code === 'abort');
    const login = () => defer(() => showLoginDialog()).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    let creds$ = login();
    const client = new Client(url, 'realm1', { authmethods: ['ticket'], onChallenge: () => creds$ });
    client.onClose.subscribe((c) => {
      if (loginEnded(c)) {
        forgetStoredToken();
        creds$ = login();
      }
    });
    // doctest-end
    env.current.track(client);
    await env.current.advance(50);
    expect(dialogs).toBe(1);
    router.goodbye('com.example.session_ended', { message: 'Your session has ended.' });
    await env.current.advance(5000);
    expect(dialogs).toBe(2); // a new dialog, not the memoised answer
    expect(forgotten).toBe(1);
    router.goodbye('wamp.close.system_shutdown');
    await env.current.advance(5000);
    expect(dialogs).toBe(2); // a restart keeps the login
    expect(env.current.written(T.AUTHENTICATE).map((f) => f[1])).toEqual([
      'jwt-dialog-1',
      'jwt-dialog-2',
      'jwt-dialog-2',
    ]);
    expect(client.session).toBeDefined();
  });

  test('recipe 18: a challenge handler bounded by its signal and AbortSignal.timeout', async () => {
    const signals: unknown[] = [];
    const fetch = vi.fn((_input: string, init: RequestInit) => {
      signals.push(init.signal);
      return Promise.resolve(new Response(JSON.stringify({ token: 'jwt-fetched' })));
    });
    vi.stubGlobal('fetch', fetch);
    // doctest: recipe-18
    const client = new Client(url, 'realm1', {
      authmethods: ['ticket'],
      onChallenge: async (challenge) => {
        const signal = AbortSignal.any([challenge.signal as AbortSignal, AbortSignal.timeout(15000)]);
        const res = await fetch('/api/token', { credentials: 'include', signal });
        const { token } = (await res.json()) as { token: string };
        return token;
      },
    });
    // doctest-end
    env.current.track(client);
    await env.current.advance(50);
    expect(client.session).toBeDefined();
    expect(env.current.written(T.AUTHENTICATE)[0]?.[1]).toBe('jwt-fetched');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test('recipe 19: a typed call timeout (brand, code, timer, procedure) and the CANCEL it sends', async () => {
    env.current.router.procedure('com.example.report', never);
    const { client, wamp } = setup();
    // doctest: recipe-19
    const callTimeout =
      (ms: number, procedure: string) =>
      <T>(src: RxObservable<T>): RxObservable<T> =>
        src.pipe(
          timeout({
            first: ms,
            with: () =>
              throwError(
                () => new TimeoutError({ timer: 'call', timeout: ms, procedure, sessionId: client.session?.id }),
              ),
          }),
        );
    const report$ = wamp.call('com.example.report', [42]).pipe(callTimeout(5000, 'com.example.report'));
    // doctest-end
    const error = lastValueFrom(report$).catch((e: unknown) => e);
    await env.current.advance(5000);
    const e = await error;
    expect(isThruwayError(e)).toBe(true);
    expect(e).toMatchObject({ code: 'timeout', timer: 'call', timeout: 5000, procedure: 'com.example.report' });
    expect((e as TimeoutError).sessionId).toBe(client.session?.id);
    expect(client.session?.id).toEqual(expect.any(Number));
    expect(env.current.written(T.CANCEL)).toEqual([[49, expect.any(Number), { mode: 'killnowait' }]]);
  });
});
