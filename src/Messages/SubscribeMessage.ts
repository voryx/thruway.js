import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class SubscribeMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _topicName: string) {
        super(Message.MSG_SUBSCRIBE);
    }

    public wampifiedMsg() {
        return [this.msgCode, this._requestId, this._options || {}, this._topicName];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    get topicName(): string {
        return this._topicName;
    }
}
