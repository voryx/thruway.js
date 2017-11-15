import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnsubscribeMessage implements IMessage, IRequestMessage {

    static MSG_UNSUBSCRIBE = 34;

    constructor(private _requestId: number, private _subscriptionId: number) {
    }

    public wampifiedMsg() {
        return [UnsubscribeMessage.MSG_UNSUBSCRIBE, this._requestId, this._subscriptionId];
    }

    get requestId(): number {
        return this._requestId;
    }

    get subscriptionId(): number {
        return this._subscriptionId;
    }

    msgCode(): number {
        return UnsubscribeMessage.MSG_UNSUBSCRIBE;
    }
}
