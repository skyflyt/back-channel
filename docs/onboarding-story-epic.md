# Onboarding & Story Epic — surface the magic

> **Status:** Approved direction · 2026-07-03
> Source: full onboarding/story review of every user-facing surface (landing,
> how-it-works, about, FAQ, signup/verify/befriend funnels, dashboard, skill,
> installer, .mcpb connector, /api/mcp tools, docs, examples).
> Companion to [`friendly-inbox-toolkit-sprint-plan.md`](friendly-inbox-toolkit-sprint-plan.md) —
> that doc renames the mental model; this doc fixes the first five minutes.

## The finding in one paragraph

The individual surfaces are strong — the landing headline lands, signup is
genuinely 60 seconds, the security story is honest rather than performative.
The problem: **the product's magic moment requires a second human, and nothing
in onboarding delivers magic before that.** A new user signs up, connects an
agent, opens the dashboard… and stares at an empty Inbox until a friend shows
up. Meanwhile the three most story-worthy assets — the async economics, the
live "watch two agents talk" transcript, and the "agents learning lessons from
each other" framing — are buried in docs, tool descriptions, and a planning
doc. This is a surfacing problem, not a building problem: every fix below uses
primitives that already exist.

## The story, in one sentence

> **Your agent has a social life — it does favors, learns lessons from
> friends' agents, and checks its inbox for free while you sleep.**

Every piece of that sentence is already built. It is never said in one place,
and the first five minutes never proves it. All copy work in this epic should
converge on that sentence (adapted per surface, always plain language per the
skill's Rule #0).

## What already works — do not regress

- Hero headline: *"Your AI has an inbox for working with other AIs."* Keep it.
- The Sara/Bob offsite example. The exchange-code flow. The honest runtime
  compatibility matrix on /how-it-works. The installer's "here is exactly what
  happened" summary. The invite links that compress two-sided signup into one
  email click. The onboarding checklist on /account.

## The buried gems (assets to surface)

1. **Async economics is the differentiator.** Real-time agent-to-agent burns
   50–100 turns per exchange and drains a $20 plan; the inbox model does it in
   5–10, and an empty check costs ~0 LLM tokens
   ([`inbox-model-pivot.md`](inbox-model-pivot.md) §1). Today this story lives
   only in that design doc and mid-skill. Visitors never learn why async-first
   matters.
2. **The live session transcript (`/sessions/[id]`) is spectator magic.**
   Presence dots, frame-by-frame metadata, payloads showing `[encrypted]` — it
   proves both the product and the privacy promise at once. It appears nowhere
   in the funnel.
3. **"Lessons" framing** (a shared skill = "a lesson your agent learned from a
   friend's agent") is the most repeatable sentence in the product and is still
   planning-doc-only.
4. **The one-yes contract** ("approve the goal and scope once, then the agents
   work — no permission-prompt hell") is marketed as a security bullet; it is
   equally a convenience story against the current agent landscape.

## Gaps, ranked

1. **No solo magic moment (cold-start dead-end).** Post-connect, the checklist
   says "Add a friend" — without one, the user is done experiencing the
   product. The fix already exists as a primitive: the "Send to my agent"
   self-inbox channel.
2. **MCP agents can't self-onboard, and MCP is the primary path.** The
   dashboard leads with MCP, but the connector has no signup or exchange-code
   redemption — dashboard → generate token → paste → restart. The skill path
   is fully self-serve; the primary path isn't. Also: the MCP connector has no
   doc in `docs/` at all.
3. **Empty states don't sell.** A pre-friends Inbox tab is indistinguishable
   from a broken one.
4. **The jargon cliff.** The skill's Rule #0 (never show humans protocol
   jargon) is right — then Step 1d hands agents bash scripts, the .mcpb
   manifest leads with ECDH, and dashboard health copy says "its runtime lost
   its own login." Human-visible copy should be plain language; technical
   transparency one click behind.
5. **Dashboard density.** Six tabs / ~1,500 lines is fine for a returning
   user, brutal for minute one.

---

## Workstreams

Internal names (`Session`, `session_id`, `/api/sessions/*`, skill endpoints)
stay stable — copy and flow only, no schema or security-model changes, no new
broker content visibility (the broker stays content-blind).

### WS-A — Concierge welcome message (solo magic moment)

**Goal:** the user's very first inbox check finds a real message; onboarding
becomes a live demo of the product.

- On an account's **first agent connect** (first successful exchange-code
  redemption or first authenticated use of a fresh MCP token), seed a welcome
  thread into that account's inbox using the existing self-inbox / "Send to my
  agent" mechanism (or a broker-owned concierge identity such as
  `backchannel@bc` — implementer's choice; prefer whichever reuses the most
  existing plumbing).
- The welcome message is broker-authored, so plaintext frames are acceptable
  (nothing secret; the content-blind promise concerns *user* content).
- Content of the welcome message (plain language, no jargon): congratulate the
  connect, explain that this thread is how messages from friends' agents will
  arrive, and walk through the next step — inviting a friend — ending with the
  one-yes promise. Keep it short enough that an agent surfacing it quotes it
  whole.
- Must be idempotent (exactly one welcome thread per account) and must not
  fire for accounts that already have sessions.
- Update the dashboard onboarding checklist so step 1 ("Connect an agent")
  completes into "your agent has mail — ask it to check its inbox."
- **Empty states (gap 3) ride along here:** every empty dashboard state
  (Inbox, Friends, Toolkit) gets copy that carries the story forward, e.g.
  Inbox: "Nothing yet — when a friend's agent sends yours a message, it lands
  here. Invite a friend →".

**Acceptance:** fresh signup → connect agent → `bc_check_inbox` (or skill
poll) returns the welcome thread; agent can read it; second connect does not
duplicate it; existing accounts unaffected; e2e test covering the seed.

### WS-B — Landing page: economics + proof

**Goal:** a visitor learns the differentiator and sees the proof without
leaving the homepage.

- Add the async-economics one-liner to the hero area or the first section
  below it, in plain language, e.g.: *"Most agent-to-agent demos burn your
  whole month's plan staying connected. Back Channel is an inbox — your agent
  checks it for free and only wakes up when there's something worth reading."*
  (Adapt freely; keep the "checks it for free / only wakes when there's
  something worth reading" mechanic.)
- Add a "watch a session" proof section: a rendered mock of the
  `/sessions/[id]` live transcript (presence dots, frame rows, payloads shown
  as `[encrypted]`) with a caption like *"This is what your agents'
  conversation looks like to you — and this is everything **we** can see."*
  Build it as static markup styled like the real transcript page (no
  screenshot asset pipeline, no live session dependency).
- Surface the one-yes contract as a convenience line, not only a security
  bullet.
- Where the homepage mentions shared skills, adopt the **Lessons** phrasing
  from the sprint plan ("a lesson your agent learned from a friend's agent").
- Keep the existing hero headline and Sara/Bob example.

**Acceptance:** homepage renders both additions responsively in light and dark
mode; no CLS/layout regressions; copy passes the no-jargon rule (ECDH/AES
stay on /trust and /how-it-works); existing tests/lint/type-check green.

### WS-C — MCP self-serve connect + docs

**Goal:** the primary connect path is as self-serve as the legacy one.

- Let the `.mcpb` connector accept a **`BCX-…` exchange code** in its user
  config (same field or a sibling field to the token): on first run, if the
  configured value looks like an exchange code, redeem it via
  `POST /api/auth/exchange` (agent_name/runtime_type identifying the Desktop
  bridge), persist the minted `bc_` key in the connector's local keystore, and
  proceed. Raw `bc_` tokens keep working unchanged. Handle the used/expired
  `410` with a plain-language error telling the user to mint a fresh code in
  the dashboard.
- Update `manifest.json` copy so the token field says a `BCX-…` code from the
  dashboard works too, and reduce jargon in `long_description` (encryption
  honesty stays, but lead with what it does for the user).
- Update the dashboard "Connect a new agent" MCP instructions to mention the
  code option for Claude Desktop.
- Write **`docs/mcp-connector.md`**: what the connector is, both connect paths
  (token, exchange code), the E2E behavior in the bridge, what `/api/mcp`
  serves for remote MCP clients, tool list, and known limitations (e.g. sealed
  frames unreadable at the remote endpoint). Link it from the README where the
  connector is mentioned.

**Acceptance:** connector unit tests cover code-redemption success,
already-used code, and raw-token passthrough; existing keystore/e2e tests
green; manifest copy updated; doc exists and is linked.

### Deferred (explicitly out of scope for this epic)

- Dashboard first-run mode (gap 5) — worth doing after WS-A lands and the
  checklist flow settles.
- Skill Step 1d tone rework (gap 4, skill side) — the agent-facing bash is
  functional; revisit with the next skill revision bump.
- Any Tier-3 / public Lessons marketplace work (parked per sprint plan).

## Rollout rules

Per [`AGENTS.md`](../AGENTS.md): feature branch + PR per workstream, never
commit to `main`, CI green before merge, two-strike rule, **no ServiceDesk
change** (not Coolify-deployed), and merging does not deploy — production
changes require the manual Cloud Run deploy with `_CLOUDSQL_INSTANCE` set.

Success measure (echoing the sprint plan): a new user, unaided, can answer
"where does my agent receive work?" within five minutes of signup — because
something is already there when they look.
