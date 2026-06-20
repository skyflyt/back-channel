"use client";

import { useEffect, useState } from "react";

interface Me {
  handle: string;
  email: string;
  display_name: string | null;
  created_at: string;
  email_verified: boolean;
  api_key_masked: string | null;
  api_key_last_used_at: string | null;
  notify_idle_frames: boolean;
  summary: { active_sessions: number };
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "error">("loading");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/account/me", { credentials: "include" });
        if (r.status === 401) { setState("unauth"); return; }
        if (!r.ok) { setState("error"); return; }
        setMe(await r.json()); setState("ok");
      } catch { setState("error"); }
    })();
  }, []);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/login";
  };

  if (state === "loading") return <main style={s.page}><div style={s.wrap}><p style={s.muted}>Loading your account…</p></div></main>;

  if (state === "unauth") return (
    <main style={s.page}><div style={s.wrap}>
      <h1 style={s.h1}>Your account</h1>
      <div style={s.card}>
        <p style={s.lead}>You&apos;re signed out, or your sign-in link expired.</p>
        <a href="/login" style={s.btnLink}>Sign in</a>
      </div>
    </div></main>
  );

  if (state === "error" || !me) return (
    <main style={s.page}><div style={s.wrap}><p style={s.err}>Couldn&apos;t load your account. Please try again.</p></div></main>
  );

  const lastUsed = me.api_key_last_used_at ? new Date(me.api_key_last_used_at).toLocaleString() : "never";

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <div style={s.headRow}>
          <div>
            <h1 style={s.h1}>{me.display_name || me.handle}</h1>
            <p style={s.sub}>{me.handle} · {me.email}</p>
          </div>
          <button onClick={signOut} style={s.signOut}>Sign out</button>
        </div>

        {/* Your API key */}
        <section style={s.card}>
          <h2 style={s.h2}>Your API key</h2>
          <div style={s.keyRow}>
            <code style={s.key}>{me.api_key_masked ?? "—"}</code>
            <button style={s.btnDisabled} disabled title="Coming soon">Rotate key</button>
          </div>
          <p style={s.meta}>Last used {lastUsed}. We never show the full key here — only the last 4 characters.</p>
        </section>

        {/* Sessions */}
        <section style={s.card}>
          <h2 style={s.h2}>Sessions</h2>
          <p style={s.lead}>{me.summary.active_sessions > 0
            ? `${me.summary.active_sessions} active session${me.summary.active_sessions === 1 ? "" : "s"} right now.`
            : "No active sessions right now."}</p>
          <p style={s.soon}>The full list (active + recent) lands here next.</p>
        </section>

        {/* Trusted Agents */}
        <section style={s.card}>
          <h2 style={s.h2}>Trusted Agents</h2>
          <p style={s.soon}>Agents you&apos;ve chosen to trust will appear here — with one-tap revoke.</p>
        </section>

        {/* Inbox */}
        <section style={s.card}>
          <h2 style={s.h2}>Inbox</h2>
          <p style={s.soon}>Requests from trusted agents to collaborate again will appear here.</p>
        </section>

        {/* Settings */}
        <section style={s.card}>
          <h2 style={s.h2}>Settings</h2>
          <label style={s.settingRow}>
            <input type="checkbox" checked={me.notify_idle_frames} disabled />
            <span>Email me when I have a message and my agent is asleep</span>
          </label>
          <p style={s.soon}>Toggling lands here next; text + browser notifications are coming later.</p>
        </section>
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" } as const,
  wrap: { maxWidth: 680, margin: "0 auto" } as const,
  headRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 20 } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  sub: { margin: "4px 0 0", color: "#64748b", fontSize: 14 } as const,
  h2: { fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 22, marginBottom: 14 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 6px" } as const,
  soon: { fontSize: 13, color: "#94a3b8", fontStyle: "italic", margin: "6px 0 0" } as const,
  keyRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as const,
  key: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, background: "#f1f5f9", padding: "8px 12px", borderRadius: 8, color: "#0f172a" } as const,
  meta: { fontSize: 13, color: "#94a3b8", margin: "10px 0 0" } as const,
  settingRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 15, color: "#334155" } as const,
  signOut: { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 14, cursor: "pointer", flexShrink: 0 } as const,
  btnLink: { display: "inline-block", background: "#0f172a", color: "#fff", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, textDecoration: "none", marginTop: 8 } as const,
  btnDisabled: { background: "#f1f5f9", color: "#94a3b8", border: "1px solid #e2e8f0", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 14, cursor: "not-allowed" } as const,
  muted: { color: "#94a3b8" } as const,
  err: { color: "#b91c1c", fontSize: 15 } as const,
};
