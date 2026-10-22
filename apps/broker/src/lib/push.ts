/**
 * The push nudge for the BC Remote app (docs/secrets-epic.md §3.6): when a secret broker request of an account is
 * raised or answered, every phone registered to the account that gave us a push token gets one Firebase Cloud
 * Messaging data message. The message says nothing but "look": `{ kind: "secrets" }`, high priority, five minutes to
 * live. The phone then reads the list with its own credential (src/lib/secrets-device.ts). So Google learns that a
 * registered phone was nudged at a time, and nothing else: never a request code, a PC, a secret's name or an outcome.
 *
 * Off unless FCM_PUSH=on: then the Firebase Admin SDK signs with the service's own application default credentials
 * (on Cloud Run, the service account; no key file, no new secret). Where it is off, or Firebase cannot be reached,
 * the phones fall back to their own long-poll (the `wait` query on the device view), which needs nothing here.
 *
 * A token Firebase reports as gone (`messaging/registration-token-not-registered`) is cleared, so an uninstalled app
 * is nudged once and never again. Nothing here logs a token.
 */
import { prisma } from "@/lib/db";
import { onSecretsChanged } from "@/lib/inbox-bus";

/** An FCM registration token as the Android SDK mints them: a long opaque string of a narrow alphabet. */
export const PUSH_TOKEN = /^[A-Za-z0-9:_-]{20,2048}$/;
export const MAX_PHONES_PER_NUDGE = 10;
const TTL_SECONDS = 300;

export const pushEnabled = () => (process.env.FCM_PUSH ?? "off").trim().toLowerCase() === "on";

type Outcome = { token: string; ok: boolean; gone: boolean };
/** The seam under the nudge: production is Firebase; route tests replace it. */
export type Sender = (tokens: string[]) => Promise<Outcome[]>;

let sender: Sender | null = null;
async function firebaseSender(): Promise<Sender> {
  if (sender) return sender;
  // Loaded only when push is on: the SDK is heavy and route tests never need it.
  const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getMessaging } = await import("firebase-admin/messaging");
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
  const messaging = getMessaging(app);
  sender = async (tokens) => {
    const batch = await messaging.sendEach(tokens.map((token) => ({
      token, data: { kind: "secrets" }, android: { priority: "high", ttl: TTL_SECONDS * 1000 },
    })));
    return batch.responses.map((r, i) => ({
      token: tokens[i], ok: r.success,
      gone: !r.success && (r.error?.code === "messaging/registration-token-not-registered" || r.error?.code === "messaging/invalid-registration-token"),
    }));
  };
  return sender;
}

/** Tests only. */
export function _setSender(s: Sender | null) { sender = s; }

/** Nudge the account's phones. Never throws: a failed nudge is logged by class and the long-poll still works. */
export async function nudgeAccount(accountId: string, send?: Sender): Promise<number> {
  const via = send ?? sender ?? (pushEnabled() ? await firebaseSender().catch(() => null) : null);
  if (!via) return 0;
  try {
    const phones = await prisma.appBridgeDevice.findMany({
      where: { accountId, role: "remote", revokedAt: null, enabled: true, pushToken: { not: null } },
      select: { id: true, pushToken: true }, take: MAX_PHONES_PER_NUDGE,
    });
    if (!phones.length) return 0;
    const outcomes = await via(phones.map((p) => p.pushToken as string));
    const gone = outcomes.filter((o) => o.gone).map((o) => o.token);
    if (gone.length) await prisma.appBridgeDevice.updateMany({ where: { id: { in: phones.filter((p) => gone.includes(p.pushToken as string)).map((p) => p.id) } }, data: { pushToken: null, pushUpdatedAt: new Date() } });
    return outcomes.filter((o) => o.ok).length;
  } catch (e) {
    console.error("[push] nudge failed:", e instanceof Error ? e.name : typeof e);
    return 0;
  }
}

/** Wire the nudge to the secrets channel once per process. */
let installed = false;
export function installPushNudge(): void {
  if (installed) return;
  installed = true;
  onSecretsChanged((accountId: string) => { void nudgeAccount(accountId); });
}
