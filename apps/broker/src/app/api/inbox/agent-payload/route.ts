import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { fireInboxEvent } from "@/lib/inbox-bus";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;

// Per-account write cap. Generous for a web clipper dropping pages through a
// session, but bounds a compromised token's ability to grow the DB / spam the
// self-inbox. Keyed on the account, not IP (bearer auth already identifies the
// account, and IP is spoofable behind the GFE for anything but throttling).
const RATE_LIMIT_PER_HOUR = 120;

// A self-drop is a URL + title + selection/excerpt, not a full page dump. 64 KiB
// (matching the relay's per-frame cap) is plenty and keeps one abusive token from
// stuffing megabytes per row × the hourly cap into Postgres.
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Allowlist for THIS generic endpoint. Deliberately the web-drop family only —
// NOT "skill" or "welcome":
//   - "skill" payloads carry share provenance ("<peer> shared <skill> with you")
//     and are only legitimate when a real SkillShare exists; that write stays
//     behind POST /api/skills/:id/send-to-me, which verifies the share. Letting a
//     bearer caller mint a kind:"skill" payload here would let any agent fabricate
//     a "a friend shared this with you" item in its own inbox (a self-spoof that
//     the reading agent narrates — see the Fable review's shared-skill-metadata
//     finding).
//   - "welcome" is broker-authored (onboarding), never client-writable.
// New self-drop kinds get added here explicitly; unknown kinds are rejected.
const SELF_DROP_KINDS = new Set(["web-drop", "web-drop-manifest", "web-drop-result"]);

/**
 * POST /api/inbox/agent-payload — bearer (agent). Generalizes the internal
 * self-inbox write path (previously only reachable via the share-gated
 * /api/skills/:id/send-to-me, hardcoded to kind="skill") into a bearer-authed
 * "post an agent.payload to MY OWN inbox" endpoint, parameterized on
 * `payload_kind`. Backs the Web Clipper self-drop (backchannel-web-clipper
 * INTEGRATION.md §1). Overrides the "v1.x — do NOT build yet" note in
 * docs/inbox-model-pivot.md §6 (approved).
 *
 * Body: { type?: "agent.payload", payload_kind: <allowlisted>, payload: object }
 * Returns: { id, delivered: true, created_at }
 *
 * Security invariants (mirroring the rest of Back Channel, and explicitly the
 * gaps called out in the Fable review):
 *   - AUTHENTICATED: bearer bc_ key only (no cookie path → no CSRF surface, no
 *     ambient-credential CSRF). A bad/missing/revoked key is a 401.
 *   - SELF-ADDRESSED ONLY: the recipient is ALWAYS the authenticated caller's own
 *     account. There is no `to`/recipient/handle field — one is never read from
 *     the body — so this cannot write into another account's inbox (contrast the
 *     arbitrary-account audit-row write the review flagged in /api/favors/log).
 *     Preserves the "no new inbound-spam surface" invariant (inbox-model-pivot §7).
 *   - VALIDATED: `payload_kind` must be in SELF_DROP_KINDS; `payload` must be a
 *     JSON object within MAX_PAYLOAD_BYTES.
 *   - RATE-LIMITED: per-account, RATE_LIMIT_PER_HOUR.
 *
 * NOTE: `payload` holds untrusted clipped web content. The broker stores it
 * opaquely (never interprets it); the CONSUMING agent must treat web-drop
 * content as untrusted data, not instructions.
 */
export async function POST(req: NextRequest) {
  const ctx = await getAuthContext(req.headers.get("authorization"));
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { account, agentTokenId } = ctx;

  const rl = rateLimit("agent-payload", account.id, RATE_LIMIT_PER_HOUR, HOUR);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many self-drops. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: { type?: unknown; payload_kind?: unknown; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Envelope type is optional, but if present it must be the documented one.
  if (body.type !== undefined && body.type !== "agent.payload") {
    return NextResponse.json({ error: "invalid_type", detail: 'type must be "agent.payload"' }, { status: 400 });
  }

  const payloadKind = body.payload_kind;
  if (typeof payloadKind !== "string" || !SELF_DROP_KINDS.has(payloadKind)) {
    return NextResponse.json(
      { error: "invalid_payload_kind", detail: `payload_kind must be one of: ${[...SELF_DROP_KINDS].join(", ")}` },
      { status: 400 },
    );
  }

  // `payload` must be a plain JSON object (not an array, null, or primitive).
  const payload = body.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "malformed_payload", detail: "payload must be a JSON object" }, { status: 400 });
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "payload_too_large", detail: `max ${MAX_PAYLOAD_BYTES} bytes` }, { status: 413 });
  }

  // Self-addressed: accountId is the AUTHENTICATED caller, full stop. Nothing
  // from the request body influences the recipient.
  const row = await prisma.agentPayload.create({
    data: {
      accountId: account.id,
      kind: payloadKind,
      ref: payload as Prisma.InputJsonValue,
      note: null,
    },
  });

  // Metadata-only audit on the caller's OWN account (never a peer's).
  await prisma.accountAudit
    .create({ data: { accountId: account.id, eventType: "agent_payload.self_dropped", detail: { payload_kind: payloadKind, agent_token_id: agentTokenId } } })
    .catch(() => {});

  // Ring the caller's own inbox doorbell so a listening agent picks it up.
  fireInboxEvent(account.id, "payload");

  return NextResponse.json({ id: row.id, delivered: true, created_at: row.createdAt.toISOString() });
}
