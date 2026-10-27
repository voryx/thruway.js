// The real routers of the integration suite: which are selected (ROUTERS) and available (started by the global setup
// through scripts/routers.mjs), their endpoints, realms, credentials and capability flags
// (test/integration/capabilities.json, validated by capabilities.test.ts), and router-level faults (restart, pause,
// SIGTERM, kill) — all through scripts/routers.mjs, the same way in CI and locally.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, inject, test } from 'vitest';

export type Tri = 'always' | 'never' | 'sometimes';

/** The capability keys. Every key is tri-state except the two that carry a value. */
export interface Capabilities {
  readonly cancel_interrupts_callee: Tri;
  readonly cancel_reply: Tri;
  readonly cancel_without_mode_interrupts: Tri;
  readonly progressive_results: Tri;
  readonly wildcard_subscribe_answered: Tri;
  readonly subscribe_match: Tri;
  readonly register_match: Tri;
  readonly goodbye_reply_delivered: Tri;
  readonly abort_delivered: Tri;
  /** How a test makes this router send a GOODBYE to a client: an admin RPC (Thruway PHP's test-only
   *  `thruway_test.goodbye_session`), the meta API (`wamp.session.kill`), SIGTERM (Bondy's system_shutdown), or the
   *  chaos proxy injecting one (routers without a trigger). */
  readonly router_goodbye_trigger: 'rpc' | 'meta' | 'sigterm' | 'proxy';
  readonly router_closes_after_goodbye: Tri;
  readonly exclude_me: Tri;
  readonly blackwhite_listing: Tri;
  readonly publisher_always_disclosed: Tri;
  readonly meta_kill: Tri;
  readonly strict_ids: Tri;
  /** The largest frame (bytes) the router forwards; larger ones close the connection (1009). */
  readonly max_message_bytes: number;
  readonly callee_leave_answer: Tri;
  readonly caller_leave_interrupts: Tri;
  readonly callee_error_forwarded: Tri;
  readonly duplicate_register_rejected: Tri;
  readonly args_nested_array_preserved: Tri;
  readonly event_details_topic: Tri;
  readonly wildcard_match: Tri;
  readonly invalid_realm_reply: Tri;
  readonly self_publish_order: Tri;
  readonly subprotocol_echo: Tri;
  readonly shared_subscription_ids: Tri;
  readonly multi_method_challenge: Tri;
  readonly anonymous_welcome_without_provider: Tri;
  readonly ghost_registrations: Tri;
  readonly probe_answered: Tri;
  /** Events of one publisher reach a subscriber in publication order (WAMP spec; Bondy reorders some). */
  readonly publisher_order_kept: Tri;
  /** The router tells the callee that the caller asked for progress (INVOCATION.Details.receive_progress, WAMP
   *  progressive_call_results); without it a spec-compliant callee answers with one final YIELD (Bondy). */
  readonly invocation_receive_progress: Tri;
  /** The payload of the final YIELD of a progressive call reaches the caller (a router may drop it and send an
   *  empty final RESULT instead). */
  readonly progressive_final_payload: Tri;
}
export type CapabilityKey = keyof Capabilities;

export interface Credential {
  readonly authid: string;
  readonly secret: string;
}
export interface AuthInfo {
  /** The endpoint and realm of the authenticated tests. */
  readonly endpoint: string;
  readonly realm: string;
  /** `ticket` (Bondy: its `password` method, a static secret; `method` says which name the router uses). */
  readonly ticket: (Credential & { readonly method: string }) | null;
  readonly wampcra: Credential | null;
  readonly wampcraSalted: Credential | null;
  readonly cryptosign: { readonly authid: string; readonly seed: string; readonly publicKey: string } | null;
  /** One authid known to both the ticket and the wampcra provider (two-method HELLOs, Thruway T6). */
  readonly dual: { readonly authid: string; readonly ticket: string; readonly wampcra: string } | null;
  /** ABORT reasons the router uses for a wrong secret. */
  readonly failureReasons: readonly string[];
}

export interface RouterEntry {
  readonly title: string;
  /** Default endpoint name and realm. */
  readonly endpoint: string;
  readonly realm: string;
  /** A realm with strict sequential request ids, when the router has one. */
  readonly strictRealm: string | null;
  /** Hostile routers run the hostile suite only. */
  readonly hostile: boolean;
  /** The router the auxiliary configurations belong to (thruway-php-anon → thruway-php). */
  readonly auth: AuthInfo | null;
  /** REGISTER options of recipe 16 for this router (Thruway `replace_orphaned_session`, Crossbar `force_reregister`). */
  readonly reregisterOptions: Readonly<Record<string, unknown>>;
  /** The chaos schedules may restart it (Bondy needs ~15 s). */
  readonly restartable: boolean;
  readonly capabilities: Capabilities;
}

export interface CapabilitiesFile {
  readonly $schema?: string;
  readonly routers: Readonly<Record<string, RouterEntry>>;
}

/** What scripts/routers.mjs `describe` prints per router. */
export interface Described {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly image: string;
  readonly container: string;
  readonly endpoints: Readonly<Record<string, string>>;
}

/** Provided by the global setup (test/integration/harness/global-setup.ts). */
export interface RoutersContext {
  readonly selected: readonly string[];
  readonly ready: readonly string[];
  readonly described: Readonly<Record<string, Described>>;
  readonly require: boolean;
}

declare module 'vitest' {
  export interface ProvidedContext {
    routers: RoutersContext;
  }
}

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../../scripts/routers.mjs', import.meta.url));

export function loadCapabilities(): CapabilitiesFile {
  return JSON.parse(readFileSync(new URL('../capabilities.json', import.meta.url), 'utf8')) as CapabilitiesFile;
}

/** The routers every matrix test runs against, in this order; wamp-server is hostile-only. */
export const MATRIX = ['thruway-php', 'crossbar', 'bondy', 'nexus-3.3.1', 'nexus-main', 'nxt', 'fox-wamp'] as const;
export const HOSTILE = ['wamp-server'] as const;
/** The routers of the default run (ROUTERS unset or empty: `npm run test:integration`, the ci integration stage):
 *  Thruway PHP, the first-class router, with its auxiliary configurations. ROUTERS=all runs every router. */
export const DEFAULT_ROUTERS = ['thruway-php'] as const;
/** Auxiliary router configurations started with their router. */
export const AUXILIARY: Readonly<Record<string, readonly string[]>> = {
  'thruway-php': ['thruway-php-anon'],
};

export interface Router extends RouterEntry {
  readonly id: string;
  readonly version: string;
  readonly container: string;
  /** Endpoint name → ws:// URL. */
  readonly endpoints: Readonly<Record<string, string>>;
  /** The default endpoint's URL. */
  readonly url: string;
  readonly available: boolean;
  /** Router-level faults (scripts/routers.mjs). */
  readonly control: RouterControl;
}

export interface RouterControl {
  restart(): Promise<void>;
  pause(): Promise<void>;
  unpause(): Promise<void>;
  /** `podman kill --signal` (TERM: Bondy's system_shutdown GOODBYE); the container then usually stops. */
  kill(signal?: string): Promise<void>;
  /** Start the container again if it stopped, and wait until the router answers. */
  waitReady(): Promise<void>;
  exec(...args: string[]): Promise<string>;
  logs(): string;
}

/** Run scripts/routers.mjs with the test's environment; rejects on a non-zero exit. */
export function routersScript(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`routers.mjs ${args.join(' ')} exited ${String(code)}: ${err}${out}`));
    });
  });
}

function control(id: string): RouterControl {
  return {
    restart: async () => {
      await routersScript(['restart', id]);
    },
    pause: async () => {
      await routersScript(['pause', id]);
    },
    unpause: async () => {
      await routersScript(['unpause', id]);
    },
    kill: async (signal = 'KILL') => {
      await routersScript(['kill', id, signal]);
    },
    waitReady: async () => {
      await routersScript(['wait', id]);
    },
    exec: (...args) => routersScript(['exec', id, ...args]),
    logs: () => spawnSync(process.execPath, [SCRIPT, 'logs', id], { encoding: 'utf8' }).stdout,
  };
}

let cached: RoutersContext | undefined;
function context(): RoutersContext {
  cached ??= inject('routers');
  return cached;
}

/** One router by id (an auxiliary configuration included). */
export function router(id: string): Router {
  const ctx = context();
  const file = loadCapabilities();
  const entry = file.routers[id];
  const described = ctx.described[id];
  if (entry === undefined || described === undefined) throw new Error(`unknown router ${id}`);
  const url = described.endpoints[entry.endpoint];
  if (url === undefined) throw new Error(`${id}: no endpoint ${entry.endpoint}`);
  return {
    ...entry,
    id,
    version: described.version,
    container: described.container,
    endpoints: described.endpoints,
    url,
    available: ctx.ready.includes(id),
    control: control(id),
  };
}

/** The selected routers of a group (ROUTERS), in matrix order. */
export function selected(group: readonly string[] = MATRIX): readonly Router[] {
  const ctx = context();
  return group.filter((id) => ctx.selected.includes(id)).map(router);
}

/** A router's endpoint URL by name. */
export function endpoint(r: Router, name: string): string {
  const url = r.endpoints[name];
  if (url === undefined) throw new Error(`${r.id} has no endpoint ${name}`);
  return url;
}

/** A capability flag (typed: an unknown key does not compile). */
export function cap<K extends CapabilityKey>(r: Router, key: K): Capabilities[K] {
  if (!(key in r.capabilities)) throw new Error(`${r.id}: capability ${key} missing from capabilities.json`);
  return r.capabilities[key];
}

/**
 * `describe` once per selected router of `group` (default: the matrix). An unavailable router skips its block, or —
 * with REQUIRE_ROUTERS=1 — fails it. Router names appear in the titles; tests inside gate on capabilities, never on
 * the router name.
 */
export function describeRouters(title: string, body: (r: Router) => void, group: readonly string[] = MATRIX): void {
  const routers = selected(group);
  // A file whose routers are all outside ROUTERS (e.g. the hostile suite in the default Thruway-only run) still needs
  // one test, or vitest fails it with "No test suite found".
  if (routers.length === 0) test.skip(`${title}: none of ${group.join(', ')} selected (ROUTERS)`, () => undefined);
  for (const r of routers) {
    describe(`${title} [${r.id}]`, () => {
      if (!r.available) {
        if (context().require) {
          test(`${r.id} is available`, () => {
            throw new Error(`router ${r.id} is not available (REQUIRE_ROUTERS=1)`);
          });
        } else {
          test.skip(`${r.id} is not available`, () => undefined);
        }
        return;
      }
      body(r);
    });
  }
}
