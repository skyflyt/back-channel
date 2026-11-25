/**
 * The per-connector vault grant (docs/vault-bridge.md, step 4): the person lets one hosted connector (an AgentToken
 * with scope "connector", minted by OAuth for claude.ai or ChatGPT) use the read-only bc_vault_* tools.
 *
 * - On: from the dashboard (Devices → Agents), with a passkey step-up for exactly that connector (grant_vault,
 *   src/lib/step-up.ts). Always a passkey: an agent driving the PC can't answer one, so it can't grant itself or a
 *   connector access to the vault. With APPROVAL_STEP_UP=off a grant is refused, never waved through.
 * - Off: one click, no passkey (refusing stays one click), or by revoking the connector's key (the row cascades,
 *   and a revoked key doesn't authenticate anyway).
 * - What it opens: the asking side only (the bc_vault_* tools). The worker routes stay full-scope only: a connector
 *   can never be the PC that answers.
 * - Fail closed: any error reading grants (the VaultGrant table not migrated yet included) means no grant.
 *
 * Note text for a connector's read passes through Back Channel readable, in memory only and never stored, as for any
 * read; that trade is what the dashboard's confirm states before the passkey prompt.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace import (see remote-app.ts): route tests may replace this module with only some exports.
import * as SU from "@/lib/step-up";
import { AGENT_SCOPE_CONNECTOR } from "@/lib/agent-scope";

/** Does this connector key of this account have a vault grant? False on any error. */
export async function connectorHasVaultGrant(accountId: string, agentTokenId: string | null | undefined): Promise<boolean> {
  if (!agentTokenId) return false;
  try {
    const row = await prisma.vaultGrant.findUnique({ where: { agentTokenId }, select: { accountId: true } });
    return row?.accountId === accountId;
  } catch {
    return false;
  }
}

/** The account's grants: agent id → when it was turned on. Empty on any error. */
export async function vaultGrantsFor(accountId: string): Promise<Map<string, Date>> {
  try {
    const rows = await prisma.vaultGrant.findMany({ where: { accountId }, select: { agentTokenId: true, createdAt: true } });
    return new Map(rows.map((r) => [r.agentTokenId, r.createdAt]));
  } catch {
    return new Map();
  }
}

export type GrantOutcome = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string, message: string): GrantOutcome => ({ status, body: { error, message } });

async function audit(accountId: string, eventType: string, detail: Prisma.InputJsonObject) {
  await prisma.accountAudit.create({ data: { accountId, eventType, detail } }).catch(() => {});
}

/** Turn a connector's grant on. The step-up grant (x-bc-step-up) is spent only once every other check passed. */
export async function turnOnVaultGrant(accountId: string, agentId: string, stepUpGrant: string | null, now: Date): Promise<GrantOutcome> {
  if (!SU.stepUpEnforced()) {
    return no(403, "step_up_off", "Letting a connector read your vault needs your passkey, and passkey approvals are switched off on Back Channel right now.");
  }
  const agent = await prisma.agentToken.findUnique({ where: { id: agentId }, select: { id: true, accountId: true, name: true, scope: true, revokedAt: true } });
  if (!agent || agent.accountId !== accountId || agent.revokedAt) return no(404, "not_found", "No such connected app on your account.");
  if (agent.scope !== AGENT_SCOPE_CONNECTOR) {
    return no(409, "not_a_connector", "Only apps connected by sign-in (claude.ai, ChatGPT) need a vault grant. Your own agents' full keys read the vault already.");
  }
  const refusal = await SU.requireStepUp(prisma, { accountId, action: "grant_vault", targetId: agentId, grant: stepUpGrant, now });
  if (refusal) return { status: refusal.status, body: { error: refusal.error, message: refusal.message } };
  const challenge = await prisma.passkeyChallenge.findUnique({ where: { grantHash: SU.grantHash((stepUpGrant ?? "").trim()) }, select: { passkeyId: true } });
  const passkeyId = challenge?.passkeyId ?? "unknown";
  const row = await prisma.vaultGrant.upsert({
    where: { agentTokenId: agentId },
    create: { agentTokenId: agentId, accountId, passkeyId, createdAt: now },
    update: {},
  });
  await audit(accountId, "vault.grant.on", { agent_token_id: agentId, name: agent.name, passkey_id: passkeyId });
  return { status: 200, body: { ok: true, vault_grant_at: row.createdAt.toISOString() } };
}

/** Turn it off. Idempotent; never asks for a passkey. */
export async function turnOffVaultGrant(accountId: string, agentId: string): Promise<GrantOutcome> {
  const gone = await prisma.vaultGrant.deleteMany({ where: { agentTokenId: agentId, accountId } });
  if (gone.count > 0) {
    const agent = await prisma.agentToken.findUnique({ where: { id: agentId }, select: { name: true } }).catch(() => null);
    await audit(accountId, "vault.grant.off", { agent_token_id: agentId, name: agent?.name ?? null });
  }
  return { status: 200, body: { ok: true, vault_grant_at: null } };
}
