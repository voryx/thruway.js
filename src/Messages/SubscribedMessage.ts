import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class SubscribedMessage implements IMessage, IRequestMessage {

    static MSG_SUBSCRIBED = 33;

    constructor(private _requestId: number, private _subscriptionId: number) {
    }

    public wampifiedMsg() {
        return [SubscribedMessage.MSG_SUBSCRIBED, this._requestId, this._subscriptionId];
    }

    get requestId(): number {
        return this._requestId;
    }

    get subscriptionId(): number {
        return this._subscriptionId;
    }

    msgCode(): number {
        return SubscribedMessage.MSG_SUBSCRIBED;
    }
}
