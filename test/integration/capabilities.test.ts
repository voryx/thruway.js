// The capability flags: test/integration/capabilities.json is valid against capabilities.schema.json; every router has
// every key; every key is used by at least one test and no test uses an unknown key; and, per available router, every
// deterministic flag re-derived from live probes (harness/probe-caps.ts) equals the recorded one — a drift fails here,
// naming the router, the key, the recorded and the observed value. A 'sometimes' flag accepts any outcome; a flag
// recorded as 'always'/'never' that a probe sees vary is drift too.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { deriveCapabilities, PROBES, UNPROBED } from './harness/probe-caps.js';
import { describeRouters, HOSTILE, loadCapabilities, MATRIX } from './harness/routers.js';

type Json = unknown;
interface Schema {
  readonly type?: string;
  readonly enum?: readonly Json[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean | Schema;
  readonly oneOf?: readonly Schema[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly minProperties?: number;
  readonly minimum?: number;
  readonly pattern?: string;
}

const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8')) as Schema;

/** The subset of JSON Schema 2020-12 the capability schema uses; returns the violations. */
function validate(value: Json, s: Schema, at: string): string[] {
  if (s.$ref !== undefined) {
    const name = s.$ref.replace('#/$defs/', '');
    const target = schema.$defs?.[name];
    return target === undefined ? [`${at}: unknown $ref ${s.$ref}`] : validate(value, target, at);
  }
  if (s.oneOf !== undefined) {
    const passing = s.oneOf.filter((option) => validate(value, option, at).length === 0).length;
    return passing === 1 ? [] : [`${at}: matches ${String(passing)} of oneOf`];
  }
  const errors: string[] = [];
  if (s.enum !== undefined && !s.enum.includes(value))
    errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`);
  if (s.type !== undefined) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = s.type === 'integer' ? Number.isInteger(value) : actual === s.type;
    if (!ok) return [...errors, `${at}: expected ${s.type}, got ${actual}`];
  }
  if (typeof value === 'number' && s.minimum !== undefined && value < s.minimum)
    errors.push(`${at}: below ${String(s.minimum)}`);
  if (typeof value === 'string' && s.pattern !== undefined && !new RegExp(s.pattern).test(value)) {
    errors.push(`${at}: does not match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems)
      errors.push(`${at}: fewer than ${String(s.minItems)} items`);
    if (s.items !== undefined) value.forEach((v, i) => errors.push(...validate(v, s.items!, `${at}[${String(i)}]`)));
  } else if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, Json>;
    if (s.minProperties !== undefined && Object.keys(obj).length < s.minProperties)
      errors.push(`${at}: too few properties`);
    for (const key of s.required ?? []) if (!(key in obj)) errors.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      const property = s.properties?.[key];
      if (property !== undefined) errors.push(...validate(v, property, `${at}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${at}: unknown key ${key}`);
      else if (typeof s.additionalProperties === 'object')
        errors.push(...validate(v, s.additionalProperties, `${at}.${key}`));
    }
  }
  return errors;
}

const file = loadCapabilities();
const KEYS = schema.$defs?.['capabilities']?.required ?? [];

test('capabilities.json is valid against its schema', () => {
  expect(validate(file, schema, '$')).toEqual([]);
  expect(KEYS.length).toBeGreaterThanOrEqual(32);
});

test('every matrix and hostile router has an entry with every key', () => {
  for (const id of [...MATRIX, ...HOSTILE]) {
    expect(Object.keys(file.routers[id]?.capabilities ?? {}).sort()).toEqual([...KEYS].sort());
  }
});

test('every key is used by a test, and no test uses an unknown key', () => {
  const dir = new URL('./', import.meta.url);
  const used = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.ts') || name === 'capabilities.test.ts') continue;
    const text = readFileSync(new URL(name, dir), 'utf8');
    for (const m of text.matchAll(/cap\(\s*\w+\s*,\s*'([a-z_]+)'\s*\)/g)) used.add(m[1] ?? '');
  }
  expect([...used].filter((k) => !KEYS.includes(k))).toEqual([]);
  expect(KEYS.filter((k) => !used.has(k))).toEqual([]);
});

test('every key has a live probe or a reason why not', () => {
  expect(KEYS.filter((k) => !(k in PROBES) && !(k in UNPROBED))).toEqual([]);
});

describeRouters(
  'probe-derived flags',
  (r) => {
    test('no drift: every deterministic flag re-derived from live probes equals the recorded one', async () => {
      const observed = await deriveCapabilities(r);
      if (process.env['PRINT_CAPABILITIES'] === '1') {
        // re-deriving after a router upgrade: the observed values, to review and copy into capabilities.json
        const shown = [...observed].map(([k, v]) => [k, v instanceof Error ? `error: ${v.message}` : v]);
        process.stderr.write(`CAPABILITIES ${r.id} ${JSON.stringify(Object.fromEntries(shown))}\n`);
      }
      const drift: string[] = [];
      for (const [key, value] of observed) {
        const recorded = r.capabilities[key];
        if (value instanceof Error) {
          drift.push(`${key}: the probe failed: ${value.message}`);
          continue;
        }
        if (recorded === 'sometimes') continue;
        if (value !== recorded) drift.push(`${key}: recorded ${String(recorded)}, observed ${value}`);
      }
      expect(drift).toEqual([]);
    });
  },
  [...MATRIX, ...HOSTILE],
);
