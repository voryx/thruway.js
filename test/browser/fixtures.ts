// The Node-side fixtures of the browser runs, shared by test/browser/global-setup.ts (which starts them) and
// test/browser/commands.ts (server-side functions the browser tests call). Vitest loads the two through different
// module graphs (the config is bundled, globalSetup is not), so the state lives on `globalThis` of the Vitest process.
import type { ReferenceServer } from '../helpers/ws-reference-server.js';
import type { TcpProxy } from './tcp-proxy.js';

/** A router the browser tests run against: the reference server, or a real one under podman. */
export interface BrowserTarget {
  readonly name: string;
  /** Where a proxy connects to. */
  readonly host: string;
  readonly port: number;
  /** WebSocket path on the router. */
  readonly path: string;
  readonly realm: string;
}

/** Endpoints of the connect-failure cases. */
export interface FailureEndpoints {
  /** wss:// to the plain reference server's port (no TLS there). */
  readonly tlsToPlain: string;
  /** wss:// to a TLS server whose certificate (test/fixtures/tls/self-signed.*) the browser does not trust. */
  readonly tlsUntrusted: string;
  /** ws:// to a port nobody listens on. */
  readonly refused: string;
  /** RFC 6761 reserves .invalid: resolution fails everywhere. */
  readonly dns: string;
}

export interface BrowserFixtures {
  readonly reference: ReferenceServer;
  readonly targets: readonly BrowserTarget[];
  readonly failures: FailureEndpoints;
  /** Proxies created by tests (`commands.proxy`), by id. */
  readonly proxies: Map<number, TcpProxy>;
  nextProxy: number;
  close(): Promise<void>;
}

const KEY = Symbol.for('thruway.js.browser-fixtures');

export function setFixtures(fixtures: BrowserFixtures | undefined): void {
  (globalThis as Record<symbol, unknown>)[KEY] = fixtures;
}

export function getFixtures(): BrowserFixtures {
  const fixtures = (globalThis as Record<symbol, unknown>)[KEY] as BrowserFixtures | undefined;
  if (fixtures === undefined) throw new Error('the browser fixtures are not started (test/browser/global-setup.ts)');
  return fixtures;
}
