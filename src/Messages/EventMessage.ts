import {Message} from './Message';

export class EventMessage extends Message {

    constructor(private _subscriptionId: number, private _publicationId: number, private _details: Object, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_EVENT);
    }

    public wampifiedMsg() {
        const r = [this.msgCode, this._subscriptionId, this._publicationId, this._details];
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
}
