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
import {IMessage} from './Messages/Message';
import {Utils} from './Common/Utils';
import {empty, Observable, of, ReplaySubject, Subject, Subscription, throwError, timer, asyncScheduler} from 'rxjs';

import {
    catchError,
    delay,
    exhaust,
    filter,
    map,
    mapTo,
    merge,
    mergeMap,
    multicast,
    refCount,
    retryWhen,
    share,
    switchMap,
    switchMapTo,
    take,
    takeUntil,
    tap
} from "rxjs/operators";

export class Client {
    private messages: Observable<IMessage>;
    private subscription: Subscription;
    private _session: Observable<WelcomeMessage>;
    private challengeCallback: (challenge: Observable<any>) => Observable<string>;
    private currentRetryCount = 0;

    constructor(private urlOrTransport: string | TransportInterface,
                private realm: string,
                private options: WampOptions = {},
                private transport?: TransportInterface) {

        this.transport = typeof urlOrTransport === 'string'
            ? new WebSocketTransport(urlOrTransport)
            : <TransportInterface>this.urlOrTransport;

        this.subscription = new Subscription();

        const open = this.transport.onOpen;

        this.messages = this.transport.pipe(retryWhen((attempts: Observable<Error>) => {
                const maxRetryDelay = 300000;
                const initialRetryDelay = 1500;
                const retryDelayGrowth = 1.5;
                const maxRetries = 550;

                return attempts
                    .pipe(mergeMap((ex: any) => {
                            console.error(ex.message);
                            console.log('Reconnecting');
                            const delay = Math.min(maxRetryDelay, Math.pow(retryDelayGrowth, ++this.currentRetryCount) + initialRetryDelay);
                            return timer(Math.floor(delay));
                        })
                        , take(maxRetries));
            })
            , map((msg: IMessage) => {
                if (msg instanceof AbortMessage) {
                    // @todo create an exception for this
                    asyncScheduler.schedule(() => {
                        throw new Error('Connection ended because ' + msg.details);
                    }, 0);
                }
                return msg;
            })
            , share());

        this._onClose = this.messages.pipe(
            filter(msg => msg instanceof AbortMessage || msg instanceof GoodbyeMessage)
            , share());

        open.pipe(
            tap(() => {
                this.currentRetryCount = 0;
            })
            , map(_ => {
                this.options.roles = Client.roles();
                return new HelloMessage(this.realm, this.options);
            }))
            .subscribe(m => this.transport.next(m));

        const challengeMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof ChallengeMessage)
            , switchMap((msg: ChallengeMessage) => {
                try {
                    return this.challengeCallback(of(msg)).pipe(take(1));
                } catch (e) {
                    throw new WampChallengeException(msg);
                }
            })
            , map((signature: string) => new AuthenticateMessage(signature))
            , catchError((error: Error) => {
                if (error instanceof WampChallengeException) {
                    return of(error.abortMessage());
                }
                return throwError(error);
            })
            , tap(m => this.transport.next(m)));

        this._session = this.messages
            .pipe(merge(challengeMsg)
                , filter((msg: IMessage) => msg instanceof WelcomeMessage)
                , multicast(() => new ReplaySubject(1))
                , refCount());

        this.subscription.add(this.transport);
    }

    private _onClose: Observable<IMessage>;

    get onClose(): Observable<IMessage> {
        return this._onClose;
    }

    get onOpen(): Observable<IMessage> {
        return this._session;
    }

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

    public topic(uri: string, options?: TopicOptions): Observable<EventMessage> {
        return this._session.pipe(
            takeUntil(this.onClose)
            , switchMapTo(new TopicObservable(uri, options, this.messages, this.transport)));
    }

    public publish<T>(uri: string, value: Observable<T> | any, options?: PublishOptions): Subscription {
        const obs = typeof value.subscribe === 'function' ? value as Observable<T> : of(value);
        const completed = new Subject();

        return this._session
            .pipe(takeUntil(completed)
                , takeUntil(this.onClose)
                , mapTo(obs.pipe(tap(null, null, () => {
                    completed.next(0);
                })))
                , exhaust()
                , map(v => new PublishMessage(Utils.uniqueId(), options, uri, [v])))
            .subscribe(this.transport);
    }

    public call(uri: string, args?: Array<any>, argskw?: Object, options?: CallOptions): Observable<ResultMessage> {
        return this._session.pipe(
            merge(this.onClose.pipe(mapTo(throwError(new Error('Connection Closed')))))
            , take(1)
            , switchMapTo(new CallObservable(uri, this.messages, this.transport, args, argskw, options)));
    }

    public register(uri: string, callback: Function, options?: RegisterOptions): Observable<RegisteredMessage | UnregisteredMessage> {
        return this._session.pipe(
            merge(this.onClose.pipe(mapTo(throwError(new Error('Connection Closed')))))
            , switchMapTo(new RegisterObservable(uri, callback, this.messages, this.transport, options)));
    }

    public progressiveCall(uri: string, args?: Array<any>, argskw?: Object, options: CallOptions = {}): Observable<ResultMessage> {

        options.receive_progress = true;
        const completed = new Subject();
        const callObs = new CallObservable(uri, this.messages, this.transport, args, argskw, options);
        let retry = false;
        return this._session.pipe(
            merge(this.onClose.pipe(mapTo(throwError(new Error('Connection Closed')))))
            , takeUntil(completed)
            , switchMapTo(callObs.pipe(tap(null, null, () => {
                completed.next(0);
            })))
            , tap(() => {
                retry = false
            })
            , retryWhen((errors: Observable<any>) => {
                return errors.pipe(
                    mergeMap((e: WampErrorException) => {
                        // start retrying when we get a canceled error and continue retrying until we get a value
                        if (e.errorUri === 'wamp.error.canceled' || retry) {
                            retry = true;
                            return of(e);
                        }

                        return empty();
                    })
                    , delay(5000));
            }));
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
}

export interface WampOptions {
    authmethods?: Array<string>;
    roles?: Object;
    role?: string;

    [propName: string]: any;
}
