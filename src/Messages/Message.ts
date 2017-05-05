export abstract class Message {

    static MSG_UNKNOWN = 0;
    static MSG_HELLO = 1;
    static MSG_WELCOME = 2;
    static MSG_ABORT = 3;
    static MSG_CHALLENGE = 4; // advanced
    static MSG_AUTHENTICATE = 5; // advanced
    static MSG_GOODBYE = 6;
    static MSG_ERROR = 8;
    static MSG_PUBLISH = 16;
    static MSG_PUBLISHED = 17;
    static MSG_SUBSCRIBE = 32;
    static MSG_SUBSCRIBED = 33;
    static MSG_UNSUBSCRIBE = 34;
    static MSG_UNSUBSCRIBED = 35;
    static MSG_EVENT = 36;
    static MSG_CALL = 48;
    static MSG_CANCEL = 49; // advanced
    static MSG_RESULT = 50;
    static MSG_REGISTER = 64;
    static MSG_REGISTERED = 65;
    static MSG_UNREGISTER = 66;
    static MSG_UNREGISTERED = 67;
    static MSG_INVOCATION = 68;
    static MSG_INTERRUPT = 69; // advanced
    static MSG_YIELD = 70;

    constructor(private _msgCode: number) {
    }

    abstract wampifiedMsg();

    get msgCode(): number {
        return this._msgCode;
    }
}
