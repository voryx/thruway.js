// Cancel as callee against every router (INTERRUPT, Thruway T2, INV-INVOKE): a raw caller cancels a call that a v3
// callee is running, in each CANCEL mode. Where the router forwards an INTERRUPT the handler's signal is aborted with
// CanceledError; for INTERRUPT killnowait the callee writes nothing more for that invocation, for kill (or Thruway's
// mode-less `{}`) exactly one ERROR(68, wamp.error.canceled). A stray `[8, 8, …]` (Thruway after killnowait) is
// dropped. Whatever happens, the registration stays and serves the next call.
import { expect, test } from 'vitest';
import { firstValue, itClient, eventually, uri } from './harness/recorder.js';
import { RawPeer, MSG } from './harness/raw-peer.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, framesOf } from './harness/scenarios.js';

const MODES = [{ mode: 'killnowait' }, { mode: 'kill' }, {}] as const;

describeRouters('callee cancel', (r) => {
  for (const options of MODES) {
    test(`CANCEL ${JSON.stringify(options)}: the handler is interrupted where the router forwards it`, async () => {
      const procedure = uri('calleecancel');
      const backend = itClient(r, { name: 'callee' });
      const invocations: { aborted: unknown }[] = [];
      await callee(backend, procedure, (inv) => {
        const entry = { aborted: undefined as unknown };
        invocations.push(entry);
        inv.signal.addEventListener('abort', () => {
          entry.aborted = inv.signal.reason;
        });
        return new Promise((resolve) =>
          setTimeout(() => {
            resolve('finished');
          }, 1500),
        );
      });
      const caller = await RawPeer.join(r.url, r.realm);
      try {
        const call = caller.call(procedure, [], {}, {}, 5000);
        await eventually(() => invocations.length === 1, 5000, 'the INVOCATION');
        caller.send([MSG.CANCEL, call.id, options]);
        const interrupts = (): readonly (readonly unknown[])[] => framesOf(backend, MSG.INTERRUPT, 'out');
        const forwards =
          'mode' in options ? cap(r, 'cancel_interrupts_callee') : cap(r, 'cancel_without_mode_interrupts');
        if (forwards === 'always') {
          await eventually(() => interrupts().length === 1, 3000, 'the INTERRUPT');
          await eventually(() => invocations[0]?.aborted !== undefined, 2000, 'the handler aborted');
          expect((invocations[0]?.aborted as { code?: unknown }).code).toBe('canceled');
          const interrupt = interrupts()[0];
          const killnowait = (interrupt?.[2] as { mode?: unknown } | undefined)?.mode === 'killnowait';
          await new Promise((resolve) => setTimeout(resolve, 1800)); // past the handler's own answer
          const invocationId = interrupt?.[1];
          const answers = backend
            .trace()
            .frames.filter(
              (f) =>
                f.direction === 'in' &&
                Array.isArray(f.frame) &&
                ((f.frame[0] === MSG.YIELD && f.frame[1] === invocationId) ||
                  (f.frame[0] === MSG.ERROR && f.frame[1] === MSG.INVOCATION && f.frame[2] === invocationId)),
            )
            .map((f) => f.frame as readonly unknown[]);
          if (killnowait) expect(answers).toEqual([]);
          else expect(answers.map((a) => [a[0], a[4]])).toEqual([[MSG.ERROR, 'wamp.error.canceled']]);
        } else if (forwards === 'never') {
          await new Promise((resolve) => setTimeout(resolve, 1800));
          expect(invocations[0]?.aborted).toBeUndefined();
        }
        // the registration still serves calls, and no stray frame ended the callee's session
        const app = itClient(r, { name: 'caller' });
        expect((await firstValue(app.client.call(procedure), 5000)).args).toEqual(['finished']);
        expect(backend.onClose.values).toEqual([]);
      } finally {
        caller.close();
      }
    });
  }
});
