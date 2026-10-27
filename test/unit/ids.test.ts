// Request ids: 53-bit random ids from WebCrypto (`hi = r0 >>> 11; id = hi·2^32 + r1 + 1`), from an own xorshift128+
// stream seeded once from an injected clock.random (request ids never consume the jitter draws), or from Math.random
// without either; redrawn while in flight; the sequential counter (from 1, no gaps, wrapping after 2^53); and, through
// the real client, no duplicate among the in-flight ids of every participant and the liveness probe — also with a
// degenerate source that keeps drawing from a pool of six.
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import { Client } from '../../src/client.js';
import { MAX_REQUEST_ID, RandomIds, REDRAW_LIMIT, SequentialIds, xorshift128plus } from '../../src/core/ids.js';
import { MessageType } from '../../src/protocol/codes.js';
import type { CloseInfo } from '../../src/types.js';
import { createHarness, type Harness } from '../helpers/harness.js';
import { replayParameters } from '../setup-fast-check.js';

const none = (): boolean => false;

/** xorshift128+ on BigInt (Vigna's reference), with the state the implementation derives from one draw. */
function referenceStream(draw: number): () => bigint {
  const mask = (1n << 64n) - 1n;
  const n = Math.floor((Number.isFinite(draw) ? Math.abs(draw) % 1 : 0) * 2 ** 53);
  let base = (Math.floor(n / 2 ** 32) ^ Math.imul(n >>> 0, 0x9e3779b9)) >>> 0;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    base = (base + 0x9e3779b9) >>> 0;
    let z = base;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    words.push((z ^ (z >>> 16)) >>> 0);
  }
  const [w0, w2, w3] = [words[0]!, words[2]!, words[3]!];
  let w1 = words[1]!;
  if ((w0 | w1 | w2 | w3) === 0) w1 = 1;
  let s0 = (BigInt(w0) << 32n) | BigInt(w1);
  let s1 = (BigInt(w2) << 32n) | BigInt(w3);
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & mask;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (s1 + y) & mask;
  };
}

describe('xorshift128+ (the id stream)', () => {
  test('equals a 64-bit BigInt reference for any seed draw, outputs in [0, 1) (property)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (draw) => {
        const ours = xorshift128plus(() => draw);
        const reference = referenceStream(draw);
        for (let i = 0; i < 20; i++) {
          const r = reference();
          // 53 bits of the 64-bit output, as the ids take them: the top 21 bits of the high word, the low word
          const expected = (Number(r >> 43n) * 2 ** 32 + Number(r & 0xffffffffn)) / 2 ** 53;
          const value = ours();
          expect(value).toBe(expected);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      replayParameters(),
    );
  });

  test('the seed is drawn exactly once; the same draw gives the same stream', () => {
    const seed = vi.fn(() => 0.123);
    const a = xorshift128plus(seed);
    const b = xorshift128plus(() => 0.123);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(new Set(first).size).toBe(3);
  });

  test('a degenerate seed (0, NaN, ±Infinity) still gives a working stream (never an all-zero state)', () => {
    for (const draw of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5]) {
      const r = xorshift128plus(() => draw);
      const values = new Set([r(), r(), r(), r()]);
      expect(values.size).toBe(4);
    }
  });
});

describe('RandomIds', () => {
  test('ids are integers in [1, 2^53]; an injected random seeds an own stream once (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (draw) => {
        const random = vi.fn(() => draw);
        const ids = new RandomIds(random);
        const twin = new RandomIds(() => draw);
        for (let i = 0; i < 50; i++) {
          const id = ids.next(none);
          expect(Number.isInteger(id)).toBe(true);
          expect(id).toBeGreaterThanOrEqual(1);
          expect(id).toBeLessThanOrEqual(MAX_REQUEST_ID);
          expect(twin.next(none)).toBe(id);
        }
        expect(random).toHaveBeenCalledTimes(1);
      }),
      replayParameters(),
    );
  });

  test('from WebCrypto: id = (r0 >>> 11) · 2^32 + r1 + 1, so both ends of [1, 2^53] are reachable', () => {
    const words = [
      [0, 0],
      [0xffffffff, 0xffffffff],
      [0x12345678, 0x9abcdef0],
    ];
    let call = 0;
    const root = {
      crypto: {
        getRandomValues(array: Uint32Array) {
          const [a, b] = words[call++] as [number, number];
          array[0] = a;
          array[1] = b;
          return array;
        },
      },
    };
    const ids = new RandomIds(undefined, root);
    expect(ids.next(none)).toBe(1);
    expect(ids.next(none)).toBe(MAX_REQUEST_ID);
    expect(ids.next(none)).toBe((0x12345678 >>> 11) * 2 ** 32 + 0x9abcdef0 + 1);
  });

  test('without WebCrypto (Hermes) or with a throwing one: Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
    try {
      expect(new RandomIds(undefined, {}).next(none)).toBe(((2 ** 31) >>> 11) * 2 ** 32 + 2 ** 30 + 1);
      spy.mockReturnValueOnce(0).mockReturnValueOnce(0);
      const throwing = {
        crypto: {
          getRandomValues(): never {
            throw new Error('no entropy');
          },
        },
      };
      expect(new RandomIds(undefined, throwing).next(none)).toBe(1);
      spy.mockReturnValueOnce(0).mockReturnValueOnce(0);
      expect(new RandomIds(undefined, { crypto: { getRandomValues: 'nope' } }).next(none)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('the default root is globalThis: real WebCrypto ids', () => {
    const ids = new RandomIds();
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(ids.next(none));
    expect(seen.size).toBe(100);
  });

  test('an id in flight is redrawn; release() keeps no state', () => {
    const ids = new RandomIds(() => 0.42);
    const twin = new RandomIds(() => 0.42);
    const first = twin.next(none);
    const second = twin.next(none);
    expect(ids.next((id) => id === first)).toBe(second);
    ids.release();
    expect(ids.next(none)).not.toBe(second);
  });

  test('a degenerate source that keeps drawing in-flight ids: after the redraw limit, the next free id after it', () => {
    let draws = 0;
    const root = {
      crypto: {
        getRandomValues(array: Uint32Array) {
          draws++;
          array[0] = 0xffffffff; // always 2^53
          array[1] = 0xffffffff;
          return array;
        },
      },
    };
    const ids = new RandomIds(undefined, root);
    const inFlight = new Set([MAX_REQUEST_ID, 1, 2]);
    expect(ids.next((id) => inFlight.has(id))).toBe(3); // wraps from 2^53 to 1, skips what is in flight
    expect(draws).toBe(REDRAW_LIMIT);
  });
});

describe('SequentialIds (Nexus strict_request_ids)', () => {
  test('1, 2, 3, …; a released last id is reused (no gaps); releasing another id changes nothing', () => {
    const ids = new SequentialIds();
    expect([ids.next(none), ids.next(none), ids.next(none)]).toEqual([1, 2, 3]);
    ids.release(3);
    expect(ids.next(none)).toBe(3);
    ids.release(1);
    expect(ids.next(none)).toBe(4);
  });

  test('ids still in flight are skipped; after 2^53 the counter wraps to 1', () => {
    const ids = new SequentialIds();
    expect(ids.next((id) => id < 3)).toBe(3);
    (ids as unknown as { last: number }).last = MAX_REQUEST_ID - 1;
    expect(ids.next(none)).toBe(MAX_REQUEST_ID);
    expect(ids.next(none)).toBe(1);
  });

  test('release followed by next is the same id (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 60 }), (script) => {
        const ids = new SequentialIds();
        let expected = 0;
        for (const keep of script) {
          const id = ids.next(none);
          expect(id).toBe(expected + 1);
          if (keep) expected = id;
          else ids.release(id);
        }
      }),
      replayParameters(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the client
// ---------------------------------------------------------------------------------------------------------------------

/** Every request the client wrote, per connection, with when its reply (if any) arrived. */
function requestIds(h: Harness): { readonly conn: number; readonly type: number; readonly id: number }[] {
  const types = new Set<number>([16, 32, 34, 48, 64, 66]);
  return h.router.frames
    .filter((f) => f.direction === 'in' && Array.isArray(f.frame) && types.has(f.frame[0] as number))
    .map((f) => ({
      conn: f.connection,
      type: (f.frame as unknown[])[0] as number,
      id: (f.frame as unknown[])[1] as number,
    }));
}

describe('ids through the client', () => {
  test('sequential: 1, 2, 3, … per session, restarting at 1 in every session', async () => {
    const h = createHarness({ seed: 3 });
    h.router.procedure('com.example.p', () => new Promise(() => undefined));
    const c = h.makeClient(Client, { options: { requestIds: 'sequential', timeouts: { idle: 0 } } });
    for (let i = 0; i < 3; i++) c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await h.clock.advance(10);
    h.router.drop();
    await h.clock.advance(5000);
    for (let i = 0; i < 2; i++) c.observe('call', 'com.example.p', c.client.call('com.example.p'));
    await h.clock.advance(10);
    const ids = requestIds(h);
    expect(ids.filter((r) => r.conn === 1).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(ids.filter((r) => r.conn === 2).map((r) => r.id)).toEqual([1, 2]);
    await h.finish();
  });

  test('a degenerate id source (a pool of two) never puts an id in flight twice, across every participant and the probe', async () => {
    const pool = [7, 8];
    let k = 0;
    const spy = vi
      .spyOn(RandomIds.prototype as unknown as { draw(): number }, 'draw')
      .mockImplementation(() => pool[k++ % pool.length]!);
    try {
      const h = createHarness({ seed: 5 });
      h.router.procedure('com.example.slow', () => new Promise(() => undefined));
      h.router.declareTopic('com.example.t');
      const c = h.makeClient(Client, { options: { timeouts: { idle: 1000 } } });
      // a REGISTER, a SUBSCRIBE and two calls written at WELCOME, then the calibration probe while both calls are in
      // flight: the allocator must step past the pool's in-flight ids every time
      c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
      c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
      c.observe('topic', 'com.example.t', c.client.topic('com.example.t'));
      c.observe(
        'register',
        'com.example.r',
        c.client.register('com.example.r', () => 1),
      );
      await h.clock.advance(1100);
      const writes = requestIds(h);
      expect(writes.map((w) => w.type)).toEqual([64, 32, 48, 48, 48]);
      const atWelcome = writes.slice(0, 4).map((w) => w.id);
      expect(new Set(atWelcome).size).toBe(4); // all in flight together: distinct
      const calls = atWelcome.slice(2);
      expect(calls).not.toContain(writes[4]!.id); // the probe never takes an id of a call still in flight
      expect(h.router.violations).toEqual([]);
      await h.finish();
    } finally {
      spy.mockRestore();
    }
  });

  test('request ids never consume the jitter draws: extra requests do not shift the retry delays', async () => {
    async function delays(extraCalls: number): Promise<readonly (number | undefined)[]> {
      const h = createHarness({ seed: 11 });
      h.router.procedure('com.example.p', () => 1);
      const c = h.makeClient(Client, { options: { timeouts: { idle: 0 } } });
      for (let round = 0; round < 4; round++) {
        await h.clock.advance(10);
        for (let i = 0; i < extraCalls; i++) c.observe('call', 'com.example.p', c.client.call('com.example.p'));
        await h.clock.advance(10);
        h.router.drop();
        await h.clock.advance(70000);
      }
      const out = (c.onClose?.values ?? []).map((info: CloseInfo) => info.delay);
      await h.finish();
      return out;
    }
    const quiet = await delays(0);
    expect(quiet).toHaveLength(4);
    expect(await delays(7)).toEqual(quiet);
  });

  test('a CALL, a PUBLISH, a SUBSCRIBE, a REGISTER and the probe share one id space (property over the mix)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('call', 'publish', 'topic', 'register'), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 10000 }),
        async (mix, seed) => {
          const h = createHarness({ seed });
          h.router.procedure('com.example.slow', () => new Promise(() => undefined));
          const c = h.makeClient(Client, { options: { timeouts: { idle: 500 } } });
          mix.forEach((kind, i) => {
            if (kind === 'call') c.observe('call', 'com.example.slow', c.client.call('com.example.slow'));
            else if (kind === 'publish') {
              h.router.declareTopic(`com.example.p${String(i)}`);
              c.observe('publish', 'p', c.client.publish(`com.example.p${String(i)}`, [], {}, { acknowledge: true }));
            } else if (kind === 'topic') {
              h.router.declareTopic(`com.example.t${String(i)}`);
              c.observe('topic', 't', c.client.topic(`com.example.t${String(i)}`));
            } else
              c.observe(
                'register',
                'r',
                c.client.register(`com.example.r${String(i)}`, () => 1),
              );
          });
          await h.clock.advance(600);
          const writes = requestIds(h);
          expect(new Set(writes.map((w) => w.id)).size).toBe(writes.length);
          expect(writes.filter((w) => w.type === MessageType.CALL).length).toBeGreaterThanOrEqual(1);
          await h.finish();
        },
      ),
      { ...replayParameters(), numRuns: 25 },
    );
  });

  // Nexus `strict_request_ids` ABORTs a session on the first request id that is not the next of one counter shared by
  // SUBSCRIBE, UNSUBSCRIBE, PUBLISH (acknowledged or not), REGISTER, UNREGISTER and CALL (the WAMP spec): the probe is
  // a CALL, a CANCEL reuses its CALL's id, and a frame that was not written (a serializer failure, a refused write)
  // must not leave a gap.
  test('sequential: one gap-free counter per session over all six request types and the probe (Nexus strict)', async () => {
    type Command =
      | 'call'
      | 'cancel'
      | 'publish'
      | 'publish ack'
      | 'topic'
      | 'untopic'
      | 'register'
      | 'unregister'
      | 'unserializable'
      | 'wait'
      | 'refused'
      | 'drop';
    const command = fc.constantFrom<Command>(
      'call',
      'cancel',
      'publish',
      'publish ack',
      'topic',
      'untopic',
      'register',
      'unregister',
      'unserializable',
      'wait',
      'refused',
      'drop',
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(command, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 1000 }),
        async (script, seed) => {
          const h = createHarness({ seed });
          h.router.procedure('com.example.p', () => 1);
          h.router.procedure('com.example.slow', () => new Promise(() => undefined));
          h.router.declareTopic('com.example.t');
          const c = h.makeClient(Client, {
            options: { requestIds: 'sequential', timeouts: { idle: 300 }, retryOptions: { retryDelay: () => 100 } },
          });
          const held: { unsubscribe(): void }[] = [];
          const interests: { unsubscribe(): void }[] = [];
          for (const [i, step] of script.entries()) {
            if (step === 'call') c.observe('call', 'p', c.client.call('com.example.p'));
            else if (step === 'cancel') held.push(c.observe('call', 'slow', c.client.call('com.example.slow')));
            else if (step === 'publish') c.observe('publish', 't', c.client.publish('com.example.t', [i]));
            else if (step === 'publish ack') {
              c.observe('publish', 't', c.client.publish('com.example.t', [i], {}, { acknowledge: true }));
            } else if (step === 'topic') interests.push(c.observe('topic', 't', c.client.topic('com.example.t')));
            else if (step === 'register') {
              interests.push(
                c.observe(
                  'register',
                  'r',
                  c.client.register(`com.example.r${String(i)}`, () => 1),
                ),
              );
            } else if (step === 'untopic' || step === 'unregister') interests.shift()?.unsubscribe();
            else if (step === 'unserializable') c.observe('call', 'p', c.client.call('com.example.p', [10n]));
            else if (step === 'refused') c.connections.at(-1)?.controls.closingWindow(50);
            else if (step === 'drop') c.connections.at(-1)?.controls.drop();
            if (step === 'cancel' || step === 'wait') held.shift()?.unsubscribe();
            await h.clock.advance(step === 'wait' ? 400 : 3);
          }
          await h.clock.advance(1000);
          const writes = requestIds(h);
          for (const conn of new Set(writes.map((w) => w.conn))) {
            const ids = writes.filter((w) => w.conn === conn).map((w) => w.id);
            expect(ids, `connection ${String(conn)}: ${JSON.stringify(writes.filter((w) => w.conn === conn))}`).toEqual(
              ids.map((_, k) => k + 1),
            );
          }
          expect(writes.some((w) => w.type === MessageType.CALL)).toBe(true);
          await h.finish();
        },
      ),
      { ...replayParameters(), numRuns: 60 },
    );
  });
});
