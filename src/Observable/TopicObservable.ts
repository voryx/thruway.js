import {UnsubscribedMessage} from '../Messages/UnsubscribedMessage';
import {UnsubscribeMessage} from '../Messages/UnsubscribeMessage';
import {SubscribedMessage} from '../Messages/SubscribedMessage';
import {WampErrorException} from '../Common/WampErrorException';
import {SubscribeMessage} from '../Messages/SubscribeMessage';
import {ErrorMessage} from '../Messages/ErrorMessage';
import {EventMessage} from '../Messages/EventMessage';
import {IMessage} from '../Messages/Message';
import {Utils} from '../Common/Utils';
import {Observable, Subject, Subscriber, Subscription} from "rxjs";
import {filter, merge, mergeMap, take, takeUntil, tap} from 'rxjs/operators';

export interface TopicOptions {
    disclose_publisher?: boolean;

    [propName: string]: any;
}

export interface PublishOptions {
    exclude_me?: boolean;
    disclose_me?: boolean;
    // acknowledge?: boolean; // Not supported
    eligible?: Array<number>;
    eligible_authid?: Array<string>;
    eligible_authroles?: Array<string>;
    exclude?: Array<number>;
    exclude_authid?: Array<string>;
    exclude_authroles?: Array<string>;
    _thruway_eligible_authids?: Array<string>;
    _thruway_eligible_authroles?: Array<string>;

    [propName: string]: any;
}

export class TopicObservable<EventMsg> extends Observable<any> {

    constructor(private uri: string,
                private options: TopicOptions,
                private messages: Observable<IMessage>,
                private websocket: Subject<IMessage>) {
        super();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription | Function | void {

        const requestId = Utils.uniqueId();
        let subscriptionId: number = null;
        const subscribeMsg = new SubscribeMessage(requestId, this.options, this.uri);

        const subscribedMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof SubscribedMessage && msg.requestId === requestId)
            , take(1));

        const errorMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof ErrorMessage && msg.errorRequestId === requestId)
            , mergeMap((msg: ErrorMessage) => Observable.throw(new WampErrorException(msg.errorURI, msg.args)))
            , take(1));

        const unsubscribedMsg = this.messages.pipe(
            filter((msg: IMessage) => msg instanceof UnsubscribedMessage && msg.requestId === requestId)
            , take(1));

        this.websocket.next(subscribeMsg);

        const sub = subscribedMsg.pipe(
            tap((m: SubscribedMessage) => subscriptionId = m.subscriptionId)
            , mergeMap((m: SubscribedMessage) => {
                const sid = m.subscriptionId;

                return this.messages.pipe(filter((msg: IMessage) => msg instanceof EventMessage && msg.subscriptionId === sid));
            })
            , merge(errorMsg)
            , takeUntil(unsubscribedMsg))
            .subscribe(subscriber);

        const disposable = new Subscription();

        disposable.add(sub);

        disposable.add(() => {
            if (!subscriptionId) {
                return;
            }
            const unsubscribeMsg = new UnsubscribeMessage(Utils.uniqueId(), subscriptionId);
            this.websocket.next(unsubscribeMsg);
        });

        return disposable;
    }
}
