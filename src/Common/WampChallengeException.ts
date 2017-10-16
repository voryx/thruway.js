import {ChallengeMessage} from '../Messages/ChallengeMessage';
import {WampErrorException} from './WampErrorException';
import {AbortMessage} from '../Messages/AbortMessage';

export class WampChallengeException extends WampErrorException {

    constructor(private challengeMessage: ChallengeMessage, errorUri?: string) {
        super(errorUri || 'thruway.error.challenge_exception');
    }

    public abortMessage() {
        return new AbortMessage({}, this.errorUri);
    }
}
