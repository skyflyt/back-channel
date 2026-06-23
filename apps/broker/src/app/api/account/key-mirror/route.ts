import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

const LIM = { pub: 64, salt: 64, wrap: 512, recovery: 512, hash: 256, cred: 512, label: 80 };
const isStr = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * GET /api/account/key-mirror — cookie (browser). Returns the material the browser
 * needs to unlock: mirror pubkey + version, prf_salt, and the caller's per-method
 * MirrorKeyWrap blobs (docs/user-side-decryption.md §8). recovery_wrap is returned
 * ONLY inside an authenticated recovery flow (?recovery=1, nit §8).
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const wraps = await prisma.mirrorKeyWrap.findMany({
    where: { accountId: account.id },
    select: { id: true, method: true, label: true, credentialId: true, kdfParams: true, wrappedMirrorPriv: true },
    orderBy: { createdAt: "asc" },
  });
  const recoveryFlow = new URL(req.url).searchParams.get("recovery") === "1";

  return NextResponse.json({
    enrolled: !!account.mirrorPub,
    mirror_pub: account.mirrorPub ?? null,
    mirror_pub_version: account.mirrorPubVersion ?? 0,
    prf_salt: account.prfSalt ?? null,
    wraps: wraps.map((w) => ({
      id: w.id, method: w.method, label: w.label, credential_id: w.credentialId,
      kdf_params: w.kdfParams, wrapped_mirror_priv: w.wrappedMirrorPriv,
    })),
    ...(recoveryFlow ? { recovery_wrap: account.recoveryWrap ?? null } : {}),
  });
}

/**
 * POST /api/account/key-mirror — cookie+CSRF (browser). Two modes:
 *  - FIRST ENROLL (no mirrorPub yet): store mirrorPub + prfSalt + recovery, create
 *    the first MirrorKeyWrap.
 *  - APPEND a wrap (same mirrorPub, new device/method): add a MirrorKeyWrap — no
 *    step-up (S8/§4.4).
 * REPLACING mirrorPub (rotation) requires step-up re-auth and is refused here with
 * 409 step_up_required — the broker NEVER silently overwrites an existing mirror
 * (nit §14). (Step-up satisfaction + rotation re-wrap land in the rotation flow,
 * Phase 5; rotation isn't a launch path.)
 *
 * Passphrase enrollment is gated (503) until the KMS pepper is provisioned (path C /
 * B2) — PRF is the launch path.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: {
    mirror_pub?: unknown; prf_salt?: unknown; recovery_wrap?: unknown; recovery_code_hash?: unknown;
    wrap?: { method?: unknown; label?: unknown; credential_id?: unknown; kdf_params?: unknown; wrapped_mirror_priv?: unknown };
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const w = body.wrap;
  if (!w || (w.method !== "prf" && w.method !== "passphrase")) return NextResponse.json({ error: "bad_method" }, { status: 400 });
  if (w.method === "passphrase") {
    return NextResponse.json({ error: "passphrase_unavailable", message: "Passphrase unlock isn't available yet — connect from a device with a passkey (Touch ID / Face ID / Windows Hello) for now." }, { status: 503 });
  }
  if (!isStr(w.wrapped_mirror_priv, LIM.wrap)) return NextResponse.json({ error: "bad_wrap" }, { status: 400 });
  if (w.credential_id != null && !isStr(w.credential_id, LIM.cred)) return NextResponse.json({ error: "bad_credential_id" }, { status: 400 });
  if (w.label != null && !isStr(w.label, LIM.label)) return NextResponse.json({ error: "bad_label" }, { status: 400 });

  // ---- APPEND (already enrolled) ----
  if (account.mirrorPub) {
    if (body.mirror_pub != null && body.mirror_pub !== account.mirrorPub) {
      // Rotation/replace — refuse silent overwrite. Requires step-up (Phase 5).
      return NextResponse.json({ error: "step_up_required", message: "Replacing your key mirror requires re-verifying with an existing passkey." }, { status: 409 });
    }
    await prisma.mirrorKeyWrap.create({ data: {
      accountId: account.id, method: "prf",
      label: (w.label as string) ?? null,
      credentialId: (w.credential_id as string) ?? null,
      kdfParams: undefined,
      wrappedMirrorPriv: w.wrapped_mirror_priv as string,
    } });
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.mirror_device_added", detail: { label: (w.label as string) ?? null } } }).catch(() => {});
    return NextResponse.json({ ok: true, appended: true });
  }

  // ---- FIRST ENROLL ----
  if (!isStr(body.mirror_pub, LIM.pub) || !isStr(body.prf_salt, LIM.salt)) {
    return NextResponse.json({ error: "missing_enroll_fields" }, { status: 400 });
  }
  if (body.recovery_wrap != null && !isStr(body.recovery_wrap, LIM.recovery)) return NextResponse.json({ error: "bad_recovery_wrap" }, { status: 400 });
  if (body.recovery_code_hash != null && !isStr(body.recovery_code_hash, LIM.hash)) return NextResponse.json({ error: "bad_recovery_hash" }, { status: 400 });

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: {
      mirrorPub: body.mirror_pub as string,
      prfSalt: body.prf_salt as string,
      recoveryWrap: (body.recovery_wrap as string) ?? null,
      recoveryCodeHash: (body.recovery_code_hash as string) ?? null,
    } }),
    prisma.mirrorKeyWrap.create({ data: {
      accountId: account.id, method: "prf",
      label: (w.label as string) ?? null,
      credentialId: (w.credential_id as string) ?? null,
      wrappedMirrorPriv: w.wrapped_mirror_priv as string,
    } }),
  ]);
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.mirror_enrolled", detail: { recovery: !!body.recovery_wrap } } }).catch(() => {});
  return NextResponse.json({ ok: true, enrolled: true });
}
