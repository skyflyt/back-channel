// PC readiness for agents (vault design pc-agent-readiness.md, "Shared contract"): bc-worker readiness, candidates,
// allow-sender and revoke-sender, the readiness report, and the one fingerprint formula, against a fake AppBridge pipe
// and a loopback Back Channel. Nothing these commands print or send may carry the agent key or a private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { identity } from '../src/crypto.mjs';
import {
    FINGERPRINT, MAX_SENDERS, ReadinessError, WORKER_VERSION, allowSender, candidates, claudeOnPath, claudeStatus, collectReadiness, findClaude,
    fingerprint, normalizeFingerprint, probeAgentControl, reportOf, revokeSender, sendReport, startReadinessReports,
} from '../src/readiness.mjs';
// The broker's own formula and report parser: both sides must agree on every fingerprint and every report.
import * as B from '../../../apps/broker/src/lib/remote-app/readiness.mjs';

const CLI = path.join(import.meta.dirname, '../bin/cli.mjs');
// Built at runtime: an agent key shaped like a real one, obviously a test value.
const newToken = () => ['bc', randomBytes(24).toString('base64url')].join('_');
const ME = randomUUID(), PEER = randomUUID(), OTHER = randomUUID();

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-readiness-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function socketPath(t) {
    if (process.platform === 'win32') return `\\\\.\\pipe\\bc-test-readiness-${randomUUID()}`;
    return path.join(tempDir(t), 'agent-control.sock');
}
/** Every secret a config holds: the token, both private keys whole, and each private key's base64 body. */
function secretsOf(config) {
    const out = [config.token];
    for (const pem of [config.identity.encryptionPrivateKey, config.identity.signingPrivateKey]) {
        out.push(pem, pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
        for (const line of pem.split('\n')) if (line.trim() && !line.startsWith('-----')) out.push(line.trim());
    }
    return out.filter(Boolean);
}
function assertNoSecrets(text, config, where) {
    for (const secret of secretsOf(config)) assert.ok(!text.includes(secret), `a secret leaked in ${where}`);
    assert.ok(!/PRIVATE KEY/.test(text), `a private key block in ${where}`);
}

/** A fake AppBridge host. hello: the answer to give (or null: never answer). Records every message it got. */
async function fakeHost(t, { hello = { ok: true, version: 1, host: { name: 'Shop-PC', version: '1.1.33.0' }, agentControl: true } } = {}) {
    const where = socketPath(t);
    const log = [];
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => { });
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
                const m = JSON.parse(buffer.slice(0, i));
                buffer = buffer.slice(i + 1);
                log.push(m);
                if (m.op === 'hello' && hello) socket.write(JSON.stringify({ id: m.id, ...hello }) + '\n');
            }
        });
    });
    await new Promise(resolve => server.listen(where, resolve));
    t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
    return { path: where, log };
}

/** A loopback Back Channel: GET /api/dispatch/agents and PUT /api/agents/self/readiness, checked with the B parser. */
async function fakeBroker(t, { token, agents, reportStatus = 200 }) {
    const requests = [], reports = [];
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        requests.push({ method: req.method, url: req.url, body: raw, authorization: req.headers.authorization });
        const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
        if (req.method === 'GET' && req.url === '/api/dispatch/agents') return reply(200, { agents });
        if (req.method === 'PUT' && req.url === '/api/agents/self/readiness') {
            const body = JSON.parse(raw);
            reports.push(body);
            B.parseReadiness(body, { agentId: ME }); // throws on anything Back Channel would refuse
            return reply(reportStatus, { recorded: true });
        }
        reply(404, { error: 'not_found' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}`, requests, reports };
}

const peerView = (id, name, keys) => ({ id, name, encryptionKey: keys.encryptionKey, signingKey: keys.signingKey });
function setup(t, { profiles = {}, agentId = ME } = {}) {
    const dir = tempDir(t);
    const store = new Store(path.join(dir, 'state'));
    const keys = { me: identity(), peer: identity(), other: identity() };
    const config = { broker: 'http://127.0.0.1:1', name: 'Shop agent', token: newToken(), identity: keys.me, agentId, peers: {}, profiles };
    store.write('config', config);
    const agents = [peerView(ME, 'Shop agent', keys.me), peerView(PEER, 'Laptop Claude', keys.peer), peerView(OTHER, 'Office Codex', keys.other)];
    const client = { request: async route => { assert.equal(route, '/agents'); return { agents }; } };
    return { dir, store, keys, config, agents, client };
}

// ── The fingerprint ──

test('fingerprint: uppercase SHA-256 of signingKey + "\\n" + encryptionKey, first 16 hex in groups of 4; the broker computes the same', () => {
    const keys = identity();
    const expected = createHash('sha256').update(keys.signingKey + '\n' + keys.encryptionKey).digest('hex').toUpperCase().slice(0, 16).match(/.{4}/g).join('-');
    assert.equal(fingerprint(keys.signingKey, keys.encryptionKey), expected);
    assert.match(expected, FINGERPRINT);
    assert.equal(B.fingerprint(keys.signingKey, keys.encryptionKey), expected, 'the broker formula is the same');
    assert.notEqual(fingerprint(keys.encryptionKey, keys.signingKey), expected, 'order matters');
    assert.equal(fingerprint('', keys.encryptionKey), null);
    assert.equal(fingerprint(keys.signingKey, null), null);
    // "Exactly as enrolled": Back Channel stores each key re-exported as SPKI PEM, which leaves the worker's own unchanged.
    for (const pem of [keys.signingKey, keys.encryptionKey]) assert.equal(createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString(), pem);
    assert.equal(normalizeFingerprint(' ab12-cd34-ef56-7890 '), 'AB12-CD34-EF56-7890');
    for (const bad of ['AB12CD34EF567890', 'AB12-CD34-EF56', 'GG12-CD34-EF56-7890', 42, undefined]) assert.equal(normalizeFingerprint(bad), null);
});

// ── The pipe probe: a v1 hello and nothing else ──

test('pipe probe: listening with the PC name; absent with no pipe; refused when the switch is off; error when it never answers. Only a hello, never a secret', async t => {
    const on = await fakeHost(t);
    assert.deepEqual(await probeAgentControl({ path: on.path }), { pipe: 'listening', hostName: 'Shop-PC', version: '1.1.33.0', reason: null });
    assert.deepEqual(on.log.map(m => Object.keys(m).sort()), [['id', 'op', 'version']], 'one hello: no session op, no executor secret');
    assert.equal(on.log[0].op, 'hello');

    const missing = await probeAgentControl({ path: socketPath(t) });
    assert.equal(missing.pipe, 'absent');
    assert.equal(missing.hostName, null);

    // AppBridge 1.1.33 (agent-control v1.2) says its version in the hello; an older one doesn't, and a malformed one is dropped.
    const old = await fakeHost(t, { hello: { ok: true, version: 1, host: { name: 'Shop-PC' }, agentControl: true } });
    assert.deepEqual(await probeAgentControl({ path: old.path }), { pipe: 'listening', hostName: 'Shop-PC', version: null, reason: null });
    for (const version of ['1.1.33', '1.1.33.0; x', 1133, '9'.repeat(41) + '.1.1.1']) {
        const odd = await fakeHost(t, { hello: { ok: true, version: 1, host: { name: 'Shop-PC', version }, agentControl: true } });
        assert.equal((await probeAgentControl({ path: odd.path })).version, null, String(version));
    }
    const off = await fakeHost(t, { hello: { ok: true, version: 1, host: { name: 'Shop-PC', version: '1.1.34.0' }, agentControl: false } });
    const offProbe = await probeAgentControl({ path: off.path });
    assert.deepEqual([offProbe.pipe, offProbe.version], ['refused', '1.1.34.0'], 'the version is known even with agent control off');
    const no = await fakeHost(t, { hello: { ok: false, outcome: 'needs_user', reason: 'Not now.' } });
    assert.deepEqual(await probeAgentControl({ path: no.path }), { pipe: 'refused', hostName: null, version: null, reason: 'Not now.' });

    const silent = await fakeHost(t, { hello: null });
    assert.equal((await probeAgentControl({ path: silent.path, timeoutMs: 150 })).pipe, 'error');
    const other = await fakeHost(t, { hello: { ok: true, version: 2, agentControl: true } });
    assert.equal((await probeAgentControl({ path: other.path })).pipe, 'error');
    const long = await fakeHost(t, { hello: { ok: true, version: 1, host: { name: 'P'.repeat(200) + '\u0007' }, agentControl: true } });
    assert.equal([...(await probeAgentControl({ path: long.path })).hostName].length, 80, 'the PC name is bounded');
});

// ── claude auth status ──

test('claude: exit 0 is signed in, exit 1 is not, anything else is unknown; fixed arguments, no shell; a missing CLI is not installed', async t => {
    const exe = process.execPath; // an existing file; the fake below decides the answer
    const calls = [];
    const fake = outcome => (file, args, options, callback) => {
        calls.push({ file, args, options });
        setImmediate(() => callback(outcome));
        return { stdin: { end() { } } };
    };
    const exit = code => Object.assign(Error('exit'), { code });
    assert.deepEqual(await claudeStatus(exe, { execFileImpl: fake(null) }), { adapter: 'claude', path: exe, installed: true, signedIn: true });
    assert.equal((await claudeStatus(exe, { execFileImpl: fake(exit(1)) })).signedIn, false);
    assert.equal((await claudeStatus(exe, { execFileImpl: fake(exit(2)) })).signedIn, null);
    assert.equal((await claudeStatus(exe, { execFileImpl: fake(Object.assign(Error('timeout'), { killed: true, code: null, signal: 'SIGKILL' })) })).signedIn, null);
    assert.deepEqual(await claudeStatus(exe, { execFileImpl: fake(Object.assign(Error('spawn'), { code: 'ENOENT' })) }), { adapter: 'claude', path: exe, installed: false, signedIn: null });
    for (const c of calls) {
        assert.deepEqual(c.args, ['auth', 'status']);
        assert.equal(c.options.shell, false);
        assert.ok(c.options.timeout > 0 && c.options.timeout <= 15000, 'a short timeout');
        assert.ok(!Object.keys(c.options.env).some(k => k.startsWith('BC_')), 'no BC_ variables reach claude');
    }
    assert.deepEqual(await claudeStatus(null), { adapter: 'claude', path: null, installed: false, signedIn: null });
    const gone = path.join(tempDir(t), 'claude.exe');
    assert.deepEqual(await claudeStatus(gone), { adapter: 'claude', path: gone, installed: false, signedIn: null });
    // A real process: node given "auth status" exits 1 (no such script), which reads as "not signed in".
    assert.deepEqual(await claudeStatus(process.execPath), { adapter: 'claude', path: process.execPath, installed: true, signedIn: false });
});

test('claude path: the remote-app profile first, else a native claude on PATH (absolute entries only)', t => {
    const dir = tempDir(t);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
    assert.equal(claudeOnPath({ env: { PATH: bin } }), null);
    fs.writeFileSync(path.join(bin, name), '');
    const delimiter = process.platform === 'win32' ? ';' : ':';
    assert.equal(claudeOnPath({ env: { PATH: ['relative-dir', '', bin].join(delimiter) } }), path.join(bin, name));
    if (process.platform === 'win32') {
        assert.equal(claudeOnPath({ env: { Path: bin } }), path.join(bin, name), 'Windows spells it Path too');
        fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
        assert.equal(claudeOnPath({ env: { PATH: dir } }), null, 'a batch shim is not run');
    }
    assert.equal(findClaude({ profiles: { 'remote-app': { executable: process.execPath } } }, { env: { PATH: bin } }), process.execPath);
    assert.equal(findClaude({ profiles: {} }, { env: { PATH: bin } }), path.join(bin, name));
});

// ── The readiness object ──

test('readiness: exactly the contract shape; the report leaves out the path, the reason and sender names, and Back Channel accepts it', async t => {
    const s = setup(t, { profiles: { 'remote-app': { adapter: 'claude', executable: process.execPath, cwd: os.tmpdir(), allowedSenders: [PEER, OTHER, 'not-a-uuid'] } } });
    s.config.peers = { [PEER]: { encryptionKey: s.keys.peer.encryptionKey, signingKey: s.keys.peer.signingKey } };
    s.config.senderNames = { [PEER]: 'Laptop Claude' };
    const at = new Date('2026-10-10T12:00:00.000Z');
    const probes = [];
    const r = await collectReadiness({ config: s.config, pipePath: 'pipe-x', now: () => at,
        probe: async o => { probes.push(o); return { pipe: 'listening', hostName: 'Shop-PC', version: '1.1.33.0', reason: null }; },
        runtime: async exe => ({ adapter: 'claude', path: exe, installed: true, signedIn: true }) });
    assert.deepEqual(probes, [{ path: 'pipe-x' }]);
    assert.deepEqual(r, {
        v: 1, agentId: ME, name: 'Shop agent', enrolled: true, fingerprint: fingerprint(s.keys.me.signingKey, s.keys.me.encryptionKey), workerVersion: WORKER_VERSION,
        appbridge: { pipe: 'listening', hostName: 'Shop-PC', reason: null, version: '1.1.33.0' },
        runtime: { adapter: 'claude', path: process.execPath, installed: true, signedIn: true },
        profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: 'Laptop Claude', pinned: true }, { agentId: OTHER, name: null, pinned: false }] } },
        checkedAt: at.toISOString(),
    });
    assert.match(WORKER_VERSION, /^\d+\.\d+\.\d+/);
    const report = reportOf(r);
    assert.equal(report.runtime.path, null);
    assert.equal(report.appbridge.reason, null);
    assert.deepEqual(report.profiles.remoteApp.senders.map(x => x.name), [null, null]);
    assert.equal(r.runtime.path, process.execPath, 'the local object keeps them');
    assert.deepEqual(B.parseReadiness(report, { agentId: ME }).profiles.remoteApp.senders.map(x => x.agentId), [PEER, OTHER]);
    assert.equal(B.parseReadiness(report, { agentId: ME }).appbridge.version, '1.1.33.0', 'Back Channel keeps the AppBridge version');
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 8192);

    // Not enrolled (a Lists-only worker): no agent id, no fingerprint; no remote-app profile.
    const plain = await collectReadiness({ config: { ...s.config, agentId: undefined, profiles: {} },
        probe: async () => ({ pipe: 'absent', hostName: null, reason: 'off' }), runtime: async () => ({ adapter: 'claude', path: null, installed: false, signedIn: null }) });
    assert.deepEqual([plain.agentId, plain.enrolled, plain.fingerprint, plain.profiles.remoteApp], [null, false, null, { present: false, senders: [] }]);
    assert.equal(plain.appbridge.version, null, 'no hello, no version: sent as null');
    assert.equal(B.parseReadiness(reportOf(plain), { agentId: ME }).appbridge.version, null);

    // At most MAX_SENDERS, so a report always fits.
    const many = Array.from({ length: MAX_SENDERS + 5 }, () => randomUUID());
    const big = await collectReadiness({ config: { ...s.config, profiles: { 'remote-app': { allowedSenders: many } } },
        probe: async () => ({ pipe: 'listening', hostName: 'H'.repeat(80), reason: null }), runtime: async () => ({ adapter: 'claude', path: null, installed: true, signedIn: null }) });
    assert.equal(big.profiles.remoteApp.senders.length, MAX_SENDERS);
    assert.ok(Buffer.byteLength(JSON.stringify(reportOf(big))) < 8192);
    B.parseReadiness(reportOf(big), { agentId: ME });
});

test('run reports at start and then on its interval; a failed report never stops it', async () => {
    const sent = [];
    let fail = true;
    const client = { reportReadiness: async body => { sent.push(body); if (fail) throw Error('offline'); return { status: 200 }; } };
    const logs = [];
    const collect = async ({ config }) => ({ marker: config.name, appbridge: { reason: 'x' }, runtime: { path: 'p' }, profiles: { remoteApp: { senders: [] } } });
    const reports = startReadinessReports({ config: { name: 'n' }, client, everyMs: 25, collect, log: m => logs.push(m) });
    await reports.first;
    assert.equal(sent.length, 1, 'at start');
    assert.match(logs[0], /carries on/);
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 90));
    reports.stop();
    const count = sent.length;
    assert.ok(count >= 3, `then every interval (${count})`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(sent.length, count, 'stop() stops it');
    assert.equal(sent[0].runtime.path, null, 'what is sent is the report form');
    assert.deepEqual(await sendReport({ reportReadiness: async () => ({ status: 400 }) }, await collect({ config: {} })), { ok: false, status: 400 });
});

// ── Step 5: candidates, allow-sender, revoke-sender ──

test('candidates: your other Dispatch agents, each with its fingerprint, pinned and allowed', async t => {
    const s = setup(t, { profiles: { 'remote-app': { adapter: 'claude', executable: process.execPath, cwd: os.tmpdir(), allowedSenders: [OTHER] } } });
    s.config.peers = { [OTHER]: { encryptionKey: s.keys.other.encryptionKey, signingKey: s.keys.other.signingKey } };
    assert.deepEqual(await candidates({ config: s.config, client: s.client }), { agents: [
        { agentId: PEER, name: 'Laptop Claude', fingerprint: fingerprint(s.keys.peer.signingKey, s.keys.peer.encryptionKey), pinned: false, allowed: false },
        { agentId: OTHER, name: 'Office Codex', fingerprint: fingerprint(s.keys.other.signingKey, s.keys.other.encryptionKey), pinned: true, allowed: true },
    ] });
    await assert.rejects(candidates({ config: { ...s.config, agentId: undefined }, client: s.client }), { code: 'not_enrolled' });
    const refused = status => ({ request: async () => { throw Object.assign(Error(`Broker HTTP ${status}`), { status }); } });
    await assert.rejects(candidates({ config: s.config, client: refused(401) }), { code: 'unauthorized' });
    await assert.rejects(candidates({ config: s.config, client: refused(403) }), { code: 'not_allowed' });
    await assert.rejects(candidates({ config: s.config, client: { request: async () => { throw Error('fetch failed'); } } }), { code: 'unreachable' });
});

test('allow-sender: refused unless the fingerprint matches; then pins it and adds it to remote-app, creating the profile beside the state', async t => {
    const s = setup(t);
    const peerFp = fingerprint(s.keys.peer.signingKey, s.keys.peer.encryptionKey);
    const otherFp = fingerprint(s.keys.other.signingKey, s.keys.other.encryptionKey);
    const before = JSON.stringify(s.store.read('config'));
    const args = over => ({ store: s.store, config: s.store.read('config'), client: s.client, id: PEER, fingerprint: peerFp, claude: process.execPath, ...over });
    await assert.rejects(allowSender(args({ fingerprint: otherFp })), { code: 'fingerprint_mismatch' });
    await assert.rejects(allowSender(args({ fingerprint: 'nope' })), { code: 'invalid_fingerprint' });
    await assert.rejects(allowSender(args({ id: 'not-a-uuid' })), { code: 'invalid_id' });
    await assert.rejects(allowSender(args({ id: ME, fingerprint: fingerprint(s.keys.me.signingKey, s.keys.me.encryptionKey) })), { code: 'self' });
    await assert.rejects(allowSender(args({ id: randomUUID() })), { code: 'not_found' });
    await assert.rejects(allowSender(args({ claude: 'relative/claude' })), { code: 'invalid_claude' });
    await assert.rejects(allowSender(args({ claude: undefined, claudeLookup: () => null })), { code: 'claude_not_found' });
    assert.equal(JSON.stringify(s.store.read('config')), before, 'nothing changed by any refusal');

    const ok = await allowSender(args({ fingerprint: peerFp.toLowerCase() }));
    assert.deepEqual(ok, { agentId: PEER, name: 'Laptop Claude', fingerprint: peerFp, pinned: true, allowed: true, profileCreated: true });
    let config = s.store.read('config');
    assert.deepEqual(config.peers[PEER], { encryptionKey: s.keys.peer.encryptionKey, signingKey: s.keys.peer.signingKey });
    const profile = config.profiles['remote-app'];
    assert.deepEqual(profile, { adapter: 'claude', executable: process.execPath, cwd: path.join(path.dirname(s.store.directory), 'remote-app'), allowedSenders: [PEER], permissionMode: 'plan', maxRuntimeMs: 3600000 });
    assert.ok(fs.statSync(profile.cwd).isDirectory());
    assert.ok(!profile.cwd.startsWith(s.store.directory + path.sep), 'never inside the state');
    assert.equal(config.senderNames[PEER], 'Laptop Claude');

    // A second one is added to the same profile; asking again changes nothing.
    assert.equal((await allowSender(args({ config, id: OTHER, fingerprint: otherFp, claude: undefined }))).profileCreated, false);
    config = s.store.read('config');
    assert.deepEqual(config.profiles['remote-app'].allowedSenders, [PEER, OTHER]);
    await allowSender(args({ config }));
    assert.deepEqual(s.store.read('config').profiles['remote-app'].allowedSenders, [PEER, OTHER]);

    // An existing pin with other keys is never silently changed.
    config = s.store.read('config');
    config.peers[OTHER] = { encryptionKey: s.keys.peer.encryptionKey, signingKey: s.keys.peer.signingKey };
    await assert.rejects(allowSender(args({ config, id: OTHER, fingerprint: otherFp })), { code: 'pin_differs' });
});

test('revoke-sender: off the remote-app profile; unpinned only when no other profile names it', async t => {
    const s = setup(t, { profiles: {
        'remote-app': { adapter: 'claude', executable: process.execPath, cwd: os.tmpdir(), allowedSenders: [PEER, OTHER] },
        review: { adapter: 'claude', executable: process.execPath, cwd: os.tmpdir(), allowedSenders: [OTHER] },
    } });
    const pin = k => ({ encryptionKey: k.encryptionKey, signingKey: k.signingKey });
    s.config.peers = { [PEER]: pin(s.keys.peer), [OTHER]: pin(s.keys.other) };
    s.config.senderNames = { [PEER]: 'Laptop Claude', [OTHER]: 'Office Codex' };
    s.store.write('config', s.config);
    assert.deepEqual(revokeSender({ store: s.store, config: s.store.read('config'), id: PEER }), { agentId: PEER, allowed: false, pinned: false });
    assert.deepEqual(revokeSender({ store: s.store, config: s.store.read('config'), id: OTHER }), { agentId: OTHER, allowed: false, pinned: true });
    const config = s.store.read('config');
    assert.deepEqual(config.profiles['remote-app'].allowedSenders, []);
    assert.deepEqual(config.profiles.review.allowedSenders, [OTHER]);
    assert.deepEqual(Object.keys(config.peers), [OTHER]);
    assert.deepEqual(Object.keys(config.senderNames), [OTHER]);
    assert.throws(() => revokeSender({ store: s.store, config, id: 'x' }), ReadinessError);
});

// ── Nothing secret, anywhere ──

test('no command prints or sends the agent key or a private key (outputs, errors and the report scanned for the fixture secrets)', async t => {
    const s = setup(t);
    const outputs = [];
    const keep = (label, value) => outputs.push([label, JSON.stringify(value)]);
    const readiness = await collectReadiness({ config: s.config, probe: async () => ({ pipe: 'listening', hostName: 'Shop-PC', reason: null }), runtime: async () => ({ adapter: 'claude', path: null, installed: true, signedIn: true }) });
    keep('readiness', readiness);
    keep('report', reportOf(readiness));
    keep('candidates', await candidates({ config: s.config, client: s.client }));
    const peerFp = fingerprint(s.keys.peer.signingKey, s.keys.peer.encryptionKey);
    for (const over of [{ fingerprint: '0000-0000-0000-0000' }, { id: randomUUID() }, {}]) {
        try { keep('allow-sender', await allowSender({ store: s.store, config: s.store.read('config'), client: s.client, id: PEER, fingerprint: peerFp, claude: process.execPath, ...over })); }
        catch (e) { keep('allow-sender error', { error: e.code, message: e.message }); }
    }
    keep('revoke-sender', revokeSender({ store: s.store, config: s.store.read('config'), id: PEER }));
    for (const [label, text] of outputs) assertNoSecrets(text, s.config, label);
});

test('the CLI: one JSON object per command, { error, message } on failure, and no secret in stdout, stderr or what reaches Back Channel', async t => {
    const s = setup(t);
    const broker = await fakeBroker(t, { token: s.config.token, agents: s.agents });
    s.config.broker = broker.url;
    s.store.write('config', s.config);
    const exec = (args, state = s.store.directory) => new Promise(resolve => {
        const child = spawn(process.execPath, [CLI, '--state', state, ...args], { windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return undefined; } })() }));
    });
    const runs = [];
    const run = async args => { const r = await exec(args); runs.push([args.join(' '), r]); return r; };

    let r = await exec(['readiness'], path.join(s.dir, 'empty-state'));
    assert.equal(r.status, 1);
    assert.deepEqual(Object.keys(r.json), ['error', 'message']);
    assert.equal(r.json.error, 'not_initialized');

    r = await run(['candidates']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.agents.map(a => [a.agentId, a.allowed]), [[PEER, false], [OTHER, false]]);

    const peerFp = fingerprint(s.keys.peer.signingKey, s.keys.peer.encryptionKey);
    r = await run(['allow-sender', '--id', PEER, '--fingerprint', '1111-2222-3333-4444', '--claude', process.execPath]);
    assert.equal(r.status, 1);
    assert.equal(r.json.error, 'fingerprint_mismatch');
    r = await run(['allow-sender', '--id', PEER, '--fingerprint', peerFp, '--claude', process.execPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual([r.json.allowed, r.json.pinned, r.json.profileCreated], [true, true, true]);

    // The worker holds its lock while running: allow-sender and revoke-sender say so; readiness and candidates still work.
    const lock = path.join(s.store.directory, 'worker.lock');
    fs.writeFileSync(lock, String(process.pid));
    r = await run(['revoke-sender', '--id', PEER]);
    assert.equal(r.json.error, 'locked');
    assert.equal((await run(['candidates'])).status, 0);
    fs.unlinkSync(lock);

    if (process.platform !== 'win32') {
        // Off Windows there is no AppBridge pipe, so this is hermetic: it probes nothing real. The claude in the
        // remote-app profile is node itself, which exits 1 for "auth status": not signed in.
        r = await run(['readiness', '--report']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(r.json.appbridge.pipe, 'error');
        assert.deepEqual([r.json.runtime.installed, r.json.runtime.signedIn], [true, false]);
        assert.equal(broker.reports.length, 1);
        assert.equal(broker.reports[0].runtime.path, null);
        assert.equal(broker.requests.at(-1).authorization, `Bearer ${s.config.token}`, 'the key goes only in the Authorization header');
    }

    r = await run(['revoke-sender', '--id', PEER]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json, { agentId: PEER, allowed: false, pinned: false });

    for (const [label, result] of runs) {
        assertNoSecrets(result.stdout, s.config, `stdout of ${label}`);
        assertNoSecrets(result.stderr, s.config, `stderr of ${label}`);
    }
    for (const req of broker.requests) assertNoSecrets(req.body + req.url, s.config, `${req.method} ${req.url}`);
});
