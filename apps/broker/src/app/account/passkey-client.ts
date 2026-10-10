/**
 * Browser side of the approval step-up (src/lib/step-up.ts, src/lib/passkeys.ts): add a passkey, and confirm one
 * action with it. The WebAuthn prompt itself is the browser's and the platform's (Windows Hello, a phone, a security
 * key); this module only fetches the options, hands them to @simplewebauthn/browser, and returns what Back Channel says.
 *
 * Browser-only trap (the 2026-10-10 blank-dashboard incident): never copy a host function such as fetch onto another
 * object and call it from there; Chrome throws "Illegal invocation". Every call here is a plain global call.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type StepUpAction = "approve_session" | "approve_support" | "connect_agent" | "manage_passkeys";
/** "needed": the page knows the account has a passkey and the step-up is on, so the prompt comes first. */
export type StepUpHint = "needed" | undefined;
export const STEP_UP_HEADER = "x-bc-step-up";

export interface PasskeyView { id: string; label: string; transports: string[]; createdAt: string; lastUsedAt: string | null }
export interface PasskeyState { stepUp: "on" | "off"; passkeys: PasskeyView[] }

/** A passkey problem, in words for the person. code: passkey_required, cancelled, unsupported, failed, or the server's. */
export class PasskeyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PasskeyError"; this.code = code; }
}

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const UNSUPPORTED = "This browser can't use passkeys. Use Edge, Chrome or Safari on a device with Windows Hello, Touch ID, or your phone nearby.";

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...headers }, body: JSON.stringify(body) });
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const text = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

/** What a failed WebAuthn prompt means for the person (cancelled, timed out, this device already has one). */
function fromPrompt(e: unknown, what: "confirm" | "add"): PasskeyError {
  const name = typeof e === "object" && e && "name" in e ? String((e as { name?: unknown }).name) : "";
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: unknown }).code) : "";
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") {
    return new PasskeyError("cancelled", what === "confirm" ? "Cancelled, or the prompt timed out. Nothing was confirmed." : "Cancelled, or the prompt timed out. No passkey was added.");
  }
  if (name === "InvalidStateError" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return new PasskeyError("already_registered", "This device already has a passkey on your account. Add one from your phone or another device instead.");
  }
  return new PasskeyError("failed", what === "confirm" ? "Your passkey didn't answer. Try again." : "The passkey couldn't be created. Try again.");
}

/** The account's passkeys, and whether approvals need one right now. null when signed out or unreachable. */
export async function loadPasskeys(): Promise<PasskeyState | null> {
  try {
    const res = await fetch("/api/account/passkeys", { credentials: "include" });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<PasskeyState>;
    return { stepUp: j.stepUp === "off" ? "off" : "on", passkeys: Array.isArray(j.passkeys) ? j.passkeys : [] };
  } catch { return null; }
}

export const hintFor = (s: PasskeyState | null): StepUpHint => (s && s.stepUp === "on" && s.passkeys.length > 0 ? "needed" : undefined);

/** One step-up: the passkey prompt for exactly this action (and target), answered with a single-use grant. */
export async function stepUp(action: StepUpAction, targetId?: string | null): Promise<string> {
  if (!browserSupportsWebAuthn()) throw new PasskeyError("unsupported", UNSUPPORTED);
  const o = await postJson("/api/account/passkeys/step-up/options", { action, ...(targetId ? { targetId } : {}) });
  if (!o.res.ok) throw new PasskeyError(text(o.body.error, "failed"), text(o.body.message, "Couldn't start the passkey prompt. Try again."));
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({ optionsJSON: o.body.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
  } catch (e) { throw fromPrompt(e, "confirm"); }
  const v = await postJson("/api/account/passkeys/step-up/verify", { ceremonyId: o.body.ceremonyId, response });
  if (!v.res.ok || typeof v.body.grant !== "string") throw new PasskeyError(text(v.body.error, "failed"), text(v.body.message, "Your passkey couldn't be checked. Try again."));
  return v.body.grant;
}

export interface Guarded { ok: boolean; status: number; body: Record<string, unknown>; needsPasskey: boolean; message: string | null }

/**
 * Send a request that may need the step-up. With hint "needed" the passkey prompt comes first; otherwise the request
 * goes as it is, and a 403 step_up_required is answered with the prompt for exactly this action and target, then
 * sent once more with the grant. needsPasskey: the account has none yet (show "Add a passkey" in place).
 * `send` gets the extra headers to send; it must call fetch itself.
 */
export async function sendWithStepUp(action: StepUpAction, targetId: string | null, send: (headers: Record<string, string>) => Promise<Response>, hint?: StepUpHint): Promise<Guarded> {
  const settle = async (res: Response): Promise<Guarded> => {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const needsPasskey = res.status === 403 && body.error === "passkey_required";
    return { ok: res.ok, status: res.status, body, needsPasskey, message: res.ok ? null : text(body.message, `That didn't work (error ${res.status}). Try again.`) };
  };
  try {
    if (hint === "needed") return await settle(await send({ [STEP_UP_HEADER]: await stepUp(action, targetId) }));
    const first = await send({});
    if (first.status !== 403) return await settle(first);
    const peek = (await first.clone().json().catch(() => ({}))) as Record<string, unknown>;
    if (peek.error !== "step_up_required") return await settle(first);
    return await settle(await send({ [STEP_UP_HEADER]: await stepUp(action, targetId) }));
  } catch (e) {
    if (e instanceof PasskeyError) return { ok: false, status: 0, body: { error: e.code }, needsPasskey: e.code === "passkey_required", message: e.message };
    return { ok: false, status: 0, body: {}, needsPasskey: false, message: "Couldn't reach Back Channel. Check your connection and try again." };
  }
}

/** Add a passkey: Windows Hello on this device, a phone, or a security key. A second one needs a step-up with the first. */
export async function addPasskey(label: string, hint?: StepUpHint): Promise<PasskeyView> {
  if (!browserSupportsWebAuthn()) throw new PasskeyError("unsupported", UNSUPPORTED);
  const o = await sendWithStepUp("manage_passkeys", null, (h) => fetch("/api/account/passkeys/register/options", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...h }, body: "{}",
  }), hint);
  if (!o.ok) throw new PasskeyError(text(o.body.error, "failed"), o.message ?? "Couldn't start adding a passkey. Try again.");
  let response: Awaited<ReturnType<typeof startRegistration>>;
  try {
    response = await startRegistration({ optionsJSON: o.body.options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
  } catch (e) { throw fromPrompt(e, "add"); }
  const v = await postJson("/api/account/passkeys/register/verify", { ceremonyId: o.body.ceremonyId, response, ...(label.trim() ? { label: label.trim() } : {}) });
  if (!v.res.ok || !v.body.passkey) throw new PasskeyError(text(v.body.error, "failed"), text(v.body.message, "The passkey couldn't be added. Try again."));
  return v.body.passkey as PasskeyView;
}

/** Remove a passkey; needs a step-up with one of the account's passkeys (possibly this one). */
export async function removePasskey(id: string, hint?: StepUpHint): Promise<Guarded> {
  return sendWithStepUp("manage_passkeys", null, (h) => fetch(`/api/account/passkeys/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf(), ...h },
  }), hint);
}
