import {assert} from 'chai';
import {EventMessage} from "../../src/Messages/EventMessage";

/** @test {call} */
describe('EventMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new EventMessage(1234, 5678, {})).wampifiedMsg()),
            '[36,1234,5678,{}]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new EventMessage(1234, 5678, {}, [], {x: 'x'})).wampifiedMsg()),
            '[36,1234,5678,{},[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new EventMessage(1234, 5678, {}, [1])).wampifiedMsg()),
            '[36,1234,5678,{},[1]]'
        );
    });
});
