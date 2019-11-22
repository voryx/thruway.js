import {IMessage} from './Message';

/**
 * This a not a WAMP message.  We just use this internally to notify interested subscribers when the transport has an open connection
 */
export class OpenMessage implements IMessage {

    static MSG_OPEN = 901;

    constructor(private _details: { event: Event }) {
    }

    public wampifiedMsg() {
        return [OpenMessage.MSG_OPEN, this._details];
    }

    get details(): any {
        return this._details;
    }

    msgCode(): number {
        return OpenMessage.MSG_OPEN;
    }
}
