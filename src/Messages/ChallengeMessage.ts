import {Message} from './Message';

export class ChallengeMessage extends Message {

    constructor(private _authMethod: string, private _extra: Object) {
        super(Message.MSG_CHALLENGE);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.authMethod, this.extra];
    }

    get authMethod(): string {
        return this._authMethod;
    }

    get extra(): Object {
        return this._extra;
    }
}
