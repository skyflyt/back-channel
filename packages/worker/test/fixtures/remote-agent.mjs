// A deterministic stand-in for an agent CLI on a remote-app run. Like claude/codex, it reads the prompt
// on stdin, starts the MCP server named in --mcp-config over stdio, and calls its tools. The scenario
// comes from a SCENARIO:<name> marker in the prompt. It prints what it saw as its final answer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const scenario = /SCENARIO:([a-z-]+)/.exec(input)?.[1] ?? 'happy';
const at = process.argv.indexOf('--mcp-config');
if (at < 0) { console.log(JSON.stringify({ error: 'no --mcp-config' })); process.exit(3); }
const { mcpServers } = JSON.parse(process.argv[at + 1]);
const [serverName] = Object.keys(mcpServers);
const server = mcpServers[serverName];
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
fs.writeFileSync(path.join(process.cwd(), 'agent-pid'), String(process.pid));
fs.writeFileSync(path.join(process.cwd(), 'mcp-pid'), String(child.pid));

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

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-agent', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const listed = await rpc('tools/list', {});
const out = { scenario, server: serverName, protocolVersion: init.result.protocolVersion, tools: listed.result.tools.map(t => t.name), steps: {} };
const steps = out.steps;
steps.sessions = await call('remote_sessions');
const appId = steps.sessions.session?.apps?.[0]?.appId;

if (scenario === 'happy') {
    steps.offList = await call('remote_open', { appId: 'app-regedit' });
    steps.open = await call('remote_open', { appId });
    const windowId = steps.open.windowId;
    steps.observe = await call('remote_observe', { windowId });
    steps.fill = await call('remote_act', { windowId, ref: 'e2', action: 'set_value', value: 'VALUE-MARKER-41' });
    steps.save = await call('remote_act', { windowId, ref: 'e1', action: 'invoke' });
    steps.key = await call('remote_act', { windowId, ref: 'e2', action: 'key', value: 'Enter' });
    steps.stale = await call('remote_act', { windowId, ref: 'e99', action: 'invoke' });
    steps.note = await call('remote_note', { text: 'NOTE-MARKER-77 filled in the memo' });
    steps.end = await call('remote_end', { summary: 'Filled in the memo and saved it.', finished: true });
    steps.after = await call('remote_observe', { windowId });
} else if (scenario === 'credential') {
    steps.open = await call('remote_open', { appId });
    const windowId = steps.open.windowId;
    steps.pin = await call('remote_act', { windowId, ref: 'e3', action: 'set_value', value: 'VALUE-MARKER-41' });
    steps.next = await call('remote_act', { windowId, ref: 'e1', action: 'invoke' });
    steps.end = await call('remote_end', { summary: 'Stopped at the PIN field and asked.', finished: false });
} else if (scenario === 'hang') {
    // Ignores every answer and keeps going, like an agent that won't stop: only the worker's kill ends it.
    steps.open = await call('remote_open', { appId });
    fs.writeFileSync(path.join(process.cwd(), 'agent-opened'), '1');
    for (;;) {
        steps.last = await call('remote_observe', { windowId: steps.open.windowId });
        await new Promise(resolve => setTimeout(resolve, 100));
    }
} else if (scenario === 'silent') {
    // Finishes without ending the session: the worker must end it.
    steps.open = await call('remote_open', { appId });
} else if (scenario === 'support-happy') {
    // A support session: one act is declined on the other PC, and the agent goes on with something else.
    steps.open = await call('remote_open', { appId });
    const windowId = steps.open.windowId;
    steps.observe = await call('remote_observe', { windowId });
    steps.fill = await call('remote_act', { windowId, ref: 'e2', action: 'set_value', value: 'VALUE-MARKER-41' });
    steps.declined = await call('remote_act', { windowId, ref: 'e6', action: 'invoke' });
    steps.print = await call('remote_act', { windowId, ref: 'e1', action: 'invoke' });
    steps.password = await call('remote_act', { windowId, ref: 'e4', action: 'set_value', value: 'VALUE-MARKER-41' });
    steps.note = await call('remote_note', { text: 'NOTE-MARKER-77 printed a test page' });
    steps.end = await call('remote_end', { summary: 'Printed a test page; they said no to removing the printer.', finished: true });
    steps.after = await call('remote_observe', { windowId });
}
child.stdin.end();
console.log(JSON.stringify(out));
process.exit(0);
