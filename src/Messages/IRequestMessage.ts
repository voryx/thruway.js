import {IMessage} from './Message';

export interface IRequestMessage extends IMessage {
    requestId: number;
}
