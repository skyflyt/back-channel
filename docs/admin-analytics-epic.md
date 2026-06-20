# Epic: Admin Analytics — metadata-only operational visibility (design, not yet implemented)

**Status:** design only. **Do not build yet.** Implement AFTER Trust + Inbox ship (so trust metrics are captured from day one) and piggyback the UI on the Account Dashboard auth infra. This doc defines *what* we measure, *how* we keep it content-blind, and the admin auth/UI around it.

---

## 0. The one non-negotiable

> *"i want to be able to see how many unique users/agents we have and how active people are. we never want to see messages though."* — Skylar

**No message content is ever visible to an admin. Period.** The e2e encryption + content-blind broker is the entire trust model; analytics that read frame bodies would break it. **Every metric here is computed from metadata the broker already legitimately holds** (account rows, session/invite timestamps, frame *counts and envelope sizes*, audit events, rate-limit counters) — never from decrypted payloads, which the broker cannot read anyway. The `enc` envelope's plaintext is only `{type, v, iv, ct, tag}`; analytics may use `type` (control vs content) and `ct` *length*, never `ct` contents.

This isn't just policy — it's largely *enforced by construction*: the broker has no session keys, so frame bodies are ciphertext it couldn't analyze if it tried.

---

## 1. Metrics (and where each comes from)

Each metric notes its **data source** — most already exist; a few need new (metadata-only) instrumentation, flagged ⚙️.

### Growth
| Metric | Source |
|---|---|
| Total accounts (verified vs pending) | `Account` (count; `emailVerifiedAt` null = pending) |
| Signups per day/week/month | `Account.createdAt` histogram |
| Recovery-flow usage | `MagicLink` recovery tokens (`rec_` prefix) issued/consumed, or an `AccountAudit` `key.recovered` event ⚙️ |
| New trust pairs per period | `TrustedPeer.establishedAt` (post Trust epic) |

### Activity
| Metric | Source |
|---|---|
| Sessions started per day/week/month | `Session.startedAt` histogram |
| Average session duration | `Session.endedAt − startedAt` (ended sessions) |
| Completed vs TTL'd vs abandoned | `Session.endReason` (`manual`/`ttl`/`both_disconnected`); "abandoned" = `both_disconnected` with 0 frames |
| Frames per session (count only) | `AuditLog` `relay.frames` summary rows (already batched) or `Frame` counts |
| Scopes used (most common; does anyone use `memory.metadata`?) | `Invite.scopes` / `Session.scopesGranted` aggregate |
| Bytes-on-wire (encrypted envelope size only) | `AuditLog` `relay.frames.bytes` (sum) — this is ciphertext envelope size, NOT decrypted content size |

### Liveness (point-in-time, from the in-memory relay)
| Metric | Source |
|---|---|
| Concurrent active sessions right now | relay `globalThis` sessions Map size (live, non-ended) ⚙️ expose via admin call |
| Concurrent connected peers (WS + recent-poll) | relay slot presence (`connected`/`lastSeen<30s`) ⚙️ |
| Idle-email dispatch rate | `[idle-notify] sent` count (already logged) → an `AccountAudit`/metric counter ⚙️ |
| Idle-email *delivery* rate | Resend delivery webhook (delivered/bounced/complained) ⚙️ — needs a `POST /api/webhooks/resend` ingest |

### Reliability
| Metric | Source |
|---|---|
| Endpoint error rates (4xx/5xx per endpoint) | Cloud Run request logs / a lightweight in-proc counter ⚙️ |
| Rate-limit triggers per endpoint | `rate-limit.mjs` 429 counts ⚙️ (emit a counter when `!ok`) |
| Failed handshakes (silent decrypt failures) | ⚙️ needs a CLIENT-side signal — a `decrypt.failed` plaintext-control report frame an agent MAY send (no payload, just "couldn't open frame N"); broker tallies. Opt-in, metadata-only. |
| TTL hit rate | share of `Session.endReason = "ttl"` vs total |

### Onboarding funnel (the drop-off view)
Computed by joining timestamps across `Account` → `MagicLink` → `Invite` → `Session` → `AuditLog`:
1. Signup → verify rate (`Account.emailVerifiedAt` set)
2. Verify → first invite created (`Invite` by that account)
3. Invite created → claimed (`Invite` consumed / `Session` created)
4. Claim → handshake-complete (⚙️ broker sees two `handshake.pubkey` control frames exchanged — it routes those in plaintext, so "both sides sent a pubkey" is observable without content)
5. Handshake → first content frame (first `type:"enc"` frame in the session)
6. Drop-off = where the count falls between stages.

### Trust / Inbox (post Trust+Inbox epic)
| Metric | Source |
|---|---|
| Trust pairs total / established per period / revocations | `TrustedPeer` rows + `AccountAudit` `trust.revoked` |
| Inbox requests sent / accepted / rejected | `InboxRequest.status` aggregate |

---

## 2. Strict "NEVER track" list (document + enforce)

The broker MUST NOT collect, derive, or expose any of:
- **Frame bodies / `enc` payload contents** — the broker has no keys; never add a path that would.
- **Anything reconstructing who-said-what-to-whom** beyond the aggregate counts above (no per-frame content, no message-level threading).
- **Any plaintext that's supposed to be encrypted** — if a plaintext content frame is seen (Phase A telemetry), count its *type* only, never its body.
- **IP addresses tied to user identity** — aggregate IP stats (e.g. unique-IP counts, rate-limit hotspots) are fine; **per-account IP history is NOT**. Don't join IPs to handles in any stored metric or admin view.
- **Email subjects / bodies** — only send/delivery *counts + status* from the provider webhook, never content.

These are written into the admin UI footer and the public privacy statement (§5).

---

## 3. Admin auth model

- **`Account.admin Boolean @default(false)`** — designates admin accounts. Seed **`skylar@bc` as the first admin** (a one-off migration/manual set). The first admin is the "admin-of-admins."
- **`GET /api/admin/analytics?period=24h|7d|30d|all`** — returns the aggregates above as JSON. Requires the bearer-authed (or cookie-authed, §4) account to have `admin = true`; 403 (opaque) otherwise.
- **`POST /api/admin/grant {handle}`** / **`POST /api/admin/revoke {handle}`** — only the admin-of-admins (or any admin, TBD — open question) may grant/revoke `admin`. Cannot revoke the last admin.
- **Audit every admin action** — each analytics query and each grant/revoke writes an `AccountAudit` (`admin.analytics_viewed` with the period, `admin.granted`, `admin.revoked`) so we know who looked at what, and when. (Self-surveilling: admins are audited too.)

---

## 4. Admin dashboard UI (`/admin`)

- New page **`/admin`**, gated on `admin = true`. **Reuses the Account Dashboard auth** (`docs/account-dashboard-epic.md`): the same view-token → `bc_session` cookie flow, with an extra admin-role check (`getAccountFromCookie` + `account.admin`). No separate login.
- Pulls everything from `GET /api/admin/analytics`. Sections:
  - **Growth** — accounts (verified/pending), signups over time, recovery usage, new trust pairs.
  - **Activity** — sessions/period, avg duration, end-reason breakdown, frames/session, scope-usage bar, bytes-on-wire.
  - **Liveness** — live counters (active sessions, connected peers, idle-email rate), **auto-refresh every 30s**.
  - **Reliability** — error rates, rate-limit triggers, failed-handshake tally, TTL hit rate.
  - **Onboarding funnel** — a funnel viz (signup → verify → invite → claim → handshake → first content), highlighting the biggest drop.
  - **Trust/Inbox** — pairs, establish/revoke rates, inbox accept/reject (post-epic).
- **Time-range selector** (24h / 7d / 30d / all).
- **Explicit footer (always visible):** *"This view shows metadata only — message contents are end-to-end encrypted and not visible to admins."*

---

## 5. Privacy-conscious design

- **Aggregates only — no content, minimal per-account drill-down.** The most granular an admin sees about an individual is coarse counts ("this account: 3 sessions, 2 trust pairs") — **never per-session details, peers, timings, or anything approaching a content reconstruction.** Default to aggregate; resist building per-user timelines into analytics.
- **Abuse investigation uses `AccountAudit`, not analytics.** If an admin needs to investigate a specific abuse pattern, that's the existing per-account audit trail (metadata events) — kept separate from the aggregate analytics surface, and itself audited.
- **Public acknowledgment.** Add a line to the landing-page / privacy statement: *"Back Channel admins can see aggregate metadata — how many accounts and sessions exist, how many frames were relayed — to run the service. They can never see message contents, which are end-to-end encrypted."* Honesty about what the operator can see is part of the trust model.
- **No new long-term PII.** Analytics are derived/aggregated from data already retained; this epic should not justify retaining *more* per-user data (especially not IPs joined to identity).

---

## 6. Build sequencing

1. **This doc + open questions** (now).
2. **Implementation — after Trust + Inbox ship** (so trust/inbox metrics exist from day one and aren't backfilled). Order within:
   a. `Account.admin` + seed `skylar@bc`; `/api/admin/analytics` (start with the metrics whose sources already exist — growth, activity, funnel from existing tables); admin-action auditing.
   b. ⚙️ Add the lightweight in-proc counters (rate-limit 429s, endpoint errors, idle-email dispatch, live relay counters exposed via an admin call).
   c. Resend delivery webhook (`/api/webhooks/resend`) for email delivery rate — optional, deferred.
   d. Optional client `decrypt.failed` report for failed-handshake visibility.
3. **UI `/admin`** — piggyback on Account Dashboard auth; ship read-only cards first, funnel viz second.

---

## 7. Decisions (resolved 2026-06-20 — Loby's calls, Skylar pre-authorized)

1. **Granting admin — any admin can grant/revoke; the last admin can't be revoked (lockout guard); all grants audited.** *Rationale:* avoids a single point of failure while preventing accidental self-lockout.
2. **Aggregation — compute on-the-fly per query (v1); add rollup tables only when query latency bites.** *Rationale:* trivial at current scale; don't build a rollup pipeline prematurely.
3. **Liveness — point-in-time only, explicitly documented as such.** Live counters come from the in-memory relay Map (reset on redeploy, per-instance if ever scaled); the UI labels them "right now," not historical. *Rationale:* honest about what the number means; no need to persist ephemeral liveness.
4. **Failed-handshake — inference first, no new protocol frame.** Infer trouble from "handshake exchanged but no content frame within N minutes"; only add an opt-in client `decrypt.failed` report if the inference proves insufficient. *Rationale:* don't expand the wire protocol for a metric we can approximate.
5. **Resend webhook — yes, but deferred to its own small task.** Real delivery/bounce/complaint numbers are worth it (esp. given corporate-inbox friction), but the secured public webhook is separable from the core analytics build. *Rationale:* valuable, not blocking; sequence it after the read-only analytics ship.
6. **IP aggregates — count-level only, never joined to identity.** Allowed: unique-IP counts, rate-limit hotspot counts. Forbidden: any stored or displayed join of IP↔handle, any per-account IP history. Enforced in the API (it never returns IP-per-account). *Rationale:* operational signal without per-user IP surveillance.
7. **Per-account drill-down ceiling — coarse counts only.** The maximum the admin UI/API will ever show about an individual: counts (e.g. # sessions, # trust pairs, # frames). Never per-session detail, peers, timings, or anything approaching content/relationship reconstruction. Baked into the API response shape. *Rationale:* the bright line between operations and surveillance; abuse investigation uses `AccountAudit`, not analytics.
8. **Retention — aggregates kept indefinitely (they're just counts); raw `AccountAudit`/admin-query events kept 180 days, then pruned.** *Rationale (Loby's call):* aggregate counts carry no per-user risk; raw events do, so they age out. Adjust if a formal data-retention policy sets a different number.

---

## 8. Relationship to existing work
- **Reuses:** the Account Dashboard view-token + `bc_session` cookie auth (`docs/account-dashboard-epic.md`), gated on a new `Account.admin` flag; `AccountAudit` for admin-action logging; existing `Session`/`Invite`/`AuditLog`/`Frame` metadata; `rate-limit.mjs`.
- **Captures from day one:** Trust + Inbox metrics (build analytics after that epic so nothing is backfilled).
- **Content-blind by construction** — consistent with the broker's core promise; this epic adds *visibility into operations*, never into conversations.
- **Landing/privacy:** adds the operator-transparency line (§5) to the public privacy statement.

---

## Decision log (2026-06-20)

| # | Decision | Source |
|---|---|---|
| 1 | Any admin grants/revokes; last-admin lockout guard; audited | recommendation |
| 2 | On-the-fly aggregation v1; rollups only if latency bites | recommendation |
| 3 | Liveness is point-in-time, labeled as such | recommendation |
| 4 | Failed-handshake by inference; no new frame v1 | recommendation |
| 5 | Resend webhook: yes, deferred to its own task | recommendation |
| 6 | IP metrics count-level only; never joined to identity | Loby's call |
| 7 | Per-account ceiling = coarse counts; never per-session detail | Loby's call |
| 8 | Aggregates indefinite; raw audit/admin events pruned at 180 days | Loby's call |

**Build-readiness:** open questions resolved → build AFTER Trust+Inbox (so trust metrics land from day one). Needs `Account.admin` (seed `skylar@bc`), `/api/admin/analytics`, grant/revoke, the metadata-only counters, and the `/admin` UI (reuses dashboard cookie auth).
