export class WampErrorException{

    public message;
    public name = 'WAMP Error';

    constructor(public errorUri: string, public args: Array<any> = [], public argskw: Object = {}, public details: Object = {}) {
        this.message = errorUri;
    }
}
