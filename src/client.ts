/**
 * `Client`: validates options (options.ts), constructs the `Core`, creates op/interest Observables whose `subscribe`
 * runs validate.ts in app context (a throw errors that subscription only and submits nothing), exposes the lifecycle
 * streams. 12 members (`progressiveCall` is kept for v2 code).
 *
 * Every method returns a new cold Observable: each subscription snapshots the arguments, creates one immutable op
 * record and submits `op.start`; its teardown (unsubscribe, error, complete) submits `op.stop`, a no-op for a record
 * that has settled. Nothing here throws after construction: argument errors arrive through the Observable.
 *
 * @module
 */
import { Core, type CoreDebugInfo, type FaultsHook } from './core/machine.js';
import type { AnyOp, OpSubscriber } from './core/contracts.js';
import { normalizeOptions } from './options.js';
import type { Observable as KitObservable, Subscriber } from './observable/observable.js';
import type {
  CallOptions,
  ClientOptions,
  CloseInfo,
  EventMessage,
  Input,
  InvocationHandler,
  Observable,
  PublishOptions,
  RegisteredMessage,
  RegisterOptions,
  ResultMessage,
  Session,
  Status,
  TopicOptions,
} from './types.js';
import { snapshotCall, snapshotProgressiveCall, snapshotPublish, snapshotRegister, snapshotTopic } from './validate.js';

/** @internal `client[DEBUG_HOOK]()` returns queue and map sizes. */
export const DEBUG_HOOK: symbol = Symbol.for('thruway.js.debug');
/** @internal `client[FAULTS_HOOK]` injects throws into named internals. */
export const FAULTS_HOOK: symbol = Symbol.for('thruway.js.faults');

/** The core of each client (kept off the instance, so nothing internal is reachable from the app's object). */
const cores = new WeakMap<object, Core>();

/** The core of a Client; a TypeError for any other `this` (`Client.prototype.open.call({})`). */
function coreOf(client: object): Core {
  const core = cores.get(client);
  if (core === undefined) throw new TypeError('not a thruway.js Client');
  return core;
}

export class Client {
  /**
   * @param url   WebSocket URL, or a function called at the start of *every* attempt (e.g. a server override
   *              read from storage per connection). First value of the Input is used.
   * @param realm WAMP realm: a URI under the spec's loose rule, in its exact form (no empty component).
   * Throws TypeError synchronously for invalid options or when no WebSocket implementation is available.
   */
  constructor(url: string | (() => Input<string>), realm: string, options?: ClientOptions) {
    const core = new Core(normalizeOptions(url, realm, options));
    cores.set(this, core);
    if (core.autoOpen) core.submit({ kind: 'open' });
  }

  /** CALL. One CALL per subscription. Emits one ResultMessage and completes; with `receive_progress: true` emits
   *  every progress result and the final one. Unsubscribe before the final result sends
   *  CANCEL {mode:'killnowait'}. Waits for a session if there is none (fails at once if the client is stopped). */
  call<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Observable<ResultMessage<A, K>> {
    return op(coreOf(this), (core, seq, subscriber: OpSubscriber<ResultMessage>) =>
      core.factories.newCallOp(seq, snapshotCall(procedure, args, kwargs, options), subscriber),
    ) as unknown as Observable<ResultMessage<A, K>>;
  }

  /** `call` with `receive_progress: true` (v2 name, kept for v2 code): emits
   *  every progress result and the final one, then completes. `options` is copied, never mutated; `receive_progress` is
   *  always `true` whatever `options` says. Exactly the `call` semantics otherwise (one CALL per subscription,
   *  unsubscribe ⇒ CANCEL). Unlike v2 it never re-sends the CALL on its own (no retry after `wamp.error.canceled`): a
   *  live read feed adds README recipe 1. */
  progressiveCall<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Observable<ResultMessage<A, K>> {
    return op(coreOf(this), (core, seq, subscriber: OpSubscriber<ResultMessage>) =>
      core.factories.newCallOp(seq, snapshotProgressiveCall(procedure, args, kwargs, options), subscriber),
    ) as unknown as Observable<ResultMessage<A, K>>;
  }

  /** REGISTER while subscribed, in every session; emits a RegisteredMessage each time the registration becomes
   *  active. Unsubscribe → UNREGISTER (running invocations get ERROR wamp.error.canceled). */
  register(procedure: string, handler: InvocationHandler, options?: RegisterOptions): Observable<RegisteredMessage> {
    return op(coreOf(this), (core, seq, subscriber: OpSubscriber<RegisteredMessage>) =>
      core.factories.newRegisterOp(seq, snapshotRegister(procedure, handler, options), subscriber),
    );
  }

  /** SUBSCRIBE while subscribed, in every session; emits every EVENT. Never errors or completes because the
   *  connection was lost. Unsubscribe → UNSUBSCRIBE (when the last local subscriber of that topic+options leaves). */
  topic<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    topic: string,
    options?: TopicOptions,
  ): Observable<EventMessage<A, K>> {
    return op(coreOf(this), (core, seq, subscriber: OpSubscriber<EventMessage>) =>
      core.factories.newTopicOp(seq, snapshotTopic(topic, options), subscriber),
    ) as unknown as Observable<EventMessage<A, K>>;
  }

  /** PUBLISH once per subscription. Emits `undefined` and completes when the frame was handed to the socket
   *  (or, with `acknowledge: true`, when PUBLISHED arrived; bound it with Rx timeout()). Waits for a session if there
   *  is none (fails at once if the client is stopped). */
  publish(
    topic: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: PublishOptions,
  ): Observable<void> {
    return op(coreOf(this), (core, seq, subscriber: OpSubscriber<void>) =>
      core.factories.newPublishOp(seq, snapshotPublish(topic, args, kwargs, options), subscriber),
    );
  }

  /** Work toward a working session. CLOSED (never opened, or stopped by close()/give-up): start connecting, retry
   *  counter reset. Backoff wait: start the next attempt now (never within 1 s of the previous attempt's start).
   *  Open: if nothing has arrived for 2 s, check the connection now with a liveness probe, so a socket that died in
   *  the background is replaced within the ping budget (wake-ups, README recipe 10). While connecting: no-op. */
  open(): void {
    coreOf(this).submit({ kind: 'open' });
  }

  /** Replace the connection now, keeping every stream. Open: GOODBYE, then a new attempt at once (in-flight calls and
   *  acknowledged publishes error ConnectionLostError; topics and registrations go dormant and are re-established;
   *  waiting ops stay). Connecting or backoff wait: abandon the attempt and start a fresh one. CLOSED: same as open().
   *  The new handshake calls onChallenge again (re-authentication, README recipe 11). Retry counter reset. */
  reconnect(): void {
    coreOf(this).submit({ kind: 'reconnect' });
  }

  /** Idempotent. Ends the session (GOODBYE), stops reconnecting, fails everything pending with
   *  ConnectionClosedError; work started afterwards fails at once until open()/reconnect(). Resolves when the
   *  connections that existed at this call are closed and their timers cleared. Never rejects. */
  close(): Promise<void> {
    const core = coreOf(this);
    return new Promise<void>((resolve) => {
      core.submit({ kind: 'close', resolve });
    });
  }

  // status / onOpen / onClose return the same Observable instance on every access.
  /** Current status, replayed to every subscriber; never errors or completes. */
  get status(): Observable<Status> {
    return coreOf(this).status;
  }
  /** Current session (replayed if open), then every new session. Never errors or completes. */
  get onOpen(): Observable<Session> {
    return coreOf(this).onOpen;
  }
  /** Every end of an attempt or session, including close() and reconnect(). Not replayed. Never errors or completes. */
  get onClose(): Observable<CloseInfo> {
    return coreOf(this).onClose;
  }
  /** The established session, or undefined. Never a session that has ended. */
  get session(): Session | undefined {
    return coreOf(this).session;
  }
}

// The internal hooks: symbol-keyed, non-enumerable, stripped from the declarations.
Object.defineProperty(Client.prototype, DEBUG_HOOK, {
  value: function debug(this: Client): CoreDebugInfo {
    return coreOf(this).debug();
  },
});
Object.defineProperty(Client.prototype, FAULTS_HOOK, {
  get(this: Client): FaultsHook {
    return coreOf(this).faultsHook;
  },
});

/** A cold Observable for one kind of op: each subscription snapshots its arguments in app context (a throw errors
 *  only that subscription, synchronously, and submits nothing), then starts one op record. */
function op<T>(core: Core, create: (core: Core, seq: number, subscriber: OpSubscriber<T>) => AnyOp): KitObservable<T> {
  return core.observable<T>((subscriber: Subscriber<T>) => {
    let record: AnyOp;
    try {
      record = create(core, core.nextSeq(), subscriber);
    } catch (error) {
      subscriber.error(error);
      return undefined;
    }
    core.submit({ kind: 'op.start', op: record });
    return () => {
      core.submit({ kind: 'op.stop', op: record });
    };
  });
}
