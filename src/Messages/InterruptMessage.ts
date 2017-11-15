import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class InterruptMessage implements IMessage, IRequestMessage {

    static MSG_INTERRUPT = 69;

    constructor(private _requestId: number, private _options: Object) {
    }

    public wampifiedMsg() {
        return [InterruptMessage.MSG_INTERRUPT, this._requestId, this._options];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    msgCode(): number {
        return InterruptMessage.MSG_INTERRUPT;
    }
}
