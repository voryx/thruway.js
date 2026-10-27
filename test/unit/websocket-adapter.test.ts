// WebSocket adapter: construction, event mapping (error without close, close without open, double close, late events
// with a no-op removeEventListener), send never throwing (CONNECTING, CLOSING, CLOSED, a throwing ws.send: false + the
// loss reported once), close-reason fallbacks, terminate, bufferedAmount, and the permanent error guard (the `ws`
// package's EventEmitter). Driven by a scriptable fake socket (test/helpers/scripted-websocket.ts); the platform
// profiles and a model-based property are in websocket-contract.test.ts, real sockets in
// test/node/websocket-real.test.ts.
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

const PROTOCOLS = ['wamp.2.json'] as const;

function setup(options: ScriptOptions = {}): { t: Transport; ws: ScriptedSocket; sink: RecordingSink } {
  const factory = scriptedWebSocket(options);
  const sink = recordingSink();
  const t = openWebSocket(factory.Ctor, 'ws://router.test/ws', PROTOCOLS, sink);
  return { t, ws: factory.last(), sink };
}

/** Fires every kind of event, as a socket would after the adapter let go of it. */
function emitEverything(ws: ScriptedSocket): void {
  ws.emit('open', {});
  ws.emit('message', { data: 'late' });
  ws.emit('error', { message: 'late error' });
  ws.emit('close', { code: 1000, reason: 'late', wasClean: true });
}

describe('construction', () => {
  test('new Ctor(url, copy of protocols), binaryType arraybuffer, the guard and four listeners', () => {
    const protocols = ['wamp.2.json'];
    const factory = scriptedWebSocket();
    openWebSocket(factory.Ctor, 'wss://a.test/', protocols, recordingSink());
    const ws = factory.last();
    expect(ws.url).toBe('wss://a.test/');
    expect(ws.protocols).toEqual(['wamp.2.json']);
    expect(ws.protocols).not.toBe(protocols);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.added.map((a) => a.type)).toEqual(['error', 'open', 'message', 'error', 'close']);
    expect(ws.added[0]?.listener).toBe(socketErrorGuard);
    expect(ws.listenerCount()).toBe(5);
  });

  test('a throwing constructor propagates the very value; nothing is reported', () => {
    const thrown = new SyntaxError('bad url');
    const factory = scriptedWebSocket({ ctorThrows: thrown });
    const sink = recordingSink();
    expect(() => openWebSocket(factory.Ctor, 'nope', PROTOCOLS, sink)).toThrow(thrown);
    expect(factory.sockets).toHaveLength(0);
    expect(sink.calls).toEqual([]);
  });

  test('a throwing addEventListener propagates after the socket was closed and its listeners removed', () => {
    const factory = scriptedWebSocket({ addEventListenerThrows: 'close' });
    const sink = recordingSink();
    expect(() => openWebSocket(factory.Ctor, 'ws://a.test/', PROTOCOLS, sink)).toThrow('addEventListener(close)');
    const ws = factory.last();
    expect(ws.closeCalls).toEqual([[1000, '']]);
    expect(ws.attached('error')).toEqual([socketErrorGuard]);
    expect(ws.listenerCount()).toBe(1);
    emitEverything(ws);
    expect(sink.calls).toEqual([]);
  });

  test('a binaryType setter that throws is tolerated (text frames still work)', () => {
    const { t, ws, sink } = setup({ binaryTypeThrows: true });
    ws.acceptOpen();
    ws.receive('[2,1,{}]');
    expect(t.send('x')).toBe(true);
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['message', '[2,1,{}]'],
    ]);
  });

  test('a socket that is already OPEN when its listeners are attached reports open at once, and only once', () => {
    const { ws, sink } = setup({ openOnConstruct: true });
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
    ws.acceptOpen();
    expect(sink.of('open')).toHaveLength(1);
  });

  test('without a static OPEN the WHATWG value 1 is used; another OPEN value is honoured', () => {
    const plain = setup({ staticOpen: 'absent' });
    plain.ws.acceptOpen();
    expect(plain.t.send('x')).toBe(true);

    const odd = setup({ staticOpen: 7 });
    odd.ws.acceptOpen();
    expect(odd.t.send('x')).toBe(false);
    const again = setup({ staticOpen: 7 });
    again.ws.readyState = 7;
    expect(again.t.send('y')).toBe(true);
    expect(again.ws.sent).toEqual(['y']);
  });
});

describe('events', () => {
  test('open reports ws.protocol; protocol "" (no subprotocol negotiated) and non-strings report ""', () => {
    const a = setup();
    a.ws.acceptOpen('wamp.2.json');
    expect(a.sink.calls).toEqual([['open', 'wamp.2.json']]);

    const b = setup();
    b.ws.acceptOpen('');
    expect(b.sink.calls).toEqual([['open', '']]);

    const c = setup();
    (c.ws as { protocol: unknown }).protocol = undefined;
    c.ws.readyState = 1;
    c.ws.emit('open', {});
    expect(c.sink.calls).toEqual([['open', '']]);
  });

  test('a second open event is ignored', () => {
    const { ws, sink } = setup();
    ws.acceptOpen();
    ws.acceptOpen();
    expect(sink.of('open')).toHaveLength(1);
  });

  test('each message event is one sink.message with the data untouched, in order', () => {
    const { ws, sink } = setup();
    ws.acceptOpen();
    const buffer = new ArrayBuffer(3);
    const frames: unknown[] = ['[36,1,2,{}]', buffer, '', '[]'];
    for (const frame of frames) ws.receive(frame);
    const received = sink.of('message').map(([data]) => data);
    expect(received).toEqual(frames);
    expect(received[1]).toBe(buffer);
  });

  test('a message event without data, a null event or a throwing data getter is reported as undefined', () => {
    const { ws, sink } = setup();
    ws.acceptOpen();
    ws.emit('message', {});
    ws.emit('message', null);
    ws.emit(
      'message',
      Object.defineProperty({}, 'data', {
        get() {
          throw new Error('data getter');
        },
      }),
    );
    expect(sink.of('message')).toEqual([[undefined], [undefined], [undefined]]);
  });

  test('error without close (Node 22 undici, socket never opened): exactly one closed(1006), no open', () => {
    const { ws, sink } = setup();
    const error = new Error('Received network error or non-101 status code.');
    ws.fail({ type: 'error', message: error.message, error }, 0);
    expect(sink.calls).toEqual([['closed', 1006, error.message, false, error]]);
  });

  test('error then close 1006 (browsers, Node 26 undici, ws): one closed, from the error', () => {
    const { ws, sink } = setup();
    const error = new TypeError('');
    ws.fail({ type: 'error', message: '', error });
    ws.closeFromPeer(1006, '', false);
    expect(sink.calls).toEqual([['closed', 1006, ERROR_FALLBACK, false, error]]);
  });

  test('close without open (and without error): closed with the event fields', () => {
    const { ws, sink } = setup();
    ws.closeFromPeer(1006, 'refused', false);
    expect(sink.calls).toEqual([['closed', 1006, 'refused', false, undefined]]);
  });

  test('close after open: code, reason and wasClean are reported; a second close event is ignored', () => {
    const { ws, sink } = setup();
    ws.acceptOpen();
    ws.closeFromPeer(4321, 'router says bye', true);
    ws.closeFromPeer(1000, 'again', true);
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['closed', 4321, 'router says bye', true, undefined],
    ]);
  });

  test.each([
    ['no wasClean, code 1000', { code: 1000, reason: 'r' }, [1000, 'r', true]],
    ['no wasClean, code 1011', { code: 1011, reason: 'r' }, [1011, 'r', false]],
    ['no reason', { code: 1001, wasClean: true }, [1001, '', true]],
    ['non-string reason', { code: 1001, reason: 42, wasClean: true }, [1001, '', true]],
    ['no code', { reason: 'r' }, [1006, 'r', false]],
    ['non-integer code', { code: 1000.5, reason: '' }, [1006, '', false]],
    ['string code', { code: '1000', reason: '' }, [1006, '', false]],
    ['non-boolean wasClean', { code: 1000, reason: '', wasClean: 'yes' }, [1000, '', true]],
    ['undefined event', undefined, [1006, '', false]],
    [
      'throwing getters',
      Object.defineProperties(
        {},
        {
          code: {
            get() {
              throw new Error('code');
            },
          },
          reason: {
            get() {
              throw new Error('reason');
            },
          },
        },
      ),
      [1006, '', false],
    ],
  ])('close event fallbacks: %s', (_name, ev, expected) => {
    const { ws, sink } = setup();
    ws.emit('close', ev);
    expect(sink.calls).toEqual([['closed', ...expected, undefined]]);
  });

  test.each([
    ['message', { message: 'getaddrinfo ENOTFOUND x.invalid' }, 'getaddrinfo ENOTFOUND x.invalid'],
    ['empty message, error.message', { message: '', error: new Error('inner') }, 'inner'],
    ['plain Event (browsers)', { type: 'error' }, ERROR_FALLBACK],
    ['empty message and error (Node 26)', { message: '', error: new TypeError('') }, ERROR_FALLBACK],
    ['non-string message', { message: 42 }, ERROR_FALLBACK],
    ['null event', null, ERROR_FALLBACK],
    [
      'throwing getter',
      Object.defineProperty({}, 'message', {
        get() {
          throw new Error('x');
        },
      }),
      ERROR_FALLBACK,
    ],
  ])('error event text: %s', (_name, ev, text) => {
    const { ws, sink } = setup();
    ws.emit('error', ev);
    expect(sink.of('closed')).toHaveLength(1);
    expect(sink.of('closed')[0]?.slice(0, 3)).toEqual([1006, text, false]);
  });

  test('error cause: ev.error when present, otherwise undefined (never the event itself)', () => {
    const inner = { code: 'ECONNREFUSED' };
    const a = setup();
    a.ws.emit('error', { message: 'm', error: inner });
    expect(a.sink.of('closed')[0]?.[3]).toBe(inner);
    const b = setup();
    b.ws.emit('error', { message: 'm', error: null });
    expect(b.sink.of('closed')[0]?.[3]).toBeUndefined();
    const c = setup();
    c.ws.emit('error', { message: 'm' });
    expect(c.sink.of('closed')[0]?.[3]).toBeUndefined();
  });

  test('after the terminal event only the guard stays attached', () => {
    const { ws } = setup();
    ws.acceptOpen();
    ws.closeFromPeer(1000, '', true);
    expect(ws.attached('error')).toEqual([socketErrorGuard]);
    expect(ws.listenerCount()).toBe(1);
  });

  test.each(['noop', 'throws'] as const)(
    'events after the terminal event are ignored when removeEventListener %s',
    (removeEventListener) => {
      const { t, ws, sink } = setup({ removeEventListener });
      ws.acceptOpen();
      ws.fail({ message: 'boom' }, 1);
      emitEverything(ws);
      expect(t.send('x')).toBe(false);
      expect(sink.calls).toEqual([
        ['open', 'wamp.2.json'],
        ['closed', 1006, 'boom', false, undefined],
      ]);
    },
  );

  test('a sink call that closes the transport re-entrantly stops further reports', () => {
    const factory = scriptedWebSocket({ removeEventListener: 'noop' });
    const ref: { t?: Transport } = {};
    const sink = recordingSink((call) => {
      if (call[0] === 'message') ref.t?.close(4000, 'protocol violation');
    });
    ref.t = openWebSocket(factory.Ctor, 'ws://a.test/', PROTOCOLS, sink);
    const ws = factory.last();
    ws.acceptOpen();
    ws.receive('garbage');
    ws.receive('more');
    ws.closeFromPeer(1000, '', true);
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['message', 'garbage'],
    ]);
    expect(ws.closeCalls).toEqual([[4000, 'protocol violation']]);
  });

  // The core's end() runs synchronously inside sink.closed (no step on the stack) and releases the transport there.
  // undici's close() on a socket that is still CONNECTING dispatches events from inside close() (measured: Node 22
  // fires `error` again, Node 24/26 `error` + `close 1006`), so the adapter must already be detached by then.
  test.each(['works', 'noop'] as const)(
    'the core releasing from inside sink.closed while ws.close re-fires error and close (removal %s): one report',
    (removeEventListener) => {
      const factory = scriptedWebSocket({ removeEventListener });
      const ref: { t?: Transport } = {};
      const sink = recordingSink((call) => {
        if (call[0] === 'closed') ref.t?.close(1000, '');
      });
      ref.t = openWebSocket(factory.Ctor, 'ws://a.test/', PROTOCOLS, sink);
      const ws = factory.last();
      const close = ws.close.bind(ws);
      ws.close = (...args: unknown[]): void => {
        close(...args);
        ws.emit('error', { message: 'Connection was closed before it was established.' });
        ws.emit('close', { code: 1006, reason: '', wasClean: false });
      };
      ws.fail({ message: 'Received network error or non-101 status code.' }, 0);
      expect(sink.calls).toEqual([
        ['closed', 1006, 'Received network error or non-101 status code.', false, undefined],
      ]);
      expect(ws.closeCalls).toEqual([[1000, '']]);
    },
  );
});

describe('send', () => {
  test('OPEN: true, and the socket gets exactly the data (string or Uint8Array, by reference)', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    const bytes = new Uint8Array([1, 2, 3]).subarray(1);
    expect(t.send('[1,"realm1",{}]')).toBe(true);
    expect(t.send(bytes)).toBe(true);
    expect(ws.sent).toEqual(['[1,"realm1",{}]', bytes]);
    expect(ws.sent[1]).toBe(bytes);
    expect(sink.of('closed')).toEqual([]);
  });

  test('CONNECTING: false without calling ws.send (WHATWG throws there); the loss is reported; socket closed', () => {
    const { t, ws, sink } = setup();
    expect(t.send('x')).toBe(false);
    expect(ws.sent).toEqual([]);
    expect(sink.calls).toEqual([['closed', 1006, SEND_REFUSED, false, undefined]]);
    expect(ws.closeCalls).toEqual([[1000, '']]);
  });

  test('CLOSING (router close frame received, no close event yet): false, the loss reported exactly once', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    ws.startClosing();
    expect(t.send('[16,1,{},"t"]')).toBe(false);
    expect(t.send('[48,2,{},"p"]')).toBe(false);
    ws.closeFromPeer(1000, 'bye', true);
    expect(t.send('x')).toBe(false);
    expect(ws.sent).toEqual([]);
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['closed', 1006, SEND_REFUSED, false, undefined],
    ]);
    expect(ws.closeCalls).toEqual([[1000, '']]);
  });

  test('CLOSED before the close event was seen: false, the loss reported once', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    ws.readyState = 3;
    expect(t.send('x')).toBe(false);
    expect(sink.of('closed')).toEqual([[1006, SEND_REFUSED, false, undefined]]);
  });

  test('a throwing ws.send while OPEN: false, the loss reported once with the thrown error', () => {
    const { t, ws, sink } = setup({ send: 'throws' });
    ws.acceptOpen();
    expect(t.send('x')).toBe(false);
    expect(t.send('y')).toBe(false);
    const closed = sink.of('closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.slice(0, 3)).toEqual([1006, SEND_REFUSED, false]);
    expect(closed[0]?.[3]).toEqual(new Error('send throws'));
  });

  test('a throwing readyState getter counts as not open', () => {
    const { t, ws, sink } = setup({ readyStateThrows: true });
    ws.acceptOpen();
    expect(t.send('x')).toBe(false);
    expect(sink.of('closed')).toEqual([[1006, SEND_REFUSED, false, undefined]]);
  });

  test('after the core closed the transport: false and nothing reported', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    t.close(1000, '');
    expect(t.send('x')).toBe(false);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
    expect(ws.closeCalls).toEqual([[1000, '']]);
  });

  test('after the socket closed: false and no second report', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    ws.closeFromPeer(1001, 'going away', true);
    expect(t.send('x')).toBe(false);
    expect(sink.of('closed')).toEqual([[1001, 'going away', true, undefined]]);
    expect(ws.closeCalls).toEqual([]);
  });

  test('a synchronous loopback may deliver the echo from inside send', () => {
    const { t, ws, sink } = setup({ echo: true });
    ws.acceptOpen();
    expect(t.send('[1,"r",{}]')).toBe(true);
    expect(sink.calls).toEqual([
      ['open', 'wamp.2.json'],
      ['message', '[1,"r",{}]'],
    ]);
  });
});

describe('close', () => {
  test('ws.close(code, reason) once; detaches, so nothing is reported afterwards even with a no-op removal', () => {
    const { t, ws, sink } = setup({ removeEventListener: 'noop' });
    ws.acceptOpen();
    t.close(4001, 'liveness timeout');
    t.close(1000, '');
    emitEverything(ws);
    expect(ws.closeCalls).toEqual([[4001, 'liveness timeout']]);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
  });

  test('listeners are removed, the guard stays', () => {
    const { t, ws } = setup();
    t.close(1000, '');
    expect(ws.listenerCount()).toBe(1);
    expect(ws.attached('error')).toEqual([socketErrorGuard]);
  });

  test.each([
    [
      'WHATWG: a reason over 123 UTF-8 bytes',
      { close: 'whatwg' },
      1000,
      'é'.repeat(62),
      [[1000, 'é'.repeat(62)], [1000]],
    ],
    ['WHATWG: a reserved code (1006)', { close: 'whatwg' }, 1006, 'x', [[1006, 'x'], [1006], []]],
    ['code only', { close: 'code-only' }, 4000, 'violation', [[4000, 'violation'], [4000]]],
    ['no arguments', { close: 'no-args' }, 4002, 'internal', [[4002, 'internal'], [4002], []]],
    ['always throws', { close: 'throws' }, 1000, '', [[1000, ''], [1000], []]],
  ] as const)('close-reason fallbacks: %s', (_name, options, code, reason, calls) => {
    const { t, ws } = setup(options);
    ws.acceptOpen();
    expect(() => {
      t.close(code, reason);
    }).not.toThrow();
    expect(ws.closeCalls).toEqual(calls);
  });

  test('close after the terminal event still closes the socket (an error may leave it open)', () => {
    const { t, ws, sink } = setup();
    ws.acceptOpen();
    ws.fail({ message: 'x' }, 1);
    t.close(1000, '');
    expect(ws.closeCalls).toEqual([[1000, '']]);
    expect(sink.of('closed')).toHaveLength(1);
  });

  test('close while CONNECTING on an EventEmitter socket (`ws`): its late error event does not throw', () => {
    const { t, ws, sink } = setup({ dispatch: 'emitter' });
    t.close(4001, 'connect timeout');
    // what `ws` does next (abortHandshake → emitErrorAndClose, in a later tick)
    expect(() => {
      ws.fail({ message: 'WebSocket was closed before the connection was established' }, 2);
      ws.closeFromPeer(1006, '', false);
    }).not.toThrow();
    expect(sink.calls).toEqual([]);
  });

  test('without the guard an EventEmitter socket would throw (the fake models `ws` faithfully)', () => {
    const factory = scriptedWebSocket({ dispatch: 'emitter' });
    const ws = new factory.Ctor('ws://a.test/') as ScriptedSocket;
    expect(() => {
      ws.fail({ message: 'x' });
    }).toThrow('Unhandled error event');
  });

  test('a close event dispatched synchronously from ws.close is not reported', () => {
    const { t, ws, sink } = setup({ syncClose: true });
    ws.acceptOpen();
    t.close(1000, '');
    expect(ws.readyState).toBe(3);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
  });
});

describe('terminate', () => {
  test('calls ws.terminate once when present, after close (lingering timer, hardReset)', () => {
    const { t, ws, sink } = setup({ terminate: 'works' });
    ws.acceptOpen();
    t.close(1000, '');
    t.terminate();
    t.terminate();
    expect(ws.closeCalls).toEqual([[1000, '']]);
    expect(ws.terminateCalls).toBe(1);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
  });

  test('absent (undici, browsers) or throwing terminate never throws', () => {
    for (const terminate of ['absent', 'throws'] as const) {
      const { t, ws } = setup({ terminate });
      ws.acceptOpen();
      t.close(1000, '');
      expect(() => {
        t.terminate();
      }).not.toThrow();
      expect(ws.terminateCalls).toBe(terminate === 'throws' ? 1 : 0);
    }
  });

  test('terminate alone detaches: nothing is reported afterwards', () => {
    const { t, ws, sink } = setup({ terminate: 'works', removeEventListener: 'noop' });
    ws.acceptOpen();
    t.terminate();
    emitEverything(ws);
    expect(sink.calls).toEqual([['open', 'wamp.2.json']]);
    expect(ws.closeCalls).toEqual([]);
  });

  test('a terminate getter that throws is contained', () => {
    const { t, ws } = setup();
    Object.defineProperty(ws, 'terminate', {
      get() {
        throw new Error('getter');
      },
    });
    expect(() => {
      t.terminate();
    }).not.toThrow();
  });
});

describe('bufferedAmount', () => {
  test('exposes ws.bufferedAmount, live', () => {
    const { t, ws } = setup();
    ws.acceptOpen();
    expect(t.bufferedAmount()).toBe(0);
    ws.amount = 65536;
    expect(t.bufferedAmount()).toBe(65536);
    ws.amount = 0;
    expect(t.bufferedAmount()).toBe(0);
  });

  test.each(['absent', 'throws', 'nan', 'infinity', 'negative', 'string'] as const)('%s ⇒ 0', (bufferedAmount) => {
    const { t, ws } = setup({ bufferedAmount });
    ws.acceptOpen();
    expect(t.bufferedAmount()).toBe(0);
  });

  test('still readable after close (a lingering connection never asks, but it must not throw)', () => {
    const { t, ws } = setup();
    ws.acceptOpen();
    ws.amount = 10;
    t.close(1000, '');
    expect(t.bufferedAmount()).toBe(10);
  });
});

describe('fixed texts', () => {
  test('the refused-write reason and the error fallback are the documented ASCII strings', () => {
    expect(SEND_REFUSED).toBe('send on a socket that is not open');
    expect(ERROR_FALLBACK).toBe('WebSocket error');
  });
});

describe('socketErrorGuard', () => {
  test('is a no-op that holds nothing', () => {
    expect(() => {
      socketErrorGuard();
    }).not.toThrow();
    expect(socketErrorGuard.length).toBe(0);
  });
});
