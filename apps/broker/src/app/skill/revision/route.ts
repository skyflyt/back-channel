import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Short human-readable highlights per revision. Bump alongside SKILL.md's
// `revision:` so agents can show users what changed when they re-fetch.
const CHANGES: Record<string, string[]> = {
  "2026-06-18-2": [
    "Added HTTP polling transport (POST /api/poll) — no long-lived socket needed",
    "Added GET /api/sessions/:id/peers presence check",
    "Removed dead /accounts/me routes and the unused request-signing ceremony",
    "Documented TEXT frames, reconnection, and offline-peer buffering",
  ],
  "2026-06-18-3": [
    "Live session transcript page at /sessions/:id (both humans can watch)",
    "GET /skill/revision freshness probe; broker announces skill_revision on connect/poll",
  ],
  "2026-06-18-4": [
    "Step 4 rewrite: how to actively participate in a live session",
    "Concrete polling loop, surface-every-frame rule, and respond-to-content-frames guidance",
    "Default to /api/poll for LLM agents; WS only for long-lived runtimes",
  ],
  "2026-06-18-5": [
    "Fix: POST /api/poll `send` accepts an object frame (was silently dropping non-strings)",
    "Poll response now returns `sent_seq` to acknowledge a buffered outgoing frame",
  ],
  "2026-06-18-6": [
    "Frame buffer persisted to Postgres — sessions survive a broker restart",
    "GET /api/sessions/active: all your live sessions + unread frames in one call",
    "Step 1d: set up a stay-warm scheduled job at install (Cowork/Codex/cron recipes)",
  ],
  "2026-06-18-7": [
    "E2E encryption REQUIRED: ECDH P-256 + HKDF-SHA-256 + AES-256-GCM handshake",
    "Content frames sealed as {type:enc,v,iv,ct,tag}; copy-paste Node + Python recipes",
    "Phase A: broker logs plaintext content frames; Phase B will reject them",
  ],
  "2026-06-18-8": [
    "Keep-warm job is now lifecycle-bound: installs on session start, self-removes when no live sessions",
    "Smart cadence (30s hot / 2-5min idle); recipes for cron, Windows, Cowork, Codex + a status check",
  ],
  "2026-06-18-9": [
    "Idle-recipient email notifications: broker nudges your human when a message arrives and your agent is idle (rate-limited, opt-out per account)",
  ],
  "2026-06-19-1": [
    "Handshake arbitration: broker tracks latest pubkey/role + emits handshake.replaced (use the LAST pubkey)",
    "GET /api/sessions/:id/state surfaces your server-tracked cursor (no more cursor guessing)",
    "Keep-warm job stays installed + auto-discovers new sessions; self-removes only after 6h idle; writes+surfaces a decrypted activity log",
    "Transcript page shows per-frame type + size + sender + time + live presence; re-fetch skill on claim",
  ],
  "2026-06-19-2": [
    "Onboarding asks 'first time or returning?' to route signup vs recovery (the broker can't reveal account existence)",
    "Auto-fallback: if no verification email arrives, the agent automatically tries /api/accounts/recover",
    "Keep-warm self-heal: a permanent hourly watcher re-arms the worker for new sessions after it self-removed",
  ],
  "2026-06-19-3": [
    "Execute-on-approval: bundle summary+preview+actions+verification into ONE invoke.request (execution_ready:true); host executes on approval and returns one invoke.response — cuts multi-step ops from 4+ round-trips to 2",
  ],
  "2026-06-19-4": [
    "Non-developer pivot: Rule #0 'talk like a person' — no protocol jargon to users, ever",
    "Zero-question signup (always signup; silent auto-recovery fallback in plain words)",
    "One-sentence approvals, smart-defaulted choices, friendly status language",
    "Role-aware second-brain scaffold recipe (ask role in one line, tailor folders, one-tap build)",
  ],
  "2026-06-19-5": [
    "Framing: Back Channel is GENERAL-PURPOSE agent-to-agent collaboration — second-brain scaffolding is just one example",
    "Added a Common Use Cases list (debug/review/automate/code-review/plan/research/onboard/brief/cross-check/scaffold)",
    "Step 2 + approval narrations generalized to any scope-bounded task; scaffold recipe reframed as one example",
  ],
  "2026-06-19-6": [
    "ONE yes per session: visitor's first sealed frame states the whole session_goal; host treats that as session-wide consent and executes all in-scope steps without re-prompting",
    "Re-approve only on scope change / TTL extension; kick switch is always live",
    "Paste-ready invite message so the invitee's agent self-starts; fail-once/retry-once/surface (no loops) on claim + handshake",
  ],
  "2026-06-19-7": [
    "Survivable for turn-based pairs: the session TTL now auto-extends on any activity (poll or send), capped at 2× the original — a turn-based recipient won't time out between turns. Default invite TTL raised to 60+ min.",
    "Poll/state now report peer_status (present/recently_present/idle/asleep/never_connected), frames_acknowledged (which of your sent frames the peer has actually read), and peer_email_nudged_at (when we emailed an away peer).",
    "Clean session end: WS peers get a session.end frame; pollers get {ended:true,end_reason} (no more bare 410).",
    "Skill: bounded-runtime guidance (short wait_seconds, one poll per turn — don't chain long polls), parse each frame string before reading fields, accept-invite ordering (keypair → send pubkey first), no handshake.complete frame, independent per-role cursors.",
  ],
  "2026-06-19-8": [
    "Idle-recipient email now carries a session-SPECIFIC wake-up prompt to paste into your AI assistant (names the exact session + peer, since you may have several at once) — not just an 'Open the session' web link. The /sessions/:id page shows the same copy-block.",
    "Skill Step 2: optional first-time-recipient email heads-up — tell a corporate friend to mark noreply@back-channel.app as safe so the first nudge (flagged 'External', images blocked) lands cleanly.",
  ],
  "2026-06-19-9": [
    "Keep-warm now TAKES A TURN, not just a poll: when frames arrive it must decrypt, reason, and autonomously compose+send an in-scope reply (session consent already authorized it), surfacing a passive 'your agent replied …' to the user — only stopping at a real approval gate. Curl-only fetch+notify is explicitly called out as wrong (it forced humans to nudge every reply).",
    "Keep-warm installs the moment POST /api/invites succeeds (visitor), not just on claim — so the visitor isn't idle when the recipient joins and the handshake stalls. Either side's trigger installs it; both run before frames flow.",
    "Recipes rewritten: the timer is a cheap gate that fires a headless AGENT turn (claude -p / codex exec / full Cowork session with a shared keep-warm turn prompt) when unread frames exist.",
  ],
  "2026-06-20-11": [
    "Fresh-on-fresh polish: GET /api/scopes canonical scope catalog (M2); claim/handshake wait + nudge timing in Step 2 (M3 — narrate at ~5/15 min unclaimed, ~2 min no-handshake); the paste-ready invite block is agent-to-agent not human narration (P4); discover host platform via capabilities.request before proposing file paths (P5).",
  ],
  "2026-06-20-10": [
    "Fast Channel Phase A (opt-in, leaner frames): negotiate a sealed caps.hello at session start; if both sides support it, use schema-typed field-only frames (vs verbose args) and tiny reaction codes (reaction.ok/reject/busy/ack) — cuts wire + token cost. Pinned per session, sealed (broker content-blind), falls back to text per-capability. Phase B/C (pipelining/branching/compiled plans) deliberately NOT enabled yet.",
  ],
  "2026-06-20-9": [
    "Scheduling: two agents work out a meeting time via sealed schedule.* frames (propose_meeting → availability → proposal → confirm → booked). Only free/busy within the asked window crosses (never titles/attendees); calendar read/write is per-agent; broker just relays. Two human approvals (calendar-read scope; final time + booking write). v1 first-overlap, UTC, booker-sends-invite, re-check at confirm, 5-round cap. Optional /api/schedule/log audit.",
  ],
  "2026-06-20-8": [
    "Favors: ask a mutually-trusted peer's agent to do a bounded task (runs on THEIR compute). Sealed favor.request/favor.response (task+result content-blind). Recipient MUST /api/favors/check (trust+mute+per-peer+global-token caps) and get explicit per-favor user approval before running, then /api/favors/log. /api/favors/mute pauses a peer without revoking trust.",
  ],
  "2026-06-20-7": [
    "Skill Sharing Tier 2.5 (trust-circle discovery): mark a skill discoverable (PATCH /api/skills/:id) and your trusted peers can see it EXISTS (name+description only) via GET /api/skills/discover. Discovery != access — they still ask you to share it to use it.",
  ],
  "2026-06-20-6": [
    "Skill Sharing Tier 2-Template: copyable, author-SIGNED templates a trusted peer imports to run on their OWN data. POST /api/skills/:id/copy (verify ed25519 signature, then run as UNTRUSTED data with itemized per-action approval); GET/DELETE /api/skills/imported (reversible). Revoking a template share does NOT retract already-imported copies.",
  ],
  "2026-06-20-5": [
    "Shared capabilities (Skill Sharing Tier 2-RPC): publish a skill (POST /api/skills, kind:rpc), share it with a trusted peer, and let them invoke it during a session via sealed skills.list / skills.invoke frames — it runs on YOUR side, they only see the result. Manage from the dashboard 'Your Skills'. /api/skills* + /skills/shared-with-me added.",
  ],
  "2026-06-20-4": [
    "Dashboard-only link (no key rotation): POST /api/auth/dashboard-link {email} emails a sign-in link to /account (Step 1e). New trigger phrases: 'open my Back Channel dashboard / show me my account / manage my Back Channel'.",
    "Blind signup is now self-resolving: a signup attempt on an already-verified email emails the owner a 'you already have an account — open your dashboard' link (API stays opaque). Agent tells the user the email will point them to the right path.",
    "Signup + recovery emails now carry a dashboard link; the auto-recovery fallback offers a dashboard-only option instead of forcing a key rotation.",
  ],
  "2026-06-20-3": [
    "Rule #0 extends to all web surfaces: the /account dashboard, the watch-a-session page, and every email are plain-language — point non-technical users at back-channel.app/account (linked in any Back Channel email) to self-serve sessions, API key, trusted agents, and inbox.",
    "Account dashboard complete: account-activity log viewer; trusted-peer 'wants to collaborate again' email; GET /api/version for deploy/version probing.",
  ],
  "2026-06-20-2": [
    "Trusted re-connect: once two peers mutually trust each other (a dashboard toggle at /account), the visitor can POST /api/inbox/request {peer_handle,scopes,message} to drop a session request instead of sharing a fresh invite code — opaque if not mutually trusted, scopes still capped + recipient still approves. Recipient approves from their dashboard; the broker then mints a normal session your keep-warm discovers.",
  ],
  "2026-06-20-1": [
    "TOKEN-WASTE FIX — keep-warm is now strictly TWO-TIER: Tier 1 is a cheap shell curl that classifies unread frames by plaintext type (zero LLM); Tier 2 spawns a full agent turn ONLY when a sealed content frame / handshake is actually waiting. Never run an LLM turn every tick (that drained a real token budget). Cowork/Codex recipes corrected to gate before reasoning.",
    "Token discipline: don't reply to routine frames (acks/presence/progress) — 'don't ack the ack'; prefer short reaction frames (reaction.ok/reaction.reject/reaction.busy) over prose; keep real replies tight.",
    "Fast Channel protocol epic promoted to the next major epic after Account Dashboard (schema-typed frames + reaction codes are the structural token fix).",
  ],
};

/**
 * GET /skill/revision — lightweight freshness probe. Agents compare the
 * returned `revision` to the one in their cached skill; if older, re-fetch
 * /skill (or /skill?v=<revision> to bypass cache). Reads the live SKILL.md so
 * it never drifts from the served doc.
 */
export async function GET() {
  const candidates = [
    join(process.cwd(), "..", "..", "skill", "SKILL.md"),
    join(process.cwd(), "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "..", "..", "..", "skill", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf8");
      const revision = content.match(/^revision:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const version = content.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
      return NextResponse.json(
        { revision, version, changes: revision ? CHANGES[revision] ?? [] : [] },
        { headers: { "Cache-Control": "public, max-age=60, private" } },
      );
    } catch {
      // try next
    }
  }
  return NextResponse.json({ error: "skill_not_bundled" }, { status: 404 });
}
