/**
 * Internal: the full simulation kit used by this repo's tests, imported by path; never reachable through `exports`. The
 * internal kit carries no stripInternal tag: on a file comment it would strip the file's first declaration from the
 * emitted .d.ts.
 *
 * `createSimRouter` is the reference router in strict mode (unscripted CALLs/PUBLISHes/SUBSCRIBEs are recorded);
 * every other export is re-exported from the module that implements it.
 *
 * @module
 */
import { createRouter, type SimRouter, type SimRouterOptions } from './router.js';

export type {
  AuthManagerState,
  Availability,
  Phase,
  ProviderState,
  SimAuthProvider,
  SimConnection,
  SimHello,
  SimRequest,
  SimRouter,
  SimRouterCall,
  SimRouterOptions,
  SimSession,
  Violation,
} from './router.js';
export type { ClockEvent, SimClock, SimClockOptions, SimClockScope } from './virtual-clock.js';
export type {
  CancelAction,
  CloseSpec,
  Dialect,
  DialectName,
  PayloadStyle,
  QuirkFlags,
  RegisterMatch,
  RequestKind,
  SubscribeMatch,
  UriRule,
  ViolationKind,
  ViolationReaction,
} from './dialects.js';
export type { ViolationCode } from './oracle.js';
export type { Direction, EventType, FakeSocket, FakeSocketControls, FreezeMode } from './socket.js';
export { createSimClock, drainMicrotasks, simClockOf, xorshift128plus } from './virtual-clock.js';
export { DIALECTS, quirksOf } from './dialects.js';
export { ORACLE_RULES } from './oracle.js';
export { createRouter } from './router.js';

/** The reference router, strict by default (`strict: false` opts out). */
export function createSimRouter(options: SimRouterOptions = {}): SimRouter {
  return createRouter({ ...options, strict: options.strict ?? true });
}
