// A test of the model itself: it catches a deliberately broken participant within the CI budget.
// The broken RegisterParticipant keys running invocations by INVOCATION id instead of by the Invocation object (and
// (conn, record)): a handler result is routed to the session that is current when it arrives, to whatever invocation
// has that id there, and ending an invocation only drops its map entry (its result keeps running). With per-session
// router ids, a deferred handler result of a lost session then answers a new session's INVOCATION with the same id —
// a stale YIELD carrying another call's tag — which the model's router-call check reports.
import fc from 'fast-check';
import { afterEach, describe, expect, test } from 'vitest';
import type { HandlerEvent, SessionCtx } from '../../src/core/contracts.js';
import { RegisterParticipant } from '../../src/ops/register.js';
import { modelProperty } from './commands.js';
import { configArb } from './model.js';

/** The configurations where keying by id is observable at all — per-session router ids: with unique or random
 *  ids a stale result can never meet a live invocation with its id, so the broken participant behaves correctly —
 *  and with the model's busy router-side caller, which keeps the client's registrations in use. */
const observable = configArb().filter((cfg) => cfg.routerIds === 'per-session' && cfg.traffic);

type Method<A extends unknown[]> = (this: Internals, ...args: A) => void;
interface Internals {
  deps: { readonly submit: (input: unknown) => void };
  s: { connId: number; invocations: Map<number, object> } | undefined;
  readonly session: (this: Internals, ctx: SessionCtx) => { invocations: Map<number, object> };
  run: Method<unknown[]>;
  handlerEvent: Method<[HandlerEvent, SessionCtx]>;
  abortInvocation: Method<[{ id: number; done: boolean }, unknown, { invocations: Map<number, object> }]>;
}

const proto = RegisterParticipant.prototype as unknown as Internals;
const original = { run: proto.run, handlerEvent: proto.handlerEvent, abortInvocation: proto.abortInvocation };

/** Install the broken participant: results keyed by (current session, invocation id). */
function breakParticipant(): void {
  proto.run = function (this: Internals, ...args: unknown[]): void {
    const real = this.deps;
    if (!(real as { broken?: boolean }).broken) {
      this.deps = {
        ...real,
        broken: true,
        submit: (input: unknown) => {
          const ev = input as HandlerEvent;
          if (!ev.kind.startsWith('handler.')) {
            real.submit(input);
            return;
          }
          const id = (ev.invocation as { id: number }).id;
          real.submit({ ...ev, conn: this.s?.connId ?? ev.conn, invocation: { id } });
        },
      } as Internals['deps'];
    }
    original.run.apply(this, args);
  };
  proto.handlerEvent = function (this: Internals, ev: HandlerEvent, ctx: SessionCtx): void {
    const found = this.session.call(this, ctx).invocations.get((ev.invocation as { id: number }).id);
    if (found !== undefined) original.handlerEvent.call(this, { ...ev, invocation: found }, ctx);
  };
  proto.abortInvocation = function (this: Internals, invocation, _reason, s): void {
    invocation.done = true;
    s.invocations.delete(invocation.id); // the id is all it keys by: the running result is left alone
  };
}

afterEach(() => {
  proto.run = original.run;
  proto.handlerEvent = original.handlerEvent;
  proto.abortInvocation = original.abortInvocation;
});

describe('the model catches a participant that keys invocations by id', () => {
  test('within the CI budget (200 runs)', async () => {
    breakParticipant();
    const result = await fc.check(modelProperty({ config: observable }), { numRuns: 200, seed: 1 });
    expect(result.failed, 'the broken participant was not caught').toBe(true);
    expect(String(result.errorInstance)).toMatch(/was answered|a progress result of|INV-INVOKE|INV-CL02/);
  }, 600000);

  test('the correct participant passes the same runs', async () => {
    const result = await fc.check(modelProperty({ config: observable }), { numRuns: 200, seed: 1 });
    expect(result.failed, String(result.errorInstance)).toBe(false);
  }, 600000);
});
