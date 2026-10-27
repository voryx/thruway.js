// RegisterParticipant: REGISTER/REGISTERED/ERROR(64), request timers, INVOCATION (unknown registration,
// payload-invalid, the handler run and every kind of result, `async function*` included), the YIELD/ERROR answers
// (yieldPayload, invalid payloads, serializer and size failures), revocation, UNREGISTER, session end and close,
// results matched by Invocation identity. Adoption is in register-adopt.test.ts, the ghost window in
// register-ghost.test.ts, INTERRUPT and the at-most-one-answer property in register-interrupt.test.ts.
import fc from 'fast-check';
import { Observable as RxObservable, of, Subject, throwError } from 'rxjs';
import { describe, expect, test, vi } from 'vitest';
import type { HandlerEvent, RegisterOp } from '../../src/core/contracts.js';
import { isThruwayError, isWampError, WampError } from '../../src/errors.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { HELLO_ROLES } from '../../src/protocol/hello.js';
import {
  invocationErrorFrame,
  registerFrame,
  unregisterFrame,
  yieldFrame,
  type OutboundFrame,
} from '../../src/protocol/messages.js';
import { Client } from '../../src/client.js';
import { RegisterParticipant } from '../../src/ops/register.js';
import type { InvocationMessage, LogEntry, RegisteredMessage } from '../../src/types.js';
import { snapshotRegister } from '../../src/validate.js';
import { Yield } from '../../src/yield.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeStopError,
  fakeRegisterOp,
  inbound,
  nextSeq,
  serializerError,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';
import { createHarness } from '../helpers/harness.js';
import { replayParameters } from '../setup-fast-check.js';

const TIMEOUT = 60000;
type Handler = (invocation: InvocationMessage) => unknown;
type Reg = RegisterOp & { readonly subscriber: FakeSubscriber<RegisteredMessage> };

function registration(
  procedure: string,
  handler: Handler = () => undefined,
  options?: Record<string, unknown>,
  seq: number = nextSeq(),
): Reg {
  return fakeRegisterOp(snapshotRegister(procedure, handler, options), seq);
}

/** The participant with a core stand-in: handler results are routed back like the core does (current connection,
 *  established session only), synchronously (a submit from a delivery is processed before it returns). */
class Harness {
  readonly reg: RegisterParticipant;
  ctx: FakeSessionCtx;
  readonly submitted: HandlerEvent[] = [];
  /** Record handler results without routing them (a core that has them queued). */
  hold = false;

  constructor() {
    this.reg = new RegisterParticipant({
      requestTimeout: TIMEOUT,
      submit: (input) => {
        if (input.kind !== 'handler.next' && input.kind !== 'handler.complete' && input.kind !== 'handler.error')
          return;
        this.submitted.push(input);
        if (this.hold) return;
        if (input.conn === this.ctx.connId && this.ctx.isGateOpen) this.reg.handlerEvent(input, this.ctx);
      },
    });
    this.ctx = this.session(1);
  }

  session(connId: number, options: Parameters<typeof createFakeCtx>[0] = {}): FakeSessionCtx {
    const ctx = createFakeCtx({ connId, session: { id: connId }, inFlight: () => this.reg.pendingIds(), ...options });
    ctx.bindTimers('register', this.reg);
    this.ctx = ctx;
    this.reg.welcome(ctx);
    return ctx;
  }

  end(willRetry = true): void {
    this.ctx.endSession();
    const fx = createFakeEffects();
    this.reg.sessionEnded(fakeEndInfo({ willRetry }), fx);
    fx.runDeliveries();
  }

  /** start + REGISTERED: an active registration with registration id `registrationId`. */
  active(op: Reg, registrationId: number): void {
    this.reg.start(op, this.ctx, this.ctx);
    const frame = this.ctx.lastFrame()!;
    expect(frame[0]).toBe(MessageType.REGISTER);
    this.reg.inbound(inbound.registered(frame[1] as number, registrationId), this.ctx);
    this.ctx.runDeliveries();
  }

  /** INVOCATION, then run the handler delivery (and whatever it submits synchronously). */
  invoke(invocationId: number, registrationId: number, details: Record<string, unknown> = {}, args?: unknown[]): void {
    expect(this.reg.inbound(inbound.invocation(invocationId, registrationId, args, {}, details), this.ctx)).toBe(true);
    this.ctx.runDeliveries();
  }

  /** Frames answering invocations (YIELD and ERROR(68)). */
  answers(): OutboundFrame[] {
    return this.ctx.frames().filter((f) => f[0] === MessageType.YIELD || f[0] === MessageType.ERROR);
  }
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('REGISTER and REGISTERED', () => {
  test('dormant without a session; the WELCOME REGISTERs every record FIFO by seq, with a request timer', () => {
    const reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const fx = createFakeEffects();
    const b = registration('com.b', undefined, { invoke: 'roundrobin' }, 20);
    const a = registration('com.a', undefined, undefined, 10);
    reg.start(b, undefined, fx);
    reg.start(a, undefined, fx);
    expect(fx.pendingDeliveries).toEqual([]);
    expect([...reg.pendingIds()]).toEqual([]);
    const ctx = createFakeCtx();
    reg.welcome(ctx);
    expect(ctx.frames()).toEqual([registerFrame(1, {}, 'com.a'), registerFrame(2, { invoke: 'roundrobin' }, 'com.b')]);
    expect(ctx.armedTimers('register').map((t) => [t.key, t.ms, t.deadline])).toEqual([
      [1, TIMEOUT, true],
      [2, TIMEOUT, true],
    ]);
    expect([...reg.pendingIds()]).toEqual([1, 2]);
    reg.welcome(ctx); // idempotent within one session
    expect(ctx.frames()).toHaveLength(2);
    reg.start(a, ctx, ctx); // a second start of one op: ignored
    expect(ctx.frames()).toHaveLength(2);
  });

  test('a start with a ctx before any WELCOME was reported establishes that session', () => {
    const reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const ctx = createFakeCtx();
    reg.start(registration('com.a'), ctx, ctx);
    expect(ctx.frames()).toEqual([registerFrame(1, {}, 'com.a')]);
  });

  test('REGISTERED ⇒ next({registrationId, procedure, sessionId}) after the step; duplicates are not consumed', () => {
    const h = new Harness();
    const op = registration('com.add');
    h.reg.start(op, h.ctx, h.ctx);
    expect(h.ctx.frames()).toEqual([registerFrame(1, {}, 'com.add')]);
    expect(h.reg.inbound(inbound.registered(1, 4000), h.ctx)).toBe(true);
    expect(op.subscriber.values).toEqual([]);
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([{ registrationId: 4000, procedure: 'com.add', sessionId: 1 }]);
    expect(Object.isFrozen(op.subscriber.values[0])).toBe(true);
    expect(h.ctx.armedTimers('register')).toEqual([]);
    expect([...h.reg.pendingIds()]).toEqual([]);
    expect(h.reg.inbound(inbound.registered(1, 4000), h.ctx)).toBe(false); // a duplicate: the id is held
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([]);
    expect(h.reg.inbound(inbound.registered(99, 1), h.ctx)).toBe(true); // an unknown request: withdrawn once
    expect(h.reg.inbound(inbound.registered(99, 1), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.registered(98, 0), h.ctx)).toBe(false); // id 0: nothing an UNREGISTER may name
    expect(h.reg.inbound(inbound.invocation(5, 0), h.ctx)).toBe(true); // answered no_such_registration only
    expect(h.ctx.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([1]);
  });

  test('ERROR(64) on a first REGISTER ⇒ WampError{uri, args, kwargs, details, procedure, requestId, sessionId}', () => {
    const h = new Harness();
    const op = registration('com.taken');
    h.reg.start(op, h.ctx, h.ctx);
    const details = { message: 'taken' };
    const error = inbound.error(64, 1, Uri.PROCEDURE_ALREADY_EXISTS, ['x'], { y: 1 }, details);
    expect(h.reg.inbound(error, h.ctx)).toBe(true);
    h.ctx.runDeliveries();
    const received = op.subscriber.errors[0] as WampError;
    expect(isWampError(received)).toBe(true);
    expect(received).toMatchObject({
      uri: Uri.PROCEDURE_ALREADY_EXISTS,
      args: ['x'],
      kwargs: { y: 1 },
      details,
      procedure: 'com.taken',
      requestId: 1,
      sessionId: 1,
    });
    expect([...h.reg.pendingIds()]).toEqual([]);
    expect(h.ctx.armedTimers('register')).toEqual([]);
    h.reg.stop(op, h.ctx, h.ctx); // the errored stream's teardown: nothing
    expect(h.ctx.frames()).toHaveLength(1);
    // Thruway PHP lowercases procedures: the error keeps the app's spelling
    const upper = registration('com.Example.UPPER');
    h.reg.start(upper, h.ctx, h.ctx);
    h.reg.inbound(inbound.error(64, 2, Uri.INVALID_URI), h.ctx);
    h.ctx.runDeliveries();
    expect(upper.subscriber.errors[0]).toMatchObject({ uri: Uri.INVALID_URI, procedure: 'com.Example.UPPER' });
  });

  test('a payload-invalid ERROR(64) ⇒ ProtocolError{frame, procedure, requestId}', () => {
    const h = new Harness();
    const op = registration('com.p');
    h.reg.start(op, h.ctx, h.ctx);
    h.reg.inbound(inbound.invalid(inbound.error(64, 1, Uri.NOT_AUTHORIZED), 'kwargs is not a dict', '[8,64,1]'), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.errors[0]).toMatchObject({ name: 'ProtocolError', frame: '[8,64,1]', procedure: 'com.p' });
  });

  test('request timer: alive ⇒ TimeoutError{request, procedure}; dead ⇒ nothing; a late REGISTERED ⇒ UNREGISTER', () => {
    for (const verdict of ['alive', 'dead'] as const) {
      const h = new Harness();
      h.ctx.now = 250;
      const op = registration('com.slow');
      h.reg.start(op, h.ctx, h.ctx);
      expect(h.ctx.advance(TIMEOUT)).toBe(1);
      expect(h.ctx.verdicts.map((v) => v.since)).toEqual([250]);
      h.ctx.resolveVerdicts(verdict);
      h.ctx.runDeliveries();
      if (verdict === 'dead') {
        expect(op.subscriber.notifications).toEqual([]);
        continue;
      }
      expect(op.subscriber.errors[0]).toMatchObject({
        name: 'TimeoutError',
        code: 'timeout',
        timer: 'request',
        timeout: TIMEOUT,
        procedure: 'com.slow',
        requestId: 1,
        sessionId: 1,
      });
      expect([...h.reg.pendingIds()]).toEqual([1]);
      h.reg.inbound(inbound.registered(1, 7), h.ctx);
      expect(h.ctx.lastFrame()).toEqual(unregisterFrame(2, 7));
      expect(h.reg.inbound(inbound.invocation(5, 7), h.ctx)).toBe(true);
      expect(h.ctx.lastFrame()).toEqual(invocationErrorFrame(5, {}, Uri.NO_SUCH_REGISTRATION));
    }
  });

  test('a stopped REGISTER that times out becomes late quietly; a verdict after the session ended does nothing', () => {
    const h = new Harness();
    const op = registration('com.slow');
    h.reg.start(op, h.ctx, h.ctx);
    h.reg.stop(op, h.ctx, h.ctx);
    h.ctx.advance(TIMEOUT);
    h.ctx.resolveVerdicts('alive');
    expect(h.ctx.runDeliveries()).toBe(0);
    expect([...h.reg.pendingIds()]).toEqual([1]);

    const second = new Harness();
    const slow = registration('com.slow');
    second.reg.start(slow, second.ctx, second.ctx);
    second.ctx.advance(TIMEOUT);
    const verdict = second.ctx.verdicts[0]!;
    second.end();
    verdict.onTimeout(); // a core that ran it anyway
    second.ctx.runDeliveries();
    expect(slow.subscriber.notifications).toEqual([]);
  });

  test('a REGISTER that was not sent is not retried before the next WELCOME; nothing is pending for it', () => {
    const h = new Harness();
    h.ctx.refuseWrites = true;
    h.reg.start(registration('com.p'), h.ctx, h.ctx);
    h.ctx.refuseWrites = false;
    expect([...h.reg.pendingIds()]).toEqual([]);
    expect(h.ctx.armedTimers('register')).toEqual([]);
    h.reg.inbound(inbound.invocation(1, 1), h.ctx);
    h.reg.timer(1, h.ctx);
    expect(h.ctx.frames(MessageType.REGISTER)).toEqual([]);
  });

  test('a REGISTER that cannot be serialized or is too large errors that stream only; not sent ⇒ dormant', () => {
    const h = new Harness();
    const bad = registration('com.bad');
    h.ctx.failNextWrite(serializerError());
    h.reg.start(bad, h.ctx, h.ctx);
    h.ctx.runDeliveries();
    expect(bad.subscriber.errors).toEqual([serializerError()]);
    const small = h.session(1, { maxFrameBytes: 10 });
    const huge = registration('com.huge');
    h.reg.start(huge, small, small);
    small.runDeliveries();
    expect(huge.subscriber.errors[0]).toMatchObject({ uri: Uri.PAYLOAD_SIZE_EXCEEDED, procedure: 'com.huge' });
    const later = h.session(1);
    later.refuseWrites = true;
    const refused = registration('com.later');
    h.reg.start(refused, later, later);
    expect(later.refused).toHaveLength(1);
    h.end();
    expect(h.session(2).frames()).toEqual([registerFrame(1, {}, 'com.later')]);
    expect(refused.subscriber.notifications).toEqual([]);
  });

  test('frames of other participants are not consumed', () => {
    const h = new Harness();
    expect(h.reg.inbound(inbound.subscribed(1, 2), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.CALL, 1, Uri.CANCELED), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.INVOCATION, 1, Uri.CANCELED), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.unregistered(1), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.UNREGISTER, 1, Uri.CANCELED), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.REGISTER, 1, Uri.CANCELED), h.ctx)).toBe(false);
    expect(h.ctx.frames()).toEqual([]);
  });

  test('the HELLO announces callee call_canceling (Thruway refuses CANCEL for callees without it)', () => {
    expect(HELLO_ROLES.callee.features).toMatchObject({ call_canceling: true, registration_revocation: true });
  });

  test('a custom serializer error that refuses the context (frozen) fails only that stream; start and welcome never throw', () => {
    const h = new Harness();
    const refused = Object.freeze(new WampError('com.serializer.refused'));
    const bad = registration('com.bad');
    const good = registration('com.good');
    h.ctx.failNextWrite(refused);
    h.reg.start(bad, h.ctx, h.ctx); // a throw here would be a hardReset that fails every stream
    h.reg.start(good, h.ctx, h.ctx);
    h.ctx.runDeliveries();
    expect(bad.subscriber.errors).toHaveLength(1);
    expect(bad.subscriber.errors[0]).toBe(refused); // passed on unchanged
    expect(h.ctx.frames()).toEqual([registerFrame(1, {}, 'com.good')]);
    // the WELCOME path: the same failure at every re-establishment would otherwise be a hardReset loop
    const again = registration('com.again');
    h.end();
    h.reg.start(again, undefined, h.ctx);
    const next = createFakeCtx({ connId: 2, session: { id: 2 } });
    next.failNextWrite(refused, (frame) => frame[3] === 'com.again');
    h.reg.welcome(next);
    next.runDeliveries();
    expect(again.subscriber.errors).toEqual([refused]);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'com.good')]);
  });

  test('pendingIds() is a live view that can be iterated again and again, across sessions (an allocator may rescan it)', () => {
    const reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    let ids: Iterable<number> = [];
    const ctx = createFakeCtx({ ids: [5, 5, 5, 6], inFlight: () => ids });
    reg.welcome(ctx);
    ids = reg.pendingIds(); // taken once; the fake allocator scans it again on every redraw
    reg.start(registration('com.a'), ctx, ctx);
    expect([...ids]).toEqual([5]);
    expect([...ids]).toEqual([5]); // a bare Map iterator would be exhausted here
    reg.start(registration('com.b'), ctx, ctx); // 5, 5 are redrawn, then 6
    expect(ctx.written.map((w) => w.requestId)).toEqual([5, 6]);
    reg.inbound(inbound.registered(5, 50), ctx);
    expect([...ids]).toEqual([6]);
    ctx.endSession();
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    expect([...ids]).toEqual([]);
    reg.welcome(createFakeCtx({ connId: 2, session: { id: 2 } })); // both records are dormant again
    expect([...ids]).toEqual([1, 2]);
  });
});

describe('INVOCATION', () => {
  test('an unknown registration ⇒ ERROR no_such_registration; a payload-invalid one ⇒ invalid_argument', () => {
    const h = new Harness();
    let calls = 0;
    h.active(
      registration('com.p', () => {
        calls++;
        return 'ok';
      }),
      7,
    );
    h.invoke(1, 99);
    expect(h.reg.inbound(inbound.invalid(inbound.invocation(2, 7), 'args is not an array'), h.ctx)).toBe(true);
    h.ctx.runDeliveries();
    expect(h.answers()).toEqual([
      invocationErrorFrame(1, {}, Uri.NO_SUCH_REGISTRATION),
      invocationErrorFrame(2, {}, Uri.INVALID_ARGUMENT),
    ]);
    expect(calls).toBe(0);
    h.invoke(3, 7); // the registration stays
    expect(h.answers()[2]).toEqual(yieldFrame(3, false, [['ok']]));
  });

  test('the handler runs in a delivery with a frozen InvocationMessage (details.procedure for patterns)', () => {
    const h = new Harness();
    const seen: InvocationMessage[] = [];
    h.active(
      registration(
        'com.pattern',
        (invocation) => {
          seen.push(invocation);
          return undefined;
        },
        { match: 'prefix' },
      ),
      7,
    );
    h.reg.inbound(inbound.invocation(1, 7, [1], { k: 2 }, { procedure: 'com.pattern.x', caller: 9 }), h.ctx);
    expect(seen).toEqual([]); // not inside the step: a step never runs app code
    h.ctx.runDeliveries();
    h.invoke(2, 7, {}, []);
    expect(seen).toHaveLength(2);
    const [first, second] = seen as [InvocationMessage, InvocationMessage];
    expect(first).toMatchObject({
      args: [1],
      kwargs: { k: 2 },
      details: { procedure: 'com.pattern.x', caller: 9 },
      procedure: 'com.pattern.x',
    });
    expect(first.signal.aborted).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second.procedure).toBe('com.pattern');
  });

  test('a duplicate INVOCATION id while the first runs is not consumed (dropped)', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => new Promise(() => undefined)),
      7,
    );
    h.invoke(1, 7);
    expect(h.reg.inbound(inbound.invocation(1, 7), h.ctx)).toBe(false);
  });
});

describe('handler results ⇒ YIELD (yieldPayload)', () => {
  const cases: readonly (readonly [string, Handler, OutboundFrame])[] = [
    ['a plain value ⇒ args [value]', () => 42, yieldFrame(1, false, [[42]])],
    ['an array value ⇒ args [array] (never spread)', () => [1, 2], yieldFrame(1, false, [[[1, 2]]])],
    ['undefined ⇒ no args (a TypeError in v2)', () => undefined, yieldFrame(1, false)],
    ['null ⇒ args [null]', () => null, yieldFrame(1, false, [[null]])],
    ['a Yield ⇒ its args/kwargs', () => new Yield([1], { a: 2 }), yieldFrame(1, false, [[1], { a: 2 }])],
    ['an empty Yield ⇒ no payload', () => new Yield(), yieldFrame(1, false)],
    [
      'a Yield with kwargs only ⇒ [] then kwargs',
      () => new Yield(undefined, { a: 1 }),
      yieldFrame(1, false, [[], { a: 1 }]),
    ],
    ['an Observable ⇒ its last value', () => of(1, 2, 3), yieldFrame(1, false, [[3]])],
    ['an empty Observable ⇒ no args', () => of(), yieldFrame(1, false)],
    ['an Observable of Yields ⇒ the last Yield', () => of(new Yield([1]), new Yield([2])), yieldFrame(1, false, [[2]])],
  ];
  test.each(cases)('%s', (_name, handler, frame) => {
    const h = new Harness();
    h.active(registration('com.p', handler), 7);
    h.invoke(1, 7);
    expect(h.answers()).toEqual([frame]);
  });

  test('a Promise ⇒ the YIELD once it resolves; a Promise of a Yield ⇒ its payload', async () => {
    const h = new Harness();
    let resolve: (value: unknown) => void = () => undefined;
    h.active(
      registration(
        'com.p',
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([]);
    resolve(new Yield(['done']));
    await flush();
    expect(h.answers()).toEqual([yieldFrame(1, false, [['done']])]);
  });

  test('progress asked (details.receive_progress) and an Observable ⇒ progress YIELDs, then the empty final YIELD', () => {
    const h = new Harness();
    const values = new Subject<unknown>();
    h.active(
      registration('com.feed', () => values),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    values.next(1);
    values.next(new Yield([2], { more: true }));
    expect(h.answers()).toEqual([yieldFrame(1, true, [[1]]), yieldFrame(1, true, [[2], { more: true }])]);
    values.complete();
    expect(h.answers()[2]).toEqual(yieldFrame(1, false));
    values.next(3); // nothing after the final answer (INV-INVOKE)
    expect(h.answers()).toHaveLength(3);
  });

  test('progress asked and a Promise or plain value ⇒ one final YIELD with the value', async () => {
    const h = new Harness();
    h.active(
      registration('com.p', (invocation) => (invocation.args[0] === 'promise' ? Promise.resolve(5) : 6)),
      7,
    );
    h.invoke(1, 7, { receive_progress: true }, ['promise']);
    h.invoke(2, 7, { receive_progress: true }, ['plain']);
    await flush();
    expect(h.answers()).toEqual([yieldFrame(2, false, [[6]]), yieldFrame(1, false, [[5]])]);
  });

  test('without progress an Observable that emits over time answers once, with its last value', () => {
    const h = new Harness();
    const values = new Subject<number>();
    h.active(
      registration('com.p', () => values),
      7,
    );
    h.invoke(1, 7);
    values.next(1);
    values.next(2);
    expect(h.answers()).toEqual([]);
    values.complete();
    expect(h.answers()).toEqual([yieldFrame(1, false, [[2]])]);
  });
});

describe('async function* handlers: answered from their values, like an Observable', () => {
  async function* counter(log: string[] = []): AsyncGenerator {
    try {
      yield 1;
      yield await Promise.resolve(new Yield([2], { more: true }));
      yield 3;
    } finally {
      log.push('finally');
    }
  }

  test('no progress asked ⇒ one YIELD with the last value, once the generator is done', async () => {
    const h = new Harness();
    const log: string[] = [];
    h.active(
      registration('com.p', () => counter(log)),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([]); // the values arrive asynchronously
    await flush();
    expect(h.answers()).toEqual([yieldFrame(1, false, [[3]])]);
    expect(log).toEqual(['finally']);
  });

  test('progress asked ⇒ a progress YIELD per value, then the empty final YIELD', async () => {
    const h = new Harness();
    h.active(
      registration('com.feed', () => counter()),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    await flush();
    expect(h.answers()).toEqual([
      yieldFrame(1, true, [[1]]),
      yieldFrame(1, true, [[2], { more: true }]),
      yieldFrame(1, true, [[3]]),
      yieldFrame(1, false),
    ]);
  });

  test('an empty generator ⇒ YIELD without args (progress asked or not)', async () => {
    // eslint-disable-next-line require-yield -- a handler stream without values
    async function* nothing(): AsyncGenerator {
      await Promise.resolve();
    }
    const h = new Harness();
    h.active(
      registration('com.p', () => nothing()),
      7,
    );
    h.invoke(1, 7);
    h.invoke(2, 7, { receive_progress: true });
    await flush();
    expect(h.answers()).toEqual([yieldFrame(1, false), yieldFrame(2, false)]);
  });

  test('a generator that throws ⇒ ERROR (a WampError keeps its uri); the registration stays', async () => {
    const h = new Harness();
    const op = registration('com.p', async function* (invocation) {
      yield 'partial';
      await Promise.resolve();
      if (invocation.args[0] === 'wamp') throw new WampError('com.example.gone', ['bye']);
      throw new Error('feed broke');
    });
    h.active(op, 7);
    h.invoke(1, 7, { receive_progress: true }, ['wamp']);
    h.invoke(2, 7, {}, ['other']);
    await flush();
    expect(h.answers()).toEqual([
      yieldFrame(1, true, [['partial']]),
      invocationErrorFrame(1, {}, 'com.example.gone', [['bye']]),
      invocationErrorFrame(2, {}, Uri.RUNTIME_ERROR, [['feed broke']]),
    ]);
    expect(op.subscriber.notifications).toHaveLength(1); // only the RegisteredMessage: the registration stays
  });

  test('INTERRUPT while it runs ⇒ return() (its finally runs), ERROR canceled, nothing after', async () => {
    const h = new Harness();
    const log: string[] = [];
    let release!: () => void;
    async function* slow(): AsyncGenerator<number> {
      try {
        yield 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield 2;
      } finally {
        log.push('finally');
      }
    }
    h.active(
      registration('com.feed', () => slow()),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    await flush();
    expect(h.answers()).toEqual([yieldFrame(1, true, [[1]])]);
    h.reg.inbound(inbound.interrupt(1), h.ctx);
    h.ctx.runDeliveries();
    expect(h.answers()).toEqual([yieldFrame(1, true, [[1]]), invocationErrorFrame(1, {}, Uri.CANCELED)]);
    release();
    await flush();
    expect(log).toEqual(['finally']);
    expect(h.answers()).toHaveLength(2);
  });

  test('the session ends while it runs ⇒ return() once, no frame, nothing pulled any more', async () => {
    const h = new Harness();
    const returns = vi.fn(() => Promise.resolve({ done: true }));
    const nexts = vi.fn(() => new Promise<never>(() => undefined));
    h.active(
      registration('com.p', () => ({ [Symbol.asyncIterator]: () => ({ next: nexts, return: returns }) })),
      7,
    );
    h.invoke(1, 7);
    await flush();
    const frames = h.ctx.frames().length;
    h.end();
    await flush();
    expect(returns).toHaveBeenCalledTimes(1);
    expect(nexts).toHaveBeenCalledTimes(1);
    expect(h.ctx.frames()).toHaveLength(frames);
  });
});

describe('handler failures ⇒ ERROR; the registration stays', () => {
  test('a throw ⇒ runtime_error with the message only (never a stack); the next invocation is served', () => {
    const h = new Harness();
    let fail = true;
    const op = registration('com.p', () => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    h.active(op, 7);
    h.invoke(1, 7);
    fail = false;
    h.invoke(2, 7);
    expect(h.answers()).toEqual([
      invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['boom']]),
      yieldFrame(2, false, [['ok']]),
    ]);
    expect(op.subscriber.notifications).toHaveLength(1); // only the RegisteredMessage
  });

  test('a WampError (thrown, rejected or errored) ⇒ ERROR with its details, uri, args and kwargs', async () => {
    const error = new WampError('com.example.not_found', ['nope'], { id: 3 }, { hint: 1 });
    const results: readonly (() => unknown)[] = [
      () => {
        throw error;
      },
      () => Promise.reject(error),
      () => throwError(() => error),
    ];
    for (const result of results) {
      const h = new Harness();
      h.active(registration('com.p', result), 7);
      h.invoke(1, 7);
      await flush();
      expect(h.answers()).toEqual([
        invocationErrorFrame(1, { hint: 1 }, 'com.example.not_found', [['nope'], { id: 3 }]),
      ]);
    }
  });

  test('other rejections and errors ⇒ runtime_error [String(message ?? error)]; hostile values never throw', async () => {
    const hostile = Object.create(null) as object; // String() throws: no toString
    const getter = {
      get message(): string {
        throw new Error('getter');
      },
    };
    const values: readonly (readonly [unknown, string])[] = [
      ['plain text', 'plain text'],
      [{ message: 'like an error' }, 'like an error'],
      [{ message: 12 }, '12'],
      [{}, '[object Object]'],
      [undefined, 'undefined'],
      [null, 'null'],
      [hostile, 'unknown error'],
      [getter, 'unknown error'],
    ];
    for (const [value, text] of values) {
      const h = new Harness();
      const reject = (): Promise<never> =>
        Promise.resolve().then(() => {
          throw value; // handlers may reject with anything
        });
      h.active(registration('com.p', reject), 7);
      h.invoke(1, 7);
      await flush();
      expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [[text]])]);
    }
  });

  test('a WampError with an invalid URI ⇒ runtime_error [uri] (Crossbar kills the callee on invalid URIs)', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new WampError('not a uri');
      }),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['not a uri']])]);
  });

  test('a WampError whose details are not a dict is sent with {} details', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new WampError('com.e', [], {}, ['not', 'a', 'dict'] as unknown as Record<string, unknown>);
      }),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, 'com.e')]);
  });

  test('an invalid Yield or WampError payload ⇒ runtime_error ["invalid result payload"] and an unhandled entry', async () => {
    const results: readonly (() => unknown)[] = [
      () => new Yield('x' as unknown as unknown[]),
      () => new Yield([], [] as unknown as Record<string, unknown>),
      () => Promise.reject(new WampError('com.e', 'x' as unknown as unknown[])),
      () => {
        throw new WampError('com.e', [], new Map() as unknown as Record<string, unknown>);
      },
    ];
    for (const result of results) {
      const h = new Harness();
      h.active(registration('com.p', result), 7);
      h.invoke(1, 7);
      await flush();
      expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['invalid result payload']])]);
      const [entry, ...more] = h.ctx.logged('unhandled');
      expect(more).toEqual([]);
      expect(entry?.level).toBe('error');
      expect(entry?.message).toContain('the handler of com.p');
      expect(entry?.message).toMatch(/a (Yield|WampError) result needs an args array and a plain kwargs object/);
    }
  });

  test.each([
    ['a Yield', 'yield'],
    ['a WampError', 'error'],
  ] as const)('a hostile %s (throwing getters) is an invalid payload, never a crash', async (_name, kind) => {
    const h = new Harness();
    const yieldLike = new Yield([1]);
    Object.defineProperty(yieldLike, 'args', {
      get() {
        throw new Error('getter');
      },
    });
    const errorLike = new WampError('com.e');
    Object.defineProperty(errorLike, 'kwargs', {
      get() {
        throw new Error('getter');
      },
    });
    h.active(
      registration('com.p', () => (kind === 'yield' ? yieldLike : Promise.reject(errorLike))),
      7,
    );
    h.invoke(1, 7);
    await flush();
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['invalid result payload']])]);
  });

  test('a result that cannot be serialized ⇒ runtime_error ["result could not be serialized"]', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => 10n),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['result could not be serialized']])]);
  });

  test('a serializer that throws a WampError of another kind still means "result could not be serialized"', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => 1),
      7,
    );
    h.ctx.failNextWrite(new WampError('com.serializer.refused'), (frame) => frame[0] === MessageType.YIELD);
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['result could not be serialized']])]);
  });

  test('a result over the frame limit ⇒ payload_size_exceeded [bytes, limit]', () => {
    const h = new Harness();
    h.session(1, { maxFrameBytes: 64 });
    h.active(
      registration('com.p', () => 'x'.repeat(100)),
      7,
    );
    h.invoke(1, 7);
    const answer = h.answers()[0]!;
    expect(answer.slice(0, 5)).toEqual([8, 68, 1, {}, Uri.PAYLOAD_SIZE_EXCEEDED]);
    expect(answer[5]).toEqual([expect.any(Number), 64]);
  });

  test('an ERROR whose own args cannot be serialized is sent without args/kwargs (and details)', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new WampError('com.e', [10n], {}, { x: 1 });
      }),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, 'com.e')]);
  });

  test('if even the bare ERROR cannot be written it is logged; the invocation is over either way', () => {
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new Error('boom');
      }),
      7,
    );
    h.ctx.failWrites(serializerError(), (frame) => frame[0] === MessageType.ERROR);
    h.invoke(1, 7);
    expect(h.answers()).toEqual([]);
    expect(h.ctx.logged('request.error')).toEqual([
      {
        level: 'warn',
        event: 'request.error',
        message: 'an answer to an INVOCATION could not be written',
        data: { error: serializerError() },
      },
    ]);
    h.ctx.clearWriteFailures();
    expect(h.reg.inbound(inbound.interrupt(1), h.ctx)).toBe(false); // finished
  });

  test('a progress YIELD that fails ⇒ the final ERROR; the handler Observable is unsubscribed (a delivery)', () => {
    const h = new Harness();
    let unsubscribed = 0;
    const values = new Subject<unknown>();
    const source = new RxObservable<unknown>((subscriber) => {
      const inner = values.subscribe(subscriber);
      return () => {
        unsubscribed++;
        inner.unsubscribe();
      };
    });
    h.active(
      registration('com.feed', () => source),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    values.next(10n);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['result could not be serialized']])]);
    expect(unsubscribed).toBe(0);
    h.ctx.runDeliveries();
    expect(unsubscribed).toBe(1);
    values.next(1);
    expect(h.answers()).toHaveLength(1);
  });

  test('a progress YIELD that fails while the handler Observable is being subscribed ⇒ it is unsubscribed at once', () => {
    const h = new Harness();
    let unsubscribed = 0;
    const source = new RxObservable<unknown>((subscriber) => {
      subscriber.next(10n); // synchronously, inside subscribe: the progress YIELD cannot be serialized
      return () => {
        unsubscribed++;
      };
    });
    h.active(
      registration('com.feed', () => source),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['result could not be serialized']])]);
    expect(unsubscribed).toBe(1); // the source never stays subscribed after the final answer
    expect(h.reg.sizes().invocations).toBe(0);
  });

  test('a progress YIELD with an invalid Yield payload ⇒ the final ERROR "invalid result payload"', () => {
    const h = new Harness();
    const values = new Subject<unknown>();
    h.active(
      registration('com.feed', () => values),
      7,
    );
    h.invoke(1, 7, { receive_progress: true });
    values.next(new Yield('x' as unknown as unknown[]));
    h.ctx.runDeliveries();
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['invalid result payload']])]);
    expect(values.observed).toBe(false);
  });

  test('a final YIELD that is not sent (closing socket) ends the invocation; nothing more is written', () => {
    const h = new Harness();
    const values = new Subject<number>();
    h.active(
      registration('com.p', () => values),
      7,
    );
    h.invoke(1, 7);
    h.ctx.refuseWrites = true;
    values.next(1);
    values.complete();
    expect(h.ctx.refused).toHaveLength(1);
    h.ctx.refuseWrites = false;
    expect(h.reg.inbound(inbound.interrupt(1), h.ctx)).toBe(false);
  });
});

describe('results are matched by Invocation identity, never by id', () => {
  test('a result of the previous session is dropped; the new session INVOCATION with the same id gets its own', () => {
    const h = new Harness();
    const op = registration('com.p', (invocation) => invocation.args[0]);
    h.active(op, 7);
    h.hold = true; // the first session's result is still queued in the core when the session ends
    h.invoke(1, 7, {}, ['stale']);
    h.hold = false;
    expect(h.submitted).toHaveLength(1);
    h.end();
    const next = h.session(2);
    h.reg.inbound(inbound.registered(1, 8), next);
    next.runDeliveries();
    h.hold = true;
    h.invoke(1, 8, {}, ['fresh']); // the router reuses invocation id 1 in the new session
    h.hold = false;
    const [stale, fresh] = h.submitted as [HandlerEvent, HandlerEvent];
    h.reg.handlerEvent({ ...stale, conn: 2 }, next); // even a core that let it through: matched by identity, dropped
    expect(h.answers()).toEqual([]);
    h.reg.handlerEvent(fresh, next);
    expect(h.answers()).toEqual([yieldFrame(1, false, [['fresh']])]);
  });

  test('a foreign InvocationRef is dropped', () => {
    const h = new Harness();
    h.reg.handlerEvent({ kind: 'handler.next', conn: 1, invocation: {}, value: 1 }, h.ctx);
    expect(h.answers()).toEqual([]);
  });
});

describe('revocation [67, 0, {registration, reason}]', () => {
  test('the stream errors registration_revoked; running invocations continue and may still answer', async () => {
    const h = new Harness();
    let resolve: (value: unknown) => void = () => undefined;
    const op = registration(
      'com.p',
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const other = registration('com.other');
    h.active(op, 7);
    h.active(other, 8);
    h.invoke(1, 7);
    expect(h.reg.inbound(inbound.registrationRevoked(7, 'wamp.registration.revoked'), h.ctx)).toBe(true);
    h.ctx.runDeliveries();
    expect(op.subscriber.errors[0]).toMatchObject({
      uri: Uri.REGISTRATION_REVOKED,
      args: ['wamp.registration.revoked'],
      details: { registration: 7, reason: 'wamp.registration.revoked' },
      procedure: 'com.p',
      sessionId: 1,
    });
    expect(other.subscriber.errors).toEqual([]);
    resolve('late but fine');
    await flush();
    expect(h.answers()).toEqual([yieldFrame(1, false, [['late but fine']])]);
    h.reg.stop(op, h.ctx, h.ctx);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([]);
    h.invoke(2, 7);
    expect(h.answers()[1]).toEqual(invocationErrorFrame(2, {}, Uri.NO_SUCH_REGISTRATION));
  });

  test('without a reason the error has no args; an unknown registration is not consumed', () => {
    const h = new Harness();
    const op = registration('com.p');
    h.active(op, 7);
    expect(h.reg.inbound(inbound.registrationRevoked(8), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.registrationRevoked(7), h.ctx)).toBe(true);
    expect(h.reg.inbound(inbound.registrationRevoked(7), h.ctx)).toBe(false); // once
    h.ctx.runDeliveries();
    expect((op.subscriber.errors[0] as WampError).args).toEqual([]);
  });
});

describe('UNREGISTER', () => {
  test('stop of an active registration ⇒ UNREGISTER [66, id, regId] with a request timer; UNREGISTERED forgets it', () => {
    const h = new Harness();
    const op = registration('com.p');
    h.active(op, 7);
    h.reg.stop(op, h.ctx, h.ctx);
    expect(h.ctx.lastFrame()).toEqual(unregisterFrame(2, 7));
    expect(h.ctx.armedTimers('register').map((t) => [t.key, t.deadline])).toEqual([[2, true]]);
    expect([...h.reg.pendingIds()]).toEqual([2]);
    h.invoke(1, 7); // an INVOCATION racing the UNREGISTER
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.NO_SUCH_REGISTRATION)]);
    // answers of the wrong kind for request 2 (an UNREGISTER) are not consumed
    expect(h.reg.inbound(inbound.registered(2, 9), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.CALL, 2, Uri.CANCELED), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.REGISTER, 2, Uri.NOT_AUTHORIZED), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.unregistered(2), h.ctx)).toBe(true);
    expect([...h.reg.pendingIds()]).toEqual([]);
    expect(h.ctx.armedTimers('register')).toEqual([]);
    expect(h.reg.inbound(inbound.unregistered(2), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.registrationRevoked(7), h.ctx)).toBe(false); // 7 is no longer ours
    h.reg.start(registration('com.q'), h.ctx, h.ctx); // request 3: a REGISTER
    expect(h.reg.inbound(inbound.unregistered(3), h.ctx)).toBe(false);
    expect(h.reg.inbound(inbound.error(MessageType.UNREGISTER, 3, Uri.NOT_AUTHORIZED), h.ctx)).toBe(false);
  });

  test('ERROR(66), also payload-invalid, forgets the UNREGISTER (logged); a timeout forgets it after the verdict', () => {
    for (const how of ['error', 'invalid', 'timeout'] as const) {
      const h = new Harness();
      const op = registration('com.p');
      h.active(op, 7);
      h.reg.stop(op, h.ctx, h.ctx);
      const error = inbound.error(MessageType.UNREGISTER, 2, Uri.NO_SUCH_REGISTRATION);
      if (how === 'timeout') {
        h.ctx.advance(TIMEOUT);
        h.ctx.resolveVerdicts('alive');
        expect(h.ctx.logged('request.timeout')).toMatchObject([
          { level: 'warn', data: { requestId: 2, registrationId: 7 } },
        ]);
      } else {
        expect(h.reg.inbound(how === 'invalid' ? inbound.invalid(error) : error, h.ctx)).toBe(true);
        expect(h.ctx.logged('request.error')).toMatchObject([
          { level: 'debug', data: { requestId: 2, registrationId: 7 } },
        ]);
      }
      expect([...h.reg.pendingIds()]).toEqual([]);
      expect(op.subscriber.errors).toEqual([]);
    }
  });

  test('an UNREGISTER that cannot be written is logged; one that is not sent is dropped with the session', () => {
    const h = new Harness();
    const a = registration('com.a');
    const b = registration('com.b');
    h.active(a, 7);
    h.active(b, 8);
    h.ctx.failNextWrite(serializerError());
    h.reg.stop(a, h.ctx, h.ctx);
    expect(h.ctx.logged('request.error')).toMatchObject([{ level: 'warn', data: { registrationId: 7 } }]);
    h.ctx.refuseWrites = true;
    h.reg.stop(b, h.ctx, h.ctx);
    expect([...h.reg.pendingIds()]).toEqual([]);
  });

  test('stop without a ctx, of a dormant record, of a settled one: nothing is written', () => {
    const h = new Harness();
    const active = registration('com.a');
    h.active(active, 7);
    h.reg.stop(active, undefined, h.ctx);
    const reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    const dormant = registration('com.d');
    reg.start(dormant, undefined, h.ctx);
    reg.stop(dormant, undefined, h.ctx);
    reg.stop(dormant, undefined, h.ctx);
    const ctx = createFakeCtx();
    reg.welcome(ctx);
    expect(ctx.frames()).toEqual([]);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([]);
  });

  test('two records the router gave one registration id: the first one out does not UNREGISTER it', () => {
    const h = new Harness();
    const a = registration('com.p', () => 'a', { invoke: 'roundrobin' });
    const b = registration('com.p', () => 'b', { invoke: 'roundrobin' });
    h.active(a, 7);
    h.active(b, 7);
    h.invoke(1, 7);
    expect(h.answers()).toEqual([yieldFrame(1, false, [['a']])]);
    h.reg.stop(a, h.ctx, h.ctx);
    h.reg.stop(a, h.ctx, h.ctx); // a second teardown of the same subscription changes nothing
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([]);
    h.invoke(2, 7);
    expect(h.answers()[1]).toEqual(yieldFrame(2, false, [['b']]));
    h.reg.stop(b, h.ctx, h.ctx);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(3, 7)]);
  });

  test('a late REGISTERED with the id of an UNREGISTER in flight is not UNREGISTERed a second time (Thruway T8)', () => {
    const h = new Harness();
    const a = registration('com.p', () => 'a', { invoke: 'roundrobin' });
    const b = registration('com.p', () => 'b', { invoke: 'roundrobin' });
    h.active(a, 7);
    h.reg.start(b, h.ctx, h.ctx); // REGISTER 2, no client-side dedupe
    h.reg.stop(b, h.ctx, h.ctx); // stopped while pending
    h.reg.stop(a, h.ctx, h.ctx); // UNREGISTER 3 for registration 7
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(3, 7)]);
    expect(h.reg.inbound(inbound.registered(2, 7), h.ctx)).toBe(true); // the router handed out 7 again
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(3, 7)]); // not a second time
    h.reg.inbound(inbound.unregistered(3), h.ctx);
    expect(h.reg.sizes()).toMatchObject({ records: 0, ops: 0, requests: 0 });
    // once that one is answered, a later stopped REGISTERED with the same id is UNREGISTERed again
    const c = registration('com.p', () => 'c', { invoke: 'roundrobin' });
    h.reg.start(c, h.ctx, h.ctx);
    h.reg.stop(c, h.ctx, h.ctx);
    h.reg.inbound(inbound.registered(4, 7), h.ctx);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(3, 7), unregisterFrame(5, 7)]);
  });

  test('a REGISTERED with the id of an UNREGISTER written after its REGISTER, still in flight: registers again once that is over, then announces', () => {
    for (const how of ['unregistered', 'timeout'] as const) {
      const h = new Harness();
      const op = registration('com.p');
      h.reg.start(op, h.ctx, h.ctx); // REGISTER 1
      h.reg.inbound(inbound.registered(4242, 7), h.ctx); // a stray REGISTERED: UNREGISTER 2 for registration 7
      expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(2, 7)]);
      expect(h.reg.inbound(inbound.registered(1, 7), h.ctx)).toBe(true); // 7 for REGISTER 1: UNREGISTER 2 removes it
      h.ctx.runDeliveries();
      expect(op.subscriber.values).toEqual([]); // not announced: that registration is about to go
      expect(h.ctx.frames(MessageType.REGISTER)).toHaveLength(1);
      h.invoke(1, 7); // an INVOCATION before the UNREGISTER: refused, never a second UNREGISTER
      expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.NO_SUCH_REGISTRATION)]);
      if (how === 'timeout') {
        h.ctx.advance(TIMEOUT);
        h.ctx.resolveVerdicts('alive');
      } else {
        h.reg.inbound(inbound.unregistered(2), h.ctx);
      }
      expect(h.ctx.frames(MessageType.REGISTER).at(-1)).toEqual(registerFrame(3, {}, 'com.p'));
      h.reg.inbound(inbound.registered(3, 8), h.ctx);
      h.ctx.runDeliveries();
      expect(op.subscriber.values).toMatchObject([{ registrationId: 8, procedure: 'com.p' }]);
      expect(h.ctx.frames(MessageType.UNREGISTER)).toHaveLength(1);
      expect(h.reg.sizes()).toMatchObject({ records: 1, ops: 1, requests: 0 });
    }
  });

  test('a REGISTERED whose raced UNREGISTER the router refuses keeps its id: announced, no second REGISTER', () => {
    const h = new Harness();
    const op = registration('com.p', () => 'served');
    h.reg.start(op, h.ctx, h.ctx);
    h.reg.inbound(inbound.registered(4242, 7), h.ctx);
    h.reg.inbound(inbound.registered(1, 7), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([]);
    h.reg.inbound(inbound.error(MessageType.UNREGISTER, 2, Uri.NO_SUCH_REGISTRATION), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toMatchObject([{ registrationId: 7, procedure: 'com.p' }]);
    expect(h.ctx.frames(MessageType.REGISTER)).toHaveLength(1);
    h.invoke(1, 7);
    expect(h.answers()).toEqual([yieldFrame(1, false, [['served']])]);
    expect(h.reg.sizes()).toMatchObject({ records: 1, ops: 1, requests: 0 });
  });

  test('waiting for the raced UNREGISTER: a stop forgets the record; a session end keeps it dormant, a possible ghost', () => {
    const stopped = new Harness();
    const a = registration('com.p');
    stopped.reg.start(a, stopped.ctx, stopped.ctx);
    stopped.reg.inbound(inbound.registered(4242, 7), stopped.ctx);
    stopped.reg.inbound(inbound.registered(1, 7), stopped.ctx);
    stopped.reg.stop(a, stopped.ctx, stopped.ctx);
    expect(stopped.reg.sizes()).toMatchObject({ records: 0, ops: 0, requests: 1 });
    stopped.reg.inbound(inbound.unregistered(2), stopped.ctx);
    expect(stopped.ctx.frames(MessageType.REGISTER)).toHaveLength(1);
    expect(stopped.ctx.frames(MessageType.UNREGISTER)).toHaveLength(1);
    const ended = new Harness();
    const b = registration('com.p');
    ended.reg.start(b, ended.ctx, ended.ctx);
    ended.reg.inbound(inbound.registered(4242, 7), ended.ctx);
    ended.reg.inbound(inbound.registered(1, 7), ended.ctx);
    ended.end();
    expect(ended.reg.sizes()).toMatchObject({ records: 1, ops: 1, requests: 0, ghostKeys: 1 });
    const next = ended.session(2);
    expect(next.frames(MessageType.REGISTER)).toEqual([registerFrame(1, {}, 'com.p')]);
    ended.reg.inbound(inbound.error(MessageType.REGISTER, 1, Uri.PROCEDURE_ALREADY_EXISTS), next);
    expect(b.subscriber.errors).toEqual([]); // ridden out as a ghost of the old session
  });

  test('an UNREGISTER written after the REGISTER and answered before its REGISTERED (Thruway PHP invokes a replacing registration first): REGISTER again', () => {
    const h = new Harness();
    const op = registration('com.p', () => 'served');
    h.reg.start(op, h.ctx, h.ctx); // REGISTER 1
    h.invoke(1, 7); // the router already invokes the registration it is granting REGISTER 1
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.NO_SUCH_REGISTRATION)]);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([unregisterFrame(2, 7)]);
    h.reg.inbound(inbound.unregistered(2), h.ctx); // the router removed 7
    h.reg.inbound(inbound.registered(1, 7), h.ctx); // the REGISTERED it held back, for that removed registration
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toEqual([]);
    expect(h.ctx.frames(MessageType.REGISTER).at(-1)).toEqual(registerFrame(3, {}, 'com.p'));
    h.reg.inbound(inbound.registered(3, 8), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toMatchObject([{ registrationId: 8, procedure: 'com.p' }]);
    h.invoke(2, 8);
    expect(h.answers().at(-1)).toEqual(yieldFrame(2, false, [['served']]));
    expect(h.ctx.frames(MessageType.UNREGISTER)).toHaveLength(1);
    expect(h.reg.sizes()).toMatchObject({ records: 1, ops: 1, requests: 0 });
  });

  test('the same race with a refused UNREGISTER keeps the id: announced, no second REGISTER', () => {
    const h = new Harness();
    const op = registration('com.p', () => 'served');
    h.reg.start(op, h.ctx, h.ctx);
    h.invoke(1, 7);
    h.reg.inbound(inbound.error(MessageType.UNREGISTER, 2, Uri.NOT_AUTHORIZED), h.ctx); // the router kept 7
    h.reg.inbound(inbound.registered(1, 7), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.values).toMatchObject([{ registrationId: 7, procedure: 'com.p' }]);
    expect(h.ctx.frames(MessageType.REGISTER)).toHaveLength(1);
    h.invoke(2, 7);
    expect(h.answers().at(-1)).toEqual(yieldFrame(2, false, [['served']]));
  });

  test.each(['before', 'after'] as const)(
    'an UNREGISTER written before the REGISTER never removes what that REGISTER is granted (the router processes them in order), answered %s its REGISTERED',
    (answered) => {
      const h = new Harness();
      const op = registration('com.p', () => 'served');
      h.reg.inbound(inbound.registered(4242, 7), h.ctx); // a stray: UNREGISTER 1
      h.reg.start(op, h.ctx, h.ctx); // REGISTER 2, written after UNREGISTER 1
      if (answered === 'before') h.reg.inbound(inbound.unregistered(1), h.ctx);
      h.reg.inbound(inbound.registered(2, 7), h.ctx); // a router that gives the id out again
      if (answered === 'after') h.reg.inbound(inbound.unregistered(1), h.ctx);
      h.ctx.runDeliveries();
      expect(op.subscriber.values).toMatchObject([{ registrationId: 7, procedure: 'com.p' }]);
      expect(h.ctx.frames(MessageType.REGISTER)).toHaveLength(1);
      h.invoke(1, 7);
      expect(h.answers()).toEqual([yieldFrame(1, false, [['served']])]);
    },
  );
});

describe('session end and close', () => {
  test('a session end aborts running invocations (Lost; Observable unsubscribed first), writes nothing, keeps the stream', () => {
    const h = new Harness();
    const order: string[] = [];
    let signal: InvocationMessage['signal'] | undefined;
    const source = new RxObservable<number>(() => () => {
      order.push(`unsubscribed (aborted: ${String(signal?.aborted)})`);
    });
    const op = registration('com.p', (invocation) => {
      signal = invocation.signal;
      invocation.signal.addEventListener('abort', () => order.push('aborted'));
      return source;
    });
    h.active(op, 7);
    h.invoke(1, 7);
    const written = h.ctx.frames().length;
    h.end();
    expect(order).toEqual(['unsubscribed (aborted: false)', 'aborted']);
    expect(signal?.reason).toMatchObject({
      name: 'ConnectionLostError',
      code: 'connection_lost',
      procedure: 'com.p',
      requestId: 1, // the INVOCATION's id, like the CanceledError of an INTERRUPT
      sessionId: 1,
    });
    expect(h.ctx.frames()).toHaveLength(written);
    expect(op.subscriber.errors).toEqual([]);
    expect([...h.reg.pendingIds()]).toEqual([]);
    // re-established on the next session: REGISTER again, a RegisteredMessage again
    const next = h.session(2);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'com.p')]);
    h.reg.inbound(inbound.registered(1, 70), next);
    next.runDeliveries();
    expect(op.subscriber.values).toEqual([
      { registrationId: 7, procedure: 'com.p', sessionId: 1 },
      { registrationId: 70, procedure: 'com.p', sessionId: 2 },
    ]);
  });

  test('a give-up end aborts with ConnectionClosedError{gaveUp, cause: Lost}', () => {
    const h = new Harness();
    let signal: InvocationMessage['signal'] | undefined;
    h.active(
      registration('com.p', (invocation) => {
        signal = invocation.signal;
        return new Promise(() => undefined);
      }),
      7,
    );
    h.invoke(1, 7);
    h.end(false);
    expect(signal?.reason).toMatchObject({
      code: 'connection_closed',
      gaveUp: true,
      cause: { code: 'connection_lost' },
    });
  });

  test('an INVOCATION whose handler had not run yet when the session ended: the handler never runs', () => {
    const h = new Harness();
    let calls = 0;
    h.active(
      registration('com.p', () => {
        calls++;
      }),
      7,
    );
    h.reg.inbound(inbound.invocation(1, 7), h.ctx);
    const pending = [...h.ctx.pendingDeliveries];
    h.end();
    for (const delivery of pending) delivery();
    expect(calls).toBe(0);
  });

  test('a session end while REGISTER is pending: dormant, REGISTER again at the next WELCOME (exactly once)', () => {
    const h = new Harness();
    const op = registration('com.p');
    h.reg.start(op, h.ctx, h.ctx);
    h.end();
    const next = h.session(2);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'com.p')]);
    expect(h.ctx.frames(MessageType.UNREGISTER)).toEqual([]);
  });

  test('sessionEnded without a session is harmless', () => {
    const reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    expect([...reg.pendingIds()]).toEqual([]);
  });

  test('clientClosed: invocations aborted and streams errored, each with its own stop error; nothing written', () => {
    const h = new Harness();
    let signal: InvocationMessage['signal'] | undefined;
    const a = registration('com.a', (invocation) => {
      signal = invocation.signal;
      return new Promise(() => undefined);
    });
    const pending = registration('com.pending');
    const stopped = registration('com.stopped');
    const dormantLater = registration('com.later');
    h.active(a, 7);
    h.invoke(1, 7);
    h.reg.start(pending, h.ctx, h.ctx);
    h.reg.start(stopped, h.ctx, h.ctx);
    h.reg.stop(stopped, h.ctx, h.ctx);
    const written = h.ctx.frames().length;
    const fx = createFakeEffects();
    const stopError = fakeStopError();
    h.ctx.endSession();
    h.reg.clientClosed(stopError, fx);
    fx.runDeliveries();
    expect(stopError.calls).toEqual([
      { requestId: 1, procedure: 'com.a' },
      { procedure: 'com.a' },
      { procedure: 'com.pending' },
    ]);
    expect(signal?.reason).toMatchObject({ code: 'connection_closed', requestId: 1, procedure: 'com.a' });
    expect(a.subscriber.errors).toMatchObject([{ code: 'connection_closed', procedure: 'com.a' }]);
    expect(a.subscriber.errors[0]).not.toHaveProperty('requestId');
    expect(pending.subscriber.errors).toMatchObject([{ code: 'connection_closed', procedure: 'com.pending' }]);
    expect(stopped.subscriber.notifications).toEqual([]);
    expect(h.ctx.frames()).toHaveLength(written);
    expect([...h.reg.pendingIds()]).toEqual([]);
    // never opened again: a dormant record started now waits for the next WELCOME
    h.reg.start(dormantLater, undefined, fx);
    const next = h.session(2);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'com.later')]);
    expect(isThruwayError(signal?.reason)).toBe(true);
  });

  test('a ctx of a session the participant was not told about ends the old one first', () => {
    const h = new Harness();
    let signal: InvocationMessage['signal'] | undefined;
    const op = registration('com.p', (invocation) => {
      signal = invocation.signal;
      return new Promise(() => undefined);
    });
    h.active(op, 7);
    h.invoke(1, 7);
    const other = createFakeCtx({ connId: 5, session: { id: 5 } });
    expect(h.reg.inbound(inbound.invocation(2, 7), other)).toBe(true); // registration 7 belonged to the old session
    expect(other.frames().slice(0, 2)).toEqual([
      registerFrame(1, {}, 'com.p'),
      invocationErrorFrame(2, {}, Uri.NO_SUCH_REGISTRATION),
    ]);
    // the router invoked registration 7 on this connection, so it is this session's: withdrawn
    expect(other.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([7]);
    other.runDeliveries();
    expect(signal?.reason).toMatchObject({ code: 'connection_lost' });
    h.reg.inbound(inbound.registered(1, 9), other);
    const sixth = createFakeCtx({ connId: 6 });
    h.reg.stop(op, sixth, other); // an active record and yet another unknown session
    expect(other.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([7]); // only the withdrawal above
    expect(sixth.frames()).toEqual([]); // registration 9 was the fifth session's: never UNREGISTERed elsewhere
  });
});

describe("the Crossbar-checked keys of a handler WampError's details", () => {
  /** Crossbar's rules for ERROR Details (autobahn 26.10 `Error.parse` and the constructor's asserts), after the JSON
   *  round trip: a Python `int` is an integer JSON number written without `.`/`e`. */
  const pyInt = (v: unknown): boolean =>
    typeof v === 'number' && Number.isInteger(v) && !/[.eE]/.test(JSON.stringify(v));
  function crossbarAccepts(details: Record<string, unknown>): boolean {
    const d = JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
    if ('callee' in d && !pyInt(d['callee'])) return false;
    for (const key of ['callee_authid', 'callee_authrole']) if (key in d && typeof d[key] !== 'string') return false;
    if (!('forward_for' in d)) return true;
    const ff = d['forward_for'];
    return (
      Array.isArray(ff) &&
      ff.every(
        (p: unknown) =>
          typeof p === 'object' &&
          p !== null &&
          !Array.isArray(p) &&
          pyInt((p as Record<string, unknown>)['session']) &&
          ((p as Record<string, unknown>)['authid'] === null ||
            typeof (p as Record<string, unknown>)['authid'] === 'string') &&
          typeof (p as Record<string, unknown>)['authrole'] === 'string',
      )
    );
  }
  function errorDetails(details: Record<string, unknown>): { sent: unknown; warns: readonly unknown[] } {
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new WampError('com.example.failed', ['why'], {}, details);
      }),
      7,
    );
    h.invoke(1, 7);
    const [answer] = h.answers();
    expect(answer?.slice(0, 3)).toEqual([MessageType.ERROR, MessageType.INVOCATION, 1]);
    expect(answer?.[4]).toBe('com.example.failed');
    return { sent: answer?.[3], warns: h.ctx.logged('option.fallback') };
  }
  const principal = { session: 7, authid: 'peter', authrole: 'user' };
  const id = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2 ** 53;
  const isPrincipal = (p: unknown): boolean =>
    typeof p === 'object' &&
    p !== null &&
    [null, Object.prototype].includes(Object.getPrototypeOf(p) as object | null) && // a plain object
    id((p as Record<string, unknown>)['session']) &&
    typeof (p as Record<string, unknown>)['authid'] === 'string' &&
    typeof (p as Record<string, unknown>)['authrole'] === 'string';
  /** The rule of validate.ts for each checked key; every other key is kept; an undefined value is absent. */
  function kept(key: string, value: unknown): boolean {
    if (value === undefined) return false;
    if (key === 'callee') return id(value);
    if (key === 'callee_authid' || key === 'callee_authrole') return typeof value === 'string';
    // Array.from turns holes into undefined (every() would skip them)
    if (key === 'forward_for') return Array.isArray(value) && Array.from(value as unknown[]).every(isPrincipal);
    return true;
  }

  test.each([
    ['callee', 1],
    ['callee', 0],
    ['callee', 2 ** 53],
    ['callee_authid', 'peter'],
    ['callee_authid', ''],
    ['callee_authrole', 'user'],
    ['forward_for', []],
    ['forward_for', [principal, { ...principal, session: 8, extra: 'kept' }]],
  ])('%s = %j is kept', (key, value) => {
    const { sent, warns } = errorDetails({ [key]: value, hint: 1 });
    expect(sent).toEqual({ [key]: value, hint: 1 });
    expect(warns).toEqual([]);
  });

  test.each([
    ['callee', '1'],
    ['callee', 1.5],
    ['callee', -1],
    ['callee', 1e21],
    ['callee', true],
    ['callee', null],
    ['callee_authid', 1],
    ['callee_authid', null],
    ['callee_authrole', ['user']],
    ['forward_for', 'peter'],
    ['forward_for', principal],
    ['forward_for', [null]],
    ['forward_for', [{ ...principal, session: '7' }]],
    ['forward_for', [{ ...principal, authid: null }]],
    ['forward_for', [{ session: 7, authid: 'peter' }]],
    ['forward_for', [principal, [principal]]],
  ])('%s = %j is dropped with a warn; the other details are sent', (key, value) => {
    const { sent, warns } = errorDetails({ hint: 1, [key]: value, other: 'x' });
    expect(sent).toEqual({ hint: 1, other: 'x' });
    expect(warns).toMatchObject([{ level: 'warn', data: { procedure: 'com.p', requestId: 1, key } }]);
    expect((warns[0] as { message: string }).message).toContain(`details.${key}`);
  });

  test('forward_for with holes (a sparse array: JSON writes each hole as null) is dropped with a warn', () => {
    // Array.prototype.every skips holes, so `[, principal]` looked like an array of principals while Crossbar received
    // [null, {…}] and closed the callee's connection (1011)
    for (const value of [new Array<unknown>(1), Object.assign(new Array<unknown>(2), { 1: principal })]) {
      const { sent, warns } = errorDetails({ hint: 1, forward_for: value });
      expect(sent).toEqual({ hint: 1 });
      expect(crossbarAccepts(sent as Record<string, unknown>)).toBe(true);
      expect(warns).toMatchObject([{ level: 'warn', data: { key: 'forward_for' } }]);
    }
  });

  test('a key whose value is undefined is absent (JSON drops it; validate.ts treats it the same way): no warn', () => {
    const { sent, warns } = errorDetails({ hint: 1, callee: undefined, forward_for: undefined, other: undefined });
    expect(Object.keys(sent as object)).toEqual(['hint']);
    expect(warns).toEqual([]);
  });

  test('several bad keys: each dropped and logged once, in the order of the details', () => {
    const { sent, warns } = errorDetails({ callee: 'x', keep: true, callee_authrole: 2, forward_for: {} });
    expect(sent).toEqual({ keep: true });
    expect(warns.map((w) => (w as { data: { key: string } }).data.key)).toEqual([
      'callee',
      'callee_authrole',
      'forward_for',
    ]);
  });

  test('a details getter that throws: runtime_error, as for any hostile WampError', () => {
    const details = {
      get callee(): number {
        throw new Error('getter');
      },
    };
    const h = new Harness();
    h.active(
      registration('com.p', () => {
        throw new WampError('com.example.failed', [], {}, details);
      }),
      7,
    );
    h.invoke(1, 7);
    expect(h.answers()).toEqual([invocationErrorFrame(1, {}, Uri.RUNTIME_ERROR, [['invalid result payload']])]);
  });

  test('each details property is read once: what was checked is what is sent', () => {
    let reads = 0;
    const details = {
      get callee(): unknown {
        reads++;
        return reads === 1 ? 5 : 'not an id';
      },
    };
    const { sent } = errorDetails(details);
    expect(sent).toEqual({ callee: 5 });
    expect(reads).toBe(1);
  });

  test('through a real Client: the caller gets the error without the bad key; the registration stays', async () => {
    const harness = createHarness({ router: { strict: false } });
    const warns: LogEntry[] = [];
    const callee = harness.makeClient(Client, {
      options: { timeouts: { idle: 0 }, logger: (entry) => warns.push(entry) },
    });
    let n = 0;
    callee.client
      .register('com.example.p', () => {
        if (++n === 1) throw new WampError('com.example.denied', ['no'], {}, { callee: 'me', reason: 'r' });
        return 'second';
      })
      .subscribe();
    const caller = harness.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    await harness.clock.advance(10);
    const errors: unknown[] = [];
    caller.client.call('com.example.p').subscribe({ error: (e: unknown) => errors.push(e) });
    await harness.clock.advance(10);
    expect(errors).toMatchObject([{ uri: 'com.example.denied', details: { reason: 'r' } }]);
    expect((errors[0] as WampError).details).not.toHaveProperty('callee');
    expect(warns.filter((e) => e.event === 'option.fallback')).toMatchObject([{ data: { key: 'callee' } }]);
    const second: unknown[] = [];
    caller.client.call('com.example.p').subscribe((r) => second.push(r.args[0]));
    await harness.clock.advance(10);
    expect(second).toEqual(['second']);
    await harness.finish();
  });

  test('property: whatever is sent passes Crossbar’s checks; unchecked and valid keys are kept', () => {
    const id = fc.oneof(fc.integer({ min: 0, max: 2 ** 53 }), fc.constant(2 ** 53));
    const anyValue = fc.oneof(
      id,
      fc.integer({ min: -5, max: -1 }),
      fc.double({ noNaN: true }),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
    );
    const principalArb = fc.oneof(
      fc.record({ session: id, authid: fc.string(), authrole: fc.string() }),
      fc.record({ session: anyValue, authid: anyValue, authrole: anyValue }),
      anyValue,
    );
    const detailsArb = fc.record(
      {
        callee: fc.oneof(id, anyValue),
        callee_authid: fc.oneof(fc.string(), anyValue),
        callee_authrole: fc.oneof(fc.string(), anyValue),
        forward_for: fc.oneof(
          fc.array(principalArb, { maxLength: 3 }),
          fc.sparseArray(principalArb, { maxLength: 3 }),
          anyValue,
        ),
        other: anyValue,
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(detailsArb, (details) => {
        const { sent, warns } = errorDetails(details);
        const out = sent as Record<string, unknown>;
        expect(crossbarAccepts(out)).toBe(true);
        // exactly the keys our (stricter: ids are non-negative, authid is a string) rules accept are kept
        expect(out).toEqual(Object.fromEntries(Object.entries(details).filter(([k, v]) => kept(k, v))));
        // a warn for each key dropped for its type; undefined values are absent, silently
        const mistyped = Object.entries(details).filter(([k, v]) => v !== undefined && !kept(k, v));
        expect(warns).toHaveLength(mistyped.length);
      }),
      replayParameters(),
    );
  });
});
