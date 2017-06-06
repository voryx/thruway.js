import {assert} from 'chai';
import {CallMessage} from "../../src/Messages/CallMessage";

/** @test {call} */
describe('CallMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new CallMessage(1234, {}, 'some.uri')).wampifiedMsg()),
            '[48,1234,{},"some.uri"]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new CallMessage(1234, {}, 'some.uri', [], {x: 'x'})).wampifiedMsg()),
            '[48,1234,{},"some.uri",[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new CallMessage(1234, {}, 'some.uri', [1])).wampifiedMsg()),
            '[48,1234,{},"some.uri",[1]]'
        );
    });
});
