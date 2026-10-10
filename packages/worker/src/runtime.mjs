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
    for (const [name, maximum] of [['maxRuntimeMs', 3600000], ['maxOutputBytes', 32000], ['maxTranscriptBytes', 4 * 1024 * 1024]]) {
        if (p[name] !== undefined && (!Number.isSafeInteger(p[name]) || p[name] < 1 || p[name] > maximum))
            throw Error(`Invalid profile ${name}; expected positive integer at most ${maximum}`);
    }
    return p;
}
// Tools a remote-app (or remote-support) run refuses outright on Claude: shell, file writes, the web, and also
// file reads and subagents. Read, Grep, Glob and Agent need no approval in any permission mode, so without these a
// run steered by something on screen could read the PC's files into its summary. Its only capability is the worker's
// own MCP server. (No MultiEdit: current Claude Code has no such tool, and a deny rule naming none warns.)
export const REMOTE_APP_DISALLOWED_TOOLS = Object.freeze(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read', 'Grep', 'Glob', 'Agent']);
const tomlString = value => {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid MCP server setting');
    return JSON.stringify(value); // a JSON string without control characters is a TOML basic string
};
const mcpServers = mcp => ({ [mcp.name]: { type: 'stdio', command: mcp.command, args: mcp.args } });
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * Fixed adapter arguments. `mcp` is set only by the worker's remote-app and lists profiles: the worker's own
 * stdio MCP server ({ name, command, args }, all chosen by the worker, never by a task). On Claude, `allowTools`
 * and `denyTools` (fixed lists chosen by the worker from the local profile) replace the remote-app defaults:
 * only the worker's server pre-approved, and shell, file writes and the web refused.
 */
export function runtimeArgs(p, { mcp } = {}) {
    if (mcp && !/^[a-z][a-z0-9_]{0,31}$/.test(mcp.name)) throw Error('Invalid MCP server name');
    const allow = [`mcp__${mcp?.name}`, ...(mcp?.allowTools ?? [])], deny = mcp?.denyTools ?? REMOTE_APP_DISALLOWED_TOOLS;
    if (mcp && ![...allow.slice(1), ...deny].every(name => TOOL_NAME.test(name))) throw Error('Invalid tool name');
    if (p.adapter === 'codex') {
        const args = ['exec', '--sandbox', p.sandbox ?? 'read-only', '--json', '--output-schema', path.join(import.meta.dirname, 'runtime-result.schema.json')];
        // Replaces the whole mcp_servers table: the run sees only the worker's server.
        if (mcp) args.push('-c', `mcp_servers={${mcp.name}={command=${tomlString(mcp.command)},args=[${mcp.args.map(tomlString).join(',')}]}}`);
        return [...args, '-'];
    }
    if (p.adapter === 'claude') {
        const args = ['--print', '--output-format', 'json', '--permission-mode', p.permissionMode ?? 'plan', '--json-schema', JSON.stringify(resultSchema)];
        if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: mcpServers(mcp) }), '--strict-mcp-config',
            '--allowedTools', allow.join(','), ...(deny.length ? ['--disallowedTools', deny.join(',')] : []));
        return args;
    }
    return mcp ? [p.fixtureScript, '--mcp-config', JSON.stringify({ mcpServers: mcpServers(mcp) })] : [p.fixtureScript];
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
/**
 * Another process's name and command line, to check a PID before acting on it (bc-worker stop). Windows: the same
 * Win32_Process query terminateTree uses. Elsewhere: /proc (with its working directory), or ps. null when unreadable.
 */
export async function processInfo(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (process.platform === 'win32') {
        const script = `[void][Reflection.Assembly]::LoadWithPartialName('System.Management'); $q=New-Object System.Management.ManagementObjectSearcher('SELECT Name,CommandLine FROM Win32_Process WHERE ProcessId=${pid}'); foreach($row in @($q.Get())) { $j=(@{ name=[string]$row['Name']; commandLine=[string]$row['CommandLine'] } | ConvertTo-Json -Compress); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }`;
        const out = (await runtimeHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).trim();
        try {
            const info = JSON.parse(Buffer.from(out, 'base64').toString('utf8'));
            return typeof info?.commandLine === 'string' && info.commandLine ? { name: String(info.name ?? ''), commandLine: info.commandLine } : null;
        } catch { return null; }
    }
    try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        let cwd;
        try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { }
        if (argv.length) return { name: path.basename(argv[0]), argv, cwd };
    } catch { }
    const args = (await runtimeHelper('ps', ['-ww', '-o', 'args=', '-p', String(pid)])).trim();
    return args ? { name: path.basename(args.split(/\s+/)[0]), argv: args.split(/\s+/) } : null;
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
export function runRuntime(profile, prompt, { signal, onSpawn = () => { }, mcp } = {}) {
    validateProfile(profile);
    const args = runtimeArgs(profile, { mcp });
    return new Promise(resolve => {
        if (signal?.aborted)
            return resolve({ status: 'interrupted', text: 'Cancelled before launch' });
        const environment = { ...process.env };
        for (const name of Object.keys(environment))
            if (name.startsWith('BC_'))
                delete environment[name];
        const child = spawn(profile.executable, args, { cwd: profile.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32', env: environment });
        const stdoutChunks = [], stderrChunks = [];
        let bytes = 0, reason, settled = false, stopDeadline;
        const stop = why => {
            if (reason) return;
            reason = why;
            void terminateTree(child);
            stopDeadline = setTimeout(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
                finish({status: 'interrupted', requiresRecovery: true, text: reason + '; process cleanup deadline reached, review local processes before recovery'});
            }, 12000);
        };
        const maxResultBytes = profile.maxOutputBytes ?? 32000;
        // CLI progress/tool events are transport, not the final result. Keep
        // their combined stdout/stderr budget finite without shrinking reports.
        const maxBytes = profile.adapter === 'fixture'
            ? maxResultBytes : profile.maxTranscriptBytes ?? 1024 * 1024;
        const collect = which => chunk => {
            if (reason || settled) return;
            if (chunk.length > maxBytes - bytes) {
                stop(profile.adapter === 'fixture' ? 'Output limit exceeded' : 'Transcript limit exceeded');
                return;
            }
            bytes += chunk.length;
            (which === 'out' ? stdoutChunks : stderrChunks).push(Buffer.from(chunk));
        };
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
            // Decode after collecting bytes so a UTF-8 character split across
            // pipe chunks is preserved and measured accurately in the result.
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            const finishResult = result => finish(Buffer.byteLength(result.text, 'utf8') > maxResultBytes
                ? {status: 'failed', text: 'Final result limit exceeded'} : result);
            if (profile.adapter === 'codex')
                return finishResult(parseCodexResult(stdout, code));
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
            finishResult({ status, text });
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
