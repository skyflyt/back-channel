/**
 * Back Channel — Email sender.
 *
 * Uses Resend if RESEND_API_KEY is set + valid. If the key is missing OR the
 * send fails (invalid key, rate limit, etc.), logs the link to stdout so it
 * can be retrieved from Cloud Run logs. Useful for initial setup before the
 * Resend account is wired up.
 */

import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM ?? "Back Channel <onboarding@resend.dev>";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";
const PLACEHOLDER_KEY = "PLACEHOLDER_REPLACE_WITH_RESEND_API_KEY";

let _resend: Resend | null = null;
function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key || key === PLACEHOLDER_KEY) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

export interface VerificationEmail {
  to: string;
  handle: string;
  token: string;
}

function logMagicLinkToStdout(args: VerificationEmail, verifyUrl: string, reason: string) {
  console.log(`
─────────── EMAIL FALLBACK (${reason}) ───────────
To:       ${args.to}
Subject:  Verify your Back Channel account
Handle:   ${args.handle}
Link:     ${verifyUrl}
──────────────────────────────────────────────────`);
}

/**
 * Send a magic link verification email. Returns true if sent via provider,
 * false if it had to fall back to log-only.
 */
export async function sendVerificationEmail(args: VerificationEmail): Promise<boolean> {
  const verifyUrl = `${APP_URL}/verify?token=${encodeURIComponent(args.token)}`;
  const resend = client();

  if (!resend) {
    logMagicLinkToStdout(args, verifyUrl, "no RESEND_API_KEY");
    return false;
  }

  const subject = "Verify your Back Channel account";
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:24px;margin:0 0 16px">Verify your Back Channel account</h2>
  <p>Your handle is <strong>${escapeHtml(args.handle)}</strong>. Click the button below to verify your email and get your API key. The link expires in 24 hours.</p>
  <p style="margin:32px 0"><a href="${verifyUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600">Verify and get my API key</a></p>
  <p style="font-size:14px;color:#64748b">Or paste this URL into your browser:<br><code style="word-break:break-all;background:#f5f5f4;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:4px">${verifyUrl}</code></p>
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0">
  <p style="font-size:13px;color:#94a3b8">If you didn't try to sign up for Back Channel, you can ignore this email — no account was created.</p>
</body></html>`.trim();

  const text = `Verify your Back Channel account.\nHandle: ${args.handle}\nLink (expires in 24h): ${verifyUrl}`;

  try {
    const res = await resend.emails.send({ from: FROM, to: [args.to], subject, html, text });
    if (res.error) {
      console.error("Resend error:", res.error);
      logMagicLinkToStdout(args, verifyUrl, `Resend error: ${res.error.name ?? "unknown"}`);
      return false;
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Resend send failed:", msg);
    logMagicLinkToStdout(args, verifyUrl, `Resend exception: ${msg.substring(0, 80)}`);
    return false;
  }
}

/**
 * Send a key-recovery email to a VERIFIED account. Links to /recover?token=...
 * which (on a human click) rotates the API key. Same provider/log-fallback
 * behavior as sendVerificationEmail.
 */
export async function sendRecoveryEmail(args: VerificationEmail & { dashboardUrl?: string }): Promise<boolean> {
  const recoverUrl = `${APP_URL}/recover?token=${encodeURIComponent(args.token)}`;
  const resend = client();

  if (!resend) {
    console.log(`
─────────── EMAIL FALLBACK (no RESEND_API_KEY) ───────────
To:       ${args.to}
Subject:  Recover your Back Channel API key
Handle:   ${args.handle}
Link:     ${recoverUrl}${args.dashboardUrl ? `\nDashboard: ${args.dashboardUrl}` : ""}
──────────────────────────────────────────────────`);
    return false;
  }

  const subject = "Recover your Back Channel API key";
  // Secondary, no-rotate option: just open the dashboard (only when verified).
  const dashBlock = args.dashboardUrl ? `
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:28px 0">
  <p style="font-size:14px;color:#475569"><strong>Don't want to rotate your key?</strong> You don't have to — <a href="${args.dashboardUrl}" style="color:#0f766e">just open your dashboard</a> to manage your account (your key stays the same).</p>` : "";
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:24px;margin:0 0 16px">Recover your Back Channel API key</h2>
  <p>Someone (hopefully you) asked to recover the API key for <strong>${escapeHtml(args.handle)}</strong>. Click below to issue a fresh key. <strong>Your old key will stop working immediately.</strong> The link expires in 24 hours.</p>
  <p style="margin:32px 0"><a href="${recoverUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600">Recover my API key</a></p>
  <p style="font-size:14px;color:#64748b">Or paste this URL into your browser:<br><code style="word-break:break-all;background:#f5f5f4;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:4px">${recoverUrl}</code></p>${dashBlock}
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0">
  <p style="font-size:13px;color:#94a3b8">If you didn't request this, you can ignore this email — your key stays unchanged until the link is used.</p>
</body></html>`.trim();

  const text = `Recover your Back Channel API key.\nHandle: ${args.handle}\nClicking the link issues a new key and invalidates the old one.\nLink (expires in 24h): ${recoverUrl}${args.dashboardUrl ? `\n\nOr, to manage your account WITHOUT rotating your key, open your dashboard: ${args.dashboardUrl}` : ""}`;

  try {
    const res = await resend.emails.send({ from: FROM, to: [args.to], subject, html, text });
    if (res.error) {
      console.error("Resend error (recovery):", res.error);
      return false;
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Resend send failed (recovery):", msg);
    return false;
  }
}

/**
 * Sent when someone tries to SIGN UP with an email that already has a VERIFIED
 * account. The API response stays opaque (never reveals existence to the
 * caller), but the legitimate owner — via their own inbox — learns they're
 * already set up and gets a one-click dashboard link (no key rotation needed),
 * plus a pointer to reset the key if they actually lost it.
 */
export async function sendAlreadyRegisteredEmail(args: { to: string; handle: string; dashboardUrl: string }): Promise<boolean> {
  const resend = client();
  if (!resend) { console.log(`[already-registered] (log-only) to=${args.handle} dash=${args.dashboardUrl}`); return false; }
  const subject = "You already have a Back Channel account";
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:22px;margin:0 0 16px">You're already set up 🎉</h2>
  <p>Someone just tried to start a new Back Channel signup for this email — but <strong>${escapeHtml(args.handle)}</strong> already exists. No need to sign up again. Open your dashboard to see your sessions, trusted agents, and settings:</p>
  <p style="margin:28px 0"><a href="${args.dashboardUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open my dashboard</a></p>
  <p style="font-size:14px;color:#64748b">Lost your API key and need a new one? Reset it at <a href="${APP_URL}/recover" style="color:#0f766e">${APP_URL}/recover</a> — that rotates your key (any agent using the old one will need the new key).</p>
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0">
  <p style="font-size:13px;color:#94a3b8">If this wasn't you, you can ignore this email — nothing changed.</p>
</body></html>`.trim();
  const text = `You already have a Back Channel account (${args.handle}).\nOpen your dashboard (no key change): ${args.dashboardUrl}\nLost your key? Reset it: ${APP_URL}/recover`;
  try {
    const res = await resend.emails.send({ from: FROM, to: [args.to], subject, html, text });
    if (res.error) { console.error("Resend error (already-registered):", res.error); return false; }
    return true;
  } catch (e) { console.error("Resend send failed (already-registered):", e instanceof Error ? e.message : e); return false; }
}

/**
 * Notify a recipient that a trusted peer's agent wants to collaborate again
 * (an inbox request). Lands them on /account (authenticated via view-token) to
 * approve/decline. Metadata only — never the task content.
 */
export async function sendInboxRequestEmail(args: { to: string; recipientHandle: string; requesterHandle: string; vtUrl: string }): Promise<boolean> {
  const resend = client();
  if (!resend) { console.log(`[inbox-email] (log-only) to=${args.recipientHandle} from=${args.requesterHandle}`); return false; }
  const subject = `${args.requesterHandle} wants to collaborate on Back Channel`;
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:22px;margin:0 0 16px">${escapeHtml(args.requesterHandle)} wants to work with your agent again</h2>
  <p>You've trusted each other before, so they can reach you without a new invite code. Open your account to see what they're asking and approve or decline — nothing happens until you say yes.</p>
  <p style="margin:28px 0"><a href="${args.vtUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600">Review the request</a></p>
  <p style="font-size:13px;color:#94a3b8">You're in control — you approve every session, and you can turn off trust anytime from your account.</p>
</body></html>`.trim();
  const text = `${args.requesterHandle} wants to collaborate with your agent on Back Channel.\nReview and approve or decline: ${args.vtUrl}\n(Nothing happens until you approve.)`;
  try {
    const res = await resend.emails.send({ from: FROM, to: [args.to], subject, html, text });
    if (res.error) { console.error("Resend error (inbox-request):", res.error); return false; }
    return true;
  } catch (e) { console.error("Resend send failed (inbox-request):", e instanceof Error ? e.message : e); return false; }
}

/**
 * Notify an account that its API key was rotated from the dashboard. No link —
 * purely a "this happened; if it wasn't you, recover" security notice.
 */
export async function sendKeyRotatedEmail(to: string, handle: string): Promise<boolean> {
  const resend = client();
  if (!resend) { console.log(`[key-rotated] (log-only) to=${handle}`); return false; }
  const subject = "Your Back Channel API key was rotated";
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:22px;margin:0 0 16px">Your API key was rotated</h2>
  <p>The API key for <strong>${escapeHtml(handle)}</strong> was just rotated from your account dashboard. Your previous key has stopped working; any agent using it needs the new one.</p>
  <p style="font-size:14px;color:#64748b">If this was you, you're all set. <strong>If it wasn't</strong>, recover your account at <a href="${APP_URL}/login">${APP_URL}/login</a> to issue a fresh key and lock out the other one.</p>
</body></html>`.trim();
  const text = `Your Back Channel API key for ${handle} was rotated from the dashboard. The old key no longer works. If this wasn't you, sign in at ${APP_URL}/login and rotate again.`;
  try {
    const res = await resend.emails.send({ from: FROM, to: [to], subject, html, text });
    if (res.error) { console.error("Resend error (key-rotated):", res.error); return false; }
    return true;
  } catch (e) { console.error("Resend send failed (key-rotated):", e instanceof Error ? e.message : e); return false; }
}

/**
 * Send an account-dashboard sign-in link. The token is a view-token; the link
 * hits /api/auth/view-verify which sets the browser session cookie and lands
 * the user on /account. Same provider/log-fallback behavior as the others.
 */
export async function sendViewTokenEmail(args: VerificationEmail): Promise<boolean> {
  // Land on the /account page (scanner-safe): the page POSTs view-token-consume.
  const url = `${APP_URL}/account?vt=${encodeURIComponent(args.token)}`;
  const resend = client();

  if (!resend) {
    console.log(`
─────────── EMAIL FALLBACK (no RESEND_API_KEY) ───────────
To:       ${args.to}
Subject:  Sign in to your Back Channel account
Handle:   ${args.handle}
Link:     ${url}
──────────────────────────────────────────────────`);
    return false;
  }

  const subject = "Sign in to your Back Channel account";
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;max-width:560px;margin:40px auto;padding:0 24px;line-height:1.6">
  <h2 style="font-size:24px;margin:0 0 16px">Sign in to Back Channel</h2>
  <p>Click below to open your account — see your sessions, the agents you've trusted, and your API key. The link works once and expires in 15 minutes.</p>
  <p style="margin:32px 0"><a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600">Open my account</a></p>
  <p style="font-size:14px;color:#64748b">Or paste this URL into your browser:<br><code style="word-break:break-all;background:#f5f5f4;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:4px">${url}</code></p>
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0">
  <p style="font-size:13px;color:#94a3b8">If you didn't ask to sign in, you can ignore this email — nothing changes.</p>
</body></html>`.trim();

  const text = `Sign in to your Back Channel account.\nHandle: ${args.handle}\nLink (works once, expires in 15 min): ${url}`;

  try {
    const res = await resend.emails.send({ from: FROM, to: [args.to], subject, html, text });
    if (res.error) {
      console.error("Resend error (view-token):", res.error);
      return false;
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Resend send failed (view-token):", msg);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
