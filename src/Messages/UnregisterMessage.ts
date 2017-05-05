import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class UnregisterMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _registrationId: number) {
        super(Message.MSG_UNREGISTER);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._registrationId];
    }

    get requestId(): number {
        return this._requestId;
    }

    get registrationId(): number {
        return this._registrationId;
    }
}
