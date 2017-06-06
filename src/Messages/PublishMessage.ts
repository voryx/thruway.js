import {Message} from './Message';
import {IRequestMessage} from './IRequestMessage';

export class PublishMessage extends Message implements IRequestMessage {

    constructor(private _requestId: number, private _options: Object, private _topic: string, private _args: Array<any> = [], private _argskw: Object = {}) {
        super(Message.MSG_PUBLISH);
    }

    public wampifiedMsg() {
        const r = [this.msgCode, this.requestId, this.options || {}, this.topic];
        if (Object.keys(this._argskw).length !== 0) {
            r.push(this._args, this._argskw);
            return r;
        }
        if (this._args.length !== 0) {
            r.push(this._args);
        }
        return r;
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
