// globalSetup of the `browser` project: starts, on 127.0.0.1, the reference server (the simulation's router behind
// `ws`), a TLS server with the untrusted test certificate and a refused port for the connect-failure cases, and — for
// each router named in BROWSER_ROUTER (thruway-php by default in CI; any router of scripts/routers.mjs, e.g. crossbar)
// — its podman container (test/browser/routers.ts, through scripts/routers.mjs). With REQUIRE_ROUTERS=1 (CI) every
// named router must come up; otherwise one that cannot start is left out with a warning. Tests reach every target
// through their own fault proxy (commands.ts), so the pages are served from loopback and talk to loopback only
// (Chromium's local-network rule).
import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import type { TestProject } from 'vitest/node';
import { startReferenceServer } from '../helpers/ws-reference-server.js';
import { setFixtures, type BrowserTarget, type FailureEndpoints } from './fixtures.js';
import type { TcpProxy } from './tcp-proxy.js';
import { removeStartedRouters, startRouter } from './routers.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The routers of this run: always the reference server, plus BROWSER_ROUTER's real routers. */
    browserTargets: { name: string; realm: string }[];
    browserFailures: FailureEndpoints;
  }
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return (server.address() as net.AddressInfo).port;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const reference = await startReferenceServer();
  reference.router.procedure('com.example.add', (args) => (args[0] as number) + (args[1] as number));
  const targets: BrowserTarget[] = [
    { name: 'reference', host: '127.0.0.1', port: reference.port, path: '/', realm: 'realm1' },
  ];

  const requested = (process.env['BROWSER_ROUTER'] ?? '').split(',').filter((name) => name !== '');
  const required = process.env['REQUIRE_ROUTERS'] === '1';
  if (required && requested.length === 0) throw new Error('REQUIRE_ROUTERS=1 needs BROWSER_ROUTER (e.g. thruway-php)');
  for (const name of requested) {
    try {
      const { host, port, path, realm } = startRouter(name);
      targets.push({ name, host, port, path, realm });
    } catch (error) {
      if (required) {
        removeStartedRouters();
        await reference.close();
        throw error;
      }
      console.warn(`browser: ${name} is not available (${String(error)}); its cases are left out`);
    }
  }

  const tls = https.createServer({
    key: readFileSync(new URL('../fixtures/tls/self-signed.key', import.meta.url)),
    cert: readFileSync(new URL('../fixtures/tls/self-signed.crt', import.meta.url)),
  });
  const tlsPort = await listen(tls);
  const gone = net.createServer();
  const refusedPort = await listen(gone);
  await new Promise<void>((resolve) => {
    gone.close(() => {
      resolve();
    });
  });
  const failures: FailureEndpoints = {
    tlsToPlain: `wss://127.0.0.1:${String(reference.port)}/`,
    tlsUntrusted: `wss://127.0.0.1:${String(tlsPort)}/`,
    refused: `ws://127.0.0.1:${String(refusedPort)}/`,
    dns: 'ws://nonexistent.invalid/',
  };

  const fixtures = {
    reference,
    targets,
    failures,
    proxies: new Map<number, TcpProxy>(),
    nextProxy: 1,
    close: async () => {
      for (const proxy of fixtures.proxies.values()) await proxy.close();
      fixtures.proxies.clear();
      await reference.close();
      tls.closeAllConnections();
      await new Promise<void>((resolve) => {
        tls.close(() => {
          resolve();
        });
      });
      removeStartedRouters();
    },
  };
  setFixtures(fixtures);
  project.provide(
    'browserTargets',
    targets.map(({ name, realm }) => ({ name, realm })),
  );
  project.provide('browserFailures', failures);
  return async () => {
    setFixtures(undefined);
    await fixtures.close();
  };
}
