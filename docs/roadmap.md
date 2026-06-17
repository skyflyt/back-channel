# Back Channel — Roadmap

> Living roadmap. Phases are sized to be shippable; cadence depends on contributor time.

## Phase 0 — Concept (Now)

**Goal:** Vision is articulated and reviewable.

- [x] Repo initialized, MIT license
- [x] README with the elevator pitch
- [x] SECURITY.md with threat model basics
- [x] CONTRIBUTING.md
- [x] Architecture sketch
- [x] Scope definitions
- [ ] First external review of the architecture
- [ ] Decision: stack confirmed (Node/TS + WS + Postgres)
- [ ] Decision: A2A protocol features we'll use vs. defer

**Exit criteria:** At least one external reader has reviewed and the design hasn't fundamentally changed in a week.

## Phase 1 — Local POC ✅ (Done 2026-06-17)

**Goal:** Two agent processes on `localhost` can hold a scoped session.

- [x] Skeleton of `back-channel` library
- [x] Visitor mode: connect, request capabilities, invoke
- [x] Host mode: register capabilities, enforce scope, return responses
- [x] In-memory session state (no DB yet)
- [x] Hardcoded scope grants (no UI yet)
- [x] Console-based transcript logging
- [x] End-to-end scenario working: read config → suggest change w/ approval → out-of-scope denial → session end
- [x] 9 unit tests passing

**What shipped:**
- `src/host.ts` — HostAgent with scope enforcement + approval gate
- `src/visitor.ts` — VisitorAgent with discovery + invocation
- `src/scopes.ts` — full v1 scope set + BLOCKED_SCOPES hard-block
- `src/messages.ts` — typed protocol envelopes
- `src/transport/in-memory.ts` — Phase 1 transport (Phase 2 will swap to WebSocket)
- `src/transcript.ts` — structured event log
- `examples/localhost-demo/run.ts` — runnable demo
- `tests/basic.test.ts` — vitest coverage

Run `npm install && npm run demo` to see it.

## Phase 2 — Networked POC ✅ (Done 2026-06-17)

**Goal:** Two agent processes on different machines (LAN or via a relay) can session.

- [ ] WebSocket transport
- [ ] Simple Broker that relays messages (no auth yet, just routing)
- [ ] JWT-based session tokens (short TTL)
- [ ] Real ECDH session key derivation
- [ ] Encrypted message layer
- [ ] Browser-based transcript viewer (host side)

**Exit criteria:** Two laptops in different rooms can hold a session, transcript visible in a browser.

## Phase 3 — MVP (Hosted Broker)

**Goal:** A real person can sign up, invite someone, and run a session — end-to-end via the hosted Broker.

- [ ] Broker deployed to Coolify (or similar)
- [ ] Account registration via email
- [ ] Out-of-band key verification flow (QR + safety number)
- [ ] Invite generation + claim flow
- [ ] Scope-grant UI on host side
- [ ] Live transcript viewer (both sides)
- [ ] Kick switch
- [ ] Auto-expire / auto-purge
- [ ] Audit log queryable by session owners

**Exit criteria:** Two unrelated friends complete a real diagnostic session start-to-finish.

## Phase 4 — Hardening

**Goal:** Safe for non-developers to use.

- [ ] Redaction layer (names, addresses, tokens, secrets in any returned content)
- [ ] Persona stripping pass on memory metadata
- [ ] Property-based testing on scope enforcement
- [ ] External pen test
- [ ] Public security policy + vuln disclosure process
- [ ] Documentation pass for non-technical users
- [ ] Rate limits + DoS protection

**Exit criteria:** A non-developer can run a session without help.

## Phase 5 — Ecosystem

**Goal:** Work across common personal AI assistant frameworks.

- [ ] Claude Code adapter
- [ ] Cowork adapter
- [ ] Home Assistant adapter
- [ ] OpenWebUI adapter
- [ ] Letta adapter
- [ ] Plugin gallery (community-contributed visitor-agent skills)
- [ ] Self-hostable Broker (for orgs that want to run their own)

**Exit criteria:** Adapters are stable, plugin gallery has 5+ useful entries.

## Phase 6+ — Future

- Federation (cross-Broker sessions)
- Voice mode (audio between agents, with transcript)
- Async sessions (visitor leaves a note for host's agent to pick up later)
- Team workspaces (org-managed visitor pool)
- Trust-graph reputation (who's a good visitor)
- Marketplace for visitor agents that offer specialized skills


