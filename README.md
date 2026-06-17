# Back Channel

> Let your AI assistant lend a hand to a friend's AI assistant — with scoped access, full audit, and zero memory leaks.

**Status:** Phase 2 complete — networked POC over WebSocket with ECDH-derived session keys and AES-256-GCM encrypted envelopes. ``npm run demo`` (single process) and ``npm run demo:net:host`` + ``demo:net:visitor`` (two processes) both work. 18/18 tests passing. Phase 3 (Broker service) is the implementation phase.

**See also:**
- [Production Architecture](./docs/production-architecture.md) — how Back Channel will run as a hosted service
- [The Skill](./skill/SKILL.md) — the one-size-fits-all instructions any agent fetches to use Back Channel
- [Scope Model](./docs/scopes.md) — what visitors are allowed to do
- [Threat Model](./docs/threat-model.md) — what we defend against

---

## The problem

People are building personal AI assistants ("second brains") — Cowork, Claude desktop, custom setups, agent frameworks, you name it. They run into configuration walls they can't articulate:

- *"My agent's memory isn't working right but I don't know why."*
- *"The automation I set up doesn't fire. Help."*
- *"My friend got hers working great but I can't figure out the setup."*

Today, the only fix is: pull up a screen share, walk through the config line by line, hope they can repro. It's the old IT support model and it sucks for a hyper-personal, agent-shaped problem space.

## The idea

A protocol-level way for **one person's AI agent to visit another person's AI agent**, perform a scoped diagnostic or fix, and leave — without either human ever revealing private context to the other.

**Mental model:** TeamViewer x IT consultant x bouncer.

1. Host (Steve) invites Visitor (Skylar's agent) for a time-limited session.
2. Host picks the **scope**: `read config`, `propose changes`, `read logs` — but NOT memory, NOT contacts, NOT personal data.
3. Visitor agent shows up wearing a badge. Only sees what's scoped.
4. Visitor proposes changes. Host's agent gates writes behind human approval for anything sensitive.
5. Both humans see a live transcript. Either can kill the session anytime.
6. Session expires. All session artifacts purge after N days.

## Why this doesn't exist yet

- **A2A protocol** (Google, 2025) defines the wire format for agent-to-agent communication, but nothing has shipped a user-facing app on top of it.
- **MCP** is about tool-using, not agent-talking-to-agent.
- **Letta / MemGPT** is about shared memory, not scoped consulting.
- **AnythingLLM / OpenWebUI** are shared platforms, not inter-agent protocols.

The gap: **"lend my agent to a friend, privately, with controls."** No one is building this. Yet.

## Tenets

1. **Privacy is non-negotiable.** Visitor agent never sees the host's raw memory, contacts, personal data — only redacted/scoped views.
2. **Human-in-the-loop for writes.** The visitor proposes, the host's human (or their own agent acting under tight scope) approves before anything mutates.
3. **Transparent by default.** Both humans see real-time transcript of every exchange.
4. **Short-lived sessions.** Tokens expire fast (minutes, not hours). No persistent access.
5. **Kick switch.** Either party can terminate instantly.
6. **No secrets ever in the repo.** All credentials live in env vars or external secret stores.
7. **Open by default.** Built on open protocols (A2A), MIT licensed, public from day one.

## Architecture sketch

```
+------------------+                  +------------------+
| Visitor Agent    |                  | Host Agent       |
| (Skylar's Loby)  |                  | (Steve's setup)  |
+--------+---------+                  +---------+--------+
         |                                      |
         |  1. Session invite (Host -> Visitor) |
         | <------------------------------------|
         |                                      |
         |  2. Auth handshake (A2A protocol)    |
         |------------------------------------->|
         |                                      |
         |  3. Scoped capability discovery      |
         | <------------------------------------|
         |                                      |
         |  4. Diagnostic / suggest loop        |
         | <----------------------------------> |
         |   Visitor reads scoped state         |
         |   Visitor proposes changes           |
         |   Host gates writes via human review |
         |                                      |
         |  5. Session end / token expire       |
         | <------------------------------------|

         +---------------------------------------+
         | Back Channel Broker                   |
         | - Issues short-lived session tokens   |
         | - Logs transcripts for both humans    |
         | - Maintains audit trail               |
         | - Auto-revokes on timeout / kick      |
         +---------------------------------------+
```

The Broker is the central trust authority. It doesn't see the *content* of the conversation (end-to-end encrypted between agents), but it knows:
- Who's connected
- What scopes are granted
- When the session expires
- How to revoke

## Scopes (initial list)

Fine-grained, declarative. Host picks via checkbox at invite-time.

| Scope | What it allows |
|---|---|
| `config.read` | Read configuration files (sanitized — secrets redacted) |
| `config.suggest` | Propose changes to config. Host approves before apply. |
| `logs.read` | Read recent log lines (also sanitized) |
| `automation.read` | List automations + their structure |
| `automation.suggest` | Propose new automations or edits to existing |
| `memory.metadata` | See *that* memory exists + counts, NOT contents |
| `tool.execute` | Run a specific scoped tool with named arguments |

**Explicitly NOT in v1**: `memory.read`, `email.read`, `contacts.read`, `messages.read`. Those are off-limits regardless of host preference. Future versions may allow them under heavy redaction with extra confirmation.

## Roadmap

### Phase 0 — Concept (you are here)
- [x] Repo scaffolded, vision doc written
- [ ] Architecture sketch reviewed
- [ ] Threat model drafted

### Phase 1 — Local POC (single machine, two agent processes)
- [ ] Two local Claude-MCP-style agents on `localhost`
- [ ] A2A protocol handshake (no auth yet)
- [ ] One agent asks for config, the other returns it (sanitized)
- [ ] Manual transcript logging

### Phase 2 — Networked POC (two machines, LAN)
- [ ] WebSocket-based transport
- [ ] Session tokens via simple JWT
- [ ] Scope enforcement at host side
- [ ] Live transcript view (browser)

### Phase 3 — MVP (broker + auth)
- [ ] Hosted broker service (deployed to Coolify)
- [ ] Account model: invite via email link or QR
- [ ] OIDC-style auth between agents
- [ ] Scope grant UI
- [ ] Transcript replay
- [ ] Kick switch
- [ ] Auto-purge

### Phase 4 — Hardening
- [ ] Persona stripping / redaction layer
- [ ] Threat model walkthrough + fixes
- [ ] Pen-test the broker
- [ ] Public security policy
- [ ] Documentation pass

### Phase 5 — Ecosystem
- [ ] Reference adapters for common agent frameworks (Claude Code, Cowork, Letta, OpenWebUI)
- [ ] Plugin gallery: "common diagnostic skills" your visitor agent can offer
- [ ] Community-contributed scopes

## Tech stack (planned)

- **Wire protocol**: A2A (Agent2Agent) by Google — open spec
- **Transport**: WebSocket over TLS
- **Broker**: Node.js + TypeScript, Express, deployed to Coolify
- **UI**: Next.js (host-side scope picker + transcript viewer)
- **Auth**: JWT with short TTL, asymmetric signing
- **Audit log**: PostgreSQL (transcript + session metadata)

## Security model

See [SECURITY.md](./SECURITY.md) for the full threat model and disclosure policy.

**TL;DR**:
- No secrets ever live in this repo. Period.
- Visitor agents never get raw memory access.
- Every write is human-gated by default.
- Transcript is end-to-end between agents; broker is blind to content.
- Sessions are short-lived (5-30 min) and revocable.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Project is in very early phase — feedback on the vision and architecture is more valuable than code right now.

## License

MIT. See [LICENSE](./LICENSE).

## Related work

- [A2A Protocol (Google)](https://google.github.io/A2A/) — the wire protocol Back Channel builds on
- [Model Context Protocol (Anthropic)](https://modelcontextprotocol.io/) — for tool-using, complementary
- [Letta / MemGPT](https://github.com/letta-ai/letta) — agent memory framework
- [OpenWebUI](https://github.com/open-webui/open-webui) — self-hosted LLM UI

## Author

Built by [Skylar Pearce](https://github.com/skyflyt) — IT Infrastructure Director who got tired of remote-debugging his colleagues' personal AI assistants by screen-share.



