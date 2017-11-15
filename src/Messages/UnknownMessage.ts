import {IMessage} from './Message';

export class UnknownMessage implements IMessage {

    static MSG_UNKNOWN = 0;

    wampifiedMsg(): Array<any> {
        return undefined;
    }

    msgCode(): number {
        return UnknownMessage.MSG_UNKNOWN;
    }
}
