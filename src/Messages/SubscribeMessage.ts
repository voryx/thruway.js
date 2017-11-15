import {IMessage} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class SubscribeMessage implements IMessage, IRequestMessage {

    static MSG_SUBSCRIBE = 32;

    constructor(private _requestId: number, private _options: Object, private _topicName: string) {
    }

    public wampifiedMsg() {
        return [SubscribeMessage.MSG_SUBSCRIBE, this._requestId, this._options || {}, this._topicName];
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

    msgCode(): number {
        return SubscribeMessage.MSG_SUBSCRIBE;
    }
}
