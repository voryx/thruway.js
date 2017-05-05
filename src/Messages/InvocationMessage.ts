import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class InvocationMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _registrationId: number, private _details: Object, private _args?: Array<any>, private _argskw?: Object) {
        super(Message.MSG_INVOCATION);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._registrationId, this._details, this._args, this._argskw];
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
}
