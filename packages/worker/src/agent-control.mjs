// Client for the AppBridge host's local agent-control pipe (contract: "Agent control — local IPC
// contract v1"), and for the support connector's pipe, which speaks the same JSON across the support
// relay to the helper on another PC (support relay contract v1 §4-§5). Newline-delimited UTF-8 JSON,
// one request then one response per line, each carrying a client-chosen id. Zero dependencies:
// node:net speaks Windows named pipes and Unix sockets alike, so tests inject a socket path and run
// on Linux CI.
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const PIPE_PREFIX = '\\\\.\\pipe\\AppBridge.AgentControl.v1.';
/** The issuer connector's pipe (support relay contract §5): it bridges this pipe to the helper on the other PC. */
export const SUPPORT_PIPE_PREFIX = '\\\\.\\pipe\\AppBridge.SupportConnector.v1.';
export const ACT_ACTIONS = Object.freeze(['invoke', 'set_value', 'toggle', 'select', 'scroll', 'key']);
export const REFUSALS = Object.freeze(['credential_field', 'not_in_scope', 'needs_user', 'fail_closed']);
/**
 * The support relay adds one outcome (contract §4.2): the person at the other PC said no, or didn't answer
 * within 60 s. Only the support connector's client keeps it; to a Phase A client it is still fail_closed.
 */
export const SUPPORT_REFUSALS = Object.freeze([...REFUSALS, 'declined']);
// The bounded key vocabulary (WORKSPACE-CONTRACT "Bounded input extension"; the broker's KEY_NAMES).
export const KEY_NAMES = Object.freeze([
    'Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
export const AGENT_CONTROL_OFF = 'Allow agent control is off on this PC';
export const SUPPORT_CONNECTOR_OFF = "The support connector isn't running on this PC. Turn on 'Allow this PC to reach helpers I approve' in AppBridge.";
export const TIMEOUT_MS = 30000;
/** The helper waits up to 60 s for the person's yes or no (contract §4.1), so a support request gets longer. */
export const SUPPORT_TIMEOUT_MS = 90000;
// What a v1 AppBridge host answers to a hello it doesn't understand (AgentControlContract.Malformed). A v1 host
// checks no secret at all, so on exactly this answer the agent-control client may greet once more without one.
export const V1_MALFORMED = "That request isn't valid for agent control v1.";
const MAX_MESSAGE = 1024 * 1024;
// v1.1 (contract §5): `abx_` and 43 base64url characters, issued by Back Channel once per session.
const EXECUTOR_SECRET = /^abx_[A-Za-z0-9_-]{43}$/;
/** Is this an executor secret's shape? Never echo the value in an error. */
export const isExecutorSecret = value => typeof value === 'string' && EXECUTOR_SECRET.test(value);
const DEFAULT_REASONS = {
    credential_field: "That's a password field, and agents never type passwords.",
    not_in_scope: "That's outside the apps approved for this session.",
    needs_user: 'This needs the person at the PC.',
    fail_closed: 'Something unexpected came up.',
    declined: 'The person at the other PC said no.',
};
const AGENT_CONTROL_WORDS = Object.freeze({
    off: AGENT_CONTROL_OFF,
    find: "Couldn't find this PC's agent control.",
    slow: "The PC's agent control didn't answer in time.",
    connect: "Couldn't connect to this PC's agent control.",
    version: "This PC's agent control speaks a different version.",
});
const SUPPORT_WORDS = Object.freeze({
    off: SUPPORT_CONNECTOR_OFF,
    find: "Couldn't find this PC's support connector.",
    slow: "This PC's support connector didn't answer in time.",
    connect: "Couldn't connect to this PC's support connector.",
    version: "This PC's support connector speaks a different version.",
});

export function refusal(outcome, reason) {
    return { ok: false, outcome, reason };
}

/** The SID in `whoami /user /fo csv /nh` output. */
export function parseSid(text) {
    const match = /\bS-1-[0-9]+(?:-[0-9]+)+\b/.exec(String(text));
    if (!match) throw Error('Could not read the current user SID');
    return match[0];
}

let sid;
/** The current user's SID, resolved once per process with System32's whoami (never a PATH lookup). */
export function currentUserSid() {
    sid ??= new Promise((resolve, reject) => {
        const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
        execFile(whoami, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
            if (error) return reject(Error('Could not read the current user SID'));
            try { resolve(parseSid(stdout)); } catch (e) { reject(e); }
        });
    });
    sid.catch(() => { sid = undefined; });
    return sid;
}

/** \\.\pipe\AppBridge.AgentControl.v1.<current user SID> */
export async function defaultPipePath() {
    if (process.platform !== 'win32') throw Error('The AppBridge agent-control pipe exists only on Windows');
    return PIPE_PREFIX + await currentUserSid();
}

/** \\.\pipe\AppBridge.SupportConnector.v1.<current user SID> */
export async function defaultSupportPipePath() {
    if (process.platform !== 'win32') throw Error('The AppBridge support connector pipe exists only on Windows');
    return SUPPORT_PIPE_PREFIX + await currentUserSid();
}

function bounded(text, max) {
    const chars = [...String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/**
 * One connection to the host, opened lazily, greeted with `hello`, and reopened after it closes.
 * Every method resolves (never rejects) with the host's response when ok, or a refusal
 * `{ ok: false, outcome, reason }` using the contract's four outcomes. A missing pipe is the
 * host's "Allow agent control" switch being off: `needs_user`, "Allow agent control is off on this PC".
 *
 * v1.1: given the session's executor secret, every `hello` carries it (and nothing else does). A v1
 * host refuses the unknown field, so it is sent only when the sealed payload carried one.
 */
export class AgentControlClient {
    #executorSecret;
    #v1Fallback;
    #omitSecret = false;
    constructor({ path: target, timeoutMs = TIMEOUT_MS, executorSecret, refusals = REFUSALS, words = AGENT_CONTROL_WORDS, v1Fallback = true } = {}) {
        if (executorSecret !== undefined && !isExecutorSecret(executorSecret)) throw Error('Invalid executor secret');
        this.target = target ?? defaultPipePath;
        this.timeoutMs = timeoutMs;
        this.#executorSecret = executorSecret;
        // Phase A rollout: a host not yet on v1.1 refuses the secret field. The support connector is
        // v1.1 from its first release and always requires the secret, so it never falls back.
        this.#v1Fallback = v1Fallback;
        this.refusals = refusals;
        this.words = words;
        this.pending = new Map();
        this.nextId = 0;
        this.socket = null;
        this.connecting = null;
        this.closed = false;
    }
    async #open() {
        let where;
        try { where = typeof this.target === 'function' ? await this.target() : this.target; }
        catch { throw refusal('fail_closed', this.words.find); }
        const socket = await new Promise((resolve, reject) => {
            const s = net.connect(where);
            const timer = setTimeout(() => { s.destroy(); reject(refusal('fail_closed', this.words.slow)); }, this.timeoutMs);
            s.once('connect', () => { clearTimeout(timer); s.removeAllListeners('error'); resolve(s); });
            s.once('error', error => {
                clearTimeout(timer);
                // A named pipe that doesn't exist is ENOENT; a stale Unix socket is ECONNREFUSED.
                reject(['ENOENT', 'ECONNREFUSED'].includes(error.code)
                    ? refusal('needs_user', this.words.off)
                    : refusal('fail_closed', this.words.connect));
            });
        });
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            let index;
            while ((index = buffer.indexOf(10)) >= 0) {
                const line = buffer.subarray(0, index).toString('utf8');
                buffer = buffer.subarray(index + 1);
                if (index > MAX_MESSAGE) return this.#drop(socket, 'The PC sent a message larger than 1 MiB.');
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                const waiter = message && typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
                // Unknown ids (a late answer after a timeout dropped the connection) are ignored.
                if (waiter && waiter.socket === socket) waiter.resolve(message);
            }
            if (buffer.length > MAX_MESSAGE) this.#drop(socket, 'The PC sent a message larger than 1 MiB.');
        });
        socket.on('error', () => {});
        socket.on('close', () => this.#drop(socket, 'The connection to the PC closed.'));
        this.socket = socket;
        const withSecret = !!this.#executorSecret && !this.#omitSecret;
        const greeting = { op: 'hello', version: 1, ...(withSecret ? { executorSecret: this.#executorSecret } : {}) };
        const hello = normalize(await this.#send(socket, greeting), this.refusals);
        if (!hello.ok && withSecret && this.#v1Fallback && hello.outcome === 'fail_closed' && hello.reason === V1_MALFORMED) {
            // A v1 host: it checks no secret, so greeting it without one gives nothing away. Once, on a fresh connection.
            this.#omitSecret = true;
            this.#drop(socket);
            return this.#open();
        }
        if (!hello.ok) { this.#drop(socket); throw hello; }
        if (hello.version !== 1) { this.#drop(socket); throw refusal('fail_closed', this.words.version); }
        if (hello.agentControl !== true) { this.#drop(socket); throw refusal('needs_user', this.words.off); }
        this.host = hello.host && typeof hello.host.name === 'string' ? { name: bounded(hello.host.name, 120) } : null;
        return socket;
    }
    #drop(socket, reason = 'The connection to the PC closed.') {
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        for (const [id, waiter] of this.pending)
            if (waiter.socket === socket) { this.pending.delete(id); waiter.resolve(refusal('fail_closed', reason)); }
    }
    #send(socket, request) {
        const id = String(++this.nextId);
        const line = JSON.stringify({ id, ...request }) + '\n';
        if (Buffer.byteLength(line) > MAX_MESSAGE) return Promise.resolve(refusal('fail_closed', 'That request is larger than 1 MiB.'));
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                // An unanswered request leaves the host's state unknown: drop the connection so a late
                // answer can never be matched to anything, and fail closed.
                this.#drop(socket, `The PC didn't answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
            }, this.timeoutMs);
            this.pending.set(id, { socket, resolve: message => { clearTimeout(timer); this.pending.delete(id); resolve(message); } });
            socket.write(line);
        });
    }
    async request(op, fields = {}) {
        if (this.closed) return refusal('fail_closed', 'The connection to the PC is closed.');
        let socket;
        try {
            socket = this.socket && !this.socket.destroyed ? this.socket : await (this.connecting ??= this.#open().finally(() => { this.connecting = null; }));
        } catch (error) {
            return error && error.ok === false ? error : refusal('fail_closed', this.words.connect);
        }
        return normalize(await this.#send(socket, { op, ...fields }), this.refusals);
    }
    sessions() { return this.request('sessions'); }
    open(sessionId, appId) { return this.request('open', { sessionId, appId }); }
    observe(sessionId, windowId) { return this.request('observe', { sessionId, windowId }); }
    act(sessionId, windowId, ref, action, value) {
        return this.request('act', { sessionId, windowId, ref, action, ...(value === undefined ? {} : { value }) });
    }
    end(sessionId) { return this.request('end', { sessionId }); }
    close() {
        this.closed = true;
        if (this.socket) this.#drop(this.socket, 'The connection to the PC is closed.');
    }
}

/**
 * The support connector's pipe (contract §5): the same client, on \\.\pipe\AppBridge.SupportConnector.v1.<SID>,
 * which always needs the session's executor secret in `hello`, keeps `declined`, and waits long enough for the
 * person at the other PC to answer. A missing pipe is the connector being off: `needs_user`, SUPPORT_CONNECTOR_OFF.
 */
export class SupportConnectorClient extends AgentControlClient {
    constructor({ path: target, timeoutMs = SUPPORT_TIMEOUT_MS, executorSecret } = {}) {
        if (!isExecutorSecret(executorSecret)) throw Error("The support connector needs the session's executor secret");
        super({ path: target ?? defaultSupportPipePath, timeoutMs, executorSecret, refusals: SUPPORT_REFUSALS, words: SUPPORT_WORDS, v1Fallback: false });
    }
}

/** Never "best effort": anything but a well-formed ok answer is one of the refusals (the four of v1, by default). */
export function normalize(response, refusals = REFUSALS) {
    if (!response || typeof response !== 'object' || Array.isArray(response))
        return refusal('fail_closed', 'The PC sent an answer that could not be read.');
    if (response.ok === true && (response.outcome === undefined || response.outcome === 'ok')) return response;
    const outcome = refusals.includes(response.outcome) ? response.outcome : 'fail_closed';
    const reason = typeof response.reason === 'string' && response.reason.trim() ? bounded(response.reason, 300) : DEFAULT_REASONS[outcome];
    return refusal(outcome, reason);
}
