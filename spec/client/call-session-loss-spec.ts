declare const global: any;

import {Observable} from 'rxjs/Observable';
import {Subject} from 'rxjs/Subject';
import {Subscriber} from 'rxjs/Subscriber';
import {Subscription} from 'rxjs/Subscription';
import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/throw';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/finally';
import 'rxjs/add/operator/merge';
import {assert} from 'chai';
import {cold} from '../helpers/marble-testing';
import {xit as it} from '../helpers/test-helpers';
import {Client, SessionData} from '../../src/Client';
import {WampErrorException} from '../../src/Common/WampErrorException';
import {IMessage} from '../../src/Messages/Message';
import {OpenMessage} from '../../src/Messages/OpenMessage';
import {ChallengeMessage} from '../../src/Messages/ChallengeMessage';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {AbortMessage} from '../../src/Messages/AbortMessage';
import {GoodbyeMessage} from '../../src/Messages/GoodbyeMessage';
import {CallMessage} from '../../src/Messages/CallMessage';
import {CancelMessage} from '../../src/Messages/CancelMessage';
import {ResultMessage} from '../../src/Messages/ResultMessage';
import {ErrorMessage} from '../../src/Messages/ErrorMessage';

// A call() made while the client has no session (no socket, or a handshake that fails) waits for the next WELCOME
// and is sent once, in that session; the reconnect attempts that fail in between do not fail it. Losing a session does
// not get in the way of calls made after the reconnect, and client.close(), which leaves the session up, does not lose it.

const CALL_AT = 95;          // the call in flight goes out inside session 1 ...
const LOSS_AT = 100;         // ... which is lost before the RESULT, due ANSWER_DELAY frames after the CALL, arrives
const ANSWER_DELAY = 10;
const TRANSPORT_RETRY = 30;  // frames before the client reconnects (constructor retryWhen)

const IN_FLIGHT = 'testing.in_flight';
const FAILING = 'testing.failing';               // the router answers it with an ERROR
const FAILING_ERROR = 'com.example.error.no_such_user';
const UNANSWERED = 'testing.unanswered';         // the callee is still working on it when the session ends

const CLOSED = new Error('socket closed');
const ABORT_DETAILS = '{"message":"The router ended the session"}';

// 'aborted' / 'ended': the router ended the session with ABORT / GOODBYE and ignores the client from then on, but the
// socket stays open until it is closed
type SocketState = 'closed' | 'handshake' | 'session' | 'aborted' | 'ended';

interface Connection {
    id: number;
    state: SocketState;
    sessions: number; // WELCOMEs seen on this socket
    replies: Subject<IMessage>;
}

const now = (): number => global.rxTestScheduler.now();

/**
 * Fake transport with one socket per subscription, like WebSocketTransport. Every write the client makes is logged
 * as "<frame> s<socket> <state> <message>", a CANCEL with the procedure of the CALL it cancels. The router answers
 * every plain CALL made inside an established session ANSWER_DELAY frames later (a RESULT, or an ERROR for FAILING;
 * a progressive CALL gets one progress RESULT), but only while that same session is still established: an answer
 * is never delivered into a later session or handshake.
 */
class FakeRouter {
    public readonly writes: string[] = [];
    public readonly transport: Subject<IMessage>;
    private conn: Connection = {id: 0, state: 'closed', sessions: 0, replies: null};
    private count = 0;
    private procedures: { [requestId: number]: string } = {};

    constructor(socket: (n: number) => Observable<IMessage>) {
        const inbound = Observable.defer(() => {
            const conn: Connection = {id: ++this.count, state: 'closed', sessions: 0, replies: new Subject<IMessage>()};
            this.conn = conn;
            return socket(conn.id)
                .merge(conn.replies)
                .do(
                    (m: IMessage) => {
                        if (m instanceof OpenMessage) {
                            conn.state = 'handshake';
                        }
                        if (m instanceof WelcomeMessage) {
                            conn.state = 'session';
                            conn.sessions++;
                        }
                        if (m instanceof AbortMessage) {
                            conn.state = 'aborted';
                        }
                        if (m instanceof GoodbyeMessage) {
                            conn.state = 'ended';
                        }
                    },
                    () => conn.state = 'closed'
                )
                .finally(() => conn.state = 'closed');
        });

        this.transport = Subject.create(new Subscriber((msg: IMessage) => this.receive(msg)), inbound);
    }

    // Writes of one message kind, e.g. 'CALL' or 'CANCEL'
    public written(kind: string): string[] {
        return this.writes.filter(w => w.split(' ')[3] === kind);
    }

    get log(): string {
        return '; client wrote ' + JSON.stringify(this.writes);
    }

    private receive(msg: IMessage) {
        const conn = this.conn;
        this.writes.push(now() + ' s' + conn.id + ' ' + conn.state + ' ' + this.summarize(msg));
        if (msg instanceof CallMessage && conn.state === 'session') {
            this.answer(msg, conn);
        }
    }

    private answer(call: CallMessage, conn: Connection) {
        if (call.procedure === UNANSWERED) {
            return;
        }
        let reply: IMessage = new ResultMessage(call.requestId, {}, ['result from socket ' + conn.id], {});
        if ((call.options as any).receive_progress) {
            reply = new ResultMessage(call.requestId, {progress: true}, ['tick from socket ' + conn.id], {});
        } else if (call.procedure === FAILING) {
            reply = new ErrorMessage(CallMessage.MSG_CALL, call.requestId, {}, FAILING_ERROR, ['no such user']);
        }
        const session = conn.sessions;
        global.rxTestScheduler.schedule(() => {
            if (conn.state === 'session' && conn.sessions === session) {
                conn.replies.next(reply);
            }
        }, ANSWER_DELAY);
    }

    private summarize(msg: IMessage): string {
        if (msg instanceof CallMessage) {
            this.procedures[msg.requestId] = msg.procedure;
            return 'CALL ' + msg.procedure;
        }
        if (msg instanceof CancelMessage) {
            return 'CANCEL ' + this.procedures[msg.requestId];
        }
        const w = msg.wampifiedMsg();
        switch (w[0]) {
            case 1:
                return 'HELLO ' + w[1];
            case 5:
                return 'AUTHENTICATE ' + w[1];
            default:
                return JSON.stringify(w);
        }
    }
}

function socketValues(n: number) {
    return {
        o: new OpenMessage({event: null}),
        c: new ChallengeMessage('ticket', {}),
        w: new WelcomeMessage(n, {}),
        a: new AbortMessage(JSON.parse(ABORT_DETAILS), 'wamp.error.protocol_violation'),
        g: new GoodbyeMessage({}, 'wamp.close.system_shutdown')
    };
}

// Socket n of a scripted router plays sockets[n - 1]
function scripted(...sockets: Array<Observable<IMessage>>): (n: number) => Observable<IMessage> {
    return n => sockets[n - 1] || Observable.throw(new Error('the test did not script socket ' + n));
}

function describeError(e: any): string {
    if (e instanceof WampErrorException) {
        return 'WampErrorException(' + e.errorUri + ')';
    }
    return e instanceof Error ? e.name + '(' + e.message + ')' : String(e);
}

// How session 1 (WELCOME at 40) ends at LOSS_AT
interface Loss {
    name: string;
    sockets: () => Array<Observable<IMessage>>;
    act?: (client: Client) => void; // what the app does at LOSS_AT
}

// The socket errors at 100, as WebSocketTransport reports any close; reconnect at 130, WELCOME at 170
const SOCKET_DROP: Loss = {
    name: 'a socket drop',
    sockets: () => [cold('o-c-w-----#', socketValues(1), CLOSED), cold('o-c-w', socketValues(2))]
};

/** @test {client} */
describe('Client call when its session ends', () => {

    let subs: Subscription;

    beforeEach(() => {
        subs = new Subscription();
    });

    afterEach(() => {
        subs.unsubscribe();
    });

    function connect(router: FakeRouter): Client {
        const client = new Client(router.transport, 'realm1', {
            retryWhen: attempts => attempts.delay(TRANSPORT_RETRY, global.rxTestScheduler)
        });
        client.onChallenge(() => Observable.of('token'));
        return client;
    }

    // Keeps the client's session stream connected, like the app's onOpen listener
    function watchSessions(client: Client): string[] {
        const seen = [];
        subs.add(client.onOpen.subscribe((s: SessionData) => seen.push(now() + ' session ' + s.welcomeMsg.sessionId)));
        return seen;
    }

    function record(results: Observable<ResultMessage>, label: string, log: string[], errors: any[] = []) {
        subs.add(results.subscribe(
            (r: ResultMessage) => log.push(now() + ' ' + label + ' next ' + JSON.stringify(r.args)),
            (e: any) => {
                errors.push(e);
                log.push(now() + ' ' + label + ' error ' + describeError(e));
            },
            () => log.push(now() + ' ' + label + ' complete')
        ));
    }

    function at(frame: number, work: () => void) {
        global.rxTestScheduler.schedule(work, frame);
    }

    function flush() {
        global.rxTestScheduler.flush();
    }

    function start(loss: Loss) {
        const router = new FakeRouter(scripted(...loss.sockets()));
        const client = connect(router);
        const sessions = watchSessions(client);
        if (loss.act) {
            at(LOSS_AT, () => loss.act(client));
        }
        return {router, client, sessions};
    }

    it('call made during an outage should not be failed by reconnect attempts that fail, and should resolve after the next WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), CLOSED), // session 1 drops at 100
            cold('o-c--#', socketValues(2), CLOSED),      // reconnect at 130, CHALLENGE at 150, drops at 180
            cold('o-c-a', socketValues(3)),               // reconnect at 210, CHALLENGE at 230, ABORT at 250
            cold('o-c-w', socketValues(4))                // reconnect at 280, WELCOME at 320
        ));
        const client = connect(router);
        const sessions = watchSessions(client);
        const outcomes = [];
        at(115, () => record(client.call('testing.gap'), 'gap', outcomes));             // no socket
        at(160, () => record(client.call('testing.handshake'), 'handshake', outcomes)); // in the handshake that drops
        at(240, () => record(client.call('testing.abort'), 'abort', outcomes));         // in the handshake that is aborted

        flush();

        assert.deepEqual(outcomes, [
            '330 gap next ["result from socket 4"]',
            '330 gap complete',
            '330 handshake next ["result from socket 4"]',
            '330 handshake complete',
            '330 abort next ["result from socket 4"]',
            '330 abort complete'
        ], 'calls made while the client had no session did not resolve from socket 4' + router.log);
        assert.deepEqual(router.written('CALL'), [
            '320 s4 session CALL testing.gap',
            '320 s4 session CALL testing.handshake',
            '320 s4 session CALL testing.abort'
        ]);
        assert.deepEqual(router.written('CANCEL'), []);
        assert.deepEqual(sessions, ['40 session 1', '320 session 4']);
    });

    it('call made after a reconnect should resolve normally in the new session', () => {
        const {router, client, sessions} = start(SOCKET_DROP);
        const lost = []; // it only has to be in flight at the drop
        const outcomes = [];
        at(CALL_AT, () => record(client.call(IN_FLIGHT), 'lost', lost));
        at(200, () => record(client.call('testing.after'), 'after', outcomes));

        flush();

        assert.deepEqual(outcomes, [
            '210 after next ["result from socket 2"]',
            '210 after complete'
        ], 'a call made after the reconnect did not resolve' + router.log);
        assert.deepEqual(router.written('CALL'), ['95 s1 session CALL ' + IN_FLIGHT, '200 s2 session CALL testing.after']);
        assert.deepEqual(router.written('CANCEL'), []);
        assert.deepEqual(sessions, ['40 session 1', '170 session 2']);
    });

    it('call made after client.close() should resolve normally in the session close() left up', () => {
        const router = new FakeRouter(scripted(cold('o-c-w', socketValues(1))));
        const client = connect(router);
        watchSessions(client);
        const outcomes = [];
        at(50, () => client.close());
        at(70, () => record(client.call('testing.after_close'), 'after_close', outcomes));

        flush();

        assert.deepEqual(outcomes, [
            '80 after_close next ["result from socket 1"]',
            '80 after_close complete'
        ], 'a call made after client.close() did not resolve' + router.log);
        assert.deepEqual(router.written('CANCEL'), []);
    });
});
