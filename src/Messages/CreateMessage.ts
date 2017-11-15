import {AbortMessage} from './AbortMessage';
import {GoodbyeMessage} from './GoodbyeMessage';
import {UnregisteredMessage} from './UnregisteredMessage';
import {WelcomeMessage} from './WelcomeMessage';
import {SubscribedMessage} from './SubscribedMessage';
import {UnsubscribedMessage} from './UnsubscribedMessage';
import {EventMessage} from './EventMessage';
import {RegisteredMessage} from './RegisteredMessage';
import {InvocationMessage} from './InvocationMessage';
import {ResultMessage} from './ResultMessage';
import {ChallengeMessage} from './ChallengeMessage';
import {ErrorMessage} from './ErrorMessage';
import {IMessage} from './Message';
import {InterruptMessage} from './InterruptMessage';

export abstract class CreateMessage {

    public static fromArray(data: Array<any>): IMessage {
        switch (data[0]) {
            case AbortMessage.MSG_ABORT:
                return new AbortMessage(data[1], data[2]);
            case GoodbyeMessage.MSG_GOODBYE:
                return new GoodbyeMessage(data[1], data[2]);
            case UnregisteredMessage.MSG_UNREGISTERED:
                return new UnregisteredMessage(data[1]);
            case WelcomeMessage.MSG_WELCOME:
                return new WelcomeMessage(data[1], data[2]);
            case SubscribedMessage.MSG_SUBSCRIBED:
                return new SubscribedMessage(data[1], data[2]);
            case UnsubscribedMessage.MSG_UNSUBSCRIBED:
                return new UnsubscribedMessage(data[1]);
            case EventMessage.MSG_EVENT:
                return new EventMessage(data[1], data[2], data[3], data[4] || [], data[5] || {});
            case RegisteredMessage.MSG_REGISTERED:
                return new RegisteredMessage(data[1], data[2]);
            case InvocationMessage.MSG_INVOCATION:
                return new InvocationMessage(data[1], data[2], data[3], data[4] || [], data[5] || {});
            case ResultMessage.MSG_RESULT:
                return new ResultMessage(data[1], data[2], data[3] || [], data[4] || {});
            case ChallengeMessage.MSG_CHALLENGE:
                return new ChallengeMessage(data[1], data[2]);
            case ErrorMessage.MSG_ERROR:
                return new ErrorMessage(data[1], data[2], data[3], data[4], data[5] || [], data[6] || {});
            case InterruptMessage.MSG_INTERRUPT:
                return new InterruptMessage(data[1], data[2]);
            // default:
            //     throw new MessageException("Unhandled message type: " . data[0]);
        }
    }
}
