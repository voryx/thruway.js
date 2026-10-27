// Per-file setup of the integration project (test/projects/integration.ts `setupFiles`): after every test, close every
// client the test created (bounded), then check each client's trace (harness/checks.ts: the built-in client-side
// invariants and every registered checker) and its state after close (no timer, no queued input, CLOSED), keep the
// trace for offline checkers, and optionally write it out (INTEGRATION_TRACES=<dir>) and record transcripts
// (RECORD_TRANSCRIPTS=1 → test/fixtures/transcripts/<router>--<file>.jsonl: flat, the router in the file name, which is
// where test/fuzz/transcripts.fuzz.test.ts reads them and takes the dialect from).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import { checkInvariants, formatViolations } from '../../helpers/invariants.js';
import { checkTrace, REAL_ROUTER_TOLERANCE, recordedTraces, registerTraceChecker, type TraceMeta } from './checks.js';
import { eventually, liveClients, type ItClient } from './recorder.js';
import { ROOT } from './routers.js';

// The INV-* checkers over every client trace of every test: a violation fails the test.
registerTraceChecker((trace, meta) => {
  const p = meta.profile;
  const found = checkInvariants(trace, {
    tolerance: REAL_ROUTER_TOLERANCE,
    requestIds: meta.requestIds,
    ...(p === undefined
      ? {}
      : { timings: p.timings, maxRetries: p.maxRetries, retryDelay: p.retryDelay, authmethods: p.authmethods }),
    ...(meta.ops === undefined ? {} : { ops: meta.ops }),
  });
  return found.length === 0 ? [] : [`${meta.client}: ${formatViolations(found, trace)}`];
});

const CLOSE_BOUND_MS = 4000;
const TRANSCRIPT_LINES = 120;
const TRANSCRIPT_FRAME_BYTES = 2048;
const transcriptLines = new Map<string, number>();
const transcriptConnections = new Map<string, number>();

/** Sockets the client closed but whose peer never completed the closing handshake (undici has no terminate()). */
export const peerHeldSockets: { test: string; client: string; router: string | undefined; sockets: number }[] = [];

function slug(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

async function closeWithin(c: ItClient): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, CLOSE_BOUND_MS);
  });
  const outcome = await Promise.race([c.close().then(() => 'closed' as const), bound]);
  clearTimeout(timer);
  return outcome === 'timeout' ? `${c.name}: close() did not resolve within ${String(CLOSE_BOUND_MS)} ms` : undefined;
}

function recordTranscript(file: string, c: ItClient): void {
  if (process.env['RECORD_TRANSCRIPTS'] !== '1' || c.router === undefined) return;
  const dir = path.join(ROOT, 'test', 'fixtures', 'transcripts');
  const target = path.join(dir, `${c.router.id}--${path.basename(file).replace(/\.test\.ts$/, '')}.jsonl`);
  let lines = transcriptLines.get(target) ?? 0;
  if (lines >= TRANSCRIPT_LINES) return;
  mkdirSync(dir, { recursive: true });
  if (lines === 0) writeFileSync(target, '');
  // connection numbers stay unique within one transcript file
  const offset = transcriptConnections.get(target) ?? 0;
  let highest = offset;
  const out: string[] = [];
  for (const f of c.trace().frames) {
    const json = JSON.stringify({
      connection: f.connection + offset,
      direction: f.direction,
      frame: f.frame,
      at: Math.round(f.at),
    });
    highest = Math.max(highest, f.connection + offset);
    if (json.length > TRANSCRIPT_FRAME_BYTES) continue;
    if (lines >= TRANSCRIPT_LINES) break;
    out.push(json);
    lines++;
  }
  transcriptConnections.set(target, highest);
  transcriptLines.set(target, lines);
  if (out.length > 0) appendFileSync(target, `${out.join('\n')}\n`);
}

afterEach(async () => {
  const state = expect.getState();
  const file = path.relative(ROOT, state.testPath ?? 'unknown');
  const test = `${file} > ${state.currentTestName ?? 'unknown'}`;
  const clients = [...liveClients];
  liveClients.clear();
  const problems: string[] = [];
  for (const p of await Promise.all(clients.map(closeWithin))) if (p !== undefined) problems.push(p);
  const traces: { meta: TraceMeta; trace: ReturnType<ItClient['trace']> }[] = [];
  for (const c of clients) {
    const debug = c.debug();
    if (debug.state !== 'CLOSED') problems.push(`${c.name}: state ${debug.state} after close()`);
    if (debug.timers !== 0) problems.push(`${c.name}: ${String(debug.timers)} timer(s) armed after close()`);
    if (debug.inputs !== 0 || debug.deliveries !== 0) problems.push(`${c.name}: queues not empty after close()`);
    if (debug.registry !== 0)
      problems.push(`${c.name}: ${String(debug.registry)} op(s) still registered after close()`);
    // the lifecycle streams never error or complete, close() included (INV-R7)
    for (const [stream, recorded] of [
      ['status', c.status],
      ['onOpen', c.onOpen],
      ['onClose', c.onClose],
    ] as const) {
      if (recorded.errored || recorded.completed)
        problems.push(`${c.name}: ${stream} ${recorded.errored ? 'errored' : 'completed'} (INV-R7)`);
    }
    const trace = c.trace();
    const meta: TraceMeta = {
      test,
      client: c.name,
      router: c.router?.id,
      requestIds: trace.frames.length > 0 && c.requestIds === 'sequential' ? 'sequential' : 'random',
      profile: c.profile,
      ops: c.ops,
    };
    problems.push(...(c.online === undefined ? checkTrace(trace, meta) : c.online.problems));
    traces.push({ meta, trace });
    recordTranscript(file, c);
  }
  // sockets: the client must have released every socket it opened (a close() it called and the peer never answered
  // is undici's frozen-peer behaviour: counted in `peerHeldSockets`, not a client failure)
  for (const c of clients) {
    try {
      await eventually(() => c.openSockets() === 0, c.allowOpenSockets ? 0 : 3000, 'sockets closed');
    } catch {
      if (c.unreleasedSockets() > 0)
        problems.push(`${c.name}: ${String(c.unreleasedSockets())} socket(s) never closed by the client`);
      peerHeldSockets.push({ test, client: c.name, router: c.router?.id, sockets: c.openSockets() });
    }
  }
  recordedTraces.set(test, traces);
  const dir = process.env['INTEGRATION_TRACES'];
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    for (const { meta, trace } of traces) {
      writeFileSync(path.join(dir, `${slug(meta.test)}--${meta.client}.json`), JSON.stringify({ meta, trace }));
    }
  }
  if (problems.length > 0) throw new Error(`the run is not clean:\n  ${problems.join('\n  ')}`);
});
