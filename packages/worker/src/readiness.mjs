// PC readiness for agents (vault design pc-agent-readiness.md, "Shared contract"). What this worker can tell about
// whether one of your agents can drive an app on this PC, as non-secret JSON for the AppBridge owner console and the
// Back Channel dashboard, plus step 5: choosing which of your agents may hand this PC a session, trusting each one by
// comparing key fingerprints (never by trusting Back Channel's word for the keys).
//
// Nothing here ever prints or sends the agent key, a private key or another agent's secrets. The pipe probe is a v1
// `hello` and nothing else (no session op, never an executor secret). `claude auth status` runs with fixed arguments,
// no shell and a short timeout, and only its exit code is read.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { AgentControlClient } from './agent-control.mjs';
import { REMOTE_APP_PROFILE, validateRemoteAppProfile } from './remote-app.mjs';

export const READINESS_VERSION = 1;
/** `run` reports at start and then this often. Back Channel calls a report older than 30 minutes "not reporting". */
export const REPORT_EVERY_MS = 10 * 60_000;
export const FINGERPRINT = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
export const PIPE_STATES = Object.freeze(['listening', 'absent', 'refused', 'error']);
/** At most this many senders are listed; Back Channel takes no more. */
export const MAX_SENDERS = 32;
const PROBE_TIMEOUT_MS = 3000;
const CLAUDE_TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A failure the CLI prints as { error: code, message }. Messages are plain sentences with nothing secret in them. */
export class ReadinessError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ReadinessError(code, message); };

/** The worker's version, from its own package.json (bundled with it). */
export const WORKER_VERSION = (() => {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
        return typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(v) ? v : 'unknown';
    } catch { return 'unknown'; }
})();

/**
 * THE fingerprint, the one formula every side uses: uppercase hex SHA-256 of `signingKey + "\n" + encryptionKey`, the
 * agent's public Dispatch keys exactly as enrolled (the SPKI PEM strings Back Channel stores and lists), first 16 hex
 * characters in groups of 4: "AB12-CD34-EF56-7890". null without both keys.
 */
export function fingerprint(signingKey, encryptionKey) {
    if (typeof signingKey !== 'string' || !signingKey || typeof encryptionKey !== 'string' || !encryptionKey) return null;
    const hex = createHash('sha256').update(`${signingKey}\n${encryptionKey}`, 'utf8').digest('hex').toUpperCase();
    return hex.slice(0, 16).match(/.{4}/g).join('-');
}

/** A fingerprint as a person typed or pasted it: trimmed and uppercased. null unless it is XXXX-XXXX-XXXX-XXXX. */
export function normalizeFingerprint(value) {
    const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return FINGERPRINT.test(v) ? v : null;
}

/** Text without control characters, cut to max characters (a name from the broker or the PC). */
export function bounded(value, max) {
    const chars = [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/** The AppBridge agent-control pipe, greeted with a v1 hello and nothing else. Never rejects. */
export async function probeAgentControl({ path: target, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    // No executorSecret: this client can never send one.
    const client = new AgentControlClient({ path: target, timeoutMs });
    try {
        const r = await client.hello();
        return { pipe: PIPE_STATES.includes(r.pipe) ? r.pipe : 'error', hostName: r.hostName ? bounded(r.hostName, 80) || null : null, reason: r.reason ? bounded(r.reason, 300) : null };
    } finally {
        client.close();
    }
}

function pathValue(env, platform) {
    if (platform !== 'win32') return env.PATH ?? '';
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
    return key ? env[key] ?? '' : '';
}

/** A native `claude` executable on PATH (claude.exe on Windows: batch and PowerShell shims can't run without a shell). */
export function claudeOnPath({ env = process.env, platform = process.platform } = {}) {
    const name = platform === 'win32' ? 'claude.exe' : 'claude';
    const delimiter = platform === 'win32' ? ';' : ':';
    for (const dir of pathValue(env, platform).split(delimiter)) {
        // Absolute entries only: never the current directory.
        const clean = dir.trim().replace(/^"(.*)"$/, '$1');
        if (!clean || !(platform === 'win32' ? path.win32.isAbsolute(clean) : path.posix.isAbsolute(clean))) continue;
        const candidate = path.join(clean, name);
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch { }
    }
    return null;
}

/** The claude this worker would run: the remote-app profile's, if there is one, else the one on PATH. */
export function findClaude(config, options) {
    const exe = config?.profiles?.[REMOTE_APP_PROFILE]?.executable;
    if (typeof exe === 'string' && path.isAbsolute(exe)) return exe;
    return claudeOnPath(options);
}

/**
 * Is claude signed in? `claude auth status`: exit 0 is signed in, exit 1 is not, anything else can't be told (null).
 * Only the exit code is read: its output (which names the account) is discarded.
 */
export function claudeStatus(executable, { timeoutMs = CLAUDE_TIMEOUT_MS, execFileImpl = execFile } = {}) {
    const result = (installed, signedIn) => ({ adapter: 'claude', path: executable ?? null, installed, signedIn });
    if (!executable) return Promise.resolve(result(false, null));
    try { if (!fs.statSync(executable).isFile()) return Promise.resolve(result(false, null)); }
    catch { return Promise.resolve(result(false, null)); }
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('BC_')) delete env[name];
    return new Promise(resolve => {
        let child;
        try {
            child = execFileImpl(executable, ['auth', 'status'], { shell: false, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env }, error => {
                if (!error) return resolve(result(true, true));
                if (error.code === 'ENOENT') return resolve(result(false, null));
                // A number is the exit code; a timeout, a signal or a spawn error leaves it unknown.
                resolve(result(true, error.code === 1 && !error.killed ? false : null));
            });
        } catch { return resolve(result(true, null)); }
        child?.stdin?.end();
    });
}

/**
 * The readiness object (the contract's `bc-worker readiness`). Local and complete: the AppBridge console reads it.
 * `probe` and `runtime` are injectable for tests.
 */
export async function collectReadiness({ config, pipePath, probe = probeAgentControl, runtime = claudeStatus, now = () => new Date() }) {
    const enrolled = typeof config.agentId === 'string' && UUID.test(config.agentId);
    const [pipe, claude] = await Promise.all([probe({ path: pipePath }), runtime(findClaude(config))]);
    const profile = config.profiles?.[REMOTE_APP_PROFILE];
    const senders = Array.isArray(profile?.allowedSenders) ? [...new Set(profile.allowedSenders.filter(id => typeof id === 'string' && UUID.test(id)))] : [];
    return {
        v: READINESS_VERSION,
        agentId: enrolled ? config.agentId : null,
        name: bounded(config.name, 80),
        enrolled,
        fingerprint: enrolled ? fingerprint(config.identity?.signingKey, config.identity?.encryptionKey) : null,
        workerVersion: WORKER_VERSION,
        appbridge: { pipe: pipe.pipe, hostName: pipe.hostName ?? null, reason: pipe.reason ?? null },
        runtime: { adapter: 'claude', path: claude.path ?? null, installed: claude.installed === true, signedIn: typeof claude.signedIn === 'boolean' ? claude.signedIn : null },
        profiles: { remoteApp: { present: !!profile, senders: senders.slice(0, MAX_SENDERS).map(id => ({
            agentId: id, name: typeof config.senderNames?.[id] === 'string' ? bounded(config.senderNames[id], 80) || null : null, pinned: !!config.peers?.[id],
        })) } },
        checkedAt: now().toISOString(),
    };
}

/**
 * What goes to Back Channel: the same object, with the three local-only strings left out (null). Back Channel keeps
 * no free text from the PC beyond its name and the worker's: not the claude path, not the pipe's reason, not the
 * senders' names (it knows its own agents' names).
 */
export function reportOf(readiness) {
    return {
        ...readiness,
        appbridge: { ...readiness.appbridge, reason: null },
        runtime: { ...readiness.runtime, path: null },
        profiles: { remoteApp: { ...readiness.profiles.remoteApp, senders: readiness.profiles.remoteApp.senders.map(s => ({ ...s, name: null })) } },
    };
}

/** PUT /api/agents/self/readiness. Resolves { ok, status }; never throws (status 0: Back Channel unreachable). */
export async function sendReport(client, readiness) {
    try {
        const { status } = await client.reportReadiness(reportOf(readiness));
        return { ok: status >= 200 && status < 300, status };
    } catch { return { ok: false, status: 0 }; }
}

/**
 * `run`: report at start and every 10 minutes. A failed report is logged (never with anything secret) and the run
 * carries on. stop() ends it.
 */
export function startReadinessReports({ config, client, pipePath, everyMs = REPORT_EVERY_MS, collect = collectReadiness, log = () => { } }) {
    let stopped = false, running = null;
    const once = () => {
        if (stopped || running) return running;
        running = (async () => {
            try {
                const r = await sendReport(client, await collect({ config, pipePath }));
                if (!r.ok) log(r.status ? `Readiness report not accepted by Back Channel (HTTP ${r.status}); the worker carries on.` : "Couldn't reach Back Channel to report readiness; the worker carries on.");
            } catch { log("Couldn't check readiness; the worker carries on."); }
        })().finally(() => { running = null; });
        return running;
    };
    const first = once();
    // Through globalThis, never as a method of another object.
    const timer = globalThis.setInterval(() => { once(); }, everyMs);
    timer.unref?.();
    return { first, stop() { stopped = true; globalThis.clearInterval(timer); } };
}

// ── Step 5: which of your agents may hand this PC a session ──────────────────────────────────────────────────────

function requireEnrolled(config) {
    if (!config.agentId) fail('not_enrolled', 'This worker is not enrolled for Dispatch yet. Run enroll first.');
}

async function dispatchAgents(client) {
    let reply;
    try { reply = await client.request('/agents'); }
    catch (e) {
        if (e.status === 401) fail('unauthorized', "Back Channel refused this worker's agent key. It may have been revoked.");
        if (e.status === 403) fail('not_allowed', "Back Channel won't list agents for this key: it needs a full agent key enrolled for Dispatch.");
        fail('unreachable', "Couldn't reach Back Channel to list your agents. Try again in a minute.");
    }
    return Array.isArray(reply?.agents) ? reply.agents.filter(a => a && typeof a.id === 'string' && UUID.test(a.id)) : [];
}

/** `bc-worker candidates`: your other Dispatch-enrolled agents, with fingerprints, and whether each is pinned and allowed. */
export async function candidates({ config, client }) {
    requireEnrolled(config);
    const allowed = new Set(config.profiles?.[REMOTE_APP_PROFILE]?.allowedSenders ?? []);
    const agents = (await dispatchAgents(client)).filter(a => a.id !== config.agentId);
    return {
        agents: agents.map(a => ({
            agentId: a.id, name: bounded(a.name ?? '', 80) || null, fingerprint: fingerprint(a.signingKey, a.encryptionKey),
            pinned: !!config.peers?.[a.id], allowed: allowed.has(a.id),
        })),
    };
}

/**
 * `bc-worker allow-sender --id ID --fingerprint FP [--claude PATH]`: refuses unless the agent's keys, fetched from Back
 * Channel and fingerprinted here, match the fingerprint the person confirmed by comparing; then pins the agent and adds
 * it to the remote-app profile's allowedSenders, creating that profile with defaults when there is none.
 */
export async function allowSender({ store, config, client, id, fingerprint: given, claude, claudeLookup = claudeOnPath }) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('invalid_id', '--id must be an agent id (a UUID), from candidates.');
    const want = normalizeFingerprint(given);
    if (!want) fail('invalid_fingerprint', '--fingerprint must look like AB12-CD34-EF56-7890: the one shown for that agent on its own PC.');
    if (claude !== undefined && (typeof claude !== 'string' || !path.isAbsolute(claude))) fail('invalid_claude', '--claude must be the full path to claude.');
    requireEnrolled(config);
    if (id === config.agentId) fail('self', 'That is this worker itself. Choose one of your other agents.');
    const agent = (await dispatchAgents(client)).find(a => a.id === id);
    if (!agent) fail('not_found', "That agent isn't one of your agents enrolled for Dispatch.");
    const actual = fingerprint(agent.signingKey, agent.encryptionKey);
    if (actual !== want) fail('fingerprint_mismatch', "The fingerprint doesn't match the keys Back Channel lists for that agent. Don't allow it: check you compared the right agent, on its own PC.");
    const keys = { encryptionKey: agent.encryptionKey, signingKey: agent.signingKey };
    const pin = config.peers?.[id];
    if (pin && (pin.encryptionKey !== keys.encryptionKey || pin.signingKey !== keys.signingKey))
        fail('pin_differs', 'This PC already pinned different keys for that agent. Changing a pin needs an explicit manual key rotation.');
    const existing = config.profiles?.[REMOTE_APP_PROFILE];
    let profile, created = false;
    if (existing) {
        const senders = Array.isArray(existing.allowedSenders) ? existing.allowedSenders : [];
        profile = { ...existing, allowedSenders: senders.includes(id) ? senders : [...senders, id] };
    } else {
        const executable = claude ?? claudeLookup();
        if (!executable) fail('claude_not_found', "Couldn't find claude on this PC. Install Claude Code, or pass --claude with its full path.");
        // An empty folder beside the state (never inside it: the agent must not see the worker's keys).
        const cwd = path.join(path.dirname(store.directory), 'remote-app');
        fs.mkdirSync(cwd, { recursive: true });
        profile = { adapter: 'claude', executable, cwd, allowedSenders: [id], permissionMode: 'plan', maxRuntimeMs: 3600000 };
        created = true;
    }
    try { validateRemoteAppProfile(profile); }
    catch (e) { fail('invalid_profile', `The remote-app profile isn't usable: ${e.message}.`); }
    const name = bounded(agent.name ?? '', 80) || null;
    config.peers = { ...config.peers, [id]: keys };
    config.profiles = { ...config.profiles, [REMOTE_APP_PROFILE]: profile };
    config.senderNames = { ...config.senderNames, ...(name ? { [id]: name } : {}) };
    store.write('config', config);
    return { agentId: id, name, fingerprint: actual, pinned: true, allowed: true, profileCreated: created };
}

/**
 * `bc-worker revoke-sender --id ID`: removes the agent from the remote-app profile's allowedSenders, and unpins it
 * when no other profile names it.
 */
export function revokeSender({ store, config, id }) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('invalid_id', '--id must be an agent id (a UUID).');
    const profiles = { ...config.profiles };
    const profile = profiles[REMOTE_APP_PROFILE];
    if (profile && Array.isArray(profile.allowedSenders)) profiles[REMOTE_APP_PROFILE] = { ...profile, allowedSenders: profile.allowedSenders.filter(s => s !== id) };
    const elsewhere = Object.entries(profiles).some(([n, p]) => n !== REMOTE_APP_PROFILE && Array.isArray(p?.allowedSenders) && p.allowedSenders.includes(id));
    config.profiles = profiles;
    if (!elsewhere) {
        const { [id]: _peer, ...peers } = config.peers ?? {};
        const { [id]: _name, ...names } = config.senderNames ?? {};
        config.peers = peers;
        config.senderNames = names;
    }
    store.write('config', config);
    return { agentId: id, allowed: false, pinned: !!config.peers?.[id] };
}
