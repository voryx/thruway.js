#!/usr/bin/env node
// The real WAMP routers of the integration suite, under podman — the one way they are built, started, probed, faulted
// and stopped, for CI and for local runs alike. The router setups are vendored under test/routers/.
//
//   node scripts/routers.mjs <command> [router…] [--json]
//
//   list                      the routers, their images, containers and host ports
//   describe [router…]        endpoints, containers, images as JSON (read by test/integration/harness/routers.ts)
//   build [router…]           build (or pull) the images that are missing; REBUILD=1 rebuilds
//   start [router…|all]       (re)create the containers and wait until each answers a WAMP HELLO; prints versions
//   stop [router…|all]        remove the containers (images are kept)
//   status [router…]          running / ready per router
//   restart <router>          podman restart (SIGTERM, then SIGKILL after the router's stop timeout), wait until ready
//   kill <router> [signal]    podman kill --signal (default KILL); `kill bondy TERM` = Bondy's system_shutdown GOODBYE
//   pause <router> | unpause <router>   freeze / thaw every process of the router (half-open sockets)
//   wait <router>             wait until the router answers a HELLO again
//   exec <router> <cmd…>      podman exec in the router's container (the late-provider controls: provider.sh)
//   logs <router>             the container log
//   hash <router>             sha256 of the router's build inputs (CI image cache key)
//   stats <router>            the container's CPU % right now (the herd soak samples it)
//   --require-env NAME        (npm run test:integration) validate the router list in NAME ("all" or ids); unset or
//                             empty: the default set, Thruway PHP only (thruway-php + thruway-php-anon)
//
// Environment (every name has a default, so CI and local runs differ only by what they set):
//   ROUTER_PREFIX     container name prefix                       [thruwayjs-it]  → <prefix>-<router>
//   ROUTER_PORT_BASE  first host port; each router has an offset  [18300]         (bound to ROUTER_BIND only)
//   ROUTER_BIND       host interface                              [127.0.0.1]
//   ROUTER_NODE_IMAGE base image of the Node routers (fox-wamp, wamp-server) [docker.io/library/node:22-alpine]
//   FOX_WAMP_NODE_MODULES / WAMP_SERVER_NODE_MODULES   a node_modules directory to copy into the image instead of
//                     `npm ci` during the build (offline builds)
//   REBUILD=1         rebuild images even if they exist
//   ROUTER_PODMAN     the podman command [podman] (CI: `sudo podman`, where rootless pause has no cgroup)
//
// Exit status: 0 ok, 1 failure, 2 usage error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROUTERS_DIR = path.join(ROOT, 'test', 'routers');

/**
 * @typedef {{ readonly port: number, readonly path: string }} Endpoint  `port`: offset from ROUTER_PORT_BASE
 * @typedef {{
 *   readonly id: string,
 *   readonly title: string,
 *   readonly version: string,
 *   readonly image: string,
 *   readonly pull?: boolean,
 *   readonly build?: { readonly dir: string, readonly file: string, readonly args?: Readonly<Record<string, string>>,
 *                      readonly nodeImage?: boolean, readonly modulesEnv?: string },
 *   readonly ports: Readonly<Record<number, number>>,
 *   readonly endpoints: Readonly<Record<string, Endpoint>>,
 *   readonly mounts?: readonly (readonly [string, string, string])[],
 *   readonly env?: Readonly<Record<string, string>>,
 *   readonly entrypoint?: string,
 *   readonly command?: readonly string[],
 *   readonly init?: boolean,
 *   readonly stopTimeout: number,
 *   readonly ready: { readonly endpoint: string, readonly realm: string, readonly timeout: number },
 * }} RouterDef
 */

/** @type {readonly RouterDef[]} */
const DEFS = [
  {
    id: 'thruway-php',
    title: 'Thruway PHP',
    version: 'voryx/thruway 0.6.1, thruway/client 0.5.8, PHP 8.3',
    image: 'localhost/thruwayjs-router-thruway-php:0.6.1',
    build: { dir: 'thruway-php', file: 'Containerfile' },
    ports: { 0: 8080, 1: 8081 },
    endpoints: { auth: { port: 0, path: '/' }, noauth: { port: 1, path: '/' } },
    mounts: [
      ['thruway-php/config.json', '/app/config.json', 'ro,Z'],
      ['thruway-php/router.php', '/app/router.php', 'ro,Z'],
    ],
    init: true,
    stopTimeout: 2,
    ready: { endpoint: 'auth', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'thruway-php-anon',
    title: 'Thruway PHP, late external provider',
    version: 'voryx/thruway 0.6.1 (stock AuthenticationManager, external extauth provider)',
    image: 'localhost/thruwayjs-router-thruway-php:0.6.1',
    build: { dir: 'thruway-php', file: 'Containerfile' },
    ports: { 2: 8080 },
    endpoints: { late: { port: 2, path: '/' } },
    mounts: [['thruway-php/anon', '/app/anon', 'ro,Z']],
    command: ['sh', '/app/anon/entry.sh'],
    init: true,
    stopTimeout: 2,
    ready: { endpoint: 'late', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'crossbar',
    title: 'Crossbar.io',
    version: 'crossbar 26.10.1 (Python 3.12)',
    image: 'localhost/thruway-crossbar:26.10.1',
    build: { dir: 'crossbar', file: 'Containerfile', args: { CROSSBAR_VERSION: '26.10.1' } },
    ports: { 3: 18080 },
    endpoints: { ws: { port: 3, path: '/ws' }, auth: { port: 3, path: '/auth' }, ping: { port: 3, path: '/ws-ping' } },
    mounts: [['crossbar/config.json', '/node/.crossbar/config.json', 'ro,Z']],
    command: ['start', '--cbdir', '/node/.crossbar', '--loglevel', 'warn'],
    stopTimeout: 5,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 90000 },
  },
  {
    id: 'bondy',
    title: 'Bondy',
    version: 'bondy 1.0.0-rc.65',
    image: 'docker.io/leapsight/bondy:1.0.0-rc.65',
    pull: true,
    ports: { 4: 18080 },
    endpoints: { ws: { port: 4, path: '/ws' } },
    mounts: [['bondy/etc', '/cfg', 'ro']],
    env: { BONDY_ERL_NODENAME: 'bondy@127.0.0.1', BONDY_ERL_DISTRIBUTED_COOKIE: 'bondy' },
    entrypoint: 'bash',
    // /bondy/etc must be writable by uid 1000 (cuttlefish writes etc/generated/*): copy the read-only config in
    command: ['-c', 'cp /cfg/bondy.conf /cfg/security_config.json /bondy/etc/ && exec bondy foreground'],
    stopTimeout: 10,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 120000 },
  },
  {
    id: 'nexus-3.3.1',
    title: 'Nexus v3.3.1',
    version: 'gammazero/nexus v3.3.1',
    image: 'localhost/thruway-nexus:v3.3.1',
    build: { dir: 'nexus', file: 'Containerfile', args: { NEXUS_VERSION: 'v3.3.1' } },
    ports: { 5: 8080 },
    endpoints: { ws: { port: 5, path: '/' } },
    mounts: [['nexus/nexus-test.json', '/etc/nexus-test.json', 'ro']],
    stopTimeout: 5,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'nexus-main',
    title: 'Nexus main',
    version: 'gammazero/nexus main 0ddca09 (v3.3.2-0.20261025192937-0ddca0973a75)',
    image: 'localhost/thruway-nexus:main',
    build: { dir: 'nexus', file: 'Containerfile', args: { NEXUS_VERSION: '0ddca0973a75' } },
    ports: { 6: 8080 },
    endpoints: { ws: { port: 6, path: '/' } },
    mounts: [['nexus/nexus-test.json', '/etc/nexus-test.json', 'ro']],
    stopTimeout: 5,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'nxt',
    title: 'xconn nxt',
    version: 'xconn-go nxt 683389304fa4 (v0.1.1-0.20261023141601)',
    image: 'localhost/thruway-nxt:683389304fa4',
    build: { dir: 'xconn-nxt', file: 'Containerfile', args: { XCONN_REF: '683389304fa4' } },
    ports: { 7: 8080 },
    endpoints: { ws: { port: 7, path: '/ws' } },
    mounts: [['xconn-nxt/config/.nxt/config.yaml', '/nxt/.nxt/config.yaml', 'ro']],
    stopTimeout: 5,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'fox-wamp',
    title: 'fox-wamp',
    version: 'fox-wamp 0.7.28',
    image: 'localhost/thruwayjs-router-fox-wamp:0.7.28',
    build: { dir: 'fox-wamp', file: 'Containerfile', nodeImage: true, modulesEnv: 'FOX_WAMP_NODE_MODULES' },
    mounts: [
      ['fox-wamp/config.json', '/app/config.json', 'ro'],
      ['fox-wamp/router.cjs', '/app/router.cjs', 'ro'],
    ],
    ports: { 8: 8080 },
    endpoints: { ws: { port: 8, path: '/' } },
    stopTimeout: 2,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 30000 },
  },
  {
    id: 'wamp-server',
    title: 'wamp-server (hostile)',
    version: 'wamp-server 0.0.9',
    image: 'localhost/thruwayjs-router-wamp-server:0.0.9',
    build: { dir: 'wamp-server', file: 'Containerfile', nodeImage: true, modulesEnv: 'WAMP_SERVER_NODE_MODULES' },
    mounts: [['wamp-server/router.cjs', '/app/router.cjs', 'ro']],
    ports: { 9: 8080 },
    endpoints: { ws: { port: 9, path: '/' } },
    stopTimeout: 2,
    ready: { endpoint: 'ws', realm: 'realm1', timeout: 30000 },
  },
];

const IDS = DEFS.map((d) => d.id);
const PREFIX = process.env['ROUTER_PREFIX'] ?? 'thruwayjs-it';
const BASE = Number(process.env['ROUTER_PORT_BASE'] ?? '18300');
const BIND = process.env['ROUTER_BIND'] ?? '127.0.0.1';
const NODE_IMAGE = process.env['ROUTER_NODE_IMAGE'] ?? 'docker.io/library/node:22-alpine';
const [PODMAN = 'podman', ...PODMAN_ARGS] = (process.env['ROUTER_PODMAN'] ?? 'podman')
  .split(' ')
  .filter((p) => p !== '');

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(`routers: ${message}\nusage: node scripts/routers.mjs <command> [router…] [--json] (see the header)`);
  process.exit(2);
}

/** @param {string} id @returns {RouterDef} */
function def(id) {
  const found = DEFS.find((d) => d.id === id);
  if (found === undefined) usage(`unknown router "${id}" (routers: ${IDS.join(', ')})`);
  return found;
}

/** @param {readonly string[]} names @returns {RouterDef[]} */
function select(names) {
  if (names.length === 0 || names.includes('all')) return [...DEFS];
  return [...new Set(names.flatMap((n) => n.split(',')).filter((n) => n !== ''))].map(def);
}

/** @param {RouterDef} d */
function container(d) {
  return `${PREFIX}-${d.id}`;
}

/** @param {RouterDef} d */
function describe(d) {
  return {
    id: d.id,
    title: d.title,
    version: d.version,
    image: d.image,
    container: container(d),
    endpoints: Object.fromEntries(
      Object.entries(d.endpoints).map(([name, e]) => [name, `ws://${BIND}:${String(BASE + e.port)}${e.path}`]),
    ),
  };
}

/**
 * @param {readonly string[]} args
 * @param {{ readonly quiet?: boolean, readonly input?: string }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function podman(args, options = {}) {
  const result = spawnSync(PODMAN, [...PODMAN_ARGS, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: `${result.stderr}${result.error ? String(result.error) : ''}`,
  };
  if (out.status !== 0 && options.quiet !== true) process.stderr.write(out.stderr);
  return out;
}

/** @param {string} image */
function imageExists(image) {
  return podman(['image', 'exists', image], { quiet: true }).status === 0;
}

/** sha256 over every build input of a router (file names and contents, sorted). @param {RouterDef} d */
function inputHash(d) {
  const hash = createHash('sha256');
  hash.update(`${d.image}\n${JSON.stringify(d.build ?? {})}\n${d.build?.nodeImage === true ? NODE_IMAGE : ''}\n`);
  const dir = d.build === undefined ? undefined : path.join(ROUTERS_DIR, d.build.dir);
  /** @param {string} at */
  const walk = (at) => {
    for (const entry of readdirSync(at).sort()) {
      const full = path.join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(`${path.relative(ROUTERS_DIR, full)}\n`).update(readFileSync(full));
    }
  };
  if (dir !== undefined) walk(dir);
  return hash.digest('hex');
}

/** @param {RouterDef} d */
function build(d) {
  if (process.env['REBUILD'] !== '1' && imageExists(d.image)) return true;
  if (d.pull === true) {
    console.log(`routers: pulling ${d.image}`);
    return podman(['pull', d.image]).status === 0;
  }
  const b = d.build;
  if (b === undefined) return false;
  const dir = path.join(ROUTERS_DIR, b.dir);
  /** @type {string[]} */
  const args = ['build', '-t', d.image, '-f', path.join(dir, b.file)];
  for (const [key, value] of Object.entries(b.args ?? {})) args.push('--build-arg', `${key}=${value}`);
  if (b.nodeImage === true) args.push('--build-arg', `NODE_IMAGE=${NODE_IMAGE}`);
  const modules = b.modulesEnv === undefined ? undefined : process.env[b.modulesEnv];
  // A local node_modules is mounted into the build (RUN steps only), so an offline build copies it instead of npm ci
  if (modules !== undefined && modules !== '') args.push('-v', `${path.resolve(modules)}:/deps/node_modules:ro`);
  args.push(dir);
  console.log(`routers: building ${d.image} from test/routers/${b.dir}`);
  return podman(args).status === 0;
}

/** @param {RouterDef} d */
function running(d) {
  const r = podman(['inspect', '-f', '{{.State.Running}}', container(d)], { quiet: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** @param {RouterDef} d */
function remove(d) {
  podman(['rm', '-f', '-t', String(d.stopTimeout), container(d)], { quiet: true });
}

/** @param {RouterDef} d */
function run(d) {
  /** @type {string[]} */
  const args = ['run', '-d', '--name', container(d), '--stop-timeout', String(d.stopTimeout)];
  if (d.init === true) args.push('--init');
  for (const [offset, port] of Object.entries(d.ports))
    args.push('-p', `${BIND}:${String(BASE + Number(offset))}:${String(port)}`);
  for (const [from, to, mode] of d.mounts ?? []) args.push('-v', `${path.join(ROUTERS_DIR, from)}:${to}:${mode}`);
  for (const [key, value] of Object.entries(d.env ?? {})) args.push('-e', `${key}=${value}`);
  if (d.entrypoint !== undefined) args.push('--entrypoint', d.entrypoint);
  args.push(d.image, ...(d.command ?? []));
  return podman(args).status === 0;
}

/**
 * One HELLO on the router's ready endpoint: resolves with the first answer's message type (WELCOME 2, ABORT 3,
 * CHALLENGE 4), or undefined when nothing answered within `ms`.
 * @param {string} url @param {string} realm @param {number} ms @returns {Promise<number | undefined>}
 */
function hello(url, realm, ms) {
  return new Promise((resolve) => {
    /** @type {WebSocket | undefined} */
    let ws;
    let settled = false;
    const done = (/** @type {number | undefined} */ type) => {
      // once: Node 22's undici dispatches error/close synchronously from close() on a connecting socket, and those
      // listeners call done again (unguarded, that recursed until the stack overflowed and the router read as down)
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
      resolve(type);
    };
    const timer = setTimeout(() => {
      done(undefined);
    }, ms);
    try {
      ws = new WebSocket(url, ['wamp.2.json']);
    } catch {
      done(undefined);
      return;
    }
    const socket = ws;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify([1, realm, { roles: { caller: {}, callee: {}, publisher: {}, subscriber: {} } }]));
    });
    ws.addEventListener('message', (event) => {
      try {
        const frame = /** @type {unknown} */ (JSON.parse(String(event.data)));
        done(Array.isArray(frame) && typeof frame[0] === 'number' ? frame[0] : undefined);
      } catch {
        done(undefined);
      }
    });
    ws.addEventListener('error', () => {
      done(undefined);
    });
    ws.addEventListener('close', () => {
      done(undefined);
    });
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the router answers a HELLO (any answer). @param {RouterDef} d @returns {Promise<number | undefined>} ms */
async function waitReady(d, timeout = d.ready.timeout) {
  const url = describe(d).endpoints[d.ready.endpoint] ?? '';
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if ((await hello(url, d.ready.realm, 2000)) !== undefined) return Math.round(performance.now() - started);
    if (!running(d)) return undefined;
    await sleep(250);
  }
  return undefined;
}

/** @param {readonly RouterDef[]} defs */
async function start(defs) {
  let ok = true;
  for (const d of defs) {
    if (!build(d)) {
      console.error(`routers: ${d.id}: no image ${d.image}`);
      ok = false;
    }
  }
  if (!ok) return false;
  const started = await Promise.all(
    defs.map(async (d) => {
      remove(d);
      if (!run(d)) return false;
      const ms = await waitReady(d);
      if (ms === undefined) {
        console.error(`routers: ${d.id} (${container(d)}) did not become ready; last log lines:`);
        process.stderr.write(podman(['logs', '--tail', '40', container(d)], { quiet: true }).stderr);
        return false;
      }
      const info = describe(d);
      console.log(
        `routers: ${d.id} ready in ${String(ms)} ms — ${d.version} — ${Object.values(info.endpoints).join(' ')} (${info.container})`,
      );
      return true;
    }),
  );
  return started.every(Boolean);
}

// --- main -----------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const positional = argv.filter((a) => a !== '--json');
const [command, ...rest] = positional;

/** @param {unknown} value */
function print(value) {
  console.log(JSON.stringify(value, null, json ? 2 : undefined));
}

/** @param {boolean} ok */
function exit(ok) {
  process.exit(ok ? 0 : 1);
}

switch (command ?? '') {
  case '--require-env': {
    const name = rest[0] ?? usage('--require-env needs a variable name');
    const value = process.env[name] ?? '';
    if (value === '') {
      console.log(
        `routers: ${name} is not set: Thruway PHP only (the default). Other routers on demand, e.g.\n` +
          `  ${name}=all npm run test:integration\n  ${name}=thruway-php,crossbar npm run test:integration\n` +
          `(routers: ${IDS.join(', ')}; REQUIRE_ROUTERS=1 turns an unavailable router into a failure)`,
      );
      break;
    }
    select(value.split(',')); // validates the ids (usage error for an unknown one)
    break;
  }
  case 'list':
    for (const d of DEFS) {
      const info = describe(d);
      console.log(
        `${d.id.padEnd(17)} ${info.container.padEnd(32)} ${Object.values(info.endpoints).join(' ')}  ${d.image}`,
      );
    }
    break;
  case 'describe':
    print(Object.fromEntries(select(rest).map((d) => [d.id, describe(d)])));
    break;
  case 'build':
    exit(select(rest).every(build));
    break;
  case 'start':
    exit(await start(select(rest)));
    break;
  case 'stop':
    for (const d of select(rest)) {
      remove(d);
      console.log(`routers: removed ${container(d)}`);
    }
    break;
  case 'status': {
    const out = await Promise.all(
      select(rest).map(async (d) => ({
        id: d.id,
        running: running(d),
        ready: running(d) && (await waitReady(d, 2500)) !== undefined,
      })),
    );
    if (json) print(out);
    else for (const s of out) console.log(`${s.id.padEnd(17)} running=${String(s.running)} ready=${String(s.ready)}`);
    break;
  }
  case 'restart': {
    const d = def(rest[0] ?? usage('restart needs a router'));
    podman(['restart', '-t', String(d.stopTimeout), container(d)]);
    exit((await waitReady(d)) !== undefined);
    break;
  }
  case 'kill': {
    const d = def(rest[0] ?? usage('kill needs a router'));
    exit(podman(['kill', '--signal', rest[1] ?? 'KILL', container(d)]).status === 0);
    break;
  }
  case 'pause':
  case 'unpause': {
    const action = command === 'pause' ? 'pause' : 'unpause';
    const d = def(rest[0] ?? usage(`${action} needs a router`));
    exit(podman([action, container(d)]).status === 0);
    break;
  }
  case 'wait': {
    // after `kill`: the container may still be shutting down; start it once it has stopped, then wait for a HELLO
    const d = def(rest[0] ?? usage('wait needs a router'));
    const until = performance.now() + d.ready.timeout;
    let ready = false;
    while (!ready && performance.now() < until) {
      if (!running(d)) podman(['start', container(d)]);
      ready = (await waitReady(d, Math.max(1000, until - performance.now()))) !== undefined;
      if (!ready) await sleep(250);
    }
    exit(ready);
    break;
  }
  case 'exec': {
    const d = def(rest[0] ?? usage('exec needs a router'));
    const r = podman(['exec', container(d), ...rest.slice(1)]);
    process.stdout.write(r.stdout);
    exit(r.status === 0);
    break;
  }
  case 'logs': {
    const d = def(rest[0] ?? usage('logs needs a router'));
    const r = podman(['logs', container(d)], { quiet: true });
    process.stdout.write(r.stdout + r.stderr);
    break;
  }
  case 'hash':
    console.log(inputHash(def(rest[0] ?? usage('hash needs a router'))));
    break;
  case 'stats': {
    const d = def(rest[0] ?? usage('stats needs a router'));
    const r = podman(['stats', '--no-stream', '--format', '{{.CPUPerc}}', container(d)], { quiet: true });
    console.log(Number.parseFloat(r.stdout));
    break;
  }
  default:
    usage(command === undefined ? 'missing command' : `unknown command "${command}"`);
}
