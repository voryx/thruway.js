import {Observable} from 'rxjs/Observable';
import {Subscription} from 'rxjs/Subscription';
import {Subscriber} from 'rxjs/Subscriber';
import {WampErrorException} from '../Common/WampErrorException';
import {ResultMessage} from '../Messages/ResultMessage';
import {CancelMessage} from '../Messages/CancelMessage';
import {ErrorMessage} from '../Messages/ErrorMessage';
import {CallMessage} from '../Messages/CallMessage';
import {Message} from '../Messages/Message';
import {Utils} from '../Common/Utils';
import {Subject} from 'rxjs/Subject';
import {Scheduler} from 'rxjs/Scheduler';

export class CallObservable<ResultMsg> extends Observable<any> {

    private completed = false;
    private messages: Observable<Message>;

    constructor(private uri: string,
                messages: Observable<Message>,
                private webSocket: Subject<any>,
                private args?: Array<any>,
                private argskw?: Object,
                private options: Object = {},
                private scheduler?: Scheduler) {
        super();
        this.messages = messages.share();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription | Function | void {
        const requestId = Utils.uniqueId();
        const callMsg = new CallMessage(requestId, this.options, this.uri, this.args, this.argskw);

        const msg = this.messages
            .filter((m: Message) => m instanceof ResultMessage && m.requestId === requestId)
            .flatMap((m: ResultMessage, index: number) => {
                // If there is no progress, we need to fake it so that the observable completes
                if (index === 0 && !!m.details.progress === false) {
                    const details = m.details;

                    details.progress = true;

                    return Observable.from([
                        new ResultMessage(m.requestId, details, m.args, m.argskw),
                        new ResultMessage(m.requestId, {progress: false})
                    ], this.scheduler)
                }
                return Observable.of(m);
            })
            .publish().refCount();

        // take until we get a message with progress: false
        const resultMsg = msg
            .takeWhile(m => m.details.progress || false)
            .finally(() => this.completed = true)
            .share();

        const error = this.messages
            .filter((m: Message) => m instanceof ErrorMessage && m.errorRequestId === requestId)
            .do(() => this.completed = true)
            .flatMap((m: ErrorMessage) => Observable.throw(new WampErrorException(m.errorURI, m.args), this.scheduler))
            .take(1);

        try {
            this.webSocket.next(callMsg);
        } catch (e) {
            subscriber.error(e);
            return;
        }

        const result: Observable<ResultMessage> = error
            .merge(resultMsg)
            .map((m: ResultMessage) => {
                const details = m.details;
                delete details.progress;
                return new ResultMessage(m.requestId, details, m.args, m.argskw);
            });

        const disposable = new Subscription(() => {
            if (!this.completed) {
                const cancelMsg = new CancelMessage(requestId, {});
                this.webSocket.next(cancelMsg);
            }
        });

        disposable.add(result.subscribe(
            (v) => subscriber.next(v),
            (e) => subscriber.error(e),
            () => subscriber.complete()
        ));

        return disposable;
    }
}
