// Real routers for the browser runs, through scripts/routers.mjs — the one way the suite builds, starts and stops
// routers. Thruway PHP 0.6.1 by default (BROWSER_ROUTER, see scripts/ci.mjs); any other router of scripts/routers.mjs
// on demand (e.g. BROWSER_ROUTER=thruway-php,crossbar). The containers are named <BROWSER_ROUTER_PREFIX>-<router>
// [thruwayjs-browser] and published on 127.0.0.1 from BROWSER_ROUTER_PORT_BASE [18400], apart from the integration
// project's (thruwayjs-it, 18300). This helper only removes the containers it started.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/routers.mjs', import.meta.url));
const CAPABILITIES = new URL('../integration/capabilities.json', import.meta.url);

/** Where each router's default endpoint and realm are recorded (the integration suite's capabilities file). */
interface CapabilityEntry {
  readonly endpoint: string;
  readonly realm: string;
}
/** What `scripts/routers.mjs describe` prints per router. */
interface Described {
  readonly container: string;
  readonly endpoints: Readonly<Record<string, string>>;
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ROUTER_PREFIX: process.env['BROWSER_ROUTER_PREFIX'] ?? 'thruwayjs-browser',
    ROUTER_PORT_BASE: process.env['BROWSER_ROUTER_PORT_BASE'] ?? '18400',
  };
}

function script(args: readonly string[], inherit = false): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: env(),
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout };
}

/** The routers scripts/routers.mjs knows that have a recorded default endpoint (the hostile ones have none). */
export function knownRouters(): readonly string[] {
  const file = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as { routers: Record<string, CapabilityEntry> };
  return Object.keys(file.routers);
}

const started = new Set<string>();
let exitHook = false;

/** Remove this run's containers, synchronously (also from a process 'exit' handler). */
export function removeStartedRouters(): void {
  if (started.size > 0) script(['stop', ...started], true);
  started.clear();
}

/** Start one router (scripts/routers.mjs builds a missing image, replaces a leftover container of the same name and
 *  waits until it answers a HELLO) and return its default endpoint as host, port, path and realm. */
export function startRouter(name: string): { host: string; port: number; path: string; realm: string } {
  const file = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as { routers: Record<string, CapabilityEntry> };
  const entry = file.routers[name];
  if (entry === undefined)
    throw new Error(`BROWSER_ROUTER: unknown router ${name} (known: ${knownRouters().join(', ')})`);
  const described = JSON.parse(script(['describe', name]).stdout) as Record<string, Described>;
  const url = described[name]?.endpoints[entry.endpoint];
  if (url === undefined) throw new Error(`scripts/routers.mjs describes no endpoint ${entry.endpoint} for ${name}`);
  started.add(name);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', removeStartedRouters);
  }
  if (script(['start', name], true).status !== 0) throw new Error(`scripts/routers.mjs start ${name} failed`);
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, realm: entry.realm };
}
