import {Message} from './Message';

export class GoodbyeMessage extends Message {

    constructor(private _details: Object, private _uri: string) {
        super(Message.MSG_GOODBYE);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.details, this.uri];
    }

    get uri(): string {
        return this._uri;
    }

    get details(): Object {
        return this._details;
    }
}
