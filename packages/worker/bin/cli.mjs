#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { identity } from '../src/crypto.mjs';
import { Store } from '../src/store.mjs';
import { Client, Worker } from '../src/worker.mjs';
import { validateProfile } from '../src/runtime.mjs';
import { REMOTE_APP_PROFILE, validateRemoteAppProfile } from '../src/remote-app.mjs';
import { REMOTE_SUPPORT_PROFILE, validateRemoteSupportProfile } from '../src/remote-support.mjs';
import { isExecutorSecret } from '../src/agent-control.mjs';
import { LISTS_PROFILE, ListsAgent, validateListsProfile } from '../src/lists.mjs';
import { ReadinessError, allowSender, candidates, collectReadiness, revokeSender, sendReport, startReadinessReports } from '../src/readiness.mjs';
const help = `bc-worker (Node 22+)\ninit --broker URL --name NAME     Token from BC_AGENT_TOKEN\nenroll                           Register public keys; prints peer trust JSON\nagents                           List enrolled peers (does not trust them)\ntrust --file peer.json            Pin {id,encryptionKey,signingKey} from owner-verified source\nprofile --name NAME --file FILE   Install local approved runtime profile ("remote-app" and "remote-support" must be\n                                 read-only claude; "lists" takes no allowedSenders and is read-only unless it says otherwise)\nsend --target ID --profile NAME --objective-file FILE [--continue-profile NAME] [--remote-session ID]\n     [--executor-secret-from FILE|-]\n                                 --remote-session hands an approved remote app session to --profile remote-app,\n                                 or a running support session to --profile remote-support, which also needs the\n                                 session's executor secret: --executor-secret-from a private file holding it, or -\n                                 to read it from stdin. It is never taken on the command line. remote-app takes one\n                                 too when Back Channel issued it (v1.1)\nrun [--once] [--lists]           Poll and execute approved work/continuations; --lists also works the Lists\n                                 tasks assigned to this agent, one at a time, with the local "lists" profile\n                                 (without Dispatch enrollment, --lists works Lists only). Without --once it also\n                                 reports readiness to Back Channel at start and every 10 minutes\nstatus                           Print durable local journal\ncancel --id UUID                 Cancel your outbound task\nrecover --confirm-stopped        Remove stale lock after owner stops previous worker/tree\nreadiness [--report]             Can an agent use apps on this PC? Non-secret JSON: the AppBridge agent-control pipe\n                                 (a hello only), claude's sign-in (claude auth status) and the agents the remote-app\n                                 profile accepts. --report also sends it to Back Channel\ncandidates                       Your other Dispatch agents, each with its key fingerprint, and whether it is pinned\n                                 and allowed to hand this PC remote app sessions\nallow-sender --id ID --fingerprint XXXX-XXXX-XXXX-XXXX [--claude PATH]\n                                 Let that agent hand this PC remote app sessions. Refused unless its keys from Back\n                                 Channel match the fingerprint you compared on its own PC. Pins it and adds it to the\n                                 remote-app profile (created if missing: claude from --claude or PATH, plan mode)\nrevoke-sender --id ID            Take it off the remote-app profile; unpin it if no other profile names it\nAll commands accept --state DIRECTORY (outside any repository/vault).\nExit 0 success; 1 failure. Enrollment and trust are separate.\nreadiness, candidates, allow-sender and revoke-sender print one JSON object; on failure {"error","message"}.\nNo command prints the agent key or a private key.\n`;
/** The executor secret from a file, or stdin for "-": one secret and nothing else. The error never shows what was read. */
function readExecutorSecret(from) {
    const secret = fs.readFileSync(from === '-' ? 0 : from, 'utf8').trim();
    if (!isExecutorSecret(secret))
        throw Error('--executor-secret-from must hold exactly one executor secret (abx_ and 43 characters)');
    return secret;
}
const JSON_COMMANDS = new Set(['readiness', 'candidates', 'allow-sender', 'revoke-sender']);
const stateDirectory = v => v.state ?? path.join(os.homedir(), '.config', 'back-channel-worker');
/**
 * readiness, candidates, allow-sender and revoke-sender (vault design pc-agent-readiness.md): one JSON object on
 * stdout, or { error, message } and exit 1. The AppBridge owner console reads them, so every failure is a code and a
 * plain sentence. Nothing printed carries the agent key or a private key.
 */
async function jsonCommand(command, v) {
    const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    let unlock = () => { };
    try {
        let store;
        try { store = new Store(stateDirectory(v)); }
        catch (e) { throw new ReadinessError('state', e.message); }
        let config;
        try { config = store.read('config', null); }
        catch { throw new ReadinessError('state_unreadable', "This worker's state can't be read. Set the worker up again."); }
        if (!config) throw new ReadinessError('not_initialized', 'This worker is not set up yet. Run init, then enroll.');
        const client = () => {
            try { return new Client(config); }
            catch { throw new ReadinessError('invalid_broker', "This worker's Back Channel address isn't valid. Set the worker up again."); }
        };
        if (command === 'readiness') {
            const readiness = await collectReadiness({ config });
            if (v.report) {
                const sent = await sendReport(client(), readiness);
                if (!sent.ok) throw new ReadinessError('report_failed', sent.status ? `Back Channel didn't accept the readiness report (HTTP ${sent.status}).` : "Couldn't reach Back Channel to send the readiness report.");
            }
            return print(readiness);
        }
        if (command === 'candidates') return print(await candidates({ config, client: client() }));
        // These two change the local profile and pins, like profile and trust: the worker must be stopped.
        try { unlock = store.lock(); }
        catch { throw new ReadinessError('locked', "The worker is running, or stopped without cleaning up. Stop it first and try again; if it isn't running, run recover --confirm-stopped."); }
        if (command === 'allow-sender') return print(await allowSender({ store, config, client: client(), id: v.id, fingerprint: v.fingerprint, claude: v.claude }));
        return print(revokeSender({ store, config, id: v.id }));
    } catch (e) {
        process.exitCode = 1;
        print(e instanceof ReadinessError ? { error: e.code, message: e.message } : { error: 'failed', message: "Something went wrong. Nothing was changed if the command didn't finish." });
    } finally {
        unlock();
    }
}
async function main() {
    if (Number(process.versions.node.split('.')[0]) < 22)
        throw Error('Node 22 or newer required');
    const { values: v, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['state', 'broker', 'name', 'file', 'target', 'profile', 'objective-file', 'continue-profile', 'id', 'remote-session', 'executor-secret-from', 'fingerprint', 'claude'].map(k => [k, { type: 'string' }]).concat(['once', 'help', 'confirm-stopped', 'lists', 'report'].map(k => [k, { type: 'boolean' }]))) });
    const command = positionals[0];
    if (v.help || !command) {
        console.log(help);
        return;
    }
    if (JSON_COMMANDS.has(command)) return jsonCommand(command, v);
    const store = new Store(stateDirectory(v));
    if (command === 'recover') {
        if (!v['confirm-stopped'])
            throw Error('First stop the previous worker and its children; then pass --confirm-stopped');
        const f = path.join(store.directory, 'worker.lock');
        if (fs.existsSync(f)) {
            const pid = Number(fs.readFileSync(f, 'utf8'));
            try {
                process.kill(pid, 0);
                throw Error('Previous worker PID is still alive');
            }
            catch (e) {
                if (e.code !== 'ESRCH')
                    throw e;
            }
            fs.unlinkSync(f);
        }
        const releaseRecoveryLock = store.lock();
        try { await new Worker(store).recover({confirmStopped: true}); }
        finally { releaseRecoveryLock(); }
        console.log('Confirmed recovery recorded. Interrupted jobs will not replay; submit a new task after reviewing side effects.');
        return;
    }
    const unlock = ['send', 'status', 'cancel', 'agents'].includes(command) ? () => { } : store.lock();
    try {
        if (command === 'init') {
            if (store.read('config', null))
                throw Error('Already initialized');
            if (!process.env.BC_AGENT_TOKEN || !v.broker || !v.name)
                throw Error('init needs --broker, --name and BC_AGENT_TOKEN');
            const config = { broker: v.broker, name: v.name, token: process.env.BC_AGENT_TOKEN, identity: identity(), peers: {}, profiles: {} };
            new Client(config);
            store.write('config', config);
            console.log('Initialized protected local state. Run enroll next.');
            return;
        }
        const config = store.read('config', null);
        if (!config)
            throw Error('Run init first');
        if (command === 'enroll') {
            const { agent } = await new Client(config).request('/agents', { name: config.name, encryptionKey: config.identity.encryptionKey, signingKey: config.identity.signingKey });
            config.agentId = agent.id;
            store.write('config', config);
            console.log(JSON.stringify({ id: agent.id, name: config.name, encryptionKey: config.identity.encryptionKey, signingKey: config.identity.signingKey }, null, 2));
            return;
        }
        if (command === 'trust') {
            const peer = JSON.parse(fs.readFileSync(v.file, 'utf8'));
            if (!peer.id || !peer.encryptionKey || !peer.signingKey)
                throw Error('Invalid peer file');
            if (config.peers[peer.id] && JSON.stringify(config.peers[peer.id]) !== JSON.stringify({ encryptionKey: peer.encryptionKey, signingKey: peer.signingKey }))
                throw Error('Existing pin differs; explicit manual key rotation required');
            config.peers[peer.id] = { encryptionKey: peer.encryptionKey, signingKey: peer.signingKey };
            store.write('config', config);
            console.log('Peer pinned');
            return;
        }
        if (command === 'profile') {
            if (!v.name)
                throw Error('--name required');
            const parsed = JSON.parse(fs.readFileSync(v.file, 'utf8'));
            const profile = v.name === REMOTE_APP_PROFILE ? validateRemoteAppProfile(parsed) : v.name === REMOTE_SUPPORT_PROFILE ? validateRemoteSupportProfile(parsed) : v.name === LISTS_PROFILE ? validateListsProfile(parsed) : validateProfile(parsed);
            if (profile.adapter === 'fixture')
                throw Error('Fixture adapter is test-only and cannot be installed by CLI');
            config.profiles[v.name] = profile;
            store.write('config', config);
            console.log('Local profile installed');
            return;
        }
        const worker = new Worker(store);
        if (command === 'agents')
            console.log(JSON.stringify(await worker.client.request('/agents'), null, 2));
        else if (command === 'status')
            console.log(JSON.stringify(worker.journal, (k, value) => k === 'leaseToken' ? undefined : value, 2));
        else if (command === 'send') {
            if (!v.target || !v.profile || !v['objective-file'])
                throw Error('send needs --target, --profile, --objective-file');
            const executorSecret = v['executor-secret-from'] === undefined ? undefined : readExecutorSecret(v['executor-secret-from']);
            console.log(await worker.send({ targetAgentId: v.target, profile: v.profile, objective: fs.readFileSync(v['objective-file'], 'utf8'), continuationProfile: v['continue-profile'], remoteAppSessionId: v['remote-session'], executorSecret }));
        }
        else if (command === 'cancel') {
            if (!v.id)
                throw Error('--id required');
            await worker.client.request(`/tasks/${encodeURIComponent(v.id)}/cancel`, {});
            console.log('Cancellation requested');
        }
        else if (command === 'run') {
            await worker.recover();
            // --lists: the always-on agent loop (src/lists.mjs) beside Dispatch, sharing this state, lock and journal.
            // It needs no Dispatch enrollment; without one, only Lists runs.
            const lists = v.lists ? new ListsAgent(worker) : null;
            lists?.recover();
            const dispatch = !lists || Boolean(config.agentId);
            if (!dispatch) console.error('Not enrolled for Dispatch: working Lists tasks only.');
            let stopped = false, failures = 0;
            // Readiness for the dashboard and the AppBridge console: at start and every 10 minutes. A failed report is
            // logged and the run carries on. Not with --once (a single pass), nor when recovery is required (it exits).
            const reports = v.once || worker.journal.recoveryRequired ? null : startReadinessReports({ config, client: worker.client, log: message => console.error(message) });
            const stop = () => { stopped = true; reports?.stop(); worker.stop(); lists?.stop(); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            const dispatchLoop = async () => {
                do {
                    try {
                        await worker.cycle();
                        worker.assertReady();
                        failures = 0;
                    }
                    catch (e) {
                        worker.assertReady();
                        if (v.once || [401, 403].includes(e.status))
                            throw e;
                        failures++;
                        console.error(`Worker cycle failed; retrying durable work: ${e.message}`);
                    }
                    if (!v.once && !stopped && !worker.stopped)
                        await new Promise(r => setTimeout(r, Math.min(60000, 5000 * 2 ** Math.min(failures, 4))));
                } while (!v.once && !stopped && !worker.stopped);
            };
            // Either loop failing stops the other; the lock is released only once both have wound down.
            const loop = promise => promise.catch(e => { stop(); throw e; });
            try {
                const outcomes = await Promise.allSettled([dispatch ? loop(dispatchLoop()) : null, lists ? loop(lists.run({ once: v.once })) : null]);
                const failed = outcomes.find(o => o.status === 'rejected');
                if (failed) throw failed.reason;
                worker.assertReady();
            }
            finally {
                reports?.stop();
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
            }
        }
        else
            throw Error('Unknown command; use --help');
    }
    finally {
        unlock();
    }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
