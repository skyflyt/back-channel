# Back Channel — Production Architecture

> Phase 3+ design. How Back Channel actually runs as a hosted service used by real people through their existing AI agents.

## Big picture

```
backchannel.app  (the Broker service + landing site)

Public:
  GET  /skill                  -> skill.md (cacheable static)
  GET  /                       -> landing page

Account API (magic-link auth):
  POST /api/accounts           -> sign up
  POST /api/accounts/verify    -> claim magic link
  GET  /api/accounts/me        -> handle, agent endpoint
  PUT  /api/accounts/me/agent  -> register agent endpoint

Session API (token auth):
  POST /api/invites            -> visitor creates session
  POST /api/invites/:code/claim -> host claims invite
  POST /api/sessions/:id/end   -> either side kicks
  WSS  /relay/:sessionId       -> encrypted message relay

UI (Next.js):
  /account                     -> manage your account
  /sessions                    -> list your sessions
  /sessions/:id                -> live transcript + approve

Stack: Next.js 15 (App Router) + Postgres + WebSocket
Deploy: Coolify, hosted at backchannel.app
```

Both agents call the Broker over HTTPS + WebSocket. The Broker is **content-blind** — it mediates connections but cannot read what the agents say to each other.

## Onboarding (one-time per user)

### Step 1: Install the skill

The user pastes a single URL into their agent:

> "Load this skill: https://backchannel.app/skill"

The agent fetches `SKILL.md`, learns the protocol. **Works for any agent that can follow markdown instructions** — Claude, Cowork, ChatGPT, custom setups.

### Step 2: Create an account

User: *"Sign me up for Back Channel."*

Agent (now skill-armed):
1. Calls `POST /api/accounts` with the user's email
2. Tells user: *"Check your email for the verification link."*
3. User clicks the link → lands on `backchannel.app/account/claim?token=...`
4. Browser confirms identity, issues an auth token
5. User copies the token back to their agent OR the agent gets it via a callback URL it owns

### Step 3: Register agent endpoint

The user's agent has a callable endpoint where it listens for incoming session requests. Could be:
- `localhost:PORT` via a local agent runtime (Cowork-style)
- `https://agent.user.tld/back-channel` for self-hosted setups
- A "polling" mode for agents that can't run a server (poll Broker for invites)

The agent calls `PUT /api/accounts/me/agent` with its endpoint URL + agent's public key.


## The visit flow (per session)

```
VISITOR SIDE                    BROKER                    HOST SIDE
============                    ======                    =========

"Help Steve with his agent's
 memory issue via Back Channel"
       |
       v
 [visitor agent] -----> POST /api/invites
                        { host_handle: "steve@bc",
                          scopes: [...],
                          ttl_minutes: 30,
                          message: "..." }
                              |
                              v
                        [generate session code: BC-7K4N-A9X]
                        [persist invite, expires 30min]
                        [push/email host]
                              |
                              v
                          <-- returns { code, expires_at }
       |
       v
 "Send Steve this code:                                   📱 Push to Steve:
  BC-7K4N-A9X"                                            "Skylar wants to help.
       |                                                   Code: BC-7K4N-A9X"
       |   (out-of-band: SMS/Slack/email)                       |
       +------------------------------------------------------->
                                                                v
                                                       [Steve: "accept BC-7K4N-A9X"]
                                                                |
                                                                v
                                                       [host agent] ---> POST /api/invites/BC-7K4N-A9X/claim
                                                                       { agent_pubkey: ... }
                                                                           |
                                                                           v
                                                                  [verify Steve's identity]
                                                                  [push confirm to Steve's phone]
                                                                           |
                                                                           v
                                                                  [Steve confirms]
                                                                           |
                                                                           v
                                                                  [issue session token to host agent]

       Both agents now have a session token.
       They open WSS /relay/:sessionId.
       Broker relays encrypted messages.
       Both humans watch /sessions/:id live transcript.

                          <- capability discovery + invoke loop ->

                          ---- session.end / kick / timeout ----
```

## Identity binding (the "is this really Steve's agent" question)

Two layers, both required:

### Layer 1: Pre-registered agent endpoints
- At account setup, Steve registered his agent's public key + endpoint URL.
- When the host agent calls `claim`, the Broker checks the request is signed with Steve's registered private key.
- A randomly-scoped attacker who snooped the session code can't claim without the key.

### Layer 2: Out-of-band confirmation
- After claim succeeds, the Broker sends a push notification / email to Steve's already-authenticated channel.
- "Your agent claims to be accepting a Back Channel invite from Skylar's agent. Confirm: [yes/no]"
- Session only finalizes after Steve clicks yes.

Both layers fail-closed. (A) without (B) = stale key risk. (B) without (A) = social engineering risk.


## End-to-end encryption

The Broker MUST NOT be able to read message content. Implementation:

1. Each user's agent has an asymmetric keypair. Public key registered with Broker.
2. When session starts, both agents exchange ephemeral keys via ECDH. Derived session key.
3. All `invoke` / `response` payloads encrypted with the session key.
4. Broker sees: `{ from: visitor, to: host, ciphertext: ... }` and routes accordingly.
5. Broker stores in the audit log: timestamps, message types (`invoke` vs `response`), session metadata. **NOT plaintext content.**

## Live transcript (the host UI)

When a session opens, both humans can navigate to `backchannel.app/sessions/[id]` and watch real-time:

- Capability invocations
- Approval prompts (with diff/details)
- Decisions (approve/reject)
- Errors / denials

Either side has a big red **Kick** button. Hitting it:
- Sends `session.end` to both agents
- Invalidates the token at the Broker
- Stops the relay

The host's approval UI can ALSO live in their agent's native chat UI — the agent receives the approval request, presents it as a chat message, user replies yes/no. The web UI is for richer review (diffs, history) or for backup when the agent's chat is busy.

## Database schema (Phase 3 baseline)

```sql
accounts (
  id              uuid pk,
  handle          text unique,            -- "skylar@bc"
  email           text unique,
  display_name    text,
  agent_pubkey    text,                   -- registered at setup
  agent_endpoint  text,                   -- where the agent listens
  created_at      timestamptz,
  email_verified_at timestamptz
)

invites (
  id              uuid pk,
  code            text unique,            -- "BC-7K4N-A9X" (short, human-shareable)
  host_account_id uuid fk,
  visitor_account_id uuid fk,
  scopes          text[],
  ttl_minutes     int,
  message         text,
  status          text,                   -- pending / claimed / expired / kicked
  created_at      timestamptz,
  expires_at      timestamptz,
  claimed_at      timestamptz,
  confirmed_at    timestamptz             -- after out-of-band confirm
)

sessions (
  id              uuid pk,
  invite_id       uuid fk,
  started_at      timestamptz,
  ended_at        timestamptz,
  end_reason      text,
  scopes_granted  text[]
)

audit_log (
  id              bigserial pk,
  session_id      uuid fk,
  ts              timestamptz,
  role            text,                   -- visitor / host
  event_type      text,
  detail          jsonb                   -- redacted — no plaintext content
)

magic_links (
  token           text pk,
  email           text,
  expires_at      timestamptz,
  consumed_at     timestamptz
)
```

## What the broker NEVER stores

Hard rule, design-enforced:
- ❌ Plaintext message content from sessions
- ❌ Capability invocation args (only types)
- ❌ Returned data
- ❌ Memory contents (which we don't allow anyway)
- ❌ Anyone's API keys, OAuth tokens, etc.

## Deployment plan

Phase 3 MVP:
1. Deploy Broker to Coolify at `back-channel.bhwk.com` (testing) → later `backchannel.app`
2. Postgres via Coolify's managed Postgres
3. Magic-link emails via Postmark or SES (env-configured)
4. Single instance to start; horizontally scalable behind nginx if needed
5. WebSocket on same Next.js server (custom server.mjs pattern from spendpilot)

## Open questions for Phase 3 implementation

- **Polling fallback** for agents that can't run an HTTP server: how often, how long-lived?
- **Voice-mode**: when both agents are voice-driven, how does the user paste a code? (Speak it.)
- **Identity providers**: magic link is minimal viable. Add SSO (Google, GitHub) for v3.1?
- **Free vs paid**: where's the boundary? (Personal use free, org accounts paid? Per-session limits?)

To be resolved during implementation. None are blockers for the architecture.
