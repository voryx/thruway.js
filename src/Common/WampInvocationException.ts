import {WampErrorException} from './WampErrorException';
import {InvocationMessage} from '../Messages/InvocationMessage';
import {ErrorMessage} from '../Messages/ErrorMessage';

export class WampInvocationException extends WampErrorException {

    public static withInvocationMessageAndWampErrorException(invocationMessage: InvocationMessage, wee: WampErrorException): WampInvocationException {
        return new WampInvocationException(
            invocationMessage,
            wee.errorUri,
            wee.args,
            wee.argskw,
            wee.details
        );
    }

    constructor(private invocationMessage: InvocationMessage, errorUri?: string, args: Array<any> = [], argskw: Object = {}, details: Object = {}) {
        super(errorUri || 'thruway.error.invocation_exception', args, argskw, details);
    }

    public errorMessage = () => {
        const errorMessage = ErrorMessage.createErrorMessageFromMessage(this.invocationMessage, this.errorUri);

        errorMessage.args = this.args;
        errorMessage.argskw = this.argskw;
        errorMessage.details = this.details;

        return errorMessage;
    };
}
