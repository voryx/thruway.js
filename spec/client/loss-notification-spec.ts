import {Observable} from 'rxjs/Observable';
import {Subject} from 'rxjs/Subject';
import {Subscription} from 'rxjs/Subscription';
import {ColdObservable} from 'rxjs/testing/ColdObservable';
import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/never';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import {expect} from 'chai';
import {cold} from '../helpers/marble-testing';
import {xit as it} from '../helpers/test-helpers';
import {Client} from '../../src/Client';
import {IMessage} from '../../src/Messages/Message';
import {OpenMessage} from '../../src/Messages/OpenMessage';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {ResultMessage} from '../../src/Messages/ResultMessage';

declare const global: any;

/*
 * What work started while the app hears that its session is gone does.
 *
 * The session replay forgets a lost session before onError says why, so a call made from an onError handler waits for
 * the next WELCOME. A call still waiting for a session gives up on client.close().
 *
 * Every test drives a fake transport whose subscriptions are fake sockets (cold marbles, one per connection attempt), and
 * records the frames the client writes with their virtual time. Session 1: HELLO 10, WELCOME 30, lost at 70. The client
 * reconnects RECONNECT_DELAY later, at 90: HELLO 100, WELCOME 120, router answers from 130 on.
 */

const REALM = 'realm1';
const RECONNECT_DELAY = 20;
const LOSS_AT = 70;
const NEW_WELCOME_AT = 120;

const CLOSED = new Error('The WebSocket connection was closed');
const CONNECTION_CLOSED = 'Connection Closed';

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

let live: Subscription = new Subscription();

interface Recording {
    values: Array<[number, any]>;
    errors: Array<[number, any]>;
    completions: number[];
}

function newRecording(): Recording {
    return {values: [], errors: [], completions: []};
}

// Subscribes right now and records everything with its virtual time
function attach(rec: Recording, obs: Observable<any>): void {
    live.add(obs.subscribe(
        v => rec.values.push([now(), v]),
        e => rec.errors.push([now(), e]),
        () => rec.completions.push(now())
    ));
}

function subscribeAt(time: number, obs: Observable<any>): Recording {
    const rec = newRecording();
    at(time, () => attach(rec, obs));
    return rec;
}

// What a recording saw: pick(value) for each value, the message of each error, and when it completed
function outcome(rec: Recording, pick: (v: any) => any = v => v): any {
    return {
        values: rec.values.map(([t, v]) => [t, pick(v)]),
        errors: rec.errors.map(([t, e]) => [t, e && e.message]),
        completions: rec.completions
    };
}

const argsOf = (msg: ResultMessage) => msg.args;

function describeFrames(frames: any[]): string {
    return '\n      actual:   ' + JSON.stringify(frames);
}

class FakeRouter {
    public readonly transport: Subject<IMessage>;
    public connections = 0;
    private sent: Array<[number, any]> = [];
    private labels: { [id: string]: string } = {};
    private labelCount = 0;
    private replies: { [uri: string]: any[] } = {};

    constructor(private sockets: Array<ColdObservable<IMessage>>) {
        this.transport = Subject.create({next: (msg: IMessage) => this.receive(msg)}, Observable.defer(() => {
            const socket = this.sockets[this.connections++];
            // Running out of sockets is a bug in the test; stay quiet instead of looping through retries
            return socket || Observable.never();
        }));
    }

    // These router messages get the request id of the latest CALL written for uri
    public reply(uri: string, ...msgs: IMessage[]): void {
        this.replies[uri] = (this.replies[uri] || []).concat(msgs);
    }

    // Outbound frames as [virtual time, code, ...key fields]; request ids become req1, req2, ... in order of appearance
    public frames(): any[] {
        return this.sent.map(([time, msg]) => [time].concat(this.summarize(msg)));
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
                return [1, w[1]];
            case 48: // CALL id procedure
                return [48, this.label(w[1]), w[3]];
            case 49: // CANCEL id of the cancelled CALL
                return [49, this.label(w[1])];
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

// For each uri, [time, code] of every outbound frame that names it (its CALL)
function writtenFor(router: FakeRouter, uris: string[]): { [uri: string]: any[] } {
    const written = {};
    uris.forEach(uri => written[uri] = router.frames().filter(f => f.indexOf(uri) !== -1).map(f => [f[0], f[1]]));
    return written;
}

function createClient(router: FakeRouter): Client {
    return new Client(router.transport, REALM, {
        retryWhen: (attempts: Observable<Error>) => attempts.delay(RECONNECT_DELAY, global.rxTestScheduler)
    });
}

const open = () => new OpenMessage({event: null});
const welcome = (sessionId: number) => new WelcomeMessage(sessionId, {});
const result = (value: string) => new ResultMessage(null, {}, [value], {});

// Session 1 ends at 70 with the socket closing, reported as an error
const droppedSocket = () => cold('-o-w---#', {o: open(), w: welcome(1001)}, CLOSED);

// The socket the client reconnects to at 90: HELLO 100, WELCOME 120, then the router messages in `after` from 130 on
function nextSocket(after: string = '', values: { [key: string]: IMessage } = {}): ColdObservable<IMessage> {
    return cold('-o-w' + after, {o: open(), w: welcome(1002), ...values});
}

/** @test {client} */
describe('Client loss notifications', () => {

    beforeEach(() => {
        live = new Subscription();
    });

    afterEach(() => {
        live.unsubscribe();
    });

    it('a call made from the onError handler at a socket drop should wait for the next WELCOME: the lost session is already '
        + 'forgotten', () => {
        const answer = result('from the handler');
        const router = new FakeRouter([droppedSocket(), nextSocket('-r', {r: answer})]);
        router.reply('from.handler', answer);
        const client = createClient(router);
        subscribeAt(0, client.onOpen);
        const fromHandler = newRecording();
        live.add(client.onError.subscribe(() => attach(fromHandler, client.call('from.handler'))));

        flush();

        expectNoFramesWritten(router, [48], LOSS_AT - 1, NEW_WELCOME_AT,
            'the call made from the handler must not be written into the lost session or the new handshake');
        expect(writtenFor(router, ['from.handler'])).to.deep.equal({'from.handler': [[NEW_WELCOME_AT, 48]]});
        expect(outcome(fromHandler, argsOf)).to.deep.equal({values: [[140, ['from the handler']]], errors: [], completions: [140]});
    });

    it('client.close() should still fail calls waiting for a session with Connection Closed', () => {
        const router = new FakeRouter([
            droppedSocket(),
            // HELLO 100, WELCOME 160
            cold('-o-----w', {o: open(), w: welcome(1002)})
        ]);
        const client = createClient(router);
        subscribeAt(0, client.onOpen);
        const outageCall = subscribeAt(80, client.call('outage.call'));
        const handshakeCall = subscribeAt(110, client.call('handshake.call'));
        at(130, () => client.close());

        flush();

        const closed = {values: [], errors: [[130, CONNECTION_CLOSED]], completions: []};
        expect({outage: outcome(outageCall), handshake: outcome(handshakeCall)}).to.deep.equal({outage: closed, handshake: closed});
        expect(writtenFor(router, ['outage.call', 'handshake.call'])).to.deep.equal({'outage.call': [], 'handshake.call': []});
    });
});
