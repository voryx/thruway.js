// `thruway.js/rxjs`: rxClient(client, from) with RxJS 7 and RxJS 5 (and RxJS 6, 9 for the peer range), every method
// forwarding its arguments to the client unchanged, the lifecycle wrappers made once (stable identity), a demo-mode
// monkeypatch on the plain result object, and `from` checked at once. Runs on the reference router under the virtual
// clock (the harness checks run after every test).
import { createRequire } from 'node:module';
import {
  delay,
  firstValueFrom,
  from,
  lastValueFrom,
  NEVER,
  Observable as RxObservable,
  type ObservableInput,
  of,
  take,
  toArray,
} from 'rxjs';
import { from as rx6From, Observable as Rx6Observable } from 'rxjs6';
import 'rxjs9';
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { isWampError } from '../../src/errors.js';
import { rxClient } from '../../src/rxjs/index.js';
import type { ResultMessage } from '../../src/types.js';
import { useHarness, type SimClient } from '../helpers/harness.js';

const h = useHarness({ seed: 11 });

// The Rx libraries' `from` functions, passed as they are: `rxClient(client, from)`. typescript-eslint reports a bare reference
// to RxJS 6/7's `from` as their deprecated scheduler overload, hence these aliases of the same functions.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- only the scheduler overload is deprecated
const rx7From: (input: ObservableInput<unknown>) => RxObservable<unknown> = from;
// eslint-disable-next-line @typescript-eslint/no-deprecated -- only the scheduler overload is deprecated
const from6: (input: unknown) => unknown = rx6From;
const advance = (ms: number): Promise<void> => h.current.clock.advance(ms);

function start(options = {}): SimClient<Client> {
  return h.current.makeClient(Client, { options: { timeouts: { idle: 0 }, ...options } });
}
/** The frames client `c` wrote on its first connection, of message type `type`. */
function written(c: SimClient<Client>, type: number): unknown[][] {
  return c
    .trace()
    .frames.filter((f) => f.direction === 'in' && (f.frame as unknown[])[0] === type)
    .map((f) => f.frame as unknown[]);
}

describe('rxClient(client, from): checks and shape', () => {
  test.each([undefined, null, 'from', {}, 42])('a `from` that is not a function (%s) is a TypeError at once', (bad) => {
    const c = start();
    expect(() => rxClient(c.client, bad as never)).toThrow(TypeError);
    expect(() => rxClient(c.client, bad as never)).toThrow('rxClient: `from` must be a function');
  });

  test('a plain object: the client, the five methods, the three lifecycle streams; all writable', () => {
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    expect(Object.getPrototypeOf(wamp)).toBe(Object.prototype);
    expect(Object.keys(wamp).sort()).toEqual(
      ['call', 'client', 'onClose', 'onOpen', 'progressiveCall', 'publish', 'register', 'status', 'topic'].sort(),
    );
    expect(wamp.client).toBe(c.client);
    for (const key of Object.keys(wamp)) {
      expect(Object.getOwnPropertyDescriptor(wamp, key)).toMatchObject({ writable: true, enumerable: true });
    }
  });

  test('lifecycle wrappers are made once, at rxClient(): `from` runs 3 times, then once per method call', () => {
    const c = start();
    const spy = vi.fn(rx7From);
    const wamp = rxClient(c.client, spy);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((args) => args[0] as unknown)).toEqual([
      c.client.status,
      c.client.onOpen,
      c.client.onClose,
    ]);
    expect(wamp.status).toBe(wamp.status);
    expect(wamp.onOpen).toBe(wamp.onOpen);
    expect(wamp.onClose).toBe(wamp.onClose);
    const a = wamp.call('com.example.p');
    const b = wamp.call('com.example.p');
    expect(a).not.toBe(b);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(spy.mock.contexts.every((self) => self === undefined)).toBe(true); // called unbound, like an app passing Observable.from
  });

  test('nothing is sent until an adapter stream is subscribed (cold)', async () => {
    h.current.router.procedure('com.example.p', () => 1);
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    wamp.call('com.example.p');
    wamp.publish('com.example.t', [1]);
    await advance(10);
    expect(written(c, 48)).toEqual([]);
    expect(written(c, 16)).toEqual([]);
  });
});

describe('every method forwards its arguments unchanged (RxJS 7)', () => {
  test('call(procedure, args, kwargs, options) and progressiveCall(…) (receive_progress forced, options not mutated)', async () => {
    const { router } = h.current;
    const seen: unknown[] = [];
    router.procedure('com.example.echo', (args, kwargs, details) => {
      seen.push({ args, kwargs, details });
      return 'ok';
    });
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    const options = { disclose_me: true };
    const result = await new Promise<ResultMessage>((resolve, reject) => {
      wamp.call('com.example.echo', [1, 'a'], { k: 'v' }, options).subscribe({ next: resolve, error: reject });
      void advance(10);
    });
    expect(result.args).toEqual(['ok']);
    const progressive = lastValueFrom(wamp.progressiveCall('com.example.echo', [2], { p: true }, options));
    await advance(10);
    await expect(progressive).resolves.toMatchObject({ args: ['ok'] });
    expect(options).toEqual({ disclose_me: true });
    const calls = written(c, 48);
    expect(calls.map((f) => f.slice(2))).toEqual([
      [{ disclose_me: true }, 'com.example.echo', [1, 'a'], { k: 'v' }],
      [{ disclose_me: true, receive_progress: true }, 'com.example.echo', [2], { p: true }],
    ]);
    expect(seen).toHaveLength(2);
  });

  test('register(procedure, handler, options): REGISTER with the options; the handler is the app’s', async () => {
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    const handler = vi.fn(() => 'handled');
    const registered: unknown[] = [];
    const subscription = wamp
      .register('com.example.r', handler, { invoke: 'roundrobin' })
      .subscribe((r) => registered.push(r.procedure));
    await advance(10);
    expect(registered).toEqual(['com.example.r']);
    expect(written(c, 64).map((f) => f.slice(2))).toEqual([[{ invoke: 'roundrobin' }, 'com.example.r']]);
    const call = h.current.router.invoke('com.example.r', { args: [5] });
    await advance(10);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]).toMatchObject([{ args: [5], procedure: 'com.example.r' }]);
    expect(call.result).toMatchObject({ args: ['handled'] });
    subscription.unsubscribe();
    await advance(10);
    expect(written(c, 66)).toHaveLength(1);
  });

  test('topic(topic, options) and publish(topic, args, kwargs, options)', async () => {
    const { router } = h.current;
    router.declareTopic('com.example.t');
    router.declareTopic('com.example.t2');
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    const events = lastValueFrom(wamp.topic('com.example.t', { match: 'prefix' }).pipe(take(1), toArray()));
    const published = lastValueFrom(wamp.publish('com.example.t2', [1], { k: 2 }, { acknowledge: true }));
    await advance(10);
    await expect(published).resolves.toBeUndefined();
    router.publish('com.example.t.x', ['e']);
    await advance(10);
    expect((await events).map((e) => e.args[0] as string)).toEqual(['e']);
    expect(written(c, 32).map((f) => f.slice(2))).toEqual([[{ match: 'prefix' }, 'com.example.t']]);
    expect(written(c, 16).map((f) => f.slice(2))).toEqual([[{ acknowledge: true }, 'com.example.t2', [1], { k: 2 }]]);
  });

  test('status / onOpen / onClose through the adapter: replay, every session, every end', async () => {
    const c = start({ autoOpen: false });
    const wamp = rxClient(c.client, rx7From);
    const states: string[] = [];
    const sessions: number[] = [];
    const ends: string[] = [];
    const subs = [
      wamp.status.subscribe((s) => states.push(s.state)),
      wamp.onOpen.subscribe((s) => sessions.push(s.id)),
      wamp.onClose.subscribe((i) => ends.push(i.initiator)),
    ];
    c.client.open();
    await advance(10);
    h.current.router.drop();
    await advance(5000);
    for (const s of subs) s.unsubscribe();
    expect(states).toEqual(['closed', 'connecting', 'open', 'closed', 'connecting', 'open']);
    expect(sessions).toHaveLength(2);
    expect(ends).toEqual(['connection']);
  });

  test('the streams are RxJS 7 Observables: pipe, instanceof; unsubscribe ⇒ CANCEL; errors stay typed', async () => {
    const { router } = h.current;
    router.procedure('com.example.slow', () => new Promise(() => undefined));
    router.deny((request) => request.uri === 'com.example.denied');
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    const slow = wamp.call('com.example.slow');
    expect(slow).toBeInstanceOf(RxObservable);
    const subscription = slow.subscribe();
    const denied = lastValueFrom(wamp.call('com.example.denied')).catch((e: unknown) => e);
    await advance(10);
    subscription.unsubscribe();
    await advance(10);
    const [call] = written(c, 48).filter((f) => f[3] === 'com.example.slow');
    expect(written(c, 49)).toEqual([[49, call?.[1], { mode: 'killnowait' }]]);
    const error = await denied;
    expect(isWampError(error)).toBe(true);
    expect(error).toMatchObject({ uri: 'wamp.error.not_authorized', procedure: 'com.example.denied' });
  });
});

describe('a demo mode: methods replaced on the adapter object', () => {
  test('(wamp as any).call / .topic replaced: callers get the demo answers, nothing is sent; the rest still works', async () => {
    h.current.router.declareTopic('com.example.status');
    const c = start();
    const wamp = rxClient(c.client, rx7From);
    const answer = [['demo row']];
    (wamp as { call: unknown }).call = () => of({ args: answer, argskw: {} }).pipe(delay(150));
    (wamp as { topic: unknown }).topic = () => NEVER;
    const rows = firstValueFrom(wamp.call('com.example.report', [1]));
    const quiet = wamp.topic('com.example.status').subscribe();
    await advance(200);
    await expect(rows).resolves.toEqual({ args: answer, argskw: {} });
    quiet.unsubscribe();
    expect(written(c, 48)).toEqual([]);
    expect(written(c, 32)).toEqual([]);
    const published = lastValueFrom(wamp.publish('com.example.status', ['still real']));
    await advance(10);
    await expect(published).resolves.toBeUndefined();
    expect(written(c, 16)).toHaveLength(1);
  });
});

describe('other Rx libraries in the peer range', () => {
  test('RxJS 5 (Observable.from, unbound): RxJS 5 Observables with the patched operators', async () => {
    interface Rx5<V> {
      map<R>(project: (value: V) => R): Rx5<R>;
      toPromise(): Promise<V>;
    }
    const require = createRequire(import.meta.url);
    const { Observable: Rx5Observable } = require('rxjs5/Observable') as {
      Observable: { readonly from: (input: unknown) => unknown };
    };
    require('rxjs5/add/observable/from');
    require('rxjs5/add/operator/map');
    require('rxjs5/add/operator/toPromise');
    h.current.router.procedure('com.example.p', () => 7);
    const c = start();
    const wamp = rxClient(c.client, Rx5Observable.from);
    const call = wamp.call('com.example.p') as unknown as Rx5<{ args: unknown[] }>;
    expect(call).toBeInstanceOf(Rx5Observable as unknown as new () => object);
    const value = call.map((r) => r.args[0]).toPromise();
    await advance(10);
    await expect(value).resolves.toBe(7);
    expect(wamp.status).toBeInstanceOf(Rx5Observable as unknown as new () => object);
  });

  test('RxJS 6 (from): RxJS 6 Observables', async () => {
    h.current.router.procedure('com.example.p', () => 6);
    const c = start();
    const wamp = rxClient(c.client, from6);
    const call = wamp.call('com.example.p');
    expect(call).toBeInstanceOf(Rx6Observable);
    const value = (call as unknown as Rx6Observable<{ args: unknown[] }>).toPromise();
    await advance(10);
    await expect(value).resolves.toMatchObject({ args: [6] });
  });

  test('RxJS 9 / the platform Observable (from = Observable.from, through the async iterator)', async () => {
    h.current.router.procedure('com.example.p', () => 9);
    const c = start();
    const wamp = rxClient(c.client, (x: AsyncIterable<unknown>) => Observable.from(x));
    const call = wamp.call('com.example.p') as unknown as Observable<{ args: unknown[] }>;
    expect(call).toBeInstanceOf(Observable);
    const value = call.first();
    await advance(10);
    await expect(value).resolves.toMatchObject({ args: [9] });
  });
});
