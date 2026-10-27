// A raw WAMP peer over a real WebSocket: the capability probes, the routers' second sessions (raw callees that omit
// features, callers that must not be thruway.js), and the hostile/quirk scenarios that need exact frames. Real time:
// every wait is bounded and returns `undefined` on timeout instead of throwing.
export type Frame = readonly unknown[];

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

/** Every feature a raw peer may announce; `callee.call_canceling` is left out with `{cancel: false}`. */
export function peerRoles(options: { readonly cancel?: boolean } = {}): Record<string, unknown> {
  const cancel = options.cancel !== false;
  return {
    caller: { features: { progressive_call_results: true, call_canceling: true, caller_identification: true } },
    callee: {
      features: {
        progressive_call_results: true,
        ...(cancel ? { call_canceling: true } : {}),
        caller_identification: true,
        pattern_based_registration: true,
        shared_registration: true,
      },
    },
    publisher: { features: { publisher_exclusion: true, subscriber_blackwhite_listing: true } },
    subscriber: { features: { pattern_based_subscription: true } },
  };
}

export interface Closed {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Waiter {
  readonly predicate: (frame: Frame) => boolean;
  readonly resolve: (frame: Frame | undefined) => void;
}

export class RawPeer {
  readonly received: Frame[] = [];
  readonly sent: Frame[] = [];
  /** Non-JSON-array texts received. */
  readonly raw: string[] = [];
  closed: Closed | undefined;
  sessionId: number | undefined;
  /** Called for each received frame before it is queued; return true to consume it. */
  onFrame: ((frame: Frame) => boolean) | undefined;
  private readonly queue: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly closedWaiters: ((closed: Closed | undefined) => void)[] = [];
  private nextId = 1;

  private constructor(
    readonly ws: WebSocket,
    readonly url: string,
    readonly realm: string,
  ) {
    ws.addEventListener('message', (event) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason, wasClean: event.wasClean };
      for (const w of this.waiters.splice(0)) w.resolve(undefined);
      for (const w of this.closedWaiters.splice(0)) w(this.closed);
    });
  }

  /** Open a socket (`undefined` when it never opens within `ms`). */
  static async open(
    url: string,
    realm = 'realm1',
    options: { readonly protocols?: readonly string[]; readonly ms?: number } = {},
  ): Promise<RawPeer | undefined> {
    const ws = new WebSocket(url, [...(options.protocols ?? ['wamp.2.json'])]);
    const peer = new RawPeer(ws, url, realm);
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, options.ms ?? 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!opened) {
      peer.close();
      return undefined;
    }
    return peer;
  }

  /** Open + HELLO + WELCOME, or throw. */
  static async join(
    url: string,
    realm = 'realm1',
    options: { readonly details?: Record<string, unknown>; readonly cancel?: boolean } = {},
  ): Promise<RawPeer> {
    const peer = await RawPeer.open(url, realm);
    if (peer === undefined) throw new Error(`raw peer: ${url} did not open`);
    const answer = await peer.hello({ roles: peerRoles(options), ...options.details });
    if (answer?.[0] !== MSG.WELCOME) {
      peer.close();
      throw new Error(`raw peer: HELLO ${realm} on ${url} answered ${JSON.stringify(answer)}`);
    }
    return peer;
  }

  private onMessage(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      this.raw.push(String(data));
      return;
    }
    if (!Array.isArray(frame)) {
      this.raw.push(String(data));
      return;
    }
    const f = frame as Frame;
    this.received.push(f);
    if (this.onFrame?.(f) === true) return;
    const index = this.waiters.findIndex((w) => w.predicate(f));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(f);
      return;
    }
    this.queue.push(f);
  }

  id(): number {
    return this.nextId++;
  }

  send(frame: Frame): void {
    this.sent.push(frame);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  sendText(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  /** The next queued (or future) frame matching `predicate`, or undefined after `ms` or a close. */
  next(predicate: (frame: Frame) => boolean = () => true, ms = 3000): Promise<Frame | undefined> {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    if (this.closed !== undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(undefined);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /** Resolves on close (or undefined after `ms`). */
  waitClosed(ms = 3000): Promise<Closed | undefined> {
    if (this.closed !== undefined) return Promise.resolve(this.closed);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(undefined);
      }, ms);
      this.closedWaiters.push((closed) => {
        clearTimeout(timer);
        resolve(closed);
      });
    });
  }

  async hello(details: Record<string, unknown> = { roles: peerRoles() }, ms = 5000): Promise<Frame | undefined> {
    this.send([MSG.HELLO, this.realm, details]);
    const answer = await this.next((f) => f[0] === MSG.WELCOME || f[0] === MSG.ABORT || f[0] === MSG.CHALLENGE, ms);
    if (answer?.[0] === MSG.WELCOME) this.sessionId = answer[1] as number;
    return answer;
  }

  /** CALL; the answer is the RESULT (final) or ERROR for it. */
  call(
    procedure: string,
    args: readonly unknown[] = [],
    kwargs: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
    ms = 3000,
  ): { readonly id: number; readonly answer: Promise<Frame | undefined> } {
    const id = this.id();
    this.send([MSG.CALL, id, options, procedure, args, kwargs]);
    return { id, answer: this.next((f) => isAnswer(f, id), ms) };
  }

  /** REGISTER; resolves with the registration id, or the ERROR / undefined. */
  async register(
    procedure: string,
    options: Record<string, unknown> = {},
    ms = 3000,
  ): Promise<{ readonly id: number | undefined; readonly frame: Frame | undefined }> {
    const request = this.id();
    this.send([MSG.REGISTER, request, options, procedure]);
    const frame = await this.next(
      (f) =>
        (f[0] === MSG.REGISTERED && f[1] === request) ||
        (f[0] === MSG.ERROR && f[1] === MSG.REGISTER && f[2] === request),
      ms,
    );
    return { id: frame?.[0] === MSG.REGISTERED ? (frame[2] as number) : undefined, frame };
  }

  async subscribe(
    topic: string,
    options: Record<string, unknown> = {},
    ms = 3000,
  ): Promise<{ readonly id: number | undefined; readonly frame: Frame | undefined }> {
    const request = this.id();
    this.send([MSG.SUBSCRIBE, request, options, topic]);
    const frame = await this.next(
      (f) =>
        (f[0] === MSG.SUBSCRIBED && f[1] === request) ||
        (f[0] === MSG.ERROR && f[1] === MSG.SUBSCRIBE && f[2] === request),
      ms,
    );
    return { id: frame?.[0] === MSG.SUBSCRIBED ? (frame[2] as number) : undefined, frame };
  }

  publish(
    topic: string,
    args: readonly unknown[] = [],
    kwargs: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): number {
    const id = this.id();
    this.send([MSG.PUBLISH, id, options, topic, args, kwargs]);
    return id;
  }

  /** Answer every INVOCATION with `handler` (YIELD its result, or ERROR when it throws a `{uri}`). */
  serve(handler: (invocation: Frame) => unknown, filter: (invocation: Frame) => boolean = () => true): void {
    const previous = this.onFrame;
    this.onFrame = (frame) => {
      if (frame[0] === MSG.INVOCATION && filter(frame)) {
        const request = frame[1] as number;
        try {
          const result = handler(frame);
          if (result !== NO_ANSWER) this.send([MSG.YIELD, request, {}, [result]]);
        } catch (error) {
          this.send([MSG.ERROR, MSG.INVOCATION, request, {}, errorUri(error)]);
        }
        return true;
      }
      return previous?.(frame) ?? false;
    };
  }

  async goodbye(ms = 2000): Promise<Frame | undefined> {
    this.send([MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    const reply = await this.next((f) => f[0] === MSG.GOODBYE, ms);
    this.close();
    return reply;
  }

  close(code = 1000): void {
    try {
      this.ws.close(code);
    } catch {
      // already closing
    }
  }
}

function errorUri(error: unknown): string {
  const value = (error as { uri?: unknown } | null)?.uri;
  return typeof value === 'string' ? value : 'wamp.error.runtime_error';
}

/** A `serve` handler result that sends nothing (the test answers itself, or never). */
export const NO_ANSWER: unique symbol = Symbol('no answer');

/** The RESULT (final) or ERROR (types 48 or 49) for call `id`. */
export function isAnswer(frame: Frame, id: number): boolean {
  if (frame[0] === MSG.RESULT) {
    const details = frame[2] as { progress?: unknown } | undefined;
    return frame[1] === id && details?.progress !== true;
  }
  return frame[0] === MSG.ERROR && (frame[1] === MSG.CALL || frame[1] === MSG.CANCEL) && frame[2] === id;
}
