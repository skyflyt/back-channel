// Stopping a running worker (vault design pc-agent-readiness.md, "Addendum (2026-10-10), stopping a running worker").
// Stopping the BackChannel-Worker scheduled task ends its PowerShell launcher, not node, which keeps the state lock.
//   - `bc-worker stop` ends the worker that holds this state's lock, after checking the lock's PID really is a node
//     running this CLI's `run` for this --state (anything else: not_this_worker, and nothing is touched). It then
//     clears the lock as `recover` does: interrupted work is never replayed.
//   - `bc-worker run --parent-pid PID` stops by itself once the process that started it (the launcher) is gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terminateTree, processInfo } from './runtime.mjs';
import { Worker } from './worker.mjs';
import { ReadinessError } from './readiness.mjs';

export const STOP_TIMEOUT_MS = 15000;
export const PARENT_CHECK_MS = 5000;
// The CLI's options that take a value (bin/cli.mjs), to read another worker's command line the way parseArgs does.
const VALUE_OPTIONS = new Set(['state', 'broker', 'name', 'file', 'target', 'profile', 'objective-file', 'continue-profile', 'id', 'remote-session', 'executor-secret-from', 'fingerprint', 'claude', 'parent-pid']);
const fail = (code, message) => { throw new ReadinessError(code, message); };
const sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));

/** Is this process alive? (A process of another user is alive too: EPERM.) */
export function isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

/** Wait until the process is gone, up to timeoutMs. true when it is. */
export async function waitGone(pid, timeoutMs, alive = isAlive) {
    const deadline = Date.now() + timeoutMs;
    while (alive(pid)) {
        if (Date.now() >= deadline) return false;
        await sleep(100);
    }
    return true;
}

/** A Windows command line split into arguments the way the C runtime (and node) does. The program name never escapes. */
export function splitWindowsCommandLine(line) {
    const s = String(line ?? '');
    const args = [];
    let i = 0;
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"') { const end = s.indexOf('"', i + 1); args.push(s.slice(i + 1, end < 0 ? s.length : end)); i = end < 0 ? s.length : end + 1; }
    else { let j = i; while (j < s.length && s[j] !== ' ' && s[j] !== '\t') j++; if (j > i) args.push(s.slice(i, j)); i = j; }
    let current = '', quoted = false, any = false;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') {
            let k = i;
            while (s[k] === '\\') k++;
            const count = k - i;
            if (s[k] === '"') {
                current += '\\'.repeat(Math.floor(count / 2));
                if (count % 2) { current += '"'; i = k + 1; }
                else i = k;
            } else { current += '\\'.repeat(count); i = k; }
            any = true;
            continue;
        }
        if (c === '"') {
            if (quoted && s[i + 1] === '"') { current += '"'; i += 2; any = true; continue; }
            quoted = !quoted; any = true; i++;
            continue;
        }
        if (!quoted && (c === ' ' || c === '\t')) {
            if (any) { args.push(current); current = ''; any = false; }
            i++;
            continue;
        }
        current += c; any = true; i++;
    }
    if (any) args.push(current);
    return args;
}

/** A bin/cli.mjs of this package (@back-channel/worker): another install of this CLI, such as before an update. */
function isWorkerCli(script) {
    if (path.basename(script).toLowerCase() !== 'cli.mjs' || path.basename(path.dirname(script)).toLowerCase() !== 'bin') return false;
    try { return JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', 'package.json'), 'utf8')).name === '@back-channel/worker'; }
    catch { return false; }
}

/**
 * Is this process (processInfo's answer) a node running this CLI's `run` for this state directory? The script must be
 * this CLI, or another install of it; the first command `run`; and --state (or the default) this state directory.
 */
export function isWorkerRun(info, { stateDirectory, cliPath, defaultStateDirectory = path.join(os.homedir(), '.config', 'back-channel-worker'), platform = process.platform }) {
    if (!info) return false;
    const argv = Array.isArray(info.argv) ? info.argv : splitWindowsCommandLine(info.commandLine);
    const exe = String(info.name || argv[0] || '').split(/[\\/]/).pop();
    if (!/^node(\.exe)?$/i.test(exe)) return false;
    const at = argv.findIndex((a, i) => i > 0 && /cli\.mjs$/i.test(a));
    if (at < 0) return false;
    const base = info.cwd ?? process.cwd();
    const resolve = p => { const r = path.resolve(base, p); try { return fs.realpathSync(r); } catch { return r; } };
    const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const script = resolve(argv[at]);
    if (!same(script, resolve(cliPath)) && !isWorkerCli(script)) return false;
    let state, command;
    for (let i = at + 1; i < argv.length; i++) {
        const option = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
        if (option) {
            const value = option[2] ?? (VALUE_OPTIONS.has(option[1]) ? argv[++i] : undefined);
            if (option[1] === 'state') state = value;
        } else if (command === undefined) command = argv[i];
    }
    if (command !== 'run' || (state !== undefined && typeof state !== 'string')) return false;
    return same(state === undefined ? resolve(defaultStateDirectory) : resolve(state), resolve(stateDirectory));
}

/** End the worker's process tree. Elsewhere than Windows it is asked first (SIGTERM: it stops its agent run itself). */
async function endWorker(pid, timeoutMs) {
    if (process.platform !== 'win32') {
        try { process.kill(pid, 'SIGTERM'); } catch { }
        if (await waitGone(pid, Math.min(8000, timeoutMs / 2))) return;
    }
    await terminateTree({ pid });
    if (process.platform !== 'win32') try { process.kill(pid, 'SIGKILL'); } catch { }
}

/**
 * `bc-worker stop`. { stopped: true, wasRunning } when this state's worker is not running any more (its lock cleared,
 * its interrupted work marked so it never replays). Throws not_this_worker (nothing touched) or stop_timeout.
 * A recovery block (uncertain process cleanup) is left in place: only the person's recover --confirm-stopped clears it.
 */
export async function stopWorker({ store, cliPath, timeoutMs = STOP_TIMEOUT_MS, inspect = processInfo, end = endWorker, alive = isAlive }) {
    const lock = path.join(store.directory, 'worker.lock');
    let raw;
    try { raw = fs.readFileSync(lock, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { stopped: true, wasRunning: false }; throw e; }
    const pid = Number(raw.trim());
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(pid) || pid <= 0)
        fail('not_this_worker', "The worker's lock doesn't name a process, so nothing was touched. If no worker is running, run recover --confirm-stopped.");
    let wasRunning = false;
    if (alive(pid)) {
        if (!isWorkerRun(await inspect(pid), { stateDirectory: store.directory, cliPath }))
            fail('not_this_worker', "The process holding the worker's lock isn't this worker running, so nothing was touched.");
        wasRunning = true;
        const started = Date.now();
        await end(pid, timeoutMs);
        if (!(await waitGone(pid, Math.max(0, timeoutMs - (Date.now() - started)), alive)))
            fail('stop_timeout', "The worker didn't stop within 15 seconds. Nothing was cleared: try again.");
    }
    // The process is gone: clear its lock (unless it released it itself) and record the stop as recover does.
    try { if (fs.readFileSync(lock, 'utf8').trim() === String(pid)) fs.unlinkSync(lock); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let release;
    try { release = store.lock(); }
    catch { fail('locked', 'Another worker started on this state just now, so it was left running.'); }
    try { await new Worker(store, { client: {} }).recover(); }
    finally { release(); }
    return { stopped: true, wasRunning };
}

/**
 * `run --parent-pid`: check now and every 5 seconds whether the process that started this worker is alive; once it is
 * gone, call onGone once (the run then stops as on an interrupt). stop() ends the watch.
 */
export function watchParent(pid, onGone, { everyMs = PARENT_CHECK_MS, alive = isAlive } = {}) {
    let done = false;
    const timer = globalThis.setInterval(() => check(), everyMs);
    const watch = { stop() { done = true; globalThis.clearInterval(timer); } };
    const check = () => { if (!done && !alive(pid)) { watch.stop(); onGone(); } };
    check();
    return watch;
}
