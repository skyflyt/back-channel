# Logged-in app redesign — prototype verdict & design system

**Date:** 2026-07-18/19 · **Branch:** `feat/logged-in-redesign` · **Status:** implemented, preview-only (not merged, not deployed)

## The question

What should the logged-in app (account, admin, sessions) look like as a modern SaaS product — structure, nav model, and information hierarchy, not just colors?

## The prototype

Per the `prototype` skill (UI branch, sub-shape A): three radically different throwaway variants rendered on the real `/account` route behind `?variant=`, with a floating switcher (dev-only). Built at commit `549b7ce`, deleted after the verdict.

- **A — "Operator"**: Linear-style dark command rail; a unified *Triage* queue as home; dense flat lists; ⌘K search affordance.
- **B — "Mission Control"**: Stripe-style white top-nav shell; "Good evening" Overview landing with metric cards, approvals, conversations, agent-fleet panel; card grid.
- **C — "Correspondence"**: full-height split-pane mail app; icon rail → thread list → reading pane with turn-state callout and the encrypted "Unlock & read" affordance.

## The verdict (Skylar, 2026-07-19)

A **combo**, folded in as follows:

| Piece | Source | Where it landed |
|---|---|---|
| Shell + landing | **B** | `AppShell` top-nav (Overview/Inbox/Friends/Toolkit/Agents/Settings) + the Overview dashboard as `/account`'s home |
| Thread reading | **C** | The Inbox tab is a split-pane: thread/approval list + reading pane (turn callout, topic, real in-browser decryption via key-mirror, respond/nudge/end, context rows) |
| Fast nav/search | **A** | `CommandPalette` (Ctrl/⌘-K): navigate, threads, friends, toolkit, actions |

IA changes vs. the old dashboard: bare `/account` now lands on **Overview** (was Inbox); the old "Account" tab dissolved — connect-agent flows moved to **Agents**, API key + activity + sign-out to **Settings** (`?tab=account` deep-links map to Overview). The first-run "simplified nav" shell was dropped; first-run is now an onboarding card on Overview.

## The design system

- `apps/broker/src/components/ui/theme.css` — token layer + shared classes, all `ds-`-prefixed, scoped to logged-in surfaces (marketing pages untouched). Palette: bg `#f6f8fa`, card white on `#e3e8ee` lines, ink `#30313d`, accent **`#635bff`**.
- `apps/broker/src/components/ui/shell.tsx` — `AppShell` (used by `/account`, `/admin`, `/sessions/[id]`).
- `apps/broker/src/components/ui/command-palette.tsx` — `CommandPalette` + `useCommandPalette`.
- `apps/broker/src/components/ui/primitives.tsx` — `MetricCard`, `Chip`, `PersonAvatar`, `EmptyState`, `SkeletonRows`, helpers.
- Sub-components (`composer`, `friend-page`, `keymirror-panel`, `library-editor`) were token-aligned in place.

**Open design question:** the app accent is now B's blurple `#635bff` while the marketing site stays teal `#0f766e`. Deliberate contrast or drift — Skylar to decide before ship.

## Data, auth, demo mode

Real signed-in data is the primary path — all pre-redesign fetching/handlers are unchanged. In **non-production builds only**, an unauthenticated `/account` renders a demo fixture (`src/lib/demo-data.ts`) with actions disabled and a banner, because local dev has no Postgres. Production unauth behavior is unchanged (signed-out card).

## The server.mjs hydration question (critical-path finding)

- **Dev:** `node server.mjs` (custom server) breaks Next 16 dev-mode client hydration app-wide — pages serve, chunks load, no errors, but React never commits; every client page hangs on its SSR state. Verified with a minimal canary (`/account/prototype-smoke/hydration`, kept for regression testing).
- **Prod:** a production build (`next build` + `NODE_ENV=production node server.mjs`) hydrates **correctly** — canary mounts and the account page transitions normally. Verified 2026-07-19 on this branch.
- **Conclusion:** the bug is dev-only; the redesign is shippable under the real runtime. Local dev/preview uses `npm run dev:proto --prefix apps/broker` (plain `next dev`, port 8080). A proper fix of dev-mode-under-server.mjs is tracked separately.
