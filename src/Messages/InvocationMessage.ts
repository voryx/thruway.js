import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class InvocationMessage implements IMessage, IRequestMessage {

    static MSG_INVOCATION = 68;

    constructor(private _requestId: number,
                private _registrationId: number,
                private _details: Object,
                private _args: Array<any> = [],
                private _argskw: Object = {}) {
    }

    public wampifiedMsg() {
        const r = [InvocationMessage.MSG_INVOCATION, this._requestId, this._registrationId, this._details];
        if (Object.keys(this._argskw).length !== 0) {
            r.push(this._args, this._argskw);
            return r;
        }
        if (this._args.length !== 0) {
            r.push(this._args);
        }
        return r;
    }

    get requestId(): number {
        return this._requestId;
    }

    get registrationId(): number {
        return this._registrationId;
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
        return InvocationMessage.MSG_INVOCATION;
    }
}
