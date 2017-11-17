import {Subscription} from 'rxjs/Subscription';
import {Observable} from 'rxjs/Observable';
import {Subscriber} from 'rxjs/Subscriber';
import {Subject} from 'rxjs/Subject';
import {CreateMessage} from '../Messages/CreateMessage';
import {TransportInterface} from './TransportInterface';

export class WebWorkerTransport<Message> extends Subject<any> implements TransportInterface {

    private output: Subject<any> = new Subject();
    private open = new Subject();
    private close = new Subject();
    private worker: Worker;

    constructor(private workerName: string = 'worker.js', private url: string = 'ws://127.0.0.1:9090/', private protocols: string | string[] = ['wamp.2.json']) {
        super();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription {

        let ww: Worker;
        if (!this.worker) {
            ww = new Worker(this.workerName);
        }

        this.output = new Subject();

        const messages = new Subject();

        ww.postMessage({type: 'open', url: this.url, protocols: this.protocols});
        ww.onmessage = (e) => {
            messages.next(e);
        };

        const open = messages
            .filter((e: MessageEvent) => e.data.type === 'open')
            .subscribe(e => {
                console.log('socket opened');
                this.worker = ww;
                this.open.next(e);
            });

        const close = messages
            .filter((e: MessageEvent) => e.data.type === 'close')
            .subscribe(e => {
                this.worker = null;
                this.close.next(e);

                // Handle all closes as errors
                this.output.error(e);
            });

        const message = messages
            .filter((e: MessageEvent) => e.data.type === 'message')
            .subscribe((e: MessageEvent) => {
                console.log(e.data.payload);
                const d = e.data.payload;
                this.output.next(CreateMessage.fromArray(d));
            });

        const error = messages
            .filter((e: MessageEvent) => e.data.type === 'error')
            .subscribe(e => {
                this.worker = null;
                this.output.error(e);
            });

        const subscription = new Subscription();

        subscription.add(this.output.subscribe(subscriber));
        subscription.add(error);
        subscription.add(message);
        subscription.add(close);
        subscription.add(open);

        subscription.add(() => {

            if (this.worker) {
                console.log('closing socket');
                this.worker.postMessage({type: 'close'});
                this.worker = null;
            }
        });

        return subscription;
    }

    public next(msg: any): void {
        if (!this.worker) {
            return;
        }

        this.worker.postMessage({type: 'send', payload: msg.wampifiedMsg()});
    }

    public unsubscribe(): void {
        super.unsubscribe();

        if (this.worker) {
            this.worker.postMessage({type: 'close'});
        }
    }

    get onOpen(): Observable<any> {
        return this.open.asObservable();
    }

    get onClose(): Observable<any> {
        return this.close.asObservable();
    }
}
