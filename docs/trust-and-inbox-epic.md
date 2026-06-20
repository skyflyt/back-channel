# Epic: Agent Trust + Inbox (design — not yet implemented)

**Status:** design only. Do not build until prioritized after the current round of fresh-on-fresh test runs.

## Problem

Today, every collaboration starts with a one-time invite code shared out-of-band (the helper texts a code to a friend, who pastes it into their agent). That's the right gate for a *first* connection between strangers. But for two people who've already collaborated and trust each other, re-sharing a code every time is friction. Skylar:

> *"After I connect with my friend we can have the option to allow our two agents to 'trust' each other to a certain extent, so in the future one agent can leave a session request on the other's inbox; if the human approves, they just connect — no new invite code. But only for agents that have already had a session together and **both** users approved the trust."*

**Goal:** let a previously-collaborated, mutually-trusting pair re-connect without the invite-code dance — the requesting agent drops a request in the recipient's **inbox**, the recipient's human approves, and a session opens. Trust replaces the *invite code*, **not** the per-session scope approval.

## Principles (non-negotiable)

1. **Mutual + explicit.** Trust requires *both* users to opt in after a real session. Neither side can unilaterally trust the other.
2. **Trust ≠ auto-approve.** A trusted peer can *reach* you without a code, but every inbox request still surfaces the goal + scope for a fresh one-yes session approval (per the v0.3.13 session-consent model).
3. **No transitive trust.** Trust is strictly per account-pair. "My friend's friend" gets nothing.
4. **Revocable instantly, one-sided, no notice.** Either party kills the trust at any time.
5. **Builds on existing primitives.** Once an inbox request is accepted, the session is identical to today: same invite→session record, ECDH handshake, AES-GCM frames, session-goal first frame, keep-warm, transcript. Trust + inbox only replace the *code-sharing* step.

## Schema (Prisma)

```prisma
model TrustedPeer {
  id              String   @id @default(uuid())
  accountId       String   // the owner of this trust record
  trustedAccountId String  // the peer they trust
  establishedAt   DateTime @default(now())
  lastUsedAt      DateTime?
  scopeDefaults   String[] // optional: scopes to pre-fill on inbox requests to/from this peer

  account        Account  @relation("TrustOwner",  fields: [accountId],        references: [id])
  trustedAccount Account  @relation("TrustPeer",    fields: [trustedAccountId], references: [id])

  @@unique([accountId, trustedAccountId])   // one record per directed pair
  @@index([accountId])
}

model InboxRequest {
  id                 String   @id @default(uuid())
  recipientAccountId String
  requesterAccountId String
  requestedScopes    String[]
  message            String?
  status             InboxStatus @default(pending)
  sessionId          String?  // set when accepted (the created session)
  createdAt          DateTime @default(now())
  expiresAt          DateTime // createdAt + 24h
  resolvedAt         DateTime?

  recipient Account @relation("InboxRecipient", fields: [recipientAccountId], references: [id])
  requester Account @relation("InboxRequester", fields: [requesterAccountId], references: [id])

  @@index([recipientAccountId, status])
  @@index([expiresAt])
}

enum InboxStatus { pending accepted rejected expired }
```

Note: `TrustedPeer` is **directed** (two rows for a mutual trust). "Mutual trust exists" = both directed rows present. This makes one-sided revoke trivial (delete your row) and lets each side keep its own `scopeDefaults`.

## Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/trust/establish` | POST `{peer_handle, session_id}` | bearer | Mark intent to trust `peer_handle`, tied to a just-ended session. Trust becomes *mutual/active* only when BOTH sides have called it for the same session within the window. |
| `/api/trust` | GET | bearer | List my trusted peers: `{handle, established_at, last_used_at}`. |
| `/api/trust/:peer_handle` | DELETE | bearer | Revoke trust (deletes my directed row). Immediate, one-sided, no notice. |
| `/api/inbox/request` | POST `{peer_handle, scopes, message}` | bearer | Drop a session request in a **trusted** peer's inbox. 403 if not mutually trusted. |
| `/api/inbox` | GET | bearer | Recipient lists pending inbox requests (polled by keep-warm). |
| `/api/inbox/:id/accept` | POST | bearer | Recipient accepts → broker creates the invite+session, returns `session_id`. No code exchanged. |
| `/api/inbox/:id/reject` | POST | bearer | Recipient declines. |

Inbox requests **expire after 24h** unread (swept like magic links / frame buffer).

## UX flow

### Establishing trust (after a session)
At session end, *each* agent asks its own user, in plain language (Rule #0):

> *"Want to trust Skylar's agent for future help? Trusted means they can reach you directly next time without a new invite code — you'd still approve each session before anything happens. (y/n)"*

- Each "yes" → `POST /api/trust/establish {peer_handle, session_id}`.
- Trust goes **active only when both** directed rows exist for that session, both created within **N hours** (proposed: 24h) of the session ending. One-sided yes = nothing happens; never surfaced to the other user as "they wanted to trust you."

### Re-connecting later (no code)
1. Requester's user: *"Have my agent ping Skylar about the budget review."*
2. Requester agent → `POST /api/inbox/request {peer_handle:"skylar@bc", scopes:[…], message:"Budget review follow-up"}` (403 if trust isn't mutual).
3. Recipient's **keep-warm job** (it already polls; add an `/api/inbox` check to the cycle) sees the pending request and surfaces it:
   > *"Skylar's agent wants to collaborate again — to **review your budget forecast** (read your notes + suggest edits). Approve? (y/n)"*
4. User yes → `POST /api/inbox/:id/accept` → broker mints the session → both agents run the **normal** flow (handshake → session-goal first frame → one-yes-per-session → rapid back-and-forth).
5. User no → `POST /api/inbox/:id/reject`.

So the *only* thing trust removes is the manual code hand-off. The recipient still gets a clear, scoped, one-tap approval per session.

## Security model

- **Mutual establishment, bounded in time.** Both sides must `/establish` within N hours of a *successful* session (verify the `session_id` is real, ended, and that both accounts were its participants). Prevents drive-by/unilateral trust.
- **Trust ≠ scope.** An inbox request still declares `scopes`, still gets a per-session human approval. Trust only waives the invite code.
- **Scope ceiling (open question).** Consider capping inbox-requested scopes at what the *original* trusted session used (or what `scopeDefaults` allows), so trust can't later be used to request far broader access silently. Recommend: yes — inbox requests may not exceed `scopeDefaults`; widening requires a fresh coded invite.
- **No transitive trust / no enumeration.** `/api/inbox/request` to a non-trusted handle returns the same opaque error as an unknown handle (don't reveal trust state or account existence).
- **Instant revoke.** `DELETE /api/trust/:peer_handle` removes the directed row; the next `/api/inbox/request` from that peer 403s. No notification to the revoked side.
- **Rate limit.** `/api/inbox/request` capped per requester→recipient pair (proposed: **5/day**) so a soured pair can't spam. Per-IP limits also apply.
- **Audit.** Append an `AuditLog`-style entry for every trust establish, trust revoke, inbox request, accept, and reject (metadata only — no content).
- **Encryption unchanged.** Inbox + trust carry no message content; the eventual session is e2e-encrypted exactly as today.

## Integration with existing system

- **Keep-warm:** add `GET /api/inbox` to the keep-warm cycle (alongside `/api/sessions/active`) so a trusted ping reaches an idle recipient. The idle-recipient email notification should also fire for a new inbox request ("Skylar's agent wants to collaborate — open to review").
- **Accept = existing session creation:** `/api/inbox/:id/accept` internally does what `/api/invites + claim` do today, minus the code. Reuse that path.
- **Skill:** a new "Step 1e / Step 6: Trusted re-connect" section + the end-of-session trust prompt. Bump skill revision when built.

## Open questions (decide before building)

1. **N-hours window** for mutual establishment — 24h proposed. Too short = users miss it; too long = stale intent.
2. **Scope ceiling on inbox requests** — cap at `scopeDefaults` / original session scope? (Recommended yes.)
3. **Re-establish after revoke** — does a fresh coded session re-enable, or is there a cooldown?
4. **Notification fatigue** — inbox requests email + keep-warm surface; ensure the same rate-limit/quiet rules as idle notifications.
5. **Handle changes / account deletion** — cascade trust rows on account delete; decide behavior if a handle is reissued.
6. **Multi-instance** — `TrustedPeer`/`InboxRequest` are in Postgres (durable), so this is multi-instance-safe even though the relay frame buffer isn't yet.

## Rough build order (when prioritized)

1. Schema + migration (`TrustedPeer`, `InboxRequest`).
2. `/api/trust/*` (establish with mutual+window check, list, revoke) + audit.
3. `/api/inbox/*` (request with trust check + rate limit, list, accept→session, reject) + expiry sweep.
4. Keep-warm + idle-notification integration.
5. Skill: end-of-session trust prompt + trusted re-connect flow.
6. Smoke: establish (one-sided → inactive; both → active), request (trusted ok / untrusted 403), accept→session opens + handshake works, revoke → subsequent request 403, rate-limit, expiry.
