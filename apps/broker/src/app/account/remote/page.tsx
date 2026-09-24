"use client";

/**
 * Back Channel Remote — the owner's relay page (docs/appbridge-remote-access.md).
 *
 * Mint a one-use code to register a PC or a phone, see and revoke your registered
 * devices, and read the 7-day connection log. Everything goes through the
 * cookie-authenticated /api/appbridge/v1/account/* routes (mutations echo the
 * bc_csrf cookie). No device credential, pass or key is ever shown here: a code is
 * the only secret, it works once and expires in 10 minutes.
 */

import { useCallback, useEffect, useState } from "react";
import { AppShell, type ShellTab } from "@/components/ui/shell";

interface RemoteDevice { id: string; role: "host" | "remote"; label: string | null; relayEnabled: boolean; enabled: boolean; connectorSpkiSha256: string; createdAt: string; revokedAt: string | null; }
interface DevicesReply { rollout: boolean; entitled: boolean; devices: RemoteDevice[]; }
interface Connection { hostDeviceId: string; remoteDeviceId: string; at: string; }
interface MintedCode { code: string; expiresAt: string; role: "host" | "remote"; }

const TABS: ShellTab[] = [
  { key: "overview", label: "Overview", href: "/account?tab=overview" },
  { key: "messages", label: "Inbox", href: "/account?tab=messages" },
  { key: "friends", label: "Friends", href: "/account?tab=friends" },
  { key: "skills", label: "Toolkit", href: "/account?tab=skills" },
  { key: "agents", label: "Agents", href: "/account?tab=agents" },
  { key: "settings", label: "Settings", href: "/account?tab=settings" },
  { key: "remote", label: "Remote", href: "/account/remote" },
];

// Non-production only: a signed-out visit shows this fixture, like the dashboard's demo mode, so the
// page can be reviewed without a database. Production always shows the signed-out card.
const DEMO: { devices: DevicesReply; connections: Connection[] } = {
  devices: { rollout: true, entitled: true, devices: [
    { id: "demo-pc-1", role: "host", label: "Office PC", relayEnabled: true, enabled: true, connectorSpkiSha256: "", createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), revokedAt: null },
    { id: "demo-phone-1", role: "remote", label: "Skylar's phone", relayEnabled: false, enabled: true, connectorSpkiSha256: "", createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), revokedAt: null },
  ] },
  connections: [{ hostDeviceId: "demo-pc-1", remoteDeviceId: "demo-phone-1", at: new Date(Date.now() - 40 * 60_000).toISOString() }],
};

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const mutate = (path: string, method: "POST" | "DELETE", body?: unknown) =>
  fetch(path, { method, credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: body === undefined ? undefined : JSON.stringify(body) });

function ago(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}
const deviceName = (d: RemoteDevice | undefined, fallback: string) => d?.label || (d ? `${d.role === "host" ? "PC" : "Phone"} ${d.id.slice(0, 6)}` : fallback);

export default function RemotePage() {
  const [state, setState] = useState<"loading" | "unauth" | "ready" | "error">("loading");
  const [data, setData] = useState<DevicesReply | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/appbridge/v1/account/devices", { credentials: "include" });
      if (r.status === 401) {
        if (process.env.NODE_ENV !== "production") { setData(DEMO.devices); setConnections(DEMO.connections); setState("ready"); return; }
        setState("unauth"); return;
      }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json());
      const c = await fetch("/api/appbridge/v1/account/connections", { credentials: "include" });
      if (c.ok) setConnections((await c.json()).connections ?? []);
      setState("ready");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!minted) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [minted]);

  async function mint(role: "host" | "remote") {
    setBusy("mint"); setMessage(""); setMinted(null);
    const r = await mutate("/api/appbridge/v1/account/device-codes", "POST", { role, ...(label.trim() ? { label: label.trim() } : {}) });
    setBusy("");
    if (r.ok) { const j = await r.json(); setMinted({ code: j.code, expiresAt: j.expiresAt, role }); setLabel(""); return; }
    const j = await r.json().catch(() => ({}));
    setMessage(j.error === "rate_limited" ? "Too many codes this hour. Try again later." : j.error === "email_unverified" ? "Verify your email first." : "Couldn't create a code. Try again.");
  }

  async function revoke(d: RemoteDevice) {
    if (!window.confirm(`Revoke ${deviceName(d, "this device")}? It stops reaching your PCs through the relay at once. Pairings on your network are not changed.`)) return;
    setBusy(d.id);
    const r = await mutate(`/api/appbridge/v1/account/devices/${encodeURIComponent(d.id)}`, "DELETE");
    setBusy("");
    setMessage(r.ok ? `${deviceName(d, "Device")} revoked.` : "Couldn't revoke that device. Try again.");
    load();
  }

  const byId = new Map((data?.devices ?? []).map((d) => [d.id, d]));
  const live = (data?.devices ?? []).filter((d) => !d.revokedAt);
  const revoked = (data?.devices ?? []).filter((d) => d.revokedAt);
  const secondsLeft = minted ? Math.max(0, Math.round((new Date(minted.expiresAt).getTime() - now) / 1000)) : 0;

  return (
    <AppShell tabs={TABS} activeTab="remote">
      <div className="ds-wrap">
        <h1 className="ds-h">Back Channel Remote</h1>
        <p className="ds-sub">Reach your PC&apos;s apps from your phone away from home. Pair a phone with a PC on your own network first; this page lets those paired devices find each other through the relay. Everything stays end-to-end encrypted: the relay cannot see your screen or typing.</p>

        {state === "loading" && <div className="ds-card"><div className="ds-skel" style={{ width: 260, height: 16 }} /></div>}
        {state === "unauth" && (
          <div className="ds-card">
            <p style={{ margin: "0 0 14px", lineHeight: 1.6 }}>You&apos;re signed out, or your sign-in link expired.</p>
            <a className="ds-btn" style={{ textDecoration: "none", display: "inline-block" }} href="/login">Sign in</a>
          </div>
        )}
        {state === "error" && <div className="ds-card"><p className="ds-fine">Couldn&apos;t load your devices. Refresh to try again.</p></div>}

        {state === "ready" && data && (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="ds-card">
              <div className="ds-cardh">Status</div>
              <p className="ds-cardsub" style={{ margin: 0 }}>
                {!data.rollout ? "Remote access through the relay is switched off for now."
                  : !data.entitled ? "Your account isn't enabled for remote access yet. Registering devices works; connecting starts once it is enabled."
                  : "Remote access is enabled for your account."}
              </p>
            </div>

            <div className="ds-card">
              <div className="ds-cardh">Add a device</div>
              <p className="ds-cardsub">Get a one-time code, then enter it on the device. On a PC: Back Channel Remote → Internet access → Register this PC. Codes work once and expire after 10 minutes.</p>
              <label className="ds-label" htmlFor="remote-label">Name (optional)</label>
              <input id="remote-label" className="ds-input" value={label} maxLength={80} placeholder="e.g. Office PC" onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 280, display: "block", marginBottom: 12 }} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="ds-btn" disabled={busy === "mint"} onClick={() => mint("host")}>Get a code for a PC</button>
                <button className="ds-btn ghost" disabled={busy === "mint"} onClick={() => mint("remote")}>Get a code for a phone</button>
              </div>
              {minted && (
                <div style={{ marginTop: 16 }} aria-live="polite">
                  <div className="ds-mono" style={{ fontSize: 28, letterSpacing: 2, userSelect: "all" }}>{minted.code}</div>
                  <p className="ds-fine" style={{ margin: "6px 0 0" }}>
                    {secondsLeft > 0
                      ? `For a ${minted.role === "host" ? "PC" : "phone"}. Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}.`
                      : "This code has expired. Get a new one."}
                  </p>
                </div>
              )}
              {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
            </div>

            <div className="ds-card">
              <div className="ds-cardh">Your devices</div>
              {live.length === 0 && <p className="ds-cardsub" style={{ margin: 0 }}>No devices registered yet.</p>}
              {live.map((d) => (
                <div key={d.id} className="ds-item" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div className="ds-iname">{deviceName(d, "")}</div>
                    <div className="ds-imeta">
                      {d.role === "host" ? (d.relayEnabled ? "PC · Internet access on" : "PC · Internet access off") : "Phone"} · registered {ago(d.createdAt)}
                    </div>
                  </div>
                  <button className="ds-btn danger" disabled={busy === d.id} onClick={() => revoke(d)}>Revoke</button>
                </div>
              ))}
              {revoked.length > 0 && <p className="ds-fine" style={{ marginTop: 12 }}>{revoked.length} revoked device{revoked.length === 1 ? "" : "s"} hidden.</p>}
            </div>

            <div className="ds-card">
              <div className="ds-cardh">Connections in the last 7 days</div>
              <p className="ds-cardsub">Which device reached which PC through the relay, and when. Nothing else is recorded, and entries are deleted after 7 days.</p>
              {connections.length === 0 && <p className="ds-fine" style={{ margin: 0 }}>No relayed connections in the last 7 days.</p>}
              {connections.map((c, i) => (
                <div key={`${c.at}-${i}`} className="ds-item">
                  <div className="ds-iname">{deviceName(byId.get(c.remoteDeviceId), "A removed phone")} → {deviceName(byId.get(c.hostDeviceId), "a removed PC")}</div>
                  <div className="ds-imeta">{ago(c.at)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
