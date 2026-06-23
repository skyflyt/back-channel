"use client";
/**
 * KeyMirrorConversation — the /account "read & reply to this conversation in your
 * browser" panel (user-side decryption UI). All crypto is local via keymirror-client;
 * bubbles render as PLAIN TEXT through React text nodes (auto-escaped — no
 * dangerouslySetInnerHTML, no raw HTML; XSS hardening, S7). Backed by the live,
 * prod-verified key-mirror endpoints.
 */
import { useState, useCallback } from "react";
import * as km from "./keymirror-client";

function mapErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("prf_unsupported")) return "This device can't unlock conversations here (no passkey PRF). Use a device with Face ID / Touch ID / Windows Hello, or recover with your 24-word phrase.";
  if (m === "not_enrolled") return "not_enrolled";
  if (m.includes("cancelled")) return "Cancelled — tap again when you're ready.";
  if (m === "no_wrap" || m === "locked") return "This conversation isn't available to read here yet (your agent hasn't shared its key for it).";
  return "Couldn't unlock on this device. If you switched devices, recover with your 24-word phrase.";
}

export function KeyMirrorConversation(props: {
  sessionId: string; accountId: string; peerHandle: string; csrf: string;
  enrolled: boolean; displayName: string; onEnrolled?: () => void;
}) {
  const { sessionId, accountId, peerHandle, csrf, enrolled, displayName, onEnrolled } = props;
  const [phase, setPhase] = useState<"gate" | "open">("gate");
  const [bubbles, setBubbles] = useState<km.Bubble[]>([]);
  const [highWater, setHighWater] = useState<bigint>(0n);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    setErr(""); setBusy(true);
    try {
      if (!km.isUnlocked()) await km.unlock(accountId);
      const { bubbles, counterHighWater } = await km.openThread(sessionId);
      setBubbles(bubbles); setHighWater(counterHighWater); setPhase("open");
    } catch (e) { setErr(mapErr(e)); }
    setBusy(false);
  }, [accountId, sessionId]);

  const doEnroll = async () => {
    setErr(""); setBusy(true);
    try {
      const { mnemonic } = await km.enroll(accountId, displayName, csrf);
      setMnemonic(mnemonic); onEnrolled?.();
    } catch (e) { setErr(mapErr(e)); }
    setBusy(false);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true); setErr("");
    try { await km.sendMessage(sessionId, text, csrf, highWater); setDraft(""); await open(); }
    catch (e) { setErr(mapErr(e)); }
    setBusy(false);
  };

  // Recovery mnemonic shown ONCE right after enrollment.
  if (mnemonic) {
    return (
      <div style={s.box}>
        <p style={s.h}>🔑 Save your recovery phrase</p>
        <p style={s.muted}>If you ever lose all your devices, these 24 words are the <strong>only</strong> way back to your past conversations. Write them down and keep them safe — we never store them, and we can&apos;t recover them for you.</p>
        <pre style={s.mnemonic}>{mnemonic}</pre>
        <div style={s.row}>
          <button style={s.btn} onClick={() => { navigator.clipboard?.writeText(mnemonic).catch(() => {}); }}>Copy</button>
          <button style={s.btnPrimary} onClick={() => { setMnemonic(null); open(); }}>I&apos;ve saved it — continue</button>
        </div>
      </div>
    );
  }

  if (phase === "gate") {
    const needsEnroll = !enrolled || err === "not_enrolled";
    return (
      <div style={s.box}>
        {needsEnroll ? (
          <>
            <p style={s.h}>Read &amp; reply to this conversation here</p>
            <p style={s.muted}>Turn on browser access to read both sides of your conversations — and reply directly — from this page. Everything is decrypted <strong>locally in your browser</strong>; Back Channel&apos;s servers never see the contents. You&apos;ll unlock with your device passkey (Face ID / Touch ID / Windows Hello).</p>
            <button style={s.btnPrimary} disabled={busy} onClick={doEnroll}>{busy ? "Setting up…" : "Enable browser access"}</button>
          </>
        ) : (
          <>
            <p style={s.h}>Unlock to read this conversation</p>
            <p style={s.muted}>Tap to unlock with your passkey — decryption happens in your browser.</p>
            <button style={s.btnPrimary} disabled={busy} onClick={open}>{busy ? "Unlocking…" : "🔓 Unlock"}</button>
          </>
        )}
        {err && err !== "not_enrolled" && <p style={s.err}>{err}</p>}
      </div>
    );
  }

  // phase === "open"
  return (
    <div style={s.box}>
      <div style={s.transcript}>
        {bubbles.length === 0 && <p style={s.muted}>No messages in this conversation yet.</p>}
        {bubbles.map((b, i) => (
          <div key={i} style={{ display: "flex", justifyContent: b.side === "me" ? "flex-end" : "flex-start" }}>
            <div style={b.side === "me" ? s.bubbleMe : s.bubblePeer}>
              <div style={s.bubbleWho}>{b.side === "me" ? "You" : peerHandle.replace(/@bc$/, "")}</div>
              {/* PLAIN TEXT — React escapes; never raw HTML (S7) */}
              <div style={s.bubbleText}>{b.text}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={s.composer}>
        <textarea style={s.textarea} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${peerHandle.replace(/@bc$/, "")}'s agent…`} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
        <button style={s.btnPrimary} disabled={busy || !draft.trim()} onClick={send}>{busy ? "…" : "Send"}</button>
      </div>
      <p style={s.foot}>Decrypted locally in your browser · ⌘/Ctrl+Enter to send · your agent stays hands-off while you&apos;re here</p>
      {err && <p style={s.err}>{err}</p>}
    </div>
  );
}

const s = {
  box: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, marginTop: 10 } as const,
  h: { fontSize: 14.5, fontWeight: 700, color: "#0f172a", margin: "0 0 6px" } as const,
  muted: { fontSize: 13, color: "#64748b", margin: "0 0 12px", lineHeight: 1.5 } as const,
  err: { fontSize: 12.5, color: "#b91c1c", margin: "10px 0 0", lineHeight: 1.45 } as const,
  row: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } as const,
  btn: { background: "#fff", color: "#0f766e", border: "1px solid #99f6e4", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" } as const,
  btnPrimary: { background: "#0f766e", color: "#fff", border: "none", borderRadius: 9, padding: "8px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  mnemonic: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5, lineHeight: 1.7, color: "#0f172a", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "12px 14px", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 } as const,
  transcript: { maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "4px 2px" } as const,
  bubbleMe: { background: "#0f766e", color: "#fff", borderRadius: "12px 12px 4px 12px", padding: "8px 12px", maxWidth: "78%", fontSize: 14, lineHeight: 1.45 } as const,
  bubblePeer: { background: "#fff", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: "12px 12px 12px 4px", padding: "8px 12px", maxWidth: "78%", fontSize: 14, lineHeight: 1.45 } as const,
  bubbleWho: { fontSize: 11, fontWeight: 700, opacity: 0.7, marginBottom: 2 } as const,
  bubbleText: { whiteSpace: "pre-wrap", wordBreak: "break-word" } as const,
  composer: { display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10 } as const,
  textarea: { flex: 1, resize: "vertical", border: "1px solid #cbd5e1", borderRadius: 9, padding: "8px 10px", fontSize: 14, fontFamily: "inherit", minHeight: 38 } as const,
  foot: { fontSize: 11.5, color: "#94a3b8", margin: "8px 0 0" } as const,
};
