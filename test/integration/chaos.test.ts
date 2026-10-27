// Chaos against every router: per router, seeded schedules of connection-, frame- and router-level faults
// (harness/workload.ts: kill, close codes, latency, fragmentation, freeze, one-way black holes, injected router
// GOODBYEs, kill on the k-th RESULT, delayed REGISTERED/SUBSCRIBED, refused upgrades, stalled upgrades (`stallUpgrade`:
// TCP accepted, no 101, so the attempt ends with timer.connect), corrupted frames, router pause and restart) against
// the app workload — reads (recipe 1), writes (recipe 3), a durable topic (recipe 5), acknowledged publishes, a callee
// with the recipe-16 options and the remount actor. After each schedule every fault is healed and the run must converge
// (Workload.check), and every client trace passes the checks of harness/setup.ts. A failure prints its CHAOS_SEED,
// which replays the schedule.
//
//   CHAOS_SCHEDULES (default 2) × CHAOS_SECONDS (default 20) per router; the nightly job runs 20 × 60.
import { afterEach, expect, test } from 'vitest';
import { cap, describeRouters } from './harness/routers.js';
import { Workload } from './harness/workload.js';

const SCHEDULES = Number(process.env['CHAOS_SCHEDULES'] ?? '2');
const SECONDS = Number(process.env['CHAOS_SECONDS'] ?? '20');
const BASE_SEED = Number(process.env['CHAOS_SEED'] ?? String(Date.now() % 1000000));

const running: Workload[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.stop()));
});

describeRouters('chaos', (r) => {
  for (let schedule = 0; schedule < SCHEDULES; schedule++) {
    const seed = BASE_SEED + schedule;
    test(
      `schedule ${String(schedule + 1)}/${String(SCHEDULES)}: ${String(SECONDS)} s, CHAOS_SEED=${String(seed)}`,
      async () => {
        // Crossbar's ghost registrations survive until a restart (test/routers/crossbar/README.md, quirk 9): a fresh
        // router per schedule
        if (schedule > 0 && cap(r, 'ghost_registrations') === 'always' && r.restartable) await r.control.restart();
        const w = await Workload.start(r, { seed });
        running.push(w);
        await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
        await w.heal();
        const problems = await w.check();
        const summary = `CHAOS ${r.id} seed=${String(seed)} ${JSON.stringify(w.stats)}`;
        process.stderr.write(`${summary}\n`);
        expect(problems, `CHAOS_SEED=${String(seed)} (${r.id})`).toEqual([]);
        expect(w.stats.reads).toBeGreaterThan(0);
        expect(w.stats.events).toBeGreaterThan(0);
      },
      SECONDS * 1000 + 180000,
    );
  }
});
