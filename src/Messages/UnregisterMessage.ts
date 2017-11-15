import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnregisterMessage implements IMessage, IRequestMessage {

    static MSG_UNREGISTER = 66;

    constructor(private _requestId: number, private _registrationId: number) {
    }

    public wampifiedMsg() {
        return [UnregisterMessage.MSG_UNREGISTER, this._requestId, this._registrationId];
    }

    get requestId(): number {
        return this._requestId;
    }

    get registrationId(): number {
        return this._registrationId;
    }

    msgCode(): number {
        return UnregisterMessage.MSG_UNREGISTER;
    }
}
