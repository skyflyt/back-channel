/**
 * Back Channel — Email sender.
 *
 * Uses Resend if RESEND_API_KEY is set. Otherwise logs the magic link to
 * stdout (visible in Cloud Run logs) — useful for dev / initial setup before
 * the Resend account is wired up.
 */

import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM ?? "Back Channel <noreply@back-channel.app>";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";

let _resend: Resend | null = null;
function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

export interface VerificationEmail {
  to: string;
  handle: string;
  token: string;
}

/**
 * Send a magic link verification email. Returns true if sent via provider,
 * false if logged-only (no provider configured).
 */
export async function sendVerificationEmail(args: VerificationEmail): Promise<boolean> {
  const verifyUrl = `${APP_URL}/verify?token=${encodeURIComponent(args.token)}`;
  const resend = client();

  if (!resend) {
    // Dev mode: log to stdout so we can copy the link from Cloud Run logs
    console.log(`
─────────── EMAIL FALLBACK (no RESEND_API_KEY) ───────────
To:       ${args.to}
Subject:  Verify your Back Channel account
Handle:   ${args.handle}
Link:     ${verifyUrl}
──────────────────────────────────────────────────────────`);
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
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend send failed:", e instanceof Error ? e.message : e);
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
