import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class YieldMessage implements IMessage, IRequestMessage {

    static MSG_YIELD = 70;

    constructor(private _requestId: number,
                private _options: Object,
                private _args: Array<any> = [],
                private _argskw: Object = {}) {
    }

    public wampifiedMsg(): any[] {
        const r = [YieldMessage.MSG_YIELD, this._requestId, this._options];
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

    get options(): Object {
        return this._options;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): Object {
        return this._argskw;
    }

    msgCode(): number {
        return YieldMessage.MSG_YIELD;
    }
}
