"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell, type ShellTab } from "@/components/ui/shell";
import { MetricCard, SkeletonRows } from "@/components/ui/primitives";

type Win = { "24h": number; "7d": number; "30d": number };
type Analytics = {
  generated_at: string; cached?: boolean;
  adoption: {
    accounts_total: number; accounts_verified: number; accounts_pending: number;
    new_accounts: Win; active_accounts: Win;
    agents_total: number; avg_agents_per_account: number; new_agents: Win;
    growth_sparkline_30d: number[];
  };
  engagement: {
    sessions_total: number; sessions: Win; active_sessions_now: number;
    frames_buffered_total: number; frames_buffered_by_type: Record<string, number>;
    frames_note: string; median_session_minutes_30d: number | null;
  };
  features: {
    trust_rows: number; trust_pairs_mutual: number; inbox_requests_7d: number;
    skill_shares_total: number; top_shared_skills: { name: string; shares: number }[];
    schedule_negotiated_7d: number; schedule_booked_7d: number;
    exchange_code_7d: { issued: number; redeemed: number; rate_pct: number | null };
    magic_link_alltime: { issued: number; redeemed: number; rate_pct: number | null };
  };
  health: {
    inbox_check_adoption_pct: number; accounts_with_active_agent_24h: number; accounts_with_agent: number;
    pending_signups_24h: number; rate_limit_hits_24h: number;
    email_delivery: { available: boolean; reason?: string; window?: string; total_7d?: number; delivered?: number; bounced?: number; complained?: number; other?: number } | null;
  };
  recent: { signups: { at: string; handle: string; email: string; verified: boolean }[]; sessions: { started_at: string; scopes: string[]; status: string }[] };
  privacy_note: string;
};
type UserRow = {
  handle: string; email: string; created_at: string; last_active_at: string | null;
  agent_count: number; session_count: number; session_count_7d: number; trusted_peer_count: number;
  invites_sent_lifetime: number; inbox_requests_sent_lifetime: number; inbox_check_installed: boolean; status_label: string;
};

const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

const TABS: ShellTab[] = [
  { key: "overview", label: "Overview", href: "/account?tab=overview" },
  { key: "messages", label: "Inbox", href: "/account?tab=messages" },
  { key: "friends", label: "Friends", href: "/account?tab=friends" },
  { key: "skills", label: "Toolkit", href: "/account?tab=skills" },
  { key: "agents", label: "Agents", href: "/account?tab=agents" },
  { key: "settings", label: "Settings", href: "/account?tab=settings" },
  { key: "admin", label: "Admin", href: "/admin" },
];

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <AppShell tabs={TABS} activeTab="admin" userLabel="OP" userTitle="Operator">
      <div className="ds-wrap">
        <h1 className="ds-h1">Operator analytics</h1>
        <p className="ds-sub">Adoption, engagement, and health across every account — metadata only, no content.</p>
        {children}
      </div>
    </AppShell>
  );
}

function Spark({ data }: { data: number[] }) {
  const w = 280, h = 44, max = Math.max(1, ...data), n = data.length;
  const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - (v / max) * (h - 6) - 3}`).join(" ");
  const total = data.reduce((a, b) => a + b, 0);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
        <polyline points={pts} fill="none" stroke="#635bff" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <p className="ds-fine" style={{ margin: "2px 0 10px", textAlign: "right" }}>new accounts/day · last 30d · {total} total</p>
    </div>
  );
}

export default function AdminPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [sort, setSort] = useState("last_active");
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "forbidden" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/analytics`, { credentials: "include" });
      if (r.status === 401) { setState("unauth"); return; }
      if (r.status === 403) { setState("forbidden"); return; }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ok");
    } catch { setState("error"); }
  }, []);
  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/users?sort=${sort}&filter=${filter}&limit=200`, { credentials: "include" });
      if (r.ok) { const j = await r.json(); setUsers(j.users ?? []); setUsersTotal(j.total ?? 0); }
    } catch { /* leave */ }
  }, [sort, filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (state === "ok") loadUsers(); }, [state, loadUsers]);

  if (state === "unauth") return <Frame><div className="ds-card"><div className="ds-call warn">Sign in first — <a href="/login" className="ds-link">/login</a>.</div></div></Frame>;
  if (state === "forbidden") return <Frame><div className="ds-card"><div className="ds-call warn">This account isn&apos;t an admin.</div></div></Frame>;
  if (state === "error") return <Frame><div className="ds-card"><div className="ds-call danger">Couldn&apos;t load analytics.</div></div></Frame>;
  if (state === "loading" || !data) {
    return (
      <Frame>
        <div className="ds-card"><SkeletonRows rows={6} /></div>
      </Frame>
    );
  }

  const { adoption: ad, engagement: en, features: ft, health: he, recent } = data;
  const Metric = ({ k, v }: { k: string; v: unknown }) => (
    <div className="ds-item" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ color: "var(--ds-mut)", fontSize: 13 }}>{k}</span>
      <span style={{ fontFamily: "var(--ds-mono)", fontSize: 13, fontWeight: 600, textAlign: "right", overflowWrap: "anywhere" }}>
        {v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}
      </span>
    </div>
  );

  return (
    <Frame>
      {/* Headline: is anyone besides me using this? */}
      <div className="ds-metrics">
        <MetricCard label="total accounts" value={ad.accounts_total} />
        <MetricCard label="active · 7d" value={ad.active_accounts["7d"]} />
        <MetricCard label="new · 7d" value={ad.new_accounts["7d"]} />
        <MetricCard label="agents" value={ad.agents_total} />
      </div>

      <div className="ds-col">
        <section className="ds-card">
          <h2 className="ds-cardh">Adoption</h2>
          <Spark data={ad.growth_sparkline_30d} />
          <Metric k="total accounts" v={`${ad.accounts_total} (${ad.accounts_verified} verified, ${ad.accounts_pending} pending)`} />
          <Metric k="new accounts (24h / 7d / 30d)" v={`${ad.new_accounts["24h"]} / ${ad.new_accounts["7d"]} / ${ad.new_accounts["30d"]}`} />
          <Metric k="active accounts (24h / 7d / 30d)" v={`${ad.active_accounts["24h"]} / ${ad.active_accounts["7d"]} / ${ad.active_accounts["30d"]}`} />
          <Metric k="registered agents" v={`${ad.agents_total} (avg ${ad.avg_agents_per_account}/account)`} />
          <Metric k="new agents (24h / 7d / 30d)" v={`${ad.new_agents["24h"]} / ${ad.new_agents["7d"]} / ${ad.new_agents["30d"]}`} />
        </section>

        <section className="ds-card">
          <h2 className="ds-cardh">Engagement</h2>
          <Metric k="sessions ever" v={en.sessions_total} />
          <Metric k="sessions (24h / 7d / 30d)" v={`${en.sessions["24h"]} / ${en.sessions["7d"]} / ${en.sessions["30d"]}`} />
          <Metric k="active sessions now" v={en.active_sessions_now} />
          <Metric k="median session (30d)" v={en.median_session_minutes_30d === null ? "—" : `${en.median_session_minutes_30d} min`} />
          <Metric k="frames buffered now" v={`${en.frames_buffered_total} — ${Object.entries(en.frames_buffered_by_type).map(([t, c]) => `${t}:${c}`).join(", ") || "none"}`} />
          <p className="ds-fine" style={{ margin: "8px 0 0" }}>{en.frames_note}</p>
        </section>

        <section className="ds-card">
          <h2 className="ds-cardh">Feature usage</h2>
          <Metric k="trust rows / mutual pairs" v={`${ft.trust_rows} / ${ft.trust_pairs_mutual}`} />
          <Metric k="inbox requests (7d)" v={ft.inbox_requests_7d} />
          <Metric k="skill shares" v={ft.skill_shares_total} />
          {ft.top_shared_skills.length > 0 && <Metric k="top shared skills" v={ft.top_shared_skills.map((x) => `${x.name} (${x.shares})`).join(", ")} />}
          <Metric k="scheduling (negotiated / booked, 7d)" v={`${ft.schedule_negotiated_7d} / ${ft.schedule_booked_7d}`} />
          <Metric k="exchange codes (7d): issued→redeemed" v={`${ft.exchange_code_7d.issued} → ${ft.exchange_code_7d.redeemed}${ft.exchange_code_7d.rate_pct === null ? "" : ` (${ft.exchange_code_7d.rate_pct}%)`}`} />
          <Metric k="magic links (all-time): issued→redeemed" v={`${ft.magic_link_alltime.issued} → ${ft.magic_link_alltime.redeemed}${ft.magic_link_alltime.rate_pct === null ? "" : ` (${ft.magic_link_alltime.rate_pct}%)`}`} />
        </section>

        <section className="ds-card">
          <h2 className="ds-cardh">Health</h2>
          <Metric k="inbox-check adoption" v={`${he.inbox_check_adoption_pct}% (${he.accounts_with_active_agent_24h}/${he.accounts_with_agent} accounts active in 24h)`} />
          <Metric k="rate-limit hits (~24h)" v={he.rate_limit_hits_24h} />
          <Metric k="pending (unverified) signups 24h" v={he.pending_signups_24h} />
          <Metric k="email delivery (7d, via Resend)" v={
            he.email_delivery?.available
              ? `${he.email_delivery.total_7d} sent · ${he.email_delivery.delivered} delivered · ${he.email_delivery.bounced} bounced · ${he.email_delivery.complained} spam-complaints`
              : `unavailable (${he.email_delivery?.reason ?? "n/a"})`
          } />
          {he.email_delivery && !he.email_delivery.available && <p className="ds-fine" style={{ margin: "8px 0 0" }}>Email stats pull live from Resend&apos;s API; &ldquo;{he.email_delivery.reason}&rdquo; means the key is missing or the call failed.</p>}
        </section>

        <section className="ds-card">
          <h2 className="ds-cardh">Recent sign-ups</h2>
          {recent.signups.length === 0 && <p className="ds-fine">None yet.</p>}
          {recent.signups.map((r, i) => (
            <div key={i} className="ds-item" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="ds-iname" style={{ fontFamily: "var(--ds-mono)" }}>{r.handle} <span className="ds-imeta" style={{ display: "inline" }}>{r.email}</span></span>
              <span className="ds-imeta" style={{ marginTop: 0, whiteSpace: "nowrap" }}>{r.verified ? "✓ verified" : "pending"} · {ago(r.at)}</span>
            </div>
          ))}
        </section>

        {/* Users table — operator visibility (admin-only): full identity + per-account metadata, no content */}
        <section className="ds-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            <h2 className="ds-cardh" style={{ margin: 0 }}>Users ({usersTotal})</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span className="ds-fine" style={{ textTransform: "uppercase", marginLeft: 6 }}>sort</span>
              {["last_active", "created", "sessions"].map((so) => (
                <button key={so} onClick={() => setSort(so)} className={sort === so ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12, padding: "4px 9px" }}>{so.replace("_", " ")}</button>
              ))}
              <span className="ds-fine" style={{ textTransform: "uppercase", marginLeft: 6 }}>filter</span>
              {[["", "all"], ["zero_activity", "no activity"], ["new_7d", "new 7d"], ["heavy", ">10 sess"]].map(([f, lbl]) => (
                <button key={f} onClick={() => setFilter(f)} className={filter === f ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12, padding: "4px 9px" }}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead><tr>
                {["handle", "email", "created", "last active", "agents", "sess", "7d", "trust", "inv", "inbox-req", "checker", "status"].map((h) => <th key={h}>{h}</th>)}
              </tr></thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={i}>
                    <td className="strong">{u.handle}</td>
                    <td>{u.email}</td>
                    <td>{ago(u.created_at)}</td>
                    <td>{u.last_active_at ? ago(u.last_active_at) : "—"}</td>
                    <td className="num">{u.agent_count}</td>
                    <td className="num">{u.session_count}</td>
                    <td className="num">{u.session_count_7d}</td>
                    <td className="num">{u.trusted_peer_count}</td>
                    <td className="num">{u.invites_sent_lifetime}</td>
                    <td className="num">{u.inbox_requests_sent_lifetime}</td>
                    <td className="num">{u.inbox_check_installed ? "✓" : "—"}</td>
                    <td>{u.status_label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {users.length === 0 && <p className="ds-fine" style={{ marginTop: 8 }}>No users match.</p>}
        </section>

        <section className="ds-card">
          <h2 className="ds-cardh">Recent sessions</h2>
          {recent.sessions.length === 0 && <p className="ds-fine">None yet.</p>}
          {recent.sessions.map((r, i) => (
            <div key={i} className="ds-item" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="ds-iname" style={{ fontFamily: "var(--ds-mono)" }}>{r.status === "active" ? "🟢" : "⚪"} {r.scopes.join(", ") || "(no scopes)"}</span>
              <span className="ds-imeta" style={{ marginTop: 0, whiteSpace: "nowrap" }}>{ago(r.started_at)}</span>
            </div>
          ))}
        </section>

        <RemoteEntitlementCard />

        <div className="ds-call ok">🔒 {data.privacy_note}</div>
        <p className="ds-fine" style={{ textAlign: "center", margin: 0 }}>generated {ago(data.generated_at)}{data.cached ? " · cached" : ""} · <button className="ds-link" onClick={load}>refresh</button></p>
      </div>
    </Frame>
  );
}

/**
 * Back Channel Remote: turn the appbridge.remote_access entitlement on or off for one account
 * (PUT /api/appbridge/v1/admin/entitlements, admin + dashboard session + CSRF only).
 */
function RemoteEntitlementCard() {
  const [handle, setHandle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const csrf = () => (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "");
  async function set(active: boolean) {
    const h = handle.trim();
    if (!h) { setMessage("Enter a handle first."); return; }
    setBusy(true); setMessage("");
    try {
      const r = await fetch("/api/appbridge/v1/admin/entitlements", { method: "PUT", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ handle: h, active }) });
      setMessage(r.ok ? `Remote access ${active ? "enabled" : "disabled"} for ${h}.` : r.status === 404 ? `No account ${h}.` : "Couldn't change it. Try again.");
    } catch { setMessage("Couldn't change it. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <section className="ds-card">
      <h2 className="ds-cardh">Back Channel Remote access</h2>
      <p className="ds-fine">Lets an account's registered devices connect through the relay. Registering devices works without it. The relay-wide switch is the APPBRIDGE_REMOTE_ACCESS setting.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="ds-input" value={handle} placeholder="handle, e.g. skylar@bc" maxLength={128} onChange={(e) => setHandle(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="ds-btn" disabled={busy} onClick={() => set(true)}>Enable</button>
        <button className="ds-btn ghost" disabled={busy} onClick={() => set(false)}>Disable</button>
      </div>
      {message && <p className="ds-fine" style={{ marginTop: 8 }} aria-live="polite">{message}</p>}
    </section>
  );
}
