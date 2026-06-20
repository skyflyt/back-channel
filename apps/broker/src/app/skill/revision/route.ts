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
