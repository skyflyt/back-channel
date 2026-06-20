# Epic: Account Dashboard (+ Trust & Inbox) — design, not yet implemented

**Status:** **building.** Greenlit. **Wave 1 (Foundation) SHIPPED 2026-06-19** in `d4c87b0` + redirect-host fix `ed491b4` (rev `00043`, `v0-5-20`) — see §7. Waves 2–4 in progress. This doc supersedes and absorbs the former `docs/trust-and-inbox-epic.md` (trust + inbox are tightly coupled to the dashboard, so they live here now).

---

## 1. Why

Today a user's only web surface is `/sessions/:id` — paste your `bc_…` API key to watch one session. That's fine for a power user mid-session; it's jarring for a non-technical user (the JEI exec) who just clicked a link in an email and is now asked to paste an API key to see "their stuff." There's also no place to see *all* your sessions, manage the agents you've trusted, accept a re-connect request, or rotate a leaked key.

Skylar:

> *"that magic link that comes to email should take you to an account page that shows you any sessions you have, any agents you have trusted and you should be able to remove trust and control your api key."*

**Goal:** a single web home — **`/account`** — that any user-side magic link lands on, authenticated, with no API-key paste. From there: see sessions, manage trusted agents, handle an inbox of re-connect requests, and control the API key — all in Rule #0 plain language.

This makes Back Channel *feel like a product* rather than an API with a transcript viewer.

---

## 2. Where you land on it

`/account` is the **default landing page for every user-facing magic link**:

| From | Today | After this epic |
|---|---|---|
| Idle-recipient email "Open the session" | → `/sessions/:id` (asks for key) | → `/account?view_token=…&session=:id` (authenticated; deep-links to that session, also shows the whole dashboard) |
| Signup verify (`/verify`) | shows key once, dead-ends | shows key once → **continue to `/account`** (now authenticated via the just-issued context) |
| Key recovery (`/recover`) | shows rotated key once, dead-ends | shows key once → **continue to `/account`** |
| Direct `back-channel.app/login` | (doesn't exist) | email entry → emails a view-link → `/account` |

The session-specific wake-up *paste prompt* (shipped in the email + on `/sessions/:id`) is still the mechanism that wakes a sleeping agent. The dashboard is the **human's** home; the paste prompt is the **agent's** instruction. Both coexist: `/account` surfaces the prompt for the relevant session too.

---

## 3. Auth model — view-tokens + browser session cookie

The dashboard must NOT require pasting the agent's bearer `bc_…` key into a web form. Instead, a **view-token** issued to the verified email, exchanged for a short-lived **browser session cookie**.

### Flow

1. `POST /api/auth/view-token-request { email }` → broker mints a `ViewToken` and emails `…/account?view_token=<random>`. Opaque response (same whether or not the account exists — never leak account existence, consistent with signup/recover).
2. User clicks the link → `/account` page calls `POST /api/auth/view-token-consume { view_token }`.
   - Validates: exists, not expired (15 min), not used. Marks `usedAt`.
   - Sets an **httpOnly, Secure, SameSite=Lax** session cookie (`bc_view`) → a server-side `SessionCookie` row, 24h TTL.
   - Returns the account's display info.
3. Subsequent dashboard API calls authenticate via the cookie (no bearer key). "Sign out" clears the cookie + deletes the `SessionCookie` row.

### Permission tier — view-token / cookie is NOT the agent key

The cookie grants a **limited, human-scoped** capability set — deliberately a subset of what the agent's `bc_…` bearer can do:

| Action | Cookie (human) | Bearer `bc_…` (agent) |
|---|---|---|
| List my sessions / view a transcript | ✅ | ✅ |
| End / kick a session | ✅ | ✅ |
| List / **revoke** trusted peers | ✅ | ✅ |
| View inbox / **accept**/decline a request | ✅ | ✅ |
| **Rotate** my API key | ✅ (one-time reveal) | ✅ |
| Toggle notification settings | ✅ | ✅ |
| **Create an invite / claim / poll / send frames** | ❌ | ✅ |
| Read the *current* full API key | ❌ (masked only) | n/a |

Rationale: a stolen/forwarded view-link should let an attacker *manage* (and even lock out, via rotate) but never *operate an agent* or exfiltrate the live key. Rotation is allowed because it's a recovery/defensive action (and reveals only the NEW key, once) — the same trust level as the existing `/recover` flow, which is already email-gated.

> **Open question (4.1):** is allowing key rotation from a 15-min emailed view-link acceptable, or should rotation require an extra step (re-enter email / second confirmation click)? Recommend: allow it, but log it (`key.rotated`) and email a "your key was rotated" notice to the account so a surprise rotation is visible.

---

## 4. Dashboard sections (scope + UI sketch)

All copy is Rule #0 plain language. Section headers: **Sessions · Trusted Agents · Inbox · Your API key · Settings**. Destructive actions get a confirm dialog.

### 4a. Your API key
```
Your API key
  bc_••••••••••••G7Yx          [ Rotate key ]
  Created Jun 12 · Last used 4 minutes ago
```
- Masked always (`bc_` + last 4). The full *current* key is never shown on the dashboard (it was shown once at issue time).
- **Rotate** → confirm (*"Rotate your API key? Any agent still using the old key will stop working until you give it the new one."*) → rotates → shows the NEW key ONCE with a "copy + save somewhere safe" callout (same component as `/verify`) → emails a "key rotated" notice.
- Shows `createdAt` and `lastUsedAt` (requires tracking last-used — see schema).

### 4b. Sessions
```
Active now (2)
  ● skylar@bc — "fix automations.yaml"   started 3m ago   [Watch] [End]
  ● dana@bc   — "review Q3 forecast"      started 1m ago   [Watch] [End]
Recent (last 30 days)
  ✓ pat@bc    — "scaffold workspace"      ended Jun 18 · 22m · completed
```
- **Active:** from `/api/sessions/active` (already exists). "Watch" → `/sessions/:id`. "End" → confirm → `POST /api/sessions/:id/end` (`session.ended_manually` audit).
- **History:** completed sessions in last 30 days (peer, goal, duration, end reason). Needs a `GET /api/sessions/history` (new) reading ended Session rows. Goal text comes from the invite `message` / first-frame `session_goal` if we persist it (today it's inside an encrypted frame — likely store the plaintext `message` from invite creation as the human label; do NOT try to surface encrypted content).

### 4c. Trusted Agents  *(depends on Trust feature — §6)*
```
Trusted Agents
  skylar@bc   trusted Jun 14 · last worked together Jun 18
              can request: config.read, config.suggest      [ Revoke ]
```
- List from `GET /api/trust`. Per-peer: handle, established date, last-used, the scope ceiling they may request.
- **Revoke** → confirm (*"Revoke trust with skylar@bc? They'll need a fresh invite code to reach you again."*) → `DELETE /api/trust/:peer_handle` (instant, one-sided, no notice; `trust.revoked` audit).
- v1: establishing trust happens only via the post-session prompt (§6). Manual "add trusted agent" from the dashboard is **v2 maybe** (open question 4.4).

### 4d. Inbox  *(depends on Inbox feature — §6)*
```
Inbox (1)
  skylar@bc wants to collaborate again
     "Budget review follow-up" · would read your notes + suggest edits
     [ Approve & open ]   [ Decline ]
```
- From `GET /api/inbox` (pending requests from trusted peers). **Approve** → `POST /api/inbox/:id/accept` → broker mints the session → deep-link to `/sessions/:id` (and the agent runs the normal handshake/one-yes flow). **Decline** → `POST /api/inbox/:id/reject`.
- Still a per-session human approval — trust only removed the invite-code step (see §6 principle 2).

### 4e. Settings
```
Settings
  [✓] Email me when I have a message and my agent is asleep   (shipped)
  [ ] Text me (SMS)            — coming soon
  [ ] Browser notifications    — coming soon
  Sign out
```
- The idle-email toggle maps to the existing `Account.notifyIdleFrames`. Needs `PATCH /api/account/settings { notifyIdleFrames }` (cookie-auth). Future toggles wire to the alt-delivery-channels epic (`docs/alt-delivery-channels.md`).

---

## 5. Schema additions

### Dashboard-specific
```prisma
model ViewToken {
  token      String   @id            // random, urlsafe
  accountId  String
  purpose    String   @default("account") // "account" | "session:<id>" deep-link hint
  createdAt  DateTime @default(now())
  expiresAt  DateTime                 // createdAt + 15 min
  usedAt     DateTime?
  account    Account  @relation(fields: [accountId], references: [id])
  @@index([accountId])
  @@index([expiresAt])
}

model BrowserSession {                // server-side cookie session (named to avoid clash with Session)
  token        String   @id          // random; stored in httpOnly cookie bc_view
  accountId    String
  createdAt    DateTime @default(now())
  expiresAt    DateTime               // createdAt + 24h
  lastUsedAt   DateTime?
  account      Account  @relation(fields: [accountId], references: [id])
  @@index([accountId])
  @@index([expiresAt])
}
```
- Add `Account.apiKeyLastUsedAt DateTime?` (touched by `getAccountFromAuth`, throttled) so the dashboard can show "last used."
- New audit event types: `key.rotated`, `trust.revoked`, `session.ended_manually`, `viewtoken.issued`, `viewtoken.consumed`, `inbox.accepted`, `inbox.rejected`.
- Both token tables swept on expiry (same pattern as MagicLink / frame buffer).

### Trust + Inbox  *(carried over from the former trust-and-inbox-epic.md)*
```prisma
model TrustedPeer {
  id               String   @id @default(uuid())
  accountId        String   // owner of this trust record
  trustedAccountId String   // the peer they trust
  establishedAt    DateTime @default(now())
  lastUsedAt       DateTime?
  scopeDefaults    String[] // scopes pre-fillable on inbox requests to/from this peer (also the ceiling)
  account          Account  @relation("TrustOwner", fields: [accountId],        references: [id])
  trustedAccount   Account  @relation("TrustPeer",  fields: [trustedAccountId], references: [id])
  @@unique([accountId, trustedAccountId])  // directed: two rows = mutual
  @@index([accountId])
}

model InboxRequest {
  id                 String      @id @default(uuid())
  recipientAccountId String
  requesterAccountId String
  requestedScopes    String[]
  message            String?
  status             InboxStatus @default(pending)
  sessionId          String?     // set when accepted
  createdAt          DateTime    @default(now())
  expiresAt          DateTime    // createdAt + 24h
  resolvedAt         DateTime?
  recipient Account @relation("InboxRecipient", fields: [recipientAccountId], references: [id])
  requester Account @relation("InboxRequester", fields: [requesterAccountId], references: [id])
  @@index([recipientAccountId, status])
  @@index([expiresAt])
}

enum InboxStatus { pending accepted rejected expired }
```
`TrustedPeer` is **directed** (two rows for mutual trust); "mutual trust exists" = both rows present. Makes one-sided revoke trivial and lets each side keep its own `scopeDefaults`.

---

## 6. Trust & Inbox (absorbed — full design)

### Problem
A one-time invite code is the right gate for a *first* connection between strangers. For two people who've already collaborated and trust each other, re-sharing a code every time is friction. Trust replaces the **invite code**, not the per-session scope approval.

### Principles (non-negotiable)
1. **Mutual + explicit.** Trust requires *both* users to opt in after a real session. Neither side can unilaterally trust the other.
2. **Trust ≠ auto-approve.** A trusted peer can *reach* you without a code, but every inbox request still surfaces goal + scope for a fresh one-yes session approval (the v0.3.x session-consent model).
3. **No transitive trust.** Strictly per account-pair. "My friend's friend" gets nothing.
4. **Revocable instantly, one-sided, no notice.** Either party kills trust anytime (from the dashboard, §4c).
5. **Builds on existing primitives.** An accepted inbox request mints the normal invite→session record; ECDH handshake, AES-GCM frames, session-goal first frame, keep-warm, transcript all unchanged. Trust + inbox only replace the *code-sharing* step.

### Endpoints
| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/trust/establish` | POST `{peer_handle, session_id}` | bearer | Intent to trust, tied to a just-ended session. Active only when BOTH sides call it for the same session within the window. |
| `/api/trust` | GET | bearer **or cookie** | List my trusted peers. |
| `/api/trust/:peer_handle` | DELETE | bearer **or cookie** | Revoke (delete my directed row). Instant, one-sided, no notice. |
| `/api/inbox/request` | POST `{peer_handle, scopes, message}` | bearer | Drop a request in a **trusted** peer's inbox. 403 (opaque) if not mutually trusted. |
| `/api/inbox` | GET | bearer **or cookie** | List pending inbox requests (also polled by keep-warm). |
| `/api/inbox/:id/accept` | POST | bearer **or cookie** | Accept → broker mints invite+session, returns `session_id`. No code. |
| `/api/inbox/:id/reject` | POST | bearer **or cookie** | Decline. |

(The dashboard reaches trust/inbox via the **cookie**; agents reach establish/request via the **bearer key**. `establish` and `inbox/request` are agent-initiated → bearer only.)

### UX flow
- **Establishing (after a session):** each agent asks its own user, Rule #0: *"Want to trust Skylar's agent for future help? Trusted means they can reach you without a new invite code — you'd still approve each session before anything happens. (y/n)."* Each yes → `POST /api/trust/establish`. Active only when **both** directed rows exist within **N hours** (proposed 24h) of session end. One-sided yes is never surfaced to the other user.
- **Re-connecting later (no code):** requester agent → `POST /api/inbox/request`; recipient sees it in the **dashboard Inbox** (§4d) and/or a keep-warm/email nudge; approves → session mints → normal flow.

### Security model
- **Mutual establishment, time-bounded.** Verify the `session_id` is real, ended, and both accounts participated. Prevents drive-by/unilateral trust.
- **Trust ≠ scope.** Inbox requests still declare scopes + get per-session human approval. **Scope ceiling:** inbox-requested scopes may not exceed the peer's `scopeDefaults`; widening requires a fresh coded invite. (Recommended.)
- **No enumeration.** A request to a non-trusted/unknown handle returns the same opaque error (don't reveal trust state or account existence).
- **Rate limit.** `/api/inbox/request` capped per requester→recipient pair (proposed 5/day) + per-IP.
- **Audit** every establish / revoke / request / accept / reject (metadata only).
- **Encryption unchanged.** Trust + inbox carry no content; the eventual session is e2e-encrypted as today.

---

## 7. Build sequencing

Ship in waves; each wave is independently useful and testable.

**Wave 0 — prerequisites (this is already shipping):** Fresh-on-Fresh Survivability, email wake-up prompt, corporate-reputation coaching. **Gate the whole epic behind these landing.**

**Wave 1 — view-auth + skeleton.** Split across phases as built:

***Phase 1 — Foundation. ✅ SHIPPED 2026-06-19 (`d4c87b0`, fix `ed491b4`, rev `00043`):***
1. ✅ `ViewToken` + `SessionCookie` (named so vs the collaboration `Session`) + `AccountAudit` schema; `Account.apiKeyLastUsedAt`. (Pushed to prod via `prisma db push`.)
2. ✅ `POST /api/auth/view-token-request` (opaque, rate-limited) → `GET /api/auth/view-verify` (consumes, sets `bc_session` httpOnly cookie, redirects to `/account`); `POST /api/auth/logout`.
3. ✅ `getAccountFromCookie()` human-tier auth; `GET /api/account/me` (masked key only); `/account` skeleton + `/login` page.
4. ✅ `POST /api/account/view-token-self` (bearer) — agent/test-harness mints a view-token for its own account (email bypass).
5. ✅ Audits `view-token.issued` / `view-token.consumed`. Smoke: 14/14 (incl. single-use, 401-without-cookie, logout).

***Phase 2a — core sections. ✅ SHIPPED 2026-06-20 (`f398c5e`, rev `00047`):*** `GET /api/account/sessions` (active + 30-day recent, metadata only); end button (`/api/sessions/:id/end` dual-auth; `session.ended_manually` audit); `POST /api/account/key/rotate` (once-reveal + invalidate + `key.rotated` audit + notice email); `PATCH /api/account/settings` (idle toggle); `/account` UI wired. Smoke 14/14.

***Phase 2b — security + email overhaul. ✅ SHIPPED 2026-06-20 (2b-1 `f8dca1a` rev `00048`; 2b-2 `002e438` rev `00049`):***
- ✅ **Hash tokens at rest** — ViewToken/SessionCookie/MagicLink stored as sha256; raw only in link/cookie (security finding).
- ✅ **Scanner-safe view-token** — GET `view-verify` is a non-consuming redirect; new POST `view-token-consume` is the only consumer (security finding).
- ✅ **Emails → `/account`** — view-token email + idle email land authenticated (idle keeps the per-session wake-prompt copy-block + mints a view-token).
- ✅ **verify/recover set `bc_session`** + "open your dashboard" callout; **transcript dual-auth** (cookie) so "Watch"/"Open session" need no key paste. Smoke 9/9 + 6/6.
- ⏳ **Remaining:** CSRF token on cookie mutations (deferred from §8.11; retrofit before/with Phase 3).

**Wave 2 — trust:** `TrustedPeer` schema; `/api/trust/*` (establish with mutual+window check, list, revoke) + audit; post-session "trust this agent?" prompt in the skill; **Trusted Agents** dashboard section.

**Wave 3 — inbox:** `InboxRequest` schema; `/api/inbox/*` (request w/ trust check + rate limit + scope ceiling, list, accept→session, reject) + expiry sweep; keep-warm + email integration ("Skylar's agent wants to collaborate again"); **Inbox** dashboard section.

**Wave 4 — polish/v2:** manual "add trusted agent" from dashboard (if 4.4 says yes); richer history; SMS/web-push settings (ties to alt-delivery-channels epic).

Dependency notes: Waves 2 & 3 add new endpoints but **reuse Wave-1 cookie auth** for their dashboard-facing reads/writes. Inbox accept **reuses the existing invite→session creation path** minus the code. Nothing in Waves 2–4 touches the e2e crypto or relay.

---

## 8. Decisions (resolved 2026-06-20 — Skylar-reviewed)

1. **Key rotation from a view-link — ALLOWED (Skylar: "emailed link is good").** Rotate from the 15-min emailed view-link; no second confirmation. Always `key.rotated` audit + a "key rotated" notice email (both shipped in Phase 2a). *Rationale:* same trust level as the existing `/recover` flow, and the notice makes a surprise rotation visible.
2. **Lifetimes — 15-min view-token / 24-h cookie, no idle timeout v1 (Skylar: "24h is probably a good start").** *Rationale:* good balance; revisit an idle timeout only if shared-machine risk shows up.
3. **History — 30 days, label = invite `message` (Skylar: "ok").** Never attempt to render encrypted goal/content; the host-chosen plaintext `message` is the human label. *Rationale:* content-blind; already implemented this way in Phase 2a.
4. **Trust control from dashboard — YES, but ONLY for peers you've had a prior session with (Skylar).** The dashboard lets you **enable/disable trust for any peer with whom a real session previously existed** — not arbitrary handles. So the gate isn't "a mutual post-session prompt was clicked" but "a session has happened between us"; given that history, either side may toggle trust on/off from the dashboard at will. *Rationale:* Skylar's call — makes trust a managed setting over your real connection history, not a one-shot prompt, while still preventing cold-trusting a stranger. **Schema impact:** trust establishment no longer strictly requires the mutual-establish-within-N-hours dance (§6) — a prior session between the pair is the eligibility gate; mutual *enable* still required for trust to be active (both sides must have it on).
5. **Mutual-trust window — configurable, default generous, up to infinite (Skylar: "adjustable up to infinite").** The N-hours window becomes a setting; "infinite" (no expiry on the eligibility to establish) is allowed. Combined with #4, the practical model: once you've had a session, that pair stays eligible to trust indefinitely; each side toggles it. *Rationale:* Skylar's call; removes artificial expiry friction.
6. **Scope ceiling on inbox requests — YES, cap at `scopeDefaults` (Skylar: "yes").** Inbox-requested scopes may not exceed the peer's `scopeDefaults`; widening needs a fresh coded invite. *Rationale:* trust waives the code, not the scope ceiling.
7. **Re-establish after revoke — no cooldown; immediate re-enable (Loby's call, pre-authorized).** Since trust is now a dashboard toggle over session history (#4), a revoke is just "off"; the user can toggle it back on anytime (the pair stays eligible). No fresh coded session required, no cooldown. *Rationale:* consistent with the toggle model; a cooldown would be surprising for a setting you control. (A cooldown is an equivalently-valid future change if abuse appears.)
8. **Notification fatigue — same rate-limit/quiet rules as idle email (Skylar: "yes rate limit").** Inbox-request emails + keep-warm surfacing obey the existing per-recipient rate limit / quiet windows. *Rationale:* one consistent nudge policy across all notification types.
9. **Account deletion / handle reissue — cascade on delete; trust is account-keyed, not handle-keyed (Skylar: "your call").** Deleting an account cascades its `ViewToken`/`SessionCookie`/`TrustedPeer`/`InboxRequest`/`AccountAudit` rows. Handles are **not** reused across accounts; trust references `accountId`, so even if a handle string were ever reissued, trust never transfers to a different account. *Rationale (Loby's call):* simplest safe behavior; no accidental trust inheritance.
10. **Multi-instance — resolved, no action.** All dashboard/trust tables are in Postgres (durable, multi-instance-safe); the dashboard doesn't add to the single-instance relay constraint.
11. **CSRF — required: SameSite=Lax + a double-submit token on state-changing cookie POSTs (Loby's call, pre-authorized).** Rotate/revoke/end/accept get a CSRF token in addition to the existing SameSite=Lax cookie. *Rationale:* SameSite=Lax blocks most cross-site POSTs but a defense-in-depth token is cheap and standard. **Build note:** add to Phase 2/3 cookie-authed mutations (the Phase-2a ones — rotate/settings/end — should get the token retrofitted before Phase 3 adds trust/inbox mutations).

---

## 9. Relationship to existing work
- **Reuses:** `/api/sessions/active`, `/sessions/:id`, the `/verify` key-reveal component, `Account.notifyIdleFrames`, the magic-link/email infra (Resend, `notify.mjs`), and the invite→session creation path.
- **Absorbs:** the former `docs/trust-and-inbox-epic.md` (now deleted; its content is §6 here).
- **Adjacent:** `docs/alt-delivery-channels.md` (Settings toggles for SMS/Slack/Teams/web-push wire in at Wave 4).
- **Skill:** Wave 2 adds the post-session trust prompt; otherwise the dashboard is a human surface and doesn't change the agent protocol. Bump skill revision only when the trust prompt ships.

---

## Decision log (2026-06-20)

| # | Decision | Source |
|---|---|---|
| 1 | Key rotation allowed from the 15-min view-link (+ audit + notice) | Skylar |
| 2 | 15-min token / 24-h cookie; no idle timeout v1 | Skylar |
| 3 | 30-day history; label = invite `message` (never encrypted content) | Skylar |
| 4 | **Trust is a dashboard toggle, eligible for any peer you've had a prior session with** (not arbitrary handles); supersedes the strict mutual-prompt-within-N-hours model in §6 | Skylar |
| 5 | Trust-eligibility window configurable up to infinite | Skylar |
| 6 | Inbox-request scopes capped at peer `scopeDefaults` | Skylar |
| 7 | Revoke → immediate re-enable, no cooldown (toggle model) | Loby's call |
| 8 | Inbox/keep-warm nudges obey the idle-email rate-limit/quiet rules | Skylar |
| 9 | Cascade dashboard/trust rows on account delete; trust is accountId-keyed (no handle-reissue inheritance) | Skylar ("your call") |
| 10 | Multi-instance: no action (all Postgres-backed) | recommendation |
| 11 | CSRF: SameSite=Lax + double-submit token on cookie mutations | Loby's call |

> **§6 reconciliation note:** decisions #4/#5 update the Trust model — eligibility to trust a peer is now "a real session has occurred between us" (kept indefinitely), and trust is an enable/disable toggle each side controls from the dashboard, rather than a one-shot mutual prompt that must both fire within N hours. Trust is still **mutual** (active only when both sides have it enabled) and **accountId-keyed**. §6's endpoints/schema stand; the *establishment trigger* is what changed. Phase 3 builds to this resolved model.

**Build-readiness:** Phase 1 + 2a + 2b shipped & verified. CSRF retrofit (§8.11) is the one carry-over, folded into Phase 3. Phase 3 (trust + inbox) is **next** — all trust decisions resolved (build to the toggle-over-session-history model above).
