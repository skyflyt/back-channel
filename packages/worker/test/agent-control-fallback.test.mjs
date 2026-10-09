import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentControlClient, SupportConnectorClient, V1_MALFORMED } from '../src/agent-control.mjs';

// Built at runtime: a well-formed executor secret that is obviously a test value.
const SECRET = ['abx', 'T'.repeat(43)].join('_');

function pipePath() {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\bc-worker-fallback-${randomUUID()}`
        : path.join(os.tmpdir(), `bc-worker-fallback-${randomUUID()}.sock`);
}

/**
 * A fake host. `mode: "v1"` refuses any hello carrying a field it doesn't know (as AppBridge v1 does);
 * `mode: "v1.1"` refuses a hello whose secret doesn't match. Records every hello it saw.
 */
function fakeHost(mode) {
    const target = pipePath();
    const hellos = [];
    const server = net.createServer(socket => {
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
                const message = JSON.parse(buffer.slice(0, i));
                buffer = buffer.slice(i + 1);
                if (message.op !== 'hello') { socket.write(JSON.stringify({ id: message.id, ok: true, sessions: [] }) + '\n'); continue; }
                hellos.push({ ...message });
                const extra = Object.keys(message).filter(k => !['id', 'op', 'version'].includes(k));
                const refuse = reason => socket.write(JSON.stringify({ id: message.id, ok: false, outcome: 'fail_closed', reason }) + '\n');
                if (mode === 'v1' && extra.length) refuse(V1_MALFORMED);
                else if (mode === 'v1.1' && message.executorSecret !== SECRET) refuse("this pipe needs the session's executor secret");
                else socket.write(JSON.stringify({ id: message.id, ok: true, version: 1, host: { name: 'Test PC' }, agentControl: true }) + '\n');
            }
        });
    });
    return new Promise(resolve => server.listen(target, () => resolve({ target, hellos, close: () => new Promise(r => server.close(r)) })));
}

test('v1 host: the agent-control client greets once more without the secret, and works', async () => {
    const host = await fakeHost('v1');
    const client = new AgentControlClient({ path: host.target, executorSecret: SECRET });
    try {
        const answer = await client.request('sessions');
        assert.equal(answer.ok, true);
        assert.equal(host.hellos.length, 2);
        assert.equal(host.hellos[0].executorSecret, SECRET, 'the first hello carried the secret');
        assert.equal('executorSecret' in host.hellos[1], false, 'the retry carried none');
    } finally { client.close?.(); await host.close(); }
});

test('v1 host: the support connector client never falls back; the refusal reaches the caller', async () => {
    const host = await fakeHost('v1');
    const client = new SupportConnectorClient({ path: host.target, executorSecret: SECRET });
    try {
        const answer = await client.request('sessions');
        assert.equal(answer.ok, false);
        assert.equal(answer.outcome, 'fail_closed');
        assert.equal(host.hellos.length, 1, 'no second hello');
    } finally { client.close?.(); await host.close(); }
});

test('v1.1 host refusing a wrong secret: no fallback, whatever the client', async () => {
    const host = await fakeHost('v1.1');
    const wrong = ['abx', 'W'.repeat(43)].join('_');
    const client = new AgentControlClient({ path: host.target, executorSecret: wrong });
    try {
        const answer = await client.request('sessions');
        assert.equal(answer.ok, false);
        assert.equal(host.hellos.length, 1, 'only the exact v1 refusal triggers a retry');
    } finally { client.close?.(); await host.close(); }
});

test('v1.1 host with the right secret: one hello, accepted', async () => {
    const host = await fakeHost('v1.1');
    const client = new AgentControlClient({ path: host.target, executorSecret: SECRET });
    try {
        assert.equal((await client.request('sessions')).ok, true);
        assert.equal(host.hellos.length, 1);
    } finally { client.close?.(); await host.close(); }
});
