export interface IMessage {
    msgCode(): number;

    wampifiedMsg(): Array<any>;
}
