# Epic: Alternative wake-up delivery channels (design — not yet implemented)

**Status:** design only. Do not build until prioritized. Skylar will decide whether to build this after we see how email reputation matures (it may turn out that "mark sender as safe" coaching — see SKILL.md Step 2 — is enough).

## Problem

The wake-up signal for a sleeping, turn-based agent is time-sensitive: *"your agent has a Back Channel message — paste this prompt to continue the session."* Today that signal rides **email only** (Resend → recipient inbox), and corporate email gateways add real friction:

- Outlook/M365 tags first-time external senders **"EXTERNAL — Think Before You Click"** and **blocks images** until the user marks the sender safe. This is *not* an auth failure — SPF, DKIM, and DMARC on `back-channel.app` are all configured and aligned (verified 2026-06-19). It is the recipient tenant's external-sender policy, which fires regardless of perfect auth.
- A JEI exec (the target non-technical user) will reflexively hesitate on a flagged external email, or never see it (junk).
- Email latency + "check your inbox" is a poor fit for a signal that wants action within seconds-to-minutes.

We already mitigate with: (1) a session-specific paste-ready wake-up prompt *inside* the email and on `/sessions/:id` (shipped `2026-06-19-8`), and (2) Step-2 coaching to allowlist `noreply@back-channel.app` (shipped). This epic is the **next** layer: signal paths that bypass the corporate email gateway entirely.

## Principles (carry over from the rest of Back Channel)

1. **Metadata only, never content.** A wake-up signal says *"you have N messages from `peer@bc` in session `<id>` — open it."* It never carries decrypted content; the session stays end-to-end encrypted. Same bar as the idle email today.
2. **Opt-in per channel, per account.** Each delivery channel is something the user explicitly connects (a phone number, a Slack workspace, a browser push subscription). Default off; email stays the always-available baseline.
3. **Same rate-limit / quiet rules as idle email.** At most one nudge per session+role per ~5 min, regardless of channel; don't fan out the same nudge to every channel and triple-buzz the user. Pick the user's preferred channel (fallback order), or let them choose.
4. **The payload is the same paste-ready prompt.** Whatever the channel, deliver the session-specific wake-up prompt (`wakePrompt(sessionId, peerHandle)` in `notify.mjs`) so the user can act in one step.

## Candidate channels

| Channel | Mechanism | Bypasses corp email? | Notes / cost |
|---|---|---|---|
| **SMS** | Twilio (or AWS SNS) → user's verified mobile | Yes | Strong for "time-sensitive nudge"; per-message cost; needs phone verification + opt-in (TCPA/consent). Truncate prompt or send a short link to `/sessions/:id` where the full copy-block lives. |
| **Slack** | Slack app / incoming webhook → DM or channel | Yes (different gateway) | Great for teams already in Slack; the message can include the full paste-block as a code snippet + an "Open session" button. Per-workspace OAuth install. |
| **Microsoft Teams** | Teams incoming webhook / bot | Yes | Most relevant for JEI (M365 shops). An Adaptive Card with the prompt + button. Bot registration in the tenant. |
| **Browser push (Web Push / VAPID)** | Service worker + push subscription | Yes | No per-message cost; works only when the user has the `/sessions` page (or a PWA) registered and granted notification permission. Already noted as future in README. |
| **Telephone / voice** | Twilio voice call | Yes | Probably overkill; listed for completeness for truly urgent escalation. |

## Sketch of the architecture (when built)

- **`NotificationChannel` model** (Postgres): `{ id, accountId, kind: "sms"|"slack"|"teams"|"webpush", target (phone / webhook URL / push subscription JSON), verifiedAt, enabled, priority }`. One account can have several; `priority` sets fallback order.
- **Dispatch fan-in:** `notify.mjs` already centralizes the idle nudge. Add a `dispatchWakeup(sessionId, destRole, unread)` that builds the prompt once, then routes to the recipient's highest-priority enabled channel (email is the implicit lowest-priority always-on channel). The existing relay-side idle + rate-limit gate stays the single chokepoint — channels are just the egress.
- **Per-channel adapters:** `channels/sms.mjs`, `channels/slack.mjs`, etc., each `async send(target, { subject, prompt, link })`. Keep them runtime-JS like `notify.mjs` so the relay can import them.
- **Verification flows:** SMS needs a code round-trip; Slack/Teams need OAuth/app install; web push needs the subscription handshake. All belong behind the authed account API + a `/settings` UI (also currently future).
- **Skill:** when a channel is connected, the keep-warm/idle story is unchanged — these are purely the human-nudge egress. Document in Step 1d that the human can connect SMS/Slack/Teams for faster nudges than email.

## Decisions (resolved 2026-06-20 — Loby's calls, Skylar pre-authorized)

1. **First channel — Microsoft Teams.** Prototype Teams first (the JEI/M365 rollout is the live use case; an Adaptive Card carries the full wake-prompt + an Open button). SMS second (most universal), web push later (cheapest but needs a registered PWA). *Rationale:* build for the actual users we have; measure before adding more.
2. **Consent + compliance — explicit opt-in + STOP per channel.** SMS especially: store explicit consent and honor a STOP path (TCPA). Each channel is opt-in, default off. *Rationale:* non-negotiable for SMS; good hygiene for all.
3. **Payload — SMS = short line + link to `/sessions/:id`; Slack/Teams = full prompt.** Length-limited channels send a teaser + the dashboard link (which shows the full copy-block); rich channels carry the whole paste-ready prompt. *Rationale:* fit the medium.
4. **Routing — single preferred channel + email fallback (no fan-out).** Deliver to the user's highest-priority enabled channel; email is the always-on fallback. Never notify all channels for one nudge. *Rationale:* respects the "don't triple-buzz" rule + the shipped rate-limit policy.
5. **Reputation gate — may stay unbuilt.** If allowlisting + warmed sending reputation makes email land cleanly for corporate recipients, this epic stays parked. Revisit after a few weeks of real JEI usage. *Rationale:* don't build delivery infra we may not need; let real deliverability data decide.

## Relationship to existing work

- Builds directly on the shipped idle-email path (`notify.mjs` → `notifyIdleRecipient`) and the `wakePrompt()` helper; channels are additive egress, not a rewrite.
- Shares the `/settings` opt-out UI and the web-push (VAPID) line already noted as future in the README roadmap.
- Independent of the trust + inbox feature (now part of `docs/account-dashboard-epic.md`), though a trusted-peer inbox request would use the same wake-up dispatch.

---

## Decision log (2026-06-20)

| # | Decision | Source |
|---|---|---|
| 1 | First channel = Microsoft Teams (then SMS, then web push) | Loby's call |
| 2 | Per-channel explicit opt-in + STOP (TCPA for SMS) | recommendation |
| 3 | SMS = short + link; Slack/Teams = full prompt | recommendation |
| 4 | Single preferred channel + email fallback; no fan-out | recommendation |
| 5 | May stay unbuilt if email reputation matures | recommendation |

**Build-readiness:** decisions resolved, but this epic is **gated on a real need** — only build if email deliverability to corporate inboxes stays poor after allowlisting + reputation warm-up. Lowest priority of the shelf.
