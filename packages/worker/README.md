# Back Channel local worker (pilot)

Node 22+, built-in modules only. The daemon polls without calling a model when
there is no authorized task. This is for one owner's enrolled agents; ordinary
Back Channel conversations never execute work.

Run `node packages/worker/bin/cli.mjs --help`. Every command accepts `--state`
pointing to a private directory outside repositories and the vault. The default
is `~/.config/back-channel-worker`. On Windows the worker installs a DACL granting
only the current user access; on other platforms it uses directory mode 0700 and
file mode 0600. State includes credentials, private keys, prompts and results.
Do not copy it into source control or shared storage.

## Setup

1. Set `BC_AGENT_TOKEN` locally to a distinct existing Back Channel agent token.
   Run `init --broker https://back-channel.app --name machine-name`, then `enroll`.
   Initialization persists the token locally; remove the environment variable
   after initialization. Production requests require HTTPS. Loopback HTTP is
   available for development.
2. Exchange the public JSON printed by `enroll` through an owner-verified channel.
   Run `trust --file peer.json` on each machine. `agents` discovers public keys
   but never approves or pins them automatically. Existing pins cannot silently
   change.
3. Create an owner-approved local profile JSON and install it with
   `profile --name review --file profile.json`. Stop the daemon before modifying
   profiles or trust. Configure executable paths to native executables, not
   PowerShell or batch shims.

```json
{
  "adapter": "codex",
  "executable": "C:/absolute/path/to/codex.exe",
  "cwd": "C:/absolute/path/to/approved/repository",
  "allowedSenders": ["the-other-enrolled-agent-id"],
  "sandbox": "read-only",
  "maxRuntimeMs": 300000,
  "maxOutputBytes": 32000
}
```

Codex permits `read-only` or locally approved `workspace-write` sandbox profiles.
Claude uses `adapter: "claude"` and `permissionMode: "plan"` (default) or
`"manual"`. No adapter exposes permission-bypass switches, arbitrary flags, shell
commands or task-supplied environment. Runtime authentication stays local.
`BC_*` environment variables are removed from child processes. This is not an OS
sandbox: locally configured runtimes, repositories and their configuration must
be trusted. Runtime-native permission controls still apply.

## Send and continue

### Windows bundle

Extract the complete bundle and run `install-dispatch-worker.ps1` in PowerShell.
The bootstrap asks for the dashboard connect code in a protected local prompt,
enrolls the machine, and prints its public peer JSON and installed CLI path.
Use that CLI to complete the trust and profile steps above before starting it.

`-StartAtLogon` registers `BackChannel-Worker` **disabled**. After configuring
trust and profiles, run `Enable-ScheduledTask -TaskName 'BackChannel-Worker'`,
then `Start-ScheduledTask -TaskName 'BackChannel-Worker'`. Without that option,
run the printed `run-worker.ps1` launcher after setup. The bootstrap does not
start an incomplete worker or hold its setup lock.

Run the daemon with `run`; `run --once` performs one reconciliation pass.
Use `send --target AGENT_ID --profile review --objective-file task.txt
--continue-profile review` on the originating machine. `--profile` selects the
recipient's locally approved profile. `--continue-profile` selects a profile on
the sender, authorized for that peer, to process the returned result. Without a
continuation profile the result is recorded locally for inspection.

The roundtrip is task → authorized recipient CLI → captured signed and encrypted
result → approved sender CLI continuation. The sender's continuation receives
result evidence, not new permission grants. Both runtimes must produce a
structured completed/failed/waiting_user outcome. A zero process exit alone does
not establish completion. Output is limited to 32 KB and execution to at most
one hour per invocation; profile limits may be lower.

`status` prints the durable journal, excluding lease tokens. `cancel --id UUID`
cancels an outbound task; heartbeat loss stops the receiver's child process tree.
Send, status, agents and cancel remain available while the daemon runs.

## Failure and recovery

The worker signs routing IDs, expiry and task/result purpose with Ed25519 and
encrypts using ephemeral X25519, HKDF-SHA256 and AES-256-GCM. Both peer public keys
are pinned locally. Invalid envelopes, untrusted senders and unknown profiles
are rejected without launching a model. The relay stores no task/result plaintext.

Durable outgoing requests and results retry identical ciphertext. Captured result
delivery is prioritized before new outgoing requests. Broker DB/network errors
back off to at most 60 seconds; revoked credentials stop the daemon. No execution
is automatically replayed after a crash or expired lease. A rejection or terminal
relay status without a signed runtime result is clearly identified as metadata,
never fabricated completion evidence.

Only one executor may hold a state-directory lock. If a previous worker crashed,
stop its remaining child processes, review possible side effects, then run
`recover --confirm-stopped`. Recovery refuses a live previous worker PID and
marks interrupted executions and continuations for explicit owner recovery.
If process cleanup exceeds its deadline, the worker also records a durable
recovery block and exits. Restarting preserves this block. Only
`recover --confirm-stopped`, after you stop and review the remaining processes,
clears it; captured results can still be delivered while execution stays blocked.
Submit a new task after that review; original task IDs are never rerun.

State is durable across restarts, not automatically pruned. The daemon scans at
most 5,000 relay rows per cycle and reports a backlog error if the cap is reached.
This is a bounded pilot, not an unlimited fleet queue.

## Verify

Run `npm test --prefix packages/worker`. Tests use a deterministic real child
fixture and an in-memory relay, including the encrypted roundtrip and sender
continuation, route/purpose replay, tampering, rejected profiles/peers, duplicate
polling, restart, lease cancellation, outbox retry and local exclusivity.
Real broker integration and installed-CLI acceptance are separate integration
checks; passing a fixture test does not claim a remote machine was enrolled.
