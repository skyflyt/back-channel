/**
 * Secret broker requests in the BC Remote app (docs/secrets-epic.md §3.1): the phone answers with its AppBridge device
 * credential (an `ab_` bearer with appbridge.secrets, src/lib/appbridge.ts), which lasts a year, instead of the
 * dashboard's day-long cookie.
 *
 *   GET  /api/appbridge/v1/devices/self/secret-broker                                  { requests: [...], now }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/deny                 {}: { denied: true }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/approve-options      { option? }: { ceremonyId, options }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/approve-verify       { ceremonyId, response }: { approved, option }
 *
 * The credential alone only sees and denies, as a deny is never gated. Approving is the same approve_secret ceremony
 * as the dashboard's: the WebAuthn challenge is the broker's digest, only a passkey that PC's broker trusts can answer,
 * the answer must come from the release app (src/lib/android-app.ts), and the PC's broker checks the assertion itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppBridgeError, secretsDevice } from "@/lib/appbridge";
import { SecretsError, denyRequest } from "@/lib/secrets";
import { PasskeyRefusal, appApprovalOptions, appApprovalVerify } from "@/lib/passkeys";

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new SecretsError(413, "too_large", "Request too large.");
  if (!text) return {};
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new SecretsError(400, "invalid_json", "Send a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SecretsError(400, "invalid_json", "Send a JSON object.");
  return body as Record<string, unknown>;
}

function onError(e: unknown): NextResponse {
  if (e instanceof AppBridgeError) return respond({ error: e.message }, e.status);
  if (e instanceof SecretsError || e instanceof PasskeyRefusal) return respond({ error: e.code, message: e.message }, e.status);
  console.error("secrets-device: unexpected error", e instanceof Error ? e.name : typeof e);
  return respond({ error: "unavailable", message: "Something went wrong. Try again." }, 503);
}

/** The account's requests still waiting for an answer, as the Remote page shows them; never a value. */
export async function deviceView(req: NextRequest): Promise<NextResponse> {
  try {
    const device = await secretsDevice(req);
    const now = new Date();
    const rows = await prisma.secretRequest.findMany({
      where: { accountId: device.accountId, status: "open", expiresAt: { gt: now } }, orderBy: { raisedAt: "desc" }, take: 20,
      include: { agent: { select: { name: true } } },
    });
    return respond({
      now: now.toISOString(),
      requests: rows.map((r) => ({
        id: r.id, machine: r.agent.name, kind: r.kind, name: r.name, mode: r.mode, tier: r.tier, target: r.target,
        code: r.requestCode, display: r.display, requester: r.requester,
        options: (r.options as { index: number; label: string }[]).map((o) => ({ index: o.index, label: o.label })),
        raisedAt: r.raisedAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      })),
    });
  } catch (e) { return onError(e); }
}

export async function deviceAnswer(req: NextRequest, id: string, action: string): Promise<NextResponse> {
  try {
    const device = await secretsDevice(req);
    if (!UUID.test(id)) throw new SecretsError(404, "not_found", "That request isn't on your account.");
    const now = new Date();
    const by = { device_id: device.id };
    if (action === "deny") return respond(await denyRequest({ id: device.accountId }, id, now, by));
    const input = await readJson(req);
    if (action === "approve-options") return respond(await appApprovalOptions(device.accountId, req.url, id, input.option, now));
    if (action === "approve-verify") return respond(await appApprovalVerify(device.accountId, req.url, id, input, now));
    return respond({ error: "not_found", message: "No such action." }, 404);
  } catch (e) { return onError(e); }
}
