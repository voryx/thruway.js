// Adoption of a pending REGISTER: StrictMode mount/unmount/mount in one tick, switchMap re-keying across round trips,
// `retry` after a request timeout; stopped and late records UNREGISTERed on arrival unless adopted, deleted at the
// session end, never REGISTERed again. A property runs random remount cycles against a single-invoke router (Thruway
// PHP / Crossbar `invoke: single`), with session drops that may leave a ghost session behind, and checks that after the
// run settles exactly one registration serves each mounted procedure, by the last-mounted handler, and that no stream
// ever saw `procedure_already_exists`.
import { fc } from '@fast-check/vitest';
import { describe, expect, test, vi } from 'vitest';
import type { RegisterOp } from '../../src/core/contracts.js';
import { MessageType, Uri } from '../../src/protocol/codes.js';
import { registerFrame, unregisterFrame, yieldFrame, type InboundMessage } from '../../src/protocol/messages.js';
import { LATE_LIMIT } from '../../src/ops/topic.js';
import { GHOST_RETRY, RegisterParticipant } from '../../src/ops/register.js';
import type { InvocationMessage, RegisteredMessage } from '../../src/types.js';
import { snapshotRegister } from '../../src/validate.js';
import {
  createFakeCtx,
  createFakeEffects,
  fakeEndInfo,
  fakeRegisterOp,
  inbound,
  nextSeq,
  type FakeSessionCtx,
  type FakeSubscriber,
} from '../helpers/fake-ctx.js';
import { replayParameters } from '../setup-fast-check.js';

// The properties generate up to 60 commands per run (`size: 'max'`: fast-check's default size caps arrays at 10). The
// time budget scales with FC_NUM_RUNS: 2 ms per run and property, never below the default 5 s.
vi.setConfig({ testTimeout: Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 2) });

const TIMEOUT = 60000;
type Reg = RegisterOp & { readonly subscriber: FakeSubscriber<RegisteredMessage> };

function registration(procedure: string, handler: (invocation: InvocationMessage) => unknown = () => undefined): Reg {
  return fakeRegisterOp(snapshotRegister(procedure, handler, undefined), nextSeq());
}

function setup(connId = 1): {
  readonly reg: RegisterParticipant;
  readonly ctx: FakeSessionCtx;
  readonly route: (ctx: FakeSessionCtx) => void;
} {
  let current: FakeSessionCtx | undefined;
  const reg = new RegisterParticipant({
    requestTimeout: TIMEOUT,
    submit: (input) => {
      if (current !== undefined && 'invocation' in input && input.conn === current.connId) {
        reg.handlerEvent(input, current);
      }
    },
  });
  const route = (ctx: FakeSessionCtx): void => {
    current = ctx;
    ctx.bindTimers('register', reg);
  };
  const ctx = createFakeCtx({ connId, session: { id: connId } });
  route(ctx);
  reg.welcome(ctx);
  return { reg, ctx, route };
}

describe('adoption of a pending REGISTER', () => {
  test('StrictMode: subscribe, unsubscribe, subscribe in one tick ⇒ one REGISTER; the second mount is registered', () => {
    const { reg, ctx } = setup();
    const first = registration('p', () => 'first');
    reg.start(first, ctx, ctx);
    reg.stop(first, ctx, ctx);
    const second = registration('p', () => 'second');
    reg.start(second, ctx, ctx);
    expect(ctx.frames()).toEqual([registerFrame(1, {}, 'p')]);
    reg.inbound(inbound.registered(1, 7), ctx);
    ctx.runDeliveries();
    expect(ctx.frames(MessageType.UNREGISTER)).toEqual([]);
    expect(first.subscriber.notifications).toEqual([]);
    expect(second.subscriber.values).toEqual([{ registrationId: 7, procedure: 'p', sessionId: 1 }]);
    reg.inbound(inbound.invocation(1, 7), ctx);
    ctx.runDeliveries();
    expect(ctx.lastFrame()).toEqual(yieldFrame(1, false, [['second']])); // the last-mounted handler serves
  });

  test("the adopter receives the pending REGISTER's error", () => {
    const { reg, ctx } = setup();
    const first = registration('p');
    reg.start(first, ctx, ctx);
    reg.stop(first, ctx, ctx);
    const second = registration('p');
    reg.start(second, ctx, ctx);
    reg.inbound(inbound.error(MessageType.REGISTER, 1, Uri.NOT_AUTHORIZED), ctx);
    ctx.runDeliveries();
    expect(second.subscriber.errors[0]).toMatchObject({ uri: Uri.NOT_AUTHORIZED, procedure: 'p' });
    expect(first.subscriber.notifications).toEqual([]);
  });

  test('a stopped REGISTER nobody adopted: REGISTERED ⇒ UNREGISTER; ERROR ⇒ dropped silently', () => {
    const { reg, ctx } = setup();
    const a = registration('a');
    const b = registration('b');
    reg.start(a, ctx, ctx);
    reg.start(b, ctx, ctx);
    reg.stop(a, ctx, ctx);
    reg.stop(b, ctx, ctx);
    expect(reg.inbound(inbound.registered(1, 7), ctx)).toBe(true);
    expect(ctx.lastFrame()).toEqual(unregisterFrame(3, 7));
    expect(reg.inbound(inbound.error(MessageType.REGISTER, 2, Uri.PROCEDURE_ALREADY_EXISTS), ctx)).toBe(true);
    ctx.runDeliveries();
    expect([a.subscriber.notifications, b.subscriber.notifications]).toEqual([[], []]);
    expect([...reg.pendingIds()]).toEqual([3]);
  });

  test('a stopped REGISTER whose registration id is in use by another record is not UNREGISTERed', () => {
    const { reg, ctx } = setup();
    const live = registration('p');
    reg.start(live, ctx, ctx);
    reg.inbound(inbound.registered(1, 7), ctx);
    const gone = registration('p'); // a second live registration of one key: its own REGISTER (no dedupe)
    reg.start(gone, ctx, ctx);
    expect(ctx.frames(MessageType.REGISTER)).toHaveLength(2);
    reg.stop(gone, ctx, ctx);
    reg.inbound(inbound.registered(2, 7), ctx); // a router that hands out the same id again
    expect(ctx.frames(MessageType.UNREGISTER)).toEqual([]);
  });

  test('switchMap re-keying: unsubscribe right after REGISTERED, subscribe before UNREGISTERED ⇒ UNREGISTER, REGISTER', () => {
    const { reg, ctx } = setup();
    const first = registration('p');
    reg.start(first, ctx, ctx);
    reg.inbound(inbound.registered(1, 7), ctx);
    reg.stop(first, ctx, ctx);
    const second = registration('p');
    reg.start(second, ctx, ctx);
    // the transport is ordered: the router handles the UNREGISTER before the new REGISTER
    expect(ctx.frames()).toEqual([registerFrame(1, {}, 'p'), unregisterFrame(2, 7), registerFrame(3, {}, 'p')]);
    reg.inbound(inbound.unregistered(2), ctx);
    reg.inbound(inbound.registered(3, 8), ctx);
    ctx.runDeliveries();
    expect(second.subscriber.values).toEqual([{ registrationId: 8, procedure: 'p', sessionId: 1 }]);
  });

  test('retry after a request timeout adopts the late REGISTER, with a fresh request timer measured from its write', () => {
    const { reg, ctx } = setup();
    ctx.now = 100;
    const first = registration('p');
    reg.start(first, ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.runDeliveries();
    expect(first.subscriber.errors[0]).toMatchObject({ name: 'TimeoutError', procedure: 'p' });
    const retry = registration('p');
    reg.start(retry, ctx, ctx);
    expect(ctx.frames(MessageType.REGISTER)).toHaveLength(1);
    expect(ctx.armedTimers('register').map((t) => [t.key, t.armedAt, t.deadline])).toEqual([[1, TIMEOUT + 100, true]]);
    reg.stop(first, ctx, ctx); // the errored stream's teardown runs late: it must not un-adopt the retry
    ctx.advance(TIMEOUT);
    expect(ctx.verdicts.map((v) => v.since)).toEqual([100, 100]);
    reg.inbound(inbound.registered(1, 7), ctx);
    ctx.runDeliveries();
    expect(retry.subscriber.values).toEqual([{ registrationId: 7, procedure: 'p', sessionId: 1 }]);
    ctx.resolveVerdicts('alive'); // the second verdict comes too late: answered
    ctx.runDeliveries();
    expect(retry.subscriber.errors).toEqual([]);
  });

  test('a late REGISTER expires lazily `request` ms after its timeout; then a re-subscription registers anew', () => {
    const { reg, ctx } = setup();
    reg.start(registration('p'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.advance(TIMEOUT);
    const again = registration('p');
    reg.start(again, ctx, ctx); // the access that forgets the late REGISTER first
    expect(ctx.frames(MessageType.REGISTER)).toEqual([registerFrame(1, {}, 'p'), registerFrame(2, {}, 'p')]);
    expect(reg.inbound(inbound.registered(1, 7), ctx)).toBe(true); // the forgotten one's answer: withdrawn
    expect(ctx.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([7]);
    expect(reg.sizes()).toMatchObject({ records: 1, ops: 1, late: 0 }); // the forgotten record is gone (no leak)
    expect(ctx.logged('request.timeout')).toEqual([
      {
        level: 'debug',
        event: 'request.timeout',
        message: 'late REGISTER 1 forgotten',
        data: { requestId: 1, procedure: 'p' },
      },
    ]);
  });

  test('the expiry is checked by inbound frames and timers too, not only by start', () => {
    const { reg, ctx } = setup();
    reg.start(registration('p'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    ctx.advance(TIMEOUT);
    expect(reg.inbound(inbound.registered(1, 7), ctx)).toBe(true); // forgotten before routing, so withdrawn
    expect(ctx.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([7]);

    const second = setup();
    second.reg.start(registration('p'), second.ctx, second.ctx);
    second.ctx.advance(TIMEOUT);
    second.ctx.resolveVerdicts('alive');
    second.ctx.advance(TIMEOUT);
    second.reg.timer(99, second.ctx); // any timer input
    expect([...second.reg.pendingIds()]).toEqual([]);
  });

  test('two live subscriptions of one key while the first REGISTER is pending: two REGISTERs (no dedupe)', () => {
    const { reg, ctx } = setup();
    const a = registration('p');
    const b = registration('p');
    reg.start(a, ctx, ctx);
    reg.start(b, ctx, ctx);
    expect(ctx.frames()).toEqual([registerFrame(1, {}, 'p'), registerFrame(2, {}, 'p')]);
    reg.inbound(inbound.registered(1, 7), ctx);
    reg.inbound(inbound.error(MessageType.REGISTER, 2, Uri.PROCEDURE_ALREADY_EXISTS), ctx);
    ctx.runDeliveries();
    expect(a.subscriber.values).toHaveLength(1);
    expect(b.subscriber.errors[0]).toMatchObject({ uri: Uri.PROCEDURE_ALREADY_EXISTS });
  });

  test('an adopted REGISTER whose session ends before the answer is REGISTERed again at the next WELCOME', () => {
    const { reg, ctx, route } = setup();
    const first = registration('p');
    reg.start(first, ctx, ctx);
    reg.stop(first, ctx, ctx);
    const second = registration('p');
    reg.start(second, ctx, ctx); // adopts request 1
    ctx.endSession();
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    const next = createFakeCtx({ connId: 2, session: { id: 2 } });
    route(next);
    reg.welcome(next);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'p')]);
    reg.inbound(inbound.registered(1, 8), next);
    next.runDeliveries();
    expect(second.subscriber.values).toEqual([{ registrationId: 8, procedure: 'p', sessionId: 2 }]);
  });

  test('late REGISTERs are capped per session: the oldest is forgotten first', () => {
    const { reg, ctx } = setup();
    for (let i = 0; i <= LATE_LIMIT; i++) reg.start(registration(`p${String(i)}`), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    expect([...reg.pendingIds()]).toHaveLength(LATE_LIMIT);
    expect(reg.inbound(inbound.registered(1, 5), ctx)).toBe(true); // the forgotten oldest: withdrawn
    expect(reg.inbound(inbound.registered(2, 6), ctx)).toBe(true);
    expect(ctx.frames(MessageType.UNREGISTER).map((f) => f[2])).toEqual([5, 6]); // 6: late, nobody adopted it
  });

  test('stopped and late records are deleted at the session end and never REGISTERed in the next session', () => {
    const { reg, ctx, route } = setup();
    const stopped = registration('stopped');
    reg.start(stopped, ctx, ctx);
    reg.stop(stopped, ctx, ctx);
    reg.start(registration('late'), ctx, ctx);
    ctx.advance(TIMEOUT);
    ctx.resolveVerdicts('alive');
    const kept = registration('kept');
    reg.start(kept, ctx, ctx);
    ctx.endSession();
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    const next = createFakeCtx({ connId: 2, session: { id: 2 } });
    route(next);
    reg.welcome(next);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'kept')]);
  });

  test('a stopped REGISTER of the previous session is not adoptable: a new mount REGISTERs in the new session', () => {
    const { reg, ctx, route } = setup();
    const first = registration('p');
    reg.start(first, ctx, ctx);
    reg.stop(first, ctx, ctx);
    ctx.endSession();
    reg.sessionEnded(fakeEndInfo(), createFakeEffects());
    const next = createFakeCtx({ connId: 2, session: { id: 2 } });
    route(next);
    reg.welcome(next);
    const second = registration('p');
    reg.start(second, next, next);
    expect(next.frames()).toEqual([registerFrame(1, {}, 'p')]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property: remount cycles against a single-invoke router
// ---------------------------------------------------------------------------------------------------------------------

/** A dealer with `invoke: single` registrations shared by every session (ours, and our ghosts). */
class Dealer {
  readonly inbox: { readonly session: number; readonly frame: readonly unknown[] }[] = [];
  readonly outbox: InboundMessage[] = [];
  /** procedure → owning session + registration id. */
  readonly registrations = new Map<string, { readonly session: number; readonly id: number }>();
  readonly ghosts = new Set<number>();
  readonly violations: string[] = [];
  private nextId = 500;

  process(): boolean {
    const next = this.inbox.shift();
    if (next === undefined) return false;
    const { session, frame } = next;
    if (frame[0] === MessageType.REGISTER) {
      const requestId = frame[1] as number;
      const procedure = frame[3] as string;
      if (this.registrations.has(procedure)) {
        this.outbox.push(inbound.error(MessageType.REGISTER, requestId, Uri.PROCEDURE_ALREADY_EXISTS));
      } else {
        const id = this.nextId++;
        this.registrations.set(procedure, { session, id });
        this.outbox.push(inbound.registered(requestId, id));
      }
    } else if (frame[0] === MessageType.UNREGISTER) {
      const requestId = frame[1] as number;
      const entry = [...this.registrations].find(([, r]) => r.id === frame[2] && r.session === session);
      if (entry === undefined) {
        this.violations.push(`UNREGISTER of ${String(frame[2])}, not a registration of session ${String(session)}`);
        this.outbox.push(inbound.error(MessageType.UNREGISTER, requestId, Uri.NO_SUCH_REGISTRATION));
      } else {
        this.registrations.delete(entry[0]);
        this.outbox.push(inbound.unregistered(requestId));
      }
    } else if (frame[0] !== MessageType.YIELD && frame[0] !== MessageType.ERROR) {
      this.violations.push(`unexpected frame ${JSON.stringify(frame)}`);
    }
    return true;
  }

  /** Our session ended: the router noticed (registrations removed) or not (a ghost keeps them). */
  drop(session: number, ghost: boolean): void {
    this.inbox.length = 0;
    this.outbox.length = 0;
    if (ghost) this.ghosts.add(session);
    else this.removeSession(session);
  }

  evictGhosts(): void {
    for (const ghost of this.ghosts) this.removeSession(ghost);
    this.ghosts.clear();
  }

  private removeSession(session: number): void {
    for (const [procedure, r] of [...this.registrations])
      if (r.session === session) this.registrations.delete(procedure);
  }
}

const PROCEDURES = ['p', 'q'] as const;

type Command =
  | { readonly kind: 'toggle'; readonly procedure: number }
  | { readonly kind: 'router'; readonly count: number }
  | { readonly kind: 'deliver'; readonly count: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'drop'; readonly ghost: boolean }
  | { readonly kind: 'evict' };

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('toggle'), procedure: fc.nat(PROCEDURES.length - 1) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('router'), count: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('deliver'), count: fc.integer({ min: 1, max: 3 }) }) },
  // at most 60 × 4 s: the run stays inside the 300 s ghost window
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('advance'), ms: fc.constantFrom(1000, 2000, 4000) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('drop'), ghost: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'evict' as const }) },
);

function run(commands: readonly Command[]): void {
  const dealer = new Dealer();
  let current: FakeSessionCtx | undefined;
  const reg = new RegisterParticipant({
    requestTimeout: 10 * 60000, // no request timeouts in this model
    submit: (input) => {
      if (current !== undefined && 'invocation' in input && input.conn === current.connId) {
        reg.handlerEvent(input, current);
      }
    },
  });
  const mounted = new Map<string, Reg>();
  const all: Reg[] = [];
  const ended: FakeSessionCtx[] = [];
  let connId = 0;
  let now = 0;
  let ctx = createFakeCtx();
  let seen = 0;
  /** REGISTERs written and not answered yet (request id → procedure), and the registration ids received, this session. */
  const outstanding = new Map<number, string>();
  const received = new Set<number>();

  const collect = (): void => {
    for (; seen < ctx.written.length; seen++) {
      const frame = ctx.written[seen]!.frame;
      if (frame[0] === MessageType.REGISTER) {
        expect([...outstanding.values()], 'two outstanding REGISTERs for one procedure').not.toContain(frame[3]);
        outstanding.set(frame[1], frame[3]);
      } else if (frame[0] === MessageType.UNREGISTER) {
        expect(received.has(frame[2]), 'UNREGISTER of an id not received in this session').toBe(true);
      }
      dealer.inbox.push({ session: connId, frame });
    }
  };
  const begin = (): void => {
    connId++;
    ctx = createFakeCtx({ connId, session: { id: connId }, now });
    current = ctx;
    ctx.bindTimers('register', reg);
    seen = 0;
    outstanding.clear();
    received.clear();
    reg.welcome(ctx);
    collect();
  };
  const deliver = (msg: InboundMessage): void => {
    if (msg.type === MessageType.REGISTERED || msg.type === MessageType.ERROR) outstanding.delete(msg.requestId);
    if (msg.type === MessageType.REGISTERED) received.add(msg.registrationId);
    reg.inbound(msg, ctx);
  };
  begin();

  const step = (cmd: Command): void => {
    switch (cmd.kind) {
      case 'toggle': {
        const procedure = PROCEDURES[cmd.procedure]!;
        const op = mounted.get(procedure);
        if (op === undefined) {
          const fresh: Reg = registration(procedure, () => fresh.seq); // the handler answers with its mount's seq
          mounted.set(procedure, fresh);
          all.push(fresh);
          reg.start(fresh, ctx, ctx);
        } else {
          mounted.delete(procedure);
          op.subscriber.unsubscribe();
          reg.stop(op, ctx, ctx);
        }
        break;
      }
      case 'router':
        for (let i = 0; i < cmd.count; i++) dealer.process();
        break;
      case 'deliver':
        for (let i = 0; i < cmd.count; i++) {
          const msg = dealer.outbox.shift();
          if (msg === undefined) break;
          deliver(msg);
        }
        break;
      case 'advance':
        now += cmd.ms;
        ctx.advance(cmd.ms);
        break;
      case 'drop':
        ctx.endSession();
        ended.push(ctx);
        reg.sessionEnded(fakeEndInfo(), createFakeEffects());
        dealer.drop(connId, cmd.ghost);
        begin();
        // stopped and late records did not survive the session end (no leak)
        expect(reg.sizes().records, 'records after a session end').toBe(mounted.size);
        break;
      case 'evict':
        dealer.evictGhosts();
        break;
    }
    ctx.runDeliveries();
    collect();
    expect(reg.sizes().ops, 'subscriptions held by the participant').toBe(mounted.size);
  };
  for (const cmd of commands) step(cmd);

  // heal: ghosts evicted, every request answered, ghost retries fired (≤ 30 s apart) until nothing is pending
  dealer.evictGhosts();
  for (let round = 0; round < 50; round++) {
    while (dealer.process());
    for (let msg = dealer.outbox.shift(); msg !== undefined; msg = dealer.outbox.shift()) deliver(msg);
    ctx.runDeliveries();
    collect();
    if (dealer.inbox.length === 0 && ctx.armedTimers('register').length === 0) break;
    step({ kind: 'advance', ms: GHOST_RETRY.cap });
  }
  expect(dealer.violations).toEqual([]);
  for (const old of ended) expect(old.refused, 'a write into an ended session').toEqual([]);
  // no stream ever errored: no genuine conflict, and every ghost was ridden out inside the window
  for (const op of all) expect(op.subscriber.errors).toEqual([]);
  // exactly one registration per mounted procedure, owned by the current session, announced to the last mount
  for (const procedure of PROCEDURES) {
    const op = mounted.get(procedure);
    const registered = dealer.registrations.get(procedure);
    if (op === undefined) {
      expect(registered, `a leaked registration of ${procedure}`).toBeUndefined();
      continue;
    }
    expect(registered?.session).toBe(connId);
    expect(op.subscriber.values.at(-1)).toEqual({ registrationId: registered!.id, procedure, sessionId: connId });
    // a CALL from another client is answered once, by the last-mounted handler
    reg.inbound(inbound.invocation(9000 + op.seq, registered!.id), ctx);
    ctx.runDeliveries();
    expect(ctx.lastFrame()).toEqual(yieldFrame(9000 + op.seq, false, [[op.seq]]));
  }
  // no leak (INV-R10): one record per mounted procedure, nothing pending, late, running or waiting
  expect(reg.sizes()).toMatchObject({
    records: mounted.size,
    ops: mounted.size,
    requests: 0,
    late: 0,
    invocations: 0,
    ghostTimers: 0,
  });
}

describe('property: remount cycles with session drops and ghosts', () => {
  test('exactly one registration per mounted procedure, by the last mount; no stream error; no stray frames', () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 60, size: 'max' }), (commands) => {
        run(commands);
      }),
      replayParameters(),
    );
  });

  test('the StrictMode cycle against the dealer: mount, unmount, mount before the router answers', () => {
    run([
      { kind: 'toggle', procedure: 0 },
      { kind: 'toggle', procedure: 0 },
      { kind: 'toggle', procedure: 0 },
      { kind: 'router', count: 1 },
      { kind: 'deliver', count: 1 },
    ]);
  });

  test('a drop that leaves a ghost: the re-REGISTER meets procedure_already_exists until the ghost is evicted', () => {
    run([
      { kind: 'toggle', procedure: 0 },
      { kind: 'router', count: 1 },
      { kind: 'deliver', count: 1 },
      { kind: 'drop', ghost: true },
      { kind: 'router', count: 1 },
      { kind: 'deliver', count: 1 },
      { kind: 'advance', ms: 1000 },
      { kind: 'router', count: 1 },
      { kind: 'deliver', count: 1 },
      { kind: 'toggle', procedure: 0 }, // a remount while the ghost holds the procedure (key memory)
      { kind: 'toggle', procedure: 0 },
      { kind: 'router', count: 1 },
      { kind: 'deliver', count: 1 },
    ]);
  });
});
