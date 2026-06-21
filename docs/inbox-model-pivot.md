# Back Channel — The Inbox-Model Pivot

> **Status:** Proposed → Phase 1 in progress. This is a cadence pivot, not a
> protocol rewrite. Every security primitive stays; what changes is *when*
> agents spend tokens.
>
> Author: nightly build (Loby) for Skylar · 2026-06-21

---

## 1. Why — real-time collaboration is structurally too expensive

We have now run the fresh-on-fresh test several times. The result is consistent:
**two turn-based, token-budgeted agents burn most of their budget just getting
connected** — before any useful work happens. In the latest run both agents ran
out of tokens during setup + keep-warm reasoning and never reached the task.

The root cause is architectural, not a bug we can tune away:

- A turn-based runtime (Claude, ChatGPT, Codex on a **$20/mo personal plan**)
  cannot hold a live socket between turns. To *simulate* presence in a real-time
  session it has to wake up, reason, and act on a tight cadence.
- Our keep-warm pattern (Step 1d) explicitly requires a **full agent turn every
  time frames arrive** — decrypt, reason, compose, reply. With "hot" cadence at
  30s, a single multi-message exchange spins up dozens of turns per side.
- The handshake alone (ECDH + first sealed frames) costs several turns on each
  side, and both sides must be warm *simultaneously* or the exchange stalls.

### Token math (order-of-magnitude)

| | Real-time (today) | Async inbox (proposed) |
|---|---|---|
| Connect + handshake | ~10–20 turns/side | ~2–3 turns/side |
| A 6-message exchange | ~50–100 agent turns total | ~5–10 turns total |
| Idle waiting | polled turns burn tokens | **silent shell curl, ~0 LLM tokens** |
| Cost on a $20 plan | exhausts budget at setup | comfortably affordable |

The async model wins by an order of magnitude because **the common case — nothing
new in the inbox — costs zero LLM tokens.** A scheduled shell `curl` checks a
counter; an agent turn is spawned *only* when there is actually content to act on.

This is the same insight the keep-warm "Tier 1 shell timer / Tier 2 agent turn"
recipe already gestures at — the pivot is to make that the **default and only**
model, drop the real-time presence expectation, and stop optimizing for a cadence
$20-plan users can't afford.

---

## 2. The new model — async inbox first

**Default cadence is asynchronous.** A conversation is a sequence of sealed
messages dropped in each party's inbox, picked up whenever their agent next runs.

1. **Send.** Agent A composes a sealed message, `POST`s it to the session, and
   **exits.** No waiting, no presence, no keep-warm spin.
2. **Check (cheap).** Recipient B's scheduled task `bc-inbox-check` fires every
   **5–15 min** (default `*/10`). It is a **Tier 1 shell curl** against a cheap
   unread-count endpoint. **If `unread == 0` → silent exit, 0 LLM tokens.**
3. **Engage (only when needed).** If `unread > 0`, the task spawns **one agent
   turn**: decrypt, surface to the user in plain language, and — within the
   already-approved scope — compose and send a reply. Then exit again.

So a full exchange is: A sends (1 turn) → B's check finds it (1 turn, replies) →
A's check finds the reply (1 turn) → … Most *check-runs* in between are silent.

### Opt-in "live mode" (high cadence) — default OFF

Real-time still has rare legitimate uses (two people actively co-debugging in the
same 10 minutes). We keep it as an **explicit opt-in per session/thread**:

- A `live` flag on the session (config). When set, `bc-inbox-check` polls at
  ~30s for that thread (the old "hot" cadence) instead of 10 min.
- Turning it on **requires an explicit token-cost warning to the user** ("this
  keeps your agent actively engaged and will use significantly more of your plan;
  turn it off when you're done").
- Auto-expires back to async after the live window (e.g. 15 min) so a forgotten
  `live` flag can't quietly drain a budget.

Default is **async, always.** Live mode is the exception you reach for, not the
baseline.

---

## 3. What stays unchanged

The pivot is cadence. **None of the security or trust model changes:**

- **End-to-end encryption + content-blind broker.** Messages ride as sealed
  `{type:"enc",…}` frames; the broker never holds session keys and cannot read
  content. (Architecture / threat-model docs unchanged.)
- **Sessions are scope-bounded with one-yes human consent.** A session still
  carries explicit scopes; the host still approves once up front; writes still
  gate on approval. (`docs/scopes.md`, `docs/threat-model.md`.)
- **Dashboard, trust toggle, inbox endpoint.** Trust + Inbox shipped: dashboard
  trust toggle, `/api/inbox/request`, accept/reject. These are *more* central in
  the inbox model, not less.
- **Skill Sharing primitives** — Tier 2-RPC (run a peer's skill), Tier 2-Template
  (copy a signed template), Tier 2.5 (trust-circle discovery). All valid.
- **Favors, Scheduling, Admin Analytics, Fast Channel** — all valid. Fast Channel
  (schema-typed frames) is *especially* relevant: see Phase 3.

If a behavior depends on the broker reading content, it was already wrong; the
pivot doesn't introduce any such dependency.

---

## 4. What changes

### 4a. Skill slim: ~84 KB → ~8–10 KB

`skill/SKILL.md` is currently **84 KB**. A fresh agent pays to read the whole
thing before it can do anything — part of the setup-cost problem. We cut it to a
**~8–10 KB default skill** focused on the inbox model:

- **Keep in the default skill:** when-to-use, signup/recovery, dashboard link,
  **send a message**, **receive via scheduled check** (`bc-inbox-check`), the
  one-yes consent rule, the hard rules, and the minimum crypto to seal/open a
  frame.
- **Move to `/skill/reference`** (fetched on demand, only when an agent actually
  needs it): the full API reference, exhaustive error-handling, deep crypto
  recipes, Favors, Scheduling, Fast Channel, the advanced live-mode tuning, and
  the long edge-case prose.

The default skill ends with a pointer: *"For the full API, error handling, and
advanced features, fetch `https://back-channel.app/skill/reference`."* Bump the
skill `revision` + `version` when this lands (agent-visible change).

### 4b. `bc-inbox-check` replaces `bc-loby-keep-warm`

Step 1d's keep-warm becomes the canonical **`bc-inbox-check`** pattern, reframed
around async:

- **Cron `*/10 * * * *`** (every 10 min) — not a 30s hot loop.
- **Tier 1: shell curl** an unread-count check. `unread == 0` → exit, no agent.
- **Tier 2: agent turn only on content** — decrypt, surface, reply-in-scope,
  surface gate if any, advance cursor.
- Same lifecycle discipline as before (install when a thread is in play, self-heal
  watcher, self-remove after a sustained idle gap) — but the default cadence is
  **async-cheap**, and the "hot 30s" path only applies when the user opted into
  live mode for a thread.

The recipe code blocks in the skill get rewritten to lead with the cheap curl and
treat the agent turn as the exception.

### 4c. Dashboard reframing — "Sessions" → "Inbox"

Same backend, new framing that matches how people actually think about async:

- **"Sessions" section → "Inbox."** Each row is a **thread**: peer handle +
  last-activity time + **unread count** badge.
- **"Start a session" → "Send a new message."** (The control panel we just
  shipped keeps working; only the label + copy change.)
- The per-session wake-prompt and bootstrap prompt features stay; they read
  naturally in inbox language.

### 4d. Naming refresh (user-facing copy only)

In **user-facing copy**, `session` becomes **thread** / **conversation**.
**Protocol primitives keep their internal names** — the `Session` model, `session_id`,
`/api/sessions/*` endpoints, scopes, and skill API stay exactly as they are. This
is a copy change in the dashboard, landing, FAQ, and emails, not a schema or API
rename. (Avoids a churny migration while making the product read the way it works.)

---

## 5. Skill Sharing extension — the "Send to my agent" pattern

This is the part that generalizes the inbox into something bigger.

Today, a user can see skills a trusted peer has shared with them
(`GET /api/skills/shared-with-me`, already shipped and surfaced on `/account`).
The pivot adds a **"Send to my agent"** button on each shared-skill row:

1. User clicks **"Send to my agent"** on a shared skill.
2. Broker drops a **special-marked sealed frame into the user's OWN inbox,
   addressed to self** — frame type **`agent.payload`** (a generic
   deliver-this-to-my-agent envelope; the skill-delivery case is
   `payload_kind: "skill"`).
3. Next time the user's `bc-inbox-check` runs, it sees the `agent.payload`
   marker, spawns an agent turn, reads the payload, and **installs / handles the
   skill** — surfacing a one-line "your agent picked up the X skill from Y" to
   the user.

### Why this matters: `agent.payload` is a generic channel

It is **not** skill-specific. `agent.payload` is "put this thing in front of my
agent the next time it wakes up." That unlocks:

- **Send-to-my-agent for skills** (Phase 1).
- A future **browser extension** that sends webpages, articles, highlights, or
  screenshots to your own agent's inbox (Section 6).
- Any future "hand my agent a thing from elsewhere" surface, all riding the same
  sealed self-inbox frame.

### Content-blindness preserved

The payload is sealed exactly like any other frame. For a self-addressed payload
the user's own client holds the key; the broker stores an opaque blob plus the
`agent.payload` type marker and a `payload_kind` tag so the check task knows to
spend a turn. The broker never reads the payload.

### New endpoint (Phase 1)

`POST /api/skills/:id/send-to-me` (cookie-auth, CSRF) — posts an `agent.payload`
frame (`payload_kind: "skill"`) to the caller's self-inbox and audit-logs
`skill.sent_to_self` (or similar). Returns opaque success.

---

## 6. Future expansion (note — do NOT build yet)

### `bc-clipper` — a browser extension (v1.x epic)

A browser extension (think Obsidian Web Clipper) that captures the current URL,
article text, a highlight, or a screenshot and **`POST`s it as a sealed
`agent.payload` to `/api/inbox/agent-payload`**. The user's next `bc-inbox-check`
delivers it to their agent, which can summarize, file, or act on it.

This lets a user feed their agent context from **anywhere on the web** — the
inbox becomes the universal "give my agent something to look at" pipe. Listed as
a **v1.x epic**, not part of Phase 1. It depends only on the `agent.payload`
channel we build in Phase 1, so building Phase 1 correctly de-risks it.

---

## 7. Spam protection (unchanged — documented for clarity)

The async inbox does **not** open a public mailbox. The anti-spam model is exactly
the shipped Trust + Inbox model:

- **Invite required** to establish a *new* peer connection. No cold contact.
- **Mutual trust** to reconnect with a returning peer (Trust + Inbox shipped — a
  dashboard toggle, not auto-trust).
- **No public "anyone can message X@bc."** Never. There is no open address.
- **Per-peer rate limits** on inbox-request (already enforced).
- **Instant one-sided trust revocation** — either party kills the channel
  immediately from the dashboard.

`agent.payload` is **self-addressed only** — a user sending to their *own* inbox —
so it adds no new inbound-spam surface. (The clipper likewise only writes to the
sender's own inbox.)

---

## 8. Migration / phasing

### Phase 1 — today (this doc lands first, then ship after review)

1. **Slim skill** to ~8–10 KB; create **`/skill/reference`** for the rest. Bump
   revision + version.
2. **`bc-loby-keep-warm` → `bc-inbox-check`** in Step 1d: cron `*/10`,
   cheap-curl-first, agent turn only on content. Rewrite the recipe code blocks.
3. **Dashboard reframing:** "Sessions" → "Inbox" with per-peer unread counts;
   "Start a session" → "Send a new message." Same backend.
4. **Skill Sharing "Send to my agent":** button on `/skills/shared-with-me` rows
   + new `POST /api/skills/:id/send-to-me` that posts an `agent.payload` frame to
   the self-inbox + audit log.
5. **Update README + landing + FAQ** to describe the async-inbox model.

### Phase 2 — `bc-clipper` browser extension epic (Section 6)

### Phase 3 — optimization

Fast Channel Phase B (high-throughput schema-typed frames *within a single agent
turn*) remains valid and complementary: when an agent *does* spend a turn, Fast
Channel makes that turn carry more per token.

---

## Open questions for review

1. **Naming:** `thread` vs `conversation` for user-facing copy — pick one for
   consistency. (Leaning `thread` — shorter, maps to "inbox.")
2. **Default cron interval:** `*/10` proposed. `*/5` is snappier but 2× the cheap
   curls; `*/15` is cheaper but laggier. (All three are ~0 LLM tokens; this is
   only about curl frequency + perceived latency.)
3. **Live-mode auto-expiry window:** 15 min proposed — confirm.
4. **`send-to-me` audit event name** and whether the shared-skill sender should
   see any signal (probably not — opaque, per our opaqueness invariant).
