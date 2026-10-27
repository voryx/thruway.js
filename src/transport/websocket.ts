/**
 * WebSocketLike adapter → internal transport events. `send` never throws for transport state; the first `error` or
 * `close` is terminal (Node 22 fires `error` without `close` for sockets that never open); listeners ignore events
 * after `finish`/`close` even when `removeEventListener` is a no-op. `CloseEvent` is never referenced as a value.
 *
 * Every socket also gets {@link socketErrorGuard}, a no-op `error` listener that is never removed: the `ws` package is
 * an EventEmitter and throws an `error` event that has no listener, so `close()` while CONNECTING (connect timeout,
 * `close()`, `reconnect()`) would otherwise crash the Node process with an uncaught exception.
 *
 * @module
 */
import type { WebSocketConstructorLike, WebSocketLike } from '../types.js';

/** Where the adapter reports (the core turns every call into `submit({kind: 'ws.*', conn, …})`). Calls can come
 *  synchronously from inside `openWebSocket` (a socket that is already OPEN), `send` (a refused write) and the
 *  socket's own methods (a synchronous transport), so the sink must only queue; it must not throw. */
export interface TransportSink {
  /** At most once, never after `closed`. `protocol` is `ws.protocol`, `''` when the socket reports none. */
  open(protocol: string): void;
  /** Each WebSocket message, data untouched (string, or ArrayBuffer with `binaryType = 'arraybuffer'`). */
  message(data: unknown): void;
  /** Exactly once per transport: the socket closed, failed, never opened, or a write was refused (code 1006) — unless
   *  the core called `close()`/`terminate()` first, after which nothing at all is reported. `error` is the error
   *  event's `error` value, or what `ws.send` threw. */
  closed(code: number, reason: string, wasClean: boolean, error?: unknown): void;
}

/** One WebSocket as the core uses it. No method ever throws. */
export interface Transport {
  /** false when nothing was sent (done, not OPEN, or `ws.send` threw); the loss is then reported through
   *  `sink.closed(1006, 'send on a socket that is not open', false)` — queued, so the core ends the connection after
   *  the current step — and the socket is closed (1000). A loss is reported once; later sends just return false. */
  send(data: string | Uint8Array): boolean;
  /** Once; removes listeners; `close(code, reason)` → `close(code)` → `close()` fallbacks. */
  close(code: number, reason: string): void;
  /** `ws.terminate?.()` in try/catch (the `ws` package), so Node can exit against a frozen peer. Once; removes
   *  listeners. Call `close()` first: a socket without `terminate` stays as `close()` left it. */
  terminate(): void;
  /** `ws.bufferedAmount` when it is a finite positive number, else 0 (liveness). */
  bufferedAmount(): number;
}

/** The reason reported for a refused write. */
export const SEND_REFUSED = 'send on a socket that is not open';

/** The reason reported for an `error` event that carries no message (browsers, Node 26's undici). */
export const ERROR_FALLBACK = 'WebSocket error';

/** The permanent `error` listener of every socket (see the module comment). It holds no reference to anything, so a
 *  released socket keeps nothing of the client alive; it is the only listener left after release, and tests that
 *  count listeners exclude it by identity. */
export function socketErrorGuard(): void {
  // Intentionally empty: it only has to exist (an EventEmitter without an `error` listener throws).
}

/** `new Ctor(url, protocols)`, `binaryType = 'arraybuffer'`, listeners wired to `sink`. A throwing constructor
 *  propagates (the core ends the attempt with `ConnectionLostError{cause}`); so does a throwing `addEventListener`,
 *  after the socket was closed. A socket that is already OPEN once its listeners are attached (a synchronous custom
 *  transport) reports `open` at once. */
export function openWebSocket(
  ctor: WebSocketConstructorLike,
  url: string,
  protocols: readonly string[],
  sink: TransportSink,
): Transport {
  const ws = new ctor(url, protocols.slice());
  const ctorOpen = read(ctor, 'OPEN');
  const OPEN = typeof ctorOpen === 'number' ? ctorOpen : 1;
  let opened = false;
  let done = false; // nothing more is reported: finished, or detached by close()/terminate()
  let closed = false; // ws.close() was attempted
  let terminated = false;

  const handlers: Readonly<Record<EventType, (ev: unknown) => void>> = {
    open: () => {
      if (done || opened) return;
      opened = true;
      const protocol = read(ws, 'protocol');
      sink.open(typeof protocol === 'string' ? protocol : '');
    },
    message: (ev) => {
      if (!done) sink.message(read(ev, 'data'));
    },
    error: (ev) => {
      finish(1006, errorText(ev), false, errorCause(ev));
    },
    close: (ev) => {
      const code = read(ev, 'code');
      const reason = read(ev, 'reason');
      const wasClean = read(ev, 'wasClean');
      const c = Number.isInteger(code) ? (code as number) : 1006; // isInteger does not narrow
      finish(c, typeof reason === 'string' ? reason : '', typeof wasClean === 'boolean' ? wasClean : c === 1000);
    },
  };
  // Method shorthand parameters are bivariant, so the per-event overloads of WebSocketLike fit this loose view.
  const target: LooseTarget = ws;

  /** Stop reporting and remove the four listeners (each removal on its own: one may throw). False if already done. */
  function detach(): boolean {
    if (done) return false;
    done = true;
    for (const type of EVENT_TYPES) {
      attempt(() => {
        target.removeEventListener(type, handlers[type]);
      });
    }
    return true;
  }
  function finish(code: number, reason: string, wasClean: boolean, error?: unknown): void {
    if (detach()) sink.closed(code, reason, wasClean, error);
  }
  function close(code: number, reason: string): void {
    if (closed) return;
    closed = true;
    detach();
    attempt(
      () => {
        ws.close(code, reason);
      },
      () => {
        ws.close(code);
      },
      () => {
        ws.close();
      },
    );
  }

  try {
    ws.binaryType = 'arraybuffer';
  } catch {
    // A transport that cannot switch binaryType still carries wamp.2.json's text frames.
  }
  try {
    target.addEventListener('error', socketErrorGuard);
    for (const type of EVENT_TYPES) target.addEventListener(type, handlers[type]);
  } catch (error) {
    close(1000, '');
    throw error;
  }
  if (read(ws, 'readyState') === OPEN) handlers.open(undefined);

  return {
    send(data) {
      if (done) return false;
      let error: unknown;
      try {
        if (read(ws, 'readyState') === OPEN) {
          ws.send(data as Parameters<WebSocketLike['send']>[0]);
          return true;
        }
      } catch (e) {
        error = e;
      }
      finish(1006, SEND_REFUSED, false, error);
      close(1000, '');
      return false;
    },
    close,
    terminate() {
      if (terminated) return;
      terminated = true;
      detach();
      attempt(() => {
        // Stryker disable next-line OptionalChaining: equivalent, attempt() contains a missing terminate's TypeError
        ws.terminate?.();
      });
    },
    bufferedAmount() {
      const amount = read(ws, 'bufferedAmount');
      return typeof amount === 'number' && amount < Infinity ? Math.max(amount, 0) : 0; // NaN, ±Infinity, < 0 ⇒ 0
    },
  };
}

type EventType = 'open' | 'message' | 'error' | 'close';
const EVENT_TYPES: readonly EventType[] = ['open', 'message', 'error', 'close'];

interface LooseTarget {
  addEventListener(type: EventType, listener: (ev: unknown) => void): void;
  removeEventListener(type: EventType, listener: (ev: unknown) => void): void;
}

/** Runs each step until one does not throw; never throws itself. */
function attempt(...steps: readonly (() => void)[]): void {
  for (const step of steps) {
    try {
      step();
      return;
    } catch {
      // try the next fallback
    }
  }
}

/** `value[key]`, or undefined when the read throws (`undefined`/`null`, a hostile getter, a revoked Proxy). */
function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // an unreadable value counts as absent
  }
  return undefined;
}

/** The error event's text: `ev.message` (undici 22, `ws`, React Native), else `ev.error.message`, else a fixed text
 *  (browsers' plain `Event`; Node 26's undici sends empty messages). */
function errorText(ev: unknown): string {
  for (const text of [read(ev, 'message'), read(read(ev, 'error'), 'message')]) {
    if (typeof text === 'string' && text !== '') return text;
  }
  return ERROR_FALLBACK;
}

/** The error behind an error event (`ws` and undici put it in `ev.error`); undefined when there is none. */
function errorCause(ev: unknown): unknown {
  const error = read(ev, 'error');
  return error === null ? undefined : error;
}
