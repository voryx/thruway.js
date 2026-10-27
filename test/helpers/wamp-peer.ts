// A raw WAMP peer over any WebSocketLike: the shape of the routers/ smoke scripts' `Peer`/`Session` classes, made
// deterministic for the virtual clock. Tests drive it frame by frame against the testing kit's router (the router
// tests, the smoke-scenario ports) and the harness tests build their scripted client on it.
import type { FakeSocket } from '../../src/testing/socket.js';
import type { WebSocketConstructorLike } from '../../src/types.js';

export const MSG = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  CHALLENGE: 4,
  AUTHENTICATE: 5,
  GOODBYE: 6,
  ERROR: 8,
  PUBLISH: 16,
  PUBLISHED: 17,
  SUBSCRIBE: 32,
  SUBSCRIBED: 33,
  UNSUBSCRIBE: 34,
  UNSUBSCRIBED: 35,
  EVENT: 36,
  CALL: 48,
  CANCEL: 49,
  RESULT: 50,
  REGISTER: 64,
  REGISTERED: 65,
  UNREGISTER: 66,
  UNREGISTERED: 67,
  INVOCATION: 68,
  INTERRUPT: 69,
  YIELD: 70,
} as const;

/** The roles of the routers/ smoke scripts (every feature the testing router implements). */
export const PEER_ROLES = {
  caller: { features: { progressive_call_results: true, call_canceling: true, caller_identification: true } },
  callee: {
    features: {
      progressive_call_results: true,
      call_canceling: true,
      caller_identification: true,
      pattern_based_registration: true,
      shared_registration: true,
      registration_revocation: true,
    },
  },
  publisher: {
    features: { publisher_exclusion: true, publisher_identification: true, subscriber_blackwhite_listing: true },
  },
  subscriber: {
    features: { pattern_based_subscription: true, publisher_identification: true, subscription_revocation: true },
  },
} as const;

export type Frame = readonly unknown[];

/** Something that delivers pending frames (the virtual clock's `runUntilIdle`, a manual `flush`, or nothing). */
export type Settle = () => Promise<void> | void;

export class WampPeer {
  /** The testing kit's socket (its `controls` reach the fault injection). */
  readonly ws: FakeSocket;
  /** Every frame received, in order. */
  readonly received: Frame[] = [];
  /** Every frame sent, in order. */
  readonly sent: Frame[] = [];
  /** Received frames not taken yet. */
  private readonly queue: Frame[] = [];
  /** Raw text of received frames that are not JSON arrays. */
  readonly raw: string[] = [];
  opened = false;
  closed: { readonly code: number; readonly reason: string; readonly wasClean: boolean } | undefined;
  readonly errors: unknown[] = [];
  readonly events: string[] = [];
  /** Called for every received frame before it is queued; return true to consume it (auto-callee). */
  onFrame: ((frame: Frame) => boolean) | undefined;
  private nextId = 1;

  constructor(
    Ctor: WebSocketConstructorLike,
    url: string,
    private readonly settle: Settle,
    protocols: string | string[] = ['wamp.2.json'],
  ) {
    this.ws = new Ctor(url, protocols) as FakeSocket;
    this.ws.addEventListener('open', () => {
      this.opened = true;
      this.events.push('open');
    });
    this.ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        frame = undefined;
      }
      if (!Array.isArray(frame)) {
        this.raw.push(data);
        this.events.push('raw');
        return;
      }
      this.events.push(`message:${String(frame[0])}`);
      this.received.push(frame);
      if (this.onFrame?.(frame) !== true) this.queue.push(frame);
    });
    this.ws.addEventListener('error', (ev) => {
      this.errors.push(ev);
      this.events.push('error');
    });
    this.ws.addEventListener('close', (ev) => {
      this.closed = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean ?? false };
      this.events.push(`close:${String(ev.code)}`);
    });
    // A synchronous transport is OPEN before any listener exists (like the adapter).
    if (this.ws.readyState === 1) this.opened = true;
  }

  id(): number {
    return this.nextId++;
  }

  send(frame: Frame): void {
    this.sent.push(frame);
    this.ws.send(JSON.stringify(frame));
  }

  /** Remove and return the first queued frame matching `pred` (undefined when there is none yet). */
  take(pred: (frame: Frame) => boolean): Frame | undefined {
    const index = this.queue.findIndex(pred);
    return index < 0 ? undefined : this.queue.splice(index, 1)[0];
  }

  /** The first queued frame matching `pred`, after letting pending deliveries run; throws when there is none. */
  async next(pred: (frame: Frame) => boolean, what: string): Promise<Frame> {
    let frame = this.take(pred);
    if (frame === undefined) {
      await this.settle();
      frame = this.take(pred);
    }
    if (frame === undefined) {
      throw new Error(`no ${what} (queued: ${JSON.stringify(this.queue)}, closed: ${JSON.stringify(this.closed)})`);
    }
    return frame;
  }

  /** The first queued frame of `type` (and, when given, request id at element 1 = `request`). */
  nextOf(type: number, request?: number): Promise<Frame> {
    return this.next(
      (f) => f[0] === type && (request === undefined || f[1] === request),
      `${String(type)}${request === undefined ? '' : ` for ${String(request)}`}`,
    );
  }

  /** The reply to request `request` of type `requestType`: `okType` or the ERROR for it. */
  reply(requestType: number, request: number, okType: number): Promise<Frame> {
    return this.next(
      (f) => (f[0] === okType && f[1] === request) || (f[0] === MSG.ERROR && f[1] === requestType && f[2] === request),
      `reply to ${String(requestType)} #${String(request)}`,
    );
  }

  /** Received frames not taken yet. */
  get pending(): readonly Frame[] {
    return this.queue;
  }

  /** HELLO → WELCOME (answering CHALLENGEs with `answer`), resolving with the WELCOME. */
  async join(
    realm = 'realm1',
    details: Record<string, unknown> = {},
    answer?: (method: string, extra: Record<string, unknown>) => string,
  ): Promise<Frame> {
    if (!this.opened) await this.settle();
    if (!this.opened) throw new Error('the socket did not open');
    this.send([MSG.HELLO, realm, { agent: 'wamp-peer', roles: PEER_ROLES, ...details }]);
    for (;;) {
      const m = await this.next(
        (f) => f[0] === MSG.WELCOME || f[0] === MSG.ABORT || f[0] === MSG.CHALLENGE,
        'WELCOME/ABORT/CHALLENGE',
      );
      if (m[0] !== MSG.CHALLENGE) return m;
      if (answer === undefined) throw new Error(`CHALLENGE ${JSON.stringify(m)} without an answer function`);
      this.send([MSG.AUTHENTICATE, answer(m[1] as string, m[2] as Record<string, unknown>), {}]);
    }
  }

  async register(procedure: string, options: Record<string, unknown> = {}): Promise<number> {
    const id = this.id();
    this.send([MSG.REGISTER, id, options, procedure]);
    const m = await this.reply(MSG.REGISTER, id, MSG.REGISTERED);
    if (m[0] !== MSG.REGISTERED) throw new Error(`REGISTER failed: ${JSON.stringify(m)}`);
    return m[2] as number;
  }

  async subscribe(topic: string, options: Record<string, unknown> = {}): Promise<number> {
    const id = this.id();
    this.send([MSG.SUBSCRIBE, id, options, topic]);
    const m = await this.reply(MSG.SUBSCRIBE, id, MSG.SUBSCRIBED);
    if (m[0] !== MSG.SUBSCRIBED) throw new Error(`SUBSCRIBE failed: ${JSON.stringify(m)}`);
    return m[2] as number;
  }

  /** CALL and the reply (RESULT or ERROR). */
  async call(
    procedure: string,
    args?: unknown[],
    kwargs?: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<Frame> {
    const id = this.id();
    this.send(callFrame(id, procedure, args, kwargs, options));
    return this.reply(MSG.CALL, id, MSG.RESULT);
  }

  /** Answer every INVOCATION of `registration` with `fn(args, kwargs, details)` (a YIELD of `[result]`). */
  autoCallee(
    registration: number,
    fn: (args: unknown[], kwargs: Record<string, unknown>, details: Record<string, unknown>) => unknown,
  ): void {
    const previous = this.onFrame;
    this.onFrame = (f) => {
      if (f[0] === MSG.INVOCATION && f[2] === registration) {
        const result = fn(
          (f[4] ?? []) as unknown[],
          (f[5] ?? {}) as Record<string, unknown>,
          f[3] as Record<string, unknown>,
        );
        this.send([MSG.YIELD, f[1], {}, [result]]);
        return true;
      }
      return previous?.(f) ?? false;
    };
  }

  async goodbye(): Promise<Frame> {
    this.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    return this.nextOf(MSG.GOODBYE);
  }
}

export function callFrame(
  id: number,
  procedure: string,
  args?: unknown[],
  kwargs?: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Frame {
  if (kwargs !== undefined) return [MSG.CALL, id, options, procedure, args ?? [], kwargs];
  if (args !== undefined) return [MSG.CALL, id, options, procedure, args];
  return [MSG.CALL, id, options, procedure];
}
