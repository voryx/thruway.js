// Small building blocks shared by the integration files: credentials as client options, a registered callee, a
// subscribed topic, waiting for lifecycle events. Nothing here asserts; the test files do.
import { cryptosign, ticket, wampcra, type AuthOptions } from '../../../src/auth/index.js';
import type {
  ChallengeMessage,
  ClientOptions,
  CloseInfo,
  EventMessage,
  InvocationHandler,
  RegisteredMessage,
  RegisterOptions,
  TopicOptions,
} from '../../../src/types.js';
import type { Recorded } from '../../helpers/trace.js';
import { eventually, type ItClient, valueOf } from './recorder.js';
import { endpoint, type Router } from './routers.js';

export type AuthMethod = 'ticket' | 'wampcra' | 'wampcraSalted' | 'cryptosign';

/** Client options authenticating with `method` on `r` (undefined when the router has no such credential). */
export function authFor(
  r: Router,
  method: AuthMethod,
): (AuthOptions & { readonly url: string; readonly realm: string }) | undefined {
  const a = r.auth;
  if (a === null) return undefined;
  const where = { url: endpoint(r, a.endpoint), realm: a.realm };
  switch (method) {
    case 'ticket': {
      if (a.ticket === null) return undefined;
      const t = ticket(a.ticket.authid, a.ticket.secret);
      if (a.ticket.method === 'ticket') return { ...t, ...where };
      // Bondy: a static secret is the `password` method, answered the same way
      return { ...t, authmethods: [a.ticket.method], onChallenge: () => a.ticket?.secret ?? '', ...where };
    }
    case 'wampcra':
      return a.wampcra === null ? undefined : { ...wampcra(a.wampcra.authid, a.wampcra.secret), ...where };
    case 'wampcraSalted':
      return a.wampcraSalted === null
        ? undefined
        : { ...wampcra(a.wampcraSalted.authid, a.wampcraSalted.secret), ...where };
    case 'cryptosign':
      if (a.cryptosign === null) return undefined;
      return {
        ...cryptosign({
          authid: a.cryptosign.authid,
          publicKey: a.cryptosign.publicKey,
          privateKey: a.cryptosign.seed,
        }),
        ...where,
      };
  }
}

/** Two methods for one authid (ticket and wampcra, Thruway T6); `sync` answers the ticket synchronously. */
export function dualAuth(
  r: Router,
  sync: boolean,
): (ClientOptions & { readonly url: string; readonly realm: string }) | undefined {
  const a = r.auth;
  if (a?.dual == null) return undefined;
  const dual = a.dual;
  const cra = wampcra(dual.authid, dual.wampcra);
  return {
    url: endpoint(r, a.endpoint),
    realm: a.realm,
    authid: dual.authid,
    authmethods: ['ticket', 'wampcra'],
    onChallenge: (challenge: ChallengeMessage) => {
      if (challenge.authMethod === 'ticket') return sync ? dual.ticket : Promise.resolve(dual.ticket);
      return cra.onChallenge?.(challenge) ?? '';
    },
  };
}

/** Register `handler` and wait until it is active (the stream stays subscribed: unsubscribe to UNREGISTER). */
export async function callee(
  c: ItClient,
  procedure: string,
  handler: InvocationHandler,
  options?: RegisterOptions,
): Promise<Recorded<RegisteredMessage>> {
  const registration = c.observe('register', procedure, c.client.register(procedure, handler, options));
  await valueOf(registration);
  return registration;
}

/** Subscribe and wait until the router acknowledged the SUBSCRIBE (a SUBSCRIBED frame on the current connection). */
export async function subscribed(c: ItClient, topic: string, options?: TopicOptions): Promise<Recorded<EventMessage>> {
  const before = subscribedCount(c);
  const events = c.observe('topic', topic, c.client.topic(topic, options));
  await eventually(() => subscribedCount(c) > before, 10000, `SUBSCRIBED for ${topic}`);
  return events;
}

/** The number of SUBSCRIBED frames the client received so far. */
export function subscribedCount(c: ItClient): number {
  return c.trace().frames.filter((f) => f.direction === 'out' && Array.isArray(f.frame) && f.frame[0] === 33).length;
}

/** Frames of one message type (and direction) in a client's trace. */
export function framesOf(c: ItClient, type: number, direction: 'in' | 'out'): readonly (readonly unknown[])[] {
  return c
    .trace()
    .frames.filter((f) => f.direction === direction && Array.isArray(f.frame) && f.frame[0] === type)
    .map((f) => f.frame as readonly unknown[]);
}

/** Wait until `c` has seen more than `count` ends (onClose values); returns the next one. */
export async function nextClose(c: ItClient, count: number, ms = 15000): Promise<CloseInfo> {
  await eventually(() => c.onClose.values.length > count, ms, `${c.name}: onClose #${String(count + 1)}`);
  return c.onClose.values[count]!;
}

/** Wait until the client is open again on a session other than `previous`. */
export async function reopened(c: ItClient, previous: number | undefined, ms = 20000): Promise<number> {
  await eventually(
    () => {
      const s = c.client.session;
      return s !== undefined && s.id !== previous;
    },
    ms,
    `${c.name}: a new session after ${String(previous)}`,
  );
  return c.client.session?.id ?? 0;
}

/** Resolve after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** xorshift32: seeded, printed with every failure of the cycles. */
export function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}
