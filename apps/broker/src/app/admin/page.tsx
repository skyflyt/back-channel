"use client";

import { useCallback, useEffect, useState } from "react";

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
    pending_signups_24h: number; email_delivery: unknown; rate_limit_hits_24h: unknown;
  };
  recent: { signups: { at: string; handle: string; verified: boolean }[]; sessions: { started_at: string; scopes: string[]; status: string }[] };
  privacy_note: string;
};

const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

function Spark({ data }: { data: number[] }) {
  const w = 280, h = 44, max = Math.max(1, ...data), n = data.length;
  const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - (v / max) * (h - 6) - 3}`).join(" ");
  const total = data.reduce((a, b) => a + b, 0);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
        <polyline points={pts} fill="none" stroke="#0f766e" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <p style={s.sparkCap}>new accounts/day · last 30d · {total} total</p>
    </div>
  );
}

export default function AdminPage() {
  const [data, setData] = useState<Analytics | null>(null);
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
  useEffect(() => { load(); }, [load]);

  if (state === "unauth") return <Shell><p style={s.muted}>Sign in first — <a href="/login" style={s.link}>/login</a>.</p></Shell>;
  if (state === "forbidden") return <Shell><p style={s.muted}>This account isn&apos;t an admin.</p></Shell>;
  if (state === "error") return <Shell><p style={s.err}>Couldn&apos;t load analytics.</p></Shell>;
  if (state === "loading" || !data) return <Shell><p style={s.muted}>Loading…</p></Shell>;

  const { adoption: ad, engagement: en, features: ft, health: he, recent } = data;
  const Metric = ({ k, v }: { k: string; v: unknown }) => (
    <div style={s.metric}><span style={s.k}>{k}</span><span style={s.v}>{v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</span></div>
  );

  return (
    <Shell>
      {/* Headline: is anyone besides me using this? */}
      <div style={s.bigRow}>
        <Big n={ad.accounts_total} label="total accounts" />
        <Big n={ad.active_accounts["7d"]} label="active · 7d" />
        <Big n={ad.new_accounts["7d"]} label="new · 7d" />
        <Big n={ad.agents_total} label="agents" />
      </div>

      <section style={s.card}>
        <h2 style={s.h2}>Adoption</h2>
        <Spark data={ad.growth_sparkline_30d} />
        <Metric k="total accounts" v={`${ad.accounts_total} (${ad.accounts_verified} verified, ${ad.accounts_pending} pending)`} />
        <Metric k="new accounts (24h / 7d / 30d)" v={`${ad.new_accounts["24h"]} / ${ad.new_accounts["7d"]} / ${ad.new_accounts["30d"]}`} />
        <Metric k="active accounts (24h / 7d / 30d)" v={`${ad.active_accounts["24h"]} / ${ad.active_accounts["7d"]} / ${ad.active_accounts["30d"]}`} />
        <Metric k="registered agents" v={`${ad.agents_total} (avg ${ad.avg_agents_per_account}/account)`} />
        <Metric k="new agents (24h / 7d / 30d)" v={`${ad.new_agents["24h"]} / ${ad.new_agents["7d"]} / ${ad.new_agents["30d"]}`} />
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>Engagement</h2>
        <Metric k="sessions ever" v={en.sessions_total} />
        <Metric k="sessions (24h / 7d / 30d)" v={`${en.sessions["24h"]} / ${en.sessions["7d"]} / ${en.sessions["30d"]}`} />
        <Metric k="active sessions now" v={en.active_sessions_now} />
        <Metric k="median session (30d)" v={en.median_session_minutes_30d === null ? "—" : `${en.median_session_minutes_30d} min`} />
        <Metric k="frames buffered now" v={`${en.frames_buffered_total} — ${Object.entries(en.frames_buffered_by_type).map(([t, c]) => `${t}:${c}`).join(", ") || "none"}`} />
        <p style={s.fine}>{en.frames_note}</p>
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>Feature usage</h2>
        <Metric k="trust rows / mutual pairs" v={`${ft.trust_rows} / ${ft.trust_pairs_mutual}`} />
        <Metric k="inbox requests (7d)" v={ft.inbox_requests_7d} />
        <Metric k="skill shares" v={ft.skill_shares_total} />
        {ft.top_shared_skills.length > 0 && <Metric k="top shared skills" v={ft.top_shared_skills.map((x) => `${x.name} (${x.shares})`).join(", ")} />}
        <Metric k="scheduling (negotiated / booked, 7d)" v={`${ft.schedule_negotiated_7d} / ${ft.schedule_booked_7d}`} />
        <Metric k="exchange codes (7d): issued→redeemed" v={`${ft.exchange_code_7d.issued} → ${ft.exchange_code_7d.redeemed}${ft.exchange_code_7d.rate_pct === null ? "" : ` (${ft.exchange_code_7d.rate_pct}%)`}`} />
        <Metric k="magic links (all-time): issued→redeemed" v={`${ft.magic_link_alltime.issued} → ${ft.magic_link_alltime.redeemed}${ft.magic_link_alltime.rate_pct === null ? "" : ` (${ft.magic_link_alltime.rate_pct}%)`}`} />
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>Health</h2>
        <Metric k="inbox-check adoption" v={`${he.inbox_check_adoption_pct}% (${he.accounts_with_active_agent_24h}/${he.accounts_with_agent} accounts active in 24h)`} />
        <Metric k="pending (unverified) signups 24h" v={he.pending_signups_24h} />
        <Metric k="email delivery (7d)" v={he.email_delivery} />
        <Metric k="rate-limit hits (24h)" v={he.rate_limit_hits_24h} />
        <p style={s.fine}>— = not instrumented in v1 (email results + rate-limit counters aren&apos;t persisted to the DB yet).</p>
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>Recent sign-ups</h2>
        {recent.signups.length === 0 && <p style={s.muted}>None yet.</p>}
        {recent.signups.map((r, i) => (
          <div key={i} style={s.row}><span style={s.rowHandle}>{r.handle}</span><span style={s.rowMeta}>{r.verified ? "✓ verified" : "pending"} · {ago(r.at)}</span></div>
        ))}
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>Recent sessions</h2>
        {recent.sessions.length === 0 && <p style={s.muted}>None yet.</p>}
        {recent.sessions.map((r, i) => (
          <div key={i} style={s.row}><span style={s.rowHandle}>{r.status === "active" ? "🟢" : "⚪"} {r.scopes.join(", ") || "(no scopes)"}</span><span style={s.rowMeta}>{ago(r.started_at)}</span></div>
        ))}
      </section>

      <p style={s.footer}>🔒 {data.privacy_note}</p>
      <p style={s.gen}>generated {ago(data.generated_at)}{data.cached ? " · cached" : ""} · <button style={s.refresh} onClick={load}>refresh</button></p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main style={s.page}><div style={s.wrap}><h1 style={s.h1}>Operator analytics</h1>{children}</div></main>;
}
function Big({ n, label }: { n: number; label: string }) {
  return <div style={s.big}><div style={s.bigN}>{n}</div><div style={s.bigL}>{label}</div></div>;
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" } as const,
  wrap: { maxWidth: 760, margin: "0 auto" } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: "0 0 18px" } as const,
  h2: { fontSize: 15, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" } as const,
  bigRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 14 } as const,
  big: { background: "#0f172a", borderRadius: 14, padding: "18px 16px", textAlign: "center" } as const,
  bigN: { fontSize: 34, fontWeight: 800, color: "#fff", lineHeight: 1 } as const,
  bigL: { fontSize: 12, color: "#94a3b8", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.04em" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 20, marginBottom: 14 } as const,
  metric: { display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #f1f5f9", fontSize: 14 } as const,
  k: { color: "#64748b" } as const,
  v: { color: "#0f172a", fontWeight: 600, fontFamily: "ui-monospace, Menlo, monospace", textAlign: "right", wordBreak: "break-word" } as const,
  sparkCap: { fontSize: 12, color: "#94a3b8", margin: "2px 0 10px", textAlign: "right" } as const,
  fine: { fontSize: 12, color: "#94a3b8", margin: "8px 0 0", lineHeight: 1.5 } as const,
  row: { display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #f1f5f9", fontSize: 14 } as const,
  rowHandle: { color: "#0f172a", fontFamily: "ui-monospace, Menlo, monospace" } as const,
  rowMeta: { color: "#94a3b8", fontSize: 13, whiteSpace: "nowrap" } as const,
  footer: { fontSize: 13, color: "#0f766e", background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: "12px 14px", marginTop: 8 } as const,
  gen: { fontSize: 12, color: "#94a3b8", textAlign: "center", marginTop: 10 } as const,
  refresh: { background: "none", border: "none", color: "#0f766e", textDecoration: "underline", cursor: "pointer", fontSize: 12 } as const,
  muted: { color: "#94a3b8" } as const,
  link: { color: "#0f766e" } as const,
  err: { color: "#b91c1c" } as const,
};
