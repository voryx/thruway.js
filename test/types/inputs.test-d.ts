/**
 * `Input<T>` and interop at the type level: every place that accepts an app value accepts a plain value, a
 * Promise/thenable, an interop Observable, any Rx Observable *type* — RxJS 7, RxJS 9 (beta, built on the platform
 * Observable) and RxJS 5.4/5.5 — and an async iterable (`async function*`); and our Observables are consumed by RxJS
 * 5's `Observable.from`, RxJS 7's `from` and the platform `Observable.from` (RxJS 9) with the element type inferred.
 *
 * The RxJS 5 and 9 packages are the in-repo aliases `rxjs5` (5.5.12), `rxjs543` (5.4.3) and `rxjs9` (9.0.0-beta.1).
 * (A consumer whose `rxjs` *is* RxJS 5 or 6 is proven by the consumer matrix, scripts/consumer-matrix.sh.)
 */
import { from, of, type Observable as Rx7Observable } from 'rxjs';
import { Observable as Rx5Observable } from 'rxjs5/Observable.js';
import 'rxjs5/add/observable/from.js';
import 'rxjs5/add/observable/of.js';
import { Observable as Rx543Observable } from 'rxjs543/Observable.js';
import 'rxjs543/add/observable/from.js';
import 'rxjs543/add/observable/of.js';
import type { ColdObservable } from 'rxjs9';
import { describe, expectTypeOf, test } from 'vitest';
import type {
  ChallengeMessage,
  Client,
  ClientOptions,
  EventMessage,
  Input,
  InteropObservable,
  InvocationHandler,
  Observable,
  ResultMessage,
} from '../../src/index.js';
import type { RxClient } from '../../src/rxjs/index.js';

declare const client: Client;
declare const challenge: ChallengeMessage;
declare const wamp: RxClient;
declare const cold: ColdObservable<string>;
declare const platform: globalThis.Observable<string>;

describe('values, thenables and interop objects are Inputs', () => {
  test('plain value, Promise, thenable', () => {
    expectTypeOf('sig').toExtend<Input<string>>();
    expectTypeOf(Promise.resolve('sig')).toExtend<Input<string>>();
    expectTypeOf<PromiseLike<string>>().toExtend<Input<string>>();
  });
  test('interop observables (Symbol.observable and @@observable)', () => {
    expectTypeOf<InteropObservable<string>>().toExtend<Input<string>>();
    expectTypeOf(client.topic('t')).toExtend<Input<EventMessage>>();
  });
});

describe('RxJS 7', () => {
  test('Observables are Inputs', () => {
    expectTypeOf(of('sig')).toExtend<Input<string>>();
    const options: ClientOptions = { authmethods: ['ticket'], onChallenge: () => of('sig') };
    expectTypeOf(options).toExtend<ClientOptions>();
    const handler: InvocationHandler = (invocation) => of(invocation.args.length, 2, 3);
    expectTypeOf(handler).toExtend<InvocationHandler>();
    const url = (): Input<string> => from(Promise.resolve('ws://example.invalid/'));
    expectTypeOf(url).toExtend<() => Input<string>>();
  });
  test('from(ours) infers the element type', () => {
    expectTypeOf(from(client.topic('t'))).toEqualTypeOf<Rx7Observable<EventMessage>>();
    expectTypeOf(from(client.call<[number]>('p'))).toEqualTypeOf<Rx7Observable<ResultMessage<[number]>>>();
  });
  test('rxClient streams are RxJS Observables', () => {
    expectTypeOf(wamp.topic('t')).toEqualTypeOf<Rx7Observable<EventMessage>>();
    expectTypeOf(wamp.progressiveCall<[number]>('p')).toEqualTypeOf<Rx7Observable<ResultMessage<[number]>>>();
    expectTypeOf(from(client.progressiveCall('p'))).toEqualTypeOf<Rx7Observable<ResultMessage>>();
  });
});

describe('RxJS 9 (platform Observable)', () => {
  test('ColdObservable and the platform Observable are Inputs', () => {
    expectTypeOf(cold).toExtend<Input<string>>();
    expectTypeOf(platform).toExtend<Input<string>>();
    const options: ClientOptions = { authmethods: ['ticket'], onChallenge: () => cold };
    expectTypeOf(options).toExtend<ClientOptions>();
    const handler: InvocationHandler = () => platform;
    expectTypeOf(handler).toExtend<InvocationHandler>();
  });
  test('Observable.from(ours) accepts our Observable (async iterable) and infers the element type', () => {
    expectTypeOf(globalThis.Observable.from(client.topic('t'))).toEqualTypeOf<globalThis.Observable<EventMessage>>();
  });
});

describe('RxJS 5.5 and 5.4.3', () => {
  test('Observables are Inputs (onChallenge returning Observable.of)', () => {
    expectTypeOf(Rx5Observable.of('sig')).toExtend<Input<string>>();
    expectTypeOf(Rx543Observable.of('sig')).toExtend<Input<string>>();
    const options: ClientOptions = { authmethods: ['jwtauth'], onChallenge: () => Rx5Observable.of('token') };
    expectTypeOf(options).toExtend<ClientOptions>();
    expectTypeOf(Rx5Observable.of(challenge.authMethod)).toExtend<Input<string>>();
  });
  test('Observable.from(ours) infers the element type', () => {
    expectTypeOf(Rx5Observable.from(client.topic('t'))).toEqualTypeOf<Rx5Observable<EventMessage>>();
    expectTypeOf(Rx543Observable.from(client.topic('t'))).toEqualTypeOf<Rx543Observable<EventMessage>>();
  });
});

describe('async iterables', () => {
  test('an async generator is an Input of its element type, for onChallenge, handlers and the url resolver', () => {
    async function* tokens(): AsyncGenerator<string, void, undefined> {
      yield await Promise.resolve('sig');
    }
    expectTypeOf(tokens()).toExtend<Input<string>>();
    expectTypeOf<AsyncIterable<string>>().toExtend<Input<string>>();
    expectTypeOf<AsyncIterableIterator<string>>().toExtend<Input<string>>();
    const options: ClientOptions = { authmethods: ['ticket'], onChallenge: () => tokens() };
    expectTypeOf(options).toExtend<ClientOptions>();
    const handler: InvocationHandler = async function* (invocation) {
      yield invocation.args.length;
      yield await Promise.resolve(2);
    };
    expectTypeOf(handler).toExtend<InvocationHandler>();
    const url = (): Input<string> => tokens();
    expectTypeOf(url).toExtend<() => Input<string>>();
  });
  test('our Observable is also an async iterable of its element type', () => {
    expectTypeOf(client.topic('t')).toExtend<AsyncIterable<EventMessage>>();
  });
});

describe('what is not an Input', () => {
  test('a value of the wrong type', () => {
    expectTypeOf(42).not.toExtend<Input<string>>();
    expectTypeOf(of(42)).not.toExtend<Input<string>>();
    expectTypeOf<Observable<number>>().not.toExtend<Input<string>>();
    expectTypeOf<AsyncIterable<number>>().not.toExtend<Input<string>>();
  });
  test('a synchronous iterable is a plain value, not a stream of its elements', () => {
    expectTypeOf<Iterable<string>>().not.toExtend<Input<string>>();
    expectTypeOf<readonly string[]>().not.toExtend<Input<string>>();
  });
});
