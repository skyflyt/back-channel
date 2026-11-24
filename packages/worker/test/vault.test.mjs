import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BUILTIN_EXCLUDES, ERRORS, VaultAgent, VaultGit, VaultReader, cleanPath, exclusions, validateVaultProfile } from '../src/vault.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
const write = (root, file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };

/** A bare "git server" and a person's checkout of it, with notes, secrets, app config and a binary pushed. */
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-vault-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const server = path.join(dir, 'server.git'), vault = path.join(dir, 'vault'), other = path.join(dir, 'other');
    git(dir, 'init', '--bare', server);
    git(dir, 'clone', '--quiet', server, vault);
    write(vault, 'README.md', '# Vault\nThe vault bridge reads this.\n');
    write(vault, 'Projects/back-channel.md', 'Back Channel notes\nvault bridge: reads only\n');
    write(vault, 'Projects/Deep/plan.md', 'Deep plan\n');
    write(vault, 'Private/diary.md', 'not for agents: vault bridge\n');
    write(vault, 'Work/HR/review.md', 'HR vault bridge\n');
    write(vault, 'Notes/HR/ok.md', 'not under Work\n');
    write(vault, '.env', 'API_KEY=vault-bridge-fixture\n');
    write(vault, 'Keys/id_ed25519', 'vault bridge private key\n');
    write(vault, '.obsidian/app.json', '{"vault bridge": true}\n');
    write(vault, 'big.md', 'x'.repeat(5000));
    fs.writeFileSync(path.join(vault, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git(vault, 'add', '-A');
    git(vault, 'commit', '--quiet', '-m', 'first');
    git(vault, 'push', '--quiet', 'origin', 'HEAD:main');
    const profile = validateVaultProfile({ root: vault, fetchUrl: server, exclude: ['Private', 'Work/HR/'], maxReadBytes: 4096, fetchEveryMs: 60000 });
    const clock = { t: Date.parse('2026-11-24T18:00:00Z') };
    const reader = new VaultReader(profile, { now: () => clock.t });
    /** Someone else pushes to the server from another checkout. */
    const push = (file, content, message) => {
        if (!fs.existsSync(other)) git(dir, 'clone', '--quiet', server, other);
        git(other, 'pull', '--quiet', 'origin', 'main');
        write(other, file, content);
        git(other, 'add', '-A');
        git(other, 'commit', '--quiet', '-m', message);
        git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    };
    return { dir, server, vault, profile, reader, clock, push };
}

test('vault profile: non-secret settings only, absolute root, https or a local path', () => {
    const root = path.resolve('/vault');
    assert.deepEqual(validateVaultProfile({ root }), { root, branch: 'main', exclude: [], maxReadBytes: 256 * 1024, fetchEveryMs: 300000 });
    assert.equal(validateVaultProfile({ root, fetchUrl: 'https://gitea.home.example/skylar/vault.git' }).fetchUrl, 'https://gitea.home.example/skylar/vault.git');
    assert.throws(() => validateVaultProfile({ root, token: 'abc' }), /takes no "token"/);
    assert.throws(() => validateVaultProfile({ root, fetchUrl: 'https://me:secret@gitea.home.example/vault.git' }), /no user name or password/);
    assert.throws(() => validateVaultProfile({ root, fetchUrl: 'http://gitea.home.example/vault.git' }), /https/);
    assert.throws(() => validateVaultProfile({ root, fetchUrl: 'ssh://git@gitea/vault.git' }), /https/);
    assert.throws(() => validateVaultProfile({ root: 'vault' }), /absolute/);
    for (const branch of ['../main', 'a..b', 'main.lock', '/main', 'ma in', '-x'.replace('-', '..')]) assert.throws(() => validateVaultProfile({ root, branch }), /branch/);
    assert.throws(() => validateVaultProfile({ root, exclude: ['../x'] }), /exclude/);
    assert.throws(() => validateVaultProfile({ root, maxReadBytes: 2 * 1024 * 1024 }), /maxReadBytes/);
    assert.throws(() => validateVaultProfile({ root, fetchEveryMs: 1000 }), /fetchEveryMs/);
});

test('paths: vault-relative only, no "..", no drive letters, backslashes allowed', () => {
    assert.equal(cleanPath('Projects/notes.md'), 'Projects/notes.md');
    assert.equal(cleanPath('Projects\\notes.md'), 'Projects/notes.md');
    assert.equal(cleanPath('./Projects/'), 'Projects');
    assert.equal(cleanPath('', { allowRoot: true }), '');
    assert.equal(cleanPath(''), null);
    for (const bad of ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'C:x', 'a//b', ':(top)x', 'a\u0000b', 'x'.repeat(600)]) assert.equal(cleanPath(bad), null, bad);
});

test('exclusions: built-in secrets and app config always, profile names anywhere, slashed folders from the top', () => {
    const ex = exclusions(['Private', 'Work/HR/', '*.pdf']);
    for (const p of ['.env', 'a/.env.local', '.obsidian', '.obsidian/app.json', 'x/.git/config', 'keys/id_ed25519', 'k.kdbx', 'c.PEM', 'Private', 'a/Private/b.md', 'Work/HR', 'Work/HR/r.md', 'doc.pdf'])
        assert.equal(ex(p), true, p);
    for (const p of ['', 'README.md', 'Notes/HR/ok.md', 'Work/notes.md', 'secret-broker-design.md', 'Projects/env.md'])
        assert.equal(ex(p), false, p);
    assert.ok(BUILTIN_EXCLUDES.includes('.obsidian/'));
});

test('reads come from the fetched ref: status, list, search and read, with exclusions and limits', async t => {
    const { reader } = fixture(t);
    const status = await reader.handle('status');
    assert.match(status.commit, /^[0-9a-f]{40}$/);
    assert.equal(status.branch, 'main');
    assert.equal(status.fetch_ok, true);
    assert.equal(status.stale_seconds, 0);
    assert.ok(Date.parse(status.as_of));

    const top = await reader.handle('list', {});
    assert.deepEqual(top.entries.map(e => e.path).sort(), ['Keys', 'Notes', 'Projects', 'README.md', 'Work', 'big.md', 'image.png']);
    assert.deepEqual(top.entries.find(e => e.path === 'README.md'), { path: 'README.md', kind: 'file', bytes: Buffer.byteLength('# Vault\nThe vault bridge reads this.\n') });
    const deep = await reader.handle('list', { path: 'Projects', depth: 2 });
    assert.deepEqual(deep.entries.map(e => e.path), ['Projects/Deep', 'Projects/Deep/plan.md', 'Projects/back-channel.md']);
    const keys = await reader.handle('list', { path: 'Keys' });
    assert.deepEqual(keys.entries, []);
    const work = await reader.handle('list', { path: 'Work', depth: 3 });
    assert.deepEqual(work.entries, []);
    await assert.rejects(reader.handle('list', { path: 'Private' }), e => e.vaultCode === 'excluded');
    await assert.rejects(reader.handle('list', { path: 'README.md' }), e => e.vaultCode === 'not_a_folder');
    await assert.rejects(reader.handle('list', { path: 'Nope' }), e => e.vaultCode === 'not_found');
    await assert.rejects(reader.handle('list', { path: '../x' }), e => e.vaultCode === 'bad_path');

    const found = await reader.handle('search', { query: 'VAULT BRIDGE' });
    assert.deepEqual(found.matches.map(m => m.path).sort(), ['Projects/back-channel.md', 'README.md']);
    assert.deepEqual(found.matches.find(m => m.path === 'README.md'), { path: 'README.md', line: 2, text: 'The vault bridge reads this.' });
    const scoped = await reader.handle('search', { query: 'vault bridge', path: 'Projects' });
    assert.deepEqual(scoped.matches.map(m => m.path), ['Projects/back-channel.md']);
    assert.deepEqual((await reader.handle('search', { query: 'no such words anywhere' })).matches, []);
    await assert.rejects(reader.handle('search', { query: '' }), e => e.vaultCode === 'bad_request');

    const note = await reader.handle('read', { path: 'Projects/back-channel.md' });
    assert.equal(note.text, 'Back Channel notes\nvault bridge: reads only\n');
    assert.equal(note.version, 'sha256:' + createHash('sha256').update(note.text).digest('hex'));
    assert.equal(note.bytes, Buffer.byteLength(note.text));
    for (const p of ['.env', 'Keys/id_ed25519', '.obsidian/app.json', 'Private/diary.md', 'Work/HR/review.md'])
        await assert.rejects(reader.handle('read', { path: p }), e => e.vaultCode === 'excluded', p);
    await assert.rejects(reader.handle('read', { path: 'big.md' }), e => e.vaultCode === 'too_large' && e.bytes === 5000);
    await assert.rejects(reader.handle('read', { path: 'image.png' }), e => e.vaultCode === 'binary');
    await assert.rejects(reader.handle('read', { path: 'Projects' }), e => e.vaultCode === 'not_a_file');
    await assert.rejects(reader.handle('read', { path: 'Projects/missing.md' }), e => e.vaultCode === 'not_found');
    await assert.rejects(reader.handle('write', { path: 'x' }), e => e.vaultCode === 'bad_request');
});

test('the working tree, index, branches and FETCH_HEAD are never touched; unpushed edits are not served', async t => {
    const { vault, reader, push } = fixture(t);
    write(vault, 'README.md', '# Vault\nlocal edit, not committed\n');
    write(vault, 'Projects/local.md', 'committed locally, not pushed\n');
    git(vault, 'add', 'Projects/local.md');
    git(vault, 'commit', '--quiet', '-m', 'local only');
    push('Projects/server.md', 'pushed by another PC\n', 'from elsewhere');
    const before = { status: git(vault, 'status', '--porcelain'), head: git(vault, 'rev-parse', 'HEAD'), branches: git(vault, 'for-each-ref', 'refs/heads', 'refs/remotes'), index: fs.readFileSync(path.join(vault, '.git', 'index')) };

    assert.equal((await reader.handle('read', { path: 'README.md' })).text, '# Vault\nThe vault bridge reads this.\n');
    assert.equal((await reader.handle('read', { path: 'Projects/server.md' })).text, 'pushed by another PC\n');
    await assert.rejects(reader.handle('read', { path: 'Projects/local.md' }), e => e.vaultCode === 'not_found');

    assert.equal(git(vault, 'status', '--porcelain'), before.status);
    assert.equal(git(vault, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(vault, 'for-each-ref', 'refs/heads', 'refs/remotes'), before.branches);
    assert.deepEqual(fs.readFileSync(path.join(vault, '.git', 'index')), before.index);
    assert.equal(fs.existsSync(path.join(vault, '.git', 'FETCH_HEAD')), false);
    assert.match(git(vault, 'for-each-ref', '--format=%(refname)', 'refs/bc-vault'), /^refs\/bc-vault\/main\n$/);
});

test('freshness: fetches only when due, and serves the last fetch with its age when the server is down', async t => {
    const { server, reader, clock, push } = fixture(t);
    const first = await reader.handle('status');
    push('new.md', 'newer\n', 'second');
    clock.t += 30000; // not due yet (fetchEveryMs 60 s)
    const cached = await reader.handle('status');
    assert.equal(cached.commit, first.commit);
    assert.equal(cached.stale_seconds, 30);
    clock.t += 31000;
    const fetched = await reader.handle('status');
    assert.notEqual(fetched.commit, first.commit);
    assert.equal(fetched.stale_seconds, 0);
    assert.equal((await reader.handle('read', { path: 'new.md' })).text, 'newer\n');

    fs.renameSync(server, server + '.away');
    clock.t += 120000;
    const down = await reader.handle('read', { path: 'new.md' });
    assert.equal(down.text, 'newer\n');
    assert.equal(down.fetch_ok, false);
    assert.equal(down.stale_seconds, 120);
    assert.equal(down.commit, fetched.commit);
});

test('never fetched and unreachable: not_fetched, with a fixed sentence', async t => {
    const { vault, dir } = fixture(t);
    const reader = new VaultReader(validateVaultProfile({ root: vault, fetchUrl: path.join(dir, 'missing.git') }));
    await assert.rejects(reader.handle('status'), e => e.vaultCode === 'not_fetched' && e.message === ERRORS.not_fetched);
});

test('a read-only token goes to git in the environment, with saved credentials switched off', async () => {
    const calls = [];
    const execFileImpl = (file, args, options, callback) => { calls.push({ file, args, env: options.env }); callback(null, '', ''); };
    const profile = validateVaultProfile({ root: path.resolve('/vault'), fetchUrl: 'https://gitea.home.example/skylar/vault.git', branch: 'main' });
    await new VaultGit(profile, { token: 'fixture-read-only-token-1234', execFileImpl }).fetch();
    const [call] = calls;
    assert.equal(call.file, 'git');
    assert.ok(!call.args.join(' ').includes('fixture-read-only-token'), 'the token is never on the command line');
    assert.deepEqual(call.args.slice(call.args.indexOf('fetch')), ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'https://gitea.home.example/skylar/vault.git', '+refs/heads/main:refs/bc-vault/main']);
    assert.ok(call.args.includes('credential.helper='));
    assert.equal(call.env.GIT_CONFIG_KEY_0, 'http.extraHeader');
    assert.equal(call.env.GIT_CONFIG_VALUE_0, 'Authorization: token fixture-read-only-token-1234');
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
    calls.length = 0;
    await new VaultGit(profile, { execFileImpl }).fetch();
    assert.ok(!calls[0].args.includes('credential.helper='));
    assert.equal(calls[0].env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_KEY_0);
    // Nothing in the reader can write: no git command here changes a branch, the index or the working tree.
    const source = fs.readFileSync(new URL('../src/vault.mjs', import.meta.url), 'utf8');
    for (const verb of ["'commit'", "'push'", "'checkout'", "'reset'", "'pull'", "'merge'", "'rebase'", "'add'", "'stash'", "'update-ref'", "'write-tree'"])
        assert.ok(!source.includes(verb), `vault.mjs never runs git ${verb}`);
});

/** A loopback Back Channel for /api/vault/worker: hands out queued requests, records answers. */
async function fakeBroker(t, { status = 200, error } = {}) {
    const queue = [], results = [], seen = [];
    const server = http.createServer(async (req, res) => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        let body = '';
        for await (const chunk of req) body += chunk;
        const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (req.headers.authorization !== 'Bearer fixture-vault-agent-key') return send(401, { error: 'unauthorized' });
        if (status !== 200) return send(status, { error });
        if (req.method === 'GET' && req.url.startsWith('/api/vault/worker/next')) return send(200, { request: queue.shift() ?? null });
        if (req.method === 'POST' && req.url === '/api/vault/worker/result') { results.push(JSON.parse(body)); return send(200, { ok: true }); }
        send(404, { error: 'not_found' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { queue, results, seen, url: `http://127.0.0.1:${server.address().port}` };
}
const workerFor = (broker, profile, token = 'fixture-vault-agent-key') => ({ config: { broker: broker.url, token, profiles: { vault: profile } }, stopped: false, store: { read: () => null } });

test('run --vault: takes a request, answers from the fetched ref, posts the answer with fixed error sentences', async t => {
    const { profile } = fixture(t);
    const broker = await fakeBroker(t);
    broker.queue.push({ id: 'req_read_000001', op: 'read', args: { path: 'README.md' } });
    const agent = new VaultAgent(workerFor(broker, profile), { log: () => { } });
    await agent.run({ once: true });
    broker.queue.push({ id: 'req_secret_0002', op: 'read', args: { path: '.env' } });
    await agent.run({ once: true });
    broker.queue.push({ id: 'req_write_00003', op: 'write', args: { path: 'x.md', text: 'no' } });
    await agent.run({ once: true });
    assert.equal(broker.results.length, 3);
    assert.equal(broker.results[0].id, 'req_read_000001');
    assert.equal(broker.results[0].ok, true);
    assert.equal(broker.results[0].result.text, '# Vault\nThe vault bridge reads this.\n');
    assert.deepEqual(broker.results[1], { id: 'req_secret_0002', ok: false, error: 'excluded', message: ERRORS.excluded });
    assert.deepEqual(broker.results[2], { id: 'req_write_00003', ok: false, error: 'bad_request', message: ERRORS.bad_request });
    assert.ok(broker.seen.every(s => s.auth === 'Bearer fixture-vault-agent-key'));
    assert.ok(broker.seen.some(s => s.url === '/api/vault/worker/next?wait=0'));
});

test('run --vault: switched off waits quietly; a refused key stops the run', async t => {
    const { profile } = fixture(t);
    const off = await fakeBroker(t, { status: 403, error: 'rollout_off' });
    const logs = [];
    await new VaultAgent(workerFor(off, profile), { log: m => logs.push(m) }).run({ once: true });
    assert.ok(logs.some(m => /switched off/.test(m)));
    const refused = await fakeBroker(t);
    await assert.rejects(new VaultAgent(workerFor(refused, profile, 'wrong-key'), { log: () => { } }).run({ once: true }), e => e.status === 401);
    const connector = await fakeBroker(t, { status: 403, error: 'not_available_to_connectors' });
    await assert.rejects(new VaultAgent(workerFor(connector, profile), { log: () => { } }).run({ once: true }), e => e.status === 403);
    await assert.rejects(new VaultAgent({ config: { broker: off.url, token: 'k', profiles: {} }, store: { read: () => null } }).run({ once: true }), /No local profile named "vault"/);
});
