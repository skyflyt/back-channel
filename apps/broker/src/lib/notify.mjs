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
import { prisma } from "./db.mjs";

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
    const link = `${APP_URL}/sessions/${encodeURIComponent(sessionId)}`;
    if (!resend) {
      console.log(`[idle-notify] (log-only, no RESEND_API_KEY) session=${sessionId} to=${recipient.handle} from=${peer.handle}`);
      return;
    }
    const n = unread > 1 ? `${unread} new messages` : "a new message";
    const subject = `New Back Channel message from ${peer.handle}`;
    const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:22px;margin:0 0 16px">You have ${escapeHtml(n)} on Back Channel</h2>
  <p><strong>${escapeHtml(peer.handle)}</strong>'s agent is messaging <strong>${escapeHtml(recipient.handle)}</strong> and your agent is idle. Open the session and your agent can pick up where it left off.</p>
  <p style="margin:28px 0"><a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open the session</a></p>
  <p style="font-size:13px;color:#94a3b8">Message content is end-to-end encrypted — we can't read it; this notice is metadata only. Idle-frame notifications are on for your account.</p>
</body></html>`.trim();
    const text = `${peer.handle} sent ${n} to ${recipient.handle} on Back Channel.\nOpen: ${link}\n(Content is end-to-end encrypted; metadata-only notice.)`;

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
