import {assert} from 'chai';
import {PublishMessage} from "../../src/Messages/PublishMessage";

/** @test {call} */
describe('PublishMessage', () => {
    it('should not serialize args or argskw if both are empty', () => {
        assert.equal(
            JSON.stringify((new PublishMessage(1234, {}, 'some.topic')).wampifiedMsg()),
            '[16,1234,{},"some.topic"]'
        );
    });

    it('should serialize empty args if argskw is not empty', () => {
        assert.equal(
            JSON.stringify((new PublishMessage(1234, {}, 'some.topic', [], {x: 'x'})).wampifiedMsg()),
            '[16,1234,{},"some.topic",[],{"x":"x"}]'
        );
    });

    it('should serialize non-empty args if argskw is empty', () => {
        assert.equal(
            JSON.stringify((new PublishMessage(1234, {}, 'some.topic', [1])).wampifiedMsg()),
            '[16,1234,{},"some.topic",[1]]'
        );
    });
});
