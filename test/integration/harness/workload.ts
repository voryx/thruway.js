// The chaos workload and the chaos monkey, shared by chaos.test.ts and soak.test.ts (`scripts/soak.mjs`). The workload
// is what apps do — reads re-issued after a loss (recipe 1), writes that are not (recipe 3), a durable topic
// re-subscribed after a request timeout (recipe 5), acknowledged publishes bounded by the app, a callee with the
// recipe-16 options, and the remount actor cycling its own registration and topic — on clients behind chaos proxies
// (callers, the callee and the remount actor each on their own proxy). The monkey injects seeded faults (connection and
// frame level, router level) until stopped. `heal()` ends every fault; `check()` then requires convergence: every
// client open, a fresh read answered, the durable topic delivering, the remount procedure registered exactly once and
// served by the last-mounted handler, and no unexpected error kind anywhere.
import type { Observer, Unsubscribable } from '../../../src/types.js';
import type { SubscribableLike } from '../../helpers/trace.js';
import { ChaosProxy, type ChaosProxyOptions } from './chaos-proxy.js';
import { eventually, firstValue, itClient, unique, type ItClient } from './recorder.js';
import { cap, type Router } from './routers.js';
import { prng } from './scenarios.js';

export interface WorkloadOptions {
  readonly seed: number;
  /** Extra caller clients (reads and writes) [2]. */
  readonly callers?: number;
  /** Faults on? [true] */
  readonly chaos?: boolean;
  /** Mean ms between faults [1500]. */
  readonly faultEvery?: number;
  /** Bounds of the pause between faults, ms (soak: 30 000 … 120 000); overrides faultEvery. */
  readonly faultMinMs?: number;
  readonly faultMaxMs?: number;
  /** How the clients are recorded [full] ('online' for long runs: bounded memory). */
  readonly record?: 'full' | 'online';
}

export interface WorkloadStats {
  reads: number;
  readsFailed: number;
  writes: number;
  writesLost: number;
  publishes: number;
  events: number;
  remounts: number;
  /** Outcomes tolerated because a corrupted frame was in flight. */
  corrupted: number;
  faults: Record<string, number>;
  /** Errors of a kind the recipes do not expect: the run fails on any. */
  readonly unexpected: string[];
}

/** Error kinds a read/write/publish may legitimately end with under chaos (recipes 1 and 3). */
/** Subscribe to one of the workload's interests: through the trace recorder for a full trace (the INV-* checkers then
 *  know the interest and its key), straight for an online one (a soak's trace must stay bounded). */
function held<T>(
  c: ItClient,
  stream: 'topic' | 'register',
  uri: string,
  source: SubscribableLike<T>,
  observer: Partial<Observer<T>> = {},
): Unsubscribable {
  return c.online === undefined ? c.observe(stream, uri, source, observer) : source.subscribe(observer);
}

function expected(error: unknown): boolean {
  const e = error as { code?: unknown; uri?: unknown } | null;
  if (e?.code === 'connection_lost' || e?.code === 'protocol') return true;
  if (e?.code === 'wamp_error') {
    return (
      typeof e.uri === 'string' &&
      /(canceled|cancelled|no_such_procedure|no_eligible_callee|network_failure|callee_failure|no_such_registration|timeout|unknown)$/.test(
        e.uri,
      )
    );
  }
  return error instanceof Error && error.message.startsWith('no value within'); // the app's own bound
}

const REMOUNT_FAULT_FREE_MS = 1000;

export class Workload {
  readonly stats: WorkloadStats = {
    reads: 0,
    readsFailed: 0,
    writes: 0,
    writesLost: 0,
    publishes: 0,
    events: 0,
    remounts: 0,
    corrupted: 0,
    faults: {},
    unexpected: [],
  };
  readonly proxies: { callers: ChaosProxy; callee: ChaosProxy; remount: ChaosProxy };
  readonly clients: ItClient[] = [];
  private running = true;
  private chaosOn: boolean;
  private readonly loops: Promise<void>[] = [];
  private readonly random: () => number;
  private readonly prefix = `com.thruwayjs.chaos.${unique()}`;
  private remountTag = '';
  private remountSub: Unsubscribable | undefined;
  private durable: Unsubscribable | undefined;
  private readonly durableEvents: string[] = [];
  private lastCalleeKill = 0;
  private lastCallerKill = 0;
  private restarted = false;
  private corruptedUntil = 0;

  private constructor(
    readonly r: Router,
    readonly options: WorkloadOptions,
    proxies: Workload['proxies'],
  ) {
    this.proxies = proxies;
    this.random = prng(options.seed);
    this.chaosOn = options.chaos !== false;
  }

  static async start(r: Router, options: WorkloadOptions): Promise<Workload> {
    const make = (): Promise<ChaosProxy> => {
      const o: ChaosProxyOptions = { target: r.url, random: prng(options.seed + 7) };
      return ChaosProxy.start(o);
    };
    const w = new Workload(r, options, { callers: await make(), callee: await make(), remount: await make() });
    await w.begin();
    return w;
  }

  private get read(): string {
    return `${this.prefix}.read`;
  }
  private get write(): string {
    return `${this.prefix}.write`;
  }
  private get topic(): string {
    return `${this.prefix}.topic`;
  }
  private get remount(): string {
    return `${this.prefix}.remount`;
  }

  private client(name: string, proxy: ChaosProxy, request = 2000): ItClient {
    // the callee rides out Thruway's 5 s ghost ping with replace_orphaned_session: a longer request timeout
    // (late-answers.test.ts)
    const c = itClient(this.r, {
      name,
      url: proxy.url,
      options: { timeouts: { request } },
      ...(this.options.record === undefined ? {} : { record: this.options.record }),
    });
    this.clients.push(c);
    return c;
  }

  private async begin(): Promise<void> {
    const callee = this.client('callee', this.proxies.callee, 10000);
    held(
      callee,
      'register',
      this.read,
      callee.client.register(this.read, (inv) => inv.args[0], this.r.reregisterOptions),
      {
        error: (e: unknown) => {
          this.unexpected('callee read registration', e);
        },
      },
    );
    let written = 0;
    held(
      callee,
      'register',
      this.write,
      callee.client.register(this.write, () => ++written, this.r.reregisterOptions),
      {
        error: (e: unknown) => {
          this.unexpected('callee write registration', e);
        },
      },
    );
    const publisher = this.client('publisher', this.proxies.callers);
    const subscriber = this.client('subscriber', this.proxies.callers);
    const remounter = this.client('remount', this.proxies.remount, 10000);
    const callers = Array.from({ length: this.options.callers ?? 2 }, (_, i) =>
      this.client(`caller-${String(i)}`, this.proxies.callers),
    );
    await Promise.all(this.clients.map((c) => c.opened(30000)));
    this.subscribeDurable(subscriber);
    for (const c of callers) this.loops.push(this.reads(c), this.writes(c));
    this.loops.push(this.publishes(publisher), this.remounts(remounter));
    if (this.chaosOn) this.loops.push(this.monkey());
  }

  private unexpected(where: string, error: unknown): void {
    if (!this.running || this.stats.unexpected.length >= 100) return;
    if (performance.now() < this.corruptedUntil) {
      // a corrupted frame can be another valid frame (other args, an invalid payload): wrong answers and
      // invalid_argument are then the router's and the callee's correct reactions, not a client bug
      this.stats.corrupted++;
      return;
    }
    this.stats.unexpected.push(`${where}: ${String((error as Error | undefined)?.message ?? error)}`);
  }

  /** Recipe 5: a durable topic, re-subscribed after a request timeout (or any other error). */
  private subscribeDurable(c: ItClient): void {
    this.durable = held(c, 'topic', this.topic, c.client.topic(this.topic), {
      next: (e) => {
        this.stats.events++;
        this.durableEvents.push(String(e.args[0]));
        if (this.durableEvents.length > 2000) this.durableEvents.splice(0, 1000);
      },
      error: (error: unknown) => {
        const e = error as { code?: unknown; timer?: unknown };
        if (!(e.code === 'timeout' && e.timer === 'request') && e.code !== 'protocol')
          this.unexpected('durable topic', error);
        if (this.running)
          setTimeout(() => {
            this.subscribeDurable(c);
          }, 200);
      },
    });
  }

  /** Recipe 1: reads re-issued after a loss. */
  private async reads(c: ItClient): Promise<void> {
    while (this.running) {
      const n = Math.floor(this.random() * 1e6);
      try {
        const result = await firstValue(c.client.call(this.read, [n]), 4000);
        this.stats.reads++;
        if (result.args[0] !== n)
          this.unexpected('read', new Error(`wrong answer ${String(result.args[0])} for ${String(n)}`));
      } catch (error) {
        this.stats.readsFailed++;
        if (!expected(error)) this.unexpected('read', error);
        await sleep(50);
      }
      await sleep(this.random() * 40);
    }
  }

  /** Recipe 3: writes are not retried; a loss means the outcome is unknown. */
  private async writes(c: ItClient): Promise<void> {
    while (this.running) {
      try {
        await firstValue(c.client.call(this.write), 4000);
        this.stats.writes++;
      } catch (error) {
        this.stats.writesLost++;
        if (!expected(error)) this.unexpected('write', error);
      }
      await sleep(100 + this.random() * 100);
    }
  }

  private async publishes(c: ItClient): Promise<void> {
    let i = 0;
    while (this.running) {
      try {
        await firstValue(c.client.publish(this.topic, [`p${String(i++)}`], {}, { acknowledge: true }), 3000);
        this.stats.publishes++;
      } catch (error) {
        if (!expected(error)) this.unexpected('publish', error);
      }
      await sleep(80 + this.random() * 80);
    }
  }

  /** The remount actor: StrictMode and switchMap cycles on its own procedure and topic, all the time. */
  private async remounts(c: ItClient): Promise<void> {
    let cycle = 0;
    while (this.running) {
      this.remountSub?.unsubscribe();
      if (this.random() < 0.5)
        held(
          c,
          'register',
          this.remount,
          c.client.register(this.remount, () => 'stale'),
        ).unsubscribe();
      else {
        const stale = held(
          c,
          'register',
          this.remount,
          c.client.register(this.remount, () => 'stale'),
        );
        await sleep(Math.floor(this.random() * 3) * 4);
        stale.unsubscribe();
      }
      const tag = `mount-${String(cycle++)}`;
      this.remountTag = tag;
      this.remountSub = held(
        c,
        'register',
        this.remount,
        c.client.register(this.remount, () => tag),
        {
          error: (error: unknown) => {
            const e = error as { code?: unknown; uri?: unknown; timer?: unknown };
            // a re-establishment rides out its ghost for 5 min: procedure_already_exists must never surface here
            if (e.uri === 'wamp.error.procedure_already_exists') this.unexpected('remount', error);
            else if (!(e.code === 'timeout' && e.timer === 'request')) this.unexpected('remount', error);
          },
        },
      );
      const topic = held(c, 'topic', `${this.remount}.topic`, c.client.topic(`${this.remount}.topic`), {
        error: (error: unknown) => {
          const e = error as { code?: unknown; timer?: unknown };
          if (!(e.code === 'timeout' && e.timer === 'request')) this.unexpected('remount topic', error);
        },
      });
      this.stats.remounts++;
      await sleep(300 + this.random() * 700);
      topic.unsubscribe();
    }
  }

  private fault(name: string): void {
    this.stats.faults[name] = (this.stats.faults[name] ?? 0) + 1;
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)] as T;
  }

  /** The chaos monkey: one seeded fault every ~faultEvery ms, each healed after a short while. */
  private async monkey(): Promise<void> {
    const every = this.options.faultEvery ?? 1500;
    const min = this.options.faultMinMs ?? every * 0.5;
    const max = this.options.faultMaxMs ?? every * 1.5;
    const ghosts = cap(this.r, 'ghost_registrations') === 'always';
    while (this.running) {
      await this.pausable(min + this.random() * (max - min));
      if (this.quiet()) break;
      const target = this.pick([this.proxies.callers, this.proxies.callers, this.proxies.callee, this.proxies.remount]);
      const isCallee = target !== this.proxies.callers;
      const now = performance.now();
      const kind = this.pick([
        'kill',
        'close',
        'latency',
        'fragment',
        'freeze',
        'blackhole-up',
        'blackhole-down',
        'goodbye',
        'kill-on-result',
        'delay-answer',
        'refuse',
        'stall-upgrade',
        'corrupt',
        'pause',
        'restart',
      ] as const);
      // on routers with ghost registrations, the callee is never killed within 1 s of the callers
      const killing = kind === 'kill' || kind === 'close' || kind === 'kill-on-result';
      if (
        ghosts &&
        killing &&
        (isCallee ? now - this.lastCallerKill : now - this.lastCalleeKill) < REMOUNT_FAULT_FREE_MS
      ) {
        continue;
      }
      if (killing) {
        if (isCallee) this.lastCalleeKill = now;
        else this.lastCallerKill = now;
      }
      if (kind !== 'restart') this.fault(kind);
      const hold = 300 + this.random() * 2500;
      switch (kind) {
        case 'kill':
          target.kill();
          break;
        case 'close':
          target.close(this.pick([1000, 1001, 1011, 4000]), 'chaos');
          break;
        case 'latency':
          target.latency(20 + this.random() * 200, this.random() * 100);
          await sleep(hold);
          target.latency(0, 0);
          break;
        case 'fragment':
          target.fragment(2 + Math.floor(this.random() * 4));
          await sleep(hold);
          target.fragment(1);
          break;
        case 'freeze':
          target.freeze();
          await sleep(hold);
          target.thaw();
          break;
        case 'blackhole-up':
        case 'blackhole-down':
          target.blackhole(kind === 'blackhole-up' ? 'up' : 'down');
          await sleep(hold);
          {
            // the outage broke the link: frames dropped on a link that lives on would be frame loss on a live TCP
            // connection, which TCP rules out — a lost REGISTERED leaks the registration. The 1 s rule for ghost
            // registrations (above) holds for this kill too.
            const other = isCallee ? this.lastCallerKill : this.lastCalleeKill;
            const wait = ghosts ? REMOUNT_FAULT_FREE_MS - (performance.now() - other) : 0;
            if (wait > 0) await sleep(wait);
            target.kill();
            if (isCallee) this.lastCalleeKill = performance.now();
            else this.lastCallerKill = performance.now();
          }
          target.blackhole(undefined);
          break;
        case 'goodbye':
          target.inject([6, { message: 'chaos' }, 'wamp.close.system_shutdown'], 'down');
          break;
        case 'kill-on-result':
          target.on('down', (f) => f?.[0] === 50, { kind: 'kill' }, { count: 1 });
          break;
        case 'delay-answer':
          // below the late window (2 × request): longer delays leak a registration (late-answers.test.ts)
          target.on('down', (f) => f?.[0] === 65 || f?.[0] === 33, { kind: 'delay', ms: 200 + this.random() * 1300 });
          break;
        case 'refuse':
          target.refuse(500 + this.random() * 1500);
          target.kill();
          break;
        case 'stall-upgrade':
          // TCP accepted, no 101 (stallUpgrade): the attempts made meanwhile end with timer.connect, then back off
          target.stallUpgrade(Number.POSITIVE_INFINITY);
          target.kill();
          await sleep(hold);
          target.stallUpgrade(0);
          break;
        case 'corrupt':
          // router → client only: the client's own frames are never corrupt, and a corrupted one kills Thruway 0.6.1
          // (a CALL whose request id is an array or object: a fatal PHP TypeError in Dealer::processCall). Never a
          // REGISTERED/SUBSCRIBED: one with a mutated request id is dropped as unknown and leaks the registration or
          // subscription for the session, so the run cannot converge — raise when that leak is fixed
          target.corrupt(0.05, 'json', 'down', [65, 33]);
          this.corruptedUntil = Number.POSITIVE_INFINITY;
          await sleep(500);
          target.corrupt(0);
          this.corruptedUntil = performance.now() + 4000; // answers to calls that were in flight
          break;
        case 'pause':
          await this.r.control.pause();
          await sleep(500 + this.random() * 1500);
          await this.r.control.unpause();
          break;
        case 'restart':
          if (this.r.restartable && !this.restarted) {
            this.restarted = true; // at most once per run
            this.fault(kind);
            await this.r.control.restart();
          }
          break;
      }
    }
  }

  /** The run stopped, or heal() ended the faults. */
  private quiet(): boolean {
    return !this.running || !this.chaosOn;
  }

  /** Sleep, but wake up early once the run stops (a soak's pause between faults is minutes long). */
  private async pausable(ms: number): Promise<void> {
    const until = performance.now() + ms;
    while (this.running && this.chaosOn && performance.now() < until)
      await sleep(Math.min(500, until - performance.now()));
  }

  /** End every fault and stop the monkey (the workload keeps running). */
  async heal(): Promise<void> {
    this.chaosOn = false;
    for (const p of Object.values(this.proxies)) await p.heal();
  }

  /** Convergence after heal(); returns the problems (empty when the run converged). */
  async check(): Promise<string[]> {
    const problems: string[] = [];
    try {
      await Promise.all(
        this.clients.map((c) => eventually(() => c.client.session !== undefined, 40000, `${c.name} open after heal`)),
      );
    } catch (error) {
      problems.push((error as Error).message);
      return problems;
    }
    const fresh = itClient(this.r, { name: 'checker' });
    try {
      // a fresh read is served (the callee re-registered); retry transient answers while it comes back
      let served = false;
      for (let i = 0; i < 40 && !served; i++) {
        try {
          served = (await firstValue(fresh.client.call(this.read, [7]), 3000)).args[0] === 7;
        } catch {
          await sleep(500);
        }
      }
      if (!served) problems.push('a fresh read was not served after heal');
      // the durable topic delivers again
      const marker = `marker-${unique()}`;
      let delivered = false;
      for (let i = 0; i < 20 && !delivered; i++) {
        await firstValue(fresh.client.publish(this.topic, [marker], {}, { acknowledge: true }), 3000).catch(
          () => undefined,
        );
        await sleep(300);
        delivered = this.durableEvents.includes(marker);
      }
      if (!delivered) problems.push('the durable topic did not deliver after heal');
      // the remount actor: stop cycling, then exactly one registration, served by the last-mounted handler
      this.running = false;
      await Promise.all(this.loops);
      const remounter = this.clients.find((c) => c.name === 'remount');
      if (remounter !== undefined) {
        await eventually(
          () => {
            const s = remounter.debug().participants['register'] as unknown as { requests: number; records: number };
            return s.requests === 0;
          },
          20000,
          'the remount registration settled',
        ).catch((e: unknown) => problems.push((e as Error).message));
        const records = (remounter.debug().participants['register'] as unknown as { records: number }).records;
        if (records !== 1) problems.push(`remount: ${String(records)} registration records, expected 1`);
        let answer: unknown;
        for (let i = 0; i < 30 && answer !== this.remountTag; i++) {
          answer = await firstValue(fresh.client.call(this.remount), 3000)
            .then((m) => m.args[0] as unknown)
            .catch(() => undefined);
          if (answer !== this.remountTag) await sleep(500);
        }
        if (answer !== this.remountTag) problems.push(`remount: served ${String(answer)}, expected ${this.remountTag}`);
      }
    } finally {
      this.running = false;
    }
    problems.push(...this.stats.unexpected);
    return problems;
  }

  /** Stop everything and release the proxies (clients are closed by the afterEach). */
  async stop(): Promise<void> {
    this.running = false;
    this.remountSub?.unsubscribe();
    this.durable?.unsubscribe();
    await Promise.allSettled(this.loops);
    for (const p of Object.values(this.proxies)) await p.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
