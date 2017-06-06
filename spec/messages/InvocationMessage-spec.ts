import {assert} from 'chai';
import {InvocationMessage} from "../../src/Messages/InvocationMessage";

/** @test {call} */
describe('InvocationMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new InvocationMessage(1234, 5678, {})).wampifiedMsg()),
            '[68,1234,5678,{}]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new InvocationMessage(1234, 5678, {}, [], {x: 'x'})).wampifiedMsg()),
            '[68,1234,5678,{},[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new InvocationMessage(1234, 5678, {}, [1])).wampifiedMsg()),
            '[68,1234,5678,{},[1]]'
        );
    });
});
