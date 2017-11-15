import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class CancelMessage implements IMessage, IRequestMessage {

    static MSG_CANCEL = 49;

    constructor(private _requestId: number, private _options: Object) {
    }

    public wampifiedMsg() {
        return [CancelMessage.MSG_CANCEL, this._requestId, this._options];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    msgCode(): number {
        return CancelMessage.MSG_CANCEL;
    }
}
