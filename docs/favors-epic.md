# Epic: Favors — delegate a task to a trusted peer's agent (design, not yet implemented)

**Status:** design only. **Do not build yet.** Sequenced AFTER Account Dashboard Phases 1–4 and Skill Sharing Tier 2-RPC; favors may land *before* Skill Sharing Tier 2-Template (they're simpler). Depends on Trust + Inbox (`docs/account-dashboard-epic.md` §6).

---

## 1. Why

Skylar:

> *"once agents are connected I can ask my agent to ask my friend's agent to work on a specific task since I'm low on tokens."*

The requester is low on context / tokens / time, so they ask their agent to **delegate a small task to a trusted peer's agent**. The recipient's agent runs the work on **their** compute + context (spending **their** tokens), and returns the result. It's "can you handle this for me?" between two people's agents — bounded, trusted, human-approved on the doing side.

This is the first feature where one user's agent **spends another user's resources** to produce a result — so consent + cost transparency are central.

## 2. Shape — it's a one-shot, cross-account invocation

A favor is structurally close to a **Skill-Sharing Tier 2-RPC invocation** (`docs/skill-sharing-epic.md`), except the "capability" is open-ended ("anything your agent can do") rather than a pre-published skill. It runs entirely on the recipient side; the requester only ever sees the result. Reuse that machinery where possible.

## 3. Scope

New scope **`favor.do`** — "execute a delegated, recipient-approved task on the recipient's compute."
- **Hard-blocked from any `*.apply` / auto-execution.** A favor NEVER runs without an explicit recipient-user approval at receipt time, regardless of session-level consent. (One-yes-per-session covers the *collaboration*; each favor is its own yes because it spends the recipient's resources.)
- Granted only between **mutually trusted** peers (trust established via the dashboard, `docs/account-dashboard-epic.md`).
- `favor.do` does not imply access to the recipient's private data — the recipient's agent uses whatever context *it* already has / its user allows; the requester can't reach in.

## 4. Frame types (sealed content, e2e-encrypted)

```jsonc
// requester -> recipient
{ "type": "favor.request",
  "task": "Draft a 3-paragraph email about Q4 planning, friendly but concise.",  // plain English
  "deadline": "2026-06-20T17:00:00Z",        // optional
  "max_tokens": 3000,                         // optional budget hints the recipient can enforce
  "max_minutes": 10,                          // optional
  "reason": "I'm low on tokens"               // enum-ish: "low on tokens" | "you have the context" | "you're better at this" | free text
}

// recipient -> requester
{ "type": "favor.response",
  "status": "accepted",                       // "accepted" | "declined"
  "reason": null,                             // why, if declined
  "result": { /* opaque payload — the drafted email, the answer, etc. */ },
  "tokens_used": 1840,                        // actual cost, for transparency / reciprocity
  "completed_at": "2026-06-20T16:42:11Z"
}
```
- The `result` is an opaque sealed payload (text, a file, structured data) — broker never sees it.
- A favor that takes a while: recipient may send an interim `favor.response {status:"accepted"}` on approval, then a second frame with the `result` when done (or stream progress as `meta.dialog`). Define the accepted-then-completed two-frame shape in build.

## 5. Trust + approval model

- **Trusted peers only.** A `favor.request` to a non-trusted handle returns the same opaque error as Skill-Sharing/Inbox (don't reveal trust state).
- **Recipient approves EACH favor at receipt** — Rule #0 plain language, surfacing task + cost:
  > *"Skylar's agent is asking yours to draft a 3-paragraph email about Q4 planning. Est. ~2k tokens of your budget, ~2 min. Approve? (y/n)"*
- **Per-peer rate limits** in account settings: a cap on favors accepted per peer per day/week (default conservative, e.g. 5/day), enforced broker-side + surfaced in the dashboard. Prevents a trusted-but-greedy peer from draining your budget.
- **Decline is always clean** — `status:"declined"`, optional reason, no resources spent.

## 6. Privacy — state it honestly

A favor's `task` description **leaks task content to the trusted peer** — that's inherent ("draft an email about **Q4 planning**" tells your friend you're doing Q4 planning). There is no way around this; the recipient must understand the task to do it. **Frame it explicitly in the dashboard trust UI and at favor-send time:**
> *"Trust means your friend's agent — and your friend — will see what you're asking for. Only send favors you're comfortable them knowing about."*

Everything stays e2e-encrypted on the wire (broker content-blind); the disclosure is **peer-to-peer by design**, not a broker leak. Distinguish the two clearly so users aren't misled about *who* sees what.

## 7. Reciprocity tracking (v2, optional)

Track **favors requested / fulfilled per trusted pair** and surface as a *visibility* signal to humans — *"You've done 6 favors for Skylar this month; Skylar's done 1 for you."* — using the `tokens_used` totals.
- **Not auto-enforced.** No "you owe me" gating; purely informational, to let humans keep relationships balanced.
- Lives in the dashboard's Trusted Agents section.

## 8. Audit

Every `favor.request`, approval/decline, and completion is logged on **both** sides (metadata only — task title + cost + status + timestamps, never the result payload). Requester sees "I asked Skylar for X — done, 1.8k tokens"; recipient sees "I did X for Skylar." New `AccountAudit` event types: `favor.requested`, `favor.accepted`, `favor.declined`, `favor.completed`.

## 9. Open questions

1. **Cost accounting.** `tokens_used` is self-reported by the recipient's runtime — different models/runtimes count differently. Is it advisory-only, or do we want a normalized unit? Recommend advisory-only v1.
2. **Long-running favors.** Accepted-then-completed two-frame flow + progress `meta.dialog`s — how long can a favor stay open, and does it count against session TTL (which now auto-extends)? Probably give favors their own deadline independent of the session.
3. **Result delivery if the requester is asleep.** The result arrives as a normal frame → idle-email wake-prompt covers it. Confirm the requester's keep-warm/idle path surfaces favor results clearly.
4. **Abuse / budget drain.** Per-peer rate limit + the per-favor approval are the controls. Is a global "max favor tokens/day across all peers" cap also warranted?
5. **Declining gracefully at scale.** If a peer sends many favors, should there be a "mute favors from this peer for a while" without revoking full trust?
6. **Reciprocity gaming.** If reciprocity is ever surfaced, can self-reported `tokens_used` be inflated/deflated to look generous? (Another reason to keep it advisory.)

## 10. Sequencing & relationships

- **After:** Account Dashboard Phases 1–4 (trust + inbox + settings for the per-peer caps) and Skill-Sharing Tier 2-RPC (favors reuse the cross-account invoke + approval machinery). **May ship before** Skill-Sharing Tier 2-Template — favors are simpler (no portable signed bundle).
- **Reuses:** trusted-peer gating + dashboard approval surface; the sealed-frame + one-approval model; `AccountAudit`.
- **Relation to Fast Channel** (`docs/fast-channel-protocol-epic.md`): a favor is a natural candidate for a schema-typed frame (§3.1) and the result for reaction codes; not a blocker either way.
- **Skill:** a new "Favors" section (how to ask for / receive a favor; the per-favor approval is mandatory). Bump skill revision when built.
