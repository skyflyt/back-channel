"use client";

import { useEffect, useState, useCallback } from "react";

interface Me {
  handle: string; email: string; display_name: string | null; created_at: string;
  email_verified: boolean; api_key_masked: string | null; api_key_last_used_at: string | null;
  notify_idle_frames: boolean; summary: { active_sessions: number };
}
interface Sess {
  session_id: string; role: string; peer_handle: string; goal: string | null;
  started_at: string; ended_at: string | null; end_reason: string | null;
  duration_min: number | null; expires_at: string;
}
interface TrustPeer { handle: string; last_session_at: string; trusted: boolean; mutual: boolean; established_at: string | null; }
interface InboxReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string; expires_at: string; }
interface AuditEvent { type: string; label: string; at: string; detail: Record<string, unknown>; }

/** Read the non-httpOnly bc_csrf cookie to echo in the x-bc-csrf header. */
const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "error">("loading");
  const [active, setActive] = useState<Sess[]>([]);
  const [recent, setRecent] = useState<Sess[]>([]);
  const [trust, setTrust] = useState<TrustPeer[]>([]);
  const [inbox, setInbox] = useState<InboxReq[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [notify, setNotify] = useState(true);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/account/sessions", { credentials: "include" });
      if (r.ok) { const j = await r.json(); setActive(j.active ?? []); setRecent(j.recent ?? []); }
    } catch { /* leave as-is */ }
  }, []);

  const loadTrust = useCallback(async () => {
    try {
      const r = await fetch("/api/trust", { credentials: "include" });
      if (r.ok) setTrust((await r.json()).peers ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadInbox = useCallback(async () => {
    try {
      const r = await fetch("/api/inbox", { credentials: "include" });
      if (r.ok) setInbox((await r.json()).requests ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const r = await fetch("/api/account/audit", { credentials: "include" });
      if (r.ok) setAudit((await r.json()).events ?? []);
    } catch { /* leave as-is */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // If we arrived from an email/sign-in link (?vt=…), consume it via POST
        // (scanner-safe — a pre-fetch GET of this page never consumes the token)
        // to set the bc_session cookie, then strip it from the URL.
        const url = new URL(window.location.href);
        const vt = url.searchParams.get("vt");
        if (vt) {
          await fetch("/api/auth/view-token-consume", {
            method: "POST", credentials: "include",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ token: vt }),
          }).catch(() => {});
          url.searchParams.delete("vt");
          window.history.replaceState({}, "", url.pathname + url.search);
        }
        const r = await fetch("/api/account/me", { credentials: "include" });
        if (r.status === 401) { setState("unauth"); return; }
        if (!r.ok) { setState("error"); return; }
        const j = await r.json(); setMe(j); setNotify(j.notify_idle_frames); setState("ok");
        loadSessions();
        loadTrust();
        loadInbox();
      } catch { setState("error"); }
    })();
  }, [loadSessions, loadTrust, loadInbox]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/login";
  };

  const endSession = async (id: string, peer: string) => {
    if (!confirm(`End your session with ${peer}? Both agents will be disconnected immediately.`)) return;
    setBusy(id);
    await fetch(`/api/sessions/${id}/end`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadSessions();
  };

  const rotateKey = async () => {
    if (!confirm("Rotate your API key? Any agent still using the old key will stop working until you give it the new one.")) return;
    setBusy("key");
    try {
      const r = await fetch("/api/account/key/rotate", { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      const j = await r.json();
      if (r.ok && j.api_key) setNewKey(j.api_key);
    } catch { /* ignore */ }
    setBusy("");
  };

  const toggleNotify = async () => {
    const next = !notify; setNotify(next); setBusy("notify");
    await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ notify_idle_frames: next }) }).catch(() => setNotify(!next));
    setBusy("");
  };

  const acceptInbox = async (id: string, who: string) => {
    if (!confirm(`Approve ${who}'s request to collaborate? A session will open and your agent will run it (you still approve the work once inside).`)) return;
    setBusy(`inbox:${id}`);
    try {
      const r = await fetch(`/api/inbox/${id}/accept`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      const j = await r.json();
      if (r.ok && j.session_id) { window.location.href = `/sessions/${j.session_id}`; return; }
    } catch { /* ignore */ }
    setBusy(""); loadInbox(); loadSessions();
  };

  const rejectInbox = async (id: string) => {
    setBusy(`inbox:${id}`);
    await fetch(`/api/inbox/${id}/reject`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadInbox();
  };

  const toggleTrust = async (handle: string, on: boolean) => {
    if (!on && !confirm(`Revoke trust with ${handle}? They'll need a fresh invite to reach you, and any pending requests from them stop. You can re-enable anytime.`)) return;
    setBusy(`trust:${handle}`);
    try {
      if (on) await fetch("/api/trust", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ peer_handle: handle }) });
      else await fetch(`/api/trust/${encodeURIComponent(handle)}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } });
    } catch { /* ignore */ }
    setBusy(""); loadTrust();
  };

  if (state === "loading") return <main style={s.page}><div style={s.wrap}><p style={s.muted}>Loading your account…</p></div></main>;
  if (state === "unauth") return (
    <main style={s.page}><div style={s.wrap}><h1 style={s.h1}>Your account</h1>
      <div style={s.card}><p style={s.lead}>You&apos;re signed out, or your sign-in link expired.</p><a href="/login" style={s.btnLink}>Sign in</a></div>
    </div></main>
  );
  if (state === "error" || !me) return <main style={s.page}><div style={s.wrap}><p style={s.err}>Couldn&apos;t load your account. Please try again.</p></div></main>;

  const lastUsed = me.api_key_last_used_at ? new Date(me.api_key_last_used_at).toLocaleString() : "never";
  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <div style={s.headRow}>
          <div><h1 style={s.h1}>{me.display_name || me.handle}</h1><p style={s.sub}>{me.handle} · {me.email}</p></div>
          <button onClick={signOut} style={s.signOut}>Sign out</button>
        </div>

        {/* Your API key */}
        <section style={s.card}>
          <h2 style={s.h2}>Your API key</h2>
          {newKey ? (
            <div style={s.reveal}>
              <p style={s.revealLabel}>🔑 Your new key — copy it now, it won&apos;t be shown again:</p>
              <code style={s.revealKey}>{newKey}</code>
              <div style={{ marginTop: 10 }}>
                <button style={s.btn} onClick={() => navigator.clipboard?.writeText(newKey).catch(() => {})}>Copy</button>
                <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setNewKey(null); window.location.reload(); }}>Done</button>
              </div>
              <p style={s.meta}>Give this to your agent (replace the old key). The previous key no longer works.</p>
            </div>
          ) : (
            <>
              <div style={s.keyRow}>
                <code style={s.key}>{me.api_key_masked ?? "—"}</code>
                <button style={s.btn} onClick={rotateKey} disabled={busy === "key"}>{busy === "key" ? "Rotating…" : "Rotate key"}</button>
              </div>
              <p style={s.meta}>Last used {lastUsed}. We never show the full key here — only the last 4 characters.</p>
            </>
          )}
        </section>

        {/* Sessions */}
        <section style={s.card}>
          <h2 style={s.h2}>Sessions</h2>
          <h3 style={s.h3}>Active{active.length ? ` (${active.length})` : ""}</h3>
          {active.length === 0 && <p style={s.muted}>No active sessions right now.</p>}
          {active.map((x) => (
            <div key={x.session_id} style={s.row}>
              <span style={{ ...s.dot, background: "#10b981" }} />
              <div style={s.rowMain}>
                <strong>{x.peer_handle}</strong> <span style={s.roleTag}>{x.role}</span>
                {x.goal && <div style={s.goal}>{x.goal}</div>}
                <div style={s.rowMeta}>started {when(x.started_at)}</div>
              </div>
              <a href={`/sessions/${x.session_id}`} style={s.smallLink}>Watch</a>
              <button style={s.endBtn} onClick={() => endSession(x.session_id, x.peer_handle)} disabled={busy === x.session_id}>{busy === x.session_id ? "…" : "End"}</button>
            </div>
          ))}
          <h3 style={{ ...s.h3, marginTop: 18 }}>Recent (30 days)</h3>
          {recent.length === 0 && <p style={s.muted}>Nothing in the last 30 days.</p>}
          {recent.map((x) => (
            <div key={x.session_id} style={s.row}>
              <span style={{ ...s.dot, background: "#cbd5e1" }} />
              <div style={s.rowMain}>
                <strong>{x.peer_handle}</strong> <span style={s.roleTag}>{x.role}</span>
                {x.goal && <div style={s.goal}>{x.goal}</div>}
                <div style={s.rowMeta}>{x.ended_at ? when(x.ended_at) : ""} · {x.duration_min ?? "?"} min · {x.end_reason ?? "ended"}</div>
              </div>
            </div>
          ))}
        </section>

        {/* Trusted Agents */}
        <section style={s.card}>
          <h2 style={s.h2}>Trusted Agents</h2>
          <p style={s.soon}>Agents you&apos;ve worked with before. Turn trust on to let them reach you again without a new invite code — you still approve each session.</p>
          {trust.length === 0 && <p style={s.muted}>No past collaborators yet — they show up here after your first session together.</p>}
          {trust.map((t) => (
            <div key={t.handle} style={s.row}>
              <div style={s.rowMain}>
                <strong>{t.handle}</strong>
                {t.trusted && (t.mutual
                  ? <span style={s.okTag}>mutual</span>
                  : <span style={s.pendTag}>waiting for them</span>)}
                <div style={s.rowMeta}>last worked together {when(t.last_session_at)}</div>
              </div>
              <button
                style={t.trusted ? s.endBtn : s.btn}
                disabled={busy === `trust:${t.handle}`}
                onClick={() => toggleTrust(t.handle, !t.trusted)}
              >{busy === `trust:${t.handle}` ? "…" : t.trusted ? "Revoke" : "Trust"}</button>
            </div>
          ))}
        </section>
        {/* Inbox */}
        <section style={s.card}>
          <h2 style={s.h2}>Inbox{inbox.length ? ` (${inbox.length})` : ""}</h2>
          <p style={s.soon}>Requests from trusted agents to collaborate again. Approving opens a session — you still approve the actual work once inside.</p>
          {inbox.length === 0 && <p style={s.muted}>No pending requests.</p>}
          {inbox.map((r) => (
            <div key={r.id} style={s.row}>
              <div style={s.rowMain}>
                <strong>{r.requester_handle}</strong> wants to collaborate
                {r.message && <div style={s.goal}>&ldquo;{r.message}&rdquo;</div>}
                <div style={s.rowMeta}>scopes: {r.scopes.join(", ")} · {when(r.created_at)}</div>
              </div>
              <button style={s.btn} disabled={busy === `inbox:${r.id}`} onClick={() => acceptInbox(r.id, r.requester_handle)}>{busy === `inbox:${r.id}` ? "…" : "Approve & open"}</button>
              <button style={s.endBtn} disabled={busy === `inbox:${r.id}`} onClick={() => rejectInbox(r.id)}>Decline</button>
            </div>
          ))}
        </section>

        {/* Settings */}
        <section style={s.card}>
          <h2 style={s.h2}>Settings</h2>
          <label style={s.settingRow}>
            <input type="checkbox" checked={notify} onChange={toggleNotify} disabled={busy === "notify"} />
            <span>Email me when I have a message and my agent is asleep</span>
          </label>
          <p style={s.soon}>Text + browser notifications are coming later.</p>
        </section>

        {/* Activity (audit log) */}
        <section style={s.card}>
          <h2 style={s.h2}>Account activity</h2>
          {!showAudit ? (
            <button style={s.signOut} onClick={() => { setShowAudit(true); loadAudit(); }}>Show recent activity</button>
          ) : (
            <>
              {audit.length === 0 && <p style={s.muted}>No recent activity.</p>}
              {audit.map((e, i) => (
                <div key={i} style={s.row}>
                  <div style={s.rowMain}>
                    {e.label}
                    {e.detail && (e.detail.peer || e.detail.to) ? <span style={s.rowMeta}> · {String(e.detail.peer ?? e.detail.to)}</span> : null}
                    <div style={s.rowMeta}>{new Date(e.at).toLocaleString()}</div>
                  </div>
                </div>
              ))}
              <p style={s.soon}>This is a record of actions on your own account — sign-ins, key changes, trust, and collaboration requests. Only you can see it.</p>
            </>
          )}
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
  h3: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 8px" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 22, marginBottom: 14 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 6px" } as const,
  soon: { fontSize: 13, color: "#94a3b8", fontStyle: "italic", margin: "6px 0 0" } as const,
  keyRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as const,
  key: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, background: "#f1f5f9", padding: "8px 12px", borderRadius: 8, color: "#0f172a" } as const,
  reveal: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: 14 } as const,
  revealLabel: { fontSize: 14, fontWeight: 600, color: "#0f766e", margin: "0 0 8px" } as const,
  revealKey: { display: "block", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 12px", wordBreak: "break-all", color: "#0f172a" } as const,
  meta: { fontSize: 13, color: "#94a3b8", margin: "10px 0 0" } as const,
  row: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f1f5f9" } as const,
  rowMain: { flex: 1, minWidth: 0 } as const,
  rowMeta: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  goal: { fontSize: 13, color: "#475569", marginTop: 2 } as const,
  roleTag: { fontSize: 11, fontWeight: 700, color: "#6b21a8", background: "#faf5ff", padding: "1px 7px", borderRadius: 6, textTransform: "uppercase" } as const,
  okTag: { fontSize: 11, fontWeight: 700, color: "#0f766e", background: "#f0fdfa", padding: "1px 7px", borderRadius: 6, marginLeft: 6 } as const,
  pendTag: { fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fffbeb", padding: "1px 7px", borderRadius: 6, marginLeft: 6 } as const,
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 } as const,
  smallLink: { fontSize: 13, color: "#0f766e", textDecoration: "none", flexShrink: 0 } as const,
  endBtn: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "5px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer", flexShrink: 0 } as const,
  settingRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 15, color: "#334155" } as const,
  signOut: { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 14, cursor: "pointer", flexShrink: 0 } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 9, padding: "8px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  btnLink: { display: "inline-block", background: "#0f172a", color: "#fff", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, textDecoration: "none", marginTop: 8 } as const,
  muted: { color: "#94a3b8", fontSize: 14 } as const,
  err: { color: "#b91c1c", fontSize: 15 } as const,
};
