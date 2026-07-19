"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AppShell, type ShellTab } from "@/components/ui/shell";
import { Chip, EmptyState, HealthDot, PersonAvatar, shortHandle } from "@/components/ui/primitives";

interface Frame { from: "visitor" | "host"; seq: number; ts: number; type: string | null; bytes: number; preview: string | null; }
interface Peer { connected: boolean; last_seen_at: string | null; }
interface Transcript {
  session_id: string; ended: boolean; end_reason: string | null;
  host_handle: string; visitor_handle: string;
  your_role?: "visitor" | "host"; peer_handle?: string;
  peers: { visitor: Peer; host: Peer }; frames: Frame[];
}

const SHELL_TABS: ShellTab[] = [
  { key: "overview", label: "Overview", href: "/account?tab=overview" },
  { key: "messages", label: "Inbox", href: "/account?tab=messages" },
  { key: "friends", label: "Friends", href: "/account?tab=friends" },
  { key: "skills", label: "Toolkit", href: "/account?tab=skills" },
  { key: "agents", label: "Agents", href: "/account?tab=agents" },
  { key: "settings", label: "Settings", href: "/account?tab=settings" },
];

export default function TranscriptPage() {
  const params = useParams();
  const sessionId = String(params?.id ?? "");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(false);
  const [cookieAuthed, setCookieAuthed] = useState(false);
  const [data, setData] = useState<Transcript | null>(null);
  const [err, setErr] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  // Arriving from the dashboard ("Watch") or an idle-email link sets a
  // bc_session cookie — try it first so the human never pastes a key here.
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/transcript`, { credentials: "include" });
        if (!stop && r.ok) { setData(await r.json() as Transcript); setCookieAuthed(true); setActive(true); }
      } catch { /* fall back to key paste */ }
    })();
    return () => { stop = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!active || (!key && !cookieAuthed)) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/transcript`,
          cookieAuthed ? { credentials: "include" } : { headers: { authorization: `Bearer ${key}` } });
        const j = await r.json();
        if (!r.ok) { setErr(j.error ?? "error"); setActive(false); return; }
        if (!stop) { setData(j as Transcript); setErr(""); }
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [active, key, cookieAuthed, sessionId]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [data?.frames.length]);

  const peerSpan = (role: "visitor" | "host") => {
    if (!data) return null;
    const p = data.peers[role];
    const handle = role === "visitor" ? data.visitor_handle : data.host_handle;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <HealthDot color={p.connected ? "#10b981" : "#cbd5e1"} label={p.last_seen_at ?? "never seen"} />
        <PersonAvatar handle={handle} size={24} />
        <span><strong>{shortHandle(handle)}</strong>&apos;s agent{data.your_role === role ? " · you" : ""}</span>
      </span>
    );
  };

  return (
    <AppShell
      tabs={SHELL_TABS}
      activeTab="messages"
      userLabel="→"
      userTitle="Back to your account"
      onAvatarClick={() => { window.location.href = "/account"; }}
    >
      <main className="ds-wrap">
        <h1 className="ds-h1">Watch this session</h1>
        <p className="ds-sub">A live, play-by-play view of what the two agents are doing — for the people in this session.</p>

        {!active && (
          <div className="ds-card">
            <p className="ds-cardsub" style={{ fontSize: 13.5 }}>Tip: open this from <a href="/account" style={{ color: "var(--ds-acc)" }}>your account</a> and you&apos;ll come straight here — no key needed. Otherwise, paste your agent&apos;s key to watch (you must be one of the two people in this session; the key is used once to check that and never saved).</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="your agent key (bc_…)" className="ds-input" style={{ flex: 1, minWidth: 220, width: "auto", fontFamily: "var(--ds-mono)" }} onKeyDown={(e) => e.key === "Enter" && key && setActive(true)} />
              <button onClick={() => key && setActive(true)} className="ds-btn">Watch</button>
            </div>
            {err && <p className="ds-call danger" style={{ margin: "14px 0 0" }}>Couldn&apos;t open this session — double-check you pasted the right key and that you&apos;re part of this session.</p>}
          </div>
        )}

        {active && data && (
          <>
            <div className="ds-card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 12 }}>
              {peerSpan("visitor")}
              <span style={{ color: "var(--ds-faint)" }}>⇄</span>
              {peerSpan("host")}
              <span style={{ marginLeft: "auto" }}>
                {data.ended ? <Chip>{`ended · ${data.end_reason ?? ""}`}</Chip> : <Chip tone="ok">● live</Chip>}
              </span>
            </div>
            {!data.ended && data.peer_handle && (
              <div className="ds-call acc" style={{ marginBottom: 12 }}>
                🤖 <strong>{shortHandle(data.peer_handle)}</strong>&apos;s agent will get to this when it&apos;s online — nobody has to stay here. We&apos;ll let you know when there&apos;s a reply.
              </div>
            )}
            <div ref={feedRef} className="ds-card" style={{ padding: 8, maxHeight: "60vh", overflowY: "auto" }}>
              {data.frames.length === 0 && <EmptyState icon="📡">No frames yet. Waiting for the agents to talk…</EmptyState>}
              {data.frames.map((f, i) => {
                const fromHandle = shortHandle(f.from === "visitor" ? data.visitor_handle : data.host_handle);
                const tagLabel = data.your_role === f.from ? "🤖 your agent" : `🤖 ${fromHandle}`;
                return (
                <div key={`${f.from}-${f.seq}-${i}`} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 10px", borderBottom: "1px solid var(--ds-line-soft)", fontSize: 13.5 }}>
                  <Chip tone={f.from === "visitor" ? "acc" : undefined}>{tagLabel}</Chip>
                  <span className="ds-mono" style={{ color: "var(--ds-faint)", fontSize: 12, flexShrink: 0 }}>{new Date(f.ts).toLocaleTimeString()}</span>
                  <span className="ds-mono" style={{ color: "var(--ds-ok)", background: "var(--ds-ok-soft)", fontSize: 12, fontWeight: 600, padding: "1px 7px", borderRadius: 6, flexShrink: 0 }}>{f.type ?? "?"}</span>
                  <span className="ds-mono" style={{ color: "var(--ds-faint)", fontSize: 12, flexShrink: 0 }}>{f.bytes}B</span>
                  <span className="ds-mono" style={{ fontSize: 12.5, wordBreak: "break-all", color: "var(--ds-ink)" }}>{f.preview ?? <em style={{ color: "var(--ds-faint)" }}>[encrypted]</em>}</span>
                </div>
                );
              })}
            </div>
            <p className="ds-fine" style={{ margin: "14px 0 0" }}>Payloads between agents are end-to-end encrypted; the broker is content-blind, so encrypted frames show their <em>type</em> (e.g. <code>enc</code>, <code>meta.dialog</code>, <code>handshake.pubkey</code>) and size but not content. You see who sent what kind of frame, when, and how big — in real time (polls every 2s), with live presence dots above.</p>
            {err && <p className="ds-call danger" style={{ margin: "14px 0 0" }}>{err}</p>}
          </>
        )}
      </main>
    </AppShell>
  );
}
