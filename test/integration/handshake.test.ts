// Handshake against every router: what the client offers (exactly the serializer's subprotocol, always roles), what it
// accepts (WELCOME details passed through frozen, unknown keys kept), and that nothing but HELLO/AUTHENTICATE/ABORT is
// written before WELCOME — also with work queued while the handshake is still running (INV-CL01; v2 ran such CALLs
// under an unverified authid on Thruway, T5).
import { expect, test } from 'vitest';
import { isThruwayError } from '../../src/index.js';
import { cap, describeRouters } from './harness/routers.js';
import { eventually, firstValue, itClient, uri } from './harness/recorder.js';
import { authFor, callee, delay, framesOf, nextClose } from './harness/scenarios.js';

describeRouters('handshake', (r) => {
  test('HELLO offers wamp.2.json and every role; the WELCOME is passed through frozen', async () => {
    const c = itClient(r);
    const session = await c.opened();
    const [hello] = framesOf(c, 1, 'in');
    expect(hello?.[1]).toBe(r.realm);
    const details = hello?.[2] as { roles: Record<string, unknown>; authmethods?: unknown };
    expect(Object.keys(details.roles).sort()).toEqual(['callee', 'caller', 'publisher', 'subscriber']);
    expect(details.authmethods).toBeUndefined();
    expect(c.sockets[0]?.opened).toBe(true);
    if (cap(r, 'subprotocol_echo') === 'always') expect(c.sockets.length).toBe(1);
    expect(session.realm).toBe(r.realm);
    expect(Object.isFrozen(session.details)).toBe(true);
    expect(typeof session.details.roles).toBe('object');
    expect(c.client.session?.id).toBe(session.id);
  });

  test('work subscribed before and during the handshake is written only after WELCOME', async () => {
    const auth = authFor(r, 'wampcra') ?? authFor(r, 'ticket');
    const procedure = uri('handshake');
    const helper = itClient(r);
    await callee(helper, procedure, () => 'ok');
    const slow = auth === undefined ? undefined : auth.onChallenge;
    const c = itClient(r, {
      ...(auth === undefined ? {} : { url: auth.url, realm: auth.realm }),
      options: {
        autoOpen: false,
        ...(auth === undefined
          ? {}
          : {
              authmethods: auth.authmethods,
              authid: auth.authid,
              // hold the answer for 300 ms: a CALL during the CHALLENGE window would run unauthenticated on Thruway
              onChallenge: async (challenge) => {
                await delay(300);
                return (await slow?.(challenge)) as string; // the helpers answer a string or a Promise of one
              },
            }),
      },
    });
    const call = firstValue(c.client.call(procedure));
    const published = firstValue(c.client.publish(uri('handshake'), ['x'], {}, { acknowledge: true }));
    c.open();
    const late = firstValue(c.client.call(procedure));
    await expect(call).resolves.toMatchObject({ args: ['ok'] });
    await expect(late).resolves.toMatchObject({ args: ['ok'] });
    await published;
    // the trace checks of every test enforce INV-CL01; here it must also hold that the work was written after WELCOME
    const frames = c.trace().frames.filter((f) => f.connection === 1);
    const welcomeAt = frames.findIndex((f) => f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === 2);
    const firstCall = frames.findIndex((f) => f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 48);
    expect(welcomeAt).toBeGreaterThan(0);
    expect(firstCall).toBeGreaterThan(welcomeAt);
  });

  test('an unknown realm: the router answers (ABORT) or welcomes it (auto-created); the client never hangs', async () => {
    const realm = r.id === 'fox-wamp' ? `nosuch_${String(Date.now())}` : `com.thruwayjs.nosuch.r${String(Date.now())}`;
    const c = itClient(r, { realm, options: { retryOptions: { maxRetries: 1 } } });
    if (cap(r, 'invalid_realm_reply') === 'always') {
      const end = await nextClose(c, 0);
      expect(end.initiator).toBe('router');
      expect(end.reason).toMatch(/no_such_realm|not_authorized|wamp\.error/);
      expect(isThruwayError(end.error)).toBe(true);
      expect(end.willRetry).toBe(true);
      const last = await nextClose(c, 1);
      expect(last.willRetry).toBe(false);
      await eventually(() => c.status.values.at(-1)?.state === 'closed', 5000, 'gave up');
    } else if (cap(r, 'invalid_realm_reply') === 'never') {
      await expect(c.opened(8000)).resolves.toMatchObject({ realm });
    } else {
      // sometimes the closing frame is lost (Nexus): either an ABORT or a bare close, then backoff
      const end = await nextClose(c, 0);
      expect(end.willRetry).toBe(true);
    }
  });

  test('the router matrix check: an authenticated WELCOME carries authid or authmethod', async () => {
    const auth = authFor(r, 'ticket') ?? authFor(r, 'wampcra');
    if (auth === undefined) return;
    const c = itClient(r, { url: auth.url, realm: auth.realm, options: auth });
    const session = await c.opened();
    // the anonymous-WELCOME rule must never fire on a real authenticated session
    expect(session.details.authid !== undefined || session.details.authmethod !== undefined).toBe(true);
    expect(framesOf(c, 4, 'out').length).toBeGreaterThanOrEqual(1);
    expect(c.onClose.values).toEqual([]);
    if (cap(r, 'anonymous_welcome_without_provider') === 'always') {
      // the same router welcomes a non-provided realm anonymously: the client rejects it (anonymous-welcome.test.ts)
      expect(session.details.authid).toBeDefined();
    }
  });
});
