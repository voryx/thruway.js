import {Message} from './Message';

export class AuthenticateMessage extends Message {

    constructor(private _signature: string, private _extra?: Object) {
        super(Message.MSG_AUTHENTICATE);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.signature, this.extra];
    }

    get signature(): string {
        return this._signature;
    }

    get extra(): Object {
        return this._extra;
    }
}
