declare const global: any;
import {Subject} from 'rxjs/Subject';
import {hot, expectObservable, expectSubscriptions, cold} from '../helpers/marble-testing';
import {assertWampMessages, recordWampMessage, wampMessages} from '../helpers/wamp-testing';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {ErrorMessage} from '../../src/Messages/ErrorMessage';
import {WampErrorException} from '../../src/Common/WampErrorException';
import {xit as it} from '../helpers/test-helpers';
import {RegisterObservable} from '../../src/Observable/RegisterObservable';
import {RegisteredMessage} from '../../src/Messages/RegisteredMessage';
import {RegisterMessage} from '../../src/Messages/RegisterMessage';
import {InvocationMessage} from '../../src/Messages/InvocationMessage';
import {InterruptMessage} from '../../src/Messages/InterruptMessage';
import {Observable} from 'rxjs/Observable';
import {expect} from 'chai';

function callable(first = 0, second = 0) {
    return +first + +second;
}

function callableObs(first = 0, second = 0) {
    return Observable.of(+first + +second);
}

function callableManyObs(first = 0, second = 0) {
    return Observable.from([first, second]);
}

function callableEmpty(first = 0, second = 0) {
    return Observable.empty();
}

function callableThrows(first = 0, second = 0) {
    throw new Error();
}

/** @test {register} */
describe('RegisterObservable', () => {

    it('should be never when source is never', () => {

        const messages = cold('-');
        const subscriptions = '^';
        const expected = '-';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            recordWampMessage(msg);
        });

        const register =  new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']] , // RegisterMessage
        ], wampMessages);
    });


    it('should complete when messages complete', () => {

        const messages =  hot('--|');
        const subscriptions = '^-!';
        const expected =      '--|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            recordWampMessage(msg);
        });

        const register =  new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']] , // RegisterMessage
        ], wampMessages);
    });


    it('should not yield message without invocation', () => {

        const registeredMsg = new RegisteredMessage(null, 54321);

        const messages = hot( '--w-r-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg});
        const subscriptions = '^-----!';
        const expected =      '----d-|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });


    it('should not yield message without invocation nor unregister when messages does not complete', () => {

        const registeredMsg = new RegisteredMessage(null, 54321);

        const messages = hot( '--w-r--', {w: new WelcomeMessage(12345, {}), r: registeredMsg});
        const subscriptions = '^------';
        const expected =      '----d--';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
        ], wampMessages);
    });

    it('should yield message with invocation', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [0]]], // YieldMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should yield message with invocation and not unsubscribe when never completes', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i--', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^--------';
        const expected =      '----d----';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [0]]], // YieldMessage
        ], wampMessages);
    });

    it('should yield message with no value when register callable returns empty observable', () => {

        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callableEmpty, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [null]]], // YieldMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should yield multiple message on multiple invocation', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-i-i-i-i-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-----------------!';
        const expected =      '----d-------------|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [0]]], // YieldMessage
            [80, [70, 12345, {}, [0]]], // YieldMessage
            [100, [70, 12345, {}, [0]]], // YieldMessage
            [120, [70, 12345, {}, [0]]], // YieldMessage
            [140, [70, 12345, {}, [0]]], // YieldMessage
            [160, [70, 12345, {}, [0]]], // YieldMessage
            [180, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should yield 1 with invocation of 1', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {}, [1]);

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [1]]], // YieldMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should yield 3 with invocation of 1,2', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {}, [1, 2]);

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callable, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [3]]], // YieldMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should yield 3 with invocation of 1,2 and callble returns an observable', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {}, [1, 2]);

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callableObs, messages, webSocket);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [70, 12345, {}, [3]]], // YieldMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should send error message when register callable throws', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callableThrows, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [8, 68, 44444, {}, 'thruway.error.invocation_exception']], // ErrorMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should send mulitple error messages when register callable throws multiple times', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const a = new InvocationMessage(44441, 54321, {});
        const b = new InvocationMessage(44442, 54321, {});
        const c = new InvocationMessage(44443, 54321, {});
        const d = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-a-b-c-d-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, a: a, b: b, c: c, d: d});
        const subscriptions = '^-------------!';
        const expected =      '----d---------|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callableThrows, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [8, 68, 44441, {}, 'thruway.error.invocation_exception']], // ErrorMessage
            [80, [8, 68, 44442, {}, 'thruway.error.invocation_exception']], // ErrorMessage
            [100, [8, 68, 44443, {}, 'thruway.error.invocation_exception']], // ErrorMessage
            [120, [8, 68, 44444, {}, 'thruway.error.invocation_exception']], // ErrorMessage
            [140, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should emit an error when error message is received during registration', () => {
        const errorMsg = new ErrorMessage(null, 54321, {}, 'registration.error.uri');

        const messages = hot( '--w-e-|', {w: new WelcomeMessage(12345, {}), e: errorMsg});
        const subscriptions = '^---!';
        const expected =      '----#';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                errorMsg['_errorRequestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const register = new RegisterObservable('testing.uri', callableThrows, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, null, new WampErrorException('registration.error.uri'));
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
        ], wampMessages);
    });

    it('should send error message when register callable return error observable', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const errorCallable = () => {
           return Observable.throw(new WampErrorException('my.custom.error', [1], {someKw: 'someArg'}));
        };

        const register = new RegisterObservable('testing.uri', errorCallable, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [8, 68, 44444, {}, 'my.custom.error', [1], {'someKw': 'someArg'}]], // ErrorMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should send error message when register callable throws custom error', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});

        const messages = hot( '--w-r-i-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg});
        const subscriptions = '^-------!';
        const expected =      '----d---|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const errorCallable = () => {
            throw new WampErrorException('my.custom.error', [1], {someKw: 'someArg'});
        };

        const register = new RegisterObservable('testing.uri', errorCallable, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [60, [8, 68, 44444, {}, 'my.custom.error', [1], {'someKw': 'someArg'}]], // ErrorMessage
            [80, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);
    });

    it('should send error message when invocation is interrupted', () => {
        const registeredMsg = new RegisteredMessage(null, 54321);
        const invocationMsg = new InvocationMessage(44444, 54321, {});
        const interruptMsg = new InterruptMessage(44444, {});

        const messages = hot( '--w-r-i-x-|', {w: new WelcomeMessage(12345, {}), r: registeredMsg, i: invocationMsg, x: interruptMsg});
        const subscriptions = '^---------!';
        const expected =      '----d-----|';

        const webSocket = new Subject();
        webSocket.subscribe(msg => {
            if (msg instanceof RegisterMessage) {
                registeredMsg['_requestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        let disposedInner = false;

        const neverCallable = () => {
            return Observable.never().finally(() => { disposedInner = true; });
        };

        const register = new RegisterObservable('testing.uri', neverCallable, messages, webSocket, {}, null, global.rxTestScheduler);

        expectObservable(register).toBe(expected, {d: registeredMsg});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [0, [64, 12345, {}, 'testing.uri']], // RegisterMessage
            [80, [8, 68, 44444, {}, 'wamp.error.canceled']], // ErrorMessage
            [100, [66, 12345, 54321]] // UnregisterMessage
        ], wampMessages);

        expect(disposedInner).to.be.true;
    });
});
