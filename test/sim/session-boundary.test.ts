// Regression scenarios at the session boundary, end to end through the real Client against the reference router under
// the virtual clock: a slow challenge during a reconnect while a topic and a retrying feed wait (a 2.x client looped on
// ABORT here), writers of a lost session during the next handshake, a second call of a call-only client, a retried call
// without lifecycle subscribers, and a retry across a router GOODBYE. Each run ends with the INV-* checkers that apply.
import { firstValueFrom, from, retry } from 'rxjs';
import { describe, expect, test } from 'vitest';
import { Client } from '../../src/client.js';
import { isThruwayError } from '../../src/errors.js';
import { Observable } from '../../src/observable/observable.js';
import type { SimAuthProvider } from '../../src/testing/sim.js';
import type { ClientOptions } from '../../src/types.js';
import { createHarness, type Harness, type SimClient } from '../helpers/harness.js';
import { checkInvariants, formatViolations, type InvariantId } from '../helpers/invariants.js';
import type { Recorded } from '../helpers/trace.js';

const PROVIDERS: readonly SimAuthProvider[] = [
  { method: 'ticket', verify: (signature) => (signature === 'secret' ? { authid: 'joe', authrole: 'user' } : false) },
];

/** A challenge the app answers when the test says so (a login dialog, a silent token refresh). */
class SlowChallenge {
  private answer: ((signature: string) => void) | undefined;
  readonly options: ClientOptions = {
    authmethods: ['ticket'],
    authid: 'joe',
    onChallenge: () =>
      new Promise<string>((resolve) => {
        this.answer = resolve;
      }),
  };

  get pending(): boolean {
    return this.answer !== undefined;
  }

  release(): void {
    const answer = this.answer;
    this.answer = undefined;
    answer?.('secret');
  }
}

/** The frames the client wrote on its `n`-th connection (1-based). */
function written(c: SimClient<Client>, n: number): unknown[][] {
  const socket = c.connections[n - 1]?.number;
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && f.connection === socket && Array.isArray(f.frame))
    .map((f) => f.frame as unknown[]);
}

/** What the client wrote on connection `n` before it received WELCOME there (message types). */
function beforeWelcome(c: SimClient<Client>, n: number): number[] {
  const socket = c.connections[n - 1]?.number;
  const types: number[] = [];
  for (const f of c.trace().frames) {
    if (f.connection !== socket || !Array.isArray(f.frame)) continue;
    if (f.direction === 'out' && f.frame[0] === 2) break;
    if (f.direction === 'in') types.push(f.frame[0] as number);
  }
  return types;
}

function expectInvariants(c: SimClient<Client>, ids: readonly InvariantId[]): void {
  const trace = c.trace();
  const found = checkInvariants(trace, { timings: { idle: 0 }, final: true }, ids);
  expect(found, formatViolations(found, trace)).toEqual([]);
}

const isLost = (e: unknown): boolean => isThruwayError(e) && e.code === 'connection_lost';

function harness(seed: number, auth: boolean, dialect: 'spec' | 'thruway-php' = 'thruway-php'): Harness {
  return createHarness({
    seed,
    router: { dialect, routerIds: 'per-session', ...(auth ? { providers: PROVIDERS } : {}) },
  });
}

describe('a slow challenge across a reconnect', () => {
  test('a slow challenge, a long-lived topic and a retrying feed: nothing but HELLO and AUTHENTICATE before WELCOME, no ABORT loop', async () => {
    const h = harness(11, true);
    h.router.declareTopic('cl.t');
    h.router.procedure(
      'cl.feed',
      () =>
        new Observable<string>((s) => {
          s.next('tick');
        }),
    );
    const challenge = new SlowChallenge();
    const c = h.makeClient(Client, { options: { ...challenge.options, timeouts: { idle: 0 } } });
    const topic = c.observe('topic', 'cl.t', c.client.topic('cl.t'));
    const errors: unknown[] = [];
    const feed = from(c.client.progressiveCall('cl.feed')).pipe(retry({ count: 100 }));
    const ticks: unknown[] = [];
    const sub = feed.subscribe({
      next: (v) => ticks.push(v),
      error: (e: unknown) => errors.push(e),
    });
    await h.clock.advance(0);
    expect(challenge.pending).toBe(true);
    await h.clock.advance(3000); // slower than the 1.45 s that looped 2.0.7
    challenge.release();
    await h.clock.advance(0);
    expect(c.client.session).toBeDefined();
    h.router.drop();
    // the reconnect, its CHALLENGE answered 3 s later; the feed resubscribed at once (retry) and waits for WELCOME
    for (let t = 0; t < 12000 && !challenge.pending; t += 100) await h.clock.advance(100);
    expect(challenge.pending).toBe(true);
    await h.clock.advance(3000);
    challenge.release();
    await h.clock.advance(2000);
    expect(c.connections).toHaveLength(2); // one reconnect, not a loop
    for (const n of [1, 2]) expect(beforeWelcome(c, n), `connection ${String(n)}`).toEqual([1, 5]);
    expect(
      written(c, 2).filter((f) => f[0] === 3),
      'no ABORT',
    ).toEqual([]);
    expect(written(c, 2).filter((f) => f[0] === 48 && f[3] === 'cl.feed')).toHaveLength(1);
    expect(ticks.length).toBeGreaterThanOrEqual(2); // the feed runs again in the new session
    expect(errors).toEqual([]);
    expect(topic.closed).toBe(false);
    sub.unsubscribe();
    await h.finish();
    expectInvariants(c, ['INV-CL01', 'INV-CL02', 'INV-AUTH']);
  });
});

describe('writers of a lost session', () => {
  test('writers of the lost session (publisher, CANCEL, late YIELD) write nothing into the next handshake or session', async () => {
    const h = harness(12, true);
    h.router.declareTopic('cl.pub');
    h.router.procedure('cl.never', () => new Promise(() => undefined));
    const challenge = new SlowChallenge();
    const c = h.makeClient(Client, {
      options: { ...challenge.options, requestIds: 'sequential', timeouts: { idle: 0 } },
    });
    let late: ((value: unknown) => void) | undefined;
    const registration = c.observe(
      'register',
      'cl.slow',
      c.client.register(
        'cl.slow',
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      ),
    );
    await h.clock.advance(0);
    challenge.release();
    await h.clock.advance(0);
    const inFlight = c.observe('call', 'cl.never', c.client.call('cl.never', ['c1']));
    const invoked = h.router.invoke('cl.slow', { args: ['r1'] });
    const published: Recorded<unknown>[] = [];
    const tick = (): void => {
      published.push(c.observe('publish', 'cl.pub', c.client.publish('cl.pub', [published.length])));
    };
    tick();
    await h.clock.advance(0);
    expect(late).toBeDefined();
    h.router.drop();
    await h.clock.advance(0);
    expect(isLost(inFlight.error)).toBe(true);
    // the handshake of connection 2, held open by the slow challenge: the app keeps publishing, drops its call, and the
    // handler of the dead session's INVOCATION answers
    for (let t = 0; t < 12000 && !challenge.pending; t += 100) await h.clock.advance(100);
    expect(challenge.pending).toBe(true);
    for (let i = 0; i < 5; i++) {
      tick();
      await h.clock.advance(100);
    }
    inFlight.unsubscribe();
    late?.('late result');
    await h.clock.advance(100);
    expect(beforeWelcome(c, 2), 'nothing but HELLO and AUTHENTICATE before WELCOME').toEqual([1]);
    challenge.release();
    await h.clock.advance(100);
    expect(beforeWelcome(c, 2)).toEqual([1, 5]);
    const second = written(c, 2);
    expect(
      second.filter((f) => f[0] === 70 || f[0] === 49),
      'no YIELD or CANCEL of session 1',
    ).toEqual([]);
    // the publishes of the handshake window waited for WELCOME, each written once
    expect(second.filter((f) => f[0] === 16)).toHaveLength(5);
    expect(invoked.result).toBeUndefined(); // the router never got the late answer
    expect(registration.closed).toBe(false);
    await h.finish();
    expectInvariants(c, ['INV-CL01', 'INV-CL02', 'INV-INVOKE', 'INV-CANCEL']);
  });
});

describe('a call-only client', () => {
  test('a call-only client: a second call made while the first is in flight is written at once', async () => {
    const h = harness(13, false, 'spec');
    let first: ((value: unknown) => void) | undefined;
    h.router.procedure('cl.slow', () => new Promise((resolve) => (first = resolve)));
    h.router.procedure('cl.fast', (args) => args[0]);
    const c = h.makeClient(Client, { lifecycle: false, options: { timeouts: { idle: 0 } } });
    const a = c.observe('call', 'cl.slow', c.client.call('cl.slow', ['a']));
    await h.clock.advance(10);
    expect(written(c, 1).filter((f) => f[0] === 48)).toHaveLength(1);
    const b = c.observe('call', 'cl.fast', c.client.call('cl.fast', ['b']));
    await h.clock.advance(0);
    expect(written(c, 1).filter((f) => f[0] === 48)).toHaveLength(2);
    expect(b.values).toMatchObject([{ args: ['b'] }]);
    expect(b.completed).toBe(true);
    expect(a.closed).toBe(false);
    first?.('a');
    await h.clock.advance(0);
    expect(a.values).toMatchObject([{ args: ['a'] }]);
    await h.finish();
    expectInvariants(c, ['INV-CL01', 'INV-CL02', 'INV-R5']);
  });
});

describe('a retried call without lifecycle subscribers', () => {
  test('no lifecycle subscriber, a call in flight at a drop: the client knows the next session and the retried call is served', async () => {
    const h = harness(14, false, 'spec');
    let n = 0;
    h.router.procedure('cl.feed', () => (++n === 1 ? new Promise(() => undefined) : 'second time'));
    const c = h.makeClient(Client, { lifecycle: false, options: { timeouts: { idle: 0 } } });
    const errors: unknown[] = [];
    const result = firstValueFrom(
      from(c.client.call('cl.feed')).pipe(
        retry({
          count: 3,
          delay: (e: unknown) => {
            errors.push(e);
            return from([0]);
          },
        }),
      ),
    );
    await h.clock.advance(10);
    const first = c.client.session?.id;
    expect(first).toBeDefined();
    h.router.drop();
    await h.clock.advance(5000);
    await expect(result).resolves.toMatchObject({ args: ['second time'] });
    expect(errors.map(isLost)).toEqual([true]);
    expect(c.client.session?.id).toBeDefined();
    expect(c.client.session?.id).not.toBe(first);
    expect(written(c, 2).filter((f) => f[0] === 48)).toHaveLength(1);
    await h.finish();
    expectInvariants(c, ['INV-CL01', 'INV-CL02', 'INV-R5']);
  });
});

describe('a retry across a router GOODBYE', () => {
  test('retry(1) across one router GOODBYE: the retried call waits for the next session and succeeds', async () => {
    const h = harness(15, false, 'thruway-php');
    let n = 0;
    h.router.procedure('op.feed', () => (++n === 1 ? new Promise(() => undefined) : 'after the goodbye'));
    const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
    const errors: unknown[] = [];
    const result = firstValueFrom(
      from(c.client.call('op.feed')).pipe(
        retry({
          count: 1,
          delay: (e: unknown) => {
            errors.push(e);
            return from([0]);
          },
        }),
      ),
    );
    await h.clock.advance(10);
    const session = h.router.sessions[0];
    expect(session).toBeDefined();
    h.router.kill(session!.id, 'wamp.close.system_shutdown');
    await h.clock.advance(5000);
    await expect(result).resolves.toMatchObject({ args: ['after the goodbye'] });
    expect(errors.map(isLost)).toEqual([true]); // one failure, the in-flight attempt
    expect(c.onClose?.values.map((i) => i.initiator)).toEqual(['router']);
    await h.finish();
    expectInvariants(c, ['INV-CL01', 'INV-R5', 'INV-R7']);
  });
});
