// The commands of the model-based suite: app API calls, router messages and faults, socket faults, time and injected
// internal faults. Each command runs against the World (model.ts), then every INV-* checker runs over every client's
// trace (safety parts) and the router-side calls are checked for answers to the wrong INVOCATION. Commands never assume
// what state the client is in: they act, the invariants judge.
import fc from 'fast-check';
import type { SimConnection } from '../../src/testing/sim.js';
import { replayPath } from '../setup-fast-check.js';
import {
  CALLS,
  PROCEDURES,
  THROWING,
  PUBLISH_TOPICS,
  TOPICS,
  type ChallengeMode,
  type HandlerKind,
  type ModelConfig,
  type ReentrantAction,
  type ReentrantTarget,
  type UrlMode,
  World,
  configArb,
} from './model.js';

export type ModelCommand = fc.AsyncCommand<World, World>;

class Cmd implements ModelCommand {
  constructor(
    private readonly label: string,
    private readonly fn: (w: World) => Promise<void> | void,
    private readonly pre: (w: World) => boolean = () => true,
  ) {}

  check(m: Readonly<World>): boolean {
    return this.pre(m as World);
  }

  async run(m: World): Promise<void> {
    m.log.push(this.label);
    await this.fn(m);
    m.check(this.label);
    m.checkRouterCalls(this.label);
  }

  toString(): string {
    return this.label;
  }
}

function cmd(label: string, fn: (w: World) => Promise<void> | void, pre?: (w: World) => boolean): ModelCommand {
  return new Cmd(label, fn, pre);
}

/** The main client's connections whose router end is open. */
function open(w: World): SimConnection[] {
  return w.c.connections.filter((c) => c.state === 'open');
}

/** Sockets the client has released (the adapter removed its listeners; the permanent error guard does not count). */
function released(w: World): SimConnection[] {
  return w.c.connections.filter((c) => c.state === 'closed' && c.controls.listenerCount === 0);
}

/** The Thruway PHP / spec providers' methods of the run. */
function methods(w: World): readonly string[] {
  return w.authmethods ?? [];
}

const PARTICIPANT_TARGETS = [
  'call.write',
  'call.inbound',
  'call.stop',
  'call.sessionEnded',
  'call.clientClosed',
  'publish.write',
  'publish.inbound',
  'publish.stop',
  'publish.sessionEnded',
  'topic.start',
  'topic.stop',
  'topic.welcome',
  'topic.inbound',
  'topic.timer',
  'topic.sessionEnded',
  'topic.clientClosed',
  'register.start',
  'register.stop',
  'register.welcome',
  'register.inbound',
  'register.timer',
  'register.sessionEnded',
  'register.clientClosed',
  'register.handlerEvent',
  'liveness.start',
  'liveness.inbound',
  'liveness.wrote',
  'liveness.sent',
  'liveness.onIdle',
  'liveness.onPing',
  'liveness.verifyAlive',
  'liveness.check',
  'liveness.sessionEnded',
  'challenge.run',
  'challenge.cancel',
  'serializer.serialize',
  'serializer.deserialize',
  'logger',
  'clock.random',
  'ws.send',
  'ws.close',
] as const;

let garbageIds = 424242;

/** Raw router frames by class (garbage, header-fatal, dropped, out of state). Unknown ids are fresh each time
 *  (a router that reuses an INVOCATION id after its final answer is not what these frames test). */
function garbage(kind: number, w: World): string {
  const unknown = ++garbageIds;
  const lastCall = (() => {
    for (const f of [...w.c.trace().frames].reverse()) {
      if (f.direction === 'in' && Array.isArray(f.frame) && f.frame[0] === 48) return f.frame[1] as number;
    }
    return 1;
  })();
  const frames: readonly string[] = [
    'not json',
    '[]',
    '{}',
    '"x"',
    '[999,1]',
    '[7]',
    JSON.stringify([2, 1, {}]), // WELCOME in a session (dropped) or a WELCOME out of nowhere
    JSON.stringify([4, 'ticket', {}]), // CHALLENGE after WELCOME
    JSON.stringify([50, 424242, {}, ['stray']]), // RESULT for an unknown call
    JSON.stringify([50, lastCall, {}, 'not args']), // payload-invalid RESULT for the latest call
    JSON.stringify([50, lastCall, { progress: true }, ['late progress']]),
    JSON.stringify([8, 48, lastCall, {}, 'wamp.error.canceled']),
    JSON.stringify([8, 8, lastCall, {}, 'wamp.error.no_such_procedure']), // Thruway's bogus ERROR after killnowait
    JSON.stringify([8, 'x', 1, {}, 'e']), // header-fatal ERROR
    JSON.stringify([36, 424242, 1, {}, ['stray']]), // EVENT for an unknown subscription
    JSON.stringify([68, unknown, unknown, {}, ['x']]), // INVOCATION for an unknown registration
    JSON.stringify([69, unknown, { mode: 'killnowait' }]), // INTERRUPT for an unknown invocation
    JSON.stringify([35, 0, { subscription: 424242 }]), // revocation of an unknown subscription
    JSON.stringify([67, 0, { registration: 424242 }]),
    JSON.stringify([33, 424242, 1]), // SUBSCRIBED for an unknown request
    JSON.stringify([65, 424242, 1]),
    JSON.stringify([17, 424242, 1]),
    JSON.stringify([48, 1, {}, 'client.only']), // a client-only type
  ];
  return frames[kind % frames.length]!;
}

type Entry = fc.Arbitrary<ModelCommand> | fc.WeightedArbitrary<ModelCommand>;

/** Weights by command name (others get their group's): the interactions that matter most often, faults that only
 *  break a run rarely. */
/** Weights by command name: [calm run, storm run]; a command not listed gets its group's weight in a calm run and
 *  2 in a storm. App traffic dominates a calm run, so sessions live long enough for whole cycles (register → invoke →
 *  loss → re-register → invoke), while every fault still occurs; a storm run is mostly faults. */
const WEIGHTS: readonly (readonly [string, number, number])[] = [
  ['Call(', 16, 4],
  ['Register(', 16, 4],
  ['Topic(', 12, 3],
  ['Unsubscribe(', 8, 3],
  ['Resubscribe(', 6, 2],
  ['Publish(', 8, 2],
  ['RouterInvoke(', 16, 3],
  ['RouterPublish(', 12, 3],
  ['Resolve(', 10, 3],
  ['Next(', 4, 1],
  ['Complete(', 4, 1],
  ['Reject(', 2, 1],
  ['Drop(', 3, 4],
  ['RouterGoodbye(', 1, 3],
  ['RouterAbort(', 1, 3],
  ['RouterInterrupt(', 3, 2],
  ['SendGarbage(', 1, 3],
  ['SetAvailable(', 1, 3],
  ['Freeze(', 1, 3],
  ['Thaw', 1, 2],
  ['CloseSocket(', 1, 2],
  ['InjectFault(', 1, 2],
  ['BadArgument(', 1, 1],
  ['Lifecycle', 1, 1],
  ['Kill', 1, 1],
  ['Revoke(', 1, 1],
  ['Deny(', 1, 2],
  ['Ignore(', 1, 2],
  ['SetProvider(', 1, 2],
  ['SetAuthManager(', 1, 2],
  ['ClosingWindow(', 1, 2],
  ['Vanish', 1, 2],
  ['LateEvent(', 1, 2],
  ['ClockJump(', 1, 2],
  ['Suspend(', 1, 2],
  ['ThrowingObserver(', 1, 1],
  ['ChallengeMode(', 1, 2],
  ['UrlMode(', 1, 2],
  ['Reentrant(', 3, 2],
  ['Open', 1, 2],
  ['Close', 1, 2],
  ['AwaitClose', 1, 2],
  ['Reconnect', 2, 2],
  ['Settle', 16, 3],
];

function weightOf(arbitrary: fc.Arbitrary<ModelCommand>, fallback: number, storm: boolean): number {
  const label = String(fc.sample(arbitrary, { numRuns: 1, seed: 1 })[0]);
  const found = WEIGHTS.find(([prefix]) => label.startsWith(prefix));
  return found === undefined ? (storm ? 2 : fallback) : storm ? found[2] : found[1];
}

/** An arbitrary with its own weight among the commands. */
function weigh(weight: number, arbitrary: fc.Arbitrary<ModelCommand>): fc.WeightedArbitrary<ModelCommand> {
  return { weight, arbitrary };
}

export function commandArbs(cfg: ModelConfig): fc.WeightedArbitrary<ModelCommand>[] {
  const t = cfg.timeouts;
  const i = cfg.internal;
  const advanceSet = [
    ...new Set([
      0,
      1,
      2,
      3,
      5,
      8,
      13,
      t.connect,
      t.handshake,
      t.request,
      t.idle,
      i.ping,
      i.stable,
      i.attemptFloor,
      cfg.maxRetryDelay,
    ]),
  ].filter((ms) => ms >= 0);
  const handle = fc.nat(40);
  const api: Entry[] = [
    fc.constant(
      cmd('Open', (w) => {
        w.c.open();
      }),
    ),
    fc.constant(
      cmd('Close', (w) => {
        void w.c.close();
      }),
    ),
    fc.constant(
      cmd('AwaitClose', async (w) => {
        const state = { done: false };
        void w.c.close().then(() => {
          state.done = true;
        });
        const limit = w.cfg.internal.goodbye + 50 + 10 * (w.cfg.latency.in + w.cfg.latency.out);
        const start = w.h.clock.now();
        while (!state.done && w.h.clock.now() - start <= limit) await w.advance(1);
        await w.advance(0);
        if (!state.done) throw new Error(`close() did not resolve within ${String(limit)} ms\n  ${w.log.join('\n  ')}`);
      }),
    ),
    fc.constant(
      cmd('Reconnect', (w) => {
        w.c.reconnect();
      }),
    ),
    fc
      .record({ p: fc.constantFrom(...CALLS), progressive: fc.boolean(), receive: fc.boolean() })
      .map(({ p, progressive, receive }) =>
        cmd(
          `Call(${p}${progressive ? ', progressiveCall' : receive ? ', receive_progress' : ''})`,
          (w) => {
            w.call(w.c, p, progressive, receive ? { receive_progress: true } : {});
          },
          (w) => p !== 'model.peer' || w.peer !== undefined,
        ),
      ),
    handle.map((n) =>
      cmd(`Resubscribe(${String(n)})`, (w) => {
        const h = w.handles[n % Math.max(1, w.handles.length)];
        if (h !== undefined) w.subscribe(h);
      }),
    ),
    handle.map((n) =>
      cmd(`Unsubscribe(${String(n)})`, (w) => {
        const subs = w.handles.flatMap((h) => h.subs);
        subs[n % Math.max(1, subs.length)]?.unsubscribe();
      }),
    ),
    fc.nat(TOPICS.length - 1).map((n) =>
      cmd(`Topic(${TOPICS[n]?.topic ?? ''})`, (w) => {
        w.topic(w.c, n);
      }),
    ),
    fc
      .record({
        p: fc.constantFrom(...PROCEDURES),
        kind: fc.constantFrom<HandlerKind>(
          'deferred',
          'deferred',
          'deferred',
          'echo',
          'echo',
          'progress',
          'progress',
          'scheduled',
          'throw',
          'never',
        ),
      })
      .map(({ p, kind }) =>
        cmd(`Register(${p}, ${kind})`, (w) => {
          w.register(w.c, p, kind);
        }),
      ),
    fc.record({ topic: fc.constantFrom('model.t1', 'model.t2'), ack: fc.boolean() }).map(({ topic, ack }) =>
      cmd(`Publish(${topic}, ${String(ack)})`, (w) => {
        w.publish(w.c, topic, ack);
      }),
    ),
    fc.constantFrom('uri' as const, 'options' as const, 'args' as const, 'match' as const).map((kind) =>
      cmd(`BadArgument(${kind})`, (w) => {
        w.bad(w.c, kind);
      }),
    ),
    fc.constantFrom('status' as const, 'onOpen' as const, 'onClose' as const).map((stream) =>
      cmd(`LifecycleSubscribe(${stream})`, (w) => {
        w.lifecycle(w.c, stream);
      }),
    ),
    handle.map((n) =>
      cmd(`LifecycleUnsubscribe(${String(n)})`, (w) => {
        w.lifecycles[n % Math.max(1, w.lifecycles.length)]?.rec.unsubscribe();
      }),
    ),
  ];
  const router: Entry[] = [
    fc.constantFrom(...PUBLISH_TOPICS).map((topic) =>
      cmd(`RouterPublish(${topic})`, (w) => {
        w.h.router.publish(topic, [`ev:${topic}`]);
      }),
    ),
    fc
      .record({ p: fc.constantFrom(...PROCEDURES, THROWING), live: fc.nat(3), progress: fc.boolean() })
      .map(({ p, live, progress }) =>
        cmd(`RouterInvoke(${live > 0 ? 'a live registration' : p}${progress ? ', receive_progress' : ''})`, (w) => {
          // mostly a procedure the router has registered for the client's session now (else it answers
          // no_such_procedure)
          const registered = w.registeredAtRouter();
          const procedure = live > 0 && registered.length > 0 ? (registered[live % registered.length] ?? p) : p;
          w.invoke(procedure, progress);
        }),
      ),
    fc.record({ n: handle, mode: fc.constantFrom('kill' as const, 'killnowait' as const) }).map(({ n, mode }) =>
      cmd(`RouterInterrupt(${String(n)}, ${mode})`, (w) => {
        const live = w.routerCalls.filter((r) => !r.call.done);
        live[n % Math.max(1, live.length)]?.call.interrupt(mode);
      }),
    ),
    fc
      .constantFrom(
        'wamp.close.system_shutdown',
        'wamp.close.killed',
        'wamp.close.goodbye_and_out',
        'wamp.error.goodbye_and_out',
        'com.example.session_ended',
      )
      .map((reason) =>
        cmd(`RouterGoodbye(${reason})`, (w) => {
          w.h.router.goodbye(reason);
        }),
      ),
    fc
      .constantFrom(
        'wamp.error.not_authorized',
        'thruway.error.authentication_failure',
        'wamp.error.no_such_realm',
        'wamp.close.killed',
      )
      .map((reason) =>
        cmd(`RouterAbort(${reason})`, (w) => {
          w.h.router.abort(reason);
        }),
      ),
    fc.constant(
      cmd('Kill', (w) => {
        for (const session of w.h.router.sessions) {
          const own = w.c.connections.some((c) => c.number === session.connection);
          if (own) w.h.router.kill(session.id);
        }
      }),
    ),
    fc.record({ kind: fc.constantFrom('topic' as const, 'register' as const), n: fc.nat(3) }).map(({ kind, n }) =>
      cmd(`Revoke(${kind}, ${String(n)})`, (w) => {
        if (kind === 'topic') w.h.router.revokeSubscription(TOPICS[n % TOPICS.length]?.topic ?? 'model.t1');
        else w.h.router.revokeRegistration(PROCEDURES[n % PROCEDURES.length] ?? 'model.r1');
      }),
    ),
    fc.constantFrom('subscribe' as const, 'register' as const, 'call' as const, 'publish' as const).map((type) =>
      cmd(`Deny(${type})`, (w) => {
        w.removers.push(w.h.router.deny((r) => r.type === type && r.uri.startsWith('model.')));
      }),
    ),
    fc
      .constantFrom('hello', 'probe', 'subscribe', 'register', 'unsubscribe', 'authenticate', 'goodbye', 'call')
      .map((kind) =>
        cmd(`Ignore(${kind})`, (w) => {
          const type = {
            hello: 1,
            probe: 48,
            subscribe: 32,
            register: 64,
            unsubscribe: 34,
            authenticate: 5,
            goodbye: 6,
            call: 48,
          }[kind];
          w.removers.push(
            w.h.router.ignore(
              (f) =>
                f[0] === type &&
                (kind !== 'probe' || f[3] === 'thruway.js.ping') &&
                (kind !== 'call' || f[3] !== 'thruway.js.ping'),
            ),
          );
        }),
      ),
    fc.nat(40).map((n) =>
      cmd(`SendGarbage(${String(n)})`, (w) => {
        const data = garbage(n, w);
        for (const c of open(w)) c.sendRaw(data);
      }),
    ),
    fc
      .constantFrom('ok' as const, 'refuse' as const, 'error-only' as const, 'hang' as const, 'throw' as const)
      .map((mode) =>
        cmd(`SetAvailable(${mode})`, (w) => {
          w.h.router.setAvailable(mode);
        }),
      ),
    fc
      .record({
        m: fc.nat(1),
        state: fc.constantFrom('registered' as const, 'absent' as const, 'stale' as const, 'silent' as const),
      })
      .map(({ m, state }) =>
        cmd(
          `SetProvider(${String(m)}, ${state})`,
          (w) => {
            const method = methods(w)[m % methods(w).length];
            if (method !== undefined) w.h.router.setProvider(method, state);
          },
          (w) => methods(w).length > 0,
        ),
      ),
    fc.constantFrom('ok' as const, 'none' as const, 'not_ready' as const).map((state) =>
      cmd(
        `SetAuthManager(${state})`,
        (w) => {
          w.h.router.setAuthManager(state);
        },
        (w) => methods(w).length > 0,
      ),
    ),
  ];
  const socket: Entry[] = [
    fc
      .record({ code: fc.constantFrom(1000, 1001, 1005, 1006, 1009, 1011, 4000), clean: fc.boolean() })
      .map(({ code, clean }) =>
        cmd(`Drop(${String(code)}, ${String(clean)})`, (w) => {
          for (const c of open(w)) c.controls.drop(code, clean);
        }),
      ),
    fc.constantFrom(1000, 1001, 1011, 4999).map((code) =>
      cmd(`CloseSocket(${String(code)})`, (w) => {
        for (const c of open(w)) c.controls.close(code, 'model');
      }),
    ),
    fc
      .record({
        mode: fc.constantFrom('drop' as const, 'buffer' as const),
        dir: fc.constantFrom('both' as const, 'up' as const, 'down' as const),
      })
      .map(({ mode, dir }) =>
        cmd(`Freeze(${mode}, ${dir})`, (w) => {
          for (const c of open(w)) c.controls.freeze(mode, dir);
        }),
      ),
    fc.constant(
      cmd('Thaw', (w) => {
        for (const c of w.c.connections) if (c.controls.frozen !== undefined) c.controls.thaw();
      }),
    ),
    fc.constantFrom(1, 5, 20).map((ms) =>
      cmd(`ClosingWindow(${String(ms)})`, (w) => {
        for (const c of open(w)) c.controls.closingWindow(ms);
      }),
    ),
    fc.constant(
      cmd('Vanish', (w) => {
        for (const c of open(w)) c.controls.vanish();
      }),
    ),
    fc.constantFrom('open' as const, 'message' as const, 'close' as const, 'error' as const).map((kind) =>
      cmd(`LateEvent(${kind})`, (w) => {
        const before = w.c.trace();
        for (const c of released(w)) c.controls.emitLate(kind);
        const after = w.c.trace();
        // INV-R10: a late event of a released socket changes nothing at all
        if (
          after.inputs.length !== before.inputs.length ||
          after.notifications.length !== before.notifications.length ||
          after.frames.length !== before.frames.length
        ) {
          throw new Error(`INV-R10: a late ${kind} on a released socket reached the client\n  ${w.log.join('\n  ')}`);
        }
      }),
    ),
  ];
  const time: Entry[] = [
    weigh(
      cfg.storm ? 30 : 60,
      fc.constantFrom(...advanceSet).map((ms) =>
        cmd(`Advance(${String(ms)})`, async (w) => {
          await w.advance(ms);
        }),
      ),
    ),
    fc.constant(
      cmd('Settle', async (w) => {
        await w.settle();
      }),
    ),
    fc.constant(
      cmd('AdvanceToNextTimer', (w) => {
        if (w.cfg.delivery === 'manual') w.h.router.flush();
        w.h.clock.advanceToNextTimer();
      }),
    ),
    fc.constantFrom(-5000, -100, -1, 1, 100, 5000).map((ms) =>
      cmd(`ClockJump(${String(ms)})`, (w) => {
        w.skews.push({ seq: w.lastSeq(), ms });
        w.h.clock.skew(ms);
      }),
    ),
    fc.constantFrom(5, 500, 5000, 60000).map((ms) =>
      cmd(`Suspend(${String(ms)})`, async (w) => {
        w.suspends.push({ seq: w.lastSeq(), ms });
        await w.h.clock.suspend(ms);
      }),
    ),
    fc.nat(5).map((n) =>
      cmd(
        `Flush(${String(n)})`,
        (w) => {
          w.h.router.flush(n);
        },
        (w) => w.cfg.delivery === 'manual',
      ),
    ),
  ];
  const app: Entry[] = [
    fc.constantFrom<ChallengeMode>('sync', 'scheduled', 'deferred', 'fail', 'reject', 'empty', 'never').map((mode) =>
      cmd(
        `ChallengeMode(${mode})`,
        (w) => {
          w.challengeMode = mode;
        },
        (w) => w.authmethods !== undefined,
      ),
    ),
    fc.constantFrom<UrlMode>('sync', 'scheduled', 'deferred', 'throw', 'empty').map((mode) =>
      cmd(
        `UrlMode(${mode})`,
        (w) => {
          w.urlMode = mode;
        },
        (w) => w.cfg.url === 'function',
      ),
    ),
    ...(['resolve', 'reject', 'next', 'complete'] as const).map((what) =>
      handle.map((n) =>
        cmd(`${what[0]?.toUpperCase() ?? ''}${what.slice(1)}(${String(n)})`, (w) => {
          // the oldest pending answer half the time (a slow app catching up), else any of them
          const pending = w.deferreds.filter((d) => !d.settled);
          (n % 2 === 0 ? pending[0] : pending[n % Math.max(1, pending.length)])?.[what]();
        }),
      ),
    ),
    handle.map((n) =>
      cmd(`ThrowingObserver(${String(n)})`, (w) => {
        const h = w.handles[n % Math.max(1, w.handles.length)];
        if (h !== undefined) w.throwing.add(h.n);
      }),
    ),
    fc
      .record({
        target: fc.constantFrom<ReentrantTarget>('op', 'interest', 'onClose', 'onOpen', 'status', 'handler'),
        action: fc.constantFrom<ReentrantAction>(
          'open',
          'close',
          'reconnect',
          'call',
          'topic',
          'unsubscribe',
          'publish',
        ),
      })
      .map(({ target, action }) =>
        cmd(`Reentrant(${target}, ${action})`, (w) => {
          if (target === 'onClose' || target === 'onOpen' || target === 'status') w.lifecycle(w.c, target);
          w.reentrant = { target, action };
        }),
      ),
    fc
      .record({
        target: fc.constantFrom(...PARTICIPANT_TARGETS),
        mode: fc.constantFrom('once' as const, 'always' as const),
      })
      .map(({ target, mode }) =>
        cmd(`InjectFault(${target}, ${mode})`, (w) => {
          w.faults = true;
          if (target === 'logger') w.faultLogger();
          (w.c.faults as { inject(target: string, mode: string): void }).inject(target, mode);
        }),
      ),
  ];
  const peer: Entry[] = cfg.peer
    ? [
        fc.constant(
          cmd('SecondClient', (w) => {
            w.startPeer();
          }),
        ),
        fc.constantFrom(...PROCEDURES).map((p) =>
          cmd(
            `PeerCall(${p})`,
            (w) => {
              if (w.peer !== undefined) w.call(w.peer, p, false);
            },
            (w) => w.peer !== undefined,
          ),
        ),
        fc.constant(
          cmd(
            'PeerDrop',
            (w) => {
              for (const c of w.peer?.connections ?? []) if (c.state === 'open') c.controls.drop();
            },
            (w) => w.peer !== undefined,
          ),
        ),
        fc.constant(
          cmd(
            'PeerClose',
            (w) => {
              void w.peer?.close();
            },
            (w) => w.peer !== undefined,
          ),
        ),
        fc.constant(
          cmd(
            'PeerOpen',
            (w) => {
              w.peer?.open();
            },
            (w) => w.peer !== undefined,
          ),
        ),
      ]
    : [];
  const weighted = (entries: Entry[], weight: number): fc.WeightedArbitrary<ModelCommand>[] =>
    entries.map((e) => ('weight' in e ? e : { weight: weightOf(e, weight, cfg.storm), arbitrary: e }));
  return [
    ...weighted(api, 2),
    ...weighted(router, 1),
    ...weighted(socket, 1),
    ...weighted(time, 1),
    ...weighted(app, 1),
    ...weighted(peer, 2),
  ];
}

/** One command, drawn with the weights above. */
export function commandArb(cfg: ModelConfig): fc.Arbitrary<ModelCommand> {
  return fc.oneof(...commandArbs(cfg));
}

/** Options of the model property (tests may pass a config arbitrary to narrow the runs). */
export interface ModelRunOptions {
  readonly maxCommands?: number;
  readonly config?: fc.Arbitrary<ModelConfig>;
}

/** The model property: a configuration, up to 60 commands, a scheduler. */
export function modelProperty(
  options: ModelRunOptions = {},
): fc.IAsyncPropertyWithHooks<[[ModelConfig, Iterable<ModelCommand>, fc.Scheduler]]> {
  const path = replayPath();
  const arb = (options.config ?? configArb()).chain((cfg) =>
    fc.tuple(
      fc.constant(cfg),
      fc.commands([commandArb(cfg)], {
        maxCommands: options.maxCommands ?? 60,
        size: 'max',
        ...(path === undefined ? {} : { replayPath: path }),
      }),
      fc.scheduler(),
    ),
  );
  return fc.asyncProperty(arb, async ([cfg, cmds, s]) => {
    const world = new World(cfg, s);
    try {
      await world.warmUp();
      await fc.scheduledModelRun(s, () => ({ model: world, real: world }), cmds);
      await world.finish();
    } finally {
      world.dispose();
    }
  });
}
