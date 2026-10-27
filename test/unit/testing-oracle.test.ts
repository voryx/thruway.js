// The violation oracle of the reference router (oracle.ts; INV-CL01/CL02/INVOKE): every rule of `ORACLE_RULES` is
// broken by a scripted client in one scenario, and caught with its code, in strict mode (the sim router's default;
// strictness adds `unscripted`, never changes `violations`) and under every dialect — the rules are the client's side
// of the protocol, judged when a frame is written, whatever the router does about it. The allowed neighbours of each
// rule (a reused id that was freed, a frame that crossed one of the router's) are pinned too.
import { afterEach, describe, expect, test } from 'vitest';
import {
  createSimClock,
  createSimRouter,
  DIALECTS,
  type DialectName,
  ORACLE_RULES,
  type SimRouter,
  type ViolationCode,
} from '../../src/testing/sim.js';
import { INVARIANT_IDS } from '../helpers/invariants.js';
import { callFrame, MSG, PEER_ROLES, WampPeer, type Frame } from '../helpers/wamp-peer.js';

interface Ctx {
  readonly router: SimRouter;
  readonly settle: () => Promise<void>;
  /** A peer whose socket is open (no HELLO yet). */
  open(): Promise<WampPeer>;
  /** A peer in a session. */
  session(details?: Record<string, unknown>): Promise<WampPeer>;
}

/** Routers of the running test: none may have failed internally. */
const routers: SimRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) expect(r.errors).toEqual([]);
});

function context(dialect: DialectName): Ctx {
  const clock = createSimClock();
  const router = createSimRouter({
    clock,
    dialect,
    authenticate: (hello) =>
      hello.realm === 'auth' ? { challenge: { method: 'ticket' }, verify: () => ({ welcome: {} }) } : { welcome: {} },
  });
  routers.push(router);
  const settle = (): Promise<void> => clock.runUntilIdle();
  const open = async (): Promise<WampPeer> => {
    const p = new WampPeer(router.WebSocket, router.url, () => clock.advance(0)); // the peer's waits pass no time
    await settle();
    return p;
  };
  return {
    router,
    settle,
    open,
    session: async (details = {}) => {
      const p = await open();
      const w = await p.join('realm1', details);
      expect(w[0]).toBe(MSG.WELCOME);
      return p;
    },
  };
}

/** Write frames without waiting for anything (the oracle judges them as written). */
function write(p: WampPeer, ...frames: (Frame | string)[]): void {
  for (const f of frames) {
    if (typeof f === 'string') p.ws.send(f);
    else p.send(f);
  }
}

async function challenged(c: Ctx): Promise<WampPeer> {
  const p = await c.open();
  p.send([MSG.HELLO, 'auth', { roles: PEER_ROLES }]);
  await p.nextOf(MSG.CHALLENGE);
  return p;
}

/** A callee with an INVOCATION received; `progress`: the CALL asked for progress. */
async function invoked(c: Ctx, progress = false): Promise<{ callee: WampPeer; caller: WampPeer; inv: Frame }> {
  const callee = await c.session();
  await callee.register('com.example.p');
  const caller = await c.session();
  caller.send(callFrame(1, 'com.example.p', undefined, undefined, progress ? { receive_progress: true } : {}));
  return { callee, caller, inv: await callee.nextOf(MSG.INVOCATION) };
}

/** Each rule: how to break it, and the rule text expected (undefined: the router never created the premise, e.g. a
 *  dialect that sends no INTERRUPT killnowait — then nothing may be flagged). */
const SCENARIOS: Readonly<Record<ViolationCode, (c: Ctx) => Promise<string | undefined>>> = {
  'not-an-array': async (c) => {
    write(await c.session(), 'not json');
    return 'the frame is not a JSON array';
  },
  'type-not-integer': async (c) => {
    write(await c.session(), ['48', 1, {}, 'com.x']);
    return 'the message type is not an integer';
  },
  'frame-too-large': async (c) => {
    const p = await c.session();
    const frame = [MSG.PUBLISH, 1, {}, 'com.t', ['x'.repeat(16 * 1024 * 1024 - 21)]];
    write(p, frame); // 16 MiB + 1 byte
    return `a frame of ${String(16 * 1024 * 1024 + 1)} bytes (the limit is 16 MiB)`;
  },
  'after-end': async (c) => {
    write(await c.session(), [MSG.GOODBYE, {}, 'wamp.close.close_realm'], callFrame(1, 'com.x'));
    return "CALL after the client's GOODBYE";
  },
  'after-router-goodbye': async (c) => {
    const p = await c.session();
    c.router.goodbye();
    await c.settle();
    const goodbye = p.take((f) => f[0] === MSG.GOODBYE);
    write(p, callFrame(1, 'com.x'));
    if (goodbye === undefined) return undefined; // Nexus loses it: the socket is closed, nothing more is written
    return "CALL after the router's GOODBYE (only the GOODBYE reply may follow)";
  },
  'before-hello': async (c) => {
    write(await c.open(), [MSG.SUBSCRIBE, 1, {}, 'com.t']);
    return 'SUBSCRIBE before HELLO';
  },
  'second-hello': async (c) => {
    write(await c.session(), [MSG.HELLO, 'realm1', { roles: PEER_ROLES }]);
    return 'a second HELLO';
  },
  'hello-malformed': async (c) => {
    write(await c.open(), [MSG.HELLO, 5, { roles: PEER_ROLES }]);
    return 'malformed HELLO';
  },
  'hello-without-roles': async (c) => {
    write(await c.open(), [MSG.HELLO, 'realm1', {}]);
    return 'HELLO without roles';
  },
  'authenticate-without-challenge': async (c) => {
    write(await c.open(), [MSG.HELLO, 'auth', { roles: PEER_ROLES }], [MSG.AUTHENTICATE, 'early', {}]);
    return 'AUTHENTICATE without a CHALLENGE';
  },
  'authenticate-after-welcome': async (c) => {
    write(await c.session(), [MSG.AUTHENTICATE, 'late', {}]);
    return 'AUTHENTICATE after WELCOME';
  },
  'authenticate-malformed': async (c) => {
    write(await challenged(c), [MSG.AUTHENTICATE, 42, {}]);
    return 'malformed AUTHENTICATE';
  },
  'before-welcome': async (c) => {
    write(await challenged(c), callFrame(1, 'com.x'));
    return 'CALL before WELCOME';
  },
  'not-a-client-message': async (c) => {
    write(await c.session(), [MSG.WELCOME, 1, {}]);
    return 'WELCOME is not a message a client sends in a session';
  },
  malformed: async (c) => {
    write(await c.session(), [MSG.SUBSCRIBE, 0, {}, 'com.t']);
    return 'malformed SUBSCRIBE';
  },
  'invalid-uri': async (c) => {
    write(await c.session(), [MSG.SUBSCRIBE, 1, {}, 'bad uri']);
    return 'SUBSCRIBE with an invalid URI "bad uri"';
  },
  'request-id-in-flight': async (c) => {
    write(await c.session(), callFrame(7, 'com.x'), [MSG.SUBSCRIBE, 7, {}, 'com.t']);
    return 'SUBSCRIBE with request id 7, which a CALL still in flight uses';
  },
  'cancel-unknown-call': async (c) => {
    write(await c.session(), [MSG.CANCEL, 40, { mode: 'killnowait' }]);
    return 'CANCEL of CALL 40, never written on this connection';
  },
  'cancel-mode': async (c) => {
    write(await c.session(), callFrame(1, 'com.x'), [MSG.CANCEL, 1, { mode: 'kill' }]);
    return 'CANCEL with mode "kill"';
  },
  'cancel-twice': async (c) => {
    write(
      await c.session(),
      callFrame(1, 'com.x'),
      [MSG.CANCEL, 1, { mode: 'killnowait' }],
      [MSG.CANCEL, 1, { mode: 'killnowait' }],
    );
    return 'a second CANCEL of CALL 1';
  },
  'unsubscribe-unknown-id': async (c) => {
    write(await c.session(), [MSG.UNSUBSCRIBE, 1, 424242]);
    return 'UNSUBSCRIBE of a subscription id this session was never given';
  },
  'unregister-unknown-id': async (c) => {
    write(await c.session(), [MSG.UNREGISTER, 1, 424242]);
    return 'UNREGISTER of a registration id this session was never given';
  },
  'error-not-for-invocation': async (c) => {
    write(await c.session(), [MSG.ERROR, MSG.CALL, 1, {}, 'com.example.e']);
    return 'ERROR for request type 48 (a client only answers INVOCATIONs)';
  },
  'answer-unknown-invocation': async (c) => {
    write(await c.session(), [MSG.YIELD, 12345, {}]);
    return 'YIELD for an INVOCATION this session never received';
  },
  'answer-after-final': async (c) => {
    const { callee, inv } = await invoked(c);
    write(callee, [MSG.YIELD, inv[1], {}, [1]], [MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'com.e']);
    return `ERROR for INVOCATION ${String(inv[1])} after its final answer`;
  },
  'answer-after-killnowait': async (c) => {
    const { callee, caller, inv } = await invoked(c);
    caller.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await c.settle();
    const interrupt = callee.take((f) => f[0] === MSG.INTERRUPT);
    write(callee, [MSG.YIELD, inv[1], {}]);
    // Thruway PHP's INTERRUPT {} is a kill (an answer is due); Bondy, fox-wamp and wamp-server send none
    if ((interrupt?.[2] as { mode?: unknown } | undefined)?.mode !== 'killnowait') return undefined;
    return `YIELD for INVOCATION ${String(inv[1])} after its INTERRUPT killnowait`;
  },
  'unrequested-progress': async (c) => {
    const { callee, inv } = await invoked(c);
    write(callee, [MSG.YIELD, inv[1], { progress: true }, [1]]);
    return 'progress YIELD although the INVOCATION did not ask for progress';
  },
};

describe('the oracle catches each rule it lists', () => {
  test('every rule has a description and a scenario', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(ORACLE_RULES).sort());
    for (const text of Object.values(ORACLE_RULES)) {
      expect(text).toMatch(/^\S.*\S$/);
      // a trailing tag names invariants of test/helpers/invariants.ts
      const tag = / \[([^\]]+)\]$/.exec(text)?.[1];
      if (tag !== undefined) expect(INVARIANT_IDS).toEqual(expect.arrayContaining(tag.split(', ')));
    }
    expect(Object.isFrozen(ORACLE_RULES)).toBe(true);
  });

  for (const code of Object.keys(SCENARIOS) as ViolationCode[]) {
    test(`${code}: ${ORACLE_RULES[code]}`, async () => {
      const c = context('spec');
      const rule = await SCENARIOS[code](c);
      await c.settle();
      expect(c.router.violations.map((v) => [v.code, v.rule])).toEqual([[code, rule]]);
    });
  }

  test('the rules do not depend on the dialect: every scenario gives the same violation on every router', async () => {
    const premiseless: string[] = [];
    for (const dialect of Object.keys(DIALECTS) as DialectName[]) {
      for (const code of Object.keys(SCENARIOS) as ViolationCode[]) {
        const c = context(dialect);
        const rule = await SCENARIOS[code](c);
        await c.settle();
        if (rule === undefined) premiseless.push(`${dialect} ${code}`);
        expect([dialect, code, c.router.violations.map((v) => [v.code, v.rule])]).toEqual([
          dialect,
          code,
          rule === undefined ? [] : [[code, rule]],
        ]);
      }
    }
    expect(premiseless).toEqual([
      'thruway-php answer-after-killnowait',
      'nexus after-router-goodbye',
      'bondy answer-after-killnowait',
      'fox-wamp answer-after-killnowait',
      'wamp-server answer-after-killnowait',
    ]);
  });
});

describe('request ids in flight (INV-CL02)', () => {
  test('a CALL is in flight until its final RESULT or ERROR arrives, or the client cancelled it; progress RESULTs do not end it', async () => {
    const c = context('spec');
    c.router.procedure('com.p', (_a, _k, details) =>
      details['receive_progress'] === true
        ? {
            subscribe: (o: { next(v: unknown): void; complete(): void }) => {
              o.next(1);
              setTimeout(() => {
                o.complete();
              }, 0);
              return { unsubscribe: () => undefined };
            },
          }
        : 'done',
    );
    c.router.procedure('com.fail', () => {
      throw new Error('no');
    });
    c.router.procedure('com.never', () => new Promise(() => undefined));
    const p = await c.session();
    p.send(callFrame(1, 'com.p'));
    await p.nextOf(MSG.RESULT, 1);
    p.send(callFrame(1, 'com.fail')); // freed by the RESULT
    await p.nextOf(MSG.ERROR);
    p.send(callFrame(1, 'com.never')); // freed by the ERROR
    p.send([MSG.CANCEL, 1, { mode: 'killnowait' }]);
    p.send(callFrame(1, 'com.never')); // freed by the CANCEL (the client may forget a cancelled call)
    p.send(callFrame(2, 'com.p', undefined, undefined, { receive_progress: true }));
    await p.nextOf(MSG.RESULT, 2); // the progress RESULT
    p.send([MSG.SUBSCRIBE, 2, {}, 'com.t']); // still in flight
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual([
      'SUBSCRIBE with request id 2, which a CALL still in flight uses',
    ]);
  });

  test('an acknowledged PUBLISH is never in flight (the client forgets one the app unsubscribed), nor an unacknowledged one or the liveness probe', async () => {
    const c = context('spec');
    c.router.ignore((f) => f[0] === MSG.PUBLISH && f[1] === 3); // never acknowledged
    const p = await c.session();
    p.send([MSG.PUBLISH, 3, { acknowledge: true }, 'com.t']);
    p.send([MSG.PUBLISH, 4, { acknowledge: true }, 'com.t']);
    p.send([MSG.PUBLISH, 5, {}, 'com.t']);
    p.send(callFrame(6, 'thruway.js.ping'));
    p.send([MSG.PUBLISH, 3, { acknowledge: true }, 'com.t']); // the app unsubscribed the first one: its id is free
    p.send(callFrame(4, 'com.x')); // before the PUBLISHED: free too
    p.send(callFrame(5, 'com.x'));
    p.send(callFrame(6, 'com.y')); // the probe's id: liveness may forget its probe
    await c.settle();
    expect(c.router.violations).toEqual([]);
  });

  test('a probe CALL reusing an id in flight is flagged once and takes the id over; a CANCEL frees only a CALL', async () => {
    const c = context('spec');
    c.router.procedure('com.never', () => new Promise(() => undefined));
    c.router.ignore((f) => f[0] === MSG.PUBLISH && f[1] === 9);
    const p = await c.session();
    p.send(callFrame(5, 'com.never'));
    p.send(callFrame(5, 'thruway.js.ping')); // flagged; the probe holds 5 now, and may be forgotten
    p.send(callFrame(5, 'com.x'));
    p.send([MSG.PUBLISH, 9, { acknowledge: true }, 'com.t']); // never answered
    p.send([MSG.CANCEL, 9, { mode: 'killnowait' }]); // no CALL 9: frees nothing
    p.send(callFrame(9, 'com.x'));
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual([
      'CALL with a request id that is still in flight',
      'CANCEL of CALL 9, never written on this connection',
    ]);
  });

  test('another kind of request with the id of a CALL in flight, as named', async () => {
    const c = context('spec');
    c.router.procedure('com.never', () => new Promise(() => undefined));
    const p = await c.session();
    const sub = await p.subscribe('com.t');
    p.send(callFrame(9, 'com.never'));
    p.send([MSG.PUBLISH, 9, { acknowledge: true }, 'com.t']);
    p.send([MSG.REGISTER, 9, {}, 'com.p']);
    p.send([MSG.UNSUBSCRIBE, 9, sub]);
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual([
      'PUBLISH with request id 9, which a CALL still in flight uses',
      'REGISTER with request id 9, which a CALL still in flight uses',
      'UNSUBSCRIBE with request id 9, which a CALL still in flight uses',
    ]);
  });

  test('an ERROR for another request type, a Thruway [8,8,…], a progress RESULT or a PUBLISHED with its id frees nothing', async () => {
    const c = context('thruway-php');
    c.router.procedure('com.never', () => new Promise(() => undefined));
    const p = await c.session();
    p.send(callFrame(4, 'com.never', undefined, undefined, { receive_progress: true }));
    await c.settle();
    for (const frame of [
      [MSG.ERROR, MSG.ERROR, 4, {}, 'wamp.error.no_such_procedure'],
      [MSG.ERROR, MSG.SUBSCRIBE, 4, {}, 'wamp.error.x'],
      [MSG.ERROR, MSG.PUBLISH, 4, {}, 'wamp.error.x'],
      [MSG.PUBLISHED, 4, 77],
      [MSG.RESULT, 4, { progress: true }, ['p1'], { k: 1 }],
      [MSG.RESULT, 4, { progress: true }, null, []], // null args and a PHP [] dict are normalised, not invalid
    ]) {
      c.router.sendRaw(JSON.stringify(frame));
    }
    await c.settle();
    p.send(callFrame(4, 'com.x'));
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual(['CALL with a request id that is still in flight']);
  });

  test('ERROR(49) and a payload-invalid progress RESULT end the CALL: the client settles it on them (Thruway T2)', async () => {
    const c = context('thruway-php');
    c.router.procedure('com.never', () => new Promise(() => undefined));
    const p = await c.session();
    const progress = { receive_progress: true };
    for (const id of [1, 2, 3, 4]) p.send(callFrame(id, 'com.never', undefined, undefined, progress));
    await c.settle();
    for (const frame of [
      [MSG.ERROR, MSG.CANCEL, 1, {}, 'wamp.error.canceled'], // an ERROR(49) without a CANCEL: settles the call
      [MSG.RESULT, 2, { progress: true }, 'not an array'],
      [MSG.RESULT, 3, { progress: true }, [], 'not a dict'],
      [MSG.RESULT, 4, 'not a dict'], // invalid details: never a progress RESULT, so final for the oracle anyway
    ]) {
      c.router.sendRaw(JSON.stringify(frame));
    }
    await c.settle();
    for (const id of [1, 2, 3, 4]) p.send(callFrame(id, 'com.x'));
    await c.settle();
    expect(c.router.violations).toEqual([]);
  });
});

describe('malformed answers', () => {
  test('a YIELD or invocation ERROR of the wrong shape is malformed (with its code), and is no answer', async () => {
    const c = context('spec');
    const { callee, inv } = await invoked(c);
    write(callee, [MSG.YIELD, inv[1], 'options'], [MSG.ERROR, MSG.INVOCATION, inv[1], {}, 5], [MSG.YIELD, inv[1], {}]);
    await c.settle();
    expect(c.router.violations.map((v) => [v.code, v.rule])).toEqual([
      ['malformed', 'malformed YIELD'],
      ['malformed', 'malformed ERROR'],
    ]);
  });
});

describe('frames the client receives with missing or null details', () => {
  test('a RESULT without details, or with null details, is final; an INTERRUPT or INVOCATION with null options is no killnowait / no progress', async () => {
    const c = context('spec');
    const p = await c.session();
    p.send(callFrame(1, 'com.x'));
    p.send(callFrame(2, 'com.x'));
    await c.settle();
    c.router.sendRaw(JSON.stringify([MSG.RESULT, 1]));
    c.router.sendRaw(JSON.stringify([MSG.RESULT, 2, null]));
    c.router.sendRaw(JSON.stringify([MSG.INVOCATION, 50, 1, null]));
    c.router.sendRaw(JSON.stringify([MSG.INTERRUPT, 50, null]));
    await c.settle();
    p.send(callFrame(1, 'com.x'));
    p.send(callFrame(2, 'com.x'));
    p.send([MSG.YIELD, 50, { progress: true }]);
    await c.settle();
    expect(c.router.violations.map((v) => v.code)).toEqual(['unrequested-progress']);
  });
});

describe('ids the client was given (INV-CL02)', () => {
  test('a registration id received in an INVOCATION and a subscription id received in an EVENT count as given, on that connection only', async () => {
    const c = context('spec');
    const p = await c.session();
    c.router.sendRaw(JSON.stringify([MSG.INVOCATION, 50, 7777, {}]));
    c.router.sendRaw(JSON.stringify([MSG.EVENT, 8888, 1, {}]));
    await c.settle();
    p.send([MSG.UNREGISTER, 1, 7777]);
    p.send([MSG.UNSUBSCRIBE, 2, 8888]);
    const q = await c.session(); // a later connection was given neither
    q.send([MSG.UNREGISTER, 1, 7777]);
    q.send([MSG.UNSUBSCRIBE, 2, 8888]);
    await c.settle();
    expect(c.router.violations.map((v) => [v.frame.connection, v.code])).toEqual([
      [2, 'unregister-unknown-id'],
      [2, 'unsubscribe-unknown-id'],
    ]);
  });
});

describe('the frame shapes beyond requests: closing frames, AUTHENTICATE, error URIs, CANCEL modes, the size limit', () => {
  test('GOODBYE and ABORT need a details dict and a reason with the exact URI rule; nothing may follow either', async () => {
    const c = context('spec');
    const frames: Frame[] = [
      [MSG.GOODBYE, 'wamp.close.close_realm', {}],
      [MSG.GOODBYE, {}, 'not a uri'],
      [MSG.ABORT, {}, 5],
      [MSG.ABORT, {}, 'wamp..error'],
      [MSG.GOODBYE, {}, 'wamp.close.close_realm'],
    ];
    const rules: string[][] = [];
    for (const frame of frames) {
      const p = await c.session();
      const before = c.router.violations.length;
      write(p, frame, callFrame(1, 'com.x'));
      await c.settle();
      rules.push(c.router.violations.slice(before).map((v) => `${v.code}: ${v.rule}`));
    }
    const after = (what: string): string => `after-end: CALL after the client's ${what}`;
    expect(rules).toEqual([
      ['malformed: malformed GOODBYE', after('GOODBYE')],
      ['invalid-uri: GOODBYE with an invalid reason "not a uri"', after('GOODBYE')],
      ['malformed: malformed ABORT', after('ABORT')],
      ['invalid-uri: ABORT with an invalid reason "wamp..error"', after('ABORT')],
      [after('GOODBYE')],
    ]);
  });

  test('an ABORT during the handshake is judged too; a GOODBYE there is no answer at all', async () => {
    const c = context('spec');
    write(await challenged(c), [MSG.ABORT, [], 'wamp.error.cannot_authenticate']);
    write(await challenged(c), [MSG.ABORT, { message: 'no' }, 'wamp.error.cannot_authenticate']);
    write(await challenged(c), [MSG.GOODBYE, {}, 'wamp.close.close_realm']);
    await c.settle();
    expect(c.router.violations.map((v) => `${v.code}: ${v.rule}`)).toEqual([
      'malformed: malformed ABORT',
      'before-welcome: GOODBYE before WELCOME',
    ]);
  });

  test('AUTHENTICATE needs a string signature and an extra dict', async () => {
    const c = context('spec');
    write(await challenged(c), [MSG.AUTHENTICATE, 'sig']);
    write(await challenged(c), [MSG.AUTHENTICATE, 'sig', []]);
    write(await challenged(c), [MSG.AUTHENTICATE, 'sig', {}]);
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual(['malformed AUTHENTICATE', 'malformed AUTHENTICATE']);
  });

  test('a callee ERROR needs a URI with the exact rule (an invalid handler error URI becomes runtime_error)', async () => {
    const c = context('spec');
    const { callee, inv } = await invoked(c);
    write(callee, [MSG.ERROR, MSG.INVOCATION, inv[1], {}, 'com.example.bad uri'], [MSG.YIELD, inv[1], {}]);
    await c.settle();
    expect(c.router.violations.map((v) => `${v.code}: ${v.rule}`)).toEqual([
      'invalid-uri: ERROR with an invalid URI "com.example.bad uri"',
      `answer-after-final: YIELD for INVOCATION ${String(inv[1])} after its final answer`,
    ]);
    const d = context('spec');
    const second = await invoked(d);
    write(second.callee, [MSG.ERROR, MSG.INVOCATION, second.inv[1], { x: 1 }, 'wamp.error.runtime_error', ['m'], {}]);
    await d.settle();
    expect(d.router.violations).toEqual([]);
  });

  test('every CANCEL mode but killnowait is flagged (a missing one too); the CANCEL still counts for cancel-twice', async () => {
    const c = context('spec');
    const p = await c.session();
    write(p, callFrame(1, 'com.x'), callFrame(2, 'com.x'), callFrame(3, 'com.x'), callFrame(4, 'com.x'));
    write(p, [MSG.CANCEL, 1, {}], [MSG.CANCEL, 2, { mode: 'skip' }], [MSG.CANCEL, 3, { mode: 5 }]);
    write(p, [MSG.CANCEL, 4, { mode: 'killnowait', extra: true }], [MSG.CANCEL, 1, { mode: 'killnowait' }]);
    await c.settle();
    expect(c.router.violations.map((v) => `${v.code}: ${v.rule}`)).toEqual([
      'cancel-mode: CANCEL with mode (none)',
      'cancel-mode: CANCEL with mode "skip"',
      'cancel-mode: CANCEL with mode 5',
      'cancel-twice: a second CANCEL of CALL 1',
    ]);
  });

  test('the size limit counts UTF-8 bytes of text and the length of a binary frame; 16 MiB exactly is allowed', async () => {
    const c = context('spec');
    const limit = 16 * 1024 * 1024;
    const p = await c.session();
    const text = (n: number, char = 'x'): string => JSON.stringify([MSG.PUBLISH, 1, {}, 'com.t', [char.repeat(n)]]);
    const base = text(0).length;
    p.ws.send(text(limit - base)); // exactly 16 MiB
    p.ws.send(text((limit - base) / 2 + 1, 'é')); // 2 bytes each: one byte over
    p.ws.send(new TextEncoder().encode(text(limit - base + 1))); // binary, one byte over
    await c.settle();
    expect(c.router.violations.map((v) => v.rule)).toEqual([
      `a frame of ${String(limit + 2)} bytes (the limit is 16 MiB)`,
      `a frame of ${String(limit + 1)} bytes (the limit is 16 MiB)`,
    ]);
  });
});
