import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class CancelMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object) {
        super(Message.MSG_CANCEL);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._options];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }
}
