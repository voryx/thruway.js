import {assert} from 'chai';
import {ErrorMessage} from "../../src/Messages/ErrorMessage";

/** @test {call} */
describe('ErrorMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new ErrorMessage(48, 1234, {}, 'some.uri')).wampifiedMsg()),
            '[8,48,1234,{},"some.uri"]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new ErrorMessage(48, 1234, {}, 'some.uri', [], {x: 'x'})).wampifiedMsg()),
            '[8,48,1234,{},"some.uri",[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new ErrorMessage(48, 1234, {}, 'some.uri', [1])).wampifiedMsg()),
            '[8,48,1234,{},"some.uri",[1]]'
        );
    });
});
