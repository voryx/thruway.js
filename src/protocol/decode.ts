/**
 * Inbound frame validation and normalisation: every deserialized frame is classified header-fatal, payload-invalid
 * (inside a `message` result, see `PayloadInvalid`), normalised or dropped. Never throws.
 *
 * The rule: ABORT only on violations that make the session state unrecoverable. A frame is fatal only when the
 * client cannot tell which request it answers, because then an op could hang.
 * - **fatal**: not an array, empty, type not an integer; WELCOME session, ERROR request type/id, RESULT/PUBLISHED/
 *   SUBSCRIBED/UNSUBSCRIBED/REGISTERED/UNREGISTERED/INVOCATION/INTERRUPT/EVENT ids not ids; CHALLENGE method or ERROR
 *   URI not a string. An ERROR whose request type is an integer the client never sends (Thruway's `[8,8,…]` after
 *   killnowait) answers nothing of ours: it is a message for routing to drop, or dropped here when malformed.
 * - **payload-invalid** (RESULT, ERROR, EVENT, INVOCATION): args neither array nor null, kwargs neither plain object,
 *   null nor `[]`, details neither plain object, null nor `[]`.
 * - **normalised**: missing/`null` args ⇒ `[]`, kwargs and dicts ⇒ `{}`; a dict sent as `[]` (PHP) ⇒ `{}`; trailing
 *   elements ignored; ABORT/GOODBYE reason and details taken from elements 1–2 in either order (wamp-server swaps
 *   them), no reason ⇒ `wamp.error.unknown`; an invalid WELCOME/CHALLENGE/ABORT/GOODBYE/INTERRUPT dict ⇒ `{}` with a
 *   warning; `[35|67, 0, {subscription|registration: id}]` ⇒ revocation.
 * - **dropped**: unknown types (7 HEARTBEAT, 256–1023, …), client-only types, revocations without an id.
 *
 * Received dicts are frozen in place (they are delivered as is: `Session.details`, `EventMessage.details`, …);
 * payloads (args/kwargs) are neither copied nor frozen. Frame texts for diagnostics are redacted like log previews.
 *
 * @module
 */
import { truncateText } from '../errors.js';
import { framePreview } from '../logger.js';
import { CLIENT_ONLY_TYPES, MessageType, Uri } from './codes.js';
import type { DecodeResult, Dict, InboundAbort, InboundGoodbye, InboundMessage, PayloadInvalid } from './messages.js';
import { inboundPayload, isEmptyArray, isPlainObject } from './payload.js';

/** Longest frame text kept for diagnostics (`ProtocolError.frame`, `DecodeResult.frame`). */
export const FRAME_TEXT_LIMIT = 256;

/** Request types whose ERROR can answer something the client sent (49 = Thruway PHP's and Bondy's cancel replies). */
const ANSWERABLE_ERROR_TYPES: ReadonlySet<number> = new Set<number>([
  MessageType.PUBLISH,
  MessageType.SUBSCRIBE,
  MessageType.UNSUBSCRIBE,
  MessageType.CALL,
  MessageType.CANCEL,
  MessageType.REGISTER,
  MessageType.UNREGISTER,
]);

const EMPTY: Dict = Object.freeze({});
const NO_WARNINGS: readonly string[] = Object.freeze([]);

/** Classify one value returned by `serializer.deserialize`. Never throws, whatever `value` is (a frame from a
 *  custom serializer may hold Proxies or throwing getters: reading it then fails as a fatal frame). */
export function decode(value: unknown): DecodeResult {
  try {
    return classify(value);
  } catch {
    return fatal('frame could not be read', value);
  }
}

/** WAMP id: an integer `n` with `0 ≤ n ≤ 2^53` (`Number.isSafeInteger(n) || n === 2 ** 53`). */
export function isId(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value <= 2 ** 53;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

/** The frame as text for diagnostics, truncated to `FRAME_TEXT_LIMIT` chars; never throws (cycles, BigInt, getters).
 *  Secrets are redacted as in log previews (HELLO/WELCOME/CHALLENGE `authextra`, WELCOME `transport`, AUTHENTICATE
 *  signature): the text reaches the app in `ProtocolError.frame`. A string is taken as a text frame (what the core
 *  passes when `deserialize` throws): a JSON array text is previewed redacted, anything else as it is. */
export function frameText(value: unknown): string {
  let text: string;
  try {
    if (Array.isArray(value) || typeof value === 'string') {
      text = framePreview(value);
    } else {
      // Rendered as a one-element frame, whose brackets are then removed (only the opening one when truncated).
      const wrapped = framePreview([value]);
      text = wrapped.slice(1, wrapped.endsWith(']') ? -1 : undefined);
    }
  } catch {
    text = '[unreadable frame]';
  }
  return truncateText(text, FRAME_TEXT_LIMIT);
}

function fatal(reason: string, frame: unknown): DecodeResult {
  return { kind: 'fatal', reason, frame: frameText(frame) };
}

function dropped(reason: string, level: 'debug' | 'warn', frame: unknown): DecodeResult {
  return { kind: 'dropped', reason, level, frame: frameText(frame) };
}

function message(msg: InboundMessage, warnings: readonly string[] = NO_WARNINGS): DecodeResult {
  return { kind: 'message', message: msg, warnings };
}

function classify(value: unknown): DecodeResult {
  if (!Array.isArray(value)) return fatal('frame is not an array', value);
  const frame: readonly unknown[] = value;
  if (frame.length === 0) return fatal('frame is empty', frame);
  const type = frame[0];
  if (!isInteger(type)) return fatal('message type is not an integer', frame);
  switch (type) {
    case MessageType.WELCOME:
      return welcome(frame);
    case MessageType.ABORT:
      return closing(frame, MessageType.ABORT, 'ABORT');
    case MessageType.CHALLENGE:
      return challenge(frame);
    case MessageType.GOODBYE:
      return closing(frame, MessageType.GOODBYE, 'GOODBYE');
    case MessageType.ERROR:
      return error(frame);
    case MessageType.PUBLISHED:
      return published(frame);
    case MessageType.SUBSCRIBED:
      return subscribed(frame);
    case MessageType.UNSUBSCRIBED:
      return unsubscribed(frame);
    case MessageType.EVENT:
      return event(frame);
    case MessageType.RESULT:
      return result(frame);
    case MessageType.REGISTERED:
      return registered(frame);
    case MessageType.UNREGISTERED:
      return unregistered(frame);
    case MessageType.INVOCATION:
      return invocation(frame);
    case MessageType.INTERRUPT:
      return interrupt(frame);
    default: {
      const kind = CLIENT_ONLY_TYPES.has(type) ? 'client-only' : 'unknown';
      return dropped(`${kind} message type ${String(type)}`, 'warn', frame);
    }
  }
}

/** A dict of a frame without payload (WELCOME, CHALLENGE, ABORT, GOODBYE, INTERRUPT): an invalid one becomes `{}`
 *  with a warning. */
function softDict(value: unknown, what: string, warnings: string[]): Dict {
  if (isPlainObject(value)) return Object.freeze(value);
  if (value !== undefined && value !== null && !isEmptyArray(value)) warnings.push(`${what} is not a dict; using {}`);
  return EMPTY;
}

function welcome(frame: readonly unknown[]): DecodeResult {
  const sessionId = frame[1];
  if (!isId(sessionId)) return fatal('WELCOME session is not an id', frame);
  const warnings: string[] = [];
  const details = softDict(frame[2], 'WELCOME details', warnings);
  return message({ type: MessageType.WELCOME, sessionId, details }, warnings);
}

function challenge(frame: readonly unknown[]): DecodeResult {
  const authMethod = frame[1];
  if (typeof authMethod !== 'string') return fatal('CHALLENGE method is not a string', frame);
  const warnings: string[] = [];
  const extra = softDict(frame[2], 'CHALLENGE extra', warnings);
  return message({ type: MessageType.CHALLENGE, authMethod, extra }, warnings);
}

/** ABORT and GOODBYE: never fatal, the connection is ending anyway. */
function closing(
  frame: readonly unknown[],
  type: typeof MessageType.ABORT | typeof MessageType.GOODBYE,
  name: string,
): DecodeResult {
  const first = frame[1];
  const second = frame[2];
  const warnings: string[] = [];
  const reason = typeof first === 'string' ? first : typeof second === 'string' ? second : undefined;
  if (reason === undefined) warnings.push(`${name} has no reason; using ${Uri.UNKNOWN}`);
  const dict = isPlainObject(first) ? first : isPlainObject(second) ? second : undefined;
  if (dict === undefined) {
    const others = reason === undefined ? [first, second] : [typeof first === 'string' ? second : first];
    if (others.some((v) => v !== undefined && v !== null && !isEmptyArray(v))) {
      warnings.push(`${name} details is not a dict; using {}`);
    }
  }
  const msg: InboundAbort | InboundGoodbye = {
    type,
    details: dict === undefined ? EMPTY : Object.freeze(dict),
    reason: reason ?? Uri.UNKNOWN,
  };
  return message(msg, warnings);
}

interface Payload {
  readonly details: Dict;
  readonly args: readonly unknown[];
  readonly kwargs: Dict;
  readonly invalid?: PayloadInvalid;
}

/** Details at `index`, args and kwargs at `argsIndex` and the next element, of a payload-bearing frame. A
 *  payload-invalid frame gets `[]`/`{}` (never to be delivered) and its `invalid` description. */
function payloadAt(frame: readonly unknown[], index: number, argsIndex: number, name: string): Payload {
  const details = frame[index];
  if (details !== undefined && details !== null && !isEmptyArray(details) && !isPlainObject(details)) {
    return invalidPayload(frame, `${name} details is not a dict`);
  }
  const payload = inboundPayload(frame[argsIndex], frame[argsIndex + 1]);
  if ('invalid' in payload) return invalidPayload(frame, `${name} ${payload.invalid.reason}`);
  return {
    details: isPlainObject(details) ? Object.freeze(details) : EMPTY,
    args: payload.args,
    kwargs: payload.kwargs,
  };
}

function invalidPayload(frame: readonly unknown[], reason: string): Payload {
  return { details: EMPTY, args: [], kwargs: {}, invalid: { reason, frame: frameText(frame) } };
}

function error(frame: readonly unknown[]): DecodeResult {
  const requestType = frame[1];
  const requestId = frame[2];
  const uri = frame[4];
  if (!isInteger(requestType)) return fatal('ERROR request type is not an integer', frame);
  if (!isId(requestId) || typeof uri !== 'string') {
    if (!ANSWERABLE_ERROR_TYPES.has(requestType)) {
      return dropped(`ERROR for request type ${String(requestType)} is malformed`, 'warn', frame);
    }
    return fatal(isId(requestId) ? 'ERROR URI is not a string' : 'ERROR request id is not an id', frame);
  }
  return message({ type: MessageType.ERROR, requestType, requestId, error: uri, ...payloadAt(frame, 3, 5, 'ERROR') });
}

function published(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  const publicationId = frame[2];
  if (!isId(requestId)) return fatal('PUBLISHED request id is not an id', frame);
  if (!isId(publicationId)) return fatal('PUBLISHED publication is not an id', frame);
  return message({ type: MessageType.PUBLISHED, requestId, publicationId });
}

function subscribed(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  const subscriptionId = frame[2];
  if (!isId(requestId)) return fatal('SUBSCRIBED request id is not an id', frame);
  if (!isId(subscriptionId)) return fatal('SUBSCRIBED subscription is not an id', frame);
  return message({ type: MessageType.SUBSCRIBED, requestId, subscriptionId });
}

function registered(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  const registrationId = frame[2];
  if (!isId(requestId)) return fatal('REGISTERED request id is not an id', frame);
  if (!isId(registrationId)) return fatal('REGISTERED registration is not an id', frame);
  return message({ type: MessageType.REGISTERED, requestId, registrationId });
}

/** The revocation form `[35|67, 0, {subscription|registration: id, reason?}]`: its details, target id and reason, or a
 *  `dropped` result. `undefined` when the frame is a normal reply. */
function revocation(
  frame: readonly unknown[],
  name: string,
  key: 'subscription' | 'registration',
): { readonly details: Dict; readonly id: number; readonly reason: string | undefined } | DecodeResult | undefined {
  if (frame[1] !== 0 || frame.length < 3) return undefined;
  const details = frame[2];
  if (!isPlainObject(details)) return dropped(`${name} revocation details is not a dict`, 'warn', frame);
  const id = details[key];
  if (!isId(id)) return dropped(`${name} revocation ${key} is not an id`, 'warn', frame);
  const reason = details['reason'];
  return { details: Object.freeze(details), id, reason: typeof reason === 'string' ? reason : undefined };
}

function unsubscribed(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  if (!isId(requestId)) return fatal('UNSUBSCRIBED request id is not an id', frame);
  const revoked = revocation(frame, 'UNSUBSCRIBED', 'subscription');
  if (revoked === undefined) return message({ type: MessageType.UNSUBSCRIBED, revocation: false, requestId });
  if ('kind' in revoked) return revoked;
  return message({
    type: MessageType.UNSUBSCRIBED,
    revocation: true,
    requestId: 0,
    subscriptionId: revoked.id,
    reason: revoked.reason,
    details: revoked.details,
  });
}

function unregistered(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  if (!isId(requestId)) return fatal('UNREGISTERED request id is not an id', frame);
  const revoked = revocation(frame, 'UNREGISTERED', 'registration');
  if (revoked === undefined) return message({ type: MessageType.UNREGISTERED, revocation: false, requestId });
  if ('kind' in revoked) return revoked;
  return message({
    type: MessageType.UNREGISTERED,
    revocation: true,
    requestId: 0,
    registrationId: revoked.id,
    reason: revoked.reason,
    details: revoked.details,
  });
}

function event(frame: readonly unknown[]): DecodeResult {
  const subscriptionId = frame[1];
  const publicationId = frame[2];
  if (!isId(subscriptionId)) return fatal('EVENT subscription is not an id', frame);
  if (!isId(publicationId)) return fatal('EVENT publication is not an id', frame);
  return message({ type: MessageType.EVENT, subscriptionId, publicationId, ...payloadAt(frame, 3, 4, 'EVENT') });
}

function result(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  if (!isId(requestId)) return fatal('RESULT request id is not an id', frame);
  return message({ type: MessageType.RESULT, requestId, ...payloadAt(frame, 2, 3, 'RESULT') });
}

function invocation(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  const registrationId = frame[2];
  if (!isId(requestId)) return fatal('INVOCATION request id is not an id', frame);
  if (!isId(registrationId)) return fatal('INVOCATION registration is not an id', frame);
  return message({
    type: MessageType.INVOCATION,
    requestId,
    registrationId,
    ...payloadAt(frame, 3, 4, 'INVOCATION'),
  });
}

function interrupt(frame: readonly unknown[]): DecodeResult {
  const requestId = frame[1];
  if (!isId(requestId)) return fatal('INTERRUPT request id is not an id', frame);
  const warnings: string[] = [];
  const options = softDict(frame[2], 'INTERRUPT options', warnings);
  return message({ type: MessageType.INTERRUPT, requestId, options }, warnings);
}
