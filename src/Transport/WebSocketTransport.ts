import {Subscription} from 'rxjs/Subscription';
import {Observable} from 'rxjs/Observable';
import {Subscriber} from 'rxjs/Subscriber';
import {Subject} from 'rxjs/Subject';
import {CreateMessage} from '../Messages/CreateMessage';
import {TransportInterface} from './TransportInterface';

// This is used for WebSockets in node - removed by webpack for bundling
declare var require;
const WebSocket2 = require('ws');

export class WebSocketTransport<Message> extends Subject<any> implements TransportInterface {

    private output: Subject<any> = new Subject();
    private socket: WebSocket = null;
    private open = new Subject();
    private close = new Subject();

    constructor(private url: string = 'ws://127.0.0.1:9090/', private protocols: string | string[] = ['wamp.2.json']) {
        super();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription {

        this.output = new Subject();

        const subscription = new Subscription();

        if (!this.socket) {
            this.connectSocket();
        }

        subscription.add(this.output.subscribe(subscriber));

        subscription.add(() => {

            if (this.socket) {
                console.log('closing socket');
                this.socket.close();
                this.socket = null;
            }
        });

        return subscription;
    }

    private connectSocket(): void {
        try {
            let ws;
            if (typeof WebSocket === 'undefined') {
                ws = new WebSocket2(this.url, this.protocols);
            } else {
                ws = new WebSocket(this.url, this.protocols);
            }

            ws.onerror = (err) => {
                this.socket = null;
                this.output.error(err);
            };

            ws.onclose = (e: CloseEvent) => {
                this.socket = null;
                this.close.next(e);

                // Handle all closes as errors
                this.output.error(e);
            };

            ws.onopen = (e: Event) => {
                console.log('socket opened');
                this.socket = ws;
                this.open.next(e);
            };

            ws.onmessage = (e: MessageEvent) => {
                this.output.next(CreateMessage.fromArray(JSON.parse(e.data)));
            };

        } catch (ex) {
            this.output.error(ex);
        }
    }

    public next(msg: any): void {
        if (!this.socket) {
            return;
        }

        this.socket.send(JSON.stringify(msg.wampifiedMsg()));
    }

    public unsubscribe(): void {
        super.unsubscribe();

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

    get onOpen(): Observable<any> {
        return this.open.asObservable();
    }

    get onClose(): Observable<any> {
        return this.close.asObservable();
    }
}
