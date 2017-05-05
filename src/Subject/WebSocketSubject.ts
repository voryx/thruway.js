import {Subscription} from 'rxjs/Subscription';
import {Subscriber} from 'rxjs/Subscriber';
import {Subject} from 'rxjs/Subject';
import {NextObserver} from 'rxjs/Observer';
import {CreateMessage} from '../Messages/CreateMessage';

// This is used for WebSockets in node - removed by webpack for bundling
declare var require;
const WebSocket2 = require('ws');

export class WebSocketSubject<Message> extends Subject<any> {

    private output: Subject<any> = new Subject();
    private socket: WebSocket = null;

    constructor(private url: string = 'ws://127.0.0.1:9090/',
                private protocols?: string | string[],
                private openObserver?: NextObserver<any>,
                private closeObserver?: NextObserver<any>) {
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

                if (this.closeObserver) {
                    this.closeObserver.next(e);
                }

                // Handle all closes as errors
                // if (e.wasClean) {
                //     this.output.complete();
                //     return;
                // }

                this.output.error(e);
            };

            ws.onopen = () => {
                this.socket = ws;
                if (this.openObserver) {
                    this.openObserver.next(this);
                }
            };

            ws.onmessage = (e: MessageEvent) => {
                this.output.next(CreateMessage.fromArray(JSON.parse(e.data)));
            };

        } catch (ex) {
            this.output.error(ex);
        }
    }

    // @todo figure out why the Message abstract doesn't work here
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
}
