/**
 * Public entry "thruway.js". The ponyfill module is imported first, so `Symbol.observable` is defined before any
 * Observable exists. The export list is the public surface of the package.
 *
 * @module
 */
import './observable/symbol-observable.js';

export { Client } from './client.js';
export {
  WampError,
  ConnectionLostError,
  ConnectionClosedError,
  TimeoutError,
  AbortError,
  ProtocolError,
  CanceledError,
  AuthenticationError,
  isThruwayError,
  isWampError,
} from './errors.js';
export type { ThruwayError } from './errors.js';
export { Yield } from './yield.js';
export { jsonSerializer } from './transport/json.js';
export type {
  // Observable kit
  Observer,
  Unsubscribable,
  Subscription,
  Subscribable,
  InteropObservable,
  SubscribableInput,
  Input,
  Observable,
  // Options
  ClientOptions,
  RetryOptions,
  Timeouts,
  Clock,
  LogEntry,
  MatchPolicy,
  InvokePolicy,
  CallOptions,
  RegisterOptions,
  TopicOptions,
  PublishOptions,
  // Data delivered to the app
  ResultMessage,
  EventMessage,
  InvocationMessage,
  InvocationHandler,
  RegisteredMessage,
  ChallengeMessage,
  AbortSignalLike,
  // Session and status
  Session,
  WelcomeDetails,
  Status,
  CloseInfo,
  // Errors and transport
  ErrorCode,
  Serializer,
  WebSocketLike,
  WebSocketConstructorLike,
} from './types.js';
