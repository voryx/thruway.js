/**
 * HELLO details: exactly `agent`, `roles` and — only when given — `authmethods`, `authid`, `authextra`; nothing else
 * from the options ever leaks. Only features implemented end to end are announced: not `call_timeout`,
 * `progressive_call_invocations`, `payload_passthru_mode`, `sharded_*`, `call_trustlevels`, `publication_trustlevels`
 * or `event_retention`. The callee announces `call_canceling` because INTERRUPT is handled (Thruway refuses CANCEL for
 * callees that do not). `hello.test.ts` snapshots the constant and checks `AGENT` against package.json.
 *
 * @module
 */
import type { Dict } from './messages.js';

export const AGENT = 'thruway.js/3.0.0-beta2';

/** One frozen role entry: `{features: {…}}`. */
function role<F extends Readonly<Record<string, true>>>(features: F): { readonly features: F } {
  return Object.freeze({ features: Object.freeze(features) });
}

/** HELLO.Details.roles, deeply frozen: the same object goes into every HELLO. */
export const HELLO_ROLES = Object.freeze({
  caller: role({ caller_identification: true, progressive_call_results: true, call_canceling: true }),
  callee: role({
    caller_identification: true,
    pattern_based_registration: true,
    shared_registration: true,
    progressive_call_results: true,
    call_canceling: true,
    registration_revocation: true,
  }),
  publisher: role({ publisher_identification: true, subscriber_blackwhite_listing: true, publisher_exclusion: true }),
  subscriber: role({ publisher_identification: true, pattern_based_subscription: true, subscription_revocation: true }),
});

/** The HELLO details dict for these (already validated) options: `authmethods` only when non-empty, `authid` and
 *  `authextra` only when defined. A new frozen object per call; `authmethods` is copied. */
export function helloDetails(auth: {
  readonly authmethods: readonly string[];
  readonly authid: string | undefined;
  readonly authextra: Readonly<Record<string, unknown>> | undefined;
}): Dict {
  const details: Record<string, unknown> = { agent: AGENT, roles: HELLO_ROLES };
  if (auth.authmethods.length > 0) details['authmethods'] = Object.freeze(auth.authmethods.slice());
  if (auth.authid !== undefined) details['authid'] = auth.authid;
  if (auth.authextra !== undefined) details['authextra'] = auth.authextra;
  return Object.freeze(details);
}
