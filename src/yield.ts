/**
 * `Yield`: an explicit callee result with args/kwargs.
 *
 * Absent (`undefined` or `null`) args/kwargs become `[]`/`{}`; anything else is kept as given (not copied), so a
 * malformed payload is detected where the YIELD is built. The brand is an own non-enumerable property:
 * `isYield` recognises a `Yield` from any copy of the package, never by `instanceof`.
 *
 * @module
 */

/** The brand a `Yield` carries (dual-package safe; `isYield` checks it, never `instanceof`). */
export const YIELD_BRAND: symbol = Symbol.for('thruway.js.yield');

export class Yield {
  constructor(args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>) {
    this.args = args ?? [];
    this.kwargs = kwargs ?? {};
    Object.defineProperty(this, YIELD_BRAND, { value: true });
  }
  declare readonly args: readonly unknown[];
  declare readonly kwargs: Readonly<Record<string, unknown>>;
}

/** @internal Brand check (either package copy). Never throws. */
export function isYield(value: unknown): value is Yield {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return (value as Record<symbol, unknown>)[YIELD_BRAND] === true;
  } catch {
    return false;
  }
}
