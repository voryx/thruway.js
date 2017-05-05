import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class YieldMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_YIELD);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._options, this._args, this._argskw];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): Object {
        return this._argskw;
    }
}
