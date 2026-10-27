// protocol/hello.ts: the HELLO details snapshot, the agent string against package.json, only the announced keys (v2
// sent the whole options object) and only implemented features.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { AGENT, HELLO_ROLES, helloDetails } from '../../src/protocol/hello.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

describe('HELLO details', () => {
  test('snapshot: anonymous', () => {
    const details = helloDetails({ authmethods: [], authid: undefined, authextra: undefined });
    expect(JSON.stringify(details, null, 2)).toMatchInlineSnapshot(`
      "{
        "agent": "thruway.js/3.0.0-beta2",
        "roles": {
          "caller": {
            "features": {
              "caller_identification": true,
              "progressive_call_results": true,
              "call_canceling": true
            }
          },
          "callee": {
            "features": {
              "caller_identification": true,
              "pattern_based_registration": true,
              "shared_registration": true,
              "progressive_call_results": true,
              "call_canceling": true,
              "registration_revocation": true
            }
          },
          "publisher": {
            "features": {
              "publisher_identification": true,
              "subscriber_blackwhite_listing": true,
              "publisher_exclusion": true
            }
          },
          "subscriber": {
            "features": {
              "publisher_identification": true,
              "pattern_based_subscription": true,
              "subscription_revocation": true
            }
          }
        }
      }"
    `);
  });

  test('the agent string carries the package version', () => {
    expect(AGENT).toBe(`thruway.js/${pkg.version}`);
    expect(helloDetails({ authmethods: [], authid: undefined, authextra: undefined })['agent']).toBe(AGENT);
  });

  test('authmethods, authid and authextra only when given, in this order', () => {
    const authextra = { pubkey: 'ab' };
    const details = helloDetails({ authmethods: ['cryptosign', 'ticket'], authid: 'joe', authextra });
    expect(Object.keys(details)).toEqual(['agent', 'roles', 'authmethods', 'authid', 'authextra']);
    expect(details['authmethods']).toEqual(['cryptosign', 'ticket']);
    expect(details['authid']).toBe('joe');
    expect(details['authextra']).toBe(authextra);
    expect(Object.keys(helloDetails({ authmethods: ['ticket'], authid: undefined, authextra: undefined }))).toEqual([
      'agent',
      'roles',
      'authmethods',
    ]);
    expect(Object.keys(helloDetails({ authmethods: [], authid: '', authextra: {} }))).toEqual([
      'agent',
      'roles',
      'authid',
      'authextra',
    ]);
  });

  test('nothing else leaks (v2 sent the whole options object): only these keys, whatever the input object carries', () => {
    const auth = {
      authmethods: ['ticket'],
      authid: 'a',
      authextra: undefined,
      realm: 'r',
      onChallenge: () => 't',
      ticket: 'secret',
    };
    expect(Object.keys(helloDetails(auth)).sort()).toEqual(['agent', 'authid', 'authmethods', 'roles']);
  });

  test('a new frozen object per call; authmethods copied; roles deeply frozen and shared', () => {
    const methods = ['ticket'];
    const one = helloDetails({ authmethods: methods, authid: undefined, authextra: undefined });
    const two = helloDetails({ authmethods: methods, authid: undefined, authextra: undefined });
    expect(one).not.toBe(two);
    expect(Object.isFrozen(one)).toBe(true);
    expect(one['authmethods']).not.toBe(methods);
    expect(Object.isFrozen(one['authmethods'])).toBe(true);
    methods.push('wampcra');
    expect(one['authmethods']).toEqual(['ticket']);
    expect(one['roles']).toBe(HELLO_ROLES);
    expect(Object.isFrozen(HELLO_ROLES)).toBe(true);
    expect(Object.isFrozen(HELLO_ROLES.callee)).toBe(true);
    expect(Object.isFrozen(HELLO_ROLES.callee.features)).toBe(true);
  });
});

describe('announced features', () => {
  const all = Object.values(HELLO_ROLES).flatMap((role) => Object.keys(role.features));

  test('roles are never empty (Crossbar closes on roles:{}), every feature is true', () => {
    expect(Object.keys(HELLO_ROLES)).toEqual(['caller', 'callee', 'publisher', 'subscriber']);
    for (const role of Object.values(HELLO_ROLES)) {
      expect(Object.keys(role.features).length).toBeGreaterThan(0);
      for (const value of Object.values(role.features)) expect(value).toBe(true);
    }
  });

  test('the callee announces call_canceling alongside progressive results (a WAMP spec MUST; Thruway T2)', () => {
    expect(HELLO_ROLES.callee.features.call_canceling).toBe(true);
    expect(HELLO_ROLES.callee.features.progressive_call_results).toBe(true);
    expect(HELLO_ROLES.caller.features.call_canceling).toBe(true);
  });

  test.each([
    'call_timeout',
    'progressive_call_invocations',
    'payload_passthru_mode',
    'sharded_registration',
    'sharded_subscription',
    'call_trustlevels',
    'publication_trustlevels',
    'event_retention',
    'call_cancelling',
    'call_reroute',
  ])('%s is not announced', (feature) => {
    expect(all).not.toContain(feature);
  });
});
