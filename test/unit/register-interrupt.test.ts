// INTERRUPT and the callee's answers (INV-INVOKE): `{}` (Thruway PHP) and `kill` abort the handler and answer
// `wamp.error.canceled`; `killnowait` (what Crossbar sends when the caller drops, quirk 12) aborts and writes nothing;
// the handler Observable is unsubscribed before the signal is aborted; later results are dropped. A property drives
// random interleavings of invocations, results, INTERRUPTs, unsubscribes and session drops and checks INV-INVOKE: at
// most one final answer per INVOCATION, on its own connection, none after `killnowait`, progress only when asked and
// never after the final answer.
import { fc } from '@fast-check/vitest';
import { Observable as RxObservable, Subject } from 'rxjs';
import { describe, expect, test, vi } from 'vitest';
import type { RegisterOp } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { invocationErrorFrame, unregisterFrame, yieldFrame, type OutboundFrame } from '../../src/protocol/messages.js';
import { RegisterParticipant } from '../../src/ops/register.js';
import type { InvocationMessage, RegisteredMessage } from '../../src/types.js';
import { snapshotRegister } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeStopError,
  fakeRegisterOp,
  inbound,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

// The properties generate up to 60 commands per run (`size: 'max'`: fast-check's default size caps arrays at 10). The
// time budget scales with FC_NUM_RUNS: 2 ms per run and property, never below the default 5 s.
vi.setConfig({ testTimeout: Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 2) });

const TIMEOUT = 60000;
type Reg = RegisterOp & { readonly subscriber: FakeSubscriber<RegisteredMessage> };

/** The participant, one session, routing handler results like the core (current connection only, synchronously). */
function setup(handler: (invocation: InvocationMessage) => unknown): {
  readonly reg: RegisterParticipant;
  readonly ctx: FakeSessionCtx;
  readonly op: Reg;
} {
  let ctx = createFakeCtx();
  const reg = new RegisterParticipant({
    requestTimeout: TIMEOUT,
    submit: (input) => {
      if ('invocation' in input && input.conn === ctx.connId && ctx.isGateOpen) reg.handlerEvent(input, ctx);
    },
  });
  ctx = createFakeCtx();
  ctx.bindTimers('register', reg);
  reg.welcome(ctx);
  const op = fakeRegisterOp(snapshotRegister('com.work', handler, undefined));
  reg.start(op, ctx, ctx);
  reg.inbound(inbound.registered(1, 7), ctx);
  ctx.runDeliveries();
  return { reg, ctx, op };
}

const answers = (ctx: FakeSessionCtx): OutboundFrame[] =>
  ctx.frames().filter((f) => f[0] === MessageType.YIELD || f[0] === MessageType.ERROR);

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('INTERRUPT', () => {
  test.each([
    ['{} (Thruway PHP)', {}],
    ['kill', { mode: 'kill' }],
  ])('%s ⇒ handler Observable unsubscribed, then signal aborted (CanceledError); ERROR canceled', (_name, options) => {
    const order: string[] = [];
    let signal: InvocationMessage['signal'] | undefined;
    const results = new Subject<number>();
    const source = new RxObservable<number>((subscriber) => {
      const inner = results.subscribe(subscriber);
      return () => {
        order.push(`unsubscribed, aborted: ${String(signal?.aborted)}`);
        inner.unsubscribe();
      };
    });
    const { reg, ctx } = setup((invocation) => {
      signal = invocation.signal;
      invocation.signal.addEventListener('abort', () => order.push('aborted'));
      return source;
    });
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    expect(reg.inbound(inbound.interrupt(5, options), ctx)).toBe(true);
    expect(answers(ctx)).toEqual([invocationErrorFrame(5, {}, Uri.CANCELED)]);
    expect(order).toEqual([]); // app code runs in a delivery
    ctx.runDeliveries();
    expect(order).toEqual(['unsubscribed, aborted: false', 'aborted']);
    expect(signal?.reason).toMatchObject({
      name: 'CanceledError',
      code: 'canceled',
      procedure: 'com.work',
      requestId: 5,
    });
    results.next(1); // too late: nothing more for invocation 5
    expect(answers(ctx)).toHaveLength(1);
    expect(reg.inbound(inbound.interrupt(5, options), ctx)).toBe(false);
  });

  test("a handler Observable whose teardown throws: reported to the client's logger (unhandled); the abort happens", () => {
    let signal: InvocationMessage['signal'] | undefined;
    const source = {
      subscribe: () => ({
        unsubscribe: () => {
          throw new Error('teardown bug');
        },
      }),
    };
    const { reg, ctx } = setup((invocation) => {
      signal = invocation.signal;
      return source;
    });
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    reg.inbound(inbound.interrupt(5), ctx);
    ctx.runDeliveries();
    expect(signal?.aborted).toBe(true);
    const [entry] = ctx.logged('unhandled');
    expect(entry?.level).toBe('error');
    expect(entry?.data?.['error']).toEqual(new Error('teardown bug'));
  });

  test('a handler Observable that unsubscribes the registration while being subscribed is unsubscribed itself', () => {
    let tornDown = 0;
    let stop: () => void = () => undefined;
    const source = new RxObservable<number>(() => {
      stop(); // app code inside the result's subscribe ends the registration (and with it this invocation)
      return () => {
        tornDown++;
      };
    });
    const { reg, ctx, op } = setup(() => source);
    stop = () => {
      reg.stop(op, ctx, ctx);
    };
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    expect(tornDown).toBe(1);
    expect(answers(ctx)).toEqual([invocationErrorFrame(5, {}, Uri.CANCELED)]);
  });

  test('killnowait ⇒ aborted, nothing written (the router already answered the caller)', () => {
    let signal: InvocationMessage['signal'] | undefined;
    const { reg, ctx } = setup((invocation) => {
      signal = invocation.signal;
      return new Promise(() => undefined);
    });
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    expect(reg.inbound(inbound.interrupt(5, { mode: 'killnowait' }), ctx)).toBe(true);
    ctx.runDeliveries();
    expect(answers(ctx)).toEqual([]);
    expect(signal?.aborted).toBe(true);
  });

  test('a Promise result that settles after the INTERRUPT is dropped', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const { reg, ctx } = setup(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    reg.inbound(inbound.interrupt(5), ctx);
    ctx.runDeliveries();
    resolve('late');
    await flush();
    expect(answers(ctx)).toEqual([invocationErrorFrame(5, {}, Uri.CANCELED)]);
  });

  test('an INTERRUPT before the handler ran: the handler never runs; ERROR canceled', () => {
    let calls = 0;
    const { reg, ctx } = setup(() => {
      calls++;
    });
    reg.inbound(inbound.invocation(5, 7), ctx);
    reg.inbound(inbound.interrupt(5), ctx);
    ctx.runDeliveries();
    expect(calls).toBe(0);
    expect(answers(ctx)).toEqual([invocationErrorFrame(5, {}, Uri.CANCELED)]);
  });

  test("unknown or already answered invocations are ignored; Thruway PHP's [8, 8, …] after killnowait is not ours", () => {
    const { reg, ctx } = setup(() => 'done');
    expect(reg.inbound(inbound.interrupt(5), ctx)).toBe(false);
    reg.inbound(inbound.invocation(6, 7), ctx);
    ctx.runDeliveries();
    expect(answers(ctx)).toEqual([yieldFrame(6, false, [['done']])]);
    expect(reg.inbound(inbound.interrupt(6), ctx)).toBe(false);
    expect(reg.inbound(inbound.error(8, 6, Uri.NO_SUCH_PROCEDURE), ctx)).toBe(false);
    expect(answers(ctx)).toHaveLength(1);
  });

  test('an INTERRUPT whose ERROR cannot be written is logged; the invocation is over', () => {
    const { reg, ctx } = setup(() => new Promise(() => undefined));
    reg.inbound(inbound.invocation(5, 7), ctx);
    ctx.runDeliveries();
    ctx.failNextWrite(new TypeError('serializer broke'));
    reg.inbound(inbound.interrupt(5), ctx);
    expect(ctx.logged('request.error')).toHaveLength(1);
    expect(reg.inbound(inbound.interrupt(5), ctx)).toBe(false);
  });

  test('unsubscribing the registration answers every running invocation canceled, then UNREGISTERs', () => {
    const signals: InvocationMessage['signal'][] = [];
    const { reg, ctx, op } = setup((invocation) => {
      signals.push(invocation.signal);
      return new Promise(() => undefined);
    });
    reg.inbound(inbound.invocation(5, 7), ctx);
    reg.inbound(inbound.invocation(6, 7), ctx);
    ctx.runDeliveries();
    op.subscriber.unsubscribe();
    reg.stop(op, ctx, ctx);
    expect(ctx.frames().slice(-3)).toEqual([
      invocationErrorFrame(5, {}, Uri.CANCELED),
      invocationErrorFrame(6, {}, Uri.CANCELED),
      unregisterFrame(2, 7),
    ]);
    ctx.runDeliveries();
    expect(signals.map((s) => [s.aborted, (s.reason as { code?: string }).code])).toEqual([
      [true, 'canceled'],
      [true, 'canceled'],
    ]);
  });

  test('an invocation of another registration is not affected by an unsubscribe', () => {
    const ctx = createFakeCtx();
    const reg = new RegisterParticipant({
      requestTimeout: TIMEOUT,
      submit: (input) => {
        if ('invocation' in input) reg.handlerEvent(input, ctx);
      },
    });
    reg.welcome(ctx);
    let resolve: (value: unknown) => void = () => undefined;
    const a = fakeRegisterOp(snapshotRegister('com.a', () => new Promise(() => undefined), undefined));
    const b = fakeRegisterOp(
      snapshotRegister(
        'com.b',
        () =>
          new Promise((r) => {
            resolve = r;
          }),
        undefined,
      ),
    );
    reg.start(a, ctx, ctx);
    reg.start(b, ctx, ctx);
    reg.inbound(inbound.registered(1, 7), ctx);
    reg.inbound(inbound.registered(2, 8), ctx);
    reg.inbound(inbound.invocation(5, 7), ctx);
    reg.inbound(inbound.invocation(6, 8), ctx);
    ctx.runDeliveries();
    reg.stop(a, ctx, ctx);
    resolve('b');
    return flush().then(() => {
      expect(answers(ctx)).toEqual([invocationErrorFrame(5, {}, Uri.CANCELED), yieldFrame(6, false, [['b']])]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// INV-INVOKE property
// ---------------------------------------------------------------------------------------------------------------------

type Command =
  | { readonly kind: 'invoke'; readonly progress: boolean; readonly result: 'subject' | 'value' | 'throw' }
  | { readonly kind: 'next'; readonly index: number; readonly bad: boolean }
  | { readonly kind: 'complete'; readonly index: number }
  | { readonly kind: 'error'; readonly index: number }
  | { readonly kind: 'interrupt'; readonly index: number; readonly mode: 'none' | 'kill' | 'killnowait' }
  | { readonly kind: 'remount' }
  | { readonly kind: 'drop' };

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('invoke'),
      progress: fc.boolean(),
      result: fc.constantFrom('subject', 'subject', 'value', 'throw'),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('next'), index: fc.nat(), bad: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('complete'), index: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('error'), index: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('interrupt'),
      index: fc.nat(),
      mode: fc.constantFrom('none', 'kill', 'killnowait'),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'remount' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'drop' as const }) },
);

interface Sent {
  readonly conn: number;
  readonly id: number;
  /** INVOCATION.Details.receive_progress */
  readonly asked: boolean;
  /** frames answering it, in order */
  readonly frames: OutboundFrame[];
  /** The first INTERRUPT: its mode, and how many answer frames had been written when it arrived. */
  interrupted: { readonly mode: 'none' | 'kill' | 'killnowait'; readonly written: number } | undefined;
}

const isFinal = (frame: OutboundFrame): boolean =>
  frame[0] === MessageType.ERROR || (frame[0] === MessageType.YIELD && !('progress' in frame[2]));

function run(commands: readonly Command[]): void {
  let connId = 1;
  let ctx = createFakeCtx();
  const reg = new RegisterParticipant({
    requestTimeout: TIMEOUT,
    submit: (input) => {
      if ('invocation' in input && input.conn === ctx.connId && ctx.isGateOpen) reg.handlerEvent(input, ctx);
    },
  });
  const subjects: Subject<unknown>[] = [];
  const invocations: Sent[] = [];
  const ended: FakeSessionCtx[] = [];
  let result: Command & { kind: 'invoke' } = { kind: 'invoke', progress: false, result: 'value' };
  const handler = (): unknown => {
    if (result.result === 'throw') throw new Error('handler bug');
    if (result.result === 'value') return 'v';
    const subject = new Subject<unknown>();
    subjects.push(subject);
    return subject;
  };
  let op = fakeRegisterOp(snapshotRegister('com.work', handler, undefined));
  let registrationId = 0;
  let seen = 0;
  let nextInvocation = 1;

  const collect = (): void => {
    for (; seen < ctx.written.length; seen++) {
      const frame = ctx.written[seen]!.frame;
      if (frame[0] === MessageType.REGISTER) {
        registrationId++;
        reg.inbound(inbound.registered(frame[1], registrationId), ctx);
      } else if (frame[0] === MessageType.UNREGISTER) {
        reg.inbound(inbound.unregistered(frame[1]), ctx);
      } else if (frame[0] === MessageType.YIELD || frame[0] === MessageType.ERROR) {
        const id = frame[0] === MessageType.YIELD ? frame[1] : frame[2];
        const target = invocations.find((i) => i.conn === ctx.connId && i.id === id);
        expect(
          target,
          `an answer for invocation ${String(id)} that was never received on this connection`,
        ).toBeDefined();
        target!.frames.push(frame);
      }
    }
  };
  const settle = (): void => {
    for (let i = 0; i < 10; i++) {
      ctx.runDeliveries();
      const before = seen;
      collect();
      if (seen === before && ctx.pendingDeliveries.length === 0) return;
    }
  };
  const begin = (): void => {
    ctx = createFakeCtx({ connId, session: { id: connId } });
    ctx.bindTimers('register', reg);
    seen = 0;
    reg.welcome(ctx);
    settle();
  };
  reg.start(op, undefined, createFakeEffects());
  begin();

  const fx = createFakeEffects();
  const pick = (index: number): Subject<unknown> | undefined =>
    subjects.length === 0 ? undefined : subjects[index % subjects.length];
  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'invoke': {
        result = cmd;
        const id = nextInvocation++;
        invocations.push({ conn: ctx.connId, id, asked: cmd.progress, frames: [], interrupted: undefined });
        const details = cmd.progress ? { receive_progress: true } : {};
        reg.inbound(inbound.invocation(id, registrationId, [], {}, details), ctx);
        break;
      }
      case 'next':
        pick(cmd.index)?.next(cmd.bad ? 10n : cmd.index);
        break;
      case 'complete':
        pick(cmd.index)?.complete();
        break;
      case 'error':
        pick(cmd.index)?.error(new Error('stream failed'));
        break;
      case 'interrupt': {
        const live = invocations.filter((i) => i.conn === ctx.connId);
        if (live.length === 0) break;
        const target = live[cmd.index % live.length]!;
        target.interrupted ??= { mode: cmd.mode, written: target.frames.length };
        reg.inbound(inbound.interrupt(target.id, cmd.mode === 'none' ? {} : { mode: cmd.mode }), ctx);
        break;
      }
      case 'remount':
        op.subscriber.unsubscribe();
        reg.stop(op, ctx, ctx);
        op = fakeRegisterOp(snapshotRegister('com.work', handler, undefined));
        reg.start(op, ctx, ctx);
        break;
      case 'drop':
        ctx.endSession();
        ended.push(ctx);
        reg.sessionEnded(fakeEndInfo(), fx);
        fx.runDeliveries(); // aborts: the handler Observables are unsubscribed
        connId++;
        begin();
        break;
    }
    settle();
  }
  for (const old of ended) expect(old.refused, 'a write into an ended session').toEqual([]);
  // close: every running invocation is aborted, nothing is written, nothing is left behind (INV-R10)
  const written = ctx.written.length;
  const closeFx = createFakeEffects();
  reg.clientClosed(fakeStopError({ gaveUp: true }), closeFx);
  closeFx.runDeliveries();
  expect(ctx.written, 'a frame written by close()').toHaveLength(written);
  expect(reg.sizes()).toMatchObject({ records: 0, ops: 0, requests: 0, late: 0, invocations: 0, ghostTimers: 0 });
  for (const invocation of invocations) {
    const finals = invocation.frames.filter(isFinal);
    expect(finals.length, `invocation ${String(invocation.id)}: more than one final answer`).toBeLessThanOrEqual(1);
    const progress = invocation.frames.filter((f) => !isFinal(f));
    if (!invocation.asked) expect(progress, 'a progress YIELD nobody asked for').toEqual([]);
    if (finals.length === 1) expect(invocation.frames.at(-1), 'a frame after the final answer').toBe(finals[0]);
    const interrupt = invocation.interrupted;
    if (interrupt === undefined) continue;
    const answeredBefore = invocation.frames.slice(0, interrupt.written).some(isFinal);
    if (interrupt.mode === 'killnowait') {
      expect(invocation.frames, 'a frame after INTERRUPT killnowait').toHaveLength(interrupt.written);
    } else if (!answeredBefore) {
      // kill, or no mode at all: the answer is `canceled`, and nothing follows it
      expect(invocation.frames.slice(interrupt.written)).toEqual([
        invocationErrorFrame(invocation.id, {}, Uri.CANCELED),
      ]);
    }
  }
}

describe('property INV-INVOKE', () => {
  test('at most one final answer per INVOCATION, on its connection; progress only when asked; none after it', () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 60, size: 'max' }), (commands) => {
        run(commands);
      }),
      replayParameters(),
    );
  });
});
