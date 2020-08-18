import {Subject} from 'rxjs/Subject';
import {hot, expectObservable, expectSubscriptions, cold} from '../helpers/marble-testing';
import {assertWampMessages, recordWampMessage, wampMessages} from '../helpers/wamp-testing';
import {CallMessage} from '../../src/Messages/CallMessage';
import {ResultMessage} from '../../src/Messages/ResultMessage';
import {WelcomeMessage} from '../../src/Messages/WelcomeMessage';
import {ErrorMessage} from '../../src/Messages/ErrorMessage';
import {WampErrorException} from '../../src/Common/WampErrorException';
import {xit as it} from '../helpers/test-helpers';
import {Subscriber} from 'rxjs/Subscriber';
import {Client} from '../../src/Client';
import {GoodbyeMessage} from '../../src/Messages/GoodbyeMessage';
import {AbortMessage} from '../../src/Messages/AbortMessage';

/** @test {client} */
describe('Client', () => {

    it('call should be never when source is never', () => {

        const messages = cold('-');
        const subscriptions = '^';
        const expected = '-';

        const observer = new Subscriber((msg: any) => {
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([], wampMessages);
    });

    it('call should never complete when messages are empty before Welcome', () => {

        const messages = hot('--|');
        const subscriptions = '^-!';
        const expected = '--';

        const observer = new Subscriber((msg: any) => {
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('call should dispose of messages after non-progressive result', () => {
        const resultMessage = new ResultMessage(null, {}, [], {});

        const messages = hot('--w--r------|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^----!';
        const expected = '-----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('call should emit empty args when result message args is empty', () => {
        const resultMessage = new ResultMessage(null, {}, [], {});

        const messages = hot('--w--r|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^----!';
        const expected = '-----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('call should emit args when result message args has value', () => {
        const resultMessage = new ResultMessage(null, {}, ['testing'], {});

        const messages = hot('--w-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^---!';
        const expected = '----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });


    it('call should emit args and argkw when result message args and argskw have values', () => {
        const resultMessage = new ResultMessage(null, {}, ['testing'], {foo: 'bar'});

        const messages = hot('--w-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^---!';
        const expected = '----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });


    it('call should emit args, argkw and details when result message has args, argskw and details', () => {
        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('--w-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^---!';
        const expected = '----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('call should emit once when reconnected', () => {
        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('--w-r-w-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^---!';
        const expected = '----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('call should not? emit error when error is emitted before welcome', () => {
        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('-#w-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage}, new Error());
        const subscriptions = '^!';
        const expected = '^';

        const observer = new Subscriber((msg: any) => {
            recordWampMessage(msg);
            if (msg instanceof CallMessage) {
                resultMessage['_requestId'] = msg.requestId;
            }
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([], wampMessages);
    });

    it('call should not emit error when error is emitted after welcome', () => {

        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('-w#-r|', {w: new WelcomeMessage(12345, {}), r: resultMessage}, new Error());
        const subscriptions = '^-!';
        const expected = '--';

        const observer = new Subscriber((msg: any) => {
            recordWampMessage(msg);
            if (msg instanceof CallMessage) {
                resultMessage['_requestId'] = msg.requestId;
            }
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri2');

        expectObservable(call).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [10, [48, 12345, {}, 'testing.uri2']], // CallMessage
        ], wampMessages);
    });

    it('call should emit error when error message is received', () => {

        const errorMessage = new ErrorMessage(123, null, {}, 'some.server.error');

        const messages = hot('--w-e|', {w: new WelcomeMessage(12345, {}), e: errorMessage});
        const subscriptions = '^---!';
        const expected = '----#';

        const observer = new Subscriber((msg: any) => {
            if (msg instanceof CallMessage) {
                errorMessage['_errorRequestId'] = msg.requestId;
            }
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call).toBe(expected, null, new WampErrorException('some.server.error', [{uri: 'testing.uri'}]));
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [20, [48, 12345, {}, 'testing.uri']], // CallMessage
        ], wampMessages);
    });

    it('call should not emit if disposed before result', () => {
        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('--w---r|', {w: new WelcomeMessage(12345, {}), e: resultMessage});
        const subscriptions = '^---!';
        const unsubscribe = '----!';
        const expected = '';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri1');

        expectObservable(call, unsubscribe).toBe(expected);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [20, [48, 12345, {}, 'testing.uri1']], // CallMessage
            [40, [49, 12345, {}]] // CancelMessage
        ], wampMessages);
    });

    it('call should emit if disposed after result', () => {
        const resultMessage = new ResultMessage(null, {detail: 'thing'}, ['testing'], {foo: 'bar'});

        const messages = hot('--w-r---|', {w: new WelcomeMessage(12345, {}), r: resultMessage});
        const subscriptions = '^---!';
        const unsubscribe = '------!';
        const expected = '----(d|)';

        const observer = new Subscriber((msg: any) => {
            resultMessage['_requestId'] = msg.requestId;
            recordWampMessage(msg);
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.call('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {d: resultMessage});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);

        assertWampMessages([
            [20, [48, 12345, {}, 'testing.uri']], // CallMessage
        ], wampMessages);
    });

    it('progressiveCall should emit multiple', () => {
        const w = new WelcomeMessage(12345, {});
        const r1 = new ResultMessage(null, {progress: true}, ['testing1'], {});
        const r2 = new ResultMessage(null, {progress: true}, ['testing2'], {});
        const r3 = new ResultMessage(null, {progress: true}, ['testing3'], {});
        const r4 = new ResultMessage(null, {});

        const messages = hot('--w-abcd|', {w: w, a: r1, b: r2, c: r3, d: r4});
        const subscriptions =        '^------!';
        const unsubscribe =          '--------!';
        const expected =             '----abc|';

        const observer = new Subscriber((msg: any) => {
            r1['_requestId'] = msg.requestId;
            r2['_requestId'] = msg.requestId;
            r3['_requestId'] = msg.requestId;
            r4['_requestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.progressiveCall('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {a: r1, b: r2, c: r3});
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('progressiveCall should be able to emit error after values', () => {
        const w = new WelcomeMessage(12345, {});
        const r1 = new ResultMessage(null, {progress: true}, ['testing1'], {});
        const r2 = new ResultMessage(null, {progress: true}, ['testing2'], {});
        const r3 = new ResultMessage(null, {progress: true}, ['testing3'], {});
        const e = new ErrorMessage(123, null, {}, 'some.server.error');
        const r4 = new ResultMessage(null, {});

        const messages = hot('--w-abced|', {w: w, a: r1, b: r2, c: r3, d: r4, e});
        const subscriptions =        '^------!';
        const unsubscribe =          '--------!';
        const expected =             '----abc#';

        const observer = new Subscriber((msg: any) => {
            r1['_requestId'] = msg.requestId;
            r2['_requestId'] = msg.requestId;
            r3['_requestId'] = msg.requestId;
            r4['_requestId'] = msg.requestId;
            e['_errorRequestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.progressiveCall('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {a: r1, b: r2, c: r3}, new WampErrorException('some.server.error', [{uri: 'testing.uri'}]));
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('progressiveCall should error when transport errors', () => {
        const error = new Error('Transport Error');
        const w = new WelcomeMessage(12345, {});
        const r1 = new ResultMessage(null, {progress: true}, ['testing1'], {});
        const r2 = new ResultMessage(null, {progress: true}, ['testing2'], {});
        const r3 = new ResultMessage(null, {progress: true}, ['testing3'], {});
        const messages = hot('--w-abc-#', {w, a: r1, b: r2, c: r3}, error);
        const subscriptions =        '^-------!';
        const unsubscribe =          '---------!';
        const expected =             '----abc-#';
        const observer = new Subscriber((msg: any) => {
            r1['_requestId'] = msg.requestId;
            r2['_requestId'] = msg.requestId;
            r3['_requestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.progressiveCall('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {w, a: r1, b: r2, c: r3}, error);
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('progressiveCall should error on GoodbyeMessage', () => {
        const w = new WelcomeMessage(12345, {});
        const r1 = new ResultMessage(null, {progress: true}, ['testing1'], {});
        const r2 = new ResultMessage(null, {progress: true}, ['testing2'], {});
        const r3 = new ResultMessage(null, {progress: true}, ['testing3'], {});
        const g = new GoodbyeMessage({}, 'goodbye');
        const messages = hot('--w-abc-g', {w, a: r1, b: r2, c: r3, g});
        const subscriptions =        '^-------!';
        const unsubscribe =          '---------!';
        const expected =             '----abc-#';
        const observer = new Subscriber((msg: any) => {
            r1['_requestId'] = msg.requestId;
            r2['_requestId'] = msg.requestId;
            r3['_requestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.progressiveCall('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {w, a: r1, b: r2, c: r3}, new Error('Connection Closed'));
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

    it('progressiveCall should error on AbortMessage', () => {
        const w = new WelcomeMessage(12345, {});
        const r1 = new ResultMessage(null, {progress: true}, ['testing1'], {});
        const r2 = new ResultMessage(null, {progress: true}, ['testing2'], {});
        const r3 = new ResultMessage(null, {progress: true}, ['testing3'], {});
        const e = new AbortMessage({}, 'abort');
        const messages = hot('-ew-abc', {w, a: r1, b: r2, c: r3, e});
        const subscriptions =        '^!';
        const unsubscribe =          '---!';
        const expected =             '-#';
        const observer = new Subscriber((msg: any) => {
            r1['_requestId'] = msg.requestId;
            r2['_requestId'] = msg.requestId;
            r3['_requestId'] = msg.requestId;
        });

        const ws = Subject.create(observer, messages);

        const client = new Client(ws, 'realm1', {retryOptions: {maxRetries: 1}});
        const call = client.progressiveCall('testing.uri');

        expectObservable(call, unsubscribe).toBe(expected, {w, a: r1, b: r2, c: r3}, new Error('Connection Closed'));
        expectSubscriptions(messages.subscriptions).toBe(subscriptions);
    });

});
