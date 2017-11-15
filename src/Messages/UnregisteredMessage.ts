import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnregisteredMessage implements IMessage, IRequestMessage {

    static MSG_UNREGISTERED = 67;

    constructor(private _requestId: number) {
    }

    public wampifiedMsg() {
        return [UnregisteredMessage.MSG_UNREGISTERED, this._requestId];
    }

    get requestId(): number {
        return this._requestId;
    }

    msgCode(): number {
        return UnregisteredMessage.MSG_UNREGISTERED;
    }
}
