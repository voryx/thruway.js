// A scriptable fake WebSocket for the adapter's unit tests (websocket-adapter.test.ts, websocket-contract.test.ts).
// Unlike the testing kit's router-bound socket (src/testing/socket.ts) it never does anything by itself: the test
// drives every event, and the options reproduce how real implementations differ (measured on Node
// 22.13/22.23/24.22/26.3 with undici and `ws` 8.22):
// - `dispatch: 'emitter'` is the `ws` package: an `error` event with no listener throws (an uncaught exception in
//   Node); `'event-target'` is browsers, undici and React Native;
// - `send` follows WHATWG (throws in CONNECTING, discards in CLOSING/CLOSED and grows bufferedAmount) unless told to
//   throw;
// - `close` validates like WHATWG (code 1000 or 3000–4999, reason ≤ 123 UTF-8 bytes) unless told otherwise;
// - optional members (`terminate`, `bufferedAmount`, static `OPEN`) can be absent, throwing or odd.
import type { WebSocketConstructorLike, WebSocketLike } from '../../src/types.js';

export type EventType = 'open' | 'message' | 'error' | 'close';
type Listener = (ev: unknown) => void;

export interface ScriptOptions {
  readonly dispatch?: 'event-target' | 'emitter';
  readonly removeEventListener?: 'works' | 'noop' | 'throws';
  /** `addEventListener` throws for this event type (or for every type with `true`). */
  readonly addEventListenerThrows?: boolean | EventType;
  readonly binaryTypeThrows?: boolean;
  readonly terminate?: 'absent' | 'works' | 'throws';
  readonly bufferedAmount?: 'number' | 'absent' | 'throws' | 'nan' | 'infinity' | 'negative' | 'string';
  /** `'throws'`: `send` always throws; `'whatwg'`: see the file comment. */
  readonly send?: 'whatwg' | 'throws';
  /** Which `close` call shapes work: `'whatwg'` validates, `'code-only'` throws when given a reason, `'no-args'` throws
   *  when given any argument, `'throws'` always throws. */
  readonly close?: 'whatwg' | 'code-only' | 'no-args' | 'throws';
  /** A synchronous transport: OPEN, and `open` dispatched, inside the constructor (before any listener exists). */
  readonly openOnConstruct?: boolean;
  /** A synchronous loopback: `send` dispatches the frame back as a message before it returns. */
  readonly echo?: boolean;
  /** `close` dispatches the close event (1000, clean) before it returns. */
  readonly syncClose?: boolean;
  /** The constructor throws this value. */
  readonly ctorThrows?: unknown;
  /** The constructor's static `OPEN` (default 1); `'absent'` leaves it out (a plain-JavaScript custom transport). */
  readonly staticOpen?: number | 'absent';
  /** `readyState` is a getter that throws once the socket is OPEN. */
  readonly readyStateThrows?: boolean;
}

export class ScriptedSocket implements WebSocketLike {
  readonly url: string;
  readonly protocols: unknown;
  readyState = 0;
  protocol = '';
  binaryTypeValue = 'blob';
  amount = 0;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closeCalls: unknown[][] = [];
  terminateCalls = 0;
  /** Every listener ever added, including those removed since (to check identity). */
  readonly added: { type: string; listener: Listener }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  declare terminate?: () => void;
  declare readonly bufferedAmount?: number;

  constructor(
    url: string,
    protocols: unknown,
    private readonly options: ScriptOptions,
  ) {
    this.url = url;
    this.protocols = protocols;
    const buffered = options.bufferedAmount ?? 'number';
    if (buffered !== 'absent') {
      Object.defineProperty(this, 'bufferedAmount', {
        get: () => {
          if (buffered === 'throws') throw new Error('bufferedAmount getter throws');
          if (buffered === 'nan') return NaN;
          if (buffered === 'infinity') return Infinity;
          if (buffered === 'negative') return -5;
          if (buffered === 'string') return '42';
          return this.amount;
        },
      });
    }
    const terminate = options.terminate ?? 'absent';
    if (terminate !== 'absent') {
      this.terminate = () => {
        this.terminateCalls++;
        if (terminate === 'throws') throw new Error('terminate throws');
        this.readyState = 3;
      };
    }
    if (options.readyStateThrows) {
      let state = 0;
      Object.defineProperty(this, 'readyState', {
        get: () => {
          if (state === 1) throw new Error('readyState getter throws');
          return state;
        },
        set: (v: number) => {
          state = v;
        },
      });
    }
    if (options.openOnConstruct) this.acceptOpen();
  }

  get binaryType(): string {
    return this.binaryTypeValue;
  }
  set binaryType(value: string) {
    if (this.options.binaryTypeThrows) throw new TypeError('binaryType is read-only here');
    this.binaryTypeValue = value;
  }

  // --- WebSocketLike ---------------------------------------------------------------------------------------------

  send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void {
    if (this.options.send === 'throws') throw new Error('send throws');
    if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
    if (this.readyState !== (typeof this.options.staticOpen === 'number' ? this.options.staticOpen : 1)) {
      this.amount += typeof data === 'string' ? data.length : data.byteLength;
      return;
    }
    this.sent.push(data);
    if (this.options.echo) this.receive(data);
  }

  close(...args: unknown[]): void {
    this.closeCalls.push(args);
    const mode = this.options.close ?? 'whatwg';
    if (mode === 'throws') throw new Error('close throws');
    if (mode === 'no-args' && args.length > 0) throw new TypeError('close takes no arguments here');
    if (mode === 'code-only' && args.length > 1) throw new TypeError('close takes no reason here');
    const [code, reason] = args;
    if (code !== undefined && code !== 1000 && !(typeof code === 'number' && code >= 3000 && code <= 4999)) {
      throw new DOMException('invalid code', 'InvalidAccessError');
    }
    if (typeof reason === 'string' && new TextEncoder().encode(reason).length > 123) {
      throw new DOMException('reason too long', 'SyntaxError');
    }
    if (this.readyState === 2 || this.readyState === 3) return;
    this.readyState = 2;
    if (this.options.syncClose) this.closeFromPeer(typeof code === 'number' ? code : 1005, '', true);
  }

  addEventListener(type: string, listener: (ev: never) => void): void {
    const thrower = this.options.addEventListenerThrows;
    if (thrower === true || thrower === type) throw new Error(`addEventListener(${type}) throws`);
    const fn = listener as Listener;
    this.added.push({ type, listener: fn });
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, listener: (ev: never) => void): void {
    const mode = this.options.removeEventListener ?? 'works';
    if (mode === 'throws') throw new Error(`removeEventListener(${type}) throws`);
    if (mode === 'noop') return;
    this.listeners.get(type)?.delete(listener as Listener);
  }

  // --- test controls ---------------------------------------------------------------------------------------------

  /** Dispatch `ev` to the current listeners whatever the state (also "late" events after release). In emitter mode
   *  an `error` without listeners throws, as Node's EventEmitter does. */
  emit(type: EventType, ev: unknown): void {
    const set = this.listeners.get(type);
    if (this.options.dispatch === 'emitter' && type === 'error' && (!set || set.size === 0)) {
      throw new Error('Unhandled error event (EventEmitter without an error listener)');
    }
    for (const listener of [...(set ?? [])]) listener(ev);
  }
  acceptOpen(protocol = 'wamp.2.json'): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.emit('open', { type: 'open' });
  }
  receive(data: unknown): void {
    this.emit('message', { type: 'message', data });
  }
  fail(ev: unknown = { type: 'error' }, readyState = 3): void {
    this.readyState = readyState;
    this.emit('error', ev);
  }
  closeFromPeer(code: number, reason: string, wasClean?: boolean): void {
    this.readyState = 3;
    this.emit(
      'close',
      wasClean === undefined ? { type: 'close', code, reason } : { type: 'close', code, reason, wasClean },
    );
  }
  /** The router's close frame arrived: CLOSING until the close event. */
  startClosing(): void {
    this.readyState = 2;
  }
  listenerCount(type?: EventType): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  /** The listeners that are still attached, by type. */
  attached(type: EventType): Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }
}

export interface ScriptedFactory {
  readonly Ctor: WebSocketConstructorLike;
  readonly sockets: ScriptedSocket[];
  /** The most recently constructed socket. */
  last(): ScriptedSocket;
}

export function scriptedWebSocket(options: ScriptOptions = {}): ScriptedFactory {
  const sockets: ScriptedSocket[] = [];
  const Ctor = class extends ScriptedSocket {
    constructor(url: string, protocols?: string | string[]) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a transport constructor may throw anything
      if (options.ctorThrows !== undefined) throw options.ctorThrows;
      super(url, protocols, options);
      sockets.push(this);
    }
  };
  if (options.staticOpen !== 'absent') Object.defineProperty(Ctor, 'OPEN', { value: options.staticOpen ?? 1 });
  return {
    Ctor: Ctor as unknown as WebSocketConstructorLike,
    sockets,
    last() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('no socket constructed');
      return socket;
    },
  };
}

/** A recording TransportSink: every call in order, as `[kind, ...args]`. */
export interface RecordingSink {
  readonly calls: unknown[][];
  open(protocol: string): void;
  message(data: unknown): void;
  closed(code: number, reason: string, wasClean: boolean, error?: unknown): void;
  /** The calls of one kind (args only). */
  of(kind: 'open' | 'message' | 'closed'): unknown[][];
}

export function recordingSink(onCall?: (call: unknown[]) => void): RecordingSink {
  const calls: unknown[][] = [];
  const record = (call: unknown[]): void => {
    calls.push(call);
    onCall?.(call);
  };
  return {
    calls,
    open: (protocol) => {
      record(['open', protocol]);
    },
    message: (data) => {
      record(['message', data]);
    },
    closed: (...args) => {
      record(['closed', ...args]);
    },
    of: (kind) => calls.filter((c) => c[0] === kind).map((c) => c.slice(1)),
  };
}
