// TypeScript consumer of the packed thruway.js (scripts/consumer-matrix.sh). The matrix copies this file as api.mts,
// api.cts and api.ts, so the same code is checked through the `import` and the `require` types of every entry point,
// with `skipLibCheck: false`. It uses the public API apps commonly use and checks that the types are
// precise (each @ts-expect-error line fails the cell if a type were `any` or too wide). In this repository it is
// linted through test/consumers/ts/tsconfig.json (types from src); it is never run.
import {
  AbortError,
  AuthenticationError,
  CanceledError,
  Client,
  ConnectionClosedError,
  ConnectionLostError,
  isThruwayError,
  isWampError,
  jsonSerializer,
  ProtocolError,
  TimeoutError,
  WampError,
  Yield,
  type ChallengeMessage,
  type ClientOptions,
  type CloseInfo,
  type ErrorCode,
  type EventMessage,
  type Input,
  type InvocationMessage,
  type LogEntry,
  type Observable,
  type RegisteredMessage,
  type ResultMessage,
  type Session,
  type Status,
  type Subscription,
  type ThruwayError,
  type WebSocketConstructorLike,
} from 'thruway.js';
import { cryptosign, ticket, wampcra } from 'thruway.js/auth';
import { createTestRouter, createVirtualClock, type TestRouter, type VirtualClock } from 'thruway.js/testing';

/** Values the checks below read, so nothing is unused. */
export const seen: unknown[] = [];

function describeError(error: ThruwayError): string {
  const code: ErrorCode = error.code;
  switch (error.code) {
    case 'wamp_error':
      return `${error.uri} ${String(error.args.length)}`;
    case 'connection_lost':
      return `${String(error.reason)} ${String(error.closeCode)}`;
    case 'connection_closed':
      return String(error.gaveUp);
    case 'timeout':
      return `${error.timer} ${String(error.timeout)}`;
    case 'abort':
      return error.reason;
    case 'protocol':
      return String(error.frame);
    case 'canceled':
      return code;
    case 'authentication':
      return String(error.authMethod);
  }
}

export async function consumer(): Promise<number> {
  const clock: VirtualClock = createVirtualClock({ seed: 1 });
  const router: TestRouter = createTestRouter({
    clock,
    authenticate: ({ realm }) => (realm === 'closed' ? { abort: 'wamp.error.no_such_realm' } : { welcome: {} }),
  });
  router.procedure('com.example.add', (args) => Number(args[0]) + Number(args[1]));
  const WebSocket: WebSocketConstructorLike = router.WebSocket;

  const options: ClientOptions = {
    WebSocket,
    clock,
    requestIds: 'sequential',
    retryOptions: {
      initialRetryDelay: 100,
      maxRetryDelay: 1000,
      retryDelayGrowth: 2,
      maxRetries: Infinity,
      retryDelay: (attempt: number, closed: CloseInfo, defaultDelay: number) =>
        closed.initiator === 'router' && attempt > 3 ? null : defaultDelay,
    },
    timeouts: { connect: 1000, handshake: 1000, request: 1000, idle: 0 },
    logger: (entry: LogEntry) => seen.push(`${entry.level} ${entry.event}`),
    ...ticket('joe', () => Promise.resolve('secret')),
  };
  const client = new Client(router.url, 'realm1', options);
  const lazy = new Client(() => Promise.resolve(router.url), 'org.example', { WebSocket, clock, autoOpen: false });

  const add: Observable<ResultMessage<[number], { total?: number }>> = client.call<[number], { total?: number }>(
    'com.example.add',
    [1, 2],
    {},
    { disclose_me: true, timeout: 1000 },
  );
  let sum = 0;
  const subscription: Subscription = add.subscribe({
    next: (r) => {
      sum = r.args[0];
      const total: number | undefined = r.kwargs.total;
      const progress: boolean | undefined = r.details.progress;
      seen.push(total, progress);
    },
    error: (e: unknown) => {
      if (isWampError(e)) seen.push(e.uri);
    },
  });
  client.progressiveCall('com.example.add', [1, 2]).subscribe((r: ResultMessage) => seen.push(r.args));
  client
    .register(
      'com.example.echo',
      (inv: InvocationMessage) => {
        inv.signal.addEventListener('abort', () => seen.push(inv.signal.reason));
        return new Yield([String(inv.args[0])], { procedure: inv.procedure });
      },
      { match: 'exact', invoke: 'roundrobin', disclose_caller: true },
    )
    .subscribe((r: RegisteredMessage) => seen.push(r.registrationId));
  client.register('com.example.many', () => client.call('com.example.add', [3, 4]));
  client.register('com.example.later', () => Promise.resolve(1));
  client
    .topic<[string], { n: number }>('com.example.topic', { match: 'prefix' })
    .subscribe((e: EventMessage<[string], { n: number }>) => {
      const s: string = e.args[0];
      const n: number = e.kwargs.n;
      seen.push(s, n);
    });
  client
    .publish('com.example.topic', ['x'], { n: 1 }, { acknowledge: true, exclude_me: false, eligible: [1] })
    .subscribe({ complete: () => seen.push('published') });
  client.status.subscribe((s: Status) => {
    if (s.state === 'connecting') seen.push(s.attempt satisfies number);
    else if (s.state === 'open') seen.push(s.session.details.authid satisfies string | undefined);
    else seen.push(s.closed?.willRetry satisfies boolean | undefined);
  });
  client.onOpen.subscribe((s: Session) => seen.push(s.id, s.realm, s.details.authroles));
  client.onClose.subscribe((c: CloseInfo) => {
    if (c.error !== undefined) seen.push(describeError(c.error));
    seen.push(c.initiator, c.reason, c.details, c.wasClean, c.delay, c.attempt, c.sessionId);
  });
  const onChallenge = (challenge: ChallengeMessage): Input<string> =>
    challenge.authMethod === 'ticket' ? Promise.resolve('t') : new Promise<string>(() => undefined);
  seen.push(
    onChallenge,
    wampcra('peter', 'secret1'),
    cryptosign({ publicKey: '00'.repeat(32), sign: (message: Uint8Array) => Promise.resolve(message) }),
    jsonSerializer({ binary: true }).serialize([1]),
  );

  const errors: ThruwayError[] = [
    new WampError('wamp.error.not_authorized', ['denied'], { a: 1 }, {}),
    new ConnectionLostError({ reason: 'wamp.close.system_shutdown' }),
    new ConnectionClosedError({ gaveUp: true }),
    new TimeoutError({ timer: 'connect', timeout: 10 }),
    new AbortError({ reason: 'wamp.error.no_such_realm' }),
    new ProtocolError({ message: 'bad frame' }),
    new CanceledError(),
    new AuthenticationError({ message: 'no answer', authMethod: 'ticket' }),
  ];
  seen.push(errors.filter(isThruwayError).map(describeError));

  for await (const status of client.status) {
    if (status.state === 'open') break;
  }
  await clock.advance(100);
  subscription.unsubscribe();
  client.reconnect();
  client.open();
  lazy.open();
  seen.push(client.session?.id);
  await Promise.all([client.close(), lazy.close()]);
  return sum;
}

// The types are precise: each of these must be an error.
// @ts-expect-error the procedure is a string
seen.push(new Client('ws://x', 'r').call(42));
// @ts-expect-error a ResultMessage is not a string
export const wrongResult: Observable<string> = new Client('ws://x', 'r').call('a.b');
// @ts-expect-error maxRetries is a number
export const wrongRetries: ClientOptions = { retryOptions: { maxRetries: '3' } };
// @ts-expect-error requestIds is 'random' or 'sequential'
export const wrongIds: ClientOptions = { requestIds: 'uuid' };
// @ts-expect-error the public testing kit has no dialects (the internal kit has)
export const noDialect = createTestRouter({ dialect: 'crossbar' });
