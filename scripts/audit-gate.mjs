#!/usr/bin/env node
// Audit gate: `npm audit --json` over the WHOLE tree (dev dependencies included) fails on any `high` or `critical`
// advisory unless audit-allowlist.json has a matching, reviewed, unexpired entry {id (GHSA), package, reason,
// reviewedBy, added, expires}. An entry is accepted only for a package that is absent from the production tree (`npm ls
// --omit=dev --all --json`) and only when `expires` is at most 90 days after `added`; an expired or malformed entry
// fails the gate by itself. Moderate and low advisories are reported.
//
//   node scripts/audit-gate.mjs [--audit <npm-audit.json>] [--prod-tree <npm-ls.json>] [--allowlist <file>]
//                               [--today <YYYY-MM-DD>]
//
// Without --audit / --prod-tree the script runs npm itself; the options feed recorded outputs (the fixture tests in
// test/package/audit-gate.test.ts). Exit status: 0 passed, 1 failed, 2 usage error.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const BLOCKING = new Set(['high', 'critical']);
const MAX_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

/** @param {string} message @returns {never} */
function usage(message) {
  console.error(
    `audit-gate: ${message}\nusage: node scripts/audit-gate.mjs [--audit <file>] [--prod-tree <file>] [--allowlist <file>] [--today <YYYY-MM-DD>]`,
  );
  process.exit(2);
}

/** @type {Record<string, string>} */
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? '';
  if (!['--audit', '--prod-tree', '--allowlist', '--today'].includes(arg)) usage(`unknown argument ${arg}`);
  const value = argv[++i];
  if (value === undefined) usage(`${arg} needs a value`);
  options[arg.slice(2)] = value;
}

/** @param {string} text @param {string} what @returns {unknown} */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(
      `audit-gate: FAILED: ${what} is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    process.exit(1);
  }
}

/** @param {string[]} args @param {string} what @returns {unknown} */
function npmJson(args, what) {
  // npm audit exits non-zero whenever it finds advisories; the JSON on stdout is what counts.
  const result = spawnSync(NPM, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined) {
    console.error(`audit-gate: FAILED: could not run npm ${args.join(' ')} (${result.error.message})`);
    process.exit(1);
  }
  return parseJson(result.stdout, what);
}

/** @param {string} date @returns {number | undefined} UTC midnight of a YYYY-MM-DD date */
function day(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date ? undefined : ms;
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- inputs -------------------------------------------------------------------------------------------------------
const audit =
  options['audit'] === undefined
    ? npmJson(['audit', '--json'], 'npm audit --json')
    : parseJson(readFileSync(options['audit'], 'utf8'), options['audit']);
const prodTree =
  options['prod-tree'] === undefined
    ? npmJson(['ls', '--omit=dev', '--all', '--json'], 'npm ls --omit=dev --all --json')
    : parseJson(readFileSync(options['prod-tree'], 'utf8'), options['prod-tree']);
const allowlistFile = options['allowlist'] ?? 'audit-allowlist.json';
const allowlist = parseJson(readFileSync(allowlistFile, 'utf8'), allowlistFile);
const today = options['today'] === undefined ? day(new Date().toISOString().slice(0, 10)) : day(options['today']);
if (today === undefined) usage('--today needs a date YYYY-MM-DD');

if (!isObject(audit)) {
  console.error('audit-gate: FAILED: npm audit did not return a JSON object');
  process.exit(1);
}
if (audit['error'] !== undefined) {
  const error = isObject(audit['error']) ? audit['error'] : {};
  console.error(`audit-gate: FAILED: npm audit reported an error: ${text(error['summary'] ?? error)}`);
  process.exit(1);
}
if (audit['auditReportVersion'] !== 2 || !isObject(audit['vulnerabilities'])) {
  console.error(
    'audit-gate: FAILED: unexpected npm audit format (auditReportVersion 2 with `vulnerabilities` expected)',
  );
  process.exit(1);
}

/** Every package name in the production tree. @type {Set<string>} */
const production = new Set();
/** @param {unknown} node */
function collect(node) {
  if (!isObject(node) || !isObject(node['dependencies'])) return;
  for (const [name, child] of Object.entries(node['dependencies'])) {
    production.add(name);
    collect(child);
  }
}
collect(prodTree);

/** @type {string[]} */
const failures = [];

// --- allowlist ----------------------------------------------------------------------------------------------------
/** @typedef {{ id: string, package: string, reason: string, reviewedBy: string, added: string, expires: string }} Entry */
/** @type {Entry[]} */
const entries = [];
const rawEntries = isObject(allowlist) && Array.isArray(allowlist['entries']) ? allowlist['entries'] : undefined;
if (rawEntries === undefined) failures.push(`${allowlistFile}: expected an object with an "entries" array`);
for (const [index, raw] of (rawEntries ?? []).entries()) {
  const where = `${allowlistFile} entry ${String(index)}`;
  if (!isObject(raw)) {
    failures.push(`${where}: not an object`);
    continue;
  }
  const fields = ['id', 'package', 'reason', 'reviewedBy', 'added', 'expires'];
  const missing = fields.filter((key) => typeof raw[key] !== 'string' || raw[key] === '');
  if (missing.length > 0) {
    failures.push(`${where}: missing or empty ${missing.join(', ')}`);
    continue;
  }
  const entry = /** @type {Entry} */ (/** @type {unknown} */ (raw));
  const label = `${where} (${entry.id} ${entry.package})`;
  const added = day(entry.added);
  const expires = day(entry.expires);
  if (!/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.id)) failures.push(`${label}: id is not a GHSA id`);
  if (added === undefined || expires === undefined) {
    failures.push(`${label}: added/expires must be dates YYYY-MM-DD`);
    continue;
  }
  if (expires < added || expires - added > MAX_DAYS * DAY) {
    failures.push(`${label}: expires must be at most ${String(MAX_DAYS)} days after added`);
  }
  if (expires < today) failures.push(`${label}: EXPIRED on ${entry.expires} (review it again or remove it)`);
  if (production.has(entry.package)) {
    failures.push(`${label}: ${entry.package} is in the production tree; only dev-only packages may be allowlisted`);
  }
  entries.push(entry);
}

// --- advisories ---------------------------------------------------------------------------------------------------
/** @typedef {{ id: string, source: string, package: string, severity: string, title: string, range: string }} Advisory */
/** @type {Map<string, Advisory>} */
const advisories = new Map();
for (const [name, vulnerability] of Object.entries(audit['vulnerabilities'])) {
  if (!isObject(vulnerability) || !Array.isArray(vulnerability['via'])) continue;
  for (const via of vulnerability['via']) {
    if (!isObject(via)) continue; // a string: "vulnerable through <dependency>", reported under that package
    const url = typeof via['url'] === 'string' ? via['url'] : '';
    const id = /GHSA(-[a-z0-9]{4}){3}/i.exec(url)?.[0] ?? `npm-${text(via['source'])}`;
    const pkg = typeof via['name'] === 'string' ? via['name'] : name;
    advisories.set(`${id} ${pkg}`, {
      id,
      source: text(via['source']),
      package: pkg,
      severity: text(via['severity']),
      title: text(via['title']),
      range: text(via['range']),
    });
  }
}

const used = new Set();
/** @type {string[]} */
const report = [];
for (const advisory of [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const line = `${advisory.severity.padEnd(8)} ${advisory.id} ${advisory.package} ${advisory.range} — ${advisory.title}`;
  if (!BLOCKING.has(advisory.severity)) {
    report.push(`  reported  ${line}`);
    continue;
  }
  const entry = entries.find((e) => e.id === advisory.id && e.package === advisory.package);
  if (entry === undefined) {
    failures.push(`unlisted ${advisory.severity} advisory: ${advisory.id} in ${advisory.package} (${advisory.title})`);
    report.push(`  BLOCKING  ${line}`);
  } else {
    used.add(entry);
    report.push(`  allowed   ${line} (until ${entry.expires}: ${entry.reason}; reviewed by ${entry.reviewedBy})`);
  }
}
for (const entry of entries) {
  if (!used.has(entry)) report.push(`  unused allowlist entry ${entry.id} ${entry.package} (remove it once fixed)`);
}

console.log(
  `audit-gate: ${String(advisories.size)} advisories in the whole tree, ${String(production.size)} production packages, ${String(entries.length)} allowlist entries`,
);
for (const line of report) console.log(line);
if (failures.length > 0) {
  for (const failure of failures) console.error(`audit-gate: ${failure}`);
  console.error(`audit-gate: FAILED (${String(failures.length)} problem(s))`);
  process.exit(1);
}
console.log('audit-gate: passed (no unlisted high or critical advisory)');
