// Authentication against every router: each helper (ticket, wampcra plain and salted, cryptosign) reaches WELCOME; a
// wrong secret is an ABORT (AbortError) followed by backoff that never resets (no WELCOME) and never a hang; two
// offered methods (Thruway sends one CHALLENGE per method and verifies the LAST, Thruway T6) reach WELCOME on the first
// attempt with an asynchronous and with a synchronous onChallenge (the 50 ms settle window), and within 3 attempts
// through 30 ms ± 20 ms latency; an onChallenge that throws ends the attempt with AuthenticationError and reconnects.
import { afterEach, expect, test } from 'vitest';
import { isThruwayError } from '../../src/index.js';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { eventually, itClient } from './harness/recorder.js';
import { cap, describeRouters } from './harness/routers.js';
import { type AuthMethod, authFor, dualAuth, framesOf, nextClose } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

const METHODS: readonly AuthMethod[] = ['ticket', 'wampcra', 'wampcraSalted', 'cryptosign'];

describeRouters('auth', (r) => {
  for (const method of METHODS) {
    const auth = authFor(r, method);
    // skipped where the router has no such credential (capabilities.json `auth`)
    test.skipIf(auth === undefined)(`${method}: WELCOME with the authid`, async () => {
      if (auth === undefined) return;
      const c = itClient(r, { url: auth.url, realm: auth.realm, options: auth });
      const session = await c.opened();
      if (auth.authid !== undefined) expect(session.details.authid).toBe(auth.authid);
      expect(framesOf(c, 5, 'in').length).toBe(1); // exactly one AUTHENTICATE
      expect(c.onClose.values).toEqual([]);
    });
  }

  const good = authFor(r, 'ticket') ?? authFor(r, 'wampcra');
  test.skipIf(good === undefined)(
    'a wrong secret: ABORT, backoff without reset, never a session, never a hang',
    async () => {
      const a = r.auth;
      if (good === undefined || a === null) return;
      const c = itClient(r, {
        url: good.url,
        realm: good.realm,
        options: {
          ...good,
          onChallenge: () => 'certainly-wrong',
          retryOptions: { maxRetries: 3, initialRetryDelay: 100, maxRetryDelay: 400 },
        },
      });
      const ends = [await nextClose(c, 0), await nextClose(c, 1), await nextClose(c, 2), await nextClose(c, 3)];
      for (const end of ends) {
        expect(end.sessionId).toBeUndefined();
        expect(isThruwayError(end.error)).toBe(true);
        if (cap(r, 'abort_delivered') === 'always') {
          expect(end.initiator).toBe('router');
          expect(a.failureReasons).toContain(end.reason);
          expect(end.error?.code).toBe('abort');
        }
      }
      expect(ends.map((e) => e.attempt)).toEqual([1, 2, 3, 4]); // consecutive failures, never reset
      expect(ends.map((e) => e.willRetry)).toEqual([true, true, true, false]);
      expect(c.onOpen.values).toEqual([]);
    },
  );

  test.skipIf(good === undefined)('onChallenge throws: AuthenticationError, then the next attempt', async () => {
    if (good === undefined) return;
    const answer = good.onChallenge;
    let calls = 0;
    const c = itClient(r, {
      url: good.url,
      realm: good.realm,
      options: {
        ...good,
        onChallenge: (challenge) => {
          calls++;
          if (calls === 1) throw new Error('the login dialog crashed');
          return answer?.(challenge) ?? '';
        },
      },
    });
    const end = await nextClose(c, 0);
    expect(end.error?.code).toBe('authentication');
    expect(end.willRetry).toBe(true);
    await c.opened();
    expect(calls).toBe(2);
  });

  for (const sync of [false, true]) {
    const dual = dualAuth(r, sync);
    test.skipIf(dual === undefined)(
      `two methods with a${sync ? ' synchronous' : 'n asynchronous'} onChallenge: WELCOME on the first attempt`,
      async () => {
        if (dual === undefined) return;
        const c = itClient(r, { url: dual.url, realm: dual.realm, options: dual });
        await c.opened();
        expect(c.onClose.values).toEqual([]); // the first attempt
        const challenges = framesOf(c, 4, 'out');
        if (cap(r, 'multi_method_challenge') === 'always') {
          expect(challenges.map((f) => f[1])).toEqual(['wampcra', 'ticket']); // provider order, the last one verified
        } else if (cap(r, 'multi_method_challenge') === 'never') {
          expect(challenges.length).toBe(1);
        }
        expect(framesOf(c, 5, 'in').length).toBe(1); // one AUTHENTICATE, for the latest CHALLENGE
      },
    );
  }

  const dualSync = dualAuth(r, true);
  test.skipIf(dualSync === undefined)(
    'two methods through 30 ms ± 20 ms latency: WELCOME within 3 attempts, never a hang',
    async () => {
      const dual = dualSync;
      if (dual === undefined) return;
      const proxy = await ChaosProxy.start({ target: dual.url });
      proxies.push(proxy);
      proxy.latency(30, 20);
      const c = itClient(r, { url: proxy.url, realm: dual.realm, options: dual });
      await c.opened(20000);
      expect(c.onClose.values.length).toBeLessThanOrEqual(2);
      for (const end of c.onClose.values) {
        // a CHALLENGE that came after the AUTHENTICATE for the other method: challenge.mismatch, Thruway ABORTs
        expect(end.willRetry).toBe(true);
      }
      await eventually(() => c.client.session !== undefined, 1000, 'open');
    },
  );
});
