import {IMessage} from './Message';

export class AuthenticateMessage implements IMessage {

    static MSG_AUTHENTICATE = 5;

    constructor(private _signature: string, private _extra?: Object) {
    }

    public wampifiedMsg() {
        return [AuthenticateMessage.MSG_AUTHENTICATE, this.signature, this.extra || {}];
    }

    get signature(): string {
        return this._signature;
    }

    get extra(): Object {
        return this._extra;
    }

    msgCode(): number {
        return AuthenticateMessage.MSG_AUTHENTICATE;
    }
}
