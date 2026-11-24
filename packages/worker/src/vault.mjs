// The "vault" profile: read-only access to a git-backed notes vault for the person's own agents, through Back
// Channel (docs/vault-bridge.md). `bc-worker run --vault` runs this loop beside Dispatch:
//   - long-poll Back Channel for the next vault request (GET /api/vault/worker/next?wait=25) with this worker's own
//     full-scope key, and post each answer back (POST /api/vault/worker/result);
//   - fetch the vault's branch from its git server (Gitea, GitHub, anything git speaks) into a private ref,
//     refs/bc-vault/<branch>, at most every fetchEveryMs, with the worker's own read-only token when one is set;
//   - answer status, list, search and read from that fetched ref only (git ls-tree, git grep, git cat-file).
// It never touches the working tree, the index or any branch: it can't collide with the sessions that edit the
// vault, can't leave a rebase stuck, and serves exactly what the git server has. When the server can't be reached it
// serves the last fetch and says how old it is.
// It never writes: no commit, push, checkout or reset exists in this file. Secret files (.env, key stores, private
// keys) and app config (.obsidian) are refused by built-in rules the profile can add to but never remove.
// Note text goes to Back Channel only as the answer to one request, and Back Channel holds it in memory only.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from './worker.mjs';

export const VAULT_PROFILE = 'vault';
export const VAULT_TOKEN_FILE = 'vault-token';
export const OPS = Object.freeze(['status', 'list', 'search', 'read']);
/** Paths the worker never lists, searches or reads, whatever the profile says. Folder rules end with "/". */
export const BUILTIN_EXCLUDES = Object.freeze([
    '.git/', '.obsidian/', '.trash/', '.claude/',
    '.env', '.env.*', '*.kdbx', '*.kdb', '*.key', '*.pem', '*.pfx', '*.p12', '*.ppk', '*.keystore', '*.jks',
    'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '*.gpg', '.netrc', '_netrc', '.npmrc', '.pgpass', '.git-credentials',
    'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml',
]);
export const LIMITS = Object.freeze({ readBytes: 256 * 1024, maxReadBytes: 1024 * 1024, listEntries: 500, searchMatches: 50, snippet: 240, query: 200, path: 512, depth: 3 });
/** Fixed sentences for what went wrong. Never git's own output, which can carry the server's address. */
export const ERRORS = Object.freeze({
    bad_request: 'That request is not one the vault reader takes.',
    bad_path: 'That is not a vault path: use a relative path like "Projects/notes.md", with no "..".',
    excluded: 'That path is excluded on this vault: secret files and app settings are never shared.',
    not_found: 'Nothing is at that path in the vault.',
    not_a_file: 'That path is a folder, not a note.',
    not_a_folder: 'That path is a note, not a folder.',
    binary: 'That file is not text, so it is not shared.',
    too_large: 'That note is larger than this vault reader shares in one read.',
    not_fetched: "The vault hasn't been fetched from its git server yet, and the last try failed.",
    failed: 'The vault reader on the PC could not answer that.',
});
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,100}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_KEYS = new Set(['root', 'fetchUrl', 'branch', 'exclude', 'maxReadBytes', 'fetchEveryMs', 'git']);
const sleep = (ms, signal) => new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
});
const vaultError = (code, extra = {}) => Object.assign(Error(ERRORS[code] ?? ERRORS.failed), { vaultCode: ERRORS[code] ? code : 'failed', ...extra });

/**
 * The local profile named "vault". Everything in it is non-secret; the read-only token, if any, lives in its own
 * private state file (bc-worker vault-token), never here. Unknown keys are refused so a token can't be put in it.
 *  - root: absolute path to the vault's git checkout on this PC (its objects and refs are read; its files never are).
 *  - fetchUrl: where to fetch from: the git server's https URL (no user name or password in it), or for a local
 *    mirror an absolute path. Default: the checkout's own "origin".
 *  - branch: the branch to serve. Default "main".
 *  - exclude: more paths to refuse, up to 50: a name or pattern ("Private", "*.pdf") refuses any file or folder of that
 *    name anywhere; a path with a slash inside ("Work/HR/") refuses that folder, from the vault's top.
 *  - maxReadBytes: largest note one read returns (default 256 KiB, at most 1 MiB).
 *  - fetchEveryMs: fetch again when the last fetch is older than this (default 5 minutes; 1 minute to 1 day).
 *  - git: absolute path to git, if it isn't on PATH.
 */
export function validateVaultProfile(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('Invalid vault profile');
    for (const key of Object.keys(profile))
        if (!PROFILE_KEYS.has(key)) throw Error(`The vault profile takes no "${key}" (it holds no secrets: set the read-only token with vault-token)`);
    const { root, fetchUrl, branch = 'main', exclude = [], maxReadBytes = LIMITS.readBytes, fetchEveryMs = 300000, git } = profile;
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('root must be the absolute path of the vault checkout');
    if (fetchUrl !== undefined) {
        if (typeof fetchUrl !== 'string' || !fetchUrl) throw Error('Invalid fetchUrl');
        if (!path.isAbsolute(fetchUrl)) {
            let u;
            try { u = new URL(fetchUrl); } catch { throw Error('fetchUrl must be an https URL or an absolute path'); }
            if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
                throw Error('fetchUrl must be https (loopback http only)');
            if (u.username || u.password) throw Error('fetchUrl takes no user name or password: set the read-only token with vault-token');
            if (u.search || u.hash) throw Error('Invalid fetchUrl');
        }
    }
    if (typeof branch !== 'string' || !BRANCH.test(branch)) throw Error('Invalid branch name');
    if (!Array.isArray(exclude) || exclude.length > 50 || !exclude.every(r => typeof r === 'string' && r.trim() && r.length <= 200 && !r.includes('..')))
        throw Error('exclude is a list of up to 50 names or patterns ("Private", "*.pdf") or folder paths ("Work/HR/")');
    if (!Number.isInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > LIMITS.maxReadBytes) throw Error(`maxReadBytes is 1 to ${LIMITS.maxReadBytes}`);
    if (!Number.isInteger(fetchEveryMs) || fetchEveryMs < 60000 || fetchEveryMs > 86400000) throw Error('fetchEveryMs is 60000 (1 minute) to 86400000 (1 day)');
    if (git !== undefined && (typeof git !== 'string' || !path.isAbsolute(git))) throw Error('git must be an absolute path');
    return { root, ...(fetchUrl ? { fetchUrl } : {}), branch, exclude: exclude.map(r => r.trim().replace(/\\/g, '/')), maxReadBytes, fetchEveryMs, ...(git ? { git } : {}) };
}

/** A vault-relative POSIX path from a request, or null when it isn't one. "" is the vault's top. */
export function cleanPath(value, { allowRoot = false } = {}) {
    if (value === undefined || value === null || value === '') return allowRoot ? '' : null;
    if (typeof value !== 'string' || value.length > LIMITS.path || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const p = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!p) return allowRoot ? '' : null;
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith(':')) return null;
    const parts = p.split('/');
    if (parts.some(s => s === '' || s === '.' || s === '..')) return null;
    return parts.join('/');
}

const globRegex = pattern => new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
/** Exclusion rules: built-in ones first, then the profile's. A rule with a slash inside ("Work/HR/") refuses that folder and all in it, from the vault's top; a name or pattern ("Private/", "*.pdf") refuses any file or folder of that name, anywhere. */
export function exclusions(extra = []) {
    const rules = [...BUILTIN_EXCLUDES, ...extra];
    const folders = rules.filter(r => r.endsWith('/') && r.slice(0, -1).includes('/')).map(r => r.replace(/^\/+/, '').toLowerCase());
    const names = rules.filter(r => !(r.endsWith('/') && r.slice(0, -1).includes('/'))).map(r => globRegex(r.replace(/\/$/, '')));
    return p => {
        if (!p) return false;
        const lower = p.toLowerCase();
        if (folders.some(f => (lower + '/').startsWith(f))) return true;
        return p.split('/').some(segment => names.some(re => re.test(segment)));
    };
}

/** git, read-only. Every call is git -C root with prompts off and, when the worker has a token, the person's own credential helpers off. */
export class VaultGit {
    constructor(profile, { token = null, execFileImpl = execFile, timeoutMs = 30000 } = {}) {
        this.profile = profile;
        this.token = token;
        this.execFileImpl = execFileImpl;
        this.timeoutMs = timeoutMs;
        this.ref = `refs/bc-vault/${profile.branch}`;
    }
    env() {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
        // The token goes to git in the environment (never on a command line others can list), as one extra header.
        if (this.token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: token ${this.token}` });
        return env;
    }
    run(args, { maxBuffer = 8 * 1024 * 1024, encoding = 'utf8', okCodes = [0] } = {}) {
        const pre = ['-C', this.profile.root, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...(this.token ? ['-c', 'credential.helper='] : [])];
        return new Promise((resolve, reject) => {
            this.execFileImpl(this.profile.git ?? 'git', [...pre, ...args], { env: this.env(), encoding, maxBuffer, timeout: this.timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
                if (okCodes.includes(code)) return resolve({ code, stdout });
                reject(Object.assign(Error(`git ${args[0]} failed`), { code, detail: String(stderr ?? '').trim().slice(0, 500), maxBuffer: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
            });
        });
    }
    /** Fetch the branch into the private ref. Writes objects and that one ref; never FETCH_HEAD, a branch or the worktree. */
    fetch() { return this.run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', this.profile.fetchUrl ?? 'origin', `+refs/heads/${this.profile.branch}:${this.ref}`]); }
    async head() {
        const { stdout } = await this.run(['log', '-1', '--format=%H %cI', this.ref, '--'], { okCodes: [0, 128] });
        const [commit, at] = stdout.trim().split(' ');
        return commit && at ? { commit, asOf: new Date(at).toISOString() } : null;
    }
    /** One tree entry, or null: { mode, type, object, size, path }. */
    async entry(p) {
        if (!p) return { mode: '040000', type: 'tree', object: null, size: null, path: '' };
        const { stdout } = await this.run(['ls-tree', '-z', '--long', '--full-tree', this.ref, '--', p]);
        return parseTree(stdout).find(e => e.path === p) ?? null;
    }
    async tree(p, recursive) {
        const args = ['ls-tree', '-z', '--long', '--full-tree', ...(recursive ? ['-r', '-t'] : []), this.ref, '--', ...(p ? [p + '/'] : [])];
        const { stdout } = await this.run(args, { maxBuffer: 32 * 1024 * 1024 });
        return parseTree(stdout);
    }
    async blob(object, max) {
        const { stdout } = await this.run(['cat-file', 'blob', object], { encoding: 'buffer', maxBuffer: max + 1 });
        return stdout;
    }
    /** git grep on the fetched ref: fixed string, any case, text files only. Exit 1 means no match. */
    async grep(query, p) {
        const { stdout } = await this.run(['grep', '-z', '-n', '-I', '-i', '-F', '--no-color', '--max-count=5', '-e', query, this.ref, '--', ...(p ? [p + '/'] : [])], { okCodes: [0, 1], maxBuffer: 16 * 1024 * 1024 });
        return stdout;
    }
}

function parseTree(stdout) {
    return stdout.split('\0').filter(Boolean).map(line => {
        const tab = line.indexOf('\t');
        const [mode, type, object, size] = line.slice(0, tab).trim().split(/\s+/);
        return { mode, type, object, size: size === '-' ? null : Number(size), path: line.slice(tab + 1) };
    });
}

/** Answers one request from the fetched ref. Pure of the network: the agent loop below brings requests to it. */
export class VaultReader {
    constructor(profile, { git, now = () => Date.now(), log = () => { } } = {}) {
        this.profile = profile;
        this.git = git ?? new VaultGit(profile);
        this.now = now;
        this.log = log;
        this.excluded = exclusions(profile.exclude);
        this.fetchedAt = 0;
        this.fetchFailedAt = 0;
        this.fetching = null;
    }
    /** Fetch when the last good fetch is older than fetchEveryMs (and not more often than once a minute after a failure). */
    async fresh({ force = false } = {}) {
        const t = this.now();
        const due = force || t - this.fetchedAt >= this.profile.fetchEveryMs;
        if (!due || (!force && t - this.fetchFailedAt < 60000)) return;
        this.fetching ??= this.git.fetch().then(() => { this.fetchedAt = this.now(); this.fetchFailedAt = 0; }, e => {
            this.fetchFailedAt = this.now();
            this.log(`Vault fetch failed (serving the last fetch): ${e.detail || e.message}`);
        }).finally(() => { this.fetching = null; });
        await this.fetching;
    }
    async freshness() {
        const head = await this.git.head();
        if (!head) throw vaultError('not_fetched');
        const t = this.now();
        return {
            commit: head.commit, as_of: head.asOf, branch: this.profile.branch,
            fetched_at: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
            stale_seconds: this.fetchedAt ? Math.max(0, Math.round((t - this.fetchedAt) / 1000)) : null,
            fetch_ok: this.fetchedAt > 0 && this.fetchFailedAt === 0,
        };
    }
    async handle(op, args = {}) {
        if (!OPS.includes(op) || !args || typeof args !== 'object' || Array.isArray(args)) throw vaultError('bad_request');
        await this.fresh();
        const freshness = await this.freshness();
        switch (op) {
            case 'status': return { ...freshness, excludes: [...BUILTIN_EXCLUDES, ...this.profile.exclude] };
            case 'list': return { ...freshness, ...(await this.list(args)) };
            case 'search': return { ...freshness, ...(await this.search(args)) };
            case 'read': return { ...freshness, ...(await this.read(args)) };
        }
    }
    async list({ path: raw, depth = 1 }) {
        const p = cleanPath(raw, { allowRoot: true });
        if (p === null) throw vaultError('bad_path');
        if (this.excluded(p)) throw vaultError('excluded');
        if (!Number.isInteger(depth) || depth < 1 || depth > LIMITS.depth) throw vaultError('bad_request');
        const at = await this.git.entry(p);
        if (!at) throw vaultError('not_found');
        if (at.type !== 'tree') throw vaultError('not_a_folder');
        const base = p ? p.split('/').length : 0;
        const rows = (await this.git.tree(p, depth > 1))
            .filter(e => (!p || e.path.startsWith(p + '/')) && e.path.split('/').length - base <= depth)
            .filter(e => !this.excluded(e.path) && (e.type === 'tree' || (e.type === 'blob' && e.mode !== '120000')));
        const entries = rows.slice(0, LIMITS.listEntries).map(e => e.type === 'tree' ? { path: e.path, kind: 'folder' } : { path: e.path, kind: 'file', bytes: e.size });
        return { path: p, entries, truncated: rows.length > entries.length };
    }
    async search({ query, path: raw }) {
        if (typeof query !== 'string' || !query.trim() || query.length > LIMITS.query || /[\u0000-\u001f\u007f]/.test(query)) throw vaultError('bad_request');
        const p = cleanPath(raw, { allowRoot: true });
        if (p === null) throw vaultError('bad_path');
        if (this.excluded(p)) throw vaultError('excluded');
        let stdout;
        try { stdout = await this.git.grep(query.trim(), p); }
        catch (e) { if (e.maxBuffer) stdout = ''; else throw e; }
        const prefix = this.git.ref + ':';
        const matches = [];
        let more = false;
        // -z -n: "<ref>:<path>" NUL "<line>" NUL "<text>", one match a line.
        for (const record of stdout.split('\n')) {
            const [file, lineText, ...rest] = record.split('\0');
            if (!file?.startsWith(prefix) || rest.length === 0) continue;
            const pathOf = file.slice(prefix.length);
            const line = Number(lineText);
            const text = rest.join(' ');
            if (this.excluded(pathOf) || !Number.isInteger(line)) continue;
            if (matches.length >= LIMITS.searchMatches) { more = true; break; }
            matches.push({ path: pathOf, line, text: snippet(text) });
        }
        return { query: query.trim(), path: p, matches, truncated: more };
    }
    async read({ path: raw }) {
        const p = cleanPath(raw);
        if (p === null) throw vaultError('bad_path');
        if (this.excluded(p)) throw vaultError('excluded');
        const at = await this.git.entry(p);
        if (!at) throw vaultError('not_found');
        if (at.type === 'tree') throw vaultError('not_a_file');
        if (at.type !== 'blob' || at.mode === '120000') throw vaultError('not_found');
        if (at.size > this.profile.maxReadBytes) throw vaultError('too_large', { bytes: at.size });
        const bytes = await this.git.blob(at.object, this.profile.maxReadBytes);
        if (bytes.includes(0)) throw vaultError('binary', { bytes: bytes.length });
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return { path: p, bytes: bytes.length, version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), blob: at.object, text };
    }
}

function snippet(text) {
    const chars = [...text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim()];
    return chars.length > LIMITS.snippet ? chars.slice(0, LIMITS.snippet - 1).join('') + '…' : chars.join('');
}

/** /api/vault/worker with this worker's own key. Resolves { status, body, retryAfter }; throws only on network errors. */
export class VaultBroker {
    constructor(config, { timeoutMs = 40000 } = {}) {
        this.base = new Client(config).base; // HTTPS only (loopback HTTP for development), as Dispatch
        this.token = config.token;
        this.timeoutMs = timeoutMs;
    }
    async call(method, route, body, { signal } = {}) {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await fetch(this.base + route, {
            method,
            headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
            redirect: 'error',
        });
        let data = null;
        try { data = await response.json(); } catch { }
        return { status: response.status, body: data, retryAfter: Number(response.headers.get('retry-after')) || 0 };
    }
    next(waitSeconds, options) { return this.call('GET', `/api/vault/worker/next?wait=${waitSeconds}`, undefined, options); }
    result(body) { return this.call('POST', '/api/vault/worker/result', body); }
}

/**
 * The loop `run --vault` runs: take one request, answer it from the fetched ref, post the answer, repeat.
 * 401/403 for the key itself stop the run (like Lists); rollout_off and a broker without the route wait 10 minutes.
 */
export class VaultAgent {
    constructor(worker, { broker, reader, token, waitSeconds = 25, offMs = 600000, retryMs = 5000, log = message => console.error(message) } = {}) {
        this.worker = worker;
        this.log = log;
        this.broker = broker ?? new VaultBroker(worker.config);
        this.token = token;
        this.reader = reader;
        Object.assign(this, { waitSeconds, offMs, retryMs });
        this.stopper = new AbortController();
    }
    get halted() { return !!(this.stopped || this.worker.stopped); }
    profile() {
        const p = this.worker.config.profiles?.[VAULT_PROFILE];
        if (!p) throw Object.assign(Error('No local profile named "vault": install one with profile --name vault --file FILE'), { fatal: true });
        try { return validateVaultProfile(p); }
        catch (e) { throw Object.assign(Error(`The local "vault" profile is invalid: ${e.message}`), { fatal: true }); }
    }
    stop() { this.stopped = true; this.stopper.abort(); }
    async run({ once = false } = {}) {
        const profile = this.profile();
        this.reader ??= new VaultReader(profile, { git: new VaultGit(profile, { token: this.token ?? this.worker.store?.read(VAULT_TOKEN_FILE, null)?.token ?? null }), log: this.log });
        await this.reader.fresh({ force: true });
        let failures = 0, saidOff = false;
        while (!this.halted) {
            let r;
            try {
                r = await this.broker.next(once ? 0 : this.waitSeconds, { signal: this.stopper.signal });
            } catch (e) {
                if (this.halted) break;
                failures++;
                this.log(`Vault poll failed; retrying: ${e.message}`);
                await sleep(Math.min(60000, this.retryMs * 2 ** Math.min(failures, 4)), this.stopper.signal);
                continue;
            }
            if (r.status === 401 || (r.status === 403 && r.body?.error !== 'rollout_off'))
                throw Object.assign(Error(`Back Channel refused this worker's key for the vault (HTTP ${r.status}${r.body?.error ? ` ${r.body.error}` : ''})`), { status: r.status });
            if (r.status === 404 || r.body?.error === 'rollout_off') {
                if (!saidOff) this.log('The vault bridge is switched off on Back Channel for now; checking again in 10 minutes.');
                saidOff = true;
                if (once) break;
                await sleep(this.offMs, this.stopper.signal);
                continue;
            }
            if (r.status === 429 || r.status >= 500) {
                failures++;
                await sleep(Math.max((r.retryAfter || 0) * 1000, Math.min(60000, this.retryMs * 2 ** Math.min(failures, 4))), this.stopper.signal);
                continue;
            }
            failures = 0;
            saidOff = false;
            const request = r.status === 200 ? r.body?.request : null;
            if (request) await this.answer(request);
            if (once) break;
        }
    }
    async answer(request) {
        if (!ID.test(String(request.id ?? ''))) return; // nothing to answer to
        let body;
        try {
            body = { id: request.id, ok: true, result: await this.reader.handle(request.op, request.args ?? {}) };
        } catch (e) {
            if (!e.vaultCode) this.log(`Vault ${String(request.op).slice(0, 20)} failed: ${e.detail || e.message}`);
            body = { id: request.id, ok: false, error: e.vaultCode ?? 'failed', message: ERRORS[e.vaultCode] ?? ERRORS.failed, ...(e.bytes !== undefined ? { bytes: e.bytes } : {}) };
        }
        for (let attempt = 1; attempt <= 3 && !this.halted; attempt++) {
            try {
                const r = await this.broker.result(body);
                if (r.status < 500 && r.status !== 429) return; // 404/410: the asker gave up; nothing to keep
            } catch { }
            await sleep(this.retryMs * attempt, this.stopper.signal);
        }
    }
}
