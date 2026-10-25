declare const global: any;

import {Observable} from 'rxjs/Observable';
import {Subject} from 'rxjs/Subject';
import {Subscriber} from 'rxjs/Subscriber';
import {Subscription} from 'rxjs/Subscription';
import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/interval';
import 'rxjs/add/observable/never';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/finally';
import 'rxjs/add/operator/mapTo';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/timeout';
import {assert} from 'chai';
import {cold} from '../helpers/marble-testing';
import {xit as it} from '../helpers/test-helpers';
import {Client, SessionData} from '../../src/Client';
import {IMessage} from '../../src/Messages/Message';
import {OpenMessage} from '../../src/Messages/OpenMessage';
import {HelloMessage} from '../../src/Messages/HelloMessage';
import {ChallengeMessage} from '../../src/Messages/ChallengeMessage';
import {AuthenticateMessage} from '../../src/Messages/AuthenticateMessage';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {AbortMessage} from '../../src/Messages/AbortMessage';
import {CallMessage} from '../../src/Messages/CallMessage';
import {ResultMessage} from '../../src/Messages/ResultMessage';
import {SubscribeMessage} from '../../src/Messages/SubscribeMessage';
import {SubscribedMessage} from '../../src/Messages/SubscribedMessage';
import {RegisterMessage} from '../../src/Messages/RegisterMessage';
import {RegisteredMessage} from '../../src/Messages/RegisteredMessage';
import {EventMessage} from '../../src/Messages/EventMessage';
import {InvocationMessage} from '../../src/Messages/InvocationMessage';
import {PublishMessage} from '../../src/Messages/PublishMessage';

// Scenarios: session 1 is lost through the transport error path (socket error, router ABORT, 'Transport Timeout'),
// or because the transport opens again without erroring first, while an onOpen listener keeps the client's session
// stream connected. Work started before the next WELCOME must wait for that WELCOME instead of being written on top
// of the lost session, and work still bound to the lost session (a long-lived publish, a call in flight when it was
// lost, a late invocation answer, a session kept by the app) must not write into the next connection's handshake.

const FEED = 'org.eggs.login_tokens';
const TOPIC = 'com.example.topic';
const TRANSPORT_RETRY = 30; // frames before the client reconnects (constructor retryWhen)
const FEED_RETRY = 60;      // frames before the app restarts its progressiveCall feed after an error

// 'aborted': the router ended the session with ABORT and ignores the client, but the socket stays open until the
// client closes it
type SocketState = 'closed' | 'handshake' | 'session' | 'aborted';

interface Connection {
    id: number;
    state: SocketState;
    replies: Subject<IMessage>;
}

type Responder = (msg: IMessage, conn: Connection, router: FakeRouter) => void;

const now = (): number => global.rxTestScheduler.now();

const live = (conn: Connection): boolean => conn.state === 'handshake' || conn.state === 'session';

function summarize(m: Array<any>): string {
    switch (m[0]) {
        case 1:
            return 'HELLO ' + m[1];
        case 5:
            return 'AUTHENTICATE ' + m[1];
        case 16:
            return 'PUBLISH ' + m[3] + ' ' + JSON.stringify(m[4] || []);
        case 32:
            return 'SUBSCRIBE ' + m[3];
        case 34:
            return 'UNSUBSCRIBE ' + m[2];
        case 64:
            return 'REGISTER ' + m[3];
        case 66:
            return 'UNREGISTER ' + m[2];
        case 48:
            return 'CALL ' + m[3];
        case 49:
            return 'CANCEL';
        case 70:
            return 'YIELD ' + JSON.stringify(m[3] || []);
        default:
            return JSON.stringify(m);
    }
}

// Answers plain CALLs made inside an established session. Progressive CALLs (the app's feed) are left open.
const answerCalls: Responder = (msg, conn, router) => {
    if (msg instanceof CallMessage && conn.state === 'session' && !(msg.options as any).receive_progress) {
        router.reply(conn, new ResultMessage(msg.requestId, {}, ['result from socket ' + conn.id], {}), 10);
    }
};

// Also answers SUBSCRIBE and REGISTER made inside an established session (ids 500 + socket and 600 + socket)
const answerRequests: Responder = (msg, conn, router) => {
    answerCalls(msg, conn, router);
    if (msg instanceof SubscribeMessage && conn.state === 'session') {
        router.reply(conn, new SubscribedMessage(msg.requestId, 500 + conn.id), 10);
    }
    if (msg instanceof RegisterMessage && conn.state === 'session') {
        router.reply(conn, new RegisteredMessage(msg.requestId, 600 + conn.id), 10);
    }
};

// A router that enforces the handshake, like the production router: CHALLENGE for HELLO, WELCOME for
// AUTHENTICATE, and ABORT wamp.error.protocol_violation for a session message (CALL, PUBLISH, CANCEL, ...) that
// arrives before the WELCOME.
const strictRouter: Responder = (msg, conn, router) => {
    if (msg instanceof HelloMessage) {
        router.reply(conn, new ChallengeMessage('ticket', {}), 10);
    }
    if (msg instanceof AuthenticateMessage) {
        router.reply(conn, new WelcomeMessage(conn.id, {}), 10);
    }
    const handshakeMessage = msg instanceof HelloMessage || msg instanceof AuthenticateMessage || msg instanceof AbortMessage;
    if (!handshakeMessage && conn.state === 'handshake') {
        const kind = summarize(msg.wampifiedMsg()).split(' ')[0];
        router.reply(conn, new AbortMessage({message: kind + ' before WELCOME'}, 'wamp.error.protocol_violation'), 5);
    }
};

/**
 * Fake transport with one socket per subscription, like WebSocketTransport. Every write the client makes is logged
 * as "<frame> s<socket> <state> <message>"; writes to a closed socket are logged but dropped, as WebSocketTransport
 * drops them, and writes after the router's ABORT are logged but ignored by the router.
 */
class FakeRouter {
    public readonly writes: string[] = [];
    public readonly aborts: string[] = [];
    public readonly transport: Subject<IMessage>;
    private conn: Connection = {id: 0, state: 'closed', replies: null};
    private count = 0;

    constructor(socket: (n: number) => Observable<IMessage>, private respond: Responder = answerCalls) {
        const inbound = Observable.defer(() => {
            const conn: Connection = {id: ++this.count, state: 'closed', replies: new Subject<IMessage>()};
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
                        }
                        if (m instanceof AbortMessage) {
                            conn.state = 'aborted';
                            this.aborts.push(now() + ' s' + conn.id + ' ' + m.reason);
                        }
                    },
                    () => conn.state = 'closed'
                )
                .finally(() => conn.state = 'closed');
        });

        this.transport = Subject.create(new Subscriber((msg: IMessage) => this.receive(msg)), inbound);
    }

    public reply(conn: Connection, msg: IMessage, delay: number) {
        global.rxTestScheduler.schedule(() => {
            if (live(conn)) {
                conn.replies.next(msg);
            }
        }, delay);
    }

    // Writes of one message kind, e.g. 'CANCEL' or 'PUBLISH'
    public written(kind: string): string[] {
        return this.writes.filter(w => w.split(' ')[3] === kind);
    }

    // Writes of one message kind made while the socket had no established session
    public outsideSession(kind: string): string[] {
        return this.written(kind).filter(w => w.split(' ')[2] !== 'session');
    }

    // Writes of one message kind made inside an established session of socket n
    public inSession(kind: string, n: number): string[] {
        return this.written(kind).filter(w => w.split(' ')[1] === 's' + n && w.split(' ')[2] === 'session');
    }

    // Everything written to socket n between an OPEN and the WELCOME that follows it
    public handshakeWrites(n: number): string[] {
        return this.writes.filter(w => w.split(' ')[1] === 's' + n && w.split(' ')[2] === 'handshake');
    }

    get callsOutsideSession(): string[] {
        return this.outsideSession('CALL');
    }

    private receive(msg: IMessage) {
        const conn = this.conn;
        this.writes.push(now() + ' s' + conn.id + ' ' + conn.state + ' ' + summarize(msg.wampifiedMsg()));
        if (live(conn)) {
            this.respond(msg, conn, this);
        }
    }
}

function socketValues(n: number) {
    return {
        o: new OpenMessage({event: null}),
        c: new ChallengeMessage('ticket', {}),
        w: new WelcomeMessage(n, {}),
        a: new AbortMessage({message: 'The router ended the session'}, 'wamp.error.protocol_violation')
    };
}

// Socket n of a scripted router plays sockets[n - 1]
function scripted(...sockets: Array<Observable<IMessage>>): (n: number) => Observable<IMessage> {
    return n => sockets[n - 1] || Observable.throw(new Error('the test did not script socket ' + n));
}

// A long-lived source for publish(): values 0 .. count - 1, one every `period` frames from its subscription
function ticker(period: number, count: number): Observable<number> {
    return Observable.interval(period, global.rxTestScheduler).take(count);
}

// One socket that opens a second time on the same subscription, with no error in between, as a transport that
// reconnects on its own can: OPEN at 0, WELCOME of session 1 at 40, OPEN again at 100, CHALLENGE at 120 and the
// WELCOME of session 2 at 200
function reopeningSocket(): Observable<IMessage> {
    return cold('o-c-w-----o-c-------x', {...socketValues(1), x: new WelcomeMessage(2, {})});
}

/** @test {client} */
describe('Client session replay after a lost connection', () => {

    const originalTimer = Observable.timer;
    let subs: Subscription;

    beforeEach(() => {
        subs = new Subscription();
    });

    afterEach(() => {
        subs.unsubscribe();
        (Observable as any).timer = originalTimer;
    });

    function connect(router: FakeRouter, options: any = {}): Client {
        return new Client(router.transport, 'realm1', {
            retryWhen: attempts => attempts.delay(TRANSPORT_RETRY, global.rxTestScheduler),
            ...options
        });
    }

    // The first challenge is answered at once; challenges after a reconnect take `reconnectDelay` frames, or are
    // never answered.
    function challengeAnswers(reconnectDelay: number | 'never' = 0) {
        let n = 0;
        return (challenge: Observable<ChallengeMessage>): Observable<string> => {
            n++;
            if (n === 1 || reconnectDelay === 0) {
                return Observable.of('token-' + n);
            }
            if (reconnectDelay === 'never') {
                return Observable.never();
            }
            return challenge.delay(reconnectDelay, global.rxTestScheduler).mapTo('token-' + n);
        };
    }

    function watchSessions(client: Client, label: string = 'onOpen', seen: string[] = []): string[] {
        subs.add(client.onOpen.subscribe(
            (s: SessionData) => seen.push(now() + ' ' + label + ' ' + (s ? 'session ' + s.welcomeMsg.sessionId : String(s))),
            (e: Error) => seen.push(now() + ' ' + label + ' error ' + e.message),
            () => seen.push(now() + ' ' + label + ' complete')
        ));
        return seen;
    }

    function watchErrors(client: Client): string[] {
        const seen = [];
        subs.add(client.onError.subscribe((e: Error) => seen.push(now() + ' ' + e.message)));
        return seen;
    }

    // The member app's long-lived feed, restarted after any error
    function startFeed(client: Client, retryDelay: number = FEED_RETRY) {
        subs.add(client.progressiveCall(FEED)
            .retryWhen(errors => errors.delay(retryDelay, global.rxTestScheduler))
            .subscribe());
    }

    function record(results: Observable<ResultMessage>, label: string, log: string[]) {
        subs.add(results.subscribe(
            (r: ResultMessage) => log.push(now() + ' ' + label + ' next ' + JSON.stringify(r.args)),
            (e: Error) => log.push(now() + ' ' + label + ' error ' + e.message),
            () => log.push(now() + ' ' + label + ' complete')
        ));
    }

    // Something was written inside an established session of socket n; what and when is up to the test
    function assertInSession(router: FakeRouter, kind: string, n: number, message: string) {
        assert.isAbove(router.inSession(kind, n).length, 0, message + '; client wrote ' + JSON.stringify(router.writes));
    }

    function at(frame: number, work: () => void) {
        global.rxTestScheduler.schedule(work, frame);
    }

    function flush() {
        global.rxTestScheduler.flush();
    }

    it('progressiveCall restarted after a socket error should not write CALL before the new WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')), // session 1, socket drops at 100
            cold('o-c-------w', socketValues(2))                              // reconnect at 130, WELCOME at 230
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60)); // second answer at 210
        watchSessions(client);
        startFeed(client); // restarted at 160, mid-handshake

        flush();

        assert.deepEqual(router.callsOutsideSession, [], 'the restarted feed wrote CALL outside an established session');
        assert.deepEqual(router.written('CANCEL'), [], 'the feed CALL of the lost session was cancelled although its session is gone');
        assert.deepEqual(router.written('CALL'), [
            '40 s1 session CALL ' + FEED,
            '230 s2 session CALL ' + FEED
        ], 'the restarted feed did not CALL at the WELCOME of socket 2');
    });

    it('progressiveCall restarted after a socket error should write no CALL while the challenge is never answered', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c', socketValues(2)) // reconnect at 130, CHALLENGE at 150 and nothing else
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers('never'));
        const sessions = watchSessions(client);
        startFeed(client);

        flush();

        assert.deepEqual(router.callsOutsideSession, [], 'the restarted feed wrote CALL outside an established session');
        assert.deepEqual(router.written('CANCEL'), [], 'the feed CALL of the lost session was cancelled although its session is gone');
        assert.deepEqual(router.writes, [
            '0 s1 handshake HELLO realm1',
            '20 s1 handshake AUTHENTICATE token-1',
            '40 s1 session CALL ' + FEED,
            '130 s2 handshake HELLO realm1'
        ]);
        assert.deepEqual(sessions, ['40 onOpen session 1']);
    });

    it('progressiveCall restarted after a router ABORT should not write CALL before the new WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----a', socketValues(1)), // session 1, router ABORTs at 100
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        const errors = watchErrors(client);
        watchSessions(client);
        startFeed(client);

        flush();

        assert.deepEqual(router.callsOutsideSession, [], 'the restarted feed wrote CALL outside an established session');
        assert.deepEqual(router.written('CANCEL'), [], 'the feed CALL of the aborted session was cancelled although its session is gone');
        assert.deepEqual(router.written('CALL'), [
            '40 s1 session CALL ' + FEED,
            '230 s2 session CALL ' + FEED
        ], 'the restarted feed did not CALL at the WELCOME of socket 2');
        assert.deepEqual(errors, [
            '100 Connection ended because {"message":"The router ended the session"}wamp.error.protocol_violation'
        ]);
    });

    it('progressiveCall feed should not drive reconnects into a CALL/ABORT loop when the challenge answer is slow', () => {
        // Production timing scaled down: reconnect after 50, app feed restart after 100, challenge answer after 70
        const router = new FakeRouter(
            n => n === 1
                ? cold('o---------#', socketValues(n), new Error('socket closed'))
                : cold('o', socketValues(n)),
            strictRouter
        );
        const client = connect(router, {retryWhen: attempts => attempts.delay(50, global.rxTestScheduler)});
        client.onChallenge(challengeAnswers(70));
        const sessions = watchSessions(client);
        startFeed(client, 100);

        flush();

        assert.deepEqual(
            {callsOutsideSession: router.callsOutsideSession, routerAborts: router.aborts},
            {callsOutsideSession: [], routerAborts: []},
            'the feed wrote CALL during a handshake and the router aborted the connection'
        );
        assert.deepEqual(router.written('CANCEL'), [], 'the feed CALL of the lost session was cancelled although its session is gone');
        assert.deepEqual(router.writes, [
            '0 s1 handshake HELLO realm1',
            '10 s1 handshake AUTHENTICATE token-1',
            '20 s1 session CALL ' + FEED,
            '150 s2 handshake HELLO realm1',
            '230 s2 handshake AUTHENTICATE token-2',
            '240 s2 session CALL ' + FEED
        ]);
        assert.deepEqual(sessions, ['20 onOpen session 1', '240 onOpen session 2']);
    });

    it('progressiveCall lost to a router ABORT should not write CANCEL to the socket the router still holds open', () => {
        // Production trace: HELLO, CHALLENGE, CALL, ABORT protocol_violation, CANCEL. The ABORT ends the session, but
        // the socket is still open while the client handles the error, so a CANCEL written then reaches the router.
        const router = new FakeRouter(scripted(
            cold('o-c-w-----a', socketValues(1)), // router ABORTs session 1 at 100; the client closes the socket after that
            cold('o-c-w', socketValues(2))        // reconnect at 130, WELCOME at 170
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers());
        watchSessions(client);
        startFeed(client, 100); // restarted at 200, after the new WELCOME

        flush();

        assert.deepEqual(router.written('CANCEL'), [], 'the lost feed CALL was cancelled on the socket after the router ended its session');
        assert.deepEqual(router.written('CALL'), [
            '40 s1 session CALL ' + FEED,
            '200 s2 session CALL ' + FEED
        ], 'the restarted feed did not CALL in the session of socket 2');
        assert.deepEqual(router.aborts, ['100 s1 wamp.error.protocol_violation']);
    });

    it('invocation from the lost session whose answer resolves during the next handshake should write no YIELD', () => {
        const values = {...socketValues(1), i: new InvocationMessage(77, 601, {}, ['ping'])}; // 601: REGISTERED on socket 1
        const router = new FakeRouter(scripted(
            cold('o-c-w--i--#', values, new Error('socket closed')), // INVOCATION at 70, drop at 100
            cold('o-c-------w', socketValues(2))                     // reconnect at 130, WELCOME at 230
        ), answerRequests);
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const seen = [];
        // The callee needs 120 frames: its answer to the INVOCATION at 70 is ready at 190, mid-handshake
        const slowCallee = (arg: string) => Observable.of('pong to ' + arg).delay(120, global.rxTestScheduler);
        subs.add(client.register('com.example.slow', slowCallee).subscribe(
            (m: RegisteredMessage) => seen.push(now() + ' registered ' + m.registrationId),
            (e: Error) => seen.push(now() + ' register error ' + e.message),
            () => seen.push(now() + ' register complete')
        ));

        flush();

        assert.deepEqual(router.written('YIELD'), [], 'the answer to an invocation from the lost session was written');
        assert.deepEqual(router.handshakeWrites(2), [
            '130 s2 handshake HELLO realm1',
            '210 s2 handshake AUTHENTICATE token-2'
        ], 'the client wrote session messages into the handshake of socket 2');
        assert.deepEqual(router.written('REGISTER'), [
            '40 s1 session REGISTER com.example.slow',
            '230 s2 session REGISTER com.example.slow'
        ]);
        assert.deepEqual(seen, ['50 registered 601', '240 registered 602']);
    });

    it('long-lived publish should write no PUBLISH during the next handshake and resume after the new WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')), // WELCOME at 40, socket drops at 100
            cold('o-c-------w', socketValues(2))                              // reconnect at 130, WELCOME at 230
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        subs.add(client.publish(TOPIC, ticker(25, 10))); // a value every 25 frames from the WELCOME at 40 until 290

        flush();

        assert.deepEqual(router.outsideSession('PUBLISH'), [], 'the long-lived publish wrote PUBLISH outside an established session');
        assert.deepEqual(router.handshakeWrites(2), [
            '130 s2 handshake HELLO realm1',
            '210 s2 handshake AUTHENTICATE token-2'
        ], 'the client wrote session messages into the handshake of socket 2');
        assertInSession(router, 'PUBLISH', 1, 'the long-lived publish wrote no PUBLISH in session 1');
        assertInSession(router, 'PUBLISH', 2, 'the long-lived publish did not resume after the WELCOME of socket 2');
    });

    it('periodic publish should not drive reconnects into a PUBLISH/ABORT loop when the challenge answer is slow', () => {
        // The strict router ABORTs any session message before its WELCOME; the publish period (30) is shorter than the
        // reconnect handshake (150 to 240), so every handshake would see a PUBLISH
        const router = new FakeRouter(
            n => n === 1
                ? cold('o---------#', socketValues(n), new Error('socket closed'))
                : cold('o', socketValues(n)),
            strictRouter
        );
        const client = connect(router, {retryWhen: attempts => attempts.delay(50, global.rxTestScheduler)});
        client.onChallenge(challengeAnswers(70));
        const sessions = watchSessions(client);
        subs.add(client.publish(TOPIC, ticker(30, 20))); // a value every 30 frames from the WELCOME at 20 until 620

        flush();

        assert.deepEqual(
            {publishesOutsideSession: router.outsideSession('PUBLISH'), routerAborts: router.aborts},
            {publishesOutsideSession: [], routerAborts: []},
            'the publish wrote PUBLISH during a handshake and the router aborted the connection'
        );
        // One reconnect, and nothing but session PUBLISHes besides the two handshakes
        assert.deepEqual(router.writes.filter(w => !/ session PUBLISH /.test(w)), [
            '0 s1 handshake HELLO realm1',
            '10 s1 handshake AUTHENTICATE token-1',
            '150 s2 handshake HELLO realm1',
            '230 s2 handshake AUTHENTICATE token-2'
        ]);
        assertInSession(router, 'PUBLISH', 1, 'the periodic publish wrote no PUBLISH in session 1');
        assertInSession(router, 'PUBLISH', 2, 'publishing did not resume on socket 2 after its WELCOME');
        assert.deepEqual(sessions, ['20 onOpen session 1', '240 onOpen session 2']);
    });

    it('long-lived publish, topic and register from the lost session should carry on in the new session after its WELCOME', () => {
        const values = (n: number) => ({
            ...socketValues(n),
            e: new EventMessage(500 + n, 900 + n, {}, ['event ' + n]),  // for the SUBSCRIBED of socket n
            i: new InvocationMessage(80 + n, 600 + n, {}, ['ping ' + n]) // for the REGISTERED of socket n
        });
        const router = new FakeRouter(scripted(
            cold('o-c-w--ei-#', values(1), new Error('socket closed')), // WELCOME at 40, EVENT 70, INVOCATION 80, drop at 100
            cold('o-c-------w---ei', values(2))                       // WELCOME at 230, EVENT 270, INVOCATION 280
        ), answerRequests);
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const seen = [];
        subs.add(client.topic(TOPIC).subscribe(
            (e: EventMessage) => seen.push(now() + ' topic ' + e.args[0]),
            (e: Error) => seen.push(now() + ' topic error ' + e.message),
            () => seen.push(now() + ' topic complete')
        ));
        subs.add(client.register('com.example.proc', (arg: string) => 'pong to ' + arg).subscribe(
            (m: RegisteredMessage) => seen.push(now() + ' registered ' + m.registrationId),
            (e: Error) => seen.push(now() + ' register error ' + e.message),
            () => seen.push(now() + ' register complete')
        ));
        subs.add(client.publish(TOPIC, ticker(25, 10))); // a value every 25 frames from the WELCOME at 40 until 290

        flush();

        // UNSUBSCRIBE and UNREGISTER of the lost session's ids are left out: whether they are written is not the point
        assert.deepEqual(router.writes.filter(w => / (SUBSCRIBE|REGISTER|YIELD) /.test(w)), [
            '40 s1 session SUBSCRIBE ' + TOPIC,
            '40 s1 session REGISTER com.example.proc',
            '80 s1 session YIELD ["pong to ping 1"]',
            '230 s2 session SUBSCRIBE ' + TOPIC,
            '230 s2 session REGISTER com.example.proc',
            '280 s2 session YIELD ["pong to ping 2"]'
        ], 'topic and register were not renewed at the WELCOME of socket 2');
        assertInSession(router, 'PUBLISH', 2, 'the long-lived publish did not carry on after the WELCOME of socket 2');
        assert.deepEqual(seen, ['50 registered 601', '70 topic event 1', '240 registered 602', '270 topic event 2']);
    });

    it('onOpen and topic should complete once the retry strategy gives up', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')), // drop at 100
            cold('o-c-w', socketValues(2)) // the last retry at 130 resubscribes it and gives up in the same frame
        ), answerRequests);
        // One retry, then the notifier completes and the client stops reconnecting
        const client = connect(router, {retryWhen: attempts => attempts.take(1).delay(TRANSPORT_RETRY, global.rxTestScheduler)});
        client.onChallenge(challengeAnswers());
        const sessions = watchSessions(client);
        const seen = [];
        subs.add(client.topic(TOPIC).subscribe(
            () => seen.push(now() + ' topic event'),
            (e: Error) => seen.push(now() + ' topic error ' + e.message),
            () => seen.push(now() + ' topic complete')
        ));

        flush();

        assert.deepEqual(sessions, ['40 onOpen session 1', '130 onOpen complete'], 'onOpen did not complete when the retries ended');
        assert.deepEqual(seen, ['130 topic complete'], 'topic did not complete when the retries ended');
    });

    it('call made after the retry strategy gave up should reconnect and resolve with the RESULT from the new connection', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')), // drop at 100
            cold('o-c-w', socketValues(2)), // the last retry at 130 resubscribes it and gives up in the same frame
            cold('o-c-w', socketValues(3))  // opened by the call at 200, WELCOME at 240
        ));
        const client = connect(router, {retryWhen: attempts => attempts.take(1).delay(TRANSPORT_RETRY, global.rxTestScheduler)});
        client.onChallenge(challengeAnswers());
        const sessions = watchSessions(client); // kept subscribed, like the app's onOpen listener
        const results = [];
        at(200, () => record(client.call('testing.after_give_up'), 'late', results));

        flush();

        assert.deepEqual(results, [
            '250 late next ["result from socket 3"]',
            '250 late complete'
        ], 'a call made after the retries ended did not reconnect; client wrote ' + JSON.stringify(router.writes));
        assert.deepEqual(router.written('CALL'), ['240 s3 session CALL testing.after_give_up']);
        assert.deepEqual(sessions, ['40 onOpen session 1', '130 onOpen complete']);
    });

    it('call made during a reconnect should wait for the next WELCOME and resolve with the RESULT from the new session', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const results = [];
        at(115, () => record(client.call('testing.gap'), 'gap', results));             // no socket
        at(160, () => record(client.call('testing.handshake'), 'handshake', results)); // after CHALLENGE

        flush();

        assert.deepEqual(results, [
            '240 gap next ["result from socket 2"]',
            '240 gap complete',
            '240 handshake next ["result from socket 2"]',
            '240 handshake complete'
        ], 'calls made during the reconnect did not resolve from socket 2; client wrote ' + JSON.stringify(router.writes));
        assert.deepEqual(router.written('CALL'), [
            '230 s2 session CALL testing.gap',
            '230 s2 session CALL testing.handshake'
        ]);
    });

    it('call made from an onError handler should wait for the next WELCOME instead of using the lost session', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const results = [];
        subs.add(client.onError.subscribe(() => record(client.call('testing.on_error'), 'onError', results)));

        flush();

        assert.deepEqual(results, [
            '240 onError next ["result from socket 2"]',
            '240 onError complete'
        ], 'a call made while onError fired did not resolve from socket 2; client wrote ' + JSON.stringify(router.writes));
        assert.deepEqual(router.written('CALL'), ['230 s2 session CALL testing.on_error']);
    });

    it('call made after a Transport Timeout during a reconnect should wait for the WELCOME of a later socket', () => {
        // Run the 'Transport Timeout' race timer in virtual time (the Client creates it without a scheduler)
        (Observable as any).timer = (dueTime, periodOrScheduler?, scheduler?) =>
            originalTimer(dueTime, periodOrScheduler === undefined ? global.rxTestScheduler : periodOrScheduler, scheduler);

        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('-', socketValues(2)),       // reconnect at 130 never opens: Transport Timeout at 180
            cold('o-c-w', socketValues(3))    // reconnect at 210, WELCOME at 250
        ));
        const client = connect(router, {timeout: 50});
        client.onChallenge(challengeAnswers());
        const errors = watchErrors(client);
        watchSessions(client);
        const results = [];
        at(115, () => record(client.call('testing.gap'), 'gap', results));
        at(190, () => record(client.call('testing.timeout'), 'timeout', results));

        flush();

        assert.deepEqual(errors, ['100 socket closed', '180 Transport Timeout']);
        assert.deepEqual(results, [
            '260 gap next ["result from socket 3"]',
            '260 gap complete',
            '260 timeout next ["result from socket 3"]',
            '260 timeout complete'
        ], 'calls made during the outage did not resolve from socket 3; client wrote ' + JSON.stringify(router.writes));
        assert.deepEqual(router.written('CALL'), [
            '250 s3 session CALL testing.gap',
            '250 s3 session CALL testing.timeout'
        ]);
    });

    it('call made while the transport opens again without an error should wait for the new WELCOME and resolve from it', () => {
        // Nothing errors between the two sessions, so the second OPEN is all that tells the client session 1 is gone
        const router = new FakeRouter(scripted(reopeningSocket()));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60)); // the second challenge (120) is answered at 180
        const sessions = watchSessions(client);   // kept subscribed, like the app's onOpen listener
        const results = [];
        at(130, () => record(client.call('testing.reopen'), 'reopen', results)); // after the second CHALLENGE

        flush();

        assert.deepEqual(router.callsOutsideSession, [], 'the call was written into the handshake of the reopened socket');
        assert.deepEqual(router.written('CALL'), [
            '200 s1 session CALL testing.reopen'
        ], 'the call made during the second handshake was not sent at the WELCOME of session 2');
        assert.deepEqual(results, [
            '210 reopen next ["result from socket 1"]',
            '210 reopen complete'
        ], 'the call made during the second handshake did not resolve in session 2; client wrote ' + JSON.stringify(router.writes));
        assert.deepEqual(sessions, ['40 onOpen session 1', '200 onOpen session 2']);
    });

    it('session kept from onOpen should not write into the handshake when the transport opens again without an error', () => {
        const router = new FakeRouter(scripted(reopeningSocket()));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60)); // the second challenge (120) is answered at 180
        // App code that stores the first session it is handed and writes through its transport later on
        let kept: SessionData = null;
        subs.add(client.onOpen.subscribe((s: SessionData) => kept = kept || s));
        const write = (label: string) => kept.transport.next(new PublishMessage(1000, {}, TOPIC, [label]));
        at(60, () => write('in session 1'));
        at(150, () => write('during the second handshake'));

        flush();

        assert.include(router.writes, '60 s1 session PUBLISH ' + TOPIC + ' ["in session 1"]',
            'the session kept from onOpen did not write while it was established');
        assert.deepEqual(router.handshakeWrites(1), [
            '0 s1 handshake HELLO realm1',
            '20 s1 handshake AUTHENTICATE token-1',
            '100 s1 handshake HELLO realm1',
            '180 s1 handshake AUTHENTICATE token-2'
        ], 'a write through the session kept from onOpen went into the handshake of the reopened socket');
    });

    it('publish made during a reconnect should be sent only after the next WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        at(115, () => subs.add(client.publish(TOPIC, 'gap')));
        at(160, () => subs.add(client.publish(TOPIC, 'handshake')));

        flush();

        assert.deepEqual(router.writes.filter(w => / PUBLISH /.test(w)), [
            '230 s2 session PUBLISH ' + TOPIC + ' ["gap"]',
            '230 s2 session PUBLISH ' + TOPIC + ' ["handshake"]'
        ], 'PUBLISH was not held until the WELCOME of socket 2');
    });

    it('topic and register made during a reconnect should SUBSCRIBE and REGISTER only after the next WELCOME', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ), answerRequests);
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const seen = [];
        at(115, () => subs.add(client.topic(TOPIC).subscribe(  // no socket
            () => seen.push(now() + ' topic event'),
            (e: Error) => seen.push(now() + ' topic error ' + e.message),
            () => seen.push(now() + ' topic complete')
        )));
        at(160, () => subs.add(client.register('com.example.proc', () => 'pong').subscribe( // after CHALLENGE
            (m: RegisteredMessage) => seen.push(now() + ' registered ' + m.registrationId),
            (e: Error) => seen.push(now() + ' register error ' + e.message),
            () => seen.push(now() + ' register complete')
        )));

        flush();

        assert.deepEqual(router.writes.filter(w => / (UN)?(SUBSCRIBE|REGISTER) /.test(w)), [
            '230 s2 session SUBSCRIBE ' + TOPIC,
            '230 s2 session REGISTER com.example.proc'
        ], 'SUBSCRIBE/REGISTER were not held until the WELCOME of socket 2');
        assert.deepEqual(seen, ['240 registered 602']);
    });

    it('onOpen should not replay the lost session to a subscriber that subscribes during a reconnect', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        watchSessions(client);
        const late = [];
        at(115, () => watchSessions(client, 'gap', late));       // no socket
        at(160, () => watchSessions(client, 'handshake', late)); // after CHALLENGE

        flush();

        assert.deepEqual(late, [
            '230 gap session 2',
            '230 handshake session 2'
        ], 'a late onOpen subscriber was handed the lost session');
    });

    it('onOpen should emit session 1 then session 2 to an existing subscriber across a reconnect and never null', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w-----#', socketValues(1), new Error('socket closed')),
            cold('o-c-------w', socketValues(2))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers(60));
        const errors = watchErrors(client);
        const sessions = watchSessions(client);

        flush();

        assert.deepEqual(sessions, ['40 onOpen session 1', '230 onOpen session 2']);
        assert.deepEqual(errors, ['100 socket closed']);
    });

    it('call should be sent at the WELCOME when made before it, and immediately when made after it', () => {
        const router = new FakeRouter(scripted(
            cold('o-c-w', socketValues(1))
        ));
        const client = connect(router);
        client.onChallenge(challengeAnswers());
        watchSessions(client);
        const results = [];
        at(10, () => record(client.call('testing.early'), 'early', results));
        at(60, () => record(client.call('testing.late'), 'late', results));

        flush();

        assert.deepEqual(router.written('CALL'), [
            '40 s1 session CALL testing.early',
            '60 s1 session CALL testing.late'
        ]);
        assert.deepEqual(results, [
            '50 early next ["result from socket 1"]',
            '50 early complete',
            '70 late next ["result from socket 1"]',
            '70 late complete'
        ]);
    });

});
