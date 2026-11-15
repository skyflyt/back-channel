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
| Toolkit | `skills` | `/account?tab=skills` | **Yours**, Shared with you, From your friends. Once there are more than three items, one search (name, description, who shared it; every word must match) and type chips (Tools, Scheduled checks, Saved prompts, Links, only those present) narrow all three lists. Each of yours is a compact row: name, type, two lines of description, one line saying who can see it, and View / Edit / Delete. Sharing with a friend, being findable by name and the public link sit behind a **Share** disclosure on the row; it stays open while a link warning is showing |
| Devices | `devices` | `/account/remote` | **Add** (one button: *An agent · A PC · A phone or laptop*), **Agents** (`#agents`: the connected agents, Check status / Reconnect / Rename / Revoke, the connect form with its client picker, connect with a code, the developer-key escape hatch), **PCs**, **Phones and laptops**, Live agent sessions, Secrets on your PCs, Agents on your PCs, Help someone, Plan, Get the apps, Connection attempts. A jump list under the heading links to each card **that actually rendered** (several hide themselves: no billing, support unavailable, signed out) |
| Settings | `settings` | `/account?tab=settings` | six sections, one at a time (§ Settings below): Account, Notifications, Agents & Inbox, Security, Developer, Activity |
| Admin | `admin` | `/admin` | owner only (`me.admin`) |

## The shell

`apps/broker/src/components/ui/shell.tsx`, the same on every signed-in page (`/account`, `/account/remote`,
`/admin`, `/sessions/[id]`). What a page gets without asking:

- **One "waiting on you" number.** The Approvals total badges the **Home** tab and prefixes the browser tab's
  title (`(6) Back Channel`), so something waiting is visible from any page and from a background tab. `/account`
  computes it from what Home already loaded (`waitingTotal`); every other page reads the same sources through
  `useAccountChrome()` (`components/ui/use-account-chrome.ts`), polling every 30 s while visible. The Inbox tab's
  own badge stays the Inbox subset (thread requests and replies), and Home's metric reads "Waiting on you: N
  in the Inbox · M elsewhere".
- **The avatar menu**: who you're signed in as, Settings, Devices, Keyboard shortcuts, Help & FAQ, Commands for
  your agent, Sign out. The avatar shows the person's initials on every page (it was "?" on Devices and "→" on a
  transcript).
- **Search everywhere** (Ctrl K or `/`): every page offers Go to, Actions (connect an agent, add a PC or phone,
  see what's waiting), every Settings section and setting (`SETTINGS_TARGETS`), every Devices card
  (`DEVICES_SECTIONS`) and Help, from `basePaletteItems()` in `account-nav.ts`. A page layers its own items on
  top (threads, friends, tools); an item with the same id replaces the base one, which is how `/account` opens
  tabs and Settings in place instead of reloading. Matching is per word, in any order, and also searches hidden
  keywords, so "rotate key" finds Developer key and "daily" finds the custom check interval.
- **Keyboard**: `g` then `h i l t d s` goes to Home, Inbox, Lists, Toolkit, Devices, Settings; `?` shows the
  list. Single-key shortcuts are off while typing in a field.
- **Phone widths** (≤600 px): the tabs get their own row under the brand, so all six fit at 375 px instead of
  scrolling behind a hidden scrollbar (the owner's seventh tab, Admin, still scrolls). Nothing else about the
  mobile layout changed.
- **Signed out** (a signed-out card, a transcript opened with a pasted key): the brand and a Sign in link only;
  no tabs, search, avatar menu or shortcuts.

## Settings

One section at a time from a side list (chips on a phone), so the page is short and each section says what it
is for. **The usual settings are up front; each section's deeper controls sit behind one "Advanced"
disclosure**, which this browser remembers per section (`localStorage` `bc.settings.advanced`). Nothing is more
than one click from the default view, and nothing advanced is in the way of someone who never opens it.

| Section | Up front | Advanced |
|---|---|---|
| Account | name, handle, email (verified?), member since; Plan and billing; Sign out | |
| Notifications | email me when something lands and my agent is asleep | |
| Agents & Inbox | scheduled Inbox checks on/off and how often (5 min to 1 h); how long a live thread stays live | an exact check interval, 5–60 min; an exact live length, 1–120 min; **limits on friends' requests** (per friend per day 0–1,000, tokens per day 0–100,000,000; 0 turns requests off; these were read-only before) |
| Security | passkeys; read threads in this browser | |
| Developer | the MCP endpoint, skill and reference URLs with Copy | the developer key and Rotate |
| Activity | the account's activity log, loaded on arrival | |

The ranges are what the consumers honor: `/api/sessions/[id]/live` caps the live length at 120 and
`/api/favors/check` enforces both limits. **The check interval stops at 60 minutes on purpose.** The route
accepts up to 1440, but agents schedule the check as `*/N` cron or `schtasks /sc minute /mo N` (skill
`SKILL.md` and `REFERENCE.md` § cadence), and neither recipe handles N over 59 correctly, so a longer value
would be saved and not honored. Offering hours and once-a-day needs a skill revision that says how to schedule
them first. `route-tests/account-settings` pins the route's clamps. Every save says "Saved" next to the control, or that it didn't save and the old value is back.

Deep links: `?tab=settings&section=<section>` or `<target>`, where a target opens its section, opens Advanced if
it lives there, scrolls to the control and flashes it: `sign-out`, `email-alerts`, `inbox-check`, `live-mode`,
`custom-cadence`, `friend-limits`, `passkeys`, `browser-access`, `developer-key`, `endpoints`, `activity`. The
URL then shows the section key.

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
opens the Add flow on that path (`?add=1` opens the chooser); `#add`, `#agents`, `#pcs`, `#phones`,
`#agent-sessions`, `#secrets`, `#agents-on-pcs`, `#support-sessions`, `#plan`, `#get-apps`, `#connections`
scroll to those cards; `?tab=settings&section=…` opens Settings (§ Settings). Non-production only: `/account?firstrun=1` keeps the first-run
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
