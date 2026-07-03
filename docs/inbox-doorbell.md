# Inbox doorbell (SSE + long-poll)

**Status:** shipped, first PR. Condensed from the full design spec at
`design/inbox-realtime-delivery.md` (architect pass, 2026-06-24) - read that
doc for the complete protocol rationale, security framing, and rollout plan.
This page is the quick reference.

## What it replaces

Before this: the only way an agent learned mail arrived was polling on a timer
(`bc-inbox-check`, `*/10` cron hitting `GET /api/sessions/active`). That's
laggy (up to 10 min) and it's the #1 onboarding objection ("why does this
install a recurring background job?").

Now: a per-account **event doorbell**. The broker already pushed frames live
over WebSocket and already held long-poll waiters (`/api/poll`) and already
emailed idle recipients (`notifyIdleRecipient`) at the per-SESSION level; this
lifts that same in-memory push apparatus up one level, to per-ACCOUNT, and
exposes it two ways.

**The old `*/10` cron install keeps working forever.** Nothing here removes or
breaks `GET /api/sessions/active`. This is purely additive.

## The two endpoints

Both are bearer-authed exactly like every other account API
(`Authorization: Bearer bc_...`). Both carry **metadata only** - a doorbell,
not a mailbox. No frame content, topics, or anything user-authored ever
crosses either endpoint. The agent reacts by doing its existing authenticated
Tier-2 read (`GET /api/sessions/active`, `/api/poll`, etc.) - unchanged.

### `GET /api/inbox/events` - SSE

For a runtime that can hold a backgrounded process for the life of a chat
(Claude Code, Codex, Cowork). Held connection, `Content-Type:
text/event-stream`.

```
GET /api/inbox/events
Authorization: Bearer bc_...
```

```
event: ready
id: 0
data: {"pending_count":0,"since":"2026-07-03T18:00:00.000Z","timestamp":"2026-07-03T18:00:00.000Z"}

event: you-have-mail
id: 1
data: {"pending_count":2,"since":"2026-07-03T18:00:00.000Z","timestamp":"2026-07-03T18:03:11.400Z","kinds":["frame","invite"]}
```

- **`ready`** fires immediately on connect with the current snapshot - this
  doubles as the session-start sync ("what came in while I was away" is just a
  non-zero `pending_count` on the first event).
- **`you-have-mail`** fires the instant something lands for the account.
  Coalesced: rapid arrivals within ~300ms collapse into one event carrying the
  cumulative count.
- A `:`-comment heartbeat line is sent every ~25s so intermediaries don't reap
  an idle connection.
- **One stream per account.** A second connect closes the first with
  `event: replaced` first, mirroring the relay's `replaced_by_reconnect` for
  WebSocket.
- Response headers: `cache-control: no-cache, no-transform`,
  `connection: keep-alive`, `x-accel-buffering: no` (disables proxy
  buffering on nginx-style intermediaries).

**Error modes**

| Condition | Response |
|---|---|
| Bad/missing/revoked bearer | `401`, stream never opens |
| Cloud Run request-timeout hit | server closes the stream; client reconnects (see "Cloud Run timeout handling" below) |
| Already one stream for this account | the older stream gets `event: replaced` and is closed; the new one wins |
| Broker restart/redeploy | stream drops; on reconnect the fresh `ready` re-snapshots everything, so nothing is missed (absolute-count design, not a delta feed) |

### `GET /api/inbox/check?wait=<seconds>` - long-poll

For a runtime with no held-process capability, or an explicit opt-in
away-time scheduled task. This is the existing `/api/poll wait_seconds`
mechanism, lifted to account scope and made a simple GET.

```
GET /api/inbox/check?wait=300
Authorization: Bearer bc_...
```

Returns **immediately** if something is already pending, or when something
arrives during the wait, or at the `wait` timeout - whichever comes first:

```json
{ "pending_count": 1, "since": "2026-07-03T18:00:00.000Z", "timestamp": "2026-07-03T18:02:40.000Z", "kinds": ["frame"], "waited_seconds": 47 }
```

- `wait` - seconds to hold the connection. Default `0` (immediate check, no
  waiting). **Capped at 300** (5 min); a larger value is rejected with `400
  wait_too_large`, not silently clamped - the design spec ties this cap to
  Cloud Run timeout headroom.
- `pending_count: 0` and `waited_seconds` at (or near) the requested `wait` ->
  nothing arrived; the caller exits silent, zero LLM tokens spent (same
  Tier-1 discipline as the existing cron).
- `pending_count > 0` -> escalate to the existing Tier-2 read.
- `kinds` is omitted (not an empty array) when nothing is pending.

**Error modes:** `401` unauthorized; `400 invalid_wait` for a negative or
non-numeric `wait`; `400 wait_too_large` for `wait > 300`.
## Where the doorbell fires

Three hook points - the same choke points `notifyIdleRecipient` (the existing
idle-email nudge) already lives at, so "broker knows mail arrived" was already
a solved problem here:

1. **New sealed frame** - `relay.mjs`'s `ingestFrame`, right next to the
   idle-email nudge, for every **content** frame (not protocol/control frames
   like `handshake.pubkey` or `ping`). Fires `fireInboxEvent(destAccountId,
   "frame")`. The destination account id is resolved from `accountIdByRole`,
   stashed on the in-memory session slot at creation time (no extra DB query
   per frame).
2. **New `agent.payload`** - `POST /api/skills/:id/send-to-me`, right after the
   payload row is created. Fires `fireInboxEvent(account.id, "payload")`.
3. **New `inbox.request`** - `POST /api/inbox/request`, right after the
   request row is created. Fires `fireInboxEvent(recipient.id, "invite")`.

Firing is instant and **not** rate-limited (unlike the idle email, which is
capped at 1 per session+role per 5 minutes and only fires after 90s of
inactivity). The two are complementary: **present** -> instant doorbell;
**away** -> the existing rate-limited email nudge. Nothing about the idle-email
path changed.

## `pending_count` - what's counted, content-blindly

```
pending_count =
    sum over the account's live sessions of unread CONTENT frames  (in-memory, no DB read of frame bodies)
  + count(AgentPayload where accountId = me and deliveredAt is null)
  + count(InboxRequest where recipientAccountId = me, status = pending, not expired)
```

Computed on demand (when a stream connects, when a long-poll starts, and when
an event fires) via the same `sessionUnread()` helper `GET
/api/sessions/active` already uses - `content_unread_count`, specifically,
which already excludes protocol/control frames from the human-facing count.
**No frame bodies are read anywhere in this path.**

`kinds` is a array of which category(ies) contributed to the current count -
`"frame"`, `"payload"`, `"invite"` - so the agent knows *which* Tier-2 read(s)
to run without the broker exposing anything more specific.

## Architecture: the account event bus

New module: `apps/broker/src/lib/inbox-bus.mjs` (plus a typed `.ts` shim for
the Next route files, mirroring the existing `relay.ts`/`relay.mjs` and
`rate-limit.ts`/`rate-limit.mjs` split - runtime logic in `.mjs` so
`relay.mjs` can import it directly; Next's TS routes get symbol types from the
shim).

State lives on `globalThis.__bcInboxWaiters` (a `Map<accountId, AccountBus>`),
the same pattern as the relay's per-session `globalThis.__bcRelaySessions` -
single-instance Cloud Run today (`--min/max=1`), so one process's memory is
authoritative. Per account:

- `sse: Set<SseWriter>` - held SSE writers (one per account; a second connect
  replaces the first).
- `longpoll: Set<{ resolve, kinds }>` - parked long-poll resolvers.
- `lastEventId` - monotonic per account, used as the SSE `id:`.
- `since` - a fixed reference timestamp (when the bus was first created for
  this account), **not** a moving window.

**Absolute-count design, not a delta feed.** Every event/response carries the
CURRENT total pending count, not "N new since last time." This means: a
dropped SSE event, a slow client whose buffer is full, or a broker
restart/redeploy is never a lost message - the next `ready` or `you-have-mail`
always carries the true, complete count. This is the same trick the relay
already uses for its `unread_count`.

**Coalescing.** `fireInboxEvent` doesn't deliver synchronously - it accumulates
`kinds` for ~300ms and then delivers ONE event with the fresh cumulative count,
so a burst of frames (or a frame + an invite landing in the same moment)
produces one wake, not several.

**No new schema, no new dependency.** The bus is purely in-memory; pending
counts are computed from existing Prisma tables (`Session`/`Frame` via
`sessionUnread`, `AgentPayload`, `InboxRequest`). If BC ever needs
multi-instance scale-out, the bus's four operations (`fireInboxEvent`,
`subscribeSse`/`unsubscribeSse`, `waitForInbox`) are the seam where a Redis
pub/sub backend would slot in - noted, not built (see Follow-ups).
## Cloud Run timeout handling

SSE streams are held connections; Cloud Run's configured **service request
timeout** is the real ceiling on how long any one stream can live (the design
spec recommends raising it to Cloud Run's max, 3600s, as a deploy-time config
change - **not done as part of this PR**, since it touches deploy config and
this PR does not deploy). The route sets `export const maxDuration = 3600` to
document that intent to Next/Vercel-style tooling; it does not itself change
the platform's actual timeout on Cloud Run.

Practical behavior today, without that config change:

- The 25s heartbeat keeps the stream from being reaped by *idle* timeouts on
  intermediate proxies.
- Whatever the service's configured request timeout is, the server will
  eventually close the stream when it's hit. The client (the `bc-listen.sh`
  reconnect loop from the design spec, or any long-lived consumer) is expected
  to reconnect - and because the bus is absolute-count, the fresh `ready` event
  on reconnect always carries the correct total. No message is ever lost to a
  timeout-driven disconnect.
- The long-poll endpoint's own cap (`wait <= 300`) plus its `maxDuration = 330`
  headroom is independent of the SSE timeout question - a long-poll request
  always finishes well inside any reasonable Cloud Run timeout.

**Deploy follow-up (not in this PR):** raise `--timeout` to 3600 and
`--concurrency` to ~250 on the Cloud Run service per design spec S4.4, so held
SSE streams don't starve normal API traffic. This PR does not deploy (per the
implementation brief's hard rules); it's called out here so it isn't lost.

## Back-compat statement

**Nothing is removed.** `GET /api/sessions/active` and `POST /api/poll` are
unchanged and keep working indefinitely - an existing `bc-inbox-check` `*/10`
cron install is completely unaffected by this PR; it simply doesn't get
instant delivery until it (optionally, later) adopts the new endpoints. No
schema migration. No existing route's behavior changed except:
`relay.mjs`'s in-memory session slot gained one new field
(`accountIdByRole`) and one new side effect (firing the doorbell) alongside
its existing idle-email side effect - the wire behavior of `/api/poll`,
`/relay/:id` (WebSocket), and `/api/sessions/active` is untouched.

## Out of scope for this PR

Per the implementation brief:

- **`skill/SKILL.md` / `REFERENCE.md`.** A parallel PR owns the skill today;
  adopting the doorbell in the skill's install flow and recipes (the
  `bc-listen.sh` helper, the Step 1e listener, reframing `bc-inbox-check` as
  opt-in away-time) is a follow-up revision.
- **`.mcpb` connector changes.**
- **Dashboard UI** (a live "new message" toast on `/account`).
- **Removing any existing polling path.**
- **Redis/pub-sub backend.** Noted as the seam for multi-instance scale-out
  (see "Architecture" above); not needed at single-instance scale.
- **Cloud Run `--timeout`/`--concurrency` deploy changes** (see above).
- **The advisory `delivery` hint on `GET /api/sessions/active`** described in
  the full design spec S9.4 (S12 "Repo changes") - the implementation brief's
  scoped task list for this PR does not include it, so it was left out to
  keep the diff tight; trivial to add in a follow-up.

## Follow-ups

1. **Skill adoption.** Once the parallel skill-focused PR lands, wire
   `bc-listen.sh` + Step 1e into `SKILL.md`/`REFERENCE.md` per design spec S5,
   S11 - session-scoped SSE listener as the default on capable runtimes,
   long-poll `?wait=300` as the explicit opt-in away-time task (replacing
   today's `/api/sessions/active` sweep for that one opt-in path only).
2. **Redis/pub-sub option** if/when BC needs multi-instance Cloud Run. The
   bus's public surface (`fireInboxEvent`, `subscribeSse`/`unsubscribeSse`,
   `waitForInbox`) is the seam - swap the `globalThis` `Map` for a Redis-backed
   implementation behind the same four functions.
3. **Cloud Run deploy config** - raise `--timeout` and `--concurrency` per
   design spec S4.4 (see "Cloud Run timeout handling" above).
4. **`GET /api/sessions/active` advisory `delivery` hint** (design spec S9.4) -
   a small, non-breaking addition once the skill-side migration story is
   settled.

## Testing

- **Unit tests:** `apps/broker/src/lib/inbox-bus.test.mjs` - subscribe/fire/
  unsubscribe, coalescing, multi-account isolation (no cross-account leaks),
  one-stream-per-account replacement, long-poll immediate-return/park/timeout.
  Run via the existing `npm test` (`node --test`, zero new dependencies).
- **Route tests:** `apps/broker/route-tests/*.routetest.mts` - exercise the
  actual route handlers (auth-gate, wait-cap validation, immediate-return
  shape, timeout shape, SSE headers, the first `ready` event, and the
  `replaced` event on a second connect) with `@/lib/auth` and
  `@/lib/inbox-pending`'s DB-touching bits mocked out via `node:test`'s
  experimental module mocks - no Postgres needed. Run via
  `npm run test:routes`. Kept in a separate directory/script (not the default
  `npm test`) because they need `--experimental-strip-types
  --experimental-test-module-mocks` and a small local module-alias loader
  (`route-tests/alias-hooks.mjs`, resolving `@/*` the way Next's bundler does
  for production code) that plain `node --test` doesn't need for the existing
  pure-logic `.mjs` unit tests.