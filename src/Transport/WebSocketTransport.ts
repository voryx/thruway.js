import {CreateMessage} from '../Messages/CreateMessage';
import {TransportInterface} from './TransportInterface';
import {fromEvent, Observable, of, Subject, Subscriber, Subscription, timer} from "rxjs";
import {catchError, delay, startWith, switchMapTo, takeUntil, tap} from "rxjs/operators";
import WS = require('ws');

// This is used for WebSockets in node - removed by webpack for bundling
declare var require: any;
const WebSocket2 = require('ws');

export class WebSocketTransport<Message> extends Subject<any> implements TransportInterface {

    private output: Subject<any> = new Subject();
    private socket: WebSocket = null;
    private openSubject = new Subject();
    private closeSubject = new Subject();
    private resetKeepaliveSubject = new Subject();
    private keepAliveTimer = 30000;

    constructor(private url: string = 'ws://127.0.0.1:8080/ws', private protocols: string | string[] = ['wamp.2.json'], private autoOpen: boolean = true) {
        super();
    }

    get onOpen(): Observable<any> {
        return this.openSubject.asObservable();
    }

    get onClose(): Observable<any> {
        return this.closeSubject.asObservable();
    }

    public _subscribe(subscriber: Subscriber<any>): Subscription {

        this.output = new Subject();

        const subscription = new Subscription();

        if (this.autoOpen) {
            this.connectSocket();
        }

        subscription.add(this.output.subscribe(subscriber));

        subscription.add(() => {
            setTimeout(() => {
                if (this.socket) {
                    console.log('closing socket');
                    this.socket.close();
                    this.socket = null;
                }
            }, 100);
        });

        return subscription;
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

    public open() {
        this.connectSocket();
        this.autoOpen = true;
    }

    private connectSocket(): void {
        if (this.socket) {
            return;
        }

        try {
            let ws: any;
            if (typeof WebSocket === 'undefined') {
                ws = new WebSocket2(this.url, this.protocols);
                this.keepAlive(ws);
            } else {
                ws = new WebSocket(this.url, this.protocols);
            }

            ws.onerror = (err: Error) => {
                this.resetKeepaliveSubject.next(0);
                this.socket = null;
                this.output.error(err);
            };

            ws.onclose = (e: CloseEvent) => {
                this.resetKeepaliveSubject.next(0);
                this.socket = null;
                this.closeSubject.next(e);

                // Handle all closes as errors
                const ex = new Error(e.reason || 'The WebSocket connection was closed');
                this.output.error(ex);
            };

            ws.onopen = (e: Event) => {
                console.log('socket opened');
                this.socket = ws;
                this.openSubject.next(e);
            };

            ws.onmessage = (e: MessageEvent) => {
                this.output.next(CreateMessage.fromArray(JSON.parse(e.data)));
            };

        } catch (ex) {
            this.output.error(ex);
        }
    }

    private keepAlive(ws: WS) {

        this.resetKeepaliveSubject.next(0);

        fromEvent(ws, 'pong').pipe(
            startWith(0)
            , switchMapTo(timer(this.keepAliveTimer).pipe(
                tap(() => ws.ping())
                , delay(20000)
                )
            )
            , takeUntil(this.resetKeepaliveSubject),
            catchError((e: any) => {
                console.log(e.message);
                return of();
            }))
            .subscribe(() => {
                console.log('Terminating because we have not received a pong back from the server');
                ws.terminate()
            });
    }
}
