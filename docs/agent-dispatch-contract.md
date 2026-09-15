# Agent dispatch pilot contract

This pilot adds same-account, explicitly enrolled agent workers. Existing friend
conversations and message bodies do not become executable jobs. The relay stores
encrypted task/result envelopes; local policy decides which jobs may run.

## API (v1)

All routes use per-agent bearer authentication (`getAuthContext` with a non-null
agentTokenId); cookie and legacy account-only authentication are rejected. All
responses are no-store. Agent IDs are existing AgentToken IDs. Revocation applies
to every operation. Routes are below `/api/dispatch`.

- `GET /agents`: active enrolled same-account agents, public keys and names.
- `POST /agents`: enroll caller with `{name, encryptionKey, signingKey}` (PEM
  X25519/Ed25519 public keys). Keys are immutable after enrollment; identical
  enrollment is idempotent. Return `{agent}` including `id`. No secrets returned.
- `GET /tasks`: paginated inbox/outbox metadata and sealed envelopes visible only
  to the sender or recipient. Return `{tasks}`. Task rows include `id`,
  `senderAgentId`, `targetAgentId`, `status`, `expiresAt`, `sealed`, `resultSealed`,
  and `updatedAt`. Pages contain at most 50 rows, ordered by immutable creation
  time and ID, and `nextCursor` (or null); pass it as `?cursor=` to continue.
  Never include lease hashes or tokens. Account active-task quota is 100.
- `POST /tasks`: `{id, targetAgentId, expiresAt, sealed}`; id is a UUID generated
  by the sender. Expiry is at most 24 hours. Same exact request is idempotent;
  conflicting reuse returns 409. Recipient must be enrolled, active, same account,
  and different from sender. Sealed strings are at most 128 KiB.
- `POST /tasks/:id/claim`: recipient only, atomically queued -> running; return
  `{task, leaseToken}` with a random secret lease stored hashed. Lease lasts 90s.
- `POST /tasks/:id/heartbeat`: `{leaseToken}`; renew only the active unexpired
  lease and unexpired task. No automatic replay after an expired execution lease.
- `POST /tasks/:id/result`: `{leaseToken,status,sealed}`; status is completed,
  failed, waiting_user, or interrupted. Atomically finish valid active lease.
  Exact retries are idempotent; never overwrite a different result.
- `POST /tasks/:id/cancel`: sender only; queued/running -> cancelled. Worker
  heartbeat detects cancellation and stops its child. Terminal jobs stay terminal.
- `POST /tasks/:id/reject`: recipient only; queued -> rejected, idempotently.
  No plaintext reason is stored. Unknown peers/profiles can be rejected without
  decrypting or producing a trusted runtime result. Sender reports this as relay
  status, never fabricated execution evidence.

Serialization/unique-write contention returns retryable HTTP 503; HTTP 409 means
an actual conflicting request or inactive lease. Workers must preserve outbox
items across retryable delivery failures without executing the task again.

Expired queued tasks become expired. Expired running leases become interrupted,
never queued again: an external side effect may already have happened. Workers
persist local task IDs before starting a runtime. Broker claim and local journal
jointly prevent blind re-execution after crashes. GET reconciliation is bounded.

## Local worker

Standalone Node 22+ package at `packages/worker`, no model calls for empty polls.
Outbound HTTPS only (explicit loopback HTTP for development). One worker process
per local state directory. Runtime executable, repository directory, peer public
keys and named authorization profiles are local owner-controlled configuration.
No task may supply an executable, command-line flags, environment or working
directory. Secrets are in local protected storage, never the vault or repo.

The authenticated encrypted request contains `v:1`, matching task/sender/target
IDs and expiry, `profile`, `objective`, optional repository commit and vault-note
reference, and acceptance criteria. Worker pins both peer keys locally, verifies
the signed envelope and its routing/expiry binding, then checks the selected
local profile permits that sender. A message is not a permission grant.

Use X25519 ephemeral agreement + HKDF-SHA256 + AES-256-GCM and Ed25519 sender
signature. Bind routing IDs, expiry and purpose (task/result) cryptographically.
The broker only sees the serialized sealed envelope, never prompt/result text.
Enrollment alone does not approve peers or execution. Unknown peers/profiles fail
closed without invoking a model.

Runtime adapters invoke installed CLIs with argument arrays and stdin prompts,
without shell interpolation or permission-bypass switches. Use configured local
repositories and the runtime's approval/sandbox controls. Exit or approval-needed
results must be reported honestly. Task completion requires a captured result;
delivery or process creation is not completion. Runtime, output and polling are
bounded. Cancellation stops the child process tree. Durable outbox retries return
delivery without rerunning work. Sender-side result processing uses a locally
configured continuation profile and marks result consumption durably before
launch; interrupted continuations require explicit recovery, not blind replay.

## Acceptance

Verify same-account and per-agent isolation, revocation, duplicate send/claim,
lost replies, expired lease, interrupted runtime, local restart, cancellation,
untrusted peer/profile, envelope tampering and task/result replay rejection.
Exercise the full task -> receiver runtime -> sealed result -> sender continuation
loop locally with deterministic runtime fixtures, then a real installed CLI.
Two-machine ARM deployment still requires its one-time local enrollment.
