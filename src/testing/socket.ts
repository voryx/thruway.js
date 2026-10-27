/**
 * Internal: the fake WebSocket of the testing kit. `createFakeWebSocket(network)` returns a `WebSocketConstructorLike`
 * whose sockets are the client ends of in-memory connections ("links"); the router owns the other end.
 *
 * The client end follows WHATWG: `readyState` CONNECTING → OPEN → CLOSING → CLOSED; `send` throws while CONNECTING
 * and discards data while CLOSING/CLOSED; `close(code, reason)` validates like WHATWG (1000 or 3000–4999, reason ≤ 123
 * UTF-8 bytes); events are dispatched EventTarget-style (deduplicated listeners, a snapshot per dispatch, a listener
 * removed during a dispatch is skipped, a throwing listener is reported to the network and never stops the others).
 * Unclean ends fire `error` before `close`, like browsers.
 *
 * Frames travel through two FIFO pipes per link (client → router "up", router → client "down"); the network's
 * `Scheduler` decides when each item arrives (virtual clock with per-direction latency, microtasks, synchronously, or
 * manually), and items are delivered strictly in order. A pipe never dispatches re-entrantly: an item that arrives
 * while its pipe is delivering is delivered right after the current one. Fault controls (`FakeSocketControls`):
 * - `freeze('drop')`: a half-open link — every frame in either direction is lost, close frames included, so neither
 *   side learns of a close; `freeze('buffer')`: a stall — frames are held and delivered, in order, on `thaw()`; both
 *   also per direction (`freeze('drop', 'up')`: a black hole for the client's frames only);
 * - `vanish()`: the client's end dies (1006) while the router end never learns (a ghost session: a dead NIC, a network
 *   switch); what the router sends goes nowhere until the router itself closes or drops the link;
 * - `drop(code, wasClean)`: the connection dies — undelivered frames are discarded both ways, the router end is gone
 *   at once, the client learns it through the down pipe (so a frozen link stays half-open);
 * - `close(code, reason)`: an orderly router close (pending frames first, then the close frame); `closingWindow(ms)`:
 *   the same, but the client's socket stays CLOSING for `ms` before its `close` event (writes in that window
 *   are refused);
 * - `emitLate(event)`: fire an event at every listener the socket ever had, removed ones included — a platform whose
 *   `removeEventListener` did not work (a released socket's late events must change nothing);
 * - `setBufferedAmount`; listener counts that leave out the adapter's permanent `error` guard (`socketErrorGuard`,
 *   transport/websocket.ts).
 * Events caused by the client's own `close()`/`terminate()` before the connection is up are local (they never travel);
 * with `closeEvents: 'sync'` they are dispatched from inside the call itself, as Node's undici does.
 *
 * @module
 */
import { socketErrorGuard } from '../transport/websocket.js';
import type { WebSocketConstructorLike, WebSocketLike } from '../types.js';

export type EventType = 'open' | 'message' | 'error' | 'close';
/** 'up' = client → router, 'down' = router → client. */
export type Direction = 'up' | 'down';

/** How a network moves frames. */
export interface Scheduler {
  /** Run `fn` when an item sent now in `direction` arrives. */
  schedule(direction: Direction, fn: () => void): void;
  /** Run `fn` after `ms` of virtual time (a closing window); without a clock it is `schedule('down', fn)`. */
  after(ms: number, fn: () => void): void;
}

/** How the router end of a link ended. */
export interface LinkEnd {
  /** 'client': the client's close frame arrived; 'gone': the client vanished without one (`terminate()`, a connect
   *  it gave up); 'router': the router closed, dropped or refused it. */
  readonly initiator: 'client' | 'gone' | 'router';
  readonly code: number;
  readonly reason: string;
}

/** What the router learns from one link. */
export interface LinkHandlers {
  /** The client wrote `data` on an OPEN socket (before it travels). The result travels with the frame to `message`. */
  sent(data: string | Uint8Array): unknown;
  /** A frame the client wrote arrived; `tag` is what `sent` returned for it. */
  message(data: string | Uint8Array, tag: unknown): void;
  /** A `message` event with `data` is about to be dispatched to the client. */
  received(data: string): void;
  /** The router end is gone. Called exactly once per link. */
  closed(end: LinkEnd): void;
}

/** The network a fake WebSocket class connects to (the router). */
export interface FakeNetwork {
  readonly scheduler: Scheduler;
  /** Sockets have a `terminate()` method (the `ws` package) [false: browsers and undici have none]. */
  readonly terminate?: boolean | undefined;
  /** Events caused by the client's own `close()`/`terminate()` before the connection is up: queued (browsers) or
   *  dispatched inside the call (undici) ['async']. */
  readonly closeEvents?: 'async' | 'sync' | undefined;
  /** The next link number (1-based per network). */
  nextLinkNumber(): number;
  /** A socket is being constructed (synchronously; a throw makes the constructor throw). Must not act on the link
   *  yet: the router answers in `attached`. */
  connect(link: FakeLink): LinkHandlers;
  /** The link is ready (its handlers are set): the router answers through it (`accept`, `fail`) or not at all (the
   *  connect hangs). Still inside the constructor. */
  attached(link: FakeLink): void;
  /** A client listener threw (a client bug: the adapter's listeners never throw). */
  listenerError(error: unknown): void;
}

/** Fault controls of one link (tests). */
export type FreezeMode = 'drop' | 'buffer';

export interface FakeSocketControls {
  readonly number: number;
  /** Abrupt loss of the connection: code [1006], wasClean [code !== 1006]. */
  drop(code?: number, wasClean?: boolean): void;
  /** Orderly router close: pending frames, then the close frame [1000, '']. */
  close(code?: number, reason?: string): void;
  /** Freeze both directions [both], or only the client's frames ('up') or the router's ('down'). */
  freeze(mode: FreezeMode, direction?: Direction | 'both'): void;
  /** Thaw both directions [both] or one; held frames are delivered in order. */
  thaw(direction?: Direction | 'both'): void;
  /** The mode of a frozen direction ('up' first): undefined when neither is frozen. */
  readonly frozen: FreezeMode | undefined;
  readonly frozenDirections: { readonly up: FreezeMode | undefined; readonly down: FreezeMode | undefined };
  /** The client's end dies with `code` [1006] (error + close, unclean); the router end stays open and never learns:
   *  its frames are discarded until it closes or drops the link itself. */
  vanish(code?: number): void;
  readonly vanished: boolean;
  /** Fire `event` now at every listener the socket ever had (removed ones too). */
  emitLate(event: EventType): void;
  /** Orderly router close whose client socket stays CLOSING for `ms` before `close` fires [1000, '']. */
  closingWindow(ms: number, code?: number, reason?: string): void;
  setBufferedAmount(script: number | (() => number)): void;
  /** Listeners currently on the socket, the adapter's permanent `error` guard not counted. */
  readonly listenerCount: number;
  readonly listeners: Readonly<Record<EventType, number>>;
  /** The adapter's permanent `error` guard is attached. */
  readonly hasErrorGuard: boolean;
  /** Every `close(code, reason)` call the client made, in order (also those that threw). */
  readonly closeCalls: readonly { readonly code: unknown; readonly reason: unknown }[];
  readonly terminateCalls: number;
}

export interface FakeSocket extends WebSocketLike {
  readonly url: string;
  readonly controls: FakeSocketControls;
}

/** The router's end of one link. */
export interface FakeLink {
  readonly number: number;
  /** The tag of the WebSocket class that created it (`createFakeWebSocket(network, owner)`). */
  readonly owner: unknown;
  readonly url: string;
  readonly protocols: readonly string[];
  readonly socket: FakeSocket;
  readonly controls: FakeSocketControls;
  /** The router end: 'connecting' until `accept`, 'closed' once `LinkHandlers.closed` ran. */
  readonly state: 'connecting' | 'open' | 'closed';
  /** A frozen direction or a vanished client: a ping from the router would get no answer. */
  readonly unresponsive: boolean;
  /** Complete the upgrade with `protocol` (the client's `open` follows through the down pipe). */
  accept(protocol: string): void;
  /** Fail the connect: `error` and `close` 1006, or `error` only (Node 22's undici), through the down pipe. */
  fail(errorOnly?: boolean, message?: string): void;
  /** Router → client frame. One sent before `accept` never reaches a listener (not OPEN); one sent once the router
   *  end is closed (`state === 'closed'`) is discarded. */
  send(data: string): void;
  /** Orderly close; `window` keeps the client socket CLOSING that long before `close` fires. */
  close(code: number, reason: string, window?: number): void;
  drop(code?: number, wasClean?: boolean): void;
}

type Listener = (this: unknown, ev: never) => void;

const CONNECT_FAILED = 'Received network error or non-101 status code.';
const CLOSED_BEFORE_OPEN = 'WebSocket was closed before the connection was established';

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const NON_ASCII = /[^\0-\x7f]/;

/** UTF-8 length of `text` (a lone surrogate counts as U+FFFD). */
export function utf8Length(text: string): number {
  if (!NON_ASCII.test(text)) return text.length; // the common case, without a loop over a 16 MiB frame
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if ((c & 0xfc00) === 0xd800 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4; // a surrogate pair (past the end charCodeAt is NaN, and NaN & x === 0)
      i++;
    } else n += 3; // other BMP characters; a lone surrogate becomes U+FFFD (3 bytes)
  }
  return n;
}

/** WHATWG `close()` argument checks. */
function checkClose(code: unknown, reason: unknown): void {
  const valid =
    code === undefined ||
    code === 1000 ||
    (Number.isInteger(code) && (code as number) >= 3000 && (code as number) <= 4999);
  if (!valid) throw namedError('InvalidAccessError', 'The close code must be 1000 or an integer from 3000 to 4999');
  if (typeof reason === 'string' && utf8Length(reason) > 123) {
    throw namedError('SyntaxError', 'The close reason must be at most 123 UTF-8 bytes');
  }
}

/** What `send` hands on: a copy of binary data (the caller may reuse its buffer), text as text (WHATWG stringifies
 *  anything else). */
function copyData(data: unknown): string | Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return String(data); // WHATWG stringifies anything else
}

type DownItem =
  | { readonly kind: 'open'; readonly protocol: string }
  | { readonly kind: 'message'; readonly data: string }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string; readonly window: number }
  | { readonly kind: 'fail'; readonly errorOnly: boolean; readonly message: string }
  | { readonly kind: 'drop'; readonly code: number; readonly wasClean: boolean };

type UpItem =
  | { readonly kind: 'message'; readonly data: string | Uint8Array; readonly tag: unknown }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string }
  | { readonly kind: 'gone' };

/** One direction of a link: FIFO, in-order, freeze-aware, never re-entrant. */
class Pipe<T> {
  private readonly slots: { readonly item: T; arrived: boolean }[] = [];
  private pumping = false;

  constructor(
    private readonly direction: Direction,
    private readonly link: Link,
    private readonly deliver: (item: T) => void,
  ) {}

  send(item: T): void {
    const slot = { item, arrived: false };
    this.slots.push(slot);
    this.link.network.scheduler.schedule(this.direction, () => {
      slot.arrived = true;
      this.pump();
    });
  }

  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let slot = this.slots[0]; slot?.arrived === true; slot = this.slots[0]) {
        const frozen = this.link.frozenIn(this.direction);
        if (frozen === 'buffer') return;
        this.slots.shift();
        if (frozen !== 'drop') this.deliver(slot.item);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Discard every undelivered item (the connection died). Their scheduled arrivals find nothing. */
  clear(): void {
    this.slots.length = 0;
  }
}

/** One in-memory connection: the two pipes and the router end. */
class Link implements FakeLink {
  readonly number: number;
  readonly controls: FakeSocketControls;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  frozenUp: FreezeMode | undefined;
  frozenDown: FreezeMode | undefined;
  vanished = false;
  readonly handlers: LinkHandlers;
  readonly up: Pipe<UpItem>;
  readonly down: Pipe<DownItem>;

  constructor(
    readonly network: FakeNetwork,
    readonly owner: unknown,
    readonly url: string,
    readonly protocols: readonly string[],
    readonly socket: SocketBase,
  ) {
    this.number = network.nextLinkNumber();
    this.up = new Pipe<UpItem>('up', this, (item) => {
      this.arriveUp(item);
    });
    this.down = new Pipe<DownItem>('down', this, (item) => {
      socket.arrive(item);
    });
    this.controls = createControls(this);
    this.handlers = network.connect(this);
  }

  frozenIn(direction: Direction): FreezeMode | undefined {
    return direction === 'up' ? this.frozenUp : this.frozenDown;
  }

  get unresponsive(): boolean {
    return this.vanished || this.frozenUp !== undefined || this.frozenDown !== undefined;
  }

  accept(protocol: string): void {
    if (this.state !== 'connecting') return;
    this.state = 'open';
    this.down.send({ kind: 'open', protocol });
  }

  fail(errorOnly = false, message = CONNECT_FAILED): void {
    if (this.state === 'closed') return;
    this.finish({ initiator: 'router', code: 1006, reason: '' });
    this.down.send({ kind: 'fail', errorOnly, message });
  }

  /** Frames sent before `accept` never reach a client listener (the socket is not OPEN then); once the router end is
   *  closed nothing is sent at all — also not from its `closed` handler, which runs before the close or drop item is
   *  queued: a dead router writes nothing. */
  send(data: string): void {
    if (this.state === 'closed' || this.vanished) return;
    this.down.send({ kind: 'message', data });
  }

  vanish(code: number): void {
    if (this.state !== 'open' || this.vanished) return;
    this.vanished = true;
    this.up.clear();
    this.down.clear();
    this.network.scheduler.schedule('down', () => {
      this.socket.arrive({ kind: 'drop', code, wasClean: false });
    });
  }

  close(code: number, reason: string, window = 0): void {
    if (this.state === 'connecting') this.fail();
    if (this.state === 'closed') return;
    this.finish({ initiator: 'router', code, reason });
    this.down.send({ kind: 'close', code, reason, window });
  }

  drop(code = 1006, wasClean = code !== 1006): void {
    if (this.state === 'closed') return;
    this.down.clear(); // client → router frames in flight are lost too: the closed router end ignores them
    this.finish({ initiator: 'router', code, reason: '' });
    this.down.send({ kind: 'drop', code, wasClean });
  }

  private finish(end: LinkEnd): void {
    this.state = 'closed';
    this.handlers.closed(end);
  }

  /** An up item reached the router end. The client writes only while OPEN, which needs `accept`, so a message can
   *  only find the router end open or closed. */
  private arriveUp(item: UpItem): void {
    if (this.state === 'closed' || this.vanished) return; // the router end is gone or cut off: nothing reaches it
    switch (item.kind) {
      case 'message':
        this.handlers.message(item.data, item.tag);
        return;
      case 'close':
        // The client's close frame: the router end is done, and the server side echoes the close frame.
        this.finish({ initiator: 'client', code: item.code, reason: item.reason });
        this.down.send({ kind: 'close', code: item.code, reason: item.reason, window: 0 });
        return;
      case 'gone':
        this.finish({ initiator: 'gone', code: 1006, reason: '' });
        return;
    }
  }
}

function setOf(map: Map<EventType, Set<Listener>>, type: EventType): Set<Listener> {
  let set = map.get(type);
  if (set === undefined) {
    set = new Set();
    map.set(type, set);
  }
  return set;
}

const LATE_EVENTS: Readonly<Record<EventType, () => object>> = {
  open: () => ({ type: 'open' }),
  message: () => ({ type: 'message', data: '[36,1,1,{}]' }),
  error: () => ({ type: 'error', message: 'late error', error: new Error('late error') }),
  close: () => ({ type: 'close', code: 1006, reason: 'late close', wasClean: false }),
};

/** The client end. One subclass per network (`createFakeWebSocket`). */
class SocketBase implements FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  protocol = '';
  readonly extensions = '';
  readonly url: string;
  readonly controls: FakeSocketControls;
  readonly link: Link;
  readonly closeCalls: { readonly code: unknown; readonly reason: unknown }[] = [];
  terminateCalls = 0;
  private binary = 'blob';
  private buffered: number | (() => number) = 0;
  private readonly listeners = new Map<EventType, Set<Listener>>();
  private readonly everAdded = new Map<EventType, Set<Listener>>();
  /** The connect failed with `error` only (Node 22's undici): readyState stays CONNECTING, nothing more arrives. */
  private failedErrorOnly = false;
  /** terminate() destroyed the socket: nothing more arrives. */
  private destroyed = false;

  constructor(url: unknown, protocols: unknown, network: FakeNetwork, owner: unknown) {
    this.url = String(url);
    this.link = new Link(network, owner, this.url, protocolList(protocols), this);
    this.controls = this.link.controls;
    network.attached(this.link);
  }

  get binaryType(): string {
    return this.binary;
  }
  set binaryType(value: string) {
    if (value === 'blob' || value === 'arraybuffer') this.binary = value; // WHATWG ignores other values
  }

  get bufferedAmount(): number {
    return typeof this.buffered === 'function' ? this.buffered() : this.buffered;
  }

  setBufferedAmount(script: number | (() => number)): void {
    this.buffered = script;
  }

  addEventListener(type: EventType, listener: Listener): void {
    if (typeof listener !== 'function') return;
    setOf(this.listeners, type).add(listener);
    setOf(this.everAdded, type).add(listener);
  }

  removeEventListener(type: EventType, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | (Uint8Array & { readonly buffer: ArrayBuffer })): void {
    if (this.readyState === 0) throw namedError('InvalidStateError', 'The WebSocket is still CONNECTING');
    if (this.readyState !== 1) return; // CLOSING or CLOSED: discarded (WHATWG)
    const copy = copyData(data);
    const tag = this.link.handlers.sent(copy);
    this.link.up.send({ kind: 'message', data: copy, tag });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    checkClose(code, reason);
    if (this.failedErrorOnly) {
      // Node 22's undici after a failed connect: every close() fires `error` again, readyState stays CONNECTING.
      this.local(() => {
        this.dispatch('error', { type: 'error', message: CLOSED_BEFORE_OPEN, error: new Error(CLOSED_BEFORE_OPEN) });
      });
      return;
    }
    if (this.readyState >= 2) return;
    const connecting = this.readyState === 0;
    this.readyState = 2;
    if (connecting) {
      this.link.up.send({ kind: 'gone' });
      this.local(() => {
        this.finish(1006, '', false, CLOSED_BEFORE_OPEN);
      });
    } else {
      this.link.up.send({ kind: 'close', code: code ?? 1005, reason: reason ?? '' });
    }
  }

  /** The `ws` package's terminate(): the socket is destroyed at once; `close` 1006 follows. */
  doTerminate(): void {
    this.terminateCalls++;
    if (this.readyState === 3 || this.destroyed || this.failedErrorOnly) return;
    const connecting = this.readyState === 0;
    this.destroyed = true;
    this.readyState = 2;
    this.link.up.send({ kind: 'gone' });
    this.local(() => {
      this.finish(1006, '', false, connecting ? CLOSED_BEFORE_OPEN : undefined);
    });
  }

  /** An event the socket raises itself (not a frame): dispatched inside the call with `closeEvents: 'sync'`. */
  private local(fn: () => void): void {
    if (this.link.network.closeEvents === 'sync') fn();
    else this.link.network.scheduler.schedule('down', fn);
  }

  /** CLOSED, then `error` (unclean ends that have a text) and `close`. At most once. */
  private finish(code: number, reason: string, wasClean: boolean, errorText?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (errorText !== undefined) {
      this.dispatch('error', { type: 'error', message: errorText, error: new Error(errorText) });
    }
    this.dispatch('close', { type: 'close', code, reason, wasClean });
  }

  /** A down-pipe item reached the client. */
  arrive(item: DownItem): void {
    if (this.destroyed || this.readyState === 3) return; // after a failed connect nothing more is sent
    switch (item.kind) {
      case 'open':
        if (this.readyState !== 0) return; // the client gave up on the connect meanwhile
        this.readyState = 1;
        this.protocol = item.protocol;
        this.dispatch('open', { type: 'open' });
        return;
      case 'message':
        if (this.readyState !== 1) return; // after a close frame nothing is delivered
        this.link.handlers.received(item.data);
        this.dispatch('message', { type: 'message', data: item.data });
        return;
      case 'fail':
        if (item.errorOnly) {
          this.failedErrorOnly = true;
          this.dispatch('error', { type: 'error', message: item.message, error: new Error(item.message) });
        } else {
          this.finish(1006, '', false, item.message);
        }
        return;
      case 'drop':
        if (this.readyState === 0) this.finish(1006, '', false, CONNECT_FAILED);
        else this.finish(item.code, '', item.wasClean, item.wasClean ? undefined : 'WebSocket connection lost');
        return;
      case 'close': {
        this.readyState = 2;
        const done = (): void => {
          this.finish(item.code, item.reason, true);
        };
        if (item.window > 0) this.link.network.scheduler.after(item.window, done);
        else done();
        return;
      }
    }
  }

  private dispatch(type: EventType, event: object, everyListener = false): void {
    const live = setOf(this.listeners, type);
    for (const listener of [...(everyListener ? setOf(this.everAdded, type) : live)]) {
      if (!everyListener && !live.has(listener)) continue; // removed during this dispatch
      try {
        listener.call(this, event as never);
      } catch (error) {
        this.link.network.listenerError(error);
      }
    }
  }

  emitLate(type: EventType): void {
    this.dispatch(type, LATE_EVENTS[type](), true);
  }

  counts(): Record<EventType, number> {
    const count = (type: EventType): number => this.listeners.get(type)?.size ?? 0;
    return {
      open: count('open'),
      message: count('message'),
      error: count('error') - (this.hasGuard() ? 1 : 0),
      close: count('close'),
    };
  }

  hasGuard(): boolean {
    return this.listeners.get('error')?.has(socketErrorGuard) === true;
  }
}

function createControls(link: Link): FakeSocketControls {
  const socket = (): SocketBase => link.socket;
  return {
    number: link.number,
    drop: (code?: number, wasClean?: boolean) => {
      link.drop(code, wasClean);
    },
    close: (code = 1000, reason = '') => {
      link.close(code, reason);
    },
    freeze: (mode: string, direction = 'both') => {
      if (mode !== 'drop' && mode !== 'buffer') throw new TypeError(`freeze mode must be 'drop' or 'buffer'`);
      const [up, down] = directions(direction);
      if (up) link.frozenUp = mode;
      if (down) link.frozenDown = mode;
    },
    thaw: (direction = 'both') => {
      const [up, down] = directions(direction);
      if (up) link.frozenUp = undefined;
      if (down) link.frozenDown = undefined;
      link.up.pump();
      link.down.pump();
    },
    get frozen() {
      return link.frozenUp ?? link.frozenDown;
    },
    get frozenDirections() {
      return { up: link.frozenUp, down: link.frozenDown };
    },
    vanish: (code = 1006) => {
      link.vanish(code);
    },
    get vanished() {
      return link.vanished;
    },
    emitLate: (event: EventType) => {
      socket().emitLate(event);
    },
    closingWindow: (ms: number, code = 1000, reason = '') => {
      if (!(ms >= 0 && ms < Infinity)) throw new RangeError('closingWindow(ms) needs a finite ms ≥ 0');
      link.close(code, reason, ms);
    },
    setBufferedAmount: (script: number | (() => number)) => {
      socket().setBufferedAmount(script);
    },
    get listenerCount() {
      const c = socket().counts();
      return c.open + c.message + c.error + c.close;
    },
    get listeners() {
      return socket().counts();
    },
    get hasErrorGuard() {
      return socket().hasGuard();
    },
    get closeCalls() {
      return socket().closeCalls;
    },
    get terminateCalls() {
      return socket().terminateCalls;
    },
  };
}

/** Which directions a `freeze`/`thaw` argument names: [up, down]. */
function directions(direction: string): readonly [boolean, boolean] {
  if (direction === 'both') return [true, true];
  if (direction === 'up' || direction === 'down') return [direction === 'up', direction === 'down'];
  throw new TypeError(`direction must be 'up', 'down' or 'both'`);
}

/** The constructor's `protocols` argument as a list (WHATWG: a string is a one-element list). */
function protocolList(protocols: unknown): readonly string[] {
  if (protocols === undefined) return [];
  if (typeof protocols === 'string') return [protocols];
  if (Array.isArray(protocols)) return protocols.map(String);
  throw namedError('SyntaxError', 'protocols must be a string or an array of strings');
}

/** A `WebSocketConstructorLike` whose sockets connect to `network`; `owner` tags their links. */
export function createFakeWebSocket(network: FakeNetwork, owner?: unknown): WebSocketConstructorLike {
  class FakeWebSocket extends SocketBase {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, network, owner);
    }
  }
  class TerminatingWebSocket extends FakeWebSocket {
    terminate(): void {
      this.doTerminate();
    }
  }
  return network.terminate === true ? TerminatingWebSocket : FakeWebSocket;
}
