/**
 * Back Channel — idle-recipient notifications (runtime JS so relay.mjs can
 * import it; relay runs outside Next's bundler and can't import email.ts).
 *
 * When a content frame is buffered for a participant whose agent has been idle,
 * we email their verified address a metadata-only nudge ("you have a message;
 * open the session"). Content is end-to-end encrypted — this never contains it.
 * Rate-limiting + the idle check live in the relay (cheap, in-memory); this
 * module does the DB lookup + send only when the relay decides to fire.
 */

import { Resend } from "resend";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./db.mjs";

// Token helpers (kept in sync with auth.ts — runtime JS can't import the .ts).
const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");
const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Mint a single-use dashboard view-token for an account; store only its hash,
 *  return the raw for the email link. Lets the idle email land authenticated. */
async function mintViewToken(accountId, sessionId) {
  const raw = "vt_" + randomBytes(32).toString("base64url");
  try {
    await prisma.viewToken.create({
      data: { token: hashToken(raw), accountId, purpose: `session:${sessionId}`, expiresAt: new Date(Date.now() + VIEW_TOKEN_TTL_MS) },
    });
    return raw;
  } catch { return null; }
}

const FROM = process.env.EMAIL_FROM ?? "Back Channel <onboarding@resend.dev>";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";
const PLACEHOLDER_KEY = "PLACEHOLDER_REPLACE_WITH_RESEND_API_KEY";

/** @type {Resend | null} */
let _resend = null;
function client() {
  const key = process.env.RESEND_API_KEY;
  if (!key || key === PLACEHOLDER_KEY) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The actual wake-up mechanism for a sleeping turn-based agent: a session-
 * SPECIFIC prompt the human pastes into their agent's chat. A user may hold
 * several concurrent sessions with different peers, so this names the exact
 * session + peer. Runtime-agnostic: any LLM agent that has loaded the Back
 * Channel skill can act on it with no extra context. Kept in sync with the
 * copy-block on /sessions/:id (see that page's wakePrompt()).
 * @param {string} sessionId
 * @param {string} peerHandle
 */
export function wakePrompt(sessionId, peerHandle) {
  return `Check my Back Channel inbox — I have unread messages from ${peerHandle} in Back Channel session ${sessionId}. Using the Back Channel skill you've already loaded: call GET /api/sessions/${sessionId}/state for the current cursor, poll /api/poll for this session, decrypt any sealed frames with the per-session key already in your local Back Channel state, show me what's there in plain language, and continue the session.`;
}

/**
 * Canonical paste prompts for a dashboard-started session (one source of truth,
 * shared by GET /api/sessions/:id/prompts). `your_prompt` goes to the starter's
 * OWN agent (the visitor/helper side); `friend_prompt` is texted to the friend
 * for THEIR agent (the host side) — same shape as Step 2's paste-ready block.
 * @param {{ inviterHandle: string, friendLabel: string|null, sessionId: string, code: string, scopes: string[], expiresAt: Date, topic: string|null }} a
 */
export function sessionStartPrompts(a) {
  const who = a.friendLabel ? a.friendLabel : "a friend";
  const topic = a.topic ? a.topic : "something";
  const exp = a.expiresAt.toISOString();
  const your_prompt =
    `I just started a Back Channel session from my dashboard to help ${who} with ${topic} (session ${a.sessionId}). Using the Back Channel skill you've loaded, this is the VISITOR side and the session already exists — connect as visitor with my stored Back Channel API key, do the ECDH handshake when the host joins, then send a sealed invoke.request whose session_goal is "${topic}". Poll /api/poll for this session and drive it per the skill; surface progress to me in plain language.`;
  const friend_prompt =
    `${a.inviterHandle} wants to help you with ${topic} via Back Channel. Load the skill from https://back-channel.app/skill (re-fetch if your copy is stale), then accept invite ${a.code} (expires ${exp}; scopes: ${a.scopes.join(", ")}). Using the skill, this is the HOST side — accept, complete the handshake, surface the first sealed frame's session goal to me, and ask me one plain yes/no before anything runs.`;
  return { your_prompt, friend_prompt };
}

/**
 * Canonical "connect a new agent" bootstrap prompt — ONE source of truth shared
 * by the dashboard "Connect an agent" reveal, the verify-success page, and the
 * recover-success page. A human pastes this whole block into any AI assistant
 * (Claude Code, Codex, ChatGPT, a new device…) and that agent becomes fully
 * Back-Channel-capable with their account. Contains the FULL API key by design
 * (the caller already owns it). Plain language — Rule #0.
 * @param {string} apiKey  the account's raw bc_ API key
 */
export function bootstrapPrompt(apiKey) {
  return `Load the Back Channel skill from ${APP_URL}/skill (re-fetch it if you have a cached copy).

My Back Channel API key is: ${apiKey}

Store that key locally and use it to help me with Back Channel — like starting a session with a friend, accepting an invite someone sent me, opening my dashboard, or rotating my key. Follow the skill exactly for any of those.`;
}

/**
 * Canonical paste prompt for the EXCHANGE-CODE connect flow (the secure default
 * — keeps the raw bc_ key out of chat). The user pastes ONLY this; the agent
 * trades the code for the real key via POST /api/auth/exchange, stores it
 * locally, and confirms. Shared by the dashboard, verify/recover pages.
 * @param {string} code  a BCX-XXXX-XXXX exchange code
 */
export function exchangePastePrompt(code) {
  return `Connect me to Back Channel. Load the skill from ${APP_URL}/skill (re-fetch if your copy is stale), then redeem this one-time exchange code for my API key: ${code}

Do this: POST ${APP_URL}/api/auth/exchange with {"code":"${code}"} (no auth header), store the returned api_key locally as my Back Channel credential, and tell me "you're connected" — don't print the key back to me. The code expires in 60 seconds, so do it now.`;
}

/**
 * Look up the idle recipient + peer for a session, honor their opt-out, and
 * email a nudge. Best-effort: logs and returns on any miss. Never throws into
 * the relay path.
 * @param {string} sessionId
 * @param {"visitor"|"host"} destRole  the role the frame is addressed to (the idle one)
 * @param {number} unread
 */
export async function notifyIdleRecipient(sessionId, destRole, unread) {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { invite: { include: { host: true, visitor: true } } },
    });
    if (!session || session.endedAt) return;
    const recipient = destRole === "visitor" ? session.invite.visitor : session.invite.host;
    const peer = destRole === "visitor" ? session.invite.host : session.invite.visitor;
    if (!recipient?.email || !recipient.emailVerifiedAt) return; // can't/shouldn't email
    if (recipient.notifyIdleFrames === false) return;            // opted out

    const resend = client();
    // Mint a view-token so the button lands the human AUTHENTICATED on their
    // dashboard (no API-key paste), deep-linked to this session. Falls back to
    // the plain dashboard link if minting fails.
    const vt = await mintViewToken(recipient.id, sessionId);
    const link = vt
      ? `${APP_URL}/account?vt=${encodeURIComponent(vt)}&session=${encodeURIComponent(sessionId)}`
      : `${APP_URL}/account`;
    if (!resend) {
      console.log(`[idle-notify] (log-only, no RESEND_API_KEY) session=${sessionId} to=${recipient.handle} from=${peer.handle}`);
      return;
    }
    const n = unread > 1 ? `${unread} new messages` : "a new message";
    const subject = `New Back Channel message from ${peer.handle}`;
    const prompt = wakePrompt(sessionId, peer.handle);
    const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:22px;margin:0 0 16px">You have ${escapeHtml(n)} on Back Channel</h2>
  <p><strong>${escapeHtml(peer.handle)}</strong>'s agent is messaging <strong>${escapeHtml(recipient.handle)}</strong> and your agent is idle. Wake your agent so it can pick up where it left off — two ways:</p>
  <p style="margin:24px 0 16px"><a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open my dashboard</a></p>
  <p style="margin:24px 0 8px;font-weight:600">💬 Or paste this to your AI assistant to wake it up:</p>
  <pre style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f172a">${escapeHtml(prompt)}</pre>
  <p style="font-size:13px;color:#94a3b8;margin-top:20px">Message content is end-to-end encrypted — we can't read it; this notice is metadata only. Idle-frame notifications are on for your account.</p>
</body></html>`.trim();
    const text = `${peer.handle} sent ${n} to ${recipient.handle} on Back Channel.\n\nOpen your dashboard: ${link}\n\nOr paste this to your AI assistant to wake it up:\n${prompt}\n\n(Content is end-to-end encrypted; metadata-only notice.)`;

    const res = await resend.emails.send({ from: FROM, to: [recipient.email], subject, html, text });
    if (res.error) {
      console.error(`[idle-notify] Resend error session=${sessionId}:`, res.error?.name ?? res.error);
      return;
    }
    console.log(`[idle-notify] sent session=${sessionId} to=${recipient.handle} from=${peer.handle} unread=${unread} provider=resend`);
  } catch (e) {
    console.error(`[idle-notify] failed session=${sessionId}:`, e instanceof Error ? e.message : e);
  }
}
