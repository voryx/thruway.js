import {assert} from 'chai';
import {ResultMessage} from "../../src/Messages/ResultMessage";

/** @test {call} */
describe('ResultMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new ResultMessage(1234, {})).wampifiedMsg()),
            '[50,1234,{}]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new ResultMessage(1234, {}, [], {x: 'x'})).wampifiedMsg()),
            '[50,1234,{},[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new ResultMessage(1234, {}, [1])).wampifiedMsg()),
            '[50,1234,{},[1]]'
        );
    });
});
