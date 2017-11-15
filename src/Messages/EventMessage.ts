import {IMessage} from './Message';

export class EventMessage implements IMessage {

    static MSG_EVENT = 36;

    constructor(private _subscriptionId: number,
                private _publicationId: number,
                private _details: Object,
                private _args: Array<any> = [],
                private _argskw: Object = {}) {
    }

    public wampifiedMsg() {
        const r = [EventMessage.MSG_EVENT, this._subscriptionId, this._publicationId, this._details];
        if (Object.keys(this._argskw).length !== 0) {
            r.push(this._args, this._argskw);
            return r;
        }
        if (this._args.length !== 0) {
            r.push(this._args);
        }
        return r;
    }

    get subscriptionId(): number {
        return this._subscriptionId;
    }

    get publicationId(): number {
        return this._publicationId;
    }

    get details(): Object {
        return this._details;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): Object {
        return this._argskw;
    }

    msgCode(): number {
        return EventMessage.MSG_EVENT;
    }
}
