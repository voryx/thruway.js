import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class ResultMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _details: Object, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_RESULT);
    }

    public wampifiedMsg() {
        const r = [this.msgCode, this._requestId, this._details];
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

    get details(): Object|any {
        return this._details;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): {} {
        return this._argskw;
    }
}
