// Stopping a running worker (vault design pc-agent-readiness.md, "Addendum (2026-10-10), stopping a running worker"):
// bc-worker stop, and run --parent-pid, against real worker processes on a loopback-only config.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { identity } from '../src/crypto.mjs';
import { isAlive, isWorkerRun, splitWindowsCommandLine } from '../src/stop.mjs';

const CLI = path.join(import.meta.dirname, '../bin/cli.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A PATH with no claude on it, so a run's readiness report never starts a real claude.
const SYSTEM_PATH = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
    : '/usr/bin:/bin';
const ENV = (() => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' || k.startsWith('BC_')) delete env[k];
    return { ...env, PATH: SYSTEM_PATH };
})();

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stop-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
/** A set-up worker state: a loopback broker nothing listens on, so a run keeps retrying until it is stopped. */
function state(t, name = 'state') {
    const store = new Store(path.join(tempDir(t), name));
    // Built at runtime: an agent key shaped like a real one, obviously a test value.
    store.write('config', { broker: 'http://127.0.0.1:1', name: 'Test PC agent', token: ['bc', randomBytes(24).toString('base64url')].join('_'), identity: identity(), agentId: randomUUID(), peers: {}, profiles: {} });
    return store;
}
const lockOf = store => path.join(store.directory, 'worker.lock');
function cli(args, store) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [CLI, '--state', store.directory, ...args], { windowsHide: true, env: ENV });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return undefined; } })() }));
    });
}
/** A process that runs until killed (or for ms), with its exit promised. */
function idle(t, script = 'setInterval(() => {}, 1000)') {
    const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(() => { try { child.kill('SIGKILL'); } catch { } });
    return { child, exited };
}
/** A real worker: run on this state. Resolves once it holds the lock. */
async function runWorker(t, store, extra = []) {
    const child = spawn(process.execPath, [CLI, '--state', store.directory, 'run', ...extra], { windowsHide: true, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    t.after(() => { try { child.kill('SIGKILL'); } catch { } });
    const deadline = Date.now() + 20000;
    while (!(fs.existsSync(lockOf(store)) && fs.readFileSync(lockOf(store), 'utf8').trim() === String(child.pid))) {
        if (Date.now() > deadline) throw Error('The worker never took its lock: ' + stderr);
        await sleep(100);
    }
    return { child, exited, stderr: () => stderr };
}

test('reading a Windows command line the way node does', () => {
    assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\bin\\cli.mjs" --state "C:\\x y\\state" run --parent-pid 42'),
        ['C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\bin\\cli.mjs', '--state', 'C:\\x y\\state', 'run', '--parent-pid', '42']);
    assert.deepEqual(splitWindowsCommandLine('node.exe C:\\w\\cli.mjs --state=C:\\s run'), ['node.exe', 'C:\\w\\cli.mjs', '--state=C:\\s', 'run']);
    assert.deepEqual(splitWindowsCommandLine('node a\\\\"b c" d\\"e "f""g"'), ['node', 'a\\b c', 'd"e', 'f"g']);
    assert.deepEqual(splitWindowsCommandLine(''), []);
});

test('which process is "this worker running": node, this CLI (or another install of it), run, this --state', t => {
    const dir = tempDir(t);
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir);
    const other = path.join(dir, 'old-install', 'bin', 'cli.mjs');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, '');
    fs.writeFileSync(path.join(dir, 'old-install', 'package.json'), JSON.stringify({ name: '@back-channel/worker' }));
    const stranger = path.join(dir, 'other-tool', 'bin', 'cli.mjs');
    fs.mkdirSync(path.dirname(stranger), { recursive: true });
    fs.writeFileSync(stranger, '');
    fs.writeFileSync(path.join(dir, 'other-tool', 'package.json'), JSON.stringify({ name: 'something-else' }));
    const want = { stateDirectory: stateDir, cliPath: CLI };
    const run = (argv, over = {}) => isWorkerRun({ name: 'node', argv, ...over }, want);
    assert.equal(run(['node', CLI, '--state', stateDir, 'run']), true);
    assert.equal(run(['node', CLI, '--state', stateDir, 'run', '--lists', '--parent-pid', '7']), true);
    assert.equal(run(['node', '--enable-source-maps', CLI, `--state=${stateDir}`, 'run']), true);
    assert.equal(run(['node', other, '--state', stateDir, 'run']), true, 'another install of this CLI (before an update)');
    assert.equal(run(['node', other, '--state', 'state', 'run'], { cwd: dir }), true, 'relative paths resolve against its own working directory');
    assert.equal(run(['node', other, '--state', 'state', 'run'], { cwd: path.join(dir, 'old-install') }), false);
    for (const [label, argv, over] of [
        ['not run', ['node', CLI, '--state', stateDir, 'status']],
        ['another state', ['node', CLI, '--state', path.join(dir, 'elsewhere'), 'run']],
        ['no --state (the default directory)', ['node', CLI, 'run']],
        ['another program', ['node', stranger, '--state', stateDir, 'run']],
        ['not node', ['python', CLI, '--state', stateDir, 'run'], { name: 'python' }],
        ['a run hidden in a value', ['node', CLI, '--state', stateDir, '--name', 'run', 'status']],
    ]) assert.equal(run(argv, over), false, label);
    assert.equal(isWorkerRun({ name: 'node.exe', commandLine: `"${process.execPath}" "${CLI}" --state "${stateDir}" run` }, want), true, 'a Windows command line');
    assert.equal(isWorkerRun(null, want), false);
});

test('stop: no lock is { stopped: true, wasRunning: false }', async t => {
    const store = state(t);
    const r = await cli(['stop'], store);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json, { stopped: true, wasRunning: false });
});

test('stop: a stale lock (its process is gone) is cleared as recover does; interrupted work never replays; a recovery block stays', async t => {
    const store = state(t);
    const gone = idle(t, '');
    await gone.exited;
    assert.equal(isAlive(gone.child.pid), false);
    fs.writeFileSync(lockOf(store), String(gone.child.pid));
    const block = { taskId: 'x', phase: 'execution', reason: 'cleanup uncertain', recordedAt: new Date().toISOString() };
    store.write('journal', { tasks: { x: { state: 'running', pid: 1 } }, sent: {}, continuations: { y: { state: 'starting' } }, recoveryRequired: block });
    const r = await cli(['stop'], store);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json, { stopped: true, wasRunning: false });
    assert.equal(fs.existsSync(lockOf(store)), false, 'the lock is cleared');
    const journal = store.read('journal');
    assert.equal(journal.tasks.x.state, 'interrupted');
    assert.equal(journal.continuations.y.state, 'interrupted');
    assert.deepEqual(journal.recoveryRequired, block, 'only the person clears a recovery block (recover --confirm-stopped)');
});

test("stop: a live process that isn't this worker running is not_this_worker, and nothing is touched", async t => {
    const store = state(t);
    const stranger = idle(t);
    fs.writeFileSync(lockOf(store), String(stranger.child.pid));
    let r = await cli(['stop'], store);
    assert.equal(r.status, 1);
    assert.deepEqual(Object.keys(r.json), ['error', 'message']);
    assert.equal(r.json.error, 'not_this_worker');
    assert.equal(fs.readFileSync(lockOf(store), 'utf8'), String(stranger.child.pid), 'the lock is untouched');
    assert.equal(isAlive(stranger.child.pid), true, 'the process is untouched');

    // A worker running this CLI, but on another state, is not this one either.
    const elsewhere = await runWorker(t, state(t, 'other'));
    fs.writeFileSync(lockOf(store), String(elsewhere.child.pid));
    r = await cli(['stop'], store);
    assert.equal(r.json.error, 'not_this_worker');
    assert.equal(isAlive(elsewhere.child.pid), true);

    fs.writeFileSync(lockOf(store), 'not a pid');
    r = await cli(['stop'], store);
    assert.equal(r.json.error, 'not_this_worker');
    assert.equal(fs.readFileSync(lockOf(store), 'utf8'), 'not a pid');
    fs.unlinkSync(lockOf(store));
    // While it runs, allow-sender is locked: stop is the way out (see the next test).
});

test('stop: a running worker is ended, its lock cleared, and the state usable again', async t => {
    const store = state(t);
    const worker = await runWorker(t, store);
    let r = await cli(['revoke-sender', '--id', randomUUID()], store);
    assert.equal(r.json.error, 'locked', 'the worker holds the lock');
    assert.match(r.json.message, /Run stop first/);
    const started = Date.now();
    r = await cli(['stop'], store);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json, { stopped: true, wasRunning: true });
    assert.ok(Date.now() - started < 20000);
    await worker.exited;
    assert.equal(isAlive(worker.child.pid), false, 'the worker is gone');
    assert.equal(fs.existsSync(lockOf(store)), false, 'the lock is cleared');
    r = await cli(['revoke-sender', '--id', randomUUID()], store);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual((await cli(['stop'], store)).json, { stopped: true, wasRunning: false }, 'stopping again is harmless');
});

test('run --parent-pid: the worker stops by itself once the process that started it is gone', async t => {
    const store = state(t);
    const parent = idle(t, 'setTimeout(() => {}, 1500)');
    const worker = await runWorker(t, store, ['--parent-pid', String(parent.child.pid)]);
    await parent.exited;
    const gone = Date.now();
    let timer;
    const code = await Promise.race([worker.exited, new Promise(resolve => { timer = setTimeout(() => resolve('still running'), 20000); })]);
    clearTimeout(timer);
    assert.equal(code, 0, `a clean exit (${worker.stderr()})`);
    assert.ok(Date.now() - gone < 15000, 'within a few seconds of the parent');
    assert.match(worker.stderr(), /The process that started this worker has ended: stopping\./);
    assert.equal(fs.existsSync(lockOf(store)), false, 'it released its lock');

    const r = await new Promise(resolve => {
        const child = spawn(process.execPath, [CLI, '--state', store.directory, 'run', '--parent-pid', 'abc'], { windowsHide: true, env: ENV });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stderr }));
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--parent-pid must be a process id/);
    assert.equal(fs.existsSync(lockOf(store)), false);
});
