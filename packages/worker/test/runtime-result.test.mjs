import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCodexResult} from '../src/runtime.mjs';

const message = text => ({type: 'item.completed', item: {type: 'agent_message', text}});
const completed = {type: 'turn.completed', usage: {input_tokens: 10, output_tokens: 10}};
const result = (status = 'completed') => message(JSON.stringify({status, text: 'Read-only evidence'}));
const parse = (events, code = 0) => parseCodexResult(events.map(e => JSON.stringify(e)).join('\n'), code);

test('Codex commentary and tool events do not corrupt the final structured response', () => {
    assert.deepEqual(parse([
        {type: 'thread.started', thread_id: 'fixture'},
        message('I will inspect the hostname and Git status.'),
        {type: 'item.completed', item: {type: 'command_execution', exit_code: 0, aggregated_output: 'fixture-host'}},
        result(), completed,
    ]), {status: 'completed', text: 'Read-only evidence'});
});

test('Codex never accepts an earlier valid response when the last message is invalid', () => {
    for (const text of ['ordinary final prose', '', '{"status":"completed"}', 'null']) {
        assert.equal(parse([result(), message(text), completed]).status, 'failed');
    }
});

test('Codex final response must match the exact schema', () => {
    for (const body of [
        {status: 'completed', text: 'ok', extra: true}, {status: 'unknown', text: 'ok'},
        {status: 'completed', text: 42}, {text: 'ok'}, [], null,
    ]) assert.equal(parse([message(JSON.stringify(body)), completed]).status, 'failed');
    for (const status of ['completed', 'failed', 'waiting_user']) {
        assert.equal(parse([result(status), completed]).status, status);
    }
});

test('Codex requires successful process exit and turn completion', () => {
    assert.equal(parse([result(), completed], 1).status, 'failed');
    assert.equal(parse([result(), completed], null).status, 'failed');
    assert.equal(parse([result()]).status, 'failed');
    assert.equal(parse([completed]).status, 'failed');
    assert.equal(parseCodexResult('not json\n', 0).status, 'failed');
});

test('Codex runtime failure wins over a valid structured success', () => {
    for (const failure of [
        {type: 'turn.failed', error: {message: 'Execution failed'}},
        {type: 'error', message: JSON.stringify({error: {message: 'Execution failed'}})},
    ]) {
        assert.deepEqual(parse([result(), completed, failure]), {status: 'failed', text: 'Execution failed'});
    }
});
