/**
 * Request id allocators, allocated at write time. `random` (default): 53 random bits from
 * `crypto.getRandomValues` (`hi = r0 >>> 11`; `id = hi * 2^32 + r1 + 1` ∈ [1, 2^53]) or, with an injected
 * `clock.random`, from an own xorshift128+ stream seeded once from it; redrawn while the id is in flight.
 * `sequential`: from 1, +1 per allocation, wrapping to 1 after 2^53; a released id rolls the counter back.
 *
 * The random allocator belongs to the client (its stream is seeded once, at construction); a sequential one is created
 * per session, so its ids restart at 1 in every session (Nexus `strict_request_ids`).
 *
 * @module
 */
import { randomWords } from './clock.js';

export const MAX_REQUEST_ID = 2 ** 53;

/** Draws before a random allocator stops trusting its source and scans for a free id (a stubbed or broken source
 *  that keeps returning one in-flight id must not hang the client). */
export const REDRAW_LIMIT = 64;

export interface IdAllocator {
  /** A fresh id for which `inFlight(id)` is false. */
  next(inFlight: (id: number) => boolean): number;
  /** The frame carrying `id` was not sent or failed to serialize: release it (sequential: roll back). */
  release(id: number): void;
}

/** The id `hi21 * 2^32 + lo + 1` ∈ [1, 2^53] of two 32-bit words. */
function idOf(hi: number, lo: number): number {
  return (hi >>> 11) * 2 ** 32 + (lo >>> 0) + 1;
}

/** The next id after `id`, wrapping from 2^53 to 1. */
function after(id: number): number {
  return id >= MAX_REQUEST_ID ? 1 : id + 1;
}

/** 53-bit random ids. `random` given ⇒ an own xorshift128+ stream seeded once from it; else crypto/Math.random. */
export class RandomIds implements IdAllocator {
  private readonly words: (() => readonly [number, number]) | undefined;
  private last = 0;

  /** @param root where WebCrypto is looked up without `random` (tests pass a fake). */
  constructor(
    random?: () => number,
    private readonly root: { readonly crypto?: unknown } = globalThis as { readonly crypto?: unknown },
  ) {
    this.words = random === undefined ? undefined : xorshiftWords(random);
  }

  next(inFlight: (id: number) => boolean): number {
    for (let i = 0; i < REDRAW_LIMIT; i++) {
      const id = this.draw();
      this.last = id;
      if (!inFlight(id)) return id;
    }
    let id = this.last;
    do id = after(id);
    while (inFlight(id));
    return id;
  }

  /** Random ids keep no state per id. */
  release(): void {
    // nothing to roll back
  }

  private draw(): number {
    if (this.words !== undefined) {
      const [hi, lo] = this.words();
      return idOf(hi, lo);
    }
    const words = randomWords(this.root);
    if (words !== undefined) return idOf(words[0], words[1]);
    return idOf(Math.floor(Math.random() * 2 ** 32), Math.floor(Math.random() * 2 ** 32));
  }
}

/** Spec-style per-session counter (Nexus `strict_request_ids`). */
export class SequentialIds implements IdAllocator {
  private last = 0;

  next(inFlight: (id: number) => boolean): number {
    let id = this.last;
    do id = after(id);
    while (inFlight(id));
    this.last = id;
    return id;
  }

  release(id: number): void {
    if (id === this.last) this.last = id - 1; // no gaps: the next allocation reuses it
  }
}

/** 32-bit finaliser of splitmix (expands one seed into the 128-bit state). */
function mix32(z: number): number {
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** xorshift128+ (a = 23, b = 17, c = 26) on 32-bit halves; each call yields one 64-bit output as `[hi, lo]`. The
 *  128-bit state is expanded from one draw of `seed()` (53 bits) and is never all zero. */
function xorshiftWords(seed: () => number): () => readonly [number, number] {
  const draw = seed();
  const n = Math.floor((Number.isFinite(draw) ? Math.abs(draw) % 1 : 0) * 2 ** 53);
  let base = (Math.floor(n / 2 ** 32) ^ Math.imul(n >>> 0, 0x9e3779b9)) >>> 0;
  const state: number[] = [];
  for (let i = 0; i < 4; i++) {
    base = (base + 0x9e3779b9) >>> 0;
    state.push(mix32(base));
  }
  // mix32 is a bijection with mix32(0) = 0, and the four inputs differ pairwise: the state is never all zero
  let [s0hi, s0lo, s1hi, s1lo] = state as [number, number, number, number];
  return () => {
    // s1 = s[0]; s0 = s[1]; s[0] = s0
    let xhi = s0hi;
    let xlo = s0lo;
    const yhi = s1hi;
    const ylo = s1lo;
    s0hi = yhi;
    s0lo = ylo;
    // s1 ^= s1 << 23
    xhi = (xhi ^ ((xhi << 23) | (xlo >>> 9))) >>> 0;
    xlo = (xlo ^ (xlo << 23)) >>> 0;
    // s[1] = s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26)
    s1hi = (xhi ^ yhi ^ (xhi >>> 17) ^ (yhi >>> 26)) >>> 0;
    s1lo = (xlo ^ ylo ^ ((xlo >>> 17) | (xhi << 15)) ^ ((ylo >>> 26) | (yhi << 6))) >>> 0;
    // return s[1] + s0
    const lo = (s1lo + ylo) >>> 0;
    const hi = (s1hi + yhi + (lo < s1lo ? 1 : 0)) >>> 0;
    return [hi, lo];
  };
}

/** xorshift128+ (uniform [0,1)), seeded from one draw of `seed()`; the id stream's own PRNG. */
export function xorshift128plus(seed: () => number): () => number {
  const words = xorshiftWords(seed);
  return () => {
    const [hi, lo] = words();
    return ((hi >>> 11) * 2 ** 32 + lo) / 2 ** 53;
  };
}
