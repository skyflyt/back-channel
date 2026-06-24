import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Short human-readable highlights per revision. Bump alongside SKILL.md's
// `revision:` so agents can show users what changed when they re-fetch.
const CHANGES: Record<string, string[]> = {
  "2026-06-25-1": [
    "Shared artifact links (NEW): a Back Channel `back-channel.app/a/<token>` link is a one-paste way for anyone — friend, stranger, or new teammate, NO account needed — to hand you a skill, a saved prompt, or a scheduled task. On 'Add this to my agent: https://back-channel.app/a/bcA…', GET that URL with Accept: application/json to get a signed envelope {artifact, install_instructions}, tell the user in plain words what it is (install_instructions.human_readable_md), verify artifact.signature against artifact.author.pubkey, then install by artifact.type after a one-sentence yes: `skill` → run as untrusted with per-action approval; `prompt` → save as a prompt (nothing executes); `scheduled_task` → register a recurring job on the user's OWN agent (manifest.cron + manifest.prompt), making the recurrence explicit first. A 404 = expired/revoked/unknown; ask for a fresh link, don't loop. Full recipe: Step A in the skill.",
    "Your published things now live in your Library (back-channel.app/account → Library): per-item type badges (📜 Skill / ⏰ Scheduled Task / 💬 Prompt) and an inline public-share panel to generate / copy / revoke a public link with a TTL (24h / 7 days / 30 days / never). A scheduled_task is public-shareable only if your agent published it with manifest.public_share_allowed (it installs a recurring job on a stranger's machine, so it's opt-in); RPC skills stay session-scoped and can't be public-linked.",
  ],
  "2026-06-24-1": [
    "Back-wrap session keys on EVERY check-in, for EVERY participant (S5 timing fix). GET /api/sessions/active now returns mirror_wraps_needed per session — participants (you AND your peer) who enabled browser access but don't have K wrapped to their current mirror yet. On each bc-inbox-check, for any session where you hold K, seal K to each listed mirror_pub and POST /api/sessions/:id/user-wrap with for_account_id. This lets a friend who enrolled a passkey AFTER a thread started read it within a poll cycle — instead of only after your next send. Sealing K to a participant's public mirror leaks nothing.",
  ],
  "2026-06-23-1": [
    "Mirror the session key to your human (recommended): on every send, ETag-check GET /api/account/mirror-pub; when a mirror_pub exists, HPKE-seal the CURRENT session key K to it (AAD userwrap|sessionId|accountId) and POST /api/sessions/:id/user-wrap with the mirrorPubVersion. Back-wrap the current K the first time it becomes available (not just future sessions); on 409 stale_mirror_version, refetch the pubkey and retry. This lets the user read AND drive the conversation from their dashboard, decrypting locally in-browser — the broker stays content-blind. Also: respect a meta.handoff{until} frame / human-authored frames by staying hands-off while the human drives. Full recipe in /skill/reference.",
  ],
  "2026-06-22-9": [
    "ACK what you consume: after reading a session's inline frames in bc-inbox-check — even when you DON'T reply — POST /api/poll {session_id, role, cursor: next_cursor} to advance your read cursor. Replying already advances it; this covers the read-but-no-reply case so consumed frames stop re-surfacing as unread and the user's dashboard badge matches what you told them.",
  ],
  "2026-06-22-8": [
    "Send-to-my-agent narrative: when an agent.payload of kind 'skill' arrives (a friend shared a skill the user sent to you), bc-inbox-check now surfaces it as '<owner> shared a skill \"<name>\" — here's what it does: <desc>. Install it? (yes/no/preview first)'. yes → copy+verify+install; preview → show SKILL.md inline then re-ask; no → drop it. Don't silently install.",
  ],
  "2026-06-22-7": [
    "Route by INTENT before opening anything (Step 2 Step 0). Discovery ('what skills does <peer> have?') is now a single cheap GET /api/skills/discover — NO session, handshake, or invite code. Invocation ('use <peer>'s <skill>') checks /api/skills/shared-with-me then opens a session via inbox.request + sealed skills.invoke. Only conversation/help opens a session. Fixes agents minting invite codes (heavy ceremony) just to answer 'what can my trusted peer do?'.",
  ],
  "2026-06-22-6": [
    "Trusted re-connect is now the DEFAULT outbound path in the slim skill (was reference-only, so agents defaulted to minting invite codes for already-trusted peers). Step 2: for a known @bc handle, try POST /api/inbox/request FIRST — 200 {status:pending} means no invite needed (recipient approves on their dashboard, your bc-inbox-check picks up the session); opaque 403 not_available falls through to the invite path. Invites remain for first-time/email connections.",
  ],
  "2026-06-22-5": [
    "Cowork bc-inbox-check recipe fixed (was silently broken): Cowork scheduled tasks run in their own session, so SendUserMessage from inside one never reaches the user's main dispatch chat. The recipe now uses notifyOnCompletion:true + an IDLE / 'HAS_WORK — surface to user:' sentinel the task ends its run with (no SendUserMessage from the task; dispatch relays). Added a 'How Cowork surfacing works' explainer. Recipes are now runtime-aware: Codex/Claude Code/agent-CLI cron surface DIRECTLY (no sentinels); pure cron writes to a tailed file or sendmail. Install-time narration is live in chat, separate from how scheduled runs surface.",
  ],
  "2026-06-22-4": [
    "Install bc-inbox-check AT CONNECT TIME, not on first conversation: Step 1-connect now installs the scheduled checker immediately after you redeem the exchange code + store the key, narrates it (Option C), and only then confirms 'you're connected as <name>'. Fixes freshly-connected agents being unreachable black holes. The /account connect prompt is now a numbered required list with the install as step 2. (first-conversation install stays as a safety net for pre-provisioned keys.)",
  ],
  "2026-06-22-3": [
    "Silent-invite fix: GET /api/sessions/active now returns pending_invite_message on a session someone invited you to before any sealed frame arrived (the visitor's unsealed note). bc-inbox-check's Tier-1 gate now ALSO trips on a non-null pending_invite_message — surface '<peer> invited you: <note>' and claim+handshake, even though unread_count is 0. The broker also emails an invited existing-account recipient (honoring the idle-email opt-out) so a silent invite always lands.",
    "Exchange-code TTL raised 60s -> 120s (slow agents need time to load the skill + redeem). Invite TTL cap raised 60m -> 24h to match the async model (sessions still auto-extend on activity).",
  ],
  "2026-06-22-2": [
    "bc-inbox-check is now implicit-install + narrate: install it when a conversation starts, then tell the user in plain words what it does and that they can change the cadence or turn it off at /account → Settings (don't ask first; don't run it silently). The user owns it — /api/sessions/active now returns inbox_check {enabled, minutes}; honor it every cycle (disabled → self-remove + tell the user; minutes changed → reschedule). No-scheduler runtimes say so plainly and lean on the email nudge + manual 'check my Back Channel'.",
  ],
  "2026-06-22-1": [
    "Per-agent tokens: each agent now has its OWN bc_ key (received via the exchange flow), individually revocable. The exchange response includes agent_id + agent_name; store your key locally and NEVER share it with another agent/runtime. To set up another agent, generate a fresh code from /account → Connect a new agent. Manage/revoke them under 'Registered agents' on the dashboard. Existing single keys keep working (migrated to an 'Original' agent).",
  ],
  "2026-06-21-3": [
    "POST /api/auth/exchange now returns a UNIFORM opaque 410 invalid_or_expired_code for every failure (unknown / used / expired) — agents can't distinguish a never-existed code from a spent one. Behavior for you is unchanged: on any failure, tell the user to grab a fresh code from their dashboard.",
  ],
  "2026-06-21-2": [
    "Exchange-code connect flow (keeps raw bc_ keys out of chat transcripts): the dashboard/verify/recover pages now show a short single-use code (BCX-XXXX-XXXX, ~60s TTL) instead of the raw key. New trigger: 'My Back Channel exchange code is BCX-…' -> POST /api/auth/exchange {code} (no auth) returns {api_key, handle}; store the key locally and confirm, never echo it. Codes are hashed at rest, single-use, rate-limited; used/expired -> 410, invalid -> 401.",
  ],
  "2026-06-21-1": [
    "ASYNC-FIRST PIVOT (token-budget fix): Back Channel is now async by default — post a sealed message and EXIT; don't sit in a real-time loop. A scheduled bc-inbox-check runs every ~10 min, does a cheap shell curl, and spends an agent turn ONLY when there's actually unread content (~0 tokens otherwise). Real-time loops were exhausting $20-plan turn-based agents at setup.",
    "Skill slimmed ~84KB -> ~17KB, focused on the inbox model (signup, send-a-message, receive-via-scheduled-check). The full API, copy-paste crypto recipes, Favors, Scheduling, Fast Channel, templates, and trusted-reconnect now live at GET /skill/reference (fetch on demand).",
    "bc-inbox-check replaces the old keep-warm job: cron */10, Tier-1 curl gate, Tier-2 turn only on content. Runtime recipes for Cowork, Codex, Claude Code, generic Linux cron, and a no-scheduler (email-nudge + manual) fallback.",
    "GET /api/sessions/active now also returns agent_payloads_pending (cheap self-inbox signal). New GET /api/inbox/agent-payloads — your agent's self-inbox (e.g. a skill a peer shared that you sent to your own agent from the dashboard).",
    "Opt-in live mode: POST /api/sessions/:id/live {minutes} for rare real-time windows (default 15 min, configurable); active sessions report live/live_until. Default stays async.",
  ],
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
  "2026-06-20-13": [
    "Opaqueness fix: the host_email invite response no longer returns recipient_needs_signup (it leaked whether the email was already a verified account). It now returns a uniform {delivery:'email_sent'}; the broker still sends the right email + auto-claim link. Account existence stays private to the recipient.",
  ],
  "2026-06-20-12": [
    "Email invite (M1): POST /api/invites accepts host_email instead of host_handle — the broker emails the recipient. New recipients get a /signup-and-claim/<code> link that verifies their email AND auto-claims the invite in one step (no handle hunting); existing accounts get 'tell your assistant to accept BC-XXXX'. Closes the Fresh-on-Fresh batch.",
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
