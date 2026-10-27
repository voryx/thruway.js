// Server-side functions the browser tests call (vitest browser `commands`): each test gets its own fault proxy in front
// of a target (so a fault never touches another test's or another browser's connections), and drives it.
import type { BrowserCommand } from 'vitest/node';
import { getFixtures } from './fixtures.js';
import { startTcpProxy } from './tcp-proxy.js';

export type Fault = 'drop' | 'freeze' | 'thaw' | 'closingWindow';

/** A new proxy in front of the named target: its id and the WebSocket URL the page connects to. */
const proxy: BrowserCommand<[target: string]> = async (_context, target) => {
  const fixtures = getFixtures();
  const spec = fixtures.targets.find((t) => t.name === target);
  if (spec === undefined) throw new Error(`no browser target ${target}`);
  const tcp = await startTcpProxy({ host: spec.host, port: spec.port });
  const id = fixtures.nextProxy++;
  fixtures.proxies.set(id, tcp);
  return { id, url: `ws://127.0.0.1:${String(tcp.port)}${spec.path}` };
};

/** Apply a fault to the proxy's open connections; returns how many were open (the tests check that the fault hit
 *  their connection, not an empty proxy). */
const fault: BrowserCommand<[id: number, kind: Fault, ms?: number]> = (_context, id, kind, ms) => {
  const tcp = getFixtures().proxies.get(id);
  if (tcp === undefined) throw new Error(`no proxy ${String(id)}`);
  const open = tcp.connections;
  if (kind === 'closingWindow') tcp.closingWindow(ms ?? 500);
  else tcp[kind]();
  return open;
};

const closeProxy: BrowserCommand<[id: number]> = async (_context, id) => {
  const fixtures = getFixtures();
  await fixtures.proxies.get(id)?.close();
  fixtures.proxies.delete(id);
};

export const browserCommands = { proxy, fault, closeProxy };

declare module 'vitest/browser' {
  interface BrowserCommands {
    proxy: (target: string) => Promise<{ id: number; url: string }>;
    fault: (id: number, kind: Fault, ms?: number) => Promise<number>;
    closeProxy: (id: number) => Promise<void>;
  }
}
