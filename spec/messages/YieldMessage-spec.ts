import {assert} from 'chai';
import {YieldMessage} from "../../src/Messages/YieldMessage";

/** @test {call} */
describe('YieldMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new YieldMessage(1234, {})).wampifiedMsg()),
            '[70,1234,{}]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new YieldMessage(1234, {}, [], {x: 'x'})).wampifiedMsg()),
            '[70,1234,{},[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new YieldMessage(1234, {}, [1])).wampifiedMsg()),
            '[70,1234,{},[1]]'
        );
    });
});
