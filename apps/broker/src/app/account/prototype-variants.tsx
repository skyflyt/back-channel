"use client";

/**
 * PROTOTYPE — throwaway. Branch: proto/logged-in-redesign.
 *
 * Plan: "Three radically different redesigns of the logged-in app, rendered on the
 * existing /account route with its real data, switchable via ?variant=a|b|c and a
 * floating bottom switcher. Dev-only (hidden in production builds)."
 *
 * Question being answered: what should the logged-in Back Channel app LOOK like as a
 * modern SaaS product? (Structure/nav/hierarchy — not backend behavior.)
 *
 * Rules (see matt-pocock/prototype UI.md):
 *  - Read-only: every mutation is stubbed with a toast. No fetches happen here.
 *  - Real data flows in from page.tsx when signed in; a demo fixture renders otherwise
 *    so the design is previewable without a local Postgres/login.
 *  - Delete this file + the small page.tsx hook once a direction wins.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

/* ================================ registry ================================ */

export type VariantKey = "current" | "a" | "b" | "c";
const ORDER: VariantKey[] = ["current", "a", "b", "c"];
const NAME: Record<VariantKey, string> = {
  current: "Current UI",
  a: "Operator — command rail",
  b: "Mission Control — dashboard",
  c: "Correspondence — split-pane inbox",
};

const DEV = process.env.NODE_ENV !== "production";

/* ============================ hook + switcher ============================= */

export function usePrototypeVariant(): { variant: VariantKey; setVariant: (v: VariantKey) => void } | null {
  const [variant, set] = useState<VariantKey>(() => {
    if (typeof window === "undefined") return "current";
    const v = new URLSearchParams(window.location.search).get("variant");
    return v === "a" || v === "b" || v === "c" ? v : "current";
  });
  const setVariant = useCallback((v: VariantKey) => {
    set(v);
    const url = new URL(window.location.href);
    if (v === "current") url.searchParams.delete("variant");
    else url.searchParams.set("variant", v);
    window.history.replaceState({}, "", url.pathname + url.search);
  }, []);
  if (!DEV) return null;
  return { variant, setVariant };
}

export function PrototypeSwitcher({ current, setVariant }: { current: VariantKey; setVariant: (v: VariantKey) => void }) {
  const cycle = useCallback((dir: 1 | -1) => {
    const i = ORDER.indexOf(current);
    setVariant(ORDER[(i + dir + ORDER.length) % ORDER.length]);
  }, [current, setVariant]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  if (!DEV) return null;
  const arrow: React.CSSProperties = {
    background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14,
    padding: "10px 12px", lineHeight: 1, borderRadius: 999,
  };
  return (
    <div style={{
      position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 99999,
      display: "flex", alignItems: "center", gap: 2, background: "#111214", color: "#fff",
      borderRadius: 999, boxShadow: "0 8px 30px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08)",
      padding: "2px 6px", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12.5, whiteSpace: "nowrap",
    }}>
      <button style={arrow} onClick={() => cycle(-1)} aria-label="Previous variant">◀</button>
      <span style={{ padding: "0 8px", opacity: 0.55 }}>?variant=</span>
      <span style={{ fontWeight: 700 }}>{current === "current" ? "—" : current.toUpperCase()}</span>
      <span style={{ padding: "0 10px 0 8px", opacity: 0.9 }}>{NAME[current]}</span>
      <button style={arrow} onClick={() => cycle(1)} aria-label="Next variant">▶</button>
    </div>
  );
}

/* ========================= data shapes + demo data ======================== */

export interface ProtoData {
  me: { handle: string; display_name?: string | null; email?: string };
  active: ProtoThread[];
  recent: ProtoThread[];
  trust: ProtoFriend[];
  inbox: ProtoReq[];
  skills: ProtoTool[];
  discover: ProtoTool[];
  sharedWithMe: ProtoTool[];
  agents: ProtoAgent[];
}
interface ProtoThread {
  session_id: string; peer_handle: string; goal: string | null; started_at: string;
  ended_at?: string | null; duration_min?: number | null; end_reason?: string | null;
  unread_count?: number; live?: boolean; peer_present?: boolean; peer_ever_connected?: boolean;
}
interface ProtoFriend { handle: string; last_session_at: string; trusted: boolean; mutual: boolean }
interface ProtoReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string }
interface ProtoTool {
  id: string; name: string; description?: string | null; kind: string;
  shared_with?: string[]; discoverable?: boolean; owner_handle?: string; public_token?: string | null;
}
interface ProtoAgent { id: string; name: string; runtime_type: string; created_at: string; last_used_at: string | null }

const mins = (n: number) => new Date(Date.now() - n * 60000).toISOString();

function demoData(): ProtoData {
  return {
    me: { handle: "skylar@bc", display_name: "Skylar", email: "skylar@example.com" },
    agents: [
      { id: "ag1", name: "Loby (Cowork)", runtime_type: "cowork", created_at: mins(60 * 24 * 40), last_used_at: mins(4) },
      { id: "ag2", name: "Claude Code — laptop", runtime_type: "claude_code", created_at: mins(60 * 24 * 12), last_used_at: mins(52) },
      { id: "ag3", name: "Codex at work", runtime_type: "codex", created_at: mins(60 * 24 * 30), last_used_at: mins(60 * 26) },
    ],
    active: [
      { session_id: "t1", peer_handle: "maren@bc", goal: "Compare notes on Cloud Run cold-start tuning", started_at: mins(130), unread_count: 2, peer_ever_connected: true, peer_present: false },
      { session_id: "t2", peer_handle: "devon@bc", goal: "Draft the joint grant outline for the tools workshop", started_at: mins(60 * 26), peer_ever_connected: false },
      { session_id: "t3", peer_handle: "priya@bc", goal: "Weekly digest swap — agent automation news", started_at: mins(190), peer_ever_connected: true, peer_present: true, live: true },
    ],
    recent: [
      { session_id: "r1", peer_handle: "jordan@bc", goal: "Trade CI flake-hunting prompts", started_at: mins(60 * 24 * 3), ended_at: mins(60 * 24 * 3 - 42), duration_min: 42, end_reason: "completed" },
      { session_id: "r2", peer_handle: "maren@bc", goal: "Review each other's backup strategy", started_at: mins(60 * 24 * 6), ended_at: mins(60 * 24 * 6 - 18), duration_min: 18, end_reason: "completed" },
      { session_id: "r3", peer_handle: "priya@bc", goal: "Swap reading lists", started_at: mins(60 * 24 * 12), ended_at: mins(60 * 24 * 12 - 9), duration_min: 9, end_reason: "expired" },
    ],
    trust: [
      { handle: "maren@bc", last_session_at: mins(130), trusted: true, mutual: true },
      { handle: "priya@bc", last_session_at: mins(190), trusted: true, mutual: true },
      { handle: "jordan@bc", last_session_at: mins(60 * 24 * 3), trusted: true, mutual: true },
      { handle: "devon@bc", last_session_at: mins(60 * 26), trusted: true, mutual: false },
    ],
    inbox: [
      { id: "q1", requester_handle: "jordan@bc", scopes: ["config.read", "config.suggest"], message: "Can my agent pull your deploy checklist and suggest tweaks?", created_at: mins(35) },
    ],
    skills: [
      { id: "s1", name: "Deploy checklist", description: "Pre-flight checks my agent runs before any production deploy.", kind: "template", shared_with: ["maren@bc"], discoverable: true },
      { id: "s2", name: "Standup summarizer", description: "Runs with a friend's agent to merge both sides' notes into one standup digest.", kind: "rpc", shared_with: [], discoverable: false },
      { id: "s3", name: "Release-notes drafter", description: "Turns merged PR titles into friendly release notes.", kind: "template", shared_with: [], discoverable: true, public_token: "pub_abc" },
      { id: "s4", name: "Inbox triage rules", description: "How my agent sorts incoming Back Channel requests.", kind: "template", shared_with: [], discoverable: false },
    ],
    sharedWithMe: [
      { id: "sw1", name: "Meeting-prep brief", description: "Builds a one-page brief before any call.", kind: "template", owner_handle: "maren@bc" },
      { id: "sw2", name: "Paper-fetcher", description: "Fetches and summarizes new arXiv papers on a topic.", kind: "rpc", owner_handle: "priya@bc" },
    ],
    discover: [
      { id: "d1", name: "Changelog watcher", description: "Watches dependencies for breaking changes.", kind: "template", owner_handle: "jordan@bc" },
      { id: "d2", name: "Recipe scaler", description: "Scales any recipe and builds a grocery list.", kind: "template", owner_handle: "priya@bc" },
      { id: "d3", name: "Trip splitter", description: "Runs with a friend to settle shared trip expenses.", kind: "rpc", owner_handle: "maren@bc" },
    ],
  };
}

/* ============================= shared helpers ============================= */

const short = (h: string) => h.replace(/@bc$/, "");
const initials = (h: string) => short(h).slice(0, 2).toUpperCase();

function ago(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

type Health = { key: "active" | "idle" | "sleeping" | "stale" | "new"; label: string; color: string };
function health(lastUsedAt: string | null): Health {
  if (!lastUsedAt) return { key: "new", label: "Never used", color: "#94a3b8" };
  const m = (Date.now() - new Date(lastUsedAt).getTime()) / 60000;
  if (m < 15) return { key: "active", label: "Active", color: "#10b981" };
  if (m < 120) return { key: "idle", label: "Idle", color: "#eab308" };
  if (m < 1440) return { key: "sleeping", label: "Sleeping", color: "#f97316" };
  return { key: "stale", label: "Stale", color: "#ef4444" };
}

type Turn = { key: "yours" | "theirs" | "connecting"; label: string };
function turn(t: ProtoThread): Turn {
  if ((t.unread_count ?? 0) > 0) return { key: "yours", label: "Your turn" };
  if (t.peer_ever_connected === false) return { key: "connecting", label: `Waiting for ${short(t.peer_handle)}` };
  return { key: "theirs", label: `With ${short(t.peer_handle)}'s agent` };
}

/** All variants are read-only — every action lands here. */
function useStub(): [string, (label: string) => void] {
  const [toast, setToast] = useState("");
  const stub = useCallback((label: string) => {
    setToast(label);
    window.setTimeout(() => setToast(""), 1900);
  }, []);
  return [toast, stub];
}

function StubToast({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 99998,
      background: "#111214", color: "#fff", borderRadius: 10, padding: "9px 16px",
      fontSize: 13, boxShadow: "0 8px 30px rgba(0,0,0,.3)", fontFamily: "system-ui, sans-serif",
    }}>
      Prototype — “{msg}” is stubbed (read-only preview)
    </div>
  );
}

function DemoBanner() {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 99997, textAlign: "center",
      background: "#fef3c7", color: "#92400e", borderBottom: "1px solid #fde68a",
      fontSize: 12, padding: "4px 10px", fontFamily: "system-ui, sans-serif",
    }}>
      Previewing with <strong>demo data</strong> — sign in (needs a local DB) to see your real account here.
    </div>
  );
}

/* ====================================================================== */
/* VARIANT A — “Operator”: Linear-style dark command rail + dense triage  */
/* Hierarchy bet: ONE unified work queue (“Triage”) is the home screen;   */
/* everything else is a secondary library reached from the rail.          */
/* ====================================================================== */

const CSS_A = `
.pva { --rail:#101113; --rail-line:#26272b; --rail-text:#9a9ea7; --rail-hi:#e8e9ed;
  --bg:#fcfcfd; --line:#e9eaec; --ink:#1f2023; --mut:#6b6f76; --acc:#5e6ad2; --acc-bg:#eef0fb;
  font-family:'Inter',-apple-system,'Segoe UI',system-ui,sans-serif; color:var(--ink);
  display:flex; min-height:100vh; background:var(--bg); font-size:13.5px; letter-spacing:-0.01em; }
.pva-rail { width:232px; flex-shrink:0; background:var(--rail); color:var(--rail-text);
  display:flex; flex-direction:column; padding:14px 10px; position:sticky; top:0; height:100vh; box-sizing:border-box; }
.pva-brand { color:var(--rail-hi); font-weight:600; font-size:13.5px; padding:6px 10px 16px; display:flex; align-items:center; gap:8px; }
.pva-brand span.k { background:#26272b; color:#9a9ea7; border-radius:4px; font-size:10px; padding:2px 5px; font-family:ui-monospace,monospace; }
.pva-grp { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; padding:14px 10px 5px; color:#5f636b; }
.pva-nav { display:flex; align-items:center; gap:9px; width:100%; text-align:left; background:none; border:none;
  color:var(--rail-text); padding:6px 10px; border-radius:6px; cursor:pointer; font-size:13px; font-family:inherit; }
.pva-nav:hover { background:#1b1c20; color:var(--rail-hi); }
.pva-nav.on { background:#232631; color:var(--rail-hi); }
.pva-nav .n { margin-left:auto; background:#2b2d33; border-radius:8px; font-size:10.5px; padding:1px 7px; color:#c8cad0; }
.pva-nav.on .n { background:var(--acc); color:#fff; }
.pva-user { margin-top:auto; border-top:1px solid var(--rail-line); padding:12px 10px 2px; display:flex; align-items:center; gap:9px; }
.pva-ava { width:26px; height:26px; border-radius:6px; background:linear-gradient(135deg,#5e6ad2,#8b5cf6);
  color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
.pva-main { flex:1; min-width:0; }
.pva-top { display:flex; align-items:center; gap:14px; padding:10px 26px; border-bottom:1px solid var(--line);
  position:sticky; top:0; background:rgba(252,252,253,.92); backdrop-filter:blur(6px); z-index:5; }
.pva-title { font-weight:600; font-size:14px; }
.pva-search { flex:1; max-width:420px; margin-left:auto; display:flex; align-items:center; gap:8px; border:1px solid var(--line);
  border-radius:7px; padding:5px 10px; color:var(--mut); background:#fff; }
.pva-search input { border:none; outline:none; flex:1; font:inherit; color:var(--ink); background:transparent; }
.pva-search .k { font-family:ui-monospace,monospace; font-size:10.5px; background:#f1f2f4; border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
.pva-cta { background:var(--acc); color:#fff; border:none; border-radius:7px; padding:6px 13px; font:inherit; font-weight:600; cursor:pointer; }
.pva-cta:hover { filter:brightness(1.08); }
.pva-body { max-width:880px; margin:0 auto; padding:22px 26px 90px; }
.pva-sec { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); font-weight:600;
  padding:20px 2px 7px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; }
.pva-sec .n { background:var(--acc-bg); color:var(--acc); border-radius:8px; padding:1px 7px; font-size:10.5px; }
.pva-row { display:flex; align-items:center; gap:11px; padding:9px 2px; border-bottom:1px solid var(--line); }
.pva-row:hover { background:#f7f8f9; }
.pva-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.pva-who { font-weight:600; white-space:nowrap; }
.pva-goal { color:var(--mut); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.pva-meta { color:#9aa0a6; font-size:12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.pva-pill { font-size:11px; border-radius:6px; padding:2px 8px; white-space:nowrap; }
.pva-pill.yours { background:var(--acc-bg); color:var(--acc); font-weight:600; }
.pva-pill.wait { background:#fff7ed; color:#c2410c; }
.pva-pill.calm { background:#f1f2f4; color:var(--mut); }
.pva-pill.live { background:#ecfdf5; color:#059669; font-weight:600; }
.pva-act { background:none; border:1px solid var(--line); border-radius:6px; padding:4px 10px; font:inherit; font-size:12px;
  color:var(--ink); cursor:pointer; white-space:nowrap; }
.pva-act:hover { border-color:#c9ccd1; background:#fff; }
.pva-act.pri { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
.pva-empty { color:var(--mut); padding:14px 2px; font-size:13px; }
.pva-kbd { color:#9aa0a6; font-size:12px; margin-top:26px; }
@media (max-width:760px){ .pva-rail{display:none;} }
`;

function VariantA({ d }: { d: ProtoData }) {
  type View = "triage" | "inbox" | "friends" | "toolkit" | "agents" | "settings";
  const [view, setView] = useState<View>("triage");
  const [toast, stub] = useStub();

  const yours = d.active.filter((t) => turn(t).key === "yours");
  const waiting = d.active.filter((t) => turn(t).key !== "yours");
  const needsYou = d.inbox.length + yours.length;
  const healthy = d.agents.filter((a) => ["active", "idle"].includes(health(a.last_used_at).key)).length;

  const NavBtn = ({ v, label, count }: { v: View; label: string; count?: number }) => (
    <button className={`pva-nav${view === v ? " on" : ""}`} onClick={() => setView(v)}>
      {label}{count ? <span className="n">{count}</span> : null}
    </button>
  );

  const threadRow = (t: ProtoThread, showActions = true) => {
    const tu = turn(t);
    const color = tu.key === "yours" ? "#5e6ad2" : tu.key === "connecting" ? "#f59e0b" : "#c9ccd1";
    return (
      <div className="pva-row" key={t.session_id}>
        <span className="pva-dot" style={{ background: color }} />
        <span className="pva-who">{short(t.peer_handle)}</span>
        {t.live && <span className="pva-pill live">live</span>}
        <span className="pva-goal">{t.goal}</span>
        <span className={`pva-pill ${tu.key === "yours" ? "yours" : tu.key === "connecting" ? "wait" : "calm"}`}>{tu.label}</span>
        {showActions && (tu.key === "yours"
          ? <button className="pva-act pri" onClick={() => stub("Respond")}>Respond</button>
          : <button className="pva-act" onClick={() => stub("Nudge")}>Nudge</button>)}
        <span className="pva-meta">{ago(t.started_at)}</span>
      </div>
    );
  };

  return (
    <div className="pva">
      <style>{CSS_A}</style>
      <StubToast msg={toast} />
      <aside className="pva-rail">
        <div className="pva-brand">◇ Back Channel <span className="k">beta</span></div>
        <div className="pva-grp">Work</div>
        <NavBtn v="triage" label="Triage" count={needsYou} />
        <NavBtn v="inbox" label="Threads" count={d.active.length} />
        <NavBtn v="friends" label="Friends" count={d.trust.filter((f) => f.mutual).length} />
        <NavBtn v="toolkit" label="Toolkit" count={d.skills.length} />
        <div className="pva-grp">System</div>
        <NavBtn v="agents" label="Agents" count={d.agents.length} />
        <NavBtn v="settings" label="Settings" />
        <div className="pva-user">
          <span className="pva-ava">{initials(d.me.handle)}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "var(--rail-hi)", fontSize: 12.5, fontWeight: 600 }}>{d.me.display_name || short(d.me.handle)}</div>
            <div style={{ fontSize: 11 }}>{d.me.handle}</div>
          </div>
        </div>
      </aside>

      <div className="pva-main">
        <div className="pva-top">
          <span className="pva-title">
            {view === "triage" ? "Triage" : view === "inbox" ? "Threads" : view[0].toUpperCase() + view.slice(1)}
          </span>
          <div className="pva-search">
            <span>⌕</span><input placeholder="Search threads, friends, tools…" onKeyDown={(e) => { if (e.key === "Enter") stub("Search"); }} />
            <span className="k">Ctrl K</span>
          </div>
          <button className="pva-cta" onClick={() => stub("New message")}>＋ New message</button>
        </div>

        <div className="pva-body">
          {view === "triage" && (<>
            <div className="pva-sec">Needs your approval {d.inbox.length > 0 && <span className="n">{d.inbox.length}</span>}</div>
            {d.inbox.length === 0 && <div className="pva-empty">Nothing waiting on you. Clean slate.</div>}
            {d.inbox.map((r) => (
              <div className="pva-row" key={r.id}>
                <span className="pva-dot" style={{ background: "#5e6ad2" }} />
                <span className="pva-who">{short(r.requester_handle)}</span>
                <span className="pva-goal">{r.message ?? "wants to collaborate"} · asks: {r.scopes.join(", ")}</span>
                <button className="pva-act pri" onClick={() => stub("Approve")}>Approve</button>
                <button className="pva-act" onClick={() => stub("Decline")}>Decline</button>
                <span className="pva-meta">{ago(r.created_at)}</span>
              </div>
            ))}
            <div className="pva-sec">Your turn {yours.length > 0 && <span className="n">{yours.length}</span>}</div>
            {yours.length === 0 && <div className="pva-empty">No thread is waiting on you.</div>}
            {yours.map((t) => threadRow(t))}
            <div className="pva-sec">In flight</div>
            {waiting.length === 0 && <div className="pva-empty">No open threads.</div>}
            {waiting.map((t) => threadRow(t))}
            <p className="pva-kbd">Agents: {healthy}/{d.agents.length} healthy · ←/→ switch prototype variants</p>
          </>)}

          {view === "inbox" && (<>
            <div className="pva-sec">Open {d.active.length > 0 && <span className="n">{d.active.length}</span>}</div>
            {d.active.map((t) => threadRow(t))}
            <div className="pva-sec">Recent — last 30 days</div>
            {d.recent.map((t) => (
              <div className="pva-row" key={t.session_id}>
                <span className="pva-dot" style={{ background: "#e5e7eb" }} />
                <span className="pva-who">{short(t.peer_handle)}</span>
                <span className="pva-goal">{t.goal}</span>
                <span className="pva-meta">{t.duration_min ?? "?"} min · {t.end_reason ?? "ended"} · {t.ended_at ? ago(t.ended_at) : ""}</span>
              </div>
            ))}
          </>)}

          {view === "friends" && (<>
            <div className="pva-sec">Friends {<span className="n">{d.trust.length}</span>}</div>
            {d.trust.map((f) => (
              <div className="pva-row" key={f.handle}>
                <span className="pva-ava" style={{ width: 22, height: 22, fontSize: 10 }}>{initials(f.handle)}</span>
                <span className="pva-who">{short(f.handle)}</span>
                <span className={`pva-pill ${f.mutual ? "calm" : "wait"}`}>{f.mutual ? "mutual" : "waiting for them"}</span>
                <span className="pva-goal">last worked together {ago(f.last_session_at)} ago</span>
                <button className="pva-act pri" onClick={() => stub("Message")}>Message</button>
              </div>
            ))}
            <div style={{ marginTop: 16 }}>
              <button className="pva-act" onClick={() => stub("Invite a friend")}>＋ Invite a friend by email</button>
            </div>
          </>)}

          {view === "toolkit" && (<>
            <div className="pva-sec">Your toolkit {<span className="n">{d.skills.length}</span>}</div>
            {d.skills.map((sk) => (
              <div className="pva-row" key={sk.id}>
                <span className="pva-who">{sk.name}</span>
                <span className="pva-pill calm">{sk.kind === "rpc" ? "runs with friend" : "copyable"}</span>
                {sk.discoverable && <span className="pva-pill yours">in your circle</span>}
                {sk.public_token && <span className="pva-pill live">public link</span>}
                <span className="pva-goal">{sk.description}</span>
                <button className="pva-act" onClick={() => stub("Share")}>Share</button>
              </div>
            ))}
            <div className="pva-sec">Shared with you</div>
            {d.sharedWithMe.map((sk) => (
              <div className="pva-row" key={sk.id}>
                <span className="pva-who">{sk.name}</span>
                <span className="pva-meta">from {short(sk.owner_handle ?? "")}</span>
                <span className="pva-goal">{sk.description}</span>
                <button className="pva-act pri" onClick={() => stub("Send to my agent")}>Send to my agent</button>
              </div>
            ))}
            <div className="pva-sec">In your circle</div>
            {d.discover.map((sk) => (
              <div className="pva-row" key={sk.id}>
                <span className="pva-who">{sk.name}</span>
                <span className="pva-meta">{short(sk.owner_handle ?? "")}</span>
                <span className="pva-goal">{sk.description}</span>
                <button className="pva-act" onClick={() => stub("Ask to share")}>Ask to share</button>
              </div>
            ))}
          </>)}

          {view === "agents" && (<>
            <div className="pva-sec">Connected agents {<span className="n">{d.agents.length}</span>}</div>
            {d.agents.map((a) => {
              const h = health(a.last_used_at);
              return (
                <div className="pva-row" key={a.id}>
                  <span className="pva-dot" style={{ background: h.color }} />
                  <span className="pva-who">{a.name}</span>
                  <span className="pva-pill calm">{a.runtime_type}</span>
                  <span className="pva-goal">{h.label} · last heard {a.last_used_at ? `${ago(a.last_used_at)} ago` : "never"}</span>
                  <button className="pva-act" onClick={() => stub("Check status")}>Check</button>
                  <button className="pva-act" onClick={() => stub("Revoke")}>Revoke</button>
                </div>
              );
            })}
            <div style={{ marginTop: 16 }}>
              <button className="pva-act pri" onClick={() => stub("Connect a new agent")}>＋ Connect a new agent</button>
            </div>
          </>)}

          {view === "settings" && (<>
            <div className="pva-sec">Notifications</div>
            <div className="pva-row"><span className="pva-goal">Email me when something lands in my Inbox and my agent is asleep</span><button className="pva-act" onClick={() => stub("Toggle notifications")}>On</button></div>
            <div className="pva-sec">Agent behavior</div>
            <div className="pva-row"><span className="pva-goal">Auto-check my Back Channel Inbox</span><button className="pva-act" onClick={() => stub("Inbox check cadence")}>Every 10 min</button></div>
            <div className="pva-row"><span className="pva-goal">Live mode default window</span><button className="pva-act" onClick={() => stub("Live default")}>15 minutes</button></div>
            <div className="pva-sec">Developer</div>
            <div className="pva-row"><span className="pva-goal">API key (masked) — rotate to cut off every agent at once</span><button className="pva-act" onClick={() => stub("Rotate key")}>Rotate</button></div>
          </>)}
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== */
/* VARIANT B — “Mission Control”: Stripe-style top nav + overview grid.   */
/* Hierarchy bet: a glanceable OVERVIEW with metrics is the home screen;  */
/* the horizontal nav gives every surface equal, roomy billing.           */
/* ====================================================================== */

const CSS_B = `
.pvb { --bg:#f6f8fa; --card:#ffffff; --line:#e3e8ee; --ink:#30313d; --mut:#687385; --acc:#635bff; --acc-soft:#f0efff;
  font-family:-apple-system,'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--ink);
  min-height:100vh; font-size:14px; }
.pvb-top { background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
.pvb-topin { max-width:1080px; margin:0 auto; padding:0 24px; display:flex; align-items:center; gap:26px; height:56px; }
.pvb-brand { font-weight:700; font-size:15px; letter-spacing:-.01em; }
.pvb-tabs { display:flex; gap:4px; height:100%; }
.pvb-tab { border:none; background:none; font:inherit; color:var(--mut); cursor:pointer; padding:0 12px;
  border-bottom:2px solid transparent; height:100%; font-weight:500; }
.pvb-tab:hover { color:var(--ink); }
.pvb-tab.on { color:var(--acc); border-bottom-color:var(--acc); font-weight:600; }
.pvb-ava { margin-left:auto; width:30px; height:30px; border-radius:50%; background:linear-gradient(135deg,#635bff,#00d4ff);
  color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
.pvb-wrap { max-width:1080px; margin:0 auto; padding:28px 24px 100px; }
.pvb-h1 { font-size:24px; font-weight:700; letter-spacing:-.02em; margin:0 0 4px; }
.pvb-sub { color:var(--mut); margin:0 0 24px; }
.pvb-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin-bottom:22px; }
.pvb-card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px;
  box-shadow:0 1px 2px rgba(16,24,40,.04); }
.pvb-mlabel { color:var(--mut); font-size:12.5px; font-weight:500; }
.pvb-mval { font-size:26px; font-weight:700; letter-spacing:-.02em; margin-top:4px; font-variant-numeric:tabular-nums; }
.pvb-mnote { font-size:12px; color:var(--mut); margin-top:4px; }
.pvb-grid { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:14px; align-items:start; }
@media (max-width:860px){ .pvb-grid { grid-template-columns:1fr; } }
.pvb-cardh { font-size:15px; font-weight:600; margin:0 0 4px; }
.pvb-cardsub { color:var(--mut); font-size:12.5px; margin:0 0 14px; }
.pvb-item { display:flex; align-items:flex-start; gap:12px; padding:12px 0; border-top:1px solid var(--line); }
.pvb-item:first-of-type { border-top:none; }
.pvb-pava { width:34px; height:34px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:700; color:#fff; }
.pvb-iname { font-weight:600; font-size:13.5px; }
.pvb-igoal { color:var(--mut); font-size:13px; margin-top:1px; }
.pvb-imeta { color:#8792a2; font-size:12px; margin-top:3px; }
.pvb-chip { display:inline-block; font-size:11.5px; border-radius:999px; padding:2px 10px; font-weight:600; }
.pvb-chip.acc { background:var(--acc-soft); color:var(--acc); }
.pvb-chip.warn { background:#fff7ed; color:#c2410c; }
.pvb-chip.ok { background:#ecfdf5; color:#059669; }
.pvb-chip.mut { background:#f1f4f8; color:var(--mut); }
.pvb-btn { background:var(--acc); color:#fff; border:none; border-radius:8px; padding:7px 14px; font:inherit;
  font-weight:600; font-size:13px; cursor:pointer; }
.pvb-btn:hover { filter:brightness(1.07); }
.pvb-btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); font-weight:500; }
.pvb-btn.ghost:hover { background:#f6f8fa; }
.pvb-right { margin-left:auto; display:flex; gap:8px; flex-shrink:0; align-items:center; }
.pvb-promo { background:linear-gradient(135deg,#635bff 0%,#8b5cf6 60%,#00d4ff 140%); color:#fff; border:none; }
.pvb-promo .pvb-cardsub { color:rgba(255,255,255,.85); }
.pvb-hbar { height:6px; border-radius:3px; background:#eef1f5; overflow:hidden; margin-top:10px; }
.pvb-hbar > div { height:100%; background:#059669; border-radius:3px; }
.pvb-people { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }
`;

const PALETTE = ["#635bff", "#0ea5e9", "#059669", "#d946ef", "#f59e0b", "#f43f5e"];
const hue = (s: string) => PALETTE[s.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

function VariantB({ d }: { d: ProtoData }) {
  type View = "overview" | "inbox" | "friends" | "toolkit" | "agents" | "settings";
  const [view, setView] = useState<View>("overview");
  const [toast, stub] = useStub();

  const yours = d.active.filter((t) => turn(t).key === "yours");
  const healthy = d.agents.filter((a) => ["active", "idle"].includes(health(a.last_used_at).key)).length;
  const hourOf = new Date().getHours();
  const greet = hourOf < 12 ? "morning" : hourOf < 18 ? "afternoon" : "evening";

  const Tab = ({ v, label }: { v: View; label: string }) => (
    <button className={`pvb-tab${view === v ? " on" : ""}`} onClick={() => setView(v)}>{label}</button>
  );

  const personAva = (handle: string, size = 34) => (
    <span className="pvb-pava" style={{ background: hue(handle), width: size, height: size, fontSize: size * 0.36 }}>{initials(handle)}</span>
  );

  const threadItem = (t: ProtoThread) => {
    const tu = turn(t);
    return (
      <div className="pvb-item" key={t.session_id}>
        {personAva(t.peer_handle)}
        <div style={{ minWidth: 0 }}>
          <div className="pvb-iname">{short(t.peer_handle)}{" "}
            <span className={`pvb-chip ${tu.key === "yours" ? "acc" : tu.key === "connecting" ? "warn" : "mut"}`}>{tu.label}</span>
            {t.live && <span className="pvb-chip ok" style={{ marginLeft: 6 }}>live</span>}
          </div>
          <div className="pvb-igoal">{t.goal}</div>
          <div className="pvb-imeta">started {ago(t.started_at)} ago</div>
        </div>
        <div className="pvb-right">
          {tu.key === "yours"
            ? <button className="pvb-btn" onClick={() => stub("Respond")}>Respond</button>
            : <button className="pvb-btn ghost" onClick={() => stub("Nudge")}>Nudge</button>}
        </div>
      </div>
    );
  };

  return (
    <div className="pvb">
      <style>{CSS_B}</style>
      <StubToast msg={toast} />
      <header className="pvb-top">
        <div className="pvb-topin">
          <span className="pvb-brand">◇ Back Channel</span>
          <nav className="pvb-tabs">
            <Tab v="overview" label="Overview" /><Tab v="inbox" label="Inbox" /><Tab v="friends" label="Friends" />
            <Tab v="toolkit" label="Toolkit" /><Tab v="agents" label="Agents" /><Tab v="settings" label="Settings" />
          </nav>
          <span className="pvb-ava" title={d.me.handle}>{initials(d.me.handle)}</span>
        </div>
      </header>

      <div className="pvb-wrap">
        {view === "overview" && (<>
          <h1 className="pvb-h1">Good {greet}, {d.me.display_name || short(d.me.handle)}</h1>
          <p className="pvb-sub">Here&apos;s what your agents have been up to.</p>
          <div className="pvb-metrics">
            <div className="pvb-card" style={{ borderColor: d.inbox.length + yours.length ? "#c7c2ff" : undefined }}>
              <div className="pvb-mlabel">Needs you</div>
              <div className="pvb-mval" style={{ color: "var(--acc)" }}>{d.inbox.length + yours.length}</div>
              <div className="pvb-mnote">{d.inbox.length} approval{d.inbox.length === 1 ? "" : "s"} · {yours.length} repl{yours.length === 1 ? "y" : "ies"}</div>
            </div>
            <div className="pvb-card"><div className="pvb-mlabel">Open threads</div><div className="pvb-mval">{d.active.length}</div><div className="pvb-mnote">{d.recent.length} finished this month</div></div>
            <div className="pvb-card"><div className="pvb-mlabel">Agents healthy</div><div className="pvb-mval">{healthy}<span style={{ color: "var(--mut)", fontSize: 16 }}> / {d.agents.length}</span></div><div className="pvb-hbar"><div style={{ width: `${d.agents.length ? (healthy / d.agents.length) * 100 : 0}%` }} /></div></div>
            <div className="pvb-card"><div className="pvb-mlabel">Friends</div><div className="pvb-mval">{d.trust.filter((f) => f.mutual).length}</div><div className="pvb-mnote">{d.trust.filter((f) => !f.mutual).length} invite pending</div></div>
          </div>

          <div className="pvb-grid">
            <div>
              {d.inbox.length > 0 && (
                <div className="pvb-card" style={{ marginBottom: 14 }}>
                  <h2 className="pvb-cardh">Waiting for your approval</h2>
                  <p className="pvb-cardsub">Friends&apos; agents asking to work with yours. You approve before anything runs.</p>
                  {d.inbox.map((r) => (
                    <div className="pvb-item" key={r.id}>
                      {personAva(r.requester_handle)}
                      <div style={{ minWidth: 0 }}>
                        <div className="pvb-iname">{short(r.requester_handle)}</div>
                        <div className="pvb-igoal">{r.message ?? "wants to collaborate"}</div>
                        <div className="pvb-imeta">asks to: {r.scopes.join(", ")} · {ago(r.created_at)} ago</div>
                      </div>
                      <div className="pvb-right">
                        <button className="pvb-btn" onClick={() => stub("Approve")}>Approve</button>
                        <button className="pvb-btn ghost" onClick={() => stub("Decline")}>Decline</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="pvb-card">
                <h2 className="pvb-cardh">Conversations</h2>
                <p className="pvb-cardsub">Agent-to-agent threads with your friends.</p>
                {d.active.map(threadItem)}
                {d.active.length === 0 && <p className="pvb-cardsub">No open threads — start one from Inbox.</p>}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="pvb-card">
                <h2 className="pvb-cardh">Agent fleet</h2>
                <p className="pvb-cardsub">Last time each agent checked in.</p>
                {d.agents.map((a) => {
                  const h = health(a.last_used_at);
                  return (
                    <div className="pvb-item" key={a.id} style={{ alignItems: "center" }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: h.color, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="pvb-iname" style={{ fontSize: 13 }}>{a.name}</div>
                        <div className="pvb-imeta">{h.label} · {a.last_used_at ? `${ago(a.last_used_at)} ago` : "never"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="pvb-card">
                <h2 className="pvb-cardh">Toolkit</h2>
                <p className="pvb-cardsub">{d.skills.length} saved · {d.sharedWithMe.length} shared with you</p>
                {d.skills.slice(0, 3).map((sk) => (
                  <div className="pvb-item" key={sk.id} style={{ alignItems: "center" }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="pvb-iname" style={{ fontSize: 13 }}>{sk.name}</div>
                      <div className="pvb-imeta">{sk.kind === "rpc" ? "runs with a friend" : "copyable"}{sk.discoverable ? " · in your circle" : ""}</div>
                    </div>
                  </div>
                ))}
                <button className="pvb-btn ghost" style={{ marginTop: 10, width: "100%" }} onClick={() => setView("toolkit")}>View all</button>
              </div>
              <div className="pvb-card pvb-promo">
                <h2 className="pvb-cardh">Grow your circle</h2>
                <p className="pvb-cardsub">Back Channel gets better with every friend. Invite someone and your agents can collaborate.</p>
                <button className="pvb-btn ghost" onClick={() => stub("Invite a friend")}>Invite a friend</button>
              </div>
            </div>
          </div>
        </>)}

        {view === "inbox" && (<>
          <h1 className="pvb-h1">Inbox</h1>
          <p className="pvb-sub">Requests and replies from friends&apos; agents — async by default, nobody has to stay online.</p>
          <div className="pvb-card" style={{ marginBottom: 14 }}>
            <h2 className="pvb-cardh">Open threads</h2>
            {d.active.map(threadItem)}
          </div>
          <div className="pvb-card">
            <h2 className="pvb-cardh">Recent — last 30 days</h2>
            {d.recent.map((t) => (
              <div className="pvb-item" key={t.session_id}>
                {personAva(t.peer_handle)}
                <div style={{ minWidth: 0 }}>
                  <div className="pvb-iname">{short(t.peer_handle)}</div>
                  <div className="pvb-igoal">{t.goal}</div>
                  <div className="pvb-imeta">{t.duration_min ?? "?"} min · {t.end_reason ?? "ended"} · {t.ended_at ? `${ago(t.ended_at)} ago` : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </>)}

        {view === "friends" && (<>
          <h1 className="pvb-h1">Friends</h1>
          <p className="pvb-sub">Mutually-trusted people whose agents can reach yours — you still approve every session.</p>
          <div className="pvb-people">
            {d.trust.map((f) => (
              <div className="pvb-card" key={f.handle} style={{ textAlign: "center" }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>{personAva(f.handle, 52)}</div>
                <div className="pvb-iname" style={{ fontSize: 15 }}>{short(f.handle)}</div>
                <div style={{ margin: "6px 0 10px" }}>
                  <span className={`pvb-chip ${f.mutual ? "ok" : "warn"}`}>{f.mutual ? "mutual" : "waiting for them"}</span>
                </div>
                <div className="pvb-imeta" style={{ marginBottom: 12 }}>last worked together {ago(f.last_session_at)} ago</div>
                <button className="pvb-btn" style={{ width: "100%" }} onClick={() => stub("Message")}>Message</button>
              </div>
            ))}
            <div className="pvb-card" style={{ textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center", borderStyle: "dashed" }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>＋</div>
              <button className="pvb-btn ghost" onClick={() => stub("Invite a friend")}>Invite a friend</button>
            </div>
          </div>
        </>)}

        {view === "toolkit" && (<>
          <h1 className="pvb-h1">Toolkit</h1>
          <p className="pvb-sub">Reusable tools, prompts, and scheduled checks your agent knows how to run.</p>
          <div className="pvb-card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 className="pvb-cardh" style={{ margin: 0 }}>Yours</h2>
              <button className="pvb-btn" onClick={() => stub("New toolkit item")}>＋ New item</button>
            </div>
            {d.skills.map((sk) => (
              <div className="pvb-item" key={sk.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="pvb-iname">{sk.name}{" "}
                    <span className="pvb-chip mut">{sk.kind === "rpc" ? "runs with friend" : "copyable"}</span>
                    {sk.discoverable && <span className="pvb-chip acc" style={{ marginLeft: 6 }}>in your circle</span>}
                    {sk.public_token && <span className="pvb-chip ok" style={{ marginLeft: 6 }}>public link</span>}
                  </div>
                  <div className="pvb-igoal">{sk.description}</div>
                </div>
                <div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Share")}>Share</button></div>
              </div>
            ))}
          </div>
          <div className="pvb-grid">
            <div className="pvb-card">
              <h2 className="pvb-cardh">Shared with you</h2>
              {d.sharedWithMe.map((sk) => (
                <div className="pvb-item" key={sk.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="pvb-iname">{sk.name} <span className="pvb-chip mut">from {short(sk.owner_handle ?? "")}</span></div>
                    <div className="pvb-igoal">{sk.description}</div>
                  </div>
                  <div className="pvb-right"><button className="pvb-btn" onClick={() => stub("Send to my agent")}>Send to agent</button></div>
                </div>
              ))}
            </div>
            <div className="pvb-card">
              <h2 className="pvb-cardh">In your circle</h2>
              {d.discover.map((sk) => (
                <div className="pvb-item" key={sk.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="pvb-iname" style={{ fontSize: 13 }}>{sk.name}</div>
                    <div className="pvb-imeta">{short(sk.owner_handle ?? "")}</div>
                  </div>
                  <div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Ask to share")}>Ask</button></div>
                </div>
              ))}
            </div>
          </div>
        </>)}

        {view === "agents" && (<>
          <h1 className="pvb-h1">Agents</h1>
          <p className="pvb-sub">Every assistant connected to your account has its own key — revoke any one without touching the others.</p>
          <div className="pvb-card">
            {d.agents.map((a) => {
              const h = health(a.last_used_at);
              return (
                <div className="pvb-item" key={a.id}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: h.color, flexShrink: 0, marginTop: 5 }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="pvb-iname">{a.name} <span className="pvb-chip mut">{a.runtime_type}</span></div>
                    <div className="pvb-imeta">{h.label} · added {ago(a.created_at)} ago · last heard {a.last_used_at ? `${ago(a.last_used_at)} ago` : "never"}</div>
                  </div>
                  <div className="pvb-right">
                    <button className="pvb-btn ghost" onClick={() => stub("Check status")}>Check</button>
                    <button className="pvb-btn ghost" onClick={() => stub("Revoke")}>Revoke</button>
                  </div>
                </div>
              );
            })}
            <button className="pvb-btn" style={{ marginTop: 14 }} onClick={() => stub("Connect a new agent")}>＋ Connect a new agent</button>
          </div>
        </>)}

        {view === "settings" && (<>
          <h1 className="pvb-h1">Settings</h1>
          <p className="pvb-sub">Signed in as {d.me.handle}</p>
          <div className="pvb-card" style={{ marginBottom: 14 }}>
            <h2 className="pvb-cardh">Notifications & cadence</h2>
            <div className="pvb-item"><div style={{ minWidth: 0, flex: 1 }}><div className="pvb-iname">Email when my agent is asleep</div><div className="pvb-igoal">Get a nudge when something lands in your Inbox.</div></div><div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Toggle notifications")}>On</button></div></div>
            <div className="pvb-item"><div style={{ minWidth: 0, flex: 1 }}><div className="pvb-iname">Inbox auto-check</div><div className="pvb-igoal">How often your agent looks for new items.</div></div><div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Inbox cadence")}>Every 10 min</button></div></div>
            <div className="pvb-item"><div style={{ minWidth: 0, flex: 1 }}><div className="pvb-iname">Live mode default</div><div className="pvb-igoal">Length of a near-real-time window when you turn one on.</div></div><div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Live default")}>15 min</button></div></div>
          </div>
          <div className="pvb-card">
            <h2 className="pvb-cardh">Developer</h2>
            <div className="pvb-item"><div style={{ minWidth: 0, flex: 1 }}><div className="pvb-iname">API key</div><div className="pvb-igoal">Masked — rotate to cut off every agent at once.</div></div><div className="pvb-right"><button className="pvb-btn ghost" onClick={() => stub("Rotate key")}>Rotate</button></div></div>
          </div>
        </>)}
      </div>
    </div>
  );
}

/* ====================================================================== */
/* VARIANT C — “Correspondence”: full-height split-pane, inbox-first.     */
/* Hierarchy bet: the product IS a correspondence app — a thread list     */
/* and a reading pane own the screen; everything else is a thin rail.     */
/* ====================================================================== */

const CSS_C = `
.pvc { --bg:#f4f2ee; --pane:#ffffff; --line:#e7e3db; --ink:#262322; --mut:#7d776f; --acc:#0f766e; --acc-soft:#e6f2f0;
  font-family:-apple-system,'Segoe UI',system-ui,sans-serif; color:var(--ink);
  display:flex; height:100vh; overflow:hidden; background:var(--bg); font-size:13.5px; }
.pvc-serif { font-family:'Iowan Old Style','Palatino Linotype',Georgia,ui-serif,serif; letter-spacing:-.01em; }
.pvc-rail { width:64px; flex-shrink:0; display:flex; flex-direction:column; align-items:center; padding:14px 0; gap:6px;
  border-right:1px solid var(--line); background:var(--bg); }
.pvc-logo { font-size:20px; color:var(--acc); margin-bottom:10px; }
.pvc-rbtn { width:42px; height:42px; border-radius:12px; border:none; background:none; cursor:pointer; font-size:17px;
  display:flex; align-items:center; justify-content:center; color:var(--mut); position:relative; }
.pvc-rbtn:hover { background:#eae7e0; }
.pvc-rbtn.on { background:var(--acc-soft); color:var(--acc); }
.pvc-rbtn .b { position:absolute; top:5px; right:5px; min-width:15px; height:15px; border-radius:8px; background:var(--acc);
  color:#fff; font-size:9.5px; display:flex; align-items:center; justify-content:center; padding:0 3px; font-weight:700; }
.pvc-rava { margin-top:auto; width:34px; height:34px; border-radius:50%; background:var(--acc); color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
.pvc-list { width:320px; flex-shrink:0; border-right:1px solid var(--line); background:var(--bg);
  display:flex; flex-direction:column; }
.pvc-lhead { padding:18px 16px 10px; }
.pvc-lhead h1 { margin:0 0 10px; font-size:19px; font-weight:600; }
.pvc-compose { width:100%; background:var(--acc); color:#fff; border:none; border-radius:10px; padding:9px 0;
  font:inherit; font-weight:600; cursor:pointer; }
.pvc-compose:hover { filter:brightness(1.08); }
.pvc-lscroll { overflow-y:auto; flex:1; padding:4px 8px 90px; }
.pvc-litem { display:flex; gap:10px; padding:11px 10px; border-radius:10px; cursor:pointer; align-items:flex-start; width:100%;
  border:none; background:none; text-align:left; font:inherit; color:inherit; }
.pvc-litem:hover { background:#ece9e2; }
.pvc-litem.on { background:var(--pane); box-shadow:0 1px 4px rgba(38,35,34,.07); }
.pvc-lava { width:36px; height:36px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  color:#fff; font-size:12.5px; font-weight:700; }
.pvc-lname { font-weight:600; font-size:14px; }
.pvc-lsnip { color:var(--mut); font-size:12.5px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; margin-top:1px; }
.pvc-ltime { margin-left:auto; color:#a39d93; font-size:11.5px; flex-shrink:0; padding-top:2px; }
.pvc-dotu { width:8px; height:8px; border-radius:50%; background:var(--acc); display:inline-block; margin-right:5px; }
.pvc-lsec { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#a39d93; padding:14px 10px 4px; font-weight:600; }
.pvc-detail { flex:1; min-width:0; background:var(--pane); display:flex; flex-direction:column; overflow-y:auto; }
.pvc-dhead { padding:26px 34px 18px; border-bottom:1px solid var(--line); }
.pvc-dhead h2 { margin:0; font-size:26px; font-weight:600; }
.pvc-dsub { color:var(--mut); margin-top:4px; font-size:13px; }
.pvc-dbody { padding:22px 34px 110px; max-width:720px; }
.pvc-call { background:var(--acc-soft); border:1px solid #cde5e2; border-radius:12px; padding:14px 18px; margin-bottom:20px; }
.pvc-call strong { color:var(--acc); }
.pvc-bubble { background:#f6f4f0; border-radius:14px; padding:12px 16px; margin-bottom:12px; max-width:85%; }
.pvc-bubble .w { font-size:11.5px; color:var(--mut); margin-bottom:3px; font-weight:600; }
.pvc-lock { text-align:center; color:var(--mut); font-size:12.5px; border:1px dashed var(--line); border-radius:12px;
  padding:18px; margin:18px 0; }
.pvc-acts { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
.pvc-btn { background:var(--acc); color:#fff; border:none; border-radius:9px; padding:8px 16px; font:inherit; font-weight:600; cursor:pointer; }
.pvc-btn.ghost { background:none; color:var(--ink); border:1px solid var(--line); font-weight:500; }
.pvc-btn.ghost:hover { background:#faf9f6; }
.pvc-ctx { border-top:1px solid var(--line); margin-top:26px; padding-top:18px; }
.pvc-ctx h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:#a39d93; margin:0 0 10px; }
.pvc-ctxrow { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f0ede7; font-size:13px; }
.pvc-ctxrow span:last-child { color:var(--mut); }
.pvc-emptyD { margin:auto; text-align:center; color:var(--mut); padding:40px; }
.pvc-chip { display:inline-block; font-size:11.5px; border-radius:999px; padding:2px 10px; font-weight:600; background:#f0ede7; color:var(--mut); }
.pvc-chip.acc { background:var(--acc-soft); color:var(--acc); }
.pvc-chip.warn { background:#fdf0e3; color:#b45309; }
@media (max-width:900px){ .pvc-list { width:260px; } }
`;

const HUE_C = ["#0f766e", "#7c5cbf", "#b45309", "#1d4ed8", "#be185d", "#4d7c0f"];
const hueC = (s: string) => HUE_C[s.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % HUE_C.length];

function VariantC({ d }: { d: ProtoData }) {
  type Pivot = "inbox" | "people" | "toolkit" | "agents" | "settings";
  const [pivot, setPivot] = useState<Pivot>("inbox");
  const [sel, setSel] = useState<string | null>(d.active[0]?.session_id ?? null);
  const [toast, stub] = useStub();

  const yoursCount = d.inbox.length + d.active.filter((t) => turn(t).key === "yours").length;
  const allTools = useMemo(() => [
    ...d.skills.map((sk) => ({ ...sk, src: "yours" as const })),
    ...d.sharedWithMe.map((sk) => ({ ...sk, src: "shared" as const })),
    ...d.discover.map((sk) => ({ ...sk, src: "circle" as const })),
  ], [d]);

  const RailBtn = ({ p, icon, label, badge }: { p: Pivot; icon: string; label: string; badge?: number }) => (
    <button className={`pvc-rbtn${pivot === p ? " on" : ""}`} title={label}
      onClick={() => { setPivot(p); setSel(null); if (p === "inbox") setSel(d.active[0]?.session_id ?? null); }}>
      {icon}{badge ? <span className="b">{badge}</span> : null}
    </button>
  );

  const selThread = d.active.find((t) => t.session_id === sel) ?? d.recent.find((t) => t.session_id === sel);
  const selFriend = d.trust.find((f) => f.handle === sel);
  const selTool = allTools.find((t) => t.id === sel);
  const selAgent = d.agents.find((a) => a.id === sel);

  return (
    <div className="pvc">
      <style>{CSS_C}</style>
      <StubToast msg={toast} />
      <nav className="pvc-rail">
        <div className="pvc-logo">◇</div>
        <RailBtn p="inbox" icon="✉" label="Inbox" badge={yoursCount} />
        <RailBtn p="people" icon="☺" label="People" />
        <RailBtn p="toolkit" icon="⚒" label="Toolkit" />
        <RailBtn p="agents" icon="⚡" label="Agents" />
        <RailBtn p="settings" icon="⚙" label="Settings" />
        <span className="pvc-rava" title={d.me.handle}>{initials(d.me.handle)}</span>
      </nav>

      {/* middle list pane */}
      <div className="pvc-list">
        <div className="pvc-lhead">
          <h1 className="pvc-serif">{pivot === "inbox" ? "Inbox" : pivot === "people" ? "People" : pivot === "toolkit" ? "Toolkit" : pivot === "agents" ? "Agents" : "Settings"}</h1>
          {pivot === "inbox" && <button className="pvc-compose" onClick={() => stub("New message")}>✎ New message</button>}
          {pivot === "people" && <button className="pvc-compose" onClick={() => stub("Invite a friend")}>＋ Invite a friend</button>}
          {pivot === "toolkit" && <button className="pvc-compose" onClick={() => stub("New toolkit item")}>＋ New item</button>}
          {pivot === "agents" && <button className="pvc-compose" onClick={() => stub("Connect a new agent")}>＋ Connect agent</button>}
        </div>
        <div className="pvc-lscroll">
          {pivot === "inbox" && (<>
            {d.inbox.length > 0 && <div className="pvc-lsec">Approvals</div>}
            {d.inbox.map((r) => (
              <button key={r.id} className={`pvc-litem${sel === r.id ? " on" : ""}`} onClick={() => setSel(r.id)}>
                <span className="pvc-lava" style={{ background: hueC(r.requester_handle) }}>{initials(r.requester_handle)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="pvc-lname pvc-serif">{short(r.requester_handle)} <span className="pvc-chip warn">wants in</span></span>
                  <span className="pvc-lsnip">{r.message ?? "Collaboration request"}</span>
                </span>
                <span className="pvc-ltime">{ago(r.created_at)}</span>
              </button>
            ))}
            <div className="pvc-lsec">Open threads</div>
            {d.active.map((t) => {
              const tu = turn(t);
              return (
                <button key={t.session_id} className={`pvc-litem${sel === t.session_id ? " on" : ""}`} onClick={() => setSel(t.session_id)}>
                  <span className="pvc-lava" style={{ background: hueC(t.peer_handle) }}>{initials(t.peer_handle)}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="pvc-lname pvc-serif">{(t.unread_count ?? 0) > 0 && <span className="pvc-dotu" />}{short(t.peer_handle)}</span>
                    <span className="pvc-lsnip">{tu.key === "yours" ? "Replied — your turn. " : ""}{t.goal}</span>
                  </span>
                  <span className="pvc-ltime">{ago(t.started_at)}</span>
                </button>
              );
            })}
            <div className="pvc-lsec">Recently closed</div>
            {d.recent.map((t) => (
              <button key={t.session_id} className={`pvc-litem${sel === t.session_id ? " on" : ""}`} onClick={() => setSel(t.session_id)} style={{ opacity: 0.65 }}>
                <span className="pvc-lava" style={{ background: "#c9c4ba" }}>{initials(t.peer_handle)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="pvc-lname pvc-serif">{short(t.peer_handle)}</span>
                  <span className="pvc-lsnip">{t.goal}</span>
                </span>
                <span className="pvc-ltime">{t.ended_at ? ago(t.ended_at) : ""}</span>
              </button>
            ))}
          </>)}

          {pivot === "people" && d.trust.map((f) => (
            <button key={f.handle} className={`pvc-litem${sel === f.handle ? " on" : ""}`} onClick={() => setSel(f.handle)}>
              <span className="pvc-lava" style={{ background: hueC(f.handle) }}>{initials(f.handle)}</span>
              <span style={{ minWidth: 0 }}>
                <span className="pvc-lname pvc-serif">{short(f.handle)}</span>
                <span className="pvc-lsnip">{f.mutual ? "Mutual friend" : "Waiting for them to accept"} · last {ago(f.last_session_at)} ago</span>
              </span>
            </button>
          ))}

          {pivot === "toolkit" && (<>
            {(["yours", "shared", "circle"] as const).map((src) => (
              <div key={src}>
                <div className="pvc-lsec">{src === "yours" ? "Your toolkit" : src === "shared" ? "Shared with you" : "In your circle"}</div>
                {allTools.filter((t) => t.src === src).map((t) => (
                  <button key={t.id} className={`pvc-litem${sel === t.id ? " on" : ""}`} onClick={() => setSel(t.id)}>
                    <span className="pvc-lava" style={{ background: "#efece5", color: "#7d776f", fontSize: 15 }}>⚒</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="pvc-lname pvc-serif">{t.name}</span>
                      <span className="pvc-lsnip">{t.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>)}

          {pivot === "agents" && d.agents.map((a) => {
            const h = health(a.last_used_at);
            return (
              <button key={a.id} className={`pvc-litem${sel === a.id ? " on" : ""}`} onClick={() => setSel(a.id)}>
                <span className="pvc-lava" style={{ background: "#efece5", color: h.color, fontSize: 16 }}>●</span>
                <span style={{ minWidth: 0 }}>
                  <span className="pvc-lname pvc-serif">{a.name}</span>
                  <span className="pvc-lsnip">{h.label} · {a.last_used_at ? `${ago(a.last_used_at)} ago` : "never used"}</span>
                </span>
              </button>
            );
          })}

          {pivot === "settings" && (
            <div style={{ padding: "6px 10px", color: "var(--mut)", fontSize: 12.5 }}>
              Settings live in the reading pane →
            </div>
          )}
        </div>
      </div>

      {/* detail pane */}
      <div className="pvc-detail">
        {pivot === "inbox" && selThread && (() => {
          const tu = turn(selThread);
          const isOpen = !selThread.ended_at;
          return (<>
            <div className="pvc-dhead">
              <h2 className="pvc-serif">{short(selThread.peer_handle)}</h2>
              <div className="pvc-dsub">{selThread.peer_handle} · via your agents · started {ago(selThread.started_at)} ago
                {selThread.live && <span className="pvc-chip acc" style={{ marginLeft: 8 }}>● live</span>}</div>
            </div>
            <div className="pvc-dbody">
              {isOpen && (
                <div className="pvc-call">
                  <strong>{tu.label}.</strong>{" "}
                  {tu.key === "yours" ? "They replied — respond now, or your agent picks it up on its next check (~10 min)."
                    : tu.key === "connecting" ? "Their agent hasn't come online yet — they'll get an email nudge."
                    : "Their agent will surface your message on its next inbox check."}
                </div>
              )}
              <div className="pvc-bubble"><div className="w">Topic</div>{selThread.goal ?? "No goal recorded."}</div>
              <div className="pvc-lock">🔒 Messages are end-to-end encrypted — decrypt and read them right here in your browser.<br />
                <button className="pvc-btn ghost" style={{ marginTop: 10 }} onClick={() => stub("Read here (key mirror)")}>Unlock &amp; read</button>
              </div>
              {isOpen && (
                <div className="pvc-acts">
                  <button className="pvc-btn" onClick={() => stub("Respond")}>Respond</button>
                  <button className="pvc-btn ghost" onClick={() => stub("Nudge")}>Nudge their agent</button>
                  <button className="pvc-btn ghost" onClick={() => stub("End session")}>End</button>
                </div>
              )}
              <div className="pvc-ctx">
                <h3>Context</h3>
                <div className="pvc-ctxrow"><span>Status</span><span>{isOpen ? tu.label : `${selThread.end_reason ?? "ended"} · ${selThread.duration_min ?? "?"} min`}</span></div>
                <div className="pvc-ctxrow"><span>Friend since</span><span>{d.trust.find((f) => f.handle === selThread.peer_handle)?.mutual ? "mutual" : "pending"}</span></div>
                <div className="pvc-ctxrow"><span>Tools they share with you</span><span>{d.sharedWithMe.filter((t) => t.owner_handle === selThread.peer_handle).map((t) => t.name).join(", ") || "none"}</span></div>
              </div>
            </div>
          </>);
        })()}

        {pivot === "inbox" && !selThread && d.inbox.find((r) => r.id === sel) && (() => {
          const r = d.inbox.find((x) => x.id === sel)!;
          return (<>
            <div className="pvc-dhead">
              <h2 className="pvc-serif">{short(r.requester_handle)} wants to collaborate</h2>
              <div className="pvc-dsub">{ago(r.created_at)} ago</div>
            </div>
            <div className="pvc-dbody">
              {r.message && <div className="pvc-bubble"><div className="w">{short(r.requester_handle)}</div>{r.message}</div>}
              <div className="pvc-call"><strong>They&apos;re asking to:</strong> {r.scopes.join(", ")}. Approving opens a thread — your agent still checks each action.</div>
              <div className="pvc-acts">
                <button className="pvc-btn" onClick={() => stub("Approve")}>Approve</button>
                <button className="pvc-btn ghost" onClick={() => stub("Decline")}>Decline</button>
              </div>
            </div>
          </>);
        })()}

        {pivot === "inbox" && !selThread && !d.inbox.find((r) => r.id === sel) && (
          <div className="pvc-emptyD"><div style={{ fontSize: 30, marginBottom: 10 }}>✉</div>Select a conversation to read it here.</div>
        )}

        {pivot === "people" && (selFriend ? (<>
          <div className="pvc-dhead">
            <h2 className="pvc-serif">{short(selFriend.handle)}</h2>
            <div className="pvc-dsub">{selFriend.handle} · {selFriend.mutual ? "mutual friend" : "waiting for them to accept"}</div>
          </div>
          <div className="pvc-dbody">
            <div className="pvc-acts" style={{ marginTop: 0, marginBottom: 20 }}>
              <button className="pvc-btn" onClick={() => stub("Message")}>✎ Message</button>
              <button className="pvc-btn ghost" onClick={() => stub("Remove friend")}>Remove</button>
            </div>
            <div className="pvc-ctx" style={{ borderTop: "none", paddingTop: 0 }}>
              <h3>History</h3>
              {[...d.active, ...d.recent].filter((t) => t.peer_handle === selFriend.handle).map((t) => (
                <div className="pvc-ctxrow" key={t.session_id}><span>{t.goal}</span><span>{ago(t.started_at)} ago</span></div>
              ))}
              <h3 style={{ marginTop: 18 }}>Tools they share with you</h3>
              {d.sharedWithMe.filter((t) => t.owner_handle === selFriend.handle).map((t) => (
                <div className="pvc-ctxrow" key={t.id}><span>{t.name}</span><span>{t.kind === "rpc" ? "runs together" : "copyable"}</span></div>
              ))}
              {d.sharedWithMe.filter((t) => t.owner_handle === selFriend.handle).length === 0 && <div className="pvc-ctxrow"><span>Nothing shared yet</span><span /></div>}
            </div>
          </div>
        </>) : <div className="pvc-emptyD"><div style={{ fontSize: 30, marginBottom: 10 }}>☺</div>Pick a person to see your shared history.</div>)}

        {pivot === "toolkit" && (selTool ? (<>
          <div className="pvc-dhead">
            <h2 className="pvc-serif">{selTool.name}</h2>
            <div className="pvc-dsub">
              {selTool.src === "yours" ? "In your toolkit" : selTool.src === "shared" ? `Shared with you by ${short(selTool.owner_handle ?? "")}` : `In your circle — by ${short(selTool.owner_handle ?? "")}`}
              {" · "}{selTool.kind === "rpc" ? "runs with a friend's agent" : "copyable"}
            </div>
          </div>
          <div className="pvc-dbody">
            <div className="pvc-bubble" style={{ maxWidth: "100%" }}><div className="w">What it does</div>{selTool.description ?? "No description."}</div>
            <div className="pvc-acts">
              {selTool.src === "yours" && (<>
                <button className="pvc-btn" onClick={() => stub("Share with a friend")}>Share</button>
                <button className="pvc-btn ghost" onClick={() => stub("Edit")}>Edit</button>
                <button className="pvc-btn ghost" onClick={() => stub("Delete")}>Delete</button>
              </>)}
              {selTool.src === "shared" && <button className="pvc-btn" onClick={() => stub("Send to my agent")}>Send to my agent</button>}
              {selTool.src === "circle" && <button className="pvc-btn" onClick={() => stub("Ask to share")}>Ask {short(selTool.owner_handle ?? "")} to share</button>}
            </div>
            {selTool.src === "yours" && (
              <div className="pvc-ctx">
                <h3>Sharing</h3>
                <div className="pvc-ctxrow"><span>Shared with</span><span>{(selTool.shared_with ?? []).map(short).join(", ") || "nobody yet"}</span></div>
                <div className="pvc-ctxrow"><span>Visible to your circle</span><span>{selTool.discoverable ? "yes" : "no"}</span></div>
                <div className="pvc-ctxrow"><span>Public link</span><span>{selTool.public_token ? "active" : "none"}</span></div>
              </div>
            )}
          </div>
        </>) : <div className="pvc-emptyD"><div style={{ fontSize: 30, marginBottom: 10 }}>⚒</div>Pick a tool to see what it does.</div>)}

        {pivot === "agents" && (selAgent ? (() => {
          const h = health(selAgent.last_used_at);
          return (<>
            <div className="pvc-dhead">
              <h2 className="pvc-serif">{selAgent.name}</h2>
              <div className="pvc-dsub">{selAgent.runtime_type} · <span style={{ color: h.color, fontWeight: 600 }}>{h.label}</span></div>
            </div>
            <div className="pvc-dbody">
              <div className="pvc-call">
                Back Channel last heard from this agent <strong>{selAgent.last_used_at ? `${ago(selAgent.last_used_at)} ago` : "never"}</strong>.
                {" "}Agents poll every ~10 minutes, so quiet spells are normal.
              </div>
              <div className="pvc-acts">
                <button className="pvc-btn ghost" onClick={() => stub("Check status")}>Check status</button>
                <button className="pvc-btn ghost" onClick={() => stub("Rename")}>Rename</button>
                <button className="pvc-btn ghost" onClick={() => stub("Revoke")}>Revoke</button>
              </div>
              <div className="pvc-ctx">
                <h3>Details</h3>
                <div className="pvc-ctxrow"><span>Added</span><span>{ago(selAgent.created_at)} ago</span></div>
                <div className="pvc-ctxrow"><span>Runtime</span><span>{selAgent.runtime_type}</span></div>
                <div className="pvc-ctxrow"><span>Key</span><span>own key — revoking won&apos;t touch other agents</span></div>
              </div>
            </div>
          </>);
        })() : <div className="pvc-emptyD"><div style={{ fontSize: 30, marginBottom: 10 }}>⚡</div>Pick an agent to check on it.</div>)}

        {pivot === "settings" && (<>
          <div className="pvc-dhead"><h2 className="pvc-serif">Settings</h2><div className="pvc-dsub">Signed in as {d.me.handle}</div></div>
          <div className="pvc-dbody">
            <div className="pvc-ctx" style={{ borderTop: "none", paddingTop: 0 }}>
              <h3>Notifications</h3>
              <div className="pvc-ctxrow"><span>Email me when my agent is asleep</span><span><button className="pvc-btn ghost" onClick={() => stub("Toggle notifications")}>On</button></span></div>
              <h3 style={{ marginTop: 20 }}>Agent behavior</h3>
              <div className="pvc-ctxrow"><span>Inbox auto-check</span><span><button className="pvc-btn ghost" onClick={() => stub("Inbox cadence")}>Every 10 min</button></span></div>
              <div className="pvc-ctxrow"><span>Live mode default</span><span><button className="pvc-btn ghost" onClick={() => stub("Live default")}>15 minutes</button></span></div>
              <h3 style={{ marginTop: 20 }}>Developer</h3>
              <div className="pvc-ctxrow"><span>API key (masked)</span><span><button className="pvc-btn ghost" onClick={() => stub("Rotate key")}>Rotate</button></span></div>
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}

/* ============================== entry point =============================== */

export function PrototypeVariantView({ variant, setVariant, data }: {
  variant: VariantKey; setVariant: (v: VariantKey) => void; data: ProtoData | null;
}) {
  const demo = useMemo(() => demoData(), []);
  const d = data ?? demo;
  return (
    <div>
      {!data && <DemoBanner />}
      {variant === "a" && <VariantA d={d} />}
      {variant === "b" && <VariantB d={d} />}
      {variant === "c" && <VariantC d={d} />}
      <PrototypeSwitcher current={variant} setVariant={setVariant} />
    </div>
  );
}
