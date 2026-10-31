# Web information architecture

The logged-in website (back-channel.app/account and its siblings) since 2026-10-31, product-coherence
Phase 1. The words follow `docs/vocabulary.md`; the design system is `docs/logged-in-redesign.md`.

## Tabs

One list, `apps/broker/src/components/ui/account-nav.ts`, used by `/account`, `/account/remote`, `/admin`
and `/sessions/[id]`. Internal keys do not change (`messages`, `skills`); the labels do.

| Tab | Key | Where | What it holds |
|---|---|---|---|
| Home | `home` | `/account?tab=home` | the greeting and the one-line story; **Approvals**; What's happening (live agent sessions, threads); My plate; the first-run checklist; Your agents; Toolkit; Add a friend |
| Inbox | `messages` | `/account?tab=messages` | **People** on the left (friends, mutual / waiting chips, Invite, a selected friend's page); the thread list and reading pane on the right. On a phone the People column is a toggle above the threads |
| Lists | `lists` | `/account?tab=lists` | unchanged |
| Toolkit | `skills` | `/account?tab=skills` | unchanged |
| Devices | `devices` | `/account/remote` | **Add** (one button: *An agent · A PC · A phone or laptop*), **Agents** (`#agents`: the connected agents, Check status / Reconnect / Rename / Revoke, the connect form with its client picker, connect with a code, the developer-key escape hatch), **PCs**, **Phones and laptops**, Live agent sessions, Secrets on your PCs, Agents on your PCs, Help someone, Plan, Get the apps, Connection attempts |
| Settings | `settings` | `/account?tab=settings` | account, notifications and cadence, passkeys, browser access, developer key, activity |
| Admin | `admin` | `/admin` | owner only (`me.admin`) |

## Aliases

Old `?tab=` values keep working (`resolveTab` in `account-nav.ts`), so bookmarks, emails and the command
palette do not break.

| Old | Lands on |
|---|---|
| `overview`, `account` | Home |
| `messages` | Inbox |
| `friends` | Inbox, with the People column showing |
| `skills` | Toolkit |
| `agents` | `/account/remote#agents` (the Devices page's Agents section; `/account` redirects) |
| `remote` | `/account/remote` |

Other deep links: `?friend=<handle>` opens the Inbox on that person's page; `/account/remote?add=agent|pc|phone`
opens the Add flow on that path (`?add=1` opens the chooser); `#agent-sessions`, `#secrets`,
`#support-sessions` scroll to those cards. Non-production only: `/account?firstrun=1` keeps the first-run
checklist on screen when every step is done.

## The Approvals card

`apps/broker/src/app/account/home-approvals.tsx`. One list of everything waiting on the person, each row with
its action and a way to open it. No new endpoints: it reuses the reads the Inbox, My plate and the Devices
cards already make.

| Row | Source | Action on the row |
|---|---|---|
| Secret | `GET /api/secret-broker` → `requests` with status `open` | Review → Devices › Secrets on your PCs (approving is a passkey prompt against that broker's challenge) |
| PC | `GET /api/remote-app/sessions` → `pending` | Review → Devices › Live agent sessions (approve asks for the passkey; deny is one click there) |
| Help code | `GET /api/support/invites` → `pending` | Review → Devices › Help someone (approving shows the code once) |
| Thread | `GET /api/inbox` → `requests` | Approve / Decline here (the Inbox's own handlers); Open → the request in the Inbox |
| Reply | `GET /api/account/sessions` → `active` where it is your turn | Respond → the thread in the Inbox |
| List | `GET /api/lists/plate` → `ok_requests` | OK for my agents here (`POST /api/lists/tasks/:id/ok`); Open → the task in Lists |
| Check | `GET /api/lists/plate` → `waiting_on_you` | Review → the task in Lists |

The card polls every 15 s while the page is on screen (a secret request lives about 90 s). In demo mode
(non-production, signed out) each source shows one sample row.

## The first-run checklist

`apps/broker/src/app/account/first-run-checklist.tsx`, the five steps of plan §7, each linking to where it is
done: Connect an agent (Devices → Add → An agent) · Give it something to do (make a list, or save a tool) · Add
a friend (Inbox → People → Invite) · Install Back Channel on a PC (Devices → Add → A PC) · Install Back Channel
on your phone (Devices → Add → A phone or laptop). State comes from what Home already loaded (agents, Toolkit,
friends) plus `GET /api/appbridge/v1/account/devices` (PCs and phones by role) and `GET /api/lists`. The card
hides once all five are done.

## Devices → Add

`apps/broker/src/app/account/remote/add-device.tsx`. *An agent* opens the Agents section's connect form (its
client picker). *A PC* and *A phone or laptop* both mint the same kind of code, one without a role
(`POST /api/appbridge/v1/account/device-codes` with no `role`; docs/appbridge-remote-access.md § Two roles): the
app the code is typed into decides whether the device is reached or reaches, so a laptop added as a PC but typed
into the client still works. The choice only picks which where-to-type line is shown (`remote-copy.ts`).
