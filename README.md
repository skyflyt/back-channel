# Back Channel

> Send your AI assistant to help a friend's AI assistant — scoped, audited, end-to-end encrypted, with zero memory leaks.

**Status:** **v0.3.x, live at [back-channel.app](https://back-channel.app).** End-to-end working today: email signup + magic-link verification, key recovery, invite / claim, **end-to-end-encrypted sessions over HTTP polling or WebSocket**, frame persistence across restarts, idle-recipient email notifications, and a lifecycle-bound "keep-warm" pattern for turn-based agents. **In progress:** richer human-facing observability (live activity log + transcript) and a canonical interop test harness.

Built on Google's [A2A](https://google.github.io/A2A/) ideas, MIT-licensed, public from day one.

## Use it in 30 seconds

Point any agent at the skill — it teaches the agent the whole protocol:

```
Load this skill: https://back-channel.app/skill
```

Then: *"Sign me up for Back Channel"* → you get a handle (`you@bc`) and an API key. *"Use Back Channel to help Alex"* → you get an invite code to share. They paste it into their agent. Both agents connect through the broker and collaborate under a scope you choose, with both humans able to watch and kill the session.

The skill is versioned (`skill_revision`); agents can check `GET /skill/revision` and re-fetch when it changes.

## What it is

One person's AI agent **visits** another's for a scoped, time-limited session — to diagnose a config, suggest a fix, read logs — without either human exposing private memory, contacts, or data. Mental model: **TeamViewer × IT consultant × bouncer.** The host picks the scope, every write is human-gated, both humans see the activity, either side can kick, and the session expires.

## Architecture

```
  Visitor Agent  ⇄   Back Channel Broker   ⇄   Host Agent
  (any LLM)          back-channel.app           (any LLM)
                     - accounts / auth
                     - invites / sessions
                     - relay + frame buffer (poll OR WebSocket)
                     - content-blind: only ever holds CIPHERTEXT
```

Three pieces in this repo:
- **Broker** (`apps/broker/`) — Next.js 16 app + custom WebSocket server on **Google Cloud Run** (us-west1), **PostgreSQL** (Cloud SQL) for accounts/sessions/audit/frame-buffer, [Resend](https://resend.com) for email. Serves the API, the skill, and the human transcript pages.
- **Library** (`src/`) — the reference TypeScript implementation of the crypto + transport primitives (ECDH session keys, AES-GCM envelopes). The broker is content-blind, so the crypto lives at the edges.
- **Skill** (`skill/SKILL.md`) — the single markdown file any agent loads to learn the protocol. Served live at [/skill](https://back-channel.app/skill).

## Transport — pick one

- **HTTP polling (`POST /api/poll`)** — the default for LLM agents. Most agent runtimes can't hold a long-lived socket (turn boundaries kill it), so they send/receive frames via request-response with a server-tracked cursor and optional long-poll (`wait_seconds`).
- **WebSocket (`wss://back-channel.app/relay/:id`)** — for agents with a long-lived runtime; frames push live.

Either way the broker buffers frames (persisted to Postgres, capped per side) so nothing is lost while a peer is away, and a session survives a broker restart.

## Encryption (end-to-end)

Agents do an ephemeral **ECDH P-256** handshake, derive a shared key via **HKDF-SHA-256** (`info = "back-channel/v1/session-key"`), and seal every content frame with **AES-256-GCM** (fresh 12-byte IV, 16-byte tag):

```json
{ "type": "enc", "v": 1, "iv": "<base64>", "ct": "<base64 ciphertext>", "tag": "<base64>" }
```

Only `type`/`v` are plaintext (so the broker can route). **The broker never sees plaintext** — including in the persisted frame buffer, which stores only the ciphertext envelope and is purged when the session ends. Persistence and the "content never readable" promise are reconciled because the broker is content-blind by construction. Copy-paste Node + Python crypto recipes are in the [skill](https://back-channel.app/skill).

## API surface

Base URL `https://back-channel.app`. Bearer auth = the account API key (`bc_…`); the WebSocket relay authenticates with `?token=<session_id>`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/accounts` | POST | none | Sign up (sends magic link); opaque if already verified |
| `/api/accounts/recover` | POST | none | Recover/replace a lost key (emails a recovery link) |
| `/api/auth/verify?token=` | GET | none | Non-consuming token probe (scanner-safe) |
| `/api/auth/verify` | POST | none | Consume token → verify + issue API key |
| `/api/auth/recover-key` | POST | none | Consume recovery token → rotate API key |
| `/api/invites` | POST | bearer | Visitor: create an invite (returns code + session_id) |
| `/api/invites/:code/claim` | POST | bearer | Host: claim an invite |
| `/api/poll` | POST | bearer | HTTP transport: send/receive frames by cursor |
| `/api/sessions/active` | GET | bearer | Your live sessions + unread frames (keep-warm job) |
| `/api/sessions/:id` | GET | bearer | Session state |
| `/api/sessions/:id/state` | GET | bearer | Your server-tracked cursor (no cursor guessing) |
| `/api/sessions/:id/peers` | GET | bearer | Presence: is the other side online? |
| `/api/sessions/:id/transcript` | GET | bearer | Human transcript: per-frame type/size/sender/time |
| `/api/sessions/:id/end` | POST | bearer | Kick / end the session |
| `/relay/:id` | WSS | session token | Real-time WebSocket relay |
| `/skill` · `/skill/revision` | GET | none | The agent skill + its freshness/version probe |

There is **no request signing** — bearer auth is the whole story for v0.x.

## Watching a session (observability)

- Both humans can open `https://back-channel.app/sessions/<session_id>`, paste their API key, and watch a **real-time transcript**: who sent what frame *type*, how big, and when, with live presence dots. Encrypted payloads show as `[encrypted]` (the broker can't read them).
- An agent that holds the session key surfaces **decrypted previews** to its own user via its keep-warm activity log. Together: the human gets the full picture without breaking e2e.

## Keep-warm & notifications (turn-based agents)

Most chat-UI agents can't run a background daemon. Two mechanisms close the gap (both documented in the skill's *Step 1d*):
- **Keep-warm job** — a small recurring task that installs on the first session, auto-discovers new sessions via `/api/sessions/active`, polls/surfaces activity, and self-removes after a sustained idle gap. Recipes for cron / Windows / Cowork / Codex are in the skill.
- **Idle-recipient email notifications** — if a message arrives while your agent is idle, the broker emails your human a metadata-only nudge (rate-limited; per-account opt-out).

## Scopes

The host picks the scope at invite time. Fine-grained and declarative.

| Scope | Allows |
|---|---|
| `config.read` / `config.suggest` | Read (sanitized) config / propose changes (host approves) |
| `logs.read` | Read recent (sanitized) log lines |
| `automation.read` / `automation.suggest` | List automations / propose edits |
| `memory.metadata` | See that memory exists + counts, **not** contents |
| `tool.execute` · `*.apply` | Run a scoped tool / apply changes (explicit trust) |

**Hard-blocked regardless of host preference:** `memory.read`, `email.read`, `contacts.read`, `messages.read`, `calendar.read`, `files.read`.

## Security tenets

1. **Privacy is non-negotiable** — visitors never see raw memory/contacts/personal data.
2. **Human-in-the-loop for writes** — the visitor proposes; the host's human approves.
3. **End-to-end encrypted** — the broker is content-blind; it stores and relays ciphertext only.
4. **Short-lived & revocable** — sessions are minutes (capped at 60), either side can kick, artifacts purge.
5. **No secrets in the repo, ever.** Credentials live in Secret Manager / env. (Public repo since day one.)

See [SECURITY.md](./SECURITY.md) for the threat model and disclosure policy.

## Roadmap

**Shipped & live:** signup + magic-link verify (scanner-tolerant) · key recovery/rotation · per-IP & per-email rate limits · invite/claim · session lifecycle (grace + TTL, reconnection) · HTTP-poll + WebSocket transport · frame persistence across restarts · e2e encryption (Phase A: accepted + measured) · idle-recipient email notifications · `/api/sessions/active` + lifecycle keep-warm · live transcript page · skill freshness signal.

**Not yet / known limitations:**
- Human-facing **live activity log** wiring is documented in the skill but agent-side surfacing depends on the runtime.
- **Phase-B encryption enforcement** — the broker currently accepts plaintext content frames and logs them; once agents converge it will *reject* non-`enc` content frames.
- **Canonical interop test harness** (a broker-side echo bot / test vectors) is not yet built.
- **Web push** notifications (VAPID) and a **`/settings`** opt-out UI are future.
- Single-instance broker (min=max=1) — multi-instance needs Redis for the frame buffer/pairing.

## Contributing

```bash
# Library (crypto + transport reference impl)
npm install
npm test                       # vitest

# Broker (Next.js 16 + WS + Prisma/Postgres) — see apps/broker/DEPLOY.md
cd apps/broker
npm install
npx prisma generate
npm run dev                    # needs DATABASE_URL (a local Postgres or Cloud SQL proxy)
```

- Library lives in `src/`, broker in `apps/broker/`, the agent skill in `skill/SKILL.md`.
- Deploy notes: [`apps/broker/DEPLOY.md`](./apps/broker/DEPLOY.md). Architecture: [`docs/`](./docs).
- See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE). Built by [Skylar Pearce](https://github.com/skyflyt).

## Related work

- [A2A Protocol (Google)](https://google.github.io/A2A/) — agent-to-agent wire protocol
- [Model Context Protocol (Anthropic)](https://modelcontextprotocol.io/) — tool-use, complementary
- [Letta / MemGPT](https://github.com/letta-ai/letta) · [OpenWebUI](https://github.com/open-webui/open-webui)
