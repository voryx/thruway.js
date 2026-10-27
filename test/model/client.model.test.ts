// The model-based suite: `fc.scheduledModelRun` over random interleavings of app API calls, router messages and faults,
// socket faults, time and injected internal faults, against the reference router's Thruway PHP dialect (the only one
// random testing runs on), with every app answer either scheduled (released by fast-check's scheduler between and
// during commands) or deferred (settled by Resolve/Reject/Next/Complete). Every INV-* checker runs after every
// command; at the end the run is healed and INV-R1 requires `open` within its bound, then everything is closed and the
// post-close checks run (INV-R5 settled, INV-R9, INV-R10 debug probe, the harness's end-of-run checks).
//
//   FC_NUM_RUNS=200 (CI) | 20000 (a deeper run, with FC_TIME_LIMIT_MS large enough; the test timeout scales itself)
//   FC_SEED / FC_PATH / FC_REPLAY_PATH replay a reported failure exactly.
import fc from 'fast-check';
import { describe, test } from 'vitest';
import { replayParameters } from '../setup-fast-check.js';
import { modelProperty } from './commands.js';

const RUNS = Number(process.env['FC_NUM_RUNS'] ?? 100);
/** About 50 ms per run on a laptop; generous so a slow CI runner does not time out. */
const TIMEOUT = Math.max(120000, RUNS * 400);

describe('model', () => {
  test(
    'every invariant holds after every command, and the healed client is open again',
    async () => {
      await fc.assert(modelProperty(), { ...replayParameters() });
    },
    TIMEOUT,
  );
});
