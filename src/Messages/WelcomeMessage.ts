import {Message} from './Message';

export class WelcomeMessage extends Message {

    constructor(private _sessionId: string, private _details: any) {
        super(Message.MSG_WELCOME);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._sessionId, this._details];
    }

    get sessionId(): string {
        return this._sessionId;
    }

    get details(): any {
        return this._details;
    }
}
