import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnsubscribedMessage implements IMessage, IRequestMessage {

    static MSG_UNSUBSCRIBED = 35;

    constructor(private _requestId: number) {
    }

    public wampifiedMsg() {
        return [UnsubscribedMessage.MSG_UNSUBSCRIBED, this._requestId];
    }

    get requestId(): number {
        return this._requestId;
    }

    msgCode(): number {
        return UnsubscribedMessage.MSG_UNSUBSCRIBED;
    }
}
