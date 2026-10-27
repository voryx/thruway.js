// The ghost re-REGISTER window (see also Crossbar quirk 9): after a drop the router has not noticed, it still holds
// this client's registrations for the old (ghost) session, so the re-REGISTER of the next session meets
// `procedure_already_exists`. Inside the client that is retried after 1, 2, 4, 8, 16, 30, 30, … s for up to 300 s from
// the first such error before the stream errors; a first REGISTER (a genuine conflict) errors at once.
import { describe, expect, test } from 'vitest';
import type { RegisterOp } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { registerFrame } from '../../src/protocol/messages.js';
import { GHOST_MEMORY, GHOST_RETRY, RegisterParticipant } from '../../src/ops/register.js';
import type { RegisteredMessage } from '../../src/types.js';
import { snapshotRegister } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeRegisterOp,
  inbound,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';

const TIMEOUT = 60000;
type Reg = RegisterOp & { readonly subscriber: FakeSubscriber<RegisteredMessage> };

function registration(procedure: string, options?: Record<string, unknown>): Reg {
  return fakeRegisterOp(snapshotRegister(procedure, () => undefined, options));
}

class Harness {
  readonly reg = new RegisterParticipant({ requestTimeout: TIMEOUT, submit: () => undefined });
  ctx: FakeSessionCtx;
  private connId = 1;
  constructor() {
    this.ctx = this.open(0);
  }
  private open(now: number): FakeSessionCtx {
    const ctx = createFakeCtx({ connId: this.connId, session: { id: this.connId }, now });
    ctx.bindTimers('register', this.reg);
    this.reg.welcome(ctx);
    this.ctx = ctx;
    return ctx;
  }
  /** The session drops; the next one is established at once (its WELCOME re-REGISTERs). */
  reconnect(): FakeSessionCtx {
    const now = this.ctx.now;
    this.ctx.endSession();
    this.reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    this.connId++;
    return this.open(now);
  }
  /** Answer the last REGISTER written. */
  answer(how: 'registered' | 'exists', registrationId = 70): void {
    const frame = this.ctx.frames(MessageType.REGISTER).at(-1)!;
    const requestId = frame[1] as number;
    this.reg.inbound(
      how === 'registered'
        ? inbound.registered(requestId, registrationId)
        : inbound.error(MessageType.REGISTER, requestId, Uri.PROCEDURE_ALREADY_EXISTS),
      this.ctx,
    );
    this.ctx.runDeliveries();
  }
  registers(): number {
    return this.ctx.frames(MessageType.REGISTER).length;
  }
}

describe('ghost re-REGISTER window', () => {
  test('a re-established registration meeting procedure_already_exists retries 1, 2, 4, 8, 16, 30, 30 s', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered', 7);
    h.reconnect();
    expect(h.registers()).toBe(1);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.answer('exists');
      const timer = h.ctx.armedTimers('register')[0]!;
      expect(timer.deadline).toBe(false);
      expect(timer.key).toBeLessThan(0); // never a request id
      delays.push(timer.ms);
      expect([...h.reg.pendingIds()]).toEqual([]); // dormant meanwhile: nothing in flight
      h.ctx.advance(timer.ms);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.registers()).toBe(8);
    expect(h.ctx.logged('register.ghost')).toHaveLength(7);
    expect(h.ctx.logged('register.ghost')[0]).toMatchObject({ level: 'debug', data: { procedure: 'com.callee' } });
    h.answer('registered', 71); // the router evicted the ghost (keepalive, replace_orphaned_session, …)
    expect(op.subscriber.values).toEqual([
      { registrationId: 7, procedure: 'com.callee', sessionId: 1 },
      { registrationId: 71, procedure: 'com.callee', sessionId: 2 },
    ]);
    expect(op.subscriber.errors).toEqual([]);
    expect(h.ctx.armedTimers('register')).toEqual([]);
  });

  test('after 300 s the stream errors procedure_already_exists (recipe 16 takes over)', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    const start = h.ctx.now;
    for (;;) {
      h.answer('exists');
      const timer = h.ctx.armedTimers('register')[0];
      if (timer === undefined) break;
      h.ctx.advance(timer.ms);
    }
    expect(h.ctx.now - start).toBeGreaterThanOrEqual(GHOST_RETRY.window);
    expect(op.subscriber.errors[0]).toMatchObject({ uri: Uri.PROCEDURE_ALREADY_EXISTS, procedure: 'com.callee' });
    // the key is a genuine conflict from now on: a new subscription errors at once
    const again = registration('com.callee');
    h.reg.start(again, h.ctx, h.ctx);
    h.answer('exists');
    expect(again.subscriber.errors).toHaveLength(1);
  });

  test('a first REGISTER meeting procedure_already_exists errors at once (a genuine conflict)', () => {
    const h = new Harness();
    const op = registration('com.taken');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('exists');
    expect(op.subscriber.errors[0]).toMatchObject({ uri: Uri.PROCEDURE_ALREADY_EXISTS });
    expect(h.ctx.armedTimers('register')).toEqual([]);
  });

  test('the ghost retry consumes the ERROR; a payload-invalid procedure_already_exists is a ProtocolError, not a ghost', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    const invalid = inbound.invalid(inbound.error(MessageType.REGISTER, 1, Uri.PROCEDURE_ALREADY_EXISTS));
    expect(h.reg.inbound(invalid, h.ctx)).toBe(true);
    h.ctx.runDeliveries();
    expect(op.subscriber.errors[0]).toMatchObject({ name: 'ProtocolError', procedure: 'com.callee' });
    const again = registration('com.callee');
    h.reg.start(again, h.ctx, h.ctx);
    expect(h.reg.inbound(inbound.error(MessageType.REGISTER, 2, Uri.PROCEDURE_ALREADY_EXISTS), h.ctx)).toBe(true);
    expect(again.subscriber.errors).toEqual([]);
  });

  test('the window is 300 s from the first ghost error, inclusive', () => {
    for (const [elapsed, errors] of [
      [GHOST_RETRY.window - 1, 0],
      [GHOST_RETRY.window, 1],
    ] as const) {
      const h = new Harness();
      h.ctx.now = 100000;
      const op = registration('com.callee');
      h.reg.start(op, h.ctx, h.ctx);
      h.answer('registered');
      h.reconnect();
      h.answer('exists'); // the window starts at 100 000
      h.ctx.advance(1000);
      h.ctx.now = 100000 + elapsed;
      h.answer('exists');
      expect(op.subscriber.errors).toHaveLength(errors);
    }
  });

  test('another error URI on a re-establishment errors at once', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.reg.inbound(inbound.error(MessageType.REGISTER, 1, Uri.NOT_AUTHORIZED), h.ctx);
    h.ctx.runDeliveries();
    expect(op.subscriber.errors[0]).toMatchObject({ uri: Uri.NOT_AUTHORIZED });
  });

  test('a REGISTER written but unanswered when the session dropped counts as a re-establishment', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx); // the router registers it, but REGISTERED is lost with the socket
    h.reconnect();
    h.answer('exists');
    expect(op.subscriber.errors).toEqual([]);
    expect(h.ctx.armedTimers('register')).toHaveLength(1);
  });

  test('a remount while disconnected keeps riding out the ghost (the key is remembered, not the record)', () => {
    const h = new Harness();
    const first = registration('com.callee');
    h.reg.start(first, h.ctx, h.ctx);
    h.answer('registered');
    h.ctx.endSession();
    h.reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    h.reg.stop(first, undefined, createFakeEffects()); // unmounted while offline …
    const second = registration('com.callee');
    h.reg.start(second, undefined, createFakeEffects()); // … and mounted again
    const ctx = createFakeCtx({ connId: 2, session: { id: 2 } });
    ctx.bindTimers('register', h.reg);
    h.ctx = ctx;
    h.reg.welcome(ctx);
    h.answer('exists');
    expect(second.subscriber.errors).toEqual([]);
    h.ctx.advance(1000);
    h.answer('registered', 9);
    expect(second.subscriber.values).toEqual([{ registrationId: 9, procedure: 'com.callee', sessionId: 2 }]);
  });

  test('a REGISTERED in a later session clears the memory: the next conflict is genuine', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reg.stop(op, h.ctx, h.ctx);
    h.reconnect(); // the UNREGISTER was in flight: remembered
    const again = registration('com.callee');
    h.reg.start(again, h.ctx, h.ctx);
    h.answer('registered');
    h.reg.stop(again, h.ctx, h.ctx);
    h.reg.inbound(inbound.unregistered(2), h.ctx);
    const third = registration('com.callee');
    h.reg.start(third, h.ctx, h.ctx);
    h.answer('exists');
    expect(third.subscriber.errors).toHaveLength(1);
  });

  test('unsubscribing while waiting cancels the retry; nothing more is written', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.answer('exists');
    h.reg.stop(op, h.ctx, h.ctx);
    expect(h.ctx.armedTimers('register')).toEqual([]);
    h.ctx.advance(60000);
    expect(h.registers()).toBe(1);
    h.reg.timer(-1, h.ctx); // the cancelled timer's input, had the core let it through
    expect(h.registers()).toBe(1);
  });

  test('a ghost timer input delivered twice REGISTERs once', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.answer('exists');
    const key = h.ctx.armedTimers('register')[0]!.key;
    h.reg.timer(key, h.ctx);
    h.reg.timer(key, h.ctx);
    expect(h.registers()).toBe(2);
  });

  test('a session end while waiting: dormant; the next WELCOME REGISTERs at once; the window keeps its start', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.answer('exists');
    h.ctx.advance(250000);
    h.answer('exists'); // after the retry fired (1 s): still inside the window
    h.reconnect();
    expect(h.registers()).toBe(1); // immediately, not after the remaining delay
    h.ctx.now += 60000; // more than 300 s since the first ghost error
    h.answer('exists');
    expect(op.subscriber.errors[0]).toMatchObject({ uri: Uri.PROCEDURE_ALREADY_EXISTS });
  });

  test('a ghost retry that is not sent stays dormant until the next WELCOME', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.answer('exists');
    h.ctx.refuseWrites = true;
    h.ctx.advance(1000);
    expect(h.ctx.refused).toHaveLength(1);
    h.ctx.refuseWrites = false;
    h.reconnect();
    expect(h.ctx.frames()).toEqual([registerFrame(1, {}, 'com.callee')]);
  });

  test('a stopped REGISTER that meets procedure_already_exists is simply forgotten', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered');
    h.reconnect();
    h.reg.stop(op, h.ctx, h.ctx);
    h.answer('exists');
    expect(op.subscriber.errors).toEqual([]);
    expect(h.ctx.armedTimers('register')).toEqual([]);
  });

  test(`the memory is bounded: ${String(GHOST_MEMORY)} keys, oldest forgotten first`, () => {
    const h = new Harness();
    const ops: Reg[] = [];
    for (let i = 0; i <= GHOST_MEMORY; i++) {
      const op = registration(`com.p${String(i)}`);
      ops.push(op);
      h.reg.start(op, h.ctx, h.ctx);
    }
    h.reconnect(); // every REGISTER was pending: all remembered, the first one evicted
    const requestOf = (procedure: string): number =>
      h.ctx.frames(MessageType.REGISTER).find((f) => f[3] === procedure)![1] as number;
    h.reg.inbound(inbound.error(MessageType.REGISTER, requestOf('com.p0'), Uri.PROCEDURE_ALREADY_EXISTS), h.ctx);
    h.reg.inbound(inbound.error(MessageType.REGISTER, requestOf('com.p1'), Uri.PROCEDURE_ALREADY_EXISTS), h.ctx);
    h.ctx.runDeliveries();
    expect(ops[0]!.subscriber.errors).toHaveLength(1);
    expect(ops[1]!.subscriber.errors).toEqual([]);
  });

  test('a record riding out its window keeps retrying after its key fell out of the memory', () => {
    const h = new Harness();
    const op = registration('com.callee');
    h.reg.start(op, h.ctx, h.ctx);
    h.answer('registered', 7);
    h.reconnect();
    h.answer('exists'); // the ghost window starts; the record waits for its ghost timer
    for (let i = 0; i < GHOST_MEMORY; i++) h.reg.start(registration(`com.other${String(i)}`), h.ctx, h.ctx);
    h.reconnect(); // GHOST_MEMORY newer keys remembered: com.callee is the one forgotten
    const request = h.ctx.frames(MessageType.REGISTER).find((f) => f[3] === 'com.callee')![1] as number;
    expect(h.reg.inbound(inbound.error(MessageType.REGISTER, request, Uri.PROCEDURE_ALREADY_EXISTS), h.ctx)).toBe(true);
    h.ctx.runDeliveries();
    expect(op.subscriber.errors).toEqual([]); // still inside its window: retried, not a genuine conflict
    expect(h.reg.sizes().ghostTimers).toBe(1);
  });

  test('a key remembered again moves to the newest end of the memory', () => {
    const h = new Harness();
    const closed = fakeEndInfo({ willRetry: false }).inflightError({});
    h.reg.start(registration('com.kept'), h.ctx, h.ctx);
    h.reconnect(); // memory: [kept]
    for (let i = 0; i < GHOST_MEMORY; i++) h.reg.start(registration(`com.p${String(i)}`), h.ctx, h.ctx);
    h.answer('exists'); // the last REGISTER is com.p1023's: a genuine conflict, forgotten
    const keptRequest = h.ctx.frames(MessageType.REGISTER).find((f) => f[3] === 'com.kept')![1] as number;
    h.reg.inbound(inbound.error(MessageType.REGISTER, keptRequest, Uri.PROCEDURE_ALREADY_EXISTS), h.ctx);
    h.ctx.advance(1000); // com.kept REGISTERs again: now its request is the newest
    h.reg.clientClosed(() => closed, createFakeEffects()); // memory: [p0 … p1022, kept]
    h.reconnect();
    h.reg.start(registration('com.last'), h.ctx, h.ctx);
    h.reconnect(); // memory: [p1 … p1022, kept, last] — p0 evicted, not kept
    const kept = registration('com.kept');
    const p0 = registration('com.p0');
    h.reg.start(kept, h.ctx, h.ctx);
    h.answer('exists');
    h.reg.start(p0, h.ctx, h.ctx);
    h.answer('exists');
    expect(kept.subscriber.errors).toEqual([]);
    expect(p0.subscriber.errors).toHaveLength(1);
  });
});
