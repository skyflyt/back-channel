// The secret broker side of the worker (src/broker-relay.mjs; docs/secrets-epic.md §3.1, §3.4): requests out, the person's
// passkey answers into the broker, and the install / update / enrol / lockdown jobs. Fakes stand in for the broker's
// relay, git and the elevated launch; nothing here touches a real broker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDecisions, collectPending, fetchRelease, launchElevated, Relay, runJob, startSecretsSync } from '../src/broker-relay.mjs';

const C = 'c'.repeat(40), T = 'd'.repeat(40);
function fakeRelay(answers = {}) {
    const calls = [];
    return { calls, call: async msg => { calls.push(msg); const a = answers[msg.op]; return typeof a === 'function' ? a(msg) : a ?? { status: 'ok' }; }, stop() { } };
}
const paths = { python: process.execPath, install: '.', staging: '.', bootstrap: '.' };

test('pending: the broker\'s remote requests become the sync\'s list, digests and grant options included', async () => {
    const relay = fakeRelay({ 'remote-pending': { status: 'ok', pending: [{ ref: 'r'.repeat(24), kind: 'serve', name: 'home/x', mode: 'inject', tier: 1, target: null, code: 'ABC123',
        digest_b64u: 'D'.repeat(43), display: 'REQUEST CODE ABC123', expires_in: 77, requester: { agent: 'claude-code' },
        options: [{ index: 0, label: '1 hour', digest_b64u: 'D'.repeat(43) }, { index: 1, label: 'just this once', digest_b64u: 'E'.repeat(43) }] }] } });
    const [p] = await collectPending(relay);
    assert.deepEqual([p.ref, p.code, p.digest, p.expiresIn, p.options[1].digest], ['r'.repeat(24), 'ABC123', 'D'.repeat(43), 77, 'E'.repeat(43)]);
    assert.ok(!('id' in p), 'never the broker\'s own challenge id');
});

test('decisions: an approval hands the passkey\'s assertion to the broker as-is; a deny is a deny', async () => {
    const relay = fakeRelay();
    const assertion = { credentialId: 'cred', authenticatorData: 'auth', clientDataJson: 'cdj', signature: 'sig' };
    await applyDecisions(relay, [{ ref: 'a'.repeat(20), decision: 'approve', option: 3, assertion }, { ref: 'b'.repeat(20), decision: 'deny' }]);
    assert.deepEqual(relay.calls, [
        { op: 'remote-approve', ref: 'a'.repeat(20), option: 3, credential_id: 'cred', authenticator_data: 'auth', client_data_json: 'cdj', signature: 'sig' },
        { op: 'remote-deny', ref: 'b'.repeat(20) },
    ]);
});

test('update: a fetched tree that does not match the pin is refused before anything is launched', async () => {
    let launched = false;
    const reports = [];
    // The real fetchRelease, over a fake git that serves a different tree for the pinned commit.
    const execFileImpl = (file, args, opts, cb) => cb(null, args.includes('rev-parse') ? `${C}\n${'e'.repeat(40)}\n` : '');
    await runJob({ job: { id: 'j1', kind: 'update', payload: { commit: C, tree: T } }, relay: fakeRelay(), paths,
        report: async (id, state, steps, failure) => reports.push([state, steps, failure]),
        fetch: args => fetchRelease({ ...args, execFileImpl }), launch: async () => { launched = true; return { ok: true }; } });
    assert.equal(launched, false);
    assert.deepEqual(reports.at(-1), ['failed', { fetched: false }, 'pin_mismatch']);
});

test('update: fetched and checked, launched (UAC at the PC), then the service and doctor are checked before done', async () => {
    const reports = [];
    let got = null;
    const relay = fakeRelay({ status: { status: 'ok', commit: C, approver_enrolled: true } });
    await runJob({ job: { id: 'j2', kind: 'update', payload: { commit: C, tree: T } }, relay, paths, waitMs: 1,
        report: async (id, state, steps, failure) => reports.push([state, steps, failure]),
        fetch: async () => '.', launch: async a => { got = a; return { ok: true }; },
        doctor: async () => ({ healthy: true, checks: [{ label: 'home backend reachable (canary)', ok: true }] }) });
    assert.deepEqual(got.payload, { commit: C, tree: T });
    const [state, steps, failure] = reports.at(-1);
    assert.equal(state, 'done'); assert.equal(failure, null);
    assert.deepEqual(steps, { fetched: true, installer_started: true, installer_finished: true, service_running: true, approver_enrolled: true, doctor_healthy: true, token_stored: true });
    // A declined UAC prompt is reported as such.
    reports.length = 0;
    await runJob({ job: { id: 'j3', kind: 'update', payload: { commit: C, tree: T } }, relay, paths, report: async (...a) => reports.push(a.slice(1)),
        fetch: async () => '.', launch: async () => ({ code: 'uac_declined' }) });
    assert.deepEqual(reports.at(-1)[2], 'uac_declined');
});

test('update: the relay is paused while the installer replaces the venv, and resumed after, a failed launch included', async () => {
    const relay = { ...fakeRelay({ status: { status: 'ok', commit: C } }), paused: false, log: [] };
    relay.pause = () => { relay.paused = true; relay.log.push('pause'); };
    relay.resume = () => { relay.paused = false; relay.log.push('resume'); };
    let pausedAtLaunch = null;
    await runJob({ job: { id: 'j6', kind: 'update', payload: { commit: C, tree: T } }, relay, paths, waitMs: 1, report: async () => { },
        fetch: async () => '.', launch: async () => { pausedAtLaunch = relay.paused; return { ok: true }; }, doctor: async () => ({ healthy: true, checks: [] }) });
    assert.equal(pausedAtLaunch, true);
    assert.deepEqual(relay.log, ['pause', 'resume']);
    relay.log.length = 0;
    await runJob({ job: { id: 'j7', kind: 'install', payload: { commit: C, tree: T } }, relay, paths, report: async () => { },
        fetch: async () => '.', launch: async () => { throw Error('spawn failed'); } });
    assert.deepEqual(relay.log, ['pause', 'resume']);
});

test('relay: a paused relay starts no Python, and the sync leaves the broker alone until it resumes', async () => {
    let spawned = 0;
    const r = new Relay({ python: 'python.exe', spawnImpl: () => { spawned++; throw Error('unexpected spawn'); } });
    r.pause();
    await assert.rejects(r.call({ op: 'status' }), /could not start/);
    assert.equal(spawned, 0);
    const relay = { ...fakeRelay({ 'remote-pending': { status: 'ok', pending: [] } }), paused: true };
    let collected = 0;
    const sent = [];
    const s = startSecretsSync({ client: { secretsSync: async body => { sent.push(body); return { status: 200, body: { decisions: [], jobs: [] } }; } },
        paths: { python: process.execPath }, relay, everyMs: 60_000, collect: async () => { collected++; return { installed: true }; } });
    await s.first;
    s.stop();
    assert.equal(collected, 0);
    assert.deepEqual(relay.calls, []);
    assert.deepEqual(sent[0].pending, []);
});

test('enrol and lockdown: the broker\'s own card decides an enrolment; lockdown is relayed at once', async () => {
    const reports = [];
    await runJob({ job: { id: 'j4', kind: 'enrol', payload: { credentialId: 'abc', publicKeyCose: 'def', label: 'phone' } }, relay: fakeRelay(), paths,
        report: async (...a) => reports.push(a.slice(1)), enrol: async () => false });
    assert.deepEqual(reports.at(-1), ['failed', { trusted: false }, 'declined_at_machine']);
    const relay = fakeRelay();
    await runJob({ job: { id: 'j5', kind: 'lockdown', payload: {} }, relay, paths, report: async (...a) => reports.push(a.slice(1)) });
    assert.deepEqual(relay.calls, [{ op: 'lockdown' }]);
    assert.deepEqual(reports.at(-1), ['done', { locked: true }, null]);
});

test('test: the phone\'s "Try it" runs the broker\'s own `run` around a command that exits at once; approved, denied and failed are told apart; nothing is read', async () => {
    const reports = [];
    const calls = [];
    const fakeExec = code => (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(code === 0 ? null : Object.assign(new Error('exit'), { code }), 'never read'); };
    const { runTest } = await import('../src/broker-relay.mjs');
    const test = ({ python, ref }) => runTest({ python, ref, execFileImpl: fakeExec(0) });
    await runJob({ job: { id: 't1', kind: 'test', payload: { ref: 'home/fixture/tier1' } }, relay: fakeRelay(), paths, report: async (...a) => reports.push(a.slice(1)), test });
    assert.deepEqual(reports.at(-1), ['done', { raised: true, approved: true, denied: false }, null]);
    assert.equal(calls[0].file, paths.python);
    assert.deepEqual(calls[0].args.slice(0, 6), ['-I', '-m', 'secret_broker', 'run', '--ref', 'home/fixture/tier1']);
    assert.equal(calls[0].args.indexOf('--'), 8, 'the command after the broker\'s own arguments');
    assert.equal(calls[0].opts.shell, false);
    assert.equal(await runTest({ python: paths.python, ref: 'home/fixture/tier1', execFileImpl: fakeExec(3) }), 'denied');
    assert.equal(await runTest({ python: paths.python, ref: 'home/fixture/tier1', execFileImpl: fakeExec(2) }), 'failed');
    assert.equal(await runTest({ python: paths.python, ref: 'not a name', execFileImpl: fakeExec(0) }), 'failed', 'a bad name never reaches the broker');
    await runJob({ job: { id: 't2', kind: 'test', payload: { ref: 'home/fixture/tier1' } }, relay: fakeRelay(), paths, report: async (...a) => reports.push(a.slice(1)), test: async () => 'denied' });
    assert.deepEqual(reports.at(-1), ['done', { raised: true, approved: false, denied: true }, null]);
    await runJob({ job: { id: 't3', kind: 'test', payload: { ref: 'home/fixture/tier1' } }, relay: fakeRelay(), paths, report: async (...a) => reports.push(a.slice(1)), test: async () => 'failed' });
    assert.deepEqual(reports.at(-1), ['failed', { raised: true, approved: false, denied: false }, 'test_failed']);
});

test('elevated launch: Windows only, and the elevated script itself checks commit and tree before running the installer', async () => {
    await assert.rejects(launchElevated({ payload: { commit: C, tree: T }, kind: 'update', platform: 'linux' }), e => e.code === 'not_supported');
    let argv = null;
    const fake = (file, args) => { argv = [file, ...args]; const ee = { on: (ev, f) => { if (ev === 'exit') setImmediate(() => f(0)); return ee; } }; return ee; };
    const r = await launchElevated({ payload: { commit: C, tree: T }, kind: 'update', platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, spawnImpl: fake });
    assert.deepEqual(r, { ok: true });
    const launcher = argv.at(-1);
    assert.match(launcher, /-Verb RunAs/);
    const inner = Buffer.from(launcher.match(/'-EncodedCommand','([^']+)'/)[1], 'base64').toString('utf16le');
    assert.ok(inner.includes(`checkout --quiet ${C}`) && inner.includes(`"${C} ${T}"`), 'the staging clone is checked against the pin');
    assert.ok(inner.indexOf('rev-parse') < inner.indexOf('install.ps1'), 'checked before the installer runs');
    assert.match(inner, /install\.ps1" -Work -UpdateOnly/);
});

test('elevated install: passes the home and work Bitwarden project ids, and only well-formed ones', async () => {
    const H = '7b315e95-c6a8-4b8d-8f90-b4e6017b8bf0', W = '0d4e2c1a-5b6f-4a7e-9c8d-1e2f3a4b5c6d';
    const innerOf = async backends => {
        let argv = null;
        const fake = (file, args) => { argv = [file, ...args]; const ee = { on: (ev, f) => { if (ev === 'exit') setImmediate(() => f(0)); return ee; } }; return ee; };
        await launchElevated({ payload: { commit: C, tree: T }, kind: 'install', platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, spawnImpl: fake, backends });
        return Buffer.from(argv.at(-1).match(/'-EncodedCommand','([^']+)'/)[1], 'base64').toString('utf16le');
    };
    assert.ok((await innerOf({ bwsProjectId: H, workBwsProjectId: W })).includes(`install.ps1" -Work  -BwsProjectId '${H}' -WorkBwsProjectId '${W}'`));
    const odd = await innerOf({ bwsProjectId: H, workBwsProjectId: `${W}'; calc; '` });
    assert.ok(odd.includes(`-BwsProjectId '${H}'`) && !odd.includes('-WorkBwsProjectId') && !odd.includes('calc'));
    assert.ok(!(await innerOf({})).includes('ProjectId'), 'none configured: the installer asks');
});

test('sync: an Install job gets the broker paths on a PC with no broker yet; enrol before an install says so', async () => {
    const nowhere = { python: 'C:/no/such/LobySecretBroker/venv/Scripts/python.exe', install: '.', staging: '.', bootstrap: '.' };
    let given;
    const client = { secretsSync: async () => ({ status: 200, body: { decisions: [], jobs: [{ id: 'j10', kind: 'install', payload: { commit: C, tree: T } }] } }) };
    const s = startSecretsSync({ client, paths: nowhere, relay: fakeRelay(), everyMs: 60_000, collect: async () => ({ installed: false }),
        job: async a => { given = a.paths; } });
    await s.first;
    s.stop();
    assert.deepEqual(given, nowhere, 'not null: Install needs them most (it failed as not_supported before)');
    const reports = [];
    await runJob({ job: { id: 'j11', kind: 'enrol', payload: {} }, relay: fakeRelay(), paths: nowhere, report: async (...a) => reports.push(a.slice(1)) });
    assert.deepEqual(reports.at(-1), ['failed', {}, 'not_installed']);
});

test('sync: one cycle sends status and pending, hands decisions to the broker, and runs a job once', async () => {
    const sent = [];
    const relay = fakeRelay({ 'remote-pending': { status: 'ok', pending: [] } });
    const jobs = [];
    const client = { secretsSync: async body => { sent.push(body); return { status: 200, body: sent.length === 1 ? { decisions: [{ ref: 'z'.repeat(20), decision: 'deny' }], jobs: [{ id: 'j9', kind: 'lockdown', payload: {} }] } : { decisions: [], jobs: [] } }; } };
    const s = startSecretsSync({ client, paths: { python: process.execPath }, relay, everyMs: 60_000, collect: async () => ({ installed: true }),
        job: async a => { jobs.push(a.job.id); } });
    await s.first;
    s.stop();
    assert.deepEqual(sent[0], { v: 1, broker: { installed: true }, pending: [], jobs: [] });
    assert.deepEqual(relay.calls.map(c => c.op), ['remote-pending', 'remote-deny']);
    assert.deepEqual(jobs, ['j9']);
});
