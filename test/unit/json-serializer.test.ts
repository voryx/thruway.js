// transport/json.ts: wamp.2.json, the "\u0000"+base64 binary convention (round trip and the WAMP spec's example
// EOP/kFMHXFJvX8BtT+N82w==), lenient NaN/±Infinity tokens (revived outside strings, untouched inside), binary frames
// decoded as UTF-8 with or without TextDecoder, and the local UTF-8/base64 codecs checked against the platform's.
import { fc } from '@fast-check/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { base64Decode, base64Encode, decodeUtf8, jsonSerializer } from '../../src/transport/json.js';
import { replayParameters } from '../setup-fast-check.js';

const plain = jsonSerializer();
const binary = jsonSerializer({ binary: true });

/** The WAMP spec's example of the binary convention: the wire text is "\u0000EOP/kFMHXFJvX8BtT+N82w==". */
const SPEC_BASE64 = 'EOP/kFMHXFJvX8BtT+N82w==';
const SPEC_BYTES = new Uint8Array([
  0x10, 0xe3, 0xff, 0x90, 0x53, 0x07, 0x5c, 0x52, 0x6f, 0x5f, 0xc0, 0x6d, 0x4f, 0xe3, 0x7c, 0xdb,
]);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('the serializer object', () => {
  test('wamp.2.json, text frames, frozen', () => {
    for (const s of [plain, binary, jsonSerializer({}), jsonSerializer({ binary: false }), jsonSerializer(undefined)]) {
      expect(s.protocol).toBe('wamp.2.json');
      expect(s.binary).toBe(false); // the frame type; options.binary is the payload convention
      expect(Object.isFrozen(s)).toBe(true);
    }
  });
  test('options.binary must be a boolean when given', () => {
    for (const bad of ['yes', 1, null, {}]) {
      expect(() => jsonSerializer({ binary: bad as unknown as boolean })).toThrow(
        new TypeError('jsonSerializer: options.binary must be a boolean'),
      );
    }
    expect(() => jsonSerializer({ binary: undefined })).not.toThrow();
  });
});

describe('plain JSON', () => {
  test('serialize is JSON.stringify of the message', () => {
    const frame = [48, 7, { receive_progress: true }, 'com.x', [1, 'a', null], { k: { n: [true] } }];
    expect(plain.serialize(frame)).toBe(JSON.stringify(frame));
    expect(binary.serialize([1, 'realm1', { agent: 'x' }])).toBe('[1,"realm1",{"agent":"x"}]');
  });

  test('round trip of arbitrary JSON frames (both serializers, without binary values)', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 6 }), fc.integer({ min: 0, max: 70 }), (rest, type) => {
        const frame = [type, ...rest];
        const expected = JSON.parse(JSON.stringify(frame)) as unknown;
        expect(plain.deserialize(plain.serialize(frame))).toEqual(expected);
        const viaBinary = binary.serialize(frame) as string;
        expect(viaBinary).toBe(JSON.stringify(frame));
        if (!viaBinary.includes('\\u0000')) expect(binary.deserialize(viaBinary)).toEqual(expected);
      }),
      replayParameters(),
    );
  });

  test('serialize never mutates the message', () => {
    const frame = deepFreeze([48, 1, { a: 1 }, 'p', [new Uint8Array([1, 2]), { b: [new Uint8Array([3])] }], { c: 1 }]);
    const before = JSON.stringify(frame);
    binary.serialize(frame);
    plain.serialize(frame);
    expect(JSON.stringify(frame)).toBe(before);
  });

  test('serializer errors propagate: cycles, BigInt, a throwing toJSON', () => {
    const cyclic: unknown[] = [48, 1, {}, 'p'];
    cyclic.push([cyclic]);
    const boom = new Error('boom');
    for (const s of [plain, binary]) {
      expect(() => s.serialize(cyclic)).toThrow(TypeError);
      expect(() => s.serialize([48, 1, {}, 'p', [1n]])).toThrow(TypeError);
      expect(() =>
        s.serialize([
          48,
          1,
          {},
          'p',
          [
            {
              toJSON: () => {
                throw boom;
              },
            },
          ],
        ]),
      ).toThrow(boom);
    }
  });

  test('a message JSON cannot represent at all throws TypeError', () => {
    expect(() => plain.serialize(undefined as unknown as unknown[])).toThrow(
      new TypeError('the message cannot be serialized as JSON'),
    );
  });

  test('lone surrogates are escaped (well-formed JSON.stringify)', () => {
    expect(plain.serialize([48, 1, {}, 'p', ['\ud800']])).toBe('[48,1,{},"p",["\\ud800"]]');
  });

  test('invalid JSON throws (the core then aborts with protocol_violation)', () => {
    for (const text of [
      '',
      'nope',
      '[1,',
      '[1,]',
      "['a']",
      '[NaNa]',
      '[Infinityy]',
      '[-NaN]',
      '{"a":NaN',
      '[NaN NaN]',
      '[Nul]', // only the exact tokens are rewritten
      '[Ixxxxxxx]',
      '[nan]',
      '[infinity]',
      '[+Infinity]',
    ]) {
      expect(() => plain.deserialize(text)).toThrow(SyntaxError);
    }
  });
});

describe('the binary convention', () => {
  test('the WAMP spec vector, both directions', () => {
    const wire = binary.serialize([16, 1, {}, 't', [SPEC_BYTES]]);
    expect(wire).toBe('[16,1,{},"t",["\\u0000EOP/kFMHXFJvX8BtT+N82w=="]]');
    const back = binary.deserialize('[36,1,2,{},["\\u0000EOP/kFMHXFJvX8BtT+N82w=="]]') as unknown[];
    expect(back[4]).toEqual([SPEC_BYTES]);
    expect((back[4] as unknown[])[0]).toBeInstanceOf(Uint8Array);
  });

  test('Uint8Array, ArrayBuffer and Node Buffer values are encoded; a Buffer as its bytes, not its toJSON', () => {
    const buffer = Buffer.from([1, 2, 3]);
    const wire = binary.serialize([
      48,
      1,
      {},
      'p',
      [new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]).buffer, buffer],
    ]);
    expect(wire).toBe('[48,1,{},"p",["\\u0000AQID","\\u0000AQID","\\u0000AQID"]]');
  });

  test('only Uint8Array and ArrayBuffer are binary: other views, look-alikes and Buffer JSON stay JSON', () => {
    const spoof = { [Symbol.toStringTag]: 'Uint8Array', 0: 1, length: 1 };
    const spoofBuffer = { [Symbol.toStringTag]: 'ArrayBuffer' };
    expect(binary.serialize([70, 1, {}, [new Int16Array([1]), new DataView(new ArrayBuffer(1)), spoof]])).toBe(
      '[70,1,{},[{"0":1},{},{"0":1,"length":1}]]',
    );
    expect(binary.serialize([70, 1, {}, [{ type: 'Buffer', data: [1] }]])).toBe(
      '[70,1,{},[{"type":"Buffer","data":[1]}]]',
    );
    expect(binary.serialize([70, 1, {}, [spoofBuffer]])).toBe('[70,1,{},[{}]]');
    expect(() => plain.deserialize(spoofBuffer as unknown as ArrayBuffer)).toThrow(TypeError);
  });

  test('binary values from another realm (vm context, iframe) are recognised', () => {
    const realm = createContext();
    const bytes = runInContext('new Uint8Array([1, 2, 3])', realm) as Uint8Array;
    const buffer = runInContext('new Uint8Array([1, 2, 3]).buffer', realm) as ArrayBuffer;
    expect(binary.serialize([70, 1, {}, [bytes, buffer]])).toBe('[70,1,{},["\\u0000AQID","\\u0000AQID"]]');
    expect(plain.deserialize(runInContext('new Uint8Array([0x5b, 0x31, 0x5d]).buffer', realm) as ArrayBuffer)).toEqual([
      1,
    ]);
  });

  test('a Uint8Array view of part of a buffer encodes only its bytes', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    expect(binary.serialize([70, 1, {}, [backing.subarray(2, 4)]])).toBe('[70,1,{},["\\u0000AQI="]]');
  });

  test('payload positions of every payload-bearing type, recursively, keys untouched', () => {
    const bytes = new Uint8Array([255]);
    const payload = [bytes, { [`\u0000key`]: bytes, nested: [[bytes]] }];
    const wirePayload = '["\\u0000/w==",{"\\u0000key":"\\u0000/w==","nested":[["\\u0000/w=="]]}]';
    const cases: [unknown[], string][] = [
      [[48, 1, {}, 'p', ...payload], `[48,1,{},"p",${wirePayload.slice(1, -1)}]`],
      [[16, 1, {}, 't', ...payload], `[16,1,{},"t",${wirePayload.slice(1, -1)}]`],
      [[70, 1, {}, ...payload], `[70,1,{},${wirePayload.slice(1, -1)}]`],
      [[8, 68, 1, {}, 'u', ...payload], `[8,68,1,{},"u",${wirePayload.slice(1, -1)}]`],
    ];
    for (const [frame, wire] of cases) {
      expect(binary.serialize(frame)).toBe(wire);
      const back = binary.deserialize(wire) as unknown[];
      expect(back).toEqual(frame);
    }
  });

  test('inbound: RESULT, EVENT, INVOCATION, ERROR and ABORT payloads are revived', () => {
    const v = '"\\u0000AQID"';
    const bytes = new Uint8Array([1, 2, 3]);
    expect(binary.deserialize(`[50,1,{},[${v}],{"k":${v}}]`)).toEqual([50, 1, {}, [bytes], { k: bytes }]);
    expect(binary.deserialize(`[36,1,2,{},[${v}]]`)).toEqual([36, 1, 2, {}, [bytes]]);
    expect(binary.deserialize(`[68,1,2,{},[],{"k":[${v}]}]`)).toEqual([68, 1, 2, {}, [], { k: [bytes] }]);
    expect(binary.deserialize(`[8,48,1,{},"u",[${v}]]`)).toEqual([8, 48, 1, {}, 'u', [bytes]]);
    expect(binary.deserialize(`[3,{},"r",[${v}]]`)).toEqual([3, {}, 'r', [bytes]]);
  });

  test('outside the payload nothing changes: options, details, URIs, other message types', () => {
    const bytes = new Uint8Array([1]);
    expect(binary.serialize([48, 1, { o: bytes }, 'p'])).toBe('[48,1,{"o":{"0":1}},"p"]');
    expect(binary.serialize([32, 1, { o: bytes }, 't'])).toBe('[32,1,{"o":{"0":1}},"t"]');
    for (const wire of [
      '[50,1,{"d":"\\u0000AQID"}]',
      '[8,48,1,{"d":"\\u0000AQID"},"\\u0000AQID"]',
      '[2,1,{"authextra":"\\u0000AQID"}]',
      '[4,"cryptosign",{"challenge":"\\u0000AQID"}]',
    ]) {
      expect(binary.deserialize(wire)).toEqual(JSON.parse(wire));
    }
  });

  test('a U+0000 string that is not base64 stays a string; the empty one is zero bytes', () => {
    const back = binary.deserialize(
      '[50,1,{},["\\u0000not base64!","\\u0000","\\u0000A","\\u0000QQ=","x\\u0000"]]',
    ) as [unknown, unknown, unknown, unknown[]];
    expect(back[3]).toEqual(['\u0000not base64!', new Uint8Array(0), '\u0000A', '\u0000QQ=', 'x\u0000']);
  });

  test('off by default: binary values serialize as JSON objects, U+0000 strings stay strings', () => {
    expect(plain.serialize([48, 1, {}, 'p', [new Uint8Array([1, 2])]])).toBe('[48,1,{},"p",[{"0":1,"1":2}]]');
    expect(plain.deserialize('[50,1,{},["\\u0000AQID"]]')).toEqual([50, 1, {}, ['\u0000AQID']]);
  });

  test('round trip: arbitrary payloads with binary values anywhere inside', () => {
    const leaf = fc.oneof(
      fc.uint8Array({ maxLength: 40 }),
      fc.string({ maxLength: 8 }).filter((s) => !s.startsWith('\u0000')),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    );
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        leaf,
        fc.array(tie('node'), { maxLength: 3 }),
        fc.dictionary(fc.string({ maxLength: 4 }), tie('node'), { maxKeys: 3 }),
      ),
    })).node;
    fc.assert(
      fc.property(
        fc.constantFrom<[number, number]>([48, 4], [16, 4], [70, 3], [8, 5], [50, 3], [36, 4], [68, 4]),
        fc.array(value, { maxLength: 3 }),
        fc.dictionary(fc.string({ maxLength: 4 }), value, { maxKeys: 3 }),
        ([type, start], args, kwargs) => {
          const header = [type, 1, 2, 3, 4, 5].slice(0, start);
          const frame = [...header, args, kwargs];
          const back = binary.deserialize(binary.serialize(frame));
          expect(back).toEqual(frame);
        },
      ),
      replayParameters(),
    );
  });
});

describe('lenient NaN / Infinity tokens (Crossbar quirk 10)', () => {
  test('bare tokens outside strings become the JS numbers', () => {
    const value = plain.deserialize('[36,1,2,{},[NaN,Infinity,-Infinity,{"x":NaN,"y":[-Infinity]}]]') as unknown[];
    expect(value).toEqual([36, 1, 2, {}, [NaN, Infinity, -Infinity, { x: NaN, y: [-Infinity] }]]);
  });

  test('the same tokens inside strings are untouched', () => {
    const text = '[36,1,2,{"NaN":"Infinity"},["NaN","-Infinity","a NaN b","\\"NaN\\"","\\\\",NaN,"Infinity\\\\"]]';
    expect(plain.deserialize(text)).toEqual([
      36,
      1,
      2,
      { NaN: 'Infinity' },
      ['NaN', '-Infinity', 'a NaN b', '"NaN"', '\\', NaN, 'Infinity\\'],
    ]);
  });

  test('works with the binary convention too', () => {
    expect(binary.deserialize('[50,1,{},[NaN,"\\u0000AQID"]]')).toEqual([50, 1, {}, [NaN, new Uint8Array([1, 2, 3])]]);
  });

  test("Python's other separators and indentation: tokens next to whitespace, at the edges of the text", () => {
    const text = '[50, 1, {}, [NaN, Infinity,\n\t-Infinity, {"x": NaN, "y" :Infinity }\r\n]]';
    expect(plain.deserialize(text)).toEqual([50, 1, {}, [NaN, Infinity, -Infinity, { x: NaN, y: Infinity }]]);
    expect(plain.deserialize('NaN')).toBeNaN();
    expect(plain.deserialize(' -Infinity ')).toBe(-Infinity);
  });

  test.each([
    '[50,1,{},[1Infinity]]',
    '[50,1,{},[Infinity1]]',
    '[50,1,{},[1.Infinity]]',
    '[50,1,{},[Infinity.5]]',
    '[50,1,{},[Infinitye5]]',
    '[50,1,{},[2NaN]]',
    '[50,1,{},[NaN0]]',
    '[50,1,{},[NaNx]]',
    '[50,1,{},["x"NaN]]',
    '[50,1,{},[NaN"x"]]',
    '[50,1,{},[trueInfinity]]',
    '[50,1,{},[-NaN]]',
    '[50,1,{},[+Infinity]]',
    '[50,1,{},[infinity]]',
    '[50,1,{},[nan]]',
  ])('%s: only whole value tokens are revived; anything else stays undecodable', (text) => {
    expect(() => plain.deserialize(text)).toThrow(SyntaxError);
  });

  test('a frame holding the private sentinel string and a bare NaN is not guessed at: it stays undecodable', () => {
    const sentinel = JSON.stringify('\u0000thruway.js:NaN');
    expect(() => plain.deserialize(`[50,1,{},[${sentinel},NaN]]`)).toThrow(SyntaxError);
    // without a bare token the first parse succeeds and the string is just a string
    expect(plain.deserialize(`[50,1,{},[${sentinel}]]`)).toEqual([50, 1, {}, ['\u0000thruway.js:NaN']]);
  });

  test('property: JSON with non-finite numbers written the Python way parses to those numbers', () => {
    const pythonJson = (value: unknown): string =>
      JSON.stringify(value, (_k, v: unknown) =>
        typeof v === 'number' && !Number.isFinite(v) ? `@@${String(v)}@@` : v,
      ).replace(/"@@(NaN|Infinity|-Infinity)@@"/g, '$1');
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        const tail = [NaN, { inf: Infinity }, [-Infinity, 'NaN', 'Infinity']];
        const text = pythonJson([50, 1, {}, [json, ...tail]]);
        expect(plain.deserialize(text)).toEqual([50, 1, {}, [JSON.parse(JSON.stringify(json)), ...tail]]);
      }),
      replayParameters(),
    );
  });
});

describe('binary WebSocket messages (wamp.2.json sent as binary, Nexus)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const text = '[2,1,{"agent":"r","é":"ü€😀"}]';
  const encoded = new TextEncoder().encode(text);

  test('ArrayBuffer, Uint8Array, Buffer and DataView are decoded as UTF-8', () => {
    const offset = new Uint8Array(encoded.length + 4);
    offset.set(encoded, 2);
    for (const data of [
      encoded.buffer.slice(0),
      encoded,
      Buffer.from(encoded),
      offset.subarray(2, 2 + encoded.length),
      new DataView(offset.buffer, 2, encoded.length),
    ]) {
      expect(plain.deserialize(data as Uint8Array)).toEqual(JSON.parse(text));
    }
  });

  test('a leading BOM is skipped, like TextDecoder does', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoded]);
    expect(plain.deserialize(withBom)).toEqual(JSON.parse(text));
  });

  test('invalid UTF-8 throws', () => {
    expect(() => plain.deserialize(new Uint8Array([0x5b, 0xff, 0x5d]))).toThrow(TypeError);
  });

  test('anything else throws TypeError', () => {
    const values: unknown[] = [42, null, undefined, {}, [1], new Blob(['[]'])];
    for (const data of values) {
      expect(() => plain.deserialize(data as string)).toThrow(
        new TypeError('unsupported frame data: expected a string or binary data'),
      );
    }
  });

  test('the platform TextDecoder is used when there is one, as a fatal UTF-8 decoder', () => {
    const made: unknown[][] = [];
    vi.stubGlobal(
      'TextDecoder',
      class {
        constructor(...args: unknown[]) {
          made.push(args);
        }
        decode(): string {
          return '[2,1,{"via":"platform"}]';
        }
      },
    );
    expect(plain.deserialize(encoded)).toEqual([2, 1, { via: 'platform' }]);
    expect(made).toEqual([['utf-8', { fatal: true }]]);
  });

  test('without TextDecoder (Hermes) the local decoder is used', () => {
    vi.stubGlobal('TextDecoder', undefined);
    expect(plain.deserialize(encoded)).toEqual(JSON.parse(text));
    expect(() => plain.deserialize(new Uint8Array([0x5b, 0xc0, 0x80, 0x5d]))).toThrow(TypeError);
  });

  test('a TextDecoder that cannot be constructed falls back to the local decoder', () => {
    vi.stubGlobal('TextDecoder', function TextDecoder() {
      throw new Error('unsupported');
    });
    expect(plain.deserialize(encoded)).toEqual(JSON.parse(text));
  });
});

describe('decodeUtf8 (the local decoder) behaves like TextDecoder(fatal)', () => {
  const platform = new TextDecoder('utf-8', { fatal: true });
  const outcome = (decode: () => string): string => {
    try {
      return `ok:${decode()}`;
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      return 'error';
    }
  };
  const same = (bytes: Uint8Array): void => {
    expect(outcome(() => decodeUtf8(bytes))).toBe(outcome(() => platform.decode(bytes)));
  };

  test.each([
    ['empty', []],
    ['ascii', [0x41, 0x42]],
    ['BOM only', [0xef, 0xbb, 0xbf]],
    ['two BOMs', [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]],
    ['overlong 2-byte', [0xc0, 0x80]],
    ['overlong 2-byte c1', [0xc1, 0xbf]],
    ['overlong 3-byte', [0xe0, 0x80, 0x80]],
    ['overlong 4-byte', [0xf0, 0x80, 0x80, 0x80]],
    ['surrogate D800', [0xed, 0xa0, 0x80]],
    ['surrogate DFFF', [0xed, 0xbf, 0xbf]],
    ['max BMP', [0xef, 0xbf, 0xbf]],
    ['U+10FFFF', [0xf4, 0x8f, 0xbf, 0xbf]],
    ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['F5', [0xf5, 0x80, 0x80, 0x80]],
    ['FF', [0xff]],
    ['stray continuation', [0x80]],
    ['truncated 2', [0xc3]],
    ['truncated 3', [0xe2, 0x82]],
    ['truncated 4', [0xf0, 0x9f, 0x98]],
    ['U+0080', [0xc2, 0x80]],
    ['U+00A0', [0xc2, 0xa0]],
    ['U+07FF', [0xdf, 0xbf]],
    ['U+0800', [0xe0, 0xa0, 0x80]],
    ['U+D7FF', [0xed, 0x9f, 0xbf]],
    ['U+E000', [0xee, 0x80, 0x80]],
    ['U+FFFF', [0xef, 0xbf, 0xbf]],
    ['U+10000', [0xf0, 0x90, 0x80, 0x80]],
    ['U+FFFFF', [0xf3, 0xbf, 0xbf, 0xbf]],
    ['U+100000', [0xf4, 0x80, 0x80, 0x80]],
    ['U+2EFF (not a BOM)', [0xe2, 0xbb, 0xbf]],
    ['BOM-like prefix EF BB 41', [0xef, 0xbb, 0x41]],
    ['BOM-like prefix EF 41 BF', [0xef, 0x41, 0xbf]],
    ['A BB BF', [0x41, 0xbb, 0xbf]],
    ['BOM then text', [0xef, 0xbb, 0xbf, 0x41]],
    ['C1 + 3 continuations', [0xc1, 0x80, 0x80, 0x80]],
    ['stray continuation run', [0x80, 0x80, 0x80, 0x80]],
    ['F8', [0xf8, 0x80, 0x80, 0x80, 0x80]],
    ['continuation after ASCII', [0x41, 0x80]],
    ['lead after lead', [0xe2, 0xe2, 0x82, 0xac]],
    ['bad continuation', [0xe2, 0x28, 0xa1]],
    ['emoji', [0xf0, 0x9f, 0x98, 0x80]],
  ])('%s', (_name, bytes) => {
    same(new Uint8Array(bytes));
  });

  test('long input crosses the internal chunk size (and the engine argument limit)', () => {
    const big = new TextEncoder().encode('€😀a'.repeat(300000));
    expect(decodeUtf8(big)).toBe(platform.decode(big));
  });

  test('errors are TypeErrors that say what is wrong', () => {
    expect(() => decodeUtf8(new Uint8Array([0xff]))).toThrow(new TypeError('invalid UTF-8 data'));
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x41]))).toThrow(new TypeError('invalid UTF-8 data'));
    expect(() => decodeUtf8(new Uint8Array([0xc3]))).toThrow(new TypeError('invalid UTF-8 data: truncated sequence'));
  });

  test('property: arbitrary bytes and mutated valid UTF-8 decode (or fail) exactly like TextDecoder', () => {
    const valid = fc.string({ unit: 'binary', maxLength: 40 }).map((s) => new TextEncoder().encode(s));
    const mutated = fc.tuple(valid, fc.nat(), fc.integer({ min: 0, max: 255 })).map(([bytes, at, b]) => {
      const copy = Uint8Array.from(bytes);
      if (copy.length > 0) copy[at % copy.length] = b;
      return copy;
    });
    fc.assert(fc.property(fc.oneof(valid, mutated, fc.uint8Array({ maxLength: 40 })), same), replayParameters());
  });
});

describe('base64 (local, RFC 4648)', () => {
  test('the spec vector', () => {
    expect(base64Encode(SPEC_BYTES)).toBe(SPEC_BASE64);
    expect(base64Decode(SPEC_BASE64)).toEqual(SPEC_BYTES);
  });

  test.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('RFC 4648 §10 vector %j', (plainText, encoded) => {
    const bytes = new TextEncoder().encode(plainText);
    expect(base64Encode(bytes)).toBe(encoded);
    expect(base64Decode(encoded)).toEqual(bytes);
  });

  test('unpadded input is accepted; broken input is rejected', () => {
    expect(base64Decode('Zg')).toEqual(new Uint8Array([0x66]));
    expect(base64Decode('Zm8')).toEqual(new Uint8Array([0x66, 0x6f]));
    expect(base64Decode('Zg======')).toBeUndefined(); // at most two padding characters
    for (const bad of [
      'Z',
      'Zg=',
      'Zg===',
      'Z===',
      '=',
      '==',
      'Zm9v=',
      'Zm 9v',
      'Zm9v\n',
      'Zm-_',
      'Zg==Zg==',
      'é',
      'éééé', // non-ASCII inside a complete group
      'Zm9Ā',
      '\u0000',
    ]) {
      expect(base64Decode(bad)).toBeUndefined();
    }
  });

  test('decoding from an offset', () => {
    expect(base64Decode('\u0000Zm9v', 1)).toEqual(new TextEncoder().encode('foo'));
  });

  test('property: matches Buffer in both directions', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const encoded = base64Encode(bytes);
        expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
        expect(base64Decode(encoded)).toEqual(bytes);
        expect(base64Decode(encoded.replace(/=+$/, ''))).toEqual(bytes);
      }),
      replayParameters(),
    );
  });

  test('large binaries', () => {
    const bytes = new Uint8Array(100000).map((_, i) => (i * 31) & 0xff);
    const encoded = base64Encode(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64Decode(encoded)).toEqual(bytes);
  });
});
