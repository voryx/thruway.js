/**
 * ChallengeRunner: runs `onChallenge` for one CHALLENGE round and reports its answer to the core as
 * `challenge.ok` / `challenge.fail`, bound to that round's `(conn, round)`.
 *
 * - `run` and `cancel` are deliveries: `onChallenge` is app code and runs only here.
 * - One round at a time, the latest wins. The core cancels a pending round before it runs a newer one; a `run`
 *   that finds a round still pending cancels it itself, with a `CanceledError`.
 * - Exactly one input per round, and none once the round was cancelled or superseded. A late answer is dropped here
 *   and never reaches another round or connection. The core also drops inputs whose `(conn, round)` is stale.
 * - Every failure becomes `challenge.fail` with the error as the app produced it: a throw, a rejection, an Observable
 *   error, a conversion throw. The runner makes a `TypeError` for an answer that is not a string or that
 *   completed without a value, and an `AuthenticationError` when there is no `onChallenge`. The core wraps each in
 *   `AuthenticationError{cause}`. The empty string is a valid answer.
 * - `cancel(reason)` first unsubscribes the pending answer (a login dialog or token fetch behind it can stop), then
 *   aborts the round's signal with `reason`. Each step has its own try/catch, so a throwing unsubscribe cannot keep
 *   the signal from aborting. The core picks the reason: ConnectionLostError, ConnectionClosedError or CanceledError.
 * - Every `ChallengeMessage` carries the runner's reporter under the non-enumerable {@link REPORTER} key, so the auth
 *   helpers report what goes wrong in the app's credential Inputs to the client's logger.
 *
 * @module
 */
import { AuthenticationError, CanceledError, type ThruwayError } from '../errors.js';
import type { ChallengeRunner as ChallengeRunnerContract, ChallengeRunnerDeps, ConnId } from '../core/contracts.js';
import { createAbort, type AbortHandle } from '../observable/abort.js';
import { firstValue } from '../observable/input.js';
import { defaultReporter, report, type UnhandledReporter } from '../observable/observable.js';
import type { ChallengeMessage, Input } from '../types.js';

/** The key of the reporter on every `ChallengeMessage` the runner builds (non-enumerable; `Symbol.for`, so the auth
 *  helpers of another copy of the package find it too). Internal: not part of the public `ChallengeMessage` type. */
export const REPORTER: symbol = Symbol.for('thruway.js.reporter');

/** The round whose answer is awaited. */
interface Round {
  readonly abort: AbortHandle;
  /** Unsubscribes the answer. Set when `firstValue` returns; absent while `onChallenge` runs or the answer subscribes. */
  release?: () => void;
}

export class ChallengeRunner implements ChallengeRunnerContract {
  private readonly deps: ChallengeRunnerDeps;
  private readonly reporter: UnhandledReporter;
  /** The round being answered: undefined before the first run and once the round was answered, failed or cancelled. */
  private pending: Round | undefined;

  /**
   * @param reporter where the runner's own unhandled errors go: an answer Observable whose `unsubscribe` throws, or a
   *                 throwing abort listener on the fallback signal. The client passes its logger's reporter.
   */
  constructor(deps: ChallengeRunnerDeps, reporter: UnhandledReporter = defaultReporter) {
    this.deps = deps;
    this.reporter = reporter;
  }

  run(conn: ConnId, round: number, challenge: { authMethod: string; extra: Readonly<Record<string, unknown>> }): void {
    this.cancel(new CanceledError({ message: 'A newer CHALLENGE superseded this one' })); // latest wins
    const current: Round = { abort: createAbort(this.reporter) };
    this.pending = current;
    const answer = (signature: string): void => {
      if (this.take(current)) this.deps.submit({ kind: 'challenge.ok', conn, round, signature });
    };
    const fail = (error: unknown): void => {
      if (this.take(current)) this.deps.submit({ kind: 'challenge.fail', conn, round, error });
    };
    const { authMethod, extra } = challenge;
    const onChallenge = this.deps.onChallenge;
    if (onChallenge === undefined) {
      fail(new AuthenticationError({ message: 'No onChallenge handler answers this CHALLENGE', authMethod }));
      return;
    }
    const message: ChallengeMessage = { authMethod, extra, signal: current.abort.signal };
    Object.defineProperty(message, REPORTER, { value: this.reporter });
    Object.freeze(message);
    let input: Input<string>;
    try {
      input = onChallenge(message);
    } catch (error) {
      fail(error);
      return;
    }
    let release: () => void;
    try {
      release = firstValue<unknown>(
        input,
        (value) => {
          if (typeof value === 'string') answer(value);
          else fail(new TypeError(`onChallenge must answer a string, not ${value === null ? 'null' : typeof value}`));
        },
        fail,
        () => {
          fail(new TypeError('onChallenge completed without a value'));
        },
        this.reporter,
      );
    } catch (error) {
      fail(error); // firstValue never throws; if it did, the attempt would otherwise wait forever
      return;
    }
    // Not pending any more: answered synchronously (released already, a no-op), or cancelled while onChallenge or the
    // answer's subscribe ran (a re-entrant core). Such an answer is still converted, so a rejected Promise is handled
    // (never an unhandled rejection, fatal in Node); take() drops its result.
    if (this.pending === current) current.release = release;
    else release();
  }

  cancel(reason: ThruwayError): void {
    const round = this.pending;
    if (round === undefined) return; // never run, answered, failed or cancelled already
    this.pending = undefined;
    try {
      round.release?.();
    } catch (error) {
      report(this.reporter, error, 'unhandled');
    }
    try {
      round.abort.abort(reason);
    } catch (error) {
      report(this.reporter, error, 'unhandled');
    }
  }

  /** True once, for the pending round: its single result may be submitted. False for a cancelled or superseded round,
   *  whose late answer is dropped. */
  private take(round: Round): boolean {
    if (this.pending !== round) return false;
    this.pending = undefined;
    return true;
  }
}
