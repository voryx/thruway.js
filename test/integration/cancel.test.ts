// Cancel as caller against every router (Thruway T2, T3): unsubscribing an in-flight call always writes
// CANCEL {mode: 'killnowait'} once and settles the call locally — whatever the router answers (Thruway's ERROR typed
// 49, Bondy's internal_error, fox-wamp's silence) and whether or not the callee is interrupted
// (`cancel_interrupts_callee`). A raw callee that does not announce `call_canceling` makes Thruway refuse the CANCEL
// (`not_supported`, and the call keeps running, T2): the client logs `cancel.refused` once per procedure and drops the
// late RESULT. Cancelling a progressive call (Thruway T3: no final message ever) settles too. The same procedure can
// be called again afterwards.
import { expect, test } from 'vitest';
import { firstValue, itClient, eventually, uri, valueOf } from './harness/recorder.js';
import { RawPeer, MSG, NO_ANSWER, type Frame } from './harness/raw-peer.js';
import { cap, describeRouters } from './harness/routers.js';
import { callee, framesOf } from './harness/scenarios.js';

describeRouters('cancel', (r) => {
  test('unsubscribe in flight: one CANCEL killnowait, settled locally, the callee interrupted where forwarded', async () => {
    const procedure = uri('cancel');
    const backend = itClient(r, { name: 'callee' });
    let invoked = 0;
    let aborted: unknown;
    await callee(backend, procedure, (inv) => {
      invoked++;
      inv.signal.addEventListener('abort', () => {
        aborted = inv.signal.reason;
      });
      return new Promise((resolve) =>
        setTimeout(() => {
          resolve('too late');
        }, 3000),
      );
    });
    const app = itClient(r, { name: 'caller' });
    const call = app.observe('call', procedure, app.client.call(procedure));
    await eventually(() => invoked === 1, 5000, 'the INVOCATION');
    call.unsubscribe();
    const cancels = framesOf(app, MSG.CANCEL, 'in');
    expect(cancels.length).toBe(1);
    expect(cancels[0]?.[2]).toEqual({ mode: 'killnowait' });
    const id = cancels[0]?.[1];
    if (cap(r, 'cancel_interrupts_callee') === 'always') {
      await eventually(() => aborted !== undefined, 3000, 'the callee interrupted');
      expect((aborted as { code?: unknown }).code).toBe('canceled');
    }
    if (cap(r, 'cancel_reply') === 'always') {
      // the router's answer to the CANCEL (ERROR typed 48 or 49) arrives and is dropped: the op is already settled
      await eventually(
        () => framesOf(app, MSG.ERROR, 'out').some((f) => (f[1] === 48 || f[1] === 49) && f[2] === id),
        3000,
        'the answer to the CANCEL',
      );
    }
    expect(call.values).toEqual([]);
    expect(call.errored).toBe(false);
    // the same procedure works again (a fresh CALL, a fresh id)
    const again = await firstValue(app.client.call(procedure), 8000);
    expect(again.args).toEqual(['too late']);
    expect(framesOf(app, MSG.CANCEL, 'in').length).toBe(1);
  });

  test('a callee that does not announce call_canceling: the call still settles; a refusal is logged once', async () => {
    const procedure = uri('cancel');
    const raw = await RawPeer.join(r.url, r.realm, { cancel: false });
    try {
      const registered = await raw.register(procedure);
      expect(registered.id).toBeDefined();
      const answers: Frame[] = [];
      raw.serve((inv) => {
        answers.push(inv);
        const request = inv[1] as number;
        setTimeout(() => {
          raw.send([MSG.YIELD, request, {}, ['finished anyway']]);
        }, 300);
        return NO_ANSWER;
      });
      const app = itClient(r, { name: 'caller' });
      for (let i = 0; i < 2; i++) {
        const call = app.observe('call', procedure, app.client.call(procedure));
        await eventually(() => answers.length === i + 1, 5000, 'the INVOCATION');
        call.unsubscribe();
        expect(call.errored).toBe(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const refusals = framesOf(app, MSG.ERROR, 'out').filter((f) => f[4] === 'wamp.error.not_supported');
      // Thruway refuses (T2); every refusal is logged once per procedure and session
      expect(app.logged('cancel.refused').length).toBe(refusals.length > 0 ? 1 : 0);
      expect(app.client.session).toBeDefined();
    } finally {
      raw.close();
    }
  });

  test('cancelling a progressive call settles it (Thruway never sends a final message, T3)', async () => {
    const procedure = uri('cancel');
    const backend = itClient(r, { name: 'callee' });
    let invoked = 0;
    await callee(backend, procedure, () => ({
      subscribe(observer: { next(v: unknown): void }) {
        invoked++;
        const timer = setInterval(() => {
          observer.next('tick');
        }, 50);
        return {
          unsubscribe: () => {
            clearInterval(timer);
          },
        };
      },
    }));
    const app = itClient(r, { name: 'caller' });
    const stream = app.observe('call', procedure, app.client.progressiveCall(procedure));
    // without progressive results (Bondy), or when the callee is not told that the caller asked for progress (Bondy),
    // nothing reaches the caller until the callee's final answer
    if (cap(r, 'progressive_results') === 'always' && cap(r, 'invocation_receive_progress') === 'always')
      await valueOf(stream);
    else await eventually(() => invoked === 1, 5000, 'the INVOCATION');
    stream.unsubscribe();
    expect(framesOf(app, MSG.CANCEL, 'in').map((f) => f[2])).toEqual([{ mode: 'killnowait' }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stream.errored || stream.completed).toBe(false);
    expect(app.client.session).toBeDefined();
  });
});
