/**
 * Internal: the client-frame oracle of the reference router, which validates every client frame and records violations.
 *
 * Every rule is judged when the client **writes** a frame, against what that client had written and received on the
 * same link so far (its `ClientView`), never against the router's state: a frame that merely crossed one of the
 * router's on the wire (a CALL behind the router's GOODBYE, a YIELD behind an INTERRUPT) is no violation, and a frame
 * the router never sees (it closed first) still is one. The rules are the client's side of the protocol (the frames a
 * client may write, with the URI rules of uri.ts and the 16 MiB frame limit; the invariants INV-CL01, INV-CL02,
 * INV-INVOKE and INV-CANCEL's one CANCEL per CALL with mode killnowait, of test/helpers/invariants.ts) and do not
 * depend on the router's dialect: a quirky router changes what the router does about a frame, never whether the client
 * was allowed to write it.
 *
 * Not judged here (the trace-based checkers of test/helpers/invariants.ts own them, they need to know when the client
 * *processed* a frame, not when it was delivered, or what the app unsubscribed): INV-CANCEL's "never after the final
 * RESULT", and request ids reused after a client forgot them on purpose (a cancelled CALL, a CALL failed by a
 * payload-invalid RESULT, an acknowledged PUBLISH the app unsubscribed, a late SUBSCRIBE/REGISTER it gave up on).
 *
 * @module
 */
import { MessageType as T, Uri } from '../protocol/codes.js';
import { MAX_FRAME_BYTES } from '../protocol/messages.js';
import { inboundPayload, isPlainObject } from '../protocol/payload.js';
import { isValidUri } from '../protocol/uri.js';

/** Stable codes of the oracle's rules (`Violation.code`); `ORACLE_RULES` describes each. */
export type ViolationCode =
  | 'not-an-array'
  | 'type-not-integer'
  | 'frame-too-large'
  | 'after-end'
  | 'after-router-goodbye'
  | 'before-hello'
  | 'second-hello'
  | 'hello-malformed'
  | 'hello-without-roles'
  | 'authenticate-without-challenge'
  | 'authenticate-after-welcome'
  | 'authenticate-malformed'
  | 'before-welcome'
  | 'not-a-client-message'
  | 'malformed'
  | 'invalid-uri'
  | 'request-id-in-flight'
  | 'cancel-unknown-call'
  | 'cancel-twice'
  | 'cancel-mode'
  | 'unsubscribe-unknown-id'
  | 'unregister-unknown-id'
  | 'error-not-for-invocation'
  | 'answer-unknown-invocation'
  | 'answer-after-final'
  | 'answer-after-killnowait'
  | 'unrequested-progress';

/** What each rule forbids (in brackets: the invariant it is part of, if any). */
export const ORACLE_RULES: Readonly<Record<ViolationCode, string>> = Object.freeze({
  'not-an-array': 'a frame that is not a JSON array (raw text, another JSON value, invalid UTF-8)',
  'type-not-integer': 'a frame whose message type is not an integer',
  'frame-too-large': 'a frame larger than 16 MiB (UTF-8 bytes of the text, or the binary length)',
  'after-end': "anything after the client's GOODBYE or ABORT, or after a received ABORT [INV-CL01]",
  'after-router-goodbye': "anything but the single GOODBYE reply after the router's GOODBYE [INV-CL01]",
  'before-hello': 'anything but HELLO as the first frame [INV-CL01]',
  'second-hello': 'a second HELLO on a connection [INV-AUTH]',
  'hello-malformed': 'a HELLO whose realm is not a string or whose details are not a dict',
  'hello-without-roles': 'a HELLO without roles',
  'authenticate-without-challenge': 'AUTHENTICATE without an unanswered CHALLENGE [INV-AUTH]',
  'authenticate-after-welcome': 'AUTHENTICATE in a session [INV-AUTH]',
  'authenticate-malformed': 'AUTHENTICATE whose signature is not a string or whose extra is not a dict',
  'before-welcome': 'anything but AUTHENTICATE or ABORT between HELLO and WELCOME [INV-CL01]',
  'not-a-client-message': 'a message type a client never sends in a session (router-only or unknown)',
  malformed:
    'a request, answer, GOODBYE or ABORT with a bad shape: request id outside [1, 2^53], options or details not a dict, a URI or reason that is not a string, args not an array, kwargs not a dict',
  'invalid-uri':
    'a URI that breaks the rule of its match policy; an ERROR, GOODBYE or ABORT reason that breaks the exact rule',
  'request-id-in-flight':
    'a request id that a CALL still in flight on this connection uses (no final or payload-invalid RESULT/ERROR yet, not cancelled) [INV-CL02]',
  'cancel-unknown-call': 'a CANCEL for a CALL never written on this connection [INV-CL02]',
  'cancel-twice': 'a second CANCEL of one CALL [INV-CANCEL]',
  'cancel-mode': "a CANCEL whose options do not say mode 'killnowait' [INV-CANCEL]",
  'unsubscribe-unknown-id': 'UNSUBSCRIBE of a subscription id never received on this connection [INV-CL02]',
  'unregister-unknown-id': 'UNREGISTER of a registration id never received on this connection [INV-CL02]',
  'error-not-for-invocation': 'an ERROR for a request type other than INVOCATION',
  'answer-unknown-invocation': 'YIELD/ERROR for an INVOCATION never received on this connection [INV-CL02]',
  'answer-after-final': 'YIELD/ERROR after the final answer of that INVOCATION [INV-INVOKE]',
  'answer-after-killnowait': 'YIELD/ERROR after an INTERRUPT killnowait for that INVOCATION [INV-INVOKE]',
  'unrequested-progress': 'a progress YIELD for an INVOCATION that did not ask for progress [INV-INVOKE]',
});

export interface Judgement {
  readonly code: ViolationCode;
  readonly rule: string;
}

type Frame = readonly unknown[];

/** The client's side of one link, built from the frames it wrote and the ones dispatched to it. */
export interface ClientView {
  sentHello: boolean;
  /** CHALLENGEs received minus AUTHENTICATEs sent. */
  unanswered: number;
  welcomed: boolean;
  /** The client sent GOODBYE/ABORT, or received ABORT: nothing may follow. */
  ended: 'goodbye' | 'abort' | 'router abort' | undefined;
  /** The router's GOODBYE reached the client: one GOODBYE reply may follow. */
  goodbyeReceived: boolean;
  /** CALL ids the client wrote on this link, and those of them it has CANCELed since (INV-CL02). */
  readonly calls: Set<unknown>;
  readonly cancelled: Set<unknown>;
  /** CALL ids the client may not reuse yet: CALLs (not the liveness probe) without a final answer that were not
   *  cancelled. Not tracked, because the client may forget them without a frame the router sees: acknowledged
   *  PUBLISHes (an unsubscribed one is forgotten), SUBSCRIBE/REGISTER/UN* (late ones are forgotten). */
  readonly inFlight: Set<unknown>;
  /** Subscription and registration ids received on this link (INV-CL02): in SUBSCRIBED/REGISTERED, and in an EVENT or
   *  an INVOCATION, whose id the router uses for this session too (the client withdraws a registration it is invoked
   *  for but holds no record of). */
  readonly subscriptions: Set<unknown>;
  readonly registrations: Set<unknown>;
  /** INVOCATION ids the client received (true: it asked for progress); those it gave its final answer (YIELD without
   *  progress, or ERROR), and those it received an INTERRUPT killnowait for: nothing more may be written for either
   *  (INV-INVOKE). */
  readonly invocations: Map<unknown, boolean>;
  readonly answered: Set<unknown>;
  readonly interrupted: Set<unknown>;
}

export function createClientView(): ClientView {
  return {
    sentHello: false,
    unanswered: 0,
    welcomed: false,
    ended: undefined,
    goodbyeReceived: false,
    calls: new Set(),
    cancelled: new Set(),
    inFlight: new Set(),
    subscriptions: new Set(),
    registrations: new Set(),
    invocations: new Map(),
    answered: new Set(),
    interrupted: new Set(),
  };
}

const TYPE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

export function typeName(type: number): string {
  return TYPE_NAMES[type] ?? `type ${String(type)}`;
}

/** WAMP id: an integer in [1, 2^53]. */
export function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 2 ** 53;
}

/** A payload tail `args?, kwargs?`: absent/null or an array, absent/null or a dict. */
export function validPayload(frame: Frame, at: number): boolean {
  const args = frame[at];
  const kwargs = frame[at + 1];
  return (
    (args === undefined || args === null || Array.isArray(args)) &&
    (kwargs === undefined || kwargs === null || isPlainObject(kwargs))
  );
}

/** `value[key]` of a decoded JSON value (undefined for null and undefined). */
function read(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key];
}

/** The INVOCATION id a well-formed YIELD `[70, id, options, args?, kwargs?]` or ERROR `[8, 68, id, details, uri,
 *  args?, kwargs?]` answers; undefined for a malformed one. */
export function answerId(frame: Frame): number | undefined {
  const isError = frame[0] === T.ERROR;
  const id = frame[isError ? 2 : 1];
  const shape = isError
    ? isPlainObject(frame[3]) && typeof frame[4] === 'string' && validPayload(frame, 5)
    : isPlainObject(frame[2]) && validPayload(frame, 3);
  return isId(id) && shape ? id : undefined;
}

function match(options: unknown): string {
  const value = read(options, 'match');
  return typeof value === 'string' ? value : 'exact';
}

/** Judge a frame the client is writing (`frame`: decoded, or the raw text when it is not a JSON array; `bytes`: its
 *  size as it travels) and update the view. Returns the broken rules (usually none, at most a couple). */
export function judgeWrite(view: ClientView, frame: Frame | string, bytes = 0): Judgement[] {
  const out: Judgement[] = [];
  const flag = (code: ViolationCode, rule: string): void => {
    out.push({ code, rule });
  };
  // (judged on its own: the frame is still read, as the router reads it)
  if (bytes > MAX_FRAME_BYTES) flag('frame-too-large', `a frame of ${String(bytes)} bytes (the limit is 16 MiB)`);
  if (typeof frame === 'string') {
    flag('not-an-array', 'the frame is not a JSON array');
    return out;
  }
  const type = frame[0] as number;
  if (!Number.isInteger(type)) {
    flag('type-not-integer', 'the message type is not an integer');
    return out;
  }
  const name = typeName(type);
  if (view.ended !== undefined) {
    const by = view.ended === 'router abort' ? "the router's ABORT" : `the client's ${view.ended.toUpperCase()}`;
    flag('after-end', `${name} after ${by}`);
    return out;
  }
  if (view.goodbyeReceived) {
    if (type === T.GOODBYE) view.ended = 'goodbye';
    else flag('after-router-goodbye', `${name} after the router's GOODBYE (only the GOODBYE reply may follow)`);
    return out;
  }
  if (type === T.ABORT || type === T.GOODBYE) view.ended = type === T.ABORT ? 'abort' : 'goodbye';
  if (!view.sentHello) {
    if (type !== T.HELLO) {
      flag('before-hello', `${name} before HELLO`);
      return out;
    }
    view.sentHello = true;
    const details = frame[2];
    if (typeof frame[1] !== 'string' || !isPlainObject(details)) flag('hello-malformed', 'malformed HELLO');
    else if (!isPlainObject(details['roles']) || Object.keys(details['roles']).length === 0)
      flag('hello-without-roles', 'HELLO without roles');
  } else if (type === T.HELLO) {
    flag('second-hello', 'a second HELLO');
  } else if (type === T.AUTHENTICATE) {
    if (view.welcomed) flag('authenticate-after-welcome', 'AUTHENTICATE after WELCOME');
    else if (view.unanswered === 0) flag('authenticate-without-challenge', 'AUTHENTICATE without a CHALLENGE');
    else {
      view.unanswered--;
      if (typeof frame[1] !== 'string' || !isPlainObject(frame[2]))
        flag('authenticate-malformed', 'malformed AUTHENTICATE');
    }
  } else if (!view.welcomed && type !== T.ABORT) {
    flag('before-welcome', `${name} before WELCOME`);
  } else if (type === T.ABORT || type === T.GOODBYE) {
    judgeClosing(frame, name, flag);
  } else {
    judgeSessionFrame(view, frame, type, name, flag);
  }
  return out;
}

/** GOODBYE `[6, details, reason]` and ABORT `[3, details, reason]`: a dict and a URI. */
function judgeClosing(frame: Frame, name: string, flag: (code: ViolationCode, rule: string) => void): void {
  const reason = frame[2];
  if (!isPlainObject(frame[1]) || typeof reason !== 'string') flag('malformed', `malformed ${name}`);
  else if (!isValidUri(reason)) flag('invalid-uri', `${name} with an invalid reason ${JSON.stringify(reason)}`);
}

/** The per-message rules of a frame written in a session. */
function judgeSessionFrame(
  view: ClientView,
  frame: Frame,
  type: number,
  name: string,
  flag: (code: ViolationCode, rule: string) => void,
): void {
  const malformed = (): void => {
    flag('malformed', `malformed ${name}`);
  };
  const uri = (value: unknown, policy: string): void => {
    if (!isValidUri(value as string, policy))
      flag('invalid-uri', `${name} with an invalid URI ${JSON.stringify(value)}`);
  };
  const request = (shape: boolean): boolean => {
    if (!isId(frame[1]) || !shape) {
      malformed();
      return false;
    }
    if (view.inFlight.has(frame[1])) {
      flag(
        'request-id-in-flight',
        type === T.CALL
          ? 'CALL with a request id that is still in flight'
          : `${name} with request id ${String(frame[1])}, which a CALL still in flight uses`,
      );
    }
    return true;
  };
  switch (type) {
    case T.SUBSCRIBE:
    case T.REGISTER:
      if (request(isPlainObject(frame[2]) && typeof frame[3] === 'string')) uri(frame[3], match(frame[2]));
      return;
    case T.UNSUBSCRIBE:
    case T.UNREGISTER: {
      if (!request(isId(frame[2]))) return;
      const subscribe = type === T.UNSUBSCRIBE;
      if (!(subscribe ? view.subscriptions : view.registrations).has(frame[2])) {
        const what = subscribe ? 'subscription' : 'registration';
        flag(
          subscribe ? 'unsubscribe-unknown-id' : 'unregister-unknown-id',
          `${name} of a ${what} id this session was never given`,
        );
      }
      return;
    }
    case T.PUBLISH:
      if (request(isPlainObject(frame[2]) && typeof frame[3] === 'string' && validPayload(frame, 4)))
        uri(frame[3], 'exact');
      return;
    case T.CALL:
      if (!request(isPlainObject(frame[2]) && typeof frame[3] === 'string' && validPayload(frame, 4))) return;
      view.calls.add(frame[1]);
      view.cancelled.delete(frame[1]); // a new CALL with this id (the old one finished)
      if (frame[3] !== Uri.PING_PROCEDURE)
        view.inFlight.add(frame[1]); // liveness may forget its probe
      else view.inFlight.delete(frame[1]);
      uri(frame[3], 'exact');
      return;
    case T.CANCEL: {
      if (!isId(frame[1]) || !isPlainObject(frame[2])) {
        malformed();
        return;
      }
      const id = frame[1];
      if (!view.calls.has(id))
        flag('cancel-unknown-call', `CANCEL of CALL ${String(id)}, never written on this connection`);
      else if (view.cancelled.has(id)) flag('cancel-twice', `a second CANCEL of CALL ${String(id)}`);
      const mode = read(frame[2], 'mode');
      if (mode !== 'killnowait')
        flag('cancel-mode', `CANCEL with mode ${mode === undefined ? '(none)' : JSON.stringify(mode)}`);
      view.cancelled.add(id);
      view.inFlight.delete(id); // cancelled: the client may forget it
      return;
    }
    case T.YIELD:
    case T.ERROR:
      judgeAnswer(view, frame, name, flag);
      return;
    default:
      flag('not-a-client-message', `${name} is not a message a client sends in a session`);
  }
}

/** YIELD or ERROR (INV-INVOKE). */
function judgeAnswer(
  view: ClientView,
  frame: Frame,
  name: string,
  flag: (code: ViolationCode, rule: string) => void,
): void {
  if (frame[0] === T.ERROR && frame[1] !== T.INVOCATION) {
    flag('error-not-for-invocation', `ERROR for request type ${String(frame[1])} (a client only answers INVOCATIONs)`);
    return;
  }
  const id = answerId(frame);
  if (id === undefined) {
    flag('malformed', `malformed ${name}`);
    return;
  }
  // a handler's error URI uses the exact rule (Crossbar closes the callee's connection for an invalid one)
  if (frame[0] === T.ERROR && !isValidUri(frame[4] as string))
    flag('invalid-uri', `ERROR with an invalid URI ${JSON.stringify(frame[4])}`);
  const progressAsked = view.invocations.get(id);
  if (progressAsked === undefined) {
    flag('answer-unknown-invocation', `${name} for an INVOCATION this session never received`);
    return;
  }
  // a progress YIELD is not final (`progress` in its options; an ERROR's element 2 is its id, never a dict)
  const progress = read(frame[2], 'progress') === true;
  if (view.answered.has(id)) {
    flag('answer-after-final', `${name} for INVOCATION ${String(id)} after its final answer`);
  } else if (view.interrupted.has(id)) {
    flag('answer-after-killnowait', `${name} for INVOCATION ${String(id)} after its INTERRUPT killnowait`);
  } else if (progress && !progressAsked) {
    flag('unrequested-progress', 'progress YIELD although the INVOCATION did not ask for progress');
  }
  if (!progress) view.answered.add(id);
}

/** Update the view with a frame dispatched to the client. */
export function observeReceived(view: ClientView, frame: Frame | string): void {
  switch (frame[0]) {
    // (a raw text frame's [0] is a character: no case)
    case T.CHALLENGE:
      view.unanswered++;
      return;
    case T.WELCOME:
      view.welcomed = true;
      return;
    case T.GOODBYE:
      // In a session: the router's GOODBYE, which one reply may answer (if the client had sent its own GOODBYE, it
      // is the reply to it and `ended` already forbids everything). Before WELCOME no reply is allowed: like ABORT.
      if (view.welcomed) view.goodbyeReceived = true;
      else view.ended = view.ended ?? 'router abort';
      return;
    case T.ABORT:
      view.ended = view.ended ?? 'router abort';
      return;
    case T.SUBSCRIBED:
      view.subscriptions.add(frame[2]);
      return;
    case T.REGISTERED:
      view.registrations.add(frame[2]);
      return;
    case T.RESULT:
      // The final RESULT ends the call; so does a payload-invalid progress RESULT (the client fails the call)
      if (read(frame[2], 'progress') !== true || 'invalid' in inboundPayload(frame[3], frame[4]))
        view.inFlight.delete(frame[1]);
      return;
    case T.ERROR:
      // ERROR(49) answers the CALL with that id too (Thruway PHP T2, Bondy; the client settles the call on it)
      if (frame[1] === T.CALL || frame[1] === T.CANCEL) view.inFlight.delete(frame[2]);
      return;
    case T.EVENT:
      view.subscriptions.add(frame[1]);
      return;
    case T.INVOCATION:
      view.invocations.set(frame[1], read(frame[3], 'receive_progress') === true);
      view.registrations.add(frame[2]);
      return;
    case T.INTERRUPT:
      if (read(frame[2], 'mode') === 'killnowait') view.interrupted.add(frame[1]);
      return;
  }
}
