import {WampChallengeException} from './Common/WampChallengeException';
import {WebSocketTransport} from './Transport/WebSocketTransport';
import {RegisterObservable, RegisterOptions} from './Observable/RegisterObservable';
import {AuthenticateMessage} from './Messages/AuthenticateMessage';
import {WampErrorException} from './Common/WampErrorException';
import {PublishOptions, TopicObservable, TopicOptions} from './Observable/TopicObservable';
import {ChallengeMessage} from './Messages/ChallengeMessage';
import {CallObservable, CallOptions} from './Observable/CallObservable';
import {GoodbyeMessage} from './Messages/GoodbyeMessage';
import {WelcomeMessage} from './Messages/WelcomeMessage';
import {PublishMessage} from './Messages/PublishMessage';
import {ResultMessage} from './Messages/ResultMessage';
import {RegisteredMessage} from './Messages/RegisteredMessage';
import {UnregisteredMessage} from './Messages/UnregisteredMessage';
import {EventMessage} from './Messages/EventMessage';
import {HelloMessage} from './Messages/HelloMessage';
import {AbortMessage} from './Messages/AbortMessage';
import {OpenMessage} from './Messages/OpenMessage';
import {IMessage} from './Messages/Message';
import {Utils} from './Common/Utils';
import {Observable} from 'rxjs/Observable';
import {Subscription} from 'rxjs/Subscription';
import {Subject} from 'rxjs/Subject';
import {ReplaySubject} from 'rxjs/ReplaySubject';
import {async} from 'rxjs/scheduler/async';

import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/mapTo';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/switchMap';
import 'rxjs/add/operator/switchMapTo';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/takeWhile';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/publishReplay';
import 'rxjs/add/operator/publish';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/finally';
import 'rxjs/add/operator/exhaust';
import 'rxjs/add/operator/defaultIfEmpty';
import 'rxjs/add/operator/multicast';
import 'rxjs/add/operator/shareReplay';
import 'rxjs/add/operator/combineLatest';
import 'rxjs/add/operator/partition';
import 'rxjs/add/operator/race';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/timer';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/merge';
import 'rxjs/add/observable/throw';

export class Client {
    private static roles = {
        'caller': {
            'features': {
                'caller_identification': true,
                'progressive_call_results': true,
                'call_canceling': true
            }
        },
        'callee': {
            'features': {
                'caller_identification': true,
                'pattern_based_registration': true,
                'shared_registration': true,
                'progressive_call_results': true,
                'registration_revocation': true,
                'call_canceling': true
            }
        },
        'publisher': {
            'features': {
                'publisher_identification': true,
                'subscriber_blackwhite_listing': true,
                'publisher_exclusion': true
            }
        },
        'subscriber': {
            'features': {
                'publisher_identification': true,
                'pattern_based_subscription': true,
                'subscription_revocation': true
            }
        }
    };

    private static retryDefaults: RetryOptions = {
        maxRetryDelay: 60000,
        initialRetryDelay: 1500,
        retryDelayGrowth: 1.5,
        maxRetries: 10000
    };

    private subscription: Subscription;
    private _session: Observable<SessionData>;
    private _transport: Subject<IMessage>;
    private _onClose: Subject<IMessage>;
    private currentRetryCount = 0;

    private challengeCallback: (challenge: Observable<ChallengeMessage>) => Observable<string> = () => Observable.throw(
        Error('When trying to make a WAMP connection, we received a Challenge Message, but no `onChallenge` callback was set.')
    );

    public readonly defaultRetryWhen = (retryOptions?: RetryOptions) => {
        return (attempts: Observable<Error>) => {

            const o = {...Client.retryDefaults, ...retryOptions};

            const {maxRetryDelay, initialRetryDelay, retryDelayGrowth, maxRetries} = o;

            return attempts
                .flatMap((ex) => {
                    console.error(ex.message);
                    const delay = Math.min(maxRetryDelay, Math.pow(retryDelayGrowth, ++this.currentRetryCount) + initialRetryDelay);
                    console.log('Reconnecting attempt: ' + this.currentRetryCount + ', Retrying in: ' + (delay / 1000).toPrecision(4) + ' seconds.');
                    return Observable.timer(Math.floor(delay));
                })
                .take(maxRetries);
        };
    };

    constructor(urlOrTransportOrObs: string | Subject<IMessage> | Observable<ThruwayConfig>, realm?: string, options: WampOptions = {}) {

        this.subscription = new Subscription();
        this._onClose = new Subject();

        const close = new Subject();

        let transportData: Observable<TransportData>;

        if (typeof urlOrTransportOrObs === 'string') {
            this._transport = new WebSocketTransport(urlOrTransportOrObs, ['wamp.2.json'], close);
            transportData = Observable.of({
                transport: this._transport,
                realm,
                options
            }) as any as Observable<TransportData>;
        } else if (urlOrTransportOrObs instanceof Subject) {
            this._transport = urlOrTransportOrObs as any as Subject<IMessage>;
            transportData = Observable.of({
                transport: this._transport,
                realm,
                options
            }) as any as Observable<TransportData>;
        } else {
            transportData = (urlOrTransportOrObs as Observable<ThruwayConfig>).map((config: ThruwayConfig) => {
                this._transport = new WebSocketTransport(config.url, ['wamp.2.json'], close, config.autoOpen);
                return {transport: this._transport, realm: config.realm, options: config.options || {}}
            }) as any as Observable<TransportData>;
        }

        transportData = transportData
            .do(({transport}) => this.subscription.add(transport))
            .take(1)
            .shareReplay(1);

        const messages = transportData
            .switchMap(({transport, options: o, realm: r}) => transport
                .map((msg: IMessage) => {
                    if (msg instanceof AbortMessage) {
                        // @todo create an exception for this
                        async.schedule(() => {
                            throw new Error('Connection ended because ' + JSON.stringify(msg.details));
                        }, 0);
                    }
                    return msg;
                })
                .do((msg: IMessage) => {
                    if (msg instanceof OpenMessage) {
                        this.currentRetryCount = 0;
                        o.roles = Client.roles;
                        const helloMsg = new HelloMessage(r, o);
                        transport.next(helloMsg);
                    }
                })
                .race(Observable.timer(options.timeout || 5000).switchMapTo(Observable.throw(Error('Transport Timeout'))))
                .retryWhen(o.retryWhen || this.defaultRetryWhen(options.retryOptions))
            )
            .share();

        let remainingMsgs: Observable<IMessage>, challengeMsg, goodByeMsg, abortMsg,
            welcomeMsg: Observable<WelcomeMessage>;

        [challengeMsg, remainingMsgs] = messages.partition(msg => msg instanceof ChallengeMessage);

        [goodByeMsg, remainingMsgs] = remainingMsgs.partition(msg => msg instanceof GoodbyeMessage);

        [abortMsg, remainingMsgs] = remainingMsgs.partition(msg => msg instanceof AbortMessage);

        goodByeMsg = goodByeMsg.do(v => this._onClose.next(v));

        remainingMsgs = remainingMsgs.merge(goodByeMsg);

        abortMsg = abortMsg.do(v => this._onClose.next(v));

        const challenge = this.challenge(challengeMsg)
            .combineLatest(transportData)
            .do(([msg, td]) => td.transport.next(msg));

        const abortError = abortMsg.map((msg: AbortMessage) => {
            throw new Error(msg.details.message + ' ' + msg.reason)
        });

        [welcomeMsg, remainingMsgs] = remainingMsgs
            .merge(challenge.share())
            .merge(abortError.share())
            .partition(msg => msg instanceof WelcomeMessage) as [Observable<WelcomeMessage>, Observable<IMessage>];

        this._session = welcomeMsg
            .combineLatest(transportData)
            .map(([msg, td]) => ({messages: remainingMsgs, transport: td.transport, welcomeMsg: msg}))
            .multicast(() => new ReplaySubject(1)).refCount();
    }

    public topic(uri: string, options?: TopicOptions): Observable<EventMessage> {
        return this._session
            .switchMap(({transport, messages}: SessionData) => new TopicObservable(uri, options, messages, transport))
            .takeUntil(this.onClose);
    }

    public publish<T>(uri: string, value: Observable<T> | any, options?: PublishOptions): Subscription {
        const obs = typeof value.subscribe === 'function' ? value as Observable<T> : Observable.of(value);
        const completed = new Subject();

        return this._session
            .takeUntil(completed)
            .map(({transport}: SessionData) => obs
                .finally(() => completed.next(0))
                .map(v => new PublishMessage(Utils.uniqueId(), options, uri, [v]))
                .do(m => transport.next(m))
            )
            .exhaust()
            .takeUntil(this.onClose)
            .subscribe();
    }

    public call(uri: string, args?: Array<any>, argskw?: Object, options?: CallOptions): Observable<ResultMessage> {
        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .take(1)
            .switchMap(({transport, messages}: SessionData) => new CallObservable(uri, messages, transport, args, argskw, options));
    }

    public register(uri: string, callback: Function, options?: RegisterOptions): Observable<RegisteredMessage | UnregisteredMessage> {
        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .switchMap(({transport, messages}: SessionData) => new RegisterObservable(uri, callback, messages, transport, options));
    }

    public progressiveCall(uri: string, args?: Array<any>, argskw?: Object, options: CallOptions = {}): Observable<ResultMessage> {

        options.receive_progress = true;
        const completed = new Subject();
        let retry = false;

        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .takeUntil(completed)
            .switchMap(({transport, messages}: SessionData) => {
                const callObs = new CallObservable(uri, messages, transport, args, argskw, options);
                return callObs.finally(() => completed.next(0))
            })
            .do(() => retry = false)
            .retryWhen((errors: Observable<any>) => {
                return errors
                    .flatMap((e: WampErrorException) => {
                        // start retrying when we get a canceled error and continue retrying until we get a value
                        if (e.errorUri === 'wamp.error.canceled' || retry) {
                            retry = true;
                            return Observable.of(e);
                        }

                        return Observable.throw(e);
                    })
                    .delay(5000);
            });
    }

    public progressiveRegister(uri: string, callback: Function, options: RegisterOptions = {}): Observable<any> {

        options.progress = true;
        options.replace_orphaned_sessions = 'yes';
        return this.register(uri, callback, options);
    }

    public onChallenge(challengeCallback: (challenge: Observable<ChallengeMessage>) => Observable<string>) {
        this.challengeCallback = challengeCallback;
    }

    private challenge = (challengeMsg: Observable<IMessage>) => {
        return challengeMsg
            .switchMap((msg: ChallengeMessage) => {
                let challengeResult: Observable<string> = null;

                try {
                    challengeResult = this.challengeCallback(Observable.of(msg))
                } catch (e) {
                    console.error(e);
                    throw new WampChallengeException(msg);
                }

                return challengeResult.take(1);
            })
            .map(signature => new AuthenticateMessage(signature))
            .catch(e => {
                if (e instanceof WampChallengeException) {
                    return Observable.of(e.abortMessage());
                }
                return Observable.throw(e);
            });
    };

    public close() {
        this._onClose.next();
    }

    public open() {
        // @todo we should be using a connectable observable for this
        (this._transport as WebSocketTransport<IMessage>).open();
    }

    get onOpen(): Observable<SessionData> {
        return this._session;
    }

    get onClose(): Observable<IMessage> {
        return this._onClose;
    }
}

export interface RetryOptions {
    maxRetryDelay?: number,
    initialRetryDelay?: number,
    retryDelayGrowth?: number,
    maxRetries?: number
}

export interface WampOptions {
    authmethods?: Array<string>;
    roles?: Object;
    role?: string;
    retryWhen?: (attempts: Observable<Error>) => Observable<any>;
    retryOptions?: RetryOptions;
    timeout?: number;

    [propName: string]: any;
}

export interface SessionData {
    messages: Observable<IMessage>,
    transport: Subject<IMessage>,
    welcomeMsg: WelcomeMessage
}

export interface ThruwayConfig {
    autoOpen?: boolean
    url: string;
    realm: string;
    options: WampOptions;
}

export interface TransportData {
    transport: Subject<IMessage>,
    realm: string,
    options: WampOptions
}
