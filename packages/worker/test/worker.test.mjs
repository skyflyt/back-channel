import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { identity, seal, open, binding } from '../src/crypto.mjs';
import { Worker } from '../src/worker.mjs';
import { runRuntime, runtimeArgs } from '../src/runtime.mjs';
class MemoryRelay {
    tasks = new Map();
    client(agent) {
        return { request: async (route, body) => {
                if (route === '/tasks' && !body)
                    return { tasks: [...this.tasks.values()], nextCursor: null };
                if (route === '/tasks') {
                    const old = this.tasks.get(body.id);
                    if (old) {
                        assert.equal(old.sealed, body.sealed);
                        return { task: old };
                    }
                    const t = { ...body, senderAgentId: agent, status: 'queued' };
                    this.tasks.set(t.id, t);
                    return { task: t };
                }
                const [, , id, operation] = route.split('/');
                const t = this.tasks.get(id);
                const error = () => { const e = Error('conflict'); e.status = 409; throw e; };
                if (operation === 'claim') {
                    if (t.status !== 'queued')
                        error();
                    t.status = 'running';
                    return { task: t, leaseToken: 'lease' };
                }
                if (operation === 'heartbeat') {
                    if (t.status !== 'running')
                        error();
                    return {};
                }
                if (operation === 'cancel') {
                    t.status = 'cancelled';
                    return {};
                }
                if (operation === 'reject') {
                    t.status = 'rejected';
                    return {};
                }
                if (operation === 'result') {
                    if (t.status !== 'running')
                        error();
                    t.status = body.status;
                    t.resultSealed = body.sealed;
                    return { task: t };
                }
                throw Error('Unknown route ' + route);
            } };
    }
}
function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-worker-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const relay = new MemoryRelay(), a = identity(), b = identity(), calls = [];
    const profile = { adapter: 'fixture', testOnly: true, executable: process.execPath, cwd: dir, fixtureScript: path.join(import.meta.dirname, 'fixtures/runtime.mjs'), allowedSenders: ['a', 'b'], maxRuntimeMs: 5000 };
    const make = (id, keys, peer) => { const store = new Store(path.join(dir, id)); store.write('config', { agentId: id, identity: keys, peers: { [id === 'a' ? 'b' : 'a']: peer }, profiles: { approved: profile } }); return new Worker(store, { client: relay.client(id), runner: async (p, prompt, options) => { calls.push({ id, prompt }); return runRuntime(p, prompt, options); }, heartbeatMs: 10 }); };
    return { a: make('a', a, b), b: make('b', b, a), relay, calls, profile };
}
test('full sealed task → real child → result → sender continuation; duplicate polls run once', async (t) => {
    const s = setup(t);
    const id = await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'Return fixture evidence', continuationProfile: 'approved' });
    assert.ok(!s.relay.tasks.get(id).sealed.includes('Return fixture evidence'));
    await s.b.cycle();
    assert.equal(s.relay.tasks.get(id).status, 'completed');
    await s.a.cycle();
    await s.a.cycle();
    await s.b.cycle();
    assert.equal(s.calls.length, 2);
    assert.equal(s.a.journal.continuations[id].state, 'completed');
    assert.match(s.a.journal.continuations[id].output.text, /fixture-result/);
});
test('signature, ciphertext, purpose and route replay all fail closed', () => {
    const a = identity(), b = identity(), task = { id: randomUUID(), senderAgentId: 'a', targetAgentId: 'b', expiresAt: new Date(Date.now() + 60000).toISOString() }, header = binding(task, 'task');
    const e = seal({ objective: 'private' }, header, a, b);
    assert.equal(open(e, header, b, a).objective, 'private');
    assert.throws(() => open(e, binding(task, 'result'), b, a));
    assert.throws(() => open(e, { ...header, id: randomUUID() }, b, a));
    assert.throws(() => open(e, header, b, identity()));
    const altered = JSON.parse(e);
    altered.ciphertext = 'AAAA';
    assert.throws(() => open(JSON.stringify(altered), header, b, a));
});
test('unknown profile and unpinned peer never invoke model', async (t) => {
    const s = setup(t);
    await s.a.send({ targetAgentId: 'b', profile: 'unknown', objective: 'Do not run' });
    await s.b.cycle();
    assert.equal(s.calls.length, 0);
    assert.equal(Object.values(s.b.journal.tasks)[0].state, 'rejected');
    s.b.config.peers = {};
    await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'Do not run' });
    await s.b.cycle();
    assert.equal(s.calls.length, 0);
});
test('restart records interrupted execution and continuation without replay', async (t) => {
    const s = setup(t);
    const id = await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'Do not rerun' });
    s.b.journal.tasks[id] = { state: 'running', pid: 123 };
    s.b.journal.continuations.x = { state: 'starting' };
    s.b.save();
    await s.b.recover();
    await s.b.cycle();
    assert.equal(s.calls.length, 0);
    assert.equal(s.b.journal.tasks[id].state, 'interrupted');
    assert.equal(s.b.journal.continuations.x.state, 'interrupted');
});
test('cancellation heartbeat aborts running work; result cannot override cancellation', async (t) => {
    const s = setup(t);
    const id = await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'wait' });
    s.b.runner = async (p, prompt, { signal }) => new Promise(resolve => { signal.addEventListener('abort', () => resolve({ status: 'interrupted', text: 'cancelled' })); setTimeout(() => { s.relay.tasks.get(id).status = 'cancelled'; }, 15); });
    await s.b.cycle();
    assert.equal(s.relay.tasks.get(id).status, 'cancelled');
    assert.equal(s.b.journal.tasks[id].state, 'delivery_rejected');
});
test('durable result outbox retries without running again', async (t) => {
    const s = setup(t);
    const id = await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'once' });
    const original = s.b.client.request;
    let failed = false;
    s.b.client.request = async (route, body) => { if (route.endsWith('/result') && !failed) {
        failed = true;
        throw Error('network unavailable');
    } return original(route, body); };
    await assert.rejects(s.b.cycle(), /network unavailable/);
    assert.equal(s.b.journal.tasks[id].state, 'result_pending');
    await s.b.cycle();
    assert.equal(s.calls.length, 1);
    assert.equal(s.relay.tasks.get(id).status, 'completed');
});
test('state lock prevents concurrent executors', t => { const s = setup(t); const release = s.a.store.lock(); assert.throws(() => s.a.store.lock(), /locked/); release(); });
test('CLI adapters use fixed permission preserving arguments', () => { assert.deepEqual(runtimeArgs({ adapter: 'codex' }).slice(0, 4), ['exec', '--sandbox', 'read-only', '--json']); assert.deepEqual(runtimeArgs({ adapter: 'claude' }).slice(0, 6), ['--print', '--output-format', 'json', '--permission-mode', 'plan', '--json-schema']); });
test('stop is sticky and never launches the next queued task', async (t) => {
    const s = setup(t);
    await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'first' });
    await s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'second' });
    let calls = 0;
    s.b.runner = async () => { calls++; s.b.stop(); return { status: 'interrupted', text: 'shutdown' }; };
    await s.b.cycle();
    await s.b.cycle();
    assert.equal(calls, 1);
    assert.equal([...s.relay.tasks.values()][1].status, 'queued');
});
test('permanent pending-send failure is journaled and does not poison inbox', async (t) => {
    const s = setup(t);
    const request = s.a.client.request;
    s.a.client.request = async (route, body) => { if (route === '/tasks' && body) {
        const e = Error('expired');
        e.status = 409;
        throw e;
    } return request(route, body); };
    await assert.rejects(s.a.send({ targetAgentId: 'b', profile: 'approved', objective: 'expired' }));
    await s.a.cycle();
    assert.equal(Object.values(s.a.journal.sent)[0].state, 'send_rejected');
    await s.a.cycle();
});
test('rejected work reaches sender as explicit relay metadata and continues once', async (t) => {
    const s = setup(t);
    const id = await s.a.send({ targetAgentId: 'b', profile: 'unknown', objective: 'reject', continuationProfile: 'approved' });
    await s.b.cycle();
    await s.a.cycle();
    await s.a.cycle();
    assert.equal(s.calls.length, 1);
    assert.equal(s.a.journal.continuations[id].result.source, 'relay-metadata');
    assert.equal(s.a.journal.continuations[id].result.status, 'rejected');
});
test('idle polling invokes no runtime and runtime output/time limits are enforced', async (t) => {
    const s = setup(t);
    await s.a.cycle();
    assert.equal(s.calls.length, 0);
    const tooMuch = await runRuntime({ ...s.profile, maxOutputBytes: 5 }, 'normal');
    assert.equal(tooMuch.status, 'interrupted');
    assert.match(tooMuch.text, /Output limit/);
    const timed = await runRuntime({ ...s.profile, maxRuntimeMs: 100 }, 'HANG_FIXTURE');
    assert.equal(timed.status, 'interrupted');
    assert.match(timed.text, /Runtime limit/);
});
test('state path components and file names cannot escape approved directory', t => {
    const s = setup(t);
    assert.throws(() => s.a.store.write('../outside', {}), /Invalid state/);
    const repo = path.join(s.profile.cwd, 'repository');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    assert.throws(() => new Store(path.join(repo, 'state')), /outside repositories/);
});
test('cancellation stops a real runtime descendant process', async t => {
    const s = setup(t), abort = new AbortController();
    const running = runRuntime(s.profile, 'TREE_FIXTURE', {signal: abort.signal});
    const marker = path.join(s.profile.cwd, 'tree-pid');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(fs.existsSync(marker), 'fixture spawned a descendant');
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    abort.abort();
    const result = await running;
    assert.equal(result.status, 'interrupted');
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
        try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 20)); }
        catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false, 'descendant was terminated');
});
test('exited runtime with inherited descendant pipes completes and cleans the child', async t => {
    const s = setup(t);
    const result = await runRuntime(s.profile, 'INHERITED_PIPE_FIXTURE');
    assert.equal(result.status, 'completed');
    assert.match(result.text, /fixture-result/);
    const pid = Number(fs.readFileSync(path.join(s.profile.cwd, 'tree-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
});
test('sender continuation retains the original local scope and tool restrictions', async t => {
    const s = setup(t), objective = 'Return OK. Do not use tools or change files.';
    await s.a.send({targetAgentId: 'b', profile: 'approved', objective, acceptanceCriteria: ['Only return OK'], continuationProfile: 'approved'});
    s.b.runner = async () => ({status: 'completed', text: 'OK'});
    let continuation;
    s.a.runner = async (profile, prompt) => { continuation = prompt; return {status: 'completed', text: 'OK'}; };
    await s.b.cycle(); await s.a.cycle();
    assert.ok(continuation.includes(objective));
    assert.ok(continuation.includes('Only return OK'));
    assert.ok(continuation.indexOf('ORIGINAL LOCAL TASK:') < continuation.indexOf('PEER RESULT EVIDENCE:'));
});
