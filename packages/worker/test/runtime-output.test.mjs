import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runRuntime, validateProfile} from '../src/runtime.mjs';

const profile = adapter => ({adapter, executable: process.execPath, cwd: process.cwd(), allowedSenders: ['local']});
const codexOutput = text => [
    {type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({status: 'completed', text})}},
    {type: 'turn.completed'},
].map(event => JSON.stringify(event) + '\n').join('');
const claudeOutput = text => JSON.stringify({structured_output: {status: 'completed', text}});

async function simulate(t, p, chunks) {
    const mock = t.mock.method(childProcess, 'spawn', (_exe, _args, options) => {
        assert.equal(options.shell, false);
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdin.resume();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        // No OS process/PID is created. Exercise the actual collection, stop,
        // completion, and parsing paths with controlled pipe chunk boundaries.
        queueMicrotask(() => {
            child.emit('spawn');
            for (const [stream, data] of chunks) child[stream].write(data);
            child.emit('exit', 0);
        });
        return child;
    });
    syncBuiltinESMExports();
    try { return await runRuntime(p, 'read-only test'); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

for (const adapter of ['codex', 'claude']) {
    const output = adapter === 'codex' ? codexOutput : claudeOutput;
    test(`${adapter}: progress over 32k with a small final result succeeds`, async t => {
        const commentary = JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'progress'.repeat(5000)}}) + '\n';
        const tools = JSON.stringify({type: 'item.completed', item: {type: 'command_execution', aggregated_output: 'tool'.repeat(10000)}}) + '\n';
        const chunks = adapter === 'codex'
            ? [['stdout', commentary], ['stdout', tools]]
            : [['stderr', 'progress'.repeat(10000)]];
        assert.deepEqual(await simulate(t, {...profile(adapter), maxOutputBytes: 16}, [...chunks, ['stdout', output('OK')]]), {status: 'completed', text: 'OK'});
    });
    test(`${adapter}: combined stdout/stderr transcript budget stops execution`, async t => {
        const result = await simulate(t, {...profile(adapter), maxTranscriptBytes: 1000}, [['stdout', 'a'.repeat(500)], ['stderr', 'b'.repeat(501)], ['stdout', output('OK')]]);
        assert.equal(result.status, 'interrupted');
        assert.match(result.text, /Transcript limit exceeded/);
    });
    test(`${adapter}: oversized UTF-8 final result is rejected, never truncated as completed`, async t => {
        const result = await simulate(t, {...profile(adapter), maxOutputBytes: 100}, [['stdout', output('é'.repeat(51))]]);
        assert.deepEqual(result, {status: 'failed', text: 'Final result limit exceeded'});
    });
    test(`${adapter}: UTF-8 split across pipe chunks preserves final result at byte limit`, async t => {
        const bytes = Buffer.from(output('é'));
        const split = bytes.indexOf(Buffer.from('é')) + 1;
        const result = await simulate(t, {...profile(adapter), maxOutputBytes: 2}, [['stdout', bytes.subarray(0, split)], ['stdout', bytes.subarray(split)]]);
        assert.deepEqual(result, {status: 'completed', text: 'é'});
    });
}

test('local transcript budget is optional, positive integer, at most 4 MiB', () => {
    assert.doesNotThrow(() => validateProfile(profile('codex')));
    assert.doesNotThrow(() => validateProfile({...profile('codex'), maxTranscriptBytes: 4 * 1024 * 1024}));
    for (const maxTranscriptBytes of [0, -1, 1.5, '1000', NaN, Infinity, 4 * 1024 * 1024 + 1]) {
        assert.throws(() => validateProfile({...profile('codex'), maxTranscriptBytes}), /Invalid profile maxTranscriptBytes/);
    }
    assert.throws(() => validateProfile({...profile('codex'), maxOutputBytes: 32001}), /Invalid profile maxOutputBytes/);
});

test('default transcript ceiling is 1 MiB and the default final ceiling is 32000 bytes', async t => {
    const transcript = await simulate(t, profile('codex'), [['stderr', Buffer.alloc(1024 * 1024 + 1, 97)], ['stdout', codexOutput('OK')]]);
    assert.equal(transcript.status, 'interrupted');
    assert.match(transcript.text, /Transcript limit exceeded/);
    const final = await simulate(t, profile('codex'), [['stdout', codexOutput('é'.repeat(16001))]]);
    assert.deepEqual(final, {status: 'failed', text: 'Final result limit exceeded'});
});

test('fixture transport cap remains independent of maxTranscriptBytes and decoded text cannot escape final cap', async t => {
    const p = {...profile('fixture'), testOnly: true, fixtureScript: 'unused.mjs', maxOutputBytes: 40, maxTranscriptBytes: 1000};
    const transport = await simulate(t, p, [['stdout', 'a'.repeat(41)]]);
    assert.deepEqual(transport, {status: 'interrupted', text: 'Output limit exceeded'});
    // Invalid UTF-8 expands to replacement characters during decoding.
    const final = await simulate(t, p, [['stdout', Buffer.alloc(40, 255)]]);
    assert.deepEqual(final, {status: 'failed', text: 'Final result limit exceeded'});
});
