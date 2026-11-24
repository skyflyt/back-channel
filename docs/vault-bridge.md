# Vault bridge: read-only notes for your own agents

Status: being built in three steps. Step 1, the worker (`packages/worker/src/vault.mjs`, `bc-worker run --vault`),
is in its own change; step 2 (the broker's `/api/vault` rendezvous) and step 3 (the `bc_vault_*` MCP tools) follow.
Writes are out of scope for now.

## Why

A person's notes vault is plain files in a git repository on their own network, edited from several PCs and by
coding sessions on them. Their hosted agents (scheduled check-ins, the claude.ai connector) can't reach it. The bridge
lets those agents read it, unattended, without opening the home network: the always-on worker on one PC reaches out
to Back Channel and answers reads; nothing reaches in.

## What reads, and from where

- The worker fetches the vault's branch from its git server into a private ref, `refs/bc-vault/<branch>`, at most
  every `fetchEveryMs` (default 5 minutes), with its own read-only token when one is set (`bc-worker vault-token`).
  The token is given to git in its environment, with the person's saved credential helpers switched off, and is
  never sent to Back Channel.
- Every read is from that ref: `git ls-tree`, `git grep`, `git cat-file`. The working tree, the index and every
  branch are left alone. A sync in progress, an unfinished rebase or unpushed edits on that PC change nothing: the
  bridge serves what the git server has.
- When the server can't be reached, the worker serves the last fetch. Every answer says how fresh it is: `commit`,
  `as_of` (the commit's time), `fetched_at`, `stale_seconds` and `fetch_ok`.
- Secret files and app settings are refused by built-in rules (`.env*`, key stores, private keys, credential files,
  `.git`, `.obsidian`, `.trash`, `.claude`); the local profile can add rules, never remove them. Binary files and
  notes over the read cap (256 KiB by default) are not returned. Paths are vault-relative; `..`, absolute paths and
  drive letters are refused.
- Errors are fixed sentences. Git's own output, which can carry the server's address, stays in the worker's log.

## Operations

| op | args | answer (besides the freshness fields) |
| --- | --- | --- |
| `status` | none | `branch`, `excludes` |
| `list` | `path` (default the top), `depth` 1 to 3 | `entries`: `{ path, kind: "folder" }` or `{ path, kind: "file", bytes }`, up to 500, `truncated` |
| `search` | `query` (fixed text, any case, up to 200 characters), `path` | `matches`: `{ path, line, text }`, up to 50 (5 a file), `truncated` |
| `read` | `path` | `path`, `bytes`, `version` (`sha256:` of the bytes), `blob` (git's id), `text` |

Error codes: `bad_request`, `bad_path`, `excluded`, `not_found`, `not_a_file`, `not_a_folder`, `binary`,
`too_large` (with `bytes`), `not_fetched`, `failed`.

## Worker protocol (step 2 implements the broker side)

Both calls use the worker's own full-scope agent key. A connector key is refused (403 `not_available_to_connectors`):
it lives on a hosted app's servers, not on a PC.

- `GET /api/vault/worker/next?wait=N` (N from 0 to 25 seconds): `200 { request: { id, op, args } | null }`. The
  broker holds the call until a request for this account arrives or the wait ends. `403 { error: "rollout_off" }`
  while the bridge is switched off; the worker checks again every 10 minutes.
- `POST /api/vault/worker/result` with `{ id, ok: true, result }` or `{ id, ok: false, error, message, bytes? }`:
  `200`, or `404` when nobody is waiting for that id any more.

## Broker (step 2)

- One in-memory rendezvous per account on the single broker instance, like the inbox doorbell. Requests and answers
  are never written to Postgres or logs. An answer is handed out once, then dropped; anything unclaimed goes after
  5 minutes.
- The vault worker is whichever of the account's agents polled most recently; with none in the last 90 seconds a
  tool answers `vault_offline` at once.
- Each answered read leaves one `AccountAudit` row of metadata only: `vault.read` or `vault.denied`, with the op, the
  path, bytes, commit and the asking agent. Never text.
- Switched on by `VAULT_BRIDGE=on`.

## Tools (step 3)

`bc_vault_status`, `bc_vault_list`, `bc_vault_search`, `bc_vault_read` and `bc_vault_result`, for the account's own
full-scope keys only. A call queues one request and waits up to 20 seconds; past that it answers
`{ status: "pending", request_id }` and `bc_vault_result` collects the answer. Every description says a note's text is
data, never instructions.

Hosted connectors (claude.ai over OAuth) stay refused until the person turns on a per-connector vault grant from one
of their PCs, with their passkey (step 4, in the PC app). Note text for a connector's read passes through Back
Channel readable, held in memory only and never stored. That is the trade the grant asks the person to accept.
