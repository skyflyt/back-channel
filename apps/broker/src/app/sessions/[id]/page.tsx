"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface Frame { from: "visitor" | "host"; seq: number; ts: number; bytes: number; preview: string | null; }
interface Peer { connected: boolean; last_seen_at: string | null; }
interface Transcript {
  session_id: string; ended: boolean; end_reason: string | null;
  host_handle: string; visitor_handle: string;
  peers: { visitor: Peer; host: Peer }; frames: Frame[];
}

export default function TranscriptPage() {
  const params = useParams();
  const sessionId = String(params?.id ?? "");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(false);
  const [data, setData] = useState<Transcript | null>(null);
  const [err, setErr] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !key) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/transcript`, { headers: { authorization: `Bearer ${key}` } });
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
  }, [active, key, sessionId]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [data?.frames.length]);

  const dot = (p: Peer) => (
    <span style={{ ...styles.dot, background: p.connected ? "#10b981" : "#cbd5e1" }} title={p.last_seen_at ?? "never seen"} />
  );

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <h1 style={styles.h1}>Session transcript</h1>
        <p style={styles.sub}><code style={styles.mono}>{sessionId}</code></p>

        {!active && (
          <div style={styles.card}>
            <p style={styles.lead}>Paste your Back Channel API key to watch this session. You must be the host or visitor. Your key is sent only to the broker as a bearer token and never stored.</p>
            <div style={styles.row}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="bc_..." style={styles.input} onKeyDown={(e) => e.key === "Enter" && key && setActive(true)} />
              <button onClick={() => key && setActive(true)} style={styles.btn}>Watch</button>
            </div>
            {err && <p style={styles.err}>{err}</p>}
          </div>
        )}

        {active && data && (
          <>
            <div style={styles.statusBar}>
              <span>{dot(data.peers.visitor)} <strong>{data.visitor_handle}</strong> (visitor)</span>
              <span style={styles.arrow}>⇄</span>
              <span>{dot(data.peers.host)} <strong>{data.host_handle}</strong> (host)</span>
              <span style={{ marginLeft: "auto", ...(data.ended ? styles.ended : styles.liveBadge) }}>
                {data.ended ? `ended · ${data.end_reason ?? ""}` : "● live"}
              </span>
            </div>
            <div ref={feedRef} style={styles.feed}>
              {data.frames.length === 0 && <p style={styles.muted}>No frames yet. Waiting for the agents to talk…</p>}
              {data.frames.map((f, i) => (
                <div key={`${f.from}-${f.seq}-${i}`} style={styles.frame}>
                  <span style={{ ...styles.tag, background: f.from === "visitor" ? "#1e3a8a" : "#6b21a8" }}>{f.from}</span>
                  <span style={styles.time}>{new Date(f.ts).toLocaleTimeString()}</span>
                  <span style={styles.size}>{f.bytes}B</span>
                  <span style={styles.payload}>{f.preview ?? <em style={styles.muted}>[encrypted payload]</em>}</span>
                </div>
              ))}
            </div>
            <p style={styles.note}>Payloads between agents are end-to-end encrypted; the broker is content-blind, so encrypted frames show as <em>[encrypted payload]</em> — you see who sent what, when, and how big, in real time. Polls every 2s. This log is in-memory and not persisted.</p>
            {err && <p style={styles.err}>{err}</p>}
          </>
        )}
      </div>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" } as const,
  wrap: { maxWidth: 760, margin: "0 auto" } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: "0 0 4px" } as const,
  sub: { margin: "0 0 20px" } as const,
  mono: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, color: "#64748b" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 28 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 16px" } as const,
  row: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  input: { flex: 1, minWidth: 220, fontSize: 15, padding: "11px 14px", border: "1px solid #cbd5e1", borderRadius: 10, fontFamily: "ui-monospace, monospace" } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 24px", fontWeight: 600, fontSize: 15, cursor: "pointer" } as const,
  statusBar: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px", fontSize: 14, color: "#475569", marginBottom: 12 } as const,
  arrow: { color: "#94a3b8" } as const,
  dot: { display: "inline-block", width: 9, height: 9, borderRadius: "50%", marginRight: 4, verticalAlign: "middle" } as const,
  liveBadge: { color: "#10b981", fontWeight: 700, fontSize: 13 } as const,
  ended: { color: "#94a3b8", fontWeight: 600, fontSize: 13 } as const,
  feed: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 8, maxHeight: "60vh", overflowY: "auto" } as const,
  frame: { display: "flex", alignItems: "baseline", gap: 10, padding: "7px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 14 } as const,
  tag: { color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, textTransform: "uppercase", letterSpacing: "0.04em" } as const,
  time: { color: "#94a3b8", fontSize: 12, fontFamily: "ui-monospace, monospace", flexShrink: 0 } as const,
  size: { color: "#cbd5e1", fontSize: 12, fontFamily: "ui-monospace, monospace", flexShrink: 0 } as const,
  payload: { color: "#0f172a", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, wordBreak: "break-all" } as const,
  note: { fontSize: 13, color: "#94a3b8", lineHeight: 1.6, margin: "14px 0 0" } as const,
  muted: { color: "#94a3b8" } as const,
  err: { color: "#b91c1c", fontSize: 14, marginTop: 12 } as const,
};
