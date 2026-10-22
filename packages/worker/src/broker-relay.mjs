// The secret broker on this PC, for Back Channel (apps/broker/docs/secrets-epic.md §3.1, §3.3, §3.4).
//
// `run` syncs every few seconds: the broker's status and the requests it would take a phone answer for go out
// (POST /api/agents/self/secret-broker/sync); the person's decisions come back and go to the broker, which checks the
// passkey's assertion itself; and jobs the person asked for (install, update, enrol, lockdown) run here.
//
// What this module never does: ask the broker for a secret, collect what an approval serves, or launch anything
// elevated except the broker's own bootstrap after checking the fetched tree against the pin. It talks to the broker
// only through `secret-broker relay`, a stdio pipe that passes the remote-approval ops and `status`, nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

export const SYNC_EVERY_MS = 4000;
const RELAY_TIMEOUT_MS = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX40 = /^[0-9a-f]{40}$/;
const REPO = 'https://github.com/skyflyt/secret-broker';

/** Where the broker's CLI lives when installed (the admin-only install, never PATH). */
export function brokerPaths({ platform = process.platform, env = process.env } = {}) {
    if (platform === 'win32') {
        const install = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'LobySecretBroker');
        return { install, python: path.join(install, 'venv', 'Scripts', 'python.exe'), staging: path.join(install, 'staging'),
            bootstrap: path.join(install, 'staging', 'install.ps1') };
    }
    if (platform === 'darwin') {
        const base = '/Library/Application Support/LobySecretBroker';
        return { install: base, python: path.join(base, 'app', 'venv', 'bin', 'python'), staging: path.join(base, 'staging'),
            bootstrap: path.join(base, 'staging', 'install.sh') };
    }
    return null;
}

/** `secret-broker relay`: one JSON line in, one out, over the installed broker's own Python. Never a value. */
export class Relay {
    constructor({ python, spawnImpl = spawn, timeoutMs = RELAY_TIMEOUT_MS } = {}) { this.python = python; this.spawnImpl = spawnImpl; this.timeoutMs = timeoutMs; this.child = null; this.queue = []; this.paused = false; }
    start() {
        if (this.child || this.paused) return;
        const child = this.spawnImpl(this.python, ['-I', '-m', 'secret_broker', 'relay'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => { const next = this.queue.shift(); if (!next) return; try { next.resolve(JSON.parse(line)); } catch { next.reject(Error('relay: not JSON')); } });
        child.on('exit', () => { this.child = null; for (const q of this.queue.splice(0)) q.reject(Error('relay exited')); });
        child.on('error', () => { this.child = null; });
    }
    call(msg) {
        this.start();
        if (!this.child) return Promise.reject(Error('relay could not start'));
        return new Promise((resolve, reject) => {
            const timer = globalThis.setTimeout(() => { const i = this.queue.indexOf(entry); if (i >= 0) this.queue.splice(i, 1); reject(Error('relay timeout')); }, this.timeoutMs);
            timer.unref?.();
            const entry = { resolve: v => { globalThis.clearTimeout(timer); resolve(v); }, reject: e => { globalThis.clearTimeout(timer); reject(e); } };
            this.queue.push(entry);
            try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { this.queue.splice(this.queue.indexOf(entry), 1); entry.reject(e); }
        });
    }
    stop() { try { this.child?.stdin.end(); this.child?.kill(); } catch { } this.child = null; }
    /** The installer replaces the venv this relay runs on: a running relay holds its python.exe open. */
    pause() { this.paused = true; this.stop(); }
    resume() { this.paused = false; }
}

/** The broker repo's release pin, fetched with this PC's own GitHub login (the repo is private). null if unavailable. */
export async function fetchPin({ execFileImpl = execFile, env = process.env, platform = process.platform } = {}) {
    const gh = platform === 'win32' ? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe') : 'gh';
    return new Promise(resolve => {
        try {
            execFileImpl(gh, ['api', 'repos/skyflyt/secret-broker/contents/release.json', '-H', 'Accept: application/vnd.github.raw'],
                { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024, env }, (error, stdout) => {
                    if (error) return resolve(null);
                    try {
                        const j = JSON.parse(String(stdout));
                        if (j && j.v === 1 && HEX40.test(j.commit) && HEX40.test(j.tree)) return resolve({ commit: j.commit, tree: j.tree, subject: typeof j.subject === 'string' ? j.subject.slice(0, 120) : null });
                    } catch { }
                    resolve(null);
                });
        } catch { resolve(null); }
    });
}

/** The broker's status for Back Channel: installed, commit, healthy, names, lockdown, trusted passkeys, the pin. */
export async function collectBroker({ relay, paths, pin = fetchPin, doctor = runDoctor }) {
    const out = { installed: false, commit: null, tree: null, healthy: null, names: null, lockdown: null, approverEnrolled: null, approvers: [], checks: [], pin: null };
    out.pin = await pin();
    if (!paths || !fs.existsSync(paths.python)) return out;
    out.installed = true;
    try {
        const st = await relay.call({ op: 'status' });
        if (st.status === 'ok') {
            out.commit = HEX40.test(st.commit ?? '') ? st.commit : null; out.tree = HEX40.test(st.tree ?? '') ? st.tree : null;
            out.names = Number.isInteger(st.names) ? st.names : null; out.lockdown = typeof st.lockdown === 'boolean' ? st.lockdown : null;
            out.approverEnrolled = typeof st.approver_enrolled === 'boolean' ? st.approver_enrolled : null;
        }
        const ap = await relay.call({ op: 'remote-approvers' });
        if (ap.status === 'ok' && Array.isArray(ap.approvers)) out.approvers = ap.approvers.slice(0, 10).map(a => ({ fingerprint: String(a.fingerprint), label: String(a.label ?? 'passkey').slice(0, 60) }));
    } catch { }
    try {
        const d = await doctor(paths.python);
        if (d) { out.healthy = d.healthy === true; out.checks = (d.checks ?? []).slice(0, 20).map(c => ({ label: String(c.label).slice(0, 80), ok: c.ok === true })); }
    } catch { }
    return out;
}

/** `secret-broker doctor --json` (never values). null if it can't run. */
export function runDoctor(python, { execFileImpl = execFile } = {}) {
    return new Promise(resolve => {
        try {
            execFileImpl(python, ['-I', '-m', 'secret_broker', 'doctor', '--json'], { shell: false, windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 },
                (error, stdout) => { try { resolve(JSON.parse(String(stdout))); } catch { resolve(null); } });
        } catch { resolve(null); }
    });
}

/** The broker's remote-approvable requests, as the sync sends them (the same text its own prompt shows). */
export async function collectPending(relay) {
    const r = await relay.call({ op: 'remote-pending' });
    if (r.status !== 'ok' || !Array.isArray(r.pending)) return [];
    return r.pending.slice(0, 20).map(p => ({
        ref: p.ref, kind: p.kind, name: p.name, mode: p.mode, tier: Number.isInteger(p.tier) ? p.tier : null, target: p.target ?? null,
        code: p.code, display: p.display, digest: p.digest_b64u,
        options: (p.options ?? []).map(o => ({ index: o.index, label: o.label, digest: o.digest_b64u })),
        expiresIn: Math.max(1, Math.min(600, Number(p.expires_in) || 90)), requester: p.requester ?? null,
    }));
}

/** Hand the person's decisions to the broker. The broker verifies the assertion; a refusal is its to make. */
export async function applyDecisions(relay, decisions, log = () => { }) {
    for (const d of decisions ?? []) {
        try {
            if (d.decision === 'approve' && d.assertion) {
                const a = d.assertion;
                const r = await relay.call({ op: 'remote-approve', ref: d.ref, option: d.option ?? 0, credential_id: a.credentialId,
                    authenticator_data: a.authenticatorData, client_data_json: a.clientDataJson, signature: a.signature });
                if (r.status !== 'ok') log(`The broker refused an approval from Back Channel: ${String(r.reason ?? '').slice(0, 120)}`);
            } else if (d.decision === 'deny') {
                await relay.call({ op: 'remote-deny', ref: d.ref });
            }
        } catch (e) { log(`Couldn't hand a decision to the broker: ${e.message}`); }
    }
}

// ── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Clone the pinned commit next to the install and check it against the pin. Never runs anything from it. */
export function fetchRelease({ payload, dir, execFileImpl = execFile, env = process.env, platform = process.platform }) {
    const git = platform === 'win32' ? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe') : 'git';
    const gh = platform === 'win32' ? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe') : 'gh';
    const run = args => new Promise((resolve, reject) => {
        execFileImpl(git, args, { shell: false, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...env, GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } },
            (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
    });
    return (async () => {
        if (!HEX40.test(payload?.commit) || !HEX40.test(payload?.tree)) throw Object.assign(Error('pin'), { code: 'pin_mismatch' });
        fs.rmSync(dir, { recursive: true, force: true });
        try {
            await run(['-c', 'core.hooksPath=' + (platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'transfer.fsckObjects=true', '-c', 'credential.helper=',
                '-c', `credential.helper=!'${gh}' auth git-credential`, 'clone', '--quiet', REPO, dir]);
            await run(['-C', dir, '-c', 'core.hooksPath=' + (platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'advice.detachedHead=false', 'checkout', '--quiet', payload.commit]);
        } catch { throw Object.assign(Error('fetch'), { code: 'fetch_failed' }); }
        const got = await run(['-C', dir, 'rev-parse', 'HEAD', 'HEAD^{tree}']).then(s => s.split(/\s+/));
        if (got[0] !== payload.commit || got[1] !== payload.tree) { fs.rmSync(dir, { recursive: true, force: true }); throw Object.assign(Error('pin'), { code: 'pin_mismatch' }); }
        return dir;
    })();
}

/**
 * Launch the broker's own bootstrap elevated. Windows: a visible elevated PowerShell (the UAC prompt is the gate; the
 * window stays open so the person can read it); it clones the pinned commit into the admin-only staging folder itself
 * and runs install.ps1 -UpdateOnly from there. Resolves when that process exits, with its exit code.
 */
export function launchElevated({ payload, kind, platform = process.platform, env = process.env, spawnImpl = spawn, backends = {} }) {
    if (platform !== 'win32') return Promise.reject(Object.assign(Error('unsupported'), { code: 'not_supported' }));
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const extra = kind === 'update' ? '-UpdateOnly' : '';
    // Bitwarden project ids (not secret) for a first install's backends.toml: home/* and, for -Work, work/* (BHWK-Agents).
    // A missing one is asked for in the elevated window; an update ignores both.
    const id = (flag, v) => typeof v === 'string' && UUID.test(v) ? `${flag} '${v}'` : '';
    const bws = [id('-BwsProjectId', backends.bwsProjectId), id('-WorkBwsProjectId', backends.workBwsProjectId)].filter(Boolean).join(' ');
    const body = [
        `$env:GIT_CONFIG_GLOBAL = "NUL"; $env:GIT_CONFIG_NOSYSTEM = "1"; $env:GIT_TERMINAL_PROMPT = "0"`,
        `$Git = "${pf}\\Git\\cmd\\git.exe"; $Gh = "${pf}\\GitHub CLI\\gh.exe"; $Stage = "${pf}\\LobySecretBroker\\staging"`,
        'if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }',
        `& $Git -c core.hooksPath=NUL -c transfer.fsckObjects=true -c credential.helper= -c "credential.helper=!'$Gh' auth git-credential" clone --quiet ${REPO} $Stage`,
        `& $Git -C $Stage -c core.hooksPath=NUL -c advice.detachedHead=false checkout --quiet ${payload.commit}`,
        `$got = (& $Git -C $Stage rev-parse HEAD "HEAD^{tree}") -join " "`,
        `if ($got -ne "${payload.commit} ${payload.tree}") { throw "the staging clone does not match the release pin; nothing was run" }`,
        `& "$Stage\\install.ps1" -Work ${extra} ${bws}`,
    ].join('; ');
    // Success closes the window after a few seconds; a failure shows its error and waits for Enter, so it can be read.
    const script = `$ErrorActionPreference = "Stop"; try { ${body}; Write-Host "\`nSecret broker ${kind} finished."; Start-Sleep 5; exit 0 } `
        + `catch { Write-Host "\`nSecret broker ${kind} stopped: $($_.Exception.Message)" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const pwsh = path.join(pf, 'PowerShell', '7', 'pwsh.exe');
    return new Promise(resolve => {
        // Start-Process -Verb RunAs raises the UAC prompt; -Wait -PassThru gives the elevated process's exit code.
        // Exit 2: the prompt was declined (Start-Process throws); otherwise the elevated script's own exit code.
        const launcher = `try { $p = Start-Process '${pwsh}' -Verb RunAs -PassThru -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') } catch { exit 2 }; exit $p.ExitCode`;
        let child;
        try {
            child = spawnImpl(pwsh, ['-NoProfile', '-NonInteractive', '-Command', launcher], { stdio: 'ignore', windowsHide: true, shell: false });
        } catch { return resolve({ code: 'uac_declined' }); }
        child.on('error', () => resolve({ code: 'uac_declined' }));
        child.on('exit', code => resolve(code === 0 ? { ok: true } : { code: code === 2 ? 'uac_declined' : 'installer_failed' }));
    });
}

/** Run one job the person asked for; `report(state, steps, failure)` ticks the card. */
/** `secret-broker remote-enrol`: the broker's local admin card (Hello) decides. true only when it enrolled. */
export function enrolPasskey({ python, payload, execFileImpl = execFile }) {
    const b64u = /^[A-Za-z0-9_-]{1,8192}$/;
    if (!b64u.test(payload?.credentialId ?? '') || !b64u.test(payload?.publicKeyCose ?? '')) return Promise.resolve(false);
    const label = String(payload.label ?? 'passkey').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60);
    return new Promise(resolve => {
        try {
            execFileImpl(python, ['-I', '-m', 'secret_broker', 'remote-enrol', '--credential-id', payload.credentialId, '--public-key-cose', payload.publicKeyCose, '--label', label],
                { shell: false, windowsHide: false, timeout: 180000, maxBuffer: 64 * 1024 }, (error, stdout) => {
                    if (error) return resolve(false);
                    try { resolve(JSON.parse(String(stdout)).status === 'ok'); } catch { resolve(false); }
                });
        } catch { resolve(false); }
    });
}

export async function runJob({ job, relay, paths, report, log = () => { }, launch = launchElevated, fetch = fetchRelease, doctor = runDoctor, enrol = enrolPasskey, waitMs = 1500, backends = {} }) {
    const steps = {};
    const tick = async (state, failure = null) => { try { await report(job.id, state, { ...steps }, failure); } catch { } };
    try {
        if (job.kind === 'lockdown') {
            const r = await relay.call({ op: 'lockdown' });
            steps.locked = r.status === 'ok';
            return tick(steps.locked ? 'done' : 'failed', steps.locked ? null : 'broker_unavailable');
        }
        if (job.kind === 'enrol') {
            const p = job.payload ?? {};
            if (!paths) return tick('failed', 'not_supported');
            if (!fs.existsSync(paths.python)) return tick('failed', 'not_installed');
            await tick('running');
            // The broker's own `remote-enrol` raises its admin card at the machine, showing the fingerprint; the person
            // compares it with the one on the Back Channel card and approves with Hello. Not through the relay: that
            // forwards ops only, and this one needs the broker's local approval.
            const ok = await enrol({ python: paths.python, payload: p });
            steps.trusted = ok;
            return tick(ok ? 'done' : 'failed', ok ? null : 'declined_at_machine');
        }
        if (job.kind === 'install' || job.kind === 'update') {
            if (!paths) { return tick('failed', 'not_supported'); }
            await tick('running');
            // A verification clone in the worker's own state: proves the pin resolves to what the repo serves before the
            // elevated clone does the same from an admin-only folder.
            const check = path.join(os.tmpdir(), `bc-secret-broker-check-${process.pid}`);
            try { await fetch({ payload: job.payload, dir: check }); } catch (e) { steps.fetched = false; return tick('failed', e.code ?? 'fetch_failed'); }
            finally { fs.rmSync(check, { recursive: true, force: true }); }
            steps.fetched = true; await tick('running');
            // Nothing of the worker's may run on the broker's Python while the installer rebuilds its venv (seen
            // 2026-10-20: the relay, respawned by the sync, left install.ps1 "Access ... python.exe is denied").
            relay?.pause?.();
            let launched;
            try { launched = await launch({ payload: job.payload, kind: job.kind, backends }); } finally { relay?.resume?.(); }
            if (!launched.ok) { steps.installer_started = false; return tick('failed', launched.code ?? 'uac_declined'); }
            steps.installer_started = true; steps.installer_finished = true; await tick('running');
            await new Promise(r => globalThis.setTimeout(r, waitMs));
            let st = null;
            try { st = await relay.call({ op: 'status' }); } catch { }
            steps.service_running = !!st && st.status === 'ok' && st.commit === job.payload.commit;
            if (st && st.status === 'ok') steps.approver_enrolled = st.approver_enrolled === true;
            const d = await doctor(paths.python);
            steps.doctor_healthy = !!d && d.healthy === true;
            if (d) steps.token_stored = (d.checks ?? []).some(c => /backend reachable/i.test(c.label) && c.ok);
            return tick(steps.service_running && steps.doctor_healthy ? 'done' : 'failed', steps.service_running ? (steps.doctor_healthy ? null : 'installer_failed') : 'installer_failed');
        }
        return tick('failed', 'not_supported');
    } catch (e) {
        log(`Secret broker job failed: ${e.message}`);
        return tick('failed', 'broker_unavailable');
    }
}

/**
 * `run`: sync every few seconds while the broker is installed (every 30 s otherwise, to notice an install and offer the
 * pin). A failed sync is logged and the run carries on. stop() ends it.
 */
export function startSecretsSync({ client, paths = brokerPaths(), relay = paths ? new Relay({ python: paths.python }) : null, everyMs = SYNC_EVERY_MS, log = () => { },
    collect = collectBroker, pending = collectPending, apply = applyDecisions, job = runJob, backends = {} }) {
    let stopped = false, running = null, lastBroker = 0, broker = null;
    const active = new Set();
    const once = () => {
        if (stopped || running) return running;
        running = (async () => {
            try {
                const installed = !!paths && fs.existsSync(paths.python);
                // While an install or update runs, nothing starts the broker's Python (status, doctor, pending).
                const held = !!relay?.paused;
                if (!held && (!broker || Date.now() - lastBroker > 60_000 || !installed)) { broker = await collect({ relay, paths: installed ? paths : null }); lastBroker = Date.now(); }
                const list = installed && relay && !held ? await pending(relay).catch(() => []) : [];
                const r = await client.secretsSync({ v: 1, broker, pending: list, jobs: [] });
                if (r.status !== 200 || !r.body) { if (r.status) log(`Secrets sync not accepted by Back Channel (HTTP ${r.status}); the worker carries on.`); return; }
                if (relay && r.body.decisions?.length) await apply(relay, r.body.decisions, log);
                for (const j of r.body.jobs ?? []) {
                    if (active.has(j.id)) continue;
                    active.add(j.id);
                    const report = (id, state, steps, failure) => client.secretsSync({ v: 1, broker, pending: [], jobs: [{ id, state, steps, failure }] });
                    // Jobs get the broker's paths whether or not it is installed yet: an Install needs them most
                    // (2026-10-22: passing null here made every Install from the card fail at once as not_supported).
                    job({ job: j, relay, paths, report, log, backends }).finally(() => { active.delete(j.id); lastBroker = 0; });
                }
            } catch (e) { log(`Secrets sync failed; the worker carries on: ${e.message}`); }
        })().finally(() => { running = null; });
        return running;
    };
    const first = once();
    const timer = globalThis.setInterval(() => { once(); }, everyMs);
    timer.unref?.();
    return { first, stop() { stopped = true; globalThis.clearInterval(timer); relay?.stop(); } };
}
