import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class CallMessage implements IMessage, IRequestMessage {

    static MSG_CALL = 48;

    constructor(private _requestId: number,
                private _options: Object,
                private _procedure: string,
                private _args: Array<any> = [],
                private _argskw: Object = {}) {
    }

    public wampifiedMsg() {
        const r = [CallMessage.MSG_CALL, this.requestId, this.options, this.procedure];
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

    get procedure(): string {
        return this._procedure;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): Object {
        return this._argskw;
    }

    msgCode(): number {
        return CallMessage.MSG_CALL;
    }
}
