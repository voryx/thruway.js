import {TestScheduler} from "rxjs/testing";

declare const global, it;

import {clearWampMessages} from './wamp-testing';
import {expect} from 'chai';

export const xit: any = function (description, cb, timeout) {
    if (cb.length === 0) {
        it(description, function () {
            global.rxTestScheduler = new TestScheduler(assertDeepEqual);
            cb();
            global.rxTestScheduler.flush();
            clearWampMessages();
        });
    } else { // async test
        it.apply(this, arguments);
    }
};

function assertDeepEqual(actual, expected) {
    // console.log('expected: ', JSON.stringify(expected));
    // console.log('actual: ', JSON.stringify(actual));

    expect(actual).to.deep.equal(expected);
}
