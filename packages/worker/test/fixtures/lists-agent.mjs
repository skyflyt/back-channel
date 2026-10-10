// A deterministic stand-in for an agent CLI on a lists run. Like claude/codex, it reads the prompt on stdin,
// starts the MCP server named in --mcp-config over stdio, and calls its tools. The scenario comes from a
// SCENARIO:<name> marker in the task's title (which reaches it as data in the prompt). It prints what it saw,
// with a marker the worker must never post anywhere.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let input = '';
for await (const chunk of process.stdin) input += chunk;
const scenario = /SCENARIO:([a-z-]+)/.exec(input)?.[1] ?? 'done';
const at = process.argv.indexOf('--mcp-config');
if (at < 0) { console.log(JSON.stringify({ error: 'no --mcp-config' })); process.exit(4); }
const { mcpServers } = JSON.parse(process.argv[at + 1]);
const [serverName] = Object.keys(mcpServers);
const server = mcpServers[serverName];
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const here = file => path.join(process.cwd(), file);
fs.writeFileSync(here('agent-pid'), String(process.pid));
fs.writeFileSync(here('mcp-pid'), String(child.pid));

let nextId = 0, buffer = '';
const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        waiting.get(message.id)?.(message);
    }
});
const rpc = (method, params) => new Promise(resolve => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args = {}) => {
    const message = await rpc('tools/call', { name, arguments: args });
    return { isError: message.result.isError, ...JSON.parse(message.result.content[0].text) };
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-agent', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const listed = await rpc('tools/list', {});
const out = { scenario, server: serverName, tools: listed.result.tools.map(t => t.name), steps: {}, raw: 'RAW-OUTPUT-MARKER' };
const steps = out.steps;
const finish = (code = 0) => { child.stdin.end(); console.log(JSON.stringify(out)); process.exit(code); };

if (scenario === 'done') {
    steps.progress = await call('task_progress', { text: 'PROGRESS-MARKER read the notes' });
    steps.secret = await call('task_progress', { text: `Found the key ${['AKIA', 'Q'.repeat(16)].join('')}` });
    steps.tooLong = await call('task_progress', { text: 'x'.repeat(501) });
    steps.comment = await call('task_comment', { text: 'COMMENT-MARKER which shelf?' });
    steps.done = await call('task_done', { summary: 'SUMMARY-MARKER put the books away', evidence: 'photo in the shared album' });
    steps.after = await call('task_progress', { text: 'one more thing' });
} else if (scenario === 'block') {
    steps.progress = await call('task_progress', { text: 'Looked for the garage code.' });
    steps.block = await call('task_block', { reason: 'BLOCK-MARKER needs the garage code' });
} else if (scenario === 'release') {
    steps.release = await call('task_release', { reason: 'RELEASE-MARKER not today' });
    steps.after = await call('task_comment', { text: 'anything' });
} else if (scenario === 'silent') {
    // Works a little, then exits without finishing: the worker must let the task go.
    steps.progress = await call('task_progress', { text: 'Started on it.' });
} else if (scenario === 'crash') {
    steps.progress = await call('task_progress', { text: 'Started on it.' });
    finish(3);
} else if (scenario === 'hang') {
    // Keeps running without a word, like an agent that won't stop: only the worker's kill ends it.
    steps.progress = await call('task_progress', { text: 'Started on it.' });
    fs.writeFileSync(here('agent-opened'), '1');
    for (;;) await sleep(100);
} else if (scenario === 'wait') {
    // Runs until the test says go.
    steps.progress = await call('task_progress', { text: 'Started on it.' });
    fs.writeFileSync(here('waiting'), '1');
    while (!fs.existsSync(here('go'))) await sleep(50);
    steps.done = await call('task_done', { summary: 'Waited for the go, then finished.' });
}
finish(0);
