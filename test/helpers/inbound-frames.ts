// Inbound frame specs and an independent classification oracle for the decoder's inbound rules. Used by
// test/unit/decode.test.ts (the table) and test/fuzz/decode.fuzz.test.ts (random mutations); other inbound-frame
// fuzzing can reuse the specs. The oracle is written from the rules below, not from src/protocol/decode.ts: it only
// shares the WAMP type codes.
//
// Each router→client type is described field by field (after element 0). A field's kind decides what a value there
// does to the frame:
//   id           integer 0 ≤ n ≤ 2^53, else header-fatal
//   requestType  ERROR request type: integer, else header-fatal; an integer the client never sends makes a malformed
//                ERROR dropped instead of fatal
//   string       a string, else header-fatal
//   softDict     dict of a frame without payload: plain object kept; null/missing/[] ⇒ {}; anything else ⇒ {} + warning
//   details      dict of a payload frame: plain object kept; null/missing/[] ⇒ {}; anything else ⇒ payload-invalid
//   args         array kept; null/missing ⇒ []; anything else ⇒ payload-invalid
//   kwargs       plain object kept; null/missing/[] ⇒ {}; anything else ⇒ payload-invalid
// ABORT/GOODBYE (reason and details in either order) and the UNSUBSCRIBED/UNREGISTERED revocation form are special
// cased below.

export type FieldKind = 'id' | 'requestType' | 'string' | 'softDict' | 'details' | 'args' | 'kwargs';

export interface FieldSpec {
  /** The property of the decoded message that holds this field. */
  readonly prop: string;
  readonly kind: FieldKind;
  /** A valid value, used to build the base frame. */
  readonly valid: unknown;
}

export interface FrameSpec {
  readonly name: string;
  readonly type: number;
  readonly fields: readonly FieldSpec[];
}

const id = (prop: string, valid: number): FieldSpec => ({ prop, kind: 'id', valid });
const field = (prop: string, kind: FieldKind, valid: unknown): FieldSpec => ({ prop, kind, valid });

/** Every router→client type except ABORT/GOODBYE (see CLOSING_TYPES). */
export const FRAME_SPECS: readonly FrameSpec[] = [
  {
    name: 'WELCOME',
    type: 2,
    fields: [id('sessionId', 4242), field('details', 'softDict', { roles: { broker: {} } })],
  },
  { name: 'CHALLENGE', type: 4, fields: [field('authMethod', 'string', 'wampcra'), field('extra', 'softDict', {})] },
  {
    name: 'ERROR',
    type: 8,
    fields: [
      field('requestType', 'requestType', 48),
      id('requestId', 7),
      field('details', 'details', { x: 1 }),
      field('error', 'string', 'wamp.error.not_authorized'),
      field('args', 'args', ['nope']),
      field('kwargs', 'kwargs', { why: 'x' }),
    ],
  },
  { name: 'PUBLISHED', type: 17, fields: [id('requestId', 7), id('publicationId', 1234)] },
  { name: 'SUBSCRIBED', type: 33, fields: [id('requestId', 7), id('subscriptionId', 99)] },
  { name: 'UNSUBSCRIBED', type: 35, fields: [id('requestId', 7)] },
  {
    name: 'EVENT',
    type: 36,
    fields: [
      id('subscriptionId', 99),
      id('publicationId', 5),
      field('details', 'details', { topic: 'a.b' }),
      field('args', 'args', [1, 'two']),
      field('kwargs', 'kwargs', { three: 3 }),
    ],
  },
  {
    name: 'RESULT',
    type: 50,
    fields: [
      id('requestId', 7),
      field('details', 'details', { progress: true }),
      field('args', 'args', [{ a: 1 }]),
      field('kwargs', 'kwargs', { b: [2] }),
    ],
  },
  { name: 'REGISTERED', type: 65, fields: [id('requestId', 7), id('registrationId', 77)] },
  { name: 'UNREGISTERED', type: 67, fields: [id('requestId', 7)] },
  {
    name: 'INVOCATION',
    type: 68,
    fields: [
      id('requestId', 8),
      id('registrationId', 77),
      field('details', 'details', { receive_progress: true }),
      field('args', 'args', [42]),
      field('kwargs', 'kwargs', { k: 'v' }),
    ],
  },
  { name: 'INTERRUPT', type: 69, fields: [id('requestId', 8), field('options', 'softDict', { mode: 'kill' })] },
];

export const CLOSING_TYPES = [
  { name: 'ABORT', type: 3 },
  { name: 'GOODBYE', type: 6 },
] as const;

/** Request types whose ERROR answers something a client sends (16, 32, 34, 48, 49 (Thruway T2), 64, 66). */
export const ANSWERABLE_REQUEST_TYPES: readonly number[] = [16, 32, 34, 48, 49, 64, 66];
/** Types only clients send. */
export const CLIENT_ONLY: readonly number[] = [1, 5, 16, 32, 34, 48, 49, 64, 66, 70];

/** Hand-picked values per kind: valid ones, normalised ones, invalid ones. */
export const MUTATIONS: Readonly<Record<FieldKind, readonly unknown[]>> = {
  id: [0, -0, 1, 2 ** 53 - 1, 2 ** 53, -1, 1.5, 2 ** 53 + 2, 1e300, '7', null, true, {}, [], [7], NaN, Infinity],
  requestType: [16, 32, 34, 48, 49, 64, 66, 8, 68, 70, 0, -1, 1024, '48', 48.5, null, NaN, {}, []],
  string: ['', 'x', 'wamp.error.canceled', 1, null, true, {}, [], ['x']],
  softDict: [{}, { a: 1 }, Object.create(null) as unknown, null, [], 'x', 1, true, [1], [{}], new Date(0)],
  details: [{}, { a: 1 }, null, [], 'x', 1, true, [1], [{}], new Map()],
  args: [[], [1], [null], [[]], null, {}, { 0: 'a', 2: 'c' }, 'x', 1, true, new Uint8Array(1)],
  kwargs: [{}, { a: 1 }, Object.create(null) as unknown, null, [], [1], [{}], 'x', 1, true, new Map()],
};

// ---------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------

export type Expected =
  | { readonly kind: 'fatal' }
  | { readonly kind: 'dropped' }
  | {
      readonly kind: 'message';
      /** Payload-invalid: args/kwargs/details replaced by []/{}. */
      readonly invalid: boolean;
      readonly warnings: number;
      /** The decoded message's properties (type included). */
      readonly fields: Readonly<Record<string, unknown>>;
    };

export function isWampId(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2 ** 53;
}

export function isPlain(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

function absentDict(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

/** What decode() must make of `frame`, a frame of `spec` whose elements may have been changed or cut off. */
export function expectedFor(spec: FrameSpec, frame: readonly unknown[]): Expected {
  const at = (i: number): unknown => frame[i + 1];
  if (spec.type === 35 || spec.type === 67) {
    const revocation = expectedRevocation(spec, frame);
    if (revocation !== undefined) return revocation;
  }
  // header fields first: the frame is fatal unless the client can tell what it answers
  const malformed = spec.fields.some(
    (f, i) => (f.kind === 'id' && !isWampId(at(i))) || (f.kind === 'string' && typeof at(i) !== 'string'),
  );
  if (spec.type === 8) {
    const requestType = at(0);
    if (typeof requestType !== 'number' || !Number.isInteger(requestType)) return { kind: 'fatal' };
    if (malformed) return ANSWERABLE_REQUEST_TYPES.includes(requestType) ? { kind: 'fatal' } : { kind: 'dropped' };
  }
  if (malformed) return { kind: 'fatal' };

  const fields: Record<string, unknown> = { type: spec.type };
  let invalid = false;
  let warnings = 0;
  for (const [i, f] of spec.fields.entries()) {
    const v = at(i);
    switch (f.kind) {
      case 'id':
      case 'requestType':
      case 'string':
        fields[f.prop] = v;
        break;
      case 'softDict':
        if (!isPlain(v) && !absentDict(v)) warnings++;
        fields[f.prop] = isPlain(v) ? v : {};
        break;
      case 'details':
        if (!isPlain(v) && !absentDict(v)) invalid = true;
        fields[f.prop] = isPlain(v) ? v : {};
        break;
      case 'args':
        if (!Array.isArray(v) && v !== undefined && v !== null) invalid = true;
        fields[f.prop] = Array.isArray(v) ? v : [];
        break;
      case 'kwargs':
        if (!isPlain(v) && !absentDict(v)) invalid = true;
        fields[f.prop] = isPlain(v) ? v : {};
        break;
    }
  }
  if (invalid) {
    for (const f of spec.fields) {
      if (f.kind === 'details' || f.kind === 'kwargs') fields[f.prop] = {};
      if (f.kind === 'args') fields[f.prop] = [];
    }
  }
  if (spec.type === 35 || spec.type === 67) fields['revocation'] = false;
  return { kind: 'message', invalid, warnings, fields };
}

function expectedRevocation(spec: FrameSpec, frame: readonly unknown[]): Expected | undefined {
  if (!(frame[1] === 0 && frame.length >= 3)) return undefined;
  const details = frame[2];
  const key = spec.type === 35 ? 'subscription' : 'registration';
  if (!isPlain(details)) return { kind: 'dropped' };
  const target = (details as Record<string, unknown>)[key];
  if (!isWampId(target)) return { kind: 'dropped' };
  const reason = (details as Record<string, unknown>)['reason'];
  return {
    kind: 'message',
    invalid: false,
    warnings: 0,
    fields: {
      type: spec.type,
      revocation: true,
      requestId: 0,
      [spec.type === 35 ? 'subscriptionId' : 'registrationId']: target,
      reason: typeof reason === 'string' ? reason : undefined,
      details,
    },
  };
}

/** ABORT/GOODBYE: reason = the first string of elements 1–2 (else `wamp.error.unknown`, warned), details = the first
 *  plain object of them (else {}, warned unless the element in the details slot is absent, null or []). */
export function expectedClosing(type: number, frame: readonly unknown[]): Expected {
  const [, first, second] = frame;
  const reason = typeof first === 'string' ? first : typeof second === 'string' ? second : undefined;
  const dict = isPlain(first) ? first : isPlain(second) ? second : undefined;
  let warnings = reason === undefined ? 1 : 0;
  if (dict === undefined) {
    const others = reason === undefined ? [first, second] : [typeof first === 'string' ? second : first];
    if (others.some((v) => !absentDict(v))) warnings++;
  }
  return {
    kind: 'message',
    invalid: false,
    warnings,
    fields: { type, reason: reason ?? 'wamp.error.unknown', details: dict ?? {} },
  };
}

/** The base frame of a spec: every field valid. */
export function baseFrame(spec: FrameSpec): unknown[] {
  return [spec.type, ...spec.fields.map((f) => structuredClone(f.valid))];
}
