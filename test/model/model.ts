// The model of the model-based suite: one run's configuration, the world it builds (the harness with the reference
// router of one dialect, the client under test, an optional second client, the app's handles and the app answers still
// pending), the bookkeeping the INV-* checkers need (test/helpers/invariants.ts), healing, and the checks run after
// every command and at the end of a run.
//
// App answers come in three kinds: synchronous values; scheduled ones (`fc.scheduler()`'s `schedule`: the scheduler of
// `fc.scheduledModelRun` releases them between and during commands, interleaved with frames, faults and timers); and
// deferred ones that only the `Resolve`/`Reject`/`Next`/`Complete` commands settle. Every op's CALL and PUBLISH carries
// a fresh tag as `args[0]` (read once per subscription, so a re-subscription of the same Observable gets its own tag),
// which links frames to observers (INV-R5); router-side calls carry a tag that a correct client's echo handler sends
// back, so an answer to the wrong INVOCATION is caught.
import fc from 'fast-check';
import { expect, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { RandomIds } from '../../src/core/ids.js';
import { WampError } from '../../src/errors.js';
import { Observable } from '../../src/observable/observable.js';
import type { DialectName, QuirkFlags } from '../../src/testing/dialects.js';
import type { SimAuthProvider, SimRouterCall } from '../../src/testing/sim.js';
import type { ChallengeMessage, ClientOptions, InvocationMessage, Observer, RetryOptions } from '../../src/types.js';
import { createHarness, INTERNAL_OPTIONS_KEY, type Harness, type SimClient } from '../helpers/harness.js';
import {
  checkDebugProbe,
  checkInvariants,
  formatViolations,
  indexTrace,
  INVARIANT_IDS,
  registerKey,
  topicKey,
  type CheckOptions,
  type InvariantId,
  type InvariantViolation,
  type OpInfo,
  type Timings,
} from '../helpers/invariants.js';
import type { Recorded } from '../helpers/trace.js';
import type { ObserverId, Trace, TraceStream } from '../helpers/trace-types.js';

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

export type RetryKind = 'default' | 'throws' | 'nan' | 'zero' | 'null-after-3' | 'huge';
export type AuthKind = 'none' | 'ticket' | 'two-methods';
export type UrlKind = 'string' | 'function';
export type ChallengeMode = 'sync' | 'scheduled' | 'deferred' | 'fail' | 'reject' | 'empty' | 'never';
export type UrlMode = 'sync' | 'scheduled' | 'deferred' | 'throw' | 'empty';

export interface ModelConfig {
  readonly seed: number;
  readonly dialect: DialectName;
  /** Nexus main's `strict_request_ids` realm (with `requestIds: 'sequential'`). */
  readonly strict: boolean;
  readonly requestIds: 'random' | 'sequential' | 'degenerate';
  readonly maxRetries: number;
  readonly retry: RetryKind;
  readonly profile: 'tiny' | 'small' | 'defaults';
  readonly timeouts: {
    readonly connect: number;
    readonly handshake: number;
    readonly request: number;
    readonly idle: number;
  };
  readonly internal: {
    readonly ping: number;
    readonly stable: number;
    readonly goodbye: number;
    readonly settle: number;
    readonly attemptFloor: number;
  };
  readonly maxRetryDelay: number;
  readonly latency: { readonly in: number; readonly out: number };
  readonly tieOrder: 'frames-first' | 'timers-first';
  readonly delivery: 'clock' | 'sync' | 'manual';
  readonly routerIds: 'unique' | 'per-session' | 'random';
  readonly url: UrlKind;
  readonly auth: AuthKind;
  readonly terminate: boolean;
  readonly closeEvents: 'async' | 'sync';
  readonly peer: boolean;
  /** Faults as often as app traffic (a third of the runs); otherwise a mostly healthy client with occasional faults. */
  readonly storm: boolean;
  /** The run starts with an established session (two thirds of the runs); otherwise with the first attempt. */
  readonly warm: boolean;
  /** A busy router-side caller (two thirds of the runs): whenever time passes, every procedure the client has registered gets
   *  calls up to two outstanding (at most 40 per run), as a production callee sees. */
  readonly traffic: boolean;
}

/** Every run configuration, on the Thruway PHP dialect only (to save time, random testing runs on the first-class
 *  router only; the other dialects' quirks are covered by the sims). */
export function configArb(): fc.Arbitrary<ModelConfig> {
  const tiny = fc.constantFrom(1, 2, 3, 5, 8);
  const profile = fc.oneof(
    { weight: 5, arbitrary: fc.constant('tiny' as const) },
    { weight: 4, arbitrary: fc.constant('small' as const) },
    { weight: 1, arbitrary: fc.constant('defaults' as const) },
  );
  return fc
    .record({
      seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      dialect: fc.constant<DialectName>('thruway-php'),
      strict: fc.boolean(),
      requestIds: fc.constantFrom('random' as const, 'sequential' as const, 'degenerate' as const),
      maxRetries: fc.oneof(
        { weight: 6, arbitrary: fc.constant(Number.POSITIVE_INFINITY) },
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 2, arbitrary: fc.constant(3) },
      ),
      retry: fc.oneof(
        { weight: 6, arbitrary: fc.constant<RetryKind>('default') },
        { weight: 1, arbitrary: fc.constantFrom<RetryKind>('throws', 'nan', 'zero', 'null-after-3', 'huge') },
      ),
      profile,
      tinyTimes: fc.record({
        connect: tiny,
        handshake: tiny,
        request: tiny,
        idle: fc.constantFrom(0, 0, 1, 2, 3, 5, 8),
        ping: tiny,
      }),
      smallTimes: fc.record({
        connect: fc.constantFrom(20, 50, 200),
        handshake: fc.constantFrom(20, 50, 200),
        request: fc.constantFrom(30, 100, 300),
        idle: fc.constantFrom(0, 0, 25, 60, 150),
        ping: fc.constantFrom(10, 40, 100),
      }),
      liveness: fc.boolean(),
      latency: fc.record({ in: fc.constantFrom(0, 0, 0, 0, 1, 2, 3), out: fc.constantFrom(0, 0, 0, 0, 1, 2, 3) }),
      tieOrder: fc.constantFrom('frames-first' as const, 'timers-first' as const),
      delivery: fc.oneof(
        { weight: 6, arbitrary: fc.constant('clock' as const) },
        { weight: 2, arbitrary: fc.constant('sync' as const) },
        { weight: 1, arbitrary: fc.constant('manual' as const) },
      ),
      // per-session ids from 1 make a stale-id bug hit a live object: drawn half the time
      routerIds: fc.constantFrom('per-session' as const, 'per-session' as const, 'unique' as const, 'random' as const),
      url: fc.constantFrom('string' as const, 'function' as const),
      auth: fc.oneof(
        { weight: 3, arbitrary: fc.constant<AuthKind>('none') },
        { weight: 2, arbitrary: fc.constant<AuthKind>('ticket') },
        { weight: 2, arbitrary: fc.constant<AuthKind>('two-methods') },
      ),
      terminate: fc.boolean(),
      closeEvents: fc.constantFrom('async' as const, 'sync' as const),
      peer: fc.boolean(),
      storm: fc.nat(2).map((n) => n === 0),
      warm: fc.nat(2).map((n) => n > 0),
      traffic: fc.nat(2).map((n) => n > 0),
    })
    .map((r): ModelConfig => {
      const defaults = r.profile === 'defaults';
      const t = r.profile === 'tiny' ? r.tinyTimes : r.smallTimes;
      const idle = defaults ? (r.liveness ? 30000 : 0) : r.liveness ? t.idle : 0;
      const strict = r.dialect === 'nexus' && r.strict;
      return {
        seed: r.seed,
        dialect: r.dialect,
        strict,
        requestIds: strict ? 'sequential' : r.requestIds,
        maxRetries: r.maxRetries,
        retry: r.retry,
        profile: r.profile,
        timeouts: defaults
          ? { connect: 10000, handshake: 15000, request: 60000, idle }
          : { connect: t.connect, handshake: t.handshake, request: t.request, idle },
        internal: defaults
          ? { ping: 20000, stable: 60000, goodbye: 2000, settle: 50, attemptFloor: 1000 }
          : {
              ping: t.ping,
              stable: r.profile === 'tiny' ? 40 : 400,
              goodbye: r.profile === 'tiny' ? 5 : 50,
              settle: r.profile === 'tiny' ? 2 : 10,
              attemptFloor: r.profile === 'tiny' ? 10 : 100,
            },
        maxRetryDelay: defaults ? 60000 : r.profile === 'tiny' ? 100 : 500,
        latency: r.delivery === 'clock' ? r.latency : { in: 0, out: 0 },
        tieOrder: r.tieOrder,
        delivery: r.delivery,
        routerIds: r.routerIds,
        url: r.url,
        auth: r.auth,
        terminate: r.terminate,
        closeEvents: r.closeEvents,
        peer: r.peer,
        storm: r.storm,
        warm: r.warm,
        traffic: r.traffic,
      };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------------------------

export const TOPICS = [
  { topic: 'model.t1', options: {} },
  { topic: 'model.t2', options: {} },
  { topic: 'model.p', options: { match: 'prefix' } },
  { topic: 'model..w', options: { match: 'wildcard' } },
] as const;
/** What the router publishes to (each matches some of TOPICS). */
export const PUBLISH_TOPICS = ['model.t1', 'model.t2', 'model.p.a', 'model.x.w'] as const;
export const PROCEDURES = ['model.r1', 'model.r2'] as const;
/** The procedure of throwing handlers (RouterInvoke reaches it too). */
export const THROWING = 'model.throw';
export const CALLS = [
  'model.ok',
  'model.err',
  'model.progress',
  'model.never',
  'model.slow',
  'model.r1',
  'model.peer',
] as const;
export type HandlerKind = 'echo' | 'deferred' | 'scheduled' | 'throw' | 'progress' | 'never';

/** A pending app answer the model settles with Resolve/Reject/Next/Complete (or the heal). */
export interface Deferred {
  readonly n: number;
  readonly kind: 'handler' | 'challenge' | 'url';
  readonly label: string;
  settled: boolean;
  resolve(): void;
  reject(): void;
  next(): void;
  complete(): void;
}

/** One app handle: a cold Observable the model can subscribe again (Resubscribe). */
export interface Handle {
  readonly n: number;
  readonly client: SimClient<Client>;
  readonly kind: 'call' | 'progressive' | 'publish' | 'topic' | 'register' | 'bad';
  readonly stream: TraceStream;
  readonly uri: string;
  readonly observable: { subscribe(observer: Partial<Observer<unknown>>): { unsubscribe(): void } };
  readonly ack: boolean;
  readonly key: string | undefined;
  readonly subs: Recorded<unknown>[];
}

export interface Lifecycle {
  readonly client: SimClient<Client>;
  readonly stream: 'status' | 'onOpen' | 'onClose';
  readonly rec: Recorded<unknown>;
}

export type ReentrantTarget = 'op' | 'interest' | 'onClose' | 'onOpen' | 'status' | 'handler';
export type ReentrantAction = 'open' | 'close' | 'reconnect' | 'call' | 'topic' | 'unsubscribe' | 'publish';

/** Errors the model injects or provokes on purpose (INV-R6 exempts them). */
const INJECTED = /^(injected fault|model: )/;

export class World {
  readonly h: Harness;
  readonly c: SimClient<Client>;
  peer: SimClient<Client> | undefined;
  readonly handles: Handle[] = [];
  readonly lifecycles: Lifecycle[] = [];
  readonly deferreds: Deferred[] = [];
  readonly routerCalls: { readonly call: SimRouterCall; readonly tag: string; readonly procedure: string }[] = [];
  /** Observer id → op info, per client. */
  readonly ops = new Map<SimClient<Client>, Map<ObserverId, OpInfo>>();
  readonly skews: { seq: number; ms: number }[] = [];
  readonly suspends: { seq: number; ms: number }[] = [];
  readonly throwingHandlers = new Set<string>();
  /** Handles whose observers throw from now on. */
  readonly throwing = new Set<number>();
  /** Lifecycle observers (index in `lifecycles`) that throw from now on (INV-R8: the other observers of that stream
   *  still get every notification). */
  readonly throwingLifecycles = new Set<number>();
  readonly removers: (() => void)[] = [];
  readonly log: string[] = [];
  challengeMode: ChallengeMode = 'sync';
  urlMode: UrlMode = 'sync';
  faults = false;
  loggerFaults = false;
  buffered = false;
  reentrant: { target: ReentrantTarget; action: ReentrantAction } | undefined;
  private tags = 0;
  private counter = 0;
  private lastTag: string | undefined;
  private nonce = 0;
  private readonly restore: (() => void)[] = [];

  constructor(
    readonly cfg: ModelConfig,
    readonly s: fc.Scheduler,
  ) {
    const providers = this.providers();
    this.h = createHarness({
      seed: cfg.seed,
      tieOrder: cfg.tieOrder,
      router: {
        dialect: cfg.dialect,
        ...(cfg.strict ? { quirks: { strict_ids: true } satisfies Partial<QuirkFlags> } : {}),
        routerIds: cfg.routerIds,
        delivery: cfg.delivery,
        latency: cfg.latency,
        terminate: cfg.terminate,
        closeEvents: cfg.closeEvents,
        ...(providers === undefined ? {} : { providers }),
      },
      // calls to registration-backed procedures (model.r1, model.peer) may find no callee: no_such_procedure is a valid
      // answer here, not a typo in the test (strict mode's unscripted check), so that check is off
      checks: { internalLogs: false, unscripted: false },
    });
    const router = this.h.router;
    for (const t of TOPICS) router.declareTopic(t.topic);
    for (const t of PUBLISH_TOPICS) router.declareTopic(t);
    router.procedure('model.ok', (args) => args[0]);
    router.procedure('model.err', () => {
      throw new WampError('model.error.failed', ['no']);
    });
    router.procedure('model.progress', (args) => {
      return new Observable<unknown>((subscriber) => {
        subscriber.next(args[0]);
        subscriber.next(args[0]);
        subscriber.complete();
      });
    });
    router.procedure('model.never', () => new Promise(() => undefined));
    const routerClock = this.h.clock.scope('router');
    router.procedure(
      'model.slow',
      (args) =>
        new Promise((resolve) => {
          routerClock.setTimeout(() => {
            resolve(args[0]);
          }, 3);
        }),
    );
    if (cfg.requestIds === 'degenerate') {
      // a pool of eight ids, so the allocator's redraw loop runs; the stream is seeded once from
      // clock.random, so only a spy on its draw can make it degenerate
      const pool = [11, 12, 13, 14, 15, 16, 17, 18];
      let k = 0;
      const spy = vi
        .spyOn(RandomIds.prototype as unknown as { draw(): number }, 'draw')
        .mockImplementation(() => pool[k++ % pool.length]!);
      this.restore.push(() => {
        spy.mockRestore();
      });
    }
    this.c = this.client('client', cfg.requestIds === 'sequential' ? 'sequential' : 'random', true);
    this.ops.set(this.c, new Map());
  }

  // --- construction ------------------------------------------------------------------------------------------

  private providers(): SimAuthProvider[] | undefined {
    if (this.cfg.auth === 'none') return undefined;
    const methods = this.cfg.auth === 'ticket' ? ['ticket'] : ['ticket', 'wampcra'];
    return methods.map((method) => ({
      method,
      extra: () => ({ nonce: ++this.nonce }),
      verify: (signature: string, _hello: unknown, extra: Readonly<Record<string, unknown>>) =>
        signature === `sig|${method}|${String(extra['nonce'])}` ? { authid: 'joe', authrole: 'user' } : false,
    }));
  }

  get authmethods(): readonly string[] | undefined {
    return this.cfg.auth === 'none' ? undefined : this.cfg.auth === 'ticket' ? ['ticket'] : ['ticket', 'wampcra'];
  }

  private retryOptions(): RetryOptions {
    const base = {
      maxRetries: this.cfg.maxRetries,
      maxRetryDelay: this.cfg.maxRetryDelay,
      initialRetryDelay: Math.min(1500, this.cfg.maxRetryDelay),
    };
    switch (this.cfg.retry) {
      case 'default':
        return base;
      case 'throws':
        return {
          ...base,
          retryDelay: () => {
            throw new Error('model: retryDelay throws');
          },
        };
      case 'nan':
        return { ...base, retryDelay: () => Number.NaN };
      case 'zero':
        return { ...base, retryDelay: () => 0 };
      case 'null-after-3':
        return { ...base, retryDelay: (attempt, _info, d) => (attempt > 3 ? null : d) };
      case 'huge':
        return { ...base, retryDelay: () => 2 ** 31 };
    }
  }

  private client(scope: string, requestIds: 'random' | 'sequential', main: boolean): SimClient<Client> {
    const cfg = this.cfg;
    const internal = { ...cfg.internal };
    const options: ClientOptions = {
      autoOpen: false,
      requestIds,
      timeouts: main ? cfg.timeouts : { ...cfg.timeouts, idle: 0 },
      retryOptions: main
        ? this.retryOptions()
        : { maxRetryDelay: cfg.maxRetryDelay, initialRetryDelay: Math.min(1500, cfg.maxRetryDelay) },
      ...(this.authmethods === undefined
        ? {}
        : main
          ? {
              authmethods: this.authmethods,
              authid: 'joe',
              onChallenge: (m: ChallengeMessage) => this.answerChallenge(m) as never,
            }
          : {
              authmethods: this.authmethods,
              authid: 'joe',
              onChallenge: (m: ChallengeMessage) => `sig|${m.authMethod}|${String(m.extra['nonce'])}`,
            }),
      [INTERNAL_OPTIONS_KEY]: internal,
    };
    const url = main && cfg.url === 'function' ? () => this.resolveUrl() : undefined;
    const sim = this.h.makeClient(Client, { scope, options, ...(url === undefined ? {} : { url: url as never }) });
    sim.open();
    return sim;
  }

  startPeer(): SimClient<Client> {
    if (this.peer !== undefined) return this.peer;
    const peer = this.client('client-2', 'sequential', false);
    this.peer = peer;
    this.ops.set(peer, new Map());
    this.register(peer, 'model.peer', 'deferred');
    return peer;
  }

  // --- app answers -------------------------------------------------------------------------------------------

  private deferred(
    kind: Deferred['kind'],
    label: string,
    settle: { resolve(): void; reject(): void; next?(): void; complete?(): void },
  ): Deferred {
    const d: Deferred = {
      n: ++this.counter,
      kind,
      label,
      settled: false,
      resolve: () => {
        if (d.settled) return;
        d.settled = true;
        settle.resolve();
      },
      reject: () => {
        if (d.settled) return;
        d.settled = true;
        settle.reject();
      },
      next: () => {
        if (!d.settled) settle.next?.();
      },
      complete: () => {
        if (d.settled) return;
        d.settled = true;
        (settle.complete ?? settle.resolve)();
      },
    };
    this.deferreds.push(d);
    return d;
  }

  /** `onChallenge` per the current ChallengeMode; the signature names the CHALLENGE (INV-AUTH). */
  private answerChallenge(m: ChallengeMessage): unknown {
    const signature = `sig|${m.authMethod}|${String(m.extra['nonce'])}`;
    switch (this.challengeMode) {
      case 'sync':
        return signature;
      case 'scheduled':
        return this.s.schedule(Promise.resolve(signature), 'challenge');
      case 'fail':
        throw new Error('model: onChallenge throws');
      case 'reject':
        return Promise.reject(new Error('model: onChallenge rejects'));
      case 'empty':
        return new Observable<string>((subscriber) => {
          subscriber.complete();
        });
      case 'deferred':
      case 'never':
        return new Promise<string>((resolve, reject) => {
          this.deferred('challenge', `challenge ${m.authMethod}`, {
            resolve: () => {
              resolve(signature);
            },
            reject: () => {
              reject(new Error('model: onChallenge rejects'));
            },
          });
        });
    }
  }

  private resolveUrl(): unknown {
    const url = this.h.router.url;
    switch (this.urlMode) {
      case 'sync':
        return url;
      case 'scheduled':
        return this.s.schedule(Promise.resolve(url), 'url');
      case 'throw':
        throw new Error('model: url throws');
      case 'empty':
        return '';
      case 'deferred':
        return new Promise<string>((resolve, reject) => {
          this.deferred('url', 'url', {
            resolve: () => {
              resolve(url);
            },
            reject: () => {
              reject(new Error('model: url rejects'));
            },
          });
        });
    }
  }

  /** A handler of `kind`; every result echoes the INVOCATION's tag (args[0]). */
  private handler(procedure: string, kind: HandlerKind): (inv: InvocationMessage) => unknown {
    return (inv) => {
      this.hook('handler');
      const tag: unknown = inv.args[0];
      switch (kind) {
        case 'echo':
          return tag;
        case 'throw':
          throw new Error('model: handler throws');
        case 'scheduled':
          return this.s.schedule(Promise.resolve(tag), `handler ${procedure}`);
        case 'never':
          return new Promise(() => undefined);
        case 'deferred':
          return new Promise((resolve, reject) => {
            this.deferred('handler', `handler ${procedure} ${String(tag)}`, {
              resolve: () => {
                resolve(tag);
              },
              reject: () => {
                reject(new Error('model: handler rejects'));
              },
            });
          });
        case 'progress':
          return new Observable<unknown>((subscriber) => {
            this.deferred('handler', `progress ${procedure} ${String(tag)}`, {
              resolve: () => {
                subscriber.next(tag);
                subscriber.complete();
              },
              reject: () => {
                subscriber.error(new Error('model: handler errors'));
              },
              next: () => {
                subscriber.next(tag);
              },
              complete: () => {
                subscriber.complete();
              },
            });
          });
      }
    };
  }

  // --- handles -----------------------------------------------------------------------------------------------

  mintTag(): string {
    this.lastTag = `op${String(++this.tags)}`;
    return this.lastTag;
  }

  /** Args whose first element is a fresh tag at every read (validate.ts reads it once per subscription). */
  private taggedArgs(): unknown[] {
    const args: unknown[] = [];
    Object.defineProperty(args, 0, { enumerable: true, get: () => this.mintTag() });
    return args;
  }

  call(
    client: SimClient<Client>,
    procedure: string,
    progressive: boolean,
    options: Record<string, unknown> = {},
  ): Handle {
    const args = this.taggedArgs();
    const observable = progressive
      ? client.client.progressiveCall(procedure, args, undefined, options)
      : client.client.call(procedure, args, undefined, options);
    return this.handle(client, progressive ? 'progressive' : 'call', 'call', procedure, observable, false, undefined);
  }

  publish(client: SimClient<Client>, topic: string, ack: boolean): Handle {
    const observable = client.client.publish(topic, this.taggedArgs(), undefined, ack ? { acknowledge: true } : {});
    return this.handle(client, 'publish', 'publish', topic, observable, ack, undefined);
  }

  topic(client: SimClient<Client>, i: number): Handle {
    const t = TOPICS[i % TOPICS.length]!;
    return this.handle(
      client,
      'topic',
      'topic',
      t.topic,
      client.client.topic(t.topic, t.options),
      false,
      topicKey(t.topic, t.options),
    );
  }

  register(client: SimClient<Client>, name: string, kind: HandlerKind): Handle {
    // a throwing handler gets a procedure of its own, so INV-R8 can tell its INVOCATIONs from another record's
    const procedure = kind === 'throw' ? THROWING : name;
    if (kind === 'throw') this.throwingHandlers.add(procedure);
    const observable = client.client.register(procedure, this.handler(procedure, kind) as never);
    return this.handle(client, 'register', 'register', procedure, observable, false, registerKey(procedure, {}));
  }

  bad(client: SimClient<Client>, kind: 'uri' | 'options' | 'args' | 'match'): Handle {
    const c = client.client;
    const observable =
      kind === 'uri'
        ? c.call('bad uri#x')
        : kind === 'options'
          ? c.call('model.ok', [], {}, { receive_progress: 'yes' as never })
          : kind === 'args'
            ? c.publish('model.t1', 'not an array' as never)
            : c.topic('model.t1', { match: 'fuzzy' as never });
    return this.handle(client, 'bad', 'call', 'bad', observable, false, undefined);
  }

  private handle(
    client: SimClient<Client>,
    kind: Handle['kind'],
    stream: TraceStream,
    uri: string,
    observable: Handle['observable'],
    ack: boolean,
    key: string | undefined,
  ): Handle {
    const handle: Handle = { n: this.handles.length, client, kind, stream, uri, observable, ack, key, subs: [] };
    this.handles.push(handle);
    this.subscribe(handle);
    return handle;
  }

  subscribe(handle: Handle): Recorded<unknown> {
    this.lastTag = undefined;
    const hookTarget: ReentrantTarget = handle.stream === 'topic' || handle.stream === 'register' ? 'interest' : 'op';
    const forward: Partial<Observer<unknown>> = {
      next: () => {
        this.hook(hookTarget);
        if (this.throwing.has(handle.n)) throw new Error('model: observer throws');
      },
      error: () => {
        this.hook(hookTarget);
        if (this.throwing.has(handle.n)) throw new Error('model: observer throws');
      },
      complete: () => {
        this.hook(hookTarget);
        if (this.throwing.has(handle.n)) throw new Error('model: observer throws');
      },
    };
    const rec = handle.client.observe(handle.stream, handle.uri, handle.observable, forward);
    handle.subs.push(rec);
    const kind = handle.kind === 'progressive' || handle.kind === 'bad' ? 'call' : handle.kind;
    this.ops.get(handle.client)?.set(rec.id, {
      kind,
      tag: kind === 'call' || kind === 'publish' ? this.lastTag : undefined,
      ack: handle.ack,
      key: handle.key,
    });
    return rec;
  }

  lifecycle(client: SimClient<Client>, stream: Lifecycle['stream']): void {
    const target: ReentrantTarget = stream;
    const source = client.client[stream] as Handle['observable'];
    const n = this.lifecycles.length;
    const rec = client.observe(stream, undefined, source, {
      next: () => {
        this.hook(target);
        if (this.throwingLifecycles.has(n)) throw new Error('model: lifecycle observer throws');
      },
    });
    this.lifecycles.push({ client, stream, rec });
  }

  /** Run the pending Reentrant action if `target` matches (inside an observer or handler: app context). */
  hook(target: ReentrantTarget): void {
    const r = this.reentrant;
    if (r?.target !== target) return;
    this.reentrant = undefined;
    const c = this.c;
    switch (r.action) {
      case 'open':
        c.open();
        return;
      case 'close':
        void c.close();
        return;
      case 'reconnect':
        c.reconnect();
        return;
      case 'call':
        this.call(c, 'model.ok', false);
        return;
      case 'topic':
        this.topic(c, 0);
        return;
      case 'publish':
        this.publish(c, 'model.t1', false);
        return;
      case 'unsubscribe': {
        const live = this.handles.flatMap((x) => x.subs).filter((s) => !s.closed);
        live[0]?.unsubscribe();
      }
    }
  }

  // --- time --------------------------------------------------------------------------------------------------

  /** Let time pass until the client is open again (what an app waiting for its session sees), at most one retry
   *  cycle; then deliver what is in flight. */
  async settle(): Promise<void> {
    const cfg = this.cfg;
    const limit =
      this.h.clock.now() +
      cfg.maxRetryDelay +
      cfg.internal.attemptFloor +
      2 * (cfg.timeouts.connect + cfg.timeouts.handshake);
    const step = Math.max(1, Math.ceil((limit - this.h.clock.now()) / 50));
    while (this.c.status?.values.at(-1)?.state !== 'open' && this.h.clock.now() < limit) await this.advance(step);
    await this.advance(2 * (cfg.latency.in + cfg.latency.out) + 1);
  }

  /** A warm start: let the first attempt establish its session (bounded: a slow handshake simply stays pending). */
  async warmUp(): Promise<void> {
    if (!this.cfg.warm) return;
    const limit = this.h.clock.now() + Math.min(200, 4 * (this.cfg.timeouts.connect + this.cfg.timeouts.handshake));
    while (this.c.status?.values.at(-1)?.state !== 'open' && this.h.clock.now() < limit) await this.advance(1);
  }

  /** The latest position of the shared trace sequence (every client's trace draws from it). */
  lastSeq(): number {
    let last = 0;
    for (const client of this.clients()) {
      const events = client.trace().events;
      last = Math.max(last, events[events.length - 1]?.seq ?? 0);
    }
    return last;
  }

  /** Router-side calls to the client's registrations (RouterInvoke and the busy caller); the tag is echoed back. */
  invoke(procedure: string, progress: boolean): void {
    const tag = `inv${String(this.routerCalls.length + 1)}`;
    const call = this.h.router.invoke(procedure, {
      args: [tag],
      ...(progress ? { options: { receive_progress: true } } : {}),
    });
    this.routerCalls.push({ call, tag, procedure });
  }

  /** What the router has registered for the client's session now. */
  registeredAtRouter(): string[] {
    const own = new Set(this.c.connections.map((c) => c.number));
    return this.h.router.sessions
      .filter((session) => own.has(session.connection))
      .flatMap((session) => session.registrations.map((r) => r.procedure));
  }

  private busyCaller(): void {
    if (!this.cfg.traffic) return;
    for (const procedure of new Set(this.registeredAtRouter())) {
      // up to two calls outstanding per procedure, at most 40 per run
      const pending = this.routerCalls.filter((r) => r.procedure === procedure && !r.call.done).length;
      for (let i = pending; i < 2 && this.routerCalls.length < 40; i++)
        this.invoke(procedure, this.routerCalls.length % 3 === 0);
    }
  }

  async advance(ms: number): Promise<void> {
    await this.advanceTime(ms);
    this.busyCaller();
  }

  private async advanceTime(ms: number): Promise<void> {
    if (this.cfg.delivery === 'manual') {
      // manual delivery: nothing moves unless flushed; time still passes in slices
      const end = this.h.clock.now() + ms;
      const slice = Math.max(1, Math.ceil(ms / 40));
      do {
        this.h.router.flush();
        await this.h.clock.advance(Math.min(slice, Math.max(0, end - this.h.clock.now())));
      } while (this.h.clock.now() < end);
      this.h.router.flush();
      await this.h.clock.advance(0);
      return;
    }
    await this.h.clock.advance(ms);
  }

  // --- checks ------------------------------------------------------------------------------------------------

  timings(main: boolean): Timings {
    const cfg = this.cfg;
    return {
      ...cfg.timeouts,
      idle: main ? cfg.timeouts.idle : 0,
      ...cfg.internal,
      maxRetryDelay: cfg.maxRetryDelay,
    };
  }

  checkOptions(client: SimClient<Client>, extra: Partial<CheckOptions> = {}): CheckOptions {
    const main = client === this.c;
    const cfg = this.cfg;
    const lat = cfg.latency.in + cfg.latency.out;
    return {
      tolerance: { absoluteMs: 1 + 2 * lat, relative: 0 },
      timings: this.timings(main),
      requestIds: (main ? cfg.requestIds === 'sequential' : true) ? 'sequential' : 'random',
      ...(this.authmethods !== undefined ? { authmethods: this.authmethods } : {}),
      maxRetries: main ? cfg.maxRetries : Number.POSITIVE_INFINITY,
      retryDelay:
        !main || cfg.retry === 'default' ? 'default' : cfg.retry === 'null-after-3' ? 'custom-null' : 'custom',
      ops: this.ops.get(client),
      signature: (sig) => {
        const [, method, nonce] = sig.split('|');
        return method === undefined ? undefined : { method, token: nonce };
      },
      challengeToken: (extra) => String(extra['nonce']),
      exempt: (e) => e instanceof Error && INJECTED.test(e.message),
      skews: this.skews,
      suspends: this.suspends,
      throwingHandlers: main ? this.throwingHandlers : new Set(),
      faults: this.faults,
      buffered: this.buffered,
      scope: client.scope.name,
      now: this.h.clock.now(),
      lostInterests:
        this.loggerFaults ||
        client
          .trace()
          .logs.some(
            (l) =>
              l.entry.event === 'unhandled' &&
              (l.entry.data as { context?: unknown } | undefined)?.context === 'hardReset',
          ),
      ...extra,
    };
  }

  /** Every invariant after a command (safety parts), on every client. */
  check(
    label: string,
    ids: readonly InvariantId[] = INVARIANT_IDS,
    extra: Partial<CheckOptions> = {},
    perClient?: ReadonlyMap<SimClient<Client>, Partial<CheckOptions>>,
  ): void {
    for (const client of this.clients()) {
      const trace = client.trace();
      const options = this.checkOptions(client, { ...extra, ...perClient?.get(client) });
      const found = checkInvariants(trace, options, this.idsFor(ids));
      if (found.length > 0) this.fail(label, client, found, trace);
    }
  }

  private idsFor(ids: readonly InvariantId[]): readonly InvariantId[] {
    // a throwing logger loses entries (the trace is the logger): the checkers that read log entries are skipped
    return this.loggerFaults ? ids.filter((id) => id !== 'INV-LIVE' && id !== 'INV-R3') : ids;
  }

  fail(label: string, client: SimClient<Client>, found: readonly InvariantViolation[], trace: Trace): never {
    const report = formatViolations(found, trace);
    throw new Error(
      `after ${label} (client ${String(client.index)}, config ${JSON.stringify(this.cfg)}):\n${report}\ncommands:\n  ${this.log.join('\n  ')}`,
    );
  }

  clients(): SimClient<Client>[] {
    return this.peer === undefined ? [this.c] : [this.c, this.peer];
  }

  /** Router-side calls answered by a callee of ours echo their own tag (a stale or misrouted YIELD shows here). */
  checkRouterCalls(label: string): void {
    for (const { call, tag, procedure } of this.routerCalls) {
      const result = call.result;
      // an empty result (an Observable that completed without a value) cannot carry another call's tag
      if (result !== undefined && result.args.length > 0 && result.args[0] !== tag) {
        throw new Error(
          `after ${label}: the router call ${tag} to ${procedure} was answered ${JSON.stringify(result.args)}\ncommands:\n  ${this.log.join('\n  ')}`,
        );
      }
      for (const p of call.progress) {
        if (p.args[0] !== tag)
          throw new Error(
            `after ${label}: a progress result of ${tag} carried ${JSON.stringify(p.args)}\ncommands:\n  ${this.log.join('\n  ')}`,
          );
      }
    }
  }

  // --- healing and the end of a run --------------------------------------------------------------------------

  /** `client`'s INV-R1 bound from now: max(idle + budget, handshake', connect') + maxDelay + connect' + handshake' + ε,
   *  from its own ends and options (the peer has no liveness and the default retry strategy). */
  bound(client: SimClient<Client> = this.c): number | undefined {
    const cfg = this.cfg;
    const main = client === this.c;
    const trace = client.trace();
    // one per end (trace.closeInfos has one per onClose observer)
    const ends = indexTrace(trace).ends;
    let kc = 0;
    let kh = 0;
    for (const e of ends) {
      const timer = (e.info.error as { timer?: unknown } | undefined)?.timer;
      if (timer === 'connect') kc++;
      else if (timer === 'handshake') kh++;
      else {
        kc = timer === undefined || e.info.closeCode !== undefined ? 0 : kc;
        kh = e.info.sessionId !== undefined ? 0 : kh;
      }
    }
    const cap = (base: number, k: number): number => Math.min(base * 2 ** k, Math.max(base, 60000));
    const connect1 = cap(cfg.timeouts.connect, kc);
    const handshake1 = cap(cfg.timeouts.handshake, kh);
    const livenessEnds = ends.filter(
      (e) => (e.info.error as { timer?: unknown } | undefined)?.timer === 'liveness',
    ).length;
    let budget = cfg.internal.ping;
    for (let i = 0; i < livenessEnds; i++) budget = Math.min(2 * budget, Math.max(120000, cfg.internal.ping));
    const retry = main ? cfg.retry : 'default';
    const maxDelay = retry === 'huge' ? undefined : retry === 'zero' ? 100 : cfg.maxRetryDelay;
    if (maxDelay === undefined) return undefined;
    const idle = main && cfg.timeouts.idle > 0 ? cfg.timeouts.idle + 2 * budget : 0;
    const lat = cfg.latency.in + cfg.latency.out;
    const eps = cfg.internal.settle * 2 + cfg.internal.attemptFloor + cfg.internal.goodbye + 20 * lat + 3000 + 50;
    return (
      Math.max(idle, handshake1, connect1) +
      maxDelay +
      cap(cfg.timeouts.connect, kc + 1) +
      cap(cfg.timeouts.handshake, kh + 1) +
      eps
    );
  }

  /** Settle every pending app answer the way a working app would (handlers answer with their tag). */
  private releaseDeferreds(): void {
    for (const d of this.deferreds) if (!d.settled) d.resolve();
  }

  /** Healing: every fault lifted, every pending app answer released, then time passes up to the INV-R1 bound. */
  async heal(): Promise<Map<SimClient<Client>, Partial<CheckOptions>>> {
    for (const client of this.clients()) {
      const faults = client.faults as { clear(): void } | undefined;
      faults?.clear();
    }
    this.challengeMode = 'sync';
    this.urlMode = 'sync';
    this.reentrant = undefined;
    this.throwing.clear();
    this.throwingLifecycles.clear();
    for (const remove of this.removers.splice(0)) remove();
    this.h.router.heal();
    for (const connection of this.h.router.connections) {
      if (connection.controls.frozen !== undefined) connection.controls.thaw();
    }
    // what is on the wire lands first (frames, the busy caller's calls), then the app answers what it still owes,
    // oldest first — as a slow app would
    for (let round = 0; round < 3; round++) {
      await this.advance(1 + this.cfg.latency.in + this.cfg.latency.out);
      this.releaseDeferreds();
      await this.s.waitIdle();
      await this.advance(0);
    }
    const at = this.h.clock.now();
    const seq = this.lastSeq() + 0.5; // after every event and every clock jump recorded so far
    // each client by its own bound (the peer's consecutive timeouts are its own); time passes up to the longest
    const healed = new Map<SimClient<Client>, Partial<CheckOptions>>();
    for (const client of this.clients()) {
      const b = this.bound(client);
      if (b !== undefined) healed.set(client, { healed: { seq, at, bound: b } });
    }
    const bound = Math.max(0, ...[...healed.values()].map((x) => x.healed?.bound ?? 0));
    if (bound === 0) {
      await this.advance(5000);
      return healed;
    }
    // in slices, so that app answers created while healing (a CHALLENGE answered by a deferred mode set earlier)
    // are released too
    const slices = 8;
    for (let i = 0; i < slices; i++) {
      await this.advance(Math.ceil(bound / slices));
      this.releaseDeferreds();
      await this.s.waitIdle();
    }
    return healed;
  }

  /** The end of a run: heal, the final invariants (INV-R1 bound included), close everything, the post-close checks. */
  async finish(): Promise<void> {
    const healed = await this.heal();
    this.checkRouterCalls('heal');
    this.check('heal', INVARIANT_IDS, { final: true }, healed);
    await this.h.closeAndSettle();
    await this.s.waitIdle();
    this.check('close', INVARIANT_IDS, { final: true });
    for (const client of this.clients()) {
      const debug = client.debug() as Parameters<typeof checkDebugProbe>[0];
      const found = checkDebugProbe(debug, { liveSubscriptions: 0 });
      if (found.length > 0) this.fail('close (debug probe)', client, found, client.trace());
      for (const connection of client.connections) {
        expect(connection.controls.listenerCount, `socket ${String(connection.number)} listeners`).toBe(0);
      }
      expect(client.scope.pendingTimers, `client ${String(client.index)} timers after close`).toBe(0);
    }
    // an injected deserialize fault makes the client ABORT after a frame it could not read; the router's oracle
    // judges what it sent, so it sees an ABORT after its own ABORT/GOODBYE (INV-CL01 excuses it the same way)
    if (this.consoleErrors !== undefined) {
      expect(this.consoleErrors.mock.calls.length, 'console.error fallbacks of a throwing logger').toBeLessThanOrEqual(
        this.clients().length,
      );
    }
    const problems = this.h
      .problems()
      .filter((p) => !p.includes('internal error logged') && !p.includes('injected fault: serializer.deserialize'));
    expect(problems, this.log.join('\n')).toEqual([]);
  }

  /** A throwing logger: `safeLog` swallows it, with at most one `console.error` fallback per client. */
  faultLogger(): void {
    this.loggerFaults = true;
    if (this.consoleErrors !== undefined) return;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    this.consoleErrors = spy;
    this.restore.push(() => {
      spy.mockRestore();
    });
  }

  private consoleErrors: { readonly mock: { readonly calls: readonly unknown[] } } | undefined;

  dispose(): void {
    for (const restore of this.restore.splice(0)) restore();
  }
}
