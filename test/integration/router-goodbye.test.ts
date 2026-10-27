// A router-initiated GOODBYE against every router: triggered through the router's own path where it has one
// (`router_goodbye_trigger`: Thruway PHP's test-only admin RPC, which sends the GOODBYE through the victim's own
// Session; Crossbar's `wamp.session.kill`; Bondy's system_shutdown on SIGTERM), else injected by the chaos proxy. The
// client answers once with wamp.close.goodbye_and_out, reports the end (`initiator: 'router'`, the reason,
// details.message, no error), fails the in-flight call with ConnectionLostError, reconnects, and its registration and
// topic survive.
//
// Thruway PHP's InspectionModule `thruway.inspect.shutdown_session` does NOT send a GOODBYE
// — it calls Session::shutdown(), a plain close 1000 — so it is the connection-loss path: tested separately.
import { afterEach, expect, test } from 'vitest';
import { ChaosProxy } from './harness/chaos-proxy.js';
import { errorFrom, eventually, firstValue, itClient, uri, type ItClient } from './harness/recorder.js';
import { cap, describeRouters, type Router } from './harness/routers.js';
import { callee, framesOf, nextClose, reopened, subscribed } from './harness/scenarios.js';

const proxies: ChaosProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

interface Expected {
  readonly reason: string;
  readonly message: string | undefined;
}

async function trigger(
  r: Router,
  victim: ItClient,
  helper: ItClient,
  proxy: ChaosProxy | undefined,
): Promise<Expected> {
  const sessionId = victim.client.session?.id;
  switch (cap(r, 'router_goodbye_trigger')) {
    case 'rpc':
      await firstValue(
        helper.client.call('thruway_test.goodbye_session', [sessionId, 'com.example.session_ended', 'Expired token']),
      );
      return { reason: 'com.example.session_ended', message: 'Expired token' };
    case 'meta':
      await firstValue(
        helper.client.call('wamp.session.kill', [sessionId], {
          reason: 'wamp.close.killed',
          message: 'killed by the test',
        }),
      );
      return { reason: 'wamp.close.killed', message: 'killed by the test' };
    case 'sigterm':
      await r.control.kill('TERM');
      return { reason: 'wamp.close.system_shutdown', message: undefined };
    case 'proxy':
      if (proxy === undefined) throw new Error('the proxy trigger needs a proxied victim');
      proxy.inject([6, { message: 'injected by the test' }, 'wamp.close.system_shutdown'], 'down');
      return { reason: 'wamp.close.system_shutdown', message: 'injected by the test' };
  }
}

describeRouters('router goodbye', (r) => {
  test('reply once, report it, fail the in-flight call, reconnect; the registration and the topic survive', async () => {
    const viaProxy = cap(r, 'router_goodbye_trigger') === 'proxy';
    const proxy = viaProxy ? await ChaosProxy.start({ target: r.url }) : undefined;
    if (proxy !== undefined) proxies.push(proxy);
    const procedure = uri('goodbye');
    const slowProcedure = uri('goodbye');
    const topic = uri('goodbye');
    const backend = itClient(r, { name: 'backend' });
    let invoked = 0;
    await callee(backend, slowProcedure, () => {
      invoked++;
      return new Promise(() => undefined);
    });
    const victim = itClient(r, { name: 'victim', ...(proxy === undefined ? {} : { url: proxy.url }) });
    const registration = await callee(victim, procedure, () => 'still here');
    const events = await subscribed(victim, topic);
    const inflight = victim.observe('call', slowProcedure, victim.client.call(slowProcedure));
    await eventually(() => invoked === 1, 5000, 'the in-flight INVOCATION');
    const before = victim.client.session?.id;
    const expected = await trigger(r, victim, backend, proxy);

    const end = await nextClose(victim, 0, 20000);
    expect(end).toMatchObject({ initiator: 'router', reason: expected.reason, error: undefined, willRetry: true });
    expect(end.sessionId).toBe(before);
    if (expected.message !== undefined && cap(r, 'router_goodbye_trigger') !== 'sigterm') {
      expect(end.details['message']).toBe(expected.message);
    }
    expect(framesOf(victim, 6, 'in')).toEqual([[6, {}, 'wamp.close.goodbye_and_out']]);
    const lost = (await errorFrom(inflight)) as { code?: unknown; procedure?: unknown; sessionId?: unknown };
    expect(lost).toMatchObject({ code: 'connection_lost', procedure: slowProcedure, sessionId: before });

    if (cap(r, 'router_goodbye_trigger') === 'sigterm') await r.control.waitReady(); // the router stopped
    await reopened(victim, before, 60000);
    const caller = itClient(r, { name: 'caller' });
    await eventually(() => registration.values.length === 2, 10000, 'REGISTERED again');
    expect((await firstValue(caller.client.call(procedure))).args).toEqual(['still here']);
    await eventually(() => framesOf(victim, 33, 'out').length === 2, 10000, 'SUBSCRIBED again');
    await firstValue(caller.client.publish(topic, ['after'], {}, { acknowledge: true }));
    await eventually(() => events.values.length === 1, 5000, 'the EVENT after the GOODBYE');
    expect(registration.errored || events.errored).toBe(false);
  });
});

describeRouters('meta kill', (r) => {
  test.skipIf(cap(r, 'meta_kill') !== 'always')(
    'wamp.session.kill from another session: the victim ends and reconnects',
    async () => {
      const victim = itClient(r, { name: 'victim' });
      const before = (await victim.opened()).id;
      const events = await subscribed(victim, uri('kill'));
      const killer = itClient(r, { name: 'killer' });
      await firstValue(
        killer.client.call('wamp.session.kill', [before], { reason: 'wamp.close.killed', message: 'test' }),
      );
      const end = await nextClose(victim, 0);
      expect(end.willRetry).toBe(true);
      // Crossbar's GOODBYE arrives; Nexus loses it and the victim sees a bare close: either way it reconnects
      if (end.initiator === 'router') expect(end.reason).toBe('wamp.close.killed');
      await reopened(victim, before);
      expect(events.errored).toBe(false);
    },
  );
});

describeRouters(
  'inspection shutdown',
  (r) => {
    test('thruway.inspect.shutdown_session semantics (close 1000, no GOODBYE): a connection loss, then reconnect', async () => {
      const helper = itClient(r, { name: 'admin' });
      const victim = itClient(r, { name: 'victim' });
      const before = (await victim.opened()).id;
      const events = await subscribed(victim, uri('inspect'));
      await firstValue(helper.client.call('thruway_test.shutdown_session', [before]));
      const end = await nextClose(victim, 0);
      expect(end).toMatchObject({ initiator: 'connection', closeCode: 1000, willRetry: true });
      expect(end.error?.code).toBe('connection_lost');
      expect(framesOf(victim, 6, 'in')).toEqual([]); // nothing to answer
      await reopened(victim, before);
      expect(events.errored).toBe(false);
    });
  },
  ['thruway-php'],
);
