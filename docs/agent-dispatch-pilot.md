# Same-owner dispatch pilot

Dispatch lets a local worker receive an authorized job, launch a configured
agent CLI, return an encrypted result, and run a follow-up on the originating
worker. The workers make outbound HTTPS requests; neither machine needs an
inbound port, SSH, or PowerShell remoting.

This starts a new CLI invocation with the task and result context. It does not
resume an arbitrary open desktop conversation. Put the durable handoff in your
shared project notes and reference it in the objective. A continuation profile
lets the originating worker act on the result without a person copying it back.

## One-time Windows setup

Package with `scripts/package-dispatch-worker.ps1 -OutputDirectory <new-path>`.
Transfer the resulting ZIP to the other machine, extract it, and run
`install-dispatch-worker.ps1` in PowerShell. Node.js 22 or newer and a locally
authenticated, compatible agent CLI are prerequisites. The JavaScript worker
has no native dependency, so the same bundle supports Windows x64 and ARM64;
the local Node.js and agent executables must support that machine.

The installer asks for a fresh Back Channel connect code locally. Credentials,
private keys, task text, and results remain in its private local state directory.
Do not put that directory in a shared vault. Follow the printed instructions
and [worker setup](../packages/worker/README.md) to pin each peer's public keys
and approve a project profile. Public enrollment JSON can be exchanged through
an owner-controlled shared vault. Verify which machine produced it before
pinning it. Installations start with no trusted peers or approved profiles.

Begin with read-only profiles on both machines. Send a harmless task asking the
recipient to report the current project commit and whether the working tree is
clean. Have the requester continuation summarize that result. Verify both local
journals and the target commit before approving a workspace-write profile.
Keep each profile limited to a specific project and explicit sender IDs.

## Routine handoff

The requesting agent writes a task file containing the objective, relevant note
path, branch/commit, acceptance criteria, and any work-claim requirements. It
uses the installed CLI's `send --target ... --profile ... --objective-file ...`
command, with `--continue-profile ...` when follow-up is wanted. The worker
receives jobs while the user is signed in and the machine is awake.

The target reports `completed`, `failed`, or `waiting_user`. Approval questions
remain approval questions: receiving a message does not grant new permissions.
Runtime interruption is recorded separately and is never silently retried.
The encrypted queue retains delivery during temporary network outages.

## Acceptance and rollout

Local tests cover the real broker, PostgreSQL, worker encryption, leases, and
child processes. CI uses a deterministic child runtime. The optional
`BC_TEST_CODEX_EXE` integration mode exercises the installed Codex executable;
it is not part of unattended CI and uses the locally configured model.

Before distributing a working pilot, deploy the additive dispatch database
migration and broker routes. Existing production databases may predate Prisma
migration tracking: inspect their schema and migration history before using
`migrate deploy`, which would also run older pending migrations. Do not use
`db push` against production. Rollback can restore the prior broker image while
leaving the unused additive dispatch table and columns in place.

The final acceptance gate is a real two-machine task/result/continuation roundtrip.
A packaged ZIP or passing local fixture does not establish ARM acceptance.
Dashboard job controls, a general fleet rollout, and resuming existing UI tasks
are outside this first pilot.
