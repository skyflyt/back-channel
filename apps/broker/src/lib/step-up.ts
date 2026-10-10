/**
 * The approval step-up: a passkey (WebAuthn: Windows Hello, a phone, a security key) just before a person's most
 * consequential dashboard actions. Vault design agent-desktop-scope.md, "Security decisions after the build" (Skylar,
 * 2026-10-10); docs/remote-app-sessions.md, "Approvals need a passkey".
 *
 * Why: agents may drive the whole PC, and that PC's signed-in browser can reach back-channel.app. Cookie + CSRF stop a
 * tool or a confused agent, not an agent clicking the page itself. A passkey prompt is a credential prompt (on the PC's
 * off-limits list), and a phone passkey needs the phone, so an agent can't complete one.
 *
 * Gated actions (each grant is for exactly one of them, and one target):
 *   approve_session   approving an agent remote-app session (src/lib/remote-app.ts opApprove); target: the session id
 *   approve_support   approving a support request, which mints and shows the BCS code (src/lib/remote-support.ts)
 *   connect_agent     minting a new agent credential from the dashboard: a connect code (/api/auth/exchange-code), an
 *                     agent token (POST /api/account/agents), a rotated key (/api/account/key/rotate) or the setup
 *                     prompt with a key (/api/account/bootstrap-prompt); no target
 *   manage_passkeys   adding a passkey when the account already has one, or removing one; no target
 * Denying, stopping and cancelling are never gated: refusing stays one click. Agent (bearer) routes are unchanged.
 *
 * The grant: POST /api/account/passkeys/step-up/verify (src/lib/passkeys.ts) answers a verified ceremony with a random
 * value; the browser sends it back once, in the x-bc-step-up header, on the action it was for. Only its sha256 is kept,
 * on the ceremony's own PasskeyChallenge row, which already names the account, the action and the target. It lives at
 * most 2 minutes and is spent by one atomic update, so it can't be replayed, reused, or carried to another action or
 * another session.
 *
 * APPROVAL_STEP_UP (default "on"): "off" skips every check here, an EMERGENCY switch only (say WebAuthn breaks for
 * everyone). Passkeys can still be added and removed, and step-ups still verify; nothing requires one.
 *
 * MCP route safety: remote-app.ts (loaded by the MCP route) imports this file, so it imports nothing but node:crypto and
 * Prisma's types: no @/lib/auth (route tests replace it with a few named exports) and no WebAuthn library.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const STEP_UP_HEADER = "x-bc-step-up";
export const STEP_UP_ACTIONS = ["approve_session", "approve_support", "connect_agent", "manage_passkeys"] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
/** A ceremony (the WebAuthn prompt) may take this long; the browser's own timeout is 60 seconds. */
export const CEREMONY_TTL_MS = 5 * 60_000;
/** A verified step-up's grant: at most 2 minutes, then it's gone. */
export const GRANT_TTL_MS = 2 * 60_000;

const GRANT_PREFIX = "bcsu_";
const GRANT_SHAPE = /^bcsu_[A-Za-z0-9_-]{43}$/;
const TARGET_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** False only when APPROVAL_STEP_UP is "off" (any case). Unset, or anything else, enforces. */
export function stepUpEnforced(): boolean {
  return (process.env.APPROVAL_STEP_UP ?? "on").trim().toLowerCase() !== "off";
}

export function isStepUpAction(v: unknown): v is StepUpAction {
  return typeof v === "string" && (STEP_UP_ACTIONS as readonly string[]).includes(v);
}

/** The two approvals name the session or support request they are for; the other actions name nothing. */
export function actionTakesTarget(action: StepUpAction): boolean {
  return action === "approve_session" || action === "approve_support";
}

/** A target id as the approvals use them (a UUID), or null. */
export function cleanTarget(action: StepUpAction, v: unknown): string | null | undefined {
  if (!actionTakesTarget(action)) return v === undefined || v === null ? null : undefined;
  return typeof v === "string" && TARGET_SHAPE.test(v) ? v.toLowerCase() : undefined;
}

export function grantHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A fresh grant: the raw value for the browser, once, and the hash to store. */
export function newGrant(): { raw: string; hash: string } {
  const raw = GRANT_PREFIX + randomBytes(32).toString("base64url");
  return { raw, hash: grantHash(raw) };
}

export type StepUpRefusal = { status: 403; error: "passkey_required" | "step_up_required"; message: string };

const PASSKEY_REQUIRED: StepUpRefusal = {
  status: 403, error: "passkey_required",
  message: "This needs a passkey on your account first (Windows Hello on this PC, or your phone). Add one, then try again. Agents can't use a passkey, so this stays yours.",
};
const CONFIRM: StepUpRefusal = {
  status: 403, error: "step_up_required",
  message: "Confirm it's you with your passkey (Windows Hello or your phone) first. Agents can't, so this stays yours.",
};
const STALE: StepUpRefusal = {
  status: 403, error: "step_up_required",
  message: "That confirmation expired, was already used, or was for something else. Confirm with your passkey again.",
};

/** The tables this needs: the Prisma client or a transaction. */
type Db = { accountPasskey: Prisma.TransactionClient["accountPasskey"]; passkeyChallenge: Prisma.TransactionClient["passkeyChallenge"] };

/**
 * The gate. null: go ahead (the grant, if one was needed, is now spent). Otherwise the refusal to return as 403.
 * Called by the gated actions after their own checks, just before they write, so a request that would be refused
 * anyway never spends a grant. Inside a transaction the spend rolls back with it.
 */
export async function requireStepUp(
  db: Db,
  q: { accountId: string; action: StepUpAction; targetId?: string | null; grant: string | null | undefined; now: Date },
): Promise<StepUpRefusal | null> {
  if (!stepUpEnforced()) return null;
  if ((await db.accountPasskey.count({ where: { accountId: q.accountId } })) === 0) return PASSKEY_REQUIRED;
  const grant = typeof q.grant === "string" ? q.grant.trim() : "";
  if (!grant) return CONFIRM;
  if (!GRANT_SHAPE.test(grant)) return STALE;
  const spent = await db.passkeyChallenge.updateMany({
    where: {
      grantHash: grantHash(grant), accountId: q.accountId, kind: "step_up", action: q.action,
      targetId: actionTakesTarget(q.action) ? (q.targetId ?? "").toLowerCase() : null,
      usedAt: null, expiresAt: { gt: q.now },
    },
    data: { usedAt: q.now },
  });
  return spent.count === 1 ? null : STALE;
}
