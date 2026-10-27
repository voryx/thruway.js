/**
 * A fake of the `Effects` / `SessionCtx` contracts (src/core/contracts.ts) for participant, liveness and challenge unit
 * tests, so a participant can be tested without the core. It implements the contracts alone — no core, no transport, no
 * real errors needed — and records everything a participant does:
 *
 * - frames written through `send`/`request`, with the request ids it allocated (sequential, seeded random 53-bit, or a
 *   scripted list), and the writes it refused (`refuseWrites`, `closeGate()`), releasing/rolling back their ids;
 * - serializer and size failures: every frame is serialized (default `JSON.stringify`, so a BigInt or a throwing
 *   `toJSON` fails like the real serializer) and checked against the 16 MiB limit; `failNextWrite`/`failWrites` inject
 *   any error;
 * - deliveries (queued, run on demand with `runDeliveries`), lazy log entries, timers (fire on demand or by
 *   `advance`, with generations; cancelled or cleared timers never fire), `verifyAlive` verdicts (resolve them alive or
 *   dead) and `violation` calls.
 *
 * Plus small builders for what participants consume: op records with recording subscribers, `EndInfo`, the
 * `StopError` of `clientClosed`, and decoded `InboundMessage`s.
 */
import type {
  CallOp,
  CallSnapshot,
  ConnId,
  Effects,
  EndInfo,
  ParticipantName,
  PublishOp,
  PublishSnapshot,
  RecordContext,
  RegisterOp,
  RegisterSnapshot,
  SessionCtx,
  StopError,
  TimerHandle,
  TopicOp,
  TopicSnapshot,
  OpSubscriber,
} from '../../src/core/contracts.js';
import { ConnectionClosedError, ConnectionLostError, WampError, type ThruwayError } from '../../src/errors.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import type {
  Dict,
  InboundAbort,
  InboundChallenge,
  InboundError,
  InboundEvent,
  InboundGoodbye,
  InboundInterrupt,
  InboundInvocation,
  InboundPublished,
  InboundRegistered,
  InboundRegistrationRevoked,
  InboundResult,
  InboundSubscribed,
  InboundSubscriptionRevoked,
  InboundUnregistered,
  InboundUnsubscribed,
  InboundWelcome,
  OutboundFrame,
  PayloadInvalid,
} from '../../src/protocol/messages.js';
import { MAX_FRAME_BYTES } from '../../src/protocol/messages.js';
import type { CloseInfo, EventMessage, LogEntry, RegisteredMessage, ResultMessage, Session } from '../../src/types.js';

// =====================================================================================================================
// Effects
// =====================================================================================================================

export interface FakeEffectsOptions {
  /** Initial monotonic time (default 0). */
  readonly now?: number;
  /** Whether a custom logger is "set": lazy entries are built and recorded (default true). With false, entries are
   *  counted but never built (what the real client does without a logger). */
  readonly customLogger?: boolean;
}

export class FakeEffects implements Effects {
  now: number;
  readonly customLogger: boolean;
  /** Deliveries queued and not yet run (FIFO). */
  readonly pendingDeliveries: (() => void)[] = [];
  /** How many deliveries have run. */
  deliveriesRun = 0;
  /** Throws out of deliveries (the real loop logs them as `unhandled`). */
  readonly deliveryErrors: unknown[] = [];
  /** Built log entries, in order (only with `customLogger`). */
  readonly logs: LogEntry[] = [];
  /** How many entries were requested through `log()`, built or not. */
  logCalls = 0;

  constructor(options: FakeEffectsOptions = {}) {
    this.now = options.now ?? 0;
    this.customLogger = options.customLogger ?? true;
  }

  deliver(fn: () => void): void {
    this.pendingDeliveries.push(fn);
  }

  log(entry: () => LogEntry): void {
    this.logCalls++;
    if (this.customLogger) this.logs.push(entry());
  }

  /**
   * Run queued deliveries FIFO, including ones queued while running, one at a time. Each throw is recorded in
   * `deliveryErrors`; with `rethrow` (default) the first throw of this call is rethrown after the queue drained.
   * Returns how many ran.
   */
  runDeliveries(options: { readonly rethrow?: boolean } = {}): number {
    const errors: unknown[] = [];
    let ran = 0;
    for (let fn = this.pendingDeliveries.shift(); fn !== undefined; fn = this.pendingDeliveries.shift()) {
      ran++;
      this.deliveriesRun++;
      try {
        fn();
      } catch (error) {
        errors.push(error);
        this.deliveryErrors.push(error);
      }
    }
    if ((options.rethrow ?? true) && errors.length > 0) throw errors[0];
    return ran;
  }

  /** Built entries with this `event` name. */
  logged(event: string): LogEntry[] {
    return this.logs.filter((entry) => entry.event === event);
  }
}

export function createFakeEffects(options?: FakeEffectsOptions): FakeEffects {
  return new FakeEffects(options);
}

// =====================================================================================================================
// SessionCtx
// =====================================================================================================================

/** A frame the fake accepted (as sent on the wire). */
export interface WrittenFrame {
  /** Order among all writes of this ctx, from 1. */
  readonly seq: number;
  readonly frame: OutboundFrame;
  readonly via: 'send' | 'request';
  /** The id `request` allocated (undefined for `send`). */
  readonly requestId: number | undefined;
  /** `request`'s `expectsReply` (undefined for `send`). */
  readonly expectsReply: boolean | undefined;
  /** The serialized form (undefined with `serialize: false`). */
  readonly data: string | Uint8Array | undefined;
  readonly at: number;
}

/** A write that returned false / undefined (nothing was sent). */
export interface RefusedWrite {
  readonly frame: OutboundFrame;
  readonly via: 'send' | 'request';
  /** The id that was allocated and released again (request only). */
  readonly releasedId: number | undefined;
  readonly reason: 'gate-closed' | 'refused';
  readonly at: number;
}

/** A write that threw (serializer or size error, or an injected failure); nothing was sent. */
export interface FailedWrite {
  readonly frame: OutboundFrame;
  readonly via: 'send' | 'request';
  readonly releasedId: number | undefined;
  readonly error: unknown;
}

export interface FakeTimer {
  /** Order of arming, from 1 (the generation the core would put into its `timer.op` input). */
  readonly gen: number;
  readonly owner: ParticipantName;
  readonly key: number;
  readonly ms: number;
  readonly deadline: boolean;
  readonly armedAt: number;
  readonly due: number;
  /** `armed` until it fires, is cancelled, or the session ends (`cleared`). */
  state: 'armed' | 'fired' | 'cancelled' | 'cleared';
}

export interface FakeVerdict {
  readonly since: number;
  readonly onTimeout: () => void;
  state: 'pending' | 'alive' | 'dead';
}

export interface FakeViolation {
  readonly message: string;
  readonly frame: unknown;
}

/** Something that handles `timer.op` for an owner (a participant). */
export interface TimerTarget {
  timer(key: number, ctx: SessionCtx): void;
}

export interface FakeCtxOptions extends FakeEffectsOptions {
  readonly connId?: ConnId;
  readonly session?: Partial<Session>;
  /** Request ids: 'sequential' from 1 (default), 'random' 53-bit from a seeded PRNG, or a scripted list (taken in
   *  order; ids still in use are skipped like the real allocator redraws them). */
  readonly ids?: 'sequential' | 'random' | readonly number[];
  /** Seed of the 'random' id stream (default 1). */
  readonly seed?: number;
  /** The ids in flight in this session, which random/scripted allocation must avoid — what the real ctx asks every
   *  participant's `pendingIds()` for, e.g. `() => participant.pendingIds()`. When given, it alone decides, so an
   *  id whose request has finished can be drawn again (as in the real client). Without it, every id this ctx allocated
   *  and did not release counts as in use (ids are never reused). */
  readonly inFlight?: () => Iterable<number>;
  /** How frames are serialized before the size check; `false` skips both. Default `JSON.stringify`. */
  readonly serialize?: ((frame: OutboundFrame) => string | Uint8Array) | false;
  /** Frame size limit in bytes (default the client's 16 MiB). */
  readonly maxFrameBytes?: number;
}

const encoder = new TextEncoder();

function byteLength(data: string | Uint8Array): number {
  return typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
}

/** xorshift128+ seeded with splitmix32 (deterministic, uniform 32-bit draws). */
function prng32(seed: number): () => number {
  let s = seed >>> 0;
  const splitmix = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix() | 1;
  return () => {
    // xorshift128 on four 32-bit words
    const t = a ^ (a << 11);
    a = b;
    b = c;
    c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d;
  };
}

export class FakeSessionCtx extends FakeEffects implements SessionCtx {
  readonly connId: ConnId;
  readonly session: Session;
  /** Accepted writes, in order. */
  readonly written: WrittenFrame[] = [];
  readonly refused: RefusedWrite[] = [];
  readonly failed: FailedWrite[] = [];
  readonly timers: FakeTimer[] = [];
  readonly verdicts: FakeVerdict[] = [];
  readonly violations: FakeViolation[] = [];
  /** Request ids allocated and not released (what this ctx considers in use). */
  readonly allocatedIds = new Set<number>();
  /** false ⇒ every write returns false/undefined (`refused`, reason 'refused'): a transport that refuses writes. */
  refuseWrites = false;

  private gateOpen = true;
  private writeSeq = 0;
  private timerGen = 0;
  private sequential = 0;
  private scriptIndex = 0;
  private readonly idMode: 'sequential' | 'random' | readonly number[];
  private readonly random32: () => number;
  private readonly inFlight: (() => Iterable<number>) | undefined;
  private readonly serializeFrame: ((frame: OutboundFrame) => string | Uint8Array) | false;
  private readonly maxFrameBytes: number;
  private readonly failures: { when: (frame: OutboundFrame) => boolean; error: () => unknown; once: boolean }[] = [];
  private readonly targets = new Map<ParticipantName, TimerTarget>();

  constructor(options: FakeCtxOptions = {}) {
    super(options);
    this.connId = options.connId ?? 1;
    this.session = Object.freeze({
      id: options.session?.id ?? 1,
      realm: options.session?.realm ?? 'realm1',
      details: Object.freeze({ ...(options.session?.details ?? {}) }),
    });
    this.idMode = options.ids ?? 'sequential';
    this.random32 = prng32(options.seed ?? 1);
    this.inFlight = options.inFlight;
    this.serializeFrame = options.serialize ?? ((frame) => JSON.stringify(frame));
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  // ---------------------------------------------------------------------------------------------- SessionCtx

  send(frame: OutboundFrame): boolean {
    return this.write(frame, 'send', undefined, undefined);
  }

  request(build: (requestId: number) => OutboundFrame, expectsReply = true): number | undefined {
    const id = this.allocate();
    let frame: OutboundFrame;
    try {
      frame = build(id);
    } catch (error) {
      this.releaseId(id);
      throw error;
    }
    let sent: boolean;
    try {
      sent = this.write(frame, 'request', id, expectsReply);
    } catch (error) {
      this.releaseId(id);
      throw error;
    }
    if (!sent) {
      this.releaseId(id);
      return undefined;
    }
    return id;
  }

  timer(ms: number, owner: ParticipantName, key: number, deadline = false): TimerHandle {
    const timer: FakeTimer = {
      gen: ++this.timerGen,
      owner,
      key,
      ms,
      deadline,
      armedAt: this.now,
      due: this.now + ms,
      state: 'armed',
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        if (timer.state === 'armed') timer.state = 'cancelled';
      },
    };
  }

  verifyAlive(since: number, onTimeout: () => void): void {
    this.verdicts.push({ since, onTimeout, state: 'pending' });
  }

  violation(message: string, frame: unknown): void {
    this.violations.push({ message, frame });
  }

  // ---------------------------------------------------------------------------------------------- controls

  /** Close the gate (the session is ending): every later write returns false / undefined (reason 'gate-closed'). */
  closeGate(): void {
    this.gateOpen = false;
  }

  get isGateOpen(): boolean {
    return this.gateOpen;
  }

  /** Simulate the end of this ctx's session: gate closed, armed timers cleared, pending verdicts dropped (dead). */
  endSession(): void {
    this.gateOpen = false;
    for (const timer of this.timers) if (timer.state === 'armed') timer.state = 'cleared';
    for (const verdict of this.verdicts) if (verdict.state === 'pending') verdict.state = 'dead';
  }

  /** The next write whose frame matches `when` (default: any) throws `error()` (or `error` itself). */
  failNextWrite(error: unknown, when: (frame: OutboundFrame) => boolean = () => true): void {
    this.failures.push({
      when,
      error: typeof error === 'function' ? (error as () => unknown) : () => error,
      once: true,
    });
  }

  /** Every write whose frame matches `when` throws `error()` (or `error`) until `clearWriteFailures()`. */
  failWrites(error: unknown, when: (frame: OutboundFrame) => boolean = () => true): void {
    this.failures.push({
      when,
      error: typeof error === 'function' ? (error as () => unknown) : () => error,
      once: false,
    });
  }

  clearWriteFailures(): void {
    this.failures.length = 0;
  }

  /** Route `timer.op` firings for `owner` to `target` (normally the participant under test). */
  bindTimers(owner: ParticipantName, target: TimerTarget): void {
    this.targets.set(owner, target);
  }

  /** Armed timers, optionally of one owner, in arming order. */
  armedTimers(owner?: ParticipantName): FakeTimer[] {
    return this.timers.filter((t) => t.state === 'armed' && (owner === undefined || t.owner === owner));
  }

  /**
   * Fire one timer now (whatever its due time) through its bound target, like the core does for a current generation.
   * A timer that is not armed (fired, cancelled, cleared) is dropped like a stale generation: returns false.
   */
  fire(timer: FakeTimer): boolean {
    if (timer.state !== 'armed') return false;
    const target = this.targets.get(timer.owner);
    if (target === undefined) throw new Error(`fake-ctx: no timer target bound for owner '${timer.owner}'`);
    timer.state = 'fired';
    target.timer(timer.key, this);
    return true;
  }

  /** Advance `now` by `ms`, firing every armed timer that becomes due — in (due, arming) order, including timers armed
   *  by those firings — with `now` set to each timer's due time. Returns how many fired. */
  advance(ms: number): number {
    const end = this.now + ms;
    let fired = 0;
    for (;;) {
      const next = this.timers
        .filter((t) => t.state === 'armed' && t.due <= end)
        .sort((x, y) => x.due - y.due || x.gen - y.gen)[0];
      if (next === undefined) break;
      this.now = Math.max(this.now, next.due);
      if (this.fire(next)) fired++;
    }
    this.now = end;
    return fired;
  }

  /** Settle pending verdicts: 'alive' runs their `onTimeout` (FIFO), 'dead' drops them. Returns how many settled. */
  resolveVerdicts(outcome: 'alive' | 'dead' = 'alive'): number {
    const pending = this.verdicts.filter((v) => v.state === 'pending');
    for (const verdict of pending) {
      verdict.state = outcome;
      if (outcome === 'alive') verdict.onTimeout();
    }
    return pending.length;
  }

  /** Written frames, optionally only those of one message type (e.g. `MessageType.CALL`). */
  frames(type?: number): OutboundFrame[] {
    return this.written.filter((w) => type === undefined || w.frame[0] === type).map((w) => w.frame);
  }

  /** The last accepted frame, or undefined. */
  lastFrame(): OutboundFrame | undefined {
    return this.written[this.written.length - 1]?.frame;
  }

  /** Forget recorded writes (keeps ids, timers and verdicts). */
  clearWritten(): void {
    this.written.length = 0;
    this.refused.length = 0;
    this.failed.length = 0;
  }

  // ---------------------------------------------------------------------------------------------- internals

  private write(
    frame: OutboundFrame,
    via: 'send' | 'request',
    requestId: number | undefined,
    expectsReply: boolean | undefined,
  ): boolean {
    if (!this.gateOpen) {
      this.refused.push({ frame, via, releasedId: requestId, reason: 'gate-closed', at: this.now });
      return false;
    }
    let data: string | Uint8Array | undefined;
    try {
      const injected = this.failures.find((f) => f.when(frame));
      if (injected !== undefined) {
        if (injected.once) this.failures.splice(this.failures.indexOf(injected), 1);
        throw injected.error();
      }
      if (this.serializeFrame !== false) {
        data = this.serializeFrame(frame);
        const bytes = byteLength(data);
        if (bytes > this.maxFrameBytes) throw sizeError(bytes, this.maxFrameBytes);
      }
    } catch (error) {
      this.failed.push({ frame, via, releasedId: requestId, error });
      throw error;
    }
    if (this.refuseWrites) {
      this.refused.push({ frame, via, releasedId: requestId, reason: 'refused', at: this.now });
      return false;
    }
    this.written.push({ seq: ++this.writeSeq, frame, via, requestId, expectsReply, data, at: this.now });
    return true;
  }

  private inUse(id: number): boolean {
    if (this.inFlight === undefined) return this.allocatedIds.has(id);
    for (const other of this.inFlight()) if (other === id) return true;
    return false;
  }

  private allocate(): number {
    let id: number;
    const mode = this.idMode;
    if (mode === 'sequential') {
      id = this.sequential = this.sequential >= 2 ** 53 ? 1 : this.sequential + 1;
    } else if (mode === 'random') {
      do {
        const hi = this.random32() >>> 11; // 21 bits
        id = hi * 2 ** 32 + this.random32() + 1; // [1, 2^53]
      } while (this.inUse(id));
    } else {
      do {
        const next = mode[this.scriptIndex++];
        if (next === undefined) throw new Error('fake-ctx: scripted request ids exhausted');
        id = next;
      } while (this.inUse(id));
    }
    this.allocatedIds.add(id);
    return id;
  }

  private releaseId(id: number): void {
    this.allocatedIds.delete(id);
    if (this.idMode === 'sequential' && id === this.sequential) this.sequential--;
  }
}

export function createFakeCtx(options?: FakeCtxOptions): FakeSessionCtx {
  return new FakeSessionCtx(options);
}

// =====================================================================================================================
// Errors
// =====================================================================================================================

/** `new WampError(uri, args, kwargs, details)`. */
export function wampError(
  uri: string,
  args: readonly unknown[] = [],
  kwargs: Readonly<Record<string, unknown>> = {},
  details: Readonly<Record<string, unknown>> = {},
): WampError {
  return new WampError(uri, args, kwargs, details);
}

/** The error the real ctx throws for a frame over the limit. */
export function sizeError(bytes: number, limit: number = MAX_FRAME_BYTES): WampError {
  return wampError(Uri.PAYLOAD_SIZE_EXCEEDED, [bytes, limit]);
}

/** What `JSON.stringify` throws for a BigInt: a serializer error as participants meet it. */
export function serializerError(): TypeError {
  return new TypeError('Do not know how to serialize a BigInt');
}

// =====================================================================================================================
// EndInfo
// =====================================================================================================================

export interface FakeEndInfo extends EndInfo {
  /** Every `inflightError` call's context, in order. */
  readonly calls: { readonly requestId?: number; readonly procedure?: string; readonly topic?: string }[];
}

/** An `EndInfo` for `sessionEnded`. `willRetry` (default true) selects ConnectionLostError vs
 *  ConnectionClosedError{gaveUp: true, cause: Lost}; `error` overrides the builder. */
export function fakeEndInfo(
  options: {
    readonly willRetry?: boolean;
    readonly info?: Partial<CloseInfo>;
    readonly error?: (ctx: { requestId?: number; procedure?: string; topic?: string }) => ThruwayError;
  } = {},
): FakeEndInfo {
  const willRetry = options.willRetry ?? true;
  const info: CloseInfo = Object.freeze({
    initiator: 'connection',
    reason: undefined,
    details: {},
    closeCode: 1006,
    wasClean: false,
    sessionId: 1,
    error: undefined,
    willRetry,
    delay: willRetry ? 1000 : undefined,
    attempt: 1,
    ...options.info,
  });
  const calls: FakeEndInfo['calls'] = [];
  const build =
    options.error ??
    ((ctx: { requestId?: number; procedure?: string; topic?: string }): ThruwayError => {
      const lostInit = {
        message: 'connection lost',
        ...(info.reason === undefined ? {} : { reason: info.reason }),
        ...(info.closeCode === undefined ? {} : { closeCode: info.closeCode }),
        ...(info.sessionId === undefined ? {} : { sessionId: info.sessionId }),
        ...ctx,
      };
      const lost = new ConnectionLostError(lostInit);
      if (info.willRetry) return lost;
      return new ConnectionClosedError({ message: 'connection closed', gaveUp: true, cause: lost, ...ctx });
    });
  return {
    info,
    calls,
    inflightError(ctx) {
      calls.push(ctx);
      return build(ctx);
    },
  };
}

// =====================================================================================================================
// StopError (clientClosed)
// =====================================================================================================================

export interface FakeStopError extends StopError {
  /** Every call's record context, in order. */
  readonly calls: RecordContext[];
}

/** The `StopError` the core hands to `clientClosed`: ConnectionClosedError{gaveUp, cause} with the
 *  record's context, as the real one builds it (close(): `gaveUp` false; give-up: true, with the last error as cause). */
export function fakeStopError(options: { readonly gaveUp?: boolean; readonly cause?: unknown } = {}): FakeStopError {
  const calls: RecordContext[] = [];
  const stopError = (ctx: RecordContext): ThruwayError => {
    calls.push(ctx);
    return new ConnectionClosedError({
      gaveUp: options.gaveUp ?? false,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...ctx,
    });
  };
  return Object.assign(stopError, { calls });
}

// =====================================================================================================================
// Subscribers and op records
// =====================================================================================================================

export type Notification<T> =
  | { readonly kind: 'next'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'complete' };

/** An `OpSubscriber` that records notifications and enforces the grammar (nothing after a terminal call or after
 *  `unsubscribe()`). `values`, `error`, `completed` are shortcuts. */
export class FakeSubscriber<T> implements OpSubscriber<T> {
  readonly notifications: Notification<T>[] = [];
  private done = false;

  get closed(): boolean {
    return this.done;
  }
  next(value: T): void {
    if (!this.done) this.notifications.push({ kind: 'next', value });
  }
  error(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.notifications.push({ kind: 'error', error });
  }
  complete(): void {
    if (this.done) return;
    this.done = true;
    this.notifications.push({ kind: 'complete' });
  }
  /** The app unsubscribed: later notifications are dropped. */
  unsubscribe(): void {
    this.done = true;
  }
  get values(): T[] {
    return this.notifications.flatMap((n) => (n.kind === 'next' ? [n.value] : []));
  }
  get errors(): unknown[] {
    return this.notifications.flatMap((n) => (n.kind === 'error' ? [n.error] : []));
  }
  get completed(): boolean {
    return this.notifications.some((n) => n.kind === 'complete');
  }
}

let fakeSeq = 0;
/** A process-wide increasing seq for op records (tests may pass their own). */
export function nextSeq(): number {
  return ++fakeSeq;
}

/** Stable JSON with sorted keys (a stand-in for payload.ts `canonicalJson` in fake keys). */
function sortedJson(value: Dict): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function fakeCallOp(
  snap: Partial<CallSnapshot> & { readonly procedure: string },
  seq: number = nextSeq(),
): CallOp & { readonly subscriber: FakeSubscriber<ResultMessage> } {
  const options = snap.options ?? {};
  return Object.freeze({
    kind: 'call' as const,
    seq,
    snap: Object.freeze({
      procedure: snap.procedure,
      args: snap.args,
      kwargs: snap.kwargs,
      options,
      progressive: snap.progressive ?? options['receive_progress'] === true,
    }),
    subscriber: new FakeSubscriber<ResultMessage>(),
  });
}

export function fakePublishOp(
  snap: Partial<PublishSnapshot> & { readonly topic: string },
  seq: number = nextSeq(),
): PublishOp & { readonly subscriber: FakeSubscriber<void> } {
  const options = snap.options ?? {};
  return Object.freeze({
    kind: 'publish' as const,
    seq,
    snap: Object.freeze({
      topic: snap.topic,
      args: snap.args,
      kwargs: snap.kwargs,
      options,
      ack: snap.ack ?? options['acknowledge'] === true,
    }),
    subscriber: new FakeSubscriber<void>(),
  });
}

/** A topic op; the default key is `topic + sorted JSON of options`, the group `topic + (match ?? 'exact')`. */
export function fakeTopicOp(
  snap: Partial<TopicSnapshot> & { readonly topic: string },
  seq: number = nextSeq(),
): TopicOp & { readonly subscriber: FakeSubscriber<EventMessage> } {
  const options = snap.options ?? {};
  const match = typeof options['match'] === 'string' ? options['match'] : 'exact';
  return Object.freeze({
    kind: 'topic' as const,
    seq,
    snap: Object.freeze({
      topic: snap.topic,
      options,
      key: snap.key ?? snap.topic + sortedJson(options),
      group: snap.group ?? snap.topic + match,
    }),
    subscriber: new FakeSubscriber<EventMessage>(),
  });
}

/** A register op; the default handler returns `undefined`, the default key is `procedure + sorted JSON of options`. */
export function fakeRegisterOp(
  snap: Partial<RegisterSnapshot> & { readonly procedure: string },
  seq: number = nextSeq(),
): RegisterOp & { readonly subscriber: FakeSubscriber<RegisteredMessage> } {
  const options = snap.options ?? {};
  const handler: RegisterSnapshot['handler'] = snap.handler ?? (() => undefined);
  return Object.freeze({
    kind: 'register' as const,
    seq,
    snap: Object.freeze({
      procedure: snap.procedure,
      options,
      key: snap.key ?? snap.procedure + sortedJson(options),
      handler,
    }),
    subscriber: new FakeSubscriber<RegisteredMessage>(),
  });
}

// =====================================================================================================================
// Decoded inbound messages (what decode() hands to the core, in its normalised forms)
// =====================================================================================================================

const empty: Dict = Object.freeze({});
const none: readonly unknown[] = Object.freeze([]);

export const inbound = {
  welcome: (sessionId: number, details: Dict = empty): InboundWelcome => ({
    type: MessageType.WELCOME,
    sessionId,
    details,
  }),
  abort: (reason: string, details: Dict = empty): InboundAbort => ({ type: MessageType.ABORT, details, reason }),
  challenge: (authMethod: string, extra: Dict = empty): InboundChallenge => ({
    type: MessageType.CHALLENGE,
    authMethod,
    extra,
  }),
  goodbye: (reason: string, details: Dict = empty): InboundGoodbye => ({ type: MessageType.GOODBYE, details, reason }),
  error: (
    requestType: number,
    requestId: number,
    error: string,
    args: readonly unknown[] = none,
    kwargs: Dict = empty,
    details: Dict = empty,
  ): InboundError => ({ type: MessageType.ERROR, requestType, requestId, details, error, args, kwargs }),
  published: (requestId: number, publicationId: number): InboundPublished => ({
    type: MessageType.PUBLISHED,
    requestId,
    publicationId,
  }),
  subscribed: (requestId: number, subscriptionId: number): InboundSubscribed => ({
    type: MessageType.SUBSCRIBED,
    requestId,
    subscriptionId,
  }),
  unsubscribed: (requestId: number): InboundUnsubscribed => ({
    type: MessageType.UNSUBSCRIBED,
    revocation: false,
    requestId,
  }),
  subscriptionRevoked: (subscriptionId: number, reason?: string): InboundSubscriptionRevoked => ({
    type: MessageType.UNSUBSCRIBED,
    revocation: true,
    requestId: 0,
    subscriptionId,
    reason,
    details: reason === undefined ? { subscription: subscriptionId } : { subscription: subscriptionId, reason },
  }),
  event: (
    subscriptionId: number,
    publicationId: number,
    args: readonly unknown[] = none,
    kwargs: Dict = empty,
    details: Dict = empty,
  ): InboundEvent => ({ type: MessageType.EVENT, subscriptionId, publicationId, details, args, kwargs }),
  result: (
    requestId: number,
    args: readonly unknown[] = none,
    kwargs: Dict = empty,
    details: Dict = empty,
  ): InboundResult => ({
    type: MessageType.RESULT,
    requestId,
    details,
    args,
    kwargs,
  }),
  registered: (requestId: number, registrationId: number): InboundRegistered => ({
    type: MessageType.REGISTERED,
    requestId,
    registrationId,
  }),
  unregistered: (requestId: number): InboundUnregistered => ({
    type: MessageType.UNREGISTERED,
    revocation: false,
    requestId,
  }),
  registrationRevoked: (registrationId: number, reason?: string): InboundRegistrationRevoked => ({
    type: MessageType.UNREGISTERED,
    revocation: true,
    requestId: 0,
    registrationId,
    reason,
    details: reason === undefined ? { registration: registrationId } : { registration: registrationId, reason },
  }),
  invocation: (
    requestId: number,
    registrationId: number,
    args: readonly unknown[] = none,
    kwargs: Dict = empty,
    details: Dict = empty,
  ): InboundInvocation => ({ type: MessageType.INVOCATION, requestId, registrationId, details, args, kwargs }),
  interrupt: (requestId: number, options: Dict = empty): InboundInterrupt => ({
    type: MessageType.INTERRUPT,
    requestId,
    options,
  }),
  /** Mark a payload-bearing message payload-invalid: payload fields become `[]`/`{}`. */
  invalid: <M extends InboundResult | InboundError | InboundEvent | InboundInvocation>(
    message: M,
    reason = 'args is not an array',
    frame = '[…]',
  ): M => {
    const invalid: PayloadInvalid = { reason, frame };
    return { ...message, args: none, kwargs: empty, invalid };
  },
} as const;
