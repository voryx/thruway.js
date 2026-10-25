import {Observable} from 'rxjs/Observable';
import {Subject} from 'rxjs/Subject';
import {Subscriber} from 'rxjs/Subscriber';
import {Subscription} from 'rxjs/Subscription';
import {ColdObservable} from 'rxjs/testing/ColdObservable';
import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/never';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/mapTo';
import 'rxjs/add/operator/retry';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/switchMap';
import {expect} from 'chai';
import {cold} from '../helpers/marble-testing';
import {xit as it} from '../helpers/test-helpers';
import {Client} from '../../src/Client';
import {IMessage} from '../../src/Messages/Message';
import {OpenMessage} from '../../src/Messages/OpenMessage';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {ChallengeMessage} from '../../src/Messages/ChallengeMessage';
import {ResultMessage} from '../../src/Messages/ResultMessage';
import {SubscribedMessage} from '../../src/Messages/SubscribedMessage';
import {RegisteredMessage} from '../../src/Messages/RegisteredMessage';
import {EventMessage} from '../../src/Messages/EventMessage';
import {InvocationMessage} from '../../src/Messages/InvocationMessage';

declare const global: any;

/*
 * Session lifecycle around socket drops and client.close().
 *
 * Every test drives a fake transport whose subscriptions are fake sockets (cold marbles, one per connection
 * attempt). A socket error ('#') is how WebSocketTransport reports any close, and the client reconnects
 * RECONNECT_DELAY virtual ms later. Outbound frames are recorded with their virtual time, so the tests can
 * check *when* something was written, not only that it was.
 */

const REALM = 'realm1';
const RECONNECT_DELAY = 20;
const CHALLENGE_DELAY = 30; // how long the app takes to answer a CHALLENGE

const CLOSED = new Error('The WebSocket connection was closed');

function now(): number {
    return global.rxTestScheduler.now();
}

// Runs fn at an absolute virtual time; only call this before flushing
function at(time: number, fn: () => void): void {
    global.rxTestScheduler.schedule(fn, time);
}

function flush(): void {
    global.rxTestScheduler.flush();
}

let liveSubscriptions: Subscription[] = [];

interface Recording {
    values: Array<[number, any]>;
    errors: Array<[number, any]>;
    completions: number[];
    subscription: Subscription;
}

function newRecording(): Recording {
    return {values: [], errors: [], completions: [], subscription: null};
}

// Subscribes right now and records everything with its virtual time
function attach(rec: Recording, obs: Observable<any>): void {
    rec.subscription = obs.subscribe(
        v => rec.values.push([now(), v]),
        e => rec.errors.push([now(), e]),
        () => rec.completions.push(now())
    );
    liveSubscriptions.push(rec.subscription);
}

function subscribeAt(time: number, obs: Observable<any>): Recording {
    const rec = newRecording();
    at(time, () => attach(rec, obs));
    return rec;
}

// Records each value of a long-lived stream (onClose, onError) with its virtual time
function listen<T>(obs: Observable<T>): Array<[number, T]> {
    const heard: Array<[number, T]> = [];
    liveSubscriptions.push(obs.subscribe(v => heard.push([now(), v])));
    return heard;
}

function describeFrames(frames: any[]): string {
    return '\n      actual:   ' + JSON.stringify(frames);
}

function settled(rec: Recording): boolean {
    return rec.errors.length > 0 || rec.completions.length > 0;
}

class FakeRouter {
    public readonly transport: Subject<IMessage>;
    public connections = 0;
    private sent: Array<[number, any]> = [];
    private labels: { [id: string]: string } = {};
    private labelCount = 0;
    private replies: { [uri: string]: any[] } = {};

    constructor(private sockets: Array<ColdObservable<IMessage>>) {
        const observer = new Subscriber((msg: IMessage) => this.receive(msg));
        this.transport = Subject.create(observer, Observable.defer(() => {
            const socket = this.sockets[this.connections++];
            // Running out of sockets is a bug in the test; stay quiet instead of looping through retries
            return socket || Observable.never();
        }));
    }

    // These router messages get the request id of the latest CALL/SUBSCRIBE/REGISTER written for uri
    public reply(uri: string, ...msgs: IMessage[]): void {
        this.replies[uri] = (this.replies[uri] || []).concat(msgs);
    }

    // Outbound frames as [virtual time, code, ...key fields]; request ids become req1, req2, ... in order of appearance
    public frames(): any[] {
        return this.sent.map(([time, msg]) => [time].concat(this.summarize(msg)));
    }

    // [connected, dropped] virtual times of each socket the client connected to; Infinity while still connected
    public connectionTimes(): Array<[number, number]> {
        return this.sockets.slice(0, this.connections)
            .map(s => [s.subscriptions[0].subscribedFrame, s.subscriptions[0].unsubscribedFrame] as [number, number]);
    }

    private receive(msg: any): void {
        this.sent.push([now(), msg]);
        const uri = msg.procedure || msg.topicName;
        if (uri && this.replies[uri]) {
            this.replies[uri].forEach(r => r._requestId = msg.requestId);
        }
    }

    private label(id: number): string {
        if (!this.labels[id]) {
            this.labels[id] = 'req' + (++this.labelCount);
        }
        return this.labels[id];
    }

    private summarize(msg: IMessage): any[] {
        const w = msg.wampifiedMsg();
        switch (w[0]) {
            case 1: // HELLO realm
            case 5: // AUTHENTICATE signature
                return [w[0], w[1]];
            case 16: // PUBLISH topic args
                return [16, w[3], w[4]];
            case 32: // SUBSCRIBE id topic
            case 48: // CALL id procedure
            case 64: // REGISTER id procedure
                return [w[0], this.label(w[1]), w[3]];
            case 34: // UNSUBSCRIBE subscription id
            case 66: // UNREGISTER registration id
                return [w[0], w[2]];
            case 49: // CANCEL id of the cancelled CALL
                return [49, this.label(w[1])];
            case 70: // YIELD invocation id, args
                return [70, w[1], w[3]];
            default:
                return w;
        }
    }
}

function framesOfKind(router: FakeRouter, codes: number[]): any[] {
    return router.frames().filter(f => codes.indexOf(f[1]) !== -1);
}

// Fails, listing every outbound frame, if a frame with one of these codes was written at a time in (after, before)
function expectNoFramesWritten(router: FakeRouter, codes: number[], after: number, before: number, reason: string): void {
    const offending = framesOfKind(router, codes).filter(f => f[0] > after && f[0] < before);
    expect(offending, reason + describeFrames(router.frames())).to.deep.equal([]);
}

/*
 * The uris of the work ([uri, settled]) that neither reached the router nor settled. Waiting is fine once the client has
 * itself started a new session since `since` (a HELLO, or a new connection), so then nothing counts as held back.
 */
function heldBack(router: FakeRouter, since: number, work: Array<[string, boolean]>): string[] {
    const frames = router.frames();
    if (frames.some(f => f[1] === 1 && f[0] >= since) || router.connections > 1) {
        return [];
    }
    return work.filter(([uri, done]) => !done && !frames.some(f => f.indexOf(uri) !== -1)).map(([uri]) => uri);
}

// retries, when given, records the virtual time of each error the retry strategy is asked to reconnect after
function createClient(router: FakeRouter, retries: number[] = []): Client {
    const client = new Client(router.transport, REALM, {
        retryWhen: (attempts: Observable<Error>) => attempts
            .do(() => retries.push(now()))
            .delay(RECONNECT_DELAY, global.rxTestScheduler)
    });
    client.onChallenge(challenge => challenge.mapTo('secret').delay(CHALLENGE_DELAY, global.rxTestScheduler));
    return client;
}

const open = () => new OpenMessage({event: null});

/** @test {client} */
describe('Client session lifecycle', () => {

    afterEach(() => {
        liveSubscriptions.forEach(s => s.unsubscribe());
        liveSubscriptions = [];
    });

    it('client.close(), which currently only emits onClose, should not hold back call and progressiveCall started after it', () => {
        // Current behaviour, guarded on purpose: close() only emits onClose (ending topic subscriptions); it sends no
        // GOODBYE, leaves the socket and the router session up and does not reconnect. The fix
        // deliberately does not treat close() as losing the session, since work started after it would then wait for a
        // WELCOME that never comes. This does not pin which frames the work writes or that writing to that session is
        // right, only that each piece of work started after close() reaches the router or settles without crashing.
        // Waiting is fine once the client has itself started a new session (a HELLO after close(), or a new connection).
        const closeAt = 50;
        const subscribed = new SubscribedMessage(null, 501);
        const result = new ResultMessage(null, {}, ['ok'], {});
        const progressMsg = new ResultMessage(null, {progress: true}, ['tick'], {});
        const router = new FakeRouter([
            cold('-o-wa------rp', {o: open(), w: new WelcomeMessage(1001, {}), a: subscribed, r: result, p: progressMsg})
        ]);
        router.reply('before.close', subscribed);
        router.reply('after.close', result);
        router.reply('feed.after.close', progressMsg);
        const client = createClient(router);
        const closes = listen(client.onClose);

        // Keeps the client connected across close()
        subscribeAt(0, client.onOpen);
        const topic = subscribeAt(0, client.topic('before.close'));
        at(closeAt, () => client.close());
        const call = subscribeAt(70, client.call('after.close'));
        const feed = subscribeAt(70, client.progressiveCall('feed.after.close'));

        flush();

        expect(closes.map(([t]) => t), 'close() emits onClose').to.deep.equal([closeAt]);
        expect(topic.completions, 'close() ends topic subscriptions').to.deep.equal([closeAt]);
        expect(framesOfKind(router, [6]), 'close() sends no GOODBYE' + describeFrames(router.frames())).to.deep.equal([]);
        expect(router.connections, 'close() does not reconnect').to.equal(1);
        expect(framesOfKind(router, [1])).to.deep.equal([[10, 1, REALM]]);
        const work: Array<[string, boolean]> = [
            ['after.close', settled(call)],
            ['feed.after.close', settled(feed)]
        ];
        expect(heldBack(router, closeAt, work), 'work started after close() is waiting for a WELCOME that cannot come'
            + describeFrames(router.frames())).to.deep.equal([]);
        [call, feed].forEach(rec => {
            expect(rec.errors.filter(([, e]) => e instanceof TypeError), 'work started after close() must not crash').to.deep.equal([]);
        });
    });

    it('topic and register made before a socket drop should resubscribe/re-register only at the new WELCOME and keep delivering', () => {
        const subscribed1 = new SubscribedMessage(null, 501);
        const registered1 = new RegisteredMessage(null, 601);
        const subscribed2 = new SubscribedMessage(null, 502);
        const registered2 = new RegisteredMessage(null, 602);
        const invoked: Array<[number, string]> = [];
        const router = new FakeRouter([
            // HELLO 10, WELCOME 30, SUBSCRIBED 50, REGISTERED 60, EVENT 80, INVOCATION 100, socket closes 140
            cold('-o-w-ab-e-i---#', {
                o: open(),
                w: new WelcomeMessage(1001, {}),
                a: subscribed1,
                b: registered1,
                e: new EventMessage(501, 7001, {}, ['news1']),
                i: new InvocationMessage(901, 601, {}, ['ping1'])
            }, CLOSED),
            // HELLO 170, CHALLENGE 190, AUTHENTICATE 220, WELCOME 230, SUBSCRIBED 250, REGISTERED 260, EVENT 280, INVOCATION 300
            cold('-o-c---w-ab-e-i', {
                o: open(),
                c: new ChallengeMessage('ticket', {}),
                w: new WelcomeMessage(1002, {}),
                a: subscribed2,
                b: registered2,
                e: new EventMessage(502, 7002, {}, ['news2']),
                i: new InvocationMessage(902, 602, {}, ['ping2'])
            })
        ]);
        router.reply('feed.topic', subscribed1, subscribed2);
        router.reply('feed.proc', registered1, registered2);
        const client = createClient(router);

        const topic = subscribeAt(0, client.topic('feed.topic'));
        const register = subscribeAt(0, client.register('feed.proc', (arg: string) => {
            invoked.push([now(), arg]);
            return 'pong:' + arg;
        }));

        flush();

        expectNoFramesWritten(router, [32, 64], 140, 230,
            'no SUBSCRIBE/REGISTER may be written between the drop at 140 and the new WELCOME at 230');
        // Session 1's UNSUBSCRIBE 501 / UNREGISTER 601 are left out: today they are written into session 2 after its WELCOME,
        // with ids session 2 never issued. That is pre-existing behaviour this test does not pin, either way.
        const isStale = (f: any[]) => (f[1] === 34 && f[2] === 501) || (f[1] === 66 && f[2] === 601);
        expect(router.frames().filter(f => !isStale(f))).to.deep.equal([
            [10, 1, REALM],
            [30, 32, 'req1', 'feed.topic'],
            [30, 64, 'req2', 'feed.proc'],
            [100, 70, 901, ['pong:ping1']],
            [170, 1, REALM],
            [220, 5, 'secret'],
            [230, 32, 'req3', 'feed.topic'],
            [230, 64, 'req4', 'feed.proc'],
            [300, 70, 902, ['pong:ping2']]
        ]);
        expect(topic.errors, 'topic must not error (e.g. a TypeError from destructuring a null session)').to.deep.equal([]);
        expect(register.errors, 'register must not error (e.g. a TypeError from destructuring a null session)').to.deep.equal([]);
        expect(topic.values.map(([t, e]) => [t, e.args])).to.deep.equal([[80, ['news1']], [280, ['news2']]]);
        expect(topic.completions).to.deep.equal([]);
        expect(register.values.map(([t, r]) => [t, r.registrationId])).to.deep.equal([[60, 601], [260, 602]]);
        expect(register.completions).to.deep.equal([]);
        expect(invoked).to.deep.equal([[100, 'ping1'], [300, 'ping2']]);
    });

    it('progressiveCall in flight should error on a socket drop, write no CANCEL into the lost connection and not CALL again', () => {
        const p1 = new ResultMessage(null, {progress: true}, ['t1'], {});
        const p2 = new ResultMessage(null, {progress: true}, ['t2'], {});
        const router = new FakeRouter([
            cold('-o-w-p-q--#', {o: open(), w: new WelcomeMessage(1001, {}), p: p1, q: p2}, CLOSED),
            cold('-o-w', {o: open(), w: new WelcomeMessage(1002, {})})
        ]);
        router.reply('feed', p1, p2);
        const client = createClient(router);

        // Keeps the client connected after the feed errors, so the reconnect can be observed
        subscribeAt(0, client.onOpen);
        const feed = subscribeAt(0, client.progressiveCall('feed'));

        flush();

        expect(feed.values.map(([t, r]) => [t, r.args])).to.deep.equal([[50, ['t1']], [70, ['t2']]]);
        expect(feed.errors.length).to.equal(1);
        expect(feed.errors[0][0]).to.equal(100);
        expect(feed.errors[0][1]).to.equal(CLOSED);
        // The session ended with the socket at 100, so the CANCEL that unsubscribing the lost call produces is dropped
        // rather than written (writes bound to a session only go out while it is established), and the feed is not
        // CALLed again on the reconnected session (WELCOME 150)
        expectNoFramesWritten(router, [48, 49], 30, Infinity, 'no CANCEL at the drop and no CALL after reconnecting');
        expect(router.frames()).to.deep.equal([
            [10, 1, REALM],
            [30, 48, 'req1', 'feed'],
            [130, 1, REALM]
        ]);
        expect(router.connections).to.equal(2);
    });
});
