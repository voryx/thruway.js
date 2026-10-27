// Trace checks of the integration suite. The router will not catch client bugs, so the outbound-frame invariants are
// checked on the client side in every test. Run by harness/setup.ts after every test, over the trace of every client
// the test created:
//
// - the built-in client-side checks below (INV-CL01, the outbound half of INV-CL02, CANCEL, AUTH, no `internal`
//   entry);
// - every checker registered with `registerTraceChecker` (harness/setup.ts registers the INV-* checkers of
//   test/helpers/invariants.ts).
//
// Every recorded trace of the run is also kept in `recordedTraces` (test name → traces), and written as JSON under
// INTEGRATION_TRACES=<dir> (one file per test and client) so the checkers can be run over a finished run offline.
import type { LogEntry } from '../../../src/types.js';
import type { OpInfo, Timings } from '../../helpers/invariants.js';
import type { Tolerance, Trace } from '../../helpers/trace-types.js';

/** Real-router timing tolerance for the time-bound invariants (50 ms + 5 %). */
export const REAL_ROUTER_TOLERANCE: Tolerance = { absoluteMs: 50, relative: 0.05 };

export interface TraceMeta {
  /** `<file> > <describe> > <test>`. */
  readonly test: string;
  readonly client: string;
  /** The router id ([] for clients on a proxy or a raw URL). */
  readonly router: string | undefined;
  readonly requestIds: 'random' | 'sequential';
  /** The client's profile, for the INV-* checkers: its timings (the fast profile merged with the test's options and
   *  internal timings), maxRetries, the kind of its retryDelay and its authmethods. */
  readonly profile?: ClientProfile | undefined;
  /** Observer id → kind and key of the client's observed topics and registrations (recorder.ts `ops`). */
  readonly ops?: ReadonlyMap<number, OpInfo> | undefined;
}

/** What a trace alone does not say about the client that made it (passed to the INV-* checkers). */
export interface ClientProfile {
  readonly timings: Partial<Timings>;
  readonly maxRetries: number | undefined;
  /** 'custom' when the test passed its own retryDelay (it may return null: 'custom-null' is the lenient reading). */
  readonly retryDelay: 'default' | 'custom-null';
  readonly authmethods: readonly string[] | undefined;
}

export type TraceChecker = (trace: Trace, meta: TraceMeta) => readonly string[];

const checkers: TraceChecker[] = [];

/** Add a checker that runs over every client trace of every following test; its problems fail that test. */
export function registerTraceChecker(checker: TraceChecker): () => void {
  checkers.push(checker);
  return () => {
    const at = checkers.indexOf(checker);
    if (at >= 0) checkers.splice(at, 1);
  };
}

/** test name → the traces of its clients, in creation order (kept for the whole run). */
export const recordedTraces = new Map<string, { readonly meta: TraceMeta; readonly trace: Trace }[]>();

const ANSWERS_OF: Readonly<Record<number, number>> = { 33: 32, 35: 34, 65: 64, 67: 66, 17: 16 };

/** Per-connection state of the client-side checks. */
interface ConnectionState {
  hellos: number;
  first: boolean;
  welcomed: boolean;
  closedByClient: boolean;
  routerGoodbye: boolean;
  repliesAfterGoodbye: number;
  sequential: number;
  readonly inFlightCalls: Set<number>;
  /** request id → request type */
  readonly pending: Map<number, number>;
  readonly cancels: Set<number>;
}

/** A frame as the checks see it (a trace FrameEvent, or a frame recorded online). */
export interface CheckedFrame {
  readonly connection: number;
  readonly direction: 'in' | 'out';
  readonly frame: readonly unknown[] | string;
}

const KEPT_CONNECTIONS = 16;
const KEPT_IDS = 10000;

/**
 * The built-in client-side checks as a stream (bounded memory, so a 60-minute soak can run them online): INV-AUTH
 * (one HELLO, first), INV-CL01 (before WELCOME only HELLO/AUTHENTICATE/ABORT; nothing after the client's GOODBYE or
 * ABORT; one reply after the router's GOODBYE), the outbound half of INV-CL02 (valid request ids, no id reused while
 * its request is in flight, 1, 2, 3, … with `sequential`), INV-CANCEL (killnowait, once per call) and no `internal`
 * log entry. No tolerance is needed: these are about order and ids only.
 */
export class StreamingChecks {
  readonly problems: string[] = [];
  private readonly connections = new Map<number, ConnectionState>();
  private readonly released = new Set<number>();

  constructor(
    private readonly client: string,
    private readonly requestIds: 'random' | 'sequential',
    private readonly limit = 200,
  ) {}

  private problem(text: string): void {
    if (this.problems.length < this.limit) this.problems.push(text);
  }

  private state(connection: number): ConnectionState | undefined {
    let s = this.connections.get(connection);
    if (s === undefined) {
      if (this.released.has(connection)) return undefined;
      s = {
        hellos: 0,
        first: true,
        welcomed: false,
        closedByClient: false,
        routerGoodbye: false,
        repliesAfterGoodbye: 0,
        sequential: 0,
        inFlightCalls: new Set(),
        pending: new Map(),
        cancels: new Set(),
      };
      this.connections.set(connection, s);
      for (const old of this.connections.keys()) {
        if (this.connections.size <= KEPT_CONNECTIONS) break;
        this.connections.delete(old);
        this.released.add(old);
      }
    }
    return s;
  }

  frame(f: CheckedFrame): void {
    const where = `${this.client} connection ${String(f.connection)}`;
    const s = this.state(f.connection);
    const frame = Array.isArray(f.frame) ? f.frame : undefined;
    const t = typeof frame?.[0] === 'number' ? frame[0] : undefined;
    if (s === undefined) {
      if (f.direction === 'in') this.problem(`${where}: a frame on a long-released connection: ${show(f)}`);
      return;
    }
    if (f.direction === 'out') {
      if (t === 2) s.welcomed = true;
      if (t === 6) s.routerGoodbye = true;
      if (frame === undefined) return;
      if (t === 50 && (frame[2] as { progress?: unknown } | undefined)?.progress !== true) settle(s, frame[1]);
      if (t === 8 && (frame[1] === 48 || frame[1] === 49)) settle(s, frame[2]);
      if (t === 8) s.pending.delete(frame[2] as number);
      if (t !== undefined && ANSWERS_OF[t] !== undefined) s.pending.delete(frame[1] as number);
      return;
    }
    // client → router
    if (s.first && t !== 1) this.problem(`${where}: first frame is not HELLO: ${show(f)}`);
    s.first = false;
    if (t === 1 && ++s.hellos > 1) this.problem(`${where}: more than one HELLO`);
    if (s.closedByClient) this.problem(`${where}: frame after the client's GOODBYE/ABORT: ${show(f)}`);
    if (s.routerGoodbye && !s.closedByClient) {
      s.repliesAfterGoodbye++;
      if (t !== 6 || s.repliesAfterGoodbye > 1) this.problem(`${where}: frame after the router's GOODBYE: ${show(f)}`);
    }
    // INV-CL01: before the WELCOME only HELLO, AUTHENTICATE, ABORT (the GOODBYE that rejects an unrequested
    // anonymous WELCOME comes after it, and nothing follows it: the GOODBYE/ABORT rule)
    if (!s.welcomed && t !== 1 && t !== 5 && t !== 3) this.problem(`${where}: ${show(f)} before WELCOME (INV-CL01)`);
    if (t === 6 || t === 3) s.closedByClient = true;
    if (frame === undefined) return;
    // ids: CALL/PUBLISH/SUBSCRIBE/REGISTER/UNSUBSCRIBE/UNREGISTER carry a request id at [1]
    if (t === 48 || t === 16 || t === 32 || t === 64 || t === 34 || t === 66) {
      const id = frame[1] as number;
      if (!Number.isSafeInteger(id) || id < 1 || id > 2 ** 53) this.problem(`${where}: invalid request id ${show(f)}`);
      if (s.inFlightCalls.has(id) || s.pending.has(id))
        this.problem(`${where}: request id ${String(id)} reused while in flight`);
      if (this.requestIds === 'sequential' && id !== ++s.sequential) {
        this.problem(`${where}: sequential id ${String(id)}, expected ${String(s.sequential)}`);
        s.sequential = id;
      }
      if (t === 48) bounded(s.inFlightCalls, id);
      else if (t !== 16 || (frame[2] as { acknowledge?: unknown } | undefined)?.acknowledge === true) {
        s.pending.set(id, t);
        if (s.pending.size > KEPT_IDS) s.pending.delete(s.pending.keys().next().value!);
      }
    }
    if (t === 49) {
      // INV-CANCEL
      const id = frame[1] as number;
      if ((frame[2] as { mode?: unknown } | undefined)?.mode !== 'killnowait')
        this.problem(`${where}: CANCEL without killnowait ${show(f)}`);
      if (s.cancels.has(id)) this.problem(`${where}: second CANCEL for call ${String(id)}`);
      bounded(s.cancels, id);
    }
  }

  log(entry: LogEntry): void {
    if (entry.event === 'internal') this.problem(`${this.client}: internal error logged: ${entry.message}`);
  }
}

function settle(s: ConnectionState, id: unknown): void {
  s.inFlightCalls.delete(id as number);
}

function bounded(set: Set<number>, id: number): void {
  set.add(id);
  if (set.size > KEPT_IDS) set.delete(set.values().next().value!);
}

/** The built-in client-side checks over a recorded trace. */
export function clientChecks(trace: Trace, meta: TraceMeta): string[] {
  const checks = new StreamingChecks(meta.client, meta.requestIds);
  for (const f of trace.frames) checks.frame(f);
  for (const l of trace.logs) checks.log(l.entry);
  return checks.problems;
}

/** Run the built-in checks and every registered checker. */
export function checkTrace(trace: Trace, meta: TraceMeta): string[] {
  const problems = clientChecks(trace, meta);
  for (const checker of checkers) {
    try {
      problems.push(...checker(trace, meta));
    } catch (error) {
      problems.push(`${meta.client}: trace checker threw: ${String(error)}`);
    }
  }
  return problems;
}

function show(f: CheckedFrame): string {
  const s = typeof f.frame === 'string' ? f.frame : JSON.stringify(f.frame);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
