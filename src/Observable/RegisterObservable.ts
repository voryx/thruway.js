import {WampInvocationException} from '../Common/WampInvocationException';
import {UnregisteredMessage} from '../Messages/UnregisteredMessage';
import {RegisteredMessage} from '../Messages/RegisteredMessage';
import {InvocationMessage} from '../Messages/InvocationMessage';
import {UnregisterMessage} from '../Messages/UnregisterMessage';
import {WampErrorException} from '../Common/WampErrorException';
import {InterruptMessage} from '../Messages/InterruptMessage';
import {RegisterMessage} from '../Messages/RegisterMessage';
import {ErrorMessage} from '../Messages/ErrorMessage';
import {YieldMessage} from '../Messages/YieldMessage';
import {IMessage} from '../Messages/Message';
import {Utils} from '../Common/Utils';
import {Scheduler,Subject,Subscriber,Subscription,Observable, merge, of, throwError, empty} from "rxjs";
import {filter, share, take, tap, mergeMap, takeUntil, mergeMapTo, map} from "rxjs/operators";

export interface RegisterOptions {
    progress?: boolean;
    invoke?: string | 'first' | 'last' | 'roundrobin' | 'random' | '_thruway' | 'single' | 'all';
    match?: string | 'prefix' | 'wildcard' | 'exact';
    disclose_caller?: boolean;
    force_reregister?: boolean;
    replace_orphaned_sessions?: boolean | 'yes' | 'no'; // Thruway equivalent of 'force_reregister'
    expanded?: boolean

    [propName: string]: any;
}

export class RegisterObservable<T> extends Observable<T> {

    private messages: Observable<IMessage>;
    private invocationErrors: Subject<WampInvocationException>;

    constructor(private uri: string,
                private callback: Function,
                messages: Observable<IMessage>,
                private webSocket: Subject<any>,
                private options: RegisterOptions = {},
                invocationErrors?: Subject<WampInvocationException>,
                private scheduler: Scheduler = null) {
        super();

        this.messages = messages.pipe(share());
        this.invocationErrors = invocationErrors || new Subject();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription | Function | void {

        const self = this;
        const requestId = Utils.uniqueId();
        const disposable = new Subscription();
        const registerMsg = new RegisterMessage(requestId, this.options, this.uri);
        let registrationId: number = null;
        let completed = false;

        const unregisteredMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof UnregisteredMessage && msg.requestId === requestId)
            ,take(1)
            ,share());

        const registeredMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof RegisteredMessage && msg.requestId === requestId)
            ,tap((m: RegisteredMessage) => {
                registrationId = m.registrationId;
            })
            ,take(1)
            ,share());

        const invocationMessage = registeredMsg.pipe(mergeMap((m: RegisteredMessage) => {
            return this.messages.pipe(filter((msg: IMessage) => msg instanceof InvocationMessage && msg.registrationId === m.registrationId));
        }));

        // Transform WAMP error messages into an error observable
        const error = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof ErrorMessage && msg.errorRequestId === requestId)
            ,mergeMap((msg: ErrorMessage) => throwError(new WampErrorException(msg.errorURI, msg.args), this.scheduler))
            ,takeUntil(registeredMsg)
            ,take(1));

        const unregister = function () {
            if (!registrationId || completed) {
                return;
            }
            const unregisterMsg = new UnregisterMessage(Utils.uniqueId(), registrationId);
            self.webSocket.next(unregisterMsg);
        };

        this.webSocket.next(registerMsg);

        const registerSubscription = merge(registeredMsg, unregisteredMsg, error)
            .subscribe(
                (v) => subscriber.next(v),
                (e) => subscriber.error(e),
                () => {
                    unregister();
                    completed = true;
                    subscriber.complete();
                });

        const invocationSubscription = invocationMessage
            .pipe(mergeMap((msg: InvocationMessage) => {
                    let result = null;
                    try {
                        if (self.options.extended) {
                            result = self.callback(msg.args, msg.argskw, msg.details, msg);
                        } else {
                            result = self.callback.apply(null, msg.args);
                        }
                    } catch (e) {
                        result = throwError(e);
                    }

                    // There are some node issues when using instanceof Observable
                    const resultObs = typeof result.subscribe === 'function'
                        ? result.defaultIfEmpty(null)
                        : of(result, this.scheduler);

                    let returnObs;
                    if (!!this.options.progress === false) {
                        returnObs = resultObs
                            .take(1)
                            .map((value: any) => new YieldMessage(msg.requestId, {}, [value]));
                    } else {
                        returnObs = resultObs
                            .map((value: any) => new YieldMessage(msg.requestId, {progress: true}, [value]))
                            .concat(of(new YieldMessage(msg.requestId, {})));
                    }

                    const interruptMsg = this.messages.pipe(filter((m: IMessage) => m instanceof InterruptMessage && m.requestId === msg.requestId)
                        ,take(1)
                        ,mergeMapTo(throwError(new WampInvocationException(msg, 'wamp.error.canceled'))));

                    return returnObs.merge(interruptMsg)
                        .takeUntil(unregisteredMsg)
                        .catch((ex: Error) => {
                            const invocationError = ex instanceof WampErrorException
                                ? WampInvocationException.withInvocationMessageAndWampErrorException(msg, ex)
                                : new WampInvocationException(msg);

                            this.invocationErrors.next(invocationError);
                            return empty(this.scheduler);
                        });
                }
            ))
            .subscribe(this.webSocket);

        const invocationErrorsSubscription = this.invocationErrors.pipe(map((e: WampInvocationException) => e.errorMessage()))
            .subscribe(this.webSocket);

        disposable.add(invocationErrorsSubscription);
        disposable.add(invocationSubscription);
        disposable.add(registerSubscription);
        disposable.add(unregister);

        return disposable;
    }
}
