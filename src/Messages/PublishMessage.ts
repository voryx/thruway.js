import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class PublishMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _topic: string, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_PUBLISH);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.requestId, this.options || {}, this.topic, this.args, this.argskw];
    }

    get requestId(): number {
        return this._requestId;
    }

    get options(): Object {
        return this._options;
    }

    get topic(): string {
        return this._topic;
    }

    get args(): Array<any> {
        return this._args;
    }

    get argskw(): Object {
        return this._argskw;
    }
}
