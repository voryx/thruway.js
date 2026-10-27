/**
 * `Connection` — one attempt: its transport, gate, TimerScope, the serializer and frame size limit on every write,
 * `release(code)` — and `Lingering`, a released-for-sending connection waiting (≤ 2 s) for the router's GOODBYE reply
 * or the socket close after a client GOODBYE.
 *
 * @module
 */
import { WampError } from '../errors.js';
import { CloseCode, Uri } from '../protocol/codes.js';
import { MAX_FRAME_BYTES, type InboundChallenge, type OutboundFrame } from '../protocol/messages.js';
import type { HelloAuth } from '../options.js';
import type { Serializer, Session } from '../types.js';
import type { Transport } from '../transport/websocket.js';
import type { ConnId } from './contracts.js';
import type { TimerScope } from './clock.js';

/** Send permission: `hello` = only HELLO/AUTHENTICATE/ABORT (+ the anonymous-WELCOME GOODBYE); `open` = the
 *  established session; `closed` forever once the session ends or a write fails. */
export type Gate = 'closed' | 'hello' | 'open';

/** The close codes the client uses. */
export type ClientCloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** The fixed ASCII close reasons of the codes the client uses (router text is never quoted). */
const CLOSE_REASONS: Readonly<Record<ClientCloseCode, string>> = {
  [CloseCode.NORMAL]: 'normal closure',
  [CloseCode.PROTOCOL_VIOLATION]: 'protocol violation',
  [CloseCode.CLIENT_TIMEOUT]: 'client timeout',
  [CloseCode.INTERNAL_ERROR]: 'client internal error',
};

export function closeReason(code: ClientCloseCode): string {
  return CLOSE_REASONS[code];
}

/** The auth keys of a connection whose HELLO is not written yet. */
const NO_AUTH: HelloAuth = Object.freeze({ authmethods: Object.freeze([]), authid: undefined, authextra: undefined });

/** The transport of a connection whose socket does not exist yet (RESOLVING): nothing can be written to it. */
const NO_TRANSPORT: Transport = Object.freeze({
  send: () => false,
  close: () => undefined,
  terminate: () => undefined,
  bufferedAmount: () => 0,
});

/** UTF-8 length of a string (lone surrogates count 3 bytes, as the replacement character they are sent as). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Byte length of a serialized frame (text: UTF-8). */
export function frameBytes(data: string | Uint8Array): number {
  return typeof data === 'string' ? utf8Length(data) : data.byteLength;
}

/** The bytes of `data` when it is over the 16 MiB limit, else undefined. Cheap for most frames: a string of
 *  more than 16 Mi code units is over, one of at most a third of that is under; only in between is it measured. */
export function oversize(data: string | Uint8Array): number | undefined {
  if (typeof data !== 'string') return data.byteLength > MAX_FRAME_BYTES ? data.byteLength : undefined;
  if (data.length * 3 <= MAX_FRAME_BYTES) return undefined;
  const bytes = utf8Length(data); // never less than data.length
  return bytes > MAX_FRAME_BYTES ? bytes : undefined;
}

export class Connection {
  readonly id: ConnId;
  /** The socket's transport (a stand-in that writes nothing until the socket exists). */
  transport: Transport = NO_TRANSPORT;
  gate: Gate = 'closed';
  readonly timers: TimerScope;
  session: Session | undefined = undefined;
  /** CHALLENGE round (0 before the first CHALLENGE; at most 8). */
  round = 0;
  /** A CHALLENGE was received on this connection (anonymous-WELCOME rule). */
  challenged = false;
  /** The latest round-1 CHALLENGE held during the settle window. */
  settling: InboundChallenge | undefined = undefined;
  /** The method of the round being answered (set when its `run` is delivered). */
  roundMethod: string | undefined = undefined;
  /** The method of the last AUTHENTICATE (for the `challenge.mismatch` warning). */
  lastAnsweredMethod: string | undefined = undefined;
  /** Cancels the URL resolver's pending first value, called in a delivery. */
  cancelResolver: (() => void) | undefined = undefined;
  /** The URL this attempt's socket was opened with (empty until the URL is resolved and the socket created). */
  url = '';
  /** The auth keys of this attempt's HELLO (none until it is written). */
  auth: HelloAuth = NO_AUTH;
  /** The id of a WELCOME the client rejected as unrequested-anonymous (`CloseInfo.sessionId`). */
  rejectedSessionId: number | undefined = undefined;
  /** The deadline the connect / handshake timer was armed with (`TimeoutError.timeout`). */
  deadline = 0;
  ended = false;
  /** Moved to the lingering set (its transport is closed by the Lingering record, never by `release`). */
  lingering = false;

  constructor(
    id: ConnId,
    timers: TimerScope,
    private readonly serializer: Serializer,
    private readonly onWrite: (frame: OutboundFrame, data: string | Uint8Array) => void,
  ) {
    this.id = id;
    this.timers = timers;
  }

  /** A socket was created for this attempt. */
  get hasSocket(): boolean {
    return this.transport !== NO_TRANSPORT;
  }

  /** Serialize, check the 16 MiB limit, send. False when nothing was sent (gate closed, transport refused: the gate is
   *  then closed for good); throws the serializer's error or a fresh `WampError('wamp.error.payload_size_exceeded',
   *  [bytes, limit])` (nothing written). */
  write(frame: OutboundFrame): boolean {
    if (this.gate === 'closed') return false; // the gate opens only once the socket is open
    const data = this.serializer.serialize(frame);
    const bytes = oversize(data);
    if (bytes !== undefined) throw new WampError(Uri.PAYLOAD_SIZE_EXCEEDED, [bytes, MAX_FRAME_BYTES]);
    if (!this.transport.send(data)) {
      this.gate = 'closed'; // the adapter has queued ws.closed: the connection ends after this step
      return false;
    }
    this.onWrite(frame, data);
    return true;
  }

  /** Close the transport with `code` (1000 / 4000 / 4001 / 4002), remove its listeners, clear its timers,
   *  close the gate. Idempotent; a no-op for a lingering connection (its record closes it). */
  release(code: ClientCloseCode): void {
    if (this.lingering) return;
    this.gate = 'closed';
    this.timers.clearAll();
    this.transport.close(code, closeReason(code)); // once: the adapter ignores a second close
  }
}

/** A connection after the client's own GOODBYE: holds the transport and its `timer.goodbye`, nothing else. */
export class Lingering {
  readonly connection: Connection;
  readonly done: Promise<void>;
  private resolve!: () => void;

  /** Arms `goodbye` (`ms`) on the connection's (cleared) TimerScope; `onTimer(gen)` submits `timer.goodbye`. */
  constructor(connection: Connection, goodbyeMs: number, onTimer: (gen: number) => void) {
    this.connection = connection;
    connection.lingering = true;
    connection.gate = 'closed';
    connection.timers.clearAll();
    this.done = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
    connection.timers.arm('goodbye', goodbyeMs, onTimer);
  }

  get id(): ConnId {
    return this.connection.id;
  }

  /** GOODBYE (any reason), ABORT, `ws.closed`, `timer.goodbye` ⇒ close (+ `terminate()` on the timer) ⇒ done. The core
   *  calls it once (it removes the record from its set first). */
  finish(terminate: boolean): void {
    const { connection } = this;
    connection.timers.clearAll();
    const transport = connection.transport;
    transport.close(CloseCode.NORMAL, closeReason(CloseCode.NORMAL));
    if (terminate) transport.terminate(); // a frozen peer never answers the closing handshake
    this.resolve();
  }
}
