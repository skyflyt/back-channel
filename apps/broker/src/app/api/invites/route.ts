import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, generateInviteCode, generateHandle, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { validateScopes } from "@/lib/scopes";
import { sendInviteEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  // Bearer (agent) is the primary path. The dashboard (cookie) may ALSO create
  // an invite — but only as the VISITOR (itself), and CSRF-gated. This widens
  // the cookie tier beyond §3 deliberately, for the dashboard "Start a session"
  // button; a stolen view-link can at worst create rate-limited pending invites
  // (it still can't DRIVE a session — that needs the bearer key).
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const visitor = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!visitor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }

  // Each invite creates an Invite + Session row. Cap per account so a
  // compromised/abusive key can't fill the DB or spam invite codes at a host.
  const rl = rateLimit("invites:account", visitor.id, 10, HOUR);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many invites created. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: { host_handle?: string; host_email?: string; scopes?: string[]; ttl_minutes?: number; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.host_handle && !body.host_email) return NextResponse.json({ error: "host_handle_or_email_required" }, { status: 400 });
  if (!body.scopes || !Array.isArray(body.scopes) || body.scopes.length === 0) {
    return NextResponse.json({ error: "scopes_required" }, { status: 400 });
  }

  const scopeCheck = validateScopes(body.scopes);
  if (!scopeCheck.ok) return NextResponse.json({ error: "invalid_scope", detail: scopeCheck.error }, { status: 400 });

  // Resolve the host. By handle (must exist) OR by email (M1): find-or-create a
  // (possibly pending) account for that email so the invite can be tied to it;
  // the recipient claims it after signing up. We email the recipient either way.
  let host;
  let emailRecipient: string | null = null;
  let recipientNeedsSignup = false;
  if (body.host_email) {
    const email = body.host_email.trim().toLowerCase();
    if (!email.includes("@")) return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    host = await prisma.account.findUnique({ where: { email } });
    if (!host) {
      // Find a free handle, capped at 10 candidates; create defensively (the
      // check→create window can race). Never fall through to an unhandled 500.
      const base = generateHandle(email);
      let handle = base;
      for (let i = 0; i < 10 && (await prisma.account.findUnique({ where: { handle } })); i++) {
        handle = `${base}-${randomBytes(2).toString("hex")}`;
      }
      try {
        host = await prisma.account.create({ data: { email, handle } }); // pending: no apiKey, unverified
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Unique constraint")) {
          // Either a handle race or the email was created concurrently — re-read by email.
          host = await prisma.account.findUnique({ where: { email } });
          if (!host) {
            console.error(`[invites] handle_collision_unresolvable email=${email} base=${base}`);
            return NextResponse.json({ error: "handle_collision_unresolvable", detail: "Couldn't allocate an account handle — please retry." }, { status: 409 });
          }
        } else {
          throw e;
        }
      }
    }
    emailRecipient = email;
    recipientNeedsSignup = !host.emailVerifiedAt; // used internally only — NEVER returned (opaqueness)
  } else {
    host = await prisma.account.findUnique({ where: { handle: body.host_handle } });
    if (!host) return NextResponse.json({ error: "host_not_found" }, { status: 404 });
  }

  // Async-first: the skill asks agents for long TTLs (a recipient may reply hours
  // later). Cap at 24h (was 60m, which silently expired async invites). Sessions
  // still auto-extend on activity; this is just the initial window.
  const ttl = Math.min(Math.max(body.ttl_minutes ?? 60, 5), 1440);
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  // Create invite AND session in one transaction so the visitor can connect
  // to the relay immediately (broker buffers until host claims and joins).
  const { invite, session } = await prisma.$transaction(async (tx) => {
    const inv = await tx.invite.create({
      data: {
        code,
        hostAccountId: host.id,
        visitorAccountId: visitor.id,
        scopes: body.scopes!,
        ttlMinutes: ttl,
        message: body.message,
        expiresAt,
      },
    });
    const ses = await tx.session.create({
      data: {
        inviteId: inv.id,
        scopesGranted: inv.scopes,
      },
    });
    return { invite: inv, session: ses };
  });

  const base = (process.env.PUBLIC_APP_URL ?? "https://back-channel.app").replace(/^https?:/, "wss:");

  // M1: if invited by email, email the recipient. New/pending → a signup-and-
  // claim link (verify + auto-claim in one step); already verified → "ask your
  // assistant to accept BC-XXXX". The branch + delivery are logged server-side
  // for postmortem, but NEVER reflected in the API response (Finding 1:
  // recipient_needs_signup leaked account existence to the inviter).
  if (emailRecipient) {
    const delivered = await sendInviteEmail({
      to: emailRecipient,
      inviterHandle: visitor.handle,
      code: invite.code,
      goal: body.message ?? null,
      needsSignup: recipientNeedsSignup,
    });
    console.log(`[invites] email invite code=${invite.code} needs_signup=${recipientNeedsSignup} delivered=${delivered}`);
  } else if (host.emailVerifiedAt && host.notifyIdleFrames !== false && host.email) {
    // Gap B: invited by HANDLE (an existing account). Don't rely on the recipient
    // happening to run bc-inbox-check — email them the bare fact + code + note, so
    // a silent invite always reaches them. Same "ask your assistant to accept
    // BC-XXXX" email as a verified email-invite; honors the idle-email opt-out.
    // Single-fire per invite (creation happens once), so no extra de-dup needed.
    const delivered = await sendInviteEmail({
      to: host.email,
      inviterHandle: visitor.handle,
      code: invite.code,
      goal: body.message ?? null,
      needsSignup: false,
    });
    console.log(`[invites] handle invite notified host code=${invite.code} delivered=${delivered}`);
  }

  // Audit dashboard-initiated sessions (cookie path) — metadata only.
  if (!bearer) {
    await prisma.accountAudit.create({ data: { accountId: visitor.id, eventType: "dashboard.session_started", detail: { sessionId: session.id } } }).catch(() => {});
  }

  return NextResponse.json({
    code: invite.code,
    invite_id: invite.id,
    session_id: session.id,
    expires_at: invite.expiresAt.toISOString(),
    relay_url: `${base}/relay/${session.id}?role=visitor&token=${session.id}`,
    host_handle: host.handle,
    scopes: invite.scopes,
    // Opaque: uniform regardless of whether the recipient already had a verified
    // account — never leak account-existence to the inviter.
    ...(emailRecipient ? { delivery: "email_sent" } : {}),
  });
}

