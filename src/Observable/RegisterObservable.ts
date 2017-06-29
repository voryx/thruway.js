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
import {Message} from '../Messages/Message';
import {Observable} from 'rxjs/Observable';
import {Subscription} from 'rxjs/Subscription';
import {Subscriber} from 'rxjs/Subscriber';
import {Utils} from '../Common/Utils';
import {Subject} from 'rxjs/Subject';
import {Scheduler} from 'rxjs/Scheduler';

export class RegisterObservable<T> extends Observable<T> {

    private messages: Observable<Message>;
    private invocationErrors: Subject<WampInvocationException>;

    constructor(private uri: string,
                private callback: Function,
                messages: Observable<Message>,
                private webSocket: Subject<Message>,
                private options: any = {},
                private extended?: boolean,
                invocationErrors?: Subject<WampInvocationException>,
                private scheduler: Scheduler = null) {
        super();

        this.messages = messages.share();
        this.invocationErrors = invocationErrors || new Subject();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription | Function | void {

        const self = this;
        const requestId = Utils.uniqueId();
        const disposable = new Subscription();
        const registerMsg = new RegisterMessage(requestId, this.options, this.uri);
        let registrationId = null;
        let completed = false;

        const unregisteredMsg = this.messages
            .filter((msg: Message) => msg instanceof UnregisteredMessage && msg.requestId === requestId)
            .take(1)
            .share();

        const registeredMsg = this.messages
            .filter((msg: Message) => msg instanceof RegisteredMessage && msg.requestId === requestId)
            .do((m: RegisteredMessage) => {
                registrationId = m.registrationId;
            })
            .take(1)
            .share();

        const invocationMessage = registeredMsg.flatMap((m: RegisteredMessage) => {
            return this.messages.filter((msg: Message) => msg instanceof InvocationMessage && msg.registrationId === m.registrationId);
        });

        // Transform WAMP error messages into an error observable
        const error = this.messages
            .filter((msg: Message) => msg instanceof ErrorMessage && msg.errorRequestId === requestId)
            .flatMap((msg: ErrorMessage) => Observable.throw(new WampErrorException(msg.errorURI, msg.args), this.scheduler))
            .takeUntil(registeredMsg)
            .take(1);

        const unregister = function () {
            if (!registrationId || completed) {
                return;
            }
            const unregisterMsg = new UnregisterMessage(Utils.uniqueId(), registrationId);
            self.webSocket.next(unregisterMsg);
        };

        this.webSocket.next(registerMsg);

        const registerSubscription = Observable
            .merge(registeredMsg, unregisteredMsg, error)
            .subscribe(
                (v) => subscriber.next(v),
                (e) => subscriber.error(e),
                () => {
                    unregister();
                    completed = true;
                    subscriber.complete();
                });

        const invocationSubscription = invocationMessage
            .flatMap((msg: InvocationMessage) => {
                    let result = null;
                    try {
                        if (self.extended) {
                            result = self.callback(msg.args, msg.argskw, msg.details, msg);
                        } else {
                            result = self.callback.apply(null, msg.args);
                        }
                    } catch (e) {
                        result = Observable.throw(e);
                    }

                    // There are some node issues when using instanceof Observable
                    const resultObs = typeof result.subscribe === 'function'
                        ? result.defaultIfEmpty(null)
                        : Observable.of(result, this.scheduler);

                    let returnObs;
                    if (!!this.options.progress === false) {
                        returnObs = resultObs
                            .take(1)
                            .map((value) => [value, msg, this.options]);
                    } else {
                        returnObs = resultObs
                            .map((value) => [value, msg, this.options])
                            .concat(Observable.of([null, msg, {progress: false}], this.scheduler));
                    }

                    const interruptMsg = this.messages
                        .filter((m: Message) => m instanceof InterruptMessage && m.requestId === msg.requestId)
                        .take(1)
                        .flatMapTo(Observable.throw(new WampInvocationException(msg, 'wamp.error.canceled')));

                    return returnObs.merge(interruptMsg)
                        .takeUntil(unregisteredMsg)
                        .catch((ex: Error) => {
                            const invocationError = ex instanceof WampErrorException
                                ? WampInvocationException.withInvocationMessageAndWampErrorException(msg, ex)
                                : new WampInvocationException(msg);

                            this.invocationErrors.next(invocationError);
                            return Observable.empty(this.scheduler);
                        });
                }
            )
            .map((args: any) => {
                const [value, invocationMsg, options] = args;

                return new YieldMessage(invocationMsg.requestId, options, [value]);
            })
            .subscribe(this.webSocket);

        const invocationErrorsSubscription = this.invocationErrors
            .map((e: WampInvocationException) => e.errorMessage())
            .subscribe(this.webSocket);

        disposable.add(invocationErrorsSubscription);
        disposable.add(invocationSubscription);
        disposable.add(registerSubscription);
        disposable.add(unregister);

        return disposable;
    }
}
