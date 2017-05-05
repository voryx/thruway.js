import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class CallMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _procedure: string, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_CALL);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.requestId, this.options, this.procedure, this.args , this.argskw];
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

    get msgCode(): number {
        return Message.MSG_CALL;
    }
}
