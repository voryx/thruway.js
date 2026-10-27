/**
 * Public entry "thruway.js/rxjs": `rxClient(client, from)` wraps every stream with the app's own `from` (RxJS 7 `from`,
 * or RxJS 5's `Observable.from`), so the runtime never imports rxjs. The lifecycle wrappers are made once (stable
 * identity); the result is a plain object (an app may replace methods on it: a demo mode).
 *
 * @module
 */
import type { Observable as RxObservable } from 'rxjs';
import type { Client } from '../client.js';
import type { CallOptions, CloseInfo, EventMessage, InvocationHandler, Observable } from '../types.js';
import type { PublishOptions, RegisteredMessage, RegisterOptions, ResultMessage, Session } from '../types.js';
import type { Status, TopicOptions } from '../types.js';

export interface RxClient {
  readonly client: Client; // open(), reconnect(), close(), session
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

/** Wrap every stream with the app's own `from`: RxJS 7 `from`, or RxJS 5's `Observable.from` (so RxJS 5 apps keep
 *  their prototype-patched operators). The result is a plain object, so an app may replace methods (a demo mode). */
export function rxClient(client: Client, from: (input: any) => unknown): RxClient {
  if (typeof from !== 'function') throw new TypeError('rxClient: `from` must be a function (RxJS from)');
  const rx = <T>(source: Observable<T>): RxObservable<T> => from(source) as RxObservable<T>;
  return {
    client,
    call: (procedure, args, kwargs, options) => rx(client.call(procedure, args, kwargs, options)),
    progressiveCall: (procedure, args, kwargs, options) => rx(client.progressiveCall(procedure, args, kwargs, options)),
    register: (procedure, handler, options) => rx(client.register(procedure, handler, options)),
    topic: (topic, options) => rx(client.topic(topic, options)),
    publish: (topic, args, kwargs, options) => rx(client.publish(topic, args, kwargs, options)),
    status: rx(client.status),
    onOpen: rx(client.onOpen),
    onClose: rx(client.onClose),
  };
}
