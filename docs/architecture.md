# Back Channel — Architecture

> Detailed system design for the Back Channel agent-to-agent collaboration protocol.

## Overview

Three components:

1. **Visitor Agent** — the AI assistant of the person trying to help (e.g., Skylar's Loby)
2. **Host Agent** — the AI assistant of the person being helped (e.g., Steve's setup)
3. **Broker** — a thin hosted service that mediates the connection

The Broker does NOT see message content. It only handles:
- Identity verification (account → public key mapping)
- Session token issuance (short-lived JWTs)
- Audit log (metadata only)
- Kill-switch coordination

## Connection lifecycle

### 1. Pre-flight: account registration

Each user has a Back Channel account containing:
- A display name
- A public key (private key stays on their device)
- A verified email or other identity assertion
- Their agent endpoint URL (where their agent listens)

### 2. Invitation

The host invites a specific visitor by their Back Channel handle.
- Host fills out: who, what scopes, how long, optional message
- Broker generates an invite link with a single-use claim token
- Visitor receives the invite (email or in-app)
- Visitor accepts → claim token redeemed for session credentials

### 3. Authentication handshake

Visitor and Host agents establish a direct connection through the Broker's relay.
- A2A protocol agent cards exchanged
- Both verify each other's public keys (signed by the Broker's CA)
- Ephemeral session key derived via ECDH
- All subsequent messages encrypted with the session key

### 4. Capability discovery

Visitor asks Host: "what can you do?"
Host responds with the list of capabilities **scoped to the granted permissions**.

Example:
```
visitor: capabilities?
host: [
  { name: "config.list", scope: "config.read" },
  { name: "config.diff", scope: "config.read" },
  { name: "config.propose-change", scope: "config.suggest" },
  { name: "logs.tail", scope: "logs.read", args: ["lines"] }
]
```

If a scope wasn't granted, the corresponding capability is omitted entirely. The visitor can't even see that it exists.

### 5. Diagnostic / suggest loop

Visitor invokes capabilities one at a time. Each invocation:
1. Goes through the Broker relay (E2E encrypted)
2. Logged in the audit trail (action name, timestamp — not args/results)
3. Returned to visitor with the response

For `*.suggest` and `*.execute` actions, the host's agent:
1. Forms the proposed change
2. Presents it to the host human (with diff if applicable)
3. Waits for approval / rejection / "approve all from this session"
4. Only applies after approval
5. Returns success/failure to visitor

### 6. Live transcript

Both humans see a real-time transcript via a web UI:
- Action invocations (full)
- Approval prompts (when they appear)
- Decisions (approve/reject)

Either party can hit "Kick" to immediately:
- Send `session.terminate` to both agents
- Invalidate the session token at the Broker
- Lock down further capability invocations

### 7. Session end

When the session ends (timer, kick, or natural close):
- Both agents drop the connection
- Token is revoked at the Broker
- Audit log is preserved (metadata only)
- Transcript is preserved for N days (configurable, default 7) then purged

## Component breakdown

### Broker service

Stack: Node.js + TypeScript + Express + WebSocket + PostgreSQL

Endpoints (REST):
- `POST /accounts` — register a new user
- `GET /accounts/:handle` — get public key + agent endpoint
- `POST /invitations` — host creates an invite
- `POST /invitations/:id/accept` — visitor accepts
- `POST /sessions/:id/end` — kill switch
- `GET /sessions/:id/transcript` — fetch (own sessions only)

Real-time (WebSocket):
- `/relay/:sessionId` — encrypted message relay between agents

### Visitor agent SDK

A library that wraps the A2A protocol with Back Channel session semantics.

Implementations (planned):
- `back-channel-node` — for Node.js based agents
- `back-channel-python` — for Python agents
- `back-channel-claude-mcp` — MCP server exposing visitor-agent capabilities to Claude desktop

### Host agent SDK

A library + adapter layer that:
- Listens on the agent's endpoint
- Enforces scope at the boundary
- Wraps a "human approval" UI hook (out-of-process)
- Logs to the audit trail

Implementations (planned, same packages as above with host mode).

### Adapters

Wrappers for popular personal AI assistant frameworks so users don't have to write integration code:

- **Claude Code adapter** — exposes Claude Code's project context (sanitized) as a Back Channel host
- **Cowork adapter** — exposes Cowork session state
- **Home Assistant adapter** — exposes HA config (without secrets.yaml content)
- **OpenWebUI adapter** — exposes OpenWebUI workspaces

## Data model (Broker DB)

```sql
accounts (
  id uuid pk,
  handle text unique,
  display_name text,
  email text,
  public_key text,
  agent_endpoint text,
  created_at timestamptz
)

invitations (
  id uuid pk,
  host_account_id uuid fk,
  visitor_account_id uuid fk nullable,
  scopes text[],
  ttl_minutes int,
  status enum(pending, accepted, expired, declined),
  claim_token text unique,
  message text,
  created_at timestamptz,
  accepted_at timestamptz nullable,
  expires_at timestamptz
)

sessions (
  id uuid pk,
  invitation_id uuid fk,
  started_at timestamptz,
  ended_at timestamptz nullable,
  end_reason enum(natural, kicked_by_host, kicked_by_visitor, timeout, error),
  scopes_granted text[],
  action_count int default 0,
  approval_prompt_count int default 0
)

audit_log (
  id bigserial pk,
  session_id uuid fk,
  ts timestamptz,
  event_type text,
  detail jsonb
)
```

NOTE: no message content is stored. Only metadata.

## Open questions

- Should the Broker also act as an STT layer for voice modes? (Probably no for v1.)
- How do we handle agent-to-agent calls that need >30 min? Renewal vs. re-invite?
- Federation: should there be multiple independent Brokers that can cross-talk?
- Identity proof: email is fine for v1, but later we might want SSO or DID-style.

These get worked out as the POC matures.
