// A worker-owned MCP server for an agent CLI, and the private bridge back to the worker.
//
// The MCP server is a small stdio process the CLI starts. It holds no key and no state: each tool call is
// forwarded over a private local bridge (a random named pipe, or a Unix socket in a private directory, plus a
// random 256-bit nonce, both chosen by the worker for one run) to the worker process that launched the CLI.
// The worker does every check and every call to Back Channel with its own key.
//
// The lists profile (lists.mjs, lists-mcp.mjs) uses this module. The remote-app profile (remote-app.mjs,
// remote-app-mcp.mjs) keeps its own copy of the same pattern.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_LINE = 4 * 1024 * 1024;
const MAX_BRIDGE_BUFFER = 1024 * 1024;

/**
 * The worker's end: listen on a fresh private pipe or socket, answer only lines carrying the nonce, and only for
 * the named tools. `handle(tool, args)` returns (a promise of) the answer object.
 */
export async function startBridge(handle, { tools, label = 'bc-worker' }) {
    const allowed = new Set(tools);
    const nonce = randomBytes(32).toString('hex');
    const expected = Buffer.from(nonce);
    let directory, where;
    if (process.platform === 'win32') where = `\\\\.\\pipe\\${label}-${randomBytes(16).toString('hex')}`;
    else {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
        fs.chmodSync(directory, 0o700);
        where = path.join(directory, 'bridge.sock');
    }
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > MAX_BRIDGE_BUFFER) return socket.destroy();
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                let message;
                try { message = JSON.parse(line); } catch { return socket.destroy(); }
                const given = Buffer.from(typeof message?.nonce === 'string' ? message.nonce : '');
                if (given.length !== expected.length || !timingSafeEqual(given, expected)) return socket.destroy();
                if (typeof message.id !== 'string') continue;
                const args = message.args && typeof message.args === 'object' && !Array.isArray(message.args) ? message.args : {};
                const answer = allowed.has(message.tool) ? handle(message.tool, args) : { ok: false, outcome: 'invalid_request', reason: 'Unknown tool.' };
                Promise.resolve(answer)
                    .catch(() => ({ ok: false, outcome: 'fail_closed', reason: 'Something unexpected went wrong in the worker.' }))
                    .then(value => { if (!socket.destroyed) socket.write(JSON.stringify({ id: message.id, result: value }) + '\n'); });
            }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(where, resolve); });
    return {
        path: where,
        nonce,
        close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            if (directory) fs.rmSync(directory, { recursive: true, force: true });
        },
    };
}

/** The MCP server's end of the bridge: newline-delimited JSON, one connection, ids per call. */
export class BridgeClient {
    constructor(where, nonce, { timeoutMs = 110000, unavailable }) {
        Object.assign(this, { where, nonce, timeoutMs, unavailable, pending: new Map(), nextId: 0 });
    }
    connect() {
        if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
        return this.connecting ??= new Promise((resolve, reject) => {
            const socket = net.connect(this.where);
            socket.once('connect', () => { socket.removeAllListeners('error'); socket.on('error', () => {}); resolve(socket); });
            socket.once('error', reject);
            let buffer = '';
            socket.setEncoding('utf8');
            socket.on('data', chunk => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    let message;
                    try { message = JSON.parse(line); } catch { continue; }
                    this.pending.get(message?.id)?.(message.result);
                }
                if (buffer.length > MAX_LINE) socket.destroy();
            });
            socket.on('close', () => {
                if (this.socket === socket) this.socket = null;
                for (const finish of this.pending.values()) finish(this.unavailable);
            });
            this.socket = socket;
        }).finally(() => { this.connecting = null; });
    }
    async call(tool, args) {
        let socket;
        try { socket = await this.connect(); } catch { return this.unavailable; }
        const id = String(++this.nextId);
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(this.unavailable), this.timeoutMs);
            const finish = result => { clearTimeout(timer); this.pending.delete(id); resolve(result && typeof result === 'object' ? result : this.unavailable); };
            this.pending.set(id, finish);
            socket.write(JSON.stringify({ nonce: this.nonce, id, tool, args }) + '\n');
        });
    }
    close() { this.socket?.destroy(); }
}

/**
 * Serve MCP (JSON-RPC 2.0, newline-delimited) on stdio until stdin closes: initialize, ping, tools/list and
 * tools/call for exactly `tools`, each call forwarded to the worker.
 */
export function serveMcp({ bridge: where, nonce, tools, serverInfo, instructions, unavailable, timeoutMs, input = process.stdin, output = process.stdout }) {
    const names = tools.map(t => t.name);
    const bridge = new BridgeClient(where, nonce, { timeoutMs, unavailable });
    const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const handle = async message => {
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
            if (message && typeof message === 'object' && 'id' in message) send({ id: message.id ?? null, error: { code: -32600, message: 'Invalid request' } });
            return;
        }
        const { id, method, params } = message;
        if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no answer
        if (method === 'initialize') {
            const requested = params?.protocolVersion;
            return send({ id, result: {
                protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo,
                instructions,
            } });
        }
        if (method === 'ping') return send({ id, result: {} });
        if (method === 'tools/list') return send({ id, result: { tools } });
        if (method === 'tools/call') {
            const name = params?.name;
            if (!names.includes(name)) return send({ id, error: { code: -32602, message: `Unknown tool: ${String(name).slice(0, 64)}` } });
            const args = params.arguments ?? {};
            if (!args || typeof args !== 'object' || Array.isArray(args)) return send({ id, error: { code: -32602, message: 'Arguments must be an object' } });
            const result = await bridge.call(name, args);
            return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.ok === false } });
        }
        send({ id, error: { code: -32601, message: `Method not found: ${method.slice(0, 64)}` } });
    };
    let buffer = '';
    input.setEncoding('utf8');
    input.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try { message = JSON.parse(line); }
            catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
            handle(message).catch(() => send({ id: message.id ?? null, error: { code: -32603, message: 'Internal error' } }));
        }
        if (buffer.length > MAX_LINE) { buffer = ''; send({ id: null, error: { code: -32700, message: 'Message too large' } }); }
    });
    return new Promise(resolve => input.once('end', () => { bridge.close(); resolve(); }));
}

/** Is the module at `url` the process's main module? Node resolves it through realpath (case-insensitive on Windows). */
export function isMain(url) {
    try {
        const self = fileURLToPath(url), started = fs.realpathSync(process.argv[1] ?? '');
        return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
    } catch { return false; }
}

/** `--bridge <path> --nonce <64 hex>`, as written by the worker; null when they are missing or malformed. */
export function bridgeArgs(argv = process.argv.slice(2)) {
    try {
        const { values } = parseArgs({ args: argv, options: { bridge: { type: 'string' }, nonce: { type: 'string' } } });
        return values.bridge && /^[0-9a-f]{64}$/.test(values.nonce ?? '') ? { bridge: values.bridge, nonce: values.nonce } : null;
    } catch { return null; }
}
