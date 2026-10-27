// The harness and the trace recorder (test/helpers/harness.ts, trace.ts), tested with a scripted stand-in for the
// Client: a miniature of the core's event loop over the real WebSocket adapter — inputs processed one at a time, app
// code only in deliveries — that reports steps and deliveries through the CoreTraceSink it receives in the internal
// option, exactly as the real core is expected to. Enough protocol for the harness: HELLO → WELCOME, CALL with CANCEL
// on unsubscribe, router GOODBYE (reply + close), socket loss, close() with GOODBYE and a 2 s lingering timer.
import { timeout as rxTimeout, from, firstValueFrom } from 'rxjs';
import { describe, expect, test } from 'vitest';
import type { CoreInput } from '../../src/core/contracts.js';
import { EventSubject, LatestSubject } from '../../src/observable/subjects.js';
import { Observable } from '../../src/observable/observable.js';
import { openWebSocket, type Transport } from '../../src/transport/websocket.js';
import type { ClientOptions, CloseInfo, Input, LogEntry, ResultMessage, Session, Status } from '../../src/types.js';
import { closeAndSettle, createHarness, INTERNAL_OPTIONS_KEY, useHarness, type HarnessClient } from './harness.js';
import {
  connectionsOf,
  frameTypes,
  framesOn,
  logsOf,
  notificationsOf,
  timersOf,
  TraceRecorder,
  type CoreTraceSink,
} from './trace.js';
import { MSG } from './wamp-peer.js';

const FAULTS = Symbol.for('thruway.js.faults');
const DEBUG = Symbol.for('thruway.js.debug');

interface Bugs {
  /** Add a `message` listener of its own to every socket and never remove it. */
  readonly leakListeners?: boolean;
  /** Leave a timer armed after close(). */
  readonly leakTimer?: boolean;
  /** close() never resolves. */
  readonly hangClose?: boolean;
  /** Write a CALL before WELCOME. */
  readonly callBeforeWelcome?: boolean;
  /** Log an 'internal' entry on open. */
  readonly internal?: boolean;
}

/** The inputs the scripted client handles (the CoreInput kinds it submits, plus two of its own). */
type Input_ =
  | Extract<CoreInput, { readonly kind: 'open' | 'reconnect' | 'close' | 'ws.open' | 'ws.message' | 'ws.closed' }>
  | { readonly kind: 'timer.goodbye'; readonly conn: number; readonly gen: number }
  | { readonly kind: 'call'; readonly id: number; readonly procedure: string }
  | { readonly kind: 'cancel'; readonly id: number };

/** A scripted Client: the core's event loop in miniature. */
class ScriptedClient implements HarnessClient {
  static bugs: Bugs = {};
  private readonly statusSubject = new LatestSubject<Status>({
    hasValue: true,
    value: { state: 'closed', closed: undefined },
  });
  private readonly openSubject = new LatestSubject<Session>({ hasValue: false });
  private readonly closeSubject = new EventSubject<CloseInfo>();
  private readonly inputs: Input_[] = [];
  private readonly deliveries: { readonly id: number; readonly fn: () => void }[] = [];
  private stepping = false;
  private delivering = false;
  private steps = 0;
  private deliveryIds = 0;
  private conn = 0;
  private transport: Transport | undefined;
  private session: Session | undefined;
  private lingering:
    { readonly transport: Transport; readonly timer: unknown; readonly resolve: () => void } | undefined;
  private readonly calls = new Map<number, (value: ResultMessage | Error, done: boolean) => void>();
  private nextCall = 1;
  private readonly trace: CoreTraceSink | undefined;
  private readonly bugs = ScriptedClient.bugs;
  readonly [FAULTS] = { kind: 'scripted faults' };

  constructor(
    private readonly url: string | (() => Input<string>),
    private readonly realm: string,
    private readonly options: ClientOptions = {},
  ) {
    this.trace = ((options as Record<symbol, unknown>)[INTERNAL_OPTIONS_KEY] as { trace?: CoreTraceSink } | undefined)
      ?.trace;
    if (options.autoOpen !== false) this.submit({ kind: 'open' });
  }

  [DEBUG](): Record<string, number> {
    return { inputs: this.inputs.length, deliveries: this.deliveries.length, calls: this.calls.size };
  }

  get status(): Observable<Status> {
    return this.statusSubject.observable;
  }
  get onOpen(): Observable<Session> {
    return this.openSubject.observable;
  }
  get onClose(): Observable<CloseInfo> {
    return this.closeSubject.observable;
  }

  open(): void {
    this.submit({ kind: 'open' });
  }
  reconnect(): void {
    this.submit({ kind: 'reconnect' });
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.submit({ kind: 'close', resolve: this.bugs.hangClose === true ? () => undefined : resolve });
    });
  }

  /** CALL procedure; unsubscribe ⇒ CANCEL killnowait. */
  call(procedure: string): Observable<ResultMessage> {
    return new Observable<ResultMessage>((subscriber) => {
      const id = this.nextCall++;
      this.calls.set(id, (value, done) => {
        if (value instanceof Error) subscriber.error(value);
        else subscriber.next(value);
        if (done) subscriber.complete();
      });
      this.submit({ kind: 'call', id, procedure });
      return () => {
        if (this.calls.delete(id)) this.submit({ kind: 'cancel', id });
      };
    });
  }

  private log(entry: LogEntry): void {
    this.options.logger?.(entry);
  }

  private submit(input: Input_): void {
    this.inputs.push(input);
    if (this.stepping) return;
    for (;;) {
      const next = this.inputs.shift();
      if (next !== undefined) {
        this.stepping = true;
        const id = ++this.steps;
        if (next.kind !== 'call' && next.kind !== 'cancel') this.trace?.stepStart(id, next);
        try {
          this.step(next, id);
        } finally {
          this.trace?.stepEnd(id);
          this.stepping = false;
        }
        continue;
      }
      if (this.delivering) return;
      const d = this.deliveries.shift();
      if (d === undefined) return;
      this.delivering = true;
      this.trace?.deliveryStart(d.id);
      try {
        d.fn();
      } finally {
        this.trace?.deliveryEnd(d.id);
        this.delivering = false;
      }
    }
  }

  private deliver(step: number): (fn: () => void) => void {
    return (fn) => {
      const id = ++this.deliveryIds;
      this.trace?.deliveryQueued(id, step);
      this.deliveries.push({ id, fn });
    };
  }

  private write(frame: readonly unknown[]): void {
    this.transport?.send(JSON.stringify(frame));
  }

  private connect(step: number): void {
    const conn = ++this.conn;
    const url = typeof this.url === 'string' ? this.url : 'memory://unsupported';
    this.statusSubject.emit({ state: 'connecting', attempt: 1 }, this.deliver(step));
    if (this.bugs.internal === true) this.log({ level: 'error', event: 'internal', message: 'scripted bug' });
    const Ctor = this.options.WebSocket!;
    const leaky = function (this: unknown, u: string, p?: string | string[]): unknown {
      const ws = new Ctor(u, p);
      ws.addEventListener('message', () => undefined);
      return ws;
    } as unknown as typeof Ctor;
    Object.assign(leaky, { OPEN: Ctor.OPEN });
    this.transport = openWebSocket(this.bugs.leakListeners === true ? leaky : Ctor, url, ['wamp.2.json'], {
      open: (protocol) => {
        this.submit({ kind: 'ws.open', conn, protocol });
      },
      message: (data) => {
        this.submit({ kind: 'ws.message', conn, data });
      },
      closed: (code, reason, wasClean) => {
        this.submit({ kind: 'ws.closed', conn, code, reason, wasClean });
      },
    });
  }

  private ended(step: number, info: Partial<CloseInfo>, release: boolean): void {
    if (release) this.transport?.close(1000, '');
    this.transport = undefined;
    this.session = undefined;
    this.openSubject.clear();
    const closed: CloseInfo = {
      initiator: 'connection',
      reason: undefined,
      details: {},
      closeCode: undefined,
      wasClean: false,
      sessionId: undefined,
      error: undefined,
      willRetry: false,
      delay: undefined,
      attempt: 1,
      ...info,
    };
    const deliver = this.deliver(step);
    this.statusSubject.emit({ state: 'closed', closed }, deliver);
    this.closeSubject.emit(closed, deliver);
    for (const [id, settle] of this.calls) {
      this.calls.delete(id);
      deliver(() => {
        settle(new Error('connection lost'), false);
      });
    }
  }

  private step(input: Input_, step: number): void {
    switch (input.kind) {
      case 'open':
      case 'reconnect':
        if (this.transport === undefined) this.connect(step);
        return;
      case 'ws.open':
        this.write([MSG.HELLO, this.realm, { roles: { caller: { features: { call_canceling: true } } } }]);
        if (this.bugs.callBeforeWelcome === true) this.write([MSG.CALL, 99, {}, 'com.example.early']);
        return;
      case 'ws.message': {
        if (input.conn !== this.conn) return;
        const frame = JSON.parse(String(input.data)) as unknown[];
        if (frame[0] === MSG.WELCOME) {
          const session: Session = {
            id: frame[1] as number,
            realm: this.realm,
            details: frame[2] as Session['details'],
          };
          this.session = session;
          const deliver = this.deliver(step);
          this.statusSubject.emit({ state: 'open', session }, deliver);
          this.openSubject.emit(session, deliver);
        } else if (frame[0] === MSG.GOODBYE) {
          this.write([MSG.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
          this.ended(
            step,
            { initiator: 'router', reason: frame[2] as string, details: frame[1] as Record<string, unknown> },
            true,
          );
        } else if (frame[0] === MSG.RESULT || frame[0] === MSG.ERROR) {
          const id = (frame[0] === MSG.RESULT ? frame[1] : frame[2]) as number;
          const settle = this.calls.get(id);
          if (settle === undefined) return;
          this.calls.delete(id);
          const value: ResultMessage | Error =
            frame[0] === MSG.RESULT
              ? { args: (frame[3] ?? []) as unknown[], kwargs: {}, details: {} }
              : new Error(String(frame[4]));
          this.deliver(step)(() => {
            settle(value, true);
          });
        }
        return;
      }
      case 'ws.closed':
        if (input.conn === this.conn && this.transport !== undefined)
          this.ended(step, { closeCode: input.code }, false);
        if (this.lingering !== undefined) this.finishLingering();
        return;
      case 'call':
        if (this.session !== undefined) this.write([MSG.CALL, input.id, {}, input.procedure]);
        return;
      case 'cancel':
        if (this.session !== undefined) this.write([MSG.CANCEL, input.id, { mode: 'killnowait' }]);
        return;
      case 'close': {
        const transport = this.transport;
        if (this.session !== undefined && transport !== undefined) {
          this.write([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
          this.transport = undefined;
          this.ended(step, { initiator: 'app', reason: 'wamp.close.close_realm', attempt: 0 }, false);
          const timer = this.options.clock!.setTimeout(() => {
            this.submit({ kind: 'timer.goodbye', conn: this.conn, gen: 1 });
          }, 2000);
          this.lingering = { transport, timer, resolve: input.resolve };
          // the router's GOODBYE reply arrives as a message for a connection that is no longer current: handled below
          this.conn = -this.conn;
        } else {
          input.resolve();
        }
        if (this.bugs.leakTimer === true) this.options.clock!.setTimeout(() => undefined, 999999);
        return;
      }
      case 'timer.goodbye':
        if (this.lingering !== undefined) this.finishLingering();
        return;
    }
  }

  private finishLingering(): void {
    const l = this.lingering!;
    this.lingering = undefined;
    this.options.clock!.clearTimeout(l.timer);
    l.transport.close(1000, '');
    l.resolve();
  }
}

/** A client class with given bugs (one per test: the harness constructs it). */
function buggy(bugs: Bugs): typeof ScriptedClient {
  return class extends ScriptedClient {
    constructor(url: string | (() => Input<string>), realm: string, options?: ClientOptions) {
      ScriptedClient.bugs = bugs;
      super(url, realm, options);
      ScriptedClient.bugs = {};
    }
  };
}

describe('makeClient wiring', () => {
  const h = useHarness({ seed: 42 });

  test('owner-tagged WebSocket, the client scope, the logger chain and the trace sink in the internal option', async () => {
    const own: LogEntry[] = [];
    let seen: ClientOptions | undefined;
    class Spy extends ScriptedClient {
      constructor(url: string | (() => Input<string>), realm: string, options?: ClientOptions) {
        super(url, realm, options);
        seen = options;
      }
    }
    const c = h.current.makeClient(Spy, {
      options: { logger: (e) => own.push(e), [INTERNAL_OPTIONS_KEY]: { ping: 5 } },
    });
    expect(c.index).toBe(1);
    expect(c.scope.name).toBe('client');
    expect(seen?.clock).toBe(c.scope);
    expect(seen?.WebSocket).toBe(c.WebSocket);
    expect((seen as Record<symbol, unknown>)[INTERNAL_OPTIONS_KEY]).toEqual({ ping: 5, trace: c.recorder.sink });
    seen?.logger?.({ level: 'info', event: 'x', message: 'chained' });
    expect(own.map((e) => e.message)).toEqual(['chained']);
    expect(c.trace().logs.map((l) => l.entry.message)).toEqual(['chained']);
    await h.current.clock.runUntilIdle();
    expect(c.connections.map((x) => x.owner)).toEqual([1]);
    expect(c.connection.number).toBe(1);
    expect(h.current.router.connections[0]!.phase).toBe('established');
    expect(c.faults).toEqual({ kind: 'scripted faults' });
    expect(c.debug()).toEqual({ inputs: 0, deliveries: 0, calls: 0 });
  });

  test('the test may replace WebSocket and clock; url and realm default to the router and realm1', () => {
    const other = h.current.clock.scope('elsewhere');
    let seen: [unknown, unknown, ClientOptions | undefined] | undefined;
    class Spy extends ScriptedClient {
      constructor(url: string | (() => Input<string>), realm: string, options?: ClientOptions) {
        super(url, realm, { ...options, autoOpen: false });
        seen = [url, realm, options];
      }
    }
    const c = h.current.makeClient(Spy, { options: { clock: other }, lifecycle: false });
    expect(seen?.[0]).toBe(h.current.router.url);
    expect(seen?.[1]).toBe('realm1');
    expect(seen?.[2]?.clock).toBe(other);
    expect([c.status, c.onOpen, c.onClose]).toEqual([undefined, undefined, undefined]);
    expect(() => c.connection).toThrow('client 1 has no connection yet');
    expect(c.debug()).toEqual({ inputs: 0, deliveries: 0, calls: 0 });
  });

  test('a client without the debug hook: debug() is undefined; scopes and owners count up per client', async () => {
    class Plain extends ScriptedClient {}
    Object.defineProperty(Plain.prototype, DEBUG, { value: undefined });
    const a = h.current.makeClient(ScriptedClient);
    const b = h.current.makeClient(Plain, { realm: 'realm2' });
    const c = h.current.makeClient(ScriptedClient, { scope: 'named' });
    expect([a.scope.name, b.scope.name, c.scope.name]).toEqual(['client', 'client-2', 'named']);
    expect(b.debug()).toBeUndefined();
    await h.current.clock.runUntilIdle();
    expect(h.current.router.sessions.map((s) => s.realm)).toEqual(['realm1', 'realm1', 'realm2']); // grouped by realm
    expect([a, b, c].map((x) => x.connections.map((k) => k.owner))).toEqual([[1], [2], [3]]);
    expect(h.current.clients).toEqual([a, b, c]);
  });
});

describe('the trace', () => {
  const h = useHarness({ seed: 7 });

  test('frames per connection with the steps that wrote and processed them; inputs; deliveries', async () => {
    const c = h.current.makeClient(ScriptedClient);
    await h.current.clock.runUntilIdle();
    const t = c.trace();
    expect(t.source).toBe('sim');
    expect(t.seed).toBe(7);
    expect(connectionsOf(t)).toEqual([1]);
    expect(frameTypes(t, 1)).toEqual([MSG.HELLO, MSG.WELCOME]);
    expect(t.inputs.map((i) => [i.stepId, i.input, i.conn])).toEqual([
      [1, 'open', undefined],
      [2, 'ws.open', 1],
      [3, 'ws.message', 1],
    ]);
    const [hello, welcome] = framesOn(t, 1);
    expect([hello!.direction, hello!.stepId]).toEqual(['in', 2]); // written by the ws.open step
    expect([welcome!.direction, welcome!.stepId]).toEqual(['out', 3]); // processed by the ws.message step
    // step 1 emitted `connecting` before the harness subscribed the lifecycle streams (autoOpen in the constructor):
    // nobody to deliver to. The WELCOME step queues `status` and `onOpen`.
    expect(t.deliveries.map((d) => [d.deliveryId, d.stepId, d.phase])).toEqual([
      [1, 3, 'queued'],
      [2, 3, 'queued'],
      [1, 3, 'ran'],
      [2, 3, 'ran'],
    ]);
    // the global order is one sequence; every event has a time
    expect(t.events.map((e) => e.seq)).toEqual([...t.events.keys()].map((i) => t.events[0]!.seq + i));
    expect(t.frames).toEqual(t.events.filter((e) => e.kind === 'frame'));
  });

  test('a raw frame whose text is not JSON.stringify of its decoded form still gets the step that processed it', async () => {
    const c = h.current.makeClient(ScriptedClient);
    await h.current.clock.runUntilIdle();
    const raw = ['[36, 1, 2, {}]', '[36,1.0,2,{"a":"\\u00e9"}]', '[36,1,2,{}]'];
    for (const text of raw) h.current.router.sendRaw(text);
    await h.current.clock.runUntilIdle();
    const t = c.trace();
    const steps = t.inputs.filter((i) => i.input === 'ws.message').map((i) => i.stepId);
    expect(framesOn(t, 1, 'out').map((f) => [f.frame, f.stepId])).toEqual([
      [[MSG.WELCOME, expect.any(Number), expect.any(Object)], steps[0]],
      [[36, 1, 2, {}], steps[1]],
      [[36, 1, 2, { a: 'é' }], steps[2]],
      [[36, 1, 2, {}], steps[3]],
    ]);
    expect(steps).toEqual([3, 4, 5, 6]);
  });

  test('lifecycle notifications: the replay inside subscribe has no step, later ones carry their step; CloseInfos recorded', async () => {
    const c = h.current.makeClient(ScriptedClient);
    await h.current.clock.runUntilIdle();
    h.current.router.goodbye('wamp.close.killed');
    await h.current.clock.runUntilIdle();
    const t = c.trace();
    const status = notificationsOf(t, c.status!.id);
    expect(status.map((n) => [(n.value as Status).state, n.stepId])).toEqual([
      ['connecting', undefined], // the replay inside subscribe (app context): the constructor had opened already
      ['open', 3],
      ['closed', 4],
    ]);
    expect(c.status!.values.map((s) => s.state)).toEqual(['connecting', 'open', 'closed']);
    expect(c.onOpen!.values).toHaveLength(1);
    expect(t.closeInfos.map((e) => [e.info.initiator, e.info.reason, e.stepId])).toEqual([
      ['router', 'wamp.close.killed', 4],
    ]);
    expect(c.onClose!.values).toEqual([t.closeInfos[0]!.info]);
    expect(t.observers.map((o) => [o.stream, o.action])).toEqual([
      ['status', 'subscribe'],
      ['onOpen', 'subscribe'],
      ['onClose', 'subscribe'],
    ]);
    // the GOODBYE reply was written by the step that processed the router's GOODBYE
    expect(framesOn(t, 1).map((f) => [(f.frame as unknown[])[0], f.direction, f.stepId])).toEqual([
      [MSG.HELLO, 'in', 2],
      [MSG.WELCOME, 'out', 3],
      [MSG.GOODBYE, 'out', 4],
      [MSG.GOODBYE, 'in', 4],
    ]);
  });

  test('observe(): values, error, completion, forwarding, unsubscribe recorded once; uri kept', async () => {
    const c = h.current.makeClient(ScriptedClient);
    h.current.router.procedure('com.example.add', () => 3);
    h.current.router.procedure('com.example.fail', () => {
      throw new Error('nope');
    });
    h.current.router.procedure('com.example.never', () => new Promise(() => undefined));
    await h.current.clock.runUntilIdle();
    const forwarded: string[] = [];
    const ok = c.observe('call', 'com.example.add', c.client.call('com.example.add'), {
      next: () => forwarded.push('next'),
      complete: () => forwarded.push('complete'),
    });
    const failed = c.observe('call', 'com.example.fail', c.client.call('com.example.fail'), {
      error: () => forwarded.push('error'),
    });
    const pending = c.observe('call', 'com.example.never', c.client.call('com.example.never'));
    await h.current.clock.runUntilIdle();
    pending.unsubscribe();
    pending.unsubscribe();
    await h.current.clock.runUntilIdle();
    expect([ok.values.map((v) => v.args as unknown[]), ok.completed, ok.errored, ok.closed]).toEqual([
      [[3]],
      true,
      false,
      true,
    ]);
    expect([failed.errored, String(failed.error), failed.closed]).toEqual([
      true,
      'Error: wamp.error.runtime_error',
      true,
    ]);
    expect([pending.closed, pending.values]).toEqual([true, []]);
    expect(forwarded).toEqual(['next', 'complete', 'error']);
    const t = c.trace();
    expect(notificationsOf(t, ok.id).map((n) => [n.stream, n.uri, n.notification])).toEqual([
      ['call', 'com.example.add', 'next'],
      ['call', 'com.example.add', 'complete'],
    ]);
    expect(notificationsOf(t, ok.id).every((n) => typeof n.stepId === 'number')).toBe(true);
    expect(t.observers.filter((o) => o.observer === pending.id).map((o) => o.action)).toEqual([
      'subscribe',
      'unsubscribe',
    ]);
    // the unsubscribe wrote a CANCEL (killnowait) in the step that processed it
    expect(frameTypes(t, 1, 'in')).toEqual([MSG.HELLO, MSG.CALL, MSG.CALL, MSG.CALL, MSG.CANCEL]);
  });

  test('api calls are recorded, close() with its resolution; timers per scope with arm/cancel/fire', async () => {
    const c = h.current.makeClient(ScriptedClient);
    await h.current.clock.runUntilIdle();
    c.open(); // already connected: nothing happens
    c.reconnect();
    await c.settle();
    const t = c.trace();
    expect(t.api.map((a) => [a.call, a.resolved])).toEqual([
      ['open', false],
      ['reconnect', false],
      ['close', false],
      ['close', true],
    ]);
    // close() armed the 2 s lingering timer in the client scope; the router's reply cancelled it
    expect(timersOf(t, 'client').map((e) => [e.action, e.delay])).toEqual([
      ['arm', 2000],
      ['cancel', undefined],
    ]);
    expect(timersOf(t, 'router')).toEqual([]);
    expect(logsOf(t, 'anything')).toEqual([]);
  });

  test('Rx timeout() on a call that never settles ⇒ CANCEL, the router answers canceled (what the testing kit promises apps)', async () => {
    const c = h.current.makeClient(ScriptedClient);
    h.current.router.procedure('com.example.never', () => new Promise(() => undefined));
    await h.current.clock.runUntilIdle();
    const result = firstValueFrom(from(c.client.call('com.example.never')).pipe(rxTimeout({ first: 5 })));
    const caught = result.catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20)); // RxJS's timeout runs on the real clock
    expect(String(await caught)).toMatch(/Timeout/);
    await h.current.clock.runUntilIdle();
    const types = h.current.router.frames.map((f) => [
      f.direction,
      (f.frame as unknown[])[0],
      (f.frame as unknown[])[4],
    ]);
    expect(types.slice(-3)).toEqual([
      ['in', MSG.CALL, undefined],
      ['in', MSG.CANCEL, undefined],
      ['out', MSG.ERROR, 'wamp.error.canceled'],
    ]);
  });

  test('two clients: separate traces and connections, one shared global order', async () => {
    const a = h.current.makeClient(ScriptedClient);
    const b = h.current.makeClient(ScriptedClient);
    await h.current.clock.runUntilIdle();
    expect([connectionsOf(a.trace()), connectionsOf(b.trace())]).toEqual([[1], [2]]);
    const seqs = [...a.trace().events, ...b.trace().events].map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('closeAndSettle and the harness checks', () => {
  test('a clean run has no problems; finish() passes', async () => {
    const h = createHarness();
    h.makeClient(ScriptedClient);
    await h.clock.runUntilIdle();
    await h.closeAndSettle();
    expect(h.problems()).toEqual([]);
    await h.finish();
    expect(h.seed).toBe(1);
  });

  test('every kind of problem is reported, and finish() throws them with the seed', async () => {
    const h = createHarness({ seed: 99 });
    const c = h.makeClient(buggy({ leakListeners: true, leakTimer: true, callBeforeWelcome: true, internal: true }));
    h.router.procedure('com.example.early', () => 1);
    h.clock.observe((e) => {
      if (e.action === 'arm' && e.delay === 999999) throw new Error('observer bug');
    });
    await h.clock.runUntilIdle();
    c.client.call('com.example.unscripted').subscribe({ error: () => undefined });
    await h.clock.runUntilIdle();
    await h.closeAndSettle();
    const problems = h.problems();
    expect(problems).toEqual([
      "client 1: 1 timer(s) still armed in scope 'client'",
      'client 1: socket 1 still has 1 listener(s) {"open":0,"message":1,"error":0,"close":0}',
      'client 1: internal error logged: scripted bug',
      'router violation on socket 1: CALL before WELCOME [48,99,{},"com.example.early"]',
      'unscripted traffic on socket 1: [48,1,{},"com.example.unscripted"]',
      'clock observer error: observer bug',
    ]);
    await expect(h.finish()).rejects.toThrow(/^seed 99: the run is not clean:\n {2}client 1: 1 timer/);
  });

  test('router errors are reported (a client listener that throws)', async () => {
    const h = createHarness();
    const c = h.makeClient(ScriptedClient);
    await h.clock.runUntilIdle();
    c.connection.socket.addEventListener('message', () => {
      throw new Error('listener bug');
    });
    h.router.sendRaw('[36,1,1,{}]');
    await h.clock.runUntilIdle();
    await h.closeAndSettle();
    // the test's own listener is still on the socket, and it threw for the raw frame and for the GOODBYE reply
    expect(h.problems()).toEqual([
      'client 1: socket 1 still has 1 listener(s) {"open":0,"message":1,"error":0,"close":0}',
      expect.stringMatching(/^router error: Error: listener bug/),
      expect.stringMatching(/^router error: Error: listener bug/),
    ]);
  });

  test('checks can be switched off', async () => {
    const h = createHarness({
      checks: { unscripted: false, violations: false, routerErrors: false, internalLogs: false },
      router: { strict: true },
    });
    const c = h.makeClient(buggy({ callBeforeWelcome: true, internal: true }));
    h.router.procedure('com.example.early', () => 1);
    await h.clock.runUntilIdle();
    c.client.call('com.example.unscripted').subscribe({ error: () => undefined });
    const throwing = (): void => {
      throw new Error('ignored');
    };
    c.connection.socket.addEventListener('message', throwing);
    await h.clock.runUntilIdle();
    c.connection.socket.removeEventListener('message', throwing); // listener counts cannot be switched off
    await h.finish();
    expect([h.router.violations.length, h.router.unscripted.length, h.router.errors.length]).toEqual([1, 1, 1]);
  });

  test('problem texts: non-Error throws, raw and long frames are shown readably', async () => {
    const h = createHarness({ checks: { unscripted: false } });
    const c = h.makeClient(ScriptedClient);
    await h.clock.runUntilIdle();
    let thrown = false;
    h.clock.observe(() => {
      if (thrown) return;
      thrown = true;
      throw 'plain string'; // eslint-disable-line @typescript-eslint/only-throw-error -- a non-Error throw on purpose
    });
    h.clock.setTimeout(() => undefined, 1);
    const socket = c.connection.socket;
    const listener = (): void => {
      throw 42; // eslint-disable-line @typescript-eslint/only-throw-error -- a non-Error throw on purpose
    };
    socket.addEventListener('message', listener);
    h.router.sendRaw('[36,1,1,{}]');
    await h.clock.runUntilIdle();
    socket.removeEventListener('message', listener);
    socket.send('not a frame');
    socket.send(JSON.stringify([MSG.HELLO, 'x'.repeat(300), {}]));
    await h.clock.runUntilIdle();
    await h.closeAndSettle();
    expect(h.problems()).toEqual([
      'router violation on socket 1: the frame is not a JSON array not a frame',
      `router violation on socket 1: a second HELLO [1,"${'x'.repeat(196)}…`,
      'router error: 42',
      'clock observer error: plain string',
    ]);
  });

  test('a close() that never resolves fails closeAndSettle with the client index (instead of hanging)', async () => {
    const h = createHarness({ seed: 5 });
    h.makeClient(ScriptedClient);
    h.makeClient(buggy({ hangClose: true }));
    await h.clock.runUntilIdle();
    await expect(h.closeAndSettle()).rejects.toThrow(
      'seed 5: close() of client 2 did not resolve once the clock was idle',
    );
  });

  test('settle() of one client leaves the others alone; a lingering timeout closes against a frozen router', async () => {
    const h = createHarness({ start: 1000, tieOrder: 'timers-first' });
    const a = h.makeClient(ScriptedClient);
    const b = h.makeClient(ScriptedClient);
    await h.clock.runUntilIdle();
    a.connection.controls.freeze('drop'); // the GOODBYE reply never comes: the 2 s timer ends the wait
    await a.settle();
    expect(h.clock.now()).toBe(3000);
    expect(b.connection.phase).toBe('established');
    expect(timersOf(a.trace(), 'client').map((e) => e.action)).toEqual(['arm', 'fire']);
    await h.finish();
  });

  test('the sim router is strict: an unscripted CALL is a problem by default', async () => {
    const h = createHarness();
    const c = h.makeClient(ScriptedClient);
    await h.clock.runUntilIdle();
    c.client.call('com.example.nobody').subscribe({ error: () => undefined });
    await h.clock.runUntilIdle();
    await expect(h.finish()).rejects.toThrow('unscripted traffic on socket 1: [48,1,{},"com.example.nobody"]');
  });
});

describe('closeAndSettle (standalone)', () => {
  test('close(), the clock until idle, the close promise; a close that never resolves throws', async () => {
    const h = createHarness();
    const ok = h.makeClient(ScriptedClient);
    const stuck = h.makeClient(buggy({ hangClose: true }));
    await h.clock.runUntilIdle();
    await closeAndSettle(ok.client, h.clock);
    expect(ok.connection.state).toBe('closed');
    await expect(closeAndSettle(stuck.client, h.clock)).rejects.toThrow(
      'close() did not resolve once the clock was idle',
    );
  });
});

describe('useHarness', () => {
  // useHarness registers hooks for the tests of its describe block; while collecting there is no harness.
  const h = useHarness();
  let failure: unknown;
  const read = (): unknown => h.current;
  try {
    read();
  } catch (error) {
    failure = error;
  }

  test('current is only available inside a test', () => {
    expect(String(failure)).toBe('Error: useHarness: only available inside a test');
    expect(h.current.router.url).toMatch(/^memory:/);
  });
});

describe('TraceRecorder on its own', () => {
  test('without a sequence it numbers its own events; a received frame nobody processes keeps no step', () => {
    let now = 0;
    const r = new TraceRecorder({ now: () => now, source: 'real-router' });
    r.frame({ connection: 1, direction: 'out', frame: 'raw text', at: 5 });
    now = 9;
    r.sink.stepStart(1, { kind: 'ws.message', conn: 1, data: 'other text' });
    r.sink.stepEnd(2); // not the current step: ignored
    r.frame({ connection: 1, direction: 'in', frame: [1], at: 9 });
    r.sink.stepEnd(1);
    r.sink.deliveryStart(77); // never queued
    r.sink.deliveryEnd(78);
    const t = r.trace();
    expect(t.source).toBe('real-router');
    expect(t.seed).toBeUndefined();
    expect(t.frames.map((f) => [f.seq, f.at, f.stepId])).toEqual([
      [1, 5, undefined],
      [3, 9, 1],
    ]);
    expect(t.deliveries).toEqual([expect.objectContaining({ deliveryId: 77, stepId: 0, phase: 'ran' })]);
    expect(frameTypes(t)).toEqual([NaN, 1]);
    expect(Object.isFrozen(t) && Object.isFrozen(t.events) && Object.isFrozen(t.events[0])).toBe(true);
  });

  test('defaults and queries: source sim, framesOn by direction, logsOf by event', () => {
    const r = new TraceRecorder({ now: () => 0 });
    r.frame({ connection: 2, direction: 'in', frame: [1], at: 0 });
    r.frame({ connection: 2, direction: 'out', frame: [2], at: 0 });
    r.log({ level: 'warn', event: 'frame.dropped', message: 'm' });
    r.log({ level: 'debug', event: 'other', message: 'o' });
    const t = r.trace();
    expect(t.source).toBe('sim');
    expect(framesOn(t, 2, 'out').map((f) => f.frame)).toEqual([[2]]);
    expect(framesOn(t, 3)).toEqual([]);
    expect(logsOf(t, 'frame.dropped').map((l) => l.entry.message)).toEqual(['m']);
  });
});
