// decode() fuzzing: it never throws — on arbitrary JS values, arbitrary JSON values, arbitrary strings through the JSON
// serializer, and hostile frames from a custom serializer — every result is well formed, and frames built from the
// inbound specs with random mutations get exactly the class the independent oracle of test/helpers/inbound-frames.ts
// predicts by construction.
import { fc } from '@fast-check/vitest';
import { describe, expect, test, vi } from 'vitest';
import { decode, FRAME_TEXT_LIMIT, isId } from '../../src/protocol/decode.js';
import type { DecodeResult } from '../../src/protocol/messages.js';
import { jsonSerializer } from '../../src/transport/json.js';
import {
  baseFrame,
  CLOSING_TYPES,
  expectedClosing,
  expectedFor,
  FRAME_SPECS,
  isPlain,
  MUTATIONS,
  type FieldKind,
  type FrameSpec,
} from '../helpers/inbound-frames.js';
import { replayParameters } from '../setup-fast-check.js';

// The time budget scales with FC_NUM_RUNS: 2 ms per run and property, never below the default 5 s.
vi.setConfig({ testTimeout: Math.max(5000, Number(process.env['FC_NUM_RUNS'] ?? 100) * 2) });

const serializer = jsonSerializer();
const binarySerializer = jsonSerializer({ binary: true });

/** Every DecodeResult must look like this, whatever went in. */
function wellFormed(result: DecodeResult): void {
  if (result.kind === 'fatal' || result.kind === 'dropped') {
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(typeof result.frame).toBe('string');
    expect(result.frame.length).toBeLessThanOrEqual(FRAME_TEXT_LIMIT);
    if (result.kind === 'dropped') expect(['debug', 'warn']).toContain(result.level);
    return;
  }
  expect(result.kind).toBe('message');
  for (const w of result.warnings) expect(typeof w).toBe('string');
  const msg = result.message as unknown as Record<string, unknown>;
  for (const key of ['sessionId', 'requestId', 'publicationId', 'subscriptionId', 'registrationId']) {
    if (key in msg) expect(isId(msg[key])).toBe(true);
  }
  for (const key of ['details', 'extra', 'options']) {
    if (key in msg) {
      expect(isPlain(msg[key])).toBe(true);
      expect(Object.isFrozen(msg[key])).toBe(true);
    }
  }
  if ('args' in msg) expect(Array.isArray(msg['args'])).toBe(true);
  if ('kwargs' in msg) expect(isPlain(msg['kwargs'])).toBe(true);
  if ('reason' in msg && msg['type'] !== 35 && msg['type'] !== 67) expect(typeof msg['reason']).toBe('string');
  if ('invalid' in msg) {
    const invalid = msg['invalid'] as { reason: unknown; frame: unknown };
    expect(typeof invalid.reason).toBe('string');
    expect(typeof invalid.frame).toBe('string');
    expect(msg['args']).toEqual([]);
    expect(msg['kwargs']).toEqual({});
  }
}

function decodeSafely(value: unknown): DecodeResult {
  let result: DecodeResult | undefined;
  expect(() => {
    result = decode(value);
  }).not.toThrow();
  wellFormed(result!);
  return result!;
}

const anything = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
  maxDepth: 3,
});

/** A small integer type code biased toward the codes that exist. */
const typeCode = fc.oneof(
  fc.constantFrom(1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 32, 33, 34, 35, 36, 48, 49, 50, 64, 65, 66, 67, 68, 69, 70),
  fc.integer({ min: -2, max: 1100 }),
);

describe('decode never throws', () => {
  test('on arbitrary values', () => {
    fc.assert(
      fc.property(anything, (value) => {
        decodeSafely(value);
      }),
      replayParameters(),
    );
  });

  test('on arrays of arbitrary values headed by a type code', () => {
    fc.assert(
      fc.property(typeCode, fc.array(anything, { maxLength: 8 }), (type, rest) => {
        decodeSafely([type, ...rest]);
      }),
      replayParameters(),
    );
  });

  test('on arbitrary JSON values, also after a JSON round trip, with the same verdict', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.tuple(typeCode, fc.jsonValue(), fc.jsonValue(), fc.jsonValue())), (v) => {
        const once = decodeSafely(v);
        const again = decodeSafely(JSON.parse(JSON.stringify(v)) as unknown);
        expect(again.kind).toBe(once.kind);
      }),
      replayParameters(),
    );
  });

  test('on arbitrary strings through the JSON serializer (a deserialize throw is header-fatal for the core)', () => {
    const text = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 64 }),
      fc.string({ unit: fc.constantFrom(...'[]{},:"\\0123456789-.eEtrufalsnNIiy '.split('')), maxLength: 48 }),
      fc
        .tuple(typeCode, fc.jsonValue(), fc.jsonValue())
        .chain(([t, a, b]) => fc.tuple(fc.constant(JSON.stringify([t, a, b])), fc.nat(), fc.string({ maxLength: 3 })))
        .map(
          ([json, at, insert]) => json.slice(0, at % (json.length + 1)) + insert + json.slice(at % (json.length + 1)),
        ),
    );
    fc.assert(
      fc.property(text, (s) => {
        for (const ser of [serializer, binarySerializer]) {
          let value: unknown;
          try {
            value = ser.deserialize(s);
          } catch {
            continue;
          }
          decodeSafely(value);
        }
      }),
      replayParameters(),
    );
  });

  test('on frames from a custom serializer whose elements are hostile Proxies or throwing getters', () => {
    type Trap = 'get' | 'getPrototypeOf' | 'ownKeys' | 'preventExtensions';
    const hostile = (target: object, trap: Trap): object =>
      new Proxy(target, {
        [trap]: () => {
          throw new Error(`hostile ${trap}`);
        },
      });
    fc.assert(
      fc.property(
        fc.constantFrom(...FRAME_SPECS),
        fc.nat(),
        fc.constantFrom<Trap>('get', 'getPrototypeOf', 'ownKeys', 'preventExtensions'),
        fc.boolean(),
        (spec, at, trap, wrapFrame) => {
          const frame = baseFrame(spec);
          const index = 1 + (at % (frame.length - 1));
          frame[index] = hostile(Array.isArray(frame[index]) ? [] : {}, trap);
          decodeSafely(wrapFrame ? hostile(frame, trap) : frame);
          const getter = baseFrame(spec);
          Object.defineProperty(getter, index, {
            enumerable: true,
            get: () => {
              throw new Error('getter');
            },
          });
          expect(decodeSafely(getter).kind).toBe('fatal');
        },
      ),
      replayParameters(),
    );
  });
});

describe('classification oracle (tagged by construction)', () => {
  /** A replacement value for a field of this kind: one of the table's values, or something arbitrary. */
  const valueFor = (kind: FieldKind): fc.Arbitrary<unknown> =>
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...MUTATIONS[kind]) },
      { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
      { weight: 1, arbitrary: fc.integer({ min: -3, max: 2 ** 53 + 4 }) },
    );

  const mutatedFrame = fc
    .constantFrom(...FRAME_SPECS)
    .chain((spec: FrameSpec) =>
      fc.tuple(
        fc.constant(spec),
        fc.tuple(...spec.fields.map((f) => fc.option(valueFor(f.kind), { nil: undefined, freq: 2 }))),
        fc.integer({ min: 1, max: spec.fields.length + 3 }),
      ),
    );

  test('every inbound type: random field mutations and lengths', () => {
    fc.assert(
      fc.property(mutatedFrame, ([spec, replacements, length]) => {
        const frame = baseFrame(spec);
        replacements.forEach((value, i) => {
          if (value !== undefined) frame[i + 1] = value;
        });
        const cut = frame.slice(0, length);
        while (cut.length < length) cut.push('trailing');
        const expected = expectedFor(spec, cut);
        const result = decodeSafely(cut);
        expect(result.kind).toBe(expected.kind);
        if (result.kind === 'message' && expected.kind === 'message') {
          const { invalid, ...fields } = result.message as unknown as Record<string, unknown>;
          expect(fields).toEqual(expected.fields);
          expect(invalid !== undefined).toBe(expected.invalid);
          expect(result.warnings).toHaveLength(expected.warnings);
        }
      }),
      replayParameters(),
    );
  });

  test('ABORT and GOODBYE: never fatal, reason and details from elements 1–2 in either order', () => {
    const element = fc.oneof(
      fc.jsonValue({ maxDepth: 1 }),
      fc.constantFrom(undefined, null, [], {}, { message: 'm' }, 'wamp.error.x'),
    );
    fc.assert(
      fc.property(fc.constantFrom(...CLOSING_TYPES), fc.array(element, { maxLength: 5 }), ({ type }, rest) => {
        const frame = [type, ...rest];
        const expected = expectedClosing(type, frame);
        const result = decodeSafely(frame);
        expect(result.kind).toBe('message');
        if (result.kind === 'message' && expected.kind === 'message') {
          expect(result.message).toEqual(expected.fields);
          expect(result.warnings).toHaveLength(expected.warnings);
        }
      }),
      replayParameters(),
    );
  });

  test('revocations: [35|67, 0, dict] with an id ⇒ revocation, anything else there ⇒ dropped', () => {
    const target = fc.oneof(fc.constantFrom(0, 1, 2 ** 53, -1, 1.5, '1', null), fc.jsonValue({ maxDepth: 1 }));
    fc.assert(
      fc.property(
        fc.constantFrom(35, 67),
        fc.oneof(
          target.map((t) => ({ subscription: t, registration: t, reason: 'r' })),
          fc.jsonValue({ maxDepth: 2 }),
        ),
        (type, details) => {
          const spec = FRAME_SPECS.find((s) => s.type === type)!;
          const frame = [type, 0, details];
          const expected = expectedFor(spec, frame);
          const result = decodeSafely(frame);
          expect(result.kind).toBe(expected.kind);
          if (result.kind === 'message' && expected.kind === 'message') expect(result.message).toEqual(expected.fields);
        },
      ),
      replayParameters(),
    );
  });
});
