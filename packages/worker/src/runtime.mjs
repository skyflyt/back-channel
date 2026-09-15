import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const resultSchema = { type: 'object', properties: { status: { type: 'string', enum: ['completed', 'failed', 'waiting_user'] }, text: { type: 'string' } }, required: ['status', 'text'], additionalProperties: false };
export function validateProfile(p) {
    if (!p || !['codex', 'claude', 'fixture'].includes(p.adapter) || !path.isAbsolute(p.executable) || !path.isAbsolute(p.cwd) || !fs.statSync(p.cwd).isDirectory())
        throw Error('Invalid local profile');
    if (!fs.statSync(p.executable).isFile())
        throw Error('Runtime executable missing');
    if (!Array.isArray(p.allowedSenders) || !p.allowedSenders.every(s => typeof s === 'string'))
        throw Error('Profile requires explicit allowedSenders');
    if (p.args || p.env || p.command)
        throw Error('Arbitrary runtime arguments/environment are not supported');
    if (p.adapter === 'fixture' && !p.testOnly)
        throw Error('Fixture profiles require testOnly');
    if (p.adapter === 'codex' && !['read-only', 'workspace-write'].includes(p.sandbox ?? 'read-only'))
        throw Error('Unsupported sandbox');
    if (p.adapter === 'claude' && !['plan', 'manual'].includes(p.permissionMode ?? 'plan'))
        throw Error('Unsupported permission mode');
    for (const [name, maximum] of [['maxRuntimeMs', 3600000], ['maxOutputBytes', 32000]]) {
        if (p[name] !== undefined && (!Number.isSafeInteger(p[name]) || p[name] < 1 || p[name] > maximum))
            throw Error(`Invalid profile ${name}; expected positive integer at most ${maximum}`);
    }
    return p;
}
export function runtimeArgs(p) {
    if (p.adapter === 'codex')
        return ['exec', '--sandbox', p.sandbox ?? 'read-only', '--json', '--output-schema', path.join(import.meta.dirname, 'runtime-result.schema.json'), '-'];
    if (p.adapter === 'claude')
        return ['--print', '--output-format', 'json', '--permission-mode', p.permissionMode ?? 'plan', '--json-schema', JSON.stringify(resultSchema)];
    return [p.fixtureScript];
}
export async function terminateTree(child) {
    if (!child.pid)
        return;
    if (process.platform === 'win32') {
        // ParentProcessId remains queryable after the direct child exits. MCP
        // helpers can inherit its pipes and otherwise prevent Node's close event.
        const script = `[void][Reflection.Assembly]::LoadWithPartialName('System.Management'); $q=New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId,ParentProcessId FROM Win32_Process'); $rows=@($q.Get()); $ids=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${child.pid}); do { $changed=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed=$true } } } while($changed); [string]::Join(',',@($ids))`;
        const found = await runtimeHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
        const ids = found.trim().split(',').filter(id => /^[0-9]+$/.test(id)).slice(0, 512);
        if (!ids.includes(String(child.pid))) ids.push(String(child.pid));
        await runtimeHelper('taskkill', [...ids.flatMap(id => ['/PID', id]), '/T', '/F']);
    }
    else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch { }
    }
}
function runtimeHelper(executable, args) {
    return new Promise(resolve => {
        const helper = spawn(executable, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
        let output = '', done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(output); };
        const timer = setTimeout(() => { helper.kill(); finish(); }, 5000);
        helper.stdout.on('data', chunk => { if (output.length < 10000) output += chunk.toString(); });
        helper.once('error', finish); helper.once('close', finish);
    });
}
export function parseCodexResult(stdout, code) {
    const invalid = {status: 'failed', text: 'Runtime did not return a valid structured completion result'};
    try {
        const events = stdout.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        const failure = events.findLast(e => e.type === 'turn.failed' || e.type === 'error');
        if (failure) {
            let message = failure.error?.message ?? failure.message ?? 'Runtime reported a failed turn';
            try { message = JSON.parse(message).error?.message ?? message; } catch { }
            return {status: 'failed', text: String(message).slice(0, 2000)};
        }
        // Codex emits commentary as agent_message too. Only the final message
        // is the schema-constrained result; never fall back to an earlier one.
        const final = events.findLast(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
        const structured = JSON.parse(final?.item.text);
        if (!structured || typeof structured !== 'object' || Array.isArray(structured)
            || Object.keys(structured).length !== 2
            || !Object.hasOwn(structured, 'status') || !Object.hasOwn(structured, 'text')
            || !['completed', 'failed', 'waiting_user'].includes(structured.status)
            || typeof structured.text !== 'string') return invalid;
        if (code !== 0) return {status: 'failed', text: structured.text || 'Runtime exited unsuccessfully'};
        if (!events.some(e => e.type === 'turn.completed'))
            return {status: 'failed', text: 'Runtime did not report a completed turn'};
        return {status: structured.status, text: structured.text};
    } catch {
        return invalid;
    }
}
export function runRuntime(profile, prompt, { signal, onSpawn = () => { } } = {}) {
    validateProfile(profile);
    return new Promise(resolve => {
        if (signal?.aborted)
            return resolve({ status: 'interrupted', text: 'Cancelled before launch' });
        const environment = { ...process.env };
        for (const name of Object.keys(environment))
            if (name.startsWith('BC_'))
                delete environment[name];
        const child = spawn(profile.executable, runtimeArgs(profile), { cwd: profile.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32', env: environment });
        let stdout = '', stderr = '', bytes = 0, reason, settled = false, stopDeadline;
        const stop = why => {
            if (reason) return;
            reason = why;
            void terminateTree(child);
            stopDeadline = setTimeout(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
                finish({status: 'interrupted', requiresRecovery: true, text: reason + '; process cleanup deadline reached, review local processes before recovery'});
            }, 12000);
        };
        const maxBytes = Math.min(profile.maxOutputBytes ?? 32000, 32000);
        const collect = which => chunk => { bytes += chunk.length; if (bytes > maxBytes) {
            stop('Output limit exceeded');
            return;
        } if (which === 'out')
            stdout += chunk.toString();
        else
            stderr += chunk.toString(); };
        child.stdout.on('data', collect('out'));
        child.stderr.on('data', collect('err'));
        const abort = () => stop('Cancelled or lease lost');
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop('Runtime limit exceeded'), Math.max(100, Math.min(profile.maxRuntimeMs ?? 300000, 3600000)));
        const finish = result => { if (settled)
            return; settled = true; clearTimeout(timer); clearTimeout(stopDeadline); signal?.removeEventListener('abort', abort); resolve(result); };
        child.once('error', () => finish({ status: 'failed', text: 'Runtime could not start' }));
        child.once('spawn', () => { try {
            onSpawn(child.pid);
        }
        catch {
            stop('Could not journal runtime PID');
        } });
        child.stdin.on('error', () => { });
        child.stdin.end(prompt + '\nFinal response must match the supplied JSON schema. status=completed only when every requested acceptance criterion is met; status=waiting_user for missing approval or permissions; status=failed for other unmet criteria. Include evidence in text.');
        const complete = code => {
            if (reason)
                return finish({ status: 'interrupted', text: reason });
            if (profile.adapter === 'codex')
                return finish(parseCodexResult(stdout, code));
            let text = stdout.trim(), status = code === 0 ? 'completed' : 'failed';
            let structured;
            if (profile.adapter === 'claude') {
                try {
                    const r = JSON.parse(text);
                    structured = r.structured_output ?? JSON.parse(r.result);
                    text = r.result ?? text;
                    if (r.is_error)
                        status = 'failed';
                    if (r.permission_denials?.length)
                        status = 'waiting_user';
                }
                catch {
                    status = 'failed';
                }
            }
            if (profile.adapter !== 'fixture') {
                if (structured && ['completed', 'failed', 'waiting_user'].includes(structured.status) && typeof structured.text === 'string') {
                    if (status === 'completed')
                        status = structured.status;
                    text = structured.text;
                }
                else {
                    status = 'failed';
                    text = 'Runtime did not return a valid structured completion result';
                }
            }
            if (!text) {
                status = 'failed';
                text = stderr.trim() || 'Runtime produced no captured result';
            }
            finish({ status, text });
        };
        child.once('exit', async code => {
            clearTimeout(timer);
            // Allow buffered final output to drain, then clean descendants even
            // when their inherited handles keep the close event from arriving.
            await new Promise(done => setTimeout(done, 200));
            await terminateTree(child);
            child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
            complete(code);
        });
    });
}
