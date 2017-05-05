import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnsubscribedMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number) {
        super(Message.MSG_UNREGISTERED);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId];
    }

    get requestId(): number {
        return this._requestId;
    }
}
