/**
 * Every action of the core's transition table (and of inbound routing, end/close, hardReset, the liveness verdict path
 * and the facade's op creation) type-checks against src/core/contracts.ts *alone*: this file imports nothing else, and
 * derives every other type it needs from the contracts. If a contract cannot express an action the core must perform,
 * this file stops compiling.
 */
import { describe, expectTypeOf, test } from 'vitest';
import type {
  AnyOp,
  BaseOp,
  CallOp,
  CallSnapshot,
  ChallengeRunner,
  ChallengeRunnerDeps,
  ConnId,
  CoreInput,
  Effects,
  EndInfo,
  HandlerEvent,
  InterestOp,
  InterestParticipant,
  InvocationRef,
  Liveness,
  LivenessHost,
  OneShotOp,
  OneShotParticipant,
  OpFactories,
  OpSubscriber,
  ParticipantDeps,
  ParticipantName,
  PublishOp,
  PublishSnapshot,
  RegisterOp,
  RegisterParticipant,
  RegisterSnapshot,
  Seq,
  SessionCtx,
  StopError,
  TimerHandle,
  TopicOp,
  TopicSnapshot,
} from '../../src/core/contracts.js';

// Types the contracts reference, derived from the contracts themselves.
type InboundMessage = Parameters<Liveness['inbound']>[0];
type OutboundFrame = Parameters<SessionCtx['send']>[0];
type ThruwayError = Parameters<ChallengeRunner['cancel']>[0];
type CloseInfo = EndInfo['info'];
type Session = SessionCtx['session'];
type LogEntry = ReturnType<Parameters<Effects['log']>[0]>;
type ResultMessage = Parameters<CallOp['subscriber']['next']>[0];
type RegisteredMessage = Parameters<RegisterOp['subscriber']['next']>[0];
type InvocationHandler = RegisterSnapshot['handler'];

// The core's collaborators, typed by the contracts only.
declare const call: OneShotParticipant<CallOp>;
declare const publish: OneShotParticipant<PublishOp>;
declare const topic: InterestParticipant<TopicOp>;
declare const register: RegisterParticipant;
declare const liveness: Liveness;
declare const runner: ChallengeRunner;
declare const factories: OpFactories;
declare const ctx: SessionCtx;
declare const fx: Effects;
declare const fifo: OneShotOp[];
/** The per-record error of a stop: what clientClosed and the core's queued-op failure use. */
declare const stopError: StopError;
const contextOf = (op: AnyOp) =>
  op.kind === 'call' || op.kind === 'register' ? { procedure: op.snap.procedure } : { topic: op.snap.topic };
declare const canceled: ThruwayError;
declare function submit(input: CoreInput): void;
declare function write(frame: OutboundFrame): boolean;
declare function endInfo(info: CloseInfo): EndInfo;
declare const op: CallOp;
declare const conn: ConnId;
declare const round: number;
declare const e: EndInfo;
declare const live: readonly AnyOp[];
declare const lost: ThruwayError;
declare const seq: Seq;
declare const callSnap: CallSnapshot;
declare const publishSnap: PublishSnapshot;
declare const topicSnap: TopicSnapshot;
declare const registerSnap: RegisterSnapshot;
declare const resultSubscriber: OpSubscriber<ResultMessage>;
declare const registeredSubscriber: OpSubscriber<RegisteredMessage>;
declare const deps: ParticipantDeps;
declare const runnerDeps: ChallengeRunnerDeps;
declare const host: LivenessHost;

const participants = { call, publish, topic, register } as const;
const interests = [register, topic] as const; // welcome order: register, topic

function participantOf(
  op: AnyOp,
): OneShotParticipant<CallOp> | OneShotParticipant<PublishOp> | InterestParticipant<TopicOp> | RegisterParticipant {
  return participants[op.kind];
}

/** One-shot write, with the 'not-sent' ⇒ stays queued rule (op.start in ESTABLISHED, the WELCOME drain). */
function writeOneShot(op: OneShotOp, session: SessionCtx): 'done' | 'not-sent' {
  return op.kind === 'call' ? call.write(op, session) : publish.write(op, session);
}

/** op.start / op.stop for any record, with or without a session. */
function startOp(op: AnyOp, session: SessionCtx | undefined, stopped: boolean): void {
  if (stopped) {
    const error = stopError(contextOf(op));
    fx.deliver(() => {
      op.subscriber.error(error);
    });
    return;
  }
  switch (op.kind) {
    case 'topic':
      topic.start(op, session, fx);
      return;
    case 'register':
      register.start(op, session, fx);
      return;
    case 'call':
    case 'publish':
      if (session === undefined || fifo.length > 0) fifo.push(op);
      else if (writeOneShot(op, session) === 'not-sent') fifo.push(op);
      return;
  }
}

function stopOp(op: AnyOp, session: SessionCtx | undefined): void {
  if (op.kind === 'call' || op.kind === 'publish') {
    const queued = fifo.indexOf(op);
    if (queued >= 0) {
      fifo.splice(queued, 1);
      return;
    }
  }
  switch (op.kind) {
    case 'call':
      call.stop(op, session, fx);
      return;
    case 'publish':
      publish.stop(op, session, fx);
      return;
    case 'topic':
      topic.stop(op, session, fx);
      return;
    case 'register':
      register.stop(op, session, fx);
      return;
  }
}

/** WELCOME: cancel a pending challenge, start liveness, re-establish interests, drain the FIFO. */
function welcome(session: SessionCtx, details: Readonly<Record<string, unknown>>, challenged: boolean): void {
  if (challenged)
    fx.deliver(() => {
      runner.cancel(canceled);
    });
  const roles = details['roles'];
  liveness.start(
    session,
    typeof roles === 'object' && roles !== null ? (roles as Readonly<Record<string, unknown>>) : {},
  );
  for (const participant of interests) participant.welcome(session);
  while (fifo.length > 0) {
    const op = fifo[0]!;
    if (writeOneShot(op, session) === 'not-sent') break;
    fifo.shift();
  }
}

/** Inbound routing in ESTABLISHED. Returns whether a participant consumed it. */
function route(msg: InboundMessage, session: SessionCtx): boolean {
  if (liveness.inbound(msg, session)) return true;
  switch (msg.type) {
    case 50:
      return call.inbound(msg, session);
    case 8:
      if (msg.requestType === 48 || msg.requestType === 49) return call.inbound(msg, session);
      if (msg.requestType === 16) return publish.inbound(msg, session);
      if (msg.requestType === 32 || msg.requestType === 34) return topic.inbound(msg, session);
      if (msg.requestType === 64 || msg.requestType === 66) return register.inbound(msg, session);
      return false; // other request types are dropped
    case 17:
      return publish.inbound(msg, session);
    case 33:
    case 35:
    case 36:
      return topic.inbound(msg, session);
    case 65:
    case 67:
    case 68:
    case 69:
      return register.inbound(msg, session);
    case 2:
    case 4:
      return false; // WELCOME / CHALLENGE in a session: dropped (warn)
    case 3:
    case 6:
      return true; // ABORT / GOODBYE: handled by the core itself
  }
}

/** The end procedure's participant-facing steps. */
function end(info: CloseInfo, hadSession: boolean, byLiveness: boolean): void {
  liveness.sessionEnded(byLiveness);
  if (hadSession) {
    const e = endInfo(info);
    for (const participant of [call, publish, topic, register] as const) participant.sessionEnded(e, fx);
  } else {
    fx.deliver(() => {
      runner.cancel(canceled);
    });
  }
  if (!info.willRetry) {
    for (const participant of [call, publish, topic, register] as const) participant.clientClosed(stopError, fx);
    for (const op of fifo.splice(0)) {
      const error = stopError(contextOf(op));
      fx.deliver(() => {
        op.subscriber.error(error);
      });
    }
  }
}

/** One step: every input kind is handled (exhaustive). */
function step(input: CoreInput, session: SessionCtx | undefined, stopped: boolean): void {
  switch (input.kind) {
    case 'open':
      if (session !== undefined) liveness.check(session);
      return;
    case 'reconnect':
      if (session !== undefined) write([6, {}, 'wamp.close.close_realm']);
      return;
    case 'close':
      if (session !== undefined) write([6, {}, 'wamp.close.close_realm']);
      for (const participant of [call, publish, topic, register] as const) participant.clientClosed(stopError, fx);
      input.resolve();
      return;
    case 'op.start':
      startOp(input.op, session, stopped);
      return;
    case 'op.stop':
      stopOp(input.op, session);
      return;
    case 'url.ok':
      expectTypeOf(input.url).toBeUnknown();
      return;
    case 'url.fail':
    case 'challenge.fail':
      expectTypeOf(input.error).toBeUnknown();
      return;
    case 'challenge.ok':
      write([5, input.signature, {}]);
      return;
    case 'handler.next':
    case 'handler.complete':
    case 'handler.error':
      if (session !== undefined) register.handlerEvent(input, session);
      return;
    case 'ws.open':
      write([1, 'realm1', { agent: 'thruway.js/3.0.0' }]);
      return;
    case 'ws.message':
      expectTypeOf(input.data).toBeUnknown();
      return;
    case 'ws.closed':
      expectTypeOf(input).toHaveProperty('wasClean').toEqualTypeOf<boolean>();
      return;
    case 'timer.idle':
      if (session !== undefined) liveness.onIdle(session);
      return;
    case 'timer.ping':
      if (session !== undefined && liveness.onPing(session) === 'dead')
        write([3, { message: 'x' }, 'wamp.error.protocol_violation']);
      return;
    case 'timer.op':
      if (session !== undefined) participants[input.owner].timer(input.key, session);
      return;
    case 'timer.retry':
    case 'timer.connect':
    case 'timer.handshake':
    case 'timer.challenge':
    case 'timer.stable':
    case 'timer.goodbye':
      expectTypeOf(input.gen).toBeNumber();
      return;
    default:
      input satisfies never;
  }
}

describe('core/contracts.ts expresses every core action', () => {
  test('API inputs: open, reconnect, close, op.start, op.stop', () => {
    expectTypeOf(step).parameter(0).toEqualTypeOf<CoreInput>();
    expectTypeOf(startOp).toBeFunction();
    expectTypeOf(stopOp).toBeFunction();
    expectTypeOf(participantOf).returns.toHaveProperty('name').toEqualTypeOf<ParticipantName>();
  });
  test('one-shots: write outcomes and the waiting FIFO', () => {
    expectTypeOf(call.write(op, ctx)).toEqualTypeOf<'done' | 'not-sent'>();
    expectTypeOf(writeOneShot).returns.toEqualTypeOf<'done' | 'not-sent'>();
    expectTypeOf(fifo).items.toEqualTypeOf<CallOp | PublishOp>();
  });
  test('handshake: challenge runner and AUTHENTICATE', () => {
    fx.deliver(() => {
      runner.run(conn, round, { authMethod: 'ticket', extra: {} });
    });
    expectTypeOf<ChallengeRunner['cancel']>().parameter(0).toEqualTypeOf<ThruwayError>();
    expectTypeOf<Extract<CoreInput, { kind: 'challenge.ok' }>>().toEqualTypeOf<{
      kind: 'challenge.ok';
      conn: ConnId;
      round: number;
      signature: string;
    }>();
  });
  test('WELCOME: liveness start, interest re-establishment, FIFO drain', () => {
    expectTypeOf(welcome).parameters.toEqualTypeOf<[SessionCtx, Readonly<Record<string, unknown>>, boolean]>();
    expectTypeOf(ctx.session).toEqualTypeOf<Session>();
  });
  test('ESTABLISHED: routing, timers, handler results, open() check', () => {
    expectTypeOf(route).returns.toEqualTypeOf<boolean>();
    expectTypeOf(liveness.onPing(ctx)).toEqualTypeOf<'alive' | 'dead'>();
    expectTypeOf<Extract<CoreInput, HandlerEvent>>().toEqualTypeOf<HandlerEvent>();
    expectTypeOf<HandlerEvent['invocation']>().toEqualTypeOf<InvocationRef>();
  });
  test('session ctx: writes, request ids, timers, verdicts, violations', () => {
    expectTypeOf<SessionCtx['send']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf(ctx.request((id) => [48, id, {}, 'thruway.js.ping'], true)).toEqualTypeOf<number | undefined>();
    expectTypeOf(ctx.timer(60000, 'topic', 7, true)).toEqualTypeOf<TimerHandle>();
    ctx.verifyAlive(ctx.now, () => {
      ctx.log(() => ({ level: 'debug', event: 'frame.dropped', message: 'verdict' }) satisfies LogEntry);
    });
    ctx.violation('bad frame', [99]);
    // what the core does inside ctx.request / ctx.verifyAlive
    liveness.wrote(true, ctx);
    liveness.verifyAlive(0, () => undefined, ctx);
    const pending: number[] = [
      ...call.pendingIds(),
      ...publish.pendingIds(),
      ...topic.pendingIds(),
      ...register.pendingIds(),
    ];
    expectTypeOf(pending).toEqualTypeOf<number[]>();
  });
  test('end procedure, close procedure, give-up', () => {
    expectTypeOf(end).parameters.toEqualTypeOf<[CloseInfo, boolean, boolean]>();
    expectTypeOf(e.inflightError({ requestId: 1, procedure: 'p' })).toEqualTypeOf<ThruwayError>();
    expectTypeOf(e.info.willRetry).toEqualTypeOf<boolean>();
  });
  test('hardReset: every live record restarts in fresh participants or errors', () => {
    for (const op of live) {
      if (op.kind === 'topic' || op.kind === 'register') startOp(op, undefined, false);
      else
        fx.deliver(() => {
          op.subscriber.error(lost);
        });
    }
    expectTypeOf<InterestOp>().toEqualTypeOf<TopicOp | RegisterOp>();
    expectTypeOf<AnyOp>().toExtend<BaseOp>();
  });
  test('facade: op factories from validated snapshots', () => {
    expectTypeOf(factories.newCallOp(seq, callSnap, resultSubscriber)).toEqualTypeOf<CallOp>();
    expectTypeOf<OpFactories['newPublishOp']>().returns.toEqualTypeOf<PublishOp>();
    expectTypeOf<OpFactories['newTopicOp']>().returns.toEqualTypeOf<TopicOp>();
    expectTypeOf(factories.newRegisterOp(seq, registerSnap, registeredSubscriber)).toEqualTypeOf<RegisterOp>();
    expectTypeOf(publishSnap.ack).toEqualTypeOf<boolean>();
    expectTypeOf(topicSnap.key).toEqualTypeOf<string>();
    expectTypeOf(registerSnap.handler).toEqualTypeOf<InvocationHandler>();
    submit({ kind: 'op.start', op: factories.newCallOp(seq, callSnap, resultSubscriber) });
  });
  test('constructor dependencies', () => {
    deps.submit({ kind: 'handler.complete', conn: 1, invocation: {}, hasValue: false });
    runnerDeps.submit({ kind: 'challenge.ok', conn: 1, round: 1, signature: '' });
    host.armIdle(ctx, host.idle);
    host.armPing(ctx, host.pingBudget);
    host.cancelPing(ctx);
    host.later(ctx, () => undefined);
    expectTypeOf(host.bufferedAmount(ctx)).toEqualTypeOf<number>();
    expectTypeOf(deps.requestTimeout).toEqualTypeOf<number>();
    expectTypeOf(runnerDeps.onChallenge).toBeNullable();
  });
});
