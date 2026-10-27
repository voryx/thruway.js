// The soak and the herd soak (`scripts/soak.mjs`). Skipped unless SOAK=1 — run them with `node scripts/soak.mjs` (which
// sets the variables below, NODE_OPTIONS=--expose-gc, and writes the JSON report).
//
// soak (SOAK_MODE=soak): the chaos workload (harness/workload.ts) with SOAK_CLIENTS clients for SOAK_MINUTES, one fault
//   every 30–120 s, every client checked online (bounded StreamingChecks); a sample per minute after gc(): heap,
//   active resources, open and unreleased sockets per client. Pass: no check problem, convergence after the final heal,
//   heap growth between minute 10 (or the first third) and the end < 10 %, active resources not growing, never more
//   than one unreleased socket per client.
// herd (SOAK_MODE=herd): SOAK_CLIENTS clients with the default retry and timeout settings, each with a topic, through
//   a router restart: reports the spread of reconnect arrivals, attempts per client, handshake/connect timeouts and
//   the router's CPU while the herd comes back.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { eventually, itClient, uri, type ItClient } from './harness/recorder.js';
import { describeRouters, HOSTILE, MATRIX, routersScript, type Router } from './harness/routers.js';
import { delay } from './harness/scenarios.js';
import { Workload } from './harness/workload.js';

const SOAK = process.env['SOAK'] === '1';
const MODE = process.env['SOAK_MODE'] ?? 'soak';
const MINUTES = Number(process.env['SOAK_MINUTES'] ?? '60');
const CLIENTS = Number(process.env['SOAK_CLIENTS'] ?? (MODE === 'herd' ? '200' : '20'));
const SEED = Number(process.env['SOAK_SEED'] ?? String(Date.now() % 1000000));
const OUT = process.env['SOAK_OUT'] ?? 'soak-results';

interface Sample {
  readonly minute: number;
  readonly heapUsed: number;
  readonly rss: number;
  readonly resources: Readonly<Record<string, number>>;
  readonly openSockets: number;
  readonly maxUnreleasedPerClient: number;
  readonly problems: number;
  readonly reads: number;
  readonly events: number;
}

function sample(minute: number, w: Workload): Sample {
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
  collect?.();
  const memory = process.memoryUsage();
  const resources: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
  return {
    minute,
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    resources,
    openSockets: w.clients.reduce((n, c) => n + c.openSockets(), 0),
    maxUnreleasedPerClient: Math.max(...w.clients.map((c) => c.unreleasedSockets())),
    problems: w.clients.reduce((n, c) => n + (c.online?.problems.length ?? 0), 0),
    reads: w.stats.reads,
    events: w.stats.events,
  };
}

function report(name: string, body: unknown): string {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
}

/** The router container's CPU % every 500 ms until stopped (scripts/routers.mjs stats, i.e. podman stats). */
function cpuSampler(r: Router): { stop(): Promise<number[]> } {
  const values: number[] = [];
  const state = { on: true };
  const loop = (async () => {
    while (state.on) {
      const value = Number.parseFloat(await routersScript(['stats', r.id]).catch(() => 'NaN'));
      if (Number.isFinite(value)) values.push(value);
      await delay(500);
    }
  })();
  return {
    stop: async () => {
      state.on = false;
      await loop;
      return values;
    },
  };
}

describeRouters(
  'soak',
  (r) => {
    test.skipIf(!SOAK || MODE !== 'soak')(
      `soak: ${String(MINUTES)} min, ${String(CLIENTS)} clients, chaos every 30–120 s, SOAK_SEED=${String(SEED)}`,
      async () => {
        const started = Date.now();
        const w = await Workload.start(r, {
          seed: SEED,
          callers: Math.max(1, CLIENTS - 4),
          record: 'online',
          faultMinMs: 30000,
          faultMaxMs: 120000,
        });
        const samples: Sample[] = [sample(0, w)];
        try {
          for (let minute = 1; minute <= MINUTES; minute++) {
            await delay(60000);
            samples.push(sample(minute, w));
            const s = samples[samples.length - 1];
            process.stderr.write(`SOAK ${r.id} minute ${String(minute)} ${JSON.stringify(s)}\n`);
            // faults come 30–120 s apart and last seconds: two whole minutes without a completed read mean the router
            // is gone or every client is stuck — fail now instead of soaking a dead link for the rest of the hour
            if (samples.length >= 3 && samples.slice(-3).every((x) => x.reads === s?.reads))
              throw new Error(`soak: no read completed in minutes ${String(minute - 1)}–${String(minute)}`);
          }
          await w.heal();
          // the end point of the growth checks: healed and settled (no fault in flight, so none of a reconnect's
          // transient timers and sockets), with the workload still running like at the start point
          await delay(10000);
          samples.push(sample(MINUTES + 1, w));
          process.stderr.write(`SOAK ${r.id} healed ${JSON.stringify(samples[samples.length - 1])}\n`);
          const problems = await w.check();
          const online = w.clients.flatMap((c) => c.online?.problems ?? []);
          const from = samples[Math.min(10, Math.floor(MINUTES / 3))] ?? samples[0]!;
          const to = samples[samples.length - 1]!;
          const growth = (to.heapUsed - from.heapUsed) / from.heapUsed;
          const resourcesFrom = Object.values(from.resources).reduce((a, b) => a + b, 0);
          const resourcesTo = Object.values(to.resources).reduce((a, b) => a + b, 0);
          const file = report(`soak-${r.id}`, {
            router: r.id,
            version: r.version,
            seed: SEED,
            minutes: MINUTES,
            clients: CLIENTS,
            durationMs: Date.now() - started,
            stats: w.stats,
            ends: Object.fromEntries(w.clients.map((c) => [c.name, c.ends()])),
            heapGrowth: growth,
            heapFromMinute: from.minute,
            resources: { from: from.resources, to: to.resources },
            problems,
            online,
            samples,
          });
          process.stderr.write(
            `SOAK ${r.id} report ${file} heapGrowth=${growth.toFixed(4)} problems=${String(problems.length + online.length)}\n`,
          );
          expect(problems).toEqual([]);
          expect(online).toEqual([]);
          expect(growth).toBeLessThan(0.1);
          expect(resourcesTo).toBeLessThanOrEqual(resourcesFrom + 10);
          expect(Math.max(...samples.map((s) => s.maxUnreleasedPerClient))).toBeLessThanOrEqual(1);
        } finally {
          await w.stop();
        }
      },
      MINUTES * 60000 + 600000,
    );

    test.skipIf(!SOAK || MODE !== 'herd')(
      `herd: ${String(CLIENTS)} clients through a router restart`,
      async () => {
        const clients: ItClient[] = [];
        for (let i = 0; i < CLIENTS; i++) {
          const c = itClient(r, {
            name: `herd-${String(i)}`,
            record: 'online',
            // the default settings: the spread comes from the real backoff (1.5 s × 1.5^n, full jitter, 60 s cap)
            options: {
              retryOptions: { initialRetryDelay: 1500, maxRetryDelay: 60000 },
              timeouts: { connect: 10000, handshake: 15000, request: 60000, idle: 30000 },
            },
            internal: { ping: 20000, goodbye: 2000, attemptFloor: 1000 },
          });
          c.client.topic(uri('herd')).subscribe({ error: () => undefined });
          clients.push(c);
          await delay(5);
        }
        await Promise.all(clients.map((c) => c.opened(60000)));
        const before = new Map(clients.map((c) => [c, c.client.session?.id]));
        const cpu = cpuSampler(r);
        const restartAt = performance.now();
        await r.control.restart();
        const readyAt = performance.now();
        const arrivals = new Map<ItClient, number>();
        await eventually(
          () => {
            for (const c of clients) {
              const s = c.client.session;
              if (!arrivals.has(c) && s !== undefined && s.id !== before.get(c))
                arrivals.set(c, performance.now() - restartAt);
            }
            return arrivals.size === clients.length;
          },
          180000,
          'every client back',
          50,
        );
        const cpuValues = await cpu.stop();
        const times = [...arrivals.values()].sort((a, b) => a - b);
        const ends = clients.map((c) => c.ends());
        const kinds = clients.flatMap((c) =>
          c.onClose.values.map(
            (e) =>
              `${String(e.error?.code)}${(e.error as { timer?: unknown } | undefined)?.timer === undefined ? '' : `:${String((e.error as { timer?: unknown }).timer)}`}`,
          ),
        );
        const count = (kind: string): number => kinds.filter((k) => k === kind).length;
        const body = {
          router: r.id,
          version: r.version,
          clients: CLIENTS,
          routerDownMs: Math.round(readyAt - restartAt),
          arrivalsMs: {
            min: Math.round(times[0] ?? NaN),
            p50: Math.round(percentile(times, 50)),
            p90: Math.round(percentile(times, 90)),
            p99: Math.round(percentile(times, 99)),
            max: Math.round(times[times.length - 1] ?? NaN),
          },
          endsPerClient: { mean: ends.reduce((a, b) => a + b, 0) / ends.length, max: Math.max(...ends) },
          endKinds: Object.fromEntries([...new Set(kinds)].map((k) => [k, count(k)])),
          handshakeTimeouts: count('timeout:handshake'),
          connectTimeouts: count('timeout:connect'),
          routerCpuPercent: {
            max: Math.max(...cpuValues),
            mean: cpuValues.reduce((a, b) => a + b, 0) / Math.max(1, cpuValues.length),
            samples: cpuValues.length,
          },
          online: clients.flatMap((c) => c.online?.problems ?? []),
        };
        const file = report(`herd-${r.id}`, body);
        process.stderr.write(`HERD ${r.id} report ${file} ${JSON.stringify(body)}\n`);
        expect(body.online).toEqual([]);
        expect(arrivals.size).toBe(CLIENTS);
      },
      600000,
    );
  },
  [...MATRIX, ...HOSTILE],
);
