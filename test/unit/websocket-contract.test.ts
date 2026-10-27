// The transport contract: `WebSocketConstructorLike` is the interface every transport implements — the platform
// WebSocket of browsers and Node (undici), the `ws` package, React Native, the testing kit's socket and any custom
// transport (a worker bridge, a recording transport in an app's tests). This file is its conformance suite: what such a
// transport MUST do, what it MAY do, and that the adapter turns every allowed behaviour into the same internal
// contract.
//
// A transport MUST: construct with `(url, protocols)` (or throw); fire `open` once connected (or already be OPEN when
// the constructor returns); deliver each WebSocket message as one `message` event whose `data` is a string,
// ArrayBuffer or Uint8Array; fire `error` and/or `close` when the connection fails or ends; expose `readyState` with
// `Ctor.OPEN` (default 1) while writable; accept `send(string | Uint8Array)` while OPEN.
// A transport MAY: fire `error` without `close` (Node 22's undici for sockets that never open) or `close` without
// `error`; fire either twice or late; omit `wasClean`, `reason` or even `code`; report `protocol` as '' (no subprotocol
// negotiated); throw from `send` in any state, from `close` for some argument shapes, from `removeEventListener`, or
// make it a no-op; dispatch events synchronously from its own methods; be an EventEmitter that throws an
// `error` event nobody listens to (`ws`); lack `terminate`, `bufferedAmount` or a static `OPEN`.
// The adapter then guarantees (the internal `TransportSink`/`Transport` contract the core relies on):
//   G1 open at most once, nothing after `closed` (a message a transport delivers before `open` is passed through: no
//      WHATWG socket does that, and the core drops `ws.message` in CONNECTING);
//   G2 `closed` exactly once per terminal event or refused write, unless the core closed/terminated first, after
//      which nothing at all is reported;
//   G3 message data is passed through untouched, in order;
//   G4 `send` returns true iff the socket was live, OPEN and `ws.send` returned; a false while live reports
//      `closed(1006, SEND_REFUSED, false, thrown?)` at once and closes the socket;
//   G5 `ws.close` is one request (`(code, reason)` → `(code)` → `()` until one does not throw), `terminate` at most once;
//   G6 no adapter method and no listener ever throws, whatever the socket does; the socket is never left without an
//      `error` listener (the guard), and the adapter's own four listeners are removed when it lets go.
// The platform profiles below reproduce the event sequences measured on real sockets; the same
// cases run against the real undici and `ws` implementations in test/node/websocket-real.test.ts.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  ERROR_FALLBACK,
  openWebSocket,
  SEND_REFUSED,
  socketErrorGuard,
  type Transport,
} from '../../src/transport/websocket.js';
import {
  recordingSink,
  scriptedWebSocket,
  type RecordingSink,
  type ScriptedSocket,
  type ScriptOptions,
} from '../helpers/scripted-websocket.js';
import { replayParameters } from '../setup-fast-check.js';

interface Profile {
  readonly name: string;
  readonly options: ScriptOptions;
  /** How the platform reports a socket that never opens (DNS, TLS, refused, 4xx, subprotocol mismatch). */
  readonly neverOpens?: (ws: ScriptedSocket) => void;
  /** What the platform does after `close()` while CONNECTING (the connect timeout). */
  readonly afterCloseWhileConnecting: (ws: ScriptedSocket) => void;
  /** wasClean of a router-initiated close with code 4xxx, as the platform reports it (undefined: omitted). */
  readonly routerCloseClean: boolean | undefined;
}

const profiles: readonly Profile[] = [
  {
    name: 'browser (WHATWG)',
    options: {},
    neverOpens: (ws) => {
      ws.fail({ type: 'error' }, 3);
      ws.closeFromPeer(1006, '', false);
    },
    afterCloseWhileConnecting: (ws) => {
      ws.fail({ type: 'error' }, 3);
      ws.closeFromPeer(1006, '', false);
    },
    routerCloseClean: true,
  },
  {
    name: 'Node 22 undici (error, never close; readyState stays CONNECTING)',
    options: {},
    neverOpens: (ws) => {
      const message = 'Received network error or non-101 status code.';
      ws.fail({ type: 'error', message, error: new Error(message) }, 0);
    },
    afterCloseWhileConnecting: () => {
      // nothing more
    },
    routerCloseClean: true,
  },
  {
    name: 'Node 24/26 undici (error with empty messages, then close 1006)',
    options: {},
    neverOpens: (ws) => {
      ws.fail({ type: 'error', message: '', error: new TypeError('') }, 3);
      ws.closeFromPeer(1006, '', false);
    },
    afterCloseWhileConnecting: (ws) => {
      ws.fail({ type: 'error', message: '', error: new TypeError('') }, 3);
      ws.closeFromPeer(1006, '', false);
    },
    routerCloseClean: true,
  },
  {
    name: '`ws` 8 (EventEmitter, terminate)',
    options: { dispatch: 'emitter', terminate: 'works' },
    neverOpens: (ws) => {
      const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
      ws.fail({ type: 'error', message: error.message, error }, 2);
      ws.closeFromPeer(1006, '', false);
    },
    afterCloseWhileConnecting: (ws) => {
      const message = 'WebSocket was closed before the connection was established';
      ws.fail({ type: 'error', message, error: new Error(message) }, 2);
      ws.closeFromPeer(1006, '', false);
    },
    routerCloseClean: true,
  },
  {
    name: 'React Native (no wasClean, no bufferedAmount)',
    options: { bufferedAmount: 'absent' },
    neverOpens: (ws) => {
      ws.fail({ type: 'error', message: 'Failed to connect to /127.0.0.1:9' }, 3);
      ws.closeFromPeer(1006, 'Failed to connect to /127.0.0.1:9');
    },
    afterCloseWhileConnecting: (ws) => {
      ws.closeFromPeer(1006, '');
    },
    routerCloseClean: undefined,
  },
  {
    name: 'minimal custom transport (no-op removal, close() only, no OPEN/terminate/bufferedAmount)',
    options: {
      removeEventListener: 'noop',
      close: 'no-args',
      staticOpen: 'absent',
      bufferedAmount: 'absent',
      terminate: 'absent',
    },
    neverOpens: (ws) => {
      ws.readyState = 3;
      ws.emit('close', {});
      ws.emit('close', {});
      ws.emit('error', {});
    },
    afterCloseWhileConnecting: (ws) => {
      ws.emit('close', {});
    },
    routerCloseClean: undefined,
  },
  {
    name: 'synchronous loopback (open inside the constructor, echo inside send, close event inside close)',
    options: { openOnConstruct: true, echo: true, syncClose: true },
    afterCloseWhileConnecting: () => {
      // never CONNECTING
    },
    routerCloseClean: true,
  },
];

function connect(profile: Profile): { t: Transport; ws: ScriptedSocket; sink: RecordingSink } {
  const factory = scriptedWebSocket(profile.options);
  const sink = recordingSink();
  const t = openWebSocket(factory.Ctor, 'ws://router.test/', ['wamp.2.json'], sink);
  return { t, ws: factory.last(), sink };
}

function opened(profile: Profile): { t: Transport; ws: ScriptedSocket; sink: RecordingSink } {
  const c = connect(profile);
  if (!profile.options.openOnConstruct) c.ws.acceptOpen();
  return c;
}

/** G6: the adapter's listeners are gone (when removal works) and the guard is attached. */
function expectReleased(profile: Profile, ws: ScriptedSocket): void {
  expect(ws.attached('error')).toContain(socketErrorGuard);
  if ((profile.options.removeEventListener ?? 'works') === 'works') expect(ws.listenerCount()).toBe(1);
}

function lateEvents(ws: ScriptedSocket): void {
  ws.emit('open', {});
  ws.emit('message', { data: 'late' });
  ws.emit('error', { message: 'late' });
  ws.emit('close', { code: 1000, reason: 'late', wasClean: true });
}

describe.each(profiles)('conformance: $name', (profile) => {
  test('a session: open (protocol), messages in order and untouched, the router closes', () => {
    const { t, ws, sink } = opened(profile);
    const binary = new ArrayBuffer(4);
    ws.receive('[2,1,{}]');
    ws.receive(binary);
    expect(t.send('[48,7,{},"p"]')).toBe(true);
    ws.closeFromPeer(4321, 'router bye', profile.routerCloseClean);
    lateEvents(ws);
    const echo = profile.options.echo ? [['message', '[48,7,{},"p"]']] : [];
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['message', '[2,1,{}]'],
      ['message', binary],
      ...echo,
      ['closed', 4321, 'router bye', profile.routerCloseClean ?? false, undefined],
    ]);
    expect(sink.of('message')[1]?.[0]).toBe(binary);
    expectReleased(profile, ws);
  });

  const neverOpens = profile.neverOpens;
  // A synchronous loopback is OPEN when constructed, so it has no never-opens case.
  if (neverOpens) {
    test('a socket that never opens: exactly one closed (1006, not clean), no open', () => {
      const { t, ws, sink } = connect(profile);
      expect(() => {
        neverOpens(ws);
      }).not.toThrow();
      expect(sink.of('open')).toEqual([]);
      expect(sink.of('closed')).toHaveLength(1);
      const [code, reason, wasClean] = sink.of('closed')[0] ?? [];
      expect([code, wasClean]).toEqual([1006, false]);
      expect(typeof reason).toBe('string');
      expect(() => {
        t.close(1000, '');
        t.terminate();
      }).not.toThrow();
      expect(sink.calls).toHaveLength(1);
      expectReleased(profile, ws);
    });
  }

  test('the router close frame, then a write: false, the loss reported once, the socket closed', () => {
    const { t, ws, sink } = opened(profile);
    ws.startClosing();
    expect(t.send('[32,1,{},"t"]')).toBe(false);
    expect(t.send('[32,2,{},"u"]')).toBe(false);
    ws.closeFromPeer(1000, 'bye', profile.routerCloseClean);
    expect(sink.of('closed')).toEqual([[1006, SEND_REFUSED, false, undefined]]);
    expect(ws.sent).toEqual([]);
    expect(ws.closeCalls.length).toBeGreaterThan(0);
    expectReleased(profile, ws);
  });

  test('the connect timeout (close while CONNECTING): nothing reported, nothing thrown', () => {
    const { t, ws, sink } = connect(profile);
    const before = sink.calls.length;
    t.close(4001, 'connect timeout');
    expect(() => {
      profile.afterCloseWhileConnecting(ws);
      lateEvents(ws);
    }).not.toThrow();
    expect(sink.calls).toHaveLength(before);
    expectReleased(profile, ws);
  });

  test('the client closes an open session: one close request, nothing reported afterwards', () => {
    const { t, ws, sink } = opened(profile);
    t.close(1000, 'wamp.close.normal');
    t.close(4002, 'again');
    ws.closeFromPeer(1000, '', profile.routerCloseClean);
    lateEvents(ws);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
    expect(ws.closeCalls[0]).toEqual([1000, 'wamp.close.normal']);
    expect(ws.closeCalls.length).toBeLessThanOrEqual(3);
    expectReleased(profile, ws);
  });

  test('the lingering timer: close, then terminate when the transport has it', () => {
    const { t, ws } = opened(profile);
    t.close(1000, '');
    t.terminate();
    t.terminate();
    expect(ws.terminateCalls).toBe(profile.options.terminate === 'works' ? 1 : 0);
  });

  test('bufferedAmount is a finite number ≥ 0', () => {
    const { t, ws } = opened(profile);
    ws.amount = 1234;
    const amount = t.bufferedAmount();
    expect(Number.isFinite(amount) && amount >= 0).toBe(true);
    expect(amount).toBe(profile.options.bufferedAmount === 'absent' ? 0 : 1234);
  });
});

// --- model-based property (G1–G6 over random socket behaviour and random interleavings) --------------------------

type Act =
  | { readonly k: 'open'; readonly protocol: string }
  | { readonly k: 'message'; readonly data: unknown }
  | {
      readonly k: 'error';
      readonly ev: unknown;
      readonly text: string;
      readonly cause: unknown;
      readonly state: number;
    }
  | { readonly k: 'close'; readonly code: number; readonly reason: string; readonly wasClean: boolean | undefined }
  | { readonly k: 'state'; readonly state: number }
  | { readonly k: 'send'; readonly data: string }
  | { readonly k: 'core-close'; readonly code: number; readonly reason: string }
  | { readonly k: 'terminate' }
  | { readonly k: 'buffered'; readonly amount: number };

const errorEvents = fc.oneof(
  fc.constant({ ev: { type: 'error' }, text: ERROR_FALLBACK, cause: undefined }),
  fc.string({ minLength: 1 }).map((m) => ({ ev: { message: m }, text: m, cause: undefined })),
  fc.string({ minLength: 1 }).map((m) => {
    const error = new Error(m);
    return { ev: { message: '', error }, text: m, cause: error };
  }),
  fc.constant(null).map(() => {
    const error = new TypeError('');
    return { ev: { message: '', error }, text: ERROR_FALLBACK, cause: error };
  }),
  fc.constant({ ev: undefined, text: ERROR_FALLBACK, cause: undefined }),
);

const acts: fc.Arbitrary<Act> = fc.oneof(
  fc.constantFrom('wamp.2.json', '').map((protocol): Act => ({ k: 'open', protocol })),
  fc
    .oneof(
      fc.string(),
      fc.constant(null).map(() => new ArrayBuffer(2)),
    )
    .map((data): Act => ({ k: 'message', data })),
  fc.tuple(errorEvents, fc.integer({ min: 0, max: 3 })).map(([e, state]): Act => ({ k: 'error', ...e, state })),
  fc
    .tuple(
      fc.integer({ min: 1000, max: 4999 }),
      fc.string({ maxLength: 8 }),
      fc.option(fc.boolean(), { nil: undefined }),
    )
    .map(([code, reason, wasClean]): Act => ({ k: 'close', code, reason, wasClean })),
  fc.integer({ min: 0, max: 3 }).map((state): Act => ({ k: 'state', state })),
  fc.string({ maxLength: 8 }).map((data): Act => ({ k: 'send', data })),
  fc
    .tuple(fc.constantFrom(1000, 3000, 4000, 4001, 4002, 1006), fc.constantFrom('', 'bye', 'é'.repeat(62)))
    .map(([code, reason]): Act => ({ k: 'core-close', code, reason })),
  fc.constant<Act>({ k: 'terminate' }),
  fc.oneof(fc.nat(), fc.constant(0)).map((amount): Act => ({ k: 'buffered', amount })),
);

const scriptOptions: fc.Arbitrary<ScriptOptions> = fc.record(
  {
    dispatch: fc.constantFrom('event-target', 'emitter'),
    removeEventListener: fc.constantFrom('works', 'noop', 'throws'),
    terminate: fc.constantFrom('absent', 'works', 'throws'),
    bufferedAmount: fc.constantFrom('number', 'absent', 'throws', 'nan', 'infinity', 'negative', 'string'),
    send: fc.constantFrom('whatwg', 'throws'),
    close: fc.constantFrom('whatwg', 'code-only', 'no-args', 'throws'),
    openOnConstruct: fc.boolean(),
    echo: fc.boolean(),
    syncClose: fc.boolean(),
    binaryTypeThrows: fc.boolean(),
    staticOpen: fc.constantFrom<number | 'absent'>(1, 'absent'),
  },
  { requiredKeys: [] },
);

/** Stands for "the error the fake's throwing `send` threw" in the model's expectations. */
const THROWN_BY_SEND = Symbol('thrown by send');

const validCode = (code: number): boolean => code === 1000 || (code >= 3000 && code <= 4999);

/** The `ws.close` calls one close request makes against each fake `close` mode (G5). */
function closeChain(mode: ScriptOptions['close'], code: number, reason: string): unknown[][] {
  const fits = new TextEncoder().encode(reason).length <= 123;
  if ((mode ?? 'whatwg') === 'whatwg' && validCode(code) && fits) return [[code, reason]];
  if ((mode ?? 'whatwg') !== 'no-args' && mode !== 'throws' && validCode(code)) return [[code, reason], [code]];
  return [[code, reason], [code], []];
}

/** The test timeout scales with FC_NUM_RUNS: ~0.25 ms per run measured, 1 ms per run allowed. */
const PROPERTY_TIMEOUT = Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100));

describe('property: G1–G6 hold for any allowed socket behaviour and any interleaving', () => {
  test(
    'the adapter matches the reference model after every step',
    () => {
      fc.assert(
        fc.property(scriptOptions, fc.array(acts, { maxLength: 40 }), (options, script) => {
          const factory = scriptedWebSocket(options);
          const sink = recordingSink();
          const t = openWebSocket(factory.Ctor, 'ws://router.test/', ['wamp.2.json'], sink);
          const ws = factory.last();
          // the reference model
          const expected: unknown[][] = [];
          let live = true;
          let opened = false;
          let closeRequested = false;
          let terminated = false;
          const closeCalls: unknown[][] = [];
          const requestClose = (code: number, reason: string): void => {
            if (closeRequested) return;
            closeRequested = true;
            live = false;
            closeCalls.push(...closeChain(options.close, code, reason));
          };
          if (options.openOnConstruct) {
            expected.push(['open', 'wamp.2.json']);
            opened = true;
          }

          for (const act of script) {
            switch (act.k) {
              case 'open':
                ws.acceptOpen(act.protocol);
                if (live && !opened) expected.push(['open', act.protocol]);
                opened = true;
                break;
              case 'message':
                ws.receive(act.data);
                if (live) expected.push(['message', act.data]);
                break;
              case 'error':
                ws.fail(act.ev, act.state);
                if (live) expected.push(['closed', 1006, act.text, false, act.cause]);
                live = false;
                break;
              case 'close':
                ws.closeFromPeer(act.code, act.reason, act.wasClean);
                if (live) expected.push(['closed', act.code, act.reason, act.wasClean ?? act.code === 1000, undefined]);
                live = false;
                break;
              case 'state':
                ws.readyState = act.state;
                break;
              case 'send': {
                const writable = live && ws.readyState === 1 && options.send !== 'throws';
                const thrown = live && ws.readyState === 1 && options.send === 'throws';
                const result = t.send(act.data);
                expect(result).toBe(writable);
                if (writable) {
                  if (options.echo) expected.push(['message', act.data]);
                } else if (live) {
                  expected.push(['closed', 1006, SEND_REFUSED, false, thrown ? THROWN_BY_SEND : undefined]);
                  requestClose(1000, '');
                }
                break;
              }
              case 'core-close':
                t.close(act.code, act.reason);
                requestClose(act.code, act.reason);
                break;
              case 'terminate':
                t.terminate();
                terminated = true;
                live = false;
                break;
              case 'buffered': {
                ws.amount = act.amount;
                const mode = options.bufferedAmount ?? 'number';
                expect(t.bufferedAmount()).toBe(mode === 'number' ? act.amount : 0);
                break;
              }
            }
            // G1–G4: exactly the model's sink calls, by identity (data, errors)
            expect(sink.calls).toHaveLength(expected.length);
            sink.calls.forEach((call, i) => {
              const want = expected[i] ?? [];
              expect(call).toHaveLength(want.length);
              call.forEach((v, j) => {
                if (want[j] === THROWN_BY_SEND) expect(v).toEqual(new Error('send throws'));
                else expect(v).toBe(want[j]);
              });
            });
            // G5
            expect(ws.closeCalls).toEqual(closeCalls);
            expect(ws.terminateCalls).toBe(terminated && (options.terminate ?? 'absent') !== 'absent' ? 1 : 0);
            // G6
            expect(ws.attached('error')).toContain(socketErrorGuard);
            if (!live && (options.removeEventListener ?? 'works') === 'works') expect(ws.listenerCount()).toBe(1);
            if (live) expect(ws.listenerCount()).toBe(5);
          }
        }),
        { ...replayParameters() },
      );
    },
    PROPERTY_TIMEOUT,
  );
});
