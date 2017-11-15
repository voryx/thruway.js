import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class RegisterMessage implements IMessage, IRequestMessage {

    static MSG_REGISTER = 64;

    constructor(private _requestId: number, private _options: Object, private _procedure: string) {
    }

    public wampifiedMsg() {
        return [RegisterMessage.MSG_REGISTER, this._requestId, this._options, this._procedure];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    get procedure(): string {
        return this._procedure;
    }

    msgCode(): number {
        return RegisterMessage.MSG_REGISTER;
    }
}
