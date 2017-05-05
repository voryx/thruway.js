import {Message} from './Message';

export class HelloMessage extends Message {

    constructor(private realm: string, private details: any) {
        super(Message.MSG_HELLO);
    }

    public wampifiedMsg() {
        return [this.msgCode, this.realm, this.details];
    }
}
