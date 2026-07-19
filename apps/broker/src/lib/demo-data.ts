/**
 * Demo fixture for the logged-in app — DEV ONLY.
 *
 * Local dev has no Postgres/session (see docs/logged-in-redesign.md), so when the
 * account page gets a 401/failure in a non-production build it renders this fixture
 * instead of the signed-out card. That is how the redesign is reviewed locally.
 * Production never uses this: the import is cheap, but the fallback is gated on
 * NODE_ENV !== "production" at the call site.
 */

const minsAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();

export const DEMO_ACCOUNT = {
  me: {
    id: "demo-account",
    handle: "skylar@bc",
    email: "skylar@example.com",
    display_name: "Skylar",
    created_at: minsAgo(60 * 24 * 60),
    email_verified: true,
    api_key_masked: "bc_…k3q7",
    api_key_last_used_at: minsAgo(4),
    notify_idle_frames: true,
    key_mirror_enrolled: false,
    summary: { active_sessions: 3 },
  },
  agents: [
    { id: "demo-ag1", name: "Loby (Cowork)", runtime_type: "cowork", created_at: minsAgo(60 * 24 * 40), last_used_at: minsAgo(4), revoked_at: null },
    { id: "demo-ag2", name: "Claude Code — laptop", runtime_type: "claude_code", created_at: minsAgo(60 * 24 * 12), last_used_at: minsAgo(52), revoked_at: null },
    { id: "demo-ag3", name: "Codex at work", runtime_type: "codex", created_at: minsAgo(60 * 24 * 30), last_used_at: minsAgo(60 * 26), revoked_at: null },
  ],
  active: [
    { session_id: "demo-t1", role: "host", peer_handle: "maren@bc", goal: "Compare notes on Cloud Run cold-start tuning", started_at: minsAgo(130), ended_at: null, end_reason: null, duration_min: null, expires_at: minsAgo(-60 * 24), unread_count: 2, peer_ever_connected: true, peer_present: false },
    { session_id: "demo-t2", role: "visitor", peer_handle: "devon@bc", goal: "Draft the joint grant outline for the tools workshop", started_at: minsAgo(60 * 26), ended_at: null, end_reason: null, duration_min: null, expires_at: minsAgo(-60 * 24), peer_ever_connected: false },
    { session_id: "demo-t3", role: "host", peer_handle: "priya@bc", goal: "Weekly digest swap — agent automation news", started_at: minsAgo(190), ended_at: null, end_reason: null, duration_min: null, expires_at: minsAgo(-60 * 24), peer_ever_connected: true, peer_present: true, live: true },
  ],
  recent: [
    { session_id: "demo-r1", role: "host", peer_handle: "jordan@bc", goal: "Trade CI flake-hunting prompts", started_at: minsAgo(60 * 24 * 3), ended_at: minsAgo(60 * 24 * 3 - 42), end_reason: "completed", duration_min: 42, expires_at: minsAgo(0) },
    { session_id: "demo-r2", role: "visitor", peer_handle: "maren@bc", goal: "Review each other's backup strategy", started_at: minsAgo(60 * 24 * 6), ended_at: minsAgo(60 * 24 * 6 - 18), end_reason: "completed", duration_min: 18, expires_at: minsAgo(0) },
    { session_id: "demo-r3", role: "host", peer_handle: "priya@bc", goal: "Swap reading lists", started_at: minsAgo(60 * 24 * 12), ended_at: minsAgo(60 * 24 * 12 - 9), end_reason: "expired", duration_min: 9, expires_at: minsAgo(0) },
  ],
  trust: [
    { handle: "maren@bc", last_session_at: minsAgo(130), trusted: true, mutual: true, established_at: minsAgo(60 * 24 * 30) },
    { handle: "priya@bc", last_session_at: minsAgo(190), trusted: true, mutual: true, established_at: minsAgo(60 * 24 * 21) },
    { handle: "jordan@bc", last_session_at: minsAgo(60 * 24 * 3), trusted: true, mutual: true, established_at: minsAgo(60 * 24 * 14) },
    // Invite-only friend: the real /api/trust returns last_session_at: null for
    // peers added via invite who have no session yet. Kept null here so the
    // "no sessions yet" empty state is exercised in local review.
    { handle: "devon@bc", last_session_at: null, trusted: true, mutual: false, established_at: null },
  ],
  inbox: [
    { id: "demo-q1", requester_handle: "jordan@bc", scopes: ["config.read", "config.suggest"], message: "Can my agent pull your deploy checklist and suggest tweaks?", created_at: minsAgo(35), expires_at: minsAgo(-60 * 24 * 6) },
  ],
  skills: [
    { id: "demo-s1", name: "Deploy checklist", description: "Pre-flight checks my agent runs before any production deploy.", kind: "template", shared_with: ["maren@bc"], discoverable: true },
    { id: "demo-s2", name: "Standup summarizer", description: "Runs with a friend's agent to merge both sides' notes into one digest.", kind: "rpc", shared_with: [], discoverable: false },
    { id: "demo-s3", name: "Release-notes drafter", description: "Turns merged PR titles into friendly release notes.", kind: "template", shared_with: [], discoverable: true, public_token: "demo-pub", public_expires_at: minsAgo(-60 * 24 * 7) },
    { id: "demo-s4", name: "Inbox triage rules", description: "How my agent sorts incoming Back Channel requests.", kind: "template", shared_with: [], discoverable: false },
  ],
  sharedWithMe: [
    { id: "demo-sw1", owner_handle: "maren@bc", name: "Meeting-prep brief", description: "Builds a one-page brief before any call.", kind: "template" },
    { id: "demo-sw2", owner_handle: "priya@bc", name: "Paper-fetcher", description: "Fetches and summarizes new arXiv papers on a topic.", kind: "rpc" },
  ],
  discover: [
    { id: "demo-d1", owner_handle: "jordan@bc", name: "Changelog watcher", description: "Watches dependencies for breaking changes.", kind: "template" },
    { id: "demo-d2", owner_handle: "priya@bc", name: "Recipe scaler", description: "Scales any recipe and builds a grocery list.", kind: "template" },
    { id: "demo-d3", owner_handle: "maren@bc", name: "Trip splitter", description: "Runs with a friend to settle shared trip expenses.", kind: "rpc" },
  ],
  audit: [] as { type: string; label: string; at: string; detail: Record<string, unknown> }[],
};

export type DemoAccount = typeof DEMO_ACCOUNT;
