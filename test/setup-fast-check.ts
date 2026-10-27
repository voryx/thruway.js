// fast-check settings, a setup file of the unit and mutation projects.
//
//   FC_NUM_RUNS=20000 npm run test:unit    a deeper run (CI runs 200; default 100)
//   FC_SEED=<n>                            global seed (every property)
//   FC_PATH=<p>                            replay path of a reported failure; fast-check accepts `path` only per
//                                          property, so properties spread `replayParameters()` into their parameters
//   FC_REPLAY_PATH=<p>                     the `replayPath` of a failed model run (`fc.commands(…, {replayPath})`)
//   FC_TIME_LIMIT_MS=<ms>                  per-property time budget (default 120 000)
//
// Time limits are a plugin since fast-check 4.10 (the `interruptAfterTimeLimit` parameter is deprecated). With
// `failOnInterrupt` an interrupted property fails instead of silently passing with fewer runs.
import { fc } from '@fast-check/vitest';

function envString(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

function envInteger(name: string): number | undefined {
  const raw = envString(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return value;
}

/** Per-property replay parameters (`FC_SEED` + `FC_PATH`), to spread into `fc.assert`/`test.prop` parameters. */
export function replayParameters(): { seed?: number; path?: string } {
  const seed = envInteger('FC_SEED');
  const path = envString('FC_PATH');
  return { ...(seed === undefined ? {} : { seed }), ...(path === undefined ? {} : { path }) };
}

/** The `replayPath` of a reported model-run failure (`FC_REPLAY_PATH`), for `fc.commands(…, {replayPath})`. */
export function replayPath(): string | undefined {
  return envString('FC_REPLAY_PATH');
}

const seed = envInteger('FC_SEED');
fc.configureGlobal({
  numRuns: envInteger('FC_NUM_RUNS') ?? 100,
  ...(seed === undefined ? {} : { seed }),
});
fc.installGlobalPlugin(fc.interruptAfterTimeLimit(envInteger('FC_TIME_LIMIT_MS') ?? 120000, { failOnInterrupt: true }));
