import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class RegisteredMessage implements IMessage, IRequestMessage {

    static MSG_REGISTERED = 65;

    constructor(private _requestId: number, private _registrationId: number) {
    }

    public wampifiedMsg() {
        return [RegisteredMessage.MSG_REGISTERED, this._requestId, this._registrationId];
    }

    get requestId(): number {
        return this._requestId;
    }

    get registrationId(): number {
        return this._registrationId;
    }

    msgCode(): number {
        return RegisteredMessage.MSG_REGISTERED;
    }
}
