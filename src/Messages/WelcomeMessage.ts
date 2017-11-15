import {IMessage} from './Message';

export class WelcomeMessage implements IMessage {

    static MSG_WELCOME = 2;

    constructor(private _sessionId: string, private _details: any) {
    }

    public wampifiedMsg() {
        return [WelcomeMessage.MSG_WELCOME, this._sessionId, this._details];
    }

    get sessionId(): string {
        return this._sessionId;
    }

    get details(): any {
        return this._details;
    }

    msgCode(): number {
        return WelcomeMessage.MSG_WELCOME;
    }
}
