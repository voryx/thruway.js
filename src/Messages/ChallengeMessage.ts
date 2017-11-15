import {IMessage} from './Message';

export class ChallengeMessage implements IMessage {

    static MSG_CHALLENGE = 4;

    constructor(private _authMethod: string, private _extra: Object) {
    }

    public wampifiedMsg() {
        return [ChallengeMessage.MSG_CHALLENGE, this.authMethod, this.extra];
    }

    get authMethod(): string {
        return this._authMethod;
    }

    get extra(): Object {
        return this._extra;
    }

    msgCode() {
        return ChallengeMessage.MSG_CHALLENGE;
    }
}
