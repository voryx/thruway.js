import {TransportInterface} from './Transport/TransportInterface';
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
import {ReplaySubject} from 'rxjs/ReplaySubject';
import {IMessage} from './Messages/Message';
import {Utils} from './Common/Utils';
import {Observable} from 'rxjs/Observable';
import {Subscription} from 'rxjs/Subscription';
import {Scheduler, Subject} from 'rxjs';

import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/share';
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
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/timer';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/merge';
import 'rxjs/add/observable/throw';

export class Client {
    private messages: Observable<IMessage>;
    private subscription: Subscription;
    private _session: Observable<WelcomeMessage>;
    private _onClose: Observable<IMessage>;
    private challengeCallback: (challenge: Observable<any>) => Observable<string>;
    private currentRetryCount = 0;

    private static roles() {
        return {
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
    }

    constructor(private urlOrTransport: string | TransportInterface,
                private realm: string,
                private options: WampOptions = {},
                private transport?: TransportInterface) {

        this.transport = typeof urlOrTransport === 'string'
            ? new WebSocketTransport(urlOrTransport)
            : <TransportInterface>this.urlOrTransport;

        this.subscription = new Subscription();

        const open = this.transport.onOpen;

        this.messages = this.transport
            .retryWhen((attempts: Observable<Error>) => {
                const maxRetryDelay = 300000;
                const initialRetryDelay = 1500;
                const retryDelayGrowth = 1.5;
                const maxRetries = 550;

                return attempts
                    .flatMap((ex) => {
                        console.error(ex);
                        console.log('Reconnecting');
                        const delay = Math.min(maxRetryDelay, Math.pow(retryDelayGrowth, ++this.currentRetryCount) + initialRetryDelay);
                        return Observable.timer(Math.floor(delay));
                    })
                    .take(maxRetries);
            })
            .map((msg: IMessage) => {
                if (msg instanceof AbortMessage) {
                    // @todo create an exception for this
                    Scheduler.async.schedule(() => {
                        throw new Error('Connection ended because ' + msg.details);
                    }, 0);
                }
                return msg;
            })
            .share();

        this._onClose = this.messages
            .filter(msg => msg instanceof AbortMessage || msg instanceof GoodbyeMessage)
            .share();

        open
            .do(() => {
                this.currentRetryCount = 0;
            })
            .map(_ => {
                this.options.roles = Client.roles();
                return new HelloMessage(this.realm, this.options);
            })
            .subscribe(m => this.transport.next(m));

        const challengeMsg = this.messages
            .filter((msg: IMessage) => msg instanceof ChallengeMessage)
            .switchMap((msg: ChallengeMessage) => {
                try {
                    return this.challengeCallback(Observable.of(msg)).take(1);
                } catch (e) {
                    throw new WampChallengeException(msg);
                }
            })
            .map((signature: string) => new AuthenticateMessage(signature))
            .catch((error: Error) => {
                if (error instanceof WampChallengeException) {
                    return Observable.of(error.abortMessage());
                }
                return Observable.throw(error);
            })
            .do(m => this.transport.next(m));

        this._session = this.messages
            .merge(challengeMsg)
            .filter((msg: IMessage) => msg instanceof WelcomeMessage)
            .multicast(() => new ReplaySubject(1)).refCount();

        this.subscription.add(this.transport);
    }

    public topic(uri: string, options?: TopicOptions): Observable<EventMessage> {
        return this._session
            .takeUntil(this.onClose)
            .switchMapTo(new TopicObservable(uri, options, this.messages, this.transport));
    }

    public publish<T>(uri: string, value: Observable<T> | any, options?: PublishOptions): Subscription {
        const obs = typeof value.subscribe === 'function' ? value as Observable<T> : Observable.of(value);
        const completed = new Subject();

        return this._session
            .takeUntil(completed)
            .takeUntil(this.onClose)
            .mapTo(obs.do(null, null, () => {
                completed.next(0);
            }))
            .exhaust()
            .map(v => new PublishMessage(Utils.uniqueId(), options, uri, [v]))
            .subscribe(this.transport);
    }

    public call(uri: string, args?: Array<any>, argskw?: Object, options?: CallOptions): Observable<ResultMessage> {
        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .take(1)
            .switchMapTo(new CallObservable(uri, this.messages, this.transport, args, argskw, options));
    }

    public register(uri: string, callback: Function, options?: RegisterOptions): Observable<RegisteredMessage | UnregisteredMessage> {
        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .switchMapTo(new RegisterObservable(uri, callback, this.messages, this.transport, options));
    }

    public progressiveCall(uri: string, args?: Array<any>, argskw?: Object, options: CallOptions = {}): Observable<ResultMessage> {

        options.receive_progress = true;
        const completed = new Subject();
        const callObs = new CallObservable(uri, this.messages, this.transport, args, argskw, options);
        let retry = false;
        return this._session
            .merge(this.onClose.mapTo(Observable.throw(new Error('Connection Closed'))))
            .takeUntil(completed)
            .switchMapTo(callObs.do(null, null, () => {
                completed.next(0);
            }))
            .do(() => {
                retry = false
            })
            .retryWhen((errors: Observable<any>) => {
                return errors
                    .flatMap((e: WampErrorException) => {
                        // start retrying when we get a canceled error and continue retrying until we get a value
                        if (e.errorUri === 'wamp.error.canceled' || retry) {
                            retry = true;
                            return Observable.of(e);
                        }

                        return Observable.empty();
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

    public close() {
        this.subscription.unsubscribe();
    }

    get onOpen(): Observable<IMessage> {
        return this._session;
    }

    get onClose(): Observable<IMessage> {
        return this._onClose;
    }
}

export interface WampOptions {
    authmethods?: Array<string>;
    roles?: Object;
    role?: string;

    [propName: string]: any;
}
