// The ES2020 downlevel sample: syntax newer than ES2020 that the library may use in TypeScript and that TypeScript 7
// must lower at `target: es2020` — class fields (instance and static), logical assignment (`??=`, `&&=`) and numeric
// separators. scripts/es2020-check.mjs --self-test compiles it with TS 7 at es2020 (the acorn ES2020 gate must accept
// the output) and at es2022 (the gate must reject it).
export class Counter {
  static readonly limit = 1_000_000;
  count = 0;
  label: string | undefined;
  readonly history: number[] = [];

  bump(by?: number): number {
    by ??= 1;
    this.count += by;
    this.history.push(this.count);
    return this.count;
  }

  name(): string {
    this.label ??= 'counter';
    return this.label;
  }

  reset(enabled: boolean): boolean {
    let ok = enabled;
    ok &&= this.count > 0;
    if (ok) this.count = 0;
    return ok;
  }
}

export const big = 0x7fff_ffff;
