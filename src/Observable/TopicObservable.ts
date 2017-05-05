import {UnsubscribedMessage} from '../Messages/UnsubscribedMessage';
import {UnsubscribeMessage} from '../Messages/UnsubscribeMessage';
import {SubscribedMessage} from '../Messages/SubscribedMessage';
import {WampErrorException} from '../Common/WampErrorException';
import {SubscribeMessage} from '../Messages/SubscribeMessage';
import {ErrorMessage} from '../Messages/ErrorMessage';
import {EventMessage} from '../Messages/EventMessage';
import {Message} from '../Messages/Message';
import {Subscription} from 'rxjs/Subscription';
import {Observable} from 'rxjs/Observable';
import {Subscriber} from 'rxjs/Subscriber';
import {Utils} from '../Common/Utils';
import {Subject} from 'rxjs/Subject';

export class TopicObservable<EventMsg> extends Observable<any> {

    constructor(private uri: string,
                private options: Object,
                private messages: Observable<Message>,
                private websocket: Subject<Message>) {
        super();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription | Function | void {

        const requestId = Utils.uniqueId();
        const subscriptionId = null;
        const subscribeMsg = new SubscribeMessage(requestId, this.options, this.uri);

        const subscribedMsg = this.messages
            .filter((msg: Message) => msg instanceof SubscribedMessage && msg.requestId === requestId)
            .take(1);

        const errorMsg = this.messages
            .filter((msg: Message) => msg instanceof ErrorMessage && msg.errorRequestId === requestId)
            .flatMap((msg: ErrorMessage) => Observable.throw(new WampErrorException(msg.errorURI, msg.args)))
            .take(1);

        const unsubscribedMsg = this.messages
            .filter((msg: Message) => msg instanceof UnsubscribedMessage && msg.requestId === requestId)
            .take(1);

        this.websocket.next(subscribeMsg);

        const sub = subscribedMsg
            .flatMap((m: SubscribedMessage) => {

                const sid = m.subscriptionId;

                return this.messages
                    .filter((msg: Message) => msg instanceof EventMessage && msg.subscriptionId === sid);
            })
            .merge(errorMsg)
            .takeUntil(unsubscribedMsg)
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
