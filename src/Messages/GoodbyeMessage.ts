import {IMessage} from './Message';

export class GoodbyeMessage implements IMessage {

    static MSG_GOODBYE = 6;

    constructor(private _details: Object, private _uri: string) {
    }

    public wampifiedMsg() {
        return [GoodbyeMessage.MSG_GOODBYE, this.details, this.uri];
    }

    get uri(): string {
        return this._uri;
    }

    get details(): Object {
        return this._details;
    }

    msgCode(): number {
        return GoodbyeMessage.MSG_GOODBYE;
    }
}
