// Thruway PHP's anonymous and echo WELCOMEs (the client's anonymous-WELCOME rule): the client offered only a
// non-anonymous method, so a WELCOME without a CHALLENGE that carries no authid/authmethod (or carries the HELLO-only
// `authmethods`: the echo) is rejected — GOODBYE, AuthenticationError, backoff that keeps growing — until the real
// CHALLENGE comes.
//
// - The late provider: a realm whose ONLY provider is an external process that registers 10 s after it joined (the
//   router configuration test/routers/thruway-php/anon); restarted fresh, the realm answers anonymously for ~10 s.
// - The stale provider: the provider is killed while the router runs ⇒ ABORT thruway.error.unknown until it is back.
// - The echo: the stock noauth router echoes the HELLO details (with `authmethods`, and the app's own `authid`).
import { expect, test } from 'vitest';
import type { ChallengeMessage } from '../../src/types.js';
import { eventually, itClient } from './harness/recorder.js';
import { describeRouters, endpoint, router } from './harness/routers.js';
import { framesOf, nextClose } from './harness/scenarios.js';

const EXTAUTH = {
  authmethods: ['extauth'],
  onChallenge: (challenge: ChallengeMessage) => {
    if (challenge.authMethod !== 'extauth') throw new Error(`unexpected ${challenge.authMethod}`);
    return 'good-signature';
  },
};

function rejectedAnonymously(info: { error: unknown; reason: string | undefined }): boolean {
  return (
    (info.error as { code?: unknown } | undefined)?.code === 'authentication' &&
    info.reason === 'wamp.close.close_realm'
  );
}

describeRouters(
  'anonymous welcome',
  (thruway) => {
    const late = router('thruway-php-anon');

    test.skipIf(!late.available)(
      'a realm whose only provider registers 10 s late: rejected until the CHALLENGE comes',
      async () => {
        await late.control.restart(); // the provider joins now and registers 10 s later
        const started = performance.now();
        const c = itClient(late, { url: late.url, realm: 'realm_late', options: EXTAUTH });
        const session = await c.opened(30000);
        const openedAfter = performance.now() - started;
        expect(openedAfter).toBeGreaterThan(8000); // nothing before the provider registered …
        expect(session.details.authid).toBe('extuser'); // … then the real, challenged session
        expect(session.details.authmethod).toBe('extauth');
        const rejected = c.onClose.values.filter(rejectedAnonymously);
        expect(rejected.length).toBeGreaterThanOrEqual(3);
        expect(rejected.length).toBe(c.onClose.values.length); // every failure was an anonymous WELCOME
        for (const end of rejected) {
          expect(end.sessionId).toBeDefined(); // the rejected WELCOME's id
          expect(end.willRetry).toBe(true);
        }
        // backoff keeps growing (never reset: no session was accepted)
        expect(rejected.map((e) => e.attempt)).toEqual(rejected.map((_, i) => i + 1));
        expect(Math.max(...rejected.map((e) => e.delay ?? 0))).toBeGreaterThan(rejected[0]?.delay ?? 0);
        // each rejected connection: HELLO, then the WELCOME, then exactly one GOODBYE (the trace checks: INV-CL01)
        for (let conn = 1; conn < c.sockets.length; conn++) {
          const written = c
            .trace()
            .frames.filter((f) => f.connection === conn && f.direction === 'in')
            .map((f) => (f.frame as unknown[])[0]);
          expect(written).toEqual([1, 6]);
        }
        expect(framesOf(c, 4, 'out').length).toBe(1);
      },
    );

    test.skipIf(!late.available)(
      'a stale provider (killed while the router runs): ABORT thruway.error.unknown until it is back',
      async () => {
        const c = itClient(late, { url: late.url, realm: 'realm_late', options: EXTAUTH });
        await c.opened(30000); // a provider is registered (the previous test, or wait for it)
        await late.control.exec('sh', '/app/anon/provider.sh', 'stop');
        const before = c.onClose.values.length;
        c.reconnect();
        await nextClose(c, before + 2, 15000); // the reconnect, then two refused attempts
        const refused = c.onClose.values.slice(before + 1);
        for (const end of refused) {
          expect(end).toMatchObject({ initiator: 'router', reason: 'thruway.error.unknown', willRetry: true });
          expect(end.error?.code).toBe('abort');
        }
        await late.control.exec('sh', '/app/anon/provider.sh', 'start');
        await eventually(() => c.client.session !== undefined, 20000, 'a session once the provider is back');
        expect(c.client.session?.details.authmethod).toBe('extauth');
      },
    );

    for (const authid of [undefined, 'joe'] as const) {
      test(`the noauth router's echo WELCOME ${authid === undefined ? 'without' : 'with'} an authid is rejected`, async () => {
        const c = itClient(thruway, {
          url: endpoint(thruway, 'noauth'),
          realm: 'realm1',
          options: {
            authmethods: ['ticket'],
            ...(authid === undefined ? {} : { authid }),
            onChallenge: () => 'never asked',
            retryOptions: { maxRetries: 2 },
          },
        });
        await nextClose(c, 2);
        expect(c.onClose.values.every(rejectedAnonymously)).toBe(true);
        expect(c.onOpen.values).toEqual([]);
        const [welcome] = framesOf(c, 2, 'out');
        const details = welcome?.[2] as Record<string, unknown>;
        expect(details['authmethods']).toEqual(['ticket']); // the echo
        if (authid !== undefined) expect(details['authid']).toBe(authid); // spoofable: why the rule checks `authmethods`
        await eventually(() => c.status.values.at(-1)?.state === 'closed', 3000, 'gave up');
      });
    }

    test('an app that offers nothing (or anonymous) accepts the echo WELCOME', async () => {
      const c = itClient(thruway, { url: endpoint(thruway, 'noauth'), realm: 'realm1' });
      const session = await c.opened();
      expect(session.details['transport']).toBeDefined(); // the echo's HTTP details: never trust echoed auth keys
      expect(c.onClose.values).toEqual([]);
    });
  },
  ['thruway-php'],
);
