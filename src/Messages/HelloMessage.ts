import {IMessage} from './Message';

export class HelloMessage implements IMessage {

    static MSG_HELLO = 1;

    constructor(private realm: string, private details: any) {
    }

    public wampifiedMsg() {
        return [HelloMessage.MSG_HELLO, this.realm, this.details];
    }

    msgCode(): number {
        return HelloMessage.MSG_HELLO;
    }
}
