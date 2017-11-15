import {IMessage} from './Message';

export class AbortMessage implements IMessage {

    static MSG_ABORT = 3;

    constructor(private _details: Object = {}, private _reason: string) {
    }

    public wampifiedMsg() {
        return [AbortMessage.MSG_ABORT, this.details, this.reason];
    }

    get reason(): string {
        return this._reason;
    }

    get details(): any {
        return this._details;
    }

    msgCode(): number {
        return AbortMessage.MSG_ABORT;
    }
}
