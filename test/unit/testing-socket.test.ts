// The testing kit's fake WebSocket (src/testing/socket.ts): WHATWG client-end semantics, the two in-order pipes, the
// fault controls (drop, close, closingWindow, freeze/thaw, emitLate, fail, hang via no answer, terminate) and listener
// counting with the adapter's permanent error guard — against a stub network, so every rule is checked without the
// router; the last block runs the real adapter on top.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  createFakeWebSocket,
  type FakeLink,
  type FakeNetwork,
  type FakeSocket,
  type LinkEnd,
  utf8Length,
} from '../../src/testing/socket.js';
import { openWebSocket, SEND_REFUSED, socketErrorGuard } from '../../src/transport/websocket.js';

interface StubOptions {
  readonly delivery?: 'sync' | 'manual';
  readonly terminate?: boolean;
  readonly closeEvents?: 'async' | 'sync';
  /** What the router does with a new link [accept]. */
  readonly answer?: (link: FakeLink) => void;
  readonly connectThrows?: boolean;
  /** Also called from the router end's `closed` handler. */
  readonly onClosed?: (link: FakeLink, end: LinkEnd) => void;
}

/** A network whose router end only records: messages (with their tags), ends, sent/received hooks. */
function stub(options: StubOptions = {}) {
  const queue: { readonly what: string; readonly fn: () => void }[] = [];
  const links: FakeLink[] = [];
  const messages: [number, string | Uint8Array, unknown][] = [];
  const ends: [number, LinkEnd][] = [];
  const hooks: string[] = [];
  const listenerErrors: unknown[] = [];
  let numbers = 0;
  const later = (what: string, fn: () => void): void => {
    if (options.delivery === 'sync') fn();
    else queue.push({ what, fn });
  };
  const network: FakeNetwork = {
    scheduler: {
      schedule: (d, fn) => {
        later(d, fn);
      },
      after: (ms, fn) => {
        later(`after ${String(ms)}`, fn);
      },
    },
    terminate: options.terminate,
    closeEvents: options.closeEvents,
    nextLinkNumber: () => ++numbers,
    connect: (link) => {
      if (options.connectThrows === true) throw new Error('refused by the stub');
      links.push(link);
      return {
        sent: (data) => {
          hooks.push(`sent ${String(link.number)} ${typeof data === 'string' ? data : `bytes ${String(data.length)}`}`);
          return `tag-${String(hooks.length)}`;
        },
        message: (data, tag) => messages.push([link.number, data, tag]),
        received: (data) => hooks.push(`received ${String(link.number)} ${data}`),
        closed: (end) => {
          ends.push([link.number, end]);
          options.onClosed?.(link, end);
        },
      };
    },
    attached: (link) => {
      if (options.answer === undefined) link.accept('wamp.2.json');
      else options.answer(link);
    },
    listenerError: (error) => listenerErrors.push(error),
  };
  const WS = createFakeWebSocket(network, 'owner-tag');
  return {
    WS,
    links,
    messages,
    ends,
    hooks,
    listenerErrors,
    queue,
    /** Run queued deliveries (also the ones they queue) until none is left. */
    flush(): string[] {
      const ran: string[] = [];
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        ran.push(next.what);
        next.fn();
      }
      return ran;
    },
    open(url = 'memory://x'): { ws: FakeSocket; link: FakeLink; events: string[] } {
      const ws = new WS(url, ['wamp.2.json']) as FakeSocket;
      const events = listen(ws);
      const link = links[links.length - 1]!;
      return { ws, link, events };
    },
  };
}

/** Record every event as text. */
function listen(ws: FakeSocket): string[] {
  const events: string[] = [];
  ws.addEventListener('open', () => events.push('open'));
  ws.addEventListener('message', (ev) => events.push(`message ${String(ev.data)}`));
  ws.addEventListener('error', (ev) => events.push(`error ${String((ev as { message?: unknown }).message)}`));
  ws.addEventListener('close', (ev) => events.push(`close ${String(ev.code)} ${ev.reason} ${String(ev.wasClean)}`));
  return events;
}

describe('construction and the WHATWG surface', () => {
  test('CONNECTING, empty protocol, constants, url, binaryType, extensions; numbers per network; owner tag', () => {
    const net = stub({ answer: () => undefined });
    const a = new net.WS('memory://a', 'wamp.2.json') as FakeSocket;
    const b = new net.WS('memory://b') as FakeSocket;
    expect([
      a.readyState,
      a.protocol,
      a.url,
      a.binaryType,
      (a as unknown as { extensions: string }).extensions,
    ]).toEqual([0, '', 'memory://a', 'blob', '']);
    expect([
      net.WS.OPEN,
      (net.WS as unknown as Record<string, number>)['CONNECTING'],
      (a as unknown as Record<string, number>)['CLOSED'],
    ]).toEqual([1, 0, 3]);
    expect([a.controls.number, b.controls.number]).toEqual([1, 2]);
    expect(net.links.map((l) => [l.owner, l.url, l.protocols, l.state])).toEqual([
      ['owner-tag', 'memory://a', ['wamp.2.json'], 'connecting'],
      ['owner-tag', 'memory://b', [], 'connecting'],
    ]);
    expect(net.links[0]!.socket).toBe(a);
    a.binaryType = 'arraybuffer';
    expect(a.binaryType).toBe('arraybuffer');
    a.binaryType = 'nonsense';
    expect(a.binaryType).toBe('arraybuffer');
    expect('terminate' in a).toBe(false);
  });

  test('binaryType switches both ways; removing a listener of a type never listened to is fine', () => {
    const net = stub();
    const ws = new net.WS('memory://x') as FakeSocket;
    ws.binaryType = 'arraybuffer';
    ws.binaryType = 'blob';
    expect(ws.binaryType).toBe('blob');
    expect(() => {
      ws.removeEventListener('close', () => undefined);
    }).not.toThrow();
  });

  test('the event objects of a Node 22 error-only failure and of its re-fired errors', () => {
    const net = stub({
      answer: (l) => {
        l.fail(true, 'refused');
      },
    });
    const ws = new net.WS('memory://x') as FakeSocket;
    const seen: unknown[] = [];
    ws.addEventListener('error', (ev: unknown) => seen.push(ev));
    net.flush();
    ws.close();
    net.flush();
    expect(seen).toEqual([
      { type: 'error', message: 'refused', error: new Error('refused') },
      {
        type: 'error',
        message: 'WebSocket was closed before the connection was established',
        error: new Error('WebSocket was closed before the connection was established'),
      },
    ]);
  });

  test('every event object, as listeners get it (late events included)', () => {
    const net = stub({ delivery: 'sync', answer: () => undefined });
    const ws = new net.WS('memory://x') as FakeSocket;
    const seen: unknown[] = [];
    for (const type of ['open', 'message', 'error', 'close'] as const) {
      ws.addEventListener(type as 'open', (ev: unknown) => seen.push(ev));
    }
    const link = net.links[0]!;
    link.accept('wamp.2.json');
    link.send('[2,1,{}]');
    link.drop();
    for (const type of ['open', 'message', 'error', 'close'] as const) ws.controls.emitLate(type);
    expect(seen).toEqual([
      { type: 'open' },
      { type: 'message', data: '[2,1,{}]' },
      { type: 'error', message: 'WebSocket connection lost', error: new Error('WebSocket connection lost') },
      { type: 'close', code: 1006, reason: '', wasClean: false },
      { type: 'open' },
      { type: 'message', data: '[36,1,1,{}]' },
      { type: 'error', message: 'late error', error: new Error('late error') },
      { type: 'close', code: 1006, reason: 'late close', wasClean: false },
    ]);
  });

  test('protocols other than a string or an array throw SyntaxError; a throwing connect makes the constructor throw', () => {
    const net = stub();
    expect(() => new net.WS('memory://x', 3 as unknown as string)).toThrow(
      expect.objectContaining({ name: 'SyntaxError', message: 'protocols must be a string or an array of strings' }),
    );
    expect(net.links).toHaveLength(0);
    const refusing = stub({ connectThrows: true });
    expect(() => new refusing.WS('memory://x')).toThrow('refused by the stub');
  });

  test('accept ⇒ `open` through the down pipe, with the protocol; a second accept is ignored', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    expect(events).toEqual([]);
    expect(net.flush()).toEqual(['down']);
    expect([ws.readyState, ws.protocol, link.state]).toEqual([1, 'wamp.2.json', 'open']);
    expect(events).toEqual(['open']);
    link.accept('other');
    expect(net.flush()).toEqual([]);
  });

  test('with synchronous delivery the socket is OPEN when the constructor returns (no listener saw `open`)', () => {
    const net = stub({ delivery: 'sync' });
    const { ws, events } = net.open();
    expect(ws.readyState).toBe(1);
    expect(events).toEqual([]);
  });

  test('bufferedAmount follows a number or a script', () => {
    const net = stub();
    const { ws } = net.open();
    expect(ws.bufferedAmount).toBe(0);
    ws.controls.setBufferedAmount(42);
    expect(ws.bufferedAmount).toBe(42);
    let n = 0;
    ws.controls.setBufferedAmount(() => ++n);
    expect([ws.bufferedAmount, ws.bufferedAmount]).toEqual([1, 2]);
  });
});

describe('send', () => {
  test('throws InvalidStateError while CONNECTING; while CLOSING/CLOSED the data is discarded', () => {
    const net = stub();
    const { ws } = net.open();
    expect(() => {
      ws.send('x');
    }).toThrow(expect.objectContaining({ name: 'InvalidStateError', message: 'The WebSocket is still CONNECTING' }));
    net.flush();
    ws.close(1000);
    ws.send('discarded');
    net.flush();
    ws.send('discarded too');
    expect(ws.readyState).toBe(3);
    expect(net.hooks.filter((h) => h.startsWith('sent'))).toEqual([]);
  });

  test('OPEN: `sent` sees it first, the router gets it with its tag, in order; binary data is copied', () => {
    const net = stub();
    const { ws } = net.open();
    net.flush();
    const bytes = new Uint8Array([1, 2, 3]);
    ws.send('one');
    ws.send(bytes);
    ws.send(new Uint8Array([9, 9]).buffer as unknown as string);
    ws.send(new DataView(new Uint8Array([7, 7, 7, 7]).buffer, 1, 2) as unknown as string);
    ws.send(42 as unknown as string);
    bytes[0] = 99;
    const buffer = new Uint8Array([5, 6]).buffer;
    ws.send(buffer as unknown as string);
    new Uint8Array(buffer)[0] = 0; // the caller reuses its buffer: what was sent must not change
    expect(net.messages).toEqual([]);
    net.flush();
    expect(net.messages.map(([n, data, tag]) => [n, typeof data === 'string' ? data : [...data], tag])).toEqual([
      [1, 'one', 'tag-1'],
      [1, [1, 2, 3], 'tag-2'],
      [1, [9, 9], 'tag-3'],
      [1, [7, 7], 'tag-4'],
      [1, '42', 'tag-5'],
      [1, [5, 6], 'tag-6'],
    ]);
  });

  test('router → client frames are dispatched in order, `received` first; ignored before the router end is open', () => {
    const net = stub({ answer: () => undefined });
    const { ws, link, events } = net.open();
    link.send('too early');
    link.accept('wamp.2.json');
    link.send('a');
    link.send('b');
    net.flush();
    expect(events).toEqual(['open', 'message a', 'message b']);
    expect(net.hooks).toEqual(['received 1 a', 'received 1 b']);
    expect(ws.readyState).toBe(1);
  });
});

describe('listeners (EventTarget semantics)', () => {
  test('deduplicated, `this` is the socket, removal during a dispatch skips, throws are reported and isolated', () => {
    const net = stub();
    const { ws, link } = net.open();
    const seen: string[] = [];
    let self: unknown;
    const twice = function (this: unknown): void {
      self = this; // eslint-disable-line @typescript-eslint/no-this-alias -- the point: listeners run with the socket as `this`
      seen.push('twice');
    };
    const removed = (): void => {
      seen.push('removed');
    };
    ws.addEventListener('message', () => {
      seen.push('first');
      ws.removeEventListener('message', removed);
      throw new Error('listener bug');
    });
    ws.addEventListener('message', twice);
    ws.addEventListener('message', twice);
    ws.addEventListener('message', removed);
    ws.addEventListener('message', 'not a function' as unknown as () => void);
    ws.removeEventListener('open', removed); // never added: fine
    net.flush();
    link.send('x');
    net.flush();
    expect(seen).toEqual(['first', 'twice']);
    expect(self).toBe(ws);
    expect(net.listenerErrors.map(String)).toEqual(['Error: listener bug']);
  });

  test('listenerCount leaves out the adapter’s permanent error guard', () => {
    const net = stub();
    const { ws } = net.open(); // `listen` added one of each
    expect(ws.controls.listenerCount).toBe(4);
    ws.addEventListener('error', socketErrorGuard);
    expect([ws.controls.listenerCount, ws.controls.hasErrorGuard]).toEqual([4, true]);
    expect(ws.controls.listeners).toEqual({ open: 1, message: 1, error: 1, close: 1 });
    const fresh = new net.WS('memory://y') as FakeSocket;
    expect([fresh.controls.listenerCount, fresh.controls.hasErrorGuard]).toEqual([0, false]);
    expect(fresh.controls.listeners).toEqual({ open: 0, message: 0, error: 0, close: 0 });
  });

  test('emitLate fires at every listener ever added, removed ones included; nothing for a type never listened to', () => {
    const net = stub();
    const ws = new net.WS('memory://x') as FakeSocket;
    const seen: string[] = [];
    const onMessage = (ev: { readonly data: unknown }): void => {
      seen.push(`message ${String(ev.data)}`);
    };
    const onClose = (ev: { readonly code: number }): void => {
      seen.push(`close ${String(ev.code)}`);
    };
    const onError = (ev: unknown): void => {
      seen.push(`error ${(ev as { message: string }).message}`);
    };
    const onOpen = (): void => {
      seen.push('open');
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.controls.emitLate('message');
    ws.controls.emitLate('close');
    ws.controls.emitLate('error');
    ws.controls.emitLate('open'); // nobody ever listened
    ws.addEventListener('open', onOpen);
    ws.controls.emitLate('open');
    expect(seen).toEqual(['message [36,1,1,{}]', 'close 1006', 'error late error', 'open']);
  });
});

describe('close() by the client', () => {
  test('WHATWG argument checks: 1000 or 3000–4999, reason ≤ 123 UTF-8 bytes; every call is recorded', () => {
    const net = stub();
    const { ws } = net.open();
    net.flush();
    const bad = [999, 1001, 2999, 5000, 1000.5, NaN, '1000'];
    for (const code of bad) {
      expect(() => {
        ws.close(code as number);
      }).toThrow(
        expect.objectContaining({
          name: 'InvalidAccessError',
          message: 'The close code must be 1000 or an integer from 3000 to 4999',
        }),
      );
    }
    expect(() => {
      ws.close(1000, 'é'.repeat(62)); // 124 bytes
    }).toThrow(
      expect.objectContaining({ name: 'SyntaxError', message: 'The close reason must be at most 123 UTF-8 bytes' }),
    );
    expect(() => {
      ws.close(1000, '😀'.repeat(31)); // 124 bytes
    }).toThrow(expect.objectContaining({ name: 'SyntaxError' }));
    expect(() => {
      ws.close(1000, `${'\ud800'.repeat(41)}x`); // lone surrogates: 3 bytes each ⇒ 124
    }).toThrow(expect.objectContaining({ name: 'SyntaxError' }));
    expect(ws.readyState).toBe(1);
    ws.close(4999, `${'€'.repeat(40)}abc`); // 123 bytes
    expect(ws.controls.closeCalls).toHaveLength(bad.length + 4);
    expect(ws.controls.closeCalls[bad.length + 3]).toEqual({ code: 4999, reason: `${'€'.repeat(40)}abc` });
    for (const code of [3000, 1000, undefined]) {
      const other = net.open().ws;
      net.flush();
      expect(() => {
        other.close(code);
      }).not.toThrow();
    }
  });

  test.each([
    ['U+007F (1 byte)', '\x7f'.repeat(123), '\x7f'.repeat(124)],
    ['U+0080 (2 bytes)', `${'\x80'.repeat(61)}a`, '\x80'.repeat(62)],
    ['U+07FF (2 bytes)', `${'\u07ff'.repeat(61)}a`, '\u07ff'.repeat(62)],
    ['U+0800 (3 bytes)', '\u0800'.repeat(41), `${'\u0800'.repeat(41)}a`],
    ['U+FFFF (3 bytes)', '\uffff'.repeat(41), `${'\uffff'.repeat(41)}a`],
    ['a surrogate pair (4 bytes)', `${'😀'.repeat(30)}abc`, `${'😀'.repeat(30)}abcd`],
    ['a high surrogate at the end (3 bytes)', `${'a'.repeat(120)}\ud83d`, `${'a'.repeat(121)}\ud83d`],
    ['a high surrogate before a non-low (3 + 1)', `${'\ud83da'.repeat(30)}abc`, `${'\ud83da'.repeat(30)}abcd`],
    ['a lone low surrogate (3 bytes)', '\udc00'.repeat(41), `${'\udc00'.repeat(41)}a`],
    [
      'U+DBFF U+DC00 (a pair at the range edges)',
      `${'\udbff\udc00'.repeat(30)}abc`,
      `${'\udbff\udc00'.repeat(30)}abcd`,
    ],
  ])('the 123-byte limit counts UTF-8 exactly: %s', (_name, fits, tooLong) => {
    const net = stub();
    const a = net.open().ws;
    const b = net.open().ws;
    net.flush();
    expect(() => {
      a.close(1000, fits);
    }).not.toThrow();
    expect(() => {
      b.close(1000, tooLong);
    }).toThrow(expect.objectContaining({ name: 'SyntaxError' }));
  });

  test('a reason that is not a string is not length-checked (WHATWG would stringify it)', () => {
    const net = stub();
    const { ws } = net.open();
    net.flush();
    expect(() => {
      ws.close(1000, { length: 999 } as unknown as string);
    }).not.toThrow();
  });

  test('OPEN: CLOSING, the close frame reaches the router (client end), the echo closes the socket cleanly', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    ws.close(4001, 'timeout');
    expect(ws.readyState).toBe(2);
    ws.close(1000); // no-op while CLOSING
    expect(net.ends).toEqual([]);
    net.flush();
    expect(net.ends).toEqual([[1, { initiator: 'client', code: 4001, reason: 'timeout' }]]);
    expect(link.state).toBe('closed');
    expect(events).toEqual(['open', 'close 4001 timeout true']);
    expect(ws.readyState).toBe(3);
    ws.close(1000); // CLOSED: nothing happens
    net.flush();
    expect([ws.readyState, events.length, net.ends.length]).toEqual([3, 2, 1]);
  });

  test('without a code the close frame carries 1005', () => {
    const net = stub();
    const { ws, events } = net.open();
    net.flush();
    ws.close();
    net.flush();
    expect(net.ends[0]![1]).toEqual({ initiator: 'client', code: 1005, reason: '' });
    expect(events).toEqual(['open', 'close 1005  true']);
  });

  test('CONNECTING: the router sees the client gone; `error` + `close` 1006 follow (queued), never `open`', () => {
    const net = stub();
    const { ws, events } = net.open();
    ws.close(4001);
    expect(ws.readyState).toBe(2);
    expect(events).toEqual([]);
    net.flush();
    expect(events).toEqual(['error WebSocket was closed before the connection was established', 'close 1006  false']);
    expect(net.ends).toEqual([[1, { initiator: 'gone', code: 1006, reason: '' }]]);
  });

  test("CONNECTING with closeEvents: 'sync' (undici): `error` + `close` dispatched inside close()", () => {
    const net = stub({ closeEvents: 'sync' });
    const { ws, events } = net.open();
    let inside = true;
    ws.addEventListener('close', () => {
      events.push(`inside close(): ${String(inside)}`);
    });
    ws.close();
    inside = false;
    expect(events).toEqual([
      'error WebSocket was closed before the connection was established',
      'close 1006  false',
      'inside close(): true',
    ]);
    expect(ws.readyState).toBe(3);
  });

  test('a router close frame racing the client’s close wins with its own code', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    link.close(1001, 'going away');
    ws.close(1000);
    net.flush();
    expect(events).toEqual(['open', 'close 1001 going away true']);
    expect(net.ends).toEqual([[1, { initiator: 'router', code: 1001, reason: 'going away' }]]);
  });
});

describe('router-side ends', () => {
  test('close(code, reason): pending frames first, then the close event (clean)', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    link.send('last words');
    link.close(4000, 'bye');
    expect(link.state).toBe('closed');
    expect(net.ends).toEqual([[1, { initiator: 'router', code: 4000, reason: 'bye' }]]);
    link.send('after close: dropped');
    net.flush();
    expect(events).toEqual(['open', 'message last words', 'close 4000 bye true']);
    expect(ws.readyState).toBe(3);
    link.close(1000, ''); // already closed
    expect(net.ends).toHaveLength(1);
  });

  test('closingWindow(ms): CLOSING for ms (writes discarded), then `close`', () => {
    const net = stub();
    const { ws, events } = net.open();
    net.flush();
    ws.controls.closingWindow(250, 4000, 'later');
    expect(net.flush()).toEqual(['down', 'after 250']);
    expect(events).toEqual(['open', 'close 4000 later true']);
    const second = net.open();
    net.flush();
    second.ws.controls.closingWindow(100);
    const ran = [net.queue.shift()!];
    ran[0]!.fn(); // the close frame arrived; the window is running
    expect(second.ws.readyState).toBe(2);
    second.ws.send('refused by readyState');
    expect(net.hooks.some((h) => h.includes('refused'))).toBe(false);
    net.flush();
    expect(second.events).toEqual(['open', 'close 1000  true']);
    expect(() => {
      second.ws.controls.closingWindow(-1);
    }).toThrow(new RangeError('closingWindow(ms) needs a finite ms ≥ 0'));
    expect(() => {
      second.ws.controls.closingWindow(Infinity);
    }).toThrow(RangeError);
  });

  test('a zero window closes at once; controls.close defaults to 1000', () => {
    const net = stub();
    const { ws, events } = net.open();
    net.flush();
    ws.controls.closingWindow(0);
    expect(net.flush()).toEqual(['down']);
    const other = net.open();
    net.flush();
    other.ws.controls.close();
    net.flush();
    expect([events, other.events]).toEqual([
      ['open', 'close 1000  true'],
      ['open', 'close 1000  true'],
    ]);
  });

  test('drop(): undelivered frames are lost both ways, the router end ends at once, `error` + `close` 1006', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    ws.send('lost up');
    link.send('lost down');
    ws.controls.drop();
    expect(link.state).toBe('closed');
    expect(net.ends).toEqual([[1, { initiator: 'router', code: 1006, reason: '' }]]);
    net.flush();
    expect(net.messages).toEqual([]);
    expect(events).toEqual(['open', 'error WebSocket connection lost', 'close 1006  false']);
    ws.controls.drop(); // already gone
    expect(net.ends).toHaveLength(1);
  });

  test('drop(code) with another code is a clean close without error; wasClean can be forced', () => {
    const net = stub();
    const a = net.open();
    const b = net.open();
    net.flush();
    a.link.drop(1011);
    b.link.drop(1000, false);
    net.flush();
    expect(a.events).toEqual(['open', 'close 1011  true']);
    expect(b.events).toEqual(['open', 'error WebSocket connection lost', 'close 1000  false']);
  });

  test('a drop before the client saw `open` is a failed connect; so is a close of an unanswered link', () => {
    const net = stub({ answer: () => undefined });
    const a = net.open();
    a.link.accept('wamp.2.json');
    a.link.drop(); // the open item is discarded with everything else
    const b = net.open();
    b.link.close(1000, ''); // never accepted: a refusal
    net.flush();
    expect(a.events).toEqual(['error Received network error or non-101 status code.', 'close 1006  false']);
    expect(b.events).toEqual(['error Received network error or non-101 status code.', 'close 1006  false']);
    expect(net.ends.map(([, e]) => e.initiator)).toEqual(['router', 'router']);
  });

  test('fail(): `error` + `close` 1006 before open; fail(errorOnly) is Node 22: `error` only, readyState stays CONNECTING', () => {
    const net = stub({
      answer: (l) => {
        if (l.url.endsWith('only')) l.fail(true);
        else l.fail(false, 'Server sent no subprotocol');
      },
    });
    const a = net.open('memory://a');
    const b = net.open('memory://only');
    net.flush();
    expect(a.events).toEqual(['error Server sent no subprotocol', 'close 1006  false']);
    expect(b.events).toEqual(['error Received network error or non-101 status code.']);
    expect([a.ws.readyState, b.ws.readyState]).toEqual([3, 0]);
    // Node 22 re-fires `error` on every close() after such a failure, and nothing else ever arrives
    b.ws.close();
    b.ws.close(4001);
    b.link.fail(); // the router end is closed already: ignored
    net.flush();
    expect(net.ends).toEqual([
      [1, { initiator: 'router', code: 1006, reason: '' }],
      [2, { initiator: 'router', code: 1006, reason: '' }],
    ]);
    expect(b.events).toEqual([
      'error Received network error or non-101 status code.',
      'error WebSocket was closed before the connection was established',
      'error WebSocket was closed before the connection was established',
    ]);
    expect(b.ws.readyState).toBe(0);
  });

  test('frames the client wrote after the router end closed never reach it', () => {
    const net = stub();
    const { ws, link } = net.open();
    net.flush();
    link.close(1000, '');
    ws.send('in flight'); // the client does not know yet
    net.flush();
    expect(net.messages).toEqual([]);
  });

  test('once the router end is closed nothing it sends reaches the client, also not from its `closed` handler', () => {
    for (const end of ['drop', 'close', 'closingWindow', 'client close'] as const) {
      const net = stub({
        onClosed: (l) => {
          l.send('from inside closed');
        },
      });
      const { ws, link, events } = net.open();
      net.flush();
      if (end === 'drop') link.drop();
      else if (end === 'close') link.close(1000, '');
      else if (end === 'closingWindow') ws.controls.closingWindow(5);
      else ws.close(1000);
      link.send('after the end');
      net.flush();
      expect([end, events.filter((e) => e.startsWith('message'))]).toEqual([end, []]);
      expect(net.hooks.filter((h) => h.startsWith('received'))).toEqual([]);
      expect(ws.readyState).toBe(3);
    }
  });

  test('a `message` that arrives while the socket is CLOSING is not dispatched', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    link.send('racing the close');
    ws.close(1000);
    net.flush();
    expect(events).toEqual(['open', 'close 1000  true']);
    expect(net.hooks.filter((h) => h.startsWith('received'))).toEqual([]);
  });

  test('an `open` that arrives after the client gave up is not dispatched', () => {
    const net = stub();
    const { ws, events } = net.open();
    ws.close();
    net.flush();
    expect(events).toEqual(['error WebSocket was closed before the connection was established', 'close 1006  false']);
    expect(ws.protocol).toBe('');
  });
});

describe('freeze / thaw', () => {
  test("'drop': a half-open link — frames and close frames are lost both ways, a thaw does not bring them back", () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    ws.controls.freeze('drop');
    expect(ws.controls.frozen).toBe('drop');
    ws.send('lost');
    link.send('lost too');
    ws.close(1000);
    net.flush();
    expect([net.messages, net.ends, events]).toEqual([[], [], ['open']]);
    expect(ws.readyState).toBe(2); // the client waits for an echo that never comes (the undici frozen peer)
    ws.controls.thaw();
    net.flush();
    expect([net.messages, net.ends]).toEqual([[], []]);
  });

  test("'buffer': frames are held and delivered in order on thaw, before frames sent later", () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    link.send('before');
    ws.controls.freeze('buffer');
    net.flush(); // 'before' arrives during the freeze: held
    link.send('during');
    net.flush();
    expect(events).toEqual(['open']);
    ws.controls.thaw();
    expect(events).toEqual(['open', 'message before', 'message during']);
    link.send('after');
    net.flush();
    expect(events).toEqual(['open', 'message before', 'message during', 'message after']);
    expect(ws.controls.frozen).toBeUndefined();
  });

  test('an item that arrives early never overtakes one held before it (per-pipe FIFO)', () => {
    const net = stub();
    const { ws, link, events } = net.open();
    net.flush();
    link.send('one');
    link.send('two');
    ws.controls.freeze('buffer');
    net.queue.shift()!.fn(); // 'one' arrives while frozen
    ws.controls.thaw(); // 'one' is delivered; 'two' has not arrived yet
    expect(events).toEqual(['open', 'message one']);
    net.flush();
    expect(events).toEqual(['open', 'message one', 'message two']);
  });

  test('freeze rejects unknown modes', () => {
    const net = stub();
    const { ws } = net.open();
    expect(() => {
      ws.controls.freeze('pause' as 'drop');
    }).toThrow(new TypeError("freeze mode must be 'drop' or 'buffer'"));
  });
});

describe('a pipe never dispatches re-entrantly', () => {
  test('a frame the router sends from inside a dispatch (sync delivery) is dispatched after the current one', () => {
    const net = stub({ delivery: 'sync' });
    const { ws, link } = net.open();
    const order: string[] = [];
    ws.addEventListener('message', (ev) => {
      order.push(`start ${String(ev.data)}`);
      if (ev.data === 'first') link.send('second');
      order.push(`end ${String(ev.data)}`);
    });
    link.send('first');
    expect(order).toEqual(['start first', 'end first', 'start second', 'end second']);
  });
});

describe('terminate (the ws package)', () => {
  test('present only when the network asks for it', () => {
    expect('terminate' in (new (stub({ terminate: true }).WS)('memory://x') as object)).toBe(true);
    expect('terminate' in (new (stub().WS)('memory://x') as object)).toBe(false);
  });

  test('OPEN: destroyed at once — `close` 1006 unclean, the router sees the client gone, nothing more arrives', () => {
    const net = stub({ terminate: true });
    const { ws, link, events } = net.open();
    net.flush();
    link.send('never seen');
    ws.terminate!();
    ws.terminate!();
    expect(ws.readyState).toBe(2);
    net.flush();
    expect(events).toEqual(['open', 'close 1006  false']);
    expect(net.ends).toEqual([[1, { initiator: 'gone', code: 1006, reason: '' }]]);
    expect(ws.controls.terminateCalls).toBe(2);
    ws.terminate!(); // CLOSED: counted, nothing else
    expect(ws.controls.terminateCalls).toBe(3);
  });

  test('CONNECTING: `error` + `close` 1006; also behind a client close frame stuck in a frozen link', () => {
    const net = stub({ terminate: true });
    const a = net.open();
    a.ws.terminate!();
    net.flush();
    expect(a.events).toEqual(['error WebSocket was closed before the connection was established', 'close 1006  false']);
    const b = net.open();
    net.flush();
    b.ws.controls.freeze('buffer');
    b.ws.close(1000);
    b.ws.terminate!();
    net.flush();
    expect(b.events).toEqual(['open', 'close 1006  false']);
    expect(net.ends.filter(([n]) => n === b.link.number)).toEqual([]);
    b.ws.controls.thaw(); // the close frame, then the loss reach the router end, in order
    expect(net.ends.filter(([n]) => n === b.link.number)).toEqual([
      [b.link.number, { initiator: 'client', code: 1000, reason: '' }],
    ]);
  });

  test('after CLOSED terminate changes nothing (no event, readyState stays CLOSED)', () => {
    const net = stub({ terminate: true });
    const { ws, events } = net.open();
    net.flush();
    ws.close(1000);
    net.flush();
    ws.terminate!();
    net.flush();
    expect([ws.readyState, events]).toEqual([3, ['open', 'close 1000  true']]);
  });

  test('a router drop that arrives between terminate() and its own close event is ignored (the socket is destroyed)', () => {
    const net = stub({ terminate: true });
    const { ws, link, events } = net.open();
    net.flush();
    link.drop(); // its item is queued first
    ws.terminate!(); // its local close event is queued behind it
    net.flush();
    expect(events).toEqual(['open', 'close 1006  false']); // no `error`: the drop never reached the socket
  });

  test('a router close frame that arrives after the client gave up on the connect is ignored', () => {
    const net = stub();
    const { ws, link, events } = net.open(); // accepted: the open item is on its way
    ws.close(); // CLOSING; the local error/close are queued
    link.close(1000, ''); // the router closes before it hears of the client
    net.flush();
    expect(events).toEqual(['error WebSocket was closed before the connection was established', 'close 1006  false']);
  });

  test('terminate during a closing window: exactly one `close`, from whichever end comes first', () => {
    const net = stub({ terminate: true });
    const { ws, events } = net.open();
    net.flush();
    ws.controls.closingWindow(50, 4000);
    net.queue.shift()!.fn(); // CLOSING now; the window's end is queued
    ws.terminate!(); // its own close event is queued behind the window's end
    net.flush();
    expect(events).toEqual(['open', 'close 4000  true']);
  });

  test('after a Node 22 error-only failure terminate does nothing', () => {
    const net = stub({
      terminate: true,
      answer: (l) => {
        l.fail(true);
      },
    });
    const { ws, events } = net.open();
    net.flush();
    ws.terminate!();
    net.flush();
    expect(events).toEqual(['error Received network error or non-101 status code.']);
  });
});

describe('with the real adapter on top', () => {
  function sink() {
    const log: string[] = [];
    return {
      log,
      sink: {
        open: (p: string) => log.push(`open ${p}`),
        message: (d: unknown) => log.push(`message ${String(d)}`),
        closed: (code: number, reason: string, wasClean: boolean) =>
          log.push(`closed ${String(code)} ${reason} ${String(wasClean)}`),
      },
    };
  }

  test('open, messages, a send refused during a closing window (reported once), and only the guard left', () => {
    const net = stub();
    const s = sink();
    const transport = openWebSocket(net.WS, 'memory://x', ['wamp.2.json'], s.sink);
    const link = net.links[0]!;
    const ws = link.socket;
    expect(ws.controls.listenerCount).toBe(4);
    net.flush();
    link.send('[2,1,{}]');
    net.flush();
    expect(transport.send('[1]')).toBe(true);
    net.flush();
    expect(net.messages.map(([, d]) => d)).toEqual(['[1]']);
    ws.controls.closingWindow(100);
    net.queue.shift()!.fn(); // the close frame arrives: CLOSING
    expect(transport.send('refused')).toBe(false);
    expect(transport.send('again')).toBe(false);
    net.flush();
    expect(s.log).toEqual(['open wamp.2.json', 'message [2,1,{}]', `closed 1006 ${SEND_REFUSED} false`]);
    expect([ws.controls.listenerCount, ws.controls.hasErrorGuard]).toEqual([0, true]);
    // late events on the released socket reach the adapter's removed listeners, which ignore them
    for (const event of ['open', 'message', 'error', 'close'] as const) ws.controls.emitLate(event);
    expect(s.log).toHaveLength(3);
  });

  test('release while CONNECTING (connect timeout) with undici-style sync close events: nothing reported, no listener', () => {
    const net = stub({ closeEvents: 'sync', answer: () => undefined });
    const s = sink();
    const transport = openWebSocket(net.WS, 'memory://x', ['wamp.2.json'], s.sink);
    transport.close(4001, 'connect timeout');
    expect(s.log).toEqual([]);
    const ws = net.links[0]!.socket;
    expect(ws.controls.closeCalls).toEqual([{ code: 4001, reason: 'connect timeout' }]);
    expect([ws.readyState, ws.controls.listenerCount, ws.controls.hasErrorGuard]).toEqual([3, 0, true]);
  });

  test('a router drop is one `closed` with 1006', () => {
    const net = stub();
    const s = sink();
    openWebSocket(net.WS, 'memory://x', ['wamp.2.json'], s.sink);
    net.flush();
    net.links[0]!.drop();
    net.flush();
    expect(s.log).toEqual(['open wamp.2.json', 'closed 1006 WebSocket connection lost false']);
  });
});

describe('utf8Length (the 16 MiB rules of the router and the oracle)', () => {
  test('property: the length TextEncoder gives, for any UTF-16 text (lone surrogates are U+FFFD, 3 bytes)', () => {
    const encoder = new TextEncoder();
    const unit = fc.oneof(
      fc.integer({ min: 0, max: 0x7f }),
      fc.integer({ min: 0x80, max: 0x7ff }),
      fc.integer({ min: 0x800, max: 0xffff }), // lone and paired surrogates included
    );
    fc.assert(
      fc.property(fc.array(unit, { maxLength: 40 }), (units) => {
        const text = String.fromCharCode(...units);
        expect(utf8Length(text)).toBe(encoder.encode(text).length);
      }),
    );
  });

  test('ASCII is one byte each; a pair is four bytes, a lone surrogate at the end three', () => {
    expect([utf8Length(''), utf8Length('abc'), utf8Length('\u{1F600}'), utf8Length('a\ud83d')]).toEqual([0, 3, 4, 4]);
    expect(utf8Length('\u007f\u0080')).toBe(3);
  });
});
