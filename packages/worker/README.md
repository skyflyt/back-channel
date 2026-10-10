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
  "maxOutputBytes": 32000,
  "maxTranscriptBytes": 1048576
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
not establish completion. Final result text is limited to 32,000 UTF-8 bytes
(`maxOutputBytes`); oversized results fail instead of being silently truncated.
Codex and Claude stdout/stderr transcripts have a separate combined budget of
1 MiB by default. A local profile may set `maxTranscriptBytes` to a positive
integer up to 4 MiB. Crossing that budget interrupts execution. Execution is
limited to one hour per invocation; profile limits may be lower. Test fixtures
retain their original combined stdout/stderr `maxOutputBytes` limit.

`status` prints the durable journal, excluding lease tokens. `cancel --id UUID`
cancels an outbound task; heartbeat loss stops the receiver's child process tree.
Send, status, agents and cancel remain available while the daemon runs.

### Remote app sessions

A profile named `remote-app` lets this worker drive an app that you approved for a remote app session in
Back Channel. It uses the PC's AppBridge "Allow agent control" pipe, and the profile must be read-only. Install
it like any profile (`profile --name remote-app --file remote-app.json`), naming the agent that hands sessions
over in `allowedSenders`. That agent sends with
`send --target THIS_AGENT --profile remote-app --remote-session SESSION_ID --objective-file goal.txt`.

The worker checks the session with Back Channel first and runs the CLI with one extra capability, its own MCP
server (`remote_sessions`, `remote_open`, `remote_observe`, `remote_act`, `remote_note`, `remote_end`). It
reports every step, and stops the CLI when the session is stopped, runs out of time or loses its lease. See
`docs/remote-app-sessions.md` ("Executor").

When Back Channel issued the session an executor secret (v1.1), add `--executor-secret-from FILE` (or `-` to read
it from stdin). The worker sends it in the PC's pipe greeting and nowhere else. Without one, nothing changes.

### Is this PC ready for agents?

Six things must all be true before one of your agents can use an app on this PC: AppBridge 1.1.32 or newer, the PC
registered with Back Channel, "Allow agent control" on, this worker set up and running, at least one agent allowed
to hand it sessions, and claude signed in. AppBridge's owner console (Agents page) and the Remote page of the Back
Channel dashboard show the same checklist. These commands feed both. Each prints one JSON object, or
`{ "error": "<code>", "message": "<plain sentence>" }` with exit code 1. None prints the agent key or a private key.

- `readiness` prints what this worker can tell: its agent id, name and key fingerprint, the AppBridge agent-control
  pipe (`listening`, `absent`, `refused` or `error`, and the PC's name), whether claude is installed and signed in, and
  which agents the `remote-app` profile accepts. The pipe probe is a v1 `hello` and nothing else (no session op, never
  an executor secret). Sign-in comes from `claude auth status`: exit 0 is signed in, 1 is not, anything else is
  `null`. The claude used is the `remote-app` profile's, or a native `claude` (`claude.exe`) on `PATH`. It runs with
  fixed arguments, no shell and a 10-second limit, and only its exit code is read.
- `readiness --report` also sends it to Back Channel (`PUT /api/agents/self/readiness`) without the claude path, the
  pipe's reason or the senders' names. `run` does this at start and every 10 minutes (not with `--once`). A failed
  report is logged and the run carries on. Back Channel calls a report older than 30 minutes "not reporting".
- `candidates` lists your other Dispatch agents with their key fingerprints, and whether each is pinned and allowed.
- `allow-sender --id AGENT --fingerprint XXXX-XXXX-XXXX-XXXX [--claude PATH]` lets that agent hand this PC remote app
  sessions. Compare the fingerprint with the one that agent's own PC shows (its AppBridge checklist, or the dashboard).
  The worker fetches the agent's keys from Back Channel, fingerprints them itself and refuses (`fingerprint_mismatch`)
  unless they match, so a compromised Back Channel can't slip in a sender. It then pins the agent and adds it to the
  `remote-app` profile. With no such profile it creates one: claude from `--claude` or `PATH`, `plan` mode, a one-hour
  limit, and an empty `remote-app` folder beside the state directory as its working directory.
- `revoke-sender --id AGENT` takes it off the `remote-app` profile, and unpins it if no other profile names it.

The fingerprint is the first 16 hex characters of the uppercase SHA-256 of `signingKey + "\n" + encryptionKey` (the
public Dispatch keys exactly as enrolled), in groups of four: `AB12-CD34-EF56-7890`. Back Channel computes it the same
way. `allow-sender` and `revoke-sender` change the local profile, so stop the worker first (`locked` otherwise).

### Support sessions

A profile named `remote-support` lets this worker carry out a support session: someone you help ran Back Channel's
temporary helper and pressed Allow, and AppBridge on this PC ("Allow this PC to reach helpers I approve") bridges
its support connector pipe across the relay to that helper. Install the profile like `remote-app`
(`profile --name remote-support --file remote-support.json`: read-only claude, naming the agent that hands sessions
over in `allowedSenders`). That agent reads the session's executor secret once from `bc_support_status`, writes it
to a private file (or pipes it in), and sends:

```
send --target THIS_AGENT --profile remote-support --remote-session SESSION_ID --objective-file task.txt
     --executor-secret-from secret.txt
```

The secret is never taken on a command line, where other processes could read it. Delete the file afterwards.

The CLI gets the same six `remote_*` tools as `remote-app`, worded for the person in control: they confirm each
open and act on their own screen, and when they say no (`declined`), the agent is told not to work around it.
Nothing pauses, and **this worker records nothing with Back Channel**: the helper on the other PC records every step.
At the end the worker sends `end` over the pipe and returns the agent's summary in the sealed result. The asking agent
then calls `bc_support_end` to close the request and get the transcript. If the support connector isn't running, the
result is `waiting_user` with the switch to turn on. See `docs/agent-dispatch-contract.md` ("The remote-support
profile").

### Lists: an always-on agent

`run --lists` also makes this worker an always-on agent for Back Channel Lists. Assign a task to this agent (in
the dashboard, "Give to…" this agent) and it starts on it: it waits on the inbox doorbell, reads its plate, claims
one open task assigned to it that its person wrote or OK'd, and runs the CLI from the local profile named `lists`.
It works one task at a time and reports with progress lines, a summary when it finishes, or a plain reason when it
lets go. See `docs/lists.md` ("Worker: always-on agent").

1. Use an agent key of its own (`BC_AGENT_TOKEN` at `init`), and give that agent `work` access on the lists it
   should work, in the dashboard. Lists mode needs no `enroll` or `trust`. Without Dispatch enrollment, `run --lists`
   works Lists only.
2. Install the profile. It takes no `allowedSenders` (no Dispatch sender may use it) and is read-only by default:

   ```json
   {
     "adapter": "claude",
     "executable": "C:/absolute/path/to/claude.exe",
     "cwd": "C:/absolute/path/to/a/folder/it/may/read",
     "maxRuntimeMs": 3600000
   }
   ```

   `profile --name lists --file lists.json`. Claude runs with shell, file writes and the web refused. To let it
   change files and run commands in `cwd`, add `"sandbox": "workspace-write"` and `"permissionMode": "manual"`; the
   web stays refused. Codex is allowed only with `"sandbox": "read-only"` written in the profile. Its sandbox can
   still run read-only shell commands, and Back Channel hears only what it reports. `"takeUnassigned": true` also
   takes unassigned tasks this agent could claim (default: only tasks assigned to it). Set `maxRuntimeMs` (up to an
   hour) to cover the work you give it; the default is 5 minutes.
3. Run `run --lists` (the daemon) or `run --lists --once` (read the plate once, work at most one task).

The CLI gets the task's title and notes as data, after a fixed preamble, and one extra capability: the worker's
own MCP server (`task_progress`, `task_comment`, `task_block`, `task_done`, `task_release`), bound to that one task.
The worker keeps the claim alive only near its 60-minute lapse while the CLI still runs. It kills the CLI when the
claim is lost (you took the task back or gave it to someone else) and lets the task go when the CLI stops without
finishing. A task it has worked isn't picked again until someone changes it.

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
`test/lists.test.mjs` covers lists mode against a loopback broker that uses the broker's own Lists rules and a
fixture agent CLI that speaks MCP. `test/remote-support.test.mjs` covers the remote-support profile against a
fixture support connector pipe that checks the executor secret's hash, a loopback Back Channel that must receive
nothing, and the same fixture agent CLI.
Real broker integration and installed-CLI acceptance are separate integration
checks; passing a fixture test does not claim a remote machine was enrolled.
