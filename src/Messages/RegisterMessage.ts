import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class RegisterMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _procedure: string) {
        super(Message.MSG_REGISTER);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._options, this._procedure];
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
}
