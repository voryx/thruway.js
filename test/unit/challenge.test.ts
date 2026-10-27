// The challenge runner. Covered here:
// - onChallenge answers: a value, a Promise or thenable, an Observable (ours, RxJS 5/6/7/9, interop objects), an async
//   iterable (an `async function*`), the auth helpers;
// - every failure kind becomes challenge.fail;
// - exactly one input per round, bound to that round's (conn, round); the latest round wins;
// - cancel unsubscribes the answer before it aborts the signal, with the reason the core gives for each end kind;
// - late answers are dropped and never reach another connection.
// The `Core` double below implements the core's CHALLENGE handling, so the runner is also tested the way the core
// drives it: Thruway PHP's duplicate CHALLENGEs, the login dialog of README recipe 17, a late answer from an earlier
// connection, and a model-based property over random interleavings.
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { defer, EMPTY, of, shareReplay, throwError, Observable as Rx7Observable } from 'rxjs';
import { ColdObservable } from 'rxjs9';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cryptosign, ticket, wampcra } from '../../src/auth/index.js';
import type { ChallengeRunnerDeps, CoreInput } from '../../src/core/contracts.js';
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  ConnectionClosedError,
  ConnectionLostError,
  isThruwayError,
  type ThruwayError,
} from '../../src/errors.js';
import type * as AbortModule from '../../src/observable/abort.js';
import type * as InputModule from '../../src/observable/input.js';
import { toObservable } from '../../src/observable/input.js';
import type { UnhandledReporter } from '../../src/observable/observable.js';
import { symbolObservable } from '../../src/observable/symbol-observable.js';
import { ChallengeRunner, REPORTER } from '../../src/ops/challenge.js';
import type { InboundChallenge } from '../../src/protocol/messages.js';
import type { ChallengeMessage, Input, Observer } from '../../src/types.js';
import { FakeEffects, inbound } from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

const require = createRequire(import.meta.url);

// ------------------------------------------------------------------------------------------------ fault injection
// The runner wraps firstValue and its two cancel steps in try/catch. The real helpers never throw, so
// these wrappers delegate to them unless a test injects a fault.
const faults = vi.hoisted(() => ({
  firstValue: undefined as ((...args: unknown[]) => () => void) | undefined,
  abortThrows: undefined as { readonly error: unknown } | undefined,
}));
vi.mock('../../src/observable/input.js', async (importOriginal) => {
  const real = await importOriginal<typeof InputModule>();
  const firstValue: typeof real.firstValue = (...args) =>
    faults.firstValue === undefined ? real.firstValue(...args) : faults.firstValue(...args);
  return { ...real, firstValue };
});
vi.mock('../../src/observable/abort.js', async (importOriginal) => {
  const real = await importOriginal<typeof AbortModule>();
  const createAbort: typeof real.createAbort = (reporter) => {
    const handle = real.createAbort(reporter);
    const fault = faults.abortThrows;
    if (fault === undefined) return handle;
    return {
      signal: handle.signal,
      abort(reason) {
        handle.abort(reason);
        throw fault.error;
      },
    };
  };
  return { ...real, createAbort };
});

afterEach(() => {
  faults.firstValue = undefined;
  faults.abortThrows = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------------------ helpers

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly runner: ChallengeRunner;
  readonly inputs: CoreInput[];
  readonly messages: ChallengeMessage[];
  readonly reports: (readonly [unknown, string])[];
}

/** A runner whose submit and reporter record; `onChallenge` is wrapped to record each ChallengeMessage. */
function setup(
  onChallenge: ((challenge: ChallengeMessage) => Input<string>) | undefined,
  submit?: (input: CoreInput) => void,
): Harness {
  const inputs: CoreInput[] = [];
  const messages: ChallengeMessage[] = [];
  const reports: (readonly [unknown, string])[] = [];
  const reporter: UnhandledReporter = (error, kind) => {
    reports.push([error, kind]);
  };
  const deps: ChallengeRunnerDeps = {
    onChallenge:
      onChallenge === undefined
        ? undefined
        : (challenge) => {
            messages.push(challenge);
            return onChallenge(challenge);
          },
    submit: (input) => {
      inputs.push(input);
      submit?.(input);
    },
  };
  return { runner: new ChallengeRunner(deps, reporter), inputs, messages, reports };
}

const EXTRA: Readonly<Record<string, unknown>> = Object.freeze({ challenge: 'abc' });
const ok = (conn: number, round: number, signature: string): CoreInput => ({
  kind: 'challenge.ok',
  conn,
  round,
  signature,
});
const failure = (conn: number, round: number, error: unknown): CoreInput => ({
  kind: 'challenge.fail',
  conn,
  round,
  error,
});

/** Exactly one input: challenge.fail for (conn, round) carrying `error` itself (identity, not equality). */
function expectFailure(inputs: readonly CoreInput[], conn: number, round: number, error: unknown): void {
  expect(inputs).toEqual([failure(conn, round, error)]);
  expect(failedWith(inputs)).toBe(error);
}

/** The error of the single challenge.fail input. */
function failedWith(inputs: readonly CoreInput[]): unknown {
  expect(inputs).toHaveLength(1);
  const [input] = inputs;
  if (input?.kind !== 'challenge.fail') throw new Error(`expected challenge.fail, got ${JSON.stringify(input)}`);
  return input.error;
}

/**
 * An answer under test control: an interop Observable that logs its subscriptions. A `hostile` one keeps calling the
 * observers it was given after they unsubscribed (a broken foreign Observable).
 */
class Manual {
  subscribes = 0;
  unsubscribes = 0;
  private observers: Observer<unknown>[] = [];
  readonly input: Input<string>;

  constructor(
    private readonly log: string[] = [],
    private readonly hostile = false,
  ) {
    this.input = {
      [symbolObservable]: () => ({
        subscribe: (observer: Observer<unknown>) => {
          this.subscribes++;
          this.log.push('subscribe');
          this.observers.push(observer);
          return {
            unsubscribe: () => {
              this.unsubscribes++;
              this.log.push('unsubscribe');
              if (!this.hostile) this.observers = this.observers.filter((o) => o !== observer);
            },
          };
        },
      }),
    };
  }

  get active(): number {
    return this.subscribes - this.unsubscribes;
  }
  next(value: unknown): void {
    for (const observer of [...this.observers]) observer.next(value);
  }
  error(error: unknown): void {
    for (const observer of [...this.observers]) observer.error(error);
  }
  complete(): void {
    for (const observer of [...this.observers]) observer.complete();
  }
}

/** A minimal thenable (not a Promise): its `then` gets the two callbacks. */
function thenable(then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => void): Input<string> {
  return { then } as unknown as Input<string>;
}

/** Log 'abort' when the signal aborts. */
function onAbort(signal: ChallengeMessage['signal'], log: string[]): void {
  signal.addEventListener('abort', () => log.push('abort'));
}

/** The (conn, round) a runner input is bound to. */
function roundOf(input: CoreInput): { readonly conn: number; readonly round: number } {
  if (input.kind !== 'challenge.ok' && input.kind !== 'challenge.fail') throw new Error(`unexpected ${input.kind}`);
  return input;
}

// ------------------------------------------------------------------------------------------------ the Core double

type CoreState = 'CLOSED' | 'WAITING' | 'HELLO_SENT' | 'CHALLENGED' | 'ESTABLISHED';
type LogEvent =
  | { readonly type: 'run'; readonly k: number }
  | { readonly type: 'cancel'; readonly reason: ThruwayError }
  | { readonly type: 'submit'; readonly input: CoreInput };

/**
 * A test double of the core, restricted to what the runner sees:
 * - the core's CHALLENGE, challenge.ok/fail and WELCOME transitions, the settle window included (`settle()` fires
 *   timer.challenge);
 * - the cancel deliveries of the end and close procedures and of reconnect(), with their reasons;
 * - the delivery rules of the event loop: deliveries run FIFO after the step and are never nested; an input
 *   submitted outside a step is processed at once; `batch` processes several events before the deliveries run, like a
 *   synchronous transport.
 * Frames are recorded with the connection and the round they were written in.
 */
class Core {
  readonly fx = new FakeEffects();
  readonly runner: ChallengeRunner;
  /** Every run, cancel and submit of the runner, in execution order. */
  readonly log: LogEvent[] = [];
  /** (conn, round) of each run, in delivery order: run k is the k-th onChallenge call. */
  readonly runs: { readonly conn: number; readonly round: number; readonly method: string }[] = [];
  readonly messages: ChallengeMessage[] = [];
  readonly written: { readonly conn: number; readonly round: number; readonly frame: readonly unknown[] }[] = [];
  readonly dropped: CoreInput[] = [];
  /** challenge.ok inputs for an ended connection while WAITING (they start the next attempt early). */
  readonly earlyStarts: number[] = [];
  readonly reports: unknown[] = [];
  /** An app `onClose` observer: delivered before the challenge cancel of an end, after it on
   *  close(). */
  onClose: ((core: Core) => void) | undefined;
  state: CoreState = 'CLOSED';
  conn = 0;
  round = 0;
  private settling: InboundChallenge | undefined;
  private running = false;
  private draining = false;
  private batching = false;

  constructor(
    readonly authmethods: readonly string[],
    onChallenge: (challenge: ChallengeMessage, core: Core) => Input<string>,
  ) {
    this.runner = new ChallengeRunner(
      {
        onChallenge: (challenge) => {
          this.messages.push(challenge);
          return onChallenge(challenge, this);
        },
        submit: (input) => {
          this.submit(input);
        },
      },
      (error) => this.reports.push(error),
    );
  }

  /** Whether a run was delivered for the current round and not answered yet (the handler is running). */
  get awaiting(): boolean {
    return this.running;
  }

  submit(input: CoreInput): void {
    this.log.push({ type: 'submit', input });
    this.step(input);
    this.drain();
  }

  batch(...events: readonly ((core: Core) => void)[]): void {
    this.batching = true;
    try {
      for (const event of events) event(this);
    } finally {
      this.batching = false;
    }
    this.drain();
  }

  /** open() / timer.retry: a new attempt whose HELLO is out. */
  attempt(): void {
    if (this.state === 'CLOSED' || this.state === 'WAITING') this.startAttempt();
    this.drain();
  }

  challenge(method: string): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') {
      const msg = inbound.challenge(
        method,
        Object.freeze({ challenge: `${String(this.conn)}.${String(this.round + 1)}` }),
      );
      if (!this.authmethods.includes(method) || this.round === 8) {
        this.write([3, { message: 'cannot authenticate' }, 'wamp.error.cannot_authenticate']);
        this.endAttempt(true, new AuthenticationError({ message: 'CHALLENGE not answerable', authMethod: method }));
      } else if (this.settling !== undefined) {
        this.round++;
        this.settling = msg; // the newer CHALLENGE replaces the held one; nothing was delivered
      } else {
        if (this.running) this.cancel(new CanceledError({ message: 'superseded' })); // latest wins
        this.round++;
        this.state = 'CHALLENGED';
        if (this.round === 1 && this.authmethods.length > 1) this.settling = msg;
        else this.runRound(msg);
      }
    } // in any other state the frame is dropped
    this.drain();
  }

  /** timer.challenge: the settle window closed. */
  settle(): void {
    if (this.state === 'CHALLENGED' && this.settling !== undefined) {
      const msg = this.settling;
      this.settling = undefined;
      this.runRound(msg);
    }
    this.drain();
  }

  /** ws.closed; `willRetry: false` is a give-up. */
  drop(willRetry = true): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') {
      this.endAttempt(willRetry, new ConnectionLostError({ message: 'socket closed (1006): ', closeCode: 1006 }));
    } else if (this.state === 'ESTABLISHED') {
      this.state = willRetry ? 'WAITING' : 'CLOSED';
    }
    this.drain();
  }

  /** A router ABORT during the handshake. */
  abort(): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') {
      this.endAttempt(true, new AbortError({ reason: 'thruway.error.authentication_failure' }));
    }
    this.drain();
  }

  welcome(): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') {
      if (this.state === 'CHALLENGED') this.cancel(new CanceledError({ message: 'welcomed' }));
      this.running = false;
      this.settling = undefined;
      this.state = 'ESTABLISHED';
    }
    this.drain();
  }

  close(): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') this.cancel(new ConnectionClosedError({}));
    if (this.state !== 'CLOSED') this.notifyClose();
    this.running = false;
    this.settling = undefined;
    this.state = 'CLOSED';
    this.drain();
  }

  reconnect(): void {
    if (this.state === 'HELLO_SENT' || this.state === 'CHALLENGED') {
      this.cancel(new CanceledError({ message: 'reconnect' }));
    }
    this.startAttempt();
    this.drain();
  }

  /** The reasons the core passed to cancel deliveries that ran, in order. */
  get cancelReasons(): ThruwayError[] {
    return this.log.flatMap((event) => (event.type === 'cancel' ? [event.reason] : []));
  }

  private startAttempt(): void {
    this.conn++;
    this.round = 0;
    this.running = false;
    this.settling = undefined;
    this.state = 'HELLO_SENT';
  }

  private runRound(msg: InboundChallenge): void {
    const { conn, round } = this;
    const k = this.runs.length;
    this.runs.push({ conn, round, method: msg.authMethod });
    this.running = true;
    this.fx.deliver(() => {
      this.log.push({ type: 'run', k });
      this.runner.run(conn, round, msg);
    });
  }

  private cancel(reason: ThruwayError): void {
    this.fx.deliver(() => {
      this.log.push({ type: 'cancel', reason });
      this.runner.cancel(reason);
    });
  }

  private step(input: CoreInput): void {
    if (input.kind !== 'challenge.ok' && input.kind !== 'challenge.fail') throw new Error(`unexpected ${input.kind}`);
    const live = this.state === 'CHALLENGED' && this.running && input.conn === this.conn && input.round === this.round;
    if (!live) {
      if (input.kind === 'challenge.ok' && this.state === 'WAITING') this.earlyStarts.push(input.conn);
      this.dropped.push(input);
      return;
    }
    this.running = false;
    if (input.kind === 'challenge.ok') {
      this.write([5, input.signature, {}]);
      this.state = 'HELLO_SENT';
    } else {
      this.write([3, { message: 'onChallenge failed' }, 'wamp.error.cannot_authenticate']);
      this.endAttempt(true, new AuthenticationError({ message: 'onChallenge failed', cause: input.error }));
    }
  }

  private notifyClose(): void {
    const observer = this.onClose;
    if (observer !== undefined) {
      this.fx.deliver(() => {
        observer(this);
      });
    }
  }

  private write(frame: readonly unknown[]): void {
    this.written.push({ conn: this.conn, round: this.round, frame });
  }

  /** The end of an attempt without a session: the challenge cancel is delivered (a no-op when nothing runs), with
   *  ConnectionLostError when the client will retry, else ConnectionClosedError{gaveUp: true}. */
  private endAttempt(willRetry: boolean, error: ThruwayError): void {
    this.notifyClose();
    this.cancel(
      willRetry
        ? new ConnectionLostError({ message: 'The connection was lost', cause: error })
        : new ConnectionClosedError({ gaveUp: true, cause: error }),
    );
    this.running = false;
    this.settling = undefined;
    this.state = willRetry ? 'WAITING' : 'CLOSED';
  }

  private drain(): void {
    if (this.draining || this.batching) return;
    this.draining = true;
    try {
      this.fx.runDeliveries();
    } finally {
      this.draining = false;
    }
  }
}

/** The AUTHENTICATE frames written: [conn, round, signature]. */
function authenticates(core: Core): [number, number, unknown][] {
  return core.written.flatMap(({ conn, round, frame }) => (frame[0] === 5 ? [[conn, round, frame[1]]] : []));
}

// ================================================================================================ answers

describe('answers: any Input of a string ⇒ challenge.ok for the round that ran', () => {
  const rx5 = require('rxjs5/Rx.js') as { Observable: { of(value: string): Input<string> } };
  const rx6 = require('rxjs6') as { of(value: string): Input<string> };
  const cases: [string, () => Input<string>][] = [
    ['a plain string', () => 'sig'],
    ['a Promise', () => Promise.resolve('sig')],
    [
      'a thenable',
      () =>
        thenable((resolve) => {
          resolve('sig');
        }),
    ],
    ['an Observable of ours', () => toObservable('sig')],
    ['an RxJS 7 Observable', () => of('sig')],
    ['an RxJS 7 Observable emitting later', () => defer(() => Promise.resolve('sig'))],
    ['an RxJS 5 Observable', () => rx5.Observable.of('sig')],
    ['an RxJS 6 Observable', () => rx6.of('sig')],
    [
      'an RxJS 9 ColdObservable',
      () =>
        new ColdObservable<string>((subscriber) => {
          subscriber.next('sig');
          subscriber.complete();
        }),
    ],
    [
      "an interop object keyed '@@observable'",
      () => ({
        '@@observable': () => ({
          subscribe(observer: Observer<string>) {
            observer.next('sig');
            return { unsubscribe: () => undefined };
          },
        }),
      }),
    ],
    [
      'any object with subscribe()',
      () => ({
        subscribe(observer: Observer<string>) {
          observer.next('sig');
          observer.complete();
        },
      }),
    ],
  ];

  test.each(cases)('%s', async (_name, answer) => {
    const { runner, inputs, reports } = setup(answer);
    runner.run(7, 3, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    expect(inputs).toEqual([ok(7, 3, 'sig')]);
    expect(reports).toEqual([]);
  });

  test('the empty string is a valid answer (an app without a token answers it; the router decides)', () => {
    const { runner, inputs } = setup(() => '');
    runner.run(1, 1, { authMethod: 'jwt', extra: EXTRA });
    expect(inputs).toEqual([ok(1, 1, '')]);
  });

  test.each([
    ['surrounding whitespace and a newline', ' token \n'],
    ['NUL and a lone surrogate', '\u0000\ud800'],
    ['non-ASCII, not normalised (a decomposed é)', 'jeton-e\u0301-🔑'],
    ['a 1 MiB JWT', 'x'.repeat(1 << 20)],
  ])('the answer is passed on verbatim: %s', (_name, signature) => {
    for (const answer of [() => signature, () => of(signature)]) {
      const { runner, inputs } = setup(answer);
      runner.run(1, 1, { authMethod: 'jwt', extra: EXTRA });
      expect(inputs).toEqual([ok(1, 1, signature)]);
    }
  });

  test('a synchronous answer is submitted inside run (no extra turn)', () => {
    const { runner, inputs } = setup(() => of('now'));
    runner.run(2, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(inputs).toEqual([ok(2, 1, 'now')]);
  });

  test('an Observable of several values: the first is the answer, and it is unsubscribed at once', () => {
    let teardowns = 0;
    const tokens = new Rx7Observable<string>((subscriber) => {
      subscriber.next('first');
      subscriber.next('second');
      return () => {
        teardowns++;
      };
    });
    const { runner, inputs } = setup(() => tokens);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(inputs).toEqual([ok(1, 1, 'first')]);
    expect(teardowns).toBe(1);
  });

  test('an RxJS 9 answer is unsubscribed through its signal after the first value', async () => {
    let signal: AbortSignal | undefined;
    const tokens = new ColdObservable<string>((subscriber) => {
      signal = subscriber.signal;
      setTimeout(() => {
        subscriber.next('later');
      }, 0);
    });
    const { runner, inputs } = setup(() => tokens);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(signal?.aborted).toBe(false);
    await flush();
    expect(inputs).toEqual([ok(1, 1, 'later')]);
    expect(signal?.aborted).toBe(true);
  });

  test('ticket(): the ticket, and the function form re-read per handshake', async () => {
    const fixed = setup(ticket('ticketuser', 'ticketsecret').onChallenge);
    fixed.runner.run(1, 1, { authMethod: 'ticket', extra: { challenge: {}, challenge_method: 'ticket' } });
    expect(fixed.inputs).toEqual([ok(1, 1, 'ticketsecret')]);
    let n = 0;
    const read = setup(ticket('u', () => Promise.resolve(`t${String(++n)}`)).onChallenge);
    read.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    read.runner.run(2, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    expect(read.inputs).toEqual([ok(1, 1, 't1'), ok(2, 1, 't2')]);
  });

  test('wampcra(): the published WAMP-CRA vector', async () => {
    const challenge =
      '{"authid":"peter","authrole":"user","authmethod":"wampcra","authprovider":"userdb","nonce":"LHRTC9zeOIrt_9U3",' +
      '"timestamp":"2014-06-22T16:36:25.448Z","session":3251278072152162}';
    const { runner, inputs } = setup(wampcra('peter', 'L3L1YUE8Txlw').onChallenge);
    runner.run(4, 2, { authMethod: 'wampcra', extra: Object.freeze({ challenge }) });
    await vi.waitFor(() => {
      expect(inputs).toEqual([ok(4, 2, 'PBOOq9+QzkvX5XaRPEd5/AkZikJep4wP3ZAKTxESkBM=')]);
    });
  });

  test('cryptosign(): the WAMP spec vector, hex(signature ‖ challenge)', async () => {
    const options = cryptosign({
      authid: 'csuser',
      publicKey: '1adfc8bfe1d35616e64dffbd900096f23b066f914c8c2ffbb66f6075b96e116d',
      privateKey: '4d57d97a68f555696620a6d849c0ce582568518d729eb753dc7c732de2804510',
    });
    const { runner, inputs, reports } = setup(options.onChallenge);
    runner.run(3, 1, { authMethod: 'cryptosign', extra: Object.freeze({ challenge: 'f'.repeat(64) }) });
    await vi.waitFor(() => {
      expect(inputs).toEqual([
        ok(
          3,
          1,
          'b32675b221f08593213737bef8240e7c15228b07028e19595294678c90d11c0cae80a357331bfc5cc9fb71081464e6e75013517c2cf067' +
            'ad566a6b7b728e5d03' +
            'f'.repeat(64),
        ),
      ]);
    });
    expect(reports).toEqual([]);
  });

  test('inputs carry the (conn, round) they were run for (property)', () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 8 }), fc.string(), fc.boolean(), (conn, round, sig, error) => {
        const boom = new Error(sig);
        const { runner, inputs } = setup(() => (error ? throwError(() => boom) : of(sig)));
        runner.run(conn, round, { authMethod: 'm', extra: EXTRA });
        if (error) expectFailure(inputs, conn, round, boom);
        else expect(inputs).toEqual([ok(conn, round, sig)]);
      }),
      replayParameters(),
    );
  });
});

// ================================================================================================ ChallengeMessage

describe('the ChallengeMessage', () => {
  test('frozen; authMethod and extra as received; a fresh, unaborted signal per run; onChallenge runs inside run', () => {
    const extra = Object.freeze({ challenge: 'x', salt: 's' });
    const args: unknown[][] = [];
    const { runner, messages } = setup((...given: unknown[]) => {
      args.push(given);
      return new Manual().input;
    });
    runner.run(1, 1, { authMethod: 'wampcra', extra });
    expect(messages).toHaveLength(1); // called synchronously: run is the delivery that runs app code
    runner.run(1, 2, { authMethod: 'ticket', extra: EXTRA });
    const [first, second] = messages;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first?.authMethod).toBe('wampcra');
    expect(first?.extra).toBe(extra);
    expect(Object.keys(first ?? {}).sort()).toEqual(['authMethod', 'extra', 'signal']);
    expect(args.map((a) => a.length)).toEqual([1, 1]);
    expect(second?.signal).not.toBe(first?.signal);
    expect(second?.signal.aborted).toBe(false);
  });

  test("carries the runner's reporter under Symbol.for('thruway.js.reporter'), non-enumerable", () => {
    const { runner, messages, reports } = setup(() => new Manual().input);
    runner.run(1, 1, { authMethod: 'wampcra', extra: EXTRA });
    const message = messages[0]!;
    const key = Symbol.for('thruway.js.reporter');
    expect(REPORTER).toBe(key);
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
    expect(Object.getOwnPropertySymbols(message)).toEqual([key]);
    expect(Object.getOwnPropertySymbols({ ...message })).toEqual([]); // a spread copy drops it
    expect(JSON.stringify(message)).toBe(JSON.stringify({ authMethod: 'wampcra', extra: EXTRA, signal: {} }));
    const reporter = descriptor?.value as UnhandledReporter;
    const error = new Error('from a helper');
    reporter(error, 'unhandled');
    expect(reports).toEqual([[error, 'unhandled']]); // the runner's own reporter (the client's logger)
  });

  test('the platform AbortSignal when there is one, so the app can hand it to fetch (recipe 18)', () => {
    const { runner, messages } = setup(() => new Manual().input);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(messages[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('without AbortController (Hermes) the fallback signal works the same way', () => {
    vi.stubGlobal('AbortController', undefined);
    const log: string[] = [];
    const { runner, messages } = setup(() => new Manual().input);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    const signal = messages[0]!.signal;
    expect(signal).not.toBeInstanceOf(AbortSignal);
    onAbort(signal, log);
    const reason = new ConnectionLostError({});
    runner.cancel(reason);
    expect(log).toEqual(['abort']);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });
});

// ================================================================================================ failures

describe('every failure kind ⇒ challenge.fail', () => {
  test.each<[string, unknown]>([
    ['an Error', new Error('no credentials')],
    ['a string', 'nope'],
    ['undefined', undefined],
  ])('onChallenge throws %s: that value, unchanged', (_name, thrown) => {
    const { runner, inputs } = setup(() => {
      throw thrown;
    });
    runner.run(3, 1, { authMethod: 'ticket', extra: EXTRA });
    expectFailure(inputs, 3, 1, thrown);
  });

  test('a rejected Promise: the rejection, unchanged', async () => {
    const boom = new Error('dialog dismissed');
    const { runner, inputs } = setup(() => Promise.reject(boom));
    runner.run(1, 2, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    expectFailure(inputs, 1, 2, boom);
  });

  test('a thenable that rejects with a non-Error: that value', async () => {
    const { runner, inputs } = setup(() =>
      thenable((_resolve, reject) => {
        reject(42);
      }),
    );
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    expect(failedWith(inputs)).toBe(42);
  });

  test('an Observable that errors: that error, and the answer is released', () => {
    const boom = new Error('token service down');
    const manual = new Manual();
    const { runner, inputs } = setup(() => manual.input);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    manual.error(boom);
    expectFailure(inputs, 1, 1, boom);
    expect(manual.active).toBe(0);
    expect(failedWith(setupAndRun(() => throwError(() => boom)))).toBe(boom);
  });

  test.each([
    ['an RxJS EMPTY', () => EMPTY],
    [
      'an Observable that only completes',
      () =>
        new Rx7Observable<string>((subscriber) => {
          subscriber.complete();
        }),
    ],
    [
      'an object with subscribe() that only completes',
      () => ({
        subscribe(observer: Observer<string>) {
          observer.complete();
        },
      }),
    ],
  ])('%s: TypeError "completed without a value"', (_name, answer) => {
    const error = failedWith(setupAndRun(answer));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('onChallenge completed without a value');
  });

  test.each([
    ['a number', 42, 'number'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['true', true, 'boolean'],
    ['an object holding the token', { token: 'secret-token' }, 'object'],
    ['an array', ['secret-token'], 'object'],
    ['bytes', new Uint8Array([1, 2, 3]), 'object'],
    ['a function', () => 'secret-token', 'function'],
  ])('a non-string answer (%s): TypeError naming its type, never its value', async (_name, value, type) => {
    const answers: (() => unknown)[] = [() => value, () => Promise.resolve(value), () => of(value)];
    for (const answer of answers) {
      const { runner, inputs } = setup(() => answer() as Input<string>);
      runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
      await flush();
      const error = failedWith(inputs);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`onChallenge must answer a string, not ${type}`);
      expect((error as Error).message).not.toContain('secret-token');
    }
  });

  test('an async iterable is an Input: an async function* answers with its first value', async () => {
    const log: string[] = [];
    async function* tokens(): AsyncGenerator<string> {
      try {
        yield await Promise.resolve('sig');
        log.push('asked for a second token');
        yield 'second';
      } finally {
        log.push('finally');
      }
    }
    const { runner, inputs, reports } = setup(() => tokens());
    runner.run(4, 2, { authMethod: 'ticket', extra: EXTRA });
    expect(inputs).toEqual([]);
    await flush();
    expect(inputs).toEqual([ok(4, 2, 'sig')]);
    expect(log).toEqual(['finally']); // released after its first value (return()), never pulled again
    expect(reports).toEqual([]);
  });

  test('an async function* that ends without a value, throws, or yields a non-string ⇒ challenge.fail', async () => {
    const boom = new Error('token store locked');
    // eslint-disable-next-line require-yield -- an answer that completes without a value
    async function* empty(): AsyncGenerator<string> {
      await Promise.resolve();
    }
    // eslint-disable-next-line require-yield -- an answer that fails before a value
    async function* failing(): AsyncGenerator<string> {
      await Promise.resolve();
      throw boom;
    }
    async function* numbers(): AsyncGenerator<number> {
      yield await Promise.resolve(42);
    }
    const a = setup(() => empty());
    const b = setup(() => failing());
    const c = setup(() => numbers() as unknown as Input<string>);
    for (const h of [a, b, c]) h.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    const completed = failedWith(a.inputs);
    expect(completed).toBeInstanceOf(TypeError);
    expect((completed as Error).message).toBe('onChallenge completed without a value');
    expectFailure(b.inputs, 1, 1, boom);
    expect((failedWith(c.inputs) as Error).message).toBe('onChallenge must answer a string, not number');
  });

  test('cancel while an async function* is pending: return() runs its finally, the signal aborts, nothing is submitted', async () => {
    const log: string[] = [];
    let release!: () => void;
    async function* dialog(challenge: ChallengeMessage): AsyncGenerator<string> {
      challenge.signal.addEventListener('abort', () => log.push('abort'));
      try {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield 'too late';
      } finally {
        log.push('finally');
      }
    }
    const { runner, inputs } = setup((challenge) => dialog(challenge));
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    runner.cancel(new ConnectionLostError({}));
    expect(log).toEqual(['abort']); // return() was queued behind the pending next(): it runs when the generator resumes
    release();
    await flush();
    expect(log).toEqual(['abort', 'finally']);
    expect(inputs).toEqual([]);
  });

  describe('throwing conversions: the conversion error', () => {
    const boom = new Error('hostile input');
    const cases: [string, () => unknown][] = [
      [
        'a then getter that throws',
        () =>
          Object.defineProperty({}, 'then', {
            get() {
              throw boom;
            },
          }),
      ],
      [
        'a then that throws',
        () => ({
          then() {
            throw boom;
          },
        }),
      ],
      [
        'a Symbol.observable method that throws',
        () => ({
          [symbolObservable]() {
            throw boom;
          },
        }),
      ],
      [
        'an interop subscribe that throws',
        () => ({
          [symbolObservable]: () => ({
            subscribe() {
              throw boom;
            },
          }),
        }),
      ],
      [
        'a subscribe() that throws',
        () => ({
          subscribe() {
            throw boom;
          },
        }),
      ],
      [
        'a Proxy whose every trap throws',
        () =>
          new Proxy(
            {},
            {
              get() {
                throw boom;
              },
            },
          ),
      ],
    ];
    test.each(cases)('%s', async (_name, answer) => {
      const { runner, inputs } = setup(answer as () => Input<string>);
      runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
      await flush();
      expectFailure(inputs, 1, 1, boom);
    });

    test('an interop method that returns no subscribable: TypeError', () => {
      const error = failedWith(
        setupAndRun(() => ({ [symbolObservable]: () => undefined }) as unknown as Input<string>),
      );
      expect(error).toBeInstanceOf(TypeError);
    });

    test('a revoked Proxy: the TypeError reading it raises', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      expect(failedWith(setupAndRun(() => proxy as Input<string>))).toBeInstanceOf(TypeError);
    });

    test('firstValue itself throwing (fault injection): that error, nothing left waiting', () => {
      const thrown = new Error('firstValue broke');
      faults.firstValue = () => {
        throw thrown;
      };
      const { runner, inputs } = setup(() => 'sig');
      runner.run(5, 1, { authMethod: 'ticket', extra: EXTRA });
      expectFailure(inputs, 5, 1, thrown);
      runner.cancel(new CanceledError({})); // nothing pending: a no-op
      expect(inputs).toHaveLength(1);
    });
  });

  describe('unsupported method', () => {
    test('no onChallenge (the core normally ABORTs without running): AuthenticationError with the method', () => {
      const { runner, inputs } = setup(undefined);
      runner.run(2, 1, { authMethod: 'wampcra', extra: EXTRA });
      const error = failedWith(inputs);
      expect(isThruwayError(error) && error.code === 'authentication').toBe(true);
      expect((error as AuthenticationError).authMethod).toBe('wampcra');
      expect((error as AuthenticationError).message).toBe('No onChallenge handler answers this CHALLENGE');
    });

    test('ticket() given a wampcra CHALLENGE: its AuthenticationError (thrown synchronously)', () => {
      const error = failedWith(setupAndRun(ticket('u', 't').onChallenge!, 'wampcra'));
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as AuthenticationError).authMethod).toBe('wampcra');
    });

    test('wampcra() given a ticket CHALLENGE: its AuthenticationError (a rejection)', async () => {
      const { runner, inputs } = setup(wampcra('u', 's').onChallenge);
      runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
      await flush();
      const error = failedWith(inputs);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as AuthenticationError).authMethod).toBe('ticket');
    });

    test('wampcra() given a malformed CHALLENGE: its TypeError', async () => {
      const { runner, inputs } = setup(wampcra('u', 's').onChallenge);
      runner.run(1, 1, { authMethod: 'wampcra', extra: Object.freeze({}) });
      await flush();
      expect(failedWith(inputs)).toBeInstanceOf(TypeError);
    });
  });
});

/** Run round (1, 1) for `authMethod` with `onChallenge` and return the inputs submitted synchronously. */
function setupAndRun(
  onChallenge: (challenge: ChallengeMessage) => Input<string>,
  authMethod = 'ticket',
): readonly CoreInput[] {
  const { runner, inputs } = setup(onChallenge);
  runner.run(1, 1, { authMethod, extra: EXTRA });
  return inputs;
}

// ================================================================================================ one input per round

describe('exactly one input per round', () => {
  const scripts: [string, (m: Manual) => void, CoreInput | undefined][] = [
    [
      'two values',
      (m) => {
        m.next('a');
        m.next('b');
      },
      ok(1, 1, 'a'),
    ],
    [
      'a value, then an error',
      (m) => {
        m.next('a');
        m.error(new Error('late'));
      },
      ok(1, 1, 'a'),
    ],
    [
      'a value, then complete',
      (m) => {
        m.next('a');
        m.complete();
      },
      ok(1, 1, 'a'),
    ],
    [
      'complete, then a value',
      (m) => {
        m.complete();
        m.next('a');
      },
      undefined,
    ],
  ];
  test.each(scripts)(
    'a hostile Observable sending %s: only the first notification counts',
    (_name, script, expected) => {
      const manual = new Manual([], true);
      const { runner, inputs } = setup(() => manual.input);
      runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
      script(manual);
      expect(inputs).toHaveLength(1);
      if (expected !== undefined) expect(inputs).toEqual([expected]);
      else expect((failedWith(inputs) as Error).message).toBe('onChallenge completed without a value');
      expect(manual.active).toBe(0);
    },
  );

  test('a thenable calling back twice and rejecting: one input', async () => {
    const { runner, inputs } = setup(() =>
      thenable((resolve, reject) => {
        resolve('one');
        resolve('two');
        reject(new Error('three'));
      }),
    );
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    await flush();
    expect(inputs).toEqual([ok(1, 1, 'one')]);
  });

  test('any notification script on a hostile source ⇒ exactly one input, from the first notification (property)', () => {
    const notification = fc.oneof(
      fc.record({ kind: fc.constant('next' as const), value: fc.oneof(fc.string(), fc.integer(), fc.constant(null)) }),
      fc.record({ kind: fc.constant('error' as const), value: fc.string() }),
      fc.record({ kind: fc.constant('complete' as const) }),
    );
    fc.assert(
      fc.property(fc.array(notification, { minLength: 1, maxLength: 8 }), (script) => {
        const manual = new Manual([], true);
        const { runner, inputs } = setup(() => manual.input);
        runner.run(9, 4, { authMethod: 'ticket', extra: EXTRA });
        for (const n of script) {
          if (n.kind === 'next') manual.next(n.value);
          else if (n.kind === 'error') manual.error(n.value);
          else manual.complete();
        }
        expect(inputs).toHaveLength(1);
        const [first] = script;
        const [input] = inputs;
        if (first?.kind === 'next' && typeof first.value === 'string') expect(input).toEqual(ok(9, 4, first.value));
        else if (first?.kind === 'error') expect(input).toEqual(failure(9, 4, first.value));
        else expect(input?.kind).toBe('challenge.fail');
        expect(manual.active).toBe(0);
      }),
      replayParameters(),
    );
  });
});

// ================================================================================================ latest wins

describe('latest wins: a newer round supersedes a pending one', () => {
  test('the first round is unsubscribed, then its signal aborted with CanceledError; its late answer is dropped', () => {
    const log: string[] = [];
    const first = new Manual(log);
    const second = new Manual(log);
    const answers = [first, second];
    const { runner, inputs, messages } = setup((challenge) => {
      onAbort(challenge.signal, log);
      log.push(`onChallenge ${challenge.authMethod}`);
      return answers.shift()!.input;
    });
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new CanceledError({ message: 'superseded' })); // what the core delivers first
    runner.run(1, 2, { authMethod: 'wampcra', extra: EXTRA });
    expect(log).toEqual([
      'onChallenge ticket',
      'subscribe',
      'unsubscribe',
      'abort',
      'onChallenge wampcra',
      'subscribe',
    ]);
    const reason = messages[0]?.signal.reason;
    expect(isThruwayError(reason) && reason.code === 'canceled').toBe(true);
    first.next('late');
    expect(inputs).toEqual([]);
    second.next('sig');
    expect(inputs).toEqual([ok(1, 2, 'sig')]);
    expect(messages[1]?.signal.aborted).toBe(false);
  });

  test('a run that finds a round still pending cancels it itself (CanceledError), before onChallenge runs again', () => {
    const log: string[] = [];
    const first = new Manual(log);
    const { runner, inputs, messages } = setup((challenge) => {
      onAbort(challenge.signal, log);
      log.push('onChallenge');
      return messages.length === 1 ? first.input : 'second';
    });
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.run(1, 2, { authMethod: 'ticket', extra: EXTRA });
    expect(log).toEqual(['onChallenge', 'subscribe', 'unsubscribe', 'abort', 'onChallenge']);
    const reason = messages[0]?.signal.reason;
    expect(reason).toBeInstanceOf(CanceledError);
    expect((reason as Error).message).toBe('A newer CHALLENGE superseded this one');
    first.next('late');
    expect(inputs).toEqual([ok(1, 2, 'second')]);
  });

  test('a late Promise answer of a superseded round is dropped', async () => {
    const resolvers: ((value: string) => void)[] = [];
    const { runner, inputs } = setup(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.run(1, 2, { authMethod: 'ticket', extra: EXTRA });
    resolvers[0]?.('late');
    await flush();
    expect(inputs).toEqual([]);
    resolvers[1]?.('current');
    await flush();
    expect(inputs).toEqual([ok(1, 2, 'current')]);
  });

  test('a new connection: the old round is cancelled by the core, its answer never reaches the new one', () => {
    const answers = [new Manual(), new Manual()];
    const pending = [...answers];
    const { runner, inputs } = setup(() => pending.shift()!.input);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new ConnectionLostError({})); // the socket died
    runner.run(2, 1, { authMethod: 'ticket', extra: EXTRA });
    answers[0]!.next('from connection 1');
    expect(inputs).toEqual([]);
    answers[1]!.next('from connection 2');
    expect(inputs).toEqual([ok(2, 1, 'from connection 2')]);
  });
});

// ================================================================================================ cancel

describe('cancel(reason)', () => {
  test.each([
    ['ConnectionLostError (the socket died; the client retries)', () => new ConnectionLostError({ closeCode: 1006 })],
    ['ConnectionClosedError (close())', () => new ConnectionClosedError({})],
    ['ConnectionClosedError{gaveUp} (give-up)', () => new ConnectionClosedError({ gaveUp: true })],
    ['CanceledError (newer CHALLENGE, WELCOME, reconnect())', () => new CanceledError({ message: 'superseded' })],
  ])('%s: the answer is unsubscribed first, then the signal aborts with that very reason', (_name, make) => {
    const log: string[] = [];
    const manual = new Manual(log);
    const { runner, inputs, messages } = setup((challenge) => {
      challenge.signal.addEventListener('abort', () => {
        log.push('abort');
        manual.next('answered from the abort listener'); // already unsubscribed: never submitted
      });
      return manual.input;
    });
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    const reason = make();
    runner.cancel(reason);
    expect(log).toEqual(['subscribe', 'unsubscribe', 'abort']);
    expect(messages[0]?.signal.aborted).toBe(true);
    expect(messages[0]?.signal.reason).toBe(reason);
    manual.next('late');
    expect(inputs).toEqual([]);
  });

  test('a no-op before any run, after the round was answered or failed, and the second time', () => {
    const { runner, inputs, messages } = setup(() => (messages.length === 1 ? 'sig' : EMPTY));
    runner.cancel(new CanceledError({}));
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new ConnectionLostError({}));
    expect(messages[0]?.signal.aborted).toBe(false); // answered: the handshake was not abandoned by the client
    runner.run(1, 2, { authMethod: 'ticket', extra: EXTRA }); // completes empty ⇒ fail
    runner.cancel(new ConnectionLostError({}));
    expect(messages[1]?.signal.aborted).toBe(false);
    expect(inputs.map((i) => i.kind)).toEqual(['challenge.ok', 'challenge.fail']);

    const manual = new Manual();
    const again = setup(() => manual.input);
    again.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    const first = new ConnectionLostError({});
    again.runner.cancel(first);
    again.runner.cancel(new ConnectionClosedError({}));
    expect(again.messages[0]?.signal.reason).toBe(first);
    expect(manual.unsubscribes).toBe(1);
  });

  test('a fetch-like answer that rejects on abort (recipe 18) submits nothing after cancel', async () => {
    const { runner, inputs } = setup(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('AbortError'));
          });
        }),
    );
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new ConnectionClosedError({}));
    await flush();
    expect(inputs).toEqual([]);
  });

  test.each([
    ['wampcra() waiting for the secret', 'wampcra', (secret: () => Input<string>) => wampcra('peter', secret)],
    ['ticket() waiting for the ticket', 'ticket', (secret: () => Input<string>) => ticket('ticketuser', secret)],
  ])(
    "%s: cancel releases the app's Input, nothing is submitted, no unhandled rejection",
    async (_name, method, helper) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const log: string[] = [];
        const secret = new Manual(log);
        const { runner, inputs, messages, reports } = setup(helper(() => secret.input).onChallenge);
        runner.run(1, 1, { authMethod: method, extra: Object.freeze({ challenge: 'c' }) });
        expect(log).toEqual(['subscribe']); // the helper asked the app for the credential
        const reason = new ConnectionLostError({ closeCode: 1006 });
        runner.cancel(reason);
        expect(log).toEqual(['subscribe', 'unsubscribe']); // a login dialog behind it can close
        expect(messages[0]?.signal.reason).toBe(reason);
        secret.next('L3L1YUE8Txlw');
        await flush();
        await flush();
        expect(inputs).toEqual([]);
        expect(reports).toEqual([]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  test("an answer Observable whose unsubscribe throws: reported to the client's reporter; the signal still aborts", () => {
    const boom = new Error('teardown failed');
    const tokens = {
      [symbolObservable]: () => ({
        subscribe: () => ({
          unsubscribe() {
            throw boom;
          },
        }),
      }),
    } as unknown as Input<string>;
    const { runner, messages, reports } = setup(() => tokens);
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new ConnectionLostError({}));
    expect(messages[0]?.signal.aborted).toBe(true);
    expect(reports).toEqual([[boom, 'unhandled']]);
    // RxJS 7 wraps its teardown's throw in an UnsubscriptionError; it is reported the same way
    const rx = setup(
      () =>
        new Rx7Observable<string>(() => () => {
          throw boom;
        }),
    );
    rx.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    rx.runner.cancel(new ConnectionLostError({}));
    expect(rx.messages[0]?.signal.aborted).toBe(true);
    expect(rx.reports).toHaveLength(1);
    expect((rx.reports[0]?.[0] as { errors?: unknown[] }).errors).toEqual([boom]);
  });

  test('a throwing abort listener on the fallback signal: reported; cancel returns; other listeners run', () => {
    vi.stubGlobal('AbortController', undefined);
    const boom = new Error('listener failed');
    const log: string[] = [];
    const manual = new Manual(log);
    const { runner, reports } = setup((challenge) => {
      challenge.signal.addEventListener('abort', () => {
        throw boom;
      });
      challenge.signal.addEventListener('abort', () => log.push('second listener'));
      return manual.input;
    });
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(() => {
      runner.cancel(new ConnectionLostError({}));
    }).not.toThrow();
    expect(log).toEqual(['subscribe', 'unsubscribe', 'second listener']);
    expect(reports).toEqual([[boom, 'unhandled']]);
  });

  test('each step in its own try/catch (fault injection): a throwing release still aborts; a throwing abort is reported', () => {
    const releaseError = new Error('release threw');
    const abortError = new Error('abort threw');
    faults.firstValue = () => () => {
      throw releaseError;
    };
    faults.abortThrows = { error: abortError };
    const { runner, messages, reports } = setup(() => 'never converted');
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    const reason = new ConnectionLostError({});
    expect(() => {
      runner.cancel(reason);
    }).not.toThrow();
    expect(messages[0]?.signal.reason).toBe(reason);
    expect(reports).toEqual([
      [releaseError, 'unhandled'],
      [abortError, 'unhandled'],
    ]);
  });

  test('without a reporter, the runner reports like the default logger (console.error)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tokens = new Rx7Observable<string>(() => () => {
      throw new Error('teardown failed');
    });
    const runner = new ChallengeRunner({ onChallenge: () => tokens, submit: () => undefined });
    runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    runner.cancel(new ConnectionLostError({}));
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('cancelled while onChallenge runs (re-entrant core): the answer it returns is released at once, nothing submitted', () => {
    const log: string[] = [];
    const manual = new Manual(log);
    const reason = new ConnectionClosedError({});
    const harness = setup(() => {
      harness.runner.cancel(reason);
      return manual.input;
    });
    harness.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(log).toEqual(['subscribe', 'unsubscribe']);
    manual.next('late');
    expect(harness.messages[0]?.signal.reason).toBe(reason);
    expect(harness.inputs).toEqual([]);
    expect(harness.reports).toEqual([]);
  });

  test.each([
    ['a rejected Promise', () => Promise.reject(new Error('dialog closed by the abort'))],
    ['a Promise rejecting later', () => flush().then(() => Promise.reject(new Error('fetch aborted')))],
    ['a Promise resolving later', () => flush().then(() => 'late token')],
  ])(
    'cancelled while onChallenge runs (re-entrant core), then %s: handled, never an unhandled rejection (fatal in Node)',
    async (_name, answer) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const harness = setup(() => {
          harness.runner.cancel(new ConnectionLostError({}));
          return answer();
        });
        harness.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
        await flush();
        await flush();
        expect(unhandled).toEqual([]);
        expect(harness.inputs).toEqual([]);
        expect(harness.reports).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  test('cancelled while the answer subscribes (re-entrant core): it is unsubscribed as soon as subscribe returns', () => {
    const log: string[] = [];
    const manual = new Manual(log);
    const harness = setup(() => ({
      subscribe(observer: Observer<string>) {
        const subscription = toObservable(manual.input).subscribe(observer);
        harness.runner.cancel(new ConnectionLostError({}));
        log.push('cancelled');
        return subscription;
      },
    }));
    harness.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
    expect(log).toEqual(['subscribe', 'cancelled', 'unsubscribe']);
    manual.next('late');
    expect(harness.inputs).toEqual([]);
    expect(harness.reports).toEqual([]);
  });

  test.each([
    [
      'a value',
      (observer: Observer<unknown>) => {
        observer.next('sig');
      },
    ],
    [
      'a non-string',
      (observer: Observer<unknown>) => {
        observer.next(7);
      },
    ],
    [
      'an error',
      (observer: Observer<unknown>) => {
        observer.error(new Error('failed'));
      },
    ],
  ])(
    'cancelled, then %s, inside the same subscribe (re-entrant core): the answer of the cancelled round is dropped',
    (_n, emit) => {
      // firstValue defers a synchronous answer until subscribe returns; by then the round is no longer pending.
      const harness = setup(() => ({
        subscribe(observer: Observer<unknown>) {
          harness.runner.cancel(new ConnectionLostError({}));
          emit(observer);
        },
      }));
      harness.runner.run(1, 1, { authMethod: 'ticket', extra: EXTRA });
      expect(harness.inputs).toEqual([]);
      expect(harness.messages[0]?.signal.aborted).toBe(true);
    },
  );

  test('superseded inside its own subscribe, then answering (re-entrant core): dropped; the newer round stays pending', () => {
    const second = new Manual();
    const harness = setup((challenge) =>
      challenge.authMethod === 'second'
        ? second.input
        : {
            subscribe(observer: Observer<unknown>) {
              harness.runner.run(1, 2, { authMethod: 'second', extra: EXTRA });
              observer.next('round 1 answer'); // deferred by firstValue until subscribe returns
            },
          },
    );
    harness.runner.run(1, 1, { authMethod: 'first', extra: EXTRA });
    expect(harness.inputs).toEqual([]);
    expect(second.active).toBe(1);
    second.next('round 2 answer');
    expect(harness.inputs).toEqual([ok(1, 2, 'round 2 answer')]);
  });

  test('a synchronous answer whose submit re-enters run (re-entrant core): the new round stays pending', () => {
    const second = new Manual();
    const harness = setup(
      (challenge) => (challenge.authMethod === 'first' ? 'sig1' : second.input),
      (input) => {
        if (input.kind === 'challenge.ok' && input.round === 1) {
          harness.runner.run(1, 2, { authMethod: 'second', extra: EXTRA });
        }
      },
    );
    harness.runner.run(1, 1, { authMethod: 'first', extra: EXTRA });
    expect(second.active).toBe(1);
    harness.runner.cancel(new CanceledError({}));
    expect(second.active).toBe(0);
    expect(harness.messages[1]?.signal.aborted).toBe(true);
    expect(harness.inputs).toEqual([ok(1, 1, 'sig1')]);
  });
});

// ================================================================================================ with the core

describe('driven by the core', () => {
  test('one method: CHALLENGE ⇒ onChallenge once ⇒ one AUTHENTICATE with its answer', () => {
    const core = new Core(['ticket'], () => 'sig');
    core.attempt();
    core.challenge('ticket');
    expect(core.messages).toHaveLength(1);
    expect(authenticates(core)).toEqual([[1, 1, 'sig']]);
  });

  test('Thruway PHP duplicate CHALLENGEs: the settle window runs onChallenge once, for the latest', () => {
    const core = new Core(['ticket', 'wampcra'], (challenge) => `answer for ${challenge.authMethod}`);
    core.attempt();
    core.batch(
      (c) => {
        c.challenge('ticket');
      },
      (c) => {
        c.challenge('wampcra');
      },
    );
    expect(core.messages).toEqual([]); // held: nothing delivered during the window
    core.settle();
    expect(core.messages.map((m) => m.authMethod)).toEqual(['wampcra']);
    expect(authenticates(core)).toEqual([[1, 2, 'answer for wampcra']]);
  });

  test('a second CHALLENGE while the handler runs: round 1 cancelled (CanceledError), only round 2 is answered', () => {
    const answers = [new Manual(), new Manual()];
    const pending = [...answers];
    const core = new Core(['ticket'], () => pending.shift()!.input);
    core.attempt();
    core.challenge('ticket');
    core.challenge('ticket'); // a duplicate after the window, or a single-method retransmission
    const reason = core.messages[0]?.signal.reason;
    expect(isThruwayError(reason) && reason.code === 'canceled').toBe(true);
    expect(answers[0]!.active).toBe(0);
    answers[0]!.next('round 1 answer');
    expect(core.written).toEqual([]);
    answers[1]!.next('round 2 answer');
    expect(authenticates(core)).toEqual([[1, 2, 'round 2 answer']]);
    expect(core.dropped).toEqual([]);
  });

  test('a synchronous handler answers round 1 before a second CHALLENGE arrives: a new round, answered again', () => {
    const core = new Core(['ticket'], (challenge) => `sig ${String(challenge.extra['challenge'])}`);
    core.attempt();
    core.challenge('ticket');
    core.challenge('ticket'); // multi-round authentication, or Thruway's CHALLENGE after AUTHENTICATE
    expect(authenticates(core)).toEqual([
      [1, 1, 'sig 1.1'],
      [1, 2, 'sig 1.2'],
    ]);
  });

  test('two CHALLENGEs in one batch with one method: round 1 answered synchronously is stale and dropped', () => {
    const core = new Core(['ticket'], (challenge) => `sig ${String(challenge.extra['challenge'])}`);
    core.attempt();
    core.batch(
      (c) => {
        c.challenge('ticket');
      },
      (c) => {
        c.challenge('ticket');
      },
    );
    expect(core.dropped).toEqual([ok(1, 1, 'sig 1.1')]);
    expect(authenticates(core)).toEqual([[1, 2, 'sig 1.2']]);
  });

  const ends: [string, Event, (reason: unknown) => boolean][] = [
    [
      'a socket drop (the client will retry)',
      { type: 'drop', willRetry: true },
      (r) => r instanceof ConnectionLostError,
    ],
    [
      'a socket drop at give-up',
      { type: 'drop', willRetry: false },
      (r) => r instanceof ConnectionClosedError && r.gaveUp && r.cause instanceof ConnectionLostError,
    ],
    [
      'a router ABORT (auth failure)',
      { type: 'abort' },
      (r) => r instanceof ConnectionLostError && r.cause instanceof AbortError,
    ],
    ['close()', { type: 'close' }, (r) => r instanceof ConnectionClosedError && !r.gaveUp],
    ['reconnect()', { type: 'reconnect' }, (r) => r instanceof CanceledError],
    ['a WELCOME while the handler runs', { type: 'welcome' }, (r) => r instanceof CanceledError],
    ['a newer CHALLENGE', { type: 'challenge', offered: 0 }, (r) => r instanceof CanceledError],
  ];
  test.each(ends)('%s: the signal reason is the end kind; the answer released first; nothing late', (_n, end, kind) => {
    const log: string[] = [];
    const first = new Manual(log);
    const core = new Core(['ticket'], (challenge, self) => {
      if (self.messages.length > 1) return new Manual().input;
      challenge.signal.addEventListener('abort', () => log.push('abort'));
      return first.input;
    });
    core.attempt();
    core.challenge('ticket');
    apply(core, end);
    const signal = core.messages[0]!.signal;
    expect(signal.aborted).toBe(true);
    expect(kind(signal.reason)).toBe(true);
    expect(core.cancelReasons).toContain(signal.reason); // the core's own reason object, passed through
    expect(log).toEqual(['subscribe', 'unsubscribe', 'abort']);
    first.next('late answer');
    expect(core.log.filter((e) => e.type === 'submit')).toEqual([]);
    expect(core.written.filter((w) => w.frame[0] === 5)).toEqual([]);
    expect(core.earlyStarts).toEqual([]);
  });

  test('after a drop, the next attempt CHALLENGE calls onChallenge again', () => {
    const core = new Core(['ticket'], (_challenge, self) =>
      self.messages.length === 1 ? new Manual().input : 'second try',
    );
    core.attempt();
    core.challenge('ticket');
    core.drop();
    core.attempt();
    core.challenge('ticket');
    expect(core.messages).toHaveLength(2);
    expect(authenticates(core)).toEqual([[2, 1, 'second try']]);
  });

  test('the answer of connection 1 arriving during connection 2 is never written into it', async () => {
    let answerFirst!: (value: string) => void;
    const core = new Core(['ticket'], (_challenge, self) =>
      self.messages.length === 1
        ? new Promise<string>((resolve) => {
            answerFirst = resolve;
          })
        : 'answer 2',
    );
    core.attempt();
    core.challenge('ticket');
    core.drop();
    core.attempt(); // connection 2: HELLO written, no CHALLENGE yet
    answerFirst('answer 1');
    await flush();
    expect(core.written).toEqual([]);
    core.challenge('ticket');
    expect(core.written).toEqual([{ conn: 2, round: 1, frame: [5, 'answer 2', {}] }]);
  });

  test('a synchronous answer that lands after the end step (same batch) reaches the core only for the ended connection', () => {
    const core = new Core(['ticket'], () => 'sig');
    core.attempt();
    core.batch(
      (c) => {
        c.challenge('ticket');
      },
      (c) => {
        c.drop();
      },
    );
    // run was queued before the end step: it answers, the core is WAITING, the answer is dropped and only starts the
    // next attempt early; the cancel that follows is a no-op.
    expect(core.dropped).toEqual([ok(1, 1, 'sig')]);
    expect(core.earlyStarts).toEqual([1]);
    expect(core.written).toEqual([]);
  });

  test('an onClose observer answers the dialog before the cancel delivery: dropped for the ended connection while WAITING (early start), nothing written', () => {
    const dialog = new Manual();
    const core = new Core(['jwtauth'], () => dialog.input);
    core.onClose = () => {
      dialog.next('jwt');
    };
    core.attempt();
    core.challenge('jwtauth');
    core.drop();
    expect(core.dropped).toEqual([ok(1, 1, 'jwt')]);
    expect(core.earlyStarts).toEqual([1]);
    expect(core.written).toEqual([]);
    expect(core.messages[0]?.signal.aborted).toBe(false); // answered before the cancel ran: the cancel is a no-op
    expect(dialog.active).toBe(0);
  });

  test('close(): the cancel runs before onClose, so an answer pushed by an onClose observer is never submitted', () => {
    const dialog = new Manual();
    const core = new Core(['jwtauth'], () => dialog.input);
    core.onClose = () => {
      dialog.next('jwt');
    };
    core.attempt();
    core.challenge('jwtauth');
    core.close();
    expect(core.log.filter((e) => e.type === 'submit')).toEqual([]);
    expect(core.messages[0]?.signal.reason).toBeInstanceOf(ConnectionClosedError);
    expect(dialog.active).toBe(0);
  });

  test('recipe 17: a login dialog that outlives its socket is shown once and answers the next connection', async () => {
    let dialogs = 0;
    let submitDialog!: (token: string) => void;
    const creds$ = defer(() => {
      dialogs++;
      return new Promise<string>((resolve) => {
        submitDialog = resolve;
      });
    }).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    const core = new Core(['jwtauth'], () => creds$);
    core.attempt();
    core.challenge('jwtauth');
    core.drop(); // nginx closes the silent socket 60 s into the dialog
    expect(core.messages[0]?.signal.reason).toBeInstanceOf(ConnectionLostError); // keep the dialog open
    core.attempt();
    core.challenge('jwtauth');
    expect(dialogs).toBe(1);
    submitDialog('jwt'); // the user submits at 90 s
    await flush();
    expect(authenticates(core)).toEqual([[2, 1, 'jwt']]);
    expect(core.dropped).toEqual([]);
  });
});

// ================================================================================================ model

type Outcome = 'value' | 'twice' | 'nonString' | 'error' | 'complete' | 'valueThenError';
type AppKind = 'manual' | 'hostile' | 'sync' | 'throw' | 'reconnectInside' | 'answerOnClose';
type Event =
  | { readonly type: 'challenge'; readonly offered: number } // authmethods[offered], or a method not offered if < 0
  | { readonly type: 'drop'; readonly willRetry: boolean }
  | { readonly type: 'abort' | 'welcome' | 'close' | 'reconnect' };
type Command =
  | Event
  | { readonly type: 'attempt' }
  | { readonly type: 'settle' }
  | { readonly type: 'answer'; readonly pick: number; readonly outcome: Outcome } // pick -1: the latest answer
  | { readonly type: 'batch'; readonly events: readonly Event[] };

const event = (value: Event, weight: number) => ({ arbitrary: fc.constant(value), weight });
const eventArb: fc.Arbitrary<Event> = fc.oneof(
  event({ type: 'challenge', offered: 0 }, 6),
  event({ type: 'challenge', offered: 1 }, 3),
  event({ type: 'challenge', offered: -1 }, 1), // not offered: ABORT
  event({ type: 'drop', willRetry: true }, 2),
  event({ type: 'drop', willRetry: false }, 1),
  event({ type: 'abort' }, 1),
  event({ type: 'welcome' }, 1),
  event({ type: 'close' }, 1),
  event({ type: 'reconnect' }, 1),
);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { arbitrary: eventArb, weight: 6 },
  { arbitrary: fc.constant<Command>({ type: 'attempt' }), weight: 3 },
  { arbitrary: fc.constant<Command>({ type: 'settle' }), weight: 2 },
  {
    arbitrary: fc.record({
      type: fc.constant('answer' as const),
      // mostly the latest answer (the pending round's, if any), sometimes an older one (a late answer)
      pick: fc.oneof({ arbitrary: fc.constant(-1), weight: 3 }, { arbitrary: fc.nat(), weight: 1 }),
      outcome: fc.constantFrom<Outcome>('value', 'twice', 'nonString', 'error', 'complete', 'valueThenError'),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      type: fc.constant('batch' as const),
      events: fc.array(eventArb, { minLength: 2, maxLength: 3 }),
    }),
    weight: 1,
  },
);

/** What onChallenge does for one call: answer later (manual, or a hostile Observable), answer at once, throw, call
 *  reconnect() before it returns, or answer from the next onClose delivery (before the end's cancel runs, while the
 *  core is WAITING). */
const appKindArb: fc.Arbitrary<AppKind> = fc.oneof(
  { arbitrary: fc.constant<AppKind>('manual'), weight: 4 },
  { arbitrary: fc.constant<AppKind>('hostile'), weight: 2 },
  { arbitrary: fc.constant<AppKind>('sync'), weight: 2 },
  { arbitrary: fc.constant<AppKind>('throw'), weight: 1 },
  { arbitrary: fc.constant<AppKind>('reconnectInside'), weight: 1 },
  { arbitrary: fc.constant<AppKind>('answerOnClose'), weight: 1 },
);

function apply(core: Core, event: Event): void {
  switch (event.type) {
    case 'challenge':
      core.challenge(event.offered < 0 ? 'other' : core.authmethods[event.offered % core.authmethods.length]!);
      return;
    case 'drop':
      core.drop(event.willRetry);
      return;
    case 'abort':
      core.abort();
      return;
    case 'welcome':
      core.welcome();
      return;
    case 'close':
      core.close();
      return;
    case 'reconnect':
      core.reconnect();
      return;
  }
}

/** The runner's specification replayed over the core's log: at most one pending round; a run supersedes it, a cancel
 *  aborts it with the given reason, a submit is its single result. Fails on any other submit. */
function replay(core: Core): { pending: number | undefined; aborted: (ThruwayError | 'superseded' | undefined)[] } {
  const aborted: (ThruwayError | 'superseded' | undefined)[] = core.runs.map(() => undefined);
  let pending: number | undefined;
  for (const event of core.log) {
    if (event.type === 'run') {
      if (pending !== undefined) aborted[pending] = 'superseded';
      pending = event.k;
    } else if (event.type === 'cancel') {
      if (pending !== undefined) aborted[pending] = event.reason;
      pending = undefined;
    } else {
      const { input } = event;
      const { conn, round } = roundOf(input);
      const k = core.runs.findIndex((r) => r.conn === conn && r.round === round);
      expect(k, `a submit only for the pending round: ${JSON.stringify(input)}`).toBe(pending);
      pending = undefined;
    }
  }
  return { pending, aborted };
}

describe('model: random interleavings of CHALLENGEs, answers, drops, ABORTs, WELCOMEs, close() and reconnect()', () => {
  // The time budget scales with FC_NUM_RUNS: about 1.5 ms per run, never below vitest's default 5 s.
  test(
    'one input per round, bound to it; signals and releases as specified; AUTHENTICATE once, with its own answer',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom<readonly string[]>(['ticket'], ['ticket', 'wampcra']),
          fc.array(appKindArb, { minLength: 1, maxLength: 6 }),
          fc.array(commandArb, { minLength: 10, maxLength: 60, size: 'max' }),
          (authmethods, kinds, commands) => {
            const sources: (Manual | undefined)[] = [];
            const core = new Core(authmethods, (_challenge, self) => {
              const k = sources.length;
              const kind = kinds[k % kinds.length]!;
              const manual =
                kind === 'manual' || kind === 'reconnectInside' || kind === 'answerOnClose'
                  ? new Manual()
                  : kind === 'hostile'
                    ? new Manual([], true)
                    : undefined;
              sources.push(manual);
              if (kind === 'sync') return `sig-${String(k)}`;
              if (kind === 'throw') throw new Error(`throw-${String(k)}`);
              if (kind === 'reconnectInside') self.reconnect();
              if (kind === 'answerOnClose') {
                self.onClose = () => {
                  self.onClose = undefined;
                  manual!.next(`sig-${String(k)}`);
                };
              }
              return manual!.input;
            });
            const check = (): void => {
              const { pending, aborted } = replay(core);
              // signals: aborted exactly as specified, with the reason object the core passed
              core.messages.forEach((message, k) => {
                const expected = aborted[k];
                if (expected === undefined) expect(message.signal.aborted).toBe(false);
                else if (expected === 'superseded') expect(message.signal.reason).toBeInstanceOf(CanceledError);
                else expect(message.signal.reason).toBe(expected);
              });
              // releases: only the pending round's answer may still be subscribed
              sources.forEach((manual, k) => {
                if (manual !== undefined) expect(manual.active).toBe(k === pending ? 1 : 0);
              });
              // the runner awaits an answer exactly when the core does, for the core's current round
              expect(pending !== undefined).toBe(core.awaiting);
              if (pending !== undefined)
                expect(core.runs[pending]).toMatchObject({ conn: core.conn, round: core.round });
              // AUTHENTICATE: once per (conn, round), carrying that round's own answer, on its own connection
              const written = authenticates(core);
              expect(new Set(written.map(([c, r]) => `${String(c)}.${String(r)}`)).size).toBe(written.length);
              for (const [conn, round, signature] of written) {
                const k = core.runs.findIndex((r) => r.conn === conn && r.round === round);
                expect(signature).toBe(`sig-${String(k)}`);
              }
              expect(core.reports).toEqual([]);
            };
            for (const command of commands) {
              if (command.type === 'attempt') core.attempt();
              else if (command.type === 'settle') core.settle();
              else if (command.type === 'batch')
                core.batch(
                  ...command.events.map((e) => (c: Core) => {
                    apply(c, e);
                  }),
                );
              else if (command.type === 'answer') {
                const live = sources.flatMap((manual, k) => (manual === undefined ? [] : [{ manual, k }]));
                const target = command.pick < 0 ? live[live.length - 1] : live[command.pick % Math.max(live.length, 1)];
                if (target !== undefined) {
                  const { manual, k } = target;
                  const wasPending = replay(core).pending === k && manual.active === 1;
                  const before = core.log.length;
                  const sig = `sig-${String(k)}`;
                  switch (command.outcome) {
                    case 'value':
                      manual.next(sig);
                      break;
                    case 'twice':
                      manual.next(sig);
                      manual.next(`${sig}-again`);
                      break;
                    case 'nonString':
                      manual.next(k);
                      break;
                    case 'error':
                      manual.error(new Error(sig));
                      break;
                    case 'complete':
                      manual.complete();
                      break;
                    case 'valueThenError':
                      manual.next(sig);
                      manual.error(new Error('after the value'));
                      break;
                  }
                  const submits = core.log.slice(before).filter((e) => e.type === 'submit');
                  expect(submits).toHaveLength(wasPending ? 1 : 0); // a pending round answers at once; others never
                }
              } else {
                // a CHALLENGE needs an attempt: start one first when the client is waiting or closed
                if (command.type === 'challenge' && (core.state === 'WAITING' || core.state === 'CLOSED'))
                  core.attempt();
                apply(core, command);
              }
              check();
            }
          },
        ),
        replayParameters(),
      );
    },
    Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 3),
  );
});
