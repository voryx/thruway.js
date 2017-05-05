declare const global: any;
import {assert} from 'chai';

export let wampMessages = [];

export function recordWampMessage(msg) {

    if (msg.hasOwnProperty('_requestId')) {
        msg['_requestId'] = 12345;
    }
    wampMessages.push([global.rxTestScheduler.now(), msg.wampifiedMsg()]);
}

export function assertWampMessages(expected: Array<any>, recorded: Array<any>) {
    global.rxTestScheduler.flush();
    clearWampMessages();

    if (expected.length !== recorded.length) {
        // console.log('expected', JSON.stringify(expected));
        // console.log('recorded', JSON.stringify(recorded));
        assert.fail(recorded.length, expected.length, 'Expected WAMP message count ' + expected.length + ' does not match actual count ' + recorded.length);
    }

    for (let i = 0, count = expected.length; i < count; i++) {
        if (JSON.stringify(expected[i]) !== JSON.stringify(recorded[i])) {
            assert.fail(expected[i], recorded[i], JSON.stringify(recorded[i]) + ' does not equal expected ' + JSON.stringify(expected[i]));
        }
    }

    assert.equal(true, true); // success
}

export function clearWampMessages() {
    wampMessages = [];
}

