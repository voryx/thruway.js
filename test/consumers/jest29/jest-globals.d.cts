// The slice of Jest 29's `@jest/globals` the consumer tests use, for linting only (jest is not a dependency of this
// repository; scripts/package-check.mjs installs jest 29.7.0 next to the tests and runs them there).
type Body = () => void | Promise<void>;
interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeGreaterThanOrEqual(expected: number): void;
  readonly not: Matchers;
}
interface Test {
  (name: string, body: Body, timeout?: number): void;
  readonly skip: (name: string, body: Body, timeout?: number) => void;
}
export declare const describe: (name: string, body: () => void) => void;
export declare const test: Test;
export declare const afterEach: (body: Body) => void;
export declare function expect(actual: unknown): Matchers;
export declare const jest: {
  useFakeTimers(config?: { legacyFakeTimers?: boolean }): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
  advanceTimersByTimeAsync(ms: number): Promise<void>;
  getTimerCount(): number;
};
