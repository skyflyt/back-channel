/**
 * Remote app sessions, as the PC sees them (docs/remote-app-sessions.md). Device routes: the PC's own `ab_`
 * credential only (appbridge.ts hostDevice()), the same fixed error shape and no-store as every AppBridge
 * route, and nothing about the caller's network stored.
 *
 *   GET  /api/appbridge/v1/hosts/self/agent-sessions            the running sessions bound to this PC
 *   POST /api/appbridge/v1/hosts/self/agent-sessions/{id}/stop  Stop on the PC: final, and the session's agent
 *                                                               leases are deleted in the same transaction
 *
 * The PC reads its running sessions to show the banner ("An agent is using QuickBooks on Shop-PC for task
 * '...'. Stop.") and to enforce the app allow-list where apps are opened. Waiting requests never reach the
 * PC: only the person's approval in the dashboard starts a session.
 */
import { NextRequest, NextResponse } from "next/server";
import { fail, handle, hostDevice, json, serializableTx } from "@/lib/appbridge";
import { sessionsForHost, stopInTx } from "@/lib/remote-app";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hostAgentSessions = (req: NextRequest) => handle(async () => {
  const device = await hostDevice(req);
  const sessions = await serializableTx((tx) => sessionsForHost(tx, device, new Date()));
  return json({ sessions });
});

export const hostStopAgentSession = (req: NextRequest, id: string) => handle(async () => {
  const device = await hostDevice(req);
  if (!SESSION_ID.test(id)) fail(404, "not_found");
  await serializableTx(async (tx) => {
    const s = await tx.remoteAppSession.findUnique({ where: { id } });
    if (!s || s.accountId !== device.accountId || s.hostDeviceId !== device.id) fail(404, "not_found");
    await stopInTx(tx, s!, "host", new Date());
  });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
