# Epic: Scheduling — "have my people talk to your people" (design, not yet implemented)

**Status:** design only. **Do not build yet.** Sequenced AFTER Account Dashboard Phases 1–4 AND Skill Sharing (both Tier 2-RPC and likely 2-Template) — it's the most involved of the autonomy features because calendar integration touches each agent's *local* stack. Depends on Trust + Inbox (`docs/account-dashboard-epic.md` §6).

---

## 1. Why

Skylar:

> *"once our agents trust each other I could say to my agent that I want to work out a time to have lunch with a friend and my agent would go to my friend's agent and they would work out a time and his agent would surface that for them to confirm and same to me before booking."*

Two agents, each with access to their own user's calendar, **negotiate availability, converge on candidate times, get human approval on both sides, and one of them books.** Classic "have my people talk to your people" — but the people are agents and the humans only touch it twice (approve calendar access once, approve the final time once).

## 2. Scope

Two new scopes, deliberately split so reading availability never implies the power to book:
- **`schedule.negotiate`** — read the user's calendar *availability* (free/busy within a stated window) + propose times. Does **not** book anything.
- **`schedule.book`** — write an event to the user's calendar. **Always** requires explicit user approval on the side that books, every time (never auto, never covered by session-level consent alone).

`schedule.negotiate` is gated by trust + session approval; `schedule.book` additionally requires the final per-event yes.

## 3. Frame types (sealed content, e2e-encrypted)

```jsonc
// initiator -> peer
{ "type": "schedule.propose_meeting",
  "purpose": "lunch with Skylar",
  "duration_min": 60,
  "participants": ["skylar@bc", "alex@bc"],
  "time_range": { "start": "2026-06-23T00:00:00Z", "end": "2026-07-04T00:00:00Z" },
  "location_pref": "downtown",                 // optional
  "preferences": "weekday lunch, walking distance to downtown"   // optional, free text
}

// peer -> initiator : free slots within time_range (NOT full calendar)
{ "type": "schedule.availability",
  "slots": [ { "start": "2026-06-24T18:00:00Z", "end": "2026-06-24T20:00:00Z" }, ... ] }

// either -> either : converge on candidates
{ "type": "schedule.proposal",
  "candidates": [ { "start": "...", "end": "...", "location": "Mendocino Farms, downtown" }, ... ],
  "rationale": "Tue noon works for both; downtown is walkable for Alex." }

// either -> either : both approve, designates who books
{ "type": "schedule.confirm",
  "chosen": { "start": "2026-06-24T19:00:00Z", "end": "2026-06-24T20:00:00Z", "location": "Mendocino Farms, downtown" },
  "who_books": "host" }                        // "visitor" | "host"

// booker -> other : it's on the calendar
{ "type": "schedule.booked",
  "event_id": "AAMk...", "calendar_link": "https://outlook.office365.com/...", "chosen": { ... } }
```

## 4. Calendar integration is per-agent (the protocol just relays)

Back Channel does **not** dictate how an agent reads or writes calendars. Each agent uses its own stack — Loby via **M365 Graph**, another agent via Google Calendar / CalDAV / whatever. The protocol provides only the relay + the frame contract above; reading free/busy and writing the event are the agent's local job. This keeps the broker content-blind and calendar-agnostic. The `schedule.availability` slots and the booked event are produced/consumed locally on each side.

## 5. Approval flow (humans touch it exactly twice)

1. **Calendar-read scope** approved at session start — `schedule.negotiate` is part of the session's one-yes (trust gates that the request is even allowed). The user knows "this session can read my free/busy to find a time."
2. **Final time** approved before booking, on **both** sides, in plain words:
   > *"Lunch with Alex — Tuesday Jun 24, 12:00 PM, Mendocino Farms downtown. Approve? (y/n)"*
3. **The booker also explicitly approves the write** — *"I'll put it on your calendar and send Alex the invite. Go ahead?"* — because that's a `schedule.book` action on their calendar. The non-booking side approves the *time*; the booking side approves the *time + the write*.

No step books silently. `who_books` is agreed in `schedule.confirm` so exactly one side writes (see race condition in failure modes).

## 6. Negotiation strategy (open question — start simple)

- **v1: first-overlap-wins.** Intersect the two free/busy sets within `time_range` + `duration_min`, take the earliest few overlaps as candidates. Dead simple, predictable.
- **v2: scored proposals.** Weight candidates by stated `preferences` (time-of-day, weekday vs weekend), location/distance, and "meeting density" (avoid back-to-back days). Each agent scores locally; `schedule.proposal.rationale` explains the pick.
- Start with v1; the frame contract already supports v2 (candidates + rationale) without change.

## 7. Privacy

Sharing free-slot times **leaks calendar density** to the trusted peer ("you're free Tue/Thu but slammed Mon/Wed/Fri"). Trust = acceptable, but **state it**: only `schedule.availability` *within the requested `time_range`* is shared — never the full calendar, never event titles/attendees. Document in the trust UI: *"Finding a time means sharing when you're free in that window — not what's on your calendar."* Broker stays content-blind (slots are sealed).

## 8. Failure modes (design for these explicitly)

- **No overlap.** Recipient returns empty/sparse `schedule.availability`; initiator surfaces *"We have no shared availability in the next 2 weeks — want me to widen the window or suggest mornings?"* — don't dead-end.
- **Decline after proposal.** Either user rejects the candidate(s) at the approval step → send a `schedule.proposal` revision or a clean `meta.dialog` "let's try another week." No event written.
- **Booking race.** Both sides must not book. `who_books` in `schedule.confirm` designates one; the other side treats booking as the booker's job and waits for `schedule.booked`. If `schedule.booked` doesn't arrive within a timeout, the non-booker asks (never books unilaterally). Idempotency: include the agreed `chosen` slot so a late/duplicate booked frame is recognizable.
- **Calendar write fails locally** (Graph error, permission lapse) → booker sends `schedule.booked {error}` (or a `meta.dialog`) so the other side isn't left expecting an invite.

## 9. Open questions

1. **Negotiation strategy** — first-overlap (v1) vs scored (v2); ship v1, measure.
2. **Timezones** — all frames in UTC ISO-8601; each agent renders local. Confirm both agents normalize correctly (a classic bug source).
3. **Multi-party (>2 participants).** The frames list `participants`, but the relay is pairwise today. Three-way scheduling needs either a coordinator agent fanning out pairwise, or a multi-party session — out of scope for v1 (two participants), but don't paint the frame contract into a corner.
4. **Re-negotiation loops** — cap rounds to avoid two agents endlessly proposing/declining; after N rounds, surface to humans.
5. **Booking authority + invites** — does the booker send the calendar invite to the other participant (so it lands on both calendars natively), or does each side book its own copy? Recommend booker-sends-invite to avoid double events.
6. **Stale availability** — free/busy can change between `schedule.availability` and `schedule.confirm`. Re-check at confirm time on the booking side; if the chosen slot is now busy, fail gracefully back to proposal.
7. **Scope creep** — `schedule.negotiate` must not become a backdoor to read event *contents*. Enforce free/busy-only at the agent layer; document that titles/attendees are never shared.

## 10. Sequencing & relationships

- **After:** Account Dashboard Phases 1–4 (trust + approval surfaces) AND Skill Sharing (shares the cross-account invoke + approval patterns). **Most involved** of the autonomy features — calendar integration touches each agent's local stack — so it comes last of this group.
- **Reuses:** trusted-peer gating; the two-touch human approval model; sealed frames + broker content-blindness; `AccountAudit` (new events `schedule.negotiated`, `schedule.booked`).
- **Relation to Fast Channel** (`docs/fast-channel-protocol-epic.md`): scheduling is a strong fit for schema-typed frames (§3.1) and speculative branching (§3.2 — "if you're free Tue propose Tue, else propose Thu" pre-computed), once both are stable.
- **Relation to Favors** (`docs/favors-epic.md`): both are "agent acts on behalf of user via a trusted peer," but scheduling spends *calendar write authority* rather than tokens — hence the dedicated `schedule.book` scope + per-event approval.
- **Skill:** a new "Scheduling" section (the propose→availability→proposal→confirm→booked flow; the mandatory final-time + booking approvals). Bump skill revision when built.
