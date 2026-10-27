/**
 * Pins every public signature. Each `Spec*` type below is an independent copy of the documented public API; the tests
 * assert that what the package exports is *equal* to it, so any change of the public surface fails here first. Runs as
 * a vitest type test compiled by TypeScript 7 (unit project) and by `scripts/typecheck.mjs` with TypeScript 7 and 6.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the public API uses `any` where RxJS does */
import { describe, expectTypeOf, test } from 'vitest';
import type * as authEntry from '../../src/auth/index.js';
import { cryptosign, ticket, wampcra, type AuthOptions } from '../../src/auth/index.js';
import type * as root from '../../src/index.js';
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  Client,
  ConnectionClosedError,
  ConnectionLostError,
  isThruwayError,
  isWampError,
  jsonSerializer,
  ProtocolError,
  TimeoutError,
  WampError,
  Yield,
  type AbortSignalLike,
  type CallOptions,
  type ChallengeMessage,
  type ClientOptions,
  type Clock,
  type CloseInfo,
  type ErrorCode,
  type EventMessage,
  type Input,
  type InteropObservable,
  type InvocationHandler,
  type InvocationMessage,
  type InvokePolicy,
  type LogEntry,
  type MatchPolicy,
  type Observable,
  type Observer,
  type PublishOptions,
  type RegisteredMessage,
  type RegisterOptions,
  type ResultMessage,
  type RetryOptions,
  type Serializer,
  type Session,
  type Status,
  type Subscribable,
  type SubscribableInput,
  type Subscription,
  type ThruwayError,
  type Timeouts,
  type TopicOptions,
  type Unsubscribable,
  type WebSocketConstructorLike,
  type WebSocketLike,
  type WelcomeDetails,
} from '../../src/index.js';
import type * as rxjsEntry from '../../src/rxjs/index.js';
import { rxClient, type RxClient } from '../../src/rxjs/index.js';
import type * as testingEntry from '../../src/testing/index.js';
import {
  createTestRouter,
  createVirtualClock,
  type AuthDecision,
  type FrameRecord,
  type TestRouter,
  type TestRouterOptions,
  type VirtualClock,
} from '../../src/testing/index.js';
import type { Observable as RxObservable } from 'rxjs';

type Dict = Readonly<Record<string, unknown>>;

declare const obs: Observable<number>;
declare const client: Client;
declare const clock: VirtualClock;
declare const router: TestRouter;

// ------------------------------------------------------------------------------------------------ Observable kit
interface SpecObserver<T> {
  next(value: T): void;
  error(error: any): void;
  complete(): void;
}
interface SpecUnsubscribable {
  unsubscribe(): void;
}
interface SpecSubscription extends SpecUnsubscribable {
  readonly closed: boolean;
}
interface SpecSubscribable<T> {
  subscribe(observer: Partial<SpecObserver<T>>): SpecUnsubscribable;
}
type SpecInteropObservable<T> =
  { [Symbol.observable]: () => SpecSubscribable<T> } | { '@@observable': () => SpecSubscribable<T> };
interface SpecSubscribableInput<T> {
  subscribe(observer: SpecObserver<T>): unknown;
}
// + AsyncIterable<T> (an `async function*` is an input too).
type SpecInput<T> = T | PromiseLike<T> | SpecInteropObservable<T> | SpecSubscribableInput<T> | AsyncIterable<T>;
interface SpecObservable<T> {
  subscribe(
    observerOrNext?: Partial<SpecObserver<T>> | ((value: T) => void) | null,
    error?: ((error: any) => void) | null,
    complete?: (() => void) | null,
  ): SpecSubscription;
  [Symbol.observable](): SpecObservable<T>;
  '@@observable'(): SpecObservable<T>;
  [Symbol.asyncIterator](): AsyncIterator<T, undefined>;
}

describe('Observable kit', () => {
  test('Symbol.observable is declared on SymbolConstructor', () => {
    // declared `readonly observable: symbol`; TypeScript gives such SymbolConstructor members a unique symbol type,
    // which is what makes `[Symbol.observable]` usable as a member name.
    expectTypeOf<SymbolConstructor['observable']>().toEqualTypeOf<typeof Symbol.observable>();
    expectTypeOf<SymbolConstructor['observable']>().toExtend<symbol>();
  });
  test('Observer, Unsubscribable, Subscription, Subscribable', () => {
    expectTypeOf<Observer<number>>().toEqualTypeOf<SpecObserver<number>>();
    expectTypeOf<Unsubscribable>().toEqualTypeOf<SpecUnsubscribable>();
    expectTypeOf<Subscription>().toEqualTypeOf<SpecSubscription>();
    expectTypeOf<Subscribable<number>>().toEqualTypeOf<SpecSubscribable<number>>();
  });
  test('InteropObservable, SubscribableInput, Input', () => {
    expectTypeOf<InteropObservable<number>>().toEqualTypeOf<SpecInteropObservable<number>>();
    expectTypeOf<SubscribableInput<number>>().toEqualTypeOf<SpecSubscribableInput<number>>();
    expectTypeOf<Input<number>>().toEqualTypeOf<SpecInput<number>>();
  });
  test('Observable', () => {
    expectTypeOf<Observable<number>>().toEqualTypeOf<SpecObservable<number>>();
    // one subscribe signature: observer object, positional callbacks, nothing
    expectTypeOf(obs.subscribe()).toEqualTypeOf<Subscription>();
    expectTypeOf(obs.subscribe({ next: (v) => expectTypeOf(v).toEqualTypeOf<number>() })).toEqualTypeOf<Subscription>();
    expectTypeOf(
      obs.subscribe(
        (v) => v,
        null,
        () => undefined,
      ),
    ).toEqualTypeOf<Subscription>();
    expectTypeOf(obs[Symbol.observable]()).toEqualTypeOf<Observable<number>>();
    expectTypeOf(obs['@@observable']()).toEqualTypeOf<Observable<number>>();
    expectTypeOf(obs[Symbol.asyncIterator]()).toEqualTypeOf<AsyncIterator<number, undefined>>();
    expectTypeOf(obs).not.toHaveProperty('pipe');
  });
});

// -------------------------------------------------------------------------------------------------------- Client
type SpecCall = <A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
  procedure: string,
  args?: readonly unknown[],
  kwargs?: Readonly<Record<string, unknown>>,
  options?: CallOptions,
) => Observable<ResultMessage<A, K>>;
type SpecRegister = (
  procedure: string,
  handler: InvocationHandler,
  options?: RegisterOptions,
) => Observable<RegisteredMessage>;
type SpecTopic = <A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
  topic: string,
  options?: TopicOptions,
) => Observable<EventMessage<A, K>>;
type SpecPublish = (
  topic: string,
  args?: readonly unknown[],
  kwargs?: Readonly<Record<string, unknown>>,
  options?: PublishOptions,
) => Observable<void>;

// Optional parameters accept `undefined`, so under exactOptionalPropertyTypes their tuple elements read `x?: T | undefined`.
describe('Client', () => {
  test('constructor', () => {
    expectTypeOf(Client).constructorParameters.toEqualTypeOf<
      [url: string | (() => Input<string>), realm: string, options?: ClientOptions | undefined]
    >();
    expectTypeOf(Client).instance.toEqualTypeOf<Client>();
  });
  test('exactly 12 members', () => {
    expectTypeOf<keyof Client>().toEqualTypeOf<
      | 'call'
      | 'progressiveCall'
      | 'register'
      | 'topic'
      | 'publish'
      | 'open'
      | 'reconnect'
      | 'close'
      | 'status'
      | 'onOpen'
      | 'onClose'
      | 'session'
    >();
  });
  test('operations', () => {
    expectTypeOf<Client['call']>().toEqualTypeOf<SpecCall>();
    expectTypeOf<Client['progressiveCall']>().toEqualTypeOf<SpecCall>(); // same signature as call
    expectTypeOf<Client['register']>().toEqualTypeOf<SpecRegister>();
    expectTypeOf<Client['topic']>().toEqualTypeOf<SpecTopic>();
    expectTypeOf<Client['publish']>().toEqualTypeOf<SpecPublish>();
    expectTypeOf(client.call('p')).toEqualTypeOf<Observable<ResultMessage>>();
    expectTypeOf(client.call<[number], { n: number }>('p')).toEqualTypeOf<
      Observable<ResultMessage<[number], { n: number }>>
    >();
    expectTypeOf(client.progressiveCall('p', [1], {}, { disclose_me: true })).toEqualTypeOf<
      Observable<ResultMessage>
    >();
    expectTypeOf(client.progressiveCall<[number]>('p')).toEqualTypeOf<Observable<ResultMessage<[number]>>>();
    expectTypeOf(client.topic<[string]>('t')).toEqualTypeOf<Observable<EventMessage<[string]>>>();
  });
  test('lifecycle', () => {
    expectTypeOf<Client['open']>().toEqualTypeOf<() => void>();
    expectTypeOf<Client['reconnect']>().toEqualTypeOf<() => void>();
    expectTypeOf<Client['close']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<Pick<Client, 'status' | 'onOpen' | 'onClose' | 'session'>>().toEqualTypeOf<{
      readonly status: Observable<Status>;
      readonly onOpen: Observable<Session>;
      readonly onClose: Observable<CloseInfo>;
      readonly session: Session | undefined;
    }>();
  });
});

// ------------------------------------------------------------------------------------------------------- Options
interface SpecClientOptions {
  readonly authmethods?: readonly string[] | (() => readonly string[] | undefined) | undefined;
  readonly authid?: string | (() => string | undefined) | undefined;
  readonly authextra?:
    Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>> | undefined) | undefined;
  readonly onChallenge?: ((challenge: ChallengeMessage) => Input<string>) | undefined;
  readonly autoOpen?: boolean | undefined;
  readonly retryOptions?: RetryOptions | undefined;
  readonly timeouts?: Timeouts | undefined;
  readonly requestIds?: 'random' | 'sequential' | undefined;
  readonly WebSocket?: WebSocketConstructorLike | undefined;
  readonly serializer?: Serializer | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: ((entry: LogEntry) => void) | undefined;
}
interface SpecRetryOptions {
  readonly initialRetryDelay?: number | undefined;
  readonly retryDelayGrowth?: number | undefined;
  readonly maxRetryDelay?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryDelay?: ((attempt: number, closed: CloseInfo, defaultDelay: number) => number | null) | undefined;
}
interface SpecTimeouts {
  readonly connect?: number | undefined;
  readonly handshake?: number | undefined;
  readonly request?: number | undefined;
  readonly idle?: number | undefined;
}
interface SpecClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random?(): number;
}
interface SpecLogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
type SpecMatchPolicy = 'exact' | 'prefix' | 'wildcard' | `_${string}`;
type SpecInvokePolicy = 'single' | 'roundrobin' | 'random' | 'first' | 'last' | `_${string}`;
interface SpecCallOptions {
  readonly receive_progress?: boolean | undefined;
  readonly disclose_me?: boolean | undefined;
  readonly [key: string]: unknown;
}
interface SpecRegisterOptions {
  readonly match?: SpecMatchPolicy | undefined;
  readonly invoke?: SpecInvokePolicy | undefined;
  readonly disclose_caller?: boolean | undefined;
  readonly [key: string]: unknown;
}
interface SpecTopicOptions {
  readonly match?: SpecMatchPolicy | undefined;
  readonly [key: string]: unknown;
}
interface SpecPublishOptions {
  readonly acknowledge?: boolean | undefined;
  readonly exclude_me?: boolean | undefined;
  readonly exclude?: readonly number[] | undefined;
  readonly exclude_authid?: readonly string[] | undefined;
  readonly exclude_authrole?: readonly string[] | undefined;
  readonly eligible?: readonly number[] | undefined;
  readonly eligible_authid?: readonly string[] | undefined;
  readonly eligible_authrole?: readonly string[] | undefined;
  readonly disclose_me?: boolean | undefined;
  readonly [key: string]: unknown;
}

describe('Options', () => {
  test('ClientOptions, RetryOptions, Timeouts, Clock, LogEntry', () => {
    expectTypeOf<ClientOptions>().toEqualTypeOf<SpecClientOptions>();
    expectTypeOf<RetryOptions>().toEqualTypeOf<SpecRetryOptions>();
    expectTypeOf<Timeouts>().toEqualTypeOf<SpecTimeouts>();
    expectTypeOf<Clock>().toEqualTypeOf<SpecClock>();
    expectTypeOf<LogEntry>().toEqualTypeOf<SpecLogEntry>();
  });
  test('WAMP options pass through under spec names', () => {
    expectTypeOf<MatchPolicy>().toEqualTypeOf<SpecMatchPolicy>();
    expectTypeOf<InvokePolicy>().toEqualTypeOf<SpecInvokePolicy>();
    expectTypeOf<CallOptions>().toEqualTypeOf<SpecCallOptions>();
    expectTypeOf<RegisterOptions>().toEqualTypeOf<SpecRegisterOptions>();
    expectTypeOf<TopicOptions>().toEqualTypeOf<SpecTopicOptions>();
    expectTypeOf<PublishOptions>().toEqualTypeOf<SpecPublishOptions>();
  });
  test('optional keys accept undefined under exactOptionalPropertyTypes', () => {
    const maybeId = undefined as string | undefined;
    expectTypeOf({ authid: maybeId, autoOpen: undefined }).toExtend<ClientOptions>();
    expectTypeOf({ match: '_mqtt' as const, get_retained: true }).toExtend<TopicOptions>();
    expectTypeOf({ invoke: '_thruway' as const, replace_orphaned_session: 'yes' }).toExtend<RegisterOptions>();
    // @ts-expect-error -- `match` only accepts the spec values or the `_…` escape hatch
    expectTypeOf({ match: 'regex' }).toExtend<TopicOptions>();
    const maybeUser = undefined as string | undefined;
    expectTypeOf({
      authmethods: () => (maybeUser === undefined ? undefined : ['ticket']),
      authid: () => maybeUser,
      authextra: () => undefined,
    }).toExtend<ClientOptions>();
    // @ts-expect-error -- the auth functions are synchronous: a Promise is not an authid
    expectTypeOf({ authid: () => Promise.resolve('joe') }).toExtend<ClientOptions>();
    const maybeSession = undefined as number | undefined;
    expectTypeOf({ timer: 'call', timeout: 1, procedure: 'p', sessionId: maybeSession } as const).toExtend<
      ConstructorParameters<typeof TimeoutError>[0]
    >();
    expectTypeOf({ message: undefined, reason: undefined, attempt: undefined }).toExtend<
      ConstructorParameters<typeof ConnectionLostError>[0]
    >();
  });
});

// ------------------------------------------------------------------------------------- Data delivered to the app
interface SpecResultMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<{ progress?: boolean } & Record<string, unknown>>;
}
interface SpecEventMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<Record<string, unknown>>;
}
interface SpecInvocationMessage<
  A extends readonly unknown[] = any[],
  K extends Record<string, unknown> = Record<string, any>,
> {
  readonly args: A;
  readonly kwargs: Readonly<K>;
  readonly details: Readonly<
    { receive_progress?: boolean; caller?: number; procedure?: string } & Record<string, unknown>
  >;
  readonly procedure: string;
  readonly signal: AbortSignalLike;
}
interface SpecRegisteredMessage {
  readonly registrationId: number;
  readonly procedure: string;
  readonly sessionId: number;
}
interface SpecChallengeMessage {
  readonly authMethod: string;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignalLike;
}
interface SpecAbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

describe('Data delivered to the app', () => {
  test('messages', () => {
    expectTypeOf<ResultMessage>().toEqualTypeOf<SpecResultMessage>();
    expectTypeOf<ResultMessage<[number], { a: string }>>().toEqualTypeOf<SpecResultMessage<[number], { a: string }>>();
    expectTypeOf<EventMessage>().toEqualTypeOf<SpecEventMessage>();
    expectTypeOf<InvocationMessage>().toEqualTypeOf<SpecInvocationMessage>();
    expectTypeOf<InvocationHandler>().toEqualTypeOf<(invocation: InvocationMessage) => Input<unknown>>();
    expectTypeOf<RegisteredMessage>().toEqualTypeOf<SpecRegisteredMessage>();
    expectTypeOf<ChallengeMessage>().toEqualTypeOf<SpecChallengeMessage>();
    expectTypeOf<AbortSignalLike>().toEqualTypeOf<SpecAbortSignalLike>();
  });
  test('Yield', () => {
    expectTypeOf(Yield).constructorParameters.toEqualTypeOf<
      [args?: readonly unknown[] | undefined, kwargs?: Readonly<Record<string, unknown>> | undefined]
    >();
    expectTypeOf<Yield>().toEqualTypeOf<{
      readonly args: readonly unknown[];
      readonly kwargs: Readonly<Record<string, unknown>>;
    }>();
  });
});

// ---------------------------------------------------------------------------- Session, status, close information
interface SpecSession {
  readonly id: number;
  readonly realm: string;
  readonly details: Readonly<WelcomeDetails>;
}
interface SpecWelcomeDetails {
  readonly authid?: string;
  readonly authrole?: string;
  readonly authroles?: readonly string[];
  readonly authmethod?: string;
  readonly authprovider?: string;
  readonly authextra?: Readonly<Record<string, unknown>>;
  readonly roles?: Readonly<Record<string, { readonly features?: Readonly<Record<string, boolean>> }>>;
  readonly [key: string]: unknown;
}
type SpecStatus =
  | { readonly state: 'connecting'; readonly attempt: number }
  | { readonly state: 'open'; readonly session: Session }
  | { readonly state: 'closed'; readonly closed: CloseInfo | undefined };
interface SpecCloseInfo {
  readonly initiator: 'app' | 'router' | 'connection';
  readonly reason: string | undefined;
  readonly details: Readonly<Record<string, unknown>>;
  readonly closeCode: number | undefined;
  readonly wasClean: boolean;
  readonly sessionId: number | undefined;
  readonly error: ThruwayError | undefined;
  readonly willRetry: boolean;
  readonly delay: number | undefined;
  readonly attempt: number;
}

describe('Session, status, close information', () => {
  test('Session, WelcomeDetails, Status, CloseInfo', () => {
    expectTypeOf<Session>().toEqualTypeOf<SpecSession>();
    expectTypeOf<WelcomeDetails>().toEqualTypeOf<SpecWelcomeDetails>();
    expectTypeOf<Status>().toEqualTypeOf<SpecStatus>();
    expectTypeOf<CloseInfo>().toEqualTypeOf<SpecCloseInfo>();
  });
});

// ------------------------------------------------------------------------ Errors, serializer and transport types
interface SpecErrorContext {
  readonly sessionId?: number | undefined;
  readonly requestId?: number | undefined;
  readonly procedure?: string | undefined;
  readonly topic?: string | undefined;
  readonly attempt?: number | undefined;
  readonly cause?: unknown;
}
type Fields<T, K extends keyof T> = Pick<T, K>;

describe('Errors', () => {
  test('ErrorCode and the ThruwayError union', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'wamp_error'
      | 'connection_lost'
      | 'connection_closed'
      | 'timeout'
      | 'abort'
      | 'protocol'
      | 'canceled'
      | 'authentication'
    >();
    expectTypeOf<ThruwayError>().toEqualTypeOf<
      | WampError
      | ConnectionLostError
      | ConnectionClosedError
      | TimeoutError
      | AbortError
      | ProtocolError
      | CanceledError
      | AuthenticationError
    >();
    expectTypeOf<ThruwayError['code']>().toEqualTypeOf<ErrorCode>();
    expectTypeOf<ThruwayError>().toExtend<Error>();
  });
  test('WampError', () => {
    expectTypeOf(WampError).constructorParameters.toEqualTypeOf<
      [uri: string, args?: readonly unknown[] | undefined, kwargs?: Dict | undefined, details?: Dict | undefined]
    >();
    expectTypeOf<
      Fields<
        WampError,
        | 'name'
        | 'code'
        | 'uri'
        | 'errorUri'
        | 'args'
        | 'kwargs'
        | 'details'
        | 'sessionId'
        | 'requestId'
        | 'procedure'
        | 'topic'
      >
    >().toEqualTypeOf<{
      readonly name: 'WampError';
      readonly code: 'wamp_error';
      readonly uri: string;
      readonly errorUri: string;
      readonly args: readonly any[];
      readonly kwargs: Readonly<Record<string, any>>;
      readonly details: Readonly<Record<string, unknown>>;
      readonly sessionId?: number;
      readonly requestId?: number;
      readonly procedure?: string;
      readonly topic?: string;
    }>();
  });
  test('ConnectionLostError', () => {
    expectTypeOf(ConnectionLostError).constructorParameters.toEqualTypeOf<
      [
        init: {
          message?: string | undefined;
          reason?: string | undefined;
          closeCode?: number | undefined;
          cause?: unknown;
        } & SpecErrorContext,
      ]
    >();
    expectTypeOf<
      Fields<
        ConnectionLostError,
        'name' | 'code' | 'reason' | 'closeCode' | 'cause' | 'sessionId' | 'requestId' | 'procedure' | 'topic'
      >
    >().toEqualTypeOf<{
      readonly name: 'ConnectionLostError';
      readonly code: 'connection_lost';
      readonly reason?: string;
      readonly closeCode?: number;
      readonly cause?: unknown;
      readonly sessionId?: number;
      readonly requestId?: number;
      readonly procedure?: string;
      readonly topic?: string;
    }>();
  });
  test('ConnectionClosedError', () => {
    expectTypeOf(ConnectionClosedError).constructorParameters.toEqualTypeOf<
      [init: { message?: string | undefined; gaveUp?: boolean | undefined; cause?: unknown } & SpecErrorContext]
    >();
    expectTypeOf<
      Fields<
        ConnectionClosedError,
        'name' | 'code' | 'gaveUp' | 'cause' | 'sessionId' | 'requestId' | 'procedure' | 'topic'
      >
    >().toEqualTypeOf<{
      readonly name: 'ConnectionClosedError';
      readonly code: 'connection_closed';
      readonly gaveUp: boolean;
      readonly cause?: unknown;
      readonly sessionId?: number;
      readonly requestId?: number;
      readonly procedure?: string;
      readonly topic?: string;
    }>();
  });
  test('TimeoutError', () => {
    type Timer = 'connect' | 'handshake' | 'request' | 'liveness' | 'call';
    expectTypeOf(TimeoutError).constructorParameters.toEqualTypeOf<
      [init: { timer: Timer; timeout: number; message?: string | undefined } & SpecErrorContext]
    >();
    expectTypeOf<
      Fields<
        TimeoutError,
        'name' | 'code' | 'timer' | 'timeout' | 'attempt' | 'sessionId' | 'requestId' | 'procedure' | 'topic'
      >
    >().toEqualTypeOf<{
      readonly name: 'TimeoutError';
      readonly code: 'timeout';
      readonly timer: Timer;
      readonly timeout: number;
      readonly attempt?: number;
      readonly sessionId?: number;
      readonly requestId?: number;
      readonly procedure?: string;
      readonly topic?: string;
    }>();
  });
  test('AbortError', () => {
    expectTypeOf(AbortError).constructorParameters.toEqualTypeOf<
      [init: { reason: string; details?: Dict | undefined; message?: string | undefined } & SpecErrorContext]
    >();
    expectTypeOf<Fields<AbortError, 'name' | 'code' | 'reason' | 'details' | 'attempt' | 'sessionId'>>().toEqualTypeOf<{
      readonly name: 'AbortError';
      readonly code: 'abort';
      readonly reason: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly attempt?: number;
      readonly sessionId?: number;
    }>();
  });
  test('ProtocolError', () => {
    expectTypeOf(ProtocolError).constructorParameters.toEqualTypeOf<
      [init: { message: string; frame?: string | undefined } & SpecErrorContext]
    >();
    expectTypeOf<
      Fields<ProtocolError, 'name' | 'code' | 'frame' | 'attempt' | 'sessionId' | 'requestId' | 'procedure' | 'topic'>
    >().toEqualTypeOf<{
      readonly name: 'ProtocolError';
      readonly code: 'protocol';
      readonly frame?: string;
      readonly attempt?: number;
      readonly sessionId?: number;
      readonly requestId?: number;
      readonly procedure?: string;
      readonly topic?: string;
    }>();
  });
  test('CanceledError', () => {
    expectTypeOf(CanceledError).constructorParameters.toEqualTypeOf<
      [init?: ({ message?: string | undefined } & SpecErrorContext) | undefined]
    >();
    expectTypeOf<Fields<CanceledError, 'name' | 'code' | 'requestId' | 'procedure'>>().toEqualTypeOf<{
      readonly name: 'CanceledError';
      readonly code: 'canceled';
      readonly requestId?: number;
      readonly procedure?: string;
    }>();
  });
  test('AuthenticationError', () => {
    expectTypeOf(AuthenticationError).constructorParameters.toEqualTypeOf<
      [init: { message: string; authMethod?: string | undefined } & SpecErrorContext]
    >();
    expectTypeOf<Fields<AuthenticationError, 'name' | 'code' | 'authMethod' | 'attempt' | 'cause'>>().toEqualTypeOf<{
      readonly name: 'AuthenticationError';
      readonly code: 'authentication';
      readonly authMethod?: string;
      readonly attempt?: number;
      readonly cause?: unknown;
    }>();
  });
  test('brand guards', () => {
    expectTypeOf(isThruwayError).toEqualTypeOf<(value: unknown) => value is ThruwayError>();
    expectTypeOf(isWampError).toEqualTypeOf<(value: unknown) => value is WampError>();
  });
});

interface SpecSerializer {
  readonly protocol: string;
  readonly binary: boolean;
  serialize(message: readonly unknown[]): string | Uint8Array;
  deserialize(data: string | ArrayBuffer | Uint8Array): unknown;
}
interface SpecWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  readonly bufferedAmount?: number;
  binaryType: string;
  // a Uint8Array over a plain ArrayBuffer: what the DOM's WebSocket.send accepts
  send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  addEventListener(type: 'open' | 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string; readonly wasClean?: boolean }) => void,
  ): void;
  // one overload per event instead of `(ev: never) => void`, mirroring addEventListener
  removeEventListener(type: 'open' | 'error', listener: (ev: unknown) => void): void;
  removeEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  removeEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string; readonly wasClean?: boolean }) => void,
  ): void;
}
interface SpecWebSocketConstructorLike {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly OPEN: number;
}

describe('Serializer and transport types', () => {
  test('Serializer, jsonSerializer', () => {
    expectTypeOf<Serializer>().toEqualTypeOf<SpecSerializer>();
    expectTypeOf(jsonSerializer).toEqualTypeOf<(options?: { readonly binary?: boolean | undefined }) => Serializer>();
  });
  test('WebSocketLike, WebSocketConstructorLike', () => {
    expectTypeOf<WebSocketLike>().toEqualTypeOf<SpecWebSocketLike>();
    expectTypeOf<WebSocketConstructorLike>().toEqualTypeOf<SpecWebSocketConstructorLike>();
  });
});

describe('root entry', () => {
  test('exactly the documented runtime exports', () => {
    expectTypeOf<keyof typeof root>().toEqualTypeOf<
      | 'Client'
      | 'WampError'
      | 'ConnectionLostError'
      | 'ConnectionClosedError'
      | 'TimeoutError'
      | 'AbortError'
      | 'ProtocolError'
      | 'CanceledError'
      | 'AuthenticationError'
      | 'isThruwayError'
      | 'isWampError'
      | 'Yield'
      | 'jsonSerializer'
    >();
  });
});

// ----------------------------------------------------------------------------------------------- thruway.js/auth
type SpecAuthOptions = Required<Pick<ClientOptions, 'authmethods' | 'onChallenge'>> &
  Pick<ClientOptions, 'authid' | 'authextra'>;

describe('thruway.js/auth', () => {
  test('helpers', () => {
    expectTypeOf<keyof typeof authEntry>().toEqualTypeOf<'ticket' | 'wampcra' | 'cryptosign'>();
    expectTypeOf<AuthOptions>().toEqualTypeOf<SpecAuthOptions>();
    expectTypeOf(ticket).toEqualTypeOf<(authid: string, ticket: string | (() => Input<string>)) => AuthOptions>();
    expectTypeOf(wampcra).toEqualTypeOf<(authid: string, secret: string | (() => Input<string>)) => AuthOptions>();
    expectTypeOf(cryptosign).toEqualTypeOf<
      (
        key:
          | { readonly authid?: string | undefined; readonly publicKey: string; readonly privateKey: string }
          | {
              readonly authid?: string | undefined;
              readonly publicKey: string;
              sign(message: Uint8Array): Input<Uint8Array>;
            },
      ) => AuthOptions
    >();
    // spreads into ClientOptions (the documented usage)
    expectTypeOf({ ...wampcra('peter', 'secret1'), retryOptions: { maxRetryDelay: 15000 } }).toExtend<ClientOptions>();
  });
});

// ----------------------------------------------------------------------------------------------- thruway.js/rxjs
interface SpecRxClient {
  readonly client: Client;
  call<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): RxObservable<ResultMessage<A, K>>;
  progressiveCall<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    procedure: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): RxObservable<ResultMessage<A, K>>;
  register(procedure: string, handler: InvocationHandler, options?: RegisterOptions): RxObservable<RegisteredMessage>;
  topic<A extends readonly unknown[] = any[], K extends Record<string, unknown> = Record<string, any>>(
    topic: string,
    options?: TopicOptions,
  ): RxObservable<EventMessage<A, K>>;
  publish(
    topic: string,
    args?: readonly unknown[],
    kwargs?: Readonly<Record<string, unknown>>,
    options?: PublishOptions,
  ): RxObservable<void>;
  readonly status: RxObservable<Status>;
  readonly onOpen: RxObservable<Session>;
  readonly onClose: RxObservable<CloseInfo>;
}

describe('thruway.js/rxjs', () => {
  test('rxClient', () => {
    expectTypeOf<keyof typeof rxjsEntry>().toEqualTypeOf<'rxClient'>();
    expectTypeOf<RxClient>().toEqualTypeOf<SpecRxClient>();
    expectTypeOf(rxClient).toEqualTypeOf<(client: Client, from: (input: any) => unknown) => RxClient>();
  });
});

// --------------------------------------------------------------------------------------------- thruway.js/testing
interface SpecVirtualClock extends Required<Clock> {
  advance(ms: number): Promise<void>;
  runUntilIdle(limitMs?: number): Promise<void>;
  readonly pendingTimers: number;
}
interface SpecTestRouterOptions {
  readonly clock?: VirtualClock | undefined;
  readonly authenticate?: ((hello: { realm: string; details: Record<string, unknown> }) => AuthDecision) | undefined;
}
type SpecAuthDecision =
  | { readonly welcome: Record<string, unknown> }
  | {
      readonly challenge: { method: string; extra?: Record<string, unknown> };
      readonly verify: (signature: string) => AuthDecision;
    }
  | { readonly abort: string; readonly details?: Record<string, unknown> };
interface SpecFrameRecord {
  readonly connection: number;
  readonly direction: 'in' | 'out';
  readonly frame: readonly unknown[] | string;
  readonly at: number;
}
interface SpecTestRouter {
  readonly url: string;
  readonly WebSocket: WebSocketConstructorLike;
  readonly frames: readonly FrameRecord[];
  procedure(
    uri: string,
    fn: (args: unknown[], kwargs: Record<string, unknown>, details: Record<string, unknown>) => Input<unknown>,
  ): void;
  publish(topic: string, args?: unknown[], kwargs?: Record<string, unknown>): void;
  drop(code?: number): void;
  goodbye(reason?: string, details?: Record<string, unknown>): void;
  abort(reason?: string, details?: Record<string, unknown>): void;
  close(): void;
}

describe('thruway.js/testing', () => {
  test('narrow public kit', () => {
    expectTypeOf<keyof typeof testingEntry>().toEqualTypeOf<'createTestRouter' | 'createVirtualClock'>();
    expectTypeOf<VirtualClock>().toEqualTypeOf<SpecVirtualClock>();
    expectTypeOf(createVirtualClock).toEqualTypeOf<
      (options?: { readonly start?: number; readonly seed?: number }) => VirtualClock
    >();
    expectTypeOf<TestRouterOptions>().toEqualTypeOf<SpecTestRouterOptions>();
    expectTypeOf<AuthDecision>().toEqualTypeOf<SpecAuthDecision>();
    expectTypeOf<FrameRecord>().toEqualTypeOf<SpecFrameRecord>();
    expectTypeOf<TestRouter>().toEqualTypeOf<SpecTestRouter>();
    expectTypeOf(createTestRouter).toEqualTypeOf<(options?: TestRouterOptions) => TestRouter>();
  });
  test('the documented usage', () => {
    expectTypeOf({ WebSocket: router.WebSocket, clock }).toExtend<ClientOptions>();
    expectTypeOf(clock).toExtend<Clock>();
  });
});
