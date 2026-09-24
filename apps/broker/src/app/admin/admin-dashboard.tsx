"use client";

/**
 * The owner's admin dashboard. Rendered only after src/app/admin/page.tsx has
 * checked, server-side, that the viewer is the owner; every API it calls
 * (/api/admin/*, PUT /api/appbridge/v1/admin/entitlements) checks again.
 * Mutations echo the bc_csrf cookie in x-bc-csrf.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, type ShellTab } from "@/components/ui/shell";
import { Chip, MetricCard, SkeletonRows } from "@/components/ui/primitives";

type Win = { "24h": number; "7d": number; "30d": number };
type Status = "active_7d" | "active_30d" | "dormant" | "never" | "reserved";
type Analytics = {
  generated_at: string; cached?: boolean;
  adoption: {
    accounts_total: number; accounts_verified: number; accounts_pending: number; accounts_reserved: number;
    new_accounts: Win; active_accounts: Win;
    agents_total: number; avg_agents_per_account: number; new_agents: Win;
    agents_per_account: { none: number; one: number; two: number; three_plus: number };
    growth_sparkline_30d: number[];
  };
  activity: { dau: number; wau: number; mau: number; status: Record<Exclude<Status, "reserved">, number>; derived_from: string };
  remote: {
    accounts_with_devices: number; accounts_entitled: number;
    devices: { pcs: number; phones: number; revoked: number };
    connections_7d: number; connections_per_day_7d: { day: string; count: number }[];
  };
  engagement: {
    sessions_total: number; sessions: Win; active_sessions_now: number;
    frames_buffered_total: number; frames_buffered_by_role: Record<string, number>;
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
    email_delivery: { available: boolean; reason?: string; total_7d?: number; delivered?: number; bounced?: number; complained?: number } | null;
  };
  recent: { sessions: { started_at: string; scopes: string[]; status: string }[] };
  privacy_note: string;
};
type RemoteSummary = { pcs: number; phones: number; pcs_revoked: number; phones_revoked: number; entitled: boolean; connections_7d: number; last_connection_at: string | null };
type UserRow = {
  handle: string; email: string; created_at: string; email_verified_at: string | null; reserved: boolean;
  last_active_at: string | null; status: Status; active_via: string[]; agents: number; plan: string | null; remote: RemoteSummary;
};
type UsersReply = { total: number; page: number; limit: number; users: UserRow[] };

const TABS: ShellTab[] = [
  { key: "overview", label: "Overview", href: "/account?tab=overview" },
  { key: "messages", label: "Inbox", href: "/account?tab=messages" },
  { key: "friends", label: "Friends", href: "/account?tab=friends" },
  { key: "skills", label: "Toolkit", href: "/account?tab=skills" },
  { key: "agents", label: "Agents", href: "/account?tab=agents" },
  { key: "settings", label: "Settings", href: "/account?tab=settings" },
  { key: "remote", label: "Remote", href: "/account/remote" },
  { key: "admin", label: "Admin", href: "/admin" },
];

const STATUS_LABEL: Record<Status, string> = {
  active_7d: "Active · 7d", active_30d: "Active · 30d", dormant: "Dormant", never: "Never active", reserved: "Reserved",
};
const STATUS_TONE: Record<Status, "ok" | "acc" | "warn" | undefined> = {
  active_7d: "ok", active_30d: "acc", dormant: "warn", never: undefined, reserved: undefined,
};
const VIA_LABEL: Record<string, string> = { agent: "agent key", dashboard: "dashboard", remote: "Remote relay", legacyKey: "legacy key" };
const PAGE_SIZE = 200;

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <AppShell tabs={TABS} activeTab="admin" userLabel="OP" userTitle="Owner">
      <div className="ds-wrap">
        <h1 className="ds-h1">Admin</h1>
        <p className="ds-sub">Who uses Back Channel and whether they are active. Owner only. Metadata only, never content.</p>
        {children}
      </div>
    </AppShell>
  );
}

function Spark({ data, label }: { data: number[]; label: string }) {
  const w = 280, h = 44, max = Math.max(1, ...data), n = Math.max(2, data.length);
  const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - (v / max) * (h - 6) - 3}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }} role="img" aria-label={label}>
        <polyline points={pts} fill="none" stroke="var(--ds-acc)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <p className="ds-fine" style={{ margin: "2px 0 10px", textAlign: "right" }}>{label}</p>
    </div>
  );
}

function Bars({ rows }: { rows: { day: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 70, margin: "8px 0 4px" }} role="img"
      aria-label={`Relayed connections per day: ${rows.map(r => `${r.day} ${r.count}`).join(", ")}`}>
      {rows.map(r => (
        <div key={r.day} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <span className="ds-fine" style={{ fontSize: 10.5 }}>{r.count}</span>
          <div style={{ width: "100%", height: Math.max(2, (r.count / max) * 44), background: "var(--ds-acc)", borderRadius: 3, opacity: r.count ? 1 : 0.25 }} />
          <span className="ds-fine" style={{ fontSize: 10.5 }}>{new Date(`${r.day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" })}</span>
        </div>
      ))}
    </div>
  );
}

function Metric({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="ds-item" style={{ justifyContent: "space-between", alignItems: "baseline", padding: "9px 0" }}>
      <span style={{ color: "var(--ds-mut)", fontSize: 13 }}>{k}</span>
      <span style={{ fontFamily: "var(--ds-mono)", fontSize: 13, fontWeight: 600, textAlign: "right", overflowWrap: "anywhere" }}>{v ?? "—"}</span>
    </div>
  );
}

export function AdminDashboard() {
  const [data, setData] = useState<Analytics | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "forbidden" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/analytics`, { credentials: "include", cache: "no-store" });
      if (r.status === 401) { setState("unauth"); return; }
      if (r.status === 403) { setState("forbidden"); return; }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ok");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (state === "unauth") return <Frame><div className="ds-card"><div className="ds-call warn">Your session ended. <a href="/login" className="ds-link">Sign in again</a>.</div></div></Frame>;
  if (state === "forbidden") return <Frame><div className="ds-card"><div className="ds-call warn">Not available.</div></div></Frame>;
  if (state === "error") return <Frame><div className="ds-card"><div className="ds-call danger">Couldn&apos;t load analytics. <button className="ds-link" onClick={load}>Try again</button></div></div></Frame>;
  if (state === "loading" || !data) return <Frame><div className="ds-card"><SkeletonRows rows={6} /></div></Frame>;

  const { adoption: ad, activity: act, remote: rm, engagement: en, features: ft, health: he, recent } = data;
  const people = Math.max(1, ad.accounts_total);
  const statusRows = (["active_7d", "active_30d", "dormant", "never"] as const).map(k => ({ k, n: act.status[k] }));

  return (
    <Frame>
      <div className="ds-metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <MetricCard label="accounts" value={ad.accounts_total} note={`${ad.accounts_verified} verified`} />
        <MetricCard label="daily active" value={act.dau} note="last 24 h" accent />
        <MetricCard label="weekly active" value={act.wau} note="last 7 days" />
        <MetricCard label="monthly active" value={act.mau} note="last 30 days" />
        <MetricCard label="Remote users" value={rm.accounts_with_devices} note={`${rm.accounts_entitled} with access`} />
      </div>

      <div className="ds-col">
        <UsersCard />

        <div className="ds-grid">
          <section className="ds-card">
            <h2 className="ds-cardh">Activity</h2>
            <p className="ds-cardsub">{act.derived_from}</p>
            {statusRows.map(({ k, n }) => (
              <div key={k} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span><Chip tone={STATUS_TONE[k]}>{STATUS_LABEL[k]}</Chip></span>
                  <span className="ds-mono" style={{ fontWeight: 600 }}>{n}</span>
                </div>
                <div className="ds-hbar"><div style={{ width: `${Math.round((n / people) * 100)}%` }} /></div>
              </div>
            ))}
            <Metric k="agents per account (0 / 1 / 2 / 3+)" v={`${ad.agents_per_account.none} / ${ad.agents_per_account.one} / ${ad.agents_per_account.two} / ${ad.agents_per_account.three_plus}`} />
            <Metric k="live agents" v={`${ad.agents_total} (avg ${ad.avg_agents_per_account} per account with one)`} />
          </section>

          <section className="ds-card">
            <h2 className="ds-cardh">Back Channel Remote</h2>
            <p className="ds-cardsub">Relayed connections per day, last 7 days (UTC). Counts only.</p>
            <Bars rows={rm.connections_per_day_7d} />
            <Metric k="accounts with devices" v={rm.accounts_with_devices} />
            <Metric k="accounts with remote access" v={rm.accounts_entitled} />
            <Metric k="PCs / phones registered" v={`${rm.devices.pcs} / ${rm.devices.phones}`} />
            <Metric k="devices revoked" v={rm.devices.revoked} />
            <Metric k="relayed connections (7d)" v={rm.connections_7d} />
          </section>
        </div>

        <div className="ds-grid">
          <section className="ds-card">
            <h2 className="ds-cardh">Growth</h2>
            <Spark data={ad.growth_sparkline_30d} label={`new accounts per day · last 30 days · ${ad.new_accounts["30d"]} total`} />
            <Metric k="new accounts (24h / 7d / 30d)" v={`${ad.new_accounts["24h"]} / ${ad.new_accounts["7d"]} / ${ad.new_accounts["30d"]}`} />
            <Metric k="new agents (24h / 7d / 30d)" v={`${ad.new_agents["24h"]} / ${ad.new_agents["7d"]} / ${ad.new_agents["30d"]}`} />
            <Metric k="unverified sign-ups" v={`${ad.accounts_pending} (${he.pending_signups_24h} in 24h)`} />
            {ad.accounts_reserved > 0 && <Metric k="reserved handles (not counted)" v={ad.accounts_reserved} />}
          </section>

          <section className="ds-card">
            <h2 className="ds-cardh">Health</h2>
            <Metric k="inbox-check adoption" v={`${he.inbox_check_adoption_pct}% (${he.accounts_with_active_agent_24h}/${he.accounts_with_agent})`} />
            <Metric k="rate-limit hits (~24h)" v={he.rate_limit_hits_24h} />
            <Metric k="email delivery (7d)" v={
              he.email_delivery?.available
                ? `${he.email_delivery.total_7d} sent · ${he.email_delivery.delivered} delivered · ${he.email_delivery.bounced} bounced`
                : "unavailable"
            } />
          </section>
        </div>

        <details className="ds-card">
          <summary className="ds-cardh" style={{ cursor: "pointer" }}>Sessions and features</summary>
          <div style={{ marginTop: 10 }}>
            <Metric k="sessions ever" v={en.sessions_total} />
            <Metric k="sessions (24h / 7d / 30d)" v={`${en.sessions["24h"]} / ${en.sessions["7d"]} / ${en.sessions["30d"]}`} />
            <Metric k="active sessions now" v={en.active_sessions_now} />
            <Metric k="median session (30d)" v={en.median_session_minutes_30d === null ? "—" : `${en.median_session_minutes_30d} min`} />
            <Metric k="frames buffered now" v={en.frames_buffered_total} />
            <Metric k="trust rows / mutual pairs" v={`${ft.trust_rows} / ${ft.trust_pairs_mutual}`} />
            <Metric k="inbox requests (7d)" v={ft.inbox_requests_7d} />
            <Metric k="skill shares" v={ft.skill_shares_total} />
            {ft.top_shared_skills.length > 0 && <Metric k="top shared skills" v={ft.top_shared_skills.map((x) => `${x.name} (${x.shares})`).join(", ")} />}
            <Metric k="scheduling (negotiated / booked, 7d)" v={`${ft.schedule_negotiated_7d} / ${ft.schedule_booked_7d}`} />
            <Metric k="exchange codes (7d) issued → redeemed" v={`${ft.exchange_code_7d.issued} → ${ft.exchange_code_7d.redeemed}`} />
            <Metric k="magic links issued → redeemed" v={`${ft.magic_link_alltime.issued} → ${ft.magic_link_alltime.redeemed}`} />
            <h3 className="ds-cardh" style={{ marginTop: 14, fontSize: 13.5 }}>Recent sessions</h3>
            {recent.sessions.length === 0 && <p className="ds-fine">None yet.</p>}
            {recent.sessions.map((r, i) => (
              <div key={i} className="ds-item" style={{ justifyContent: "space-between", alignItems: "baseline", padding: "8px 0" }}>
                <span className="ds-imeta" style={{ marginTop: 0, fontFamily: "var(--ds-mono)", overflowWrap: "anywhere" }}>{r.status} · {r.scopes.join(", ") || "(no scopes)"}</span>
                <span className="ds-imeta" style={{ marginTop: 0, whiteSpace: "nowrap" }}>{ago(r.started_at)}</span>
              </div>
            ))}
          </div>
        </details>

        <div className="ds-call ok">🔒 {data.privacy_note}</div>
        <p className="ds-fine" style={{ textAlign: "center", margin: 0 }}>generated {ago(data.generated_at)}{data.cached ? " · cached up to 60 s" : ""} · <button className="ds-link" onClick={load}>refresh</button></p>
      </div>
    </Frame>
  );
}

/** One page (≤200) of users, searchable by handle or email, with a per-row Remote access switch. */
function UsersCard() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"created" | "handle" | "last_active">("created");
  const [reply, setReply] = useState<UsersReply | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => { const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const serverSort = sort === "handle" ? "handle" : "created";
  const load = useCallback(async () => {
    setState("loading");
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: serverSort });
      if (query) params.set("q", query);
      const r = await fetch(`/api/admin/users?${params}`, { credentials: "include", cache: "no-store" });
      if (!r.ok) { setState("error"); return; }
      setReply(await r.json()); setState("ok");
    } catch { setState("error"); }
  }, [page, query, serverSort]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const list = reply?.users ?? [];
    if (sort !== "last_active") return list;
    return [...list].sort((a, b) => new Date(b.last_active_at ?? 0).getTime() - new Date(a.last_active_at ?? 0).getTime());
  }, [reply, sort]);

  async function setAccess(u: UserRow, active: boolean) {
    setBusy(u.handle); setMessage("");
    try {
      const r = await fetch("/api/appbridge/v1/admin/entitlements", {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ handle: u.handle, active }),
      });
      if (!r.ok) { setMessage(r.status === 403 ? "Not allowed. Sign in again and retry." : `Couldn't change remote access for ${u.handle}.`); return; }
      setReply(prev => prev && { ...prev, users: prev.users.map(x => x.handle === u.handle ? { ...x, remote: { ...x.remote, entitled: active } } : x) });
      setMessage(`Remote access ${active ? "on" : "off"} for ${u.handle}.`);
    } catch { setMessage(`Couldn't change remote access for ${u.handle}.`); }
    finally { setBusy(null); }
  }

  const total = reply?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sticky: React.CSSProperties = { position: "sticky", left: 0, background: "var(--ds-card)", zIndex: 1 };

  return (
    <section className="ds-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <h2 className="ds-cardh" style={{ margin: 0 }}>Users {reply ? `(${total})` : ""}</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <label htmlFor="admin-user-search" className="ds-fine" style={{ position: "absolute", left: -9999 }}>Search users</label>
          <input id="admin-user-search" className="ds-input" type="search" value={q} maxLength={100} placeholder="Search handle or email"
            onChange={(e) => setQ(e.target.value)} style={{ width: 220, maxWidth: "100%", padding: "6px 10px", fontSize: 13 }} />
          <select className="ds-select" aria-label="Sort users" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ padding: "6px 8px", fontSize: 13 }}>
            <option value="created">Newest</option>
            <option value="handle">Handle A–Z</option>
            <option value="last_active">Last active (this page)</option>
          </select>
        </div>
      </div>

      {state === "error" && <div className="ds-call danger" style={{ marginBottom: 10 }}>Couldn&apos;t load users. <button className="ds-link" onClick={load}>Try again</button></div>}
      {state === "loading" && !reply && <SkeletonRows rows={5} />}

      {reply && (
        <div className="ds-table-wrap" style={{ opacity: state === "loading" ? 0.6 : 1 }}>
          <table className="ds-table">
            <thead><tr>
              <th style={sticky}>handle</th><th>email</th><th>plan</th><th>created</th><th>verified</th><th>last active</th><th>status</th>
              <th title="Live agent keys">agents</th><th title="Registered PCs (revoked)">PCs</th><th title="Registered phones (revoked)">phones</th>
              <th>remote access</th><th title="Relayed connections, last 7 days">relays 7d</th><th>last relay</th>
            </tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.handle}>
                  <td className="strong" style={sticky}>{u.handle}</td>
                  <td>{u.email}</td>
                  <td>{u.plan ?? "—"}</td>
                  <td title={u.created_at}>{day(u.created_at)}</td>
                  <td>{u.email_verified_at ? <span title={u.email_verified_at}>✓</span> : <span className="ds-fine">no</span>}</td>
                  <td title={u.active_via.length ? `via ${u.active_via.map(v => VIA_LABEL[v] ?? v).join(", ")}` : undefined}>{ago(u.last_active_at)}</td>
                  <td><Chip tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Chip></td>
                  <td className="num">{u.agents}</td>
                  <td className="num">{u.remote.pcs}{u.remote.pcs_revoked ? <span className="ds-fine"> ({u.remote.pcs_revoked})</span> : null}</td>
                  <td className="num">{u.remote.phones}{u.remote.phones_revoked ? <span className="ds-fine"> ({u.remote.phones_revoked})</span> : null}</td>
                  <td>
                    <button
                      type="button" role="switch" aria-checked={u.remote.entitled}
                      aria-label={`Remote access for ${u.handle}`}
                      className={u.remote.entitled ? "ds-btn" : "ds-btn ghost"}
                      style={{ fontSize: 12, padding: "3px 10px", minWidth: 52 }}
                      disabled={busy === u.handle || u.reserved}
                      onClick={() => setAccess(u, !u.remote.entitled)}
                    >{busy === u.handle ? "…" : u.remote.entitled ? "On" : "Off"}</button>
                  </td>
                  <td className="num">{u.remote.connections_7d}</td>
                  <td>{ago(u.remote.last_connection_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reply && rows.length === 0 && <p className="ds-fine" style={{ marginTop: 8 }}>No users match.</p>}
      {message && <p className="ds-fine" style={{ marginTop: 8 }} aria-live="polite">{message}</p>}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <p className="ds-fine" style={{ margin: 0 }}>
          Remote access lets an account&apos;s paired devices connect through the relay. The relay-wide switch is APPBRIDGE_REMOTE_ACCESS. Plan shows once billing exists.
        </p>
        {pages > 1 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="ds-btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="ds-fine">{page} / {pages}</span>
            <button className="ds-btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </div>
    </section>
  );
}
