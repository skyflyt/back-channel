"use client";

import { useCallback, useEffect, useState } from "react";

type Analytics = {
  period: string; generated_at: string;
  growth: Record<string, number>; activity: Record<string, unknown>;
  trust_inbox: Record<string, unknown>; skills: Record<string, number>;
  funnel: Record<string, number>; note: string;
};

const PERIODS = ["24h", "7d", "30d", "all"];

export default function AdminPage() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<Analytics | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "forbidden" | "error">("loading");

  const load = useCallback(async (p: string) => {
    try {
      const r = await fetch(`/api/admin/analytics?period=${p}`, { credentials: "include" });
      if (r.status === 401) { setState("unauth"); return; }
      if (r.status === 403) { setState("forbidden"); return; }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ok");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  if (state === "unauth") return <main style={s.page}><div style={s.wrap}><h1 style={s.h1}>Admin</h1><p style={s.muted}>Sign in first — <a href="/login" style={s.link}>/login</a>.</p></div></main>;
  if (state === "forbidden") return <main style={s.page}><div style={s.wrap}><h1 style={s.h1}>Admin</h1><p style={s.muted}>This account isn&apos;t an admin.</p></div></main>;
  if (state === "error") return <main style={s.page}><div style={s.wrap}><p style={s.err}>Couldn&apos;t load analytics.</p></div></main>;

  const Card = ({ title, rows }: { title: string; rows: [string, unknown][] }) => (
    <section style={s.card}>
      <h2 style={s.h2}>{title}</h2>
      {rows.map(([k, v]) => (
        <div key={k} style={s.metric}><span style={s.k}>{k.replace(/_/g, " ")}</span><span style={s.v}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span></div>
      ))}
    </section>
  );

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <div style={s.head}>
          <h1 style={s.h1}>Operator analytics</h1>
          <div style={s.periods}>{PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={p === period ? s.pOn : s.pOff}>{p}</button>
          ))}</div>
        </div>
        {state === "loading" || !data ? <p style={s.muted}>Loading…</p> : (
          <>
            <Card title="Growth" rows={Object.entries(data.growth)} />
            <Card title="Activity" rows={Object.entries(data.activity)} />
            <Card title="Trust & Inbox" rows={Object.entries(data.trust_inbox)} />
            <Card title="Skills" rows={Object.entries(data.skills)} />
            <Card title="Onboarding funnel" rows={Object.entries(data.funnel)} />
            <p style={s.footer}>🔒 {data.note}</p>
          </>
        )}
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" } as const,
  wrap: { maxWidth: 720, margin: "0 auto" } as const,
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 18 } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  h2: { fontSize: 15, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" } as const,
  periods: { display: "flex", gap: 6 } as const,
  pOn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer" } as const,
  pOff: { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 20, marginBottom: 14 } as const,
  metric: { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderBottom: "1px solid #f1f5f9", fontSize: 14 } as const,
  k: { color: "#64748b" } as const,
  v: { color: "#0f172a", fontWeight: 600, fontFamily: "ui-monospace, Menlo, monospace", textAlign: "right", wordBreak: "break-all" } as const,
  footer: { fontSize: 13, color: "#0f766e", background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: "12px 14px", marginTop: 8 } as const,
  muted: { color: "#94a3b8" } as const,
  link: { color: "#0f766e" } as const,
  err: { color: "#b91c1c" } as const,
};
