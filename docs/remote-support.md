# Remote support: one-time help for someone else

Phase B of "agents and Back Channel Remote" (design: the vault's `agent-remote-design.md` §3 to §5, chunks B1,
B2 and B4; decisions taken 2026-10-09). Example: Skylar's mother needs help with her printer. Skylar's agent asks
for a support code; Skylar approves it on the Remote page and sends her the code or link himself. She opens it,
sees who is asking and for what, runs a temporary helper app, presses Allow on her own screen, and confirms every
action. The agent does that one task through it; it disconnects, and the helper removes itself. Both sides get a
plain transcript.

This has the shape of a tech-support scam, so the safe path is the easy one and the dangerous ones are
structurally hard. It is deliberately not Phase A pointed at a stranger: the helped person is the one in control.

This document is the broker side. The temporary client itself (design chunk B3, in the AppBridge repo), the relay's
routing for it, and code signing and publishing are **not built here**: see [What is not built](#what-is-not-built).

Code: `apps/broker/src/lib/remote-support/rules.mjs` (every decision, pure, `node --test`),
`src/lib/remote-support/proof.mjs` (the helper's key and signatures), `src/lib/remote-support.ts` (I/O),
`src/lib/appbridge.ts` (the "support" relay lease), `src/lib/mcp/remote-tools.mjs` (the MCP catalog),
`src/app/support/[code]/page.tsx` and `src/app/support/page.tsx` (the landing pages),
`src/app/account/remote/support-sessions.tsx` (the dashboard card). Tests: `src/lib/remote-support/*.test.mjs`,
`route-tests/remote-support.routetest.mts`, and the redeem race in `scripts/appbridge-integration.mts`.

## The flow

1. **The agent asks.** `bc_support_invite { for, task, minutes, task_id? }` (or `POST /api/support/invites`) with
   a full-scope agent key. This creates a *request*, never a code, and returns a one-tap approval link (a
   single-use, 15-minute dashboard sign-in, the view-token pattern Phase A uses). The agent gives the link to its
   person. **No response to an agent ever carries a code.**
2. **The person approves, and the code is minted.** Only on the Remote page (cookie + CSRF), only the owner in v1.
   Approving mints a single-use code `BCS-XXXX-XXXX` (31^8 possibilities, from an alphabet without 0/O/1/I/L) and
   shows it **once**, with its link `https://back-channel.app/support/BCS-XXXX-XXXX`, to the person. Only its
   SHA-256 is stored, so nobody can show it again: not the dashboard, not the agent, not an operator. The person
   sends it themselves.
3. **The helped person opens the link** (or types the code at `/support`). The landing page says who is asking
   (the issuer's account name and handle, as the broker asserts them), for what (the exact task text), for how long,
   shows the scam warning, offers the helper download, and has an **"I didn't ask for this"** button.
4. **The temporary client redeems the code** with a fresh P-256 key and a proof: `POST /api/support/redeem`. In one
   serializable transaction the code is consumed and a support session (a `RemoteAppSession` with `kind:
   "support"`) is created, **pinned to that key**. The client gets only what it needs: the session id, who is
   asking, the task, the cap, and a short-lived credential bound to that key.
5. **Allow.** The client shows the consent screen. Nothing can act until the helped person presses Allow, which the
   client sends signed with its key (`POST /api/support/client/allow`). They have 10 minutes; after that the session
   lapses and nothing happened.
6. **One task, view-first.** While the session runs (at most 45 minutes), every action that changes something needs
   the helped person's OK on their own screen; the client records each step as a fixed phrase. Either side can stop
   it at any time.
7. **Disconnect and removal.** When it ends (finished, stopped, out of time or reported), the relay lease is
   deleted in the same transaction, and the client sends a **signed removal receipt**: removed, ran in memory only,
   or couldn't confirm. Without one, both sides are told "couldn't confirm the helper removed itself", never that it
   worked.
8. **Transcripts.** The issuer sees a plain, metadata-only transcript on the Remote page (and, if the request was
   bound to a Lists task, on the task); the helped person gets theirs from the client as a copyable summary.

## The rules

| Rule | Value |
|---|---|
| Who can issue | the owner only (v1): an account whose verified email is in `ADMIN_EMAILS` (`src/lib/owner.ts`), with Back Channel Remote (`remoteAccessSource`), while `APPBRIDGE_REMOTE_ACCESS` is `on`. Checked when the agent asks, when the person approves, when the code is redeemed and at Allow; the relay gate re-checks the entitlement at every pass, redemption and renewal. |
| Who asks | an agent with a full-scope key; a connector key (claude.ai, ChatGPT) is refused |
| Who mints | the person, cookie + CSRF; any request carrying a bearer key is refused first (`403 people_only`) |
| The task | one plain sentence, at most 300 characters, shown word for word; no links, email addresses or phone numbers (`422 no_contact_details`); nothing code- or secret-shaped (`422 secret_like`); invisible and direction-changing characters stripped |
| `for` | who it's for, in the agent's words (at most 60 characters); shown to the issuer only, never to the helped person |
| Minutes | 1 to 45, never extended |
| A request waits | 60 minutes for the person's answer, then lapses |
| A code works | once, for 15 minutes after it is minted |
| Allow must come | within 10 minutes of redemption |
| Outstanding | at most 3 per account: requests waiting plus codes minted and not used yet (`409 too_many_outstanding`) |
| Codes per day | at most 5 minted per account in any 24 hours (`429 daily_limit`), counted from the database |
| Requests per hour | at most 10 per agent (only one that created a request counts) |
| Running at once | one support session per account (waiting for Allow or running): a second code is told `409 issuer_busy` and is **not** spent |
| Steps per session | at most 500 |

Every mint, deny, cancel (void), redemption, Allow, stop, report and removal receipt writes an `AccountAudit` row
(`support.*`), with ids only: never the code, the credential or the task text.

### States

The request (`SupportInvite`):

| From | To | When |
|---|---|---|
| `requested` | `minted` | the person approved it: the code is minted and shown to them once |
| `requested` | `denied` / `lapsed` / `withdrawn` | the person said no / nobody answered in 60 minutes / the agent withdrew it |
| `minted` | `redeemed` | the temporary client redeemed the code |
| `minted` | `expired` / `voided` / `withdrawn` / `reported` | unused for 15 minutes / the person cancelled it / the agent withdrew it / "I didn't ask for this" on the landing page |
| `redeemed` | `reported` | "I didn't ask for this" in the temporary client |

The session (`RemoteAppSession`, `kind: "support"`):

| From | To | When |
|---|---|---|
| `awaiting_consent` | `active` | the helped person's signed Allow |
| `awaiting_consent` | `denied` / `lapsed` | they pressed Stop instead / nobody pressed Allow in 10 minutes |
| `awaiting_consent`, `active` | `ended` | `done` (the agent finished), `host_stop` (Stop on the helped computer, or the helper left), `user_stop` (the person's Stop on the Remote page), `agent_stop` (the agent ended it without finishing), `lapsed` (the cap), `reported` ("I didn't ask for this") |

`ended`, `denied` and `lapsed` are final. A support session never pauses: the helped person is there and confirms
each action, so a refusal on their screen is recorded and the session goes on.

## Consent and view-first

- **Nothing before Allow.** Before the signed Allow, the client can't record a step (`409 not_allowed_yet`) and
  can't get a relay pass (`403 session_inactive`); the relay gate refuses any support lease. Allow is a signature by
  the pinned key over `bc-support-allow-v1:<sessionId>`; the agent, the person's dashboard and any device credential
  can't send it.
- **Who is asking is the broker's word, not the issuer's.** The consent data is the issuer account's display name
  (else its handle) and its handle, cleaned of invisible characters. Nothing typed for this one code is ever shown as
  "who": `for` is the issuer's private label. (In v1 only the owner can issue. If issuance opens to others, the
  display name must be verified too, or the handle shown alone; see the threat table.)
- **View-first, per action.** A step that changes something (`open`, `invoke`, `set_value`, `toggle`, `select`,
  `scroll`, `key`) can only be recorded as done with `confirmed: true`: the client attests the helped person said
  yes on their own screen. A no is recorded as `declined`. Looking (`observe`) needs no confirmation. The broker
  cannot see the screen, so the real enforcement is in the client (B3); the broker refuses an unconfirmed control
  step (`400 confirm_required`) and records every no.
- **Steps carry no content.** `{ action, target?, outcome, confirmed? }` and nothing else (any other field is
  refused). No `screenshot`: nothing is kept on a machine that removes itself. Outcomes: `ok`, `declined`,
  `credential_field`, `not_in_scope`, `needs_user` (for example a Windows permission prompt, which the person answers
  on the real prompt), `fail_closed`.

## The temporary client's credential and relay admission

**The choice:** the temporary client is **not a device**. Redeeming does not create an `AppBridgeDevice`, so it
never counts against a device cap, never appears in the device list, can't be renewed and has nothing to revoke
later. Instead the support session itself is the client's identity:

- **Key:** the P-256 key that redeemed the code, pinned on the session (`supportKeySha256`, `supportKeySpki`). A
  key is used for one code only (`409 key_in_use`). The same key may redeem the same code again within the code's
  15 minutes (its first reply was lost): it gets a fresh credential and the old one stops working. Any other key gets
  the uniform answer.
- **Credential:** `abs_` + 43 base64url characters, returned once at redemption, stored only as its SHA-256. It
  is resolved only by `remote-support.ts` and `appbridge.ts supportClient()`: an `ab_` device credential, a `bc_`
  agent key or the dashboard cookie is never one, and an `abs_` credential is never accepted where a device's is. It
  expires at redemption + 10 minutes (Allow) + the session's minutes + 60 minutes (for the removal receipt and the
  transcript), fixed and never renewed. Everything that acts (steps, relay passes) also needs the session to be
  running, so in practice it dies with the session.
- **Relay identity:** the session's `hostDeviceId` holds an ephemeral relay identity, `support_` + 22 base64url
  characters, minted at redemption. Device ids are exactly 22 characters, so it can never name a device, and every
  Phase A path that treats `hostDeviceId` as a PC either filters `kind: "agent"` or finds no device by that id.
- **The "support" lease.** `POST /api/appbridge/v1/relay/support-passes {}` with the `abs_` credential returns
  `{ pass, expiresAt, relay }`. The relay redeems it with `purpose: "support"` and the **pinned key's** fingerprint.
  The gate (`appbridge.ts gate()`, still the one authority) re-reads at every pass, redemption and renewal: the
  rollout switch, the issuer's Remote entitlement, and the session (`kind: "support"`, this account, this relay
  identity, allowed, running and in time: `remote-support/rules.mjs admitsSupportLease`). The grant names
  `hostDeviceId` (the relay identity), `hostConnectorSpkiSha256` (the pinned key) and `remoteAppSessionId`; the
  `client*` and `enrollmentId` members are `null`. A lease never outlives its session. Its own budget: at most 2
  live support leases per account (the one session plus a reconnect spare), never counted with or displacing device,
  presence or agent leases; no connection-log row. Every way a session ends deletes its leases in the same
  transaction, so the relay's next renewal is a `404` and the helper is cut off within about a minute.
- Under a redeem flood, a presented key that belongs to a running support session gets through like a registered
  device's.

**Not admitted yet: the other end of the pipe.** The agent's side (an AppBridge component on one of the issuer's
own enrolled devices, connecting to the helper's relay identity as a client) needs the AppBridge Agent runtime
(design chunk A6) and a decision on which of the issuer's devices may connect. The proposed shape: a support
*client* pass for one of the issuer's own enrolled devices, bound to the session and pinned at its first use, gated
by the same support gate. Until it exists, the helper's lease only holds its place at the relay.

## Endpoints

All responses are `no-store`; errors are `{ error, message }`. Bodies are JSON objects, at most 8 KiB.
Serializable conflicts that outlast the retry budget are `503 { error: "busy", retryable: true }` with
`Retry-After: 1`.

### The agent and the dashboard: `/api/support`

| Method and path | Who | Body | Result |
|---|---|---|---|
| `POST /invites` | agent (full key) | `{ for, task, minutes, taskId? }` | `{ support, approvalUrl, approvalUrlExpiresAt, next }`; `support.status` is `requested` |
| `GET /invites` | agent: its own (20); person: the dashboard card | | agent: `{ support: [...] }`; person: `{ available, remoteAccess, limits, pending, codes, live, recent, reports }` (non-owner: `{ available: false, reason: "owner_only" }`) |
| `GET /invites/{id}` | the agent that asked, or the person | | `{ support, steps?, transcript?, next? }` |
| `POST /invites/{id}/end` | the agent that asked | `{ finished? }` | withdraws a request or an unused code; ends a session (`done` when finished, else `agent_stop`); `{ support, transcript?, task, next }` |
| `POST /invites/{id}/approve` | person (owner) | | `{ support, code, url, codeExpiresAt, note }`: **the only response that ever carries the code** |
| `POST /invites/{id}/deny` | person | | `{ support }` |
| `POST /invites/{id}/void` | person | | cancels an unused code: `{ support }` |
| `POST /invites/{id}/stop` | person | | ends the session (`user_stop`), deletes its relay lease; idempotent: `{ support, transcript }` |

`support` (a view) is `{ id, status, statusText, for, task, minutes, requestedBy, listTask, requestedAt,
approvalExpiresAt, codeExpiresAt, redeemedAt, closedAt, reported, session }`, where `session` is `null` or
`{ id, status, statusText, allowBy, startedAt, expiresAt, endedAt, endReason, removal, removalText }`. It never
contains the code or its hash.

### The helped person: no account

| Method and path | Auth | Body | Result |
|---|---|---|---|
| `POST /api/support/redeem` | the code | `{ code, keySpki, proof }` | `{ sessionId, issuer: { name, handle }, task, minutes, allowBy, credential, credentialExpiresAt }`; `409 issuer_busy` (code not spent) |
| `POST /api/support/report` | the code | `{ code }` | the landing page's "I didn't ask for this": the code stops working, a report is filed: `{ reported: true, message }` |
| `GET /api/support/client/session` | `abs_` | | `{ session, steps }` (steps as the helped person's phrases) |
| `POST /api/support/client/allow` | `abs_` + signature | `{ proof }` | `{ session }`; idempotent; `410 too_late` after 10 minutes |
| `POST /api/support/client/stop` | `abs_` | | before Allow: `denied`; after: `ended` (`host_stop`); idempotent |
| `POST /api/support/client/report` | `abs_` | | "I didn't ask for this": ends the session (`reported`), marks the code reported, files a report; idempotent |
| `POST /api/support/client/actions` | `abs_` | `{ action, target?, outcome, confirmed? }` | `{ recorded, step }` |
| `POST /api/support/client/receipt` | `abs_` + signature | `{ removal, proof }` | `removal` is `removed`, `in_memory` or `unconfirmed`; once per session (the same again is a no-op, another is `409`); ends a session still running: `{ removal, transcript }` |
| `GET /api/support/client/transcript` | `abs_` | | `{ transcript: { lines, text } }` |
| `POST /api/appbridge/v1/relay/support-passes` | `abs_` | `{}` | `{ pass, expiresAt, relay }`, see above |

**Uniform answers.** Redeem and report answer every code that can't be used right now (unknown, malformed,
mistyped, used, cancelled, reported, expired) with the same `410 { error: "code_invalid", message }`, and the landing
page shows one message for all of them. A valid code gets other answers only after that check (`issuer_busy`,
`unavailable`), which only a holder of a valid code can see.

**Proofs.** ECDSA P-256 / SHA-256, IEEE P1363 (r‖s, 64 bytes), base64url, the same encoding as AppBridge device
proofs, over:

| When | Message |
|---|---|
| Redeem | `bc-support-redeem-v1:<code>` (the canonical `BCS-XXXX-XXXX`, whatever was typed) |
| Allow | `bc-support-allow-v1:<sessionId>` |
| Removal receipt | `bc-support-receipt-v1:<sessionId>:<removal>` |

**Rate limits** (in memory, one broker instance; `429` with `Retry-After`): 240 reads and 60 writes per minute per
agent, person or helper session; 10 requests per agent per hour; 30 relay passes per helper session per minute.
Redeem, report and the landing page are unauthenticated by nature: only their *failures* spend a global budget of
300 per minute, checked before any database work, like AppBridge's device exchange. Nothing is keyed by or stores an
IP address.

## The landing pages

- `/support/<code>`: server-rendered, `noindex`, `Referrer-Policy: no-referrer` (the code in the address never leaks
  through a link). For a valid code: who is asking, the task (quoted), the minutes, how it works, the scam warning
  ("Only continue if you personally asked <name> for help"), the download, and "I didn't ask for this". Otherwise the
  one uniform message.
- `/support`: a form to type the code; it only navigates to `/support/<code>`.
- **The download.** The helper is not published: it needs a publicly trusted code signature (Azure Trusted
  Signing), which only Skylar can buy. The button reads `SUPPORT_CLIENT_URL` (https only). When that is unset the page
  says honestly that the helper isn't available yet, and links nothing. Set it only to a build signed with the
  publicly trusted identity: never to the pilot-signed builds, whose certificate must never be installed on a
  stranger's machine.

## Transcripts and the removal receipt

The transcript is built only from the session's times, the task text, the fixed step phrases, how it ended and the
removal receipt. Two audiences:

```
Support for Mom, through Back Channel.              Help from Skylar (skylar@bc), through Back Channel.
Task: Get the printer working again.                Task: Get the printer working again.
Connected on 2026-10-10, 14:02 to 14:21 UTC (19 minutes).
Opened Printers & scanners (they allowed it).       Opened Printers & scanners (you allowed it).
Asked to click 'Remove device', and they said no.   Asked to click 'Remove device', and you said no.
Clicked 'Print a test page' (they allowed it).      Clicked 'Print a test page' (you allowed it).
Finished.                                           Finished.
The helper removed itself.                          The helper removed itself.
```

- Removal: "The helper removed itself." / "The helper ran in memory only, so there was nothing to remove." / "The
  helper couldn't confirm it removed itself." / with no receipt once it's over: "Couldn't confirm the helper removed
  itself." (the helped person's version adds how to delete the download).
- The issuer sees it on the Remote page (recent sessions, with Copy) and through `bc_support_status`; the helped
  person through `GET /api/support/client/transcript`.

## Lists

`task_id` binds a request to a Lists task the asking agent has claimed (`409 claim_first` otherwise). Lifecycle
lines are written to it as progress entries (asked, approved, said no, cancelled, opened, allowed, reported,
withdrawn), and the issuer's transcript when the session ends. `bc_support_end` with `finished: true` runs the Lists
**done** path with the transcript as the summary. Never the code. Mirroring is best effort, as in Phase A: a Lists
refusal never undoes the support write, and endings by time alone (a lapse, the cap) are not mirrored.

## MCP tools (full-scope keys only)

In `src/lib/mcp/remote-tools.mjs`, next to the `bc_remote_*` tools and gated the same way: `tools/list` leaves them
out for anything but a full-scope agent key, and a call from a connector key is refused. Dispatched by
`remote-app.ts remoteTool()` to `remote-support.ts supportTool()`.

| Tool | Does |
|---|---|
| `bc_support_invite` | `{ for, task, minutes, task_id? }`, `POST /invites`. "Your person approves it and sends the code; you never see it." |
| `bc_support_status` | `{ support_id }`, `GET /invites/{id}`, with the transcript and `next` |
| `bc_support_end` | `{ support_id, finished? }`, `POST /invites/{id}/end` |

## Threats (design §4)

| # | Threat | Mitigation here |
|---|---|---|
| T2 | Session hijack | The helper's lease is re-gated on every renewal and presented with the key pinned at redemption; its credential is bound to that key (Allow and the receipt are signed by it). Every ending deletes the lease in the same transaction. A rotated credential (same-key re-redeem) ends the old one. |
| T3 | Code interception or forwarding | Single use, 15 minutes, bound to the issuer and the exact task, minted only for the person and shown once, stored hashed; the agent never sees it; pinned to the first key (a second key gets the uniform answer); the consent screen shows the real issuer; "I didn't ask for this" voids it. The page sends no Referer. A code in a request log (the path) is still single-use and short-lived, and whoever redeems it sees the consent screen, not the helped person's machine. |
| T5 | Privilege escalation, UAC | `needs_user` is recorded and the helped person answers the real Windows prompt; the client (B3) can't bypass or auto-accept it. |
| T6 | Persistence | No device enrollment, no `AppBridgeDevice`, a credential that can't be renewed and expires on its own, a relay identity that dies with the session, and a signed removal receipt; an unconfirmed removal is said plainly. |
| T7 | Scam misuse | Owner-only (v1), verified email, Remote subscribers only; at most 3 outstanding, 5 a day, 10 requests an hour, one session at a time; every step audited; the broker-asserted identity on the consent screen (never per-code text, and no links, emails or phone numbers in the task); the scam warning; reports from the page and the helper, shown to the issuer; narrow by default (view-first, 45 minutes, no screenshots); killable from both ends and by the relay-wide `APPBRIDGE_REMOTE_ACCESS` switch. |
| T8 | Standing access creep | One code, one session, one task; never extended or renewed; a stopped session never reopens; the next time needs a new request, approval and code. |
| T1, T9 | Injection, broker compromise | Steps carry no content; tool descriptions say screen content is data, never instructions; the broker stores fixed phrases and hashes only. |

## Privacy

Stored: which agent asked and for which account, `for` (the agent's words, issuer-only), the task text, the minutes,
the code's hash and its times, the helper's public key, its credential's hash, the session's times, each step's kind,
control name (at most 120 characters) and outcome, the removal receipt, and reports (which code, page or helper,
when). Not stored: the code, the credential, anything on the helped person's screen, anything typed, a screenshot,
an IP address or a user agent. Nothing identifies the helped person beyond what the issuer's agent wrote in `for`.
No retention rule yet; a deleted account's rows must be removed by `accountId` by hand (no foreign keys).

## Configuration

| Variable | Meaning |
|---|---|
| `ADMIN_EMAILS` | Who may issue support codes in v1 (the owner gate, `src/lib/owner.ts`). Unset: nobody. |
| `APPBRIDGE_REMOTE_ACCESS` | `on` enables support (and all relay access). Anything else refuses requests, mints, redemptions, Allow and every support lease. |
| `SUPPORT_CLIENT_URL` | The signed helper's download (https). Unset: the landing page says the helper isn't available yet. |

## What is not built

- **The temporary client (design chunk B3, the AppBridge repo, Skylar's).** Portable or in-memory, user-level, no
  service, autostart or machine trust; the consent screen with the broker-asserted identity, the countdown, Allow,
  a persistent Stop and "I didn't ask for this"; view-first confirmation per action; the UAC ask on the real prompt;
  self-removal on every exit path with the signed receipt. It talks to exactly the endpoints above.
- **Code signing and publishing (B0, Skylar's).** A publicly trusted signature (Azure Trusted Signing) is a hard
  blocker: the pilot `LocalMachine\Root` certificate must never reach a stranger's machine. Publishing the build and
  setting `SUPPORT_CLIENT_URL` are Skylar's too.
- **The relay** (backchannel-relay): accepting `purpose: "support"` at redeem, holding the helper at its `support_`
  relay identity, and routing the agent's side to it.
- **The agent's side of the pipe** (see above): needs the AppBridge Agent runtime (A6) and a support client pass.
- **Pricing (B5)**, a retention rule, and opening issuance beyond the owner (which needs verified display names or
  relationships).

## Data

`prisma/migrations/20261010090000_remote_support` creates `SupportInvite` and `SupportReport`, adds seven nullable
support columns to `RemoteAppSession` (with a unique index on the credential hash), and **widens** existing checks:
`RemoteAppSession` (`endReason` + `reported`; `consentVia` + `helper` for support only; an empty app list for support
only), `RemoteAppActionLog.outcome` (+ `declined`), and the `AppBridgePass`/`AppBridgeLease` purpose (+ `support`) and
session binding. `hostDeviceId` stays `NOT NULL` (it holds the relay identity for support). Apply it before deploying
the code; its header has the order, rollback and the production notice.
