import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class ResultMessage implements IMessage, IRequestMessage {

    static MSG_RESULT = 50;

    constructor(private _requestId: number,
                private _details: Object,
                private _args?: Array<any>,
                private _argskw?: Object) {
    }

    public wampifiedMsg() {
        const r = [ResultMessage.MSG_RESULT, this._requestId, this._details];
        if (this._argskw && Object.keys(this._argskw).length !== 0) {
            r.push(this._args, this._argskw);
            return r;
        }
        if (this._args && this._args.length !== 0) {
            r.push(this._args);
        }
        return r;
    }

    get requestId(): number {
        return this._requestId;
    }

    get details(): Object | any {
        return this._details;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): {} {
        return this._argskw;
    }

    msgCode(): number {
        return ResultMessage.MSG_RESULT;
    }
}
