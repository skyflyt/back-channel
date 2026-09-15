#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { identity } from '../src/crypto.mjs';
import { Store } from '../src/store.mjs';
import { Client, Worker } from '../src/worker.mjs';
import { validateProfile } from '../src/runtime.mjs';
const help = `bc-worker (Node 22+)\ninit --broker URL --name NAME     Token from BC_AGENT_TOKEN\nenroll                           Register public keys; prints peer trust JSON\nagents                           List enrolled peers (does not trust them)\ntrust --file peer.json            Pin {id,encryptionKey,signingKey} from owner-verified source\nprofile --name NAME --file FILE   Install local approved runtime profile\nsend --target ID --profile NAME --objective-file FILE [--continue-profile NAME]\nrun [--once]                     Poll and execute approved work/continuations\nstatus                           Print durable local journal\ncancel --id UUID                 Cancel your outbound task\nrecover --confirm-stopped        Remove stale lock after owner stops previous worker/tree\nAll commands accept --state DIRECTORY (outside any repository/vault).\nExit 0 success; 1 failure. Enrollment and trust are separate.\n`;
async function main() {
    if (Number(process.versions.node.split('.')[0]) < 22)
        throw Error('Node 22 or newer required');
    const { values: v, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['state', 'broker', 'name', 'file', 'target', 'profile', 'objective-file', 'continue-profile', 'id'].map(k => [k, { type: 'string' }]).concat(['once', 'help', 'confirm-stopped'].map(k => [k, { type: 'boolean' }]))) });
    const command = positionals[0];
    if (v.help || !command) {
        console.log(help);
        return;
    }
    const store = new Store(v.state ?? path.join(os.homedir(), '.config', 'back-channel-worker'));
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
        await new Worker(store).recover();
        console.log('Interrupted jobs will not replay; submit a new task after reviewing side effects.');
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
            const profile = validateProfile(JSON.parse(fs.readFileSync(v.file, 'utf8')));
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
            console.log(await worker.send({ targetAgentId: v.target, profile: v.profile, objective: fs.readFileSync(v['objective-file'], 'utf8'), continuationProfile: v['continue-profile'] }));
        }
        else if (command === 'cancel') {
            if (!v.id)
                throw Error('--id required');
            await worker.client.request(`/tasks/${encodeURIComponent(v.id)}/cancel`, {});
            console.log('Cancellation requested');
        }
        else if (command === 'run') {
            await worker.recover();
            let stopped = false, failures = 0;
            const stop = () => { stopped = true; worker.stop(); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            try {
                do {
                    try {
                        await worker.cycle();
                        failures = 0;
                    }
                    catch (e) {
                        if (v.once || [401, 403].includes(e.status))
                            throw e;
                        failures++;
                        console.error(`Worker cycle failed; retrying durable work: ${e.message}`);
                    }
                    if (!v.once && !stopped)
                        await new Promise(r => setTimeout(r, Math.min(60000, 5000 * 2 ** Math.min(failures, 4))));
                } while (!v.once && !stopped);
            }
            finally {
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
